// Parsing file-manager clipboard formats into local paths.
import {copiedFilePaths} from '../attachments.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)}`);

// GNOME Files, Nemo and Caja: an operation line, then URIs.
same(copiedFilePaths('copy\nfile:///home/user/notes.txt\nfile:///home/user/Projects'),
    ['/home/user/notes.txt', '/home/user/Projects'], 'GNOME copied files');
same(copiedFilePaths('cut\nfile:///home/user/a.txt'), ['/home/user/a.txt'], 'Cut files');
// text/uri-list: CRLF line ends, comments, percent-encoding.
same(copiedFilePaths('# from Dolphin\r\nfile:///home/user/My%20Report.pdf\r\nfile:///tmp/%C3%A9t%C3%A9.txt\r\n'),
    ['/home/user/My Report.pdf', '/tmp/été.txt'], 'URI list');
// Links and other schemes are not local files.
same(copiedFilePaths('https://gnome.org\nsftp://host/file'), [], 'Remote URIs');
same(copiedFilePaths('file:///tmp/a.txt\nhttps://gnome.org\nfile:///tmp/a.txt'), ['/tmp/a.txt'], 'Mixed and duplicate URIs');
same(copiedFilePaths(''), [], 'Empty clipboard');
same(copiedFilePaths('copy'), [], 'Operation without files');
print('COPIED FILES TESTS PASSED');
