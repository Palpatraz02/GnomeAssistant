import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {protectScreenshot} from './imagePrivacy.js';
import {windowInfo} from './desktopContext.js';
import {projectCandidates} from './desktopProject.js';
import {processInfo} from './desktopSystem.js';
import {captureWindowAttachment} from './screenCapture.js';

// "Ask …" from a window's menu: a desktop context about that one window.
// It has the shape prepareDesktopContext() gives (so the chip, the desktop_*
// tools, privacy and the Shared view work alike) plus scope 'window'.
const MAX_WINDOWS = 40;

const readLink = path => {
    try {
        return GLib.file_read_link(path);
    } catch {
        return null;
    }
};
const readText = path => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]).trim() || null;
    } catch {
        return null;
    }
};

// The program behind a window, when its process is known and ours.
function windowProgram(pid) {
    if (!(pid > 0))
        return {};
    const executable = readLink(`/proc/${pid}/exe`);
    const comm = readText(`/proc/${pid}/comm`);
    return {pid, ...(executable ? {executable: executable.replace(/ \(deleted\)$/, '')} : {}), ...(comm ? {comm} : {})};
}

// Events about this application only: its notifications, windows, crashes
// and logged errors. Others belong to the full desktop context.
export function eventsForWindow(events, info) {
    const names = new Set([info.app, info.app_id, info.app_id?.split('.').pop(), info.wm_class, info.comm,
        info.executable && GLib.path_get_basename(info.executable)].filter(Boolean).map(name => name.toLowerCase()));
    const named = value => Boolean(value) && names.has(String(value).toLowerCase());
    return events.filter(event => {
        switch (event.type) {
        case 'notification':
            return named(event.application);
        case 'window_opened':
        case 'window_closed':
            return event.window_id === info.id || named(event.application);
        case 'application_crash':
            return (info.pid && event.pid === info.pid) || (info.executable && event.executable === info.executable) ||
                named(event.program);
        case 'error_logged':
            return named(event.source);
        default:
            return false;
        }
    });
}

// parts: the user's Included Context switches. The window's screenshot and
// details are always included: they are what the menu entry is for.
export async function captureWindowContext(window, {parts, events = null, knownRoots = [], privacy = null}) {
    const tracker = Shell.WindowTracker.get_default();
    const activeWorkspace = global.workspace_manager.get_active_workspace_index();
    const recent = parts.events && events ? events.snapshot().catch(() => []) : Promise.resolve(null);
    const shot = await captureWindowAttachment(window);
    const pid = window.get_pid?.() ?? 0;
    const {comm, ...program} = windowProgram(pid);
    const info = {...windowInfo(window, tracker, activeWorkspace), wm_class: window.get_wm_class() ?? null, ...program};
    const used = {screenshots: true, focusedWindow: true, windows: false, pointer: false, selection: false,
        projects: Boolean(parts.projects), events: Boolean(parts.events), appLogs: Boolean(parts.appLogs), deviceStatus: false};
    let projects = null;
    if (used.projects) {
        // Every window helps: the folder an editor names may be known from a terminal.
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(candidate => !candidate.is_skip_taskbar?.()).slice(0, MAX_WINDOWS);
        try {
            projects = projectCandidates(windows.includes(window) ? windows : [window, ...windows],
                {focused: window, activeWorkspace, knownRoots})
                .filter(candidate => candidate.windows.includes(info.id))
                .map(({windows: _windows, focused: _focused, ...candidate}) => candidate);
        } catch (error) {
            console.warn('GNOME Assistant: Could not infer the window project', error);
            projects = [];
        }
    }
    const rect = window.get_frame_rect();
    const monitor = window.get_monitor();
    const context = {
        id: GLib.uuid_string_random(), scope: 'window', capturedAt: new Date(), parts: used,
        monitors: [{index: monitor, primary: false, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            scale: 1, name: shot.name, image: {bytes: shot.bytes, width: shot.width, height: shot.height}}],
        focusedWindow: info, projects,
        events: used.events ? eventsForWindow((await recent) ?? [], {...info, comm}) : null,
        selection: null,
        processes: used.appLogs ? new Map([[info.id, processInfo(window, tracker.get_window_app(window)?.get_id())]]) : null,
    };
    // The window's own content has no other windows or banners on it; with
    // OCR, secret-looking text is still blacked out before sending.
    context.protection = privacy ? protectScreenshot(context.monitors[0].image).then(result => {
        context.monitors[0].image = result.image;
        context.privacy = {hidden: result.hidden ?? [], secrets: result.secrets ?? [], ocr: result.ocr ?? null};
    }) : Promise.resolve();
    return context;
}
