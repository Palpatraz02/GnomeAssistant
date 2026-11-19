import GLib from 'gi://GLib';
import {StdioRpcClient} from './stdioRpcClient.js';

export class AcpClient extends StdioRpcClient {
    constructor(launcher, args, cwd, label, {onUpdate = () => {}, onPermission, onRequest, onClose = () => {}, capabilities = {}} = {}) {
        super(launcher, args, label,
            (method, params) => {
                if (method === 'session/update')
                    onUpdate(params);
            },
            (id, method, params) => {
                if (method === 'session/request_permission') {
                    const decide = optionId => this.respond(id, {
                        outcome: optionId == null ? {outcome: 'cancelled'} :
                            {outcome: 'selected', optionId},
                    });
                    if (onPermission)
                        onPermission(id, params, decide);
                    else
                        decide(null);
                } else if (onRequest) {
                    Promise.resolve().then(() => onRequest(method, params)).then(
                        result => result === undefined ? this.unsupported(id, method) : this.respond(id, result),
                        error => this.reject(id, error));
                } else {
                    this.unsupported(id, method);
                }
            }, onClose, true);
        this._cwd = cwd;
        this._capabilities = capabilities;
    }

    async initialize() {
        const result = await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: this._capabilities,
            clientInfo: {name: 'gnome-assistant', title: 'GNOME Assistant', version: '5'},
        });
        if (result.protocolVersion !== 1)
            throw new Error('The agent requires an unsupported ACP protocol version.');
        this.agentCapabilities = result.agentCapabilities ?? {};
        return result;
    }

    async openSession(sessionId, options = {}) {
        const params = {cwd: this._cwd, mcpServers: [], ...options};
        if (!sessionId)
            return this.request('session/new', params);
        const method = this.agentCapabilities?.sessionCapabilities?.resume !== undefined
            ? 'session/resume' : 'session/load';
        const result = await this.request(method, {...params, sessionId});
        return {...result, sessionId};
    }

    prompt(sessionId, text, instructions, resources = [], metadata = {}) {
        const prompt = [{type: 'text', text}, ...resources];
        if (instructions)
            prompt.push({type: 'text', text: instructions, annotations: {audience: ['assistant']}});
        const models = metadata.a2uiClientDataModel?.surfaces;
        if (models && Object.keys(models).length)
            prompt.push({type: 'text', text: 'A2UI client data models: ' + JSON.stringify(models),
                annotations: {audience: ['assistant']}});
        return this.request('session/prompt', {sessionId, prompt, _meta: {'org.gnome.assistant/a2ui': metadata}}, 0).finally(() => {
            if (this._cancelWatch) {
                GLib.source_remove(this._cancelWatch);
                this._cancelWatch = null;
            }
        });
    }

    async cancel(sessionId) {
        this._cancelWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._cancelWatch = null;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
        try {
            await this.notify('session/cancel', {sessionId});
        } catch (error) {
            this.close(error);
        }
    }

    close(error) {
        // EOF gives ACP adapters time to shut down their child processes.
        super.close(error, {graceful: true});
    }
}
