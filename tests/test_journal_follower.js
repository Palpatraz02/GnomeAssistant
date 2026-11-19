// The journal follower against a stand-in journalctl: exact arguments, JSON
// entries, a broken line ignored, and a restart after journalctl exits.
import GLib from 'gi://GLib';
import {JournalFollower} from '../journalFollower.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const root = GLib.dir_make_tmp('gnome-assistant-journal-XXXXXX');
GLib.file_set_contents(`${root}/journalctl`, `#!/bin/sh
printf '%s\\n' "$*" >> "${root}/calls"
printf '{"MESSAGE":"first","N":1}\\n'
printf 'not json at all\\n'
printf '{"MESSAGE":"second","N":2}\\n'
`);
GLib.spawn_command_line_sync(`chmod 755 ${root}/journalctl`);
GLib.setenv('PATH', `${root}:${GLib.getenv('PATH')}`, true);

const loop = new GLib.MainLoop(null, false);
const entries = [];
const follower = new JournalFollower(['MESSAGE_ID=abc', '_TRANSPORT=kernel'], entry => entries.push(entry),
    {fields: ['MESSAGE', 'N']});
follower.start();
let failed = false;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
    try {
        follower.stop();
        const calls = new TextDecoder().decode(GLib.file_get_contents(`${root}/calls`)[1]).trim().split('\n');
        assert(calls[0] === '--follow --lines=0 --output=json --all --no-pager --output-fields=MESSAGE,N MESSAGE_ID=abc + _TRANSPORT=kernel',
            'Unexpected journalctl arguments: ' + calls[0]);
        assert(calls.length === 2, `journalctl was not restarted once after exiting: ${calls.length} calls`);
        assert(JSON.stringify(entries.map(entry => entry.N)) === '[1,2,1,2]', 'Entries were not read: ' + JSON.stringify(entries));
        print('JOURNAL FOLLOWER TESTS PASSED');
    } catch (error) {
        printerr(`${error}`);
        failed = true;
    }
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
if (failed)
    imports.system.exit(1);
