// Finds secrets in text sent to the agent, so they can be redacted first.
// Precise rules recognise well-known token formats; assignment rules
// (password=…, api_key: …) only fire for values that look like real secrets,
// not code, types or placeholders. No GNOME imports: tested with node.

const placeholder = label => `[redacted ${label}]`;

// Specific formats, most specific first. `group` redacts only that part.
const RULES = [
    {label: 'private key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g},
    {label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g},
    {label: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g},
    {label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g},
    {label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g},
    {label: 'Slack token', pattern: /\bxox[abprsoe]-[A-Za-z0-9-]{10,}/g},
    {label: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g},
    {label: 'AWS access key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g},
    {label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g},
    {label: 'Google OAuth secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}/g},
    {label: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g},
    {label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g},
    {label: 'PyPI token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g},
    {label: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{34,}\b/g},
    {label: 'DigitalOcean token', pattern: /\bdo[opr]_v1_[a-f0-9]{64}\b/g},
    {label: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g},
    {label: 'password in URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, group: 1},
    {label: 'authorization token', pattern: /\b(?:Proxy-)?Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Bot)\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1},
];

// key = value, key: value, "key": "value", KEY=value (env files).
const ASSIGNMENT = /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*?(password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?))["']?[ \t]*[:=][ \t]*(["']?)([^\s"'`,;]+)\3/gi;
const NOT_VALUES = new Set(['string', 'str', 'number', 'int', 'integer', 'boolean', 'bool', 'null', 'none', 'nil',
    'true', 'false', 'undefined', 'required', 'optional', 'password', 'secret', 'token', 'self', 'this', 'env', 'text',
    'hidden', 'redacted', 'masked', 'example', 'changeme', 'placeholder', 'default', 'empty', 'unknown', 'any', 'object']);

// Shannon entropy in bits per character: random keys are high, words low.
export function entropy(text) {
    const counts = new Map();
    for (const character of text)
        counts.set(character, (counts.get(character) ?? 0) + 1);
    const length = [...text].length;
    return [...counts.values()].reduce((sum, count) => sum - count / length * Math.log2(count / length), 0);
}

function secretValue(value, keyword) {
    const bare = value.toLowerCase();
    if (NOT_VALUES.has(bare) || /^[*xX.•_-]+$/.test(value) || /[([{}<>$%]|\.\.\./.test(value) ||
        /^(?:your|my|<|\$\{|process\.env|os\.environ|getenv|env\.)/i.test(value) || /^https?:\/\//i.test(value))
        return false;
    // Passwords can be short and word-like; keys and tokens are long and random.
    if (/pass|pwd/i.test(keyword))
        return [...value].length >= 6 && entropy(value) >= 2.5;
    return [...value].length >= 16 && entropy(value) >= 3.5;
}

// All findings as {start, end, label}, without overlaps.
export function findSecrets(text) {
    const source = String(text ?? '');
    const found = [];
    for (const {label, pattern, group} of RULES) {
        for (const match of source.matchAll(pattern)) {
            const value = group ? match[group] : match[0];
            const start = match.index + (group ? match[0].indexOf(value) : 0);
            found.push({start, end: start + value.length, label});
        }
    }
    for (const match of source.matchAll(ASSIGNMENT)) {
        const [whole, , keyword, , value] = match;
        if (!secretValue(value, keyword))
            continue;
        const start = match.index + whole.lastIndexOf(value);
        found.push({start, end: start + value.length, label: /pass|pwd/i.test(keyword) ? 'password' : 'secret'});
    }
    // Earlier first; on overlap keep the specific rule (listed first) or the longer match.
    found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const kept = [];
    for (const item of found) {
        const last = kept.at(-1);
        if (last && item.start < last.end)
            continue;
        kept.push(item);
    }
    return kept;
}

export function redactSecrets(text) {
    const source = String(text ?? '');
    const findings = findSecrets(source);
    let result = '';
    let offset = 0;
    for (const {start, end, label} of findings) {
        result += source.slice(offset, start) + placeholder(label);
        offset = end;
    }
    return {text: result + source.slice(offset), findings};
}

// Redact every string inside a JSON-like value; returns a copy and the findings.
export function redactDeep(value) {
    const findings = [];
    const walk = item => {
        if (typeof item === 'string') {
            const {text, findings: found} = redactSecrets(item);
            findings.push(...found);
            return text;
        }
        if (Array.isArray(item))
            return item.map(walk);
        // Plain objects from any realm; byte arrays, Maps and GObjects are left as they are.
        if (item && typeof item === 'object' && Object.prototype.toString.call(item) === '[object Object]' &&
            [Object.prototype, null].includes(Object.getPrototypeOf(Object.getPrototypeOf(item) ?? Object.prototype)))
            return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
        return item;
    };
    return {value: walk(value), findings};
}

// "2 secrets: GitHub token, password" for the interface.
export function describeFindings(findings) {
    const labels = [...new Set(findings.map(finding => finding.label))];
    return `${findings.length} ${findings.length === 1 ? 'possible secret' : 'possible secrets'}: ${labels.join(', ')}`;
}

// A short, safe preview of a finding: "ghp_…a1b2".
export function maskedPreview(text, {start, end}) {
    const value = text.slice(start, end).replace(/\s+/g, ' ');
    return value.length <= 8 ? '•'.repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

// Files whose very purpose is to hold secrets, by name. Returns a label or null.
const SENSITIVE_NAMES = new Map([
    ['.netrc', 'credentials file'], ['_netrc', 'credentials file'], ['.pgpass', 'database passwords'],
    ['.git-credentials', 'Git credentials'], ['.npmrc', 'npm credentials'], ['.pypirc', 'PyPI credentials'],
    ['.htpasswd', 'password file'], ['kubeconfig', 'Kubernetes credentials'], ['wallet.dat', 'wallet'],
    ['id_rsa', 'SSH private key'], ['id_dsa', 'SSH private key'], ['id_ecdsa', 'SSH private key'],
    ['id_ed25519', 'SSH private key'], ['credentials.json', 'credentials file'], ['secrets.yml', 'secrets file'],
    ['secrets.yaml', 'secrets file'], ['secrets.json', 'secrets file'],
]);
const SENSITIVE_EXTENSIONS = new Map([
    ['.pem', 'certificate or key'], ['.key', 'private key'], ['.p12', 'certificate store'], ['.pfx', 'certificate store'],
    ['.jks', 'Java keystore'], ['.keystore', 'keystore'], ['.kdbx', 'password database'], ['.gpg', 'encrypted file'],
    ['.asc', 'key or encrypted file'],
]);

// Folders that exist to hold secrets; their contents have no telling names.
const SENSITIVE_FOLDERS = new Map([['.gnupg', 'GnuPG keys'], ['.password-store', 'password store'], ['.ssh', 'SSH keys']]);
export function sensitiveFolder(path) {
    return SENSITIVE_FOLDERS.get(String(path ?? '').split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '') ?? null;
}

export function sensitiveFile(path) {
    const parts = String(path ?? '').split('/').filter(Boolean);
    const name = parts.at(-1) ?? '';
    const lower = name.toLowerCase();
    const parent = parts.at(-2) ?? '';
    if (SENSITIVE_NAMES.has(lower))
        return SENSITIVE_NAMES.get(lower);
    if (/^\.env(?:\..+)?$/.test(lower) && !/\.(?:example|sample|template|dist|defaults?)$/.test(lower))
        return 'environment secrets';
    if (/^client_secret.*\.json$/.test(lower) || /service[-_]?account.*\.json$/.test(lower))
        return 'service credentials';
    if ((parent === '.aws' && lower === 'credentials') || (parent === '.kube' && lower === 'config') ||
        (parent === '.docker' && lower === 'config.json') || (parent === '.ssh' && /^id_/.test(lower) && !lower.endsWith('.pub')))
        return 'credentials file';
    const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
    return SENSITIVE_EXTENSIONS.get(extension) ?? null;
}

// Boxes to black out in an image, from Tesseract's TSV output (one row per
// word, with its line and position). Words are joined into lines, so tokens
// split by spacing are still found; each finding covers the words it touches.
export function secretBoxesFromTsv(tsv, {padding = 3} = {}) {
    const lines = new Map();
    for (const row of String(tsv ?? '').split('\n').slice(1)) {
        const cells = row.split('\t');
        if (cells.length < 12 || cells[0] !== '5' || !cells[11].trim())
            continue;
        const [, page, block, paragraph, line, , left, top, width, height] = cells.map(Number);
        const key = `${page}.${block}.${paragraph}.${line}`;
        if (!lines.has(key))
            lines.set(key, []);
        lines.get(key).push({text: cells[11], left, top, width, height});
    }
    const boxes = [];
    const findings = [];
    for (const words of lines.values()) {
        let text = '';
        const spans = words.map(word => {
            const start = text.length + (text ? 1 : 0);
            text += (text ? ' ' : '') + word.text;
            return {start, end: text.length, word};
        });
        for (const finding of findSecrets(text)) {
            const touched = spans.filter(span => span.start < finding.end && span.end > finding.start).map(span => span.word);
            if (!touched.length)
                continue;
            const left = Math.min(...touched.map(word => word.left)) - padding;
            const top = Math.min(...touched.map(word => word.top)) - padding;
            const right = Math.max(...touched.map(word => word.left + word.width)) + padding;
            const bottom = Math.max(...touched.map(word => word.top + word.height)) + padding;
            boxes.push({x: Math.max(0, left), y: Math.max(0, top), width: right - Math.max(0, left),
                height: bottom - Math.max(0, top), label: finding.label});
            findings.push(finding);
        }
    }
    return {boxes, findings};
}
