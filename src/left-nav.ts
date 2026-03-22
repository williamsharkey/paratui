import type { AppState } from "./types.js";

export interface LeftNavEntry {
  kind: "person" | "room" | "dm" | "new-room";
  key: string;
  handle?: string;
  displayName?: string;
  roomName?: string;
  online?: boolean;
  messageCount?: number;
}

export function getLeftNavEntries(state: AppState): LeftNavEntry[] {
  const entries: LeftNavEntry[] = [
    ...state.people.items.map((person) => ({
      kind: "person" as const,
      key: `person:${person.handle}`,
      handle: person.handle,
      displayName: person.displayName,
      online: person.online
    })),
    ...state.social.rooms.map((room) => ({
      kind: "room" as const,
      key: `room:${room.name}`,
      roomName: room.name,
      messageCount: room.messageCount
    })),
    ...state.social.dms.map((dm) => ({
      kind: "dm" as const,
      key: `dm:${dm.handle}`,
      handle: dm.handle,
      displayName: dm.displayName,
      online: dm.online
    }))
  ];

  if (state.authUser && (entries.length > 0 || state.view === "profile")) {
    entries.splice(state.people.items.length + state.social.rooms.length, 0, {
      kind: "new-room",
      key: "room:new",
      roomName: "+ room"
    });
  }

  return entries;
}

export function getLeftNavEntry(state: AppState, index: number): LeftNavEntry | null {
  const entries = getLeftNavEntries(state);
  if (!entries.length) {
    return null;
  }
  const clamped = Math.max(0, Math.min(index, entries.length - 1));
  return entries[clamped] || null;
}

export function findLeftNavIndex(state: AppState, key: string): number {
  return getLeftNavEntries(state).findIndex((entry) => entry.key === key);
}
