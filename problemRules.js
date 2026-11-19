// Detectable problems (crashes, out-of-memory kills, failed services), from
// journal entries and systemd, and the prompt that asks the agent about one.
// No GNOME imports: tested with node.

export const COREDUMP_MESSAGE_ID = 'fc2e22bc6ee647b6b90729ab34a250b1';
export const OOMD_KILL_MESSAGE_ID = 'd989611b15e44c9dbf31e3c81256e4ed';
// Repeats of the same program's problem are grouped for this long.
export const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const MAX_STACK_FRAMES = 15;
const MAX_LOG_LINES = 20;

const field = (entry, name) => {
    const value = entry?.[name];
    return Array.isArray(value) ? new TextDecoder().decode(new Uint8Array(value)) : value ?? null;
};
const timeOf = entry => Number(field(entry, '__REALTIME_TIMESTAMP') ?? 0) / 1000 || Date.now();

// systemd escapes '-' and other characters in unit names as \xNN.
export const unescapeUnit = name => String(name ?? '').replace(/\\x([0-9a-f]{2})/gi,
    (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// The app ID behind GNOME's per-application units:
// app-gnome-org.gnome.Nautilus-1234.scope, app-flatpak-org.foo.Bar-1234.scope,
// app-dbus\x2d:1.2\x2dorg.gnome.Nautilus@0.service.
export function appIdFromUnit(unit) {
    const name = unescapeUnit(unit).split('/').pop();
    const match = /^app-(?:gnome|flatpak|dbus-:[\d.]+)-(.+?)(?:-\d+\.scope|@[^.]*\.service|\.service|\.scope)$/.exec(name);
    return match ? match[1] : null;
}

// Only the top frames, which are what identifies a crash.
export function stackTop(message) {
    const lines = String(message ?? '').split('\n');
    const start = lines.findIndex(line => /Stack trace of thread/.test(line));
    if (start < 0)
        return [];
    const frames = [];
    for (const line of lines.slice(start + 1)) {
        const frame = line.trim();
        if (!frame.startsWith('#'))
            break;
        frames.push(frame);
        if (frames.length === MAX_STACK_FRAMES)
            break;
    }
    return frames;
}

// A crash of one of this user's processes, from a systemd-coredump entry.
// Only chosen fields are kept: the environment and command line of a crashed
// process can contain secrets.
export function parseCoredump(entry, uid) {
    if (field(entry, 'MESSAGE_ID') !== COREDUMP_MESSAGE_ID || Number(field(entry, 'COREDUMP_UID')) !== uid)
        return null;
    const exe = field(entry, 'COREDUMP_EXE');
    const program = field(entry, 'COREDUMP_COMM') ?? (exe ? exe.split('/').pop() : 'A program');
    const userUnit = field(entry, 'COREDUMP_USER_UNIT');
    return {
        kind: 'crash', program, exe, pid: Number(field(entry, 'COREDUMP_PID')) || null,
        signal: field(entry, 'COREDUMP_SIGNAL_NAME'), unit: userUnit ?? field(entry, 'COREDUMP_UNIT'),
        appId: appIdFromUnit(userUnit), userService: Boolean(userUnit && /\.service$/.test(userUnit) && !/^app-/.test(userUnit)),
        stack: stackTop(field(entry, 'MESSAGE')), time: timeOf(entry),
    };
}

// The kernel's out-of-memory killer: "Out of memory: Killed process 1234 (name) … UID:1000 …".
export function parseKernelOom(entry, uid) {
    if (field(entry, '_TRANSPORT') !== 'kernel')
        return null;
    const match = /Out of memory: Killed process (\d+) \(([^)]+)\)(?:.*?\bUID:(\d+))?/.exec(field(entry, 'MESSAGE') ?? '');
    if (!match || (match[3] !== undefined && Number(match[3]) !== uid))
        return null;
    return {kind: 'memory', program: match[2], pid: Number(match[1]), by: 'kernel', time: timeOf(entry)};
}

// systemd-oomd kills whole units: "Killed /user.slice/…/app-gnome-firefox-1234.scope due to …".
export function parseOomdKill(entry, uid) {
    if (field(entry, 'MESSAGE_ID') !== OOMD_KILL_MESSAGE_ID)
        return null;
    const match = /Killed (\S+) due to (.+?)(?:\.|$)/.exec(field(entry, 'MESSAGE') ?? '');
    if (!match || !match[1].includes(`/user-${uid}.slice/`))
        return null;
    const unit = unescapeUnit(match[1].split('/').pop());
    const appId = appIdFromUnit(unit);
    return {kind: 'memory', program: appId ?? unit, unit, appId, reason: match[2], by: 'systemd-oomd', time: timeOf(entry)};
}

export function parseJournalEntry(entry, uid) {
    return parseCoredump(entry, uid) ?? parseOomdKill(entry, uid) ?? parseKernelOom(entry, uid);
}

// 'app' (had a window, or a GNOME app unit), 'service' (the user's own
// service) or 'background' (a helper the user never saw).
export function classifyProblem(problem, {windowPids = new Set()} = {}) {
    if (problem.kind === 'service')
        return 'service';
    if ((problem.pid && windowPids.has(problem.pid)) || (problem.kind === 'memory' && problem.appId))
        return 'app';
    if (problem.userService)
        return 'service';
    return 'background';
}

export const problemKey = problem => problem.kind === 'service' ? `service:${problem.unit}` : `program:${problem.appId ?? problem.program}`;

// Whether to notify, given the user's settings and earlier notifications
// (a Map from key to the last time). Records the notification when true.
export function shouldNotify(problem, kind, {settings, recent, now = Date.now()}) {
    const enabled = {crash: settings.crashes, memory: settings.memory, service: settings.services}[problem.kind];
    if (!enabled || (kind === 'background' && !settings.background))
        return false;
    const key = problemKey(problem);
    if (settings.ignored.includes(key))
        return false;
    const last = recent.get(key);
    if (last !== undefined && now - last < REPEAT_WINDOW_MS)
        return false;
    recent.set(key, now);
    return true;
}

export function problemTitle(problem, name = problem.program) {
    if (problem.kind === 'crash')
        return `${name} crashed${problem.signal ? ` (${problem.signal})` : ''}`;
    if (problem.kind === 'memory')
        return `${name} was closed: out of memory`;
    return `${problem.unit} failed`;
}

// The prompt put in the composer for the user to review and send.
// logs: recent log lines, newest last. remote: the agent cannot reach this
// computer, so it is asked for an explanation and steps instead of a fix.
export function problemPrompt(problem, {name = problem.program, logs = [], remote = false} = {}) {
    const when = new Date(problem.time).toLocaleString();
    const what = problem.kind === 'crash'
        ? `${name} crashed at ${when}${problem.signal ? ` with ${problem.signal}` : ''}.`
        : problem.kind === 'memory'
            ? `${name} was killed at ${when} because the system ran out of memory (by ${problem.by}${problem.reason ? `: ${problem.reason}` : ''}).`
            : `The ${problem.scope === 'system' ? 'system' : 'user'} service ${problem.unit} failed at ${when}${problem.result ? ` (${problem.result})` : ''}.`;
    const ask = remote
        ? 'You are not on this computer: explain what most likely caused this and give me the steps to fix it.'
        : 'Please find out why and fix it if you can. Ask me before changing anything.';
    const details = [
        problem.exe ? `Program: ${problem.exe}${problem.pid ? ` (pid ${problem.pid})` : ''}` : null,
        problem.unit && problem.kind !== 'service' ? `Unit: ${problem.unit}` : null,
    ].filter(Boolean);
    const sections = [what, ask];
    if (details.length)
        sections.push(details.join('\n'));
    if (problem.stack?.length)
        sections.push(`Stack trace (top):\n\`\`\`\n${problem.stack.join('\n')}\n\`\`\``);
    const recentLogs = logs.slice(-MAX_LOG_LINES);
    if (recentLogs.length)
        sections.push(`Recent log lines:\n\`\`\`\n${recentLogs.join('\n')}\n\`\`\``);
    return sections.join('\n\n');
}
