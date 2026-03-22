import type { ParsedCommand } from "./types.js";
import type { ParatuiApp } from "./app.js";

export interface CommandSpec {
  id: string;
  path: string;
  title: string;
  order?: number;
  run: (app: ParatuiApp, command: ParsedCommand) => Promise<void>;
}

export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && i + 1 < line.length) {
        current += line[i + 1]!;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseCommandText(line: string): ParsedCommand {
  const tokens = tokenizeCommand(line.trim());
  if (!tokens.length) {
    throw new Error("Empty command");
  }

  const [path, ...rest] = tokens;
  if (!path.startsWith("/")) {
    throw new Error(`Invalid command path: ${path}`);
  }

  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const token of rest) {
    const eqIndex = token.indexOf("=");
    if (eqIndex > 0) {
      const key = token.slice(0, eqIndex);
      const value = token.slice(eqIndex + 1);
      named[key] = value;
    } else {
      positional.push(token);
    }
  }

  return {
    path,
    positional,
    named
  };
}

function firstHandle(command: ParsedCommand, app: ParatuiApp): string | null {
  const raw = command.positional[0] || command.named.handle || "";
  if (!raw) {
    return app.currentSelectedHandle();
  }
  return raw.replace(/^@/, "");
}

export function createCommandRegistry(): CommandSpec[] {
  return [
    {
      id: "auth.login",
      path: "/auth/login",
      title: "Login",
      order: 10,
      run: async (app, command) => {
        const token = command.named.token || command.positional[0] || "";
        if (token.startsWith("psn_")) {
          await app.setApiKey(token);
          return;
        }
        app.startApiKeyEntry(token);
      }
    },
    {
      id: "auth.key.set",
      path: "/auth/key/set",
      title: "Set API Key",
      order: 11,
      run: async (app, command) => {
        const token = command.named.token || command.positional[0] || "";
        if (!token) {
          throw new Error("Usage: /auth/key/set psn_<your-secret>");
        }
        await app.setApiKey(token);
      }
    },
    {
      id: "auth.key.open",
      path: "/auth/key/open",
      title: "Open API Key Help",
      order: 12,
      run: async (app) => {
        await app.openApiKeyHelp();
      }
    },
    {
      id: "auth.key.paste",
      path: "/auth/key/paste",
      title: "Paste API Key",
      order: 13,
      run: async (app) => {
        app.startApiKeyEntry();
      }
    },
    {
      id: "auth.logout",
      path: "/auth/logout",
      title: "Forget API Key",
      order: 14,
      run: async (app) => {
        await app.logout();
      }
    },
    {
      id: "people.refresh",
      path: "/people/list/refresh",
      title: "Refresh People",
      order: 25,
      run: async (app) => {
        await app.refreshPeople();
      }
    },
    {
      id: "people.open",
      path: "/people/open",
      title: "Open Person",
      order: 21,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        if (!handle) {
          throw new Error("No person selected");
        }
        app.selectHandle(handle);
      }
    },
    {
      id: "people.profile",
      path: "/people/profile",
      title: "Open Profile",
      order: 22,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        if (!handle) {
          throw new Error("No person selected");
        }
        await app.openProfile(handle);
      }
    },
    {
      id: "people.creations",
      path: "/people/creations",
      title: "Open Creations",
      order: 23,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        if (!handle) {
          throw new Error("No person selected");
        }
        await app.openCreations(handle);
      }
    },
    {
      id: "people.dm",
      path: "/people/dm",
      title: "Open DM",
      order: 24,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        if (!handle) {
          throw new Error("No person selected");
        }
        await app.openDm(handle);
      }
    },
    {
      id: "dm.send",
      path: "/dm/send",
      title: "Send DM",
      order: 40,
      run: async (app, command) => {
        const text = command.named.text || command.positional.join(" ");
        if (!text.trim()) {
          throw new Error("Usage: /dm/send text=\"hello\"");
        }
        await app.sendDm(text.trim());
      }
    },
    {
      id: "media.upload",
      path: "/media/upload",
      title: "Upload Image",
      order: 45,
      run: async (app, command) => {
        const rawPath = command.named.path || command.positional.join(" ");
        if (!rawPath.trim()) {
          throw new Error("Usage: /media/upload path=/absolute/path/to/image.png");
        }
        const handled = await app.shareImageInput(rawPath.trim());
        if (!handled) {
          throw new Error("Image path not found");
        }
      }
    },
    {
      id: "rooms.open",
      path: "/rooms/open",
      title: "Open Room",
      order: 30,
      run: async (app, command) => {
        const room = command.named.room || command.positional[0] || "";
        if (!room.trim()) {
          throw new Error("Usage: /rooms/open noir");
        }
        await app.openRoom(room.trim());
      }
    },
    {
      id: "rooms.join",
      path: "/rooms/join",
      title: "Join Room",
      order: 30,
      run: async (app, command) => {
        const room = command.named.room || command.positional[0] || "";
        if (!room.trim()) {
          throw new Error("Usage: /rooms/join testroom");
        }
        await app.openRoom(room.trim());
      }
    },
    {
      id: "rooms.post",
      path: "/rooms/post",
      title: "Post Room Message",
      order: 31,
      run: async (app, command) => {
        const text = command.named.text || command.positional.join(" ");
        if (!text.trim()) {
          throw new Error("Usage: /rooms/post text=\"hello\"");
        }
        await app.postRoomMessage(text.trim());
      }
    },
    {
      id: "rooms.send",
      path: "/rooms/send",
      title: "Send Room Message",
      order: 31,
      run: async (app, command) => {
        const text = command.named.text || command.positional.join(" ");
        if (!text.trim()) {
          throw new Error("Usage: /rooms/send text=\"hello\"");
        }
        await app.postRoomMessage(text.trim());
      }
    },
    {
      id: "feed.open",
      path: "/feed/open",
      title: "Open Feed",
      order: 50,
      run: async (app) => {
        await app.openFeed();
      }
    },
    {
      id: "feed.next",
      path: "/feed/next",
      title: "Next Feed Item",
      order: 51,
      run: async (app) => {
        await app.nextFeed();
      }
    },
    {
      id: "feed.previous",
      path: "/feed/previous",
      title: "Previous Feed Item",
      order: 52,
      run: async (app) => {
        await app.previousFeed();
      }
    },
    {
      id: "art.next",
      path: "/art/next",
      title: "Next Art",
      order: 60,
      run: async (app) => {
        await app.nextCreation();
      }
    },
    {
      id: "art.previous",
      path: "/art/previous",
      title: "Previous Art",
      order: 61,
      run: async (app) => {
        await app.previousCreation();
      }
    },
    {
      id: "art.preview.toggle",
      path: "/art/preview/toggle",
      title: "Toggle Preview",
      order: 62,
      run: async (app) => {
        await app.togglePreview();
      }
    },
    {
      id: "art.slot.assign",
      path: "/art/slot/assign",
      title: "Assign Slot",
      order: 64,
      run: async (app, command) => {
        const slot = (command.named.slot || command.positional[0] || "").toUpperCase();
        if (!["A", "B", "C", "D", "E"].includes(slot)) {
          throw new Error("Usage: /art/slot/assign slot=C");
        }
        app.assignCurrentCreationToSlot(slot as "A" | "B" | "C" | "D" | "E");
      }
    },
    {
      id: "art.save",
      path: "/art/save",
      title: "Save Art",
      order: 63,
      run: async (app, command) => {
        const format = command.named.format || command.positional[0] || "png";
        await app.saveCurrentArt(format);
      }
    },
    {
      id: "art.open",
      path: "/art/open",
      title: "Open Saved Art",
      order: 64,
      run: async (app) => {
        await app.openSavedArt();
      }
    },
    {
      id: "art.open.folder",
      path: "/art/open-folder",
      title: "Open Saved Art Folder",
      order: 65,
      run: async (app) => {
        await app.openSavedArtFolder();
      }
    },
    {
      id: "comment.add",
      path: "/comment/add",
      title: "Add Comment",
      order: 80,
      run: async (app, command) => {
        const text = command.named.text || command.positional.join(" ");
        if (!text.trim()) {
          throw new Error("Usage: /comment/add text=\"hello\"");
        }
        await app.addComment(text.trim());
      }
    },
    {
      id: "comment.react",
      path: "/comment/react",
      title: "React To Comment",
      order: 81,
      run: async (app, command) => {
        const emoji = command.named.emoji || command.positional[0] || "";
        const indexValue = command.named.index || command.positional[1] || "0";
        const index = Number(indexValue);
        if (!emoji) {
          throw new Error("Usage: /comment/react emoji=thumbsUp index=0");
        }
        await app.reactToComment(emoji, Number.isFinite(index) ? index : 0);
      }
    },
    {
      id: "prompt.send",
      path: "/prompt/send",
      title: "Generate Prompt",
      order: 70,
      run: async (app, command) => {
        const prompt = command.named.prompt || command.positional.join(" ");
        if (!prompt.trim()) {
          throw new Error("Usage: /prompt/send prompt=\"...\"");
        }
        await app.generatePrompt({
          prompt: prompt.trim(),
          title: command.named.title || null,
          server: command.named.server || null,
          method: command.named.method || null,
          share: command.named.share !== "false"
        });
      }
    },
    {
      id: "settings.open",
      path: "/settings/open",
      title: "Open Settings",
      order: 90,
      run: async (app) => {
        app.openSettings();
      }
    },
    {
      id: "settings.select",
      path: "/settings/select",
      title: "Select Setting",
      order: 91,
      run: async (app, command) => {
        const key = command.named.key || command.positional[0] || "";
        if (key !== "mute_sounds") {
          throw new Error("Only mute_sounds is supported right now");
        }
        app.openSettings();
      }
    },
    {
      id: "settings.audio.mute.toggle",
      path: "/settings/audio/mute/toggle",
      title: "Toggle Mute",
      order: 92,
      run: async (app) => {
        await app.toggleMute();
      }
    },
    {
      id: "realtime.open",
      path: "/realtime/open",
      title: "Open Live View",
      order: 100,
      run: async (app) => {
        app.openRealtime();
      }
    },
    {
      id: "realtime.connect",
      path: "/realtime/connect",
      title: "Connect Live Realtime",
      order: 101,
      run: async (app, command) => {
        const room = command.named.room || command.positional[0] || "lobby";
        await app.connectRealtime(room);
      }
    },
    {
      id: "realtime.disconnect",
      path: "/realtime/disconnect",
      title: "Disconnect Live Realtime",
      order: 102,
      run: async (app) => {
        await app.disconnectRealtime();
      }
    },
    {
      id: "realtime.room.join",
      path: "/realtime/room/join",
      title: "Join Live Room",
      order: 103,
      run: async (app, command) => {
        const room = command.named.room || command.positional[0] || "";
        if (!room.trim()) {
          throw new Error("Usage: /realtime/room/join noir");
        }
        await app.joinRealtimeRoom(room.trim());
      }
    },
    {
      id: "realtime.room.chat",
      path: "/realtime/room/chat",
      title: "Send Live Room Message",
      order: 104,
      run: async (app, command) => {
        const text = command.named.text || command.positional.join(" ");
        if (!text.trim()) {
          throw new Error("Usage: /realtime/room/chat text=\"hello\"");
        }
        await app.sendRealtimeRoomChat(text.trim());
      }
    },
    {
      id: "realtime.dm.send",
      path: "/realtime/dm/send",
      title: "Send Live Direct Message",
      order: 105,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        const text = command.named.text || command.positional.slice(handle ? 1 : 0).join(" ");
        if (!handle || !text.trim()) {
          throw new Error("Usage: /realtime/dm/send @crosshj text=\"hello\"");
        }
        await app.sendRealtimeDirect(handle, text.trim());
      }
    },
    {
      id: "realtime.signal.send",
      path: "/realtime/signal/send",
      title: "Send Live Signal",
      order: 106,
      run: async (app, command) => {
        const handle = firstHandle(command, app);
        const signalType = (command.named.type || command.positional[1] || "") as "offer" | "answer" | "candidate";
        const payload = command.named.payload || command.positional.slice(handle ? 2 : 1).join(" ");
        if (!handle || !["offer", "answer", "candidate"].includes(signalType) || !payload.trim()) {
          throw new Error("Usage: /realtime/signal/send @crosshj type=offer payload=\"...\"");
        }
        await app.sendRealtimeSignal(handle, signalType, payload.trim(), command.named.call || null);
      }
    },
    {
      id: "slash.open",
      path: "/slash/open",
      title: "Open Slash",
      order: 110,
      run: async (app) => {
        app.openSlash();
      }
    },
    {
      id: "ui.cancel",
      path: "/ui/cancel",
      title: "Cancel",
      order: 111,
      run: async (app) => {
        await app.cancel();
      }
    }
  ];
}

export function findMatchingCommands(registry: CommandSpec[], input: string): CommandSpec[] {
  const normalized = input.trim().toLowerCase();
  const sorted = [...registry].sort((left, right) => {
    const leftOrder = left.order ?? 999;
    const rightOrder = right.order ?? 999;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.path.localeCompare(right.path);
  });
  if (!normalized || normalized === "/") {
    return sorted.slice(0, 8);
  }
  return sorted.filter((command) => command.path.toLowerCase().startsWith(normalized)).slice(0, 8);
}

export function longestCommonCommandPrefix(commands: CommandSpec[]): string {
  if (!commands.length) {
    return "/";
  }
  let prefix = commands[0]!.path;
  for (let index = 1; index < commands.length; index += 1) {
    const path = commands[index]!.path;
    let cursor = 0;
    while (cursor < prefix.length && cursor < path.length && prefix[cursor] === path[cursor]) {
      cursor += 1;
    }
    prefix = prefix.slice(0, cursor);
    if (!prefix) {
      return "/";
    }
  }
  return prefix;
}
