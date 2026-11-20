// node --test tests/test_commands.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {availableCommands, commandBeingUsed, commandQuery, commandText, matchCommands, nativeCommandInput,
    resolveCommand} from '../commands.js';

// Shaped like what Claude Code and Codex advertise through ACP.
const agent = [
    {name: 'code-review', description: 'Review the current diff', input: {hint: '[low|medium|high]'}},
    {name: 'compact', description: 'Free up context by summarizing the conversation'},
    {name: 'effort', description: "Set the model's effort level", input: {hint: '<low|medium|high>'}},
    {name: '$imagegen', description: 'Generate or edit raster images'},
    {name: '$pdf:pdf', description: 'Read, create, inspect PDF files'},
    {name: 'bad name', description: 'Has a space'},
    {name: '', description: 'Empty'},
];

test('the list holds GNOME Assistant commands and every valid agent command, Codex skills included', () => {
    const names = availableCommands(agent).map(command => command.name);
    assert.deepEqual(names, ['a2ui', 'code-review', 'compact', 'effort', '$imagegen', '$pdf:pdf']);
    assert.deepEqual(availableCommands(null).map(command => command.name), ['a2ui']);
});

test('typing a sigil and part of a name opens the list, ranked', () => {
    assert.deepEqual(commandQuery('/co'), {sigil: '/', query: 'co'});
    assert.deepEqual(commandQuery('$'), {sigil: '$', query: ''});
    assert.equal(commandQuery('/code-review high'), null, 'Arguments closed nothing');
    assert.equal(commandQuery('hello /co'), null);
    const commands = availableCommands(agent);
    assert.deepEqual(matchCommands(commands, 'co').map(c => c.name), ['code-review', 'compact']);
    assert.deepEqual(matchCommands(commands, 'pdf').map(c => c.name), ['$pdf:pdf'], 'Codex skill not found by name');
    assert.deepEqual(matchCommands(commands, 'review').map(c => c.name), ['code-review'], 'Word match missing');
    assert.deepEqual(matchCommands(commands, 'raster').map(c => c.name), ['$imagegen'], 'Description match missing');
    assert.deepEqual(matchCommands(commands, 'effort')[0].name, 'effort');
    assert.equal(matchCommands(commands, '').length, commands.length);
});

test('completion keeps the sigil typed, without doubling a skill\'s own $', () => {
    const [review, , , imagegen] = availableCommands(agent).slice(1);
    assert.equal(commandText(review, '/'), '/code-review');
    assert.equal(commandText(review, '$'), '$code-review');
    assert.equal(commandText(imagegen, '$'), '$imagegen');
    assert.equal(commandText(imagegen, '/'), '/$imagegen');
});

test('messages are sent the standard ACP way: /name and the rest', () => {
    assert.equal(nativeCommandInput('/code-review high', agent), '/code-review high');
    assert.equal(nativeCommandInput('$code-review high', agent), '/code-review high');
    // Codex attaches a skill for "/$imagegen" (checked against Codex itself).
    assert.equal(nativeCommandInput('$imagegen a red fox', agent), '/$imagegen a red fox');
    assert.equal(nativeCommandInput('/$imagegen a red fox', agent), '/$imagegen a red fox');
    assert.equal(nativeCommandInput('/imagegen a red fox', agent), '/$imagegen a red fox');
    assert.equal(nativeCommandInput('$native:compact', agent), '/compact');
    assert.equal(nativeCommandInput('/a2ui plan my week', agent),
        'Display an interactive A2UI interface for this request.\nplan my week');
    assert.equal(nativeCommandInput('$a2ui', agent), 'Display an interactive A2UI interface for this request.\n');
    // Unknown commands, paths and ordinary text are left to the agent.
    assert.equal(nativeCommandInput('/home/me/notes.txt what is this?', agent), '/home/me/notes.txt what is this?');
    assert.equal(nativeCommandInput('$unknown thing', agent), '$unknown thing');
    assert.equal(nativeCommandInput('how much is $5?', agent), 'how much is $5?');
    assert.equal(resolveCommand('/compact', agent).command.name, 'compact');
});

test('while typing arguments, the chosen command is known for its hint', () => {
    assert.equal(commandBeingUsed('/effort ', agent).input.hint, '<low|medium|high>');
    assert.equal(commandBeingUsed('$effort hi', agent).name, 'effort');
    assert.equal(commandBeingUsed('/effort', agent), null, 'Still typing the name');
    assert.equal(commandBeingUsed('/nothing here', agent), null);
});
