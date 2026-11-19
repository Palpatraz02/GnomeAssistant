import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Folders sent to remote agents travel as one uncompressed tar archive,
// written on the fly while the agent downloads it: nothing is staged on disk.
// The folder is scanned when attached, which fixes the exact archive size
// (sent as Content-Length) and each file's size and modification time. Every
// file is checked again as it is streamed, so the agent receives exactly what
// was attached or a failed transfer, never a mix of old and new contents.

export const MAX_FOLDER_BYTES = 1024 ** 3;
export const MAX_FOLDER_ITEMS = 100000;
const BLOCK = 512;
const ATTRIBUTES = 'standard::name,standard::type,standard::size,standard::symlink-target,' +
    'time::modified,time::modified-usec,unix::mode';
const encoder = new TextEncoder();
const padding = size => (BLOCK - size % BLOCK) % BLOCK;

const io = (start, finish) => new Promise((resolve, reject) => start((source, result) => {
    try {resolve(source[finish](result));} catch (error) {reject(error);}
}));

const stampOf = info =>
    `${info.get_size()}:${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}`;

function writeField(block, offset, length, text) {
    block.set(encoder.encode(text).subarray(0, length), offset);
}

function writeOctal(block, offset, length, value) {
    writeField(block, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

// One ustar header block.
function header({name, mode, size, mtime, type, linkname = ''}) {
    const block = new Uint8Array(BLOCK);
    writeField(block, 0, 100, name);
    writeOctal(block, 100, 8, mode);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    writeOctal(block, 124, 12, size);
    writeOctal(block, 136, 12, mtime);
    writeField(block, 148, 8, '        ');
    writeField(block, 156, 1, type);
    writeField(block, 157, 100, linkname);
    writeField(block, 257, 6, 'ustar\0');
    writeField(block, 263, 2, '00');
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    writeField(block, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
    return block;
}

// ustar fields hold 100 ASCII bytes; PAX records carry longer or non-ASCII names.
const needsPax = text => encoder.encode(text).length > 100 || /[^\x20-\x7e]/.test(text);

function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    const length = encoder.encode(body).length;
    let total = length + String(length).length;
    total = length + String(total).length;
    return encoder.encode(`${total}${body}`);
}

// The header blocks for one entry: an optional PAX header, then ustar.
function entryHeader(rootName, entry) {
    const path = rootName + (entry.rel ? '/' + entry.rel : '') + (entry.kind === 'dir' ? '/' : '');
    const linkname = entry.kind === 'link' ? entry.target : '';
    const records = [
        ...(needsPax(path) ? [paxRecord('path', path)] : []),
        ...(needsPax(linkname) ? [paxRecord('linkpath', linkname)] : []),
    ];
    const type = {file: '0', dir: '5', link: '2'}[entry.kind];
    const ascii = text => text.replace(/[^\x20-\x7e]/g, '_').slice(-99);
    const main = header({name: records.length ? ascii(path) : path, mode: entry.mode, mtime: entry.mtime, type,
        size: entry.kind === 'file' ? entry.size : 0, linkname: needsPax(linkname) ? '' : linkname});
    if (!records.length)
        return main;
    const data = new Uint8Array(records.reduce((sum, record) => sum + record.length, 0));
    records.reduce((offset, record) => (data.set(record, offset), offset + record.length), 0);
    const pax = header({name: ascii(`PaxHeaders/${entry.rel || rootName}`), mode: 0o644, mtime: entry.mtime, type: 'x',
        size: data.length});
    const blocks = new Uint8Array(BLOCK + data.length + padding(data.length) + BLOCK);
    blocks.set(pax, 0);
    blocks.set(data, BLOCK);
    blocks.set(main, blocks.length - BLOCK);
    return blocks;
}

async function children(directory) {
    const enumerator = await io(callback => directory.enumerate_children_async(ATTRIBUTES,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null, callback), 'enumerate_children_finish');
    const infos = [];
    try {
        for (;;) {
            const batch = await io(callback => enumerator.next_files_async(256, GLib.PRIORITY_DEFAULT, null, callback),
                'next_files_finish');
            if (!batch.length)
                break;
            infos.push(...batch);
        }
    } finally {
        enumerator.close(null);
    }
    // A stable order makes archives reproducible.
    return infos.sort((a, b) => a.get_name() < b.get_name() ? -1 : 1);
}

// Scan a folder for streaming. Symlinks are stored as links, never followed,
// so nothing outside the folder is included; sockets, devices, pipes and
// unreadable folders are skipped and reported.
// exclude(rel, isFolder) returns a reason to leave an item out (such as a
// sensitive file), or null; left-out items are listed in `excluded`.
export async function selectFolder(path, {maxBytes = MAX_FOLDER_BYTES, maxItems = MAX_FOLDER_ITEMS, exclude = null} = {}) {
    const root = Gio.File.new_for_path(path);
    const rootInfo = root.query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (rootInfo.get_file_type() !== Gio.FileType.DIRECTORY)
        throw new Error('Choose a folder.');
    const name = root.get_basename();
    const limit = `${GLib.format_size(maxBytes)} and ${maxItems.toLocaleString('en-US')} items`;
    const entries = [{rel: '', kind: 'dir', mode: rootInfo.get_attribute_uint32('unix::mode') & 0o7777,
        mtime: Number(rootInfo.get_attribute_uint64('time::modified'))}];
    const skipped = [];
    const excluded = [];
    let contentSize = 0;
    const walk = async (directory, rel) => {
        let infos;
        try {
            infos = await children(directory);
        } catch {
            skipped.push(rel + '/');
            return;
        }
        for (const info of infos) {
            const childRel = rel ? `${rel}/${info.get_name()}` : info.get_name();
            const base = {rel: childRel, mode: info.get_attribute_uint32('unix::mode') & 0o7777,
                mtime: Number(info.get_attribute_uint64('time::modified'))};
            const type = info.get_file_type();
            const reason = exclude?.(childRel, type === Gio.FileType.DIRECTORY);
            if (reason) {
                excluded.push({path: childRel, reason});
                continue;
            }
            if (type === Gio.FileType.DIRECTORY) {
                entries.push({...base, kind: 'dir'});
            } else if (type === Gio.FileType.REGULAR) {
                entries.push({...base, kind: 'file', size: info.get_size(), stamp: stampOf(info)});
                contentSize += info.get_size();
            } else if (type === Gio.FileType.SYMBOLIC_LINK) {
                entries.push({...base, kind: 'link', mode: 0o777, target: info.get_symlink_target() ?? ''});
            } else {
                skipped.push(childRel);
                continue;
            }
            if (entries.length > maxItems || contentSize > maxBytes)
                throw new Error(`${name} is too large to send: folders are limited to ${limit}.`);
            if (type === Gio.FileType.DIRECTORY)
                await walk(directory.get_child(info.get_name()), childRel);
        }
    };
    await walk(root, '');
    const size = entries.reduce((sum, entry) => sum + entryHeader(name, entry).length +
        (entry.kind === 'file' ? entry.size + padding(entry.size) : 0), 0) + 2 * BLOCK;
    return {id: GLib.uuid_string_random(), name, path: root.get_path(), folder: true, image: false, size, contentSize,
        files: entries.filter(entry => entry.kind === 'file').length, entries, skipped, excluded};
}

const changed = (record, rel) =>
    Object.assign(new Error(`${record.name}/${rel} changed after the folder was attached. Attach the folder again.`),
        {status: 409});

// Streams the archive, at most `max` bytes per read; null at the end.
export class FolderReader {
    constructor(record, cancellable = null) {
        this.record = record;
        this.cancellable = cancellable;
        this.root = Gio.File.new_for_path(record.path);
        if (this.root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !== Gio.FileType.DIRECTORY)
            throw Object.assign(new Error(`${record.name} is no longer available. Attach it again.`), {status: 410});
        this.index = 0;
        this.pending = null;
        this.stream = null;
        this.ended = false;
    }

    async _openNext() {
        const entry = this.record.entries[this.index++];
        this.pending = entryHeader(this.record.name, entry);
        if (entry.kind !== 'file' || entry.size === 0)
            return;
        const file = this.root.resolve_relative_path(entry.rel);
        let info;
        try {
            info = file.query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch {
            throw changed(this.record, entry.rel);
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR || stampOf(info) !== entry.stamp)
            throw changed(this.record, entry.rel);
        this.stream = await io(callback => file.read_async(GLib.PRIORITY_DEFAULT, this.cancellable, callback), 'read_finish');
        this.entry = entry;
        this.remaining = entry.size;
    }

    // File contents go out as the GBytes GIO read them, without copies in
    // JavaScript; only small pieces (headers, padding, small files) are merged
    // into one chunk, so many small files still make few, large writes.
    async read(max) {
        const pieces = [];
        let total = 0;
        while (total < max) {
            if (this.pending) {
                const piece = this.pending.subarray(0, max - total);
                this.pending = piece.length < this.pending.length ? this.pending.subarray(piece.length) : null;
                pieces.push(piece);
                total += piece.length;
            } else if (this.stream) {
                const bytes = await io(callback => this.stream.read_bytes_async(Math.min(max - total, this.remaining),
                    GLib.PRIORITY_DEFAULT, this.cancellable, callback), 'read_bytes_finish');
                const size = bytes.get_size();
                if (!size)
                    throw changed(this.record, this.entry.rel);
                this.remaining -= size;
                if (this.remaining === 0)
                    this._finishEntry();
                if (!total)
                    return bytes;
                pieces.push(bytes.get_data());
                total += size;
            } else if (this.index < this.record.entries.length) {
                await this._openNext();
            } else if (!this.ended) {
                this.ended = true;
                this.pending = new Uint8Array(2 * BLOCK);
            } else {
                break;
            }
        }
        if (!total)
            return null;
        if (pieces.length === 1)
            return new GLib.Bytes(pieces[0]);
        const chunk = new Uint8Array(total);
        pieces.reduce((offset, piece) => (chunk.set(piece, offset), offset + piece.length), 0);
        return new GLib.Bytes(chunk);
    }

    _finishEntry() {
        this.stream.close(null);
        this.stream = null;
        const after = this.root.resolve_relative_path(this.entry.rel)
            .query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (stampOf(after) !== this.entry.stamp)
            throw changed(this.record, this.entry.rel);
        this.pending = new Uint8Array(padding(this.entry.size));
    }

    close() {
        this.stream?.close(null);
        this.stream = null;
    }
}

// GNU tar archives many small files far faster than FolderReader (about 25x
// on 10,000 files). Its output size cannot be predicted exactly, so the
// download is chunked instead of carrying a Content-Length. Other tar
// implementations take different options, so only GNU tar is used.
let systemTarPath;
export function systemTar() {
    if (systemTarPath !== undefined)
        return systemTarPath;
    systemTarPath = null;
    const path = GLib.find_program_in_path('tar');
    if (path) {
        try {
            // GJS always collects stdout and stderr here.
            const [ok, out] = GLib.spawn_sync(null, [path, '--version'], ['LC_ALL=C'], GLib.SpawnFlags.DEFAULT, null);
            if (ok && /GNU tar/.test(new TextDecoder().decode(out)))
                systemTarPath = path;
        } catch {
            // Fall back to FolderReader.
        }
    }
    return systemTarPath;
}

const MAX_TAR_ERROR = 4096;

// Streams the snapshot through GNU tar. tar gets the exact list of entries
// from the scan, so it never adds anything; every file is checked against the
// snapshot first, and a tar error (such as a file changing while read) fails
// the transfer before the archive is complete.
// Checks every file against the snapshot. Called before a download responds,
// so a changed or removed folder is refused with 409 or 410 rather than
// failing after the response has started.
export function checkFolder(record) {
    const root = Gio.File.new_for_path(record.path);
    if (root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !== Gio.FileType.DIRECTORY)
        throw Object.assign(new Error(`${record.name} is no longer available. Attach it again.`), {status: 410});
    for (const entry of record.entries) {
        if (entry.kind !== 'file')
            continue;
        let info;
        try {
            info = root.resolve_relative_path(entry.rel).query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch {
            throw changed(record, entry.rel);
        }
        if (stampOf(info) !== entry.stamp)
            throw changed(record, entry.rel);
    }
}

export class TarReader {
    static async start(record, tar, cancellable = null, {checked = false} = {}) {
        if (!checked)
            checkFolder(record);
        const root = Gio.File.new_for_path(record.path);
        const reader = new TarReader(record, cancellable);
        // The list goes in a private file, not tar's stdin: GSubprocess pipes
        // block, and a large list written from the main loop would wait for
        // tar while tar waits for us to read its output, freezing the Shell.
        const directory = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnome-assistant']);
        GLib.mkdir_with_parents(directory, 0o700);
        reader.list = Gio.File.new_for_path(GLib.build_filenamev([directory, `tar-list-${GLib.uuid_string_random()}`]));
        const names = record.entries.map(entry => record.name + (entry.rel ? '/' + entry.rel : '')).join('\0') + '\0';
        reader.list.replace_contents(encoder.encode(names), null, false, Gio.FileCreateFlags.PRIVATE, null);
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
        launcher.set_cwd(root.get_parent().get_path());
        launcher.setenv('LC_ALL', 'C', true);
        try {
            reader.process = launcher.spawnv([tar, '--create', '--file=-', '--no-recursion', '--null', '--verbatim-files-from',
                `--files-from=${reader.list.get_path()}`, '--owner=0', '--group=0', '--numeric-owner']);
        } catch (error) {
            reader._removeList();
            throw error;
        }
        reader.process.wait_async(null, () => reader._removeList());
        reader._collectErrors();
        return reader;
    }

    constructor(record, cancellable) {
        this.record = record;
        this.cancellable = cancellable;
        this.errors = '';
    }

    _removeList() {
        try {
            this.list?.delete(null);
        } catch {
            // Already removed.
        }
        this.list = null;
    }

    async _collectErrors() {
        const stderr = this.process.get_stderr_pipe();
        try {
            for (;;) {
                const bytes = await io(callback => stderr.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, callback),
                    'read_bytes_finish');
                if (!bytes.get_size())
                    break;
                if (this.errors.length < MAX_TAR_ERROR)
                    this.errors += new TextDecoder().decode(bytes.get_data()).slice(0, MAX_TAR_ERROR - this.errors.length);
            }
        } catch {
            // The process was stopped.
        }
    }

    async read(max) {
        const bytes = await io(callback => this.process.get_stdout_pipe().read_bytes_async(max, GLib.PRIORITY_DEFAULT,
            this.cancellable, callback), 'read_bytes_finish');
        if (bytes.get_size())
            return bytes;
        // The archive is complete only if tar succeeded.
        await io(callback => this.process.wait_async(this.cancellable, callback), 'wait_finish');
        if (!this.process.get_successful()) {
            const reason = this.errors.trim().split('\n').pop()?.replace(/^tar: /, '') ?? '';
            throw Object.assign(new Error(`${this.record.name} could not be archived${reason ? `: ${reason}` : ''}. ` +
                'If it changed after it was attached, attach it again.'), {status: 409});
        }
        return null;
    }

    close() {
        // The identifier is null once tar has exited.
        if (this.process?.get_identifier())
            this.process.force_exit();
    }
}
