// Project detection for windows, with a stand-in home folder:
// gjs -m tests/test_desktop_project.js
import GLib from 'gi://GLib';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const root = GLib.dir_make_tmp('gnome-assistant-projects-XXXXXX');
const home = `${root}/home`;
const mkdir = path => GLib.mkdir_with_parents(`${home}/${path}`, 0o755);
const touch = path => GLib.file_set_contents(`${home}/${path}`, '');
// One project directly in ~/Projects, one a folder deeper, two of the same
// name, and a folder that is no project.
for (const path of ['Projects/thesis/.git', 'Projects/thesis/figures', 'code/work/api-server', 'Projects/notes', 'src/notes', 'Documents/photos'])
    mkdir(path);
touch('code/work/api-server/package.json');
touch('Projects/notes/Makefile');
touch('src/notes/Makefile');
GLib.setenv('HOME', home, true);
const {projectCandidates, searchProjectByName} = await import('../desktopProject.js');

let failed = false;
try {
    assert(searchProjectByName('main.tex — thesis — Visual Studio Code') === `${home}/Projects/thesis`,
        'A project directly in ~/Projects was not found');
    assert(searchProjectByName('● index.js - api-server - Zed') === `${home}/code/work/api-server`,
        'A project one folder deeper was not found (or the unsaved marker was kept)');
    assert(searchProjectByName('todo.md — notes — Editor') === null, 'Two projects of the same name were a coin flip');
    assert(searchProjectByName('photos — Files') === null, 'A folder without project markers counted as a project');
    assert(searchProjectByName('Untitled') === null, 'A title without a project matched');

    const window = (id, title) => ({get_id: () => id, get_title: () => title, get_pid: () => 0, minimized: false,
        is_on_all_workspaces: () => false, get_workspace: () => ({index: () => 0})});
    const editor = window(1, 'chapter2.tex — thesis — Code');
    const other = window(2, 'notes.txt — thesis — Code');
    const [found] = projectCandidates([editor, other], {focused: editor});
    // Found for the focused window; the other window naming it is then linked too.
    assert(found?.path === `${home}/Projects/thesis` && found.sources.join() === 'name_search,window_title_name' &&
        found.focused && found.windows.join() === '1,2', 'The focused editor was not linked by name search: ' + JSON.stringify(found));
    assert(projectCandidates([other, editor], {focused: null}).length === 0, 'Name search ran for windows that are not focused');
    assert(projectCandidates([editor], {focused: editor, searchNames: false}).length === 0, 'searchNames: false still searched');
    // A path in a title wins, and other windows naming that folder are linked to it.
    const terminal = window(3, `~/Projects/thesis/figures`);
    const candidates = projectCandidates([terminal, other], {focused: other});
    assert(candidates.length === 1 && candidates[0].sources.sort().join() === 'window_title,window_title_name' &&
        candidates[0].windows.sort().join() === '2,3', 'Title paths and names were not combined: ' + JSON.stringify(candidates));
    print('DESKTOP PROJECT TESTS PASSED');
} catch (error) {
    printerr(`${error}`);
    failed = true;
}
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
if (failed)
    imports.system.exit(1);
