import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

export const MAX_INLINE_IMAGES = 6;
const IMAGE_SIZE = 480;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LOCAL_IMAGE = /\.(?:jpe?g|png|webp)$/i;

export function parseLocalImageRequest(prompt) {
    const match = /^(?:please\s+)?(?:show|display|preview)\s+(?:me\s+)?(?:the\s+)?(?:(?:local\s+)?(?:image|photo|picture)\s+(?:at\s+)?)?([^\r\n]+)$/i
        .exec(prompt.trim());
    if (!match)
        return null;
    const path = match[1].trim().replace(/^([<"'`])(.+)[>"'`]$/, '$2');
    if (!LOCAL_IMAGE.test(path) || !/^(?:\/|~\/|\.{1,2}\/)/.test(path))
        return null;
    return path.startsWith('~/') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]) : path;
}

function httpsUrl(value) {
    try {
        const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
        if (uri.get_scheme() === 'https' && uri.get_host() && !uri.get_userinfo() &&
            [-1, 443].includes(uri.get_port()))
            return uri;
    } catch (_error) {
        // An invalid URL is not a preview target.
    }
    return null;
}

export function parseImageLine(line) {
    const target = '(?:<([^<>\\n]+)>|([^\\s()]+(?:\\([^()\\s]*\\)[^\\s()]*)*))';
    const image = '!\\[([^\\]\\n]*)\\]\\(' + target + '\\)';
    const linked = new RegExp('^\\[' + image + '\\]\\(' + target + '\\)$').exec(line.trim());
    const match = linked ?? new RegExp('^' + image + '$').exec(line.trim());
    if (!match)
        return null;
    const [, title, wrappedUrl, bareUrl, wrappedSource, bareSource] = match;
    const url = wrappedUrl ?? bareUrl;
    const source = wrappedSource ?? bareSource;
    if (!httpsUrl(url) && (!LOCAL_IMAGE.test(url) || /^[a-z][a-z\d+.-]*:/i.test(url)))
        return null;
    return {title: title || 'Image', url, source: source && httpsUrl(source) ? source : null};
}

function finishAsync(start, finish) {
    return new Promise((resolve, reject) => {
        start((source, result) => {
            try {
                resolve(finish(source, result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function readImageBytes(stream, cancellable) {
    const chunks = [];
    let size = 0;
    while (true) {
        const bytes = await finishAsync(
            callback => stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, callback),
            (source, result) => source.read_bytes_finish(result));
        if (!bytes.get_size())
            break;
        size += bytes.get_size();
        if (size > MAX_IMAGE_BYTES)
            throw new Error('Image exceeds the preview size limit.');
        chunks.push(bytes.get_data());
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    return body;
}

function isPublicIpv4(address) {
    const [a, b, c] = address.to_string().split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 &&
        !(a === 100 && b >= 64 && b <= 127) &&
        !(a === 169 && b === 254) &&
        !(a === 172 && b >= 16 && b <= 31) &&
        !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) &&
        !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
        !(a === 203 && b === 0 && c === 113);
}

export async function publicHttpsAddress(value, cancellable) {
    const uri=httpsUrl(value);
    if (!uri) throw new Error('Use a public HTTPS URL.');
    const host = uri.get_host().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host))
        throw new Error('Image URL must use a public HTTPS hostname.');
    const addresses = await finishAsync(
        callback => Gio.Resolver.get_default().lookup_by_name_with_flags_async(
            host, Gio.ResolverNameLookupFlags.IPV4_ONLY, cancellable, callback),
        (source, result) => source.lookup_by_name_with_flags_finish(result));
    const address = addresses.find(isPublicIpv4);
    if (!address)
        throw new Error('Image host has no public IPv4 address.');

    return {uri,host,address};
}

async function fetchPublicImage(uri, cancellable) {
    const {host,address}=await publicHttpsAddress(uri.to_string(),cancellable);

    // Pin the checked address while retaining TLS validation for the original
    // hostname. Disable proxy, redirects, and user curl configuration.
    const process = Gio.Subprocess.new(['curl', '-q', '--silent', '--fail',
        '--noproxy', '*', '--proto', '=https', '--connect-timeout', '5', '--max-time', '12',
        '--max-filesize', String(MAX_IMAGE_BYTES), '--resolve', host + ':443:' + address.to_string(),
        '--url', uri.to_string()], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const cancelId = cancellable.connect(() => process.force_exit());
    try {
        const bytes = await readImageBytes(process.get_stdout_pipe(), cancellable);
        await finishAsync(callback => process.wait_check_async(cancellable, callback),
            (source, result) => source.wait_check_finish(result));
        return bytes;
    } finally {
        cancellable.disconnect(cancelId);
        process.force_exit();
    }
}

function localImagePath(url, cwd, requestedImage) {
    if (!GLib.path_is_absolute(cwd ?? '') || !LOCAL_IMAGE.test(url))
        throw new Error('Unsupported image path.');
    const path = GLib.canonicalize_filename(url, cwd);
    const roots = [cwd];
    if (path !== requestedImage &&
        !roots.some(root => path.startsWith(GLib.canonicalize_filename(root, null).replace(/\/$/, '') + '/')))
        throw new Error('Image is outside the workspace.');
    let part = path;
    while (part !== '/') {
        if (GLib.file_test(part, GLib.FileTest.IS_SYMLINK))
            throw new Error('Symbolic links cannot be previewed.');
        part = GLib.path_get_dirname(part);
    }
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        throw new Error('Image file is unavailable.');
    return path;
}

export async function loadInlineImage(image, cwd, cancellable, requestedImage = null) {
    const uri = httpsUrl(image.url);
    let bytes;
    let target;
    if (uri) {
        bytes = await fetchPublicImage(uri, cancellable);
        target = image.source ?? image.url;
    } else {
        const path = localImagePath(image.url, cwd, requestedImage);
        const file = Gio.File.new_for_path(path);
        const stream = await finishAsync(
            callback => file.read_async(GLib.PRIORITY_DEFAULT, cancellable, callback),
            (source, result) => source.read_finish(result));
        try {
            bytes = await readImageBytes(stream, cancellable);
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
        }
        target = file.get_uri();
    }

    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
    if (!png && !jpeg && !webp)
        throw new Error('Preview requires a PNG, JPEG, or WebP image.');

    const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
    const pixbuf = await finishAsync(
        callback => GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            stream, IMAGE_SIZE, IMAGE_SIZE, true, cancellable, callback),
        (_source, result) => GdkPixbuf.Pixbuf.new_from_stream_finish(result));
    return {pixbuf, target};
}
