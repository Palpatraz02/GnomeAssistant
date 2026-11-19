// node --test tests/test_problem_rules.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {appIdFromUnit, classifyProblem, COREDUMP_MESSAGE_ID, OOMD_KILL_MESSAGE_ID, parseJournalEntry, problemKey,
    problemPrompt, problemTitle, REPEAT_WINDOW_MS, shouldNotify, stackTop, unescapeUnit} from '../problemRules.js';

const uid = 1000;
// Shaped like the systemd-coredump entries on a real system.
const coredump = (fields = {}) => ({
    MESSAGE_ID: COREDUMP_MESSAGE_ID, __REALTIME_TIMESTAMP: '1795092560120435', COREDUMP_UID: '1000',
    COREDUMP_COMM: 'nautilus', COREDUMP_EXE: '/usr/bin/nautilus', COREDUMP_PID: '4242', COREDUMP_SIGNAL_NAME: 'SIGSEGV',
    COREDUMP_UNIT: 'user@1000.service', COREDUMP_USER_UNIT: 'app-gnome-org.gnome.Nautilus-4242.scope',
    COREDUMP_ENVIRON: 'GITHUB_TOKEN=ghp_secret\nHOME=/home/u', COREDUMP_CMDLINE: 'nautilus --password=hunter2',
    MESSAGE: 'Process 4242 (nautilus) of user 1000 dumped core.\n\nStack trace of thread 4242:\n#0  0x1 g_main (libglib-2.0.so.0 + 0x1)\n#1  0x2 main (nautilus + 0x2)\n\nStack trace of thread 4243:\n#0  0x3 other',
    ...fields,
});

test('crashes are read from systemd-coredump entries, without the environment or command line', () => {
    const problem = parseJournalEntry(coredump(), uid);
    assert.equal(problem.kind, 'crash');
    assert.equal(problem.program, 'nautilus');
    assert.equal(problem.signal, 'SIGSEGV');
    assert.equal(problem.pid, 4242);
    assert.equal(problem.appId, 'org.gnome.Nautilus');
    assert.deepEqual(problem.stack, ['#0  0x1 g_main (libglib-2.0.so.0 + 0x1)', '#1  0x2 main (nautilus + 0x2)']);
    const all = JSON.stringify(problem);
    assert.ok(!all.includes('ghp_secret') && !all.includes('hunter2'), 'Environment or command line leaked');
    assert.equal(parseJournalEntry(coredump({COREDUMP_UID: '1001'}), uid), null, "another user's crash was accepted");
});

test('out-of-memory kills from the kernel and systemd-oomd', () => {
    const kernel = parseJournalEntry({_TRANSPORT: 'kernel', __REALTIME_TIMESTAMP: '1795092560120435',
        MESSAGE: 'Out of memory: Killed process 777 (firefox) total-vm:1234kB, anon-rss:999kB, UID:1000 pgtables:12kB'}, uid);
    assert.deepEqual([kernel.kind, kernel.program, kernel.pid, kernel.by], ['memory', 'firefox', 777, 'kernel']);
    assert.equal(parseJournalEntry({_TRANSPORT: 'kernel', MESSAGE: 'Out of memory: Killed process 5 (x) UID:0'}, uid), null);
    assert.equal(parseJournalEntry({_TRANSPORT: 'kernel', MESSAGE: 'usb 1-1: new device'}, uid), null);
    const oomd = parseJournalEntry({MESSAGE_ID: OOMD_KILL_MESSAGE_ID, __REALTIME_TIMESTAMP: '1795092560120435',
        MESSAGE: 'Killed /user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.mozilla.firefox-555.scope due to memory pressure for /user.slice/user-1000.slice being 82% > 80% for > 20s with reclaim activity.'}, uid);
    assert.deepEqual([oomd.kind, oomd.appId, oomd.by], ['memory', 'org.mozilla.firefox', 'systemd-oomd']);
});

test('unit names map to app IDs', () => {
    assert.equal(unescapeUnit('app-gnome-brave\\x2dorigin-542827.scope'), 'app-gnome-brave-origin-542827.scope');
    assert.equal(appIdFromUnit('app-gnome-org.gnome.Nautilus-4242.scope'), 'org.gnome.Nautilus');
    assert.equal(appIdFromUnit('app-flatpak-org.gimp.GIMP-99.scope'), 'org.gimp.GIMP');
    assert.equal(appIdFromUnit('app-dbus\\x2d:1.2\\x2dorg.gnome.Nautilus@0.service'), 'org.gnome.Nautilus');
    assert.equal(appIdFromUnit('pipewire.service'), null);
    assert.equal(appIdFromUnit(null), null);
});

test('only programs the user uses notify by default, and repeats are grouped', () => {
    const settings = {crashes: true, memory: true, services: false, background: false, ignored: []};
    const recent = new Map();
    const app = parseJournalEntry(coredump(), uid);
    assert.equal(classifyProblem(app, {windowPids: new Set([4242])}), 'app');
    const helper = parseJournalEntry(coredump({COREDUMP_PID: '9', COREDUMP_COMM: 'chrome_crashpad', COREDUMP_USER_UNIT: 'app-gnome-brave-1.scope'}), uid);
    assert.equal(classifyProblem(helper, {windowPids: new Set([4242])}), 'background');
    const service = parseJournalEntry(coredump({COREDUMP_PID: '10', COREDUMP_COMM: 'pipewire', COREDUMP_USER_UNIT: 'pipewire.service'}), uid);
    assert.equal(classifyProblem(service), 'service');
    const now = 1_000_000;
    assert.ok(shouldNotify(app, 'app', {settings, recent, now}));
    assert.ok(!shouldNotify(app, 'app', {settings, recent, now: now + 60_000}), 'A repeat within the window notified');
    assert.ok(shouldNotify(app, 'app', {settings, recent, now: now + REPEAT_WINDOW_MS + 1}));
    assert.ok(!shouldNotify(helper, 'background', {settings, recent, now}), 'A background helper notified by default');
    assert.ok(shouldNotify(helper, 'background', {settings: {...settings, background: true}, recent: new Map(), now}));
    assert.ok(!shouldNotify(app, 'app', {settings: {...settings, ignored: [problemKey(app)]}, recent: new Map(), now}));
    assert.ok(!shouldNotify(app, 'app', {settings: {...settings, crashes: false}, recent: new Map(), now}));
    const failed = {kind: 'service', unit: 'backup.service', scope: 'user', result: 'exit-code', time: now};
    assert.ok(!shouldNotify(failed, 'service', {settings, recent: new Map(), now}), 'Failed services notified while off');
    assert.ok(shouldNotify(failed, 'service', {settings: {...settings, services: true}, recent: new Map(), now}));
});

test('titles and prompts', () => {
    const problem = parseJournalEntry(coredump(), uid);
    assert.equal(problemTitle(problem, 'Files'), 'Files crashed (SIGSEGV)');
    const local = problemPrompt(problem, {name: 'Files', logs: ['warning: x', 'error: y']});
    assert.match(local, /^Files crashed at .* with SIGSEGV\.\n\nPlease find out why and fix it if you can\. Ask me before changing anything\./);
    assert.ok(local.includes('Program: /usr/bin/nautilus (pid 4242)') && local.includes('#1  0x2 main') &&
        local.includes('error: y'));
    assert.match(problemPrompt(problem, {name: 'Files', remote: true}), /You are not on this computer/);
    assert.equal(problemTitle({kind: 'service', unit: 'backup.service'}), 'backup.service failed');
    assert.equal(problemTitle({kind: 'memory', program: 'firefox'}, 'Firefox'), 'Firefox was closed: out of memory');
    assert.equal(stackTop('no trace here').length, 0);
});
