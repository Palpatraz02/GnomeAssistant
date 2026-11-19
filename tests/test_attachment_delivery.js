// Which user attachments are embedded in the prompt and which are streamed
// on request, and that a file changed after attaching is refused.
import GLib from 'gi://GLib';
import {attachedFile, attachmentDelivery, isTextContent, MAX_ATTACHMENT_BYTES, MAX_EMBEDDED_TEXT_BYTES,
    readAttachedBytes, selectAttachment} from '../attachments.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const MiB = 1024 * 1024;
const tools = {tools: true, images: true, embedded: true};
const plain = {tools: false, images: true, embedded: true};
const deliver = (file, agent) => attachmentDelivery({name: 'file', image: false, text: false, ...file}, agent);
const throws = (body, pattern, message) => {
    try {body();} catch (error) {assert(pattern.test(error.message), `${message}: ${error.message}`); return;}
    throw new Error(`${message}: no error`);
};

// With GNOME Assistant tools: images and small text are embedded, the rest streamed.
assert(deliver({image: true, size: 2 * MiB}, tools) === 'image', 'Images should be embedded so the model sees them');
assert(deliver({image: true, size: 20 * MiB}, tools) === 'stream', 'Large images should be streamed');
assert(deliver({image: true, size: MiB}, {...tools, images: false}) === 'stream', 'Images the agent cannot see should be streamed');
assert(deliver({text: true, size: 10 * 1024}, tools) === 'embed', 'Small text should be embedded');
assert(deliver({text: true, size: MAX_EMBEDDED_TEXT_BYTES + 1}, tools) === 'stream', 'Large text should be streamed');
assert(deliver({size: 1024}, tools) === 'stream', 'Binary files should be streamed');
assert(deliver({size: 900 * MiB}, tools) === 'stream', 'Files up to 1 GiB should be streamed');
// Without tools: the previous embedding, limited to 8 MiB.
assert(deliver({size: 3 * MiB}, plain) === 'embed', 'Without tools files are embedded');
throws(() => deliver({size: MAX_ATTACHMENT_BYTES + 1}, plain), /over 8 MiB/, 'Without tools large files are refused');
throws(() => deliver({size: 10}, {tools: false, images: false, embedded: false}), /does not accept/, 'Agents without file support');

// Folders only travel as a streamed archive.
assert(deliver({folder: true, size: 10}, tools) === 'stream', 'Folders should be streamed');
throws(() => deliver({folder: true, size: 10}, plain), /folder/, 'Without tools folders are refused');

assert(isTextContent(new TextEncoder().encode('Résumé ☕\n')), 'UTF-8 text is text');
assert(!isTextContent(new Uint8Array([0x89, 0x50, 0x00, 0x47])), 'Binary is not text');
assert(!isTextContent(new Uint8Array([0xff, 0xfe, 0x41])), 'Invalid UTF-8 is not text');

const loop = new GLib.MainLoop(null, false);
const root = GLib.dir_make_tmp('gnome-assistant-delivery-XXXXXX');
(async () => {
    const path = root + '/report.txt';
    GLib.file_set_contents(path, 'First version.');
    const record = await selectAttachment(path);
    assert(record.size === 14 && !record.image && !record.bytes, 'Selecting a file must not read it');
    assert(new TextDecoder().decode(await readAttachedBytes(record)) === 'First version.', 'Embedding read the wrong bytes');
    attachedFile(record);
    // Same size, new contents and modification time: still a change.
    GLib.usleep(20000);
    GLib.file_set_contents(path, 'Second version');
    throws(() => attachedFile(record), /changed after it was attached/, 'An edited file was not refused');
    GLib.unlink(path);
    throws(() => attachedFile(record), /no longer available/, 'A deleted file was not refused');
    print('ATTACHMENT DELIVERY TESTS PASSED');
})().catch(error => {printerr(`${error}\n${error.stack}`); imports.system.exit(1);}).finally(() => {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
    loop.quit();
});
loop.run();
