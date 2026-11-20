import GObject from 'gi://GObject';
import Atk from 'gi://Atk';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import {activeProfile, connectionKey, ProfileClient, readProfiles} from './connections.js';
import {configContext, nextConfigChange, savedConfigValues, saveConfigValue, selectChoices} from './acpConfig.js';
import {GnomeTools} from './gnomeTools.js';
import {AttachmentUpload, attachmentDelivery, attachmentFile, attachmentInstructions, attachmentMetadata, attachmentName,
    copyAttachment, decodeAttachment, imageMime, isTextContent, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TURN,
    MAX_EMBEDDED_TEXT_BYTES, downloadTarget, readAttachedBytes, receivedAttachmentInstructions, removeAttachmentDirectory,
    saveAttachment, selectAttachment} from './attachments.js';
import {selectFolder} from './folderArchive.js';
import {assistantName, assistantNameInstructions} from './assistantName.js';
import {describeFindings, findSecrets, maskedPreview, redactDeep, redactSecrets, sensitiveFile,
    sensitiveFolder} from './secretScanner.js';
import {privateApps} from './screenPrivacy.js';
import {appLogs, deviceStatus} from './desktopSystem.js';
import {captureWindow, desktopContextDetail, desktopContextForAgent, desktopContextParts, desktopContextInstructions, desktopContextLabel,
    desktopContextProcess, desktopContextScreenshots, desktopContextSize, desktopContextSnapshot} from './desktopContext.js';
import {chooseFile, relativeLocalPath, runLocalCommand, workspaceOperation} from './localAccess.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {nativeCommandInput} from './commands.js';
import {loadInlineImage, MAX_INLINE_IMAGES, parseImageLine, parseLocalImageRequest} from './imageSearch.js';
import {A2uiStore, A2UI_CATALOG_ID, A2UI_INSTRUCTIONS, A2UI_AGENT_FUNCTION_INSTRUCTIONS, A2UI_MIME, A2UI_MAX_BYTES, a2uiTransportPolicy,
    parseA2ui, splitA2uiBlocks} from './a2ui.js';
import {a2uiFallbackReference} from './a2uiReference.js';
import {A2uiView} from './a2uiView.js';
import {stateFile} from './state.js';
import {formatUnifiedDiff, hunkHeader, PathLinks, snippetName, unifiedDiff} from './replyActions.js';
import {applyHistoryMeta, buildHistoryIndex, conversationMarkdown, exportFileName, highlightSegments, historySnippet,
    loadHistoryMeta, searchHistory, searchTerms, updateHistoryMeta, writeTextFile} from './historyStore.js';
import {getBoolean, getString} from './settingsAccess.js';

// GNOME Shell 51 removed the legacy St.BoxLayout vertical property.
const VERTICAL_LAYOUT = St.BoxLayout.find_property('orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const DEFAULT_MAX_VISIBLE_MESSAGES = 12;
// View transitions, in the range GNOME Shell uses for menus and panels.
// Shell's ease() honours the user's animation and slow-down settings.
const VIEW_IN_MS = 200;
const VIEW_OUT_MS = 120;
const VIEW_SLIDE_PX = 16;
const PRIVACY_INSTRUCTIONS = 'GNOME Assistant removes secrets before content reaches you. Text such as "[redacted GitHub token]" or "[redacted password]" marks a secret that was replaced; it cannot be recovered. Black areas in screenshots hide private windows (such as password managers), notifications or secret-looking text. If a task really needs a secret, ask the user to make it available another way (for example, an environment variable or a file only they control) rather than to paste it into the chat.';
const REFERENCE_INSTRUCTIONS = 'The user referenced local files or folders instead of uploading them, listed as resource links and "Referenced file" or "Referenced folder" lines with absolute paths. They are on the computer where you run. Read them with your tools when the request needs them; for a folder, look only at what is relevant. When the user asks for changes, edit the referenced files in place, within your permissions, and say which files you changed.';
// GNOME Assistant does not search the web itself: agents have their own tools.
const WEB_RESEARCH_INSTRUCTIONS = 'Research on the web: when an answer depends on facts you are not sure of, on details that change over time (news, prices, versions, schedules, opening hours, statistics, measurements such as heights or distances), or when the user asks you to check, search the web and read the sources with your own web tools before answering, instead of answering from memory. Do not offer to search later: search now. Prefer primary and reputable sources, and cross-check figures when sources disagree. Cite the pages you used as Markdown links. Questions about the user\'s own files, code or computer do not need the web. If you have no web tools or they are blocked, say that the answer comes from memory and may be inaccurate.';
const DELEGATION_INSTRUCTIONS = 'You may use subagents automatically for substantial, independent read-only subtasks when parallel work would help. Give each subagent a clear scope, wait for relevant results, and combine them into one answer. Handle small or sequential tasks directly.';
const MAX_HISTORY_SESSIONS = 60;
const HISTORY_TITLE_CHARS = 96;
const HISTORY_PREVIEW_CHARS = 180;
const MAX_DISPLAY_CHARS = 24000;
const MAX_RENDER_BLOCKS = 800;
const TRUNCATED_NOTICE = '\n\n[Output truncated to keep GNOME Shell responsive.]';
// Diff lines shown before "Show all" in an approval.
const DIFF_PREVIEW_LINES = 30;
// Types whose default handler runs them (an executable, a launcher, Wine,
// Java…). Links to these, and to files with the executable bit, open the
// containing folder instead.
const RUNNABLE_TYPES = ['application/x-executable', 'application/x-sharedlib', 'application/x-desktop',
    'application/x-shellscript', 'application/x-ms-dos-executable', 'application/x-msi',
    'application/x-java-archive', 'application/vnd.appimage'];
const debug = false;
const A2UI_FALLBACK_REFERENCE = JSON.stringify(a2uiFallbackReference());

function debugWarn(...args) {
    if (debug)
        console.warn(...args);
}

function debugError(...args) {
    if (debug)
        console.error(...args);
}

function imageContent(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const content = new St.ImageContent({preferred_width: width, preferred_height: height});
    const format = pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
    const geometry = [pixbuf.read_pixel_bytes(), format, width, height, pixbuf.get_rowstride()];
    if (content.set_bytes.length === 6) {
        const context = global.stage.get_context().get_backend().get_cogl_context();
        content.set_bytes(context, ...geometry);
    } else {
        content.set_bytes(...geometry);
    }
    return content;
}

function previewImage(pixbuf, displayWidth, displayHeight, fit = 'contain') {
    return new St.Widget({
        content: imageContent(pixbuf),
        content_gravity: fit==='fill'?Clutter.ContentGravity.RESIZE_FILL:fit==='none' || (fit==='scaleDown' && pixbuf.get_width()<=displayWidth && pixbuf.get_height()<=displayHeight)?Clutter.ContentGravity.CENTER:Clutter.ContentGravity.RESIZE_ASPECT,
        clip_to_allocation:true,
        width: displayWidth,
        height: displayHeight,
    });
}

// St.Label's default height measurement does not account for wrapped lines.
const WrappedLabel = GObject.registerClass(
class WrappedLabel extends St.Label {
    vfunc_get_preferred_height(forWidth) {
        const fallback = super.vfunc_get_preferred_height(forWidth);
        if (forWidth < 0)
            return fallback;

        const node = this.get_theme_node();
        const layout = this.clutter_text.get_layout().copy();
        layout.set_width(Math.max(1, forWidth - node.get_horizontal_padding()) * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        const [, height] = layout.get_pixel_size();
        const needed = height + node.get_vertical_padding();
        return [Math.max(fallback[0], needed), Math.max(fallback[1], needed)];
    }
});

const MessageBubble = GObject.registerClass(
class MessageBubble extends St.BoxLayout {
    vfunc_get_preferred_height(forWidth) {
        // The chat column can offer its full width even though this aligned
        // bubble will only be allocated its natural width.
        const [, naturalWidth] = this.get_preferred_width(-1);
        const bubbleWidth = forWidth < 0 ? naturalWidth : Math.min(forWidth, naturalWidth);
        return super.vfunc_get_preferred_height(bubbleWidth);
    }
});

// A scrollable approval still needs to reserve space for its preview. The
// default ScrollView can report zero natural height inside a wrapping card.
const ApprovalPreview = GObject.registerClass(
class ApprovalPreview extends St.ScrollView {
    vfunc_get_preferred_height(forWidth) {
        const child = this.get_child();
        if (!child)
            return super.vfunc_get_preferred_height(forWidth);
        const node = this.get_theme_node();
        const width = forWidth < 0 ? -1 : Math.max(1, forWidth - node.get_horizontal_padding());
        const [, contentHeight] = child.get_preferred_height(width);
        const maximum = node.get_max_height();
        const height = Math.min(contentHeight + node.get_vertical_padding(), maximum >= 0 ? maximum : Infinity);
        return [height, height];
    }
});

const MarkdownTable = GObject.registerClass(
class MarkdownTable extends St.Widget {
    _init(rows, properties) {
        super._init(properties);
        this._rows = rows;
        for (const [rowIndex, row] of rows.entries()) {
            for (const [columnIndex, label] of row.entries())
                this.layout_manager.attach(label, columnIndex, rowIndex, 1, 1);
        }
    }

    vfunc_get_preferred_height(forWidth) {
        if (forWidth < 0)
            return super.vfunc_get_preferred_height(forWidth);

        const node = this.get_theme_node();
        const contentWidth = forWidth - node.get_horizontal_padding();
        const columnWidth = Math.max(1, Math.floor(contentWidth / this._rows[0].length));
        // The homogeneous grid wraps each cell at its share of the table width.
        const height = this._rows.reduce((total, row) => total +
            Math.max(...row.map(cell => cell.get_preferred_height(columnWidth)[1])),
        node.get_vertical_padding());
        return [height, height];
    }
});

export const AiView = GObject.registerClass({
    Signals: {'external-opened': {}, 'preferences-requested': {}, 'attachments-changed': {}, 'attachment-added': {},
        // File pickers are separate windows: the overview must step aside.
        'picker-opened': {}, 'picker-closed': {}, 'desktop-context-requested': {},
        // Progress for the top bar and notifications while the overview is
        // closed: see `running`, `pendingApprovals` and `decideApproval()`.
        'run-state-changed': {},
        // (outcome: 'done' | 'error' | 'stopped', reply text as shown in chat)
        'reply-finished': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        'approval-requested': {param_types: [GObject.TYPE_STRING]},
        'approval-resolved': {param_types: [GObject.TYPE_STRING]},
        // 'area' or 'window': the overlay draws on the desktop, so the
        // extension closes the overview while the user picks.
        'screen-capture-requested': {param_types: [GObject.TYPE_STRING]}},
},
class AiView extends St.BoxLayout {
    _init(settings = null) {
        super._init({
            style_class: 'ai-view-container',
            ...VERTICAL_LAYOUT,
            x_expand: true,
            y_expand: true,
            visible: false
        });
        this.add_style_class_name('popup-menu');
        this.add_style_class_name('popup-menu-content');

        this._settings = settings;
        this._approvals = new Map();
        // What each approval card asks and how to answer it, by card id.
        this._approvalRequests = new Map();
        this._queuedFiles = [];
        // Local paths sent by reference, without uploading their contents.
        this._queuedReferences = [];
        // Attached files the agent may stream with attachment_download, by id.
        this._downloads = new Map();
        this._desktopContext = null;
        // What this conversation sent to the agent, for the Shared view.
        // Kept in memory only, never in saved history.
        this._sharedItems = [];
        this._client = null;
        this._run = null;
        this._a2uiStore = this._createA2uiStore();
        this._a2uiViews = new Map();
        this._maxVisibleMessages = DEFAULT_MAX_VISIBLE_MESSAGES;
        this._visibleMessages = [];
        this._selectableMessageText = new WeakSet();
        this._memoryFilePath = stateFile('chat-history.jsonl').get_path();
        this._memoryWrites = Promise.resolve();
        this._scrollToBottomId = null;
        this._activeTab = 'chat';
        this._selectedHistorySessionId = null;
        // Rebuilt each time the history is loaded; searching only reads it.
        this._historyIndex = [];

        this.connect('destroy', () => {
            this._flushA2uiState();
            this._a2uiStore.remote.clear();
            if (this._agentFunctionSource) GLib.source_remove(this._agentFunctionSource);
            this._destroyed = true;
            this._publishAcpConfigState();
            if (this._connectionTimer)
                GLib.source_remove(this._connectionTimer);
            this._connectionTimer = null;
            this._cancelScrollToBottom();
            this._acpOptionsMenu?.destroy();
            this._client?.close();
            this._run?.acp?.close();
            this._run?.localCancel?.cancel();
            for (const cancel of this._run?.pendingApprovals ?? [])
                cancel(false);
            this._discardTemporaryAttachments();
            this._attachButton?.destroy();
            for (const id of this._profileSignals ?? [])
                this._settings.disconnect(id);
        });

        const headerLayout = new Clutter.GridLayout({column_homogeneous: true});
        this._headerRow = new St.Widget({
            style_class: 'ai-view-header-row',
            layout_manager: headerLayout,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL
        });
        this.add_child(this._headerRow);

        this._header = new St.Label({
            text: assistantName(settings),
            style_class: 'ai-view-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerLayout.attach(this._header, 0, 0, 1, 1);

        const tabs = new St.BoxLayout({
            style_class: 'ai-view-tabs',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chatTabButton = this._createTabButton('Chat', 'chat', 'chat-message-new-symbolic');
        this._historyTabButton = this._createTabButton('History', 'history', 'document-open-recent-symbolic');
        tabs.add_child(this._chatTabButton);
        tabs.add_child(this._historyTabButton);
        headerLayout.attach(tabs, 1, 0, 2, 1);

        const actions = new St.BoxLayout({
            style_class: 'ai-header-actions',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerLayout.attach(actions, 3, 0, 1, 1);

        this._newSessionButton = new St.Button({
            style_class: 'icon-button default ai-new-session-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'New conversation',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._newSessionButton.set_child(new St.Icon({
            icon_name: 'list-add-symbolic',
            icon_size: 16,
        }));
        this._newSessionButton.connect('clicked', () => {
            this._startNewConversation();
        });

        this._stopButton = new St.Button({
            style_class: 'icon-button flat', can_focus: true, track_hover: true, visible: false,
            accessible_name: 'Stop response',
        });
        this._stopButton.set_child(new St.Icon({icon_name: 'process-stop-symbolic'}));
        this._stopButton.connect('clicked', () => this._stopRun());
        this._agentOptionsButton = this._headerAction('emblem-system-symbolic', 'Options',
            () => this._showAcpOptions());
        this._syncAcpOptions([]);
        this._attachButton = this._headerAction('mail-attachment-symbolic', 'Attach',
            () => this._showAttachMenu());
        this._attachButton.style_class = 'button ai-prompt-attach';
        this._attachButton.y_align = Clutter.ActorAlign.START;
        this._shareFolderButton = this._headerAction('folder-open-symbolic', 'Share a local folder',
            () => this._shareLocalFolder());
        this._sharedButton = this._headerAction('document-send-symbolic', 'Shared with the agent',
            () => this._setActiveTab(this._activeTab === 'shared' ? 'chat' : 'shared'));
        this._sharedButton.add_style_class_name('ai-shared-toggle');
        this._sharedButton.toggle_mode = true;
        this._sharedButton.visible = false;
        for (const button of [this._sharedButton, this._agentOptionsButton, this._shareFolderButton])
            actions.add_child(button);
        this._profileSignals = this._settings ? ['acp-profile', 'acp-profiles', 'workspace-folder', 'memory-enabled']
            .map(key => this._settings.connect(`changed::${key}`, () => {
                if (!this._run) {
                    this._cancelFolderShare();
                    this._syncProfileButtons();
                }
                this._scheduleConnection();
                this._publishAcpConfigState();
            })) : [];
        if (this._settings)
            this._profileSignals.push(this._settings.connect('changed::assistant-name', () => {
                this._header.text = this.assistantName;
            }));
        if (this._settings)
            this._profileSignals.push(this._settings.connect('changed::acp-config-values', () => {
                this._configError = null;
                if (!this._run && !this._preparation?.pending && !this._configApplyPromise)
                    this._applySavedAcpConfig();
            }));
        this._syncProfileButtons();
        actions.add_child(this._stopButton);
        actions.add_child(this._newSessionButton);

        // Scroll View for Chat
        this._scrollView = new St.ScrollView({
            style_class: 'ai-view-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true
        });
        this.add_child(this._scrollView);

        // Content Container inside ScrollView
        this._contentBox = new St.BoxLayout({
            style_class: 'ai-view-content',
            ...VERTICAL_LAYOUT,
            x_expand: true,
            y_expand: true,
        });
        this._scrollView.set_child(this._contentBox);

        // The search entry stays above the scrolled list, and outside it so
        // that redrawing the results never takes its keyboard focus.
        this._historyPage = new St.BoxLayout({
            ...VERTICAL_LAYOUT,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.add_child(this._historyPage);
        this._historySearch = new St.Entry({
            style_class: 'ai-history-search',
            hint_text: 'Search conversations',
            can_focus: true,
            x_expand: true,
            visible: false,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 16}),
        });
        this._historySearch.clutter_text.connect('text-changed', () => {
            if (this._activeTab === 'history' && !this._selectedHistorySessionId)
                this._renderHistoryList();
        });
        this._historyPage.add_child(this._historySearch);

        this._historyScrollView = new St.ScrollView({
            style_class: 'ai-view-scroll ai-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._historyPage.add_child(this._historyScrollView);

        this._historyBox = new St.BoxLayout({
            style_class: 'ai-history-content',
            ...VERTICAL_LAYOUT,
            x_expand: true,
            y_expand: true,
        });
        this._historyScrollView.set_child(this._historyBox);

        this._sharedScrollView = new St.ScrollView({
            style_class: 'ai-view-scroll ai-shared-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.add_child(this._sharedScrollView);
        this._sharedBox = new St.BoxLayout({
            style_class: 'ai-history-content ai-shared-content',
            ...VERTICAL_LAYOUT,
            x_expand: true,
        });
        this._sharedScrollView.set_child(this._sharedBox);

        this._welcomePanel = new St.BoxLayout({
            ...VERTICAL_LAYOUT, style_class: 'ai-chat-welcome',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        this._welcomePanel.add_child(new St.Icon({
            icon_name: 'chat-message-new-symbolic', icon_size: 48,
            style_class: 'ai-welcome-icon', x_align: Clutter.ActorAlign.CENTER,
        }));
        this._welcomePanel.add_child(this._createTextLabel('ai-welcome-title', 'How can I help?'));
        this._welcome = this._createTextLabel(
            'ai-welcome-description',
            'Ask about your workspace or give the agent a task.'
        );
        this._welcome.opacity = 180;
        this._welcomePanel.add_child(this._welcome);
        this._contentBox.add_child(this._welcomePanel);

        this._syncTabState();
        this._scheduleConnection();
    }

    addMessage(sender, text, {pending = false} = {}) {
        if (this._activeTab !== 'chat')
            this._setActiveTab('chat');

        this._welcomePanel.hide();
        const isUser = sender === 'You';
        const {bubble, bodyBox, copyButton} = this._createMessageBubble(sender, isUser);

        const extras = new St.BoxLayout({...VERTICAL_LAYOUT, x_expand: true, visible: !isUser});
        bubble.add_child(extras);
        const message = {
            sender,
            extras,
            actor: bubble,
            bodyBox,
            text: '',
            renderMode: pending ? 'pending' : null,
            plainLabel: null,
            requestedImage: null,
            disposed: false,
            setText: value => {
                if (message.disposed)
                    return;

                const nextText = this._limitDisplayText(value);
                if (message.renderMode === 'markdown' && message.text === nextText)
                    return;

                message.text = nextText;
                copyButton.visible = Boolean(nextText);
                message.renderMode = 'markdown';
                message.plainLabel = null;
                this._renderMarkdownToBox(bodyBox, message.text, message.renderCwd ?? this._threadCwd, message.requestedImage, message.remote);
                this._scrollToBottom();
            },
            setPlainText: value => {
                if (message.disposed)
                    return;

                const nextText = this._limitDisplayText(value);
                if (message.renderMode === 'pending' && !nextText.trim())
                    return;
                if (message.renderMode === 'plain' && message.text === nextText)
                    return;

                message.text = nextText;
                copyButton.visible = Boolean(nextText);
                message.renderMode = 'plain';

                if (!message.plainLabel) {
                    for (const child of bodyBox.get_children())
                        child.destroy();

                    message.plainLabel = this._createTextLabel('ai-message-text', message.text, {selectable: true});
                    bodyBox.add_child(message.plainLabel);
                } else {
                    message.plainLabel.clutter_text.set_text(message.text);
                }

                this._scrollToBottom();
            }
        };
        copyButton.connect('clicked', () => this._copyText(message.text));

        this._contentBox.add_child(bubble);
        this._visibleMessages.push(message);
        this._trimVisibleMessages();
        if (pending) {
            bodyBox.add_child(this._createTypingIndicator());
            this._scrollToBottom();
        } else if (isUser)
            message.setPlainText(text ?? '');
        else
            message.setText(text ?? '');

        return message;
    }

    _createTypingIndicator() {
        const indicator = new St.BoxLayout({
            style_class: 'ai-typing-indicator',
            accessible_name: 'Waiting for response',
        });
        const dots = Array.from({length: 3}, () => new St.Widget({style_class: 'ai-typing-dot'}));
        for (const dot of dots)
            indicator.add_child(dot);

        const settings = St.Settings.get();
        let activeDot = 0;
        const update = () => {
            for (const [index, dot] of dots.entries())
                dot.opacity = !settings.enable_animations || index === activeDot ? 255 : 100;
        };
        update();
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            if (indicator.mapped) {
                activeDot = (activeDot + 1) % dots.length;
                update();
            }
            return GLib.SOURCE_CONTINUE;
        });
        indicator.connect('destroy', () => GLib.source_remove(source));
        return indicator;
    }

    _createMessageBubble(sender, isUser) {
        const side = isUser ? 'ai-chat-bubble-user' : 'ai-chat-bubble-agent';
        const bubble = new MessageBubble({
            style_class: `message ai-chat-bubble ${side}`,
            ...VERTICAL_LAYOUT,
            reactive: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_align: isUser ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        });
        const header = new St.BoxLayout({style_class: 'ai-message-header'});
        header.add_child(new St.Label({
            text: sender,
            style_class: 'ai-message-sender',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const copyButton = new St.Button({
            style_class: 'icon-button flat ai-copy-message',
            accessible_name: 'Copy message',
            can_focus: true,
            track_hover: true,
            visible: false,
        });
        copyButton.set_child(new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14}));
        header.add_child(copyButton);
        bubble.add_child(header);
        const bodyBox = new St.BoxLayout({
            style_class: 'ai-message-body',
            ...VERTICAL_LAYOUT,
            x_expand: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
        });
        bubble.add_child(bodyBox);
        return {bubble, bodyBox, copyButton};
    }

    // The outgoing view fades out, then the incoming one fades in, sliding
    // up from below for the Shared view as it is a panel opened on top of
    // the chat. Views share one slot, so they never overlap mid-transition.
    _transitionViews() {
        const views = {chat: this._scrollView, history: this._historyPage, shared: this._sharedScrollView};
        const incoming = views[this._activeTab];
        const outgoing = Object.values(views).filter(view => view && view !== incoming && view.visible);
        const token = this._viewTransition = Symbol('view transition');
        const slide = view => view === this._sharedScrollView ? VIEW_SLIDE_PX : 0;
        const show = () => {
            if (this._viewTransition !== token || !incoming || this._destroyed)
                return;
            for (const view of Object.values(views)) {
                if (view && view !== incoming && view.visible) {
                    view.remove_all_transitions();
                    view.hide();
                }
            }
            if (incoming.visible && incoming.opacity === 255 && incoming.translation_y === 0)
                return;
            incoming.remove_all_transitions();
            if (!incoming.visible) {
                incoming.opacity = 0;
                incoming.translation_y = slide(incoming);
                incoming.show();
            }
            incoming.ease({opacity: 255, translation_y: 0, duration: VIEW_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        // Nothing on screen yet (startup): show without a fade-out first.
        if (!outgoing.length || !this.mapped) {
            for (const view of outgoing) {
                view.remove_all_transitions();
                view.hide();
            }
            if (!this.mapped && incoming) {
                incoming.remove_all_transitions();
                incoming.opacity = 255;
                incoming.translation_y = 0;
                incoming.show();
                return;
            }
            show();
            return;
        }
        let pending = outgoing.length;
        for (const view of outgoing) {
            view.remove_all_transitions();
            view.ease({opacity: 0, translation_y: slide(view), duration: VIEW_OUT_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    view.translation_y = 0;
                    if (--pending === 0)
                        show();
                }});
        }
    }

    _createTabButton(label, tab, iconName) {
        const button = new St.Button({
            style_class: 'button flat ai-tab-button',
            toggle_mode: true,
            can_focus: true,
            track_hover: true,
            accessible_name: label,
        });
        const content = new St.BoxLayout({style_class: 'ai-tab-content'});
        content.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        content.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        button.set_child(content);
        button.connect('clicked', () => {
            this._setActiveTab(tab);
        });
        return button;
    }

    _setActiveTab(tab) {
        if (tab !== 'chat' && tab !== 'history' && tab !== 'shared')
            return;

        this._activeTab = tab;
        if (tab === 'history')
            this._refreshHistoryView();
        if (tab === 'shared')
            this._refreshSharedView();

        this._syncTabState();
    }

    _syncTabState() {
        this._transitionViews();
        if (this._sharedButton) {
            this._sharedButton.checked = this._activeTab === 'shared';
            this._sharedButton.accessible_name = this._activeTab === 'shared' ? 'Back to chat' : 'Shared with the agent';
        }

        this._chatTabButton.checked = this._activeTab === 'chat';
        this._historyTabButton.checked = this._activeTab === 'history';
        for (const button of [this._chatTabButton, this._historyTabButton]) {
            button[button.checked ? 'add_style_class_name' : 'remove_style_class_name']('default');
            button[button.checked ? 'remove_style_class_name' : 'add_style_class_name']('flat');
        }
    }

    _trimVisibleMessages() {
        const maxMessages = Math.max(1, this._maxVisibleMessages | 0);
        while (this._visibleMessages.length > maxMessages) {
            const oldMessage = this._visibleMessages.shift();
            if (oldMessage)
                oldMessage.disposed = true;
            oldMessage?.actor?.destroy?.();
        }
    }

    _startNewConversation() {
        if (this._run)
            return;
        this._privacyReview?.resolve('cancel');
        this._resetA2ui();
        this._threadId = null;
        this._threadConnection = null;
        this._nativeProfileCommands = [];
        this._threadRemote = false;
        // Queued attachments and the desktop context belong to the message
        // being written, not to the old conversation: they stay.
        this._downloads = new Map();
        this._sharedDesktopContext = null;
        this._sharedDesktopEntry = null;
        this._sharedItems = [];
        this._syncSharedButton();
        this._discardTemporaryAttachments();
        this._cancelFolderShare();
        this._syncAcpOptions([]);
        this._updateAttachmentButton();
        if (this._preparation?.pending) {
            this._client?.close();
            this._client = null;
            this._preparation = null;
        }
        this._reconnectDelay = 1000;
        this._selectedHistorySessionId = null;
        this._setActiveTab('chat');

        for (const message of this._visibleMessages) {
            message.disposed = true;
            message.actor?.destroy?.();
        }
        this._visibleMessages = [];
        this._welcomePanel.show();
        this._scrollToBottom();
        this._scheduleConnection();
    }

    _canContinueThread(cwd, persist) {
        return this._threadId && this._threadCwd === cwd && this._threadEphemeral === !persist;
    }

    async generateResponse(prompt, {a2uiEvent = null, a2uiFunctions = null} = {}) {
        if (this._run)
            throw new Error('Wait for the current response before sending another message.');
        this._flushA2uiState();
        const profile = activeProfile(this._settings);
        const name = profile?.name || 'ACP agent';
        const message = a2uiFunctions ? this._a2uiViews.get(a2uiFunctions[0].callAgentFunction.surfaceId)?.message
            : this.addMessage(this.assistantName, '', {pending: true});
        if (!message || message.disposed) throw new Error('The source interface was removed.');
        const statusLabel = new St.Label({
            style_class: 'ai-message-status',
            text: `Connecting to ${name}…`,
            opacity: 180,
        });
        this._contentBox.insert_child_above(statusLabel, message.actor);
        const run = {
            message, statusLabel, cancelled: false, silentFunctions:Boolean(a2uiFunctions),
            functionRequests:a2uiFunctions, agentStore:this._a2uiStore,
        };
        run.finished = new Promise(resolve=>{run.finish=resolve;});
        this._run = run;
        this.emit('run-state-changed');
        this._syncProfileButtons();
        this._publishAcpConfigState();
        if (!run.silentFunctions) this._setA2uiBusy(true);
        this._stopButton.show();
        this._newSessionButton.reactive = false;
        try {
            const cwd = this._getSettingString('workspace-folder', '');
            if (!GLib.path_is_absolute(cwd) || !GLib.file_test(cwd, GLib.FileTest.IS_DIR))
                throw new Error('Choose an existing workspace folder in extension Preferences.');
            const requestedImage = parseLocalImageRequest(prompt);
            if (requestedImage)
                message.requestedImage = GLib.canonicalize_filename(requestedImage, cwd);

            await this._runProfile(run, profile, cwd, prompt, a2uiEvent);
        } catch (error) {
            run.failed = true;
            if (run.silentFunctions)
                run.agentStore.remote.fail(run.functionRequests.map(request=>request.callAgentFunction.functionCallId),
                    run.functionTimedOut?'TIMEOUT':run.cancelled?'CANCELLED':'TRANSPORT_ERROR',error.message);
            else if (!this._destroyed)
                message.setPlainText(run.functionTimedOut ? 'The agent timed out while processing the interface function result.' : run.cancelled ? 'Stopped.' : `${name}: ${error.message}`);
        } finally {
            run.localCancel?.cancel();
            for (const cancel of run.pendingApprovals ?? [])
                cancel(false);
            if (!this._destroyed) {
                if (!run.silentFunctions && run.cancelled && message.renderMode === 'pending')
                    message.setPlainText('Stopped.');
                this._clearApprovals();
                this._stopButton.hide();
                this._newSessionButton.reactive = true;
                statusLabel.destroy();
            }
            this._run = null;
            run.finish();
            this._setA2uiBusy(false);
            if (!this._destroyed) {
                this.emit('run-state-changed');
                // Interface function calls run unseen; only chat replies finish.
                if (!run.silentFunctions)
                    this.emit('reply-finished', run.cancelled ? 'stopped'
                        : run.failed || run.functionTimedOut ? 'error' : 'done', message.text ?? '');
                this._syncProfileButtons();
                this._publishAcpConfigState();
                this._applySavedAcpConfig();
                this._scheduleConnection();
                if (run.silentFunctions) this._queueA2uiState(this._a2uiContext);
                this._scheduleAgentFunctions();
            }
        }
    }

    _scheduleConnection(delay = 750) {
        if (this._destroyed)
            return;
        if (this._connectionTimer)
            GLib.source_remove(this._connectionTimer);
        this._connectionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._connectionTimer = null;
            if (!this._run)
                this._warmConnection();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _warmConnection() {
        const profile = activeProfile(this._settings);
        const localCwd = this._getSettingString('workspace-folder', '');
        if (typeof profile?.command !== 'string' || !profile.command.trim() ||
            !GLib.path_is_absolute(localCwd) || !GLib.file_test(localCwd, GLib.FileTest.IS_DIR) ||
            (profile.transport === 'ssh' && !GLib.path_is_absolute(profile.remoteCwd ?? ''))) {
            this._client?.close();
            this._client = null;
            this._preparation = null;
            this._nativeProfileCommands = [];
            this._syncAcpOptions([]);
            this._welcome.text = 'Add an ACP connection and workspace in Preferences.';
            return;
        }
        let preparation;
        try {
            const ready = this._prepareProfile(profile, localCwd);
            preparation = this._preparation;
            this._welcome.text = `Connecting to ${profile.name || 'ACP agent'}…`;
            await ready;
            if (this._destroyed || this._preparation !== preparation)
                return;
            this._reconnectDelay = 1000;
            this._welcome.text = 'Ask about your workspace or give the agent a task.';
        } catch (error) {
            if (this._destroyed || this._run || (preparation && this._preparation !== preparation))
                return;
            this._welcome.text = 'Connection unavailable. Send a message to retry.';
            console.warn('GNOME Assistant: Background ACP connection failed', error.message);
            this._scheduleConnection(this._reconnectDelay ?? 1000);
            this._reconnectDelay = Math.min((this._reconnectDelay ?? 1000) * 2, 30000);
        }
    }

    _prepareProfile(profile, localCwd) {
        if (!profile)
            throw new Error('Add and select an ACP connection in extension Preferences.');
        if (this._destroyed)
            throw new Error('GNOME Assistant was disabled.');
        const remote = profile.transport === 'ssh';
        const cwd = remote ? profile.remoteCwd : localCwd;
        if (typeof cwd !== 'string' || !GLib.path_is_absolute(cwd))
            throw new Error('Set an absolute remote workspace path in the ACP connection.');

        const persist = this._isPersistentMemoryEnabled();
        const identity = connectionKey(profile, cwd);
        const root = remote && this._sharedFolder?.profile === profile.id ? this._sharedFolder.path : null;
        const key = JSON.stringify([identity, localCwd, root, Boolean(profile.localCommands), persist]);
        const previous = this._preparation;
        if (previous?.key === key && this._client && !this._client.closed &&
            (previous.pending || (previous.sessionId === this._threadId && this._loadedThreadId === this._threadId)))
            return previous.promise;

        if (!this._canContinueThread(cwd, persist) || this._threadConnection !== identity ||
            this._threadLocalCwd !== localCwd)
            this._threadId = null;
        const reusableClient = previous?.key === key && !previous.pending && this._client && !this._client.closed
            ? this._client : null;
        if (!reusableClient) {
            this._client?.close();
            this._client = null;
        }
        this._threadConnection = identity;
        this._threadProfile = profile.id;
        this._threadLocalCwd = localCwd;
        this._threadCwd = cwd;
        this._threadRemote = remote;
        const context = {profile, localCwd, remote, cwd, persist, root};
        const preparation = {key, pending: true};
        this._preparation = preparation;
        preparation.promise = this._openProfileConnection(context, reusableClient).then(client => {
            preparation.pending = false;
            preparation.sessionId = this._threadId;
            this._publishAcpConfigState();
            return {...context, client};
        }, error => {
            preparation.pending = false;
            if (this._preparation === preparation)
                this._client?.close(error);
            this._publishAcpConfigState();
            throw error;
        });
        return preparation.promise;
    }

    async _openProfileConnection({profile, cwd, remote, persist, root}, client) {
        if (!client) {
            this._nativeProfileCommands = [];
            this._loadedThreadId = null;
            this._syncAcpOptions([]);
            const tools = new GnomeTools({
                checkTurn: () => this._activeProfileTurn(client),
                attach: (name, bytes) => this._receiveAttachment(this._activeProfileTurn(client), name, bytes),
                beginUpload: (name, size, cancel) => this._beginAttachmentUpload(this._activeProfileTurn(client), name, size, cancel),
                image: (url, caption) => this._receiveToolImage(this._activeProfileTurn(client), url, caption),
                a2ui: messages => this._receiveA2ui(this._activeProfileTurn(client), messages, true),
                desktop: (name, args) => this._desktopTool(this._activeProfileTurn(client), name, args),
                desktopTools: () => this._desktopToolNames(remote),
                describeDownload: id => this._download(this._activeProfileTurn(client), id),
                openDownload: id => this._openDownload(this._activeProfileTurn(client), id),
                local: root ? (method, args) => this._profileLocalTool(this._activeProfileTurn(client), method, args) : null,
                commands: Boolean(root && profile.localCommands),
            });
            try {
                client = new ProfileClient(profile, cwd, remote ? tools.port : null, {
                    onUpdate: params => {
                        if (client === this._client)
                            this._onAcpUpdate(params);
                    },
                    onPermission: (id, params, decide) => this._onAgentPermission(client, id, params, decide, remote),
                    onRequest: (method, params) => this._onProfileRequest(client, method, params),
                    onClose: () => {
                        tools.close();
                        if (client === this._client)
                            this._publishAcpConfigState();
                        if (client === this._client && !this._run && !this._preparation?.pending) {
                            if (!this._visibleMessages.length && !client.agentCapabilities.loadSession &&
                                client.agentCapabilities.sessionCapabilities?.resume === undefined)
                                this._threadId = null;
                            this._scheduleConnection(this._reconnectDelay ?? 1000);
                        }
                    },
                    capabilities: {
                        ...(root ? {fs: {readTextFile: true, writeTextFile: true}} : {}),
                        _meta: {'org.gnome.assistant/a2ui': {version: '1.0', supportedCatalogIds: [A2UI_CATALOG_ID]}},
                    },
                });
            } catch (error) {
                tools.close();
                throw error;
            }
            client.gnomeTools = tools;
            this._client = client;
            this._loadedThreadId = null;
            if (!persist)
                this._threadId = null;
            try {
                await client.initialize();
                if (this._destroyed || this._client !== client)
                    throw new Error('The ACP connection changed during setup.');
            } catch (error) {
                client.close();
                throw error;
            }
        }
        if (!this._threadId || this._loadedThreadId !== this._threadId) {
            const canResume = client.agentCapabilities.loadSession ||
                client.agentCapabilities.sessionCapabilities?.resume !== undefined;
            if (this._threadId && !canResume)
                throw new Error('This agent cannot resume the saved chat. Start a new conversation.');
            const session = await client.openSession(this._threadId, {
                mcpServers: client.agentCapabilities.mcpCapabilities?.http ? [client.gnomeTools.descriptor()] : [],
            });
            if (this._destroyed || this._client !== client)
                throw new Error('The ACP connection changed during setup.');
            this._threadId = session.sessionId;
            this._loadedThreadId = session.sessionId;
            this._threadEphemeral = !persist;
            this._threadResumable = Boolean(canResume);
            this._syncAcpOptions(session.configOptions ?? []);
        }
        client.gnomeTools.setSession(this._threadId);
        await this._applySavedAcpConfig();
        return client;
    }

    async _runProfile(run, profile, localCwd, prompt, a2uiEvent) {
        const {client, remote, root, persist} = await this._prepareProfile(profile, localCwd);
        await this._applySavedAcpConfig();
        if (run.cancelled || this._destroyed)
            return;
        const context = this._threadConnection + ':' + this._threadId;
        if (this._a2uiContext !== context) {
            this._resetA2ui();
            this._a2uiContext = context;
        }
        if (run.silentFunctions && run.agentStore !== this._a2uiStore)
            throw new Error('The conversation changed before the interface function was sent.');
        run.acp = client;
        run.localRoot = root;
        run.localCommands = Boolean(root && profile.localCommands);
        run.pendingApprovals = new Set();
        run.localCancel = new Gio.Cancellable();
        run.message.renderCwd = localCwd;
        run.message.remote = remote;
        run.message.requestedImage = remote ? null : run.message.requestedImage;
        // /name or $name: the agent's commands and skills, or GNOME Assistant's own (/a2ui).
        const input = run.functionRequests ? run.functionRequests.map(request=>JSON.stringify(request)).join('\n') : a2uiEvent ? JSON.stringify(a2uiEvent) : nativeCommandInput(prompt, this._nativeProfileCommands);
        const resources = [];
        const files = run.silentFunctions ? [] : [...this._queuedFiles];
        const hasTools = client.agentCapabilities.mcpCapabilities?.http;
        const promptCapabilities = client.agentCapabilities.promptCapabilities ?? {};
        const capabilities = {tools: Boolean(hasTools), images: Boolean(promptCapabilities.image),
            embedded: Boolean(promptCapabilities.embeddedContext)};
        let text = input;
        // Decide every file first, so nothing is offered for download if a
        // later file cannot be sent.
        const deliveries = [];
        for (const file of files) {
            const size = file.size ?? file.bytes.length;
            const image = file.image ?? Boolean(imageMime(file.bytes));
            // Read only what may be embedded: images, and text small enough to embed.
            const readable = !file.folder && (file.bytes || (image && capabilities.images && size <= MAX_ATTACHMENT_BYTES) ||
                size <= (capabilities.tools ? MAX_EMBEDDED_TEXT_BYTES : MAX_ATTACHMENT_BYTES));
            const bytes = readable ? await readAttachedBytes(file) : null;
            const delivery = attachmentDelivery({name: file.name, size, image, folder: Boolean(file.folder),
                text: Boolean(bytes && isTextContent(bytes))}, capabilities);
            deliveries.push({file, size, bytes, delivery});
        }
        if (run.cancelled || this._destroyed)
            return;
        let streamed = false;
        for (const {file, size, bytes, delivery} of deliveries) {
            const shared = {kind: 'file', time: new Date(), prompt, name: file.name, size, path: file.path ?? null,
                redacted: file.redacted ?? [], excluded: file.excluded ?? [], privacy: file.privacy ?? null,
                delivery, downloads: [], ...(file.folder ? {folder: true, files: file.files, contentSize: file.contentSize} : {}),
                ...(delivery !== 'stream' ? {bytes} : {})};
            if (delivery === 'image') {
                resources.push({type: 'image', mimeType: imageMime(bytes), data: GLib.base64_encode(bytes)});
                text += `\nAttached file: ${JSON.stringify(file.name)}.`;
            } else if (delivery === 'embed') {
                const uri = `gnome-assistant://attached/${encodeURIComponent(file.name)}`;
                resources.push({type: 'resource', resource: {uri, ...(isTextContent(bytes)
                    ? {text: new TextDecoder().decode(bytes), mimeType: 'text/plain'}
                    : {blob: GLib.base64_encode(bytes), mimeType: 'application/octet-stream'})}});
                text += `\nAttached file: ${JSON.stringify(file.name)}.`;
            } else if (file.folder) {
                this._downloads.set(file.id, {...file, shared});
                text += `\nAttached folder for download: ${JSON.stringify({id: file.id, name: file.name, files: file.files,
                    content_size: file.contentSize, format: 'tar',
                    ...(file.skipped.length ? {skipped: file.skipped.slice(0, 20), skipped_count: file.skipped.length} : {}),
                    ...(file.excluded?.length ? {left_out_as_sensitive: file.excluded.slice(0, 20).map(item => item.path)} : {})})}.`;
                streamed = true;
            } else {
                // Streamed on request: only a short description enters the prompt.
                const type = Gio.content_type_get_mime_type(Gio.content_type_guess(file.name, null)[0]) ?? 'application/octet-stream';
                this._downloads.set(file.id, {...file, shared});
                text += `\nAttached file for download: ${JSON.stringify({id: file.id, name: file.name, size, type})}.`;
                streamed = true;
            }
            this._recordShared(shared);
        }
        const references = run.silentFunctions ? [] : [...this._queuedReferences];
        if (references.length && remote)
            throw new Error('References only work with an agent running on this computer. Remove them, or attach the files instead.');
        for (const reference of references) {
            // resource_link is part of every ACP agent's baseline prompt support.
            resources.push({type: 'resource_link', uri: Gio.File.new_for_path(reference.path).get_uri(),
                name: GLib.path_get_basename(reference.path), ...(reference.folder ? {mimeType: 'inode/directory'} : {})});
            text += `\nReferenced ${reference.folder ? 'folder' : 'file'}: ${JSON.stringify(reference.path)}.`;
            this._recordShared({kind: 'reference', time: new Date(), prompt, name: reference.path, folder: reference.folder});
        }
        const captured = run.silentFunctions ? null : this._desktopContext;
        // A local agent reads some details itself; see desktopContextForAgent.
        const desktop = captured && desktopContextForAgent(captured,
            {local: !remote, skipLocal: this._getSettingBoolean('desktop-context-skip-local', true)});
        if (desktop) {
            // Screenshot protection runs while the user types; never send before it is done.
            if (captured.protection) {
                run.statusLabel?.set_text('Checking screenshots for secrets…');
                await captured.protection;
                desktop.privacy = captured.privacy;
                if (run.cancelled || this._destroyed)
                    return;
            }
            const screenshots = desktopContextScreenshots(desktop);
            if (screenshots.length && !client.agentCapabilities.promptCapabilities?.image)
                throw new Error('This agent does not accept images. Remove the desktop context, or turn off screenshots in Preferences.');
            for (const monitor of screenshots)
                resources.push({type: 'image', mimeType: imageMime(monitor.image.bytes) ?? 'image/png',
                    data: GLib.base64_encode(monitor.image.bytes)});
            const agent = {host: remote ? 'ssh' : 'local', working_directory: (remote ? profile.remoteCwd : localCwd) || null};
            // With tools, details stay out of the prompt until the agent asks.
            // Without them, read what tools would return now and attach it.
            const extras = hasTools ? {} : await this._desktopContextExtras(desktop);
            if (run.cancelled || this._destroyed)
                return;
            // Collected text (selection, titles, notifications, logs) is redacted
            // without asking: the user did not choose to send it.
            const redacted = [];
            const transform = value => {
                if (!this.privacyEnabled)
                    return value;
                const result = redactDeep(value);
                redacted.push(...result.findings.map(finding => finding.label));
                return result.value;
            };
            const snapshot = desktopContextSnapshot(desktop, agent, {onRequest: Boolean(hasTools), extras, transform});
            resources.push({type: 'text', text: snapshot, annotations: {audience: ['assistant']}});
            this._sharedDesktopEntry = {kind: 'desktop', time: new Date(), prompt, view: desktop, snapshot,
                onRequest: Boolean(hasTools), toolCalls: [], redacted, privacy: desktop.privacy ?? null};
            this._recordShared(this._sharedDesktopEntry);
            text += `\nAttached ${desktop.scope === 'window' ? 'window' : 'desktop'} context: ${desktopContextLabel(desktop)}.`;
        }
        if (files.length || captured || references.length) {
            this._queuedFiles.splice(0, files.length);
            this._queuedReferences.splice(0, references.length);
            if (this._desktopContext === captured)
                this._desktopContext = null;
            // The desktop_* tools answer from the latest context shared here.
            if (desktop)
                this._sharedDesktopContext = desktop;
            this._updateAttachmentButton();
        }
        const instructions = [
            this._getSettingString('system-prompt', ''),
            this._getSettingString('custom-instructions', ''),
            assistantNameInstructions(this.assistantName),
            this.privacyEnabled ? PRIVACY_INSTRUCTIONS : '',
            this._getSettingBoolean('auto-delegate', true) ? DELEGATION_INSTRUCTIONS : '',
            this._getSettingBoolean('web-research', true) ? WEB_RESEARCH_INSTRUCTIONS : '',
            'GNOME Assistant renders Markdown, public HTTPS image links, inline images, and embedded files.',
            attachmentInstructions(Boolean(hasTools)),
            streamed ? receivedAttachmentInstructions() : '',
            desktop ? desktopContextInstructions(desktop, {onRequest: Boolean(hasTools)}) : '',
            references.length ? REFERENCE_INSTRUCTIONS : '',
            hasTools ? client.gnomeTools.instructions() : '',
            root ? 'The user shared a local folder. Use only the GNOME Assistant local tools or ACP client file requests to access it. Ordinary agent filesystem tools run on the agent host.' : '',
            A2UI_INSTRUCTIONS,
            a2uiTransportPolicy(Boolean(hasTools)).instructions,
            run.functionRequests ? A2UI_AGENT_FUNCTION_INSTRUCTIONS + '\nA2UI function modes: '+
                JSON.stringify(Object.fromEntries(run.functionRequests.map(request=>[request.callAgentFunction.functionCallId,
                    run.agentStore.remote.byId.get(request.callAgentFunction.functionCallId)?.imperative?'action':'reactive']))) : '',
            !hasTools ? 'GNOME A2UI reference (documentation, not a replacement schema): ' + A2UI_FALLBACK_REFERENCE : '',
        ].filter(Boolean).join('\n\n');
        await this._runAcpPrompt(run, text, persist, prompt, profile.name || 'ACP agent', instructions, resources);
    }

    // Tool names for the parts enabled now, adjusted for where the agent runs.
    _desktopToolNames(remote) {
        const enabled = key => this._getSettingBoolean(key, true);
        // No gate on the desktop context shortcut: window contexts come from
        // the window menu, and the tools only answer about what was shared.
        const local = !remote && enabled('desktop-context-skip-local');
        return [
            enabled('desktop-context-windows') && 'desktop_get_windows',
            enabled('desktop-context-selection') && 'desktop_get_selection',
            enabled('desktop-context-projects') && 'desktop_get_projects',
            enabled('desktop-context-events') && 'desktop_get_recent_events',
            enabled('desktop-context-screenshots') && 'desktop_capture_window',
            enabled('desktop-context-app-logs') && (local ? 'desktop_get_window_process' : 'desktop_get_app_logs'),
            enabled('desktop-context-device-status') && !local && 'desktop_get_device_status',
        ].filter(Boolean);
    }

    async _desktopContextExtras(desktop) {
        const focused = desktop.focusedWindow && desktop.processes?.get(desktop.focusedWindow.id);
        const [logs, status] = await Promise.all([
            desktop.parts.appLogs && focused ? appLogs(focused, {priority: 'info', lines: 20, minutes: 30}).catch(() => null) : null,
            desktop.parts.deviceStatus ? deviceStatus().catch(() => null) : null,
        ]);
        return {appLogs: logs, deviceStatus: status};
    }

    // Logs each desktop_* call in the Shared view, so the user can see what
    // the agent looked at.
    async _desktopTool(run, name, args) {
        const entry = this._sharedDesktopEntry;
        const call = {name, args, time: new Date()};
        try {
            let result = await this._runDesktopTool(run, name, args);
            if (result?.image) {
                call.image = result.image;
                call.redacted = result.image.secrets ?? [];
                return result.content;
            }
            if (this.privacyEnabled && result && typeof result === 'object') {
                const redacted = redactDeep(result);
                call.redacted = redacted.findings.map(finding => finding.label);
                result = redacted.value;
            }
            return result;
        } catch (error) {
            call.error = error.message;
            throw error;
        } finally {
            if (entry && this._sharedItems.includes(entry)) {
                entry.toolCalls.push(call);
                if (this._activeTab === 'shared')
                    this._refreshSharedView();
            }
        }
    }

    async _runDesktopTool(run, name, args) {
        const context = this._sharedDesktopContext;
        if (!context)
            throw new Error('The user has not shared a desktop context in this conversation. Ask them to press the desktop context shortcut.');
        const part = {desktop_get_windows: 'windows', desktop_get_selection: 'selection', desktop_get_projects: 'projects',
            desktop_get_recent_events: 'events', desktop_capture_window: 'screenshots',
            desktop_get_app_logs: 'appLogs', desktop_get_device_status: 'deviceStatus',
            desktop_get_window_process: 'appProcess'}[name];
        if (!context.parts[part]) {
            if (context.localSkipped?.length && ['appLogs', 'deviceStatus'].includes(part))
                throw new Error('You run on the user\'s computer: read this yourself with your tools, as the desktop context instructions describe.');
            throw new Error('The user did not include this part in the desktop context.');
        }
        if (name === 'desktop_get_window_process')
            return desktopContextProcess(context, args.window_id);
        if (name === 'desktop_get_device_status')
            return deviceStatus();
        if (name === 'desktop_get_app_logs') {
            const process = context.processes?.get(String(args.window_id ?? ''));
            if (!process)
                throw new Error('Use a window_id from the shared desktop context.');
            return appLogs(process, args);
        }
        if (name !== 'desktop_capture_window')
            return desktopContextDetail(context, part);
        const id = String(args.window_id ?? '');
        const known = context.focusedWindow?.id === id || (context.windows ?? []).some(window => window.id === id);
        if (!known)
            throw new Error('Use a window_id from the shared desktop context.');
        const {image, window, secrets} = await captureWindow(id, {privacy: this._privacy()});
        // Show the user that the agent looked at a window again.
        run.statusLabel?.set_text(`Looking at ${window.title || 'a window'}…`);
        return {image: {bytes: image.bytes, title: window.title, secrets}, content: {mcpContent: [
            {type: 'image', mimeType: imageMime(image.bytes) ?? 'image/png', data: GLib.base64_encode(image.bytes)},
            {type: 'text', text: JSON.stringify({window, pixels: [image.width, image.height], captured_at: new Date().toISOString(),
                ...(secrets.length ? {blacked_out: secrets.map(label => `text: ${label}`)} : {})})},
        ]}};
    }

    _recordShared(item) {
        this._sharedItems.push(item);
        this._syncSharedButton();
        if (this._activeTab === 'shared')
            this._refreshSharedView();
    }

    _syncSharedButton() {
        if (!this._sharedButton)
            return;
        this._sharedButton.visible = this._sharedItems.length > 0;
        if (!this._sharedItems.length && this._activeTab === 'shared')
            this._setActiveTab('chat');
    }

    _refreshSharedView() {
        if (this._destroyed || !this._sharedBox)
            return;
        this._clearChildren(this._sharedBox);
        this._sharedBox.add_child(this._createTextLabel('ai-history-summary',
            'What this conversation sent to the agent. Kept for this conversation only.'));
        // Newest first, like History.
        for (const item of [...this._sharedItems].reverse())
            this._sharedBox.add_child(item.kind === 'desktop' ? this._sharedDesktopCard(item)
                : item.kind === 'reference' ? this._sharedReferenceCard(item) : this._sharedFileCard(item));
    }

    _sharedCardFrame(icon, title, item) {
        const card = new St.BoxLayout({style_class: 'message ai-shared-card', ...VERTICAL_LAYOUT, x_expand: true});
        const header = new St.BoxLayout({style_class: 'ai-shared-header', x_expand: true});
        header.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(new St.Label({text: title, style_class: 'ai-history-title', y_align: Clutter.ActorAlign.CENTER}));
        card.add_child(header);
        const time = item.time.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const prompt = [...(item.prompt ?? '')].length > 80 ? [...item.prompt].slice(0, 80).join('') + '…' : item.prompt;
        card.add_child(this._createTextLabel('ai-history-meta', prompt ? `${time} · sent with “${prompt}”` : time));
        return card;
    }

    _sharedDesktopCard(item) {
        const windowScope = item.view.scope === 'window';
        const card = this._sharedCardFrame(windowScope ? 'focus-windows-symbolic' : 'video-display-symbolic',
            windowScope ? `Window: ${item.view.focusedWindow?.title || item.view.focusedWindow?.app || 'untitled'}` : 'Desktop context', item);
        const {included, leftOut} = desktopContextParts(item.view);
        card.add_child(this._createTextLabel('ai-shared-text', `Included: ${included.join(', ') || 'monitor layout only'}.`));
        if (leftOut.length)
            card.add_child(this._createTextLabel('ai-history-meta',
                `Left out because the agent runs on this computer and can read it itself: ${leftOut.join(', ')}.`));
        if (item.onRequest)
            card.add_child(this._createTextLabel('ai-history-meta',
                'Details were sent as summaries; the agent can fetch more with tools, listed below.'));
        for (const line of this._privacyLines(item.redacted, item.privacy))
            card.add_child(this._createTextLabel('ai-history-meta ai-privacy-note', line));

        const shots = item.view.monitors.filter(monitor => monitor.image);
        if (shots.length) {
            const row = new St.BoxLayout({style_class: 'ai-shared-thumbs', x_expand: true});
            for (const monitor of shots)
                row.add_child(this._sharedThumbnail(monitor.image.bytes, monitor.name, windowScope ? 'Window' :
                    `Monitor ${monitor.index}${monitor.primary ? ' (primary)' : ''}`));
            card.add_child(row);
        }

        // The written context, exactly as the agent received it.
        let pretty = item.snapshot;
        try {
            pretty = JSON.stringify(JSON.parse(item.snapshot.replace(/^[^{]*/, '')), null, 2);
        } catch {
            // Show the raw text.
        }
        const json = this._createTextLabel('ai-shared-json', pretty, {selectable: true});
        json.visible = false;
        const actions = new St.BoxLayout({style_class: 'ai-shared-actions'});
        const toggle = new St.Button({style_class: 'button', label: 'Show written context', can_focus: true});
        toggle.connect('clicked', () => {
            json.visible = !json.visible;
            toggle.label = json.visible ? 'Hide written context' : 'Show written context';
        });
        const copy = new St.Button({style_class: 'button', label: 'Copy', can_focus: true});
        copy.connect('clicked', () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, pretty));
        actions.add_child(toggle);
        actions.add_child(copy);
        card.add_child(actions);
        card.add_child(json);

        if (item.toolCalls.length) {
            card.add_child(new St.Label({text: 'Requested by the agent', style_class: 'ai-history-title ai-shared-subtitle'}));
            for (const call of item.toolCalls) {
                const time = call.time.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
                const args = Object.keys(call.args ?? {}).length ? ' ' + JSON.stringify(call.args) : '';
                card.add_child(this._createTextLabel(call.error ? 'ai-history-meta ai-shared-error' : 'ai-history-meta',
                    `${time} · ${call.name}${args}${call.error ? ` — refused: ${call.error}` : ''}`));
                for (const line of this._privacyLines(call.redacted))
                    card.add_child(this._createTextLabel('ai-history-meta ai-privacy-note', line));
                if (call.image)
                    card.add_child(this._sharedThumbnail(call.image.bytes, 'window.png', call.image.title || 'Window'));
            }
        }
        return card;
    }

    _sharedReferenceCard(item) {
        const card = this._sharedCardFrame(item.folder ? 'folder-symbolic' : 'text-x-generic-symbolic',
            GLib.path_get_basename(item.name) || item.name, item);
        card.add_child(this._createTextLabel('ai-history-meta',
            `${item.folder ? 'Folder' : 'File'} referenced by path, not uploaded: ${item.name}`));
        return card;
    }

    // "Redacted: GitHub token (2), password" and what screenshots hid.
    _privacyLines(redacted = [], privacy = null) {
        const count = labels => {
            const totals = new Map();
            for (const label of labels)
                totals.set(label, (totals.get(label) ?? 0) + 1);
            return [...totals].map(([label, n]) => n > 1 ? `${label} (${n})` : label).join(', ');
        };
        const lines = [];
        if (redacted.length)
            lines.push(`Redacted before sending: ${count(redacted)}`);
        if (privacy?.hidden?.length)
            lines.push(`Blacked out in screenshots: ${privacy.hidden.join(', ')}`);
        if (privacy?.secrets?.length)
            lines.push(`Blacked out text in screenshots: ${count(privacy.secrets)}`);
        if (privacy?.ocr === 'unavailable')
            lines.push('Screenshots were not checked for secret text (install Tesseract to enable it).');
        if (privacy?.ocr === 'failed')
            lines.push('Checking screenshots for secret text failed; private windows were still blacked out.');
        return lines;
    }

    _sharedFileCard(item) {
        const card = this._sharedCardFrame(item.folder ? 'folder-symbolic' : 'mail-attachment-symbolic', item.name, item);
        const how = item.delivery === 'stream' ? 'offered for download, not embedded' : 'embedded in the message';
        const size = item.folder ? `${item.files.toLocaleString()} files · ${GLib.format_size(item.contentSize)}`
            : GLib.format_size(item.size);
        card.add_child(this._createTextLabel('ai-history-meta', `${size} · ${how}`));
        for (const line of this._privacyLines(item.redacted, item.privacy))
            card.add_child(this._createTextLabel('ai-history-meta ai-privacy-note', line));
        if (item.excluded?.length)
            card.add_child(this._createTextLabel('ai-history-meta ai-privacy-note',
                `Left out as sensitive: ${item.excluded.map(entry => entry.path).join(', ')}`));
        for (const download of item.downloads ?? []) {
            const time = download.time.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
            card.add_child(this._createTextLabel(download.ok ? 'ai-history-meta' : 'ai-history-meta ai-shared-error',
                download.ok ? `${time} · downloaded by the agent` : `${time} · download failed: ${download.error}`));
        }
        if (item.delivery === 'stream' && !item.downloads?.length)
            card.add_child(this._createTextLabel('ai-history-meta', 'Not downloaded by the agent yet.'));
        if (item.bytes && imageMime(item.bytes))
            card.add_child(this._sharedThumbnail(item.bytes, item.name, item.name));
        return card;
    }

    // An attachment offered for download in this conversation.
    _download(run, id) {
        const entry = this._downloads.get(id);
        if (!entry)
            throw Object.assign(new Error('Unknown attachment id. Use an id from an "Attached file for download" line.'),
                {status: 404});
        return entry;
    }

    _openDownload(run, id) {
        const entry = this._download(run, id);
        return {...downloadTarget(entry), finished: (ok, error) => {
            entry.shared.downloads.push({time: new Date(), ok, error: error?.message ?? null});
            if (this._activeTab === 'shared')
                this._refreshSharedView();
        }};
    }

    _sharedThumbnail(bytes, name, caption) {
        const box = new St.BoxLayout({style_class: 'ai-shared-thumb', ...VERTICAL_LAYOUT});
        const button = new St.Button({style_class: 'button flat ai-shared-thumb-button', can_focus: true,
            accessible_name: `Open ${caption}`});
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_at_scale(
                Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes)), 320, 200, true, null);
            button.set_child(previewImage(pixbuf, pixbuf.get_width(), pixbuf.get_height()));
        } catch {
            button.set_child(new St.Icon({icon_name: 'image-x-generic-symbolic', icon_size: 48}));
        }
        button.connect('clicked', () => this._openSharedImage(bytes, name));
        box.add_child(button);
        box.add_child(new St.Label({text: caption, style_class: 'ai-history-meta'}));
        return box;
    }

    // Opens a full-size copy in the default image viewer. The copy lives in
    // the private runtime directory, which is cleared at logout.
    _openSharedImage(bytes, name) {
        try {
            const directory = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnome-assistant']);
            GLib.mkdir_with_parents(directory, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([directory, GLib.path_get_basename(name)]));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
            this.emit('external-opened');
        } catch (error) {
            Main.notifyError(this.assistantName, `Could not open the image: ${error.message}`);
        }
    }

    _activeProfileTurn(client) {
        const run = this._run;
        if (this._destroyed || !run || run.cancelled || run.acp !== client || run.streamedText === undefined)
            throw new Error('There is no active turn for this connection.');
        return run;
    }

    _receiveAttachment(run, name, bytes) {
        if ((run.message.attachments?.length ?? 0) + (run.attachmentUploads?.size ?? 0) >= MAX_ATTACHMENTS_PER_TURN)
            throw new Error('This reply already has 12 attachments.');
        if (!this._isPersistentMemoryEnabled())
            this._temporaryAttachments ??= GLib.dir_make_tmp('gnome-assistant-attachments-XXXXXX');
        const temporary = this._isPersistentMemoryEnabled() ? null : this._temporaryAttachments;
        const record = saveAttachment(name, bytes, temporary);
        return this._appendAttachmentRecord(run, record, temporary);
    }

    _appendAttachmentRecord(run, record, temporary) {
        run.message.attachments ??= [];
        run.message.attachments.push({...record, temporary});
        this._addAttachmentCard(run.message.extras, record, temporary);
        this._scrollToBottom();
        return {filename: record.name, size: record.size, displayed: true};
    }

    async _beginAttachmentUpload(run, name, size, cancel) {
        if ((run.message.attachments?.length ?? 0) + (run.attachmentUploads?.size ?? 0) >= MAX_ATTACHMENTS_PER_TURN)
            throw new Error('This reply already has 12 attachments or transfers.');
        const persistent = this._isPersistentMemoryEnabled();
        if (!persistent)
            this._temporaryAttachments ??= GLib.dir_make_tmp('gnome-assistant-attachments-XXXXXX');
        const temporary = persistent ? null : this._temporaryAttachments;
        const ticket = {};
        run.attachmentUploads ??= new Set();
        run.attachmentUploads.add(ticket);
        const row = new St.BoxLayout({...VERTICAL_LAYOUT, style_class: 'message ai-upload-transfer',
            reactive: true, x_expand: true});
        const status = this._createTextLabel('ai-message-text', `Receiving ${name} · 0 / ${GLib.format_size(size)}`);
        row.add_child(status);
        const stop = new St.Button({label: 'Cancel transfer', accessible_name: 'Cancel transfer '+name,
            style_class: 'button', can_focus: true, x_align: Clutter.ActorAlign.START});
        row.add_child(stop);
        stop.connect('clicked', () => cancel.cancel());
        run.message.extras.show();
        run.message.extras.add_child(row);
        this._scrollToBottom();
        let settled = false;
        let rowDisposed = false;
        row.connect('destroy', () => {rowDisposed = true; if (!settled) cancel.cancel();});
        const cancelSignal = run.localCancel.connect(() => cancel.cancel());
        if (run.localCancel.is_cancelled()) cancel.cancel();
        const cleanup = () => {
            if (settled) return;
            settled = true;
            run.attachmentUploads.delete(ticket);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                run.localCancel.disconnect(cancelSignal);
                return GLib.SOURCE_REMOVE;
            });
            if (!rowDisposed) row.destroy();
        };
        const current = () => {
            if (this._destroyed || run !== this._run || run.cancelled || run.message.disposed)
                throw new Error('The file transfer no longer belongs to an active response.');
        };
        let sink;
        try {sink = await AttachmentUpload.create(name, size, temporary, cancel);}
        catch (error) {cleanup(); throw error;}
        let lastProgress = 0;
        return {
            write: async chunk => {
                current();
                await sink.write(chunk);
                const now = GLib.get_monotonic_time();
                if (!settled && now - lastProgress >= 100000) {
                    lastProgress = now;
                    status.text = `Receiving ${name} · ${GLib.format_size(sink.received)} / ${GLib.format_size(size)}`;
                }
            },
            finish: async () => {
                try {
                    const record = await sink.finish();
                    current();
                    if (this._isPersistentMemoryEnabled() !== persistent)
                        throw new Error('Attachment storage settings changed. Please retry this transfer.');
                    run.attachmentUploads.delete(ticket);
                    const result = this._appendAttachmentRecord(run, record, temporary);
                    sink.keep();
                    cleanup();
                    return result;
                } catch (error) {
                    await sink.abort();
                    cleanup();
                    throw error;
                }
            },
            abort: async () => {try {await sink.abort();} finally {cleanup();}},
        };
    }

    _receiveToolImage(run, url, caption) {
        const uri = typeof url === 'string' && GLib.Uri.parse(url, GLib.UriFlags.NONE);
        if (!uri || uri.get_scheme() !== 'https' || !uri.get_host() || uri.get_userinfo() ||
            ![-1, 443].includes(uri.get_port()) || url.length > 2048)
            throw new Error('Use a public HTTPS image URL.');
        run.toolImages ??= [];
        if (run.toolImages.length >= MAX_INLINE_IMAGES)
            throw new Error('This reply already has the maximum number of images.');
        const title = typeof caption === 'string' ? caption.slice(0, 160) : 'Image';
        run.toolImages.push({title, url});
        run.message.extras.add_child(this._createInlineImage({title, url}, ''));
        return 'Image added to the chat.';
    }

    _createA2uiStore() {
        return new A2uiStore({
            schedule:(milliseconds,callback)=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,milliseconds,()=>{callback();return GLib.SOURCE_REMOVE;}),
            cancel:source=>GLib.source_remove(source),
            ready:()=>this._scheduleAgentFunctions(),
            changed:id=>this._a2uiViews?.get(id)?.view.queueRefresh(),
        });
    }

    _scheduleAgentFunctions() {
        if (this._destroyed || this._agentFunctionSource || this._run) return;
        this._agentFunctionSource = GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{
            this._agentFunctionSource = null;
            if (this._destroyed || this._run) return GLib.SOURCE_REMOVE;
            const store=this._a2uiStore;
            const requests=store.remote.take();
            if (!requests.length) return GLib.SOURCE_REMOVE;
            const ids=requests.map(request=>request.callAgentFunction.functionCallId);
            try {
                this._assertA2uiContext(this._a2uiContext);
                this.generateResponse('',{a2uiFunctions:requests}).catch(error=>store.remote.fail(ids,'TRANSPORT_ERROR',error.message));
            } catch (error) {store.remote.fail(ids,'CANCELLED',error.message);}
            return GLib.SOURCE_REMOVE;
        });
    }

    _resetA2ui() {
        this._flushA2uiState();
        this._a2uiStore?.remote.clear();
        for (const {view} of this._a2uiViews?.values() ?? []) {
            view._interactive = false;
            view.refresh();
        }
        this._a2uiStore = this._createA2uiStore();
        this._a2uiViews = new Map();
        this._a2uiContext = null;
    }

    _setA2uiBusy(busy) {
        for (const {view} of this._a2uiViews.values()) view.setBusy(busy);
    }

    _mountA2ui(store, id, message, interactive) {
        const context = this._a2uiContext;
        const view = new A2uiView(store, id, {
            text: (style, value) => this._createTextLabel(style, value),
            image: image => this._createInlineImage(image, message.remote ? '' : message.renderCwd ?? this._threadCwd,
                message.remote ? null : message.requestedImage),
            changed: () => this._scrollToBottom(),
            interactive,
            cwd:message.remote?'':message.renderCwd ?? this._threadCwd,
            open:url=>{
                const uri=GLib.Uri.parse(url,GLib.UriFlags.NONE);
                if(/^https?:/i.test(url) && !uri.get_host())throw new Error('The URL needs a hostname.');
                if(!this._openUri(url,{allowHandler:true}))throw new Error('No application could open this URL.');
            },
            action: event => this._dispatchA2uiAction(event, context),
            beforeAction: () => this._assertA2uiContext(context, true),
            edited: () => this._queueA2uiState(context),
        });
        message.extras.show();
        message.extras.add_child(view.actor);
        view.setBusy(Boolean(this._run && !this._run.silentFunctions));
        return view;
    }

    _queueA2uiState(context) {
        if (!this._isPersistentMemoryEnabled()) return;
        try {this._assertA2uiContext(context, true);} catch {return;}
        this._pendingA2uiState = {type:'a2ui_state', a2ui:this._a2uiStore.snapshot(), ts:Date.now(),
            sessionId:this._threadId, connection:this._threadConnection};
        if (this._a2uiSaveSource) GLib.source_remove(this._a2uiSaveSource);
        this._a2uiSaveSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT,500,()=>{
            this._a2uiSaveSource = null;
            this._flushA2uiState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushA2uiState() {
        if (this._a2uiSaveSource) GLib.source_remove(this._a2uiSaveSource);
        this._a2uiSaveSource = null;
        const entry = this._pendingA2uiState;
        this._pendingA2uiState = null;
        if (entry && this._isPersistentMemoryEnabled()) this._appendMemoryEntry(entry);
    }

    _receiveA2ui(run, messages, viaTool = false) {
        const result = this._a2uiStore.process(messages, changed => {
            for (const id of changed) {
                const existing = this._a2uiViews.get(id);
                if (!this._a2uiStore.surfaces.has(id)) {
                    existing?.view.actor.destroy();
                    this._a2uiViews.delete(id);
                } else if (!existing || existing.view.disposed || existing.message.disposed) {
                    const view = this._mountA2ui(this._a2uiStore, id, run.message, true);
                    this._a2uiViews.set(id, {view, message: run.message});
                } else {
                    existing.view.queueRender();
                }
            }
        });
        run.a2uiReceived = true;
        if (!viaTool) {
            run.a2uiReplies ??= [];
            if (run.a2uiReplies.length + result.responses.length > 64)
                throw new Error('Too many interface function requests in one response.');
            run.a2uiReplies.push(...result.responses);
        }
        return result;
    }

    _assertA2uiContext(context, local = false) {
        if (this._destroyed || this._run?.cancelled || (this._run && !(local && this._run.silentFunctions)) || context !== this._a2uiContext)
            throw new Error('This interface is unavailable for the current chat.');
        const profile = activeProfile(this._settings);
        const localCwd = this._getSettingString('workspace-folder', '');
        const cwd = profile?.transport === 'ssh' ? profile.remoteCwd : localCwd;
        if (!profile || connectionKey(profile, cwd) !== this._threadConnection || localCwd !== this._threadLocalCwd)
            throw new Error('Select the original ACP connection and workspace to use this interface.');
    }

    async _dispatchA2uiAction(event, context) {
        const current = this._run;
        if (current?.silentFunctions) {
            await current.finished;
            if (current.cancelled) throw new Error('The interface request was stopped.');
        }
        this._assertA2uiContext(context);
        const label = event.action.userMessage || event.action.name;
        this.addMessage('You', label);
        await this.generateResponse(label, {a2uiEvent: event});
    }

    _readA2uiSnapshot(value) {
        if (!Array.isArray(value)) return undefined;
        try {
            const store = new A2uiStore();
            if (value.length) store.apply(value, {restore:true});
            return store.snapshot();
        } catch {
            return undefined;
        }
    }

    _showA2uiSnapshot(snapshot, message, interactive = false) {
        if (!snapshot?.length) return;
        const store = interactive ? this._a2uiStore : new A2uiStore();
        store.apply(snapshot, {restore:true});
        for (const id of store.surfaces.keys()) {
            const view = this._mountA2ui(store, id, message, interactive);
            if (interactive) this._a2uiViews.set(id, {view, message});
        }
    }

    async _onProfileRequest(client, method, params) {
        if (!['fs/read_text_file', 'fs/write_text_file'].includes(method))
            return undefined;
        const run = this._activeProfileTurn(client);
        if (params.sessionId !== this._threadId)
            throw new Error('This request is for a different chat.');
        if (method === 'fs/write_text_file') {
            await this._profileLocalTool(run, 'write_local_file', {path: params.path, text: params.content});
            return {};
        }
        const {text} = await this._profileLocalTool(run, 'read_local_file', {path: params.path});
        const lines = text.split('\n');
        const start = Number.isInteger(params.line) ? Math.max(params.line - 1, 0) : 0;
        const limit = Number.isInteger(params.limit) ? Math.max(params.limit, 0) : lines.length;
        return {content: lines.slice(start, start + limit).join('\n')};
    }

    async _profileLocalTool(run, method, args) {
        const root = run.localRoot;
        if (!root)
            throw new Error('Use Share a local folder before requesting local access.');
        const path = relativeLocalPath(root, method === 'run_local_command' ? args.cwd ?? '' : args.path ?? '');
        const cancel = run.localCancel;
        if (method === 'list_local_files')
            return workspaceOperation(root, 'list', path, {}, cancel);
        if (method === 'read_local_file')
            return workspaceOperation(root, 'read', path, {}, cancel);
        if (method === 'write_local_file') {
            if (typeof args.text !== 'string' || args.text.length > MAX_DISPLAY_CHARS)
                throw new Error('The proposed edit is too large to review in chat.');
            const previous = await workspaceOperation(root, 'preview', path, {}, cancel);
            const preview = `${root}/${path}\n\nBefore\n${previous.text ?? '(new file)'}\n\nAfter\n${args.text}`;
            if (preview.length > MAX_DISPLAY_CHARS)
                throw new Error('The full edit is too large to review in chat.');
            await this._askLocalApproval(run, {title: 'Apply this edit on this PC?', preview});
            return workspaceOperation(root, 'write', path, {text: args.text, revision: previous.revision}, cancel);
        }
        if (method === 'run_local_command' && run.localCommands) {
            const {command, args: argv = []} = args;
            if (typeof command !== 'string' || !command || !Array.isArray(argv) || argv.length > 100 ||
                [command, ...argv].some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))
                throw new Error('Use a command and a list of arguments.');
            const display = [command, ...argv].map(GLib.shell_quote).join(' ');
            if (display.length > MAX_DISPLAY_CHARS)
                throw new Error('The full command is too large to review in chat.');
            await this._askLocalApproval(run, {title: 'Run this command on this PC?',
                command: {command: display, cwd: root + (path ? '/' + path : '')}});
            return runLocalCommand(root, command, argv, path, cancel);
        }
        throw new Error('This local action is unavailable.');
    }

    async _askLocalApproval(run, options) {
        this._activeProfileTurn(run.acp);
        const id = GLib.uuid_string_random();
        const approved = await new Promise(resolve => {
            const decide = accepted => {
                run.pendingApprovals.delete(decide);
                resolve(accepted);
            };
            run.pendingApprovals.add(decide);
            this._showApproval(id, {...options, canAccept: true, decide});
        });
        if (!approved || run.cancelled || this._destroyed)
            throw new Error('The local action was declined.');
    }

    _syncAcpOptions(options) {
        this._acpOptionsMenu?.close();
        this._acpConfigOptions = Array.isArray(options) ? options : [];
        this._publishAcpConfigState();
    }

    _publishAcpConfigState() {
        if (!this._settings)
            return;
        const profile = activeProfile(this._settings);
        const localCwd = this._getSettingString('workspace-folder', '');
        const current = this._threadConnection === connectionKey(profile ?? {},
            profile?.transport === 'ssh' ? profile.remoteCwd : localCwd) && this._threadLocalCwd === localCwd;
        const ready = Boolean(!this._destroyed && current && this._client && !this._client.closed &&
            this._threadId && this._loadedThreadId === this._threadId && !this._preparation?.pending);
        const state = JSON.stringify({key: configContext(profile, localCwd), ready,
            busy: Boolean(this._run || this._configApplyPromise), applying: Boolean(this._configApplyPromise),
            options: ready ? this._acpConfigOptions ?? [] : [], error: current ? this._configError ?? '' : ''});
        if (getString(this._settings, 'acp-config-state') !== state)
            this._settings.set_string('acp-config-state', state);
    }

    async _applySavedAcpConfig() {
        // Serialize requests with each other and finish them before prompting.
        while (this._configApplyPromise)
            await this._configApplyPromise;
        const client = this._client;
        const sessionId = this._threadId;
        const profile = activeProfile(this._settings);
        const localCwd = this._getSettingString('workspace-folder', '');
        const context = configContext(profile, localCwd);
        const current = () => !this._destroyed && client === this._client && !client?.closed &&
            sessionId === this._threadId && context === configContext(activeProfile(this._settings),
                this._getSettingString('workspace-folder', ''));
        if (!client || !sessionId || !profile || !current() ||
            this._threadConnection !== connectionKey(profile, profile.transport === 'ssh' ? profile.remoteCwd : localCwd) ||
            (this._run && this._run.streamedText !== undefined))
            return;
        const attempted = new Set();
        const apply = async () => {
            while (current()) {
                const values = savedConfigValues(this._settings, profile.id);
                const option = nextConfigChange(this._acpConfigOptions ?? [], values, attempted);
                if (!option)
                    break;
                const value = values[option.id];
                attempted.add(JSON.stringify([option.id, value]));
                try {
                    const result = await client.request('session/set_config_option', {sessionId, configId: option.id, value});
                    if (!current())
                        return;
                    if (!Array.isArray(result.configOptions))
                        throw new Error('The agent did not return updated configuration options.');
                    this._syncAcpOptions(result.configOptions);
                    if (result.configOptions.find(item => item.id === option.id)?.currentValue !== value)
                        throw new Error(`The agent did not accept the selection for ${option.name ?? option.id}.`);
                } catch (error) {
                    // Keep the last confirmed choice instead of retrying a rejected
                    // setting on every turn. A newer user selection takes precedence.
                    if (current() && savedConfigValues(this._settings, profile.id)[option.id] === value)
                        saveConfigValue(this._settings, profile.id, option.id,
                            this._acpConfigOptions.find(item => item.id === option.id)?.currentValue ?? option.currentValue);
                    throw error;
                }
            }
        };
        this._configError = null;
        const pending = apply().catch(error => {
            if (current())
                this._configError = error.message;
        });
        this._configApplyPromise = pending;
        this._publishAcpConfigState();
        this._syncProfileButtons();
        await pending;
        if (this._configApplyPromise === pending)
            this._configApplyPromise = null;
        if (!this._destroyed) {
            this._publishAcpConfigState();
            this._syncProfileButtons();
        }
    }

    _showAcpOptions() {
        if (this._acpOptionsMenu) {
            this._acpOptionsMenu.close();
            return;
        }
        // Agent options can change only between replies; Preferences always opens.
        const configurable = !this._run && !this._configApplyPromise && this._client && !this._client.closed;
        const client = this._client;
        const sessionId = this._threadId;
        const profileId = activeProfile(this._settings)?.id;
        const menu = new PopupMenu.PopupMenu(this._agentOptionsButton, 0.5, St.Side.TOP);
        this._acpOptionsMenu = menu;
        menu.actor.add_style_class_name('ai-config-menu');
        Main.uiGroup.add_child(menu.actor);
        const manager = new PopupMenu.PopupMenuManager(this._agentOptionsButton);
        manager.addMenu(menu);
        for (const option of configurable ? this._acpConfigOptions : []) {
            if (option.type !== 'select')
                continue;
            const choices = selectChoices(option);
            const section = new PopupMenu.PopupSubMenuMenuItem(option.name ?? option.id);
            menu.addMenuItem(section);
            const current = choices.find(choice => choice.value === option.currentValue);
            if (current) {
                const summary = new St.Label({text: current.name ?? current.value,
                    style_class: 'ai-config-current', y_align: Clutter.ActorAlign.CENTER});
                summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                section.insert_child_below(summary, section.get_last_child());
            }
            if (option.description) {
                const description = new PopupMenu.PopupMenuItem(option.description,
                    {reactive: false, can_focus: false});
                description.label.clutter_text.line_wrap = true;
                description.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                section.menu.addMenuItem(description);
            }
            let previousGroup;
            for (const choice of choices) {
                if (choice.groupName && choice.groupName !== previousGroup)
                    section.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(choice.groupName));
                previousGroup = choice.groupName;
                const selected = choice.value === option.currentValue;
                const item = new PopupMenu.PopupMenuItem(choice.name ?? choice.value,
                    {style_class: 'ai-config-choice'});
                item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
                item.setOrnament(selected ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE);
                const subtitle = [choice.groupName, choice.description].filter(Boolean).join(' · ');
                if (subtitle)
                    item.get_accessible().set_description(subtitle);
                section.menu.addMenuItem(item);
                item.connect('activate', async () => {
                    if (this._run || this._client !== client || this._threadId !== sessionId ||
                        activeProfile(this._settings)?.id !== profileId || selected)
                        return;
                    try {
                        saveConfigValue(this._settings, profileId, option.id, choice.value);
                        if (this._configApplyPromise)
                            await this._configApplyPromise;
                        else
                            await this._applySavedAcpConfig();
                        if (this._configError)
                            throw new Error(this._configError);
                    } catch (error) {
                        Main.notifyError(this.assistantName, error.message);
                    }
                });
            }
        }
        // Last: a button to the extension's Preferences.
        if (!menu.isEmpty())
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'ai-config-footer'});
        const preferences = new St.Button({style_class: 'button ai-config-preferences', can_focus: true, x_expand: true,
            accessible_name: 'Preferences'});
        const content = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
        content.add_child(new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 16}));
        content.add_child(new St.Label({text: 'Preferences', y_align: Clutter.ActorAlign.CENTER}));
        preferences.set_child(content);
        preferences.connect('clicked', () => {
            menu.close();
            this.emit('preferences-requested');
        });
        footer.add_child(preferences);
        menu.addMenuItem(footer);
        let destroyIdle = null;
        menu.connect('destroy', () => {
            if (destroyIdle)
                GLib.source_remove(destroyIdle);
            if (this._acpOptionsMenu === menu)
                this._acpOptionsMenu = null;
        });
        menu.connect('open-state-changed', (_menu, open) => {
            if (!open && !destroyIdle)
                destroyIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    destroyIdle = null;
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    async _runAcpPrompt(run, text, persist, originalPrompt, name, instructions, resources) {
        run.streamedText = '';
        run.rawText = '';
        run.a2uiBlocks = new Set();
        run.a2uiErrors = [];
        run.a2uiReplies = [];
        let stopReason;
        // ACP permits one prompt at a time. Streamed RPC results are delivered
        // in a bounded continuation after the current prompt has finished.
        for (let round = 0; round <= 4; round++) {
            if (this._destroyed || run.cancelled) break;
            run.statusLabel.set_text(round ? 'Updating interface…' : 'Working…');
            let watch = (round || run.silentFunctions) ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, 45000, () => {
                watch = null;
                run.functionTimedOut = true;
                this._stopRun();
                return GLib.SOURCE_REMOVE;
            }) : null;
            try {
                const metadata=this._a2uiStore.metadata();
                metadata.transport=a2uiTransportPolicy(Boolean(run.acp.agentCapabilities.mcpCapabilities?.http)).metadata;
                if (run.functionRequests) metadata.agentFunctionModes=Object.fromEntries(run.functionRequests.map(request=>[
                    request.callAgentFunction.functionCallId,run.agentStore.remote.byId.get(request.callAgentFunction.functionCallId)?.imperative?'action':'reactive']));
                ({stopReason} = await run.acp.prompt(this._threadId, text, instructions, resources, metadata));
            } finally {
                if (watch) GLib.source_remove(watch);
            }
            if (this._destroyed || run.cancelled || stopReason === 'cancelled' || !run.a2uiReplies.length) break;
            if (round === 4) {
                run.streamedText += '\nThe agent requested too many interface function rounds. Please try again.';
                break;
            }
            text = run.a2uiReplies.splice(0).map(reply => JSON.stringify(reply)).join('\n');
            resources = [];
            run.rawText += '\n\n';
        }
        if (this._destroyed)
            return;
        if (run.silentFunctions) {
            run.agentStore.remote.fail(run.functionRequests.map(request=>request.callAgentFunction.functionCallId),
                run.functionTimedOut?'TIMEOUT':run.cancelled || stopReason==='cancelled'?'CANCELLED':'MISSING_RESPONSE',
                run.functionTimedOut?'The agent timed out.':run.cancelled || stopReason==='cancelled'?'The interface request was stopped.':'The agent did not return a result for this function.');
            return;
        }
        if (run.functionTimedOut) {
            run.message.setPlainText('The agent timed out while processing the interface function result.');
            return;
        }
        if (splitA2uiBlocks(run.rawText).incomplete)
            run.streamedText += '\nThe agent sent an incomplete A2UI interface.';
        const content = run.streamedText;
        if (run.cancelled || stopReason === 'cancelled') {
            run.message.setPlainText(content ? `${content}\n\nStopped.` : 'Stopped.');
            return;
        }
        run.message.setText(content || (run.a2uiReceived || run.message.attachments?.length
            ? '' : `${name} finished without a text reply.`));
        if (persist && this._isPersistentMemoryEnabled()) {
            const rendered = [content, ...(run.toolImages ?? []).map(({title, url}) =>
                `![${title.replaceAll(']', '')}](<${url}>)`)].filter(Boolean).join('\n\n');
            this._rememberConversation(originalPrompt, rendered, run.message.attachments);
        }
    }

    _onAcpUpdate({sessionId, update}) {
        const run = this._run;
        if (this._destroyed || !update)
            return;
        if (update.sessionUpdate === 'config_option_update') {
            if (this._client instanceof ProfileClient && (!this._threadId || this._threadId === sessionId))
                this._syncAcpOptions(update.configOptions ?? []);
            return;
        }
        if (update.sessionUpdate === 'available_commands_update') {
            if (this._client instanceof ProfileClient && (!this._threadId || this._threadId === sessionId))
                this._nativeProfileCommands = update.availableCommands ?? [];
            return;
        }
        if (run?.streamedText === undefined || run.cancelled || sessionId !== this._threadId)
            return;
        // Thinking and plan updates also separate parts of the reply.
        if (['agent_thought_chunk', 'plan'].includes(update.sessionUpdate))
            run.paragraphBreak = true;
        if (update.sessionUpdate === 'agent_message_chunk' && this._client instanceof ProfileClient &&
            ['image', 'audio', 'resource'].includes(update.content?.type)) {
            try {
                this._receiveContentBlock(run, update.content);
            } catch (error) {
                Main.notifyError(this.assistantName, error.message);
            }
        } else if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            // Text before and after a tool call arrives as one stream: start a
            // new paragraph there, unless the agent already separated them.
            let chunk = update.content.text;
            if (run.paragraphBreak && run.rawText && !/\s$/.test(run.rawText) && !/^\s/.test(chunk))
                chunk = '\n\n' + chunk;
            run.paragraphBreak = false;
            run.rawText = (run.rawText + chunk).slice(0, A2UI_MAX_BYTES);
            const parsed = splitA2uiBlocks(run.rawText);
            for (const block of parsed.blocks) {
                if (run.a2uiBlocks.has(block.start)) continue;
                run.a2uiBlocks.add(block.start);
                try {
                    this._receiveA2ui(run, parseA2ui(block.body));
                } catch (error) {
                    run.a2uiErrors.push('Interface error · ' + error.message);
                }
            }
            run.streamedText = this._limitDisplayText([parsed.text, ...run.a2uiErrors].filter(Boolean).join('\n'));
            if (!run.silentFunctions) run.message.setPlainText(run.streamedText);
            run.statusLabel.set_text('Responding…');
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            run.paragraphBreak = true;
            if (update.status === 'completed' || update.status === 'failed')
                run.statusLabel.set_text('Working…');
            else if (update.title)
                run.statusLabel.set_text(update.title.slice(0, 100));
        }
    }

    _onAgentPermission(client, id, {sessionId, toolCall, options}, decide, remote = false) {
        const run = this._run;
        if (client !== this._client || !run?.acp || run.cancelled || this._destroyed ||
            sessionId !== this._threadId) {
            decide(null);
            return;
        }
        const decline = options?.find(option => option.kind === 'reject_once');
        const allow = options?.find(option => option.kind === 'allow_once');
        const changes = toolCall?.content?.filter(item => item.type === 'diff') ?? [];
        const valid = changes.filter(item => item.path && typeof item.newText === 'string');
        const hasPreview = toolCall?.kind === 'edit' && changes.length > 0 && valid.length === changes.length &&
            (toolCall.locations ?? []).every(location => changes.some(change => change.path === location.path));
        // Every change is reviewed as a diff; a change too large to compare
        // cannot be reviewed, so it cannot be allowed.
        const diffs = valid.map(({path, oldText, newText}) =>
            ({path: String(path), ...unifiedDiff(typeof oldText === 'string' ? oldText : null, newText)}));
        const details = diffs.map(diff => `${diff.path}\n${formatUnifiedDiff(diff)}`).join('\n\n');
        const rawCommand = client instanceof ProfileClient && toolCall?.kind === 'execute'
            ? toolCall.rawInput?.command : null;
        const command = typeof rawCommand === 'string' && rawCommand.length <= MAX_DISPLAY_CHARS
            ? {command: rawCommand, cwd: toolCall.rawInput?.cwd ?? this._threadCwd} : null;
        const extra = [...(toolCall?.content ?? []).filter(item => item.type !== 'diff').map(item => JSON.stringify(item)),
            toolCall?.rawInput === undefined ? '' : JSON.stringify(toolCall.rawInput, null, 2)].filter(Boolean).join('\n\n');
        const description = [toolCall?.title, details, extra].filter(Boolean).join('\n\n');
        const canAccept = Boolean(allow && description && description.length <= MAX_DISPLAY_CHARS &&
            !diffs.some(diff => diff.replaced));
        this._showApproval(id, {
            title: command ? (remote ? 'Run this command on the agent host?' : 'Run this command?')
                : hasPreview ? 'Apply these file changes?' : 'Allow this action?',
            command: canAccept ? command : null,
            preview: !canAccept ? 'The full action could not be displayed for review.'
                : diffs.length ? toolCall?.title ?? '' : description,
            changes: canAccept ? diffs : [],
            details: diffs.length ? extra : '',
            canAccept,
            decide: accepted => decide(accepted ? allow.optionId : decline?.optionId),
        });
    }

    _headerAction(icon, name, activate) {
        const button = new St.Button({
            style_class: 'icon-button flat', can_focus: true, track_hover: true,
            accessible_name: name,
        });
        button.set_child(new St.Icon({icon_name: icon, icon_size: 16}));
        button.connect('clicked', () => activate());
        return button;
    }

    _syncProfileButtons() {
        const profile = activeProfile(this._settings);
        this._attachButton.visible = Boolean(profile);
        this._attachButton.reactive = Boolean(profile && !this._run && !this._choosingFile);
        this._shareFolderButton.visible = profile?.transport === 'ssh';
        this._shareFolderButton.reactive = !this._run;
        this._agentOptionsButton.reactive = !this._run && !this._configApplyPromise;
        this._updateAttachmentButton();
    }

    _updateAttachmentButton() {
        const queued = this._queuedFiles.length + this._queuedReferences.length + (this._desktopContext ? 1 : 0);
        this._attachButton.accessible_name = queued ? `Attach (${queued} queued)` : 'Attach';
        const state = JSON.stringify({files: this.queuedAttachments, busy: Boolean(this._run)});
        if (state !== this._attachmentState) {
            this._attachmentState = state;
            this.emit('attachments-changed');
        }
    }

    get assistantName() {
        return assistantName(this._settings);
    }

    get privacyEnabled() {
        return this._getSettingBoolean('privacy-protection', true);
    }

    _privacy() {
        return this.privacyEnabled ? {apps: privateApps(this._settings)} : null;
    }

    get queuedAttachments() {
        const files = this._queuedFiles.map(file => ({id: file.id, name: file.name,
            size: file.size ?? file.bytes.length, image: file.image ?? Boolean(imageMime(file.bytes)),
            ...(file.folder ? {folder: true, detail: `${file.files.toLocaleString()} files · ${GLib.format_size(file.contentSize)}` +
                (file.excluded?.length ? ` · ${file.excluded.length} sensitive left out` : '')} : {})}));
        const home = GLib.get_home_dir();
        const references = this._queuedReferences.map(reference => ({id: reference.id,
            name: GLib.path_get_basename(reference.path) || reference.path, size: 0, image: false,
            reference: true, folder: reference.folder,
            detail: 'Reference · ' + (reference.path.startsWith(home + '/') ? '~' + reference.path.slice(home.length) : reference.path)}));
        const desktop = this._desktopContext;
        return [...(desktop ? [{id: desktop.id, name: desktop.scope === 'window' ? 'Window context' : 'Desktop context',
            size: desktopContextSize(desktop),
            image: desktopContextScreenshots(desktop).length > 0, context: true, windowContext: desktop.scope === 'window',
            detail: desktopContextLabel(desktop)}] : []),
        ...files, ...references];
    }

    // A picked screen area or window: an ordinary image attachment, kept in
    // memory only.
    addScreenCapture({name, bytes, privacy = null}) {
        if (this._run || this._destroyed)
            throw new Error('Wait for the current reply to finish, then try again.');
        if (this._queuedFiles.length + this._queuedReferences.length >= MAX_ATTACHMENTS_PER_TURN)
            throw new Error('Attach or reference up to 12 items per message.');
        this._queuedFiles.push({id: GLib.uuid_string_random(), name: attachmentName(name), size: bytes.length, image: true,
            bytes, privacy});
        this._updateAttachmentButton();
    }

    // Before the user's own message and files are sent: look for secrets and
    // ask. Resolves to {proceed, prompt}; with "Redact", secrets in the text
    // and in attached text files are replaced (files are sent from a redacted
    // copy), and files that exist to hold secrets are left out.
    async reviewOutgoing(prompt) {
        if (!this.privacyEnabled || this._run)
            return {proceed: true, prompt};
        const items = findSecrets(prompt).map(finding => ({source: 'Your message', label: finding.label,
            preview: maskedPreview(prompt, finding)}));
        const files = [];
        for (const file of this._queuedFiles) {
            if (file.folder || file.redacted)
                continue;
            const sensitive = sensitiveFile(file.path ?? file.name);
            let text = null, findings = [];
            if (!file.image && (file.size ?? file.bytes?.length ?? 0) <= MAX_ATTACHMENT_BYTES) {
                try {
                    const bytes = await readAttachedBytes(file);
                    if (isTextContent(bytes)) {
                        text = new TextDecoder().decode(bytes);
                        findings = findSecrets(text);
                    }
                } catch {
                    // Changed or unreadable: sending reports it.
                }
            }
            if (sensitive)
                items.push({source: file.name, label: `${sensitive} file`, preview: 'left out if you redact'});
            for (const finding of findings)
                items.push({source: file.name, label: finding.label, preview: maskedPreview(text, finding)});
            if (sensitive || findings.length)
                files.push({file, sensitive, text, findings});
        }
        if (!items.length || this._destroyed)
            return {proceed: true, prompt};
        const choice = await this._showPrivacyReview(items);
        if (choice === 'cancel' || this._destroyed)
            return {proceed: false, prompt};
        if (choice === 'send')
            return {proceed: true, prompt};
        for (const {file, sensitive, text, findings} of files) {
            if (sensitive) {
                this._queuedFiles.splice(this._queuedFiles.indexOf(file), 1);
            } else {
                file.bytes = new TextEncoder().encode(redactSecrets(text).text);
                file.size = file.bytes.length;
                file.redacted = findings.map(finding => finding.label);
            }
        }
        this._updateAttachmentButton();
        return {proceed: true, prompt: redactSecrets(prompt).text};
    }

    _showPrivacyReview(items) {
        this._privacyReview?.resolve('cancel');
        this._setActiveTab('chat');
        return new Promise(resolve => {
            const card = new St.BoxLayout({style_class: 'message ai-privacy-review', ...VERTICAL_LAYOUT, x_expand: true});
            const heading = new St.BoxLayout({style_class: 'ai-privacy-review-heading'});
            heading.add_child(new St.Icon({icon_name: 'security-medium-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
            heading.add_child(new St.Label({text: describeFindings(items).replace(/^./, c => c.toUpperCase()),
                style_class: 'ai-history-title', y_align: Clutter.ActorAlign.CENTER}));
            card.add_child(heading);
            for (const item of items.slice(0, 12))
                card.add_child(this._createTextLabel('ai-history-meta', `${item.source} · ${item.label} · ${item.preview}`));
            if (items.length > 12)
                card.add_child(this._createTextLabel('ai-history-meta', `…and ${items.length - 12} more`));
            card.add_child(this._createTextLabel('ai-privacy-review-help',
                'Redact replaces each secret with a label such as [redacted password], and leaves out files that ' +
                'exist to hold secrets. Send anyway sends exactly what you wrote.'));
            const actions = new St.BoxLayout({style_class: 'ai-privacy-review-actions'});
            const finish = choice => {
                if (this._privacyReview?.card !== card)
                    return;
                this._privacyReview = null;
                card.destroy();
                resolve(choice);
            };
            for (const [label, choice, style] of [['Redact and send', 'redact', 'button default'],
                ['Send anyway', 'send', 'button'], ['Cancel', 'cancel', 'button flat']]) {
                const button = new St.Button({label, style_class: style, can_focus: true});
                button.connect('clicked', () => finish(choice));
                actions.add_child(button);
                if (choice === 'redact')
                    this._privacyReviewDefault = button;
            }
            card.add_child(actions);
            this._privacyReview = {card, resolve: finish};
            this._contentBox.add_child(card);
            this._scrollToBottom?.();
            this._privacyReviewDefault?.grab_key_focus();
        });
    }

    // Replaces any earlier snapshot: only the latest desktop state is useful.
    setDesktopContext(context) {
        this._desktopContext = context;
        this._updateAttachmentButton();
    }

    removeQueuedAttachment(id) {
        if (this._run)
            return false;
        if (this._desktopContext?.id === id) {
            this._desktopContext = null;
            this._updateAttachmentButton();
            return true;
        }
        const reference = this._queuedReferences.findIndex(item => item.id === id);
        if (reference >= 0) {
            this._queuedReferences.splice(reference, 1);
            this._updateAttachmentButton();
            return true;
        }
        const index = this._queuedFiles.findIndex(file => file.id === id);
        if (index < 0)
            return false;
        this._queuedFiles.splice(index, 1);
        this._updateAttachmentButton();
        return true;
    }

    get attachmentButton() {
        return this._attachButton;
    }

    // The picker is its own window, hidden behind the overview: the
    // extension closes the overview while it is open and restores it after.
    async _choosePath(action, name = '') {
        this.emit('picker-opened');
        try {
            return await chooseFile(action, name);
        } finally {
            if (!this._destroyed)
                this.emit('picker-closed');
        }
    }

    _isLocalProfile() {
        const profile = activeProfile(this._settings);
        return Boolean(profile) && profile.transport !== 'ssh';
    }

    _showAttachMenu() {
        if (this._attachMenu) {
            this._attachMenu.close();
            return;
        }
        if (this._run || this._choosingFile)
            return;
        const menu = new PopupMenu.PopupMenu(this._attachButton, 0.5, St.Side.TOP);
        this._attachMenu = menu;
        menu.actor.add_style_class_name('ai-attach-menu');
        Main.uiGroup.add_child(menu.actor);
        const manager = new PopupMenu.PopupMenuManager(this._attachButton);
        manager.addMenu(menu);
        menu.addAction('Attach file…', () => this._queueLocalFile(), 'mail-attachment-symbolic');
        menu.addAction('Attach area…', () => this.emit('screen-capture-requested', 'area'), 'screenshot-ui-area-symbolic');
        // A picked window comes with its context, unless window context is off.
        menu.addAction(this._getSettingBoolean('window-context-enabled', true) ? 'Attach window context…' : 'Attach window…',
            () => this.emit('screen-capture-requested', 'window'), 'screenshot-ui-window-symbolic');
        menu.addAction('Attach desktop context', () => this.emit('desktop-context-requested'), 'video-display-symbolic');
        if (this._isLocalProfile()) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Reference a file…', () => this._queueReference(false), 'text-x-generic-symbolic');
            menu.addAction('Reference a folder…', () => this._queueReference(true), 'folder-symbolic');
        }
        let destroyIdle = null;
        menu.connect('destroy', () => {
            if (destroyIdle)
                GLib.source_remove(destroyIdle);
            if (this._attachMenu === menu)
                this._attachMenu = null;
        });
        menu.connect('open-state-changed', (_menu, open) => {
            this._attachButton[open ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
            if (!open && !destroyIdle)
                destroyIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    destroyIdle = null;
                    menu.destroy();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    // Files and folders pasted or sent from Files. Agents on this computer get
    // references, like the menu; remote agents cannot reach local paths, so
    // files are attached and folders sent as streamed archives.
    async addLocalPaths(paths) {
        if (this._run || this._choosingFile || this._destroyed)
            return 0;
        const local = this._isLocalProfile();
        const identity = activeProfile(this._settings)?.id;
        const problems = [];
        let added = 0;
        for (const path of paths) {
            const name = GLib.path_get_basename(path);
            if (this._queuedFiles.length + this._queuedReferences.length >= MAX_ATTACHMENTS_PER_TURN) {
                problems.push('Attach or reference up to 12 items per message.');
                break;
            }
            const type = Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null);
            const folder = type === Gio.FileType.DIRECTORY;
            if (type !== Gio.FileType.REGULAR && !folder) {
                problems.push(`${name} is not a file or folder on this computer.`);
            } else if (local) {
                const absolute = GLib.canonicalize_filename(path, null);
                if (!this._queuedReferences.some(item => item.path === absolute)) {
                    this._queuedReferences.push({id: GLib.uuid_string_random(), path: absolute, folder});
                    added++;
                }
            } else {
                try {
                    const exclude = this.privacyEnabled
                        ? (rel, isFolder) => isFolder ? sensitiveFolder(rel) : sensitiveFile(rel) : null;
                    const file = await (folder ? selectFolder(path, {exclude}) : selectAttachment(path));
                    if (this._destroyed || this._run || identity !== activeProfile(this._settings)?.id)
                        return added;
                    this._queuedFiles.push(file);
                    added++;
                } catch (error) {
                    problems.push(`${name}: ${error.message}`);
                }
            }
        }
        if (added)
            this._updateAttachmentButton();
        if (problems.length)
            Main.notifyError(this.assistantName, problems.join('\n'));
        return added;
    }

    async _queueReference(folder) {
        if (this._run || this._choosingFile || !this._isLocalProfile())
            return;
        this._choosingFile = true;
        this._syncProfileButtons();
        const identity = activeProfile(this._settings)?.id;
        try {
            const path = await this._choosePath(folder ? 'reference-folder' : 'reference-file');
            if (!path || this._destroyed || this._run || identity !== activeProfile(this._settings)?.id)
                return;
            if (this._queuedFiles.length + this._queuedReferences.length >= MAX_ATTACHMENTS_PER_TURN)
                throw new Error('Attach or reference up to 12 items per message.');
            const absolute = GLib.canonicalize_filename(path, null);
            if (!this._queuedReferences.some(item => item.path === absolute))
                this._queuedReferences.push({id: GLib.uuid_string_random(), path: absolute, folder: Boolean(folder)});
            this._updateAttachmentButton();
            this.emit('attachment-added');
        } catch (error) {
            if (!this._destroyed)
                Main.notifyError(this.assistantName, error.message);
        } finally {
            this._choosingFile = false;
            if (!this._destroyed)
                this._syncProfileButtons();
        }
    }

    async _queueLocalFile() {
        if (this._run || this._choosingFile)
            return;
        this._choosingFile = true;
        this._syncProfileButtons();
        const identity = activeProfile(this._settings)?.id;
        try {
            const path = await this._choosePath('open');
            if (!path || this._destroyed || this._run || identity !== activeProfile(this._settings)?.id)
                return;
            const file = await selectAttachment(path);
            if (this._destroyed || this._run || identity !== activeProfile(this._settings)?.id)
                return;
            if (this._queuedFiles.length + this._queuedReferences.length >= MAX_ATTACHMENTS_PER_TURN)
                throw new Error('Attach or reference up to 12 items per message.');
            this._queuedFiles.push(file);
            this._updateAttachmentButton();
            this.emit('attachment-added');
        } catch (error) {
            if (!this._destroyed)
                Main.notifyError(this.assistantName, error.message);
        } finally {
            this._choosingFile = false;
            if (!this._destroyed)
                this._syncProfileButtons();
        }
    }

    async _shareLocalFolder() {
        const profile = activeProfile(this._settings);
        if (this._run || profile?.transport !== 'ssh')
            return;
        if (this._sharedFolder) {
            this._cancelFolderShare();
            return;
        }
        try {
            const path = await this._choosePath('folder');
            if (!path || this._destroyed || this._run || activeProfile(this._settings)?.id !== profile.id)
                return;
            const root = GLib.canonicalize_filename(path, null).replace(/\/$/, '') || '/';
            await workspaceOperation(root, 'list', '');
            this._sharedFolder = {profile: profile.id, path: root};
            this._shareFolderButton.accessible_name = 'Stop sharing ' + root;
        } catch (error) {
            if (!this._destroyed)
                Main.notifyError(this.assistantName, error.message);
        }
    }

    _cancelFolderShare() {
        this._sharedFolder = null;
        if (this._shareFolderButton)
            this._shareFolderButton.accessible_name = 'Share a local folder';
    }

    _discardTemporaryAttachments() {
        if (!this._temporaryAttachments)
            return;
        removeAttachmentDirectory(Gio.File.new_for_path(this._temporaryAttachments));
        this._temporaryAttachments = null;
    }

    _addAttachmentCard(container, record, temporary = null) {
        const file = attachmentFile(record, temporary);
        container.show();
        if (record.image) {
            const path = file.get_path();
            container.add_child(this._createInlineImage({title: record.name, url: path},
                file.get_parent().get_path(), path));
        }
        const card = new St.BoxLayout({style_class: 'message ai-attachment-card', ...VERTICAL_LAYOUT,
            reactive: true,
            x_expand: true, x_align: Clutter.ActorAlign.START,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH});
        const header = new St.BoxLayout({style_class: 'ai-attachment-header', x_expand: true});
        let icon = new Gio.ThemedIcon({name: 'text-x-generic-symbolic'});
        try {icon = Gio.content_type_get_symbolic_icon(Gio.content_type_guess(record.name, null)[0]);} catch { /* Generic file icon. */ }
        header.add_child(new St.Icon({gicon: icon, icon_size: 28, style_class: 'ai-attachment-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        const info = new St.BoxLayout({...VERTICAL_LAYOUT, x_expand: true});
        info.add_child(this._createTextLabel('ai-message-text ai-attachment-name', record.name));
        info.add_child(new St.Label({text: GLib.format_size(record.size), style_class: 'ai-attachment-meta', opacity: 180}));
        header.add_child(info);
        card.add_child(header);
        const actions = new St.BoxLayout({style_class: 'ai-attachment-actions', x_expand: true});
        const button = new St.Button({
            style_class: 'button default', accessible_name: 'Download ' + record.name,
            can_focus: true, track_hover: true, x_align: Clutter.ActorAlign.START,
        });
        const buttonContent = new St.BoxLayout({style_class: 'ai-attachment-download'});
        buttonContent.add_child(new St.Icon({icon_name: 'folder-download-symbolic', icon_size: 16}));
        buttonContent.add_child(new St.Label({text: 'Download'}));
        button.set_child(buttonContent);
        actions.add_child(button);
        const status = this._createTextLabel('ai-attachment-meta', '');
        status.visible = false;
        actions.add_child(status);
        const stop = new St.Button({label: 'Cancel', accessible_name: 'Cancel download '+record.name,
            style_class: 'button', can_focus: true, visible: false});
        actions.add_child(stop);
        card.add_child(actions);
        container.add_child(card);
        let disposed = false;
        let saving = false;
        let downloadCancel = null;
        stop.connect('clicked', () => downloadCancel?.cancel());
        card.connect('destroy', () => {disposed = true; downloadCancel?.cancel();});
        button.connect('clicked', async () => {
            if (saving)
                return;
            saving = true;
            downloadCancel = new Gio.Cancellable();
            button.reactive = false;
            try {
                const path = await this._chooseAttachmentSavePath(record.name);
                if (!path || this._destroyed || disposed)
                    return;
                status.text = 'Saving…';
                status.show();
                stop.show();
                let lastProgress = 0;
                await copyAttachment(record, path, temporary, {cancellable: downloadCancel, progress: (done, total) => {
                    const now = GLib.get_monotonic_time();
                    if (!disposed && now - lastProgress >= 100000) {
                        lastProgress = now;
                        status.text = `Saving ${GLib.format_size(done)} / ${GLib.format_size(total)}`;
                    }
                }});
                if (!disposed)
                    status.text = 'Saved';
            } catch (error) {
                if (!this._destroyed && !disposed) {
                    const cancelled = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
                    status.text = cancelled ? 'Cancelled' : 'Could not save file';
                    status.show();
                    if (!cancelled) Main.notifyError(this.assistantName, error.message);
                }
            } finally {
                saving = false;
                downloadCancel = null;
                if (!disposed) {
                    stop.hide();
                    button.reactive = true;
                }
            }
        });
    }

    _chooseAttachmentSavePath(name) {
        return this._choosePath('save', name);
    }

    _receiveContentBlock(run, block) {
        if (block.type === 'resource' && block.resource?.mimeType === A2UI_MIME) {
            const text = block.resource.text ?? new TextDecoder().decode(decodeAttachment(block.resource.blob));
            this._receiveA2ui(run, parseA2ui(text));
            return;
        }
        if (block.type === 'resource' && block.resource) {
            const resource = block.resource;
            const name = decodeURIComponent(resource.uri?.split('/').pop() || 'attachment');
            const bytes = typeof resource.text === 'string'
                ? new TextEncoder().encode(resource.text) : decodeAttachment(resource.blob);
            this._receiveAttachment(run, name, bytes);
        } else if (block.type === 'image' && !block.data && block.uri) {
            this._receiveToolImage(run, block.uri, 'Image');
        } else if (block.data) {
            const suffix = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg'}[block.mimeType] ?? 'bin';
            this._receiveAttachment(run, `attachment.${suffix}`, decodeAttachment(block.data));
        }
    }

    _createInlineImage(image, cwd, requestedImage) {
        const card = new St.Button({
            style_class: 'button ai-image-preview',
            track_hover: true,
            can_focus: true,
            accessible_name: image.title,
            x_align: Clutter.ActorAlign.START,
        });
        const label = this._createTextLabel('ai-message-text', 'Loading image…');
        card.set_child(label);
        const cancel = new Gio.Cancellable();
        card.connect('destroy', () => cancel.cancel());
        let target = image.source ?? (/^https:\/\//i.test(image.url) ? image.url : null);
        card.connect('clicked', () => this._openUri(target, {allowLocal: true}));
        loadInlineImage(image, cwd, cancel, requestedImage).then(({pixbuf, target: uri}) => {
            if (cancel.is_cancelled())
                return;
            const sizes={icon:[32,32],avatar:[64,64],smallFeature:[160,100],mediumFeature:[280,160],largeFeature:[400,240],header:[480,180]};
            const [width,height]=sizes[image.variant] ?? [280,160];
            let pixels=pixbuf;
            if(image.fit==='cover') {
                const ratio=width/height;
                const cropWidth=Math.min(pixbuf.get_width(),Math.floor(pixbuf.get_height()*ratio));
                const cropHeight=Math.min(pixbuf.get_height(),Math.floor(pixbuf.get_width()/ratio));
                pixels=pixbuf.new_subpixbuf(Math.floor((pixbuf.get_width()-cropWidth)/2),Math.floor((pixbuf.get_height()-cropHeight)/2),Math.max(1,cropWidth),Math.max(1,cropHeight));
            }
            const preview = previewImage(pixels,width,height,image.fit==='cover'?'fill':image.fit??'contain');
            target = uri;
            label.destroy();
            card.set_child(preview);
            // Reserve the full preview height when the chat becomes scrollable.
            card.min_height = card.get_preferred_height(-1)[1];
            if (this._activeTab === 'chat' && this._contentBox.contains(card))
                this._scrollToBottom();
        }).catch(error => {
            if (!cancel.is_cancelled()) {
                debugError('GNOME Assistant: Could not preview image', error);
                label.set_text(image.title + ' · Preview unavailable' + (target ? ' · Open source' : ''));
            }
        });
        return card;
    }

    _showApproval(id, {title, preview, canAccept, command, changes = [], details = '', decide}) {
        const card = new MessageBubble({
            style_class: 'message ai-chat-bubble ai-chat-bubble-agent ai-approval',
            ...VERTICAL_LAYOUT,
            reactive: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_align: Clutter.ActorAlign.START,
        });
        const heading = new St.BoxLayout({style_class: 'ai-approval-heading'});
        heading.add_child(new St.Icon({icon_name: 'changes-prevent-symbolic', icon_size: 20,
            style_class: 'ai-approval-icon', y_align: Clutter.ActorAlign.CENTER}));
        heading.add_child(this._createTextLabel('ai-message-sender', title));
        card.add_child(heading);
        const scroll = new ApprovalPreview({
            style_class: changes.length ? 'ai-approval-preview ai-approval-preview-diff' : 'ai-approval-preview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const previewBox = new St.BoxLayout({...VERTICAL_LAYOUT, x_expand: true});
        if (command) {
            if (command.reason)
                previewBox.add_child(this._createTextLabel('ai-message-text', command.reason));
            const cwd = command.cwd;
            if (cwd) {
                previewBox.add_child(new St.Widget({style_class: 'ai-approval-divider', x_expand: true}));
                previewBox.add_child(this._createTextLabel('ai-approval-caption', 'Working directory'));
                previewBox.add_child(this._createTextLabel('ai-message-text', cwd));
            }
            previewBox.add_child(new St.Widget({style_class: 'ai-approval-divider', x_expand: true}));
            previewBox.add_child(this._createTextLabel('ai-approval-caption', 'Command'));
            previewBox.add_child(this._createTextLabel('ai-approval-command', command.command));
            if (command.grantRoot)
                previewBox.add_child(this._createTextLabel('ai-message-text', `Requested write access: ${command.grantRoot}`));
            if (command.additionalPermissions)
                previewBox.add_child(this._createTextLabel('ai-message-text', `Requested permissions: ${JSON.stringify(command.additionalPermissions)}`));
        } else if (changes.length) {
            if (preview)
                previewBox.add_child(this._createTextLabel('ai-message-text', preview));
            for (const change of changes)
                previewBox.add_child(this._createDiffView(change));
            if (details)
                previewBox.add_child(this._createTextLabel('ai-message-text', details));
        } else {
            previewBox.add_child(this._createTextLabel('ai-message-text', preview));
        }
        scroll.set_child(previewBox);
        card.add_child(scroll);

        const actions = new St.BoxLayout({style_class: 'ai-approval-actions'});
        for (const [label, decision] of [['Decline', 'decline'], ['Allow once', 'accept']]) {
            if (decision === 'accept' && !canAccept)
                continue;
            const button = new St.Button({
                label, can_focus: true, track_hover: true,
                style_class: decision === 'accept' ? 'button default' : 'button',
            });
            button.connect('clicked', () => this.decideApproval(id, decision === 'accept'));
            actions.add_child(button);
        }
        card.add_child(actions);
        this._approvals.set(id, card);
        this._approvalRequests.set(id, {id, title, canAccept,
            details: command ? command.command : preview, decide});
        this._contentBox.add_child(card);
        this._setActiveTab('chat');
        this._scrollToBottom();
        this.emit('approval-requested', id);
        this.emit('run-state-changed');
    }

    // The single decision path for the chat card and for notifications: the
    // first answer wins, and the card goes away wherever it was given.
    decideApproval(id, accepted) {
        const request = this._approvalRequests.get(id);
        if (!request || (accepted && !request.canAccept))
            return false;
        this._clearApproval(id);
        request.decide(accepted);
        return true;
    }

    // Requests waiting for an answer: {id, title, details, canAccept}.
    get pendingApprovals() {
        return [...this._approvalRequests.values()].map(({decide: _decide, ...request}) => request);
    }

    get running() {
        return Boolean(this._run);
    }

    stopReply() {
        this._stopRun();
    }

    showChat() {
        this._setActiveTab('chat');
    }

    // A file change as a unified diff. Consecutive lines of one kind share a
    // label, and long diffs show their start until "Show all".
    _createDiffView(diff) {
        const view = new St.BoxLayout({style_class: 'ai-diff', ...VERTICAL_LAYOUT, x_expand: true});
        const header = new St.BoxLayout({style_class: 'ai-diff-header', x_expand: true});
        header.add_child(this._createTextLabel('ai-diff-path', diff.path, {selectable: true}));
        header.add_child(new St.Label({style_class: 'ai-diff-summary', y_align: Clutter.ActorAlign.CENTER,
            text: `${diff.newFile ? 'New file · ' : ''}+${diff.added} −${diff.removed}`}));
        view.add_child(header);
        const rows = diff.hunks.flatMap(hunk => [{type: '@', text: hunkHeader(hunk)},
            ...hunk.lines.map(line => ({type: line.type, text: line.type + line.text}))]);
        if (!rows.length)
            rows.push({type: '@', text: 'No changes'});
        const lines = new St.BoxLayout({style_class: 'ai-diff-lines', ...VERTICAL_LAYOUT, x_expand: true});
        view.add_child(lines);
        const style = {'@': 'ai-diff-hunk', '+': 'ai-diff-added', '-': 'ai-diff-removed', ' ': 'ai-diff-context'};
        const show = limit => {
            this._clearChildren(lines);
            let group = [];
            const flush = () => {
                if (group.length)
                    lines.add_child(this._createTextLabel(`ai-diff-line ${style[group[0].type]}`,
                        group.map(row => row.text).join('\n'), {selectable: true}));
                group = [];
            };
            for (const row of rows.slice(0, limit)) {
                if (group.length && group[0].type !== row.type)
                    flush();
                group.push(row);
            }
            flush();
        };
        show(DIFF_PREVIEW_LINES);
        if (rows.length > DIFF_PREVIEW_LINES) {
            const more = new St.Button({style_class: 'button flat ai-code-action', can_focus: true, track_hover: true,
                x_align: Clutter.ActorAlign.START, label: `Show all ${rows.length} lines`});
            more.connect('clicked', () => {
                show(rows.length);
                more.destroy();
            });
            view.add_child(more);
        }
        return view;
    }

    _clearApproval(id) {
        this._approvals.get(id)?.destroy();
        this._approvals.delete(id);
        if (!this._approvalRequests.delete(id) || this._destroyed)
            return;
        this.emit('approval-resolved', id);
        this.emit('run-state-changed');
    }

    _clearApprovals() {
        for (const id of this._approvals.keys())
            this._clearApproval(id);
    }

    async _stopRun() {
        const run = this._run;
        if (!run || run.cancelled)
            return;
        run.cancelled = true;
        this._a2uiStore.remote.fail([...this._a2uiStore.remote.byId.keys()],
            run.functionTimedOut ? 'TIMEOUT' : 'CANCELLED',
            run.functionTimedOut ? 'The agent timed out while answering the interface.' : 'The interface request was stopped.');
        run.localCancel?.cancel();
        for (const cancel of run.pendingApprovals ?? [])
            cancel(false);
        this._clearApprovals();
        run.statusLabel.set_text('Stopping…');
        if (run.acp) {
            if (run.streamedText === undefined)
                run.acp.close();
            else
                await run.acp.cancel(this._threadId);
        } else {
            this._client?.close();
        }
    }

    _renderMarkdownToBox(container, markdown, cwd = this._threadCwd, requestedImage = null, remote = false) {
        for (const child of container.get_children())
            child.destroy();

        const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
        let paragraph = [];
        let fence = null;
        let fenceInfo = '';
        let codeLines = [];
        let renderedBlocks = 0;
        let renderedImages = 0;
        let renderingTruncated = false;
        const links = new Map();
        // Paths from a remote agent name files on another machine: plain text.
        const paths = remote ? null : new PathLinks({cwd, home: GLib.get_home_dir(), kind: path => this._localPathKind(path)});
        const inline = text => this._inlineMarkdownToMarkup(text, links, 0, paths);

        const addMarkupLabel = (styleClass, markup) => {
            if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                renderingTruncated = true;
                return;
            }

            container.add_child(this._createMarkupLabel(styleClass, markup));
            renderedBlocks++;
        };

        const flushParagraph = () => {
            if (paragraph.length === 0)
                return;
            const text = paragraph.join('\n').trim();
            paragraph = [];
            if (text.length > 0)
                addMarkupLabel('ai-message-text', text.split(/(?: {2,}|\\)\n/)
                    .map(part => inline(part.replace(/ *\n */g, ' '))).join('\n'));
        };

        const flushCode = () => {
            if (codeLines.length === 0)
                return;
            const codeText = codeLines.join('\n');
            codeLines = [];
            if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                renderingTruncated = true;
                return;
            }
            container.add_child(this._createCodeBlock(codeText, fenceInfo, paths));
            renderedBlocks++;
        };

        const splitTableRow = line => line.trim().replace(/^\||(?<!\\)\|$/g, '')
            .split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

        for (let index = 0; index < lines.length; index++) {
            if (renderingTruncated)
                break;

            const line = lines[index];
            const codeFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
            if (fence) {
                if (codeFence && codeFence[1][0] === fence[0] &&
                    codeFence[1].length >= fence.length && !codeFence[2].trim()) {
                    flushCode();
                    fence = null;
                } else {
                    codeLines.push(line);
                }
                continue;
            }

            if (codeFence) {
                flushParagraph();
                fence = codeFence[1];
                fenceInfo = codeFence[2];
                continue;
            }

            const image = renderedImages < MAX_INLINE_IMAGES ? parseImageLine(line) : null;
            if (image) {
                flushParagraph();
                if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                    renderingTruncated = true;
                    break;
                }
                container.add_child(this._createInlineImage(image, remote ? '' : cwd, requestedImage));
                renderedImages++;
                renderedBlocks++;
                continue;
            }

            const separator = lines[index + 1] ?? '';
            if (line.includes('|') && separator.includes('|')) {
                const header = splitTableRow(line);
                const columns = splitTableRow(separator);
                if (columns.length >= 2 && columns.length <= 12 &&
                    header.length === columns.length && columns.every(cell => /^:?-{3,}:?$/.test(cell))) {
                    flushParagraph();
                    const rows = [header];
                    index++;
                    while (lines[index + 1]?.includes('|')) {
                        const row = splitTableRow(lines[index + 1]);
                        if (row.length !== columns.length)
                            break;
                        rows.push(row);
                        index++;
                    }
                    const cells = rows.length * columns.length;
                    if (renderedBlocks + cells > MAX_RENDER_BLOCKS) {
                        renderingTruncated = true;
                        break;
                    }
                    container.add_child(this._createMarkdownTable(rows, inline));
                    renderedBlocks += cells;
                    continue;
                }
            }

            if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
                flushParagraph();
                if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                    renderingTruncated = true;
                    break;
                }
                container.add_child(new St.Widget({style_class: 'ai-message-rule'}));
                renderedBlocks++;
                continue;
            }

            if (line.trim().length === 0) {
                flushParagraph();
                continue;
            }

            const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*$/);
            if (heading) {
                flushParagraph();
                const level = heading[1].length;
                const text = inline(heading[2].replace(/\s+#+$/, ''));
                addMarkupLabel(`ai-message-h${level}`, `<b>${text}</b>`);
                continue;
            }

            const listItem = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.+)$/);
            if (listItem) {
                flushParagraph();
                const [, indent, marker, content] = listItem;
                const task = /^\[([ xX])\]\s+(.+)$/.exec(content);
                const bullet = task ? (task[1] === ' ' ? '☐' : '☑') :
                    (marker.length === 1 ? '•' : marker);
                const padding = '\u2003'.repeat(Math.min(4, Math.floor(indent.replace(/\t/g, '    ').length / 2)));
                addMarkupLabel('ai-message-list', `${padding}${bullet} ${inline(task ? task[2] : content)}`);
                continue;
            }

            const quote = line.match(/^ {0,3}>\s?(.*)$/);
            if (quote) {
                flushParagraph();
                const item = inline(quote[1].trim());
                addMarkupLabel('ai-message-quote', item);
                continue;
            }

            paragraph.push(line);
        }

        flushParagraph();
        if (fence)
            flushCode();

        for (const [uri, title] of links) {
            if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                renderingTruncated = true;
                break;
            }
            const button = new St.Button({
                style_class: 'button flat shell-link ai-message-link',
                can_focus: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.START,
                accessible_name: `Open ${title}: ${uri}`,
            });
            button.set_child(this._createTextLabel('ai-message-text', `↗ ${uri}`));
            button.connect('clicked', () => this._openUri(uri));
            container.add_child(button);
            renderedBlocks++;
        }

        for (const link of paths?.links.values() ?? []) {
            if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                renderingTruncated = true;
                break;
            }
            container.add_child(this._createPathLink(link));
            renderedBlocks++;
        }

        if (renderingTruncated) {
            const escaped = GLib.markup_escape_text(TRUNCATED_NOTICE.trim(), -1);
            container.add_child(this._createMarkupLabel('ai-message-text', escaped));
        }
    }

    _closesCodeFence(line, fence) {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        return Boolean(match && match[1][0] === fence[0] && match[1].length >= fence.length);
    }

    // A fenced block keeps its text as code, with actions above it.
    _createCodeBlock(code, info, paths) {
        const block = new St.BoxLayout({style_class: 'ai-code-block', ...VERTICAL_LAYOUT, x_expand: true});
        const bar = new St.BoxLayout({style_class: 'ai-code-actions', x_expand: true});
        bar.add_child(new St.Label({text: info.trim().split(/\s+/)[0].slice(0, 24), style_class: 'ai-code-language',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const action = (label, name, activate) => {
            const button = new St.Button({label, accessible_name: name, style_class: 'button flat ai-code-action',
                can_focus: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER});
            button.connect('clicked', () => activate());
            bar.add_child(button);
        };
        // A block holding only an existing path can open it, like a path in text.
        const link = code.includes('\n') ? null : paths?.resolve(code, {bare: true});
        if (link)
            action('Open', `Open ${link.label}`, () => this._openLocalPath(link.path));
        action('Copy', 'Copy code', () => this._copyText(code));
        action('Save as…', 'Save code as…', () => this._saveCodeBlock(code, snippetName(info)));
        block.add_child(bar);
        block.add_child(this._createMarkupLabel('ai-message-code', `<tt>${GLib.markup_escape_text(code, -1)}</tt>`));
        return block;
    }

    async _saveCodeBlock(code, name) {
        try {
            const path = await this._choosePath('save-code', name);
            if (!path || this._destroyed)
                return;
            const bytes = new GLib.Bytes(new TextEncoder().encode(code.endsWith('\n') ? code : code + '\n'));
            const file = Gio.File.new_for_path(path);
            await new Promise((resolve, reject) => file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null, (source, result) => {
                    try {
                        resolve(source.replace_contents_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }));
        } catch (error) {
            if (!this._destroyed)
                Main.notifyError(this.assistantName, `Could not save the code: ${error.message}`);
        }
    }

    _localPathKind(path) {
        const type = Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        return type === Gio.FileType.DIRECTORY ? 'directory' : type === Gio.FileType.REGULAR ? 'file' : null;
    }

    _createPathLink(link) {
        const button = new St.Button({
            style_class: 'button flat shell-link ai-message-link',
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.START,
            accessible_name: `Open ${link.label}`,
        });
        const content = new St.BoxLayout({style_class: 'ai-path-link'});
        content.add_child(new St.Icon({icon_name: link.kind === 'directory' ? 'folder-symbolic' : 'text-x-generic-symbolic',
            icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        content.add_child(this._createTextLabel('ai-message-text', link.label));
        button.set_child(content);
        button.connect('clicked', () => this._openLocalPath(link.path));
        return button;
    }

    // Opens a path from a reply in its default app, or a folder in the file
    // manager. The path is checked again, as it may have changed since the
    // reply. A line number cannot be passed to apps generically, so it is
    // left out. Runnable files open their folder: a click must not run them.
    _openLocalPath(path) {
        let file = Gio.File.new_for_path(path);
        try {
            const info = file.query_info('standard::type,standard::content-type,access::can-execute',
                Gio.FileQueryInfoFlags.NONE, null);
            const type = info.get_file_type();
            if (type !== Gio.FileType.REGULAR && type !== Gio.FileType.DIRECTORY)
                throw new Error('Only files and folders can be opened.');
            const contentType = info.get_content_type() ?? '';
            if (type === Gio.FileType.REGULAR && (info.get_attribute_boolean('access::can-execute') ||
                RUNNABLE_TYPES.some(runnable => Gio.content_type_is_a(contentType, runnable))))
                file = file.get_parent();
            const context = global.create_app_launch_context(global.get_current_time(), -1);
            if (Gio.AppInfo.launch_default_for_uri(file.get_uri(), context))
                this.emit('external-opened');
        } catch (error) {
            Main.notifyError(this.assistantName, `Could not open ${GLib.path_get_basename(path)}: ${error.message}`);
        }
    }

    _createMarkdownTable(rows, inline) {
        const layout = new Clutter.GridLayout({column_homogeneous: true});
        const cells = rows.map((row, index) => {
            const style = index === 0 ? 'ai-message-table-cell ai-message-table-header' : 'ai-message-table-cell';
            return row.map(value => this._createMarkupLabel(style, inline(value)));
        });
        return new MarkdownTable(cells, {
            style_class: 'ai-message-table',
            layout_manager: layout,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
        });
    }

    _createMarkupLabel(styleClass, markup) {
        const label = new WrappedLabel({
            style_class: styleClass,
            x_expand: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_align: Clutter.ActorAlign.FILL
        });

        this._configureWrappedText(label);
        this._makeTextSelectable(label);

        label.clutter_text.set_markup(markup);
        return label;
    }

    _createTextLabel(styleClass, text, {selectable = false} = {}) {
        const label = new WrappedLabel({
            style_class: styleClass,
            x_expand: true,
            request_mode: Clutter.RequestMode.HEIGHT_FOR_WIDTH,
            x_align: Clutter.ActorAlign.FILL
        });

        this._configureWrappedText(label);
        if (selectable)
            this._makeTextSelectable(label);
        label.clutter_text.set_text(String(text ?? ''));
        return label;
    }

    _makeTextSelectable(label) {
        const text = label.clutter_text;
        text.editable = false;
        text.reactive = true;
        text.selectable = true;
        this._selectableMessageText.add(text);
        text.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1)
                text.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    handleMessageKeyPress(event) {
        const text = global.stage.get_key_focus();
        // Escape leaves assistant mode, unless it can first cancel a rename
        // or clear the history search.
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            if (this._historyRename && text === this._historyRename.entry.clutter_text) {
                this._historyRename.cancel();
                return Clutter.EVENT_STOP;
            }
            if (text === this._historySearch.clutter_text && this._historySearch.get_text()) {
                this._historySearch.set_text('');
                return Clutter.EVENT_STOP;
            }
        }
        if (!this._selectableMessageText.has(text))
            return Clutter.EVENT_PROPAGATE;

        // Clutter can run deletion bindings even when editable is false.
        const key = event.get_key_symbol();
        const modifiers = event.get_state();
        const control = modifiers & Clutter.ModifierType.CONTROL_MASK;
        const shift = modifiers & Clutter.ModifierType.SHIFT_MASK;
        if (key === Clutter.KEY_BackSpace || key === Clutter.KEY_Delete ||
            key === Clutter.KEY_KP_Delete ||
            (control && [Clutter.KEY_x, Clutter.KEY_X, Clutter.KEY_v, Clutter.KEY_V].includes(key)) ||
            (shift && (key === Clutter.KEY_Insert || key === Clutter.KEY_KP_Insert)))
            return Clutter.EVENT_STOP;

        if (!control || (key !== Clutter.KEY_c && key !== Clutter.KEY_C))
            return Clutter.EVENT_PROPAGATE;

        const selection = text.get_selection();
        if (selection)
            this._copyText(selection);
        return Clutter.EVENT_STOP;
    }

    _copyText(text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _configureWrappedText(label) {
        if (['ai-history-summary', 'ai-history-meta', 'ai-attachment-meta', 'ai-approval-caption',
            'a2ui-caption', 'a2ui-text-caption'].some(name => label.has_style_class_name(name)))
            label.opacity = 180;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.single_line_mode = false;
        label.clutter_text.line_wrap = true;
        const wrapMode = Pango.WrapMode ?? Pango.LineWrapMode;
        if (wrapMode && wrapMode.WORD_CHAR !== undefined)
            label.clutter_text.line_wrap_mode = wrapMode.WORD_CHAR;

    }

    _limitDisplayText(value) {
        const limited = this._appendLimitedText('', value, MAX_DISPLAY_CHARS);
        return this._formatLimitedText(limited.text, limited.truncated);
    }

    _appendLimitedText(current, addition, maxChars) {
        const base = String(current ?? '');
        const extra = String(addition ?? '');
        const limit = Math.max(0, maxChars | 0);

        if (limit === 0)
            return {text: '', truncated: base.length > 0 || extra.length > 0};

        if (base.length >= limit)
            return {text: base.slice(0, limit), truncated: extra.length > 0 || base.length > limit};

        const combined = `${base}${extra}`;
        if (combined.length <= limit)
            return {text: combined, truncated: false};

        return {text: combined.slice(0, limit), truncated: true};
    }

    _formatLimitedText(text, truncated) {
        return truncated ? `${text}${TRUNCATED_NOTICE}` : String(text ?? '');
    }

    _inlineMarkdownToMarkup(text, links, depth = 0, paths = null) {
        const escape = value => GLib.markup_escape_text(value, -1);
        if (depth >= 6)
            return escape(text);
        // Running text, with existing local paths underlined like links.
        const plain = value => paths ? paths.split(value)
            .map(piece => piece.link ? '<u>' + escape(piece.text) + '</u>' : escape(piece.text)).join('') : escape(value);

        // Tokenize before escaping so literal code and escaped punctuation stay intact.
        const tokens = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|(?<!`)(`+)(?!`)([^\n]+?)(?<!`)\2(?!`)|\[([^\]\n]+)\]\(([^\s()]+(?:\([^()\s]*\)[^\s()]*)*)\)|<(https?:\/\/[^\s<>]+)>|(\*\*\*|___|\*\*|__|~~|\*|(?<!\w)_)(?=\S)(.+?)(?<=\S)\7(?![*_~])/g;
        let output = '';
        let cursor = 0;
        for (const match of text.matchAll(tokens)) {
            const [token, literal, fence, code, label, destination, autolink, delimiter, emphasis] = match;
            output += plain(text.slice(cursor, match.index));
            cursor = match.index + token.length;

            if (literal) {
                output += escape(literal);
            } else if (fence) {
                const value = /^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code;
                const tt = '<tt>' + escape(value) + '</tt>';
                output += paths?.add(value, {bare: true}) ? '<u>' + tt + '</u>' : tt;
            } else if (delimiter) {
                const markup = this._inlineMarkdownToMarkup(emphasis, links, depth + 1, paths);
                if (delimiter === '~~')
                    output += '<s>' + markup + '</s>';
                else if (delimiter.length === 3)
                    output += '<b><i>' + markup + '</i></b>';
                else if (delimiter.length === 2)
                    output += '<b>' + markup + '</b>';
                else
                    output += '<i>' + markup + '</i>';
            } else {
                const uri = destination ?? autolink;
                const title = label ?? autolink;
                const markup = this._inlineMarkdownToMarkup(title, links, depth + 1, paths);
                if (/^https?:\/\//i.test(uri)) {
                    links.set(uri, title);
                    output += '<u>' + markup + '</u>';
                } else if (paths?.add(uri, {bare: true})) {
                    output += '<u>' + markup + '</u>' + (uri === title ? '' : ' (<tt>' + escape(uri) + '</tt>)');
                } else {
                    output += uri === title ? markup : markup + ' (<tt>' + escape(uri) + '</tt>)';
                }
            }
        }
        return output + plain(text.slice(cursor));
    }

    _scrollToBottom() {
        this._cancelScrollToBottom();
        this._scrollToBottomId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._scrollToBottomId = null;
            const adjustment = this._scrollView.vadjustment ?? this._scrollView.vscroll?.adjustment;
            if (adjustment) {
                const upper = adjustment.upper ?? adjustment.get_upper?.() ?? 0;
                const pageSize = adjustment.page_size ?? adjustment.get_page_size?.() ?? 0;
                adjustment.set_value(Math.max(0, upper - pageSize));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelScrollToBottom() {
        if (!this._scrollToBottomId)
            return;

        GLib.source_remove(this._scrollToBottomId);
        this._scrollToBottomId = null;
    }

    _openUri(uri, {allowLocal = false, allowHandler = false} = {}) {
        if (!uri || !(/^https?:\/\//i.test(uri) || (allowLocal && uri.startsWith('file://')) || (allowHandler && /^(?:mailto:|tel:)/i.test(uri))))
            return;

        try {
            const context = global.create_app_launch_context(global.get_current_time(), -1);
            if (Gio.AppInfo.launch_default_for_uri(uri, context)) {
                this.emit('external-opened');
                return true;
            }
        } catch (e) {
            debugError(`GNOME Assistant: Failed to open URI ${uri}`, e);
        }
        return false;
    }

    _getSettingString(key, fallback) {
        if (!this._settings)
            return fallback;

        try {
            const value = getString(this._settings, key, fallback).trim();
            return value.length > 0 ? value : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    _rememberConversation(prompt, responseText, attachments) {
        this._appendHistoryEntry('user', prompt);
        this._appendHistoryEntry('assistant', responseText, attachments);
        if (this._activeTab === 'history')
            this._refreshHistoryView();
    }

    _appendHistoryEntry(role, content, attachments) {
        const text = this._limitDisplayText(content).trim();
        const a2ui = role === 'assistant' ? this._a2uiStore.snapshot() : undefined;
        if (!text && !attachments?.length && a2ui === undefined)
            return;

        const entry = {
            role,
            content: text,
            ts: Date.now(),
            sessionId: this._threadId,
            ...(a2ui ? {a2ui} : {}),
            cwd: this._threadCwd,
            connection: this._threadConnection, profile: this._threadProfile,
            localCwd: this._threadLocalCwd, remote: this._threadRemote, resumable: this._threadResumable,
            ...(attachments?.length ? {attachments: attachments.filter(item => !item.temporary).map(attachmentMetadata)} : {}),
        };
        this._appendMemoryEntry(entry);
    }

    async _refreshHistoryView() {
        if (this._destroyed || !this._historyBox)
            return;
        // Refreshes overlap (switching tabs, saving, deleting): only the
        // latest may draw, or an older one would redraw the rows later, such
        // as under a row's open menu.
        const token = this._historyRefreshToken = Symbol('history refresh');

        this._clearChildren(this._historyBox);

        if (!this._isPersistentMemoryEnabled()) {
            this._historyIndex = [];
            this._historySearch.visible = false;
            this._renderHistoryEmptyState('Saving conversations is disabled.');
            return;
        }

        const [entries, meta] = await Promise.all([this._loadMemoryEntriesAsync(), loadHistoryMeta()]);
        if (this._destroyed || !this._historyBox || token !== this._historyRefreshToken)
            return;

        this._historyIndex = buildHistoryIndex(this._buildHistorySessions(entries), meta);
        const selected = this._selectedHistorySessionId &&
            this._historyIndex.find(item => item.session.id === this._selectedHistorySessionId);
        if (selected) {
            this._clearChildren(this._historyBox);
            this._renderHistorySession(selected.session, selected.title);
            return;
        }
        this._selectedHistorySessionId = null;
        this._renderHistoryList();
    }

    _renderHistoryEmptyState(text, iconName = 'document-open-recent-symbolic') {
        const box = new St.BoxLayout({
            style_class: 'ai-history-empty',
            ...VERTICAL_LAYOUT,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 48,
            style_class: 'ai-welcome-icon', x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(this._createTextLabel('ai-history-empty-title', text));
        this._historyBox.add_child(box);
    }

    // Runs on every keystroke in the search entry, from the index only.
    _renderHistoryList() {
        this._clearChildren(this._historyBox);
        const index = this._historyIndex;
        this._historySearch.visible = index.length > 0;
        if (!index.length) {
            this._renderHistoryEmptyState('No saved conversations yet.');
            return;
        }

        const query = this._historySearch.get_text().trim();
        const terms = searchTerms(query);
        const results = searchHistory(index, query);
        const plural = index.length === 1 ? '' : 's';
        this._historyBox.add_child(this._createTextLabel('ai-history-summary', terms.length
            ? `${results.length} of ${index.length} conversation${plural} match${results.length === 1 ? 'es' : ''}`
            : `${index.length} saved conversation${plural}`));
        if (!results.length) {
            this._renderHistoryEmptyState(`No conversations match “${query}”.`, 'edit-find-symbolic');
            return;
        }

        for (const {item} of results.slice(0, MAX_HISTORY_SESSIONS))
            this._historyBox.add_child(this._createHistoryRow(item, terms));
    }

    _createHistoryRow(item, terms) {
        const {session} = item;
        const container = new St.BoxLayout({
            style_class: 'ai-history-row',
            x_expand: true,
            reactive: true,
            track_hover: true,
        });
        const row = new St.Button({
            style_class: 'list-search-result ai-history-item',
            can_focus: true,
            track_hover: true,
            x_expand: true
        });

        const rowBox = new St.BoxLayout({
            style_class: 'ai-history-row-content',
            ...VERTICAL_LAYOUT,
            x_expand: true
        });

        rowBox.add_child(this._createHighlightedLabel('ai-history-title', highlightSegments(item.title, terms), 'u'));
        rowBox.add_child(this._createTextLabel(
            'ai-history-meta',
            `${this._formatTimestamp(session.latestTs)} · ${session.entries.length} messages`
        ));

        const snippet = historySnippet(item, terms);
        if (snippet)
            rowBox.add_child(this._createHighlightedLabel('ai-history-preview', snippet));
        else if (session.preview)
            rowBox.add_child(this._createTextLabel('ai-history-preview', session.preview));

        row.set_child(rowBox);
        row.connect('clicked', () => {
            this._selectedHistorySessionId = session.id;
            this._refreshHistoryView();
        });

        const action = (iconName, accessibleName, styleClass) => {
            const button = new St.Button({
                style_class: `icon-button flat ai-history-action ${styleClass}`,
                accessible_name: `${accessibleName}: ${item.title}`,
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
            });
            button.set_child(new St.Icon({icon_name: iconName, icon_size: 16}));
            return button;
        };
        const pin = action('view-pin-symbolic', item.pinned ? 'Unpin conversation' : 'Pin conversation', 'ai-history-pin');
        if (item.pinned)
            pin.add_style_class_name('ai-history-pinned');
        pin.connect('clicked', () => this._setHistoryMeta(item, {pinned: !item.pinned}));
        const more = action('view-more-symbolic', 'More actions', 'ai-history-more');
        more.connect('clicked', () => this._showHistoryMenu(more, item,
            () => this._startHistoryRename(container, row, item), () => syncActionVisibility()));
        const remove = action('user-trash-symbolic', 'Delete conversation', 'ai-history-delete');
        remove.connect('clicked', () => this._deleteHistorySession(session.id));

        // Actions show on hover or keyboard focus, and while the row's menu is
        // open (the menu takes the pointer and focus away from the row), except
        // the pin of a pinned conversation, which shows why it is at the top.
        const buttons = [pin, more, remove];
        const syncActionVisibility = () => {
            const active = container.hover || [row, ...buttons].some(actor => actor.has_key_focus()) ||
                more.has_style_pseudo_class('checked');
            for (const button of buttons)
                button.opacity = active || (button === pin && item.pinned) ? 255 : 0;
        };
        syncActionVisibility();
        container.connect('notify::hover', syncActionVisibility);
        for (const actor of [row, ...buttons]) {
            actor.connect('key-focus-in', syncActionVisibility);
            actor.connect('key-focus-out', syncActionVisibility);
        }
        container.add_child(row);
        for (const button of buttons)
            container.add_child(button);
        return container;
    }

    // Matches are bold, as in Shell's search results, or underlined in the
    // already bold titles. All text is escaped so it cannot inject markup.
    _createHighlightedLabel(styleClass, segments, tag = 'b') {
        const label = this._createTextLabel(styleClass, segments.map(segment => segment.text).join(''));
        if (segments.some(segment => segment.match)) {
            label.clutter_text.set_markup(segments.map(({text, match}) => {
                const escaped = GLib.markup_escape_text(text, -1);
                return match ? `<${tag}>${escaped}</${tag}>` : escaped;
            }).join(''));
        }
        return label;
    }

    _showHistoryMenu(button, item, rename, openChanged = () => {}) {
        this._historyMenu?.close();
        const menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.TOP);
        this._historyMenu = menu;
        Main.uiGroup.add_child(menu.actor);
        const manager = new PopupMenu.PopupMenuManager(button);
        manager.addMenu(menu);
        // Actions run once the menu has closed and returned the keyboard
        // focus, which would otherwise end the rename at once, and only if
        // the list was not redrawn meanwhile.
        let chosen = null;
        let rowGone = false;
        button.connect('destroy', () => {
            rowGone = true;
        });
        menu.addAction('Rename…', () => {
            chosen = rename;
        }, 'document-edit-symbolic');
        menu.addAction('Export…', () => {
            chosen = () => this._exportHistorySession(item.session, item.title);
        }, 'document-save-as-symbolic');
        let destroyIdle = null;
        menu.connect('destroy', () => {
            if (destroyIdle)
                GLib.source_remove(destroyIdle);
            if (this._historyMenu === menu)
                this._historyMenu = null;
        });
        menu.connect('open-state-changed', (_menu, open) => {
            button[open ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('checked');
            if (!rowGone)
                openChanged(open);
            if (!open && !destroyIdle)
                destroyIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    destroyIdle = null;
                    menu.destroy();
                    if (!rowGone)
                        chosen?.();
                    return GLib.SOURCE_REMOVE;
                });
        });
        menu.open();
    }

    // Edits the title in place. Enter saves, Escape or leaving the entry
    // cancels; an empty title goes back to the automatic one.
    _startHistoryRename(container, row, item) {
        const entry = new St.Entry({
            style_class: 'ai-history-rename',
            text: item.title,
            hint_text: item.session.title,
            accessible_name: 'Conversation title',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Redrawing the list destroys the row, which also ends the rename.
        let finished = false;
        container.connect('destroy', () => {
            finished = true;
            if (this._historyRename?.entry === entry)
                this._historyRename = null;
        });
        const finish = save => {
            if (finished)
                return;
            finished = true;
            this._historyRename = null;
            if (save) {
                const title = entry.get_text().trim();
                this._setHistoryMeta(item, {title: title === item.session.title ? '' : title});
            } else {
                entry.destroy();
                row.show();
                row.grab_key_focus();
            }
        };
        this._historyRename = {entry, cancel: () => finish(false)};
        entry.clutter_text.connect('activate', () => finish(true));
        entry.clutter_text.connect('key-focus-out', () => finish(false));
        row.hide();
        container.insert_child_at_index(entry, 0);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
    }

    // Titles and pins are kept in their own file, never in the transcript,
    // and only while saving conversations is enabled.
    _setHistoryMeta(item, changes) {
        if (!this._isPersistentMemoryEnabled())
            return;
        try {
            const meta = updateHistoryMeta(item.session.id, changes,
                {knownKeys: new Set(this._historyIndex.map(indexed => indexed.session.id))});
            applyHistoryMeta(this._historyIndex, meta);
        } catch (e) {
            console.error(`GNOME Assistant: Failed to save conversation details: ${e.message}`);
            Main.notifyError(this.assistantName, 'Could not save the conversation title or pin.');
        }
        if (!this._destroyed && this._activeTab === 'history' && !this._selectedHistorySessionId)
            this._renderHistoryList();
    }

    _historyAgentName(session) {
        const id = session.entries.find(entry => entry.profile)?.profile;
        return (id && readProfiles(this._settings).find(profile => profile.id === id)?.name) || '';
    }

    async _exportHistorySession(session, title) {
        if (this._choosingFile)
            return;
        const markdown = conversationMarkdown({title, entries: session.entries, assistantName: this.assistantName,
            agentName: this._historyAgentName(session), formatTime: ts => this._formatTimestamp(ts)});
        this._choosingFile = true;
        this._syncProfileButtons();
        try {
            const path = await this._choosePath('export', exportFileName(title));
            if (path && !this._destroyed)
                await writeTextFile(path, markdown);
        } catch (error) {
            if (!this._destroyed)
                Main.notifyError(this.assistantName, `Could not export the conversation: ${error.message}`);
        } finally {
            this._choosingFile = false;
            if (!this._destroyed)
                this._syncProfileButtons();
        }
    }

    _deleteHistorySession(sessionId) {
        this._memoryWrites = this._memoryWrites.then(() => {
            const file = Gio.File.new_for_path(this._memoryFilePath);
            const [, contents] = file.load_contents(null);
            const lines = new TextDecoder().decode(contents).split('\n');
            const retained = lines.filter(line => {
                try {
                    const entry = JSON.parse(line);
                    const id = String(entry.sessionId ?? '').trim();
                    const key = entry.connection ? JSON.stringify([entry.connection, id]) : id;
                    return key !== sessionId;
                } catch (_e) {
                    return true;
                }
            });
            file.replace_contents(new TextEncoder().encode(retained.join('\n')), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            updateHistoryMeta(sessionId, {title: '', pinned: false});
        }).then(() => {
            if (!this._destroyed && this._activeTab === 'history')
                this._refreshHistoryView();
        }).catch(e => {
            console.error(`GNOME Assistant: Failed to delete conversation: ${e.message}`);
            if (!this._destroyed && this._activeTab === 'history') {
                this._clearChildren(this._historyBox);
                this._historySearch.visible = false;
                this._renderHistoryEmptyState('Could not delete the conversation.');
            }
        });
    }

    _renderHistorySession(session, title = session.title) {
        this._historySearch.visible = false;
        const header = new St.BoxLayout({
            style_class: 'ai-history-detail-header',
            x_expand: true
        });

        const backButton = new St.Button({
            style_class: 'icon-button flat',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Back to history',
        });
        backButton.set_child(new St.Icon({icon_name: 'go-previous-symbolic'}));
        backButton.connect('clicked', () => {
            this._selectedHistorySessionId = null;
            this._refreshHistoryView();
        });
        header.add_child(backButton);

        const titleBox = new St.BoxLayout({
            style_class: 'ai-history-detail-title-box',
            ...VERTICAL_LAYOUT,
            x_expand: true
        });
        titleBox.add_child(this._createTextLabel('ai-history-detail-title', title));
        titleBox.add_child(this._createTextLabel(
            'ai-history-meta',
            `${this._formatTimestamp(session.latestTs)} · ${session.entries.length} messages`
        ));
        header.add_child(titleBox);
        const exportButton = new St.Button({
            style_class: 'icon-button flat',
            accessible_name: 'Export conversation',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        exportButton.set_child(new St.Icon({icon_name: 'document-save-as-symbolic', icon_size: 16}));
        exportButton.connect('clicked', () => this._exportHistorySession(session, title));
        header.add_child(exportButton);
        const cwd = session.entries.find(entry => entry.cwd)?.cwd;
        const context = session.entries[0];
        const profile = context.profile && readProfiles(this._settings).find(item => item.id === context.profile);
        const localCwd = this._getSettingString('workspace-folder', '');
        const canUseWorkspace = () => Boolean(profile && context.resumable &&
            context.localCwd === localCwd && connectionKey(profile, profile.transport === 'ssh' ? profile.remoteCwd : localCwd)
                === context.connection);
        if (cwd) {
            const canResume = !this._run && canUseWorkspace();
            const resume = new St.Button({
                style_class: 'button default ai-resume-button',
                accessible_name: 'Resume conversation',
                opacity: canResume ? 255 : 128,
                track_hover: true,
                can_focus: canResume,
                reactive: canResume,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const resumeContent = new St.BoxLayout({style_class: 'ai-resume-content'});
            resumeContent.add_child(new St.Icon({
                icon_name: 'media-playback-start-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            resumeContent.add_child(new St.Label({
                text: 'Resume',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            resume.set_child(resumeContent);
            resume.connect('clicked', () => {
                if (this._run || !canUseWorkspace())
                    return;
                if (profile)
                    this._settings.set_string('acp-profile', profile.id);
                this._startNewConversation();
                this._threadId = context.sessionId;
                this._loadedThreadId = null;
                this._threadCwd = cwd;
                this._threadEphemeral = false;
                this._threadConnection = context.connection;
                this._threadLocalCwd = context.localCwd;
                this._threadRemote = context.remote;
                this._a2uiContext = this._threadConnection + ':' + this._threadId;
                const latestUi = session.entries.findLast(entry => entry.a2ui !== undefined);
                for (const entry of session.entries.slice(-this._maxVisibleMessages)) {
                    const message = this.addMessage(this._roleToSender(entry.role), entry.role === 'user' ? entry.content : '');
                    message.renderCwd = entry.localCwd ?? entry.cwd;
                    message.remote = entry.remote;
                    if (entry.role !== 'user')
                        message.setText(entry.content);
                    if (entry === latestUi) this._showA2uiSnapshot(entry.a2ui, message, true);
                    for (const attachment of entry.attachments ?? [])
                        this._addAttachmentCard(message.extras, attachment);
                }
            });
            header.add_child(resume);
        }
        this._historyBox.add_child(header);

        for (const entry of session.entries) {
            const isUser = entry.role === 'user';
            const sender = this._roleToSender(entry.role);
            const {bubble, bodyBox, copyButton} = this._createMessageBubble(sender, isUser);
            const text = this._limitDisplayText(entry.content);
            copyButton.visible = Boolean(text);
            copyButton.connect('clicked', () => this._copyText(text));
            if (isUser)
                bodyBox.add_child(this._createTextLabel('ai-message-text', text, {selectable: true}));
            else
                this._renderMarkdownToBox(bodyBox, text, entry.localCwd ?? entry.cwd, null, entry.remote);
            this._showA2uiSnapshot(entry.a2ui, {extras: bodyBox, renderCwd: entry.localCwd ?? entry.cwd, remote: entry.remote});
            for (const attachment of entry.attachments ?? [])
                this._addAttachmentCard(bodyBox, attachment);
            this._historyBox.add_child(bubble);
        }
    }

    _buildHistorySessions(entries) {
        const bySession = new Map();
        for (const entry of entries) {
            const sessionId = String(entry.sessionId ?? '').trim();
            const content = String(entry.content ?? '').trim();
            if (!sessionId || (!content && !entry.attachments?.length && entry.a2ui === undefined))
                continue;
            const key = entry.connection ? JSON.stringify([entry.connection, sessionId]) : sessionId;
            if (!bySession.has(key))
                bySession.set(key, []);
            bySession.get(key).push({...entry, content});
        }

        const sessions = [];
        for (const [sessionId, sessionEntries] of bySession.entries()) {
            sessionEntries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
            const firstUser = sessionEntries.find(entry => entry.role === 'user') ?? sessionEntries[0];
            const firstAssistant = sessionEntries.find(entry => entry.role === 'assistant');
            const latestTs = sessionEntries[sessionEntries.length - 1]?.ts ?? 0;
            sessions.push({
                id: sessionId,
                title: this._summarizeText(firstUser?.content ?? 'Untitled conversation', HISTORY_TITLE_CHARS),
                preview: this._summarizeText(firstAssistant?.content ?? '', HISTORY_PREVIEW_CHARS),
                latestTs,
                entries: sessionEntries
            });
        }

        sessions.sort((a, b) => (b.latestTs ?? 0) - (a.latestTs ?? 0));
        return sessions;
    }

    _summarizeText(text, maxChars) {
        const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
        const limit = Math.max(1, maxChars | 0);
        if (normalized.length <= limit)
            return normalized;

        return `${normalized.slice(0, limit - 1)}…`;
    }

    _formatTimestamp(ts) {
        const value = Number(ts ?? 0);
        if (!Number.isFinite(value) || value <= 0)
            return 'Unknown time';

        try {
            const dateTime = GLib.DateTime.new_from_unix_local(Math.floor(value / 1000));
            return dateTime.format('%Y-%m-%d %H:%M');
        } catch (_e) {
            return 'Unknown time';
        }
    }

    _clearChildren(container) {
        for (const child of container.get_children())
            child.destroy();
    }

    _roleToSender(role) {
        if (role === 'assistant')
            return this.assistantName;
        if (role === 'user')
            return 'You';
        return 'System';
    }

    _ensureMemoryDir() {
        const dir = GLib.path_get_dirname(this._memoryFilePath);
        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch (e) {
            debugWarn(`GNOME Assistant: Failed to create memory dir ${dir}: ${e.message}`);
        }
    }

    _appendMemoryEntry(entry) {
        this._ensureMemoryDir();

        const line = `${JSON.stringify(entry)}\n`;
        this._memoryWrites = this._memoryWrites.then(() => this._appendMemoryLineAsync(line)).catch(e => {
            debugWarn(`GNOME Assistant: Failed to append memory entry: ${e.message}`);
        });
    }

    async _loadMemoryEntriesAsync() {
        this._ensureMemoryDir();

        await this._memoryWrites;
        const content = await this._readMemoryTextAsync();
        if (!content)
            return [];

        return this._parseMemoryEntries(content);
    }

    _parseMemoryEntries(content) {
        const lines = String(content ?? '').split('\n');
        const entries = [];
        for (const line of lines) {
            const raw = line.trim();
            if (!raw)
                continue;

            try {
                const parsed = JSON.parse(raw);
                const role = String(parsed.role ?? '').trim();
                const message = String(parsed.content ?? '').trim();
                const attachments = Array.isArray(parsed.attachments)
                    ? parsed.attachments.slice(0, MAX_ATTACHMENTS_PER_TURN).map(attachmentMetadata).filter(Boolean) : [];
                const a2ui = this._readA2uiSnapshot(parsed.a2ui);
                if (parsed.type === 'a2ui_state') {
                    const target = entries.findLast(entry => entry.role === 'assistant' &&
                        entry.sessionId === parsed.sessionId && entry.connection === parsed.connection);
                    if (target && a2ui !== undefined) {
                        target.a2ui = a2ui;
                        target.ts = Number(parsed.ts ?? target.ts);
                    }
                    continue;
                }
                if (!role || (!message && !attachments.length && a2ui === undefined))
                    continue;

                entries.push({
                    role,
                    content: message,
                    ts: Number(parsed.ts ?? 0),
                    sessionId: String(parsed.sessionId ?? ''),
                    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
                    connection: typeof parsed.connection === 'string' ? parsed.connection : null,
                    profile: typeof parsed.profile === 'string' ? parsed.profile : null,
                    localCwd: typeof parsed.localCwd === 'string' ? parsed.localCwd : null,
                    remote: parsed.remote === true,
                    resumable: parsed.resumable === true,
                    attachments,
                    a2ui,
                });
            } catch (_e) {
                // Ignore malformed lines.
            }
        }

        return entries;
    }

    _readMemoryTextAsync() {
        const file = Gio.File.new_for_path(this._memoryFilePath);
        return new Promise(resolve => {
            file.load_contents_async(null, (source, result) => {
                try {
                    const [, contents] = source.load_contents_finish(result);
                    resolve(new TextDecoder().decode(contents));
                } catch (_error) {
                    resolve('');
                }
            });
        });
    }

    _appendMemoryLineAsync(line) {
        const file = Gio.File.new_for_path(this._memoryFilePath);
        const bytes = new GLib.Bytes(new TextEncoder().encode(line));

        return new Promise((resolve, reject) => {
            file.append_to_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null, (src, result) => {
                let stream = null;
                try {
                    stream = src.append_to_finish(result);
                } catch (e) {
                    reject(e);
                    return;
                }

                stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, (_stream, writeResult) => {
                    try {
                        if (stream.write_bytes_finish(writeResult) !== bytes.get_size())
                            throw new Error('Incomplete history write');
                    } catch (e) {
                        stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
                        reject(e);
                        return;
                    }

                    stream.close_async(GLib.PRIORITY_DEFAULT, null, () => {
                        resolve();
                    });
                });
            });
        });
    }

    _isPersistentMemoryEnabled() {
        return this._getSettingBoolean('memory-enabled', true);
    }

    _getSettingBoolean(key, fallback) {
        if (!this._settings)
            return fallback;

        try {
            return getBoolean(this._settings, key, fallback);
        } catch (_e) {
            return fallback;
        }
    }
});
