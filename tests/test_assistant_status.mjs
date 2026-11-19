// Top-bar state, notification text and the GNOME 45 / 46+ notification APIs.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source = await readFile(new URL('../assistantStatus.js', import.meta.url), 'utf8');
const {indicatorState, plainSummary, truncateText, approvalNotice, createNotificationSource, showNotification,
    SUMMARY_CHARS, REVIEWABLE_CHARS} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('the most urgent state wins', () => {
    assert.equal(indicatorState(), 'idle');
    assert.equal(indicatorState({unread: true}), 'unread');
    assert.equal(indicatorState({running: true, unread: true}), 'working');
    assert.equal(indicatorState({running: true, approvals: 1, unread: true}), 'approval');
    assert.equal(indicatorState({approvals: 2}), 'approval');
});

test('reply summaries are the first sentence in plain text', () => {
    assert.equal(plainSummary('## Done\n\nI **updated** [the notes](file:///tmp/notes.md) and `README.md`. Next, run tests.'),
        'Done I updated the notes and README.md.');
    assert.equal(plainSummary('- first item\n- second item'), 'first item second item');
    assert.equal(plainSummary('> Quoted *answer* here! More.'), 'Quoted answer here!');
    assert.equal(plainSummary('![chart](<https://example.com/a.png>)'), 'chart');
    assert.equal(plainSummary('```sh\nls -la\n```\nListed.'), 'ls -la Listed.');
    assert.equal(plainSummary('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'a b 1 2');
    assert.equal(plainSummary('Keep snake_case_names and notes.txt intact.'), 'Keep snake_case_names and notes.txt intact.');
    assert.equal(plainSummary(''), '');
    const long = plainSummary('word '.repeat(80));
    assert.ok(long.length <= SUMMARY_CHARS && long.endsWith('…') && !long.includes('  '), long);
    assert.equal(truncateText('x'.repeat(200), 10), 'xxxxxxxxx…');
});

test('approvals are offered from a notification only when fully shown', () => {
    const short = approvalNotice({title: 'Run this command?', details: 'ls -la', canAccept: true});
    assert.deepEqual(short, {title: 'Run this command?', body: 'ls -la', reviewable: true});
    const long = approvalNotice({title: 'Apply these file changes?', details: 'x '.repeat(REVIEWABLE_CHARS), canAccept: true});
    assert.equal(long.reviewable, false);
    assert.equal(long.title, 'Apply these file changes?');
    assert.match(long.body, /^.{1,120}\nOpen the chat to review the full request\.$/);
    assert.equal(approvalNotice({title: 'Allow this action?', details: 'short', canAccept: false}).reviewable, false);
});

class Emitter {
    constructor() { this.handlers = {}; }
    connect(name, handler) { (this.handlers[name] ??= []).push(handler); return 1; }
    emit(name) { for (const handler of this.handlers[name] ?? []) handler(); }
}

// GNOME Shell 45: positional constructors, setUrgency() and showNotification().
const legacyTray = {
    Urgency: {LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3},
    Source: class extends Emitter {
        constructor(title, iconName) { super(); Object.assign(this, {title, iconName, shown: []}); }
        showNotification(notification) { this.shown.push(notification); }
    },
    Notification: class extends Emitter {
        constructor(source, title, body) { super(); Object.assign(this, {source, title, body, actions: []}); }
        setUrgency(urgency) { this.urgency = urgency; }
        addAction(label, callback) { this.actions.push({label, callback}); }
    },
};

// GNOME Shell 46+: property objects, urgency property and addNotification().
const modernTray = {
    Urgency: legacyTray.Urgency,
    Source: class extends Emitter {
        constructor(params) { super(); Object.assign(this, params, {added: []}); }
        addNotification(notification) { this.added.push(notification); }
    },
    Notification: class extends Emitter {
        constructor(params) { super(); Object.assign(this, params, {actions: []}); }
        addAction(label, callback) { this.actions.push({label, activate: callback}); }
    },
};

test('notifications use the GNOME 45 API', () => {
    const source = createNotificationSource(legacyTray, {title: 'Jarvis', icon: {}, iconName: 'dialog-information-symbolic'});
    assert.equal(source.title, 'Jarvis');
    assert.equal(source.iconName, 'dialog-information-symbolic');
    let decided = null, opened = 0;
    const notice = showNotification(legacyTray, source, {title: 'Jarvis', body: 'Run?', urgent: true,
        actions: [{label: 'Allow once', callback: () => {decided = true;}}], onActivate: () => opened++});
    assert.deepEqual(source.shown, [notice]);
    assert.equal(notice.urgency, legacyTray.Urgency.HIGH);
    notice.actions[0].callback();
    notice.emit('activated');
    assert.equal(decided, true);
    assert.equal(opened, 1);
});

test('notifications use the GNOME 46+ API', () => {
    const icon = {name: 'assistant'};
    const source = createNotificationSource(modernTray, {title: 'Jarvis', icon, iconName: 'fallback'});
    assert.equal(source.icon, icon);
    assert.equal(source.iconName, undefined);
    const notice = showNotification(modernTray, source, {title: 'Jarvis', body: 'Done.',
        actions: [{label: 'Decline', callback: () => {}}]});
    assert.deepEqual(source.added, [notice]);
    assert.equal(notice.body, 'Done.');
    assert.equal(notice.urgency, undefined);
    assert.deepEqual(notice.actions.map(action => action.label), ['Decline']);
});

test('without notification actions, a notification still opens the chat', () => {
    class Plain extends modernTray.Notification {}
    Plain.prototype.addAction = undefined;
    const tray = {...modernTray, Notification: Plain};
    let opened = 0;
    const notice = showNotification(tray, createNotificationSource(tray, {title: 'A'}), {title: 'A', body: 'Run?',
        actions: [{label: 'Allow once', callback: () => assert.fail('no actions')}], onActivate: () => opened++});
    notice.emit('activated');
    assert.equal(opened, 1);
    assert.deepEqual(notice.actions, []);
});
