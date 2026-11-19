import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {secretBoxesFromTsv} from './secretScanner.js';

// Image side of screenshot privacy, with no GNOME Shell imports so it can be
// tested on its own: black out regions of a PNG, and find secret-looking text
// with Tesseract OCR when it is installed (a safety net, not a guarantee).

// Regions inside `area` (stage coordinates), in the pixels of an image of it.
export function regionsInImage(regions, area, image) {
    const scaleX = image.width / area.width;
    const scaleY = image.height / area.height;
    return regions.map(region => {
        const left = Math.max(region.x, area.x), top = Math.max(region.y, area.y);
        const right = Math.min(region.x + region.width, area.x + area.width);
        const bottom = Math.min(region.y + region.height, area.y + area.height);
        if (right <= left || bottom <= top)
            return null;
        return {x: Math.floor((left - area.x) * scaleX), y: Math.floor((top - area.y) * scaleY),
            width: Math.ceil((right - left) * scaleX), height: Math.ceil((bottom - top) * scaleY), label: region.label};
    }).filter(Boolean);
}

// Black out rectangles (image pixels) in a PNG; returns new PNG bytes.
export function maskPng(bytes, rects) {
    if (!rects.length)
        return bytes;
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes)), null);
    for (const rect of rects) {
        const x = Math.max(0, Math.min(rect.x, pixbuf.get_width()));
        const y = Math.max(0, Math.min(rect.y, pixbuf.get_height()));
        const width = Math.min(rect.width, pixbuf.get_width() - x);
        const height = Math.min(rect.height, pixbuf.get_height() - y);
        if (width > 0 && height > 0)
            pixbuf.new_subpixbuf(x, y, width, height).fill(0x000000ff);
    }
    const [ok, encoded] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok)
        throw new Error('Could not encode the protected screenshot.');
    return encoded;
}

const io = (start, finish) => new Promise((resolve, reject) => start((source, result) => {
    try {resolve(source[finish](result));} catch (error) {reject(error);}
}));

async function run(argv, timeoutMs) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
    launcher.setenv('LC_ALL', 'C', true);
    launcher.setenv('OMP_THREAD_LIMIT', '2', true);
    const process = launcher.spawnv(argv);
    const cancellable = new Gio.Cancellable();
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        cancellable.cancel();
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [, out] = await io(callback => process.communicate_utf8_async(null, cancellable, callback), 'communicate_utf8_finish');
        if (!process.get_successful())
            throw new Error(`${GLib.path_get_basename(argv[0])} failed.`);
        return out ?? '';
    } finally {
        if (!cancellable.is_cancelled())
            GLib.source_remove(timer);
    }
}

// Tesseract with English data, or null. Checked once, asynchronously.
let ocr;
export function ocrEngine() {
    ocr ??= (async () => {
        const path = GLib.find_program_in_path('tesseract');
        if (!path)
            return null;
        try {
            return /^eng$/m.test(await run([path, '--list-langs'], 5000)) ? path : null;
        } catch {
            return null;
        }
    })();
    return ocr;
}

// Finds secret-looking text in a PNG with OCR and blacks it out.
// {bytes, findings, ocr: 'checked' | 'unavailable' | 'failed'}
export async function ocrProtect(bytes) {
    const tesseract = await ocrEngine();
    if (!tesseract)
        return {bytes, findings: [], ocr: 'unavailable'};
    const directory = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnome-assistant']);
    GLib.mkdir_with_parents(directory, 0o700);
    const file = Gio.File.new_for_path(GLib.build_filenamev([directory, `ocr-${GLib.uuid_string_random()}.png`]));
    try {
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
        const tsv = await run([tesseract, file.get_path(), 'stdout', '-l', 'eng', 'tsv'], 30000);
        const {boxes, findings} = secretBoxesFromTsv(tsv);
        return {bytes: maskPng(bytes, boxes), findings, ocr: 'checked'};
    } catch {
        return {bytes, findings: [], ocr: 'failed'};
    } finally {
        try {
            file.delete(null);
        } catch {
            // Never written.
        }
    }
}

// Protect one screenshot of `area` (stage coordinates): black out the given
// private regions, then OCR. Returns the image and what was hidden.
export async function protectScreenshot(image, {regions = [], area = null} = {}) {
    const rects = area ? regionsInImage(regions, area, image) : [];
    const masked = maskPng(image.bytes, rects);
    const {bytes, findings, ocr: state} = await ocrProtect(masked);
    return {image: {...image, bytes}, hidden: [...new Set(rects.map(rect => rect.label))],
        secrets: findings.map(finding => finding.label), ocr: state};
}
