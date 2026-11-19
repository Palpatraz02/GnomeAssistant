import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getStrv} from './settingsAccess.js';

// Window side of screenshot privacy: windows of password managers, 2FA apps
// and apps the user lists, and a notification banner on screen, are found at
// the moment of capture so imagePrivacy.js can black them out.

// Matched against the app ID, GTK application ID and window class.
export const DEFAULT_PRIVATE_APPS = [
    'com.bitwarden.desktop', 'bitwarden', 'org.keepassxc.keepassxc', 'keepassxc', '1password',
    'com.1password.1password', 'me.proton.pass', 'proton-pass', 'proton pass', 'org.gnome.seahorse.application',
    'seahorse', 'org.gnome.world.secrets', 'gnome-secrets', 'secrets', 'com.belmoussaoui.authenticator',
    'authenticator', 'org.gnome.keysign',
];

export function privateApps(settings) {
    let extra = [];
    try {
        extra = getStrv(settings, 'privacy-hidden-apps');
    } catch {
        // Older settings without the key.
    }
    return new Set([...DEFAULT_PRIVATE_APPS, ...extra].map(id => id.toLowerCase().replace(/\.desktop$/, '')));
}

export function windowAppIds(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return [app?.get_id(), window.get_gtk_application_id?.(), window.get_wm_class(), window.get_sandboxed_app_id?.()]
        .filter(Boolean).map(id => id.toLowerCase().replace(/\.desktop$/, ''));
}

// The app's name when the window must stay private, otherwise null.
export function privateWindowLabel(window, apps) {
    if (!windowAppIds(window).some(id => apps.has(id)))
        return null;
    return Shell.WindowTracker.get_default().get_window_app(window)?.get_name() ?? window.get_wm_class() ?? 'a private app';
}

// Screen areas to black out, in stage coordinates, right now.
export function privateRegions(apps) {
    const workspace = global.workspace_manager.get_active_workspace();
    const regions = [];
    for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
        if (window.minimized || !window.located_on_workspace(workspace))
            continue;
        const label = privateWindowLabel(window, apps);
        if (label)
            regions.push({...rectOf(window.get_frame_rect()), label});
    }
    // The banner of a notification showing at capture time.
    const banner = Main.messageTray?._bannerBin;
    if (banner?.mapped && banner.visible && banner.get_n_children?.()) {
        const [x, y] = banner.get_transformed_position();
        const [width, height] = banner.get_transformed_size();
        if (width > 0 && height > 0)
            regions.push({x, y, width, height, label: 'notification'});
    }
    return regions;
}

const rectOf = rect => ({x: rect.x, y: rect.y, width: rect.width, height: rect.height});

export {protectScreenshot, regionsInImage} from './imagePrivacy.js';
