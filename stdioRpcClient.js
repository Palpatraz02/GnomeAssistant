import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PRIORITY = GLib.PRIORITY_DEFAULT;
const RPC_TIMEOUT_MS = 30_000;

export function readLine(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_line_async(PRIORITY, cancellable, (source, result) => {
            try {
                resolve(source.read_line_finish_utf8(result)[0]);
            } catch (error) {
                reject(error);
            }
        });
    });
}

export class StdioRpcClient {
    constructor(launcher, args, label, onNotification, onRequest, onClose, jsonrpc = false) {
        this._label = label;
        this._jsonrpc = jsonrpc;
        this._pending = new Map();
        this._nextId = 0;
        this._cancellable = new Gio.Cancellable();
        this._writes = Promise.resolve();
        this.closed = false;

        this._process = launcher.spawnv(args);
        this._stdin = this._process.get_stdin_pipe();
        this._stdout = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()});

        this._readMessages(onNotification, onRequest)
            .catch(error => this.close(error))
            .finally(() => onClose(this._closeError));
    }

    request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
        if (this.closed)
            return Promise.reject(new Error(`${this._label} is disconnected.`));

        const id = ++this._nextId;
        return new Promise((resolve, reject) => {
            const timeout = timeoutMs && GLib.timeout_add(PRIORITY, timeoutMs, () => {
                this._pending.delete(id);
                const error = new Error(`${this._label} did not respond to ${method}.`);
                reject(error);
                this.close(error);
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timeout});
            this._send({id, method, params}).catch(error => this.close(error));
        });
    }

    notify(method, params) {
        return this._send({method, params});
    }

    respond(id, result) {
        this._send({id, result}).catch(error => this.close(error));
    }

    reject(id, error) {
        this._send({id, error: {code: -32603, message: error.message}})
            .catch(failure => this.close(failure));
    }

    unsupported(id, method) {
        this._send({id, error: {code: -32601, message: `Unsupported request: ${method}`}})
            .catch(error => this.close(error));
    }

    _send(message) {
        if (this._jsonrpc)
            message = {jsonrpc: '2.0', ...message};
        const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
        const write = this._writes.then(() => new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error(`${this._label} is disconnected.`));
                return;
            }
            this._stdin.write_all_async(bytes, PRIORITY, this._cancellable, (source, result) => {
                try {
                    source.write_all_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        }));
        this._writes = write.catch(() => {});
        return write;
    }

    async _readMessages(onNotification, onRequest) {
        while (!this.closed) {
            const line = await readLine(this._stdout, this._cancellable);
            if (line === null)
                throw new Error(`${this._label} exited. Check the CLI installation and sign-in.`);
            if (!line)
                continue;

            const message = JSON.parse(line);
            if (message.method) {
                try {
                    if (message.id === undefined)
                        onNotification(message.method, message.params ?? {});
                    else
                        onRequest(message.id, message.method, message.params ?? {});
                } catch (error) {
                    console.error(`GNOME Assistant: Failed to handle ${message.method}: ${error.message}`);
                    if (message.id !== undefined) {
                        await this._send({
                            id: message.id,
                            error: {code: -32603, message: 'GNOME Assistant could not handle this request.'},
                        });
                    }
                }
            } else {
                const pending = this._pending.get(message.id);
                if (!pending)
                    continue;
                this._pending.delete(message.id);
                if (pending.timeout)
                    GLib.source_remove(pending.timeout);
                if (message.error) {
                    const error = new Error(message.error.message);
                    error.code = message.error.code;
                    pending.reject(error);
                } else
                    pending.resolve(message.result);
            }
        }
    }

    close(error = new Error(`${this._label} connection closed.`), {graceful = false} = {}) {
        if (this.closed)
            return;
        this.closed = true;
        this._closeError = error;
        this._cancellable.cancel();
        for (const pending of this._pending.values()) {
            if (pending.timeout)
                GLib.source_remove(pending.timeout);
            pending.reject(error);
        }
        this._pending.clear();
        if (graceful) {
            this._stdin.close_async(PRIORITY, null, () => {});
            const timeout = GLib.timeout_add(PRIORITY, 2000, () => {
                this._process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            this._process.wait_async(null, (process, result) => {
                process.wait_finish(result);
                if (GLib.MainContext.default().find_source_by_id(timeout))
                    GLib.source_remove(timeout);
            });
        } else {
            this._process.force_exit();
            this._process.wait_async(null, null);
        }
    }
}
