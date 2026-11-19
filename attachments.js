import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {stateFile} from './state.js';
import {checkFolder, FolderReader, systemTar, TarReader} from './folderArchive.js';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 12;
export function attachmentInstructions(hasTools) {
    const common = 'GNOME Assistant displays file attachments in chat with a Download button. When creating or editing a useful deliverable, offer the finished file as an attachment, especially when the user asks you to provide it. Transfer the actual contents with a sensible filename and extension; a path or Markdown link alone does not deliver the file. There are 12 attachments per reply. ';
    return common + (hasTools
        ? 'Use attachment_upload for existing files and all files over 8 MiB: obtain its authenticated endpoint and POST the original bytes using a streaming upload (such as curl --request POST --upload-file file), Content-Length and percent-encoded X-Gnome-Filename. Do not read or base64-encode the full file into memory. This streams directly to disk, supports files up to 1 GiB and also works over SSH. Wait for the successful HTTP response before ending the turn; do not leave uploads running in the background. At most two uploads may run concurrently. Small files up to 8 MiB may use send_attachment({filename,text}) for UTF-8 or {filename,base64} for binary. Do not invent file contents, base64, or a successful transfer; check the result. Keep upload URLs and authorization headers out of the user-facing reply.'
        : 'Without HTTP MCP, files are limited to 8 MiB. Send a standard ACP resource content block in the assistant output: {type:"resource",resource:{uri:"attachment:///report.txt",mimeType:"text/plain",text:"file contents"}}. For binary files use resource.blob with base64 instead of text. The URI identifies the file; its contents must be embedded. If your agent cannot emit resource blocks, explain that file transfer is unavailable rather than claiming a path has been attached.');
}
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const NAME = /^[^/\\\x00-\x1f\x7f]{1,160}$/u;

// Clipboard formats file managers use for copied files, preferred first:
// GNOME's (also used by Nemo and Caja) and the standard URI list.
export const COPIED_FILE_TYPES = ['x-special/gnome-copied-files', 'text/uri-list'];

// Local paths from copied files: "copy" or "cut" then URIs for GNOME's
// format, one URI per line with "#" comments for text/uri-list. Only file://
// URIs count; links copied from other apps are not files.
export function copiedFilePaths(text) {
    const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    if (['copy', 'cut'].includes(lines[0]))
        lines.shift();
    const paths = lines.map(uri => {
        if (!/^file:\/\//i.test(uri))
            return null;
        try {
            return Gio.File.new_for_uri(uri).get_path();
        } catch {
            return null;
        }
    }).filter(Boolean);
    return [...new Set(paths)];
}

export function attachmentName(name) {
    if (typeof name !== 'string' || !NAME.test(name) || name === '.' || name === '..')
        throw new Error('Use a filename of up to 160 characters, without a path.');
    return name;
}

export function attachmentMetadata(record) {
    if (!record || !ID.test(record.id) || !NAME.test(record.name) ||
        ['.', '..'].includes(record.name) || !Number.isSafeInteger(record.size) ||
        record.size < 0 || record.size > MAX_STREAM_ATTACHMENT_BYTES)
        return null;
    return {id: record.id, name: record.name, size: record.size,
        image: record.image === true && record.size <= MAX_ATTACHMENT_BYTES};
}

function attachmentRoot() {
    return stateFile('attachments');
}

export function attachmentFile(record, temporaryDirectory = null) {
    if (!attachmentMetadata(record))
        throw new Error('Invalid attachment.');
    const root = temporaryDirectory ? Gio.File.new_for_path(temporaryDirectory) : attachmentRoot();
    return root.get_child(record.id).get_child(record.name);
}

export function imageMime(bytes) {
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
        return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        return 'image/jpeg';
    if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP')
        return 'image/webp';
    return null;
}

export function saveAttachment(name, bytes, temporaryDirectory = null) {
    attachmentName(name);
    if (bytes.length > MAX_ATTACHMENT_BYTES)
        throw new Error('Attachments are limited to 8 MiB each.');
    const record = {id: GLib.uuid_string_random(), name, size: bytes.length, image: Boolean(imageMime(bytes))};
    const file = attachmentFile(record, temporaryDirectory);
    if (GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700) !== 0)
        throw new Error('Could not create attachment storage.');
    file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
    return record;
}

const io = (start, finish) => new Promise((resolve, reject) => start((source, result) => {
    try {resolve(source[finish](result));} catch (error) {reject(error);}
}));
const removeFile = async file => {
    try {await io(callback => file.delete_async(GLib.PRIORITY_DEFAULT, null, callback), 'delete_finish');}
    catch (error) {if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;}
};

export async function copyAttachment(record, destination, temporaryDirectory = null,
    {cancellable = null, progress = null} = {}) {
    const file = attachmentFile(record, temporaryDirectory);
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !== Gio.FileType.REGULAR)
        throw new Error('This attachment is no longer available.');
    const target = Gio.File.new_for_path(destination);
    const partial = target.get_parent().get_child('.gnome-assistant-download-'+GLib.uuid_string_random()+'.part');
    try {
        await io(callback => file.copy_async(partial, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
            cancellable, progress, callback), 'copy_finish');
        cancellable?.set_error_if_cancelled();
        // Commit a complete copy atomically. Cancelling never destroys an existing destination.
        await io(callback => partial.move_async(target, Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT, null, null, callback), 'move_finish');
    } catch (error) {
        await removeFile(partial);
        throw error;
    }
}

export class AttachmentUpload {
    static async create(name, size, temporaryDirectory = null, cancellable = new Gio.Cancellable()) {
        attachmentName(name);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_STREAM_ATTACHMENT_BYTES)
            throw new Error('Streamed files are limited to 1 GiB each.');
        const upload = new AttachmentUpload();
        upload.record = {id: GLib.uuid_string_random(), name, size, image: false};
        upload.file = attachmentFile(upload.record, temporaryDirectory);
        upload.partial = upload.file.get_parent().get_child(name === '.upload' ? '.upload-part' : '.upload');
        upload.cancellable = cancellable;
        upload.received = 0;
        upload.prefix = new Uint8Array();
        try {
            if (GLib.mkdir_with_parents(upload.file.get_parent().get_path(), 0o700) !== 0)
                throw new Error('Could not create attachment storage.');
            upload.output = await io(callback => upload.partial.create_async(Gio.FileCreateFlags.PRIVATE,
                GLib.PRIORITY_DEFAULT, cancellable, callback), 'create_finish');
            return upload;
        } catch (error) {
            await upload.abort();
            throw error;
        }
    }

    write(chunk) {
        if (this.finishing || this.aborting)
            return Promise.reject(new Error('The upload is no longer writable.'));
        this.writing = (async () => {
            this.cancellable.set_error_if_cancelled();
            const size = chunk.get_size();
            if (this.received + size > this.record.size)
                throw new Error('The upload exceeds its declared size.');
            if (this.prefix.length < 16) {
                const data = chunk.get_data();
                const prefix = new Uint8Array(Math.min(16, this.prefix.length + data.length));
                prefix.set(this.prefix);
                prefix.set(data.subarray(0, prefix.length - this.prefix.length), this.prefix.length);
                this.prefix = prefix;
            }
            let offset = 0;
            while (offset < size) {
                const bytes = offset ? chunk.new_from_bytes(offset, size - offset) : chunk;
                // GIO retains GBytes across the asynchronous write. A borrowed
                // JS byte array is not a safe async buffer in GJS.
                const written = await io(callback => this.output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT,
                    this.cancellable, callback), 'write_bytes_finish');
                if (written <= 0)
                    throw new Error('Could not write the upload chunk.');
                offset += written;
            }
            this.received += size;
        })();
        return this.writing;
    }

    finish() {
        if (this.finishing || this.aborting)
            return Promise.reject(new Error('The upload has already finished.'));
        this.finishing = (async () => {
            await this.writing;
            this.cancellable.set_error_if_cancelled();
            if (this.received !== this.record.size)
                throw new Error('The upload ended before all file bytes arrived.');
            await io(callback => this.output.close_async(GLib.PRIORITY_DEFAULT, this.cancellable, callback), 'close_finish');
            await io(callback => this.partial.move_async(this.file, Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT, this.cancellable, null, callback), 'move_finish');
            this.cancellable.set_error_if_cancelled();
            this.record.image = this.record.size <= MAX_ATTACHMENT_BYTES && Boolean(imageMime(this.prefix));
            return this.record;
        })();
        return this.finishing;
    }

    keep() { this.retained = true; }

    abort() {
        if (this.retained)
            return Promise.resolve();
        if (this.aborting)
            return this.aborting;
        this.cancellable.cancel();
        this.aborting = (async () => {
            await this.writing?.catch(() => {});
            await this.finishing?.catch(() => {});
            if (this.output && !this.output.is_closed()) {
                try {await io(callback => this.output.close_async(GLib.PRIORITY_DEFAULT, null, callback), 'close_finish');}
                catch { /* Delete incomplete data even after an I/O error. */ }
            }
            await removeFile(this.partial);
            await removeFile(this.file);
            await removeFile(this.file.get_parent());
        })();
        return this.aborting;
    }
}

export function decodeAttachment(base64) {
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
        base64.length % 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(base64))
        throw new Error('Use base64 for the file contents, up to 8 MiB decoded.');
    return GLib.base64_decode(base64);
}

export function removeAttachmentDirectory(directory = attachmentRoot()) {
    const type = directory.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.UNKNOWN)
        return;
    if (type === Gio.FileType.DIRECTORY) {
        const children = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        try {
            for (let info; (info = children.next_file(null));)
                removeAttachmentDirectory(directory.get_child(info.get_name()));
        } finally {
            children.close(null);
        }
    }
    directory.delete(null);
}

// Text files up to this size are embedded so the agent can answer at once;
// larger or binary files are streamed when the agent asks for them.
export const MAX_EMBEDDED_TEXT_BYTES = 256 * 1024;
const SELECTION_ATTRIBUTES = 'standard::type,standard::size,time::modified,time::modified-usec';

function changeStamp(info) {
    return `${info.get_size()}:${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}`;
}

// Record a file the user attached without reading it. Large files are only
// read if and when the agent downloads them.
export async function selectAttachment(path) {
    const file = Gio.File.new_for_path(path);
    const info = await io(callback => file.query_info_async(SELECTION_ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT, null, callback), 'query_info_finish');
    if (info.get_file_type() !== Gio.FileType.REGULAR)
        throw new Error('Choose a regular file.');
    if (info.get_size() > MAX_STREAM_ATTACHMENT_BYTES)
        throw new Error('Files are limited to 1 GiB each.');
    const stream = await io(callback => file.read_async(GLib.PRIORITY_DEFAULT, null, callback), 'read_finish');
    let prefix;
    try {
        prefix = (await io(callback => stream.read_bytes_async(16, GLib.PRIORITY_DEFAULT, null, callback),
            'read_bytes_finish')).get_data() ?? new Uint8Array();
    } finally {
        stream.close(null);
    }
    return {id: GLib.uuid_string_random(), name: attachmentName(file.get_basename()), path: file.get_path(),
        size: info.get_size(), stamp: changeStamp(info), image: Boolean(imageMime(prefix))};
}

// The agent must receive the file as it was when attached, never a later
// version: refuse it once its size or modification time has changed.
export function attachedFile(record) {
    const file = Gio.File.new_for_path(record.path);
    let info;
    try {
        info = file.query_info(SELECTION_ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        throw Object.assign(new Error(`${record.name} is no longer available. Ask the user to attach it again.`), {status: 410});
    }
    if (info.get_file_type() !== Gio.FileType.REGULAR || changeStamp(info) !== record.stamp)
        throw Object.assign(new Error(`${record.name} changed after it was attached. Ask the user to attach it again.`), {status: 409});
    return file;
}

// What the download route streams for an attachment: the file itself, or a
// folder as a tar archive built on the fly, by GNU tar when available (much
// faster for many small files, size unknown) or by FolderReader (exact size).
export function downloadTarget(record, {builtin = false} = {}) {
    if (record.folder) {
        const tar = builtin ? null : systemTar();
        if (tar) {
            checkFolder(record);
            return {size: null, name: `${record.name}.tar`, contentType: 'application/x-tar',
                open: cancellable => TarReader.start(record, tar, cancellable, {checked: true})};
        }
        const reader = new FolderReader(record);
        return {size: record.size, name: `${record.name}.tar`, contentType: 'application/x-tar',
            open: cancellable => Object.assign(reader, {cancellable})};
    }
    // A redacted copy in memory is sent instead of the file on disk.
    if (record.bytes) {
        const bytes = new GLib.Bytes(record.bytes);
        return {size: bytes.get_size(), name: record.name, open: async () => {
            let sent = false;
            return {read: async () => sent ? null : (sent = true, bytes), close: () => {}};
        }};
    }
    const file = attachedFile(record);
    return {size: record.size, name: record.name, open: async cancellable => {
        const stream = await io(callback => file.read_async(GLib.PRIORITY_DEFAULT, cancellable, callback), 'read_finish');
        return {
            read: async max => {
                const bytes = await io(callback => stream.read_bytes_async(max, GLib.PRIORITY_DEFAULT, cancellable, callback),
                    'read_bytes_finish');
                return bytes.get_size() ? bytes : null;
            },
            close: () => stream.close_async(GLib.PRIORITY_DEFAULT, null, null),
        };
    }};
}

export async function readAttachedBytes(record) {
    if (record.bytes)
        return record.bytes;
    if (record.size > MAX_ATTACHMENT_BYTES)
        throw new Error(`${record.name} is over 8 MiB, too large to embed in a message.`);
    const stream = await io(callback => attachedFile(record).read_async(GLib.PRIORITY_DEFAULT, null, callback), 'read_finish');
    try {
        const bytes = (await io(callback => stream.read_bytes_async(MAX_ATTACHMENT_BYTES + 1, GLib.PRIORITY_DEFAULT, null,
            callback), 'read_bytes_finish')).get_data() ?? new Uint8Array();
        if (bytes.length !== record.size)
            throw new Error(`${record.name} changed after it was attached. Attach it again.`);
        return bytes;
    } finally {
        stream.close(null);
    }
}

export function isTextContent(bytes) {
    if (bytes.includes(0))
        return false;
    try {
        new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

// How a user attachment reaches the agent: in the prompt as an image or an
// embedded resource, or streamed on request with attachment_download.
// Images stay embedded, as the model only sees images in the prompt; small
// text is embedded so the agent can answer without a download.
export function attachmentDelivery({name, size, image, text, folder}, {tools, images, embedded}) {
    // Folders only travel as a streamed archive.
    if (folder) {
        if (tools)
            return 'stream';
        throw new Error(`${name} is a folder. Folders can only be sent to agents with GNOME Assistant tools; ` +
            'with an agent on this computer, reference it instead.');
    }
    if (image && images && size <= MAX_ATTACHMENT_BYTES)
        return 'image';
    if (tools)
        return text && embedded && size <= MAX_EMBEDDED_TEXT_BYTES ? 'embed' : 'stream';
    if (size > MAX_ATTACHMENT_BYTES)
        throw new Error(`${name} is over 8 MiB. This agent can only receive files embedded in the message; ` +
            'use an agent with GNOME Assistant tools, or reference the file if the agent runs on this computer.');
    if (embedded)
        return 'embed';
    throw new Error('This agent does not accept the selected file as an ACP attachment.');
}

export function receivedAttachmentInstructions() {
    return [
        'Files and folders the user attached that are not embedded in the message are listed as "Attached file for ' +
        'download" or "Attached folder for download" lines with an id. Call attachment_download({id}) only when the ' +
        'request needs them, and use the returned URL and headers.',
        'Download into a new private temporary directory on your host, created with mktemp -d (it honours TMPDIR and ' +
        'works inside sandboxes), never into the user\'s project or your working directory unless they ask. A file: ' +
        'curl --fail --silent --show-error --header "Authorization: ..." --output "$dir/NAME" URL. A folder arrives as ' +
        'an uncompressed tar archive: extract it while it downloads, curl ... URL | tar -x -C "$dir", and check that ' +
        'both commands succeeded; its line lists items that were skipped, such as sockets or unreadable folders.',
        'Keep that directory for follow-up questions in this conversation instead of downloading again.',
        'Downloads can be up to 1 GiB, far more than fits in your context. Never print a whole file to the terminal or ' +
        'into your reply. If you have your own file tools, such as a read or view tool, use them on the downloaded ' +
        'path: they page through large files, so read only the parts the request needs. Otherwise use commands that ' +
        'bound their output, such as ls, find, file, wc, head, tail, grep -m, unzip -l or sqlite3 queries.',
        'A 409 or 410 response, or a transfer that ends early, means the user changed or removed the item after ' +
        'attaching it: ask them to attach it again. At most two downloads run at once. Keep download URLs and ' +
        'authorization headers out of the user-facing reply.',
    ].join(' ');
}

export async function readSelectedAttachment(path) {
    const record = await selectAttachment(path);
    if (record.size > MAX_ATTACHMENT_BYTES)
        throw new Error('Choose a regular file of up to 8 MiB.');
    record.bytes = await readAttachedBytes(record);
    return record;
}
