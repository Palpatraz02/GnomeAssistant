import GLib from 'gi://GLib';

// GNOME does not know which project an application works in. These are
// inferences from window titles and process working directories, reported as
// ranked candidates with their sources so the agent can weigh and verify them.

const MARKERS = ['.git', '.hg', '.svn', 'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod',
    'meson.build', 'CMakeLists.txt', 'Makefile', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile',
    'deno.json', 'metadata.json'];
const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu', 'xonsh', 'elvish', 'pwsh']);
const MAX_CANDIDATES = 8;
const MAX_PROCESSES = 64;
const MAX_DEPTH = 12;
const TITLE_PATH = /(?:^|[\s:("'[=])((?:~|\/)[^\s"'()[\]:,;]*)/g;
const TITLE_SEPARATOR = /\s+[—–\-|•·]\s+/;
// Where people keep projects, searched for a folder name an editor shows.
const SEARCH_FOLDERS = ['', 'Projects', 'projects', 'Project', 'src', 'Source', 'code', 'Code', 'dev', 'Dev', 'Developer',
    'git', 'Git', 'repos', 'Repos', 'workspace', 'Workspace', 'work', 'Work', 'Documents'];
const MAX_SEARCH_CHILDREN = 100;
const MAX_NAME_LENGTH = 100;

const home = GLib.get_home_dir();
const decoder = new TextDecoder();

function readText(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

function processCwd(pid) {
    try {
        return GLib.file_read_link(`/proc/${pid}/cwd`);
    } catch {
        return null;
    }
}

function childProcesses(pid) {
    const children = [];
    let tasks;
    try {
        tasks = GLib.Dir.open(`/proc/${pid}/task`, 0);
    } catch {
        return children;
    }
    for (let task; (task = tasks.read_name());)
        children.push(...(readText(`/proc/${pid}/task/${task}/children`) ?? '').split(/\s+/).filter(Boolean).map(Number));
    tasks.close();
    return children;
}

// Working directories of the shells running inside a window's process.
function shellDirectories(pid) {
    const found = [];
    const queue = [[pid, 0]];
    for (let seen = 0; queue.length && seen < MAX_PROCESSES; seen++) {
        const [current, depth] = queue.shift();
        if (current !== pid && SHELLS.has(readText(`/proc/${current}/comm`)?.trim())) {
            const cwd = processCwd(current);
            if (cwd)
                found.push(cwd);
            continue;
        }
        if (depth < 3)
            queue.push(...childProcesses(current).map(child => [child, depth + 1]));
    }
    return found;
}

function directoryFor(path) {
    const expanded = path.startsWith('~') ? home + path.slice(1) : path;
    const clean = GLib.canonicalize_filename(expanded.replace(/[.…]+$/, '') || '/', null);
    if (GLib.file_test(clean, GLib.FileTest.IS_DIR))
        return clean;
    if (GLib.file_test(clean, GLib.FileTest.IS_REGULAR))
        return GLib.path_get_dirname(clean);
    return null;
}

function projectRoot(directory) {
    let current = directory;
    for (let depth = 0; depth < MAX_DEPTH && current !== '/' && current !== home; depth++) {
        const marker = MARKERS.find(name => GLib.file_test(GLib.build_filenamev([current, name]), GLib.FileTest.EXISTS));
        if (marker)
            return {path: current, marker};
        current = GLib.path_get_dirname(current);
    }
    return null;
}

function childFolders(path) {
    const folders = [];
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return folders;
    }
    for (let name; folders.length < MAX_SEARCH_CHILDREN && (name = dir.read_name());) {
        const child = GLib.build_filenamev([path, name]);
        if (!name.startsWith('.') && GLib.file_test(child, GLib.FileTest.IS_DIR) && !GLib.file_test(child, GLib.FileTest.IS_SYMLINK))
            folders.push(child);
    }
    dir.close();
    return folders;
}

// Parts of a window title that could be a folder name ("gnome-assistant" in
// "main.js — gnome-assistant — Visual Studio Code").
function titleNames(title) {
    return [...new Set(title.split(TITLE_SEPARATOR)
        .map(part => part.replace(/^[^\p{L}\p{N}._-]+/u, '').replace(/\s+\[[^\]]*\]$/, '').trim())
        .filter(part => part && part.length <= MAX_NAME_LENGTH && !part.includes('/') && part !== '.' && part !== '..'))];
}

// Projects named like a part of the title, in the usual places: directly in
// them, or one folder further down (~/Projects/work/name). Only a single match
// counts: two folders of the same name would make it a coin flip.
export function searchProjectByName(title, {base = home} = {}) {
    const names = titleNames(title);
    if (!names.length)
        return null;
    const found = new Set();
    const check = (folder, name) => {
        const directory = GLib.build_filenamev([folder, name]);
        if (projectRoot(directory)?.path === directory)
            found.add(GLib.canonicalize_filename(directory, null));
    };
    const folders = SEARCH_FOLDERS.map(folder => folder ? GLib.build_filenamev([base, folder]) : base)
        .filter(folder => GLib.file_test(folder, GLib.FileTest.IS_DIR));
    for (const folder of [...new Set(folders)]) {
        for (const name of names)
            check(folder, name);
        if (folder === base)
            continue;
        for (const child of childFolders(folder)) {
            for (const name of names)
                check(child, name);
        }
    }
    return found.size === 1 ? [...found][0] : null;
}

export function projectCandidates(windows, {focused = null, activeWorkspace = 0, knownRoots = [], searchNames = true} = {}) {
    const candidates = new Map();
    const add = (directory, window, source, {needsRoot = false} = {}) => {
        if (!directory || directory === '/' || directory === home)
            return;
        const root = projectRoot(directory);
        if (needsRoot && !root)
            return;
        const path = root?.path ?? directory;
        let candidate = candidates.get(path);
        if (!candidate) {
            candidate = {path, marker: root?.marker ?? null, directories: new Set(), windows: new Set(),
                sources: new Set(), focused: false};
            candidates.set(path, candidate);
        }
        if (directory !== path)
            candidate.directories.add(directory);
        if (window) {
            candidate.windows.add(window.get_id().toString());
            candidate.focused ||= window === focused;
        }
        candidate.sources.add(source);
    };

    for (const root of knownRoots)
        add(root, null, 'agent_workspace');
    const pidWindows = new Map();
    for (const window of windows) {
        const pid = window.get_pid?.() ?? 0;
        if (pid > 0)
            pidWindows.set(pid, (pidWindows.get(pid) ?? 0) + 1);
    }
    // Focused window first, then most recently used.
    const ordered = focused && windows.includes(focused) ? [focused, ...windows.filter(w => w !== focused)] : windows;
    const unresolved = [];
    for (const window of ordered) {
        const before = candidates.size;
        const title = window.get_title() ?? '';
        for (const match of title.matchAll(TITLE_PATH))
            add(directoryFor(match[1]), window, 'window_title');
        // Only a process with a single window maps its shells to that window.
        const pid = window.get_pid?.() ?? 0;
        const onScreen = !window.minimized && (window.is_on_all_workspaces() ||
            window.get_workspace?.()?.index() === activeWorkspace);
        if (pid > 0 && pidWindows.get(pid) === 1 && onScreen) {
            const shells = shellDirectories(pid);
            for (const directory of shells)
                add(directory, window, 'terminal_shell');
            if (!shells.length)
                add(processCwd(pid), window, 'process', {needsRoot: true});
        }
        if (candidates.size === before)
            unresolved.push(window);
    }
    // Editors often show only the folder name: match it against what we found.
    for (const window of unresolved) {
        const parts = new Set(titleNames(window.get_title() ?? ''));
        let matched = false;
        for (const candidate of candidates.values()) {
            if (parts.has(GLib.path_get_basename(candidate.path))) {
                candidate.windows.add(window.get_id().toString());
                candidate.focused ||= window === focused;
                candidate.sources.add('window_title_name');
                matched = true;
            }
        }
        // Still nothing for the focused window: look for that name on disk.
        if (!matched && searchNames && window === focused) {
            const path = searchProjectByName(window.get_title() ?? '');
            if (path)
                add(path, window, 'name_search');
        }
    }
    return [...candidates.values()]
        .filter(candidate => candidate.windows.size)
        .sort((a, b) => Number(b.focused) - Number(a.focused))
        .slice(0, MAX_CANDIDATES)
        .map(candidate => ({
            path: candidate.path,
            marker: candidate.marker,
            ...(candidate.directories.size ? {directories: [...candidate.directories].slice(0, 4)} : {}),
            windows: [...candidate.windows],
            sources: [...candidate.sources],
            ...(candidate.focused ? {focused: true} : {}),
        }));
}
