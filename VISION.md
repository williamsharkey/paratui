# VISION.md

## Repo notes

- `paratui` lives directly at this repository root.
- Website source for `parasharkgod.com` lives under `website/parasharkgod/`.
- The private deployment mirror repo is `williamsharkey/parasharkgod`.

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
- chosen shell direction is the social-first chat layout
- every meaningful user action should map to one stable command for UI, macros, and tests

## Recommended stack

### Install and distribution

Default distribution is a Node CLI published to npm with a `bin` entry.

Why:

- easiest cross-platform install path for a JavaScript/TypeScript TUI
- works on macOS, Linux, and Windows without custom packaging
- supports both `npm install -g paratui` and `npx paratui`
- stays aligned with the existing `parascene` JavaScript stack

Secondary channels can come later:

- Homebrew
- Scoop
- standalone binaries if cold-start or Node dependency becomes a real problem

### TUI library

Best fit for `paratui`: **Ink**.

Why:

- React-style state and layout fit a multi-pane terminal app
- proven in modern CLIs
- easier testing and state management than lower-level hand-rolled rendering stacks

Use lower-level terminal control only where needed for:

- raw keyboard input
- drag/drop support
- image protocol detection
- exact cursor placement for custom ASCII image rendering

## Auth approach

Current auth flow:

1. User signs into parascene in a normal browser session.
2. User opens Profile and generates an API key.
3. User copies the key once and pastes it into `paratui`.
4. `paratui` stores the bearer token in its canonical OS config JSON.
5. `paratui` calls the API with `Authorization: Bearer psn_<your-secret>`.
6. Sign-out in `paratui` only removes the saved local key.

Avoid:

- scraping browser cookies
- asking users to paste session cookies
- scattering app state across multiple config files

## Config storage

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
- lightweight UI preferences

## What parascene already gives us

From the current API help and reference repo, `parascene` already has:

- browser-managed API key generation/removal
- bearer auth on `/api/...`
- `GET /api/profile`
- feed, explore, comments, likes, reactions, follows, user profiles, servers
- create/image routes under `/api/create...`

That means `paratui` can cover a meaningful slice of the product today.

## Smallest useful upstream ask

The next useful upstream ask is a stable documented contract for the routes `paratui` needs beyond auth:

- exact request/response bodies for `/api/create`
- stable people/discovery routes that support fast user lists
- official room/DM/chat routes
- a durable bearer introspection shape for secondary services like realtime signaling

Requirements:

- keep `Authorization: Bearer psn_...`
- avoid forcing cookie reuse in CLI integrations
- keep route contracts stable enough for first-party terminal clients

## Upstream notes

The latest upstream chat/realtime change review is tracked in:

- `docs/parascene-upstream-chat-realtime-2026-03-22.md`

That note separates:

- public documented chat API surface that `paratui` can rely on now
- newer repo-only realtime/browser features that still need an explicit supported contract before `paratui` should depend on them

## Realtime freshness

`paratui` prefers the official parascene Supabase Broadcast invalidation flow when the server exposes it, and falls back to polling when it does not.
