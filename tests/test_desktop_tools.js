import GLib from 'gi://GLib';
import {GnomeTools} from '../gnomeTools.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const loop = new GLib.MainLoop(null, false);
const toolsWith = handlers => Object.assign(Object.create(GnomeTools.prototype), {_token: 'test', port: 1, _handlers: handlers});
const call = (tools, name, args = {}) => tools._rpc({id: 1, method: 'tools/call', params: {name, arguments: args}});
const names = async tools => (await tools._rpc({id: 1, method: 'tools/list'})).result.tools.map(tool => tool.name);

async function run() {
    assert(!(await names(toolsWith({}))).some(name => name.startsWith('desktop_')), 'Desktop tools listed without a handler');
    const calls = [];
    const tools = toolsWith({desktop: async (name, args) => {
        calls.push(name);
        if (name === 'desktop_get_selection')
            throw new Error('The user did not include this part in the desktop context.');
        if (name === 'desktop_capture_window')
            return {mcpContent: [{type: 'image', mimeType: 'image/png', data: 'AA=='}, {type: 'text', text: args.window_id}]};
        return {windows: []};
    }});
    const listed = await names(tools);
    for (const name of ['desktop_get_windows', 'desktop_get_selection', 'desktop_get_projects', 'desktop_get_recent_events', 'desktop_capture_window',
        'desktop_get_app_logs', 'desktop_get_device_status'])
        assert(listed.includes(name), `${name} missing`);
    const windows = await call(tools, 'desktop_get_windows');
    assert(JSON.parse(windows.result.content[0].text).windows, 'Window data not returned as JSON text');
    const denied = await call(tools, 'desktop_get_selection');
    assert(denied.result.isError && /did not include/.test(denied.result.content[0].text), 'Disabled part not reported as a tool error');
    const image = await call(tools, 'desktop_capture_window', {window_id: '42'});
    assert(image.result.content[0].type === 'image' && image.result.content[1].text === '42', 'Image content not passed through');
    assert(calls.length === 3, 'Unexpected handler calls');
    const local = toolsWith({desktop: () => ({}), desktopTools: () => ['desktop_get_windows', 'desktop_get_window_process']});
    const localNames = (await names(local)).filter(name => name.startsWith('desktop_'));
    assert(localNames.join() === 'desktop_get_windows,desktop_get_window_process', `Unexpected local tools: ${localNames}`);
    print('DESKTOP TOOLS TESTS PASSED');
}
run().catch(error => {printerr(error.stack ?? error); imports.system.exit(1);}).finally(() => loop.quit());
loop.run();
