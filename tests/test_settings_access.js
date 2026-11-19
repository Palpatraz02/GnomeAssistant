// Reading a key the schema lacks aborts the whole process in GLib (this is
// what crashed GNOME Shell after an update installed while it ran); the
// helpers must return the fallback instead. Run:
//   GSETTINGS_BACKEND=memory gjs -m tests/test_settings_access.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getBoolean, getStrv, getString, hasKey} from '../settingsAccess.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const directory = GLib.dir_make_tmp('gnome-assistant-settings-XXXXXX');
const repo = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const [, xml] = GLib.file_get_contents(`${repo}/schemas/org.gnome.shell.extensions.gnome-assistant.gschema.xml`);
GLib.file_set_contents(`${directory}/org.gnome.shell.extensions.gnome-assistant.gschema.xml`, xml);
const [ok] = GLib.spawn_sync(null, ['glib-compile-schemas', directory], null, GLib.SpawnFlags.SEARCH_PATH, null);
assert(ok, 'Could not compile the schema');
const source = Gio.SettingsSchemaSource.new_from_directory(directory, null, false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.gnome-assistant', false)});

assert(hasKey(settings, 'assistant-name') && !hasKey(settings, 'no-such-key') && !hasKey(null, 'assistant-name'),
    'hasKey is wrong');
settings.set_string('assistant-name', 'Jarvis');
assert(getString(settings, 'assistant-name') === 'Jarvis', 'Existing keys are not read');
assert(getBoolean(settings, 'privacy-protection', false) === true, 'Defaults of existing keys are not read');
// The case that aborted GNOME Shell: a key missing from the loaded schema.
assert(getString(settings, 'no-such-key', 'fallback') === 'fallback', 'A missing string key did not fall back');
assert(getBoolean(settings, 'no-such-key', true) === true, 'A missing boolean key did not fall back');
assert(JSON.stringify(getStrv(settings, 'no-such-key', ['x'])) === '["x"]', 'A missing list key did not fall back');
assert(getString(null, 'assistant-name', 'none') === 'none', 'Missing settings did not fall back');
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(directory)}`);
print('SETTINGS ACCESS TESTS PASSED');
