import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {attachmentName} from './attachments.js';
import {fitScreenshot} from './desktopContext.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

// Drags smaller than this (in logical pixels) are clicks, not selections.
const MIN_AREA_EDGE = 4;
const MAX_NAME_CHARS = 80;
// Waiting for a frame is only for the user's eyes, so never wait long.
const FRAME_TIMEOUT_MS = 250;
const HINTS = {
    area: 'Drag to select an area · Esc to cancel',
    window: 'Click a window to attach it · Esc to cancel',
};

// The rectangle between two pointer positions, in whole stage pixels and
// clamped to the stage; null while it is too small to be a selection.
export function selectionRect([startX, startY], [endX, endY], {width, height}) {
    const clamp = (value, max) => Math.min(Math.max(value, 0), max);
    const left = clamp(Math.floor(Math.min(startX, endX)), width);
    const top = clamp(Math.floor(Math.min(startY, endY)), height);
    const right = clamp(Math.ceil(Math.max(startX, endX)), width);
    const bottom = clamp(Math.ceil(Math.max(startY, endY)), height);
    if (right - left < MIN_AREA_EDGE || bottom - top < MIN_AREA_EDGE)
        return null;
    return {x: left, y: top, width: right - left, height: bottom - top};
}

// Four shades around the selection, so it shows undimmed; without one the
// first shade dims everything.
export function shadeRects(rect, {width, height}) {
    if (!rect)
        return [{x: 0, y: 0, width, height}, ...Array(3).fill({x: 0, y: 0, width: 0, height: 0})];
    const bottom = rect.y + rect.height, right = rect.x + rect.width;
    return [
        {x: 0, y: 0, width, height: Math.max(rect.y, 0)},
        {x: 0, y: bottom, width, height: Math.max(height - bottom, 0)},
        {x: 0, y: rect.y, width: Math.max(rect.x, 0), height: rect.height},
        {x: right, y: rect.y, width: Math.max(width - right, 0), height: rect.height},
    ];
}

// candidates are ordered topmost first, so the first hit is the visible one.
export function windowAt(candidates, x, y) {
    return candidates.find(({rect}) => x >= rect.x && x < rect.x + rect.width &&
        y >= rect.y && y < rect.y + rect.height) ?? null;
}

// Client-side decorations draw shadows inside the window buffer: keep only
// the frame, in texture pixels. Falls back to the whole texture.
export function frameCrop(buffer, frame, textureWidth, textureHeight) {
    const scale = buffer.width > 0 ? textureWidth / buffer.width : 1;
    const x = Math.max(Math.round((frame.x - buffer.x) * scale), 0);
    const y = Math.max(Math.round((frame.y - buffer.y) * scale), 0);
    const width = Math.min(Math.round(frame.width * scale), textureWidth - x);
    const height = Math.min(Math.round(frame.height * scale), textureHeight - y);
    if (width <= 0 || height <= 0)
        return {x: 0, y: 0, width: -1, height: -1};
    return {x, y, width, height};
}

// Window titles come from applications: keep them usable as attachment names.
export function captureName(label, fallback) {
    const clean = String(label ?? '').replace(/[/\\]+/g, '-').replace(/[\x00-\x1f\x7f\s]+/g, ' ')
        .replace(/^[\s.]+/, '');
    const base = [...clean].slice(0, MAX_NAME_CHARS).join('').replace(/[\s.]+$/, '');
    return `${base || fallback}.png`;
}

function stageSize() {
    return {width: global.stage.width, height: global.stage.height};
}

// Normal windows on screen, topmost first. Shell chrome and the picker are
// not windows, and menus or tooltips have other window types.
function pickableWindows() {
    const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
        Meta.WindowType.UTILITY];
    const workspace = global.workspace_manager.get_active_workspace();
    return global.get_window_actors()
        .map(actor => actor.get_meta_window())
        .filter(window => window && types.includes(window.get_window_type()) && !window.minimized &&
            window.showing_on_its_workspace() && window.located_on_workspace(workspace))
        .reverse()
        .map(window => ({window, rect: window.get_frame_rect()}));
}

function windowLabel(window) {
    return window.get_title() || Shell.WindowTracker.get_default().get_window_app(window)?.get_name() || '';
}

// The overlay has just been destroyed: let a frame without it reach the
// screen, so the user sees what is captured.
function nextFrame() {
    return new Promise(resolve => {
        let timeoutId = 0;
        const paintId = global.stage.connect('after-paint', () => done());
        const done = () => {
            global.stage.disconnect(paintId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = 0;
            resolve();
        };
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_TIMEOUT_MS, () => {
            timeoutId = 0;
            done();
            return GLib.SOURCE_REMOVE;
        });
        global.stage.queue_redraw();
    });
}

// A full-stage overlay above everything, holding a modal grab while the user
// selects. It resolves with {rect} or {window}, or null when cancelled.
class CapturePicker {
    constructor(mode, resolve, reject) {
        this._mode = mode;
        this._resolve = resolve;
        this._reject = reject;
        this._start = null;
        this._rect = null;
        this._window = null;
        this._signals = [];
        this._actor = new St.Widget({style_class: 'ai-capture-overlay', reactive: true, can_focus: true,
            accessible_name: HINTS[mode]});
        this._actor.add_constraint(new Clutter.BindConstraint({source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL}));
        this._shades = Array.from({length: 4}, () => new St.Widget({style_class: 'ai-capture-shade'}));
        this._frame = new St.Widget({style_class: `ai-capture-frame ai-capture-${mode}`, visible: false});
        this._tag = new St.Label({style_class: 'ai-capture-tag', visible: false});
        this._hint = new St.Label({style_class: 'ai-capture-tag ai-capture-hint', text: HINTS[mode]});
        for (const child of [...this._shades, this._frame, this._tag, this._hint])
            this._actor.add_child(child);
        this._actor.connect('event', (_actor, event) => this._onEvent(event));
    }

    get mode() {
        return this._mode;
    }

    // Exposed for checks: what a click or Enter would pick now.
    get selection() {
        return this._mode === 'area' ? this._rect : this._window;
    }

    open() {
        Main.uiGroup.add_child(this._actor);
        Main.uiGroup.set_child_above_sibling(this._actor, null);
        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        // Another modal, such as the lock screen, already holds the keyboard.
        if (typeof this._grab?.get_seat_state === 'function' &&
            !(this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
            this.finish(null);
            return;
        }
        this._actor.grab_key_focus();
        if (this._mode === 'area')
            this._setCrosshair(true);
        // Anything that changes the screen under the picker cancels it; the
        // overlay must never cover the lock screen.
        const cancel = () => this.finish(null);
        this._signals.push([Main.sessionMode, Main.sessionMode.connect('updated', cancel)],
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', cancel)],
            [Main.overview, Main.overview.connect('showing', cancel)]);
        if (Main.screenShield)
            this._signals.push([Main.screenShield, Main.screenShield.connect('active-changed', cancel)]);
        this._placeHint();
        if (this._mode === 'window')
            this._hover(...global.get_pointer());
        this._update();
    }

    finish(result, error = null) {
        if (this._done)
            return;
        this._done = true;
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        if (this._mode === 'area')
            this._setCrosshair(false);
        this._actor.destroy();
        if (error)
            this._reject(error);
        else
            this._resolve(result);
    }

    // Actors set their own cursor on GNOME 48 and later; earlier, the display does.
    _setCrosshair(enabled) {
        if (typeof this._actor.set_cursor_type === 'function') {
            if (enabled)
                this._actor.set_cursor_type(Clutter.CursorType.CROSSHAIR);
        } else if (Meta.Cursor) {
            global.display.set_cursor(enabled ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT);
        }
    }

    _onEvent(event) {
        const type = event.type();
        // Crossing events must propagate; everything else stops here.
        if (type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (type === Clutter.EventType.KEY_PRESS) {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape)
                this.finish(null);
            else if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(key))
                this._confirm();
        } else if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this.finish(null);
            } else if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                if (this._mode === 'window') {
                    this._hover(x, y);
                    this._confirm();
                } else {
                    this._start = [x, y];
                    this._rect = null;
                    this._hint.hide();
                    this._update();
                }
            }
        } else if (type === Clutter.EventType.MOTION) {
            if (this._mode === 'window')
                this._hover(x, y);
            else if (this._start)
                this._drag(x, y);
        } else if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY &&
            this._start) {
            this._drag(x, y);
            this._start = null;
            if (this._rect) {
                this._confirm();
            } else {
                this._hint.show();
                this._update();
            }
        }
        return Clutter.EVENT_STOP;
    }

    _drag(x, y) {
        this._rect = selectionRect(this._start, [x, y], stageSize());
        this._update();
    }

    _hover(x, y) {
        const hit = windowAt(pickableWindows(), x, y);
        if (hit?.window === this._window)
            return;
        this._window = hit?.window ?? null;
        this._rect = hit?.rect ?? null;
        this._update();
    }

    _confirm() {
        if (this._mode === 'area' && this._rect)
            this.finish({rect: this._rect});
        else if (this._mode === 'window' && this._window)
            this.finish({window: this._window});
    }

    _update() {
        const size = stageSize();
        for (const [index, rect] of shadeRects(this._rect, size).entries()) {
            this._shades[index].set_position(rect.x, rect.y);
            this._shades[index].set_size(rect.width, rect.height);
        }
        const rect = this._rect;
        this._frame.visible = this._tag.visible = Boolean(rect);
        if (!rect)
            return;
        this._frame.set_position(rect.x, rect.y);
        this._frame.set_size(rect.width, rect.height);
        this._tag.text = this._mode === 'area' ? `${rect.width} × ${rect.height}` : windowLabel(this._window);
        // Below the selection, else above it, else inside its top edge.
        const [, height] = this._tag.get_preferred_height(-1);
        const [, width] = this._tag.get_preferred_width(-1);
        const gap = 8;
        let y = rect.y + rect.height + gap;
        if (y + height > size.height)
            y = rect.y - gap - height >= 0 ? rect.y - gap - height : rect.y + gap;
        this._tag.set_position(Math.max(Math.min(rect.x, size.width - width), 0), y);
    }

    _placeHint() {
        const monitor = Main.layoutManager.primaryMonitor ?? {x: 0, y: 0, ...stageSize()};
        const [, width] = this._hint.get_preferred_width(-1);
        this._hint.set_position(Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height / 8));
    }
}

let activePicker = null;

// The picker currently shown, if any, for the native tests.
export function activeCapturePicker() {
    return activePicker;
}

// Closes a shown picker as if the user cancelled, such as when disabling.
export function cancelPick() {
    activePicker?.finish(null);
}

async function pick(mode) {
    if (activePicker)
        return null;
    let choice;
    try {
        choice = await new Promise((resolve, reject) => {
            activePicker = new CapturePicker(mode, resolve, reject);
            try {
                activePicker.open();
            } catch (error) {
                activePicker.finish(null, error);
            }
        });
    } finally {
        activePicker = null;
    }
    if (!choice)
        return null;
    await nextFrame();
    const stamp = GLib.DateTime.new_now_local().format('%H%M%S');
    if (choice.rect) {
        const {x, y, width, height} = choice.rect;
        const stream = Gio.MemoryOutputStream.new_resizable();
        // Shell captures at the highest scale of the monitors it covers.
        await new Shell.Screenshot().screenshot_area(x, y, width, height, stream);
        stream.close(null);
        return {name: `area-${stamp}.png`, area: {x, y, width, height}, ...await fitScreenshot(stream.steal_as_bytes())};
    }
    return captureWindowAttachment(choice.window);
}

// A window as an image attachment, named after it: also used by the window
// menu's "Ask …" entry.
export async function captureWindowAttachment(window) {
    const stamp = GLib.DateTime.new_now_local().format('%H%M%S');
    return {name: attachmentName(captureName(windowLabel(window), `window-${stamp}`)), window,
        ...await captureWindowContent(window)};
}

// The window's own content, even where other windows cover it.
async function captureWindowContent(window) {
    const actor = window.get_compositor_private();
    if (!actor)
        throw new Error('The window closed before it could be captured.');
    const texture = actor.paint_to_content(null)?.get_texture();
    if (!texture)
        throw new Error('Could not capture that window.');
    const crop = frameCrop(window.get_buffer_rect(), window.get_frame_rect(), texture.get_width(), texture.get_height());
    const stream = Gio.MemoryOutputStream.new_resizable();
    await Shell.Screenshot.composite_to_stream(texture, crop.x, crop.y, crop.width, crop.height, 1, null, 0, 0, 1,
        stream);
    stream.close(null);
    return fitScreenshot(stream.steal_as_bytes());
}

// Both resolve to {name, bytes, width, height} (a PNG of at most 1920 pixels
// per edge) plus `area` (stage rectangle) or `window`, or null when the user
// cancels. Call them with the overview closed.
export function pickArea() {
    return pick('area');
}

export function pickWindow() {
    return pick('window');
}
