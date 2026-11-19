// node --test tests/test_secret_scanner.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {describeFindings, entropy, findSecrets, maskedPreview, redactDeep, redactSecrets, sensitiveFile} from '../secretScanner.js';

const labels = text => findSecrets(text).map(finding => finding.label);
// Built at run time so this file does not itself look like it holds secrets.
// A deterministic linear congruential generator: reproducible, yet as varied
// as a real random key.
let state = 0x2545f491;
const random = (alphabet, length) => Array.from({length}, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return alphabet[state % alphabet.length];
}).join('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

test('well-known token formats are found', () => {
    const cases = [
        [`export OPENAI_API_KEY=sk-proj-${random(ALNUM, 40)}`, 'OpenAI API key'],
        [`key: sk-ant-api03-${random(ALNUM, 40)}`, 'Anthropic API key'],
        [`ghp_${random(ALNUM, 36)}`, 'GitHub token'],
        [`github_pat_${random(ALNUM, 30)}_${random(ALNUM, 20)}`, 'GitHub token'],
        [`glpat-${random(ALNUM, 20)}`, 'GitLab token'],
        [`xoxb-${random('0123456789', 12)}-${random(ALNUM, 24)}`, 'Slack token'],
        [`AKIA${random('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`, 'AWS access key'],
        [`AIza${random(ALNUM, 35)}`, 'Google API key'],
        [`sk_live_${random(ALNUM, 24)}`, 'Stripe key'],
        [`hf_${random(ALNUM, 34)}`, 'Hugging Face token'],
        [`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${random(ALNUM, 43)}`, 'JSON web token'],
        ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'private key'],
        ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA (truncated by the terminal)', 'private key'],
    ];
    for (const [text, label] of cases)
        assert.deepEqual(labels(text), [label], text);
});

test('credentials in URLs, headers and assignments are found, value only', () => {
    let result = redactSecrets('git clone https://alice:S3cr3tP4ss@example.com/repo.git');
    assert.equal(result.text, 'git clone https://alice:[redacted password in URL]@example.com/repo.git');
    result = redactSecrets(`curl -H "Authorization: Bearer ${random(ALNUM, 32)}" https://api.example.com`);
    assert.equal(result.text, 'curl -H "Authorization: Bearer [redacted authorization token]" https://api.example.com');
    result = redactSecrets('DB_PASSWORD=Tr0ub4dor&3\nDB_USER=admin');
    assert.equal(result.text, 'DB_PASSWORD=[redacted password]\nDB_USER=admin');
    result = redactSecrets(`{"client_secret": "${random(ALNUM, 32)}", "name": "app"}`);
    assert.equal(result.text, '{"client_secret": "[redacted secret]", "name": "app"}');
    result = redactSecrets(`api_key: '${random(ALNUM, 24)}'`);
    assert.equal(result.text, "api_key: '[redacted secret]'");
});

test('lookalikes are not flagged', () => {
    const benign = [
        'commit 3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291',
        'id 123e4567-e89b-12d3-a456-426614174000',
        'password = request.form["password"]',
        'password: string;',
        'const token = getToken();',
        'api_key=${API_KEY}',
        'PASSWORD=changeme',
        'secret: <your-secret-here>',
        'token = os.environ["TOKEN"]',
        'password: ********',
        'sk-learn is a library',
        'Use the "Authorization" header.',
        'background: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)',
        'integrity sha512-' + 'q'.repeat(10) + random(ALNUM, 60),
        'The secret to good soup is patience.',
        'pk_live_' + random(ALNUM, 24) + ' is a publishable key',
    ];
    for (const text of benign)
        assert.deepEqual(findSecrets(text), [], text);
});

test('several secrets in one text, without overlaps', () => {
    const text = `token=ghp_${random(ALNUM, 36)} and DB_PASSWORD=Tr0ub4dor&3 and AKIA${random('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`;
    const found = findSecrets(text);
    assert.deepEqual(found.map(finding => finding.label), ['GitHub token', 'password', 'AWS access key']);
    for (let i = 1; i < found.length; i++)
        assert.ok(found[i].start >= found[i - 1].end);
    assert.equal(describeFindings(found), '3 possible secrets: GitHub token, password, AWS access key');
    assert.equal(maskedPreview(text, found[0]), 'ghp_…' + text.slice(found[0].end - 2, found[0].end));
});

test('redactDeep covers nested values and keeps everything else', () => {
    const {value, findings} = redactDeep({selection: {content: `export TOKEN=ghp_${random(ALNUM, 36)}`, length: 50},
        events: [{type: 'notification', body: 'Your code is 4711'}], count: 3, flag: true});
    assert.equal(value.selection.content, 'export TOKEN=[redacted GitHub token]');
    assert.equal(value.selection.length, 50);
    assert.equal(value.events[0].body, 'Your code is 4711');
    assert.equal(value.count, 3);
    assert.equal(findings.length, 1);
});

test('entropy separates words from random strings', () => {
    assert.ok(entropy('aaaaaaaa') === 0);
    assert.ok(entropy('password') < 3);
    assert.ok(entropy(random(ALNUM, 32)) > 4);
});

test('sensitive file names', () => {
    for (const [path, expected] of [
        ['/home/u/project/.env', 'environment secrets'], ['/home/u/project/.env.production', 'environment secrets'],
        ['/home/u/project/.env.example', null], ['/home/u/.ssh/id_ed25519', 'SSH private key'],
        ['/home/u/.ssh/id_ed25519.pub', null], ['/home/u/.aws/credentials', 'credentials file'],
        ['/home/u/.kube/config', 'credentials file'], ['/srv/tls/server.key', 'private key'],
        ['/srv/tls/cert.pem', 'certificate or key'], ['/home/u/client_secret_123.json', 'service credentials'],
        ['/home/u/vault.kdbx', 'password database'], ['/home/u/.netrc', 'credentials file'],
        ['/home/u/project/README.md', null], ['/home/u/project/config.json', null], ['/home/u/notes/key-ideas.md', null],
    ])
        assert.equal(sensitiveFile(path), expected, path);
});
