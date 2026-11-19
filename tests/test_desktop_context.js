#!/usr/bin/env node
// Desktop context snapshot and instructions: per-part settings, and the split
// between attached data and details fetched with desktop_* tools.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let source = fs.readFileSync(path.join(__dirname, '..', 'desktopContext.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^Gio\._promisify.*\n/gm, '')
    .replace(/^export /gm, '');
source += '\nthis.api = {desktopContextSnapshot, desktopContextInstructions, desktopContextLabel, desktopContextDetail, desktopContextForAgent, DESKTOP_CONTEXT_PARTS, pngSize};';
const context = {GLib: {DateTime: {new_from_unix_local: () => ({format_iso8601: () => '2026-11-18T10:36:00+01'})}}, console,
    windowProcess: process => ({...process, journalctl_command: `journalctl _PID=${process.pid}`})};
vm.runInNewContext(source, context);
const {desktopContextSnapshot, desktopContextInstructions, desktopContextLabel, desktopContextDetail, desktopContextForAgent,
    DESKTOP_CONTEXT_PARTS} = context.api;

const partsWith = enabled => Object.fromEntries(DESKTOP_CONTEXT_PARTS.map(part => [part, enabled(part)]));
const ALL = partsWith(() => true);
const NONE = partsWith(() => false);
const snapshot = (desktop, options) => JSON.parse(desktopContextSnapshot(desktop, {host: 'local'}, options).replace(/^[^{]*/, ''));

function capture(parts) {
    const long = 'x'.repeat(300);
    return {
        parts, capturedAt: new Date(),
        monitors: [{index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
            ...(parts.screenshots ? {name: 'monitor-0.png', image: {bytes: [], width: 960, height: 540}} : {})}],
        focusedWindow: {id: '1', title: 'localhost:3000', app: 'Firefox'},
        workspaces: {count: 2, active: 0},
        windows: [
            {id: '1', title: 'localhost:3000', app: 'Firefox', visible: true, focused: true, minimized: false},
            {id: '2', title: 'my-project', app: 'Code', visible: false, minimized: true},
        ],
        omitted: 0,
        pointer: {x: 100, y: 100, monitor: 0, window_id: '1'},
        selection: parts.selection ? {type: 'text', content: long, length: 300, truncated: false, seconds_since_selected: 4} : null,
        projects: [{path: '/home/user/my-project', marker: '.git', windows: ['2'], sources: ['window_title'], focused: true}],
        events: [{type: 'notification', application: 'Files', summary: 'Operation failed', seconds_ago: 8, window_id: '2'},
            {type: 'application_crash', program: 'nautilus', seconds_ago: 20},
            {type: 'error_logged', source: 'udisksd', message: 'mount failed', seconds_ago: 21}],
        processes: new Map([['1', {pid: 4821, appId: 'firefox.desktop', unit: 'app-gnome-firefox-4821.scope'}]]),
    };
}

function test(name, body) {
    body();
    console.log(`[PASS] ${name}`);
}

test('Without tools, every enabled part is attached in full', () => {
    const extras = {appLogs: {entries: [{message: 'boom'}]}, deviceStatus: {audio: {output: {muted: true}}}};
    const withExtras = snapshot(capture(ALL), {extras});
    assert.equal(withExtras.app_logs.entries[0].message, 'boom');
    assert.equal(withExtras.device_status.audio.output.muted, true);
    const json = snapshot(capture(ALL));
    assert.deepEqual(json.pointer.screenshot, [50, 50]);
    assert.equal(json.windows.length, 2);
    assert.equal(json.selection.content.length, 300);
    assert.equal(json.recent_events.length, 3);
    assert.equal(json.projects.candidates[0].path, '/home/user/my-project');
    assert.ok(!desktopContextInstructions(capture(ALL)).includes('desktop_get_'));
});

test('With tools, details are summarized and fetched on request', () => {
    const json = snapshot(capture(ALL), {onRequest: true});
    assert.equal(json.windows, undefined);
    assert.deepEqual(json.visible_windows.map(window => window.id), ['1']);
    assert.equal(json.all_windows_count, 2);
    assert.equal(json.selection.content, undefined);
    assert.equal([...json.selection.preview].length, 121);
    assert.equal(json.recent_events.count, 3);
    assert.equal(json.recent_events.by_type.notification, 1);
    assert.equal(json.projects.focused, '/home/user/my-project');
    assert.equal(json.projects.candidates, undefined);
    assert.ok(json.monitors[0].screenshot, 'Screenshots stay attached');
    const instructions = desktopContextInstructions(capture(ALL), {onRequest: true});
    assert.equal(snapshot(capture(ALL), {onRequest: true, extras: {deviceStatus: {}}}).device_status, undefined,
        'Tool mode never attaches extras');
    for (const name of ['desktop_get_windows', 'desktop_get_selection', 'desktop_get_projects',
        'desktop_get_recent_events', 'desktop_capture_window', 'desktop_get_app_logs', 'desktop_get_device_status'])
        assert.ok(instructions.includes(name), `${name} is explained`);
});

test('Tool details return the full data', () => {
    const desktop = capture(ALL);
    assert.equal(desktopContextDetail(desktop, 'windows').windows.length, 2);
    assert.equal(desktopContextDetail(desktop, 'selection').content.length, 300);
    assert.deepEqual(desktopContextDetail(desktop, 'projects')[0].windows, ['2']);
    assert.equal(desktopContextDetail(desktop, 'events')[0].window_id, '2');
});

test('Disabled parts are neither attached nor described', () => {
    const desktop = capture(NONE);
    for (const onRequest of [false, true]) {
        const json = snapshot(desktop, {onRequest, extras: {appLogs: {}, deviceStatus: {}}});
        assert.deepEqual(Object.keys(json).sort(), ['captured_at', 'coordinates', 'monitors', 'trigger', 'version']);
        const instructions = desktopContextInstructions(desktop, {onRequest});
        assert.ok(instructions.includes('monitor layout only'));
        assert.ok(!instructions.includes('screenshot per monitor'));
        assert.ok(!instructions.includes('desktop_capture_window'));
        assert.ok(!instructions.includes('device_status') && !instructions.includes('app_logs'));
    }
    assert.equal(desktopContextLabel(desktop).split(' · ')[0], 'No screenshots');
});

test('Window ids are dropped when no window details are included', () => {
    const desktop = capture({...NONE, pointer: true, projects: true, events: true});
    const json = snapshot(desktop);
    assert.equal(json.pointer.window_id, undefined);
    assert.equal(json.pointer.screenshot, null);
    assert.equal(json.projects.candidates[0].windows, undefined);
    assert.equal(json.recent_events[0].window_id, undefined);
    assert.ok(desktopContextInstructions(desktop).includes('Only these parts were included: mouse position, project directories, recent events.'));
});

test('A local agent is not sent what it can read itself', () => {
    const local = desktopContextForAgent(capture(ALL), {local: true, skipLocal: true});
    assert.equal(local.parts.deviceStatus, false);
    assert.equal(local.parts.appLogs, false);
    assert.equal(local.parts.appProcess, true);
    assert.deepEqual(local.events.map(event => event.type), ['notification']);
    const json = snapshot(local, {extras: {appLogs: {entries: []}, deviceStatus: {}}});
    assert.equal(json.device_status, undefined);
    assert.equal(json.app_logs, undefined);
    assert.equal(json.focused_process.journalctl_command, 'journalctl _PID=4821');
    assert.equal(json.recent_events.length, 1);
    const instructions = desktopContextInstructions(local, {onRequest: true});
    for (const hint of ['coredumpctl', 'nmcli', 'pactl', 'desktop_get_window_process', 'If your environment blocks'])
        assert.ok(instructions.includes(hint), `${hint} is explained`);
    assert.ok(!instructions.includes('desktop_get_device_status') && !instructions.includes('desktop_get_app_logs'));
    assert.equal(snapshot(local, {onRequest: true}).focused_process, undefined, 'Tool mode links processes on request');
});

test('Remote agents, or turning the setting off, keep every part', () => {
    for (const options of [{local: false, skipLocal: true}, {local: true, skipLocal: false}]) {
        const view = desktopContextForAgent(capture(ALL), options);
        assert.equal(view.localSkipped.length, 0);
        assert.equal(view.parts.deviceStatus, true);
        assert.equal(view.parts.appProcess, undefined);
        assert.equal(view.events.length, 3);
        assert.ok(!desktopContextInstructions(view).includes('You run on the user'));
    }
});

test('Screenshot sizes are read from the PNG header', () => {
    // Regression: a refactor once deleted this helper, breaking every capture.
    assert.equal(typeof context.api.pngSize, 'function');
    const header = new Uint8Array(24);
    header.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(header.buffer).setUint32(16, 2560);
    new DataView(header.buffer).setUint32(20, 1440);
    assert.equal(JSON.stringify(context.api.pngSize(header)), JSON.stringify({width: 2560, height: 1440}));
    assert.equal(context.api.pngSize(new Uint8Array(24)), null);
});

// Collected text is redacted through the snapshot's transform hook.
import('../secretScanner.js').then(({redactDeep}) => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const desktop = capture(ALL);
    desktop.selection = {type: 'text', content: `export GITHUB_TOKEN=${token}`, length: 60, truncated: false, seconds_since_selected: 2};
    desktop.focusedWindow = {...desktop.focusedWindow, title: `Password: Tr0ub4dor&3 — ${token}`};
    const text = desktopContextSnapshot(desktop, {host: 'local'}, {transform: value => redactDeep(value).value});
    assert.ok(!text.includes(token) && !text.includes('Tr0ub4dor'), 'Collected text kept a secret');
    assert.ok(text.includes('[redacted GitHub token]'), 'The redaction label is missing');
    console.log('[PASS] Secrets in collected text are redacted before sending');
});

// The same for a window context ("Ask …" in a window's menu): title, events and logs.
import('../secretScanner.js').then(({redactDeep}) => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const window = {id: '7', title: `deploy.sh — GITHUB_TOKEN=${token}`, app: 'Terminal', app_id: 'org.gnome.Ptyxis',
        monitor: 0, workspace: 0, geometry: {x: 0, y: 0, width: 800, height: 600}, pid: 42, executable: '/usr/bin/ptyxis'};
    const desktop = {scope: 'window', capturedAt: new Date(), parts: {...partsWith(() => false), screenshots: true,
        focusedWindow: true, projects: true, events: true, appLogs: true},
    monitors: [{index: 0, x: 0, y: 0, width: 800, height: 600, name: 'deploy.png', image: {bytes: new Uint8Array(1), width: 800, height: 600}}],
    focusedWindow: window, projects: [{path: '/home/u/app', marker: '.git', sources: ['window_title']}],
    events: [{type: 'notification', application: 'Terminal', summary: 'Login', body: 'password: Tr0ub4dor&3', seconds_ago: 5}]};
    const extras = {appLogs: {entries: [{priority: 'info', source: 'ptyxis', message: `Authorization: Bearer ${token}`}]}};
    const text = desktopContextSnapshot(desktop, {host: 'ssh'}, {extras, transform: value => redactDeep(value).value});
    assert.ok(text.startsWith('Window context snapshot: '), 'Not a window snapshot');
    assert.ok(!text.includes(token) && !text.includes('Tr0ub4dor'), 'The window context kept a secret: ' + text);
    assert.ok(text.includes('/home/u/app') && text.includes('Terminal'), 'Redaction removed ordinary details');
    console.log('[PASS] Secrets in a window context are redacted before sending');
});
