import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {assistantName} from './assistantName.js';
import {createNotificationSource, showNotification} from './assistantStatus.js';
import {appLogs, run} from './desktopSystem.js';
import {JournalFollower} from './journalFollower.js';
import {classifyProblem, COREDUMP_MESSAGE_ID, OOMD_KILL_MESSAGE_ID, parseJournalEntry, problemKey, problemTitle,
    shouldNotify} from './problemRules.js';
import {getBoolean, getStrv} from './settingsAccess.js';

// Watches for problems the user would want help with, and offers to ask the
// assistant about them: crashes and out-of-memory kills (from the journal)
// and failed services (from systemd). Nothing is sent anywhere: "Fix" only
// fills in a prompt for the user to review and send.

const KEYS = {crashes: 'problem-crashes', memory: 'problem-memory', services: 'problem-services',
    background: 'problem-background', ignored: 'problem-ignored'};
const JOURNAL_FIELDS = ['MESSAGE', 'MESSAGE_ID', '_TRANSPORT', 'COREDUMP_EXE', 'COREDUMP_COMM', 'COREDUMP_PID',
    'COREDUMP_SIGNAL_NAME', 'COREDUMP_UID', 'COREDUMP_UNIT', 'COREDUMP_USER_UNIT'];
// A crashed app's windows close at once: remember their processes a while.
const WINDOW_MEMORY_MS = 2 * 60 * 1000;
const SYSTEMD = 'org.freedesktop.systemd1';

export class ProblemWatcher {
    constructor(settings, {onFix, icon = null}) {
        this._settings = settings;
        this._onFix = onFix;
        this._icon = icon;
        this._recent = new Map();
        this._windowPids = new Map();
        this._units = [];
    }

    start() {
        this._settingsSignals = Object.values(KEYS).map(key =>
            this._settings.connect(`changed::${key}`, () => this._sync()));
        // Processes with windows are "programs the user uses".
        for (const actor of global.get_window_actors())
            this._rememberWindow(actor.get_meta_window());
        this._windowCreated = global.display.connect('window-created', (_display, window) => this._rememberWindow(window));
        this._sync();
    }

    destroy() {
        for (const id of this._settingsSignals ?? [])
            this._settings.disconnect(id);
        this._settingsSignals = null;
        if (this._windowCreated)
            global.display.disconnect(this._windowCreated);
        this._windowCreated = null;
        this._follower?.stop();
        this._follower = null;
        this._stopUnits();
        this._source?.destroy();
        this._source = null;
    }

    _settingsValues() {
        return {crashes: getBoolean(this._settings, KEYS.crashes, true), memory: getBoolean(this._settings, KEYS.memory, true),
            services: getBoolean(this._settings, KEYS.services, false),
            background: getBoolean(this._settings, KEYS.background, false), ignored: getStrv(this._settings, KEYS.ignored)};
    }

    _sync() {
        const settings = this._settingsValues();
        if ((settings.crashes || settings.memory) && !this._follower) {
            this._follower = new JournalFollower([`MESSAGE_ID=${COREDUMP_MESSAGE_ID}`, `MESSAGE_ID=${OOMD_KILL_MESSAGE_ID}`,
                '_TRANSPORT=kernel'], entry => this._fromJournal(entry), {fields: JOURNAL_FIELDS});
            this._follower.start();
        } else if (!settings.crashes && !settings.memory && this._follower) {
            this._follower.stop();
            this._follower = null;
        }
        if (settings.services && !this._units.length)
            this._startUnits();
        else if (!settings.services)
            this._stopUnits();
    }

    _rememberWindow(window) {
        const remember = () => {
            const pid = window.get_pid?.() ?? 0;
            if (pid > 0)
                this._windowPids.set(pid, {app: Shell.WindowTracker.get_default().get_window_app(window), until: Infinity});
        };
        remember();
        // Wayland clients may report their process only once shown.
        const shown = window.connect('shown', remember);
        const gone = window.connect('unmanaged', () => {
            window.disconnect(shown);
            window.disconnect(gone);
            const pid = window.get_pid?.() ?? 0;
            const entry = this._windowPids.get(pid);
            if (entry)
                entry.until = Date.now() + WINDOW_MEMORY_MS;
        });
    }

    _livePids() {
        const now = Date.now();
        for (const [pid, entry] of this._windowPids) {
            if (entry.until < now)
                this._windowPids.delete(pid);
        }
        return new Set(this._windowPids.keys());
    }

    _fromJournal(entry) {
        this._uid ??= new Gio.Credentials().get_unix_user();
        const problem = parseJournalEntry(entry, this._uid);
        if (problem)
            this.handle(problem);
    }

    // Public for tests: decides, names and notifies.
    handle(problem) {
        const kind = classifyProblem(problem, {windowPids: this._livePids()});
        if (!shouldNotify(problem, kind, {settings: this._settingsValues(), recent: this._recent}))
            return null;
        const name = this._displayName(problem);
        return this._notify(problem, name);
    }

    _displayName(problem) {
        const windowApp = problem.pid ? this._windowPids.get(problem.pid)?.app : null;
        const app = windowApp ?? (problem.appId ? Shell.AppSystem.get_default().lookup_app(`${problem.appId}.desktop`) : null);
        return app?.get_name() || problem.program || problem.unit;
    }

    _notify(problem, name) {
        const assistant = assistantName(this._settings);
        if (!this._source || this._source.title !== assistant) {
            this._source?.destroy();
            this._source = createNotificationSource(MessageTray, {title: assistant, icon: this._icon,
                iconName: 'dialog-warning-symbolic'});
            this._source.connect('destroy', source => {
                if (this._source === source)
                    this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const fix = () => this._onFix(problem, name);
        return showNotification(MessageTray, this._source, {
            title: problemTitle(problem, name),
            body: `${assistant} can look into it: you review the question before it is sent.`,
            actions: [{label: `Fix with ${assistant}`, callback: fix},
                {label: `Don't show for ${name}`, callback: () => this._ignore(problem)}],
            onActivate: fix,
        });
    }

    _ignore(problem) {
        const ignored = getStrv(this._settings, KEYS.ignored);
        const key = problemKey(problem);
        if (!ignored.includes(key))
            this._settings.set_strv(KEYS.ignored, [...ignored, key]);
    }

    // Failed services: systemd reports unit changes once subscribed; only a
    // change into "failed" counts, not units that were failed already.
    _startUnits() {
        for (const [bus, scope] of [[Gio.DBus.session, 'user'], [Gio.DBus.system, 'system']]) {
            bus.call(SYSTEMD, '/org/freedesktop/systemd1', `${SYSTEMD}.Manager`, 'Subscribe', null, null,
                Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch {
                        // No systemd on this bus.
                    }
                });
            const id = bus.signal_subscribe(SYSTEMD, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null,
                `${SYSTEMD}.Unit`, Gio.DBusSignalFlags.NONE, (_bus, _sender, path, _iface, _signal, parameters) => {
                    const [, changed] = parameters.deepUnpack();
                    if (changed.ActiveState?.deepUnpack() === 'failed')
                        this._unitFailed(bus, scope, path);
                });
            this._units.push({bus, id});
        }
    }

    _stopUnits() {
        for (const {bus, id} of this._units.splice(0))
            bus.signal_unsubscribe(id);
    }

    _unitFailed(bus, scope, path) {
        const get = (iface, property) => new Promise(resolve => bus.call(SYSTEMD, path, 'org.freedesktop.DBus.Properties',
            'Get', new GLib.Variant('(ss)', [iface, property]), null, Gio.DBusCallFlags.NONE, 2000, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).recursiveUnpack()[0]);
                } catch {
                    resolve(null);
                }
            }));
        Promise.all([get(`${SYSTEMD}.Unit`, 'Id'), get(`${SYSTEMD}.Service`, 'Result')]).then(([unit, result]) => {
            if (unit && this._settingsSignals)
                this.handle({kind: 'service', unit, scope, result, time: Date.now()});
        });
    }
}

// Recent log lines for the prompt, read only when the user asks for a fix.
export async function problemLogs(problem) {
    const format = entries => entries.filter(entry => entry.source !== 'systemd-coredump')
        .map(entry => `${entry.priority ?? 'info'} ${entry.source ?? ''}: ${entry.message}`.trim());
    if (problem.kind === 'service') {
        const output = await run(['journalctl', '--no-pager', '-q', '-o', 'cat', '-n', '20', '--since=-15min',
            ...(problem.scope === 'user' ? ['--user-unit', problem.unit] : ['--unit', problem.unit])]);
        return output.split('\n').filter(Boolean);
    }
    if (problem.pid || problem.appId || problem.unit) {
        const logs = await appLogs({pid: problem.pid, appId: problem.appId ? `${problem.appId}.desktop` : null,
            unit: problem.unit}, {priority: 'info', lines: 30, minutes: 15});
        return format(logs.entries);
    }
    return [];
}
