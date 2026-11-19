// Run inside the isolated native test's Wayland and settings session.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {addAcpConfiguration} from '../acpConfigPreferences.js';
const assert = (condition, message) => {if (!condition) throw new Error(message);};
const loop = new GLib.MainLoop(null,false);
const pause = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT,50,()=>{
    resolve();return GLib.SOURCE_REMOVE;
}));
const descendants = widget => {
    const result = [widget];
    for(let child=widget.get_first_child();child;child=child.get_next_sibling())
        result.push(...descendants(child));
    return result;
};
async function run() {
    Adw.init();
    const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
        GLib.getenv('GNOME_ASSISTANT_TEST_ROOT')+'/data/gnome-shell/extensions/a2ui-test@local/schemas',
        Gio.SettingsSchemaSource.get_default(),false);
    const settings = new Gio.Settings({settings_schema:schemaSource.lookup('org.gnome.shell.extensions.gnome-assistant',true)});
    const state = () => JSON.parse(settings.get_string('acp-config-state'));
    const wait = async predicate => {
        for(let i=0;i<100;i++) {if(predicate())return;await pause();}
        throw new Error('Timed out waiting for settings: '+JSON.stringify(state()));
    };
    const window = new Adw.PreferencesWindow();
    const page = new Adw.PreferencesPage();window.add(page);
    const group = addAcpConfiguration(page,settings,window);
    const row = title => descendants(group).find(item => item instanceof Adw.ComboRow && item.title===title);
    const value = id => state().options?.find(option=>option.id===id)?.currentValue;
    window.present();
    await wait(()=>state().ready && !state().busy && row('Model'));
    assert(row('Model').model.get_string(1)==='Test models — Deep','Grouped model labels missing');
    assert(row('Other setting'),'Options without categories were lost');
    row('Model').selected=1;
    await wait(()=>!state().busy && value('engine-choice')==='deep');
    assert(row('Thinking effort').model.get_string(1)==='High','Effort did not refresh after model selection');
    row('Thinking effort').selected=1;
    await wait(()=>!state().busy && value('depth-choice')==='high');
    row('Model').selected=2;
    await wait(()=>!state().busy && state().error?.includes('Test selection rejected'));
    assert(row('Model').selected===1,'Rejected selection was shown as active');
    assert(JSON.parse(settings.get_string('acp-config-values')).test['engine-choice']==='deep',
        'A rejected selection replaced the saved working model');
    row('Model').selected=0;
    await wait(()=>!state().busy && value('engine-choice')==='quick');
    assert(row('Thinking effort').subtitle.includes('Saved choice unavailable'),'Unavailable saved effort was not explained');
    row('Model').selected=1;
    await wait(()=>!state().busy && value('engine-choice')==='deep' && value('depth-choice')==='high');
    window.close();
    print('ACP PREFERENCES TEST PASSED');
}
let failure;
run().catch(error=>{failure=error;logError(error);}).finally(()=>loop.quit());
loop.run();
if(failure)throw failure;
