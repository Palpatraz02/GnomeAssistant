# GNOME Assistant

GNOME Assistant brings an ACP agent into GNOME Shell’s Activities overview.
Chat, work on a project, review approvals, exchange files, and use interactive
interfaces without leaving the overview.

## Credits

GNOME Assistant is a **hard fork** of
[GNOME Shell AI Search Assistant](https://github.com/lerosua/gnome-shell-ai-search-assistant),
created by **lerosua**. Many thanks to them for the original extension.

The base idea is the same, an AI agent inside GNOME Shell's overview, but
the extension has been radically changed and now goes its own way: it is
developed independently, with AI coding agents, and does not track upstream.
The original history is kept in this repository, and the project keeps the
upstream [MIT license](LICENSE), with lerosua's copyright notice.

## What it does

- Connects to a locally launched ACP agent or launches one on an SSH host.
- Streams replies, shows activity beneath messages, and displays approvals in chat.
- Keeps working with the overview closed: a top-bar indicator and notifications
  report progress, finished replies, and approvals you can answer from the notification.
- Provides a growing multiline prompt, attachment chips, and `$` command suggestions.
- Renders Markdown, selectable message text, image previews, and downloadable files.
- Turns local file paths in replies into links, adds **Copy** and **Save as…** to
  code blocks, and shows file edits awaiting approval as diffs.
- Displays interactive A2UI interfaces directly in the overview.
- Saves local conversation history, searchable and with custom titles and pins,
  exports conversations as Markdown, and resumes sessions when the agent supports it.
- Exposes model, effort, and other settings advertised by the connected agent.

The integration is **agent-independent**. It uses ACP protocol version 1 over
stdio, including over SSH. GNOME Assistant does not bundle an agent, install
adapters, manage provider credentials, or call a model provider directly.
Available tools, skills, delegation, memory, and configuration depend on the agent.

## Requirements

The [extension metadata](metadata.json) currently declares GNOME Shell **45, 46,
47, 48, 49, and 51**. Recent native UI checks in this workspace run on Shell 51;
the metadata list is not a claim that every version has been tested equally.

For the extension and its Preferences/file dialogs, install:

- GJS and GNOME Shell’s normal introspection libraries.
- GTK4 **4.10+** and libadwaita **1.4+**.
- libsoup **3.0** and GdkPixbuf introspection support.
- GLib’s `glib-compile-schemas` tool for installation from source.
- An installed, authenticated ACP agent or adapter.

Additional dependencies depend on the feature:

| Feature | Dependency |
| --- | --- |
| Public HTTPS image previews | `curl` |
| SSH connections | OpenSSH client and working noninteractive authentication |
| Shared local folder access for an SSH agent | Python 3 |
| Approved commands in a shared local folder | Bubblewrap (`bwrap`) and `timeout` |
| Inline audio/video | GStreamer 1.0, GstApp introspection, and suitable codec plugins |

## Install from source

Run the following from this repository’s root for a local **copy installation**:

```sh
gnome_assistant_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/gnome-assistant@faby02"
mkdir -p "$gnome_assistant_dir/schemas"
cp ./*.js ./*.py ./*.svg metadata.json stylesheet.css README.md LICENSE "$gnome_assistant_dir/"
cp -R docs nautilus "$gnome_assistant_dir/"
cp schemas/*.xml "$gnome_assistant_dir/schemas/"
glib-compile-schemas --strict "$gnome_assistant_dir/schemas"
```

Copy only the schema source and compile it in place, as above. A running GNOME
Shell reads the compiled schema file directly from disk; copying a compiled file
over it changes it underneath the Shell, which can then crash. Compiling writes
a new file and swaps it in, so updating while you are logged in is safe.

If your installed extension is already a symlink to a development checkout,
update that checkout and recompile its schemas instead of copying files onto
it. Disable the old `ai-search-assistant@lerosua` extension when upgrading.

Log out and back in so Shell discovers the extension, then enable it:

```sh
gnome-extensions enable gnome-assistant@faby02
gnome-extensions prefs gnome-assistant@faby02
```

After updating loaded JavaScript or schemas on Wayland, log out and back in
again to load the changes. Changing ordinary preferences does not require this.

## Connect an agent

1. Install the agent or ACP adapter on the host where it will run, and complete
   its authentication in a terminal.
2. In Preferences, on the **Agent** tab, choose an existing **Workspace folder** on this PC.
3. Under **ACP connections**, choose **New connection**, give it a name, and
   select **Local command** or **SSH**.
4. Enter the **ACP command and arguments** and select that connection. Changes
   save automatically. For SSH, also enter the host and an absolute remote workspace.

Examples of launch commands, when installed on the selected host:

| Agent | Command | Agent-side setup |
| --- | --- | --- |
| Codex adapter | `codex-acp` | [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) |
| Claude Agent adapter | `claude-agent-acp` | [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) |
| OpenCode | `opencode acp` | [OpenCode ACP documentation](https://opencode.ai/docs/cli/acp/) |
| Hermes | `hermes acp` | [Hermes ACP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) |

These are configuration examples, not bundled integrations or a guarantee of
identical capabilities. Other compatible stdio ACP agents can be configured too.
Use the agent’s current documentation for installation and authentication.

The command field is parsed as an executable and arguments, **not a shell script**.
Use an absolute executable path if GNOME’s environment cannot find the command.
For environment setup or shell initialization, provide a wrapper executable.

### SSH and local folder sharing

An SSH connection launches the configured command on the remote host. It uses
OpenSSH configuration, strict host-key checking, and batch mode. Verify the host
and sign in from a terminal first; GNOME Assistant cannot answer password prompts.
The remote account must allow reverse forwarding for the extension’s helper tools.

The agent’s workspace and ordinary filesystem tools run on the remote host.
The local Workspace folder does not automatically share files with that host.
Use **Share a local folder** in the chat header to grant access to a chosen folder
on this PC. Click it again to stop sharing.

The folder bridge offers listing and UTF-8 text reads, plus reviewed writes.
It rejects symlinks and paths outside the shared folder. Reads are limited to
256 KiB; proposed edits must fit the chat review limits. Writes check that the
file has not changed since its preview. These are separate from file attachments.

For SSH connections, **Allow local command requests** additionally enables
approval-gated commands on this PC. They run with a read-only shared folder,
no network, and a 30-second timeout through Bubblewrap. The agent’s own remote
commands continue to follow the agent’s permissions.

### Background connection and agent options

When the extension starts at login, it connects in the background and prepares
a session. It reuses the connection and reconnects after unexpected exits.
Changing connection or workspace prepares a fresh connection/session as needed.
The selected agent can remain running while the overview is closed.

The **Agent options** gear shows the agent’s advertised select settings using
standard GNOME Shell menu items. The same settings appear as GTK/libadwaita
controls under **Preferences › Agent › Agent configuration**. Model and thinking effort
appear when advertised; permission modes and other choices depend on the agent.

Selections are saved per connection, confirmed through ACP, and restored in new
chats. Model changes refresh dependent effort choices. Unsupported choices are
not invented, and rejected selections retain the confirmed value.

## Use the overview

Press **Super+X**, or click the search/assistant icon, to switch modes. The shortcut
can be changed in Preferences.

- The empty prompt matches GNOME’s search bar. Typing or adding a file expands
  it to a fixed wider layout; it grows up to seven text lines and then scrolls.
- Press **Enter** to send, **Shift+Enter** for a newline, and **Stop** to interrupt.
- The paperclip stays on the right. Attachments show names, sizes, and remove buttons.
- Type `$` at the start of the prompt to browse and filter commands advertised
  by the agent. `$command-name` is translated to the corresponding `/command-name`.
- Use **Chat**, **History**, and **New conversation** to navigate conversations.
- Select message text to copy it, or use its **Copy message** button. Sent text is read-only.
- Approvals appear below the response and disappear after **Allow once** or **Decline**.
  When the agent asks to edit files, the approval shows each change as a unified
  diff with a few lines of context; long diffs show their start until **Show all**.
  A change too large to compare cannot be allowed, as it cannot be reviewed.
- Code blocks have **Copy** and **Save as…** buttons; the save dialog suggests a
  name from the block's language, such as `snippet.py`.
- With an agent on this computer, file and folder paths in replies become links
  listed below the message: absolute paths, `~/` paths, and paths relative to the
  working folder, optionally with `:line` or `:line:column` (shown, but not passed
  to the app). Only paths that exist are linked. Files open in their default app
  and folders in the file manager; runnable files (programs, launchers, files
  marked executable) open their folder instead, so a click never runs them. A
  code block holding a single existing path gets an **Open** button. Paths from
  an agent on an SSH host refer to that machine and stay plain text.
- Opening external links, file links, or image sources closes the overview.

GNOME Assistant prioritizes native components and theme defaults: `St` and
`PopupMenu` in the overview, and GTK4/libadwaita in Preferences and file dialogs.
The overview cannot embed GTK widgets directly. Custom layout is still needed
for chat, Markdown, and A2UI content. System accents highlight primary actions,
selected tabs, your messages, and activity indicators; native controls retain
their own theme-defined selection and focus treatment.

### With the overview closed

Close the overview while a reply runs and keep working; the reply continues.

- A **top-bar indicator** appears while the assistant works: its icon while a
  reply runs, an accent-coloured background while an approval waits for you,
  and an accent-coloured icon (or a warning icon for an error) once a reply is
  ready, until you open the chat. Its menu opens the chat and stops a running
  reply. It is hidden when there is nothing to report, and can be turned off in
  Preferences (**General › With the Overview Closed**).
- A **notification** tells you when a reply finishes or fails while the chat is
  not on screen. It shows the first sentence of the reply as plain text;
  clicking it opens the overview on the chat. Nothing is shown while you are
  looking at the chat, or when you stop a reply yourself.
- An **approval** requested while the overview is closed is also a notification,
  with **Decline** and **Allow once**. Answering there or in the chat resolves
  the same request: the other one disappears. **Allow once** is offered only
  when the whole request fits in the notification; longer requests, such as
  file changes, are reviewed in the chat. On Shell versions without
  notification actions, the notification opens the chat.

Notifications go through GNOME's message tray, so Do Not Disturb and the
notification settings for GNOME Shell apply. They are not stored by the extension.

### Attach menu

The paperclip in the prompt opens a menu:

- **Attach file…** sends a file with your next message (see the limits below).
- **Attach area…** and **Attach window…** close the overview so you can pick
  part of the screen (see below); the picked image is attached and the
  assistant reopens with your typed prompt.
- **Attach desktop context** closes the overview, captures your desktop as
  described below, and reopens the assistant with the capture attached.
- **Reference a file…** and **Reference a folder…** (agents running on this
  computer only) send the path instead of the contents, so the agent reads the
  file itself or edits it in place. Nothing is uploaded.

You can also copy files or folders in Files (or any file manager) and paste
them into the prompt with Ctrl+V. They become references for agents on this
computer, and attachments for agents over SSH: folders are sent as one archive
(see below).
Pasting ordinary text works as usual.

### Attach an area or a window

**Attach area…** dims the screen: drag a rectangle (across monitors if you
like; its size is shown next to it) and release, or press **Enter**, to
attach it. **Attach window…** highlights the window under the pointer; click
to attach it. It captures the window's own content, even parts covered by
other windows, without the shadow around it. **Esc** or a right-click
cancels and brings the assistant back unchanged.

The picker is removed before anything is captured, so the image shows only
what you selected, at the screen's full resolution, downscaled like desktop
context screenshots (at most 1920 pixels per side). It becomes an ordinary
image chip named `area-HHMMSS.png` or after the window title, is kept in memory
only, and is sent with your next message to agents that accept images.

### Ask GNOME Assistant from Files

An optional Files extension adds **Ask GNOME Assistant** to the right-click
menu. Selected files and folders, or the folder you right-click in when nothing
is selected, are added to the chat the same way as pasted files: references for
an agent on this computer, attachments for an agent over SSH (folders as one
archive). Recent and Starred items resolve to the real file; Trash and
network locations are not offered.

Files only loads compiled extensions from its system folder, so install it once
with administrator rights. It needs a C compiler and the Files extension
headers (`libnautilus-extension` on Arch, `libnautilus-extension-dev` on Debian):

```sh
make -C nautilus && sudo make -C nautilus install && nautilus -q
```

Preferences (**General › Files**) shows whether it is installed and can copy this command. Run it
again after updating GNOME Assistant; `sudo make -C nautilus uninstall` removes
it. It talks to the GNOME Assistant extension over D-Bus, so it does nothing
while the extension is disabled, and tells you so.

Pickers use the desktop file chooser portal, which GNOME serves with the Files
picker (with your bookmarks, search and recent locations). If no portal is
running, a GTK picker is used instead. Pickers open as normal windows, so the
overview closes while one is open and returns afterwards with your typed prompt.

### Desktop context

Turn on **Desktop Context** in Preferences (**Context** tab) to get a second shortcut
(**Super+Shift+X** by default, changeable there). It takes a screenshot of
each monitor *before* the overview opens and records the workspaces, the open
windows and which one has focus (title, application, monitor, workspace,
position), the mouse position and the window under it, and the text you have
highlighted (the primary selection). It also infers
which project directories those windows belong to, from paths in window titles,
terminal shells and folder names in editor titles; the agent is told these are
guesses to verify. Recent events from the last five minutes are added too:
notifications and windows opened or closed (kept in memory only while this
part is enabled), plus crashes from systemd-coredump and error-level journal
messages. It then opens the assistant with a
**Desktop context** chip in the prompt bar. Your next message sends the
screenshots, the monitor layout and instructions telling the agent how to use
them. Remove the chip to send without it; press the shortcut again to replace
it with a fresh capture. Each part (screenshots, focused window, open windows
and workspaces, mouse position, selected text, project directories, recent events, application
logs, device status) has its
own switch under **Included Context**; the agent is told which parts are
included. Screenshots require an agent that accepts images. Screenshots may contain
private information and are sent to the connected agent.

To keep messages small, agents that support GNOME Assistant's MCP tools get a
compact snapshot: screenshots, the focused window, the windows on screen, the
pointer, and summaries of the rest (a selection preview, the focused project,
event counts). They fetch details only when needed with `desktop_get_windows`,
`desktop_get_selection`, `desktop_get_projects`, `desktop_get_recent_events`,
`desktop_get_app_logs` (journal logs of a captured window's application, found
by its desktop ID, process and per-application systemd unit, even after it
closed) and `desktop_get_device_status` (network, VPN, Wi-Fi, audio devices and
mute state, Bluetooth, battery, power profile, Do Not Disturb, keyboard layout),
and can take a fresh screenshot of a window from the snapshot with
`desktop_capture_window`, for example to check a page after changing code.
These tools answer only from the context you shared in that chat, and only for
the parts you enabled. Agents without MCP tools receive everything attached, including the focused
application's last 20 log lines and the device status.

Agents running on this computer can read some of this themselves, so by
default they are not sent device status, crashes, logged errors or application
logs. Instead they get the link they cannot work out themselves: each window's
process, desktop ID and systemd unit, with a ready `journalctl` command
(`desktop_get_window_process`), plus instructions naming the commands to use
(`nmcli`, `pactl`, `coredumpctl`, …). Agents over SSH always receive everything.
Turn off **Skip what a local agent can read itself** if your agent runs in a
sandbox that blocks these commands.

### Assistant name

**Preferences › General › Assistant › Name** changes what the assistant is called: the chat
header, the sender of its messages, the prompt placeholder (“Ask …”),
notifications, and the Files menu entry. The default is GNOME Assistant; names
are trimmed and limited to 40 characters, and the agent is told the name you
choose. The extension, its settings and the technical instructions the agent
reads keep the name GNOME Assistant. The Files extension reads the name from
the same setting; if you installed it before this setting existed, run its
install command again.

### Secrets and private windows

Before anything reaches the agent, GNOME Assistant looks for secrets: API keys
and tokens in well-known formats (OpenAI, Anthropic, GitHub, GitLab, Slack, AWS,
Google, Stripe, npm, PyPI, Hugging Face…), private keys, JSON web tokens,
passwords in URLs and `Authorization` headers, and `password=`/`api_key:` style
assignments whose values look real (code, types and placeholders such as
`changeme` are ignored). Each is replaced by a label such as `[redacted GitHub
token]`, which the agent is told it cannot recover.

- **What it collects for you** (selection, window titles, notifications, logs,
  and everything the agent fetches with its desktop tools) is redacted
  automatically.
- **What you type or attach** is checked when you send: a card lists what was
  found, with a safe preview, and offers **Redact and send**, **Send anyway** or
  **Cancel**. Redacting sends attached text files from a redacted copy (the file
  on disk is untouched) and leaves out files that exist to hold secrets, such as
  `.env`, SSH keys, `*.pem`/`*.key` or password databases.
- **Folders sent to an agent over SSH** leave such files out, along with `.ssh`,
  `.gnupg` and `.password-store`; the chip says how many.
- **Screenshots** (desktop context, attached areas and windows, and windows the
  agent captures) black out password managers and authenticator apps, apps you
  add under **Private apps**, and a notification banner on screen. A private
  app's window cannot be attached or captured at all. When Tesseract OCR is
  installed with English data (`tesseract`, `tesseract-data-eng`), text in
  screenshots that looks like a secret is blacked out too. OCR runs locally in
  the background while you type; it is a safety net, not a guarantee.

The **Shared** view lists everything that was redacted, left out or blacked out.
Turn it all off with **Preferences › Privacy › Secrets and Private Windows › Protect
secrets and private windows**.

### Ask about a window

Right-click a window's title bar (or press **Alt+Space**) and choose **Ask GNOME
Assistant** (with your chosen name), right after **Take Screenshot**. This works
for every app, including those with header bars. Or press **Super+Shift+W** for
the focused window (with the overview open, the most recently used window on
the current workspace). Change the shortcut, or turn both off, under
**Preferences › Context › Window Context**. A **Window context** chip is
attached and the assistant opens, with your draft kept, ready for the question.

The chip is a desktop context about that one window:

- **A screenshot** of the window's own content, cropped to it and complete even
  where other windows cover it.
- **Window details**: title, application name and ID, and its process ID and
  executable when known.
- **Its project folder** (with **Project directories** on), from a path in its
  title, a shell running in it, or its working directory. Editors that show
  only a folder name ("main.js — thesis — Code") are matched against folders
  known from other windows, or else searched for in the usual places (your home
  folder, `~/Projects`, `~/src`, `~/code`, `~/dev` and similar, one folder
  deep). That search counts only when exactly one project has that name.
- **Recent events of that application** (with **Recent events** on): its
  notifications, windows, crashes and logged errors from the last five minutes.
- **Its logs** (with **Application logs** on), offered through agent tools, or
  as a ready `journalctl` command for agents on this computer.

The screenshot and window details are always included, since they are what the
entry is for; the other parts follow **Preferences › Context › Included Context**, and
work even with the desktop context shortcut turned off. Windows of private apps
(see **Secrets and private windows**) do not offer the entry, and screenshot
and text protection apply. **Shared** shows exactly what was sent.

### Problem notifications

When something goes wrong, a notification offers to ask the assistant about it:

- **Crashes** of programs you use (with a window, or your own user services),
  from systemd-coredump, with the signal and the top of the stack trace.
- **Out-of-memory kills** by the kernel or systemd-oomd.
- **Failed services** (user or system), off by default as some fail harmlessly.

**Fix with GNOME Assistant** (or a click on the notification) opens a new
conversation with a question already written: what failed, when, the stack
trace and the program's recent log lines. It is not sent: review it, add
context, and press Enter. For an agent over SSH the question asks for an
explanation and steps instead of a fix, since the agent cannot reach this
computer. The details go through secret redaction first; a crashed process's
environment and command line, which can hold secrets, are never included.

Only new problems are reported, repeats of the same program are grouped for
five minutes, and **Don't show for …** mutes a program (undo it under
**Preferences › Notifications › Problem Notifications › Muted**). Helper processes without a
window are ignored unless **Background processes** is on. Do Not Disturb
applies. A crash of GNOME Shell itself cannot be reported this way.

## Instructions, skills, and delegation

**Assistant Instructions** supplies editable assistant context, and **Custom
Instructions** adds your personal preferences. The default prompt describes the
assistant’s role and working style; it does not prescribe an image-search or
image-generation preference. Use **Restore default prompt** to reset it.

Instructions are sent as ACP chat context. Their treatment depends on the agent;
they do not replace the agent’s own system configuration. Start a new chat after
changing instructions so earlier conversation context does not carry old guidance.

GNOME Assistant has no separate skill directory or special skill registration.
Configure skills in your agent. Advertised commands can be invoked through `$`;
a skill that is not advertised can still be available to the agent through its
own mechanisms. **Delegate automatically** adds a preference for independent
subtasks; actual subagent support and execution belong to the connected agent.
Context compaction is also handled by the agent.

## Attachments, images, and media

The agent can send files of any type, including documents, archives, images,
audio, and video. Completed attachments show a filename, size, and **Download**
button with a native Save As dialog. A path or link by itself does not transfer
file contents. Inline playback and image previews have separate format limits.

| Transfer or preview | Current limit |
| --- | --- |
| Streamed file from the agent, using HTTP MCP | 1 GiB per file; 2 simultaneous uploads |
| Inline text/base64 or ACP embedded-resource delivery | 8 MiB per file |
| File attached to your prompt, agent with HTTP MCP | 1 GiB per file; 2 simultaneous downloads |
| Folder sent to an agent over SSH, with HTTP MCP | 1 GiB and 100,000 items per folder |
| File attached to your prompt, other agents | 8 MiB per file; agent must accept the content type |
| Attachment count | 12 per prompt or agent reply |
| Inline PNG, JPEG, or WebP image preview | 8 MiB per image |
| HTTPS audio/video fetched for inline playback | 64 MiB; 30-second fetch timeout |

Transfers and downloads show progress and offer Cancel. Incomplete uploads are
removed on failure, cancellation, disconnection, or a 60-second idle timeout.
Downloads use a temporary copy before replacing the selected destination, so
cancellation preserves an existing file.

HTTP MCP agents receive `send_attachment` for small UTF-8/base64 files and
`attachment_upload` for streamed existing files. The latter returns an authenticated
endpoint; stream bytes with `Content-Length` and a percent-encoded `X-Gnome-Filename`,
for example using `curl --request POST --upload-file file`. Wait for completion
before ending the turn. This also works through the SSH connection. Without HTTP
MCP, standard ACP embedded resources can carry small files if the agent emits them.

Files you attach travel the other way with the same streaming. With an HTTP MCP
agent, images up to 8 MiB and text files up to 256 KiB are embedded in your
message, so the agent sees them at once. Larger and binary files are only
described in the message (name, size, type and an id); the agent streams them
to its disk with `attachment_download` when the request needs them, over the
SSH connection too, without loading them into its context. It is told to use a
new private temporary folder (`mktemp -d`), never to print whole files, and to
read large files with its own file tools, which page through them, or with
commands that limit their output.

Folders for an agent over SSH are sent the same way, as one uncompressed tar
archive written while the agent downloads it, so nothing is staged on disk.
GNU tar builds it when installed (about six times faster for folders with many
small files; the download is then chunked, without a known size); otherwise a
built-in writer does, with an exact size. The
whole folder is limited to 1 GiB and 100,000 items, checked when you attach it.
Symlinks are kept as links, never followed, so nothing outside the folder is
included; sockets, devices and unreadable folders are skipped and listed. Each
file is checked as it is sent: if one changed after you attached the folder,
the transfer stops and the agent asks you to attach it again. A file is read when
the agent downloads it, not when you attach it, and a file changed in between is
refused, so the agent always gets what you attached. The **Shared** view shows
which files were embedded or downloaded. Agents without HTTP MCP receive files
embedded in the message, up to 8 MiB.

Image search and generation are performed by the agent with its own tools.
The chat can preview public HTTPS images, regular image files inside the local
workspace, and transferred image attachments. An explicit local image-path request
can permit that image outside the workspace. Remote agent paths need a file
transfer before this PC can preview them. Public previews reject private addresses,
redirects, and unsupported formats. Click a preview to open its source.

A2UI audio/video players offer Play/Pause, Stop, seeking, volume, and playback time.
Playback starts on user interaction. Local media must be regular, non-symlink
files inside the workspace. Web sources must be public HTTPS media files;
streaming playlists are not supported. Missing codecs are reported inline.

## Interactive interfaces: A2UI

Start a request with `@a2ui` to ask explicitly for an interactive interface.
The agent may also choose one when useful. Interfaces render directly in the
overview using A2UI 1.0 and GNOME Assistant’s custom catalog,
`urn:gnome-assistant:a2ui:catalog:1`.

The catalog includes text, symbolic icons, images, layouts, cards, buttons, fields,
checkboxes, choices, tabs, dialogs, sliders, date/time inputs, and media players.
Bindings, list templates, validation, local calculations/actions, incremental
updates, renderer functions, and calls back to the agent are supported.

Agents with HTTP MCP use `get_a2ui_catalog` and `render_a2ui`; fenced `a2ui`
JSON/JSONL and ACP embedded resources are fallback delivery paths. Agent support
for these transports determines what can be displayed. The renderer accepts
declarative data, not arbitrary HTML, JavaScript, or custom styling. It is not
the complete standard A2UI basic catalog.

See the [A2UI reference](docs/A2UI.md) for components, helper functions, progressive
rendering, transport behavior, agent calls, media details, and limits.

## History and agent memory

**Save conversations** controls GNOME Assistant’s transcripts, interface snapshots,
and received attachment storage. It is enabled by default. The default locations are:

```text
~/.local/state/gnome-assistant/chat-history.jsonl
~/.local/state/gnome-assistant/history-meta.json
~/.local/state/gnome-assistant/attachments/
```

They follow `$XDG_STATE_HOME/gnome-assistant` when that variable is set.
**History → Resume** requires the original connection and workspace, plus agent
support for loading/resuming the session. History previews are read-only.

In **History**, the search entry filters conversations as you type, by title and
message text, ignoring case and accents; every word must match. Matches are
highlighted, with the matching part of a message shown under the title. **Escape**
clears the search. Hover or focus a conversation for its actions:

- **Pin** keeps it at the top of the list, newest pinned first.
- **More actions → Rename…** edits the title in place; **Enter** saves and
  **Escape** cancels. An empty title restores the automatic one, the first message.
- **More actions → Export…**, or **Export conversation** in an open conversation,
  saves it as Markdown where you choose: title, date, agent, and each turn under
  “You” or the assistant’s name. Attachments are listed by name, and interactive
  interfaces are noted rather than included.

Titles and pins are stored in `history-meta.json`, readable only by you, and are
never added to the transcript. They are only saved while **Save conversations** is on.
**Clear overview history** removes the extension’s transcripts, titles and pins,
and attachment cache; deleting a conversation also removes its title and pin.
Files already saved with Download remain at your chosen destinations.

With saving disabled, received attachments are temporary and are removed when
a new conversation starts or the extension is disabled. The connected agent still
manages its own memory and session storage, and may persist data independently.
Configure that behavior in the agent. GNOME Assistant has no separate long-term
memory database or global/workspace memory selector.

## Development and checks

Core checks, without a live model or API key:

```sh
node --test tests/test_acp_config.mjs tests/test_a2ui.mjs tests/test_assistant_status.mjs tests/test_reply_actions.mjs tests/test_secret_scanner.mjs tests/test_problem_rules.mjs
node tests/test_mode_visibility.js
node tests/test_desktop_context.js
node tests/test_screen_capture.js
gjs -m tests/test_attachments.js
gjs -m tests/test_desktop_tools.js
gjs -m tests/test_copied_files.js
gjs -m tests/test_attachment_delivery.js
gjs -m tests/test_folder_archive.js
gjs -m tests/test_history_store.js
GSETTINGS_BACKEND=memory gjs -m tests/test_settings_access.js
gjs -m tests/test_desktop_project.js
gjs -m tests/test_journal_follower.js
XDG_RUNTIME_DIR=$(mktemp -d) gjs -m tests/test_image_privacy.js
sh tests/test_files_extension.sh
env -u WAYLAND_DISPLAY -u DISPLAY dbus-run-session --config-file=tests/private-bus.conf -- gjs -m tests/test_file_portal.js
```

The native integration suite runs an isolated headless GNOME session with a local
ACP fixture. It covers Preferences, configuration, chat, approvals (including
file diffs), path links and code block actions, attachments, history search,
titles, pins and export, the window menu entry, A2UI, real overview typing,
the top-bar indicator and notifications with the overview closed, problem
notifications, secret review
and private windows in screenshots, and the area and window pickers (driven with a virtual pointer and keyboard, against a small
GTK test window). It needs headless GNOME Shell, a session bus,
GStreamer command-line tools/plugins (including VP8/WebM), and local socket access:

```sh
sh tests/test_a2ui_shell.sh
```

For transfer checks, including a 128 MiB upload/download, a 96 MiB attachment
download by the agent, byte integrity, bounded
memory use, cancellation, and incomplete-file cleanup, use Python 3.11+:

```sh
python3 tests/test_streamed_attachments.py
```

Native checks write their screenshots and logs to a printed temporary directory.
The old provider-specific `test_llm_flow.sh` and `test_streaming.js` scripts are
legacy diagnostics and do not test the current ACP integration.

## Upgrading from earlier versions

Preferences and legacy history are migrated when possible without replacing an
existing destination. Old dedicated-agent transcripts remain readable, but Resume
requires compatible ACP session information. The former standalone memory store,
widget-folder system, special skill registration, and canvas feature are no longer
part of the active interface. Selecting a workspace does not generate widget or
skill folders. Existing workspace files are not removed.
