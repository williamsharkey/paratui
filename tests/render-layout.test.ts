import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandRegistry } from "../src/commands.js";
import { calculateLayout } from "../src/layout.js";
import { renderApp } from "../src/render.js";
import type { AppState } from "../src/types.js";

function createState(): AppState {
  return {
    view: "profile",
    focus: "left",
    status: "ready",
    config: {
      audio: {
        muted: false
      }
    },
    authInput: {
      active: false,
      draft: ""
    },
    authUser: {
      id: 1,
      email: "consumer@example.com",
      role: "user",
      handle: "sharkgod",
      displayName: "Shark God"
    },
    people: {
      items: [
        {
          id: 2,
          email: "creator@example.com",
          role: "user",
          handle: "crosshj",
          displayName: "crosshj",
          online: true,
          lastActiveAt: new Date().toISOString()
        },
        {
          id: 3,
          email: "noir@example.com",
          role: "user",
          handle: "noirguy",
          displayName: "noirguy",
          online: false,
          lastActiveAt: null
        }
      ],
      selectedIndex: 0,
      pageIndex: 0
    },
    profile: {
      user: {
        id: 2,
        role: "user",
        created_at: null
      },
      profile: {
        user_name: "crosshj",
        display_name: "crosshj",
        about: "renders tunnels"
      },
      stats: {
        creations_total: 12,
        creations_published: 8,
        likes_received: 42,
        followers_count: 11,
        member_since: null
      },
      is_self: false,
      viewer_follows: false,
      plan: "free"
    },
    creations: {
      ownerHandle: "crosshj",
      items: [],
      currentIndex: 0,
      activity: [],
      ascii: "",
      selectedCommentIndex: 0,
      commentScrollOffset: 0,
      selectionMode: "actions"
    },
    social: {
      threadId: null,
      dmHandle: null,
      roomName: null,
      threadPageIndex: 0,
      threadMessages: [],
      rooms: [],
      dms: []
    },
    feed: {
      items: [],
      currentIndex: 0,
      ascii: ""
    },
    notifications: {
      items: [],
      unreadCount: 3,
      selectedIndex: 0
    },
    loaded: {
      people: true,
      social: true,
      notifications: true,
      feed: true,
      thread: true,
      profile: true
    },
    realtime: {
      connected: false,
      room: null,
      selfPeerId: null,
      peers: [],
      messages: [],
      iceServerCount: 0,
      lastSignalType: null
    },
    settings: {
      selectedKey: "mute_sounds"
    },
    actions: {
      selectedIndex: 0
    },
    slash: {
      open: false,
      input: "/",
      selectedIndex: 0
    },
    composer: {
      active: false,
      kind: null,
      text: "",
      returnFocus: null
    },
    slots: {
      A: null,
      B: null,
      C: null,
      D: null,
      E: null
    },
    previewOpen: false,
    fullView: {
      open: false,
      ascii: ""
    },
    exports: {
      lastSavedPath: null
    }
  };
}

test("layout engine uses columns mode for wide terminals", () => {
  const layout = calculateLayout({ columns: 120, rows: 40 });
  assert.equal(layout.mode, "columns");
  assert.equal(layout.leftWidth + layout.centerWidth + 4, 120);
  assert.equal(layout.bodyHeight + 7, 40);
});

test("layout engine stacks panes on medium terminals", () => {
  const layout = calculateLayout({ columns: 60, rows: 24 });
  assert.equal(layout.mode, "stacked");
  assert.equal(layout.contentWidth + 3, 60);
  assert.equal(layout.topSectionHeight + layout.bottomSectionHeight + 1, layout.bodyHeight);
});

test("layout engine falls back to compact mode on tiny terminals", () => {
  const layout = calculateLayout({ columns: 36, rows: 10 });
  assert.equal(layout.mode, "compact");
  assert.ok(layout.contentWidth > 0);
});

test("rendered frames honor viewport width and height", () => {
  const state = createState();
  const commands = createCommandRegistry();
  const screen = renderApp(state, commands, { columns: 90, rows: 22 }).trimEnd();
  const lines = screen.split("\n");
  assert.equal(lines.length, 22);
  for (const line of lines) {
    assert.equal(line.length, 90);
  }
});

test("stacked layout still renders social shell cleanly", () => {
  const state = createState();
  const commands = createCommandRegistry();
  const screen = renderApp(state, commands, { columns: 60, rows: 20 });
  assert.match(screen, /Feed/);
  assert.match(screen, /Notifications \(3\)/);
  assert.match(screen, /profile @crosshj/);
});

test("multiline pane content stays inside the pane grid", () => {
  const state = createState();
  state.profile!.profile.about = "#tips\n@croskie";
  const commands = createCommandRegistry();
  const screen = renderApp(state, commands, { columns: 90, rows: 22 });
  const lines = screen.split("\n");
  for (const line of lines) {
    assert.equal(line.length, 90);
  }
  assert.match(screen, /#tips/);
  assert.match(screen, /@croskie/);
});

test("thread history paginates long wrapped conversations with a pager line", () => {
  const state = createState();
  state.view = "dm";
  state.loaded.thread = true;
  state.social.dmHandle = "crosshj";
  state.social.threadMessages = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    authorHandle: index % 2 === 0 ? "sharkgod" : "crosshj",
    authorDisplayName: index % 2 === 0 ? "Shark God" : "crosshj",
    text: `long message ${index + 1} `.repeat(6).trim(),
    createdAt: new Date().toISOString()
  }));
  const commands = createCommandRegistry();
  const screen = renderApp(state, commands, { columns: 90, rows: 18 });
  assert.match(screen, /history\[1\/\d+\]/);
  assert.match(screen, /right older/);
});
