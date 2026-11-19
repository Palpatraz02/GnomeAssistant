// What the top-bar indicator and notifications show while the overview is
// closed. Kept free of Shell imports so it can be checked outside the Shell.

export const SUMMARY_CHARS = 120;
// An approval can be given from a notification only when its whole request
// fits in the notification; longer ones are reviewed in the chat.
export const REVIEWABLE_CHARS = 240;

// The most urgent state wins: a waiting approval blocks the agent.
export function indicatorState({running = false, approvals = 0, unread = false} = {}) {
    if (approvals > 0)
        return 'approval';
    if (running)
        return 'working';
    return unread ? 'unread' : 'idle';
}

export function truncateText(text, limit = SUMMARY_CHARS) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length <= limit)
        return value;
    const cut = value.slice(0, limit - 1);
    const space = cut.lastIndexOf(' ');
    return (space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '…';
}

// A short plain-text line for a Markdown reply: its first sentence, or as much
// of it as fits.
export function plainSummary(markdown, limit = SUMMARY_CHARS) {
    const text = String(markdown ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/^\s*(```|~~~).*$/gm, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<((?:https?|file):[^>\s]+)>/g, '$1')
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
        .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' ')
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
        .replace(/\|/g, ' ')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/gm, '$1$2')
        .replace(/\s+/g, ' ')
        .trim();
    const sentence = text.match(/^.*?[.!?…](?=\s|$)/)?.[0] ?? text;
    return truncateText(sentence, limit);
}

// Notification text for an approval request from AiView.pendingApprovals.
// The question is the title: the message tray already names the assistant.
export function approvalNotice({title, details, canAccept}) {
    const full = String(details ?? '').trim();
    const reviewable = Boolean(canAccept && full && full.length <= REVIEWABLE_CHARS);
    const body = reviewable ? full
        : [truncateText(full, SUMMARY_CHARS), 'Open the chat to review the full request.'].filter(Boolean).join('\n');
    return {title, body, reviewable};
}

// GNOME Shell 46 replaced the positional MessageTray constructors and
// Source.showNotification() with property objects and addNotification().
function usesNotificationProperties(MessageTray) {
    return typeof MessageTray.Source.prototype.addNotification === 'function';
}

export function createNotificationSource(MessageTray, {title, icon, iconName}) {
    return usesNotificationProperties(MessageTray)
        ? new MessageTray.Source({title, ...(icon ? {icon} : {iconName})})
        : new MessageTray.Source(title, iconName);
}

// Shows a notification through the message tray, so Do Not Disturb and the
// user's notification settings apply. Actions are [{label, callback}]; they
// are skipped where the Shell has no notification actions, leaving
// onActivate (a click on the notification) as the way in.
export function showNotification(MessageTray, source, {title, body, urgent = false, actions = [], onActivate = null}) {
    const modern = usesNotificationProperties(MessageTray);
    const notification = modern
        ? new MessageTray.Notification({source, title, body})
        : new MessageTray.Notification(source, title, body);
    if (urgent && MessageTray.Urgency?.HIGH !== undefined) {
        if (modern)
            notification.urgency = MessageTray.Urgency.HIGH;
        else
            notification.setUrgency?.(MessageTray.Urgency.HIGH);
    }
    if (typeof notification.addAction === 'function') {
        for (const {label, callback} of actions)
            notification.addAction(label, callback);
    }
    if (onActivate)
        notification.connect('activated', () => onActivate());
    if (modern)
        source.addNotification(notification);
    else
        source.showNotification(notification);
    return notification;
}
