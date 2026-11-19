export function nativeCommandInput(prompt, commands = []) {
    const match = /^\$([\w-]+(?::[\w-]+)*)(?=\s|$)/u.exec(prompt);
    if (!match)
        return prompt;

    const name = match[1].replace(/^native:/, '');
    if (!commands.some(command => command.name === name))
        throw new Error('The connected agent has not advertised this command: ' + name);
    return '/' + name + prompt.slice(match[0].length);
}
