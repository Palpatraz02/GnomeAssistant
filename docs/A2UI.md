# A2UI reference

[Back to the README](../README.md)

This reference describes GNOME Assistant’s implemented catalog and transports.
It is a custom native catalog, not the complete A2UI basic renderer.


Agents can display native interactive interfaces directly in overview chat using
[A2UI 1.0](https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md).
Start a message with `/a2ui` (or `$a2ui`) to request one explicitly. The agent can also choose
an interactive presentation when it helps answer your request.

The GNOME catalog (`urn:gnome-assistant:a2ui:catalog:1`) supports text, symbolic
icons, images, rows, columns, lists, cards, dividers, buttons, text fields,
checkboxes, choices, tabs, modal dialogs, sliders, date/time inputs, video, and
audio players. It supports data bindings, templated lists, incremental
updates, and user actions sent back to the same ACP conversation. Input changes
stay local until an agent action is submitted. Setting `sendDataModel: true` includes
the surface's current values with subsequent requests.

Agents can compose the catalog's reusable functions using nested `@call` objects:

| Purpose | Functions |
| --- | --- |
| Calculations and conversion | `add`, `subtract`, `multiply`, `divide`, `round`, `number` |
| Conditions | `compare`, `if`, `coalesce`, `and`, `or`, `not` |
| Text and formatting | `concat`, `formatString`, `formatNumber`, `formatCurrency`, `formatDate`, `pluralize` |
| Data and lists | `get`, `count`, `includes`, `map`, `filter`, `sort`, `slice` |
| Form validation | `required`, `numeric`, `length`, `regex`, `email` |
| Local actions | `setValue`, `sequence`, `openUrl` |

Computed text, visibility, enabled states, and `@checks` update when the data
changes. For example, this button increments a counter locally:

```json
{
  "id": "increment",
  "component": "Button",
  "child": "incrementLabel",
  "action": {
    "functionCall": {
      "@call": "setValue",
      "args": {
        "path": "/count",
        "value": {"@call": "add", "args": {"values": [{"@path": "/count"}, 1]}}
      }
    }
  }
}
```

This component needs a `Text` child with ID `incrementLabel`, and a numeric
`count` value in its surface's data model. Other components can bind to `/count`
or compute a label from it. `number` converts text-field input for calculations.
`concat` combines text and computed values. `formatString` supports standard
`${/path}` and `${function(named: arguments)}` interpolation, including nested
expressions and escaped `\${` literals. `formatDate` accepts the standard
`format` pattern, such as `yyyy-MM-dd` or `EEEE, d MMMM`, as well as the existing
Intl `dateStyle`/`timeStyle` options. Number, currency, date and plural formatting
support optional locale selection. The catalog implements every standard basic
helper name, while retaining the additional generic helpers above.

`regex` implements the A2UI portable dialect using a bounded, memoized matcher.
It rejects unsafe patterns, backreferences, lookbehind and unsupported escapes.
`email` checks syntax; it does not verify mailbox availability. `openUrl` requires
a local user action and opens HTTP(S), mailto or telephone links through the
desktop handler. It cannot run from passive bindings, checks or agent RPC.
`required` follows standard presence semantics: false, zero and whitespace are
present values. Use a boolean check to require a checkbox to be checked. Combine
`required` with `numeric` when a numeric field must also be nonempty. Standard
date patterns retain the wall-clock fields of an ISO timestamp unless an explicit
`timeZone` is supplied; the `ISO` pattern returns the normalized UTC timestamp.

Tabs are composed from native Shell buttons; dialogs use Shell’s modal dialog
component and support Close and Escape. These are not GTK/libadwaita widgets.
Sliders support discrete steps. Date/time entries commit with Enter, focus change,
or the native calendar, and enforce ISO values and range bounds. Choice lists can
be filtered locally. Standard icon names map to GNOME symbolic icons, and SVG
path icons are supported. Images accept standard size variants and fit modes.
Layout weights serve as native expansion hints.
Agents are instructed to include icons where they improve clarity, navigation,
scanning, or understanding of actions and status. Icons should have consistent
meaning, clear accompanying text when needed, and accessible labels for icon-only
controls.

Audio/video players are embedded in overview chat with Play/Pause, Stop, seek,
volume and playback time. Playback starts only on user interaction. They use
GStreamer 1.0 and GstApp introspection; available codecs depend on installed
GStreamer plugins. Missing playback support is reported inline. Local sources
must be regular files inside the workspace without symlinks. Web sources must
be public HTTPS files; they are downloaded with a 64 MiB limit and a 30-second
timeout, without redirects. Streaming playlists are not supported. Temporary files are removed when playback is
disposed. Video frames are bounded to 640×360 and displayed within the chat.

`setValue` writes only to the current surface, and `sequence` runs local steps in
order. Both require a user action and cannot run from passive bindings, validation,
or agent-initiated calls. `map` and `filter` evaluate pure item expressions:
relative paths read the item, absolute paths read the surface, and `@index`
returns the item's position. Store a filtered/sorted result with `setValue` to
update a template list. Inputs show failed `@checks` inline; invalid buttons are
disabled. Local state is saved with chat history, without adding chat messages,
when **Save conversations** is enabled.

Agents with HTTP MCP support receive a compact quick start from
`get_a2ui_catalog({})`. It is agent documentation, not a replacement A2UI
catalog or message format. Request only missing details with
`get_a2ui_catalog({components:["Tabs"], functions:["openUrl"], topics:["actions"]})`;
the complete formal catalog remains available unchanged with
`get_a2ui_catalog({format:"schema"})`. Session instructions record which
reference sections have already been delivered and encourage reuse; agents may
refetch details if context compaction removed them. A fresh session resets this
record.

Agents are instructed to render a small useful interface early, then use
standard `updateComponents` and `updateDataModel` messages as verified data
arrives. This avoids waiting to generate an entire component tree. The compact
guide includes an example, while standard schema validation and catalog identity
remain unchanged. Data lookup and model generation can still take time.

Agents are explicitly instructed to prefer `render_a2ui` for messages and same-turn
function results. Each ACP prompt also carries a connection-specific delivery
hint. Chat fences/resources remain a fallback if the MCP transport is unavailable;
validation errors do not trigger replay through another path. Other agents receive a
compact reference covering all supported components/functions in chat instructions,
instead of repeating the complete JSON Schema, and can emit fenced `a2ui` JSON or
JSONL. Separately closed fences display progressively. Embedded ACP resources
with MIME type `application/a2ui+json` work too. ACP capability metadata advertises
the catalog; the extension bridges A2UI actions into ACP prompt messages.

This is a custom native catalog, rather than the complete A2UI basic catalog.
Agents can invoke its pure functions with `callRendererFunction`, including an
explicit catalog ID and a unique `functionCallId`. The response contains the
matching ID and either a value or an error. MCP returns these responses in the
`render_a2ui` tool result's `responses` array. Fenced/resource requests receive
responses in a following ACP prompt after the current turn ends. Automatic
continuations are limited to four rounds, each with a 45-second response timeout,
and can be cancelled with Stop.

Interfaces can also call the agent directly. A non-system function name that has
no local implementation is routed through A2UI `callAgentFunction`, with resolved
arguments, the surface's catalog ID, and a unique request ID. The agent performs
the requested operation using its normal tools and returns `agentFunctionResponse`
with the matching ID and exactly one of `value` or `error`. The same function call
syntax works inside calculated values, checks, choice lists, and button actions;
local functions such as `get`, `if`, and `concat` can compose its returned value.
No function-specific native code or registration is required.

For example, a component's text can use the result of an agent operation:

```json
{
  "@call": "get",
  "args": {
    "value": {"@call": "lookupAvailability", "args": {"item": {"@path": "/item"}}},
    "path": "/summary"
  }
}
```

Here the agent must return an object with a `summary` field. A check instead
expects a boolean or `{"valid": true/false, "message": "..."}`. A choice list
expects up to 32 `{"label": "...", "value": "..."}` options. Agents return an
`UNKNOWN_FUNCTION` or `INVALID_FUNCTION_CALL` error when an operation is unclear
or its arguments are invalid.

Passive queries are read-only, debounced for 250 ms, shared by identical resolved
arguments within a surface, and cached until their arguments change or their
cache entry is evicted. Fields show loading feedback, and pending checks disable
submission. Button calls are fresh on every click. An asynchronous `sequence`
resumes after a result without replaying completed writes. Queries use background
ACP prompts after the current turn finishes, and do not add chat messages or
replace the original response. Form input remains available during background
queries. Side effects require a user action and the agent's ordinary permissions;
approval prompts continue to appear in chat.

Outstanding calls time out after 45 seconds and can be cancelled with Stop.
Malformed, missing, duplicate, and late responses are handled without automatic
retry loops. Surface removal, changed controls, reordered list items, and chat
changes invalidate pending actions. At most 16 requests are pending at once, and
the function cache holds at most 128 entries. Settled reactive results are saved
in client-owned history metadata within the existing size limits. History shows
cached results without contacting the agent; uncached values require resuming
the chat. Normal agent messages cannot seed this client-owned cache.

Arbitrary executable code and custom styling remain unavailable. Local functions
cannot read files or network data; `openUrl` is an explicit user-activated desktop action. Expression depth, evaluation
steps, and list sizes are bounded to keep the shell responsive. A failed binding
shows an inline error while sibling components remain usable. Invalid structural
batches are rejected together; valid batches preceding a function call take
effect before it executes. Saved history includes interface snapshots; previews are read
only, and resuming a supported session restores the latest interactive state.
