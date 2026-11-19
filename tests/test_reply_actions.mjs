// Path links, snippet names and line diffs used by actionable replies.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source = await readFile(new URL('../replyActions.js', import.meta.url), 'utf8');
const {PathLinks, diffLines, formatUnifiedDiff, isOpenableLocation, parsePathCandidate, resolvePath, snippetName,
    unifiedDiff} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const files = new Map([
    ['/home/user/project/src/main.py', 'file'],
    ['/home/user/project/README.md', 'file'],
    ['/home/user/project/docs', 'directory'],
    ['/home/user/notes.txt', 'file'],
    ['/etc/hosts', 'file'],
    ['/home/user/My Files/report.pdf', 'file'],
    ['/proc/self/environ', 'file'],
]);
const linker = (options = {}) => {
    const checked = [];
    const links = new PathLinks({cwd: '/home/user/project', home: '/home/user',
        kind: path => {checked.push(path); return files.get(path) ?? null;}, ...options});
    return {links, checked};
};

test('parses absolute, home and relative paths with line suffixes', () => {
    assert.deepEqual(parsePathCandidate('/etc/hosts'), {path: '/etc/hosts', line: null, column: null});
    assert.deepEqual(parsePathCandidate('src/main.py:12'), {path: 'src/main.py', line: 12, column: null});
    assert.deepEqual(parsePathCandidate('~/notes.txt:3:7'), {path: '~/notes.txt', line: 3, column: 7});
    assert.deepEqual(parsePathCandidate('./README.md'), {path: './README.md', line: null, column: null});
    assert.equal(parsePathCandidate('README.md'), null, 'A bare name in running text is not a path');
    assert.equal(parsePathCandidate('README.md', {bare: true}).path, 'README.md');
});

test('rejects URLs, URIs and other non-paths', () => {
    for (const text of ['https://example.com/a/b', 'file:///etc/hosts', 'mailto:me@example.com', 'C:/x/y',
        '//server/share', '/', '~/', '...', '~root/.ssh/id_rsa', 'a\nb/c', ''])
        assert.equal(parsePathCandidate(text, {bare: true}), null, text);
});

test('resolves paths against the working directory and home', () => {
    const where = {cwd: '/home/user/project', home: '/home/user'};
    assert.equal(resolvePath('src/../README.md', where), '/home/user/project/README.md');
    assert.equal(resolvePath('~/notes.txt', where), '/home/user/notes.txt');
    assert.equal(resolvePath('/etc//./hosts', where), '/etc/hosts');
    assert.equal(resolvePath('../../../../etc/hosts', where), '/etc/hosts');
    assert.equal(resolvePath('src/main.py', {cwd: '', home: '/home/user'}), null, 'Relative paths need a working directory');
    assert.equal(isOpenableLocation('/proc/self/environ'), false);
    assert.equal(isOpenableLocation('/devices'), true);
});

test('links only existing paths in running text', () => {
    const {links} = linker();
    const pieces = links.split('See /etc/hosts, src/main.py:12. and/or ~/missing.txt or https://example.com/a/b.');
    assert.deepEqual(pieces.filter(piece => piece.link).map(piece => piece.text), ['/etc/hosts', 'src/main.py:12']);
    assert.equal(pieces.map(piece => piece.text).join(''),
        'See /etc/hosts, src/main.py:12. and/or ~/missing.txt or https://example.com/a/b.', 'Splitting changed the text');
    assert.deepEqual([...links.links.values()].map(link => [link.label, link.path, link.kind, link.line]), [
        ['/etc/hosts', '/etc/hosts', 'file', null],
        ['src/main.py:12', '/home/user/project/src/main.py', 'file', 12],
    ]);
});

test('inline code links bare names, spaces and folders; special locations stay text', () => {
    const {links} = linker();
    assert.equal(links.add('README.md', {bare: true}).path, '/home/user/project/README.md');
    assert.equal(links.add('docs/', {bare: true}).kind, 'directory');
    assert.equal(links.add('~/My Files/report.pdf', {bare: true}).path, '/home/user/My Files/report.pdf');
    assert.equal(links.add('/proc/self/environ', {bare: true}), null);
    assert.equal(links.add('missing.py', {bare: true}), null);
});

test('checks and links are bounded and deduplicated', () => {
    const {links, checked} = linker({maxChecks: 3, maxLinks: 1});
    links.split('/etc/hosts /etc/hosts:2 /a/b /c/d /e/f /home/user/notes.txt');
    assert.equal(links.links.size, 1);
    assert.equal(links.links.get('/etc/hosts').label, '/etc/hosts', 'The first mention names the link');
    assert.deepEqual(checked, ['/etc/hosts', '/a/b', '/c/d'], 'Paths were checked twice or past the limit');
});

test('remote agents get no links', () => {
    // The view passes no linker for remote agents; a linker without a working
    // directory or home still refuses relative paths.
    const links = new PathLinks({kind: () => 'file'});
    assert.equal(links.add('src/main.py'), null);
    assert.equal(links.add('~/notes.txt'), null);
});

test('suggests snippet names from the code block language', () => {
    assert.equal(snippetName('python'), 'snippet.py');
    assert.equal(snippetName('Bash'), 'snippet.sh');
    assert.equal(snippetName('js title="x"'), 'snippet.js');
    assert.equal(snippetName(''), 'snippet.txt');
    assert.equal(snippetName('../../evil'), 'snippet.txt');
});

test('produces a unified diff with context', () => {
    const before = Array.from({length: 20}, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[4] = 'changed 5';
    after.splice(15, 1);
    after.push('line 21');
    const diff = unifiedDiff(before.join('\n') + '\n', after.join('\n') + '\n');
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 2);
    assert.equal(formatUnifiedDiff(diff), [
        '@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+changed 5', ' line 6', ' line 7', ' line 8',
        '@@ -13,8 +13,8 @@', ' line 13', ' line 14', ' line 15', '-line 16', ' line 17', ' line 18', ' line 19', ' line 20',
        '+line 21',
    ].join('\n'));
});

test('diffs new files, deletions and identical text', () => {
    assert.equal(formatUnifiedDiff(unifiedDiff(null, 'a\nb\n')), '@@ -0,0 +1,2 @@\n+a\n+b');
    assert.equal(unifiedDiff(null, 'a').newFile, true);
    assert.equal(formatUnifiedDiff(unifiedDiff('a\nb\n', '')), '@@ -1,2 +0,0 @@\n-a\n-b');
    assert.equal(formatUnifiedDiff(unifiedDiff('same\n', 'same\n')), 'No changes');
});

test('the diff is minimal and reproduces the new text', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
        const a = Array.from({length: Math.floor(random() * 12)}, () => 'abc'[Math.floor(random() * 3)]);
        const b = Array.from({length: Math.floor(random() * 12)}, () => 'abc'[Math.floor(random() * 3)]);
        const ops = diffLines(a, b);
        assert.deepEqual(ops.filter(op => op.type !== '+').map(op => op.text), a);
        assert.deepEqual(ops.filter(op => op.type !== '-').map(op => op.text), b);
        // Minimal: the kept lines form a longest common subsequence.
        const lcs = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
        for (let i = a.length - 1; i >= 0; i--)
            for (let j = b.length - 1; j >= 0; j--)
                lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        assert.equal(ops.filter(op => op.type === ' ').length, lcs[0][0], JSON.stringify({a, b}));
    }
});

test('huge rewrites fall back to a summary', () => {
    const before = Array.from({length: 5000}, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({length: 4000}, (_, index) => `new ${index}`).join('\n');
    const diff = unifiedDiff(before, after, {maxSteps: 10000});
    assert.equal(diff.replaced, true);
    assert.match(formatUnifiedDiff(diff), /^File replaced: 5000 lines removed, 4000 lines added/);
    // A small edit in a large file stays cheap thanks to prefix/suffix trimming.
    const large = Array.from({length: 100000}, (_, index) => `row ${index}`);
    const edited = [...large];
    edited[50000] = 'edited';
    assert.equal(unifiedDiff(large.join('\n'), edited.join('\n'), {maxSteps: 100}).hunks.length, 1);
});
