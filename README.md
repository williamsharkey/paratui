# paratui

Keyboard-native TUI for [parascene.com](https://parascene.com).

`paratui` lets you browse the feed, open DMs, join rooms, comment on creations, generate images, and share uploads without leaving the terminal.

Longer design and product notes live in [VISION.md](VISION.md).

## Install

### npm

```bash
npm install -g paratui
paratui
```

Or run the latest published version without installing globally:

```bash
npx paratui
```

### From source

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

## First Run

`paratui` uses a parascene API key.

1. Sign into parascene in a normal browser session.
2. Open `Profile`.
3. Under `API key`, choose `Generate API key`.
4. Copy the `psn_...` key immediately.
5. Launch `paratui`.
6. Press `enter` to open the API help page, or press `p` to paste the key directly into the TUI.

## Basic Controls

- `up` / `down`: move through the sidebar or the active pane
- `left` / `right`: move through feed/art items, switch people pages, or page long DM/room history when available
- `tab`: switch focus
- `enter` / `space`: activate the selected TUI button
- typing in a DM, room, or comment context starts input immediately
- `esc`: cancel input or back out

## Using Paratui

### Sidebar

The left sidebar is the main navigation surface:

- `Feed`
- `Notifications`
- `Settings`
- `Exit`
- followed users
- joined rooms

Moving to a person opens that DM view. Moving to a room opens that room.

### DMs and rooms

- Select a person to open a DM.
- Select a room to open that room.
- Start typing to compose a message.
- Press `enter` to send.
- If the visible history is longer than the current terminal height, `left` and `right` page through history.

### Feed and creations

- `Feed` opens the latest public feed.
- `left` / `right` move between feed items and creation items.
- Select `Open Creations` on a person or DM view to browse that user’s creations.
- In creation view you can preview, save, comment, and open a full-screen ASCII view.

### Upload and share

While in a DM or room:

- drag and drop an image file path into the terminal, or paste a local image path
- `paratui` uploads it, publishes it, copies the public share URL, and keeps you in the current conversation

## Headless Mode

You can also use `paratui` as a console generation client:

```bash
paratui --api-key 'psn_<your-secret>' --prompt 'orbital fungus' --title 'orbital fungus' --server mutations --method chain
```

## Config

Saved config file:

- macOS: `~/Library/Application Support/paratui/config.json`
- Linux: `$XDG_CONFIG_HOME/paratui/config.json` or `~/.config/paratui/config.json`
- Windows: `%AppData%/paratui/config.json`

This stores your saved bearer token, mute setting, export path, and lightweight UI state.

## Development

```bash
npm run build
npm test
./paratui
```
