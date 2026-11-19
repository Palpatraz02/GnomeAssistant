#!/usr/bin/env node
// Attach area / Attach window: selection geometry, window hit-testing, frame
// cropping and attachment names. The overlay itself is driven in
// tests/test_a2ui_shell.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let source = fs.readFileSync(path.join(__dirname, '..', 'screenCapture.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^Gio\._promisify.*\n/gm, '')
    .replace(/^export /gm, '');
source += '\nthis.api = {selectionRect, shadeRects, windowAt, frameCrop, captureName};';
const context = {};
vm.runInNewContext(source, context);
const {selectionRect, shadeRects, windowAt, frameCrop, captureName} = context.api;
const plain = value => JSON.parse(JSON.stringify(value));
const stage = {width: 2560, height: 900};

// Drags work in any direction, snap outwards to whole pixels and stay on the stage.
assert.deepEqual(plain(selectionRect([520, 390], [200, 150], stage)), {x: 200, y: 150, width: 320, height: 240});
assert.deepEqual(plain(selectionRect([10.4, 20.6], [30.2, 40.1], stage)), {x: 10, y: 20, width: 21, height: 21});
assert.deepEqual(plain(selectionRect([-50, 800], [100, 1200], stage)), {x: 0, y: 800, width: 100, height: 100});
// Across two side-by-side monitors.
assert.deepEqual(plain(selectionRect([1200, 100], [1400, 300], stage)), {x: 1200, y: 100, width: 200, height: 200});
// A click, or a sliver, is not a selection.
assert.equal(selectionRect([100, 100], [102, 300], stage), null);
assert.equal(selectionRect([100, 100], [100, 100], stage), null);

// Without a selection everything is dimmed; with one, the shades surround it exactly.
const empty = plain(shadeRects(null, stage));
assert.deepEqual(empty[0], {x: 0, y: 0, ...stage});
assert(empty.slice(1).every(rect => rect.width * rect.height === 0));
const rect = {x: 200, y: 150, width: 320, height: 240};
const shades = plain(shadeRects(rect, stage));
const shaded = shades.reduce((total, shade) => total + shade.width * shade.height, 0);
assert.equal(shaded, stage.width * stage.height - rect.width * rect.height);
const inside = (shade, x, y) => x >= shade.x && x < shade.x + shade.width && y >= shade.y && y < shade.y + shade.height;
assert(!shades.some(shade => inside(shade, 200, 150) || inside(shade, 519, 389)));
assert(shades.some(shade => inside(shade, 199, 150)) && shades.some(shade => inside(shade, 520, 389)));

// The topmost window under the pointer wins; gaps pick nothing.
const windows = [
    {window: 'dialog', rect: {x: 300, y: 200, width: 200, height: 100}},
    {window: 'editor', rect: {x: 0, y: 32, width: 1280, height: 868}},
];
assert.equal(windowAt(windows, 350, 250).window, 'dialog');
assert.equal(windowAt(windows, 100, 100).window, 'editor');
assert.equal(windowAt(windows, 500, 250).window, 'editor', 'The right edge belongs to the next window');
assert.equal(windowAt(windows, 100, 10), null);
assert.equal(windowAt([], 1, 1), null);

// Client-side shadows are cropped away, at the buffer's scale.
const buffer = {x: 90, y: 80, width: 420, height: 340};
const frame = {x: 100, y: 90, width: 400, height: 300};
assert.deepEqual(plain(frameCrop(buffer, frame, 420, 340)), {x: 10, y: 10, width: 400, height: 300});
assert.deepEqual(plain(frameCrop(buffer, frame, 840, 680)), {x: 20, y: 20, width: 800, height: 600});
assert.deepEqual(plain(frameCrop(frame, frame, 400, 300)), {x: 0, y: 0, width: 400, height: 300});
assert.deepEqual(plain(frameCrop(buffer, {x: 0, y: 0, width: 0, height: 0}, 420, 340)), {x: 0, y: 0, width: -1, height: -1});

// Names are usable as attachment names: no paths, control characters or hidden files.
assert.equal(captureName('Capture target', 'window'), 'Capture target.png');
assert.equal(captureName('~/Projects/app: zsh', 'window'), '~-Projects-app: zsh.png');
assert.equal(captureName('a\\b\n\tc\x7f', 'window'), 'a-b c.png');
assert.equal(captureName('..', 'window-101500'), 'window-101500.png');
assert.equal(captureName('  .hidden. ', 'window'), 'hidden.png');
assert.equal(captureName('', 'window'), 'window.png');
assert.equal(captureName(null, 'window'), 'window.png');
const long = captureName('é'.repeat(300), 'window');
assert.equal([...long].length, 84);
assert.match(long, /^[^/\\\x00-\x1f\x7f]{1,160}$/u);

console.log('SCREEN CAPTURE TEST PASSED');
