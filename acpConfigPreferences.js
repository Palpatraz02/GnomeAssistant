import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import {activeProfile} from './connections.js';
import {configContext, readConfigObject, savedConfigValues, saveConfigValue, selectChoices} from './acpConfig.js';

export function addAcpConfiguration(page, settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'Agent configuration',
        description: 'Model, thinking effort and other choices provided by your ACP agent. Selections are saved per connection and applied to new chats.',
    });
    page.add(group);
    let rows = [];
    const sync = () => {
        for (const row of rows)
            group.remove(row);
        rows = [];
        const add = row => { rows.push(row); group.add(row); };
        const profile = activeProfile(settings);
        const state = readConfigObject(settings, 'acp-config-state');
        const matches = state.key === configContext(profile, settings.get_string('workspace-folder'));
        const ready = matches && state.ready;
        const options = ready && Array.isArray(state.options)
            ? state.options.filter(option => option.type === 'select') : [];
        const saved = savedConfigValues(settings, profile?.id);
        for (const option of options) {
            const choices = selectChoices(option);
            const row = new Adw.ComboRow({title: option.name ?? option.id,
                use_subtitle: false, use_markup: false, sensitive: !state.busy && choices.length > 0});
            const labels = choices.map(choice => choice.groupName
                ? `${choice.groupName} — ${choice.name ?? choice.value}` : choice.name ?? choice.value);
            row.model = Gtk.StringList.new(labels);
            const index = choices.findIndex(choice => choice.value === option.currentValue);
            row.selected = index < 0 ? Gtk.INVALID_LIST_POSITION : index;
            const unavailable = Object.hasOwn(saved, option.id) &&
                !choices.some(choice => choice.value === saved[option.id]);
            row.subtitle = [option.description,
                unavailable ? 'Saved choice unavailable; using the agent’s current value.' : '',
                choices[index]?.description].filter(Boolean).join(' ');
            row.connect('notify::selected', () => {
                const choice = choices[row.selected];
                if (choice && choice.value !== option.currentValue)
                    saveConfigValue(settings, profile.id, option.id, choice.value);
            });
            add(row);
        }
        for (const [category, title] of [['model', 'Model'], ['thought_level', 'Thinking effort']]) {
            if (options.some(option => option.category === category))
                continue;
            add(new Adw.ActionRow({title, sensitive: false,
                subtitle: ready ? 'Not offered by this agent through ACP.'
                    : profile ? 'Available after the extension connects to the agent.' : 'Select an ACP connection first.'}));
        }
        if (matches && state.error)
            add(new Adw.ActionRow({title: 'Could not apply agent settings', subtitle: state.error}));
        else if (ready && state.busy)
            add(new Adw.ActionRow({title: state.applying ? 'Applying your selection…'
                : 'The agent is working. Settings are available after this response.'}));
    };
    const signals = ['acp-config-state', 'acp-profile', 'acp-profiles', 'workspace-folder']
        .map(key => settings.connect(`changed::${key}`, sync));
    window.connect('close-request', () => {
        signals.forEach(signal => settings.disconnect(signal));
        return false;
    });
    sync();
    return group;
}
