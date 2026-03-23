# paratui

Keyboard-native TUI for [parascene.com](https://parascene.com).

`paratui` lives directly in this repository root. Do not create a nested `paratui/` folder inside this repo.

## Install

### From Source

This works right now:

```bash
git clone https://github.com/williamsharkey/paratui.git
cd paratui
npm install
npm run build
npm link
paratui
```

Without linking globally:

```bash
./paratui
```

### From npm

This is the intended distribution channel for `paratui`.

```bash
npm install -g paratui
paratui
```

Or:

```bash
npx paratui
```

If npm install does not work yet, use the source install above.

## Quick Start

1. Launch `paratui`.
2. On first run, press `enter` to open the parascene API help page, or press `p` to paste a key you already generated.
3. Generate an API key in the browser from `Profile > API key`.
4. Paste the `psn_...` key into `paratui` and press `enter`.
5. Use the left sidebar to move between `Feed`, `Notifications`, `Settings`, people, and rooms.

## How To Use Paratui

### Main flow

- `up` / `down`: move through the sidebar or the current pane actions
- `left` / `right`: move through art/feed items, page people, or jump into creation browsing
- `tab`: move focus between sidebar and main pane
- `enter` / `space`: invoke the focused TUI button
- typing in a DM, room, or creation view starts the relevant composer immediately
- `esc`: back out of input or return from deeper views

### First-run auth

`paratui` uses parascene bearer API keys.

1. Sign into parascene in a normal browser session.
2. Open `Profile`.
3. Under `API key`, choose `Generate API key`.
4. Copy the key immediately. It is shown only once.
5. Paste it into `paratui`.

Saved config location:

- macOS: `~/Library/Application Support/paratui/config.json`
- Linux: `$XDG_CONFIG_HOME/paratui/config.json` or `~/.config/paratui/config.json`
- Windows: `%AppData%/paratui/config.json`

### Chat and browsing

- selecting a person opens the DM view
- selecting a room opens that room
- typing in a DM or room and pressing `enter` sends the message
- selecting a person and pressing `right` opens their creations
- `left` / `right` scroll through creations and feed items
- `space` can open preview/full-view actions when those TUI buttons are selected
- drag-and-drop or paste a local image path to upload and publish quickly while staying in chat

### Headless mode

You can also use `paratui` as a console image-generation client:

```bash
npx paratui --api-key 'psn_<your-secret>' --prompt 'orbital fungus' --title 'orbital fungus' --server mutations --method chain
```

### Development commands

```bash
npm test
npm run build
./paratui
```

## Local setup notes

- Repo root: `./`
- Reference clone: `../parascene-reference`
- The reference clone is a sibling checkout, not part of this repo, so it stays out of commits by default.
- Website source for `parasharkgod.com` lives in `./website/parasharkgod/`.
- The private deployment mirror repo is `../parasharkgod`.

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
- chosen shell direction is the social-first chat layout, not the balanced three-pane layout
- every meaningful user action should map to one stable command for UI, macros, and tests

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

Current v1 auth flow:

1. User signs into parascene in a normal browser session.
2. User opens Profile and generates an API key.
3. User copies the key once and pastes it into `paratui`.
4. `paratui` stores the bearer token in its canonical OS config JSON.
5. `paratui` calls the API with `Authorization: Bearer psn_<your-secret>`.
6. Sign-out in `paratui` only removes the saved local key. Key creation, rotation, and removal still happen in the browser.

First-run TUI flow:

- press `enter` to open the API help page
- generate a key in the browser from `Profile > API key`
- return to `paratui`, press `p`, paste the key, and press `enter`
- power-user path: `/auth/key/set psn_<your-secret>`

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

From the current API help and reference repo, `parascene` already has:

- browser-managed API key generation/removal
- bearer auth on `/api/...`
- `GET /api/profile`
- feed, explore, comments, likes, reactions, follows, user profiles, servers
- create/image routes under `/api/create...`

That means `paratui` can cover a meaningful slice of the product today. The missing work is mostly route-shape discovery for create/social flows, not auth issuance.

## Smallest useful upstream ask

The smallest good PR to `parascene` is no longer a CLI auth bridge. API keys already exist.

The next useful upstream ask is a **stable documented contract** for the routes `paratui` needs beyond auth:

- exact request/response bodies for `/api/create`
- stable people/discovery routes that support fast user lists
- official room/DM/chat routes, if chat is meant to live in parascene
- a durable bearer introspection shape for secondary services like realtime signaling

Requirements:

- keep `Authorization: Bearer psn_...`
- avoid forcing cookie reuse in CLI integrations
- keep route contracts stable enough for first-party terminal clients

With that, `paratui` can ship against the real API without guessing from the browser network panel.

## Upstream Notes

The latest upstream chat/realtime change review is tracked in:

- `docs/parascene-upstream-chat-realtime-2026-03-22.md`

That note separates:

- public documented chat API surface that `paratui` can rely on now
- newer repo-only realtime/browser features that still need an explicit supported contract before `paratui` should depend on them

## Realtime Freshness

`paratui` now prefers the official parascene Supabase Broadcast invalidation flow when the server exposes it, and falls back to the existing polling path when it does not.

- default behavior: auto-discover the logged-in web shell config, open a Supabase session bridge, and subscribe to inbox/thread invalidation
- authoritative data still comes from HTTP chat/profile/feed routes
- fallback remains active, so unsupported environments still work normally
- optional overrides:
  - `PARATUI_PARASCENE_REALTIME=0` disables official realtime and uses polling only
  - `PARATUI_SUPABASE_URL=...`
  - `PARATUI_SUPABASE_ANON_KEY=...`

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

Chosen shell: **social-first hacker messenger**.

Detailed interaction and macro spec:

- [docs/interaction-model.md](docs/interaction-model.md)

```text
+------------------------------------------------------------------+
| paratui           room:noir   you:@sharkgod online               |
+-------------------------+----------------------------+-----------+
| people / rooms / dm     | thread / room / creation              a|
|                         |                                       b|
| > @crosshj   online     | ascii image preview                   C|
|   @noirguy   offline    |                                       d|
|   room: noir            | messages / comments / reactions       E|
|   dm: crosshj           |                                        |
+-------------------------+----------------------------+-----------+
| command / compose:                                               |
+------------------------------------------------------------------+
```

## Build order

1. bootstrap a Node + TypeScript CLI with an npm `bin`
2. build the shared command registry and slash-command model
3. add the macro runner and macro-driven test harness
4. stand up Ink app shell and keyboard routing
5. add API-key paste flow plus single-file config loading/saving
6. add people list with online state, DM, and jump-to-creations actions
7. add fast image browser with prev/current/next preload and OS preview handoff
8. add prompt flow, slot letters on the border, and image upload
9. add settings view with space-toggle mute checkbox and lightweight UI prefs
10. add comments/reactions
11. add headless mode
12. add chat transport
