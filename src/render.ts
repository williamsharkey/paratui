import { findMatchingCommands, type CommandSpec } from "./commands.js";
import { getFocusActions } from "./focus-actions.js";
import { calculateLayout, type ViewportSize } from "./layout.js";
import type { ActivityItem, AppState, FocusRegion } from "./types.js";

interface RenderRow {
  text: string;
  inverted?: boolean;
}

function pad(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const truncated = input.length > width ? input.slice(0, Math.max(0, width - 1)) + "…" : input;
  return truncated.padEnd(width, " ");
}

function repeat(char: string, width: number): string {
  return width > 0 ? char.repeat(width) : "";
}

function border(totalWidth: number): string {
  return `+${repeat("-", Math.max(0, totalWidth - 2))}+`;
}

function reverseVideo(input: string): string {
  if (!process.stdout.isTTY) {
    return input;
  }
  return `\x1b[7m${input}\x1b[0m`;
}

function renderRow(row: RenderRow, width: number): string {
  const padded = pad(row.text, width);
  return row.inverted ? reverseVideo(padded) : padded;
}

function normalizeRows(rows: RenderRow[], width: number, height: number): string[] {
  const rendered = rows.slice(0, height).map((row) => renderRow(row, width));
  while (rendered.length < height) {
    rendered.push(repeat(" ", width));
  }
  return rendered;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, count - 1));
}

function slashPath(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return "/";
  }
  const spaceIndex = trimmed.search(/\s/);
  return spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
}

function maskApiKey(input: string): string {
  if (!input) {
    return "";
  }
  if (input.length <= 8) {
    return "*".repeat(input.length);
  }
  return `${input.slice(0, 4)}${"*".repeat(Math.max(0, input.length - 8))}${input.slice(-4)}`;
}

function activityLine(item: ActivityItem): string {
  if (item.type === "tip") {
    return `$${item.amount ?? 0} tip by @${item.user_name || item.display_name || "user"}`;
  }
  const author = item.user_name || item.display_name || "user";
  return `@${author}: ${item.text || ""}`;
}

function socialLine(authorHandle: string, text: string): string {
  return `@${authorHandle}: ${text}`;
}

function personLabel(handle: string, displayName: string): string {
  return displayName && displayName !== handle ? `${displayName} @${handle}` : `@${handle}`;
}

function buildPeopleRows(state: AppState): RenderRow[] {
  if (!state.authUser) {
    const draft = state.authInput.active
      ? `key: ${maskApiKey(state.authInput.draft)}${state.authInput.draft ? "" : "█"}`
      : "key: (empty)";
    return [
      { text: "people" },
      { text: "" },
      { text: "not signed in" },
      { text: "" },
      { text: "up/down pick action" },
      { text: "enter/space invokes" },
      { text: "tab keeps auth focus" },
      { text: "" },
      { text: draft }
    ];
  }

  const rows: RenderRow[] = [{ text: "people" }, { text: "" }];
  for (let index = 0; index < state.people.items.length; index += 1) {
    const person = state.people.items[index]!;
    const marker = index === state.people.selectedIndex ? ">" : " ";
    const online = person.online ? "online" : "offline";
    rows.push({
      text: `${marker} ${personLabel(person.handle, person.displayName)} ${online}`,
      inverted: state.focus === "left" && index === state.people.selectedIndex
    });
  }
  if (state.social.rooms.length) {
    rows.push({ text: "" });
    rows.push({ text: "rooms" });
    for (const room of state.social.rooms.slice(0, 3)) {
      rows.push({ text: ` ${room.name}  ${room.messageCount}` });
    }
  }
  if (state.social.dms.length) {
    rows.push({ text: "" });
    rows.push({ text: "dm" });
    for (const dm of state.social.dms.slice(0, 3)) {
      rows.push({ text: ` ${personLabel(dm.handle, dm.displayName)} ${dm.online ? "online" : "offline"}` });
    }
  }
  if (state.realtime.connected) {
    rows.push({ text: "" });
    rows.push({ text: "live" });
    for (const peer of state.realtime.peers.slice(0, 3)) {
      rows.push({ text: ` @${peer.handle}  live` });
    }
  }
  return rows;
}

function buildCenterContentRows(state: AppState): RenderRow[] {
  if (!state.authUser) {
    const draft = state.authInput.active
      ? `key: ${maskApiKey(state.authInput.draft)}${state.authInput.draft ? "" : "█"}`
      : "key: (empty)";
    return [
      { text: "api key" },
      { text: "" },
      { text: "profile > api key" },
      { text: "or open browser help" },
      { text: "" },
      { text: draft },
      { text: state.authInput.active ? "enter saves  esc cancels" : "/auth/login or /auth/key/set" }
    ];
  }

  if (state.view === "settings") {
    return [
      { text: "settings" },
      { text: "" },
      { text: "space or enter toggles" },
      { text: "esc returns" }
    ];
  }

  if (state.view === "profile" && state.profile) {
    const profile = state.profile;
    const handle = profile.profile.user_name || "unknown";
    return [
      { text: `profile @${handle}` },
      { text: profile.profile.display_name || "" },
      { text: "" },
      { text: `creations: ${profile.stats.creations_published}` },
      { text: `followers: ${profile.stats.followers_count}` },
      { text: `likes: ${profile.stats.likes_received}` },
      { text: "" },
      { text: profile.profile.about || "(no bio)" },
      { text: "" },
      { text: "right opens creations" }
    ];
  }

  if (state.view === "dm") {
    return [
      { text: `dm @${state.social.dmHandle || "unknown"}` },
      { text: "" },
      { text: `messages: ${state.social.threadMessages.length}` },
      { text: "" },
      ...state.social.threadMessages.slice(-10).map((message) => ({ text: socialLine(message.authorHandle, message.text) })),
      { text: "" },
      { text: "/dm/send text=\"...\"" }
    ];
  }

  if (state.view === "room") {
    return [
      { text: `room ${state.social.roomName || "unknown"}` },
      { text: "" },
      { text: `messages: ${state.social.threadMessages.length}` },
      { text: "" },
      ...state.social.threadMessages.slice(-10).map((message) => ({ text: socialLine(message.authorHandle, message.text) })),
      { text: "" },
      { text: "/rooms/post text=\"...\"" }
    ];
  }

  if (state.view === "feed") {
    const current = state.feed.items[state.feed.currentIndex];
    if (!current) {
      return [{ text: "feed" }, { text: "" }, { text: "no feed items" }];
    }
    const asciiLines = state.feed.ascii ? state.feed.ascii.split("\n") : ["(loading ascii...)"];
    return [
      { text: "feed latest" },
      { text: `${current.title || "(untitled)"} by @${current.ownerHandle || "unknown"}` },
      { text: "" },
      ...asciiLines.map((line) => ({ text: line })),
      { text: "" },
      { text: current.description || "(no description)" },
      { text: "" },
      { text: "left/right browse" }
    ];
  }

  if (state.view === "live") {
    const peerHandles = state.realtime.peers.length
      ? state.realtime.peers.map((peer) => `@${peer.handle}`).join(" ")
      : "(no peers)";
    return [
      { text: `live ${state.realtime.room || "(offline)"}` },
      { text: state.realtime.connected ? "connected" : "offline" },
      { text: `peers: ${state.realtime.peers.length}  ice: ${state.realtime.iceServerCount}` },
      { text: peerHandles },
      { text: "" },
      ...state.realtime.messages.slice(-9).map((message) => {
        if (message.kind === "signal") {
          return { text: `[${message.signalType}] @${message.fromHandle || "system"} ${message.text}` };
        }
        if (message.kind === "system") {
          return { text: `[sys] ${message.text}` };
        }
        return { text: `${message.scope === "direct" ? "dm" : "room"} @${message.fromHandle || "system"}: ${message.text}` };
      }),
      { text: "" },
      { text: "/realtime/room/chat text=\"...\"" }
    ];
  }

  if (state.view === "creation") {
    const current = state.creations.items[state.creations.currentIndex];
    if (!current) {
      return [{ text: "creation" }, { text: "" }, { text: "no creations" }];
    }
    const asciiLines = state.creations.ascii ? state.creations.ascii.split("\n") : ["(loading ascii...)"];
    const commentLines = state.creations.activity.slice(0, 5).map((item) => ({ text: activityLine(item) }));
    return [
      { text: `art @${state.creations.ownerHandle || "unknown"}` },
      { text: current.title || "(untitled)" },
      { text: "" },
      ...asciiLines.map((line) => ({ text: line })),
      { text: "" },
      { text: `comments: ${state.creations.activity.length}` },
      ...commentLines
    ];
  }

  return [{ text: "profile" }, { text: "" }, { text: "select a person" }];
}

function buildActionFooterRows(state: AppState, focus: FocusRegion): RenderRow[] {
  if (focus === "settings") {
    const checked = state.config.audio.muted ? "x" : " ";
    return [
      { text: "" },
      { text: `[${checked}] mute menu sounds`, inverted: state.focus === "settings" }
    ];
  }

  const actions = getFocusActions(state, focus);
  if (!actions.length) {
    return [];
  }
  const selectedIndex = clampIndex(state.actions.selectedIndex, actions.length);
  return [
    { text: "" },
    ...actions.map((action, index) => ({
      text: action.label,
      inverted: state.focus === focus && index === selectedIndex
    }))
  ];
}

function buildCenterRows(state: AppState, width: number, height: number): string[] {
  const contentRows = buildCenterContentRows(state);
  const footerFocus: FocusRegion = !state.authUser || state.view === "login"
    ? "auth"
    : state.view === "settings"
      ? "settings"
      : "center";
  const footerRows = buildActionFooterRows(state, footerFocus);
  const contentHeight = Math.max(0, height - footerRows.length);
  return normalizeRows([
    ...contentRows.slice(0, contentHeight),
    ...footerRows
  ], width, height);
}

function buildStatusLine(state: AppState): string {
  if (state.slash.open) {
    return `slash> ${state.slash.input}`;
  }
  return state.status || "ready";
}

function buildSuggestionLine(state: AppState, commands: CommandSpec[], width: number): string {
  if (!state.slash.open) {
    return pad("compose / command", width);
  }
  const matches = findMatchingCommands(commands, slashPath(state.slash.input));
  if (!matches.length) {
    return pad("no matching commands", width);
  }

  const selectedIndex = clampIndex(state.slash.selectedIndex, matches.length);
  let visibleLength = 0;
  let output = "";

  for (let index = 0; index < matches.length; index += 1) {
    const token = matches[index]!.path;
    const separator = output ? "  " : "";
    const needed = separator.length + token.length;
    if (visibleLength + needed > width) {
      const ellipsisSeparator = output ? "  " : "";
      if (visibleLength + ellipsisSeparator.length + 3 <= width) {
        output += `${ellipsisSeparator}...`;
        visibleLength += ellipsisSeparator.length + 3;
      }
      break;
    }

    output += separator;
    output += index === selectedIndex ? reverseVideo(token) : token;
    visibleLength += needed;
  }

  return `${output}${repeat(" ", Math.max(0, width - visibleLength))}`;
}

function bodySlotChar(state: AppState, rowIndex: number): string {
  const slotLetters: Array<"A" | "B" | "C" | "D" | "E"> = ["A", "B", "C", "D", "E"];
  const slot = slotLetters[rowIndex];
  if (!slot) {
    return " ";
  }
  return state.slots[slot] ? slot : slot.toLowerCase();
}

function renderCompact(state: AppState, commands: CommandSpec[], viewport?: Partial<ViewportSize> | null): string {
  const layout = calculateLayout(viewport);
  const contentWidth = Math.max(8, layout.totalWidth - 4);
  const lines: string[] = [];
  lines.push(border(layout.totalWidth));
  lines.push(`| ${pad("paratui", contentWidth)} |`);
  lines.push(`| ${pad(`resize terminal: ${layout.viewport.columns}x${layout.viewport.rows}`, contentWidth)} |`);
  lines.push(`| ${pad(buildStatusLine(state), contentWidth)} |`);
  lines.push(`| ${buildSuggestionLine(state, commands, contentWidth)} |`);
  lines.push(border(layout.totalWidth));
  return lines.join("\n");
}

export function renderApp(
  state: AppState,
  commands: CommandSpec[],
  viewport?: Partial<ViewportSize> | null
): string {
  const layout = calculateLayout(viewport);

  if (layout.mode === "compact") {
    return renderCompact(state, commands, viewport);
  }

  const lines: string[] = [];

  lines.push(border(layout.totalWidth));
  lines.push(
    `| ${pad(`paratui  ${state.authUser ? `you:@${state.authUser.handle}` : "guest"}${state.authUser ? " online" : ""}${state.realtime.connected ? `  live:${state.realtime.room}` : ""}`, layout.totalWidth - 4)} |`
  );
  lines.push(border(layout.totalWidth));

  if (layout.mode === "columns") {
    const leftLines = normalizeRows(buildPeopleRows(state), layout.leftWidth, layout.bodyHeight);
    const centerLines = buildCenterRows(state, layout.centerWidth, layout.bodyHeight);

    for (let index = 0; index < layout.bodyHeight; index += 1) {
      lines.push(`|${leftLines[index]}|${centerLines[index]}${bodySlotChar(state, index)}|`);
    }
  } else {
    const separatorHeight = layout.bodyHeight > layout.topSectionHeight + layout.bottomSectionHeight ? 1 : 0;
    const peopleLines = normalizeRows(buildPeopleRows(state), layout.contentWidth, layout.topSectionHeight);
    const centerLines = buildCenterRows(state, layout.contentWidth, layout.bottomSectionHeight);
    let rowIndex = 0;

    for (const line of peopleLines) {
      lines.push(`|${line}${bodySlotChar(state, rowIndex)}|`);
      rowIndex += 1;
    }

    if (separatorHeight) {
      lines.push(`|${repeat("-", layout.contentWidth)}${bodySlotChar(state, rowIndex)}|`);
      rowIndex += 1;
    }

    for (const line of centerLines) {
      lines.push(`|${line}${bodySlotChar(state, rowIndex)}|`);
      rowIndex += 1;
    }

    while (rowIndex < layout.bodyHeight) {
      lines.push(`|${repeat(" ", layout.contentWidth)}${bodySlotChar(state, rowIndex)}|`);
      rowIndex += 1;
    }
  }

  lines.push(border(layout.totalWidth));
  lines.push(`| ${buildSuggestionLine(state, commands, layout.totalWidth - 4)} |`);
  lines.push(`| ${pad(buildStatusLine(state), layout.totalWidth - 4)} |`);
  lines.push(border(layout.totalWidth));

  return lines.join("\n");
}
