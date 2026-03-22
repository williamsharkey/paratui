import type { CommandSpec } from "./commands.js";
import { sanitizeTextForTui } from "./emoji.js";
import { getFocusActions } from "./focus-actions.js";
import { getLeftNavEntries } from "./left-nav.js";
import { calculateLayout, type ViewportSize } from "./layout.js";
import type { ActivityItem, AppState, FocusRegion } from "./types.js";

interface RenderRow {
  text: string;
  inverted?: boolean;
}

const FRAME = {
  horizontal: "─",
  vertical: "│",
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  leftTee: "├",
  rightTee: "┤",
  topTee: "┬",
  bottomTee: "┴",
  cross: "┼"
} as const;

function pad(input: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const safeInput = sanitizeTextForTui(input);
  const truncated = safeInput.length > width ? safeInput.slice(0, Math.max(0, width - 1)) + "…" : safeInput;
  return truncated.padEnd(width, " ");
}

function repeat(char: string, width: number): string {
  return width > 0 ? char.repeat(width) : "";
}

function frameLine(
  totalWidth: number,
  kind: "top" | "middle" | "bottom",
  dividerOffsets: number[] = []
): string {
  const innerWidth = Math.max(0, totalWidth - 2);
  const chars: string[] = Array.from({ length: innerWidth }, () => FRAME.horizontal);

  for (const offset of dividerOffsets) {
    const index = offset - 1;
    if (index < 0 || index >= chars.length) {
      continue;
    }
    chars[index] = kind === "top"
      ? FRAME.topTee
      : kind === "bottom"
        ? FRAME.bottomTee
        : FRAME.cross;
  }

  if (kind === "top") {
    return `${FRAME.topLeft}${chars.join("")}${FRAME.topRight}`;
  }
  if (kind === "bottom") {
    return `${FRAME.bottomLeft}${chars.join("")}${FRAME.bottomRight}`;
  }
  return `${FRAME.leftTee}${chars.join("")}${FRAME.rightTee}`;
}

function topBorder(totalWidth: number, dividerOffsets: number[] = []): string {
  return frameLine(totalWidth, "top", dividerOffsets);
}

function middleBorder(totalWidth: number, dividerOffsets: number[] = []): string {
  return frameLine(totalWidth, "middle", dividerOffsets);
}

function bottomBorder(totalWidth: number, dividerOffsets: number[] = []): string {
  return frameLine(totalWidth, "bottom", dividerOffsets);
}

function framedLine(content: string): string {
  return `${FRAME.vertical}${content}${FRAME.vertical}`;
}

function renderFullView(state: AppState, viewport?: Partial<ViewportSize> | null): string {
  const layout = calculateLayout(viewport);
  const totalWidth = layout.totalWidth;
  const totalHeight = layout.totalHeight;
  const asciiLines = (state.fullView.ascii || "(loading full view...)").split("\n");
  const artWidth = asciiLines.reduce((max, line) => Math.max(max, sanitizeTextForTui(line).length), 0);
  const verticalPad = Math.max(0, Math.floor((totalHeight - asciiLines.length) / 2));
  const horizontalPad = Math.max(0, Math.floor((totalWidth - artWidth) / 2));
  const lines: string[] = [];

  for (let index = 0; index < verticalPad; index += 1) {
    lines.push(repeat(" ", totalWidth));
  }

  for (const rawLine of asciiLines.slice(0, totalHeight)) {
    const line = sanitizeTextForTui(rawLine);
    const centered = `${repeat(" ", horizontalPad)}${line}`;
    lines.push(pad(centered, totalWidth));
  }

  while (lines.length < totalHeight) {
    lines.push(repeat(" ", totalWidth));
  }

  return lines.slice(0, totalHeight).join("\n");
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
  const expanded = wrapRows(expandRows(rows), width);
  const rendered = expanded.slice(0, height).map((row) => renderRow(row, width));
  while (rendered.length < height) {
    rendered.push(repeat(" ", width));
  }
  return rendered;
}

function expandRows(rows: RenderRow[]): RenderRow[] {
  const expanded: RenderRow[] = [];
  for (const row of rows) {
    const parts = row.text
      .replace(/\r/g, "")
      .replace(/\t/g, "  ")
      .split("\n");
    for (const part of parts) {
      expanded.push({
        text: part,
        inverted: row.inverted
      });
    }
  }
  return expanded;
}

function wrapRows(rows: RenderRow[], width: number): RenderRow[] {
  if (width <= 0) {
    return [];
  }

  const wrapped: RenderRow[] = [];
  for (const row of rows) {
    if (!row.text) {
      wrapped.push(row);
      continue;
    }

    let remaining = row.text;
    while (remaining.length > width) {
      wrapped.push({
        text: remaining.slice(0, width),
        inverted: row.inverted
      });
      remaining = remaining.slice(width);
    }
    wrapped.push({
      text: remaining,
      inverted: row.inverted
    });
  }
  return wrapped;
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, count - 1));
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

function buildPositionBar(index: number, count: number, width: number): string {
  const barWidth = Math.max(3, width);
  const chars: string[] = Array.from({ length: barWidth }, () => FRAME.horizontal);
  if (!count || count <= 1) {
    chars[0] = FRAME.cross;
    return chars.join("");
  }
  const markerIndex = Math.max(0, Math.min(
    barWidth - 1,
    Math.round((clampIndex(index, count) / Math.max(1, count - 1)) * (barWidth - 1))
  ));
  chars[markerIndex] = FRAME.cross;
  return chars.join("");
}

function buildHeaderContext(state: AppState): string | null {
  if (!state.authUser) {
    return null;
  }

  if (state.view === "creation") {
    const current = state.creations.items[state.creations.currentIndex];
    if (!current) {
      return null;
    }
    const owner = state.creations.ownerHandle || "unknown";
    const title = current.title || "(untitled)";
    return `art @${owner} - ${title}`;
  }

  if (state.view === "feed") {
    const current = state.feed.items[state.feed.currentIndex];
    if (!current) {
      return "feed";
    }
    const owner = current.ownerHandle || "unknown";
    const title = current.title || "(untitled)";
    return `feed @${owner} - ${title}`;
  }

  if (state.view === "room" && state.social.roomName) {
    return `room #${state.social.roomName}`;
  }

  if (state.view === "dm" && state.social.dmHandle) {
    return `dm @${state.social.dmHandle}`;
  }

  if (state.view === "profile" && state.profile?.profile.user_name) {
    return `profile @${state.profile.profile.user_name}`;
  }

  if (state.view === "settings") {
    return "settings";
  }

  if (state.view === "notifications") {
    return state.notifications.unreadCount
      ? `notifications ${state.notifications.unreadCount} unread`
      : "notifications";
  }

  if (state.view === "live") {
    return `live ${state.realtime.room || "(offline)"}`;
  }

  return null;
}

function roomParticipantLine(state: AppState): string {
  const handles = Array.from(new Set(
    state.social.threadMessages
      .map((message) => message.authorHandle)
      .filter(Boolean)
  ));
  return handles.length ? `users: ${handles.map((handle) => `@${handle}`).join(" ")}` : "users: (no messages yet)";
}

function buildSidebarRows(state: AppState): RenderRow[] {
  if (!state.authUser) {
    const draft = state.authInput.active
      ? `key: ${maskApiKey(state.authInput.draft)}${state.authInput.draft ? "" : "█"}`
      : "key: (empty)";
    return [
      { text: "not signed in" },
      { text: "" },
      { text: "enter opens help" },
      { text: "p pastes key" },
      { text: "" },
      { text: draft }
    ];
  }

  const entries = getLeftNavEntries(state);
  const rows: RenderRow[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const previous = index > 0 ? entries[index - 1] : null;
    const movedIntoPeople = entry.kind === "person" && previous && previous.kind !== "person";
    const movedIntoRooms = (entry.kind === "room" || entry.kind === "new-room")
      && previous
      && previous.kind !== "room"
      && previous.kind !== "new-room";
    if ((movedIntoPeople || movedIntoRooms) && rows[rows.length - 1]?.text !== "") {
      rows.push({ text: "" });
    }

    let text = "";
    if (entry.kind === "feed") {
      text = "Feed";
    } else if (entry.kind === "notifications") {
      text = entry.unreadCount ? `Notifications (${entry.unreadCount})` : "Notifications";
    } else if (entry.kind === "settings") {
      text = "Settings";
    } else if (entry.kind === "person" && entry.handle) {
      text = `@${entry.handle}${entry.online ? " [on]" : ""}`;
    } else if (entry.kind === "people_page") {
      text = `people[${(entry.pageIndex || 0) + 1}/${entry.pageCount || 1}]`;
    } else if (entry.kind === "room" && entry.roomName) {
      text = entry.roomName;
    } else if (entry.kind === "new-room") {
      text = "+ room";
    }

    rows.push({
      text,
      inverted: state.focus === "left" && index === state.people.selectedIndex
    });
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
      { text: state.authInput.active ? "enter saves  esc cancels" : "tab moves  enter opens" }
    ];
  }

  if (state.composer.active && state.composer.kind === "room_join") {
    return [
      { text: "join room" },
      { text: "" },
      { text: `room: ${state.composer.text}${state.composer.text ? "" : "█"}` },
      { text: "" },
      { text: "enter joins  esc cancels" }
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

  if (state.view === "notifications") {
    if (!state.notifications.items.length) {
      return [
        { text: "notifications" },
        { text: "" },
        { text: "no notifications" }
      ];
    }

    const visibleCount = 10;
    const selectedIndex = clampIndex(state.notifications.selectedIndex, state.notifications.items.length);
    const start = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(visibleCount / 2),
        Math.max(0, state.notifications.items.length - visibleCount)
      )
    );
    const items = state.notifications.items.slice(start, start + visibleCount);
    return [
      ...items.map((item, index) => ({
        text: `${item.acknowledged_at ? " " : "*"} ${item.title}${item.message ? ` - ${item.message}` : ""}`,
        inverted: state.focus === "center" && start + index === selectedIndex
      }))
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
    const messageRows = state.social.threadMessages.length
      ? state.social.threadMessages.slice(-10).map((message) => ({ text: socialLine(message.authorHandle, message.text) }))
      : [{ text: "(no messages yet)" }];
    return [
      ...messageRows
    ];
  }

  if (state.view === "room") {
    const messageRows = state.social.threadMessages.length
      ? state.social.threadMessages.slice(-10).map((message) => ({ text: socialLine(message.authorHandle, message.text) }))
      : [{ text: "(no messages yet)" }];
    return [
      { text: roomParticipantLine(state) },
      { text: "" },
      ...messageRows
    ];
  }

  if (state.view === "feed") {
    const current = state.feed.items[state.feed.currentIndex];
    if (!current) {
      return [{ text: "feed" }, { text: "" }, { text: "no feed items" }];
    }
    const asciiLines = state.feed.ascii ? state.feed.ascii.split("\n") : ["(loading ascii...)"];
    return [
      ...asciiLines.map((line) => ({ text: line })),
      { text: buildPositionBar(state.feed.currentIndex, state.feed.items.length, Math.max(12, asciiLines[0]?.length || 12)) },
      { text: "" },
      { text: current.description || "(no description)" },
      { text: "" }
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
    const visibleComments = state.creations.activity
      .slice(state.creations.commentScrollOffset, state.creations.commentScrollOffset + 4)
      .map((item, index) => ({
        text: activityLine(item),
        inverted: state.focus === "center"
          && state.creations.selectionMode === "comments"
          && state.creations.commentScrollOffset + index === state.creations.selectedCommentIndex
      }));
    return [
      ...asciiLines.map((line) => ({ text: line })),
      { text: buildPositionBar(state.creations.currentIndex, state.creations.items.length, Math.max(12, asciiLines[0]?.length || 12)) },
      ...(visibleComments.length ? [{ text: "" }, ...visibleComments] : [])
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

  if (state.view === "creation" && state.composer.active && state.composer.kind === "comment") {
    return [
      { text: "" },
      { text: `comment: ${state.composer.text}${state.composer.text ? "" : "█"}`, inverted: true },
      { text: "enter sends  esc cancels" }
    ];
  }

  if ((state.view === "room" || state.view === "dm") && state.composer.active) {
    const label = state.view === "room" ? "chat" : "dm";
    return [
      { text: "" },
      { text: `${label}: ${state.composer.text}${state.composer.text ? "" : "█"}`, inverted: true },
      { text: "enter sends  esc cancels" }
    ];
  }

  if (focus === "center" && state.composer.active && state.composer.kind === "room_join") {
    return [];
  }

  const actions = getFocusActions(state, focus);
  if (!actions.length) {
    return [];
  }
  const selectedIndex = clampIndex(state.actions.selectedIndex, actions.length);
  const actionsActive = !(focus === "center" && state.view === "creation" && state.creations.selectionMode === "comments");
  return [
    { text: "" },
    ...actions.map((action, index) => ({
      text: action.label,
      inverted: state.focus === focus && actionsActive && index === selectedIndex
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
  return state.status || "ready";
}

function buildSuggestionLine(state: AppState, _commands: CommandSpec[], width: number): string {
  let hint = "up/down browses  type sends in dm/room/comment  tab switches focus  esc backs out";
  if (!state.authUser) {
    hint = "p pastes api key  enter opens help";
  } else if (state.composer.active) {
    hint = "type text  enter sends  esc cancels";
  } else if (state.view === "creation") {
    hint = "left/right art  up/down moves comments and buttons  type adds a comment";
  } else if (state.view === "notifications") {
    hint = "up/down selects notifications  enter marks read  tab switches focus";
  } else if (state.view === "room") {
    hint = "type to chat  enter sends  tab switches focus";
  } else if (state.view === "dm") {
    hint = "type to dm  enter sends  tab switches focus";
  } else if (state.focus === "left") {
    hint = "up/down changes view  type sends in the active view";
  }
  return pad(hint, width);
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
  lines.push(topBorder(layout.totalWidth));
  lines.push(framedLine(` ${pad("paratui", contentWidth)} `));
  lines.push(framedLine(` ${pad(`resize terminal: ${layout.viewport.columns}x${layout.viewport.rows}`, contentWidth)} `));
  lines.push(framedLine(` ${pad(buildStatusLine(state), contentWidth)} `));
  lines.push(framedLine(` ${buildSuggestionLine(state, commands, contentWidth)} `));
  lines.push(bottomBorder(layout.totalWidth));
  return lines.join("\n");
}

export function renderApp(
  state: AppState,
  commands: CommandSpec[],
  viewport?: Partial<ViewportSize> | null
): string {
  if (state.fullView.open) {
    return renderFullView(state, viewport);
  }

  const layout = calculateLayout(viewport);

  if (layout.mode === "compact") {
    return renderCompact(state, commands, viewport);
  }

  const lines: string[] = [];
  const columnDivider = layout.mode === "columns" ? [layout.leftWidth + 1] : [];

  lines.push(topBorder(layout.totalWidth));
  const headerParts = [
    `paratui  ${state.authUser ? `you:@${state.authUser.handle} online` : "guest"}${state.realtime.connected ? `  live:${state.realtime.room}` : ""}`
  ];
  const headerContext = buildHeaderContext(state);
  if (headerContext) {
    headerParts.push(headerContext);
  }
  lines.push(framedLine(` ${pad(headerParts.join(" - "), layout.totalWidth - 4)} `));
  lines.push(middleBorder(layout.totalWidth, columnDivider));

  if (layout.mode === "columns") {
    const leftLines = normalizeRows(buildSidebarRows(state), layout.leftWidth, layout.bodyHeight);
    const centerLines = buildCenterRows(state, layout.centerWidth, layout.bodyHeight);

    for (let index = 0; index < layout.bodyHeight; index += 1) {
      lines.push(
        `${FRAME.vertical}${leftLines[index]}${FRAME.vertical}${centerLines[index]}${bodySlotChar(state, index)}${FRAME.vertical}`
      );
    }
  } else {
    const separatorHeight = layout.bodyHeight > layout.topSectionHeight + layout.bottomSectionHeight ? 1 : 0;
    const peopleLines = normalizeRows(buildSidebarRows(state), layout.contentWidth, layout.topSectionHeight);
    const centerLines = buildCenterRows(state, layout.contentWidth, layout.bottomSectionHeight);
    let rowIndex = 0;

    for (const line of peopleLines) {
      lines.push(`${FRAME.vertical}${line}${bodySlotChar(state, rowIndex)}${FRAME.vertical}`);
      rowIndex += 1;
    }

    if (separatorHeight) {
      lines.push(
        `${FRAME.leftTee}${repeat(FRAME.horizontal, layout.contentWidth)}${bodySlotChar(state, rowIndex)}${FRAME.rightTee}`
      );
      rowIndex += 1;
    }

    for (const line of centerLines) {
      lines.push(`${FRAME.vertical}${line}${bodySlotChar(state, rowIndex)}${FRAME.vertical}`);
      rowIndex += 1;
    }

    while (rowIndex < layout.bodyHeight) {
      lines.push(`${FRAME.vertical}${repeat(" ", layout.contentWidth)}${bodySlotChar(state, rowIndex)}${FRAME.vertical}`);
      rowIndex += 1;
    }
  }

  lines.push(middleBorder(layout.totalWidth));
  lines.push(framedLine(` ${buildSuggestionLine(state, commands, layout.totalWidth - 4)} `));
  lines.push(framedLine(` ${pad(buildStatusLine(state), layout.totalWidth - 4)} `));
  lines.push(bottomBorder(layout.totalWidth));

  return lines.join("\n");
}
