import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getBoolean} from './settingsAccess.js';

const LEGACY_NAME = 'ai-search-assistant';
const LEGACY_SCHEMA = 'org.gnome.shell.extensions.' + LEGACY_NAME;

export function stateFile(...parts) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'gnome-assistant', ...parts]));
}

function moveIfMissing(source, target) {
    try {
        source.move(target, Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE, null, null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS) &&
            !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}

export function migrateState() {
    const legacy = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), LEGACY_NAME]));
    const marker = stateFile('.legacy-state-migrated');
    if (!legacy.query_exists(null) || marker.query_exists(null))
        return;

    const target = stateFile();
    moveIfMissing(legacy, target);
    if (!legacy.query_exists(null))
        return;

    // Also support upgrades where the new state directory already exists.
    moveIfMissing(legacy.get_child('chat-history.jsonl'), stateFile('chat-history.jsonl'));
    // Leave conflicting legacy files in place without resurrecting them after a clear.
    marker.replace_contents(new Uint8Array(), null, false, Gio.FileCreateFlags.PRIVATE, null);
}

export function migrateSettings(settings, legacy) {
    if (getBoolean(settings, 'settings-migrated'))
        return;
    settings.delay();
    for (const key of legacy.settings_schema.list_keys()) {
        const value = legacy.get_user_value(key);
        if (value && settings.settings_schema.has_key(key) && !settings.get_user_value(key))
            settings.set_value(key, value);
    }
    settings.set_boolean('settings-migrated', true);
    settings.apply();
}

export function migrateAssistantData(extension) {
    // Delayed GSettings writes stay enabled on the migration instance only.
    migrateSettings(extension.getSettings(), extension.getSettings(LEGACY_SCHEMA));
    const settings = extension.getSettings();
    if (!settings.get_user_value('workspace-folder')) {
        const legacy = extension.getSettings(LEGACY_SCHEMA);
        const workspace = (settings.get_user_value('codex-workspace') ??
            legacy.get_user_value('codex-workspace'))?.get_string()[0];
        if (workspace)
            settings.set_string('workspace-folder', workspace);
    }
    Gio.Settings.sync();
    try {
        migrateState();
    } catch (error) {
        console.warn('GNOME Assistant: Could not move legacy state', error);
    }
}
