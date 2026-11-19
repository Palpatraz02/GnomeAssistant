// File pickers through org.freedesktop.portal.FileChooser, against a mock
// portal. Run on a private bus without activatable services, so no real
// portal or picker can start:
//   env -u WAYLAND_DISPLAY -u DISPLAY dbus-run-session --config-file=tests/private-bus.conf -- gjs -m tests/test_file_portal.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {chooseFile} from '../localAccess.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const XML = `<node><interface name="org.freedesktop.portal.FileChooser">
  <method name="OpenFile"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
  <method name="SaveFile"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
</interface></node>`;
const bus = Gio.DBus.session;
const loop = new GLib.MainLoop(null, false);
const calls = [];
// What the mock does next: {response, uri, early, ignoreToken}.
let behaviour = {};

function answer(method, [, title, options], invocation) {
    options = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, value.deepUnpack()]));
    calls.push({method, title, options});
    const sender = invocation.get_sender().slice(1).replace(/\./g, '_');
    const path = behaviour.ignoreToken ? `${PORTAL_PATH}/request/${sender}/legacy1`
        : `${PORTAL_PATH}/request/${sender}/${options.handle_token}`;
    const respond = () => bus.emit_signal(null, path, 'org.freedesktop.portal.Request', 'Response',
        new GLib.Variant('(ua{sv})', [behaviour.response ?? 0,
            behaviour.uri ? {uris: new GLib.Variant('as', [behaviour.uri])} : {}]));
    // A fast portal can answer before its method reply arrives.
    if (behaviour.early)
        respond();
    invocation.return_value(new GLib.Variant('(o)', [path]));
    if (!behaviour.early)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {respond(); return GLib.SOURCE_REMOVE;});
}

const portal = Gio.DBusExportedObject.wrapJSObject(XML, {
    OpenFileAsync: (params, invocation) => answer('OpenFile', params, invocation),
    SaveFileAsync: (params, invocation) => answer('SaveFile', params, invocation),
});
const fallback = async (action, filename) => `fallback:${action}:${filename}`;

async function run() {
    // Never risk auto-starting the real portal, which would open Files.
    const [activatable] = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'ListActivatableNames', null, null, Gio.DBusCallFlags.NONE, -1, null).deepUnpack();
    assert(!activatable.includes('org.freedesktop.portal.Desktop'),
        'Refusing to run: this bus can start the real portal. Use tests/private-bus.conf.');
    // No portal on the bus yet: the GTK helper takes over.
    assert(await chooseFile('open', '', {fallback}) === 'fallback:open:', 'Missing portal did not fall back');

    portal.export(bus, PORTAL_PATH);
    await new Promise(resolve => Gio.bus_own_name_on_connection(bus, 'org.freedesktop.portal.Desktop',
        Gio.BusNameOwnerFlags.NONE, () => resolve(), null));

    behaviour = {uri: 'file:///home/user/My%20Notes.txt'};
    assert(await chooseFile('open', '', {fallback}) === '/home/user/My Notes.txt', 'Open did not return the picked path');
    let call = calls.at(-1);
    assert(call.method === 'OpenFile' && call.title === 'Attach a file' && call.options.accept_label === 'Attach' &&
        !call.options.directory && call.options.modal === true, 'Unexpected open options: ' + JSON.stringify(call));

    behaviour = {uri: 'file:///home/user/project'};
    assert(await chooseFile('reference-folder', '', {fallback}) === '/home/user/project', 'Folder reference failed');
    call = calls.at(-1);
    assert(call.options.directory === true && call.options.accept_label === 'Reference' && call.title === 'Reference a folder',
        'Folder picker options are wrong: ' + JSON.stringify(call));

    behaviour = {uri: 'file:///home/user/Downloads/report.pdf'};
    assert(await chooseFile('save', 'report.pdf', {fallback}) === '/home/user/Downloads/report.pdf', 'Save failed');
    call = calls.at(-1);
    assert(call.method === 'SaveFile' && call.options.current_name === 'report.pdf', 'Save options are wrong: ' + JSON.stringify(call));

    behaviour = {uri: 'file:///home/user/snippet.py'};
    assert(await chooseFile('save-code', 'snippet.py', {fallback}) === '/home/user/snippet.py', 'Saving code failed');
    call = calls.at(-1);
    assert(call.method === 'SaveFile' && call.title === 'Save code' && call.options.current_name === 'snippet.py',
        'Code save options are wrong: ' + JSON.stringify(call));

    behaviour = {uri: 'file:///home/user/Trip%20plan.md'};
    assert(await chooseFile('export', 'Trip plan.md', {fallback}) === '/home/user/Trip plan.md', 'Export failed');
    call = calls.at(-1);
    assert(call.method === 'SaveFile' && call.title === 'Export conversation' && call.options.current_name === 'Trip plan.md',
        'Export options are wrong: ' + JSON.stringify(call));

    behaviour = {response: 1};
    assert(await chooseFile('open', '', {fallback}) === null, 'Cancelling did not return null');

    behaviour = {uri: 'file:///tmp/early.txt', early: true};
    assert(await chooseFile('reference-file', '', {fallback}) === '/tmp/early.txt', 'An early response was missed');

    behaviour = {uri: 'file:///tmp/legacy.txt', ignoreToken: true};
    assert(await chooseFile('open', '', {fallback}) === '/tmp/legacy.txt', 'A portal ignoring handle_token was not followed');

    print('FILE PORTAL TESTS PASSED');
}

run().catch(error => {printerr(`${error}\n${error.stack ?? ""}`); imports.system.exit(1);}).finally(() => loop.quit());
loop.run();
