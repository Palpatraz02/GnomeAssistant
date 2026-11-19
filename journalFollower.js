import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Follows new journal entries matching the given journalctl matches, as
// parsed JSON, without polling. Only entries written after start() are read,
// so old problems do not reappear at login. If journalctl exits, it is
// started again after a growing pause, so a broken journal cannot spin.
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class JournalFollower {
    constructor(matches, onEntry, {fields = null, command = 'journalctl'} = {}) {
        this._matches = matches;
        this._onEntry = onEntry;
        this._fields = fields;
        this._command = command;
        this._backoff = 2000;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._spawn();
    }

    stop() {
        this._running = false;
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = null;
        this._cancellable?.cancel();
        this._process?.force_exit();
        this._process = null;
    }

    _spawn() {
        const path = GLib.find_program_in_path(this._command);
        if (!path)
            return;
        // --all: journalctl leaves large fields (such as long stack traces) out of JSON otherwise.
        const argv = [path, '--follow', '--lines=0', '--output=json', '--all', '--no-pager',
            ...(this._fields ? [`--output-fields=${this._fields.join(',')}`] : []),
            ...this._matches.flatMap((match, index) => index ? ['+', match] : [match])];
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
        launcher.setenv('LC_ALL', 'C', true);
        try {
            this._process = launcher.spawnv(argv);
        } catch {
            this._scheduleRestart();
            return;
        }
        const process = this._process;
        this._cancellable = new Gio.Cancellable();
        const lines = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), close_base_stream: true});
        const read = () => lines.read_line_async(GLib.PRIORITY_LOW, this._cancellable, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch {
                line = null;
            }
            if (line === null) {
                // journalctl ended (or was stopped).
                if (this._process === process) {
                    this._process = null;
                    this._scheduleRestart();
                }
                return;
            }
            this._backoff = 2000;
            try {
                this._onEntry(JSON.parse(line));
            } catch (error) {
                if (!(error instanceof SyntaxError))
                    console.warn('GNOME Assistant: problem entry', error);
            }
            read();
        });
        read();
    }

    _scheduleRestart() {
        if (!this._running || this._retry)
            return;
        this._retry = GLib.timeout_add(GLib.PRIORITY_LOW, this._backoff, () => {
            this._retry = null;
            if (this._running)
                this._spawn();
            return GLib.SOURCE_REMOVE;
        });
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
    }
}
