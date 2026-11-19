import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AiView } from './aiView.js';
import {migrateAssistantData} from './state.js';
import {assistantName} from './assistantName.js';
import {privateApps, privateRegions, privateWindowLabel, protectScreenshot} from './screenPrivacy.js';
import {COPIED_FILE_TYPES, copiedFilePaths} from './attachments.js';
import {captureDesktop, DESKTOP_CONTEXT_PARTS, prepareDesktopContext, SelectionTracker} from './desktopContext.js';
import {EventTracker} from './desktopEvents.js';
import {cancelPick, pickArea, pickWindow} from './screenCapture.js';
import {captureWindowContext} from './windowContext.js';
import {BackgroundStatus} from './statusIndicator.js';
import {getBoolean, getStrv, getString} from './settingsAccess.js';
import {problemLogs, ProblemWatcher} from './problemWatcher.js';
import {problemPrompt} from './problemRules.js';
import {redactSecrets} from './secretScanner.js';

const PROMPT_EXPAND_MS = 240;
const PROMPT_WIDTH = 720;
const PROMPT_MAX_LINES = 7;
const SKILL_SUGGESTIONS_HEIGHT = 168;
const SKILL_SUGGESTIONS_GAP = 6;
function verticalLayout() {
    return St.BoxLayout.find_property('orientation')
        ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
}
const SEARCH_ICON_NAME = 'edit-find-symbolic';
const AI_ICON_FILENAME = 'ai-search-symbolic.svg';
const TOGGLE_AI_MODE_KEYBINDING = 'toggle-ai-mode';
const DESKTOP_CONTEXT_KEYBINDING = 'open-with-desktop-context';
// Called by the Files extension ("Ask GNOME Assistant") on the session bus,
// under GNOME Shell's own name.
const ASSISTANT_DBUS_PATH = '/org/gnome/Shell/Extensions/GnomeAssistant';
const ASSISTANT_DBUS_INTERFACE = `<node><interface name="org.gnome.Shell.Extensions.GnomeAssistant">
  <method name="AskAbout"><arg type="as" name="uris" direction="in"/></method>
</interface></node>`;
const DESKTOP_CONTEXT_ENABLED = 'desktop-context-enabled';
const WINDOW_CONTEXT_ENABLED = 'window-context-enabled';
const WINDOW_CONTEXT_KEYBINDING = 'open-with-window-context';
// Settings key for each optional part of the desktop context.
const DESKTOP_CONTEXT_KEYS = {
    screenshots: 'desktop-context-screenshots',
    focusedWindow: 'desktop-context-focused-window',
    windows: 'desktop-context-windows',
    pointer: 'desktop-context-pointer',
    selection: 'desktop-context-selection',
    projects: 'desktop-context-projects',
    events: 'desktop-context-events',
    appLogs: 'desktop-context-app-logs',
    deviceStatus: 'desktop-context-device-status',
};
const debug = false;

function debugLog(...args) {
    if (debug)
        console.log(...args);
}

function debugWarn(...args) {
    if (debug)
        console.warn(...args);
}

function debugError(...args) {
    if (debug)
        console.error(...args);
}

export default class GnomeAssistantExtension extends Extension {
    enable() {
        debugLog('GNOME Assistant: Enabling...');
        
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._modeVisibilityIdleId = null;
        this._focusSearchIdleId = null;
        this._toggleShortcutRegistered = false;
        this._contextShortcutRegistered = false;
        this._capturingContext = false;
        migrateAssistantData(this);
        this._settings = this.getSettings();
        this._searchEntry = Main.overview.searchEntry;
        this._searchTextActor = this._searchEntry?.clutter_text ?? null;
        this._originalPrimaryIcon = this._searchEntry.get_primary_icon?.() ?? null;
        this._originalSearchPlaceholder = this._getSearchPlaceholder();
        this._usesPrimaryIcon = false;
        this._aiIcon = this._loadAiIcon();

        // Create the Icon
        this._icon = new St.Icon({
            icon_name: SEARCH_ICON_NAME,
            style_class: 'search-entry-icon'
        });

        // Use primary icon slot so the button does not disappear while typing.
        if (typeof this._searchEntry.set_primary_icon === 'function') {
            this._usesPrimaryIcon = true;
            this._searchEntry.set_primary_icon(this._icon);
            this._iconButtonSignal = this._searchEntry.connect('primary-icon-clicked', () => {
                this._toggleMode();
            });
        } else {
            // Fallback for shells without icon-slot API.
            this._aiButton = new St.Button({
                style_class: 'icon-button flat search-entry-ai-button',
                can_focus: true,
                track_hover: true,
                accessible_name: 'Toggle agent mode',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._aiButton.set_child(this._icon);
            this._aiButtonSignal = this._aiButton.connect('clicked', () => {
                this._toggleMode();
            });

            const searchEntryParent = this._searchEntry.get_parent?.();
            if (searchEntryParent)
                searchEntryParent.add_child(this._aiButton);
            else
                this._searchEntry.add_child(this._aiButton);
        }

        // Intercept AI-mode control keys at capture phase.
        this._stageSignal = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._isAiMode)
                return Clutter.EVENT_PROPAGATE;

            const eventType = event.type ? event.type() : event.type;
            if (eventType === Clutter.EventType.BUTTON_PRESS)
                return this._handlePromptPointerEvent(event);
            if (eventType !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;

            if (this._aiView?.handleMessageKeyPress(event) === Clutter.EVENT_STOP)
                return Clutter.EVENT_STOP;

            return this._handleAiModeKeyEvent(event);
        });

        // Keep AI result UI visible in AI mode even when search text is cleared.
        if (this._searchTextActor?.connect) {
            this._searchTextSignal = this._searchTextActor.connect('text-changed', () => {
                if (!this._isAiMode)
                    return;

                this._queuePromptResize();
                if (this._isUpdatingSearchText)
                    return;

                this._queueModeVisibilitySync();
            });

            this._searchKeyPressSignal = this._searchTextActor.connect('key-press-event', (_actor, event) => {
                if (!this._isAiMode)
                    return Clutter.EVENT_PROPAGATE;

                return this._handleAiModeKeyEvent(event);
            });
        }

        this._shortcutChangedSignal = this._settings.connect(
            `changed::${TOGGLE_AI_MODE_KEYBINDING}`,
            () => this._reloadToggleShortcut()
        );
        this._registerToggleShortcut();
        this._selectionTracker = new SelectionTracker();
        this._eventTracker = new EventTracker();
        this._contextShortcutSignals = [DESKTOP_CONTEXT_KEYBINDING, DESKTOP_CONTEXT_ENABLED, DESKTOP_CONTEXT_KEYS.events]
            .map(key => this._settings.connect(`changed::${key}`, () => this._registerContextShortcut()));
        this._registerContextShortcut();
        this._windowShortcutSignals = [WINDOW_CONTEXT_KEYBINDING, WINDOW_CONTEXT_ENABLED]
            .map(key => this._settings.connect(`changed::${key}`, () => this._registerWindowShortcut()));
        this._registerWindowShortcut();
        this._nameChangedSignal = this._settings.connect('changed::assistant-name', () => this._syncAssistantName());

        this._overviewShowingSignal = Main.overview.connect('showing', () => {
            if (!this._isAiMode || !this._aiView)
                return;

            if (this._promptEditor) {
                this._searchTextActor?.set_input_interceptor?.(null);
                this._promptEditor.clutter_text.set_input_interceptor?.(global.stage);
            }

            this._queueModeVisibilitySync();
            this._queueFocusSearchEntry();
        });

        this._overviewShownSignal = Main.overview.connect('shown', () => {
            if (!this._isAiMode || Main.modalCount > 1)
                return;
            const focus = global.stage.get_key_focus();
            // Opening animations can focus the overview controls after our
            // initial focus request. Respect deliberate focus inside chat/UI.
            if (focus && (this._aiView?.contains(focus) || this._promptBox?.contains(focus)))
                return;
            this._queueFocusSearchEntry();
        });

        this._overviewHiddenSignal = Main.overview.connect('hidden', () => {
            if (this._isAiMode) {
                this._setAiMode(false);
                debugLog('GNOME Assistant: Overview hidden, switched to Search Mode');
            } else {
                this._cancelVisibilityReassertion();
            }

            if (this._aiView)
                this._aiView.visible = false;
        });

        // Init AI View
        this._aiView = new AiView(this._settings);
        this._aiView.connect('external-opened', () => Main.overview.hide());
        this._aiView.connect('attachments-changed', () => {
            this._syncPromptAttachments();
            this._queuePromptResize();
        });
        this._aiView.connect('attachment-added', () => {
            Main.overview.show();
            this._setAiMode(true);
            this._queueFocusSearchEntry();
        });
        this._aiView.connect('picker-opened', () => this._stepAsideForPicker());
        this._aiView.connect('picker-closed', () => this._returnFromPicker());
        this._aiView.connect('desktop-context-requested', () => this._openWithDesktopContext());
        this._aiView.connect('screen-capture-requested', (_view, mode) => this._attachScreenCapture(mode));
        this._backgroundStatus = new BackgroundStatus(this._aiView, this._settings, this._aiIcon, () => this._openChat());
        this._problemWatcher = new ProblemWatcher(this._settings, {icon: this._aiIcon,
            onFix: (problem, name) => this._fixProblem(problem, name)});
        this._problemWatcher.start();
        // "Ask …" in every window's menu (right-click on the title bar, Alt+Space).
        this._injections = new InjectionManager();
        const extension = this;
        this._injections.overrideMethod(WindowMenu.WindowMenu.prototype, '_buildMenu', original => function (window) {
            original.call(this, window);
            extension._addWindowMenuItem(this, window);
        });
        this._dbusObject = Gio.DBusExportedObject.wrapJSObject(ASSISTANT_DBUS_INTERFACE,
            {AskAbout: uris => this._askAbout(uris)});
        this._dbusObject.export(Gio.DBus.session, ASSISTANT_DBUS_PATH);
        
        // Locate Search Results Container and attach AI view.
        // Keep AI results in the same visual slot as native search results
        // (below the search entry), so it never covers the search bar.
        try {
            const overview = Main.overview;
            const overviewControls = overview._controls ?? overview._overview?.controls;

            this._searchResultsView = null;
            this._searchResultsActor = null;
            this._searchController = overview.searchController ??
                overviewControls?.searchController ?? overviewControls?._searchController ?? null;
            this._aiViewParent = null;

            if (this._searchController) {
                const sr = this._searchController._searchResults;
                this._searchResultsView = sr;
                this._searchResultsActor = sr?.actor ?? sr;
            }

            const srParent = this._searchResultsActor?.get_parent?.();
            if (srParent && this._searchResultsActor) {
                srParent.add_child(this._aiView);
                this._aiView.add_constraint(new Clutter.BindConstraint({
                    source: this._searchResultsActor,
                    coordinate: Clutter.BindCoordinate.POSITION,
                    offset: 0,
                }));
                this._aiView.add_constraint(new Clutter.BindConstraint({
                    source: this._searchResultsActor,
                    coordinate: Clutter.BindCoordinate.SIZE,
                    offset: 0,
                }));
                this._aiViewParent = srParent;
                debugLog('GNOME Assistant: AI view attached as sibling of search results');
            } else {
                // Last-resort fallback for unusual shell internals.
                const overviewGroup = Main.overview._overview ?? Main.layoutManager.overviewGroup;
                if (overviewGroup) {
                    overviewGroup.add_child(this._aiView);
                    this._aiView.add_constraint(new Clutter.BindConstraint({
                        source: overviewGroup,
                        coordinate: Clutter.BindCoordinate.ALL,
                        offset: 0,
                    }));
                    this._aiViewParent = overviewGroup;
                    debugWarn('GNOME Assistant: Falling back to overview overlay attachment');
                } else {
                    debugWarn('GNOME Assistant: Could not find a suitable parent for AI view');
                }
            }

            this._aiView.visible = false;
            this._aiView.reactive = true;
            this._raiseAiView();
        } catch (e) {
            debugError('GNOME Assistant: Error attaching AI view', e);
        }
    }

    _toggleMode() {
        this._setAiMode(!this._isAiMode);
    }

    _toggleModeFromShortcut() {
        if (!this._isOverviewTargetVisible()) {
            Main.overview.show();
            this._setAiMode(true);
            this._queueFocusSearchEntry();
            return;
        }

        this._toggleMode();
        this._queueFocusSearchEntry();
    }

    // Capture first: once the overview starts showing, the screenshots would
    // contain the overview instead of what the user was looking at.
    async _openWithDesktopContext() {
        if (this._capturingContext || !this._aiView)
            return;
        this._capturingContext = true;
        const view = this._aiView;
        const draft = this._takeDraft();
        try {
            if (this._isOverviewTargetVisible())
                await this._hideOverviewForCapture();
            if (this._aiView !== view)
                return;
            const capture = await captureDesktop({
                parts: Object.fromEntries(DESKTOP_CONTEXT_PARTS.map(part =>
                    [part, getBoolean(this._settings, DESKTOP_CONTEXT_KEYS[part], true)])),
                selection: this._selectionTracker,
                events: this._eventTracker,
                knownRoots: [getString(this._settings, 'workspace-folder')].filter(Boolean),
                privacy: this._privacy(),
            });
            if (this._aiView !== view)
                return;
            this._reopenWithDraft(draft);
            const context = await prepareDesktopContext(capture);
            if (this._aiView === view)
                view.setDesktopContext(context);
        } catch (e) {
            if (this._aiView === view)
                Main.notifyError(this._assistantName(), `Could not capture the desktop context: ${e.message}`);
        } finally {
            this._capturingContext = false;
        }
    }

    // The picker draws on the real desktop, so the overview closes first. It
    // comes back with the typed prompt, plus the capture unless cancelled.
    async _attachScreenCapture(mode) {
        if (this._capturingContext || !this._aiView)
            return;
        this._capturingContext = true;
        const view = this._aiView;
        const draft = this._takeDraft();
        let capture = null;
        try {
            if (this._isOverviewTargetVisible())
                await this._hideOverviewForCapture();
            if (this._aiView === view)
                capture = await (mode === 'window' ? pickWindow() : pickArea());
            if (capture && this._aiView === view)
                capture = await this._protectCapture(capture);
            if (capture && this._aiView === view)
                view.addScreenCapture(capture);
        } catch (e) {
            if (this._aiView === view)
                Main.notifyError(this._assistantName(), `Could not attach the ${mode}: ${e.message}`);
        } finally {
            this._capturingContext = false;
        }
        if (this._aiView === view)
            this._reopenWithDraft(draft);
    }

    _assistantName() {
        return assistantName(this._settings);
    }

    _privacy() {
        return getBoolean(this._settings, 'privacy-protection', true) ? {apps: privateApps(this._settings)} : null;
    }

    // A picked window of a private app is refused; an area gets private
    // windows and banners blacked out, then OCR. Null when refused.
    async _protectCapture(capture) {
        const privacy = this._privacy();
        if (!privacy)
            return capture;
        const {window, area, ...image} = capture;
        const label = window ? privateWindowLabel(window, privacy.apps) : null;
        if (label) {
            Main.notify(this._assistantName(), `${label} is kept private in your settings, so it was not attached.`);
            return null;
        }
        const regions = area ? privateRegions(privacy.apps) : [];
        const result = await protectScreenshot(image, {regions, area});
        return {...result.image, privacy: {hidden: result.hidden, secrets: result.secrets, ocr: result.ocr}};
    }

    _placeholderText() {
        return `Ask ${this._assistantName()}`;
    }

    // The placeholder follows the name as soon as it changes.
    _syncAssistantName() {
        if (this._isAiMode)
            this._setSearchPlaceholder(this._placeholderText());
        if (this._promptEditor)
            this._promptEditor.hint_text = this._placeholderText();
    }

    // Files from the Files right-click menu: open the assistant and add them,
    // as references for a local agent or attachments for a remote one.
    _askAbout(uris) {
        const paths = uris.map(uri => {
            try {
                return Gio.File.new_for_uri(uri).get_path();
            } catch {
                return null;
            }
        }).filter(Boolean);
        if (!paths.length || !this._aiView)
            return;
        if (this._aiView._run) {
            Main.notify(this._assistantName(), 'Wait for the current reply to finish, then try again.');
            return;
        }
        this._reopenWithDraft(this._takeDraft());
        this._aiView.addLocalPaths(paths).catch(error => Main.notifyError(this._assistantName(), error.message));
    }

    // From the top bar or a notification: show the conversation in progress.
    // After "Take Screenshot", the first entry. Not for windows of private apps.
    _addWindowMenuItem(menu, window) {
        const privacy = this._privacy();
        if (!this._aiView || !getBoolean(this._settings, WINDOW_CONTEXT_ENABLED, true) ||
            (privacy && privateWindowLabel(window, privacy.apps)))
            return;
        const item = new PopupMenu.PopupMenuItem(`Ask ${this._assistantName()}`);
        // Line up with the other entries, which keep room for a checkmark.
        item.setOrnament(menu._getMenuItems()[0]?._ornament ?? PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._askAboutWindow(window));
        menu.addMenuItem(item, Math.min(1, menu.numMenuItems));
    }

    // A window context chip (its screenshot, details, project, events and
    // logs, as the Included Context switches allow), then the assistant
    // opens with the draft kept, ready for the question.
    async _askAboutWindow(window) {
        const view = this._aiView;
        if (!view || this._capturingContext)
            return;
        this._capturingContext = true;
        const draft = this._takeDraft();
        try {
            const context = await captureWindowContext(window, {
                parts: Object.fromEntries(DESKTOP_CONTEXT_PARTS.map(part =>
                    [part, getBoolean(this._settings, DESKTOP_CONTEXT_KEYS[part], true)])),
                events: this._eventTracker,
                knownRoots: [getString(this._settings, 'workspace-folder')].filter(Boolean),
                privacy: this._privacy(),
            });
            if (this._aiView !== view)
                return;
            view.setDesktopContext(context);
        } catch (e) {
            if (this._aiView === view)
                Main.notifyError(this._assistantName(), `Could not attach the window: ${e.message}`);
            return;
        } finally {
            this._capturingContext = false;
        }
        this._reopenWithDraft(draft);
        view.showChat();
    }

    // "Fix with …" on a problem notification: a new conversation with the
    // details in the prompt, for the user to review and send.
    async _fixProblem(problem, name) {
        const view = this._aiView;
        if (!view)
            return;
        const logs = await problemLogs(problem).catch(() => []);
        if (this._aiView !== view)
            return;
        let prompt = problemPrompt(problem, {name, logs, remote: !view._isLocalProfile()});
        if (getBoolean(this._settings, 'privacy-protection', true))
            prompt = redactSecrets(prompt).text;
        const draft = this._takeDraft().trim();
        if (!view._run)
            view._startNewConversation();
        this._reopenWithDraft('');
        view.showChat();
        this._fillPrompt(draft ? `${draft}\n\n${prompt}` : prompt);
    }

    // The composer opens on an idle; fill it once it exists, so line breaks
    // are kept (the single-line search entry would lose them).
    _fillPrompt(text, attempts = 40) {
        if (this._promptEditor) {
            this._setSearchEntryText(text);
            this._queueFocusSearchEntry();
            return;
        }
        if (attempts > 0 && this._aiView)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
                this._fillPrompt(text, attempts - 1);
                return GLib.SOURCE_REMOVE;
            });
    }

    _openChat() {
        if (!this._aiView)
            return;
        this._reopenWithDraft(this._takeDraft());
        this._aiView.showChat();
    }

    // Hiding the overview resets its search entry, so keep the typed prompt.
    _takeDraft() {
        return this._isAiMode ? this._getSearchEntryText() : '';
    }

    _reopenWithDraft(draft) {
        if (!this._isOverviewTargetVisible())
            Main.overview.show();
        this._setAiMode(true);
        if (draft && !this._getSearchEntryText())
            this._setSearchEntryText(draft);
        this._queueFocusSearchEntry();
    }

    // File pickers open as normal windows, which the overview would cover.
    _stepAsideForPicker() {
        this._pickerReturn = this._isOverviewTargetVisible() ? {draft: this._takeDraft()} : null;
        if (this._pickerReturn)
            Main.overview.hide();
    }

    _returnFromPicker() {
        const target = this._pickerReturn;
        this._pickerReturn = null;
        if (target && this._aiView)
            this._reopenWithDraft(target.draft);
    }

    _hideOverviewForCapture() {
        return new Promise(resolve => {
            let timeoutId = 0;
            const signalId = Main.overview.connect('hidden', () => done());
            const done = () => {
                Main.overview.disconnect(signalId);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                timeoutId = 0;
                resolve();
            };
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                timeoutId = 0;
                done();
                return GLib.SOURCE_REMOVE;
            });
            Main.overview.hide();
        });
    }

    _setAiMode(isAiMode) {
        if (this._isAiMode === isAiMode)
            return false;

        this._isAiMode = isAiMode;

        if (this._isAiMode) {
            if (this._aiButton)
                this._aiButton.add_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.add_style_class_name('active');
            this._setEntryIcon(this._aiIcon);
            this._setSearchPlaceholder(this._placeholderText());
            this._queuePromptResize();
            debugLog('GNOME Assistant: Switched to AI Mode');
        } else {
            if (this._aiButton)
                this._aiButton.remove_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.remove_style_class_name('active');
            this._setEntryIcon(null);
            this._setSearchPlaceholder(this._originalSearchPlaceholder);
            this._restoreSingleLinePrompt();
            this._restoreOverviewSearchActive();
            debugLog('GNOME Assistant: Switched to Search Mode');
        }

        this._syncModeVisibility();
        if (this._isAiMode)
            this._scheduleVisibilityReassertion();
        else
            this._cancelVisibilityReassertion();

        return true;
    }

    _loadAiIcon() {
        const iconPath = GLib.build_filenamev([this.path, AI_ICON_FILENAME]);
        return new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)});
    }

    _setEntryIcon(gicon) {
        if (gicon) {
            this._icon.gicon = gicon;
            return;
        }

        this._icon.gicon = null;
        this._icon.icon_name = SEARCH_ICON_NAME;
    }

    _exitAiMode(reason) {
        if (!this._setAiMode(false))
            return false;

        debugLog(`GNOME Assistant: ${reason}, switched to Search Mode`);
        return true;
    }

    _isPasteKey(key, state) {
        return ((key === Clutter.KEY_v || key === Clutter.KEY_V) && (state & Clutter.ModifierType.CONTROL_MASK)) ||
            (key === Clutter.KEY_Insert && (state & Clutter.ModifierType.SHIFT_MASK));
    }

    // Files copied in any file manager are offered on the clipboard as file
    // URIs. Turn them into prompt chips instead of pasting paths as text.
    // Returns false to let the editor paste ordinary text itself.
    _pasteCopiedFiles() {
        const clipboard = St.Clipboard.get_default();
        const offered = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        const type = COPIED_FILE_TYPES.find(candidate => offered.includes(candidate));
        if (!type || !this._aiView)
            return false;
        const editor = this._promptEditor;
        clipboard.get_content(St.ClipboardType.CLIPBOARD, type, (_clipboard, bytes) => {
            const paths = copiedFilePaths(bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : '');
            if (paths.length) {
                this._aiView?.addLocalPaths(paths).catch(error => Main.notifyError(this._assistantName(), error.message));
                return;
            }
            // A URI list without local files, such as a copied link: paste it as text.
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_source, text) => {
                if (!text || this._promptEditor !== editor)
                    return;
                const field = editor.clutter_text;
                field.delete_selection();
                field.insert_text(text, field.get_cursor_position());
            });
        });
        return true;
    }

    _handleAiModeKeyEvent(event) {
        const key = event.get_key_symbol();

        if (key === Clutter.KEY_Escape) {
            if (this._skillMenu?.visible) {
                this._hideSkillSuggestions();
                return Clutter.EVENT_STOP;
            }
            this._exitAiMode('Escape intercepted');
            return Clutter.EVENT_STOP;
        }

        if (this._promptEditor && global.stage.get_key_focus() === this._promptEditor.clutter_text &&
            this._handleSkillSuggestionKey(key, event.get_state()))
            return Clutter.EVENT_STOP;

        if (this._promptEditor && global.stage.get_key_focus() === this._promptEditor.clutter_text &&
            this._isPasteKey(key, event.get_state()) && this._pasteCopiedFiles())
            return Clutter.EVENT_STOP;

        if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
            return Clutter.EVENT_PROPAGATE;

        const focus = global.stage.get_key_focus?.();
        const searchText = this._promptEditor?.clutter_text ?? this._searchTextActor;
        let isSearchFocus = false;
        for (let actor = focus; actor; actor = actor.get_parent?.()) {
            if (actor === searchText || actor === this._searchEntry || actor === this._promptEditor) {
                isSearchFocus = true;
                break;
            }
        }

        if (!isSearchFocus)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            searchText.delete_selection();
            searchText.insert_unichar('\n');
            return Clutter.EVENT_STOP;
        }

        if (this._isSubmitting)
            return Clutter.EVENT_STOP;

        this._submitAiPrompt();
        debugLog('GNOME Assistant: Enter intercepted in AI mode');
        return Clutter.EVENT_STOP;
    }

    async _submitAiPrompt() {
        const text = this._getSearchEntryText();
        const attachments = this._aiView?.queuedAttachments ?? [];
        const files = attachments.filter(file => !file.context && !file.reference);
        const references = attachments.filter(file => file.reference);
        const prompt = text.trim() || (files.length === 1 ? 'Please review the attached file.'
            : files.length ? 'Please review the attached files.'
            : references.length === 1 ? `Please look at the referenced ${references[0].folder ? 'folder' : 'file'}.`
            : references.length ? 'Please look at the referenced files and folders.'
            : attachments.length ? 'Please look at what is on my screen.' : '');

        if (prompt.length === 0 || this._isSubmitting || this._aiView?._run)
            return;

        this._isSubmitting = true;

        if (this._isAiMode && this._aiView)
            this._aiView.visible = true;

        // Secrets the user typed or attached: ask before anything is sent.
        // Cancelling leaves the prompt as it is.
        const view = this._aiView;
        let review;
        try {
            review = await view.reviewOutgoing(prompt);
        } catch (error) {
            review = {proceed: false};
            Main.notifyError(this._assistantName(), `Could not check the message for secrets: ${error.message}`);
        }
        if (!review.proceed || this._aiView !== view) {
            this._isSubmitting = false;
            return;
        }
        const sent = review.prompt;

        debugLog(`GNOME Assistant: Submitting prompt (${sent.length} chars)`);

        this._aiView.addMessage('You', sent);

        this._setSearchEntryText('');
        this._syncModeVisibility();
        this._queueModeVisibilitySync();

        try {
            // The reviewed text: what is shown is exactly what is sent.
            await this._aiView.generateResponse(sent);
        } finally {
            this._isSubmitting = false;
        }
    }

    _getSearchEntryText() {
        return this._promptEditor?.get_text() ?? this._searchTextActor?.get_text() ??
            this._searchEntry?.get_text?.() ?? '';
    }

    _queuePromptResize() {
        if (!this._isAiMode || !this._searchTextActor || this._promptResizeId)
            return;

        this._promptResizeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._promptResizeId = null;
            if (this._isAiMode && this._searchTextActor)
                this._resizePrompt();
            return GLib.SOURCE_REMOVE;
        });
    }

    _openPromptEditor() {
        const entry = this._searchEntry;
        if (!entry || !this._isAiMode)
            return;
        const parent = entry.get_parent();
        if (parent?.get_child?.() !== entry)
            return;

        const nativeText = this._searchTextActor;
        const expanded = Boolean(nativeText.text || this._aiView?.queuedAttachments?.length);
        const originalWidth = entry.get_allocation_box().get_width() || entry.get_preferred_width(-1)[1];
        const contentHeight = entry.get_theme_node().get_content_box(entry.get_allocation_box()).get_height();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const icon = entry.get_primary_icon?.();
        const iconGap = icon ? Math.max(0, nativeText.x > icon.x
            ? nativeText.x - icon.x - icon.width : icon.x - nativeText.x - nativeText.width) : 0;
        const monitorWidth = Main.layoutManager.primaryMonitor.width;
        const width = Math.min(PROMPT_WIDTH * scale, monitorWidth - 32 * scale);
        const box = new St.BoxLayout({
            // Keep Shell's search-entry geometry, colours and focus treatment.
            // Only the expanded shape is specific to the assistant.
            style_class: `${entry.get_style_class_name()} ai-prompt-box`,
            style: `spacing: ${iconGap / scale}px;`,
            reactive: true,
            track_hover: true,
            width: Math.min(originalWidth, width),
            clip_to_allocation: true,
        });
        const toggle = new St.Button({
            style_class: 'button ai-prompt-toggle',
            accessible_name: 'Return to search',
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
        });
        toggle.set_child(new St.Icon({gicon: this._aiIcon, style_class: 'search-entry-icon'}));
        toggle.connect('clicked', () => {
            this._setAiMode(false);
            this._queueFocusSearchEntry();
        });
        box.add_child(toggle);

        const input = new St.BoxLayout({
            ...verticalLayout(), style_class: 'ai-prompt-input', x_expand: true,
        });
        const files = new St.ScrollView({
            style_class: 'ai-prompt-attachments', visible: false,
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
        });
        const fileRow = new St.BoxLayout({style_class: 'ai-prompt-attachment-list'});
        files.set_child(fileRow);
        input.add_child(files);

        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const content = new St.BoxLayout({
            ...verticalLayout(),
            x_expand: true,
        });
        const editor = new St.Entry({
            style_class: 'ai-prompt-editor',
            accessible_name: 'Prompt',
            hint_text: this._placeholderText(),
            x_expand: true,
            can_focus: true,
            reactive: true,
        });
        const text = editor.clutter_text;
        text.single_line_mode = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        editor.set_text(nativeText.text);
        text.set_cursor_position(nativeText.cursor_position);
        text.set_selection_bound(nativeText.selection_bound);
        content.add_child(editor);
        scroll.set_child(content);
        input.add_child(scroll);
        box.add_child(input);
        const attachmentButton = this._aiView?.attachmentButton;
        if (attachmentButton) {
            attachmentButton.get_parent()?.remove_child(attachmentButton);
            attachmentButton.get_child()?.add_style_class_name('search-entry-icon');
            box.add_child(attachmentButton);
        }

        this._promptEditor = editor;
        this._promptBox = box;
        this._promptScroll = scroll;
        this._promptInput = input;
        this._promptFiles = files;
        this._promptFileRow = fileRow;
        files.connect('notify::allocation', () => this._syncPromptAttachmentOverflow());
        this._promptParent = parent;
        this._promptDimensions = {width, originalWidth, contentHeight};
        text.connect('text-changed', () => {
            this._queuePromptResize();
            this._updateSkillSuggestions();
        });
        text.connect('notify::width', () => this._queuePromptResize());
        text.connect('cursor-changed', () => this._queuePromptCursorScroll());
        text.connect('key-focus-in', () => box.add_style_pseudo_class('focus'));
        text.connect('key-focus-out', () => box.remove_style_pseudo_class('focus'));
        // Recent Shell versions intercept overview input for the native search
        // text, even while it is detached. Release it while our editor is active.
        this._nativeInputInterceptor = nativeText.get_input_interceptor?.() ?? null;
        nativeText.set_input_interceptor?.(null);
        text.set_input_interceptor?.(this._isOverviewTargetVisible() ? global.stage : null);
        parent.set_child(box);
        scroll.height = Math.max(1, contentHeight);
        if (expanded) {
            box.add_style_pseudo_class('expanded');
            this._animatePromptWidth(width);
        }
        // Opening the composer is an explicit transition into assistant mode.
        // Focus it even when the mode button or another overview control had focus.
        editor.grab_key_focus();
        this._syncPromptAttachments();
        this._updateSkillSuggestions();
    }

    _syncPromptAttachments() {
        if (!this._promptFileRow)
            return;
        const files = this._aiView?.queuedAttachments ?? [];
        const focus = global.stage.get_key_focus();
        const restoreFocus = focus && this._promptFiles.contains(focus);
        this._promptFiles.visible = files.length > 0;
        const key = JSON.stringify(files);
        if (key !== this._promptAttachmentsKey) {
            this._promptAttachmentsKey = key;
            this._promptFileRow.destroy_all_children();
            this._promptFileRemoveButtons = [];
            for (const file of files) {
                const chip = new St.BoxLayout({style_class: 'ai-prompt-file'});
                let icon = new Gio.ThemedIcon({name: file.context ? 'video-display-symbolic'
                    : file.folder ? 'folder-symbolic' : file.image ? 'image-x-generic-symbolic' : 'text-x-generic-symbolic'});
                if (file.reference) {
                    chip.add_style_class_name('ai-prompt-reference');
                    if (!file.folder) {
                        try {icon = Gio.content_type_get_symbolic_icon(Gio.content_type_guess(file.name, null)[0]);} catch { /* Use the generic file icon. */ }
                    }
                } else if (!file.context && !file.folder) {
                    try {icon = Gio.content_type_get_symbolic_icon(Gio.content_type_guess(file.name, null)[0]);} catch { /* Use the generic file icon. */ }
                } else {
                    chip.add_style_class_name('ai-prompt-context');
                }
                chip.add_child(new St.Icon({gicon: icon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER}));
                const labels = new St.BoxLayout({...verticalLayout(), y_align: Clutter.ActorAlign.CENTER});
                const name = new St.Label({text: file.name, style_class: 'ai-prompt-file-name'});
                name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                labels.add_child(name);
                labels.add_child(new St.Label({text: file.detail ?? GLib.format_size(file.size), style_class: 'ai-prompt-file-size'}));
                chip.add_child(labels);
                const remove = new St.Button({style_class: 'button ai-prompt-file-remove',
                    accessible_name: `Remove attachment ${file.name}`, can_focus: true, track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER});
                remove.set_child(new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}));
                remove.connect('clicked', () => this._aiView.removeQueuedAttachment(file.id));
                chip.add_child(remove);
                this._promptFileRemoveButtons.push(remove);
                this._promptFileRow.add_child(chip);
            }
            if (restoreFocus)
                this._promptEditor.grab_key_focus();
        }
        for (const button of this._promptFileRemoveButtons ?? []) {
            button.reactive = !this._aiView?._run;
            button.can_focus = button.reactive;
        }
        this._syncPromptAttachmentOverflow();
    }

    _syncPromptAttachmentOverflow() {
        if (!this._promptFiles?.visible || this._promptFiles.width <= 0)
            return;
        const [, width] = this._promptFileRow.get_preferred_width(-1);
        const policy = width > this._promptFiles.width + 1 ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        if (this._promptFiles.hscrollbar_policy !== policy)
            this._promptFiles.hscrollbar_policy = policy;
    }

    _handlePromptPointerEvent(event) {
        const editor = this._promptEditor;
        if (!editor || event.get_button() !== Clutter.BUTTON_PRIMARY || Main.modalCount > 1)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        // Overview grabs can retarget clicks to a generic actor. Use the visible
        // bounds to recognize the composer, preserving its buttons/scrollbars.
        const inside = actor => {
            if (!actor?.mapped)
                return false;
            const [valid, localX, localY] = actor.transform_stage_point(x, y);
            return valid && localX >= 0 && localY >= 0 && localX < actor.width && localY < actor.height;
        };
        if (!inside(this._promptBox))
            return Clutter.EVENT_PROPAGATE;
        for (const button of [this._promptBox.get_first_child(), this._aiView?.attachmentButton,
            ...(this._promptFileRemoveButtons ?? [])]) {
            if (inside(button))
                return Clutter.EVENT_PROPAGATE;
        }
        for (const scroll of [this._promptScroll, this._promptFiles]) {
            for (const bar of scroll?.get_children() ?? []) {
                if (!(bar instanceof St.ScrollBar))
                    continue;
                const vertical = bar.orientation !== undefined
                    ? bar.orientation === Clutter.Orientation.VERTICAL : bar.vertical;
                if ((vertical ? scroll.vscrollbar_visible : scroll.hscrollbar_visible) && inside(bar))
                    return Clutter.EVENT_PROPAGATE;
            }
        }
        const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        editor.grab_key_focus();
        const source = global.stage.get_event_actor?.(event) ?? event.get_source();
        if (editor.get_text() && target === editor.clutter_text && source && editor.contains(source))
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    _updateSkillSuggestions() {
        const query = /^\$([\w:-]*)$/.exec(this._promptEditor?.get_text() ?? '');
        if (!query) {
            this._hideSkillSuggestions();
            return;
        }

        if (!this._skillMenu) {
            this._skillRows = new St.BoxLayout({
                ...verticalLayout(),
                style_class: 'ai-skill-rows',
            });
            this._skillMenu = new St.ScrollView({
                style_class: 'popup-menu popup-menu-content ai-skill-menu',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                reactive: true,
            });
            this._skillMenu.set_child(this._skillRows);
            Main.layoutManager.overviewGroup.add_child(this._skillMenu);
            this._promptBox.connect('notify::allocation', () => this._positionSkillSuggestions());
        }
        this._skillMenu.show();
        this._positionSkillSuggestions();
        this._skillFilter = query[1].toLowerCase();
        this._renderSkillSuggestions();
    }

    _positionSkillSuggestions() {
        if (!this._skillMenu?.visible)
            return;

        const [x, y] = this._promptBox.get_transformed_position();
        const [width, height] = this._promptBox.get_transformed_size();
        const [parentX, parentY] = this._skillMenu.get_parent().get_transformed_position();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._skillMenu.set_position(x - parentX, y + height - parentY + SKILL_SUGGESTIONS_GAP * scale);
        this._skillMenu.set_width(width);
    }

    _renderSkillSuggestions() {
        this._skillRows.destroy_all_children();
        this._skillSelection = -1;
        this._skillMatches = [];
        const query = this._skillFilter.replace(/^native:/, '');
        const seen = new Set();
        for (const skill of this._aiView?._nativeProfileCommands ?? []) {
            if (typeof skill.name !== 'string' || !/^[\w-]+(?::[\w-]+)*$/.test(skill.name))
                continue;
            const command = '$' + skill.name;
            if (seen.has(command) ||
                !skill.name.toLowerCase().includes(query))
                continue;
            seen.add(command);
            this._skillMatches.push({...skill, command});
        }
        this._skillMatches.sort((a, b) => a.name.localeCompare(b.name));
        for (const {name, command} of this._skillMatches) {
            const button = new St.Button({
                style_class: 'popup-menu-item ai-skill-option',
                accessible_name: name,
                track_hover: true,
                x_expand: true,
            });
            const row = new St.BoxLayout({style_class: 'ai-skill-option-content'});
            const label = new St.Label({text: name, x_expand: true});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(label);
            button.set_child(row);
            button.connect('clicked', () => this._completeSkillSuggestion(command));
            this._skillRows.add_child(button);
        }
        if (!this._skillMatches.length) {
            const text = 'No matching commands advertised by the agent.';
            this._skillRows.add_child(new St.Label({text, style_class: 'ai-skill-empty'}));
        }
        const [, height] = this._skillRows.get_preferred_height(-1);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._skillMenu.height = Math.min(height + this._skillMenu.get_theme_node().get_vertical_padding(),
            SKILL_SUGGESTIONS_HEIGHT * scale);
        const adjustment = this._skillMenu.vadjustment ?? this._skillMenu.vscroll.adjustment;
        adjustment.value = 0;
    }

    _handleSkillSuggestionKey(key, modifiers) {
        const matches = this._skillMatches;
        if (!this._skillMenu?.visible || !matches?.length ||
            (modifiers & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.SUPER_MASK)))
            return false;
        if (key === Clutter.KEY_Tab ||
            (this._skillSelection >= 0 && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter))) {
            this._completeSkillSuggestion(matches[Math.max(0, this._skillSelection)].command);
            return true;
        }
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down)
            return false;
        const rows = this._skillRows.get_children();
        rows[this._skillSelection]?.remove_style_pseudo_class('selected');
        const direction = key === Clutter.KEY_Down ? 1 : -1;
        this._skillSelection = this._skillSelection < 0 ? (direction > 0 ? 0 : rows.length - 1) :
            (this._skillSelection + direction + rows.length) % rows.length;
        const row = rows[this._skillSelection];
        row.add_style_pseudo_class('selected');
        const box = row.get_allocation_box();
        const adjustment = this._skillMenu.vadjustment ?? this._skillMenu.vscroll.adjustment;
        adjustment.clamp_page(box.y1, box.y2);
        return true;
    }

    _completeSkillSuggestion(command) {
        this._setSearchEntryText(command + ' ');
        this._focusSearchEntry();
    }

    _hideSkillSuggestions() {
        this._skillMenu?.hide();
    }

    _resizePrompt() {
        if (!this._promptEditor)
            this._openPromptEditor();

        if (!this._getSearchEntryText() && !this._aiView?.queuedAttachments?.length) {
            this._collapsePromptEditor();
            return;
        }

        const editor = this._promptEditor;
        if (!editor)
            return;

        if (this._promptClosing) {
            this._promptClosing = false;
            this._promptTargetHeight = null;
            this._animatePromptWidth(this._promptDimensions.width);
        }
        this._promptBox.add_style_pseudo_class('expanded');
        const text = editor.clutter_text;
        if (text.width <= 0)
            return;

        const layout = text.get_layout().copy();
        // Measure against the settled width so the height can animate in parallel.
        const targetTextWidth = text.width + this._promptDimensions.width - this._promptBox.width;
        layout.set_width(Math.round(Math.max(1, targetTextWidth) * Pango.SCALE));
        const [, contentHeight] = layout.get_pixel_size();
        layout.set_text('Ag', -1);
        const [, lineHeight] = layout.get_pixel_size();
        const padding = editor.get_theme_node().get_vertical_padding();
        editor.height = Math.max(lineHeight * 2, contentHeight) + padding;
        const maxHeight = PROMPT_MAX_LINES * lineHeight + padding;
        const overflow = editor.height > maxHeight;
        this._promptScroll.vscrollbar_policy = overflow ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        if (!overflow) {
            const adjustment = this._promptScroll.vadjustment ?? this._promptScroll.vscroll.adjustment;
            adjustment.value = adjustment.lower;
        }
        const height = Math.min(editor.height, maxHeight);
        if (height !== this._promptTargetHeight) {
            this._promptTargetHeight = height;
            this._promptScroll.ease({
                height,
                duration: PROMPT_EXPAND_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._queuePromptCursorScroll(),
            });
        }
        this._queuePromptCursorScroll();
    }

    _animatePromptWidth(width, onComplete) {
        this._promptBox.ease({
            width,
            duration: PROMPT_EXPAND_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete,
        });
    }

    _collapsePromptEditor() {
        if (!this._promptEditor || this._promptClosing)
            return;

        this._promptClosing = true;
        this._promptBox.remove_style_pseudo_class('expanded');
        this._promptEditor.height = -1;
        this._promptScroll.vscrollbar_policy = St.PolicyType.NEVER;
        const adjustment = this._promptScroll.vadjustment ?? this._promptScroll.vscroll.adjustment;
        adjustment.value = adjustment.lower;
        const {originalWidth, contentHeight} = this._promptDimensions;
        this._promptScroll.ease({
            height: Math.max(1, contentHeight),
            duration: PROMPT_EXPAND_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._animatePromptWidth(originalWidth);
    }

    _queuePromptCursorScroll() {
        if (this._promptCursorId || !this._promptEditor)
            return;
        this._promptCursorId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._promptCursorId = null;
            const text = this._promptEditor.clutter_text;
            const adjustment = this._promptScroll.vadjustment ?? this._promptScroll.vscroll.adjustment;
            const position = text.cursor_position < 0 ? text.get_buffer().get_length() : text.cursor_position;
            const [valid, , y, height] = text.position_to_coords(position);
            if (valid)
                adjustment.clamp_page(y, y + height);
            return GLib.SOURCE_REMOVE;
        });
    }

    _restoreSingleLinePrompt() {
        if (this._promptResizeId) {
            GLib.source_remove(this._promptResizeId);
            this._promptResizeId = null;
        }
        if (!this._promptEditor)
            return;
        if (this._promptCursorId) {
            GLib.source_remove(this._promptCursorId);
            this._promptCursorId = null;
        }
        const text = this._promptEditor.clutter_text;
        text.set_input_interceptor?.(null);
        const draft = text.text;
        const cursor = text.cursor_position;
        const selection = text.selection_bound;
        const hadFocus = global.stage.get_key_focus() === text;
        this._promptEditor = null;
        this._promptScroll = null;
        this._promptInput = null;
        this._promptFiles = null;
        this._promptFileRow = null;
        this._promptAttachmentsKey = null;
        this._promptFileRemoveButtons = null;
        this._promptTargetHeight = null;
        this._promptClosing = false;
        this._promptDimensions = null;
        this._skillMenu?.destroy();
        this._skillMenu = null;
        this._skillRows = null;
        this._skillMatches = null;
        // The view owns this button; keep it alive across prompt transitions.
        const attachmentButton = this._aiView?.attachmentButton;
        if (attachmentButton?.get_parent() === this._promptBox)
            this._promptBox.remove_child(attachmentButton);
        this._promptParent.set_child(this._searchEntry);
        this._promptParent = null;
        this._promptBox.destroy();
        this._promptBox = null;
        this._searchEntry.set_text(draft);
        this._searchTextActor.set_cursor_position(cursor);
        this._searchTextActor.set_selection_bound(selection);
        this._searchTextActor.set_input_interceptor?.(this._isOverviewTargetVisible()
            ? this._nativeInputInterceptor : null);
        this._nativeInputInterceptor = null;
        if (hadFocus)
            this._searchTextActor.grab_key_focus();
    }

    _setSearchEntryText(value) {
        this._isUpdatingSearchText = true;
        try {
            const text = String(value ?? '');
            const entry = this._promptEditor ?? this._searchEntry;
            const searchText = entry?.clutter_text;
            entry?.set_text(text);

            const cursorPos = text.length;
            if (searchText?.set_cursor_position)
                searchText.set_cursor_position(cursorPos);
            if (searchText?.set_selection)
                searchText.set_selection(cursorPos, cursorPos);
        } finally {
            this._isUpdatingSearchText = false;
        }
    }

    _getSearchPlaceholder() {
        try {
            if (this._searchEntry?.get_hint_text)
                return this._searchEntry.get_hint_text();
            if (this._searchEntry?.hint_text !== undefined)
                return this._searchEntry.hint_text;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to read search placeholder: ${e.message}`);
        }

        return '';
    }

    _setSearchPlaceholder(value) {
        try {
            const text = String(value ?? '');
            if (this._searchEntry?.set_hint_text) {
                this._searchEntry.set_hint_text(text);
                return;
            }

            if (this._searchEntry?.hint_text !== undefined)
                this._searchEntry.hint_text = text;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to set search placeholder: ${e.message}`);
        }
    }

    _getOverviewSearchActive() {
        const controller = this._searchController ?? null;
        if (!controller)
            return null;

        try {
            if (controller.searchActive !== undefined)
                return !!controller.searchActive;
            if (controller._searchActive !== undefined)
                return !!controller._searchActive;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to read search active state: ${e.message}`);
        }

        return null;
    }

    _setOverviewSearchActive(active) {
        const controller = this._searchController ?? null;
        if (!controller)
            return false;

        try {
            const nextActive = Boolean(active);
            if (this._getOverviewSearchActive() === nextActive)
                return true;

            if (typeof controller._setSearchActive === 'function') {
                controller._setSearchActive(nextActive);
                return true;
            }

            if (controller._searchActive !== undefined) {
                controller._searchActive = nextActive;
                controller.notify?.('search-active');
                return true;
            }

            if (controller.searchActive !== undefined) {
                controller.searchActive = nextActive;
                return true;
            }
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to set search active state: ${e.message}`);
        }

        return false;
    }

    _restoreOverviewSearchActive() {
        this._setOverviewSearchActive(this._getSearchEntryText().trim().length > 0);
    }

    _restoreSearchActorVisibility(searchActor) {
        if (!searchActor)
            return;

        searchActor.visible = true;
        searchActor.opacity = 255;
        searchActor.reactive = true;
    }

    _syncModeVisibility() {
        const searchActor = this._searchResultsActor ?? null;

        if (!this._aiView)
            return;

        if (this._isAiMode) {
            if (!this._isOverviewTargetVisible()) {
                this._aiView.visible = false;
                this._aiView.reactive = false;
                this._restoreSearchActorVisibility(searchActor);
                return;
            }

            this._setOverviewSearchActive(true);
            this._aiView.visible = true;
            this._aiView.reactive = true;
            this._raiseAiView();
            this._ensureVisibleChain(this._aiView);

            if (searchActor) {
                searchActor.visible = true;
                searchActor.opacity = 0;
                searchActor.reactive = false;
                this._ensureVisibleChain(searchActor);
            }
            return;
        }

        this._aiView.visible = false;
        this._aiView.reactive = false;
        this._restoreSearchActorVisibility(searchActor);
    }

    _queueModeVisibilitySync() {
        if (this._modeVisibilityIdleId)
            return;

        this._modeVisibilityIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._modeVisibilityIdleId = null;
            if (this._isAiMode && this._aiView) {
                this._syncModeVisibility();
                this._scheduleVisibilityReassertion();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueFocusSearchEntry() {
        if (this._focusSearchIdleId)
            return;

        this._focusSearchIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusSearchIdleId = null;
            this._focusSearchEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusSearchEntry() {
        if (this._isAiMode && !this._promptEditor)
            this._openPromptEditor();
        const text = this._promptEditor?.clutter_text ?? this._searchTextActor;
        if (text?.grab_key_focus) {
            text.grab_key_focus();
            return;
        }

        this._searchEntry?.grab_key_focus?.();
    }

    _isOverviewTargetVisible() {
        if (Main.overview?.visibleTarget !== undefined)
            return !!Main.overview.visibleTarget;

        return !!Main.overview?.visible;
    }

    _raiseAiView() {
        if (!this._aiView)
            return;

        const parent = this._aiView.get_parent?.();
        if (!parent)
            return;

        try {
            if (typeof parent.set_child_above_sibling === 'function') {
                parent.set_child_above_sibling(this._aiView, null);
                return;
            }

            if (typeof this._aiView.raise_top === 'function')
                this._aiView.raise_top();
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to raise AI view: ${e.message}`);
        }
    }

    _ensureVisibleChain(actor) {
        for (let node = actor; node; node = node.get_parent?.()) {
            if (node === global.stage)
                break;

            if (!node.visible)
                node.visible = true;
        }
    }

    _scheduleVisibilityReassertion() {
        if (!this._isAiMode || !this._aiView)
            return;

        this._cancelVisibilityReassertion();

        let retries = 6;
        this._visibilityReassertionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            if (!this._isAiMode || !this._aiView) {
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            if (!this._isOverviewTargetVisible()) {
                this._aiView.visible = false;
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            this._syncModeVisibility();
            retries--;

            if (retries <= 0) {
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelVisibilityReassertion() {
        if (!this._visibilityReassertionId)
            return;

        GLib.source_remove(this._visibilityReassertionId);
        this._visibilityReassertionId = null;
    }

    _cancelModeVisibilitySync() {
        if (!this._modeVisibilityIdleId)
            return;

        GLib.source_remove(this._modeVisibilityIdleId);
        this._modeVisibilityIdleId = null;
    }

    _cancelFocusSearch() {
        if (!this._focusSearchIdleId)
            return;

        GLib.source_remove(this._focusSearchIdleId);
        this._focusSearchIdleId = null;
    }

    _registerToggleShortcut() {
        this._removeToggleShortcut();

        const shortcuts = this._settings?.get_strv?.(TOGGLE_AI_MODE_KEYBINDING) ?? [];
        if (shortcuts.length === 0 || !shortcuts[0])
            return;

        try {
            Main.wm.addKeybinding(
                TOGGLE_AI_MODE_KEYBINDING,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleModeFromShortcut()
            );
            this._toggleShortcutRegistered = true;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to register toggle shortcut: ${e.message}`);
        }
    }

    _removeToggleShortcut() {
        if (!this._toggleShortcutRegistered)
            return;

        try {
            Main.wm.removeKeybinding(TOGGLE_AI_MODE_KEYBINDING);
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to remove toggle shortcut: ${e.message}`);
        }
        this._toggleShortcutRegistered = false;
    }

    _reloadToggleShortcut() {
        this._registerToggleShortcut();
    }

    _registerContextShortcut() {
        this._removeContextShortcut();
        // Record events (in memory, for five minutes) only while they can be
        // sent: the window menu's "Ask …" sends them even without the shortcut.
        if (getBoolean(this._settings, DESKTOP_CONTEXT_KEYS.events, true))
            this._eventTracker?.start();
        else
            this._eventTracker?.stop();
        if (!getBoolean(this._settings, DESKTOP_CONTEXT_ENABLED) ||
            !getStrv(this._settings, DESKTOP_CONTEXT_KEYBINDING)[0])
            return;
        try {
            Main.wm.addKeybinding(
                DESKTOP_CONTEXT_KEYBINDING,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._openWithDesktopContext()
            );
            this._contextShortcutRegistered = true;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to register desktop context shortcut: ${e.message}`);
        }
    }

    _registerWindowShortcut() {
        this._removeWindowShortcut();
        if (!getBoolean(this._settings, WINDOW_CONTEXT_ENABLED, true) || !getStrv(this._settings, WINDOW_CONTEXT_KEYBINDING)[0])
            return;
        try {
            Main.wm.addKeybinding(WINDOW_CONTEXT_KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._askAboutFocusedWindow());
            this._windowShortcutRegistered = true;
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to register window context shortcut: ${e.message}`);
        }
    }

    _removeWindowShortcut() {
        if (!this._windowShortcutRegistered)
            return;
        try {
            Main.wm.removeKeybinding(WINDOW_CONTEXT_KEYBINDING);
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to remove window context shortcut: ${e.message}`);
        }
        this._windowShortcutRegistered = false;
    }

    // The shortcut: the focused window, or with the overview open (which
    // takes focus), the most recently used window on this workspace.
    _askAboutFocusedWindow() {
        if (!this._aiView)
            return;
        const usable = window => window && !window.is_skip_taskbar?.() && !window.minimized &&
            window.get_window_type() !== Meta.WindowType.DESKTOP;
        const workspace = global.workspace_manager.get_active_workspace();
        const window = [global.display.focus_window, ...global.display.get_tab_list(Meta.TabList.NORMAL, workspace)]
            .find(usable);
        if (!window) {
            Main.notify(this._assistantName(), 'There is no window to attach. Focus a window, then press the shortcut again.');
            return;
        }
        const privacy = this._privacy();
        const label = privacy ? privateWindowLabel(window, privacy.apps) : null;
        if (label) {
            Main.notify(this._assistantName(), `${label} is kept private by your settings, so it was not attached.`);
            return;
        }
        this._askAboutWindow(window);
    }

    _removeContextShortcut() {
        if (!this._contextShortcutRegistered)
            return;
        try {
            Main.wm.removeKeybinding(DESKTOP_CONTEXT_KEYBINDING);
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to remove desktop context shortcut: ${e.message}`);
        }
        this._contextShortcutRegistered = false;
    }

    disable() {
        debugLog('GNOME Assistant: Disabling...');

        const wasAiMode = this._isAiMode;
        this._isAiMode = false;
        this._restoreSingleLinePrompt();
        if (wasAiMode) {
            this._restoreOverviewSearchActive();
        }

        if (this._stageSignal) {
            if (global.stage)
                global.stage.disconnect(this._stageSignal);
            this._stageSignal = null;
        }

        if (this._searchTextSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchTextSignal);
            this._searchTextSignal = null;
        }

        if (this._searchKeyPressSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchKeyPressSignal);
            this._searchKeyPressSignal = null;
        }

        if (this._overviewShowingSignal) {
            Main.overview.disconnect(this._overviewShowingSignal);
            this._overviewShowingSignal = null;
        }

        if (this._overviewShownSignal) {
            Main.overview.disconnect(this._overviewShownSignal);
            this._overviewShownSignal = null;
        }

        if (this._overviewHiddenSignal) {
            Main.overview.disconnect(this._overviewHiddenSignal);
            this._overviewHiddenSignal = null;
        }

        this._cancelVisibilityReassertion();
        this._cancelModeVisibilitySync();
        this._cancelFocusSearch();
        this._removeToggleShortcut();

        if (this._shortcutChangedSignal && this._settings) {
            this._settings.disconnect(this._shortcutChangedSignal);
            this._shortcutChangedSignal = null;
        }
        this._dbusObject?.unexport();
        this._dbusObject = null;
        if (this._nameChangedSignal)
            this._settings?.disconnect(this._nameChangedSignal);
        this._nameChangedSignal = null;
        this._removeWindowShortcut();
        for (const id of this._windowShortcutSignals ?? [])
            this._settings.disconnect(id);
        this._windowShortcutSignals = null;
        this._removeContextShortcut();
        for (const id of this._contextShortcutSignals ?? [])
            this._settings?.disconnect(id);
        this._contextShortcutSignals = null;
        // A shown area or window picker holds a modal grab.
        cancelPick();
        this._selectionTracker?.destroy();
        this._selectionTracker = null;
        this._eventTracker?.stop();
        this._eventTracker = null;

        if (this._iconButtonSignal && this._searchEntry) {
            this._searchEntry.disconnect(this._iconButtonSignal);
            this._iconButtonSignal = null;
        }

        if (this._usesPrimaryIcon && this._searchEntry && typeof this._searchEntry.set_primary_icon === 'function') {
            this._searchEntry.set_primary_icon(this._originalPrimaryIcon);
        }

        if (this._aiButton) {
            if (this._aiButtonSignal) {
                this._aiButton.disconnect(this._aiButtonSignal);
                this._aiButtonSignal = null;
            }
            this._aiButton.destroy();
            this._aiButton = null;
        }

        if (this._icon) {
            this._icon.destroy();
            this._icon = null;
        }

        this._backgroundStatus?.destroy();
        this._backgroundStatus = null;
        this._injections?.clear();
        this._injections = null;
        this._problemWatcher?.destroy();
        this._problemWatcher = null;
        if (this._aiView) {
            this._aiView.destroy();
            this._aiView = null;
        }

        this._setSearchPlaceholder(this._originalSearchPlaceholder);
        
        // Restore search results visibility just in case
        if (this._searchResultsActor) {
            this._searchResultsActor.visible = true;
            this._searchResultsActor.opacity = 255;
            this._searchResultsActor.reactive = true;
        }

        this._searchEntry = null;
        this._searchTextActor = null;
        this._searchResultsView = null;
        this._searchResultsActor = null;
        this._searchController = null;
        this._aiViewParent = null;
        this._settings = null;
        this._originalSearchPlaceholder = null;
        this._originalPrimaryIcon = null;
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._modeVisibilityIdleId = null;
        this._focusSearchIdleId = null;
        this._shortcutChangedSignal = null;
        this._toggleShortcutRegistered = false;
        this._usesPrimaryIcon = false;
    }
}
