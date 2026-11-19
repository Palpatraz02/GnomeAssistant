// Builds the full Preferences window. Run inside the isolated native test's
// Wayland and settings session (tests/test_a2ui_shell.sh).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const loop = new GLib.MainLoop(null, false);
const pause = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {resolve(); return GLib.SOURCE_REMOVE;}));
const descendants = widget => {
    const result = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        result.push(...descendants(child));
    return result;
};
let failed = false;

async function run() {
    Adw.init();
    // prefs.js imports GNOME's ExtensionPreferences from this resource.
    Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
    const {default: Preferences} = await import('../prefs.js');
    const dir = Gio.File.new_for_path(GLib.getenv('GNOME_ASSISTANT_TEST_ROOT') + '/data/gnome-shell/extensions/a2ui-test@local');
    const preferences = new Preferences({uuid: 'a2ui-test@local', name: 'Test', dir, path: dir.get_path(),
        'settings-schema': 'org.gnome.shell.extensions.gnome-assistant'});
    const settings = preferences.getSettings();
    const window = new Adw.PreferencesWindow();
    preferences.fillPreferencesWindow(window);
    window.present();
    await pause();
    const widgets = descendants(window);

    const name = widgets.find(widget => widget instanceof Adw.EntryRow && widget.title === 'Name');
    assert(name?.text === 'GNOME Assistant', 'The name row is missing or wrong');
    const reset = descendants(name).find(widget => widget instanceof Gtk.Button && widget.icon_name === 'edit-undo-symbolic');
    assert(reset && !reset.sensitive, 'Reset is available for the default name');
    const files = widgets.find(widget => widget instanceof Adw.PreferencesGroup && widget.title === 'Files');
    name.text = '   Jarvis   ';
    name.emit('apply');
    await pause();
    assert(settings.get_string('assistant-name') === 'Jarvis' && name.text === 'Jarvis', 'The name was not saved trimmed');
    assert(reset.sensitive && files.description.includes('“Ask Jarvis”'), 'The page did not follow the new name');
    reset.emit('clicked');
    await pause();
    assert(settings.get_string('assistant-name') === 'GNOME Assistant' && name.text === 'GNOME Assistant' && !reset.sensitive,
        'Reset did not restore the default name');

    const indicator = widgets.find(widget => widget instanceof Adw.SwitchRow && widget.title === 'Show status in the top bar');
    assert(indicator?.active, 'The top-bar indicator switch is missing or off by default');
    indicator.active = false;
    assert(!settings.get_boolean('show-status-indicator'), 'The top-bar indicator switch is not bound');
    settings.reset('show-status-indicator');

    // Wayland only lets a window own the clipboard after real user input,
    // which a headless session has none of: capture what the button copies.
    const copy = descendants(files).find(widget => widget instanceof Gtk.Button && widget.label === 'Copy install command');
    let text = null;
    copy.get_clipboard = () => ({set: value => {text = value;}});
    copy.emit('clicked');
    await pause();
    assert(typeof text === 'string', 'The button did not copy the command');
    assert(text.includes(`make -C ${GLib.shell_quote(dir.get_path() + '/nautilus')}`) && text.includes('sudo make') &&
        text.endsWith('nautilus -q'), 'Unexpected install command: ' + text);

    // Clearing history also removes conversation titles and pins. This runs
    // before the native test saves any conversation.
    const state = GLib.get_user_state_dir() + '/gnome-assistant';
    GLib.mkdir_with_parents(state, 0o700);
    for (const file of ['chat-history.jsonl', 'history-meta.json'])
        GLib.file_set_contents(`${state}/${file}`, '{}\n');
    const clear = descendants(window).find(widget => widget.title === 'Clear overview history');
    if (Adw.ButtonRow && clear instanceof Adw.ButtonRow)
        clear.emit('activated');
    else
        descendants(clear).find(widget => widget instanceof Gtk.Button && widget.label === 'Clear now').emit('clicked');
    await pause();
    assert(!GLib.file_test(`${state}/chat-history.jsonl`, GLib.FileTest.EXISTS) &&
        !GLib.file_test(`${state}/history-meta.json`, GLib.FileTest.EXISTS), 'Clearing history left history files');
    // Window context: its switch controls its shortcut; Included Context
    // stays usable while either kind of context is on.
    const all = descendants(window);
    const windowSwitch = all.find(widget => widget instanceof Adw.SwitchRow && widget.title === 'Enable window context');
    const windowShortcut = all.find(widget => widget.title === 'Ask about the focused window');
    const screenshots = all.find(widget => widget instanceof Adw.SwitchRow && widget.title === 'Screenshots');
    assert(windowSwitch?.active && windowShortcut?.sensitive && screenshots, 'The Window Context group is missing');
    settings.set_boolean('desktop-context-enabled', false);
    await pause();
    assert(screenshots.sensitive, 'Included Context was turned off although window context is on');
    settings.set_boolean('window-context-enabled', false);
    await pause();
    assert(!windowShortcut.sensitive && !screenshots.sensitive, 'Window context rows stayed active while turned off');
    settings.reset('window-context-enabled');
    settings.reset('desktop-context-enabled');
    // Settings are organized in tabs; each group sits on its topic's page.
    // (Adwaita adds an untitled page of its own for search results.)
    const pages = descendants(window).filter(widget => widget instanceof Adw.PreferencesPage && widget.title);
    assert(pages.map(page => page.title).join() === 'General,Agent,Context,Privacy,Notifications',
        'Unexpected tabs: ' + pages.map(page => page.title));
    const groupsOf = page => descendants(page).filter(widget => widget instanceof Adw.PreferencesGroup && widget.title)
        .map(group => group.title);
    const expected = {General: ['Assistant', 'Keyboard Shortcut', 'With the Overview Closed', 'Files'],
        Agent: ['Workspace', 'ACP connections', 'Assistant Instructions', 'Custom Instructions'],
        Context: ['Desktop Context', 'Window Context', 'Included Context'],
        Privacy: ['Privacy', 'Secrets and Private Windows'], Notifications: ['Problem Notifications']};
    for (const page of pages) {
        const groups = groupsOf(page);
        assert(expected[page.title].every(title => groups.includes(title)), `${page.title} lacks groups: ${groups}`);
    }
    // GNOME_ASSISTANT_PREFS_SHOTS=dir: a PNG of each tab, to look at the layout.
    const shots = GLib.getenv('GNOME_ASSISTANT_PREFS_SHOTS');
    if (shots) {
        GLib.mkdir_with_parents(shots, 0o755);
        for (const page of pages) {
            window.set_visible_page(page);
            for (let i = 0; i < 6; i++)
                await pause();
            const paintable = new Gtk.WidgetPaintable({widget: window});
            const snapshot = new Gtk.Snapshot();
            paintable.snapshot(snapshot, window.get_width(), window.get_height());
            window.get_native().get_renderer().render_texture(snapshot.to_node(), null)
                .save_to_png(`${shots}/${page.name}.png`);
        }
    }
    window.destroy();
    print('PREFERENCES WINDOW TEST PASSED');
}
run().catch(error => {printerr(`${error}\n${error.stack}`); failed = true;}).finally(() => loop.quit());
loop.run();
if (failed)
    imports.system.exit(1);
