// Search, custom titles, pins and Markdown export for saved conversations.
// Titles and pins live in their own small file so that renaming or pinning
// never rewrites the transcript in chat-history.jsonl.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {stateFile} from './state.js';

export const HISTORY_META_FILE = 'history-meta.json';
const META_VERSION = 1;
export const MAX_CUSTOM_TITLE_CHARS = 120;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;
const MAX_FILE_NAME_CHARS = 80;

export function historyMetaFile() {
    return stateFile(HISTORY_META_FILE);
}

// Case- and accent-insensitive form used on both sides of a search:
// compatibility decomposition, then marks dropped ("Café" and "cafe"
// match, so do "ﬁ" and "fi"). Final sigma is folded so that lowercasing
// a whole string and a single character agree.
export function normalizeSearchText(text) {
    return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
}

export function searchTerms(query) {
    return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

// The normalized text, and for each of its code units the offset of the
// original character it came from, so a match can be shown in the original.
// Stops once `limit` normalized units are mapped.
function normalizeWithOffsets(text, limit = Infinity) {
    let normalized = '';
    const offsets = [];
    let index = 0;
    for (const char of text) {
        if (normalized.length >= limit)
            break;
        const part = char.charCodeAt(0) < 0x80 ? char.toLowerCase() : normalizeSearchText(char);
        for (let i = 0; i < part.length; i++)
            offsets.push(index);
        normalized += part;
        index += char.length;
    }
    return {normalized, offsets};
}

// End offset, in the original text, of the character that produced the
// normalized unit at `position`.
function originalEnd(text, offsets, position) {
    const start = offsets[position];
    return start + (text.codePointAt(start) > 0xffff ? 2 : 1);
}

// The text split into plain and matching parts, for highlighting.
export function highlightSegments(text, terms) {
    text = String(text ?? '');
    if (!terms.length || !text)
        return [{text, match: false}];
    const {normalized, offsets} = normalizeWithOffsets(text);
    const ranges = [];
    for (const term of terms) {
        for (let at = normalized.indexOf(term); at >= 0; at = normalized.indexOf(term, at + term.length))
            ranges.push([offsets[at], originalEnd(text, offsets, at + term.length - 1)]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const segments = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (end <= cursor)
            continue;
        const from = Math.max(start, cursor);
        if (from > cursor)
            segments.push({text: text.slice(cursor, from), match: false});
        segments.push({text: text.slice(from, end), match: true});
        cursor = end;
    }
    if (cursor < text.length)
        segments.push({text: text.slice(cursor), match: false});
    return segments;
}

export function applyHistoryMeta(index, meta) {
    for (const item of index) {
        const info = meta.conversations[item.session.id] ?? {};
        item.customTitle = info.title ?? null;
        item.title = item.customTitle ?? item.session.title;
        item.pinned = info.pinned === true;
        item.normalizedTitle = normalizeSearchText(item.title);
    }
    return index;
}

// Built once each time the history is loaded, so typing in the search entry
// only scans these strings and never reads the file again.
export function buildHistoryIndex(sessions, meta = emptyHistoryMeta()) {
    return applyHistoryMeta(sessions.map(session => ({
        session,
        texts: session.entries.map(entry => normalizeSearchText(entry.content)),
    })), meta);
}

function byPinThenRecency(a, b) {
    return (b.item.pinned - a.item.pinned) || (b.score - a.score) ||
        ((b.item.session.latestTs ?? 0) - (a.item.session.latestTs ?? 0));
}

// Conversations containing every term, in the title or any message. Pinned
// conversations come first, as in the unfiltered list; then title matches
// rank above matches in the text, and newer above older.
export function searchHistory(index, query) {
    const terms = searchTerms(query);
    const results = [];
    const phrase = terms.join(' ');
    for (const item of index) {
        let score = 0;
        let matches = true;
        for (const term of terms) {
            if (item.normalizedTitle.includes(term))
                score += 2;
            else if (!item.texts.some(text => text.includes(term))) {
                matches = false;
                break;
            }
        }
        if (!matches)
            continue;
        if (terms.length > 1 && item.normalizedTitle.includes(phrase))
            score += 2;
        else if (terms.length > 1 && item.texts.some(text => text.includes(phrase)))
            score += 1;
        results.push({item, score});
    }
    return results.sort(byPinThenRecency);
}

// The part of the first message that matches, as highlight segments, or
// null when only the title matches.
export function historySnippet(item, terms) {
    if (!terms.length || terms.every(term => item.normalizedTitle.includes(term)))
        return null;
    for (const [position, text] of item.texts.entries()) {
        const found = terms.map(term => [text.indexOf(term), term]).filter(([at]) => at >= 0)
            .sort((a, b) => a[0] - b[0])[0];
        if (!found)
            continue;
        const content = item.session.entries[position].content;
        const [at, term] = found;
        const {offsets} = normalizeWithOffsets(content, at + term.length);
        if (offsets.length < at + term.length)
            continue;
        const start = offsets[at];
        const end = originalEnd(content, offsets, at + term.length - 1);
        const from = Math.max(0, start - SNIPPET_BEFORE);
        const to = Math.min(content.length, end + SNIPPET_AFTER);
        const segments = highlightSegments(content.slice(from, to), terms)
            .map(segment => ({...segment, text: segment.text.replace(/\s+/g, ' ')}));
        if (from > 0)
            segments.unshift({text: '…', match: false});
        if (to < content.length)
            segments.push({text: '…', match: false});
        return segments;
    }
    return null;
}

export function emptyHistoryMeta() {
    return {version: META_VERSION, conversations: {}};
}

export function normalizeCustomTitle(title) {
    return [...String(title ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_CUSTOM_TITLE_CHARS).join('').trim();
}

// Unknown or damaged content reads as "no titles or pins": the transcript
// itself is unaffected, so the worst case is losing these preferences.
export function parseHistoryMeta(text) {
    const meta = emptyHistoryMeta();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return meta;
    }
    const conversations = parsed?.conversations;
    if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations))
        return meta;
    for (const [key, value] of Object.entries(conversations)) {
        const title = typeof value?.title === 'string' ? normalizeCustomTitle(value.title) : '';
        const info = {...(title ? {title} : {}), ...(value?.pinned === true ? {pinned: true} : {})};
        if (key && Object.keys(info).length)
            meta.conversations[key] = info;
    }
    return meta;
}

export function readHistoryMeta(file = historyMetaFile()) {
    try {
        return parseHistoryMeta(new TextDecoder().decode(file.load_contents(null)[1]));
    } catch {
        return emptyHistoryMeta();
    }
}

export function loadHistoryMeta(file = historyMetaFile()) {
    return new Promise(resolve => {
        file.load_contents_async(null, (source, result) => {
            try {
                resolve(parseHistoryMeta(new TextDecoder().decode(source.load_contents_finish(result)[1])));
            } catch {
                resolve(emptyHistoryMeta());
            }
        });
    });
}

// Written to a temporary file and renamed over the old one, so a crash
// leaves either the previous or the new metadata, never a partial file.
export function writeHistoryMeta(file, meta) {
    if (!Object.keys(meta.conversations).length) {
        removeHistoryMeta(file);
        return;
    }
    GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
    GLib.file_set_contents_full(file.get_path(), new TextEncoder().encode(`${JSON.stringify(meta)}\n`),
        GLib.FileSetContentsFlags.CONSISTENT, 0o600);
    // GLib keeps the mode of a file it replaces; titles stay private.
    file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
}

// Re-reads the file first so a clear from Preferences is respected, and
// drops conversations that are no longer in the history.
export function updateHistoryMeta(key, changes, {file = historyMetaFile(), knownKeys = null} = {}) {
    const meta = readHistoryMeta(file);
    const info = {...meta.conversations[key]};
    if ('title' in changes) {
        const title = normalizeCustomTitle(changes.title);
        if (title)
            info.title = title;
        else
            delete info.title;
    }
    if ('pinned' in changes) {
        if (changes.pinned)
            info.pinned = true;
        else
            delete info.pinned;
    }
    if (Object.keys(info).length)
        meta.conversations[key] = info;
    else
        delete meta.conversations[key];
    if (knownKeys) {
        for (const known of Object.keys(meta.conversations)) {
            if (!knownKeys.has(known))
                delete meta.conversations[known];
        }
    }
    writeHistoryMeta(file, meta);
    return meta;
}

export function removeHistoryMeta(file = historyMetaFile()) {
    try {
        file.delete(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}

// A file name derived from the title, safe on common file systems.
export function exportFileName(title) {
    // Automatic titles end with an ellipsis when shortened; leading dots
    // would hide the file.
    const name = [...String(title ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ').replace(/…$/, '').replace(/^[.\s]+|[.\s]+$/g, '')]
        .slice(0, MAX_FILE_NAME_CHARS).join('').trim();
    return `${name || 'Conversation'}.md`;
}

function surfaceIds(snapshot) {
    return snapshot.map(envelope => envelope?.createSurface?.surfaceId).filter(id => typeof id === 'string');
}

function a2uiNote(snapshot) {
    const ids = surfaceIds(snapshot);
    const names = ids.length ? ` (${ids.map(id => `“${id}”`).join(', ')})` : '';
    return `> *Interactive interface${names} shown here; it is not included in this export.*`;
}

// Markdown for one conversation. Each reply stores the whole current
// interface, so it is noted where it first appears or changes, and on
// replies that consist only of an interface.
export function conversationMarkdown({title, entries, assistantName, agentName = '',
    formatTime = ts => GLib.DateTime.new_from_unix_local(Math.floor(ts / 1000)).format('%Y-%m-%d %H:%M')}) {
    const lines = [`# ${String(title).replace(/\s+/g, ' ').trim() || 'Conversation'}`, ''];
    const firstTs = entries.find(entry => entry.ts > 0)?.ts;
    if (firstTs)
        lines.push(`- **Date:** ${formatTime(firstTs)}`);
    if (agentName)
        lines.push(`- **Agent:** ${agentName}`);
    if (lines.length > 2)
        lines.push('');
    let previousUi = '';
    for (const entry of entries) {
        const speaker = entry.role === 'user' ? 'You' : entry.role === 'assistant' ? assistantName : 'System';
        lines.push(`### ${speaker}`, '');
        const content = String(entry.content ?? '').trim();
        if (content)
            lines.push(content, '');
        if (entry.attachments?.length) {
            lines.push('Attachments:', '');
            for (const attachment of entry.attachments)
                lines.push(`- ${attachment.name}${Number.isFinite(attachment.size) ? ` (${GLib.format_size(attachment.size)})` : ''}`);
            lines.push('');
        }
        if (Array.isArray(entry.a2ui)) {
            const ui = JSON.stringify(entry.a2ui);
            if (entry.a2ui.length && (ui !== previousUi || (!content && !entry.attachments?.length)))
                lines.push(a2uiNote(entry.a2ui), '');
            previousUi = ui;
        }
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

// GIO writes local files to a temporary file and renames it into place, so
// an existing file is only replaced once the export is complete.
export function writeTextFile(path, text) {
    const file = Gio.File.new_for_path(path);
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null, (source, result) => {
            try {
                source.replace_contents_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}
