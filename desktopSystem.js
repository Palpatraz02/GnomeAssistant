import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

// System state that links the desktop to the machine: per-application logs
// and device status. Every source is standard on GNOME (systemd journal,
// NetworkManager, PipeWire/PulseAudio, BlueZ, UPower, power-profiles-daemon),
// optional, and bounded by a timeout so a missing or hung service is skipped.

const TIMEOUT_MS = 1500;
const MAX_TEXT = 300;
const PRIORITIES = {error: 3, warning: 4, info: 6, debug: 7};
const PRIORITY_NAMES = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

export const clip = text => {
    const characters = [...String(text ?? '').trim()];
    return characters.length > MAX_TEXT ? characters.slice(0, MAX_TEXT).join('') + '…' : characters.join('');
};

// Non-UTF-8 journal messages are serialized as byte arrays.
export const journalText = value => Array.isArray(value) ? new TextDecoder().decode(new Uint8Array(value)) : value;

export async function run(argv) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
    // Parse untranslated output.
    launcher.setenv('LC_ALL', 'C', true);
    const process = launcher.spawnv(argv);
    const cancellable = new Gio.Cancellable();
    const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
        cancellable.cancel();
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        return await new Promise((resolve, reject) => process.communicate_utf8_async(null, cancellable, (source, result) => {
            try {
                resolve(source.communicate_utf8_finish(result)[1] ?? '');
            } catch (error) {
                reject(error);
            }
        }));
    } finally {
        if (!cancellable.is_cancelled())
            GLib.source_remove(timeout);
    }
}

function dbusCall(bus, name, path, iface, method, args = null) {
    return new Promise((resolve, reject) => bus.call(name, path, iface, method, args, null,
        Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, null, (connection, result) => {
            try {
                resolve(connection.call_finish(result).recursiveUnpack());
            } catch (error) {
                reject(error);
            }
        }));
}

const properties = (bus, name, path, iface) =>
    dbusCall(bus, name, path, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [iface]))
        .then(([values]) => values);

// --- Application logs -------------------------------------------------------

// Capture-time process details for a window, kept out of the snapshot. The
// process may exit before the agent asks, which is often why it asks.
export function processInfo(window, appId) {
    const pid = window.get_pid?.() ?? 0;
    let unit = null;
    if (pid > 0) {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cgroup`);
            // "0::/user.slice/.../app.slice/app-gnome-org.gnome.Nautilus-1234.scope"; unit names may contain ':'.
            const line = new TextDecoder().decode(bytes).split('\n').find(entry => entry.startsWith('0::'));
            unit = line?.slice(3).split('/').pop() || null;
        } catch {
            // The process is gone or not ours.
        }
    }
    return {pid: pid > 0 ? pid : null, appId: appId ?? null, unit};
}

// Journal matches for an application's entries, joined by journalctl as OR.
function journalMatches({pid, appId, unit}) {
    const matches = [];
    // GNOME's launch stream logs stdout under the application's desktop ID.
    if (appId)
        matches.push(`SYSLOG_IDENTIFIER=${appId}`, `SYSLOG_IDENTIFIER=${appId.replace(/\.desktop$/, '')}`);
    if (pid)
        matches.push(`_PID=${pid}`);
    // Only per-application units: shared ones, such as GNOME Shell's own
    // service, would return logs from everything else in them.
    if (unit?.startsWith('app-'))
        matches.push(`_SYSTEMD_USER_UNIT=${unit}`);
    if (!matches.length)
        throw new Error('This window has no process information, so its logs cannot be found.');
    return matches.flatMap((match, index) => index ? ['+', match] : [match]);
}

// For agents on this computer: the link from a window to its journal
// entries, which they cannot work out themselves, instead of the logs.
export function windowProcess(process) {
    const command = ['journalctl', '--no-pager', '-p', 'info', '--since=-30min', '-n', '50', ...journalMatches(process)];
    return {pid: process.pid, app_id: process.appId, unit: process.unit,
        journalctl_command: command.map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : GLib.shell_quote(arg)).join(' ')};
}

export async function appLogs(process, {priority = 'info', lines = 50, minutes = 30} = {}) {
    const {pid, appId, unit} = process;
    const matches = journalMatches(process);
    const level = PRIORITIES[priority] ?? PRIORITIES.info;
    const count = Math.min(Math.max(Math.round(lines) || 50, 1), 200);
    const since = Math.min(Math.max(Math.round(minutes) || 30, 1), 1440);
    const output = await run(['journalctl', '--no-pager', '-q', '-o', 'json', '-p', String(level), `--since=-${since}min`,
        '-n', String(count), '--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_COMM,_PID', ...matches]);
    const now = Date.now();
    const entries = [];
    for (const line of output.split('\n')) {
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        entries.push({
            seconds_ago: Math.max(0, Math.round((now - Number(entry.__REALTIME_TIMESTAMP) / 1000) / 1000)),
            priority: PRIORITY_NAMES[Number(entry.PRIORITY)] ?? null,
            source: entry.SYSLOG_IDENTIFIER ?? entry._COMM ?? null,
            message: clip(journalText(entry.MESSAGE)),
        });
    }
    return {application: appId, pid, unit, priority_at_least: PRIORITY_NAMES[level], minutes: since,
        entries: entries.reverse()};
}

// --- Device status ----------------------------------------------------------

// nmcli terse output escapes ':' and '\' inside fields.
const nmFields = line => {
    const fields = [];
    let current = '';
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && i + 1 < line.length)
            current += line[++i];
        else if (line[i] === ':')
            fields.push(current), current = '';
        else
            current += line[i];
    }
    fields.push(current);
    return fields;
};

async function network() {
    const [devices, connectivity, wifi, radio] = await Promise.all([
        run(['nmcli', '-t', '-f', 'TYPE,STATE,CONNECTION,DEVICE', 'device']),
        run(['nmcli', '-t', 'networking', 'connectivity']),
        run(['nmcli', '-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no']).catch(() => ''),
        run(['nmcli', '-t', '-f', 'WIFI,WWAN', 'radio']).catch(() => ''),
    ]);
    const connections = devices.split('\n').filter(Boolean).map(nmFields)
        .filter(([type, state]) => !['loopback', 'wifi-p2p'].includes(type) && state.startsWith('connected'))
        .map(([type, state, connection, device]) => ({type, connection, device,
            ...(state.includes('externally') ? {managed_externally: true} : {})}));
    const active = wifi.split('\n').map(nmFields).find(([isActive]) => isActive === 'yes');
    const [wifiRadio] = nmFields(radio.trim());
    return {
        connectivity: connectivity.trim() || null,
        connections,
        vpn: connections.some(connection => ['vpn', 'wireguard', 'tun'].includes(connection.type)),
        ...(active ? {wifi: {ssid: active[1], signal_percent: Number(active[2]), security: active[3] || 'open'}} : {}),
        ...(wifiRadio ? {wifi_enabled: wifiRadio === 'enabled'} : {}),
    };
}

async function audio() {
    const [info, sinks, sources] = await Promise.all([
        run(['pactl', '--format=json', 'info']).then(JSON.parse),
        run(['pactl', '--format=json', 'list', 'sinks']).then(JSON.parse),
        run(['pactl', '--format=json', 'list', 'sources']).then(JSON.parse),
    ]);
    const describe = device => device && {
        name: device.description ?? device.name,
        muted: Boolean(device.mute),
        volume_percent: Math.round(Math.max(...Object.values(device.volume ?? {})
            .map(channel => parseInt(channel.value_percent, 10)).filter(Number.isFinite), 0)),
        ...(device.active_port ? {port: device.ports?.find(port => port.name === device.active_port)?.description ??
            device.active_port} : {}),
    };
    const realSources = sources.filter(source => !source.name.endsWith('.monitor'));
    return {
        output: describe(sinks.find(sink => sink.name === info.default_sink_name)) ?? null,
        input: describe(realSources.find(source => source.name === info.default_source_name)) ?? null,
        outputs_available: sinks.map(sink => sink.description ?? sink.name),
        inputs_available: realSources.map(source => source.description ?? source.name),
    };
}

async function bluetooth() {
    const [objects] = await dbusCall(Gio.DBus.system, 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
    const adapters = Object.values(objects).map(item => item['org.bluez.Adapter1']).filter(Boolean);
    const devices = Object.values(objects).map(item => item['org.bluez.Device1']).filter(device => device?.Connected);
    return {
        powered: adapters.some(adapter => adapter.Powered),
        connected_devices: devices.map(device => ({name: device.Alias ?? device.Name ?? null, type: device.Icon ?? null})),
    };
}

async function power() {
    const upower = 'org.freedesktop.UPower';
    const [daemon, display] = await Promise.all([
        properties(Gio.DBus.system, upower, '/org/freedesktop/UPower', upower),
        properties(Gio.DBus.system, upower, '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device'),
    ]);
    const states = ['unknown', 'charging', 'discharging', 'empty', 'fully charged', 'pending charge', 'pending discharge'];
    let profile = null;
    for (const [name, path] of [['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
        ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles']]) {
        try {
            profile = (await properties(Gio.DBus.system, name, path, name)).ActiveProfile ?? null;
            break;
        } catch {
            // Try the older name.
        }
    }
    return {
        on_battery: Boolean(daemon.OnBattery),
        ...(display.IsPresent ? {battery: {
            percent: Math.round(display.Percentage),
            state: states[display.State] ?? 'unknown',
            ...(display.TimeToEmpty ? {minutes_to_empty: Math.round(display.TimeToEmpty / 60)} : {}),
            ...(display.TimeToFull ? {minutes_to_full: Math.round(display.TimeToFull / 60)} : {}),
        }} : {}),
        power_profile: profile,
    };
}

function setting(schema, key) {
    const source = Gio.SettingsSchemaSource.get_default();
    const found = source.lookup(schema, true);
    if (!found?.has_key(key))
        return undefined;
    return new Gio.Settings({settings_schema: found}).get_value(key).recursiveUnpack();
}

function session() {
    const manager = Keyboard.getInputSourceManager?.();
    const current = manager?.currentSource;
    return {
        do_not_disturb: setting('org.gnome.desktop.notifications', 'show-banners') === false,
        color_scheme: setting('org.gnome.desktop.interface', 'color-scheme') ?? null,
        night_light: setting('org.gnome.settings-daemon.plugins.color', 'night-light-enabled') ?? null,
        text_scaling: setting('org.gnome.desktop.interface', 'text-scaling-factor') ?? null,
        screen_reader: setting('org.gnome.desktop.a11y.applications', 'screen-reader-enabled') ?? null,
        keyboard_layout: current ? {current: current.displayName ?? current.id,
            available: Object.values(manager.inputSources ?? {}).map(source => source.displayName ?? source.id)} : null,
        session_type: GLib.getenv('XDG_SESSION_TYPE') ?? null,
    };
}

// Each section is independent: one missing service never hides the others.
export async function deviceStatus() {
    const sections = {network, audio, bluetooth, power};
    const results = await Promise.all(Object.entries(sections).map(async ([name, read]) => {
        try {
            return [name, await read()];
        } catch {
            return [name, {unavailable: true}];
        }
    }));
    let sessionState;
    try {
        sessionState = session();
    } catch {
        sessionState = {unavailable: true};
    }
    return {...Object.fromEntries(results), session: sessionState};
}
