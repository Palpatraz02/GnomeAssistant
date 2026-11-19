import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {assistantName} from './assistantName.js';
import {approvalNotice, createNotificationSource, indicatorState, plainSummary, showNotification} from './assistantStatus.js';
import {getBoolean} from './settingsAccess.js';

const SHOW_INDICATOR_KEY = 'show-status-indicator';
const PANEL_ROLE = 'gnome-assistant-status';
// The assistant's icon unless stated; stylesheet.css tells the states apart.
const STATES = {
    working: {label: 'Working on a reply…'},
    approval: {label: 'Waiting for your approval'},
    unread: {label: 'Reply ready'},
    failed: {label: 'The reply failed', icon: 'dialog-warning-symbolic'},
};

const AssistantIndicator = GObject.registerClass(
class AssistantIndicator extends PanelMenu.Button {
    _init(gicon, {openChat, stopReply}) {
        super._init(0.5, null);
        this._gicon = gicon;
        this.add_style_class_name('ai-status-indicator');
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.add_style_class_name('ai-status-label');
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Open chat', () => openChat());
        this._stopItem = this.menu.addAction('Stop reply', () => stopReply());
    }

    // Hidden when idle: the overview is the way in then.
    sync(state, name, running) {
        const shown = STATES[state];
        this.visible = Boolean(shown);
        for (const key of Object.keys(STATES))
            this[key === state ? 'add_style_class_name' : 'remove_style_class_name'](`ai-status-${key}`);
        if (!shown) {
            this.menu.close();
            return;
        }
        if (shown.icon)
            this._icon.icon_name = shown.icon;
        else
            this._icon.gicon = this._gicon;
        this._status.label.text = shown.label;
        this.accessible_name = `${name}: ${shown.label}`;
        this._stopItem.visible = running;
    }
});

// Keeps the user informed while the overview is closed: a top-bar indicator
// for the current state, and notifications for finished replies, errors and
// approvals, which can be answered from the notification.
export class BackgroundStatus {
    constructor(view, settings, gicon, openChat) {
        this._view = view;
        this._settings = settings;
        this._gicon = gicon;
        this._openChat = openChat;
        this._unread = null;
        this._replyNotice = null;
        // Approval notifications, by approval id.
        this._approvalNotices = new Map();
        this._viewSignals = [
            view.connect('run-state-changed', () => this._sync()),
            view.connect('reply-finished', (_view, outcome, text) => this._replyFinished(outcome, text)),
            view.connect('approval-requested', (_view, id) => this._approvalRequested(id)),
            view.connect('approval-resolved', (_view, id) => this._withdrawApproval(id)),
            view.connect('notify::mapped', () => {
                if (this._isLookingAtChat())
                    this._markRead();
            }),
        ];
        this._settingsSignals = [
            settings.connect(`changed::${SHOW_INDICATOR_KEY}`, () => this._syncIndicator()),
            settings.connect('changed::assistant-name', () => this._sync()),
        ];
        this._syncIndicator();
    }

    get state() {
        const state = indicatorState({running: this._view.running,
            approvals: this._view.pendingApprovals.length, unread: Boolean(this._unread)});
        return state === 'unread' && this._unread === 'error' ? 'failed' : state;
    }

    _isLookingAtChat() {
        return this._view.mapped;
    }

    _name() {
        return assistantName(this._settings);
    }

    _syncIndicator() {
        const wanted = getBoolean(this._settings, SHOW_INDICATOR_KEY, true);
        if (wanted && !this._indicator) {
            this._indicator = new AssistantIndicator(this._gicon, {
                openChat: () => this._openChat(),
                stopReply: () => this._view.stopReply(),
            });
            Main.panel.addToStatusArea(PANEL_ROLE, this._indicator);
        } else if (!wanted && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._sync();
    }

    _sync() {
        this._indicator?.sync(this.state, this._name(), this._view.running);
    }

    _markRead() {
        this._unread = null;
        this._withdrawReply();
        this._sync();
    }

    _replyFinished(outcome, text) {
        // Stopping is the user's own doing; nothing new to read.
        if (outcome === 'stopped' || this._isLookingAtChat())
            return;
        this._unread = outcome === 'error' ? 'error' : 'reply';
        this._withdrawReply();
        // A notification closes itself once used: forget it first so that
        // opening the chat does not destroy it a second time.
        const forget = () => {
            if (this._replyNotice === notice)
                this._replyNotice = null;
        };
        const notice = this._notify({
            body: plainSummary(text) || (outcome === 'error' ? 'The reply failed.' : 'Reply ready.'),
            onActivate: () => {
                forget();
                this._openChat();
            },
        });
        this._replyNotice = notice;
        notice?.connect('destroy', forget);
        this._sync();
    }

    _approvalRequested(id) {
        if (this._isLookingAtChat())
            return;
        const request = this._view.pendingApprovals.find(item => item.id === id);
        if (!request)
            return;
        const {title, body, reviewable} = approvalNotice(request);
        // As for replies: the resolved approval must not destroy a
        // notification that is already closing after an action.
        const forget = () => {
            if (this._approvalNotices.get(id) === notice)
                this._approvalNotices.delete(id);
        };
        const answer = accepted => () => {
            forget();
            this._view.decideApproval(id, accepted);
        };
        const notice = this._notify({
            title,
            body,
            urgent: true,
            actions: [{label: 'Decline', callback: answer(false)},
                ...(reviewable ? [{label: 'Allow once', callback: answer(true)}] : [])],
            onActivate: () => {
                forget();
                this._openChat();
            },
        });
        if (!notice)
            return;
        this._approvalNotices.set(id, notice);
        notice.connect('destroy', forget);
    }

    _notify(params) {
        try {
            if (!this._source) {
                const source = createNotificationSource(MessageTray, {title: this._name(), icon: this._gicon,
                    iconName: 'dialog-information-symbolic'});
                // The tray destroys a source once its last notification goes.
                source.connect('destroy', () => {
                    if (this._source === source)
                        this._source = null;
                });
                Main.messageTray.add(source);
                this._source = source;
            }
            return showNotification(MessageTray, this._source, {title: this._name(), ...params});
        } catch (error) {
            console.warn(`${this._name()}: Could not show a notification: ${error.message}`);
            return null;
        }
    }

    // Forgetting a notification before destroying it keeps its own destroy
    // handler from acting on it twice.
    _withdrawReply() {
        const notice = this._replyNotice;
        this._replyNotice = null;
        notice?.destroy();
    }

    _withdrawApproval(id) {
        const notice = this._approvalNotices.get(id);
        this._approvalNotices.delete(id);
        notice?.destroy();
    }

    destroy() {
        for (const id of this._viewSignals)
            this._view.disconnect(id);
        for (const id of this._settingsSignals)
            this._settings.disconnect(id);
        this._viewSignals = [];
        this._settingsSignals = [];
        this._indicator?.destroy();
        this._indicator = null;
        // Answering a stale approval would reach a destroyed chat.
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._approvalNotices.clear();
        this._replyNotice = null;
    }
}
