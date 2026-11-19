import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

const TITLES = {save: 'Download attachment', 'save-code': 'Save code', export: 'Export conversation',
    folder: 'Share a local folder', open: 'Attach a file', 'reference-file': 'Reference a file',
    'reference-folder': 'Reference a folder'};
const METHODS = {save: 'save', 'save-code': 'save', export: 'save', open: 'open', folder: 'select_folder',
    'reference-file': 'open', 'reference-folder': 'select_folder'};

const [action, name = ''] = ARGV;
const app = new Gtk.Application({flags: Gio.ApplicationFlags.NON_UNIQUE, application_id: 'org.gnome.Assistant.FileDialog'});
app.connect('activate', () => {
    app.hold();
    const dialog = new Gtk.FileDialog({
        title: TITLES[action] ?? TITLES.open,
        modal: true,
        ...(METHODS[action] === 'save' ? {initial_name: name} : {}),
    });
    const method = METHODS[action] ?? METHODS.open;
    dialog[method](null, null, (source, result) => {
        try {
            const path = source[method + '_finish'](result)?.get_path();
            if (path)
                print(JSON.stringify(path));
        } catch (_error) {
            // The user dismissed the chooser.
        } finally {
            app.release();
        }
    });
});
app.run([]);
