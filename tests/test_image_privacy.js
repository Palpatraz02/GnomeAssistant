// Screenshot privacy without a Shell: blacking out regions, mapping screen
// areas to image pixels, and the OCR pipeline with a stand-in tesseract.
// Run with a private runtime folder:
//   XDG_RUNTIME_DIR=$(mktemp -d) gjs -m tests/test_image_privacy.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const root = GLib.dir_make_tmp('gnome-assistant-image-privacy-XXXXXX');
const loop = new GLib.MainLoop(null, false);

// A white 200x100 PNG.
function whitePng(width = 200, height = 100) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    pixbuf.fill(0xffffffff);
    return pixbuf.save_to_bufferv('png', [], [])[1];
}
const pixel = (bytes, x, y) => {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes)), null);
    const offset = y * pixbuf.get_rowstride() + x * pixbuf.get_n_channels();
    return [...pixbuf.get_pixels().slice(offset, offset + 3)];
};
const black = (bytes, x, y) => pixel(bytes, x, y).every(value => value === 0);

// A stand-in tesseract: lists English, and "finds" a GitHub token at x 40–150.
const token = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe';
const bin = root + '/bin';
GLib.mkdir_with_parents(bin, 0o700);
GLib.file_set_contents(bin + '/tesseract', `#!/bin/sh
if [ "$1" = "--list-langs" ]; then printf 'List of available languages (1):\\neng\\n'; exit 0; fi
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n'
printf '5\\t1\\t1\\t1\\t1\\t1\\t10\\t20\\t25\\t12\\t95\\ttoken:\\n'
printf '5\\t1\\t1\\t1\\t1\\t2\\t40\\t20\\t110\\t12\\t91\\t${token}\\n'
printf '5\\t1\\t1\\t1\\t2\\t1\\t10\\t60\\t60\\t12\\t96\\tharmless\\n'
echo "$1" > "${root}/ocr-input-path"
`);
GLib.spawn_command_line_sync(`chmod 755 ${bin}/tesseract`);
GLib.setenv('PATH', `${bin}:${GLib.getenv('PATH')}`, true);

async function main() {
    const {maskPng, ocrProtect, protectScreenshot, regionsInImage} = await import('../imagePrivacy.js');
    // Stage regions to image pixels, for a 2x downscaled capture of an area.
    const rects = regionsInImage([{x: 150, y: 50, width: 100, height: 100, label: 'KeePassXC'},
        {x: 900, y: 900, width: 10, height: 10, label: 'elsewhere'}], {x: 100, y: 0, width: 400, height: 200},
    {width: 200, height: 100});
    assert(JSON.stringify(rects) === JSON.stringify([{x: 25, y: 25, width: 50, height: 50, label: 'KeePassXC'}]),
        'Regions were not mapped to image pixels: ' + JSON.stringify(rects));
    const masked = maskPng(whitePng(), rects);
    assert(black(masked, 25, 25) && black(masked, 74, 74) && !black(masked, 24, 25) && !black(masked, 75, 75),
        'The region was not blacked out exactly');
    assert(maskPng(whitePng(), []).length > 0, 'Masking nothing failed');

    const ocr = await ocrProtect(whitePng());
    assert(ocr.ocr === 'checked' && ocr.findings.length === 1 && ocr.findings[0].label === 'GitHub token',
        'OCR did not find the token: ' + JSON.stringify(ocr.findings));
    // The token word (40..150 x 20..32, padded by 3) is black; its label and other text are not.
    assert(black(ocr.bytes, 37, 17) && black(ocr.bytes, 152, 34) && !black(ocr.bytes, 20, 25) && !black(ocr.bytes, 20, 65),
        'OCR blacked out the wrong pixels');
    const input = new TextDecoder().decode(GLib.file_get_contents(root + '/ocr-input-path')[1]).trim();
    // GLib fixes the runtime folder at startup; run with XDG_RUNTIME_DIR set to keep tests isolated.
    assert(input.startsWith(GLib.get_user_runtime_dir() + '/gnome-assistant/') && !GLib.file_test(input, GLib.FileTest.EXISTS),
        'The OCR copy was not private, or not removed: ' + input);

    const result = await protectScreenshot({bytes: whitePng(), width: 200, height: 100},
        {regions: [{x: 0, y: 0, width: 20, height: 20, label: 'notification'}], area: {x: 0, y: 0, width: 200, height: 100}});
    assert(JSON.stringify(result.hidden) === '["notification"]' && JSON.stringify(result.secrets) === '["GitHub token"]' &&
        result.ocr === 'checked' && black(result.image.bytes, 5, 5), 'protectScreenshot did not combine both');
    print('IMAGE PRIVACY TESTS PASSED');
}
let failed = false;
main().catch(error => {printerr(`${error}\n${error.stack}`); failed = true;}).finally(() => {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
    loop.quit();
});
loop.run();
if (failed)
    imports.system.exit(1);
