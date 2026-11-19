// Actionable replies: local path links, code snippet names and line diffs.
// No GNOME imports, so the logic is unit tested with Node; the view supplies
// the file system checks.

const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;
// A bare file name, as in `README.md`, is only accepted where the reply marks
// it as code; in running text a path needs a slash.
const BARE_FILE = /^[\w+@-][\w.+@-]*\.[A-Za-z0-9]{1,12}$/;
// Characters that end a path in running text. Spaces in paths only work in
// inline code, where the whole span is the path.
const TEXT_TOKEN = /[^\s<>"'`()[\]{}|,;]+/g;
const MAX_PATH_CHARS = 4096;
// Kernel and runtime file systems hold devices, sockets and process state,
// none of which a default app should be handed.
const SPECIAL_ROOTS = ['/proc', '/sys', '/dev', '/run'];

// Splits `path:line:column`. A colon anywhere else rejects the text, which
// keeps URLs and other URIs (`https://…`, `file://…`, `mailto:…`) out.
export function parsePathCandidate(raw, {bare = false} = {}) {
    const text = String(raw ?? '').trim();
    if (!text || text.length > MAX_PATH_CHARS || /[\0-\x1f]/.test(text))
        return null;
    const suffix = LINE_SUFFIX.exec(text);
    const path = suffix ? text.slice(0, suffix.index) : text;
    if (!path || path.includes(':') || path.startsWith('//') || !/[^/.~]/.test(path))
        return null;
    // `~user/…` would need a passwd lookup; only the user's own home is meant.
    if (path.startsWith('~') && !path.startsWith('~/'))
        return null;
    if (!path.includes('/') && !(bare && BARE_FILE.test(path)))
        return null;
    return {path, line: suffix ? Number(suffix[1]) : null, column: suffix?.[2] ? Number(suffix[2]) : null};
}

// Lexically resolves `.` and `..`, without following symbolic links.
export function normalizePath(path) {
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '..')
            parts.pop();
        else if (part && part !== '.')
            parts.push(part);
    }
    return '/' + parts.join('/');
}

export function resolvePath(path, {cwd = '', home = ''} = {}) {
    if (path.startsWith('~/'))
        return home.startsWith('/') ? normalizePath(home + path.slice(1)) : null;
    if (path.startsWith('/'))
        return normalizePath(path);
    return cwd?.startsWith('/') ? normalizePath(cwd + '/' + path) : null;
}

export function isOpenableLocation(path) {
    return !SPECIAL_ROOTS.some(root => path === root || path.startsWith(root + '/'));
}

// Collects the paths in one rendered reply. `kind(path)` returns 'file',
// 'directory' or null; only existing paths become links. Checks and links
// are capped, as rendering runs in the Shell's main loop.
export class PathLinks {
    constructor({cwd = '', home = '', kind, maxChecks = 64, maxLinks = 20}) {
        Object.assign(this, {cwd, home, maxChecks, maxLinks});
        this._kind = kind;
        this._kinds = new Map();
        this.links = new Map();
    }

    resolve(text, {bare = false} = {}) {
        const candidate = parsePathCandidate(text, {bare});
        const path = candidate && resolvePath(candidate.path, this);
        if (!path || !isOpenableLocation(path))
            return null;
        if (!this._kinds.has(path)) {
            if (this._kinds.size >= this.maxChecks)
                return null;
            this._kinds.set(path, this._kind(path) ?? null);
        }
        const kind = this._kinds.get(path);
        return kind ? {path, kind, label: String(text).trim(), line: candidate.line, column: candidate.column} : null;
    }

    // Like resolve, and lists the path once among the reply's links.
    add(text, options) {
        const link = this.resolve(text, options);
        if (!link || (!this.links.has(link.path) && this.links.size >= this.maxLinks))
            return null;
        if (!this.links.has(link.path))
            this.links.set(link.path, link);
        return link;
    }

    // Splits running text into pieces, marking the linked paths.
    split(text) {
        const pieces = [];
        let cursor = 0;
        for (const match of text.matchAll(TEXT_TOKEN)) {
            // Sentence punctuation after a path is not part of it.
            const token = match[0].replace(/[.:!?]+$/, '');
            if (!token.includes('/') || !this.add(token))
                continue;
            if (match.index > cursor)
                pieces.push({text: text.slice(cursor, match.index)});
            pieces.push({text: token, link: true});
            cursor = match.index + token.length;
        }
        if (cursor < text.length)
            pieces.push({text: text.slice(cursor)});
        return pieces;
    }
}

const SNIPPET_EXTENSIONS = {
    python: 'py', py: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', fish: 'fish',
    javascript: 'js', js: 'js', mjs: 'mjs', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', rust: 'rs', rs: 'rs',
    go: 'go', java: 'java', kotlin: 'kt', ruby: 'rb', rb: 'rb', php: 'php', sql: 'sql', lua: 'lua',
    perl: 'pl', swift: 'swift', csharp: 'cs', cs: 'cs', vala: 'vala', nix: 'nix', r: 'r',
    markdown: 'md', md: 'md', diff: 'diff', patch: 'patch', csv: 'csv',
};

// The suggested file name for a fenced code block's info string.
export function snippetName(info) {
    const language = String(info ?? '').trim().split(/\s+/)[0].toLowerCase();
    return 'snippet.' + (SNIPPET_EXTENSIONS[language] ?? 'txt');
}

export function splitLines(text) {
    if (!text)
        return [];
    const lines = String(text).split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return lines;
}

// Myers' O((N+M)D) line diff on what is left after trimming the common
// prefix and suffix. Returns null once `maxSteps` is spent, so a huge rewrite
// cannot stall the Shell; callers then summarise the change instead.
export function diffLines(before, after, {maxSteps = 1000000} = {}) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
        start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start &&
        before[before.length - 1 - end] === after[after.length - 1 - end])
        end++;
    const middle = myers(before.slice(start, before.length - end), after.slice(start, after.length - end), maxSteps);
    if (!middle)
        return null;
    const same = text => ({type: ' ', text});
    return [...before.slice(0, start).map(same), ...middle, ...before.slice(before.length - end).map(same)];
}

// The furthest point on diagonal k after d edits comes from k + 1 (an
// insertion) or k - 1 (a deletion); -1 marks points outside the grid.
function previousDiagonal(previous, k, d) {
    const insert = k + 1 <= d - 1 ? previous[k + 1 + d - 1] : -1;
    const remove = k - 1 >= -(d - 1) ? previous[k - 1 + d - 1] : -1;
    return insert >= 0 && (remove < 0 || remove < insert) ? k + 1 : k - 1;
}

function myers(a, b, maxSteps) {
    const n = a.length, m = b.length;
    // trace[d] holds the furthest x for diagonals -d…d, so memory grows with
    // the number of edits, not the file size.
    const trace = [];
    let steps = 0;
    for (let d = 0; d <= n + m; d++) {
        const furthest = new Int32Array(2 * d + 1).fill(-1);
        for (let k = -d; k <= d; k += 2) {
            if (++steps > maxSteps)
                return null;
            let x = 0;
            if (d > 0) {
                const from = previousDiagonal(trace[d - 1], k, d);
                const previous = trace[d - 1][from + d - 1];
                if (previous < 0)
                    continue;
                x = from === k + 1 ? previous : previous + 1;
            }
            let y = x - k;
            if (x > n || y > m || y < 0)
                continue;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
                steps++;
            }
            furthest[k + d] = x;
            if (x === n && y === m) {
                trace.push(furthest);
                return backtrack(trace, a, b);
            }
        }
        trace.push(furthest);
    }
    return null;
}

function backtrack(trace, a, b) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let d = trace.length - 1; d > 0; d--) {
        const k = x - y;
        const from = previousDiagonal(trace[d - 1], k, d);
        const previousX = trace[d - 1][from + d - 1];
        const previousY = previousX - from;
        while (x > previousX && y > previousY) {
            ops.push({type: ' ', text: a[--x]});
            y--;
        }
        if (from === k + 1)
            ops.push({type: '+', text: b[--y]});
        else
            ops.push({type: '-', text: a[--x]});
    }
    while (x > 0 && y > 0) {
        ops.push({type: ' ', text: a[--x]});
        y--;
    }
    return ops.reverse();
}

// A unified diff of one file: hunks of changed lines with `context` lines
// around them. `oldText` null means a new file.
export function unifiedDiff(oldText, newText, {context = 3, maxSteps} = {}) {
    const before = splitLines(oldText), after = splitLines(newText);
    const newFile = oldText === null || oldText === undefined;
    const ops = diffLines(before, after, {maxSteps});
    if (!ops)
        return {replaced: true, newFile, hunks: [], added: after.length, removed: before.length};
    const ranges = [];
    for (let index = 0; index < ops.length; index++) {
        if (ops[index].type === ' ')
            continue;
        const from = Math.max(0, index - context), to = Math.min(ops.length - 1, index + context);
        if (ranges.length && from <= ranges.at(-1)[1] + 1)
            ranges.at(-1)[1] = to;
        else
            ranges.push([from, to]);
    }
    // Line numbers before each operation, for the hunk headers.
    const oldBefore = [], newBefore = [];
    let oldLine = 0, newLine = 0;
    for (const op of ops) {
        oldBefore.push(oldLine);
        newBefore.push(newLine);
        oldLine += op.type === '+' ? 0 : 1;
        newLine += op.type === '-' ? 0 : 1;
    }
    const hunks = ranges.map(([from, to]) => {
        const lines = ops.slice(from, to + 1);
        const oldLines = lines.filter(line => line.type !== '+').length;
        const newLines = lines.filter(line => line.type !== '-').length;
        // As in GNU diff, an empty side names the line before the hunk.
        return {oldStart: oldBefore[from] + (oldLines ? 1 : 0), oldLines,
            newStart: newBefore[from] + (newLines ? 1 : 0), newLines, lines};
    });
    return {replaced: false, newFile, hunks,
        added: ops.filter(op => op.type === '+').length, removed: ops.filter(op => op.type === '-').length};
}

export function hunkHeader(hunk) {
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

export function formatUnifiedDiff(diff) {
    if (diff.replaced)
        return `${diff.newFile ? 'New file' : 'File replaced'}: ${diff.removed} lines removed, ${diff.added} lines added (too large to compare)`;
    if (!diff.hunks.length)
        return 'No changes';
    return diff.hunks.map(hunk => [hunkHeader(hunk), ...hunk.lines.map(line => line.type + line.text)].join('\n')).join('\n');
}
