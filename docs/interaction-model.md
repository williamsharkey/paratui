# Interaction Model

This document defines the chosen `paratui` layout and the shared command system that powers:

- keyboard interaction
- slash-menu navigation
- macro scripting
- feature testing

The rule is simple: every meaningful user action must resolve to one stable command.

## Chosen Layout

Chosen direction: **social-first hacker messenger**.

This is layout idea `3`, now treated as the default shell.

```text
+------------------------------------------------------------------+
| paratui           room:noir   you:@sharkgod online               |
+-------------------------+----------------------------+-----------+
| people / rooms / dm     | thread / room / creation               a|
|                         |                                         b|
| > @crosshj   online     | ascii image preview                    C|
|   @noirguy   offline    |                                         d|
|   room: noir            | messages / comments / reactions        E|
|   dm: crosshj           |                                         |
+-------------------------+----------------------------+-----------+
| command / compose:                                             |
+------------------------------------------------------------------+
```

## Pane Model

### Left pane

Primary navigation list.

It hosts:

- people
- rooms
- DMs
- feed shortcuts
- saved searches later, if needed

Each row should be compact and keyboard-first:

- handle or room name
- online/offline state when relevant
- optional unread marker

### Center pane

Active conversation or content pane.

Depending on context, it shows:

- room thread
- DM thread
- creation thread
- profile summary
- user creations list

Image posts render inline as ASCII. The current item owns a real-image preview target for `space`.

### Right border

Not a pane. Just slot markers.

- `a b c d e` when empty
- `A B C D E` when assigned
- letters sit on the right border line, not inside a large panel

### Bottom line

Shared command/composer area.

It serves two modes:

- text compose mode for DM, room, prompt, comment
- slash-command mode

## Focus Model

The UI must be fully usable in a "newbie complete" mode using only:

- arrow keys
- `enter`
- `space`
- `esc`

Recommended defaults:

- `tab` / `shift+tab`: cycle major focus regions
- `up` / `down`: move selection in current list or menu
- `left` / `right`: move across tabs, menu columns, or image sequences depending on context
- `enter`: activate selected row or confirm current command
- `space`: context action
- `esc`: cancel, close, back out, or blur input
- `/`: open slash menu

Context behavior for `space`:

- on a settings checkbox: toggle it
- on a creation/image row: toggle OS image preview
- on a selectable row: optional quick-select behavior where appropriate

Context behavior for `esc`:

- close slash menu
- close preview state
- blur composer
- leave edit mode
- back up one menu level

## Slash Menu

Slash opens a Lotus-style hierarchical command menu.

Users can drive it in two ways:

- arrows + `enter` + `esc`
- mnemonic letters and path narrowing

The slash menu is backed by the same command registry as macros and tests.

### Example top-level slash tree

```text
/
  People
    Open
    DM
    Profile
    Creations
    Follow
  Rooms
    Join
    Leave
    Post
    Members
  Art
    Next
    Previous
    Preview
    Save
    Assign Slot
    React
    Comment
  Prompt
    Compose
    Mutate
    Combine
    Send
  Settings
    Mute Sounds
    Export Directory
    Sign Out
```

### Slash menu requirements

- every entry maps to one stable command id
- every command path is scriptable
- commands can declare context requirements
- hidden commands are allowed, but only if they are genuinely internal

## Shared Action Registry

Every meaningful feature is registered once.

Suggested shape:

```ts
type CommandSpec = {
  id: string;
  path: string;
  title: string;
  description?: string;
  category: string;
  contexts: string[];
  args?: Array<{ name: string; required?: boolean }>;
  defaultKeys?: string[];
  run: (ctx: CommandContext, args: Record<string, unknown>) => Promise<void> | void;
};
```

### Command rules

- `id` is dot-style, for example `people.dm`
- `path` is slash-style, for example `/people/dm`
- `title` is user-facing
- keybindings dispatch commands; they do not bypass the command system
- slash menu dispatches commands; it does not bypass the command system
- macros dispatch commands; they do not bypass the command system

### Example commands

```text
people.open
people.dm
people.profile
people.creations
rooms.join
rooms.post
art.next
art.previous
art.preview.toggle
art.save
art.slot.assign
composer.focus
composer.send
settings.audio.mute.toggle
ui.cancel
ui.focus.next
ui.focus.prev
```

## Macro Language

Working name: **PTML** (`paratui` macro language).

Suggested file extension: `.ptm`.

Goals:

- easy to read
- easy to record later
- same verbs as slash commands
- stable enough for feature tests

### Design principles

- action lines look like slash commands
- control and test lines use `!`
- one statement per line
- comments start with `#`

### Grammar

```text
comment     = "#" text
action      = "/" path (WS arg)*
directive   = "!" name (WS arg)*
arg         = bare | key "=" value
value       = bare | quoted
```

Examples of valid action lines:

```text
/people/open @crosshj
/people/dm @crosshj
/art/next
/art/slot/assign slot=C source=current
/settings/audio/mute/toggle
```

Examples of valid directive lines:

```text
!assert focus=thread
!assert row.handle=@crosshj
!wait state=thread.ready timeout=1500
!sleep ms=50
```

## Macro Semantics

### Action lines

Action lines invoke registered commands directly.

Examples:

```text
/people/dm @crosshj
/composer/focus
/input/type text="hello from paratui"
/composer/send
```

### Directive lines

Directives are for tests and scripted control.

Initial directive set:

- `!assert`
- `!wait`
- `!sleep`
- `!capture`
- `!echo`

Suggested meanings:

- `!assert key=value`: verify current UI/application state
- `!wait ...`: wait for async state transition
- `!sleep ms=...`: deterministic delay when really necessary
- `!capture name=...`: save selected state for later debugging
- `!echo text="..."`: debug output for macro runs

## Macro Examples

### User macro: DM a person

```text
# dm-crosshj.ptm
/people/open @crosshj
/people/dm @crosshj
/input/type text="hey"
/composer/send
```

### User macro: browse art and save current image

```text
/art/next
/art/next
/art/preview/toggle
/art/save format=jpg
```

### Test macro: mute sounds in settings

```text
/settings/open
/settings/select mute_sounds
/settings/audio/mute/toggle
!assert settings.audio.muted=true
```

### Test macro: open profile and creations

```text
/people/open @crosshj
/people/profile @crosshj
!assert view=profile
/people/creations @crosshj
!assert view=creations
```

## Keyboard Mapping Strategy

Two layers should exist:

### High-level command tests

These verify the feature itself.

Example:

```text
/people/dm @crosshj
!assert view=dm
```

### Input mapping tests

These verify that raw keys trigger the right commands in the right contexts.

Example assertions:

- `slash` opens the slash menu
- `space` on a checkbox dispatches `settings.audio.mute.toggle`
- `space` on an art row dispatches `art.preview.toggle`
- `esc` dispatches `ui.cancel`

This split keeps feature tests stable even if keybindings evolve.

## Newbie Mode vs Power Mode

### Newbie mode

The user can succeed with:

- arrows
- `enter`
- `space`
- `esc`
- `/`

No memorized command paths required.

### Power mode

The user can:

- open slash menu and type narrow command paths quickly
- run saved `.ptm` macros
- bind favorite commands later
- reuse the same commands in headless mode

## Shipping Rule

No feature should ship unless it has all of the following:

- a command id
- a slash path
- a keyboard path or explicit reason not to have one
- at least one macro-based test
- clear context behavior for `enter`, `space`, and `esc` when relevant

## Build Implication

The command registry and macro runner should land early.

Recommended order:

1. command registry
2. slash menu
3. macro runner
4. macro-driven test harness
5. pane rendering on top of that
