import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {clip, journalText, run} from './desktopSystem.js';

// Recent desktop events from sources every application goes through:
// GNOME Shell notifications and windows, systemd-coredump and the journal.
// Shell events live in a small in-memory ring buffer and are never written
// to disk; crashes and errors are queried only when the user captures.

const WINDOW_SECONDS = 300;
const MAX_BUFFERED = 60;
const MAX_REPORTED = 30;
const DIALOG_TYPES = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG]);
const SIGNALS = {4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV'};

function appFor(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return app?.get_name() ?? window.get_wm_class() ?? null;
}

async function crashes(since) {
    let list;
    try {
        list = JSON.parse(await run(['coredumpctl', 'list', '--no-pager', '--json=short', `--since=@${since}`]) || '[]');
    } catch {
        return [];
    }
    return list.map(crash => ({
        type: 'application_crash',
        time: crash.time / 1000,
        program: GLib.path_get_basename(crash.exe ?? '') || null,
        executable: crash.exe ?? null,
        pid: crash.pid,
        signal: SIGNALS[crash.sig] ?? crash.sig,
    }));
}

async function errors(since) {
    let output;
    try {
        output = await run(['journalctl', '--no-pager', '-p', 'err', `--since=@${since}`, '-n', '40', '-o', 'json',
            '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_COMM']);
    } catch {
        return [];
    }
    const grouped = new Map();
    for (const line of output.split('\n')) {
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const source = entry.SYSLOG_IDENTIFIER ?? entry._COMM ?? null;
        // Crashes are reported separately, with better detail.
        if (source === 'systemd-coredump')
            continue;
        const message = clip(journalText(entry.MESSAGE));
        const key = source + '\n' + message;
        const time = Number(entry.__REALTIME_TIMESTAMP) / 1000;
        const existing = grouped.get(key);
        if (existing) {
            existing.count++;
            existing.time = Math.max(existing.time, time);
        } else {
            grouped.set(key, {type: 'error_logged', time, source, message, count: 1});
        }
    }
    return [...grouped.values()].map(({count, ...event}) => count > 1 ? {...event, count} : event);
}

export class EventTracker {
    constructor() {
        this._events = [];
        this._sources = new Map();
        this._windows = new Map();
    }

    get active() {
        return Boolean(this._trayAdded);
    }

    start() {
        if (this.active)
            return;
        const tray = Main.messageTray;
        this._trayAdded = tray.connect('source-added', (_tray, source) => this._watchSource(source));
        this._trayRemoved = tray.connect('source-removed', (_tray, source) => this._unwatchSource(source));
        for (const source of tray.getSources?.() ?? [])
            this._watchSource(source);
        this._windowCreated = global.display.connect('window-created', (_display, window) => this._watchWindow(window));
    }

    stop() {
        if (!this.active)
            return;
        Main.messageTray.disconnect(this._trayAdded);
        Main.messageTray.disconnect(this._trayRemoved);
        global.display.disconnect(this._windowCreated);
        this._trayAdded = this._trayRemoved = this._windowCreated = null;
        for (const source of [...this._sources.keys()])
            this._unwatchSource(source);
        for (const [window, id] of this._windows)
            window.disconnect(id);
        this._windows.clear();
        this._events = [];
    }

    _record(event) {
        this._events.push({time: Date.now(), ...event});
        if (this._events.length > MAX_BUFFERED)
            this._events.shift();
    }

    _watchSource(source) {
        if (this._sources.has(source))
            return;
        try {
            this._sources.set(source, source.connect('notification-added', (_source, notification) => this._record({
                type: 'notification',
                application: clip(source.title),
                summary: clip(notification?.title),
                body: clip(notification?.body ?? notification?.bannerBodyText),
                ...(notification?.urgency === 3 ? {urgency: 'critical'} : {}),
            })));
        } catch {
            // Older Shell versions use other signals; notifications are then skipped.
        }
    }

    _unwatchSource(source) {
        const id = this._sources.get(source);
        if (id)
            source.disconnect(id);
        this._sources.delete(source);
    }

    _watchWindow(window) {
        if (!DIALOG_TYPES.has(window.get_window_type()) || this._windows.has(window))
            return;
        // Titles are often set after creation, so read them when reporting.
        const event = {type: 'window_opened', window, dialog: window.get_window_type() !== Meta.WindowType.NORMAL};
        this._record(event);
        this._windows.set(window, window.connect('unmanaged', () => {
            const title = clip(window.get_title());
            const application = appFor(window);
            for (const recorded of this._events) {
                if (recorded.window === window) {
                    recorded.title = title;
                    recorded.application = application;
                    delete recorded.window;
                }
            }
            this._record({type: 'window_closed', title, application,
                dialog: window.get_window_type() !== Meta.WindowType.NORMAL});
            window.disconnect(this._windows.get(window));
            this._windows.delete(window);
        }));
    }

    // Events from the last few minutes, newest first, with seconds_ago.
    async snapshot() {
        const now = Date.now();
        const since = Math.floor(now / 1000) - WINDOW_SECONDS;
        const shell = this._events.filter(event => event.time >= since * 1000).map(({window, ...event}) => window
            ? {...event, title: clip(window.get_title()), application: appFor(window), window_id: window.get_id().toString()}
            : event);
        const [crashed, logged] = await Promise.all([crashes(since), errors(since)]);
        return [...shell, ...crashed, ...logged]
            .sort((a, b) => b.time - a.time)
            .slice(0, MAX_REPORTED)
            .map(({time, ...event}) => ({...event, seconds_ago: Math.max(0, Math.round((now - time) / 1000))}));
    }
}
