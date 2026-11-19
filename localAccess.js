import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const helper = Gio.File.new_for_uri(import.meta.url).get_parent();

export async function communicate(argv, input = null, cancellable = null) {
    const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    try {
        return await new Promise((resolve, reject) => {
            process.communicate_utf8_async(input, cancellable, (source, result) => {
                try {
                    const [, output] = source.communicate_utf8_finish(result);
                    if (!source.get_successful())
                        throw new Error(`${GLib.path_get_basename(argv[0])} exited unsuccessfully.`);
                    resolve(output);
                } catch (error) {
                    reject(error);
                }
            });
        });
    } finally {
        if (cancellable?.is_cancelled())
            process.force_exit();
    }
}

// File pickers go through the desktop portal, which GNOME serves with the
// Files picker. The GTK helper remains a fallback when no portal is running.
const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PICKERS = {
    open: {title: 'Attach a file', accept: 'Attach'},
    folder: {title: 'Share a local folder', accept: 'Share', directory: true},
    save: {title: 'Download attachment', save: true},
    'save-code': {title: 'Save code', save: true},
    export: {title: 'Export conversation', save: true},
    'reference-file': {title: 'Reference a file', accept: 'Reference'},
    'reference-folder': {title: 'Reference a folder', accept: 'Reference', directory: true},
};
const PORTAL_MISSING = ['org.freedesktop.DBus.Error.ServiceUnknown', 'org.freedesktop.DBus.Error.UnknownMethod',
    'org.freedesktop.DBus.Error.UnknownInterface', 'org.freedesktop.DBus.Error.UnknownObject',
    'org.freedesktop.DBus.Error.NameHasNoOwner'];

function portalChoose(action, filename, bus) {
    const picker = PICKERS[action] ?? PICKERS.open;
    // The portal answers with a Response signal on a Request object whose
    // path it derives from our bus name and this token. Subscribe before
    // calling, so a fast answer cannot be missed.
    const token = 'gnome_assistant_' + GLib.uuid_string_random().replace(/-/g, '');
    const sender = bus.get_unique_name().slice(1).replace(/\./g, '_');
    let requestPath = `${PORTAL_PATH}/request/${sender}/${token}`;
    return new Promise((resolve, reject) => {
        let subscription = 0;
        const listen = path => bus.signal_subscribe(null, 'org.freedesktop.portal.Request', 'Response', path, null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _signal, parameters) => {
                bus.signal_unsubscribe(subscription);
                subscription = 0;
                const [response, results] = parameters.recursiveUnpack();
                // 0 is success; 1 means the user cancelled, 2 that it ended otherwise.
                const uri = response === 0 ? results.uris?.[0] : null;
                resolve(uri ? Gio.File.new_for_uri(uri).get_path() : null);
            });
        subscription = listen(requestPath);
        const options = {
            handle_token: new GLib.Variant('s', token),
            modal: new GLib.Variant('b', true),
            ...(picker.accept ? {accept_label: new GLib.Variant('s', picker.accept)} : {}),
            ...(picker.directory ? {directory: new GLib.Variant('b', true)} : {}),
            ...(picker.save && filename ? {current_name: new GLib.Variant('s', filename)} : {}),
        };
        bus.call(PORTAL, PORTAL_PATH, 'org.freedesktop.portal.FileChooser', picker.save ? 'SaveFile' : 'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', picker.title, options]), new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    const [handle] = connection.call_finish(result).deepUnpack();
                    // Old portals ignore handle_token: follow the path they chose.
                    if (handle !== requestPath && subscription) {
                        bus.signal_unsubscribe(subscription);
                        requestPath = handle;
                        subscription = listen(handle);
                    }
                } catch (error) {
                    if (subscription)
                        bus.signal_unsubscribe(subscription);
                    subscription = 0;
                    reject(error);
                }
            });
    });
}

async function helperChoose(action, filename) {
    const output = await communicate(['gjs', '-m', helper.get_child('assistant-file-dialog.js').get_path(), action, filename]);
    return output.trim() ? JSON.parse(output) : null;
}

export async function chooseFile(action, filename = '', {bus = Gio.DBus.session, fallback = helperChoose} = {}) {
    try {
        return await portalChoose(action, filename, bus);
    } catch (error) {
        const name = Gio.DBusError.get_remote_error(error);
        if (!PORTAL_MISSING.includes(name))
            throw error;
        return fallback(action, filename);
    }
}

export async function workspaceOperation(root, operation, path, args = {}, cancellable = null) {
    const output = await communicate(['python3', '-I', helper.get_child('localWorkspace.py').get_path(), root],
        JSON.stringify({operation, path, ...args}), cancellable);
    const {result, error} = JSON.parse(output);
    if (error)
        throw new Error(error);
    return result;
}

export function relativeLocalPath(root, path) {
    if (typeof path !== 'string')
        throw new Error('Choose a path in the shared local folder.');
    if (!GLib.path_is_absolute(path))
        return path;
    if (path === root)
        return '';
    if (!path.startsWith(root + '/'))
        throw new Error('This path is outside the shared local folder.');
    return path.slice(root.length + 1);
}

export async function runLocalCommand(root, command, args, cwd, cancellable) {
    if (!GLib.find_program_in_path('bwrap') || !GLib.find_program_in_path('timeout'))
        throw new Error('Install Bubblewrap and timeout for sandboxed local commands.');
    // Resolve the root and working directory through the same no-symlink checks as file operations.
    await workspaceOperation(root, 'list', cwd, {}, cancellable);
    const argv = ['timeout', '--kill-after=2s', '30s', 'bwrap',
        '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--ro-bind', root, '/workspace', '--chdir', '/workspace' + (cwd ? '/' + cwd : ''),
        '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin', '--',
        command, ...args];
    const process = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const stream = process.get_stdout_pipe();
    const chunks = [];
    let size = 0;
    let truncated = false;
    try {
        while (true) {
            const chunk = await new Promise((resolve, reject) => {
                stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                    try {
                        resolve(source.read_bytes_finish(result).get_data());
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            if (!chunk.length)
                break;
            if (size < 65536) {
                const part = chunk.subarray(0, 65536 - size);
                chunks.push(part);
                size += part.length;
                truncated ||= part.length !== chunk.length;
            } else {
                truncated = true;
            }
        }
        await new Promise((resolve, reject) => {
            process.wait_async(cancellable, (source, result) => {
                try {
                    resolve(source.wait_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
            bytes.set(part, offset);
            offset += part.length;
        }
        return {output: new TextDecoder().decode(bytes) + (truncated ? '\n[Output truncated]' : ''),
            exitCode: process.get_if_exited() ? process.get_exit_status() : null};
    } finally {
        if (cancellable.is_cancelled())
            process.send_signal(15);
        stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }
}
