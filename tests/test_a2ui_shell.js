import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Atk from 'gi://Atk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {AiView} from '../aiView.js';
import {A2uiStore, A2UI_CATALOG_ID} from '../a2ui.js';
import GnomeAssistantExtension from '../extension.js';
import {readSelectedAttachment, selectAttachment} from '../attachments.js';
import {selectFolder} from '../folderArchive.js';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const pause = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const all = actor => [actor, ...actor.get_children().flatMap(all)];
const component = (actor, id) => all(actor).find(child => child.a2uiComponentId === id);

export default class extends Extension {
    enable() { this.test().catch(error => logError(error, 'A2UI TEST FAILED')); }
    async test() {
        const settings = this.getSettings('org.gnome.shell.extensions.gnome-assistant');
        const root = GLib.getenv('GNOME_ASSISTANT_TEST_ROOT');
        const repo = GLib.getenv('GNOME_ASSISTANT_SOURCE');
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const stylesheet = Gio.File.new_for_path(repo + '/stylesheet.css');
        theme.load_stylesheet(stylesheet);
        settings.set_string('workspace-folder', root + '/workspace');
        settings.set_string('acp-profiles', JSON.stringify([{id:'test',name:'A2UI fixture',transport:'local',
            command:'python3 ' + GLib.shell_quote(repo + '/tests/a2ui_agent.py')}]));
        settings.set_string('acp-profile','test');
        if(GLib.getenv('GNOME_ASSISTANT_TEST_OPTIONS_ONLY')) {
            const view=new AiView(settings);view.set_position(40,50);view.set_size(1200,800);
            Main.uiGroup.add_child(view);view.show();
            try {await this.testAcpOptions(view,settings,root);} finally {view.destroy();await pause();}
            theme.unload_stylesheet(stylesheet);
            print('A2UI TEST PASSED');return;
        }
        if(GLib.getenv('GNOME_ASSISTANT_TEST_THEME_ONLY')) {
            await this.testThemeGallery(settings,root,stylesheet);
            theme.unload_stylesheet(stylesheet);
            print('A2UI TEST PASSED');return;
        }
        if(GLib.getenv('GNOME_ASSISTANT_TEST_FOCUS_ONLY')) {
            await this.testOverviewTyping(root);
            theme.unload_stylesheet(stylesheet);
            print('A2UI TEST PASSED');return;
        }
        const view = new AiView(settings);
        view.set_position(50, 50);
        view.set_size(1180, 800);
        global.stage.add_child(view);
        view.show();
        const turn = async prompt => {await view.generateResponse(prompt); await pause();};
        try {
            for(let i=0;i<100 && !JSON.parse(settings.get_string('acp-config-state')).ready;i++) await pause();
            assert(JSON.parse(settings.get_string('acp-config-state')).ready,'ACP config did not publish on background connection');
            const preferences = Gio.Subprocess.new(['gjs','-m',repo+'/tests/test_acp_config_prefs.js'],
                Gio.SubprocessFlags.STDOUT_PIPE|Gio.SubprocessFlags.STDERR_PIPE);
            const [stdout,stderr] = await new Promise((resolve,reject)=>preferences.communicate_utf8_async(null,null,(source,result)=>{
                try {const [,out,err]=source.communicate_utf8_finish(result);resolve([out,err]);}catch(error){reject(error);}
            }));
            assert(preferences.get_successful(),'ACP preferences failed: '+stdout+stderr);
            assert(stdout.includes('ACP PREFERENCES TEST PASSED'),'Preferences test did not finish');
            // GNOME's preferences code needs Shell's private typelibs, as in the Extensions app.
            const launcher = new Gio.SubprocessLauncher({flags:Gio.SubprocessFlags.STDOUT_PIPE|Gio.SubprocessFlags.STDERR_PIPE});
            launcher.setenv('GI_TYPELIB_PATH',['/usr/lib/gnome-shell/girepository-1.0','/usr/lib64/gnome-shell/girepository-1.0',
                GLib.getenv('GI_TYPELIB_PATH')].filter(Boolean).join(':'),true);
            const window = launcher.spawnv(['gjs','-m',repo+'/tests/test_prefs_window.js']);
            const [windowOut,windowErr] = await new Promise((resolve,reject)=>window.communicate_utf8_async(null,null,(source,result)=>{
                try {const [,out,err]=source.communicate_utf8_finish(result);resolve([out,err]);}catch(error){reject(error);}
            }));
            assert(window.get_successful() && windowOut.includes('PREFERENCES WINDOW TEST PASSED'),
                'Preferences window failed ('+(window.get_if_signaled()?'signal '+window.get_term_sig():'exit '+window.get_exit_status())+'): '+
                    windowOut+windowErr);
            view._startNewConversation();
            await turn('configuration');
            assert(view._visibleMessages.at(-1).text==='deep:high','Saved model and effort were not applied before new-session prompt');
            const requests = new TextDecoder().decode(GLib.file_get_contents(root+'/config-requests.jsonl')[1]).trim().split('\n').map(JSON.parse);
            assert(requests.at(-2).configId==='engine-choice' && requests.at(-1).configId==='depth-choice',
                'Saved options applied in the wrong dependency order');
            const configuration = JSON.parse(settings.get_string('acp-config-state'));
            settings.set_string('acp-profile','missing');
            assert(!JSON.parse(settings.get_string('acp-config-state')).ready,'A different connection showed stale model options');
            settings.set_string('acp-profile','test');
            assert(configuration.options.some(option=>option.currentValue==='high'),'Effort configuration was lost');
            // Exercise the real composer widgets without altering the desktop overview.
            const searchEntry=new St.Entry({text:'',style_class:'search-entry',width:360});
            const promptBin=new St.Bin({child:searchEntry,x:300,y:5});
            global.stage.add_child(promptBin);await pause();
            const prompt=Object.create(GnomeAssistantExtension.prototype);
            Object.assign(prompt,{_isAiMode:true,_searchEntry:searchEntry,_searchTextActor:searchEntry.clutter_text,
                _aiView:view,_aiIcon:new Gio.ThemedIcon({name:'system-search-symbolic'})});
            // The paperclip opens the attach menu; the menu itself is tested below.
            const showAttachMenu=view._showAttachMenu;
            let attachmentClicks=0;
            view._showAttachMenu=()=>{attachmentClicks++;};
            try {
                assert(!view.attachmentButton.get_parent(),'Attachment button remains in the chat header');
                prompt._resizePrompt();await pause();await pause();await pause();
                const button=view.attachmentButton;
                assert(prompt._promptBox.get_last_child()===button && button.mapped,
                    'Attachment button is missing from the empty prompt');
                const scrollbars=()=>all(prompt._promptScroll).filter(actor=>actor instanceof St.ScrollBar &&
                    actor.mapped && actor.width>1 && actor.height>1 && actor.get_paint_opacity()>0);
                const compactImage=Gio.File.new_for_path(root+'/compact-prompt.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
                const {default:Shell}=await import('gi://Shell');
                await new Shell.Screenshot().screenshot(false,compactImage);compactImage.close(null);
                assert(scrollbars().length===0,'The empty prompt shows a scrollbar: '+JSON.stringify(
                    scrollbars().map(actor=>({width:actor.width,height:actor.height,opacity:actor.opacity}))));
                button.emit('clicked',1);
                assert(attachmentClicks===1,'Prompt attachment button no longer opens attachment selection');
                prompt._promptEditor.set_text('A multiline prompt\nwith a second line');
                await pause();await pause();await pause();await pause();
                assert(button.get_parent()===prompt._promptBox && button.x>=prompt._promptScroll.x+prompt._promptScroll.width-1,
                    'Attachment button is not on the right of the expanded prompt');
                assert(button.x+button.width<=prompt._promptBox.width,'Attachment button overflows the prompt');
                assert(scrollbars().length===0,'A short prompt shows a scrollbar before reaching the height limit');
                prompt._promptEditor.set_text(Array.from({length:16},(_,index)=>`Line ${index+1}`).join('\n'));
                await pause();await pause();await pause();await pause();
                const adjustment=prompt._promptScroll.vadjustment ?? prompt._promptScroll.vscroll.adjustment;
                assert(scrollbars().length===1 && adjustment.upper>adjustment.page_size,
                    'A prompt over the height limit is not scrollable');
                adjustment.value=adjustment.upper-adjustment.page_size;
                prompt._promptEditor.set_text('');await pause();await pause();await pause();await pause();
                assert(scrollbars().length===0 && adjustment.value===adjustment.lower,
                    'Clearing a long prompt left a scrollbar or a scrolled empty editor');
                assert(button.mapped && button.get_parent()===prompt._promptBox &&
                    prompt._promptBox.width<500 && prompt._promptEditor.height<80,
                    'Clearing the prompt hid attachments or left an expanded empty editor');
                view._run={};view._syncProfileButtons();
                assert(!button.reactive,'Attachment button remains enabled while the agent is working');
                view._run=null;view._syncProfileButtons();
                prompt._isAiMode=false;prompt._restoreSingleLinePrompt();
                assert(promptBin.get_child()===searchEntry && !button.get_parent(),
                    'Leaving assistant mode did not restore normal search');
                prompt._isAiMode=true;prompt._resizePrompt();
                assert(prompt._promptBox.get_last_child()===button,'Reopening assistant mode lost the attachment button');
            } finally {
                view._run=null;
                prompt._isAiMode=false;prompt._restoreSingleLinePrompt();
                view._showAttachMenu=showAttachMenu;
                promptBin.destroy();
            }
            await this.testFileDownloads(view,root,turn);
            await this.testStreamingUI(view,root,turn);
            await this.testReplyActions(view,root,turn);
            // Text before and after a tool call is one stream: it must not run together.
            await turn('tool-between');
            assert(view._visibleMessages.at(-1).text==="I'll create hello.txt and verify its contents.\n\nCreated hello.txt. It contains hello world.",
                'Text around a tool call ran together: '+JSON.stringify(view._visibleMessages.at(-1).text));
            await turn('tool-between-spaced');
            assert(view._visibleMessages.at(-1).text==="I'll create hello.txt and verify its contents.\nCreated hello.txt. It contains hello world.",
                'A break was added where the agent already had one: '+JSON.stringify(view._visibleMessages.at(-1).text));
            await this.testHistory(view,root);
            await this.testPrivacy(view,root,turn);
            const progressive=view.generateResponse('progressive');
            for(let i=0;i<60 && !view._a2uiViews.has('progressive');i++)await pause();
            const early=view._a2uiViews.get('progressive')?.view;
            assert(early && view._run && component(early.actor,'root').text==='Loading…',
                'The first UI update did not render before generation finished');
            await progressive;await pause();
            assert(view._a2uiViews.get('progressive').view===early && component(early.actor,'root').text==='Ready',
                'The incremental data update replaced or failed to refresh the early UI');
            await turn('progressive-clear');
            await turn('form');
            assert(view._client.gnomeTools.instructions().includes('full catalog'),
                'Read catalog details were not recorded in the ACP session instructions');
            assert(view._visibleMessages.at(-1).text === 'Here is your plan.', 'Fenced JSON leaked into reply');
            let ui = view._a2uiViews.get('form')?.view;
            assert(ui && !all(ui.actor).some(actor => actor.text?.startsWith('Interface unavailable')), 'Native form failed: ' + (ui ? all(ui.actor).map(actor=>actor.text??'').filter(Boolean).join(' | ') : 'missing surface'));
            assert(ui.actor.mapped && ui.actor.width > 100, 'Interface is not visible');
            const entry = all(component(ui.actor,'name')).find(actor => actor instanceof St.Entry);
            assert(entry, 'Text field did not render');
            entry.grab_key_focus();
            assert(global.stage.key_focus === entry.clutter_text, 'Text field could not receive focus');
            entry.set_text('Jane');
            assert(view._a2uiStore.surfaces.get('form').data.name === 'Jane', 'Input did not write model');
            assert(component(ui.actor,'echo').text === 'Jane', 'Bound label did not update');
            assert(all(component(ui.actor,'notes')).some(actor => actor instanceof St.ScrollView), 'Multiline input is not scrollable');
            const check = component(ui.actor,'check');
            check.checked = true; check.emit('clicked',1);
            const choices = all(component(ui.actor,'choice')).filter(actor => actor instanceof St.Button);
            choices[1].checked = true; choices[1].emit('clicked',1);
            assert(view._a2uiStore.surfaces.get('form').data.tomorrow, 'Checkbox did not write model');
            assert(view._a2uiStore.surfaces.get('form').data.units[0] === 'f', 'Choice did not write model');
            const submit = component(ui.actor,'submit');
            submit.grab_key_focus();
            view._setA2uiBusy(true);
            assert(!submit.reactive && !check.can_focus, 'Busy controls remain active');
            view._setA2uiBusy(false);
            submit.emit('clicked',1);
            await pause();
            for (let tries=0;view._run && tries<80;tries++) await pause();
            assert(view._visibleMessages.at(-1).text === 'Plan updated.', 'Button failed to reach the same ACP session');
            assert(view._a2uiViews.get('form').view === ui, 'Updating created a duplicate surface');
            assert(component(ui.actor,'echo').text === 'Updated', 'MCP data update not rendered');
            await pause();
            view._scrollView.vadjustment.value = 0;
            const screenshot = await import('gi://Shell');
            const stream = Gio.File.new_for_path(root + '/native-ui.png').replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new screenshot.default.Screenshot().screenshot(false, stream);
            stream.close(null);
            await turn('resource');
            assert(view._visibleMessages.at(-1).text === '', 'UI-only reply acquired fallback text');
            assert(view._a2uiViews.get('resource')?.view, 'MIME resource did not render');
            const image = component(view._a2uiViews.get('resource').view.actor,'image');
            for (let tries=0;all(image).some(actor => actor.text === 'Loading image…') && tries<50;tries++) await pause();
            assert(!all(image).some(actor => actor.text?.includes('unavailable')) && all(image).some(actor => actor.content),
                'A2UI local image did not load');
            const saved = await view._loadMemoryEntriesAsync();
            const latest = saved.at(-1);
            assert(latest.a2ui.length === 2 && latest.content === '', 'UI-only history lost');
            const restored = new A2uiStore(); restored.apply(latest.a2ui);
            assert(restored.surfaces.get('form').data.name === 'Updated', 'History model differs');
            const historyMessage = view.addMessage('GNOME Assistant','History test');
            view._showA2uiSnapshot(latest.a2ui,historyMessage);
            const historySubmit = component(historyMessage.extras,'submit');
            assert(!historySubmit.reactive && !historySubmit.can_focus, 'History controls remain interactive');
            await turn('invalid');
            assert(view._visibleMessages.at(-1).text === 'Invalid interface rejected.', 'Invalid MCP interface was accepted');
            assert(component(ui.actor,'echo').text === 'Updated', 'Invalid update damaged previous state');
            await turn('$native:native argument');
            assert(view._visibleMessages.at(-1).text === 'Native command works.', 'Native ACP command regressed');
            const approval = view._showApproval.bind(view);
            view._showApproval = (id,options) => {
                approval(id,options);
                view._approvals.get(id).get_last_child().get_last_child().emit('clicked',1);
                assert(view._approvals.size === 0, 'Approval did not disappear');
            };
            await turn('approval');
            assert(view._visibleMessages.at(-1).text === 'Approved.', 'ACP permission flow regressed');
            const stop = view.generateResponse('stop');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT,200,()=>{view._stopRun();return GLib.SOURCE_REMOVE;});
            await stop;
            assert(view._visibleMessages.at(-1).text === 'Stopped.', 'ACP cancellation regressed');
            assert(component(ui.actor,'submit').reactive, 'Cancellation left form disabled');
            await turn('clear');
            assert(view._a2uiStore.surfaces.size === 0 && view._a2uiViews.size === 0, 'Deleted surfaces survived');
            assert((await view._loadMemoryEntriesAsync()).at(-1).a2ui.length === 0, 'Cleared state was not saved');
            view._renderHistorySession(view._buildHistorySessions(saved)[0]);
            const resume = all(view._historyBox).find(actor => actor.accessible_name === 'Resume conversation');
            assert(resume?.reactive, 'History cannot resume the original ACP session');
            resume.emit('clicked',1);
            ui = view._a2uiViews.get('form').view;
            assert(component(ui.actor,'submit').reactive, 'Resumed interface is not interactive');
            await turn('$native:native argument');
            assert(view._a2uiViews.get('form').view === ui && ui.store.surfaces.get('form').data.name === 'Updated',
                'Session loading discarded the restored interface');
            view._startNewConversation();
            assert(ui.disposed && view._a2uiStore.surfaces.size === 0, 'New chat retained an old interactive surface');
            const profiles = JSON.parse(settings.get_string('acp-profiles'));
            profiles[0].command += ' --no-tools';
            settings.set_string('acp-profiles',JSON.stringify(profiles));
            await turn('/a2ui resource');
            assert(view._a2uiViews.get('resource')?.view && view._visibleMessages.at(-1).text === '',
                'Catalog fallback or manual /a2ui request failed without MCP');
            await turn('files-acp');
            const fallbackFile=view._visibleMessages.at(-1);
            assert(fallbackFile.attachments?.[0].name==='fallback.csv' && fallbackFile.text==='',
                'Standard ACP resource output did not become a downloadable file');
            view._startNewConversation();
            profiles[0].command = profiles[0].command.replace(' --no-tools','');
            settings.set_string('acp-profiles',JSON.stringify(profiles));
            await turn('local');
            const local=view._a2uiViews.get('local').view;
            const data=()=>view._a2uiStore.surfaces.get('local').data;
            const field=id=>all(component(local.actor,id)).find(actor=>actor instanceof St.Entry);
            const click=async id=>{component(local.actor,id).emit('clicked',1);await pause();};
            const messageCount=view._visibleMessages.length;
            assert(component(local.actor,'temperature').text==='20 °C','Computed label failed');
            assert(local._error.visible && local._error.text.includes('zero'),'Expression error was not isolated');
            await click('toggle');
            assert(component(local.actor,'temperature').text==='68 °F' && data().unit==='f','Composed local conversion failed');
            field('c').set_text('25');
            assert(component(local.actor,'temperature').text==='77 °F','Typing did not refresh composed expressions');
            field('c').set_text('');
            assert(!component(local.actor,'submit').reactive,'Invalid form submit remained enabled');
            assert(all(local.actor).some(actor=>actor.text==='Enter a number from 0 to 100.'),'Validation feedback missing');
            field('c').set_text('25');
            assert(component(local.actor,'submit').reactive,'Valid form submit remained disabled');
            field('query').set_text('b');
            await click('apply');
            assert(data().shown.length===1 && data().shown[0].name==='Beta','Local filtering and sorting failed');
            assert(all(component(local.actor,'list')).some(actor=>actor.text==='1. Beta'),'Computed template was not rebuilt');
            await click('fix');
            assert(component(local.actor,'bad').text==='Result: 0.5' && !local._error.visible,'Expression did not recover locally');
            assert(view._visibleMessages.length===messageCount && !view._run,'Local helpers called the agent');
            view._flushA2uiState();
            const localHistory=await view._loadMemoryEntriesAsync();
            const localSnapshot=localHistory.at(-1).a2ui.find(envelope=>envelope.createSurface.surfaceId==='local');
            assert(localSnapshot.createSurface.dataModel.c==='25' && localSnapshot.createSurface.dataModel.unit==='f' &&
                localSnapshot.createSurface.dataModel.divisor===2,'Local state was not saved without an agent request');
            const checkpoint={type:'a2ui_state',sessionId:localHistory.at(-1).sessionId,connection:localHistory.at(-1).connection,a2ui:[localSnapshot],ts:1};
            const folded=view._parseMemoryEntries(JSON.stringify(localHistory.at(-1))+'\n'+JSON.stringify(checkpoint));
            assert(folded.length===1 && folded[0].a2ui[0].createSurface.dataModel.c==='25','State checkpoints created chat messages');
            view._scrollView.vadjustment.value=0;
            const localStream=Gio.File.new_for_path(root+'/local-functions.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new screenshot.default.Screenshot().screenshot(false,localStream);
            localStream.close(null);

            view._setA2uiBusy(true);
            await click('toggle');
            assert(data().unit==='f','Busy local action modified the model');
            view._setA2uiBusy(false);
            const previousContext=view._a2uiContext;
            view._a2uiContext='stale-context';
            await click('toggle');
            assert(data().unit==='f','Stale local action modified the model');
            view._a2uiContext=previousContext;
            local.queueRender();
            await pause();
            assert(local._error.visible && local._error.text.includes('unavailable'),'Action error disappeared during a redraw');
            await click('fix');
            assert(!local._error.visible,'Successful local action did not clear the old error');
            await turn('rpc-mcp');
            assert(view._visibleMessages.at(-1).text==='MCP function results received.','MCP RPC result not returned');
            await turn('rpc');
            assert(view._visibleMessages.at(-1).text==='Function results received.','Streamed RPC continuation failed');
            assert(data().unit==='f' && data().c==='25','Agent RPC mutated local state');
            await turn('rpc-loop');
            assert(view._visibleMessages.at(-1).text.includes('too many interface function rounds') && !view._run,
                'Repeated RPC calls were not bounded');
            const rpcStop=view.generateResponse('rpc-stop');
            for (let tries=0; view._run?.statusLabel.text!=='Updating interface…' && tries<50; tries++) await pause();
            await view._stopRun();
            await rpcStop;
            assert(view._visibleMessages.at(-1).text==='Stopped.','RPC continuation did not cancel');
            const timeoutAdd=GLib.timeout_add;
            GLib.timeout_add=(priority,delay,callback)=>timeoutAdd(priority,delay===45000?50:delay,callback);
            try {await turn('rpc-stop');} finally {GLib.timeout_add=timeoutAdd;}
            assert(view._visibleMessages.at(-1).text.includes('timed out'),'Function response timeout did not stop the agent');
            const readonly=JSON.parse(JSON.stringify(localSnapshot));
            readonly.createSurface.components.find(item=>item.id==='c').label={'@call':'divide',args:{left:1,right:0}};
            const preview=view.addMessage('GNOME Assistant','Read-only preview');
            view._showA2uiSnapshot([readonly],preview);
            const readonlyField=all(component(preview.extras,'c')).find(actor=>actor instanceof St.Entry);
            assert(!readonlyField.clutter_text.editable,'Invalid expression made history editable');
            const readonlyToggle=component(preview.extras,'toggle');
            assert(!readonlyToggle.reactive,'Local action is enabled in history');


            view._startNewConversation();
            await turn('remote');
            const remote=view._a2uiViews.get('remote').view;
            const remoteField=()=>all(component(remote.actor,'name')).find(actor=>actor instanceof St.Entry);
            const remoteData=()=>view._a2uiStore.surfaces.get('remote').data;
            const settle=async()=>{
                for (let tries=0;tries<150;tries++) {
                    await pause();
                    if (!view._run && ![...view._a2uiStore.remote.records.values()].some(record=>['queued','sent'].includes(record.status))) return;
                }
                throw new Error('Agent-backed interface did not settle');
            };
            assert(remote._loading.visible,'Remote bindings did not show a loading state');
            assert(!component(remote.actor,'submit').reactive,'Remote validation was treated as valid before returning');
            const remoteMessage=view._visibleMessages.at(-1);
            const remoteCount=view._visibleMessages.length;
            await settle();
            assert(component(remote.actor,'answer').text==='Hello Alice','Agent result did not populate the interface');
            assert(component(remote.actor,'echo').text==='Echo: Hello Alice','Nested remote value did not compose with local functions');
            assert(component(remote.actor,'submit').reactive && !remote._loading.visible,'Remote validation did not complete');
            const remoteChoices=all(component(remote.actor,'choices')).filter(actor=>actor instanceof St.Button);
            assert(remoteChoices.length===2 && (remoteChoices[0].getLabelActor?.().text ?? remoteChoices[0].label)==='Alice one','Agent-returned options did not populate choices');
            remoteChoices[1].checked=true;remoteChoices[1].emit('clicked',1);
            assert(remoteData().selection[0]==='two','Agent-returned choice could not be selected');

            assert(remoteMessage.text==='Original response.' && view._visibleMessages.length===remoteCount,'Function result overwrote chat text or created messages');
            const stats=()=>new TextDecoder().decode(GLib.file_get_contents(root+'/agent-functions.jsonl')[1]).trim().split('\n').map(line=>JSON.parse(line));
            assert(stats().filter(entry=>entry.name==='lookupTitle' && entry.args.name==='Alice').length===1,'Identical bindings made duplicate agent calls');
            const originalEntry=remoteField();
            originalEntry.set_text('Al');originalEntry.set_text('Alicia');originalEntry.set_text('Bob');
            await settle();
            assert(component(remote.actor,'answer').text==='Hello Bob' && remoteField()===originalEntry,'Typing lost focus or received a stale value');
            assert(!stats().some(entry=>['Al','Alicia'].includes(entry.args.name)),'Typing queries were not debounced');
            component(remote.actor,'refresh').emit('clicked',1);
            await pause();await settle();await pause();
            assert(remoteData().summary==='Summary for Bob' && remoteData().counter===2,'Remote action repeated or skipped local sequence steps');
            component(remote.actor,'refresh').emit('clicked',1);
            await pause();await settle();await pause();
            assert(remoteData().counter===4 && stats().filter(entry=>entry.name==='makeSummary').length===2,'Repeated clicks reused a cached action result');
            originalEntry.set_text('bad');await settle();
            assert(remote._error.text.includes('Lookup failed') && !component(remote.actor,'submit').reactive,'Agent errors were not shown or validation remained enabled');
            originalEntry.set_text('missing');await settle();
            assert(remote._error.text.includes('did not return a result'),'Missing function response did not settle as an error');
            originalEntry.set_text('hold');
            for (let tries=0;!view._run?.silentFunctions && tries<40;tries++) await pause();
            assert(view._run?.silentFunctions && originalEntry.clutter_text.editable,'Background calls blocked form typing');
            await view._stopRun();await settle();
            assert(remote._error.text.includes('stopped') && remoteMessage.text==='Original response.','Stop corrupted the original response or failed to cancel');
            const originalTimeout=GLib.timeout_add;
            GLib.timeout_add=(priority,delay,callback)=>originalTimeout(priority,delay===45000?100:delay,callback);
            try {originalEntry.set_text('timeout');await settle();} finally {GLib.timeout_add=originalTimeout;}
            assert(remote._error.text.includes('time') && remoteMessage.text==='Original response.','Background timeout damaged the source message: '+JSON.stringify({error:remote._error.text,text:remoteMessage.text,records:[...view._a2uiStore.remote.records.values()].filter(record=>record.callFunction.args.name==='timeout').map(record=>({status:record.status,error:record.error}))}));
            originalEntry.set_text('Carol');await settle();
            assert(component(remote.actor,'answer').text==='Hello Carol' && !remote._error.visible,'Interface did not recover after cancellation');
            view._scrollView.vadjustment.value=0;
            const remoteStream=Gio.File.new_for_path(root+'/agent-functions.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new screenshot.default.Screenshot().screenshot(false,remoteStream);
            remoteStream.close(null);

            view._a2uiStore.apply({version:'1.0',updateComponents:{surfaceId:'remote',components:[{
                id:'submit',component:'Button',child:'submitLabel',action:{event:{name:'contextSubmit',context:{value:{'@call':'contextValue',args:{}}}}},
            }]}});
            remote.queueRender();await pause();
            component(remote.actor,'submit').emit('clicked',1);
            await pause();await settle();await pause();
            assert(view._visibleMessages.at(-1).text==='Context event received.','Remote event context was sent while another ACP turn was still active');
            view._flushA2uiState();
            const remoteSaved=(await view._loadMemoryEntriesAsync()).at(-1);
            const previewRemote=view.addMessage('GNOME Assistant','Saved remote view');
            const beforePreview=stats().length;
            view._showA2uiSnapshot(remoteSaved.a2ui,previewRemote);
            assert(component(previewRemote.extras,'answer').text==='Hello Carol','Read-only history lost settled agent values');
            await pause();assert(stats().length===beforePreview,'History dispatched a live agent request');
            view._startNewConversation();
            profiles[0].command += ' --no-tools';settings.set_string('acp-profiles',JSON.stringify(profiles));
            await turn('remote');await settle();
            assert(component(view._a2uiViews.get('remote').view.actor,'answer').text==='Hello Alice','Fenced agentFunctionResponse failed');
            view._startNewConversation();
            await turn('components');
            const gallery=view._a2uiViews.get('components')?.view;
            assert(gallery && !all(gallery.actor).some(actor=>actor.text?.startsWith('Interface unavailable')),'New components failed to render');
            const galleryData=()=>view._a2uiStore.surfaces.get('components').data;
            const slider=component(gallery.actor,'slider').a2uiSlider;
            slider.value=0.63;
            assert(galleryData().amount===6 && component(gallery.actor,'computed').text==='Value: 6.0','Slider snapping or standard interpolation failed');
            const tabs=component(gallery.actor,'tabs');
            const tabButtons=tabs.get_first_child().get_children();tabButtons[1].emit('clicked',1);
            assert(component(gallery.actor,'formatting').get_parent().visible && !component(gallery.actor,'inputs').get_parent().visible,'Tab selection failed');
            assert(component(gallery.actor,'money').text==='€6.00','Standard currency formatting failed');
            tabButtons[0].emit('clicked',1);
            const date=component(gallery.actor,'date');
            const dateEntry=all(date).find(actor=>actor instanceof St.Entry);
            dateEntry.set_text('2026-11-15');dateEntry.clutter_text.emit('activate');
            assert(galleryData().date==='2026-11-15','Date input did not update its model');
            dateEntry.set_text('2026-02-30');dateEntry.clutter_text.emit('activate');
            assert(galleryData().date==='2026-11-15','Invalid calendar date entered the model');
            dateEntry.set_text('2027-01-01');dateEntry.clutter_text.emit('activate');
            assert(galleryData().date==='2026-11-15','Date range bounds were ignored');
            const calendar=date.a2uiCalendar;
            const calendarButton=all(date).find(actor=>actor instanceof St.Button && actor.accessible_name==='Choose date');
            calendarButton.emit('clicked',1);assert(calendar.visible,'Calendar picker did not open');
            calendar.emit('selected-date-changed',date.a2uiCalendarUsesGLib?GLib.DateTime.new_local(2026,11,16,0,0,0):new Date(2026,10,16));
            assert(galleryData().date==='2026-11-16','Native calendar selection failed');
            assert(component(gallery.actor,'day').text==='Monday, 16 November 2026','Standard date pattern failed in GNOME');
            const timeEntry=all(component(gallery.actor,'time')).find(actor=>actor instanceof St.Entry);
            timeEntry.set_text('15:45');timeEntry.clutter_text.emit('activate');
            assert(galleryData().time==='15:45','Time input failed');
            const filtered=component(gallery.actor,'choiceFilter');
            const filterInput=all(filtered).find(actor=>actor instanceof St.Entry);
            filterInput.set_text('second');
            const filterButtons=all(filtered).filter(actor=>actor instanceof St.Button);
            assert(!filterButtons[0].visible && filterButtons[1].visible,'Local choice filtering failed');
            filterButtons[1].checked=true;filterButtons[1].emit('clicked',1);
            assert(galleryData().selection[0]==='two','Standard checkbox choice failed');
            assert(component(gallery.actor,'standardIcon').icon_name==='edit-find-symbolic','Standard icon name mapping failed');
            assert(component(gallery.actor,'svgIcon').gicon,'SVG path icon failed');
            const priorMessages=view._visibleMessages.length;
            component(gallery.actor,'details').emit('clicked',1);await pause();
            assert(gallery._dialogs[0].contentLayout.mapped,'Native modal did not open');
            assert(view._visibleMessages.length===priorMessages && !view._run,'Opening a modal incorrectly called the agent');
            gallery._dialogs[0].close();await pause();await pause();
            component(gallery.actor,'details').emit('clicked',1);await pause();
            assert(gallery._dialogs[0].contentLayout.mapped,'Modal could not reopen after closing');
            gallery._dialogs[0].close();await pause();await pause();
            const {default:Gst}=await import('gi://Gst?version=1.0');Gst.init(null);
            for(const name of ['audio','video']) {
                const media=component(gallery.actor,name).a2uiMedia;
                media.audioSink=Gst.ElementFactory.make('fakesink',null);media.audioSink.sync=true;
                await media.toggle();await pause();await pause();
                assert(media.pipeline && !media.status.text.includes('unavailable'),name+' playback failed: '+media.status.text);
                media.volume.value=0.25;
                assert(Math.abs(media.pipeline.volume-0.25)<0.001,name+' volume control failed');
                if(media._duration)media.seek.value=0.5;
                if(name==='video') {
                    for(let tries=0;!media._videoActor.content && tries<30;tries++)await pause();
                    assert(media._videoActor.content,'Video did not produce inline frames');
                }
                await media.toggle();assert(!media._playing,name+' did not pause');
                media.reset();assert(!media.pipeline,name+' did not stop');
                media.setSource('/etc/passwd','Outside workspace','');
                let outsideRejected=false;
                try{await media.toggle();}catch{outsideRejected=true;}
                assert(outsideRejected && !media.pipeline,'Media accessed a file outside the workspace');

            }
            view._scrollView.vadjustment.value=0;
            const galleryStream=Gio.File.new_for_path(root+'/components.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new screenshot.default.Screenshot().screenshot(false,galleryStream);galleryStream.close(null);
            view.destroy();
            await this.testOverviewTyping(root);
            print('A2UI TEST PASSED');
        } finally {
            if(!view._destroyed)view.destroy();
            theme.unload_stylesheet(stylesheet);
        }
    }

    async testAcpOptions(view,settings,root) {
        const wait=async condition=>{
            for(let index=0;index<70;index++) {if(condition())return;await pause();}
            throw new Error('Timed out waiting for radio options');
        };
        await wait(()=>JSON.parse(settings.get_string('acp-config-state')).ready && !view._configApplyPromise);
        const option=id=>view._acpConfigOptions.find(item=>item.id===id);
        const open=async title=>{
            view._showAcpOptions();await pause();
            const menu=view._acpOptionsMenu;
            assert(menu?.isOpen,'The agent options menu did not open');
            const section=menu._getMenuItems().find(item=>item.label?.text===title);
            assert(section,'The agent option group is missing: '+title);
            section.menu.open({animate:false});await pause();
            return section.menu._getMenuItems().filter(item=>item.has_style_class_name('ai-config-choice'));
        };
        const checked=rows=>rows.filter(item=>item.get_accessible().ref_state_set().contains_state(Atk.StateType.CHECKED));
        const title=row=>row.label_actor.text;
        const {default:Shell}=await import('gi://Shell');
        let rows=await open('Model');
        assert(rows.length===3 && rows.every(row=>row instanceof PopupMenu.PopupMenuItem &&
            row.accessible_role===Atk.Role.RADIO_MENU_ITEM),'Agent choices are not native, accessible menu items');
        assert(checked(rows).length===1 && title(checked(rows)[0])==='Quick','Current model is not selected exclusively');
        assert(all(view._acpOptionsMenu.actor).some(actor=>actor.text==='Test models'),'Native model group heading disappeared');
        const indicator=checked(rows)[0].get_children().find(actor=>actor instanceof St.Icon);
        assert(indicator.icon_name==='ornament-dot-checked-symbolic','Selection does not use Shell’s native indicator');
        const section=view._acpOptionsMenu._getMenuItems().find(item=>item.label?.text==='Model');
        const reference=new PopupMenu.PopupMenuItem('Native reference');
        reference.setOrnament(PopupMenu.Ornament.DOT);section.menu.addMenuItem(reference,1);await pause();
        const geometryStyle=actor=>{
            const node=actor.get_theme_node();
            return [Object.values(St.Side).map(side=>node.get_padding(side)),
                Object.values(St.Corner).map(corner=>node.get_border_radius(corner))];
        };
        assert(JSON.stringify(geometryStyle(rows[0]))===JSON.stringify(geometryStyle(reference)),
            'Agent choice styling overrides native menu geometry');
        reference.destroy();await pause();
        const popup=view._acpOptionsMenu.actor;
        const [popupX]=popup.get_transformed_position(),[popupWidth]=popup.get_transformed_size();
        assert(popupX>=0 && popupX+popupWidth<=global.stage.width+1,'Agent options overflow the monitor');
        const image=Gio.File.new_for_path(root+'/agent-radio-options.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
        await new Shell.Screenshot().screenshot(false,image);image.close(null);
        const keyboard=global.stage.get_context().get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        rows[0].grab_key_focus();
        keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Down,Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Down,Clutter.KeyState.RELEASED);await pause();
        assert(global.stage.get_key_focus()===rows[1],'Arrow keys do not navigate the radio choices');
        keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Return,Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Return,Clutter.KeyState.RELEASED);
        await wait(()=>!view._acpOptionsMenu && !view._configApplyPromise && option('engine-choice').currentValue==='deep');
        rows=await open('Model');
        assert(checked(rows).length===1 && title(checked(rows)[0])==='Deep','Confirmed model is not reflected when reopened');
        view._acpOptionsMenu.close();await wait(()=>!view._acpOptionsMenu);
        rows=await open('Thinking effort');
        assert(rows.length===2 && rows.some(row=>title(row)==='High'),'Model change did not refresh available effort choices');
        rows.find(row=>title(row)==='High').activate(null);
        await wait(()=>!view._acpOptionsMenu && !view._configApplyPromise && option('depth-choice').currentValue==='high');
        rows=await open('Model');
        rows.find(row=>title(row)==='Rejected').activate(null);
        await wait(()=>!view._acpOptionsMenu && !view._configApplyPromise && view._configError);
        assert(option('engine-choice').currentValue==='deep' &&
            JSON.parse(settings.get_string('acp-config-values')).test['engine-choice']==='deep',
            'Rejected radio selection replaced the confirmed model');
        // While working, the menu offers only Preferences: its last item, a button.
        view._run={};view._showAcpOptions();await pause();
        const busyItems=view._acpOptionsMenu?._getMenuItems()??[];
        const preferencesButton=item=>all(item.actor??item).find(actor=>actor instanceof St.Button && actor.accessible_name==='Preferences');
        assert(view._acpOptionsMenu?.isOpen && busyItems.length===1 && preferencesButton(busyItems[0]),
            'Agent options can change while working, or Preferences is missing: '+busyItems.map(item=>item.label?.text));
        view._acpOptionsMenu.close();await wait(()=>!view._acpOptionsMenu);view._run=null;
        // Normally it comes last, after the agent's options, and asks to open Preferences.
        view._showAcpOptions();await pause();
        const items=view._acpOptionsMenu._getMenuItems();
        assert(items.length>2 && items.at(-2) instanceof PopupMenu.PopupSeparatorMenuItem && preferencesButton(items.at(-1)),
            'Preferences is not the last item of the options menu');
        const menuShot=Gio.File.new_for_path(root+'/options-preferences.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
        await new Shell.Screenshot().screenshot(false,menuShot);menuShot.close(null);
        let requested=0;const requestSignal=view.connect('preferences-requested',()=>requested++);
        preferencesButton(items.at(-1)).emit('clicked',1);
        await wait(()=>!view._acpOptionsMenu);view.disconnect(requestSignal);
        assert(requested===1,'The Preferences button did not ask to open Preferences');
        await open('Thinking effort');
        print('ACP RADIO OPTIONS TEST PASSED');
    }

    async testThemeGallery(settings,root,stylesheet) {
        const {default:Shell}=await import('gi://Shell');
        const context=St.ThemeContext.get_for_stage(global.stage),original=context.get_theme();
        const resource=Gio.Resource.load('/usr/share/gnome-shell/gnome-shell-theme.gresource');
        const desktop=new Gio.Settings({schema_id:'org.gnome.desktop.interface'});
        const accent=desktop.get_string('accent-color');
        let view;
        const capture=async name=>{
            const output=Gio.File.new_for_path(root+'/'+name+'.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,output);output.close(null);
        };
        try {
            view=new AiView(settings);view.set_position(40,50);view.set_size(1200,800);
            global.stage.add_child(view);view.show();
            const user=view.addMessage('You','Can you help me plan my afternoon?');
            const answer=view.addMessage('GNOME Assistant','Here’s a plan with time for focused work and a break.\n\n### Your afternoon\n- Finish the project update\n- Take a walk\n\n[Open your notes](https://example.com/notes)');
            const store=new A2uiStore();
            store.apply({version:'1.0',createSurface:{surfaceId:'theme',catalogId:A2UI_CATALOG_ID,components:[
                {id:'root',component:'Card',child:'body'},
                {id:'body',component:'Column',children:['heading','name','choice','done']},
                {id:'heading',component:'Row',children:['icon','title']},
                {id:'icon',component:'Icon',name:'x-office-calendar-symbolic'},
                {id:'title',component:'Text',text:'Make time for what matters',variant:'h3'},
                {id:'name',component:'TextField',label:'Focus',value:{'@path':'/focus'}},
                {id:'choice',component:'ChoicePicker',displayStyle:'chips',label:'When',value:{'@path':'/when'},options:[{label:'Today',value:'today'},{label:'Tomorrow',value:'tomorrow'}]},
                {id:'done',component:'Button',variant:'primary',child:'doneText',action:{event:{name:'save'}}},
                {id:'doneText',component:'Text',text:'Save plan'},
            ],dataModel:{focus:'Finish the project update',when:['today']}}});
            const ui=new (await import('../a2uiView.js')).A2uiView(store,'theme',{
                text:(style,text)=>view._createTextLabel(style,text),image:()=>new St.Widget(),action:()=>{},
            });
            answer.extras.add_child(ui.actor);
            view._threadId='theme-preview';view._threadCwd=root+'/workspace';
            view._rememberConversation(user.text,answer.text,[]);await view._memoryWrites;
            const probe=new St.Button({style_class:'button default',label:'Native primary'});
            const nativeCard=new St.Widget({style_class:'message',reactive:true});
            const nativeSurface=new St.Widget({style_class:'popup-menu popup-menu-content'});
            for(const actor of [probe,nativeCard,nativeSurface]) {actor.opacity=0;global.stage.add_child(actor);}
            let firstAccent;
            for(const [name,colour] of [['dark','orange'],['light','purple'],['high-contrast','blue']]) {
                const css=root+'/gnome-shell-'+name+'.css';
                GLib.file_set_contents(css,resource.lookup_data('/org/gnome/shell/theme/gnome-shell-'+name+'.css',0).get_data());
                const theme=new St.Theme({application_stylesheet:Gio.File.new_for_path(css)});
                theme.load_stylesheet(stylesheet);context.set_theme(theme);desktop.set_string('accent-color',colour);
                for(let index=0;index<5;index++)await pause();
                const background=actor=>actor.get_theme_node().get_background_color().to_string();
                const foreground=actor=>actor.get_theme_node().get_foreground_color().to_string();
                assert(background(view)===background(nativeSurface),name+': assistant surface overrides the Shell theme');
                assert(background(answer.actor)===background(nativeCard),name+': reply card overrides the Shell theme');
                assert(background(user.actor)===background(probe) && foreground(user.actor)===foreground(probe),
                    name+': user message is not using the native accent palette');
                assert(background(view._chatTabButton)===background(probe),name+': selected tab lost the native accent');
                const field=all(component(ui.actor,'name')).find(actor=>actor instanceof St.Entry);
                const before=field.get_size();field.grab_key_focus();await pause();
                assert(before.every((value,index)=>Math.abs(value-field.get_size()[index])<=1),name+': focusing a field changed its size');
                const selected=all(component(ui.actor,'choice')).find(actor=>actor instanceof St.Button && actor.checked);
                assert(background(selected)===background(probe) && foreground(selected)===foreground(probe),
                    name+': selected choice does not match native accent colours');
                print('THEME GALLERY '+JSON.stringify({name,accent:background(probe),surface:background(view),card:background(answer.actor),text:foreground(answer.actor)}));
                if(name==='dark') firstAccent=background(probe);
                if(name==='light') assert(firstAccent!==background(probe),'Changing the GNOME accent did not update the interface');
                view._scrollView.vadjustment.value=0;
                await capture('theme-'+name+'-chat');
                view._setActiveTab('history');await pause();await capture('theme-'+name+'-history');
                view._setActiveTab('chat');
                view._showApproval('theme-preview',{title:'Allow this command?',canAccept:true,decide:()=>{},
                    command:{reason:'Create a note in your workspace.',cwd:root+'/workspace',command:'printf hello > notes.txt'}});
                await pause();
                const preview=all(view._approvals.get('theme-preview')).find(actor=>actor.has_style_class_name?.('ai-approval-preview'));
                assert(preview.height>80,name+': command approval preview collapsed');
                const command=all(preview).find(actor=>actor.text==='printf hello > notes.txt');
                assert(command?.mapped && command.height>15,name+': command text has no visible space');
                const approval=view._approvals.get('theme-preview'),actions=approval.get_last_child();
                assert(actions.y+actions.height<=approval.height-approval.get_theme_node().get_padding(St.Side.BOTTOM)+1,
                    name+': approval actions overflow the card '+JSON.stringify({height:approval.height,
                        actions:[actions.y,actions.height],preview:[preview.y,preview.height]}));
                await capture('theme-'+name+'-approval');view._clearApproval('theme-preview');
                view._showApproval('theme-long',{title:'Review details',canAccept:true,decide:()=>{},
                    preview:Array.from({length:40},(_,index)=>'Permission detail '+index).join('\n')});
                await pause();
                const long=all(view._approvals.get('theme-long')).find(actor=>actor.has_style_class_name?.('ai-approval-preview'));
                const adjustment=long.vadjustment ?? long.vscroll.adjustment;
                assert(long.height<=long.get_theme_node().get_max_height()+1 && adjustment.upper>adjustment.page_size,
                    name+': long approval does not stay bounded and scroll');
                view._clearApproval('theme-long');
            }
            for(const actor of [probe,nativeCard,nativeSurface]) actor.destroy();
            view._startNewConversation();await pause();await capture('theme-welcome');
        } finally {
            view?.destroy();desktop.set_string('accent-color',accent);context.set_theme(original);
        }
    }

    async testFileDownloads(view,root,turn) {
        await turn('files');
        const message=view._visibleMessages.at(-1);
        assert(message.attachments?.length===3 && message.text==='',
            'MCP files were not delivered, or a file-only reply showed an empty-response warning');
        const expected=['report.txt','results.zip','data.bin'];
        assert(message.attachments.every((record,index)=>record.name===expected[index]),'Delivered filenames changed');
        const saved=await view._loadMemoryEntriesAsync();
        assert(saved.at(-1).attachments?.length===3,'Delivered files were not saved in chat history');
        GLib.mkdir_with_parents(root+'/downloads',0o700);
        const choose=view._chooseAttachmentSavePath;
        view._chooseAttachmentSavePath=async name=>root+'/downloads/'+name;
        try {
            for(const name of expected) {
                const button=all(message.extras).find(actor=>actor.accessible_name==='Download '+name);
                assert(button?.reactive,'Download button is missing for '+name);
                button.emit('clicked',1);
                for(let tries=0;!button.reactive && tries<50;tries++)await pause();
                assert(GLib.file_test(root+'/downloads/'+name,GLib.FileTest.IS_REGULAR),'Download did not save '+name);
            }
            assert(new TextDecoder().decode(GLib.file_get_contents(root+'/downloads/report.txt')[1])==='Risultato: caffè ☕\n',
                'Downloaded text bytes changed');
            const binary=GLib.file_get_contents(root+'/downloads/data.bin')[1];
            assert(JSON.stringify([...binary])==='[0,255,1,0,128,254]','Binary upload/download changed bytes');
            assert(all(message.extras).filter(actor=>actor instanceof St.Label && actor.text==='Saved').length===3,
                'Download completion was not shown');
            view._chooseAttachmentSavePath=async()=>null;
            const button=all(message.extras).find(actor=>actor.accessible_name==='Download report.txt');
            button.emit('clicked',1);await pause();
            assert(button.reactive,'Cancelling Save As left the download disabled');
            view._scrollView.vadjustment.value=0;
            const {default:Shell}=await import('gi://Shell');
            const image=Gio.File.new_for_path(root+'/download-cards.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,image);image.close(null);
        } finally {view._chooseAttachmentSavePath=choose;}
    }

    // History search, rename, pin and Markdown export, on three old
    // conversations added to the saved history and removed afterwards.
    async testHistory(view,root) {
        const add=(sessionId,ts,user,reply)=>{
            for(const [role,content,offset] of [['user',user,0],['assistant',reply,1]])
                view._appendMemoryEntry({role,content,ts:ts+offset,sessionId,profile:'test'});
        };
        add('hist-a',1000,'Plan a trip to Zürich histtest','Visit the old town.');
        add('hist-b',2000,'Résumé help histtest','Mention your café job first.');
        add('hist-c',3000,'Fix the build histtest','The build passes now.');
        view._setActiveTab('history');await view._refreshHistoryView();
        const rows=()=>all(view._historyBox).filter(actor=>actor.has_style_class_name?.('ai-history-row'));
        const titles=()=>rows().map(row=>all(row).find(actor=>actor.has_style_class_name?.('ai-history-title')).text);
        const button=name=>all(view._historyBox).find(actor=>actor.accessible_name===name);
        const menuItem=async(name,label)=>{
            button(name).emit('clicked',1);await pause();
            // The menu takes the pointer and focus from the row: its actions must stay visible meanwhile.
            const actions=button(name).get_parent().get_children().filter(actor=>actor.has_style_class_name?.('ai-history-action'));
            assert(view._historyMenu?.isOpen && actions.length===3 && actions.every(actor=>actor.opacity===255),
                'Row actions hid while their menu was open: '+JSON.stringify(actions.map(actor=>actor.opacity)));
            view._historyMenu._getMenuItems().find(item=>item.label?.text===label).activate(Clutter.get_current_event());
            await pause();
        };
        const search=view._historySearch;
        search.grab_key_focus();
        search.set_text('ZURICH  histtest');
        assert(JSON.stringify(titles())==='["Plan a trip to Zürich histtest"]','Search did not filter by title: '+titles());
        assert(global.stage.key_focus===search.clutter_text,'Typing a search lost the entry focus');
        assert(all(rows()[0]).find(actor=>actor.has_style_class_name?.('ai-history-title')).clutter_text.use_markup,
            'Search matches are not highlighted');
        search.set_text('cafe');
        assert(JSON.stringify(titles())==='["Résumé help histtest"]' &&
            all(rows()[0]).some(actor=>actor.text?.includes('your café job')),'Message search or its snippet failed');
        search.set_text('nomatch histtest');
        assert(rows().length===0 && all(view._historyBox).some(actor=>actor.text==='No conversations match “nomatch histtest”.'),
            'Search has no empty state');
        search.set_text('');
        await menuItem('More actions: Plan a trip to Zürich histtest','Rename…');
        const rename=all(view._historyBox).find(actor=>actor.accessible_name==='Conversation title');
        assert(rename && global.stage.key_focus===rename.clutter_text,'Rename did not open an entry');
        rename.set_text('Trip / Zürich');rename.clutter_text.emit('activate');
        await view._refreshHistoryView();
        assert(titles().includes('Trip / Zürich'),'Renamed title is not shown after refresh: '+titles());
        assert(JSON.stringify(titles().slice(-3))==='["Fix the build histtest","Résumé help histtest","Trip / Zürich"]',
            'History is not newest first: '+titles());
        button('Pin conversation: Résumé help histtest').emit('clicked',1);
        await view._refreshHistoryView();
        assert(titles()[0]==='Résumé help histtest' && button('Unpin conversation: Résumé help histtest'),'Pinning did not move to top');
        const meta=root+'/state/gnome-assistant/history-meta.json';
        assert(JSON.stringify(JSON.parse(new TextDecoder().decode(GLib.file_get_contents(meta)[1])).conversations)===
            '{"hist-a":{"title":"Trip / Zürich"},"hist-b":{"pinned":true}}','Metadata file differs');
        search.set_text('histtest');rows()[0].get_first_child().grab_key_focus();await pause();
        const historyImage=Gio.File.new_for_path(root+'/history.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
        const {default:Shell}=await import('gi://Shell');
        await new Shell.Screenshot().screenshot(false,historyImage);historyImage.close(null);
        const choosePath=view._choosePath;
        let picked;
        view._choosePath=async(action,name)=>{picked=[action,name];return root+'/exported.md';};
        try {
            await menuItem('More actions: Trip / Zürich','Export…');
            for(let tries=0;!GLib.file_test(root+'/exported.md',GLib.FileTest.EXISTS) && tries<30;tries++)await pause();
        } finally {view._choosePath=choosePath;}
        assert(JSON.stringify(picked)==='["export","Trip Zürich.md"]','Export did not use the picker: '+picked);
        const markdown=new TextDecoder().decode(GLib.file_get_contents(root+'/exported.md')[1]);
        assert(markdown===`# Trip / Zürich\n\n- **Date:** ${view._formatTimestamp(1000)}\n- **Agent:** A2UI fixture\n\n`+
            `### You\n\nPlan a trip to Zürich histtest\n\n### ${view.assistantName}\n\nVisit the old town.\n`,'Export differs:\n'+markdown);
        view._selectedHistorySessionId='hist-a';await view._refreshHistoryView();
        assert(all(view._historyBox).some(actor=>actor.text==='Trip / Zürich' && actor.has_style_class_name('ai-history-detail-title')) &&
            button('Export conversation') && !search.visible,'Conversation view lost the custom title or export');
        view._selectedHistorySessionId=null;
        for(const id of ['hist-a','hist-b','hist-c'])view._deleteHistorySession(id);
        await view._memoryWrites;
        assert(!GLib.file_test(meta,GLib.FileTest.EXISTS),'Deleting conversations kept their metadata');
        search.set_text('');view._setActiveTab('chat');
        // Tab changes fade out, then in: wait until the chat is shown again,
        // so the next test does not start against a hidden view.
        for(let i=0;i<40 && !(view._scrollView.visible && view._scrollView.opacity===255);i++)await pause();
    }

    async testStreamingUI(view,root,turn) {
        const cancelled=view.generateResponse('large-file-cancel');
        let cancel;
        for(let tries=0;!cancel && tries<50;tries++) {
            await pause();
            cancel=all(view._visibleMessages.at(-1).extras).find(actor=>actor.accessible_name==='Cancel transfer large-transfer.bin');
        }
        assert(cancel,'A receiving file did not show progress/cancellation controls');
        cancel.emit('clicked',1);await cancelled;
        assert(view._visibleMessages.at(-1).text==='Transfer cancelled.' &&
            !view._visibleMessages.at(-1).attachments?.length,'A cancelled transfer left a downloadable partial file');
        // A user file over 8 MiB is offered for download, not embedded:
        // the agent streams it with attachment_download.
        const datasetPath=root+'/workspace/dataset.bin';
        const dataset=new Uint8Array(12*1024*1024).map((_,index)=>(index*31+7)&255);
        GLib.file_set_contents(datasetPath,dataset);
        view._queuedFiles.push(await selectAttachment(datasetPath));view._updateAttachmentButton();
        await turn('Please download the attached file.');
        const datasetDigest=GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256,dataset);
        assert(view._visibleMessages.at(-1).text===`Downloaded dataset.bin: ${dataset.length} bytes, sha256 ${datasetDigest}`,
            'The agent did not download the attached file intact: '+JSON.stringify(view._visibleMessages.at(-1).text));
        const sharedFile=view._sharedItems.find(item=>item.kind==='file' && item.name==='dataset.bin');
        assert(sharedFile?.delivery==='stream' && sharedFile.downloads.length===1 && sharedFile.downloads[0].ok,
            'The Shared view did not record the download: '+JSON.stringify(sharedFile?.downloads));
        // A folder is streamed as one tar archive the agent extracts.
        const folderPath=root+'/workspace/project';
        GLib.mkdir_with_parents(folderPath+'/src',0o700);
        GLib.file_set_contents(folderPath+'/README.md','# Project\n');
        GLib.file_set_contents(folderPath+'/src/main.py','print("hello")\n');
        view._queuedFiles.push(await selectFolder(folderPath));view._updateAttachmentButton();
        await turn('Please download the attached folder.');
        assert(view._visibleMessages.at(-1).text==='Extracted project: project/README.md, project/src/main.py',
            'The agent did not receive the folder archive: '+JSON.stringify(view._visibleMessages.at(-1).text));
        await turn('large-file');
        const message=view._visibleMessages.at(-1),record=message.attachments?.[0];
        assert(record?.size===16*1024*1024,'A streamed file larger than 8 MiB was rejected or truncated');
        const choose=view._chooseAttachmentSavePath;
        view._chooseAttachmentSavePath=async()=>root+'/downloaded-large.bin';
        try {
            const button=all(message.extras).find(actor=>actor.accessible_name==='Download large-transfer.bin');
            button.emit('clicked',1);
            for(let tries=0;!button.reactive && tries<100;tries++)await pause();
            const file=Gio.File.new_for_path(root+'/downloaded-large.bin');
            assert(file.query_info('standard::size',0,null).get_size()===record.size,'Large download was not saved completely');
            const stream=file.read(null),actual=new GLib.Checksum(GLib.ChecksumType.SHA256);
            for(let bytes;(bytes=stream.read_bytes(65536,null)).get_size();)actual.update(bytes.get_data());
            stream.close(null);
            const expected=new GLib.Checksum(GLib.ChecksumType.SHA256),block=new Uint8Array(65536);
            for(let index=0;index<block.length;index++)block[index]=index%256;
            for(let index=0;index<256;index++)expected.update(block);
            assert(actual.get_string()===expected.get_string(),'The streamed upload/download changed file bytes');
        } finally {view._chooseAttachmentSavePath=choose;}
    }

    // A desktop context focused on another project offers a workspace switch.
    // Path links, code block actions and diff approvals. Launching, the
    // clipboard and the save picker are stubbed: nothing opens for real.
    async testReplyActions(view,root,turn) {
        const workspace=root+'/workspace';
        GLib.mkdir_with_parents(workspace+'/project/src',0o700);
        GLib.file_set_contents(workspace+'/run.sh','#!/bin/sh\necho hi\n');
        Gio.File.new_for_path(workspace+'/run.sh').set_attribute_uint32('unix::mode',0o755,Gio.FileQueryInfoFlags.NONE,null);
        await turn('paths');
        const message=view._visibleMessages.at(-1);
        const named=name=>all(message.bodyBox).find(actor=>actor.accessible_name===name);
        assert(named('Open preview.png:3') && named(`Open ${workspace}/tone.wav:10:2`) && named('Open ./project/src/'),
            'Existing paths did not become links: '+all(message.bodyBox).map(actor=>actor.accessible_name).filter(Boolean).join(' | '));
        assert(!all(message.bodyBox).some(actor=>/missing-file|absent|example/.test(actor.accessible_name??'')),
            'A missing path or a URL became a path link');
        const launch=Gio.AppInfo.launch_default_for_uri,launched=[];
        let opened=0;
        const signal=view.connect('external-opened',()=>opened++);
        Gio.AppInfo.launch_default_for_uri=uri=>{launched.push(uri);return true;};
        try {
            for(const name of ['Open preview.png:3','Open ./project/src/',`Open ${workspace}/run.sh`])
                named(name).emit('clicked',1);
        } finally {Gio.AppInfo.launch_default_for_uri=launch;view.disconnect(signal);}
        const uri=path=>Gio.File.new_for_path(path).get_uri();
        assert(JSON.stringify(launched)===JSON.stringify([uri(workspace+'/preview.png'),uri(workspace+'/project/src'),uri(workspace)]) &&
            opened===3,'Path links did not open files, folders, or the folder of a runnable file: '+JSON.stringify(launched));
        const clipboard=St.Clipboard.get_default;
        let copied=null;
        St.Clipboard.get_default=()=>({set_text:(_type,text)=>{copied=text;}});
        try {named('Copy code').emit('clicked',1);} finally {St.Clipboard.get_default=clipboard;}
        assert(copied==='print("hi")','Code block Copy handed the wrong text to the clipboard: '+JSON.stringify(copied));
        const choose=view._choosePath;
        let asked=null;
        view._choosePath=async(action,name)=>{asked=[action,name];return root+'/saved-'+name;};
        try {
            named('Save code as…').emit('clicked',1);
            for(let tries=0;!GLib.file_test(root+'/saved-snippet.py',GLib.FileTest.EXISTS) && tries<30;tries++)await pause();
        } finally {view._choosePath=choose;}
        assert(JSON.stringify(asked)==='["save-code","snippet.py"]' &&
            new TextDecoder().decode(GLib.file_get_contents(root+'/saved-snippet.py')[1])==='print("hi")\n',
            'Save as… did not save the code block through the picker');
        const remote=new St.BoxLayout();
        view._renderMarkdownToBox(remote,`\`${workspace}/preview.png\` and ${workspace}/tone.wav`,workspace,null,true);
        assert(!all(remote).some(actor=>actor.accessible_name?.startsWith('Open ')),'A remote agent\'s paths became links');
        remote.destroy();
        view._scrollView.vadjustment.value=view._scrollView.vadjustment.upper;
        const {default:Shell}=await import('gi://Shell');
        const capture=async name=>{
            await pause();
            const stream=Gio.File.new_for_path(`${root}/${name}.png`).replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,stream);stream.close(null);
        };
        await capture('reply-actions');
        const approval=view._showApproval;
        let card=null;
        view._showApproval=(id,options)=>{approval.call(view,id,options);card=view._approvals.get(id);};
        try {
            const pending=view.generateResponse('diff-approval');
            for(let tries=0;!card && tries<50;tries++)await pause();
            const diff=card && all(card).find(actor=>actor.has_style_class_name?.('ai-diff'));
            const line=(style,text)=>all(diff).some(actor=>actor.has_style_class_name?.(style) && actor.text.split('\n').includes(text));
            assert(diff && all(diff).some(actor=>actor.text===workspace+'/notes.txt') &&
                line('ai-diff-removed','-line 5') && line('ai-diff-added','+line five') && line('ai-diff-context',' line 4') &&
                !line('ai-diff-context',' line 1'),'The approval did not show the change as a diff with context');
            const more=all(card).find(actor=>actor.label?.startsWith?.('Show all'));
            assert(more && !line('ai-diff-added','+line 61'),'A long diff was not collapsed');
            more.emit('clicked',1);
            assert(line('ai-diff-added','+line 61') && line('ai-diff-removed','-line 40'),'Show all did not expand the diff');
            await capture('diff-approval');
            card.get_last_child().get_last_child().emit('clicked',1);
            await pending;await pause();
        } finally {view._showApproval=approval;}
        assert(view._visibleMessages.at(-1).text==='Diff approved.','Allowing a diff approval failed');
    }

    async testOverviewTyping(root) {
        const assistant=new GnomeAssistantExtension({...this.metadata,'settings-schema':'org.gnome.shell.extensions.gnome-assistant'});
        const backend=global.stage.get_context().get_backend();
        const keyboard=backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const pointer=backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const trace=GLib.getenv('GNOME_ASSISTANT_TRACE_INPUT')?global.stage.connect('captured-event',(_stage,event)=>{
            if(event.type()===Clutter.EventType.BUTTON_PRESS) {
                const [x,y]=event.get_coords();
                print('INPUT TRACE '+JSON.stringify({button:event.get_button(),coords:[x,y],modal:Main.modalCount,
                    mode:assistant._isAiMode,pick:String(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,x,y)),
                    box:assistant._promptBox?.get_transformed_position(),size:assistant._promptBox?.get_transformed_size()}));
            }
            return Clutter.EVENT_PROPAGATE;
        }):0;
        const key=async symbol=>{
            keyboard.notify_keyval(GLib.get_monotonic_time(),symbol,Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(),symbol,Clutter.KeyState.RELEASED);
            await pause();
        };
        const click=async actor=>{
            const [x,y]=actor.get_transformed_position();
            const [width,height]=actor.get_transformed_size();
            pointer.notify_absolute_motion(GLib.get_monotonic_time(),x+width/2,y+height/2);
            await pause();
            const [pointerX,pointerY]=global.get_pointer();
            if(Math.abs(pointerX-x-width/2)>1 || Math.abs(pointerY-y-height/2)>1) {
                pointer.notify_relative_motion(GLib.get_monotonic_time(),x+width/2-pointerX,y+height/2-pointerY);
                await pause();
            }
            const [actualX,actualY]=global.get_pointer();
            assert(Math.abs(actualX-x-width/2)<2 && Math.abs(actualY-y-height/2)<2,
                'Virtual pointer did not reach the prompt: '+JSON.stringify({x,y,width,height,actualX,actualY}));
            pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.PRESSED);
            pointer.notify_button(GLib.get_monotonic_time(),Clutter.BUTTON_PRIMARY,Clutter.ButtonState.RELEASED);
            await pause();
        };
        try {
            assistant.enable();
            for(let i=0;i<50 && Main.layoutManager._startingUp;i++)await pause();
            Main.overview.show();for(let i=0;i<8;i++)await pause();
            assistant._searchEntry.grab_key_focus();await pause();
            const geometry=actor=>[...actor.get_transformed_position(),...actor.get_transformed_size()];
            const decoration=actor=>{
                const node=actor.get_theme_node(),shadow=node.get_box_shadow();
                return {
                    background:node.get_background_color().to_string(),
                    padding:Object.values(St.Side).map(side=>node.get_padding(side)),
                    margins:Object.values(St.Side).map(side=>node.get_margin(side)),
                    border:Object.values(St.Side).map(side=>node.get_border_width(side)),
                    shadow:shadow?[shadow.color.to_string(),shadow.xoffset,shadow.yoffset,shadow.blur,shadow.spread,shadow.inset]:null,
                };
            };
            const nativeGeometry=geometry(assistant._searchEntry);
            const nativeDecoration=decoration(assistant._searchEntry);
            const nativeRadius=assistant._searchEntry.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
            const nativeTextPosition=assistant._searchTextActor.get_transformed_position();
            const {default:PromptShell}=await import('gi://Shell');
            const capture=async name=>{
                const stream=Gio.File.new_for_path(root+'/'+name+'.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
                await new PromptShell.Screenshot().screenshot(false,stream);stream.close(null);
            };
            await capture('native-search');
            Main.overview.hide();for(let i=0;i<5;i++)await pause();
            keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Super_L,Clutter.KeyState.PRESSED);
            await key(Clutter.KEY_x);
            keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Super_L,Clutter.KeyState.RELEASED);
            for(let i=0;i<8;i++)await pause();
            const compactGeometry=geometry(assistant._promptBox);
            print('PROMPT THEME '+JSON.stringify({nativeGeometry,compactGeometry,nativeDecoration,
                compactDecoration:decoration(assistant._promptBox),nativeTextPosition,
                compactTextPosition:assistant._promptEditor.clutter_text.get_transformed_position()}));
            assert(nativeGeometry.every((value,index)=>Math.abs(value-compactGeometry[index])<=1),
                'The compact prompt does not match native search geometry');
            assert(JSON.stringify(decoration(assistant._promptBox))===JSON.stringify(nativeDecoration),
                'The compact prompt does not match native search decoration');
            assert(assistant._promptBox.get_theme_node().get_border_radius(St.Corner.TOPLEFT)===nativeRadius,
                'The compact prompt has a different native corner radius');
            assert(nativeTextPosition.every((value,index)=>
                Math.abs(assistant._promptEditor.clutter_text.get_transformed_position()[index]-value)<=1),
                'The compact prompt text is not aligned with native search');
            await capture('assistant-compact');
            await key(Clutter.KEY_a);
            for(let i=0;i<5;i++)await pause();
            assert(assistant._promptEditor,'The overview composer did not open');
            assert(global.stage.get_key_focus()===assistant._promptEditor.clutter_text,'Opening assistant mode did not focus the prompt');
            if(assistant._searchTextActor.get_input_interceptor)
                assert(!assistant._searchTextActor.get_input_interceptor(),'Hidden native search still intercepts typing');
            if(assistant._promptEditor.clutter_text.get_input_interceptor)
                assert(assistant._promptEditor.clutter_text.get_input_interceptor()===global.stage,
                    'The assistant composer does not receive overview type-to-search input');
            assert(assistant._getSearchEntryText()==='a','Typing in the overview failed: '+JSON.stringify({
                editor:assistant._promptEditor?.get_text(),native:assistant._searchEntry.get_text(),
                focus:String(global.stage.get_key_focus())}));
            assert(JSON.stringify(decoration(assistant._promptBox))===JSON.stringify(nativeDecoration),
                'The expanded prompt lost native search colours, padding or focus decoration');
            assert(Math.abs(assistant._promptBox.get_transformed_position()[1]-nativeGeometry[1])<=1,
                'The expanded prompt moved away from the native search top edge');
            await capture('assistant-expanded');
            assistant._setSearchEntryText('');for(let i=0;i<4;i++)await pause();
            await key(Clutter.KEY_b);
            assert(assistant._getSearchEntryText()==='b','Typing failed after clearing the prompt');
            assistant._setAiMode(false);assistant._setAiMode(true);assistant._queueFocusSearchEntry();
            for(let i=0;i<4;i++)await pause();
            await key(Clutter.KEY_c);
            assert(assistant._getSearchEntryText()==='bc','Typing failed after reopening the prompt');
            assistant._setSearchEntryText('');for(let i=0;i<4;i++)await pause();
            assistant._aiView.attachmentButton.grab_key_focus();
            const {default:Shell}=await import('gi://Shell');
            const image=Gio.File.new_for_path(root+'/overview-prompt.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,image);image.close(null);
            await click(assistant._promptEditor);
            await key(Clutter.KEY_d);
            assert(assistant._getSearchEntryText()==='d','Clicking the prompt did not restore typing: '+JSON.stringify({
                modalCount:Main.modalCount,mode:assistant._isAiMode,
                reactive:assistant._promptEditor?.reactive,editable:assistant._promptEditor?.clutter_text.editable,
                native:assistant._searchEntry.get_text(),focus:String(global.stage.get_key_focus())}));
            for(let i=0;i<4;i++)await pause();
            const attachView=assistant._aiView;
            const queueFile=attachView._queueLocalFile,queueReference=attachView._queueReference;
            let attached=0,referenced=[];
            attachView._queueLocalFile=()=>{attached++;};
            attachView._queueReference=folder=>{referenced.push(folder);};
            try {
                await click(attachView.attachmentButton);for(let i=0;i<3;i++)await pause();
                const menu=attachView._attachMenu;
                assert(menu?.isOpen,'The prompt focus fix intercepted the attachment button');
                const items=menu._getMenuItems().filter(item=>!(item instanceof PopupMenu.PopupSeparatorMenuItem));
                const labels=items.map(item=>item.label.text);
                assert(JSON.stringify(labels)===JSON.stringify(['Attach file…','Attach area…','Attach window context…','Attach desktop context',
                    'Reference a file…','Reference a folder…']),'Unexpected attach menu for a local agent: '+JSON.stringify(labels));
                await capture('attach-menu');
                items[0].activate(Clutter.get_current_event());for(let i=0;i<3;i++)await pause();
                assert(attached===1 && !menu.isOpen,'Attach file did not open the file picker');
                attachView._showAttachMenu();for(let i=0;i<3;i++)await pause();
                attachView._attachMenu._getMenuItems().filter(item=>item.label?.text==='Reference a folder…')[0]
                    .activate(Clutter.get_current_event());for(let i=0;i<3;i++)await pause();
                assert(JSON.stringify(referenced)==='[true]','Reference a folder did not open a folder picker');
            } finally {
                attachView._attachMenu?.close();
                attachView._queueLocalFile=queueFile;attachView._queueReference=queueReference;
            }
            // A picker is a separate window: the overview steps aside, then
            // comes back in assistant mode with the typed draft.
            const draft=assistant._getSearchEntryText();
            attachView.emit('picker-opened');
            for(let i=0;i<80 && Main.overview.visible;i++)await pause();
            assert(!Main.overview.visible,'The overview stayed over the file picker');
            attachView.emit('picker-closed');
            for(let i=0;i<80 && !(Main.overview.visible && assistant._promptEditor);i++)await pause();
            for(let i=0;i<4;i++)await pause();
            assert(Main.overview.visible && assistant._isAiMode && assistant._getSearchEntryText()===draft,
                'Closing the picker did not restore the assistant and draft: '+JSON.stringify({visible:Main.overview.visible,
                    mode:assistant._isAiMode,text:assistant._getSearchEntryText(),draft}));
            await this.testScreenCapture(assistant,pointer,key,capture);
            await this.testPrivateWindows(assistant);
            await this.testProblemNotifications(assistant);
            await this.testWindowMenu(assistant);
            await this.testNewConversationKeepsDraft(assistant,click);
            await this.testBubblesFitText(assistant);
            await this.testCommandSuggestions(assistant);
            // Files copied in a file manager arrive as file URIs: Ctrl+V adds
            // them as chips (references, as the fixture agent is local).
            const clipboard=St.Clipboard.get_default();
            const paste=async()=>{
                keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Control_L,Clutter.KeyState.PRESSED);
                await key(Clutter.KEY_v);
                keyboard.notify_keyval(GLib.get_monotonic_time(),Clutter.KEY_Control_L,Clutter.KeyState.RELEASED);
                for(let i=0;i<10;i++)await pause();
            };
            // Refusals show a banner over the prompt: check its text, then
            // dismiss it so later clicks reach the prompt.
            const takeNotice=pattern=>{
                const sources=Main.messageTray.getSources();
                const shown=sources.some(source=>source.notifications?.some(notice=>pattern.test(notice.body ?? '')));
                for(const source of sources)source.destroy();
                return shown;
            };
            const pastedPath=root+'/workspace/pasted notes.txt';
            GLib.file_set_contents(pastedPath,'Pasted from Files.');
            clipboard.set_content(St.ClipboardType.CLIPBOARD,'x-special/gnome-copied-files',
                new GLib.Bytes(new TextEncoder().encode('copy\n'+Gio.File.new_for_path(pastedPath).get_uri())));
            assistant._promptEditor.grab_key_focus();await pause();
            await paste();
            const pastedChip=attachView.queuedAttachments.find(item=>item.reference);
            assert(pastedChip?.name==='pasted notes.txt' && assistant._getSearchEntryText()===draft,
                'Pasting copied files did not add a reference: '+JSON.stringify({queued:attachView.queuedAttachments,
                    text:assistant._getSearchEntryText()}));
            assert(assistant._promptFiles?.mapped,'The pasted file chip is not shown in the prompt');
            await capture('pasted-files');
            attachView.removeQueuedAttachment(pastedChip.id);
            // A remote agent cannot reach local paths: pasted files are
            // attached, and folders sent as streamed archives.
            attachView._isLocalProfile=()=>false;
            try {
                await paste();
                const attachedChip=attachView.queuedAttachments.find(item=>!item.reference && item.name==='pasted notes.txt');
                assert(attachedChip && attachView._queuedFiles.length===1 && !attachView._queuedReferences.length,
                    'Pasting files did not attach them for a remote agent: '+JSON.stringify(attachView.queuedAttachments));
                attachView.removeQueuedAttachment(attachedChip.id);
                clipboard.set_content(St.ClipboardType.CLIPBOARD,'x-special/gnome-copied-files',
                    new GLib.Bytes(new TextEncoder().encode('copy\n'+Gio.File.new_for_path(root+'/workspace').get_uri())));
                await paste();
                const pastedFolder=attachView.queuedAttachments;
                assert(pastedFolder.length===1 && pastedFolder[0].folder && !pastedFolder[0].reference &&
                    attachView._queuedFiles[0]?.folder && /files ·/.test(pastedFolder[0].detail),
                    'A pasted folder was not attached for a remote agent: '+JSON.stringify(pastedFolder));
                attachView.removeQueuedAttachment(pastedFolder[0].id);
            } finally {delete attachView._isLocalProfile;}
            assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
            // Ordinary text still pastes as text.
            clipboard.set_text(St.ClipboardType.CLIPBOARD,'xy');
            await paste();
            assert(assistant._getSearchEntryText()===draft+'xy','Pasting text stopped working: '+
                JSON.stringify(assistant._getSearchEntryText()));
            assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
            // A copied image becomes an image chip: PNG, shrunk to 1920 pixels
            // at most, never enlarged; the prompt text is left alone.
            const {default:GdkPixbuf}=await import('gi://GdkPixbuf');
            const encoded=(width,height,format)=>{const image=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,false,8,width,height);
                image.fill(0x3366ccff);return image.save_to_bufferv(format,[],[])[1];};
            const pastedImage=async(type,bytes)=>{
                const before=attachView._queuedFiles.length;
                clipboard.set_content(St.ClipboardType.CLIPBOARD,type,new GLib.Bytes(bytes));
                await paste();
                for(let i=0;i<60 && attachView._queuedFiles.length===before;i++)await pause();
                const file=attachView._queuedFiles.at(-1);
                const image=file?.bytes&&GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(file.bytes)),null);
                return {file,size:image?[image.get_width(),image.get_height()]:null,png:file?.bytes?.[1]===80};
            };
            const wide=await pastedImage('image/png',encoded(2400,100,'png'));
            assert(/^pasted-image-\d{6}\.png$/.test(wide.file?.name) && wide.file.image && wide.png &&
                JSON.stringify(wide.size)==='[1920,80]' && assistant._getSearchEntryText()===draft,
                'A pasted image was not attached at a fitting size: '+JSON.stringify({name:wide.file?.name,size:wide.size}));
            attachView.removeQueuedAttachment(wide.file.id);
            const photo=await pastedImage('image/jpeg',encoded(300,200,'jpeg'));
            assert(photo.png && JSON.stringify(photo.size)==='[300,200]','A small pasted JPEG was enlarged or not converted: '+
                JSON.stringify(photo.size));
            attachView.removeQueuedAttachment(photo.file.id);
            // "Ask GNOME Assistant" in Files calls AskAbout over D-Bus, while
            // the overview is closed.
            const askAbout=uris=>new Promise((resolve,reject)=>Gio.DBus.session.call('org.gnome.Shell',
                '/org/gnome/Shell/Extensions/GnomeAssistant','org.gnome.Shell.Extensions.GnomeAssistant','AskAbout',
                new GLib.Variant('(as)',[uris]),null,Gio.DBusCallFlags.NONE,5000,null,(bus,result)=>{
                    try {resolve(bus.call_finish(result));} catch(error) {reject(error);}
                }));
            const settle=async done=>{for(let i=0;i<80 && !done();i++)await pause();for(let i=0;i<4;i++)await pause();};
            const askedFolder=root+'/workspace';
            Main.overview.hide();await settle(()=>!Main.overview.visible);
            await askAbout([Gio.File.new_for_path(pastedPath).get_uri(),Gio.File.new_for_path(askedFolder).get_uri(),
                'https://example.com/not-local']);
            await settle(()=>Main.overview.visible && attachView.queuedAttachments.length===2);
            const asked=attachView.queuedAttachments;
            assert(Main.overview.visible && assistant._isAiMode && asked.length===2 && asked.every(item=>item.reference) &&
                asked.some(item=>item.folder) && attachView._queuedReferences.some(item=>item.path===askedFolder),
                'Ask GNOME Assistant did not open the assistant with references: '+JSON.stringify({
                    visible:Main.overview.visible,mode:assistant._isAiMode,asked}));
            await capture('files-ask');
            for(const item of asked)attachView.removeQueuedAttachment(item.id);
            // A remote agent gets the file as an attachment and the folder as an archive.
            attachView._isLocalProfile=()=>false;
            try {
                await askAbout([Gio.File.new_for_path(pastedPath).get_uri(),Gio.File.new_for_path(askedFolder).get_uri()]);
                await settle(()=>attachView.queuedAttachments.length===2);
                const remote=attachView.queuedAttachments;
                assert(remote.length===2 && remote.every(item=>!item.reference) &&
                    remote.some(item=>item.name==='pasted notes.txt' && !item.folder) &&
                    remote.some(item=>item.name==='workspace' && item.folder),
                    'Ask GNOME Assistant did not attach the file and folder for a remote agent: '+JSON.stringify(remote));
                for(const item of remote)attachView.removeQueuedAttachment(item.id);
                assert(!takeNotice(/./),'Sending a folder to a remote agent showed an error');
            } finally {delete attachView._isLocalProfile;}
            // The name chosen in Preferences shows at once, trimmed.
            const names=()=>({header:attachView._header.text,hint:assistant._promptEditor?.hint_text,
                sender:attachView._roleToSender('assistant')});
            assistant._settings.set_string('assistant-name','  Jarvis ');for(let i=0;i<4;i++)await pause();
            assert(JSON.stringify(names())===JSON.stringify({header:'Jarvis',hint:'Ask Jarvis',sender:'Jarvis'}),
                'The assistant name was not applied: '+JSON.stringify(names()));
            assistant._settings.reset('assistant-name');for(let i=0;i<4;i++)await pause();
            assert(JSON.stringify(names())===JSON.stringify({header:'GNOME Assistant',hint:'Ask GNOME Assistant',
                sender:'GNOME Assistant'}),'Resetting the assistant name failed: '+JSON.stringify(names()));
            assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
            const interfaceEntry=new St.Entry({text:'',can_focus:true});
            assistant._aiView.add_child(interfaceEntry);
            try {
                interfaceEntry.grab_key_focus();await key(Clutter.KEY_z);
                assert(interfaceEntry.get_text()==='z' && assistant._getSearchEntryText()==='d',
                    'Overview typing was stolen from an editable field inside the assistant');
            } finally {interfaceEntry.destroy();}
            assistant._setSearchEntryText('');for(let i=0;i<4;i++)await pause();
            const queuedView=assistant._aiView;
            const imageFile=await readSelectedAttachment(root+'/workspace/preview.png');
            GLib.file_set_contents(root+'/workspace/notes.txt','A short note.');
            const noteFile=await readSelectedAttachment(root+'/workspace/notes.txt');
            queuedView._queuedFiles.push(imageFile,noteFile);queuedView._updateAttachmentButton();
            for(let i=0;i<5;i++)await pause();
            assert(assistant._promptFiles.mapped && assistant._promptBox.width>=700 &&
                assistant._getSearchEntryText()==='','Attachments did not expand an empty prompt');
            assert(all(assistant._promptFileRow).some(actor=>actor.text==='preview.png') &&
                all(assistant._promptFileRow).some(actor=>actor.text==='notes.txt'),
                'The prompt does not show the selected filenames');
            const fileScrollbars=()=>all(assistant._promptFiles).filter(actor=>actor instanceof St.ScrollBar &&
                actor.mapped && actor.width>1 && actor.height>1 && actor.get_paint_opacity()>0);
            assert(!fileScrollbars().length,'A fitting file row shows an unnecessary scrollbar');
            const extraFiles=[];
            for(let i=0;i<10;i++)extraFiles.push(await readSelectedAttachment(root+'/workspace/notes.txt'));
            queuedView._queuedFiles.push(...extraFiles);queuedView._updateAttachmentButton();
            for(let i=0;i<4;i++)await pause();
            assert(fileScrollbars().length===1 && assistant._promptBox.width<=721,
                'Many queued files overflowed the bar instead of scrolling');
            for(const file of extraFiles)queuedView.removeQueuedAttachment(file.id);
            for(let i=0;i<4;i++)await pause();
            assert(!fileScrollbars().length,'The file scrollbar remained after removing excess attachments');
            const chipImage=Gio.File.new_for_path(root+'/attachment-prompt.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,chipImage);chipImage.close(null);
            await click(assistant._promptFileRemoveButtons[1]);
            assert(queuedView.queuedAttachments.length===1 && queuedView.queuedAttachments[0].id===imageFile.id,
                'Removing a file chip removed the wrong attachment or failed');
            assistant._focusSearchEntry();await key(Clutter.KEY_e);
            assert(assistant._getSearchEntryText()==='e','The file chips prevented typing');
            assistant._setSearchEntryText('');
            Main.overview.hide();for(let i=0;i<5;i++)await pause();
            queuedView.emit('attachment-added');for(let i=0;i<6;i++)await pause();
            assert(assistant._isAiMode && assistant._promptFiles.mapped &&
                all(assistant._promptFileRow).some(actor=>actor.text==='preview.png'),
                'Returning from file selection lost the queued preview');
            await queuedView._warmConnection();
            const capabilities=queuedView._client.agentCapabilities.promptCapabilities;
            queuedView._client.agentCapabilities.promptCapabilities={};
            await assistant._submitAiPrompt();
            assert(queuedView.queuedAttachments.length===1 && assistant._promptFiles.visible,
                'Unsupported attachments disappeared instead of staying queued');
            queuedView._client.agentCapabilities.promptCapabilities=capabilities;
            await assistant._submitAiPrompt();for(let i=0;i<4;i++)await pause();
            assert(!queuedView.queuedAttachments.length && !assistant._promptFiles.visible &&
                queuedView._visibleMessages.at(-1).text==='Attachment received.',
                'Sending attachments without text failed or left stale chips');
            assert(assistant._promptBox.width<500,'The empty prompt did not collapse after sending attachments');
            assistant._setAiMode(false);assistant._setSearchEntryText('');
            assistant._searchEntry.grab_key_focus();await key(Clutter.KEY_x);
            assert(assistant._searchEntry.get_text()==='x','Normal search no longer receives typing after leaving assistant mode');
            await this.testBackgroundStatus(assistant);
        } finally {
            assistant.disable();Main.overview.hide();
            if(trace)global.stage.disconnect(trace);
            keyboard.run_dispose();
            pointer.run_dispose();
        }
    }

    // With the overview closed, the top-bar indicator follows the run, and
    // replies, errors and approvals arrive as notifications.
    async testBackgroundStatus(assistant) {
        const view=assistant._aiView,status=assistant._backgroundStatus,settings=assistant._settings;
        const settle=async done=>{for(let i=0;i<100 && !done();i++)await pause();await pause();};
        const indicator=()=>Main.panel.statusArea['gnome-assistant-status'];
        const notices=()=>status._source?.notifications ?? [];
        const close=async()=>{assistant._setAiMode(false);Main.overview.hide();await settle(()=>!Main.overview.visible && !view.mapped);};
        const describe=()=>JSON.stringify({state:status.state,visible:indicator()?.visible,mapped:view.mapped,
            notices:notices().map(notice=>({title:notice.title,body:notice.body,actions:notice.actions.map(action=>action.label)}))});
        for(const source of Main.messageTray.getSources())source.destroy();
        await close();
        assert(indicator() && !indicator().visible && status.state==='idle','The idle indicator is shown: '+describe());
        const states=[];
        const stateSignal=view.connect('run-state-changed',()=>states.push(status.state));
        try {
            // Approving from the notification answers the chat card.
            let reply=view.generateResponse('approval');
            await settle(()=>notices().length===1);
            assert(states[0]==='working' && status.state==='approval' && indicator().visible &&
                indicator().has_style_class_name('ai-status-approval'),'The indicator did not follow the run: '+states+' '+describe());
            const {default:Shell}=await import('gi://Shell');
            const shot=Gio.File.new_for_path(GLib.getenv('GNOME_ASSISTANT_TEST_ROOT')+'/background-approval.png')
                .replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,shot);shot.close(null);
            const approval=notices()[0];
            assert(approval.title==='Allow this action?' && approval.body==='Sample approval' &&
                approval.actions.map(action=>action.label).join()==='Decline,Allow once','Unexpected approval notification: '+describe());
            approval.actions[1].activate();
            assert(!view._approvals.size && !view.pendingApprovals.length,'Approving from the notification left the chat card');
            await reply;
            await settle(()=>notices().length===1);
            assert(view._visibleMessages.at(-1).text==='Approved.' && notices()[0].body==='Approved.' &&
                status.state==='unread' && indicator().has_style_class_name('ai-status-unread'),
                'The finished reply did not notify: '+describe());
            notices()[0].activate();
            await settle(()=>view.mapped);
            assert(Main.overview.visible && assistant._isAiMode && view.mapped && status.state==='idle' &&
                !indicator().visible && !notices().length,'The notification did not open the chat: '+describe());
            // Someone looking at the chat gets no notification.
            await view.generateResponse('configuration');await pause();
            assert(!notices().length && status.state==='idle','A reply notified while the chat was shown: '+describe());
            // Answering in the chat withdraws the notification.
            await close();
            reply=view.generateResponse('approval');
            await settle(()=>notices().length===1);
            const pending=notices()[0];
            let withdrawn=false;pending.connect('destroy',()=>{withdrawn=true;});
            view._approvals.values().next().value.get_last_child().get_last_child().emit('clicked',1);
            assert(withdrawn && !notices().includes(pending),'Approving in the chat left the notification: '+describe());
            await reply;
            await settle(()=>notices().length===1);
            assert(notices()[0].body==='Approved.','The second reply did not notify: '+describe());
            // Errors notify too.
            const runProfile=view._runProfile;
            view._runProfile=async()=>{throw new Error('Fixture failure.');};
            try {await view.generateResponse('fail');} finally {view._runProfile=runProfile;}
            await settle(()=>notices().length===1 && notices()[0].body.includes('Fixture failure'));
            assert(status.state==='failed' && notices()[0].body==='A2UI fixture: Fixture failure.' &&
                indicator().has_style_class_name('ai-status-failed'),'The failed reply did not notify: '+describe());
            status._markRead();
            // Stop from the top-bar menu: the user's own choice, so no notification.
            reply=view.generateResponse('stop');
            await settle(()=>view._run?.streamedText!==undefined && indicator().visible);
            assert(status.state==='working' && indicator()._stopItem.visible,'The menu cannot stop the reply: '+describe());
            indicator()._stopItem.activate(Clutter.get_current_event());
            await reply;await pause();
            assert(view._visibleMessages.at(-1).text==='Stopped.' && !notices().length && status.state==='idle' &&
                !indicator().visible,'Stopping from the top bar failed or notified: '+describe());
            // The indicator can be turned off in Preferences.
            settings.set_boolean('show-status-indicator',false);
            assert(!indicator(),'The hidden indicator stayed in the top bar');
            settings.reset('show-status-indicator');
            assert(indicator() && !indicator().visible,'The indicator did not come back');
            print('BACKGROUND STATUS TEST PASSED');
        } finally {
            view.disconnect(stateSignal);
            for(const source of Main.messageTray.getSources())source.destroy();
        }
    }

    // Attach area / Attach window: the picker draws on the desktop while the
    // overview is closed, then the overview returns with the draft and image.
    // Secrets the user typed or attached are reviewed before sending; what
    // the fixture agent echoes back is what actually left the extension.
    async testPrivacy(view,root,turn) {
        const token='ghp_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
        const card=()=>view._privacyReview?.card;
        const answer=async(review,label)=>{
            for(let i=0;i<40 && !card();i++)await pause();
            assert(card(),'No review card appeared for a secret');
            all(card()).find(actor=>actor instanceof St.Button && actor.label===label).emit('clicked',1);
            return review;
        };
        const echoed=()=>JSON.parse(view._visibleMessages.at(-1).text);
        let result=await view.reviewOutgoing('privacy-echo nothing secret here');
        assert(result.proceed && result.prompt==='privacy-echo nothing secret here' && !card(),'A harmless message was reviewed');
        result=await answer(view.reviewOutgoing(`privacy-echo my token is ${token}`),'Redact and send');
        assert(result.proceed && result.prompt==='privacy-echo my token is [redacted GitHub token]','The token was not redacted');
        await turn(result.prompt);
        assert(echoed().prompt.includes('[redacted GitHub token]') && !view._visibleMessages.at(-1).text.includes(token),
            'The agent received the token');
        result=await answer(view.reviewOutgoing(`privacy-echo ${token}`),'Send anyway');
        assert(result.proceed && result.prompt.includes(token),'Send anyway changed the message');
        result=await answer(view.reviewOutgoing(`privacy-echo ${token}`),'Cancel');
        assert(!result.proceed && !card(),'Cancel did not stop the message');
        // An attached text file is sent redacted; a .env file is left out; the original stays as it is.
        const config=root+'/workspace/config.txt',env=root+'/workspace/.env';
        GLib.file_set_contents(config,'DB_PASSWORD=Tr0ub4dor&3\nname=demo\n');
        GLib.file_set_contents(env,'API_KEY=whatever\n');
        view._queuedFiles.push(await selectAttachment(config),await selectAttachment(env));view._updateAttachmentButton();
        result=await answer(view.reviewOutgoing('privacy-echo files'),'Redact and send');
        assert(view._queuedFiles.length===1 && view._queuedFiles[0].name==='config.txt',
            'The .env file was not left out: '+JSON.stringify(view.queuedAttachments));
        await turn(result.prompt);
        const sent=echoed().resources;
        assert(sent.length===1 && sent[0].includes('DB_PASSWORD=[redacted password]') && !sent[0].includes('Tr0ub4dor'),
            'The attached file was not sent redacted: '+JSON.stringify(sent));
        assert(new TextDecoder().decode(GLib.file_get_contents(config)[1]).includes('Tr0ub4dor'),'The original file was changed');
        // A folder for a remote agent leaves sensitive items out of the archive.
        const project=root+'/workspace/secret-project';
        GLib.mkdir_with_parents(project+'/.ssh',0o700);
        GLib.file_set_contents(project+'/main.py','print("hi")\n');
        GLib.file_set_contents(project+'/.env','TOKEN=x\n');
        GLib.file_set_contents(project+'/cert.pem','not really\n');
        GLib.file_set_contents(project+'/.ssh/id_ed25519','not really\n');
        view._isLocalProfile=()=>false;
        try {
            await view.addLocalPaths([project]);
            const folder=view._queuedFiles.find(file=>file.folder);
            const left=folder?.excluded.map(item=>item.path).sort();
            assert(folder?.files===1 && JSON.stringify(left)==='[".env",".ssh","cert.pem"]' &&
                view.queuedAttachments.find(item=>item.folder).detail.includes('3 sensitive left out'),
                'Sensitive files were not left out of the folder: '+JSON.stringify({files:folder?.files,left}));
            view.removeQueuedAttachment(folder.id);
        } finally {delete view._isLocalProfile;}
        // With protection off, nothing is reviewed.
        view._settings.set_boolean('privacy-protection',false);
        result=await view.reviewOutgoing(`privacy-echo ${token}`);
        assert(result.proceed && result.prompt.includes(token) && !card(),'Protection off still reviewed the message');
        view._settings.reset('privacy-protection');
        print('PRIVACY TEST PASSED');
    }

    // "Ask …" in GNOME's window menu attaches that window and opens the
    // assistant; private apps get no entry.
    async testWindowMenu(assistant) {
        const WindowMenu=await import('resource:///org/gnome/shell/ui/windowMenu.js');
        const spawn=(id,title)=>Gio.Subprocess.new(['gjs','-c',"imports.gi.versions.Gtk='4.0';const {Gtk,Gio}=imports.gi;"+
            `const app=new Gtk.Application({application_id:'${id}',flags:Gio.ApplicationFlags.NON_UNIQUE});`+
            `app.connect('activate',()=>{const window=new Gtk.ApplicationWindow({application:app,title:'${title}',`+
            "default_width:320,default_height:200});window.set_child(new Gtk.Label({label:'content'}));window.present();});"+
            "app.run([]);"],Gio.SubprocessFlags.NONE);
        const find=title=>global.get_window_actors().map(actor=>actor.get_meta_window()).find(window=>window.get_title()===title);
        // The title names a folder of a project, as terminals do.
        const project=GLib.getenv('GNOME_ASSISTANT_TEST_ROOT')+'/window-project';
        GLib.mkdir_with_parents(project+'/.git',0o755);GLib.mkdir_with_parents(project+'/src',0o755);
        const title=`Notes ${project}/src`;
        const apps=[spawn('org.example.Notes',title),spawn('org.keepassxc.KeePassXC','Vault/menu')];
        const view=assistant._aiView,source=new St.Widget();
        const draft=assistant._getSearchEntryText();
        Main.uiGroup.add_child(source);
        const menus=[];
        try {
            for(let i=0;i<100 && !(find(title)?.get_compositor_private()?.mapped && find('Vault/menu'));i++)await pause();
            const window=find(title);
            assert(window && find('Vault/menu'),'The window menu test windows did not open');
            const labels=menu=>menu._getMenuItems().filter(item=>item.label).map(item=>item.label.text);
            const menu=new WindowMenu.WindowMenu(window,source);menus.push(menu);
            assert(labels(menu)[1]==='Ask GNOME Assistant','The window menu has no Ask entry after Take Screenshot: '+labels(menu));
            // Its text lines up with the other entries (which keep room for a checkmark).
            // (Opening the menu here would disturb later hover tests, so compare its layout state.)
            const [screenshotItem,askItem]=menu._getMenuItems();
            const column=item=>[item._ornament,item._ornamentIcon?.visible ?? null];
            assert(JSON.stringify(column(askItem))===JSON.stringify(column(screenshotItem)),
                'The Ask entry does not line up: '+JSON.stringify([column(screenshotItem),column(askItem)]));
            const privateMenu=new WindowMenu.WindowMenu(find('Vault/menu'),source);menus.push(privateMenu);
            assert(!labels(privateMenu).includes('Ask GNOME Assistant'),'A private app offered Ask');
            Main.overview.hide();for(let i=0;i<80 && Main.overview.visible;i++)await pause();
            const queued=view._queuedFiles.length;
            view.setDesktopContext(null);
            menu._getMenuItems()[1].activate(Clutter.get_current_event());
            for(let i=0;i<120 && !(view._desktopContext && Main.overview.visible);i++)await pause();
            const context=view._desktopContext,frame=window.get_frame_rect();
            await context?.protection;
            const shot=context?.monitors[0],info=context?.focusedWindow;
            assert(context?.scope==='window' && view._queuedFiles.length===queued && Main.overview.visible && assistant._isAiMode &&
                shot.name.startsWith('Notes') && shot.image.width===frame.width && shot.image.height===frame.height,
                'Ask did not attach a window context and open the assistant: '+JSON.stringify({scope:context?.scope,
                    name:shot?.name,size:[shot?.image?.width,shot?.image?.height],frame:[frame.width,frame.height],visible:Main.overview.visible}));
            // Window details with the process, its project, and its events.
            assert(info.title===title && info.id===window.get_id().toString() && info.pid===window.get_pid() &&
                /gjs/.test(info.executable ?? '') && context.projects?.[0]?.path===project &&
                context.projects[0].sources.includes('window_title') && Array.isArray(context.events) &&
                context.processes?.get(info.id)?.pid===info.pid,
                'The window context lacks details: '+JSON.stringify({info,projects:context.projects,events:context.events}));
            const chip=view.queuedAttachments.find(item=>item.id===context.id);
            assert(chip?.name==='Window context' && chip.image,'Unexpected chip: '+JSON.stringify(chip));
            const {eventsForWindow}=await import('../windowContext.js');
            const kept=eventsForWindow([{type:'notification',application:info.app},{type:'notification',application:'Other'},
                {type:'application_crash',pid:info.pid},{type:'application_crash',pid:1,program:'other'},
                {type:'error_logged',source:'gjs'},{type:'error_logged',source:'systemd'},{type:'window_opened',window_id:info.id}],
                {...info,comm:'gjs'});
            assert(kept.length===4 && !kept.some(event=>event.application==='Other' || event.program==='other' || event.source==='systemd'),
                'Events of other applications were kept: '+JSON.stringify(kept));
            // What the agent receives: the window's screenshot, and its context in words.
            await view.generateResponse('context-echo window');await pause();
            const echoed=JSON.parse(view._visibleMessages.at(-1).text);
            const snapshot=echoed.texts.find(text=>text.startsWith('Window context snapshot: '));
            const sent=snapshot && JSON.parse(snapshot.slice('Window context snapshot: '.length));
            assert(echoed.images===1 && echoed.window_instructions && sent?.trigger==='window_menu' && sent.window.title===title && sent.window.pid===info.pid &&
                sent.screenshot.pixels.join()===`${frame.width},${frame.height}` && sent.projects.candidates[0].path===project &&
                !('comm' in sent.window) && echoed.prompt.includes('Attached window context:') && !view._desktopContext,
                'The agent did not receive the window context: '+JSON.stringify({echoed:{...echoed,texts:echoed.texts.map(text=>text.slice(0,200))}}));
            // The switch in Preferences turns off the menu entry and the shortcut.
            const settings=assistant._settings;
            assert(assistant._windowShortcutRegistered,'The window context shortcut is not registered');
            settings.set_boolean('window-context-enabled',false);
            const offMenu=new WindowMenu.WindowMenu(window,source);menus.push(offMenu);
            assert(!labels(offMenu).includes('Ask GNOME Assistant') && !assistant._windowShortcutRegistered,
                'Window context stayed available while turned off');
            settings.reset('window-context-enabled');
            assert(assistant._windowShortcutRegistered,'The shortcut did not come back');
            // The shortcut attaches the focused window, even from the overview.
            window.activate(global.get_current_time());for(let i=0;i<10 && global.display.focus_window!==window;i++)await pause();
            view.setDesktopContext(null);
            assistant._askAboutFocusedWindow();
            for(let i=0;i<120 && !(view._desktopContext && Main.overview.visible);i++)await pause();
            assert(view._desktopContext?.scope==='window' && view._desktopContext.focusedWindow.title===title && Main.overview.visible,
                'The shortcut did not attach the focused window: '+JSON.stringify({scope:view._desktopContext?.scope,
                    title:view._desktopContext?.focusedWindow?.title,focus:global.display.focus_window?.get_title()}));
            await view._desktopContext.protection;
            view.setDesktopContext(null);
            // A private app is refused, with a notice instead of a chip.
            const vault=find('Vault/menu');
            vault.activate(global.get_current_time());for(let i=0;i<10 && global.display.focus_window!==vault;i++)await pause();
            if(global.display.focus_window===vault) {
                assistant._askAboutFocusedWindow();for(let i=0;i<10;i++)await pause();
                assert(!view._desktopContext,'A private window was attached by the shortcut');
            }
            for(const notice of Main.messageTray.getSources())notice.destroy();
            print('WINDOW MENU TEST PASSED');
        } finally {
            for(const menu of menus)menu.destroy();
            source.destroy();
            for(const app of apps)app.force_exit();
            // Closing the overview clears its search entry: restore the draft later tests expect.
            assistant._reopenWithDraft('');
            for(let i=0;i<40 && !assistant._promptEditor;i++)await pause();
            assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
        }
    }

    // "/" or "$" lists the agent's commands and skills (as advertised through
    // ACP, with descriptions and argument hints) and GNOME Assistant's own.
    async testCommandSuggestions(assistant) {
        const view=assistant._aiView,draft=assistant._getSearchEntryText();
        // The test agent advertises commands shaped like Claude's (with an
        // argument hint) and Codex's skills (names starting with $).
        for(let i=0;i<120 && !view._nativeProfileCommands.some(command=>command.name==='$imagegen');i++)await pause();
        assert(view._nativeProfileCommands.some(command=>command.name==='$imagegen'),'The agent did not advertise its commands');
        const type=async text=>{assistant._setSearchEntryText(text);for(let i=0;i<4;i++)await pause();};
        const rows=()=>assistant._skillMenu?.visible ? assistant._skillRows.get_children() : [];
        const texts=row=>row ? all(row).filter(actor=>actor instanceof St.Label).map(label=>label.text) : [];
        try {
            await type('/');
            const names=rows().map(row=>texts(row)[0]);
            assert(['/a2ui','/effort','/$imagegen','/native'].every(name=>names.includes(name)),
                'The list lacks commands: '+names);
            const effortRow=rows().find(row=>texts(row)[0]==='/effort');
            assert(texts(effortRow).join('|')==="/effort|<low|medium|high>|Set the model's effort level",
                'A row lacks its hint or description: '+texts(effortRow));
            const {default:Shell}=await import('gi://Shell');
            const shot=Gio.File.new_for_path(GLib.getenv('GNOME_ASSISTANT_TEST_ROOT')+'/command-suggestions.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
            await new Shell.Screenshot().screenshot(false,shot);shot.close(null);
            await type('/eff');
            assert(texts(rows()[0])[0]==='/effort','The best match is not first');
            assistant._handleSkillSuggestionKey(Clutter.KEY_Tab,0);for(let i=0;i<4;i++)await pause();
            assert(assistant._getSearchEntryText()==='/effort ','Tab did not complete the command');
            // While its argument is typed, the hint stays, and Enter is left to send.
            assert(rows().length===1 && texts(rows()[0]).includes('<low|medium|high>') && !assistant._skillMatches.length,
                'The argument hint is not shown: '+rows().map(texts));
            await type('$imag');
            assert(texts(rows()[0])[0]==='$imagegen','A Codex skill is missing or its $ was doubled: '+rows().map(texts));
            await type('/home/me/notes.txt');
            assert(!rows().length,'A path opened the command list');
            print('COMMAND SUGGESTIONS TEST PASSED');
        } finally {
            await type(draft);
        }
    }

    // Every chat bubble is tall enough for its text, also after several
    // turns, when the chat scrolls.
    async testBubblesFitText(assistant) {
        const view=assistant._aiView;
        view._startNewConversation();await pause();
        const prompts=["e quale' la punta piu alta della val d'ayas?",'in realta il castore fa parte di ayas',
            'e il lyskamm?','quanto è alto il monte rosa?','grazie'];
        for(const prompt of prompts) {
            view.addMessage('You',prompt);
            await view.generateResponse('markdown-reply '+prompt);
            for(let i=0;i<3;i++)await pause();
        }
        for(let i=0;i<10;i++)await pause();
        view._scrollView.get_vadjustment?.()?.set_value(0);for(let i=0;i<3;i++)await pause();
        const {default:Shell}=await import('gi://Shell');
        const bubblesShot=Gio.File.new_for_path(GLib.getenv('GNOME_ASSISTANT_TEST_ROOT')+'/chat-bubbles.png').replace(null,false,Gio.FileCreateFlags.NONE,null);
        await new Shell.Screenshot().screenshot(false,bubblesShot);bubblesShot.close(null);
        const problems=[];
        for(const message of view._visibleMessages) {
            const bubble=message.actor,node=bubble.get_theme_node();
            const bottom=Math.max(...bubble.get_children().filter(child=>child.visible).map(child=>child.get_allocation_box().y2));
            const room=bubble.height-node.get_padding(St.Side.BOTTOM);
            if(bottom>room+1)
                problems.push({sender:message.sender,text:message.text.slice(0,30),height:bubble.height,bottom,room,width:bubble.width,
                    style:{max:node.get_max_height(),min:node.get_min_height(),fixed:node.get_height(),classes:bubble.style_class},
                    children:bubble.get_children().filter(child=>child.visible).map(child=>child.get_allocation_box().get_height())});
        }
        assert(problems.length===0,'Bubbles are too short for their text: '+JSON.stringify(problems));
        // Web research instructions follow their setting.
        const echoed=async()=>{await view.generateResponse('instructions-echo');await pause();return JSON.parse(view._visibleMessages.at(-1).text);};
        assert((await echoed()).web,'The agent was not asked to research on the web');
        assistant._settings.set_boolean('web-research',false);
        assert(!(await echoed()).web,'Web research instructions were sent while turned off');
        assistant._settings.reset('web-research');
        view._startNewConversation();await pause();
        print('BUBBLE HEIGHT TEST PASSED');
    }

    // The New button starts over, but the message being written stays:
    // its text and its attachments.
    async testNewConversationKeepsDraft(assistant,click) {
        const {default:GdkPixbuf}=await import('gi://GdkPixbuf');
        const view=assistant._aiView,draft=assistant._getSearchEntryText();
        await view.generateResponse('context-echo before');await pause();
        assert(view._visibleMessages.length>0,'No conversation to start over from');
        const pixbuf=GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB,false,8,4,4);pixbuf.fill(0x3366ccff);
        view.addScreenCapture({name:'kept.png',bytes:pixbuf.save_to_bufferv('png',[],[])[1]});
        assistant._setSearchEntryText('half-written\nquestion');assistant._queueFocusSearchEntry();for(let i=0;i<6;i++)await pause();
        const before=view.queuedAttachments.map(item=>item.name).join();
        assert(view._newSessionButton.visible && view._newSessionButton.mapped,'The New button is not shown');
        await click(view._newSessionButton);
        for(let i=0;i<20 && view._visibleMessages.length;i++)await pause();
        for(let i=0;i<4;i++)await pause();
        const state={messages:view._visibleMessages.length,text:assistant._getSearchEntryText(),
            attachments:view.queuedAttachments.map(item=>item.name).join(),before};
        assert(state.messages===0 && state.text==='half-written\nquestion' && state.attachments===before &&
            before.includes('kept.png'),'New conversation did not keep the draft: '+JSON.stringify(state));
        view.removeQueuedAttachment(view.queuedAttachments.find(item=>item.name==='kept.png').id);
        assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
        print('NEW CONVERSATION DRAFT TEST PASSED');
    }

    // Problem notifications: who is notified, grouping, and "Fix" filling in
    // (not sending) a prompt in a new conversation.
    async testProblemNotifications(assistant) {
        const {COREDUMP_MESSAGE_ID,parseJournalEntry}=await import('../problemRules.js');
        const watcher=assistant._problemWatcher,view=assistant._aiView;
        const draft=assistant._getSearchEntryText();
        assistant._setSearchEntryText('');
        for(const source of Main.messageTray.getSources())source.destroy();
        const crash=parseJournalEntry({MESSAGE_ID:COREDUMP_MESSAGE_ID,COREDUMP_UID:'1000',COREDUMP_COMM:'pipewire',
            COREDUMP_EXE:'/usr/bin/pipewire',COREDUMP_PID:'4321',COREDUMP_SIGNAL_NAME:'SIGSEGV',COREDUMP_USER_UNIT:'pipewire.service',
            __REALTIME_TIMESTAMP:String(Date.now()*1000),
            MESSAGE:'Process 4321 (pipewire) dumped core.\n\nStack trace of thread 4321:\n#0  0x1 crash_here (libpipewire-0.3.so + 0x1)\n'},1000);
        const notice=watcher.handle(crash);
        assert(notice?.title==='pipewire crashed (SIGSEGV)' &&
            notice.actions.map(action=>action.label).join()==="Fix with GNOME Assistant,Don't show for pipewire",
            'Unexpected crash notification: '+JSON.stringify({title:notice?.title,actions:notice?.actions?.map(action=>action.label)}));
        assert(watcher.handle(crash)===null,'A repeated crash was not grouped');
        const helper=parseJournalEntry({MESSAGE_ID:COREDUMP_MESSAGE_ID,COREDUMP_UID:'1000',COREDUMP_COMM:'crashpad',COREDUMP_PID:'77',
            COREDUMP_SIGNAL_NAME:'SIGTRAP',COREDUMP_USER_UNIT:'app-gnome-brave-1.scope',__REALTIME_TIMESTAMP:String(Date.now()*1000)},1000);
        assert(watcher.handle(helper)===null,'A background helper notified by default');
        assert(watcher.handle({kind:'service',unit:'backup.service',scope:'user',result:'exit-code',time:Date.now()})===null,
            'A failed service notified while that is off');
        // Fix: a new conversation, the details in the prompt, nothing sent.
        Main.overview.hide();for(let i=0;i<80 && Main.overview.visible;i++)await pause();
        notice.actions[0].activate();
        for(let i=0;i<120 && !assistant._getSearchEntryText().includes('pipewire crashed');i++)await pause();
        const prompt=assistant._getSearchEntryText();
        assert(Main.overview.visible && assistant._isAiMode && prompt.startsWith('pipewire crashed at') &&
            prompt.includes('Please find out why') && prompt.includes('crash_here') && prompt.includes('\n') &&
            !view._run && view._visibleMessages.length===0,
            'Fix did not prepare the prompt in a new conversation: '+JSON.stringify({visible:Main.overview.visible,
                prompt:prompt.slice(0,160),run:Boolean(view._run),messages:view._visibleMessages.length}));
        // "Don't show for …" mutes that program.
        const other=watcher.handle({...crash,program:'gvfsd',pid:99,unit:'gvfs-daemon.service'});
        other.actions[1].activate();
        assert(assistant._settings.get_strv('problem-ignored').includes('program:gvfsd'),'Muting did not save');
        assert(watcher.handle({...crash,program:'gvfsd',pid:98,unit:'gvfs-daemon.service',time:Date.now()+1})===null,
            'A muted program notified again');
        assistant._settings.reset('problem-ignored');
        for(const source of Main.messageTray.getSources())source.destroy();
        assistant._setSearchEntryText(draft);for(let i=0;i<4;i++)await pause();
        print('PROBLEM NOTIFICATIONS TEST PASSED');
    }

    // Windows of private apps are refused when picked and blacked out in areas.
    async testPrivateWindows(assistant) {
        const {default:GdkPixbuf}=await import('gi://GdkPixbuf');
        const {default:Shell}=await import('gi://Shell');
        const vault=Gio.Subprocess.new(['gjs','-c',"imports.gi.versions.Gtk='4.0';const {Gtk,Gio}=imports.gi;"+
            "const app=new Gtk.Application({application_id:'org.keepassxc.KeePassXC',flags:Gio.ApplicationFlags.NON_UNIQUE});"+
            "app.connect('activate',()=>{const window=new Gtk.ApplicationWindow({application:app,title:'Vault',"+
            "default_width:300,default_height:200});window.set_child(new Gtk.Label({label:'secret'}));window.present();});"+
            "app.run([]);"],Gio.SubprocessFlags.NONE);
        const vaultWindow=()=>global.get_window_actors().map(actor=>actor.get_meta_window()).find(window=>window.get_title()==='Vault');
        try {
            for(let i=0;i<80 && !vaultWindow()?.get_compositor_private()?.mapped;i++)await pause();
            const window=vaultWindow();
            assert(window,'The private test window did not open');
            const refused=await assistant._protectCapture({name:'vault.png',bytes:new Uint8Array(),width:1,height:1,window});
            assert(refused===null,'A private window could be attached');
            assert(Main.messageTray.getSources().some(source=>source.notifications?.some(notice=>/kept private/.test(notice.body??''))),
                'Refusing a private window was not explained');
            for(const source of Main.messageTray.getSources())source.destroy();
            const rect=window.get_frame_rect();
            const area={x:rect.x-20,y:rect.y-20,width:rect.width+40,height:rect.height+40};
            const stream=Gio.MemoryOutputStream.new_resizable();
            await new Shell.Screenshot().screenshot_area(area.x,area.y,area.width,area.height,stream);
            stream.close(null);
            const bytes=stream.steal_as_bytes().get_data();
            const result=await assistant._protectCapture({name:'area.png',bytes,width:area.width,height:area.height,area});
            const pixbuf=GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(result.bytes)),null);
            const at=(x,y)=>{const offset=y*pixbuf.get_rowstride()+x*pixbuf.get_n_channels();return [...pixbuf.get_pixels().slice(offset,offset+3)];};
            const middle=at(Math.floor(pixbuf.get_width()/2),Math.floor(pixbuf.get_height()/2));
            assert(middle.every(value=>value===0) && result.privacy.hidden.length===1,
                'The private window was not blacked out: '+JSON.stringify({middle,privacy:result.privacy}));
            assert(!at(5,5).every(value=>value===0),'Blacking out covered more than the private window');
            print('PRIVATE WINDOWS TEST PASSED');
        } finally {
            vault.force_exit();
        }
    }

    async testScreenCapture(assistant,pointer,key,capture) {
        const {activeCapturePicker}=await import('../screenCapture.js');
        const {default:Shell}=await import('gi://Shell');
        const view=assistant._aiView,draft=assistant._getSearchEntryText(),queued=view._queuedFiles.length;
        const wait=async(done,what)=>{for(let i=0;i<80 && !done();i++)await pause();assert(done(),what);};
        const move=async(x,y)=>{
            pointer.notify_absolute_motion(GLib.get_monotonic_time(),x,y);await pause();
            const [actualX,actualY]=global.get_pointer();
            if(actualX!==x || actualY!==y) {pointer.notify_relative_motion(GLib.get_monotonic_time(),x-actualX,y-actualY);await pause();}
        };
        const press=async(state,button=Clutter.BUTTON_PRIMARY)=>{
            pointer.notify_button(GLib.get_monotonic_time(),button,state);await pause();
        };
        const choose=async label=>{
            view._showAttachMenu();for(let i=0;i<3;i++)await pause();
            view._attachMenu._getMenuItems().find(item=>item.label?.text===label).activate(Clutter.get_current_event());
            await wait(()=>activeCapturePicker()?._actor.mapped && !Main.overview.visible,label+' did not show its picker');
            for(let i=0;i<2;i++)await pause();
        };
        const restored=async what=>{
            await wait(()=>!activeCapturePicker() && Main.overview.visible && assistant._isAiMode,what);
            for(let i=0;i<6;i++)await pause();
            assert(assistant._getSearchEntryText()===draft && global.stage.get_key_focus()===assistant._promptEditor?.clutter_text &&
                !all(Main.uiGroup).some(actor=>actor.has_style_class_name?.('ai-capture-overlay')),
                what+': '+JSON.stringify({text:assistant._getSearchEntryText(),draft,focus:String(global.stage.get_key_focus())}));
        };
        const pngSize=bytes=>{const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return [data.getUint32(16),data.getUint32(20)];};
        // Area: drag a rectangle; the chip holds exactly that region.
        await choose('Attach area…');
        await move(200,400);await press(Clutter.ButtonState.PRESSED);await move(360,520);await move(520,640);
        assert(JSON.stringify(activeCapturePicker().selection)==='{"x":200,"y":400,"width":320,"height":240}',
            'The area picker did not follow the drag: '+JSON.stringify(activeCapturePicker().selection));
        await capture('capture-area');
        await press(Clutter.ButtonState.RELEASED);
        await restored('Attaching an area did not restore the assistant with the draft');
        const area=view._queuedFiles.find(file=>/^area-\d{6}\.png$/.test(file.name));
        assert(area && JSON.stringify(pngSize(area.bytes))==='[320,240]' && area.size===area.bytes.length &&
            view.queuedAttachments.some(item=>item.id===area.id && item.image) &&
            all(assistant._promptFileRow).some(actor=>actor.text===area.name),
            'The area was not attached at its size: '+JSON.stringify(view.queuedAttachments));
        // The overlay was gone before capturing: the image matches the plain
        // desktop. Open a window for the window picker meanwhile.
        const text=assistant._takeDraft();
        Main.overview.hide();await wait(()=>!Main.overview.visible && !Main.overview.animationInProgress,'The overview did not close');
        const desktop=Gio.MemoryOutputStream.new_resizable();
        await new Promise((resolve,reject)=>new Shell.Screenshot().screenshot_area(200,400,320,240,desktop,(shot,result)=>{
            try {resolve(shot.screenshot_area_finish(result));} catch(error) {reject(error);}
        }));
        desktop.close(null);
        const {default:GdkPixbuf}=await import('gi://GdkPixbuf');
        const pixels=bytes=>GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
            GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes),null).read_pixel_bytes());
        assert(pixels(desktop.steal_as_bytes())===pixels(new GLib.Bytes(area.bytes)),'The area capture included the picker overlay');
        const target=Gio.Subprocess.new(['gjs','-c',"imports.gi.versions.Gtk='4.0';const {Gtk,GLib}=imports.gi;Gtk.init();"+
            "const window=new Gtk.Window({title:'Capture/target',default_width:420,default_height:260});"+
            "window.set_child(new Gtk.Label({label:'Pick me'}));window.present();new GLib.MainLoop(null,false).run();"],
        Gio.SubprocessFlags.NONE);
        const targetWindow=()=>global.get_window_actors().map(actor=>actor.get_meta_window()).find(window=>window.get_title()==='Capture/target');
        try {
            await wait(()=>targetWindow()?.get_compositor_private()?.mapped,'The capture target window did not open');
            for(let i=0;i<5;i++)await pause();
            assistant._reopenWithDraft(text);await restored('The assistant did not reopen after opening a window');
            // Escape cancels and leaves the prompt as it was.
            await choose('Attach area…');
            await key(Clutter.KEY_Escape);
            await restored('Escape did not restore the assistant');
            assert(view._queuedFiles.length===queued+1,'Cancelling an area still attached something');
            // Window: the window under the pointer is highlighted; a click picks
            // it and attaches its window context.
            view.setDesktopContext(null);
            await choose('Attach window context…');
            const window=targetWindow(),frame=window.get_frame_rect();
            await move(frame.x+frame.width/2,frame.y+frame.height/2);
            assert(activeCapturePicker().selection===window,'The window under the pointer was not highlighted');
            await move(frame.x+frame.width+40,frame.y+frame.height/2);
            assert(activeCapturePicker().selection!==window,'The highlight stayed after leaving the window');
            await move(frame.x+frame.width/2,frame.y+frame.height/2);
            await capture('capture-window');
            await press(Clutter.ButtonState.PRESSED);await press(Clutter.ButtonState.RELEASED);
            await restored('Attaching a window did not restore the assistant with the draft');
            const context=view._desktopContext;
            await context?.protection;
            const shot=context?.monitors[0];
            assert(context?.scope==='window' && context.focusedWindow.title==='Capture/target' &&
                shot.image.width===frame.width && shot.image.height===frame.height && view._queuedFiles.length===queued+1 &&
                view.queuedAttachments.some(item=>item.id===context.id && item.name==='Window context'),
                'The picked window was not attached as a window context: '+JSON.stringify({scope:context?.scope,
                    title:context?.focusedWindow?.title,size:[shot?.image?.width,shot?.image?.height],frame:[frame.width,frame.height],
                    files:view._queuedFiles.map(file=>file.name)}));
            const chipIcons=all(assistant._promptFileRow).filter(actor=>actor instanceof St.Icon).map(icon=>icon.gicon?.get_names?.()?.[0]);
            assert(chipIcons.includes('focus-windows-symbolic'),'The window context chip lacks its window icon: '+chipIcons);
            await capture('capture-chips');
            view.removeQueuedAttachment(context.id);
            // With window context turned off, it attaches the window's screenshot.
            assistant._settings.set_boolean('window-context-enabled',false);
            try {
                await choose('Attach window…');
                await move(frame.x+frame.width/2,frame.y+frame.height/2);
                await press(Clutter.ButtonState.PRESSED);await press(Clutter.ButtonState.RELEASED);
                await restored('Attaching a window screenshot did not restore the assistant with the draft');
                const picked=view._queuedFiles.find(file=>file.name==='Capture-target.png');
                assert(picked && JSON.stringify(pngSize(picked.bytes))===JSON.stringify([frame.width,frame.height]) && !view._desktopContext,
                    'The window was not attached at its frame size: '+JSON.stringify({names:view._queuedFiles.map(file=>file.name),
                        size:picked&&pngSize(picked.bytes),frame:[frame.width,frame.height]}));
                // A right-click cancels too.
                await choose('Attach window…');
                await press(Clutter.ButtonState.PRESSED,Clutter.BUTTON_SECONDARY);await press(Clutter.ButtonState.RELEASED,Clutter.BUTTON_SECONDARY);
                await restored('Right-click did not cancel the window picker');
                assert(view._queuedFiles.length===queued+2,'Cancelling a window still attached something');
                view.removeQueuedAttachment(area.id);view.removeQueuedAttachment(picked.id);
            } finally {
                assistant._settings.reset('window-context-enabled');
            }
        } finally {
            target.force_exit();
            await wait(()=>!targetWindow(),'The capture target window did not close');
        }
    }
}
