# AGENTS.md

## Repo boundary

- This repository root is `/Users/william/Desktop/paratui`.
- Keep all first-party project files here.
- Do not create an extra inner `paratui/` folder.
- Website source for `parasharkgod.com` lives here under `website/parasharkgod/`.
- The private deploy mirror repo is `williamsharkey/parasharkgod`.
- Keep the website files in sync between this repo and the private deploy repo.

## Reference code

- Use `/Users/william/Desktop/parascene-reference` as a read-only sibling reference checkout.
- Do not vendor or copy large chunks of `parascene` into this repo without an explicit reason.
- If upstream support is needed, prefer a small targeted PR to `parascene` over duplicating backend logic here.

## Product constraints

- Default to black-and-white or terminal-default colors.
- Avoid heavy ANSI styling that pollutes copied output.
- No emoji in UI output; use ASCII equivalents.
- Keyboard-first before mouse-first.
- Use short synthetic UI sounds with a restrained retro-game feel.
- Sounds must be easy to mute from inside the TUI.
- Preserve the image slot model: `A` through `E`.
- Keep slot letters tiny and on the side border, not in a large dedicated column.
- Show people by name with online/offline state and fast keyboard actions.
- Headless mode must remain a first-class target, not an afterthought.

## Technical direction

- Prefer Node.js + TypeScript.
- Prefer Ink for the main TUI renderer unless there is a strong measured reason to replace it.
- Build around a shared command registry before building feature-specific UI flows.
- Keep transport and rendering layers separate so headless and interactive modes share core logic.
- Treat semantic ASCII rendering as a pluggable subsystem.
- Optimize image browsing for preload and cache locality; previous/current/next should be ready before the user asks.
- Support real-image handoff to the host OS preview tool without breaking TUI focus flow.
- Export saved images with stable slugged filenames and embedded generation metadata.
- Keep app persistence simple: one canonical JSON config file per OS user profile.

## Command And Macro Expectations

- Every meaningful user action must have one stable command id.
- Slash menu entries, keybindings, macros, and tests should resolve through the same command registry.
- Prefer slash paths like `/people/dm` and ids like `people.dm`.
- Feature tests should be macro-driven by default.
- Raw key tests should verify key-to-command mapping separately from feature behavior.
- New features should define `enter`, `space`, and `esc` behavior when applicable.

## Auth expectations

- Do not store website session cookies as the long-term auth mechanism.
- Prefer the browser-generated API key flow documented by parascene.
- API calls should use `Authorization: Bearer`.
- Store the bearer token in the same single config JSON as the rest of app state unless requirements change later.
- Support explicit local sign-out and account switching.

## Config expectations

- Use one `config.json` in the canonical OS config directory.
- Keep the schema small and obvious.
- Save settings immediately after user changes when practical.
- Include at least auth token, mute-sounds, and export path state.

## Collaboration rules

- Keep docs and code aligned when major decisions change.
- Favor small reversible steps.
- When proposing upstream `parascene` changes, ask for the smallest surface that unlocks `paratui`.
- Treat `website/parasharkgod/` in this repo as the editable source copy, then mirror it into the private deploy repo before publishing site changes.
