// Commands in the prompt: those the agent advertises through ACP
// (available_commands_update: name, description, input hint), which include
// skills for agents such as Claude Code and Codex, and GNOME Assistant's own.
// Typed as /name or $name at the start of a message; sent the standard ACP
// way, as /name followed by the rest of the message. No GNOME imports: tested
// with node.

const A2UI_REQUEST = 'Display an interactive A2UI interface for this request.';

// Handled by GNOME Assistant, listed with the agent's commands.
export const LOCAL_COMMANDS = [
    {name: 'a2ui', description: 'Ask for the answer as an interactive interface. Handled by GNOME Assistant.',
        input: {hint: 'request'}, local: true},
];

const MAX_NAME_LENGTH = 100;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH && !/\s/.test(name);
const bare = name => name.replace(/^\$/, '').toLowerCase();

// GNOME Assistant's commands, then the agent's, without duplicates.
export function availableCommands(agentCommands = []) {
    const seen = new Set();
    return [...LOCAL_COMMANDS, ...(Array.isArray(agentCommands) ? agentCommands : [])].filter(command => {
        if (!validName(command?.name) || seen.has(command.name))
            return false;
        seen.add(command.name);
        return true;
    });
}

// The command being typed: "/" or "$" and a partial name, nothing else yet.
export function commandQuery(text) {
    const match = /^([/$])(\S*)$/u.exec(text ?? '');
    return match ? {sigil: match[1], query: match[2]} : null;
}

// Best matches first: the exact name, names starting with the query, a word of
// the name starting with it, the name containing it, then the description.
export function matchCommands(commands, query) {
    const wanted = bare(query.replace(/^native:/, ''));
    const ranked = [];
    for (const command of commands) {
        const name = bare(command.name);
        const description = (command.description ?? '').toLowerCase();
        const rank = !wanted ? 0 : name === wanted ? 0 : name.startsWith(wanted) ? 1
            : name.split(/[:_.-]/).some(word => word.startsWith(wanted)) ? 2
                : name.includes(wanted) ? 3 : description.includes(wanted) ? 4 : -1;
        if (rank >= 0)
            ranked.push({command, rank});
    }
    return ranked.sort((a, b) => a.rank - b.rank || bare(a.command.name).localeCompare(bare(b.command.name)))
        .map(({command}) => command);
}

// What completing a command inserts: with the sigil the user typed, except
// that names carrying their own "$" (Codex skills) are not doubled.
export function commandText(command, sigil = '/') {
    return sigil === '$' && command.name.startsWith('$') ? command.name : sigil + command.name;
}

// The command a message starts with, and the rest of the message.
export function resolveCommand(prompt, agentCommands = []) {
    const match = /^([/$])(\S+)(?=\s|$)/u.exec(prompt ?? '');
    if (!match)
        return null;
    const commands = availableCommands(agentCommands);
    // "$native:name" names the agent's command explicitly.
    const token = match[2].replace(/^native:/, '');
    const candidates = [token, '$' + token];
    const command = commands.find(item => candidates.includes(item.name)) ??
        commands.find(item => candidates.some(name => name.toLowerCase() === item.name.toLowerCase()));
    return command ? {command, rest: prompt.slice(match[0].length)} : null;
}

// The text sent to the agent. Messages that do not start with a known command
// are sent unchanged: the agent may still understand them.
export function nativeCommandInput(prompt, agentCommands = []) {
    const resolved = resolveCommand(prompt, agentCommands);
    if (!resolved)
        return prompt;
    const {command, rest} = resolved;
    if (command.local)
        return A2UI_REQUEST + '\n' + rest.trimStart();
    return '/' + command.name + rest;
}

// While the arguments are typed: the chosen command, to show its hint.
export function commandBeingUsed(prompt, agentCommands = []) {
    if (!/^[/$]\S+\s/u.test(prompt ?? ''))
        return null;
    return resolveCommand(prompt, agentCommands)?.command ?? null;
}
