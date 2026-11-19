import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

const MAX_QUEUED_BYTES = 512 * 1024;
const NATIVE_COLLECTION_BYTES = 16 * 1024 * 1024;
let nativeBytesSinceCollection = 0;

// Soup never accumulates the upload body. Pause socket reads until each chunk
// has reached disk, including any final chunk delivered immediately before got-body.
export class AttachmentTransfer {
    constructor(message, {open, reply, released, idleMs = 60000}) {
        Object.assign(this, {message, open, reply, released, idleMs});
        this.cancellable = new Gio.Cancellable();
        this.queuedBytes = 0;
        this.queue = [];
        this.lastActivity = GLib.get_monotonic_time();
        this.signals = [];
    }

    start() {
        const message = this.message;
        message.get_request_body().set_accumulate(false);
        message.pause();
        this.signals.push(message.connect('got-chunk', (_message, chunk) => this._chunk(chunk)));
        this.signals.push(message.connect('got-body', () => this._finish()));
        for (const signal of ['disconnected', 'finished']) {
            this.signals.push(message.connect(signal, () => {
                this.disconnected = true;
                if (!this.done) this.cancel(new Error('The upload connection closed.'));
            }));
        }
        this.cancelSignal = this.cancellable.connect(() => this.cancel(new Error('Transfer cancelled.')));
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(1000, this.idleMs), () => {
            if (GLib.get_monotonic_time() - this.lastActivity >= this.idleMs * 1000) {
                this.timer = null;
                this.cancel(Object.assign(new Error('The upload timed out.'), {status: 408}));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this.setup = Promise.resolve().then(() => this.open(this.cancellable));
        this.setup.then(sink => {
            this.sink = sink;
            if (!this.failed && !this.bodyDone && !this.queuedBytes)
                this._resume();
        }, error => this.cancel(error));
    }

    _chunk(chunk) {
        if (this.failed || this.done) return;
        this.message.pause();
        this.lastActivity = GLib.get_monotonic_time();
        const size = chunk.get_size();
        nativeBytesSinceCollection += size;
        this.queuedBytes += size;
        if (this.queuedBytes > MAX_QUEUED_BYTES) {
            this.cancel(new Error('The upload exceeded its bounded write queue.'));
            return;
        }
        this.queue.push(chunk);
        this._drain();
    }

    _finish() {
        if (this.failed || this.done) return;
        this.bodyDone = true;
        this.message.pause();
        this._drain();
    }

    async _drain() {
        if (this.working || this.failed || this.done) return;
        this.working = true;
        try {
            const sink = await this.setup;
            while (this.queue.length && !this.failed) {
                let chunk = this.queue.shift();
                const size = chunk.get_size();
                await sink.write(chunk);
                chunk = null;
                this.queuedBytes -= size;
                this.lastActivity = GLib.get_monotonic_time();
            }
            if (!this.failed && this.bodyDone) {
                const result = await sink.finish();
                if (this.failed || this.disconnected) return;
                this.done = true;
                this.reply(200, result);
                this.message.unpause();
                this._release();
            }
        } catch (error) {
            this.cancel(error);
        } finally {
            this.working = false;
            if (!this.failed && !this.done && !this.disconnected)
                this._resume();
        }
    }

    _resume() {
        if (this.resumeSource) return;
        // Give Shell repaint and GJS collection sources a turn between chunks;
        // continuously ready network/GTask sources would otherwise starve them.
        this.resumeSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this.resumeSource = null;
            // GJS does not account for Soup's native GBytes payloads when
            // deciding to collect boxed wrappers. Release completed payloads
            // at a bounded interval, below Shell's repaint priority.
            if (nativeBytesSinceCollection >= NATIVE_COLLECTION_BYTES) {
                System.gc();
                nativeBytesSinceCollection = 0;
            }
            if (!this.failed && !this.done && !this.disconnected)
                this.message.unpause();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel(error = new Error('Transfer cancelled.')) {
        if (this.done || this.failed) return this.aborting;
        this.failed = true;
        this.queue = [];
        this.cancellable.cancel();
        if (!this.disconnected) {
            this.reply(error.status ?? 400, {error: error.message});
            if (this.bodyDone) {
                this.message.unpause();
            } else {
                // Do not drain the rest of a cancelled 1 GiB request before
                // reporting failure. Closing also stops the sender promptly.
                this.disconnected = true;
                try {this.message.get_socket()?.close();} catch { /* Already disconnected. */ }
            }
        }
        this.aborting = (this.setup ?? Promise.resolve(null)).then(sink => sink?.abort(), () => {})
            .catch(failure => console.warn('GNOME Assistant: Could not remove incomplete upload', failure.message))
            .finally(() => this._release());
        return this.aborting;
    }

    _release() {
        if (this.releasedAlready) return;
        this.releasedAlready = true;
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = null;
        if (this.resumeSource) GLib.source_remove(this.resumeSource);
        this.resumeSource = null;
        for (const signal of this.signals) this.message.disconnect(signal);
        this.signals = [];
        if (this.cancelSignal) {
            const id = this.cancelSignal;
            // Gio.Cancellable.disconnect waits for a cancellation callback to
            // return; never invoke it from within that callback's dispatch.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.cancellable.disconnect(id);
                return GLib.SOURCE_REMOVE;
            });
            this.cancelSignal = null;
        }
        this.released(this);
    }
}

const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

// The reverse of AttachmentTransfer: stream a user's file or folder archive
// to the agent. `open` returns a reader whose read(max) gives GLib.Bytes, or
// null at the end. The response body never accumulates, and only one chunk
// is in flight: the next is read once Soup has written the previous one.
export class AttachmentDownload {
    constructor(message, {open, size, name, contentType = 'application/octet-stream', released, finished = () => {},
        idleMs = 60000}) {
        Object.assign(this, {message, open, size, name, contentType, released, finished, idleMs});
        this.cancellable = new Gio.Cancellable();
        this.sent = 0;
        this.lastActivity = GLib.get_monotonic_time();
        this.signals = [];
    }

    start() {
        const message = this.message;
        message.pause();
        message.set_status(200, null);
        const headers = message.get_response_headers();
        // An unknown size (an archive from system tar) is sent chunked: the
        // final empty chunk marks a complete transfer, so a cut-off one fails.
        if (this.size === null) {
            headers.set_encoding(Soup.Encoding.CHUNKED);
        } else {
            headers.set_encoding(Soup.Encoding.CONTENT_LENGTH);
            headers.set_content_length(this.size);
        }
        headers.set_content_type(this.contentType, null);
        headers.replace('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(this.name)}`);
        headers.replace('Cache-Control', 'no-store');
        message.get_response_body().set_accumulate(false);
        this.signals.push(message.connect('wrote-chunk', () => this._next()));
        // With Content-Length, Soup finishes as soon as the promised bytes are
        // written: a finished response after complete() means success.
        this.signals.push(message.connect('finished', () => {
            this.succeeded = this.complete && !this.failed && !this.disconnected;
            this._release();
        }));
        this.signals.push(message.connect('disconnected', () => {
            this.disconnected = true;
            this._release();
        }));
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(1000, this.idleMs), () => {
            if (GLib.get_monotonic_time() - this.lastActivity >= this.idleMs * 1000) {
                this.timer = null;
                this.cancel(new Error('The download timed out.'));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        Promise.resolve().then(() => this.open(this.cancellable)).then(reader => {
            this.reader = reader;
            if (this.failed)
                reader.close();
            else
                this._next();
        }, error => this.cancel(error));
    }

    async _next() {
        if (this.reading || this.complete || this.failed || !this.reader)
            return;
        this.reading = true;
        try {
            const bytes = await this.reader.read(DOWNLOAD_CHUNK_BYTES);
            if (this.failed)
                return;
            this.lastActivity = GLib.get_monotonic_time();
            const size = bytes?.get_size() ?? 0;
            const body = this.message.get_response_body();
            if (size === 0) {
                // The promised Content-Length must match exactly.
                if (this.size !== null && this.sent !== this.size)
                    throw new Error('The file changed while it was being sent.');
                this.complete = true;
                body.complete();
            } else {
                this.sent += size;
                if (this.size !== null && this.sent > this.size)
                    throw new Error('The file changed while it was being sent.');
                nativeBytesSinceCollection += size;
                body.append_bytes(bytes);
                if (this.sent === this.size) {
                    this.complete = true;
                    body.complete();
                }
            }
            this._resume();
        } catch (error) {
            this.cancel(error);
        } finally {
            this.reading = false;
        }
    }

    _resume() {
        if (this.resumeSource)
            return;
        // As for uploads, let Shell repaint and collect between chunks.
        this.resumeSource = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this.resumeSource = null;
            if (nativeBytesSinceCollection >= NATIVE_COLLECTION_BYTES) {
                System.gc();
                nativeBytesSinceCollection = 0;
            }
            if (!this.failed && !this.disconnected)
                this.message.unpause();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Headers are already sent, so a failure can only end the connection;
    // the client sees fewer bytes than Content-Length and reports an error.
    cancel(error = new Error('Transfer cancelled.')) {
        if (this.failed || this.releasedAlready)
            return;
        this.failed = true;
        this.error = error;
        this.cancellable.cancel();
        if (!this.disconnected) {
            this.disconnected = true;
            try {this.message.get_socket()?.close();} catch { /* Already closed. */ }
        }
        this._release();
    }

    _release() {
        if (this.releasedAlready)
            return;
        this.releasedAlready = true;
        if (this.timer)
            GLib.source_remove(this.timer);
        this.timer = null;
        if (this.resumeSource)
            GLib.source_remove(this.resumeSource);
        this.resumeSource = null;
        for (const signal of this.signals)
            this.message.disconnect(signal);
        this.signals = [];
        this.reader?.close();
        this.reader = null;
        const succeeded = Boolean(this.succeeded);
        this.finished(succeeded, succeeded ? null : this.error ?? new Error('The download did not complete.'));
        this.released(this);
    }
}
