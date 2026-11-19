// Reading a key that the loaded settings schema lacks is a fatal error in
// GLib: it aborts the whole GNOME Shell and cannot be caught. That happens
// when the schema in memory and the extension's code disagree, for example
// after an update installed while the Shell is running. Every read in the
// Shell goes through here and falls back to a default instead.

export function hasKey(settings, key) {
    try {
        return Boolean(settings?.settings_schema?.has_key(key));
    } catch {
        return false;
    }
}

export function getString(settings, key, fallback = '') {
    return hasKey(settings, key) ? settings.get_string(key) : fallback;
}

export function getBoolean(settings, key, fallback = false) {
    return hasKey(settings, key) ? settings.get_boolean(key) : fallback;
}

export function getStrv(settings, key, fallback = []) {
    return hasKey(settings, key) ? settings.get_strv(key) : fallback;
}
