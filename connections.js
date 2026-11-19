import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {AcpClient} from './acpClient.js';
import {getString} from './settingsAccess.js';

export function readProfiles(settings) {
    try {
        return JSON.parse(getString(settings, 'acp-profiles', '[]')).filter(profile =>
            typeof profile.id === 'string' && ['local', 'ssh'].includes(profile.transport));
    } catch (_error) {
        return [];
    }
}

export function activeProfile(settings) {
    return readProfiles(settings).find(profile => profile.id === getString(settings, 'acp-profile'));
}

export function connectionKey(profile, cwd) {
    return JSON.stringify([profile.id, profile.transport, profile.host, profile.command, cwd]);
}

export class ProfileClient extends AcpClient {
    constructor(profile, cwd, port, handlers) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
        });
        const [valid, command] = GLib.shell_parse_argv(profile.command);
        if (!valid || !command.length)
            throw new Error('Set an ACP launch command in Preferences.');
        let argv = command;
        if (profile.transport === 'ssh') {
            if (!/^(?:[\w.-]+@)?(?:[\w.-]+|\[[0-9a-fA-F:]+\])$/.test(profile.host) || profile.host.startsWith('-'))
                throw new Error('Enter an SSH host alias, hostname, or user@host.');
            const remote = "cd " + GLib.shell_quote(cwd) + ' && exec ' + command.map(GLib.shell_quote).join(' ');
            argv = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ExitOnForwardFailure=yes',
                '-o', 'ConnectTimeout=10'];
            if (port)
                argv.push('-R', `127.0.0.1:${port}:127.0.0.1:${port}`);
            argv.push('--', profile.host, remote);
        } else {
            launcher.set_cwd(cwd);
        }
        super(launcher, argv, cwd, profile.name || 'ACP agent', handlers);
    }
}
