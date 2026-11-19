// ACP option IDs and values are opaque. Only categories guide presentation/order.
export function selectChoices(option) {
    if (option?.type !== 'select' || !Array.isArray(option.options))
        return [];
    return option.options.flatMap(item => Array.isArray(item.options)
        ? item.options.map(choice => ({...choice, groupName: item.name})) : [item])
        .filter(choice => typeof choice.value === 'string');
}

export function readConfigObject(settings, key) {
    try {
        // As settingsAccess.js (this module stays import-free): reading a key
        // missing from the loaded schema would abort GNOME Shell.
        const schema = settings?.settings_schema;
        const value = JSON.parse(!schema || schema.has_key(key) ? settings.get_string(key) : '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_error) {
        return {};
    }
}

export function savedConfigValues(settings, profileId) {
    const value = readConfigObject(settings, 'acp-config-values')[profileId];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function saveConfigValue(settings, profileId, configId, value) {
    const profiles = readConfigObject(settings, 'acp-config-values');
    settings.set_string('acp-config-values', JSON.stringify({...profiles,
        [profileId]: {...savedConfigValues(settings, profileId), [configId]: value}}));
}

export function configContext(profile, localCwd) {
    if (!profile)
        return '';
    return JSON.stringify([profile.id, profile.transport, profile.host ?? '', profile.command,
        profile.transport === 'ssh' ? profile.remoteCwd : localCwd, localCwd]);
}

export function nextConfigChange(options, values, attempted = new Set()) {
    // A model change may replace the effort selector and its available values.
    const ordered = [...options.filter(option => option.category === 'model'),
        ...options.filter(option => option.category !== 'model')];
    return ordered.find(option => {
        const value = Object.hasOwn(values, option.id) ? values[option.id] : undefined;
        return typeof value === 'string' && value !== option.currentValue &&
            !attempted.has(JSON.stringify([option.id, value])) &&
            selectChoices(option).some(choice => choice.value === value);
    });
}
