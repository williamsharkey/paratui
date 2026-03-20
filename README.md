# paratui

Keyboard-native TUI for [parascene.com](https://parascene.com).

`paratui` lives directly in this repository root. Do not create a nested `paratui/` folder inside this repo.

## Local setup notes

- Repo root: `./`
- Reference clone: `../parascene-reference`
- The reference clone is a sibling checkout, not part of this repo, so it stays out of commits by default.

## Product direction

`paratui` should feel like parascene for keyboard hackers:

- monochrome-first, using normal terminal foreground/background colors
- no emoji output; use plain-text equivalents like `:)`
- no noisy control-code-heavy styling that makes copied terminal output ugly
- fast keyboard navigation over prompts, people, servers, methods, comments, and reactions
- image slots live on the side border as tiny letter markers, not as a big dedicated panel
- slot letters `a` through `e` flip to `A` through `E` when assigned and can be reused in prompts
- people lists show online state, names, fast selection, DM entry, and jump-to-creations actions
- use short synthetic menu sounds for focus, select, back, and toggle actions: light, sharp, old-game feel
- sounds must be globally muteable from a settings view with a space-toggle checkbox
- headless mode for automation: `paratui --prompt "..." --server ...`
- drag-and-drop image upload in GUI terminals when supported, with file-path paste fallback
- image browsing should feel instant, with current, previous, and next ASCII renders preloaded

## Recommended stack

### Install and distribution

Best default: publish a Node CLI to npm with a `bin` entry.

Why:

- easiest cross-platform install path for a JavaScript/TypeScript TUI
- works on macOS, Linux, and Windows without custom packaging
- supports both `npm install -g paratui` and `npx paratui`
- stays aligned with the existing `parascene` JavaScript stack

Secondary channels can come later:

- Homebrew for macOS/Linux convenience
- Scoop for Windows convenience
- standalone binaries only if cold-start or Node dependency becomes a real problem

### TUI library

Best fit for `paratui`: **Ink**.

Why Ink over older terminal stacks:

- React model is a good fit for a multi-pane app with feed, comments, prompts, slots, and modal-like flows
- proven in large modern CLIs
- flexible layout system for dense terminal UIs
- easier testing and state management than lower-level string-painting libraries

Use lower-level terminal control only where Ink needs help:

- raw keyboard input
- mouse/drag events when terminals expose them
- image protocol detection
- exact cursor placement for custom ASCII image rendering

## Auth approach

Best v1 auth flow:

1. `paratui login` opens the browser.
2. User signs into parascene on the web and approves CLI access.
3. Browser exchanges that approval for a CLI bearer token.
4. `paratui` stores the bearer token in its canonical OS config JSON.
5. `paratui` calls the API with `Authorization: Bearer ...`.
6. `paratui` can refresh or revoke the token cleanly.

Avoid for the main design:

- scraping browser cookies
- asking users to paste session cookies into env files
- spreading app state across many config files

### Config storage

Keep config simple: one JSON file in the normal OS config location.

Canonical targets:

- macOS: `~/Library/Application Support/paratui/config.json`
- Linux: `$XDG_CONFIG_HOME/paratui/config.json` or `~/.config/paratui/config.json`
- Windows: `%AppData%/paratui/config.json`

This file should contain:

- bearer token
- active account summary
- mute-sound setting
- download/export directory
- preview behavior
- any lightweight UI preferences

Keep permissions tight where the OS allows it. If we harden later, the first likely upgrade path is moving the token to the keychain while preserving the same public config shape.

## What parascene already gives us

From the current reference repo, `parascene` already has:

- account signup/login/logout
- cookie-backed sessions
- `GET /me`
- image upload and image-edit flows
- comments, likes, reactions, follows, feed, explore, servers

That means `paratui` can probably cover a lot of product surface once bearer-token auth is added for CLI use.

## Smallest useful upstream ask

The smallest good PR to `parascene` is not full chat or full peer discovery.

It is a **first-party CLI auth bridge with bearer-token support**:

- `POST /api/cli/auth/start`
- `POST /api/cli/auth/exchange`
- `POST /api/cli/auth/refresh`
- `POST /api/cli/auth/revoke`
- `GET /api/cli/me`

Requirements:

- issued from an existing web session or a device/browser approval flow
- returns a scoped bearer token, not the website cookie
- supports revoke/sign-out
- identifies the user and exposes username/display name
- can be checked by API middleware on routes `paratui` needs

With just that, `paratui` can ship independently and still talk to parascene safely.

## Peer discovery and chat

Pure internet-scale peer discovery without any server support is not the right default.

Practical reality:

- LAN discovery can use mDNS or UDP broadcast
- internet P2P still needs rendezvous/signaling, and often relay fallback
- public rooms and reliable DMs usually want a server anyway

Recommended path:

- v1 chat uses a small relay service with parascene-backed identity
- optional later experiment with direct peer transport for friend-to-friend sessions
- do not block the core TUI on full P2P

If we want to avoid an upstream PR for chat, `paratui` can run its own relay and use parascene only for identity proof.

## Image handling

Planned image workflows:

- browse latest generated content
- render images inline as ASCII previews
- keep previous/current/next items warm in memory so scrolling feels immediate
- drop or paste local images to start mutation chains
- save generated images locally on demand
- open a real-image OS preview with `space`, then dismiss and return to the TUI
- reveal the saved file or containing folder when the platform preview path is unavailable
- name exports like `earthworm-jim-crosshj.jpg`
- embed prompt and generation metadata directly in PNG/JPEG metadata so future tools can recover it
- reference slot letters in prompts like `mutate A with C`

## Settings and sound

Settings should stay minimal and terminal-native.

- settings view includes a checkbox-like toggle for `mute sounds`
- `space` toggles the checkbox
- setting persists immediately to the single config JSON
- default sound set is synthetic, tiny, sharp, and unobtrusive
- sounds should be optional polish, never a source of lag

## Semantic ASCII rendering

There is room for something better than naive brightness-to-character mapping.

Promising direction:

- first pass: standard grayscale/edge ASCII renderer for speed
- second pass: model-assisted semantic remapping that chooses glyph clusters to preserve faces, silhouettes, text, and composition
- output must remain plain ASCII or box-drawing-friendly Unicode, depending on mode

This should be a pluggable renderer, not hardwired into the core app loop.

## Rough screen shape

```text
+------------------------------------------------------------------+
| paratui                         you: sharkgod   online            |
+----------------------+--------------------------+-----------------+
| people / feed        | image / post            a|                |
|                      |                          b|                |
| > @crosshj  online   | fast ascii preview      C|                |
|   @noirguy offline   |                          d|                |
|   room: noir         | comments / reactions    E|                |
|                      |                          |                |
+----------------------+--------------------------+-----------------+
| prompt: mutate C with E, gritty film noir, keep silhouette      |
+------------------------------------------------------------------+
```

## Build order

1. bootstrap a Node + TypeScript CLI with an npm `bin`
2. stand up Ink app shell and keyboard routing
3. add browser-assisted bearer-token auth plus single-file config loading/saving
4. add fast image browser with prev/current/next preload and OS preview handoff
5. add people list with online state, DM, and jump-to-creations actions
6. add prompt flow, slot letters on the border, and image upload
7. add settings view with space-toggle mute checkbox and lightweight UI prefs
8. add comments/reactions
9. add headless mode
10. add chat transport
