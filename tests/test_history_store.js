// History search, titles and pins, and Markdown export, in a temporary directory.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {buildHistoryIndex, conversationMarkdown, exportFileName, highlightSegments, historySnippet, loadHistoryMeta,
    normalizeSearchText, parseHistoryMeta, readHistoryMeta, removeHistoryMeta, searchHistory, searchTerms,
    updateHistoryMeta, writeTextFile} from '../historyStore.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const root = GLib.dir_make_tmp('gnome-assistant-history-XXXXXX');
const metaFile = Gio.File.new_for_path(root + '/state/history-meta.json');
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const marked = segments => segments.map(({text, match}) => match ? `[${text}]` : text).join('');

const session = (id, title, latestTs, contents) => ({id, title, latestTs, preview: '',
    entries: contents.map((content, index) => ({role: index % 2 ? 'assistant' : 'user', content, ts: latestTs - 10 + index}))});
const sessions = [
    session('new', 'Plan a trip to Zürich', 300, ['Plan a trip to Zürich', 'Visit the old town and the lake.']),
    session('old', 'Résumé help', 100, ['Résumé help', 'List your experience first, then your café job.']),
    session(JSON.stringify(['conn', 'mid']), 'Fix the build', 200, ['Fix the build', 'The Café build passes now.']),
];

async function main() {
    // Normalization: case, accents and compatibility forms.
    assert(normalizeSearchText('Ça Fait Résumé ﬁ ΟΔΟΣ') === 'ca fait resume fi οδοσ', 'Normalization differs');
    assert(JSON.stringify(searchTerms('  CAFÉ   build ')) === '["cafe","build"]', 'Query terms differ');
    assert(marked(highlightSegments('Ein Café in Zürich', searchTerms('cafe zurich'))) === 'Ein [Café] in [Zürich]',
        'Highlighting lost the original accents');
    assert(marked(highlightSegments('été', ['ete'])) === '[été]', 'Combining marks were not highlighted');

    // Search: every term must match; pins first, then title matches, then recency.
    const index = buildHistoryIndex(sessions);
    const ids = query => searchHistory(index, query).map(result => result.item.session.id);
    assert(JSON.stringify(ids('')) === JSON.stringify(['new', sessions[2].id, 'old']), 'Unfiltered order is not newest first');
    assert(JSON.stringify(ids('CAFE')) === JSON.stringify([sessions[2].id, 'old']), 'Accent-insensitive search failed');
    assert(JSON.stringify(ids('resume')) === '["old"]', 'Title search failed');
    assert(JSON.stringify(ids('cafe job')) === '["old"]', 'All terms are not required');
    assert(ids('nothing here').length === 0, 'A missing term matched');
    assert(JSON.stringify(ids('build')) === JSON.stringify([sessions[2].id]), 'Search matched the wrong conversation');
    const titleFirst = buildHistoryIndex([session('a', 'Notes', 500, ['Notes', 'About the lake']),
        session('b', 'Lake walk', 100, ['Lake walk', 'Sunny'])]);
    assert(searchHistory(titleFirst, 'lake')[0].item.session.id === 'b', 'A title match did not rank first');
    const snippet = historySnippet(index.find(item => item.session.id === 'old'), searchTerms('cafe'));
    assert(marked(snippet).includes('your [café] job'), 'Snippet does not show the match: ' + marked(snippet));
    assert(historySnippet(index[0], searchTerms('zurich')) === null, 'A title match showed a message snippet');
    const long = buildHistoryIndex([session('long', 'Long', 1, ['x', 'word '.repeat(200) + 'needle ' + 'tail '.repeat(200)])]);
    const longSnippet = marked(historySnippet(long[0], ['needle']));
    assert(longSnippet.startsWith('…') && longSnippet.endsWith('…') && longSnippet.includes('[needle]') &&
        longSnippet.length < 220, 'Long snippet is not trimmed around the match');

    // A few thousand messages stay fast once indexed.
    const many = Array.from({length: 2000}, (_, number) => session(`s${number}`, `Conversation ${number}`, number,
        Array.from({length: 4}, (_, turn) => `Message ${turn} of conversation ${number} about résumés and lakes. `.repeat(8))));
    const started = GLib.get_monotonic_time();
    const bigIndex = buildHistoryIndex(many);
    const indexed = GLib.get_monotonic_time();
    for (const query of ['r', 're', 'res', 'resu', 'resum', 'resume', 'resume 1999'])
        searchHistory(bigIndex, query);
    const searched = GLib.get_monotonic_time();
    assert(searchHistory(bigIndex, 'resume 1999').length === 1, 'Large index search failed');
    print(`Indexed 8000 messages in ${(indexed - started) / 1000} ms; 7 searches in ${(searched - indexed) / 1000} ms`);
    assert((searched - indexed) / 7 < 100000, 'Searching a large history is too slow');

    // Metadata: missing and corrupt files are tolerated; writes are atomic and private.
    assert(Object.keys(readHistoryMeta(metaFile).conversations).length === 0, 'Missing metadata was not empty');
    assert(Object.keys((await loadHistoryMeta(metaFile)).conversations).length === 0, 'Missing metadata did not load');
    GLib.mkdir_with_parents(root + '/state', 0o700);
    GLib.file_set_contents(metaFile.get_path(), '{"conversations": {"new": {"title": "Trip", "pinned"');
    assert(Object.keys(readHistoryMeta(metaFile).conversations).length === 0, 'Corrupt metadata was not ignored');
    assert(Object.keys(parseHistoryMeta('[1,2]').conversations).length === 0, 'Unexpected metadata shape was accepted');
    const odd = parseHistoryMeta(JSON.stringify({conversations: {a: {title: 5, pinned: 'yes'}, b: {title: '  Two\n words '}}}));
    assert(JSON.stringify(odd.conversations) === '{"b":{"title":"Two words"}}', 'Invalid metadata values were kept');
    updateHistoryMeta('new', {title: '  Summer   trip '}, {file: metaFile});
    updateHistoryMeta('old', {pinned: true}, {file: metaFile});
    const saved = JSON.parse(read(metaFile.get_path()));
    assert(saved.version === 1 && saved.conversations.new.title === 'Summer trip' && saved.conversations.old.pinned === true,
        'Metadata was not saved: ' + JSON.stringify(saved));
    const mode = metaFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
    assert((mode & 0o777) === 0o600, 'Metadata is not private: ' + (mode & 0o777).toString(8));
    const leftovers = [];
    const children = metaFile.get_parent().enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = children.next_file(null));)
        leftovers.push(info.get_name());
    assert(JSON.stringify(leftovers) === '["history-meta.json"]', 'Atomic write left temporary files: ' + leftovers);
    const meta = await loadHistoryMeta(metaFile);
    const titled = buildHistoryIndex(sessions, meta);
    assert(titled.find(item => item.session.id === 'new').title === 'Summer trip', 'Custom title was not applied');
    assert(searchHistory(titled, '')[0].item.session.id === 'old', 'Pinned conversation does not sort first');
    assert(searchHistory(titled, 'summer')[0]?.item.session.id === 'new', 'Custom titles are not searchable');
    updateHistoryMeta('new', {title: ''}, {file: metaFile});
    assert(!readHistoryMeta(metaFile).conversations.new, 'Clearing a title did not restore the automatic one');
    updateHistoryMeta('gone', {pinned: true}, {file: metaFile});
    updateHistoryMeta('old', {pinned: true}, {file: metaFile, knownKeys: new Set(['old'])});
    assert(JSON.stringify(Object.keys(readHistoryMeta(metaFile).conversations)) === '["old"]', 'Deleted conversations kept metadata');
    updateHistoryMeta('old', {pinned: false}, {file: metaFile});
    assert(!metaFile.query_exists(null), 'Empty metadata left a file behind');
    updateHistoryMeta('old', {pinned: true}, {file: metaFile});
    removeHistoryMeta(metaFile);
    removeHistoryMeta(metaFile);
    assert(!metaFile.query_exists(null), 'Clearing did not remove the metadata');

    // Markdown export.
    assert(exportFileName('Plan: a/b "trip"?') === 'Plan a b trip.md', 'File name was not sanitized: ' + exportFileName('Plan: a/b "trip"?'));
    assert(exportFileName('  ...  ') === 'Conversation.md' && exportFileName('Long title…') === 'Long title.md',
        'Empty or shortened titles produced bad file names');
    assert([...exportFileName('é'.repeat(300))].length === 83, 'Long file names were not shortened');
    const ui = [{version: 'v0.9', createSurface: {surfaceId: 'form', dataModel: {}}}];
    const markdown = conversationMarkdown({
        title: 'Trip plan', assistantName: 'Helper', agentName: 'Local agent', formatTime: ts => `T${ts}`,
        entries: [
            {role: 'user', content: 'Plan my trip', ts: 1000, attachments: [{name: 'notes.txt', size: 2048}]},
            {role: 'assistant', content: 'Here is a **plan**.', ts: 2000, a2ui: ui},
            {role: 'user', content: 'Thanks', ts: 3000},
            {role: 'assistant', content: '', ts: 4000, a2ui: ui},
        ],
    });
    const expected = `# Trip plan

- **Date:** T1000
- **Agent:** Local agent

### You

Plan my trip

Attachments:

- notes.txt (${GLib.format_size(2048)})

### Helper

Here is a **plan**.

> *Interactive interface (“form”) shown here; it is not included in this export.*

### You

Thanks

### Helper

> *Interactive interface (“form”) shown here; it is not included in this export.*
`;
    assert(markdown === expected, 'Markdown export differs:\n' + markdown);
    const exported = root + '/export.md';
    GLib.file_set_contents(exported, 'old');
    await writeTextFile(exported, markdown);
    assert(read(exported) === markdown, 'Export was not written');
}

const loop = new GLib.MainLoop(null, false);
let failure = null;
main().catch(error => {failure = error;}).finally(() => {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
    loop.quit();
});
loop.run();
if (failure) {
    printerr(failure.stack ? `${failure}\n${failure.stack}` : failure);
    imports.system.exit(1);
}
print('HISTORY STORE TEST PASSED');
