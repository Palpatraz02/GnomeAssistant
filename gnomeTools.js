import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {A2uiReferenceSession, A2UI_REFERENCE_TOPICS} from './a2uiReference.js';
import {AttachmentDownload, AttachmentTransfer} from './attachmentTransfer.js';
import {attachmentName, decodeAttachment, MAX_ATTACHMENT_BYTES, MAX_STREAM_ATTACHMENT_BYTES} from './attachments.js';

const MAX_RPC_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16384;
const object = properties => ({type: 'object', properties});
const string = {type: 'string'};
const tool = (name, description, properties, required = []) => ({
    name, description, inputSchema: {...object(properties), required, additionalProperties: false},
});

export class GnomeTools {
    constructor(handlers, {uploadIdleMs = 60000} = {}) {
        this._handlers = handlers;
        this._uploadIdleMs = uploadIdleMs;
        this._uploads = new Set();
        this._downloads = new Set();
        this._a2uiReference = new A2uiReferenceSession();
        this._token = GLib.uuid_string_random() + GLib.uuid_string_random();
        this._server = new Soup.Server();
        this._server.add_early_handler(null, (_server, message, path) => this._accept(message, path));
        this._server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        this.port = this._server.get_uris()[0].get_port();
    }

    descriptor() {
        return {type: 'http', name: 'gnome-assistant', url: `http://127.0.0.1:${this.port}/mcp`,
            headers: [{name: 'Authorization', value: `Bearer ${this._token}`}]};
    }

    close() {
        this._closed = true;
        for (const upload of this._uploads) upload.cancel();
        for (const download of this._downloads) download.cancel();
        this._server.disconnect();
    }

    instructions() {
        return 'GNOME Assistant exposes MCP tools for its chats. ' +
            'Use render_a2ui for interfaces; send small updates as soon as useful instead of waiting for the full UI. ' +
            'Deliver finished files with send_attachment or attachment_upload; use show_image for a public HTTPS image. ' +
            'PNG, JPEG, and WebP attachments get an inline preview. ' +
            'Files on the agent host must be transferred as attachments for local download. ' +
            this._a2uiReference.hint();
    }

    setSession(id) {
        this._a2uiReference.setSession(id);
    }

    _accept(message, path) {
        // Rejected/unauthenticated bodies must not accumulate either. Only an
        // accepted, size-bounded JSON-RPC request opts back into buffering.
        message.get_request_body().set_accumulate(false);
        const headers = message.get_request_headers();
        if (headers.get_one('Origin') || headers.get_one('Authorization') !== `Bearer ${this._token}`) {
            message.set_status(403, null);
            return;
        }
        const method = message.get_method();
        if (path.startsWith('/download/') && this._handlers.openDownload) {
            if (method !== 'GET')
                message.set_status(405, null);
            else
                this._download(message, decodeURIComponent(path.slice('/download/'.length)));
            return;
        }
        if (!['/mcp', '/attachment'].includes(path) || (path === '/attachment' && method !== 'POST')) {
            message.set_status(404, null);
            return;
        }
        if (method !== 'POST') {
            message.set_status(405, null);
            return;
        }
        const length = headers.get_one('Content-Length');
        const limit = path === '/attachment' ? MAX_STREAM_ATTACHMENT_BYTES : MAX_RPC_BYTES;
        if (!length || !/^\d{1,10}$/.test(length) || Number(length) > limit || headers.get_one('Transfer-Encoding')) {
            message.set_status(413, null);
            return;
        }
        if (path === '/attachment') {
            if (this._uploads.size >= 2) {
                message.set_status(429, null);
                return;
            }
            let name;
            try {
                name = attachmentName(decodeURIComponent(headers.get_one('X-Gnome-Filename') ?? ''));
                this._handlers.checkTurn();
            } catch (error) {
                this._reply(message, 400, {error: error.message});
                return;
            }
            const upload = new AttachmentTransfer(message, {
                open: cancel => this._handlers.beginUpload(name, Number(length), cancel),
                reply: (status, result) => {if (!this._closed) this._reply(message, status, result);},
                released: transfer => this._uploads.delete(transfer), idleMs: this._uploadIdleMs,
            });
            this._uploads.add(upload);
            upload.start();
            return;
        }
        message.get_request_body().set_accumulate(true);
        message.connect('got-body', () => {
            message.pause();
            Promise.resolve().then(async () => {
                const body = message.get_request_body().flatten().get_data();
                return this._rpc(JSON.parse(new TextDecoder().decode(body)));
            }).then(result => {
                if (result === undefined)
                    message.set_status(202, null);
                else
                    this._reply(message, 200, result);
            }, error => this._reply(message, 400, {error: error.message})).finally(() => message.unpause());
        });
    }

    _download(message, id) {
        if (this._downloads.size >= 2) {
            message.set_status(429, null);
            return;
        }
        let target;
        try {
            target = this._handlers.openDownload(id);
        } catch (error) {
            this._reply(message, error.status ?? 404, {error: error.message});
            return;
        }
        const download = new AttachmentDownload(message, {
            ...target, idleMs: this._uploadIdleMs,
            released: transfer => this._downloads.delete(transfer),
        });
        this._downloads.add(download);
        download.start();
    }

    _reply(message, status, result) {
        message.set_status(status, null);
        message.set_response('application/json', Soup.MemoryUse.COPY,
            new TextEncoder().encode(JSON.stringify(result)));
    }

    _tools() {
        const attachment = tool('send_attachment',
            'Deliver a finished file to this chat as a downloadable attachment. Supply exactly one of text (UTF-8 files) or base64 (binary files). For existing files, attachment_upload avoids putting their contents in tool arguments.',
            {filename: string, text: {...string, maxLength: MAX_ATTACHMENT_BYTES}, base64: string}, ['filename']);
        attachment.inputSchema.oneOf = [{required: ['text']}, {required: ['base64']}];
        const tools = [
            attachment,
            tool('attachment_upload', 'Stream an existing file (up to 1 GiB) from the agent host directly to chat storage. POST with Content-Length and percent-encoded X-Gnome-Filename, using streaming file I/O such as curl --request POST --upload-file file. Do not load/base64 the file into model context. Wait for the successful upload response before ending the turn. At most two uploads run concurrently. Completed files get Download cards.',
                {}),
            ...(this._handlers.describeDownload ? [tool('attachment_download',
                'Get an authenticated URL to stream a file or folder the user attached (listed as "Attached file for download" or "Attached folder for download") with an HTTP GET, up to 1 GiB. Folders arrive as an uncompressed tar archive. Stream to a temporary directory, for example with curl --output, or curl | tar -x for a folder; do not load the contents into model context. At most two downloads run concurrently.',
                {id: {...string, description: 'The id from the "Attached file for download" or "Attached folder for download" line.'}}, ['id'])] : []),
            tool('show_image', 'Show an image from a public HTTPS URL.', {url: string, caption: string}, ['url']),
            tool('get_a2ui_catalog', 'Get a compact A2UI 1.0 quick start by default. Request only missing component/function/topic details; reuse prior results. format:"schema" returns the full formal catalog unchanged, only when needed for schema validation.', {
                format: {type:'string', enum:['guide','schema']},
                components: {type:'array', maxItems:18, items:string, description:'Exact component names; omitted sections are empty when any filter is supplied.'},
                functions: {type:'array', maxItems:64, items:string},
                topics: {type:'array', maxItems:5, items:{type:'string', enum:Object.keys(A2UI_REFERENCE_TOPICS)}},
            }),
            tool('render_a2ui', 'Apply standard A2UI 1.0 messages now. For multi-step work, send a small useful surface first and update it as data arrives; use updateDataModel for bound data. Do not wait to build a large final tree.',
                {messages: {type: 'array', minItems: 1, maxItems: 64, items: {type: 'object'}}}, ['messages']),
        ];
        if (this._handlers.desktop) {
            const shared = 'Uses the desktop context the user shared in this conversation, only for parts they included.';
            const desktop = [
                tool('desktop_get_windows', `Get every open window on every workspace, most recently used first, with workspace details. ${shared}`, {}),
                tool('desktop_get_selection', `Get the full text the user had highlighted (primary selection) when they captured the desktop. ${shared}`, {}),
                tool('desktop_get_projects', `Get the project directories inferred from the user's windows and terminals, most likely first, with their sources. ${shared}`, {}),
                tool('desktop_get_recent_events', `Get notifications, opened and closed windows, crashes and logged errors from the five minutes before capture, newest first. ${shared}`, {}),
                tool('desktop_get_app_logs', `Get recent journal log lines of the application owning a window from the shared desktop context, even after it closed. ${shared}`, {
                    window_id: {...string, description: 'A window id from the desktop context snapshot.'},
                    priority: {type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'Minimum priority. Defaults to info, where stdout and stderr output is logged.'},
                    lines: {type: 'integer', minimum: 1, maximum: 200},
                    minutes: {type: 'integer', minimum: 1, maximum: 1440},
                }, ['window_id']),
                tool('desktop_get_device_status', `Get the current network, audio, Bluetooth, power and session status of the user's machine. ${shared}`, {}),
                tool('desktop_get_window_process', `Get the process, desktop ID and systemd unit of a window's application from the shared desktop context, with a journalctl command for its logs. ${shared}`,
                    {window_id: {...string, description: 'A window id from the desktop context snapshot.'}}, ['window_id']),
                tool('desktop_capture_window', `Take a fresh screenshot of one window from the shared desktop context, as it looks now. ${shared}`,
                    {window_id: {...string, description: 'A window id from the desktop context snapshot.'}}, ['window_id']),
            ];
            // Only tools for parts the user enabled and this agent needs.
            const available = this._handlers.desktopTools?.();
            tools.push(...desktop.filter(item => !available || available.includes(item.name)));
        }
        if (this._handlers.local) {
            tools.push(
                tool('list_local_files', 'List the user-shared local folder.', {path: string}),
                tool('read_local_file', 'Read a text file from the user-shared local folder.', {path: string}, ['path']),
                tool('write_local_file', 'Request approval to write a text file in the local shared folder.',
                    {path: string, text: string}, ['path', 'text']));
            if (this._handlers.commands)
                tools.push(tool('run_local_command', 'Request approval to run a sandboxed command on the local PC.',
                    {command: string, args: {type: 'array', items: string}, cwd: string}, ['command']));
        }
        return tools;
    }

    async _rpc({id, method, params}) {
        if (id === undefined)
            return undefined;
        const response = {jsonrpc: '2.0', id};
        if (method === 'initialize') {
            return {...response, result: {
                protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26'].includes(params?.protocolVersion)
                    ? params.protocolVersion : '2025-03-26',
                capabilities: {tools: {}}, serverInfo: {name: 'gnome-assistant', version: '1.0.0'},
            }};
        }
        if (method === 'ping')
            return {...response, result: {}};
        if (method === 'tools/list')
            return {...response, result: {tools: this._tools()}};
        if (method !== 'tools/call')
            return {...response, error: {code: -32601, message: 'Method unavailable'}};
        try {
            const {name, arguments: args = {}} = params;
            if (!this._tools().some(item => item.name === name))
                throw new Error('Tool unavailable in this chat.');
            const result = await this._call(name, args);
            // Handlers may return MCP content directly, such as images.
            return {...response, result: {content: result?.mcpContent ?? [{type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result)}]}};
        } catch (error) {
            return {...response, result: {isError: true, content: [{type: 'text', text: error.message}]}};
        }
    }

    _call(name, args) {
        const handlers = this._handlers;
        switch (name) {
        case 'send_attachment':
            if (Object.hasOwn(args, 'text') === Object.hasOwn(args, 'base64'))
                throw new Error('Provide exactly one of text or base64.');
            if (Object.hasOwn(args, 'text') && typeof args.text !== 'string')
                throw new Error('File text must be a string.');
            return handlers.attach(attachmentName(args.filename), Object.hasOwn(args, 'text')
                ? new TextEncoder().encode(args.text) : decodeAttachment(args.base64));
        case 'attachment_upload':
            handlers.checkTurn();
            return {url: this.descriptor().url.replace('/mcp', '/attachment'), method: 'POST',
                headers: {Authorization: `Bearer ${this._token}`}, filenameHeader: 'X-Gnome-Filename',
                contentLengthRequired: true, streaming: true, maxConcurrentUploads: 2,
                maxBytes: MAX_STREAM_ATTACHMENT_BYTES};
        case 'attachment_download': {
            const {name, size, folder, contentSize, files} = handlers.describeDownload(String(args.id ?? ''));
            return {url: this.descriptor().url.replace(/\/mcp$/, '/download/' + encodeURIComponent(String(args.id))),
                method: 'GET', headers: {Authorization: `Bearer ${this._token}`}, filename: folder ? `${name}.tar` : name,
                ...(folder ? {format: 'tar', extract: 'curl ... URL | tar -x -C "$dir"', content_size: contentSize, files}
                    : {size}),
                streaming: true, maxConcurrentDownloads: 2};
        }
        case 'show_image':
            return handlers.image(args.url, args.caption);
        case 'get_a2ui_catalog':
            return this._a2uiReference.read(args);
        case 'render_a2ui':
            return handlers.a2ui(args.messages);
        case 'desktop_get_windows':
        case 'desktop_get_selection':
        case 'desktop_get_projects':
        case 'desktop_get_recent_events':
        case 'desktop_capture_window':
        case 'desktop_get_app_logs':
        case 'desktop_get_device_status':
        case 'desktop_get_window_process':
            return handlers.desktop(name, args);
        default:
            return handlers.local(name, args);
        }
    }
}
