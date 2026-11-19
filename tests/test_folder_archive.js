// The on-the-fly tar archive for folders sent to remote agents, checked by
// extracting it with the system tar.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {FolderReader, selectFolder, systemTar, TarReader} from '../folderArchive.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const run = argv => {
    const [, out, err, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    assert(status === 0, `${argv.join(' ')} failed: ${new TextDecoder().decode(err)}`);
    return new TextDecoder().decode(out);
};
const loop = new GLib.MainLoop(null, false);
const root = GLib.dir_make_tmp('gnome-assistant-folder-XXXXXX');
const project = root + '/thesis';
const longName = 'chapter-' + 'x'.repeat(130) + '.tex';
const write = (path, text) => {GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700); GLib.file_set_contents(path, text);};

// Both implementations: GNU tar when available, and the built-in writer.
const implementations = {
    builtin: async record => new FolderReader(record),
    ...(systemTar() ? {'GNU tar': record => TarReader.start(record, systemTar())} : {}),
};

async function stream(record, chunk = 4096, open = implementations.builtin) {
    const reader = await open(record);
    const parts = [];
    let total = 0;
    try {
        for (let bytes; (bytes = await reader.read(chunk));) {
            const data = bytes.get_data();
            assert(data.length <= chunk, 'A read returned more than requested');
            parts.push(data);
            total += data.length;
        }
    } finally {
        reader.close();
    }
    const archive = new Uint8Array(total);
    parts.reduce((offset, part) => (archive.set(part, offset), offset + part.length), 0);
    return archive;
}

async function main() {
    write(`${project}/main.tex`, '\\documentclass{article}\n');
    write(`${project}/figures/plot data.csv`, 'x,y\n1,2\n');
    write(`${project}/chapters/${longName}`, 'A very long name.\n');
    write(`${project}/notes/été ☕.md`, 'Accents survive.\n');
    write(`${project}/empty.txt`, '');
    GLib.mkdir_with_parents(`${project}/empty-folder`, 0o700);
    const big = new Uint8Array(300000).map((_, index) => index % 251);
    GLib.mkdir_with_parents(`${project}/data`, 0o700);
    GLib.file_set_contents(`${project}/data/blob.bin`, big);
    Gio.File.new_for_path(`${project}/outside`).make_symbolic_link('/etc/hostname', null);
    run(['mkfifo', `${project}/pipe`]);

    const record = await selectFolder(project);
    assert(record.folder && record.name === 'thesis' && record.files === 6, `Unexpected scan: ${record.files} files`);
    assert(JSON.stringify(record.skipped) === '["pipe"]', `Special files were not skipped: ${record.skipped}`);
    for (const [label, open] of Object.entries(implementations)) {
        const archive = await stream(record, 4096, open);
        if (open === implementations.builtin)
            assert(archive.length === record.size, `Archive is ${archive.length} bytes, promised ${record.size}`);
        assert(archive.length % 512 === 0, `${label}: archive is not block aligned`);
        const archivePath = `${root}/${label}.tar`;
        GLib.file_set_contents(archivePath, archive);
        const out = `${root}/out-${label}`;
        GLib.mkdir_with_parents(out, 0o700);
        run(['tar', '-x', '-f', archivePath, '-C', out]);
        run(['diff', '-r', '--no-dereference', '-x', 'pipe', project, `${out}/thesis`]);
        assert(GLib.file_test(`${out}/thesis/empty-folder`, GLib.FileTest.IS_DIR), `${label}: the empty folder is missing`);
        assert(Gio.File.new_for_path(`${out}/thesis/outside`).query_info('standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_symlink_target() === '/etc/hostname',
        `${label}: the symlink was followed instead of stored`);
        const listing = run(['tar', '-t', '-f', archivePath]);
        assert(listing.includes(`thesis/chapters/${longName}`) && listing.includes('thesis/notes/été ☕.md') &&
            !listing.includes('pipe'), `${label}: names were not preserved, or the pipe was included`);
        assert((await stream(record, 256 * 1024, open)).length === archive.length, `${label}: large reads changed the archive`);
        print(`  ${label}: ${archive.length} bytes, extracted identically`);
    }
    if (implementations['GNU tar']) {
        // A file removed after the transfer started fails it, never a short archive.
        const copy = root + '/copy';
        run(['cp', '-a', project, copy]);
        const copied = await selectFolder(copy);
        const reader = await TarReader.start(copied, systemTar());
        GLib.unlink(`${copy}/main.tex`);
        let failed = false;
        try {
            while (await reader.read(4096));
        } catch (error) {
            failed = /could not be archived/.test(error.message);
        } finally {
            reader.close();
        }
        assert(failed, 'GNU tar: a file removed during the transfer did not fail it');
        // A changed file is refused before tar starts.
        GLib.usleep(20000);
        GLib.file_set_contents(`${copy}/empty.txt`, 'now edited');
        let refused = false;
        try {await TarReader.start(copied, systemTar());} catch (error) {refused = error.status === 409;}
        assert(refused, 'GNU tar: a changed folder was not refused');
    }

    // A file edited after attaching stops the transfer.
    GLib.usleep(20000);
    GLib.file_set_contents(`${project}/main.tex`, '\\documentclass{book}\n');
    let refused = false;
    try {await stream(record);} catch (error) {refused = /main\.tex changed/.test(error.message);}
    assert(refused, 'An edited file was streamed');
    run(['rm', '-rf', project + '/data']);
    // Limits apply to the whole folder.
    let limited = 0;
    for (const options of [{maxBytes: 10}, {maxItems: 3}]) {
        try {await selectFolder(project, options);} catch (error) {if (/too large to send/.test(error.message)) limited++;}
    }
    assert(limited === 2, 'Folder limits were not enforced');
    run(['rm', '-rf', project]);
    let gone = false;
    try {new FolderReader(record);} catch (error) {gone = error.status === 410;}
    assert(gone, 'A removed folder was not refused');
    print('FOLDER ARCHIVE TESTS PASSED');
}
let failed = false;
main().catch(error => {printerr(`${error}\n${error.stack}`); failed = true;}).finally(() => {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
    loop.quit();
});
loop.run();
if (failed)
    imports.system.exit(1);
