import type { AppState } from "./types.js";

export const PEOPLE_PER_PAGE = 8;

export interface LeftNavEntry {
  kind: "feed" | "notifications" | "settings" | "person" | "people_page" | "room" | "new-room";
  key: string;
  handle?: string;
  roomName?: string;
  online?: boolean;
  messageCount?: number;
  unreadCount?: number;
  pageIndex?: number;
  pageCount?: number;
}

export function getLeftNavEntries(state: AppState): LeftNavEntry[] {
  if (!state.authUser) {
    return [];
  }

  const entries: LeftNavEntry[] = [
    {
      kind: "feed",
      key: "feed"
    },
    {
      kind: "notifications",
      key: "notifications",
      unreadCount: state.notifications.unreadCount
    },
    {
      kind: "settings",
      key: "settings"
    }
  ];

  const people = state.people.items.filter((person) => person.handle);
  const pageCount = Math.max(1, Math.ceil(people.length / PEOPLE_PER_PAGE));
  const pageIndex = Math.max(0, Math.min(state.people.pageIndex, pageCount - 1));
  const start = pageIndex * PEOPLE_PER_PAGE;
  const visiblePeople = people.slice(start, start + PEOPLE_PER_PAGE);

  for (const person of visiblePeople) {
    entries.push({
      kind: "person",
      key: `person:${person.handle}`,
      handle: person.handle,
      online: person.online
    });
  }

  if (pageCount > 1) {
    entries.push({
      kind: "people_page",
      key: `people_page:${pageIndex}`,
      pageIndex,
      pageCount
    });
  }

  for (const room of state.social.rooms) {
    entries.push({
      kind: "room",
      key: `room:${room.name}`,
      roomName: room.name,
      messageCount: room.messageCount
    });
  }

  entries.push({
    kind: "new-room",
    key: "room:new",
    roomName: "+ room"
  });

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

export function peoplePageCount(state: AppState): number {
  const peopleCount = state.people.items.filter((person) => person.handle).length;
  return Math.max(1, Math.ceil(peopleCount / PEOPLE_PER_PAGE));
}

export function peoplePageIndexForHandle(state: AppState, handle: string): number {
  const normalized = String(handle || "").replace(/^@/, "").trim();
  const personIndex = state.people.items.findIndex((person) => person.handle === normalized);
  if (personIndex < 0) {
    return Math.max(0, Math.min(state.people.pageIndex, peoplePageCount(state) - 1));
  }
  return Math.floor(personIndex / PEOPLE_PER_PAGE);
}
