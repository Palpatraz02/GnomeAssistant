import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import {readProfiles} from './connections.js';
import {addAcpConfiguration} from './acpConfigPreferences.js';
import {removeAttachmentDirectory} from './attachments.js';
import {migrateAssistantData, stateFile} from './state.js';
import {removeHistoryMeta} from './historyStore.js';
import {DEFAULT_ASSISTANT_NAME, MAX_ASSISTANT_NAME_LENGTH, assistantName, normalizeAssistantName} from './assistantName.js';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TOGGLE_AI_MODE_KEYBINDING = 'toggle-ai-mode';
const DESKTOP_CONTEXT_KEYBINDING = 'open-with-desktop-context';
const SHORTCUT_RECORDING_LABEL = 'Press shortcut...';
const SHORTCUT_DISABLED_LABEL = 'Disabled';

export default class GnomeAssistantPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        migrateAssistantData(this);
        const settings = this.getSettings();

        window.set_default_size(680, 640);

        // One tab per topic, as GNOME's own settings do.
        const addPage = (name, title, icon) => {
            const tab = new Adw.PreferencesPage({name, title, icon_name: icon});
            window.add(tab);
            return tab;
        };
        const general = addPage('general', 'General', 'preferences-system-symbolic');
        const agent = addPage('agent', 'Agent', 'utilities-terminal-symbolic');
        const context = addPage('context', 'Context', 'preferences-desktop-display-symbolic');
        const privacy = addPage('privacy', 'Privacy', 'preferences-system-privacy-symbolic');
        const notifications = addPage('notifications', 'Notifications', 'preferences-system-notifications-symbolic');

        // General: who the assistant is and how to reach it.
        let page = general;
        this._addNameRow(page, settings);
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
            description: 'Open the agent from anywhere in GNOME.'
        });
        page.add(shortcutGroup);
        this._addShortcutRow(shortcutGroup, settings);
        const backgroundGroup = new Adw.PreferencesGroup({
            title: 'With the Overview Closed',
            description: 'Replies keep running. Notifications tell you when one is ready, fails or needs your approval, and follow Do Not Disturb.',
        });
        page.add(backgroundGroup);
        this._addSwitchRow(backgroundGroup, settings, {
            title: 'Show status in the top bar',
            subtitle: 'While a reply is running, waiting for approval or ready to read.',
            key: 'show-status-indicator',
        });
        this._addFilesIntegration(page, settings, window);

        // Agent: where it works, how to connect, and what it is told.
        page = agent;
        const group = new Adw.PreferencesGroup({
            title: 'Workspace',
            description: 'Choose the project the agent should work in.'
        });
        page.add(group);
        this._addFolderRow(group, settings, window, 'Workspace folder', 'workspace-folder');
        this._addAcpProfiles(page, settings, window);
        addAcpConfiguration(page, settings, window);
        this._addSwitchRow(group, settings, {
            title: 'Delegate automatically',
            subtitle: 'Include a preference for delegating independent work when the connected agent supports it.',
            key: 'auto-delegate',
        });

        const promptGroup = new Adw.PreferencesGroup({
            title: 'Assistant Instructions',
            description: 'Context sent with chat requests. The connected agent determines how it applies these instructions.',
        });
        page.add(promptGroup);
        this._addInstructionsEditor(promptGroup, settings, 'system-prompt', 160);
        const resetPrompt = new Gtk.Button({
            label: 'Restore default prompt',
            halign: Gtk.Align.END,
            css_classes: ['flat'],
        });
        resetPrompt.connect('clicked', () => settings.reset('system-prompt'));
        promptGroup.add(resetPrompt);

        const instructionsGroup = new Adw.PreferencesGroup({
            title: 'Custom Instructions',
            description: 'Add your preferences for the selected agent, such as reply language or style. Start a new chat to apply changes.',
        });
        page.add(instructionsGroup);
        this._addInstructionsEditor(instructionsGroup, settings, 'custom-instructions', 112);

        // Context: what the agent can be shown.
        page = context;
        const contextGroup = new Adw.PreferencesGroup({
            title: 'Desktop Context',
            description: 'Show the agent what you are working on. The shortcut captures your desktop before the overview opens and attaches it to your next message. It is sent to the connected agent and may contain private information.',
        });
        page.add(contextGroup);
        const contextSwitch = this._addSwitchRow(contextGroup, settings, {
            title: 'Enable desktop context shortcut',
            subtitle: 'The monitor layout is always included.',
            key: 'desktop-context-enabled',
        });
        const contextShortcut = this._addShortcutRow(contextGroup, settings, {
            key: DESKTOP_CONTEXT_KEYBINDING,
            title: 'Open with desktop context',
        });
        contextSwitch.bind_property('active', contextShortcut, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        const windowGroup = new Adw.PreferencesGroup({
            title: 'Window Context',
            description: 'Attach one window, with its details and project folder, from its menu (right-click the title bar or press Alt+Space) or with the shortcut.',
        });
        page.add(windowGroup);
        const windowSwitch = this._addSwitchRow(windowGroup, settings, {
            title: 'Enable window context',
            subtitle: 'The window menu entry and the shortcut. Private apps never offer it.',
            key: 'window-context-enabled',
        });
        const windowShortcut = this._addShortcutRow(windowGroup, settings, {
            key: 'open-with-window-context',
            title: 'Ask about the focused window',
        });
        windowSwitch.bind_property('active', windowShortcut, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        // Included Context applies to both kinds of context.
        const anyContext = () => settings.get_boolean('desktop-context-enabled') || settings.get_boolean('window-context-enabled');
        const contextRows = [];
        const syncContextRows = () => contextRows.forEach(row => (row.sensitive = anyContext()));
        for (const key of ['desktop-context-enabled', 'window-context-enabled'])
            settings.connect(`changed::${key}`, syncContextRows);

        const partsGroup = new Adw.PreferencesGroup({
            title: 'Included Context',
            description: 'Choose what desktop and window contexts contain. Changes apply to the next capture.',
        });
        page.add(partsGroup);
        for (const part of [
            {key: 'desktop-context-screenshots', title: 'Screenshots',
                subtitle: 'One per monitor. Requires an agent that accepts images. A window context always includes its window.'},
            {key: 'desktop-context-focused-window', title: 'Focused window',
                subtitle: 'Title, application, monitor, workspace and position of the active window.'},
            {key: 'desktop-context-windows', title: 'Open windows and workspaces',
                subtitle: 'Titles and applications of windows on every workspace.'},
            {key: 'desktop-context-pointer', title: 'Mouse position',
                subtitle: 'Where the pointer is and which window is under it.'},
            {key: 'desktop-context-selection', title: 'Selected text',
                subtitle: 'Text highlighted in an application, up to 8000 characters.'},
            {key: 'desktop-context-projects', title: 'Project directories',
                subtitle: 'Folders inferred from window titles and terminal working directories.'},
            {key: 'desktop-context-events', title: 'Recent events',
                subtitle: 'Notifications, windows opened and closed, crashes and logged errors from the last five minutes. Kept in memory only.'},
            {key: 'desktop-context-app-logs', title: 'Application logs',
                subtitle: 'Recent journal logs of the applications whose windows are captured.'},
            {key: 'desktop-context-device-status', title: 'Device status',
                subtitle: 'Network, audio, Bluetooth, battery and session settings such as Do Not Disturb.'},
        ]) {
            contextRows.push(this._addSwitchRow(partsGroup, settings, part));
        }
        const skipLocal = this._addSwitchRow(partsGroup, settings, {
            key: 'desktop-context-skip-local',
            title: 'Skip what a local agent can read itself',
            subtitle: 'For agents on this computer, leave out device status, crashes, logged errors and application logs, and tell the agent which commands read them. Turn off if your agent runs in a sandbox that blocks these commands. Agents over SSH always receive them.',
        });
        contextRows.push(skipLocal);
        syncContextRows();

        // Privacy: what is kept, and what never leaves.
        page = privacy;
        const privacyGroup = new Adw.PreferencesGroup({
            title: 'Privacy',
            description: 'Control chat history stored by GNOME Assistant. The connected agent manages its own storage and memory.'
        });
        page.add(privacyGroup);

        this._addSwitchRow(privacyGroup, settings, {
            title: 'Save conversations',
            subtitle: 'Keep transcripts in GNOME Assistant. Resume is available when the connected agent supports it.',
            key: 'memory-enabled'
        });
        this._addClearHistoryRow(privacyGroup, window);
        this._addSecretProtection(page, settings);

        this._addProblemNotifications(notifications, settings);
    }

    // Offers to ask the assistant about crashes and other problems (problemWatcher.js).
    _addProblemNotifications(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Problem Notifications',
            description: 'When something goes wrong, a notification offers to ask the assistant. Its button fills in a question with the details; you review it and press Enter to send.',
        });
        page.add(group);
        for (const part of [
            {key: 'problem-crashes', title: 'Crashes', subtitle: 'A program you use crashes.'},
            {key: 'problem-memory', title: 'Out of memory', subtitle: 'A program is closed because memory ran out.'},
            {key: 'problem-services', title: 'Failed services', subtitle: 'A user or system service fails. Off by default: some fail harmlessly.'},
            {key: 'problem-background', title: 'Background processes', subtitle: 'Also crashes of helper processes that have no window.'},
        ])
            this._addSwitchRow(group, settings, part);
        const muted = new Adw.ExpanderRow({title: 'Muted', subtitle: 'Programs and services you chose not to be notified about.'});
        group.add(muted);
        const rows = [];
        const sync = () => {
            for (const row of rows.splice(0))
                muted.remove(row);
            const keys = settings.get_strv('problem-ignored');
            muted.subtitle = keys.length ? `${keys.length} muted` : 'Nothing muted. Use “Don\u2019t show for …” on a notification.';
            for (const key of keys) {
                const [type, ...rest] = key.split(':');
                const row = new Adw.ActionRow({title: rest.join(':'), subtitle: type === 'service' ? 'Service' : 'Program'});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                    css_classes: ['flat'], tooltip_text: 'Notify again'});
                remove.connect('clicked', () => settings.set_strv('problem-ignored',
                    settings.get_strv('problem-ignored').filter(item => item !== key)));
                row.add_suffix(remove);
                muted.add_row(row);
                rows.push(row);
            }
        };
        settings.connect('changed::problem-ignored', sync);
        sync();
    }

    // Secret redaction and screenshot protection (see secretScanner.js,
    // screenPrivacy.js, imagePrivacy.js).
    _addSecretProtection(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Secrets and Private Windows',
            description: 'Before anything reaches the agent: secrets in collected text are replaced by labels such as [redacted password], you are asked before sending secrets you typed or attached, sensitive files are left out of folders, and private windows and notifications are blacked out in screenshots.',
        });
        page.add(group);
        const enabled = this._addSwitchRow(group, settings, {
            title: 'Protect secrets and private windows',
            subtitle: 'Recommended. Every change is listed in the Shared view.',
            key: 'privacy-protection',
        });

        const apps = new Adw.ExpanderRow({title: 'Private apps',
            subtitle: 'Their windows are blacked out in screenshots and cannot be captured. Password managers and authenticator apps are always included.'});
        group.add(apps);
        enabled.bind_property('active', apps, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        const installed = Gio.AppInfo.get_all().filter(app => app.should_show() && app.get_id())
            .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
        const appName = id => installed.find(app => app.get_id().replace(/\.desktop$/, '') === id)?.get_display_name() ?? id;
        const rows = [];
        const picker = new Adw.ActionRow({title: 'Add an app'});
        const choices = Gtk.StringList.new(installed.map(app => app.get_display_name()));
        const dropdown = new Gtk.DropDown({model: choices, enable_search: true, valign: Gtk.Align.CENTER,
            expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string')});
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: 'Add this app'});
        add.connect('clicked', () => {
            const app = installed[dropdown.selected];
            const id = app?.get_id().replace(/\.desktop$/, '');
            const current = settings.get_strv('privacy-hidden-apps');
            if (id && !current.includes(id))
                settings.set_strv('privacy-hidden-apps', [...current, id]);
        });
        picker.add_suffix(dropdown);
        picker.add_suffix(add);
        apps.add_row(picker);
        const sync = () => {
            for (const row of rows.splice(0))
                apps.remove(row);
            for (const id of settings.get_strv('privacy-hidden-apps')) {
                const row = new Adw.ActionRow({title: appName(id), subtitle: id});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                    css_classes: ['flat'], tooltip_text: 'Remove'});
                remove.connect('clicked', () => settings.set_strv('privacy-hidden-apps',
                    settings.get_strv('privacy-hidden-apps').filter(item => item !== id)));
                row.add_suffix(remove);
                apps.add_row(row);
                rows.push(row);
            }
        };
        settings.connect('changed::privacy-hidden-apps', sync);
        sync();

        // OCR is optional: say whether it is available, and how to get it.
        let ocr = false;
        const tesseract = GLib.find_program_in_path('tesseract');
        if (tesseract) {
            try {
                const [, out] = GLib.spawn_sync(null, [tesseract, '--list-langs'], null, GLib.SpawnFlags.DEFAULT, null);
                ocr = /^eng$/m.test(new TextDecoder().decode(out));
            } catch {
                // Treated as unavailable.
            }
        }
        const status = new Adw.ActionRow({
            title: 'Secret text in screenshots',
            subtitle: ocr ? 'Available: screenshots are also checked with Tesseract OCR, which blacks out text that looks like a secret.'
                : 'Not available. Install Tesseract with English data (for example tesseract and tesseract-data-eng) to also black out secret-looking text in screenshots.',
        });
        enabled.bind_property('active', status, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        group.add(status);
    }

    _addAcpProfiles(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'ACP connections',
            description: 'Changes are saved automatically. Use a local command or an SSH host from your SSH configuration. Run ssh in a terminal once to verify the host and sign in.',
        });
        page.add(group);
        const selector = new Adw.ComboRow({title: 'Connection'});
        group.add(selector);
        const transport = new Adw.ComboRow({title: 'Transport', model: Gtk.StringList.new(['Local command', 'SSH'])});
        group.add(transport);
        const fields = {};
        for (const [key, title] of [['name', 'Name'], ['command', 'ACP command and arguments'],
            ['host', 'SSH host'], ['remoteCwd', 'Remote workspace']]) {
            fields[key] = new Adw.EntryRow({title});
            group.add(fields[key]);
        }
        const browser = new Gtk.Button({label: 'New connection', valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']});
        const remove = new Gtk.Button({label: 'Remove', css_classes: ['destructive-action'], valign: Gtk.Align.CENTER});
        const buttons = new Gtk.Box({spacing: 8});
        buttons.append(browser);
        buttons.append(remove);
        const actions = new Adw.ActionRow({title: 'Manage connections'});
        actions.add_suffix(buttons);
        group.add(actions);
        const commands = new Adw.SwitchRow({title: 'Allow local command requests',
            subtitle: 'Ask in chat before running a sandboxed command in a shared local folder.'});
        group.add(commands);
        let profiles = [];
        let updating = false;
        const sync = () => {
            updating = true;
            profiles = readProfiles(settings);
            const index = profiles.findIndex(profile => profile.id === settings.get_string('acp-profile'));
            const profile = profiles[index];
            const names = profiles.map(item => item.name || 'Unnamed connection');
            if (!selector.model || selector.model.get_n_items() !== names.length ||
                names.some((name, position) => selector.model.get_string(position) !== name))
                selector.model = Gtk.StringList.new(names);
            selector.selected = index < 0 ? Gtk.INVALID_LIST_POSITION : index;
            transport.visible = Boolean(profile);
            transport.selected = profile?.transport === 'ssh' ? 1 : 0;
            commands.active = Boolean(profile?.localCommands);
            commands.visible = profile?.transport === 'ssh';
            remove.sensitive = Boolean(profile);
            for (const [key, field] of Object.entries(fields)) {
                field.visible = Boolean(profile) && (['name', 'command'].includes(key) || profile.transport === 'ssh');
                const value = profile?.[key] ?? '';
                if (field.text !== value)
                    field.text = value;
            }
            updating = false;
        };
        const save = next => settings.set_string('acp-profiles', JSON.stringify(next));
        const edit = (key, value) => {
            if (updating)
                return;
            const id = settings.get_string('acp-profile');
            save(readProfiles(settings).map(profile => profile.id === id ? {...profile, [key]: value} : profile));
        };
        for (const [key, field] of Object.entries(fields))
            field.connect('notify::text', () => edit(key, field.text));
        transport.connect('notify::selected', () => edit('transport', transport.selected === 1 ? 'ssh' : 'local'));
        commands.connect('notify::active', () => edit('localCommands', commands.active));
        selector.connect('notify::selected', () => {
            if (!updating && profiles[selector.selected])
                settings.set_string('acp-profile', profiles[selector.selected].id);
        });
        browser.connect('clicked', () => {
            const id = GLib.uuid_string_random();
            save([...readProfiles(settings), {id, name: 'New connection', transport: 'local', command: '',
                host: '', remoteCwd: '', localCommands: false}]);
            settings.set_string('acp-profile', id);
        });
        remove.connect('clicked', () => {
            const id = settings.get_string('acp-profile');
            const remaining = readProfiles(settings).filter(profile => profile.id !== id);
            save(remaining);
            settings.set_string('acp-profile', remaining[0]?.id ?? '');
            window.add_toast(new Adw.Toast({title: 'Connection removed'}));
        });
        const signals = ['acp-profiles', 'acp-profile']
            .map(key => settings.connect(`changed::${key}`, sync));
        window.connect('close-request', () => {
            signals.forEach(signal => settings.disconnect(signal));
            Gio.Settings.sync();
            return false;
        });
        sync();
    }

    _addInstructionsEditor(group, settings, key, height) {
        const editor = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 12,
            right_margin: 12,
            top_margin: 10,
            bottom_margin: 10,
            accessible_role: Gtk.AccessibleRole.TEXT_BOX,
        });
        editor.update_property([Gtk.AccessibleProperty.LABEL], [group.title]);
        settings.bind(key, editor.buffer, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(new Gtk.ScrolledWindow({
            child: editor,
            min_content_height: height,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            css_classes: ['card'],
        }));
    }

    _addEntryRow(group, settings, title, key) {
        const row = new Adw.EntryRow({title});
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    _addFolderRow(group, settings, window, title, key) {
        const row = this._addEntryRow(group, settings, title, key);
        const browse = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: `Choose ${title}`,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        row.add_suffix(browse);
        browse.connect('clicked', () => {
            const chooser = new Gtk.FileDialog({title});
            chooser.select_folder(window, null, (dialog, result) => {
                try {
                    const path = dialog.select_folder_finish(result)?.get_path();
                    if (path)
                        settings.set_string(key, path);
                } catch (_error) {
                    // The chooser was dismissed.
                }
            });
        });
    }

    _addShortcutRow(group, settings, {key = TOGGLE_AI_MODE_KEYBINDING, title = 'Toggle agent mode'} = {}) {
        const row = new Adw.ActionRow({
            title,
            subtitle: 'Click the button, then press a shortcut. Backspace clears it.'
        });

        const button = new Gtk.Button({
            valign: Gtk.Align.CENTER
        });

        let recording = false;
        const updateButton = () => {
            button.set_label(recording
                ? SHORTCUT_RECORDING_LABEL
                : this._getShortcutLabel(settings, key));
        };

        button.connect('clicked', () => {
            recording = true;
            updateButton();
            button.grab_focus();
        });

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!recording)
                return false;

            if (keyval === Gdk.KEY_Escape) {
                recording = false;
                updateButton();
                return true;
            }

            if (keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(key, []);
                recording = false;
                updateButton();
                return true;
            }

            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (!this._isValidShortcut(keyval, modifiers))
                return true;

            settings.set_strv(key, [
                Gtk.accelerator_name(keyval, modifiers)
            ]);
            recording = false;
            updateButton();
            return true;
        });
        button.add_controller(controller);

        settings.connect(`changed::${key}`, () => {
            if (!recording)
                updateButton();
        });
        updateButton();

        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
        return row;
    }

    _getShortcutLabel(settings, key) {
        const shortcuts = settings.get_strv(key);
        const shortcut = shortcuts[0] ?? '';
        if (!shortcut)
            return SHORTCUT_DISABLED_LABEL;

        const [ok, keyval, modifiers] = Gtk.accelerator_parse(shortcut);
        if (!ok || !Gtk.accelerator_valid(keyval, modifiers))
            return shortcut;

        return Gtk.accelerator_get_label(keyval, modifiers);
    }

    _isValidShortcut(keyval, modifiers) {
        if (!Gtk.accelerator_valid(keyval, modifiers))
            return false;

        const nonShiftModifiers =
            Gdk.ModifierType.CONTROL_MASK |
            Gdk.ModifierType.ALT_MASK |
            Gdk.ModifierType.SUPER_MASK |
            Gdk.ModifierType.META_MASK;

        if ((modifiers & nonShiftModifiers) !== 0)
            return true;

        return keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
    }

    // The Files extension is compiled and must go in Files' system folder,
    // so it is installed once with administrator rights, not from here.
    _addFilesIntegration(page, settings, window) {
        const describe = () => `Adds “Ask ${assistantName(settings)}” to the right-click menu in Files. Selected files and folders, or the folder you right-click in, are added to the chat: as references for an agent on this computer, or as attachments for an agent over SSH.`;
        const group = new Adw.PreferencesGroup({title: 'Files', description: describe()});
        settings.connect('changed::assistant-name', () => group.set_description(describe()));
        page.add(group);
        const library = 'libgnome-assistant-files.so';
        const installed = ['/usr/lib/nautilus/extensions-4', '/usr/lib64/nautilus/extensions-4',
            '/usr/lib/x86_64-linux-gnu/nautilus/extensions-4', '/usr/lib/aarch64-linux-gnu/nautilus/extensions-4']
            .some(directory => GLib.file_test(GLib.build_filenamev([directory, library]), GLib.FileTest.EXISTS));
        const source = GLib.shell_quote(GLib.build_filenamev([this.path, 'nautilus']));
        const command = `make -C ${source} && sudo make -C ${source} install && nautilus -q`;
        const row = new Adw.ActionRow({
            title: 'Files right-click menu',
            subtitle: installed
                ? 'Installed. After updating GNOME Assistant, run the install command again.'
                : 'Not installed. Run the install command once in a terminal: it builds the extension and installs it with administrator rights, then restarts Files. Needs a C compiler and the Files extension headers.',
        });
        const copy = new Gtk.Button({label: 'Copy install command', valign: Gtk.Align.CENTER});
        copy.connect('clicked', () => {
            copy.get_clipboard().set(command);
            window.add_toast(new Adw.Toast({title: 'Install command copied'}));
        });
        row.add_suffix(copy);
        group.add(row);
    }

    // The name shown for the assistant: in the chat, the prompt placeholder,
    // notifications and the Files menu. Saved on Enter or with the apply button.
    _addNameRow(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Assistant',
            description: `Shown in the chat, the prompt, notifications and the Files menu. The agent is told the name you choose. Up to ${MAX_ASSISTANT_NAME_LENGTH} characters.`,
        });
        page.add(group);
        const row = new Adw.EntryRow({title: 'Name', show_apply_button: true, text: assistantName(settings)});
        row.connect('apply', () => {
            const name = normalizeAssistantName(row.text);
            settings.set_string('assistant-name', name);
            row.text = name;
        });
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: `Use the default name, ${DEFAULT_ASSISTANT_NAME}`});
        reset.connect('clicked', () => settings.reset('assistant-name'));
        row.add_suffix(reset);
        const sync = () => {
            reset.sensitive = assistantName(settings) !== DEFAULT_ASSISTANT_NAME;
            if (!row.has_focus)
                row.text = assistantName(settings);
        };
        settings.connect('changed::assistant-name', sync);
        sync();
        group.add(row);
    }

    _addSwitchRow(group, settings, {title, subtitle, key}) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    _addClearHistoryRow(group, window) {
        const path = stateFile('chat-history.jsonl').get_path();
        const title = 'Clear overview history';
        const description = 'Deletes overview transcripts, their titles and pins, and their downloaded attachments. The agent manages its own saved sessions.';
        const clear = () => this._clearHistoryFile(path)
            ? 'Overview history cleared'
            : 'Could not clear overview history';

        if (Adw.ButtonRow) {
            const row = new Adw.ButtonRow({title, tooltip_text: description});
            row.add_css_class('destructive-action');
            row.connect('activated', () => {
                window.add_toast(new Adw.Toast({title: clear()}));
            });
            group.add(row);
        } else {
            const row = new Adw.ActionRow({title, subtitle: description});
            const button = new Gtk.Button({
                label: 'Clear now',
                valign: Gtk.Align.CENTER,
                css_classes: ['destructive-action'],
            });
            button.connect('clicked', () => {
                row.subtitle = clear();
            });
            row.add_suffix(button);
            group.add(row);
        }
    }

    _clearHistoryFile(path) {
        try {
            if (GLib.file_test(path, GLib.FileTest.EXISTS) && GLib.unlink(path) !== 0)
                return false;
            removeHistoryMeta();
            removeAttachmentDirectory();
            return true;
        } catch (_e) {
            return false;
        }
    }
}
