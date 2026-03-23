import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AsciiArtCache, type AsciiRenderSize } from "./ascii.js";
import { ParasceneClient, type ParasceneRealtimeConfig } from "./api.js";
import {
  createCommandRegistry,
  findMatchingCommands,
  longestCommonCommandPrefix,
  parseCommandText,
  type CommandSpec
} from "./commands.js";
import { loadConfig, saveConfig } from "./config.js";
import { exportImageWithMetadata, normalizeFormat } from "./export.js";
import { sanitizeTextForTui } from "./emoji.js";
import { getFocusActions } from "./focus-actions.js";
import {
  findLeftNavIndex,
  getLeftNavEntries,
  getLeftNavEntry,
  peoplePageCount,
  peoplePageIndexForHandle,
  type LeftNavEntry
} from "./left-nav.js";
import { calculateLayout, type ViewportSize } from "./layout.js";
import { assertSnapshotValue, runMacroFile } from "./macros.js";
import { ParasceneRealtimeClient } from "./parascene-realtime.js";
import { RealtimeClient } from "./realtime-client.js";
import { renderApp } from "./render.js";
import { TestBridge } from "./test-bridge.js";
import type {
  ActivityItem,
  AppConfig,
  AppSnapshot,
  AppState,
  CliAuthUser,
  CliUserSummary,
  CreationSummary,
  DmSummary,
  FeedItem,
  FocusRegion,
  NotificationSummary,
  ParsedCommand,
  RealtimeMessage,
  RealtimePeerSummary,
  RoomSummary,
  SocialMessage,
  SlotValue,
  UserProfileData
} from "./types.js";

export interface AppOptions {
  macroPath?: string | null;
  exitAfterMacro?: boolean;
  headless?: boolean;
}

interface CachedValue<T> {
  value: T;
  updatedAt: number;
}

interface CachedDmView {
  threadId: number;
  dm: DmSummary;
  messages: SocialMessage[];
}

interface CachedRoomView {
  threadId: number;
  room: RoomSummary;
  messages: SocialMessage[];
}

interface CachedNotificationsView {
  items: NotificationSummary[];
  unreadCount: number;
}

const FEED_CACHE_TTL_MS = 15_000;
const PROFILE_CACHE_TTL_MS = 60_000;
const THREAD_CACHE_TTL_MS = 15_000;
const NOTIFICATIONS_CACHE_TTL_MS = 10_000;
const PERSON_STATS_CACHE_TTL_MS = 5 * 60_000;
const SOCIAL_SUMMARY_CACHE_TTL_MS = 10_000;
const LEFT_PREFETCH_DELAY_MS = 100;

export class ParatuiApp {
  config!: AppConfig;
  readonly bridge = new TestBridge();
  readonly asciiCache = new AsciiArtCache();
  readonly commands: CommandSpec[] = createCommandRegistry();
  readonly options: AppOptions;
  readonly state: AppState = {
    view: "login",
    focus: "auth",
    status: "booting",
    config: {
      audio: {
        muted: false
      }
    },
    authInput: {
      active: false,
      draft: ""
    },
    authUser: null,
    people: {
      items: [],
      selectedIndex: 0,
      pageIndex: 0
    },
    profile: null,
    creations: {
      ownerHandle: null,
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
      unreadCount: 0,
      selectedIndex: 0
    },
    loaded: {
      people: false,
      social: false,
      notifications: false,
      feed: false,
      thread: false,
      profile: false
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

  #client = new ParasceneClient("http://127.0.0.1:2367", () => this.config?.auth.bearerToken || null);
  #realtime = new RealtimeClient("ws://127.0.0.1:8788/realtime", () => this.config?.auth.bearerToken || null, {
    onWelcome: (message) => {
      this.state.realtime.connected = true;
      this.state.realtime.room = message.room;
      this.state.realtime.selfPeerId = message.self.peerId;
      this.state.realtime.peers = message.peers;
      this.state.realtime.iceServerCount = message.iceServers.length;
      this.state.realtime.messages = [
        {
          kind: "system",
          scope: "system",
          fromHandle: null,
          text: `connected to live room ${message.room}`,
          createdAt: new Date().toISOString()
        }
      ];
      this.state.status = `live ${message.room}`;
      this.renderRealtimeEvent();
    },
    onPresence: (message) => {
      if (message.event === "snapshot") {
        this.state.realtime.room = message.room;
        this.state.realtime.peers = message.peers || [];
      } else if (message.peer) {
        if (message.event === "join") {
          const nextPeers = this.state.realtime.peers.filter((peer) => peer.peerId !== message.peer!.peerId);
          nextPeers.push(message.peer);
          this.state.realtime.peers = nextPeers.sort((left, right) => left.handle.localeCompare(right.handle));
          this.pushRealtimeMessage({
            kind: "system",
            scope: "system",
            fromHandle: message.peer.handle,
            text: `@${message.peer.handle} joined ${message.room}`,
            createdAt: new Date().toISOString()
          });
          this.state.status = `live join @${message.peer.handle}`;
        } else if (message.event === "leave") {
          this.state.realtime.peers = this.state.realtime.peers.filter((peer) => peer.peerId !== message.peer!.peerId);
          this.pushRealtimeMessage({
            kind: "system",
            scope: "system",
            fromHandle: message.peer.handle,
            text: `@${message.peer.handle} left ${message.room}`,
            createdAt: new Date().toISOString()
          });
          this.state.status = `live leave @${message.peer.handle}`;
        }
      }
      this.renderRealtimeEvent();
    },
    onChat: (message) => {
      this.pushRealtimeMessage({
        kind: "chat",
        scope: message.scope,
        fromHandle: message.from.handle,
        text: message.text,
        createdAt: new Date().toISOString()
      });
      this.state.status = message.scope === "direct"
        ? `live direct @${message.from.handle}`
        : `live room @${message.from.handle}`;
      this.renderRealtimeEvent();
    },
    onSignal: (message) => {
      this.state.realtime.lastSignalType = message.signalType;
      this.pushRealtimeMessage({
        kind: "signal",
        scope: "signal",
        fromHandle: message.from.handle,
        text: typeof message.payload === "string"
          ? String(message.payload)
          : `call ${message.callId || "signal"}`,
        signalType: message.signalType,
        createdAt: new Date().toISOString()
      });
      this.state.status = `live signal ${message.signalType} @${message.from.handle}`;
      this.renderRealtimeEvent();
    },
    onDisconnect: () => {
      this.clearRealtimeState();
      this.state.status = "live offline";
      this.renderRealtimeEvent();
    },
    onError: (message) => {
      this.state.status = message;
      this.renderRealtimeEvent();
    }
  });
  #parasceneRealtime = new ParasceneRealtimeClient({
    onUserDirty: () => {
      this.queueParasceneUserRefresh();
    },
    onThreadDirty: (threadId) => {
      this.queueParasceneThreadRefresh(threadId);
    },
    onStateChange: (connected) => {
      if (!connected) {
        this.showCachedModeStatus("reconnecting - cached mode");
      }
    },
    onError: () => {
      this.showCachedModeStatus("offline - cached mode");
    }
  });
  #interactiveResolver: (() => void) | null = null;
  #runningInteractive = false;
  #viewport: ViewportSize = this.readViewport();
  #lastNonSlashFocus: FocusRegion = "auth";
  #activityCache = new Map<number, Promise<ActivityItem[]>>();
  #profileCache = new Map<string, CachedValue<UserProfileData>>();
  #profileLoadPromises = new Map<string, Promise<UserProfileData>>();
  #dmCache = new Map<string, CachedValue<CachedDmView>>();
  #dmLoadPromises = new Map<string, Promise<CachedDmView>>();
  #roomCache = new Map<string, CachedValue<CachedRoomView>>();
  #roomLoadPromises = new Map<string, Promise<CachedRoomView>>();
  #feedCache: CachedValue<FeedItem[]> | null = null;
  #feedLoadPromise: Promise<FeedItem[]> | null = null;
  #notificationsCache: CachedValue<CachedNotificationsView> | null = null;
  #notificationsLoadPromise: Promise<CachedNotificationsView> | null = null;
  #socialSummaryCache: CachedValue<{ rooms: RoomSummary[]; dms: DmSummary[] }> | null = null;
  #socialSummaryLoadPromise: Promise<{ rooms: RoomSummary[]; dms: DmSummary[] }> | null = null;
  #personStatsCache = new Map<string, CachedValue<number>>();
  #personStatsPromises = new Map<string, Promise<number | null>>();
  #peopleRefreshTimer: NodeJS.Timeout | null = null;
  #leftPrefetchTimer: NodeJS.Timeout | null = null;
  #persistUiCacheTimer: NodeJS.Timeout | null = null;
  #leftSelectionLoadVersion = 0;
  #terminalUiActive = false;
  #lastRenderedLines: string[] = [];
  #lastRenderedViewport: ViewportSize | null = null;
  #previewProcess: ReturnType<typeof spawn> | null = null;
  #previewPath: string | null = null;
  #inputSeq = 0;
  #pollTick = 0;
  #parasceneRealtimeBootstrapPromise: Promise<boolean> | null = null;
  #parasceneRealtimeRetryAt = 0;
  #parasceneUserRefreshPromise: Promise<void> | null = null;
  #parasceneUserRefreshQueued = false;
  #parasceneThreadRefreshPromise: Promise<void> | null = null;
  #parasceneThreadRefreshQueuedThreadId: number | null = null;

  constructor(options: AppOptions = {}) {
    this.options = options;
  }

  async init(): Promise<void> {
    this.config = await loadConfig();
    this.state.config.audio.muted = this.config.audio.muted;
    this.state.social.rooms = this.config.social.recentRooms.map((roomName) => recentRoomSummary(roomName));
    this.#client.setBaseUrl(this.config.serverBaseUrl);
    this.#realtime.setUrl(this.config.realtimeBaseUrl);

    if (this.config.auth.bearerToken) {
      try {
        const me = await this.#client.me();
        this.state.authUser = me.user;
      } catch {
        this.config.auth.bearerToken = null;
        this.config.auth.username = null;
        await saveConfig(this.config);
      }
    }

    this.state.view = this.state.authUser ? "feed" : "login";
    this.state.focus = this.defaultFocusRegion();
    this.#lastNonSlashFocus = this.state.focus;
    this.state.status = this.state.authUser
      ? `signed in as @${this.state.authUser.handle}`
      : "set api key";

    if (this.state.authUser) {
      this.applyPersistedUiCache();
      const selectedKey = this.config.uiCache.selectedLeftKey || "feed";
      if (!this.selectLeftEntry(selectedKey)) {
        this.selectLeftEntry("feed");
      }
      const selectedEntry = this.currentLeftSelection();
      if (selectedEntry) {
        this.primeLeftSelection(selectedEntry);
        this.openLeftSelectionInBackground(selectedEntry, true);
      }
      this.state.focus = "left";
      this.#lastNonSlashFocus = "left";
      this.ensureParasceneRealtime();
      this.syncParasceneRealtimeSubscriptions();
    }

    if (!this.options.headless) {
      this.render();
      this.bridge.emit({ type: "ready", snapshot: this.snapshot() });
    }

    if (this.state.authUser) {
      this.kickAuthenticatedBackgroundHydration();
    }
  }

  snapshot(): AppSnapshot {
    const current = this.currentCreation();
    const currentFeedItem = this.currentFeedItem();
    const previous = this.state.creations.items[this.state.creations.currentIndex - 1] ?? null;
    const next = this.state.creations.items[this.state.creations.currentIndex + 1] ?? null;
    const firstComment = this.state.creations.activity.find((item) => item.type === "comment");
    const slashMatches = this.currentSlashMatches();
    const selectedSlash = this.selectedSlashCommand(slashMatches);
    const focusActions = this.currentFocusActions();
    const selectedActionIndex = this.clampedActionIndex(focusActions);
    const slotEntries = Object.fromEntries(
      Object.entries(this.state.slots).map(([slot, value]) => [
        slot,
        {
          assigned: Boolean(value),
          title: value?.title ?? null
        }
      ])
    );

    return {
      meta: {
        inputSeq: this.#inputSeq
      },
      view: this.state.view,
      focus: this.state.focus,
      status: this.state.status,
      auth: {
        loggedIn: Boolean(this.state.authUser),
        handle: this.state.authUser?.handle ?? null,
        inputActive: this.state.authInput.active,
        draftLength: this.state.authInput.draft.length
      },
      selected: {
        handle: this.currentSelectedHandle()
      },
      profile: {
        handle: this.state.profile?.profile.user_name ?? null
      },
      creation: {
        title: current?.title ?? null,
        index: this.state.creations.currentIndex,
        count: this.state.creations.items.length,
        ownerHandle: this.state.creations.ownerHandle,
        preloaded: {
          previous: this.asciiCache.has(previous?.url),
          next: this.asciiCache.has(next?.url)
        }
      },
      activity: {
        count: this.state.creations.activity.length,
        firstCommentText: firstComment?.text ?? null
      },
      dm: {
        handle: this.state.social.dmHandle,
        messageCount: this.state.view === "dm" ? this.state.social.threadMessages.length : 0
      },
      room: {
        name: this.state.social.roomName,
        messageCount: this.state.view === "room" ? this.state.social.threadMessages.length : 0
      },
      feed: {
        title: currentFeedItem?.title ?? null,
        index: this.state.feed.currentIndex,
        count: this.state.feed.items.length
      },
      notifications: {
        count: this.state.notifications.items.length,
        unreadCount: this.state.notifications.unreadCount,
        selectedId: this.state.notifications.items[this.state.notifications.selectedIndex]?.id ?? null
      },
      realtime: {
        connected: this.state.realtime.connected,
        room: this.state.realtime.room,
        peerCount: this.state.realtime.peers.length,
        peerHandles: this.state.realtime.peers.map((peer) => peer.handle),
        messageCount: this.state.realtime.messages.length,
        lastMessageText: this.state.realtime.messages[this.state.realtime.messages.length - 1]?.text ?? null,
        iceServerCount: this.state.realtime.iceServerCount,
        lastSignalType: this.state.realtime.lastSignalType
      },
      settings: {
        audio: {
          muted: this.config.audio.muted
        }
      },
      actions: {
        selectedIndex: selectedActionIndex,
        selectedId: focusActions[selectedActionIndex]?.id ?? null,
        count: focusActions.length
      },
      slots: slotEntries,
      previewOpen: this.state.previewOpen,
      fullView: {
        open: this.state.fullView.open,
        asciiLength: this.state.fullView.ascii.length
      },
      export: {
        lastSavedPath: this.state.exports.lastSavedPath
      },
      composer: {
        active: this.state.composer.active,
        kind: this.state.composer.kind,
        textLength: this.state.composer.text.length
      },
      slash: {
        open: this.state.slash.open,
        input: this.state.slash.input,
        selectedPath: selectedSlash?.path ?? null,
        matchCount: slashMatches.length
      }
    };
  }

  private applyPersistedUiCache(): void {
    const cache = this.config.uiCache;
    const persistedThreadKey = cache.currentThread.view === "dm" && cache.currentThread.dmHandle
      ? `person:${cache.currentThread.dmHandle}`
      : cache.currentThread.view === "room" && cache.currentThread.roomName
        ? `room:${cache.currentThread.roomName}`
        : null;
    const persistedThreadReady = Boolean(
      cache.loaded.thread
      && cache.currentThread.view
      && persistedThreadKey
      && cache.selectedLeftKey === persistedThreadKey
      && cache.currentThread.messages.length
    );
    this.state.loaded = {
      ...this.state.loaded,
      ...cache.loaded,
      thread: persistedThreadReady
    };
    this.state.social.rooms = mergeRoomSummaries(
      cache.rooms,
      this.config.social.recentRooms.map((roomName) => recentRoomSummary(roomName))
    );
    this.state.social.dms = [...cache.dms];
    this.state.people.items = this.mergePeopleCandidates(cache.people);
    this.state.notifications.items = [...cache.notifications.items];
    this.state.notifications.unreadCount = cache.notifications.unreadCount;
    this.state.feed.items = [...cache.feed.items];
    this.state.feed.currentIndex = Math.max(0, Math.min(cache.feed.currentIndex, Math.max(0, cache.feed.items.length - 1)));
    this.state.social.dmHandle = cache.currentThread.dmHandle;
    this.state.social.roomName = cache.currentThread.roomName;
    this.state.social.threadId = cache.currentThread.threadId;
    this.state.social.threadPageIndex = 0;
    this.state.social.threadMessages = [...cache.currentThread.messages];

    if (cache.feed.items.length) {
      this.#feedCache = {
        value: [...cache.feed.items],
        updatedAt: Date.now()
      };
    }

    this.#notificationsCache = {
      value: {
        items: [...cache.notifications.items],
        unreadCount: cache.notifications.unreadCount
      },
      updatedAt: Date.now()
    };

    this.#socialSummaryCache = {
      value: {
        rooms: [...cache.rooms],
        dms: [...cache.dms]
      },
      updatedAt: Date.now()
    };

    if (cache.currentThread.view === "dm" && cache.currentThread.dmHandle) {
      this.setCachedMapValue(this.#dmCache, cache.currentThread.dmHandle, {
        threadId: cache.currentThread.threadId || 0,
        dm: this.state.social.dms.find((entry) => entry.handle === cache.currentThread.dmHandle) || {
          threadId: cache.currentThread.threadId,
          handle: cache.currentThread.dmHandle,
          displayName: cache.currentThread.dmHandle,
          online: false,
          lastMessageText: cache.currentThread.messages.at(-1)?.text || null,
          lastMessageAt: cache.currentThread.messages.at(-1)?.createdAt || null
        },
        messages: [...cache.currentThread.messages]
      });
    }

    if (cache.currentThread.view === "room" && cache.currentThread.roomName) {
      this.setCachedMapValue(this.#roomCache, cache.currentThread.roomName, {
        threadId: cache.currentThread.threadId || 0,
        room: this.state.social.rooms.find((entry) => entry.name === cache.currentThread.roomName) || recentRoomSummary(cache.currentThread.roomName),
        messages: [...cache.currentThread.messages]
      });
    }
  }

  private schedulePersistUiCache(): void {
    if (!this.config) {
      return;
    }
    if (this.#persistUiCacheTimer) {
      clearTimeout(this.#persistUiCacheTimer);
    }
    this.#persistUiCacheTimer = setTimeout(() => {
      this.#persistUiCacheTimer = null;
      void this.persistUiCacheNow();
    }, 150);
  }

  private async persistUiCacheNow(): Promise<void> {
    if (!this.config) {
      return;
    }
    this.config.uiCache = {
      loaded: { ...this.state.loaded },
      selectedLeftKey: this.currentLeftSelectionKey(),
      people: this.state.people.items.slice(0, 32),
      rooms: this.state.social.rooms.slice(0, 24),
      dms: this.state.social.dms.slice(0, 24),
      notifications: {
        items: this.state.notifications.items.slice(0, 32),
        unreadCount: this.state.notifications.unreadCount
      },
      feed: {
        items: this.state.feed.items.slice(0, 32),
        currentIndex: this.state.feed.currentIndex
      },
      currentThread: {
        view: this.state.view === "dm" || this.state.view === "room" ? this.state.view : null,
        dmHandle: this.state.social.dmHandle,
        roomName: this.state.social.roomName,
        threadId: this.state.social.threadId,
        messages: this.state.social.threadMessages.slice(-20)
      }
    };
    await saveConfig(this.config);
  }

  bridgeLog(message: string): void {
    this.bridge.emit({ type: "log", message });
  }

  private formatUiError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RangeError || /maximum call stack size exceeded/i.test(message)) {
      this.#parasceneRealtimeRetryAt = Date.now() + 5 * 60_000;
      void this.#parasceneRealtime.disconnect().catch(() => undefined);
      return "realtime paused - cached mode";
    }
    return message;
  }

  assertSnapshot(pathName: string, expectedRaw: string): void {
    assertSnapshotValue(this.snapshot(), pathName, expectedRaw);
  }

  private freshCachedValue<T>(entry: CachedValue<T> | null | undefined, ttlMs: number): T | null {
    if (!entry) {
      return null;
    }
    return Date.now() - entry.updatedAt <= ttlMs ? entry.value : null;
  }

  private setCachedMapValue<T>(map: Map<string, CachedValue<T>>, key: string, value: T): T {
    map.set(key, {
      value,
      updatedAt: Date.now()
    });
    return value;
  }

  private currentLeftSelectionKey(): string | null {
    return this.currentLeftSelection()?.key || null;
  }

  private syncPageIndexForSelectionKey(key: string | null): void {
    const pageCount = peoplePageCount(this.state);
    if (!key) {
      this.state.people.pageIndex = Math.max(0, Math.min(this.state.people.pageIndex, pageCount - 1));
      return;
    }
    if (key.startsWith("person:")) {
      const handle = key.slice("person:".length);
      this.state.people.pageIndex = peoplePageIndexForHandle(this.state, handle);
      return;
    }
    if (key.startsWith("people_page:")) {
      this.state.people.pageIndex = Math.max(0, Math.min(this.state.people.pageIndex, pageCount - 1));
    }
  }

  private setLeftSelectionByKey(key: string): boolean {
    this.syncPageIndexForSelectionKey(key);
    const index = findLeftNavIndex(this.state, key);
    if (index < 0) {
      return false;
    }
    this.state.people.selectedIndex = index;
    return true;
  }

  private selectedLeftEntryWithinBounds(): void {
    const entries = getLeftNavEntries(this.state);
    if (!entries.length) {
      this.state.people.selectedIndex = 0;
      return;
    }
    this.state.people.selectedIndex = Math.max(0, Math.min(this.state.people.selectedIndex, entries.length - 1));
  }

  currentSelectedHandle(): string | null {
    const entry = this.currentLeftSelection();
    if (!entry || entry.kind !== "person") {
      return null;
    }
    return entry.handle ?? null;
  }

  selectHandle(handle: string): void {
    const normalized = handle.replace(/^@/, "");
    if (this.setLeftSelectionByKey(`person:${normalized}`)) {
      this.state.status = `selected @${normalized}`;
      this.playUiSound("select");
    }
  }

  selectRoom(roomName: string): void {
    const normalized = roomName.replace(/^#/, "").trim().toLowerCase();
    if (this.setLeftSelectionByKey(`room:${normalized}`)) {
      this.state.status = `selected room ${normalized}`;
      this.playUiSound("select");
    }
  }

  currentCreation(): CreationSummary | null {
    return this.state.creations.items[this.state.creations.currentIndex] || null;
  }

  currentFeedItem(): FeedItem | null {
    return this.state.feed.items[this.state.feed.currentIndex] || null;
  }

  currentSlashMatches(): CommandSpec[] {
    return findMatchingCommands(this.commands, this.currentSlashPath());
  }

  currentFocusActions(focus: FocusRegion = this.state.focus): ReturnType<typeof getFocusActions> {
    return getFocusActions(this.state, focus);
  }

  private async loadProfileCached(handle: string, force = false): Promise<UserProfileData> {
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    const cached = !force ? this.freshCachedValue(this.#profileCache.get(normalized), PROFILE_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    const inflight = this.#profileLoadPromises.get(normalized);
    if (inflight) {
      return inflight;
    }
    const promise = this.#client.loadProfile(normalized)
      .then((profile) => {
        this.setCachedMapValue(this.#profileCache, normalized, profile);
        this.setCachedMapValue(this.#personStatsCache, normalized, profile.stats.creations_published);
        return profile;
      })
      .finally(() => {
        this.#profileLoadPromises.delete(normalized);
      });
    this.#profileLoadPromises.set(normalized, promise);
    return promise;
  }

  private async loadDmCached(handle: string, force = false, knownThreadId?: number | null): Promise<CachedDmView> {
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    const cached = !force ? this.freshCachedValue(this.#dmCache.get(normalized), THREAD_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    const inflight = this.#dmLoadPromises.get(normalized);
    if (inflight) {
      return inflight;
    }
    const promise = this.#client.loadDmMessages(normalized, knownThreadId)
      .then((data) => this.setCachedMapValue(this.#dmCache, normalized, {
        threadId: data.threadId,
        dm: data.dm,
        messages: data.messages
      }))
      .finally(() => {
        this.#dmLoadPromises.delete(normalized);
      });
    this.#dmLoadPromises.set(normalized, promise);
    return promise;
  }

  private async loadRoomCached(roomName: string, force = false): Promise<CachedRoomView> {
    const normalized = roomName.replace(/^#/, "").trim().toLowerCase();
    const cached = !force ? this.freshCachedValue(this.#roomCache.get(normalized), THREAD_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    const inflight = this.#roomLoadPromises.get(normalized);
    if (inflight) {
      return inflight;
    }
    const promise = this.#client.loadRoomMessages(normalized)
      .then((data) => this.setCachedMapValue(this.#roomCache, normalized, {
        threadId: data.threadId,
        room: data.room,
        messages: data.messages
      }))
      .finally(() => {
        this.#roomLoadPromises.delete(normalized);
      });
    this.#roomLoadPromises.set(normalized, promise);
    return promise;
  }

  private async loadFeedCached(force = false): Promise<FeedItem[]> {
    const cached = !force ? this.freshCachedValue(this.#feedCache, FEED_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    if (this.#feedLoadPromise) {
      return this.#feedLoadPromise;
    }
    this.#feedLoadPromise = this.#client.loadLatestFeed()
      .then((items) => {
        this.#feedCache = {
          value: items,
          updatedAt: Date.now()
        };
        return items;
      })
      .finally(() => {
        this.#feedLoadPromise = null;
      });
    return this.#feedLoadPromise;
  }

  private async loadNotificationsCached(force = false): Promise<CachedNotificationsView> {
    const cached = !force ? this.freshCachedValue(this.#notificationsCache, NOTIFICATIONS_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    if (this.#notificationsLoadPromise) {
      return this.#notificationsLoadPromise;
    }
    this.#notificationsLoadPromise = Promise.all([
      this.#client.loadNotifications(),
      this.#client.loadNotificationUnreadCount()
    ])
      .then(([items, unreadCount]) => {
        const next = {
          items,
          unreadCount
        };
        this.#notificationsCache = {
          value: next,
          updatedAt: Date.now()
        };
        return next;
      })
      .finally(() => {
        this.#notificationsLoadPromise = null;
      });
    return this.#notificationsLoadPromise;
  }

  private async loadSocialSummariesCached(force = false): Promise<{ rooms: RoomSummary[]; dms: DmSummary[] }> {
    const cached = !force ? this.freshCachedValue(this.#socialSummaryCache, SOCIAL_SUMMARY_CACHE_TTL_MS) : null;
    if (cached) {
      return cached;
    }
    if (this.#socialSummaryLoadPromise) {
      return this.#socialSummaryLoadPromise;
    }
    this.#socialSummaryLoadPromise = this.#client.listSocialSummaries()
      .then((social) => {
        this.#socialSummaryCache = {
          value: social,
          updatedAt: Date.now()
        };
        return social;
      })
      .finally(() => {
        this.#socialSummaryLoadPromise = null;
      });
    return this.#socialSummaryLoadPromise;
  }

  private async ensurePersonStats(handle: string): Promise<number | null> {
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    const cached = this.freshCachedValue(this.#personStatsCache.get(normalized), PERSON_STATS_CACHE_TTL_MS);
    if (cached != null) {
      return cached;
    }
    const inflight = this.#personStatsPromises.get(normalized);
    if (inflight) {
      return inflight;
    }
    const promise = this.loadProfileCached(normalized)
      .then((profile) => profile.stats.creations_published)
      .catch(() => null)
      .finally(() => {
        this.#personStatsPromises.delete(normalized);
      });
    this.#personStatsPromises.set(normalized, promise);
    return promise;
  }

  private currentSlashPath(): string {
    const input = this.state.slash.input.trimStart();
    if (!input.startsWith("/")) {
      return "/";
    }
    const spaceIndex = input.search(/\s/);
    return spaceIndex === -1 ? input : input.slice(0, spaceIndex);
  }

  private currentSlashRemainder(): string {
    const input = this.state.slash.input.trimStart();
    const spaceIndex = input.search(/\s/);
    return spaceIndex === -1 ? "" : input.slice(spaceIndex);
  }

  private selectedSlashCommand(matches = this.currentSlashMatches()): CommandSpec | null {
    if (!matches.length) {
      this.state.slash.selectedIndex = 0;
      return null;
    }
    const index = Math.max(0, Math.min(this.state.slash.selectedIndex, matches.length - 1));
    this.state.slash.selectedIndex = index;
    return matches[index] ?? null;
  }

  private clampedActionIndex(actions = this.currentFocusActions()): number {
    if (!actions.length) {
      this.state.actions.selectedIndex = 0;
      return 0;
    }
    const index = Math.max(0, Math.min(this.state.actions.selectedIndex, actions.length - 1));
    this.state.actions.selectedIndex = index;
    return index;
  }

  private selectedFocusAction(focus: FocusRegion = this.state.focus): ReturnType<typeof getFocusActions>[number] | null {
    const actions = this.currentFocusActions(focus);
    if (!actions.length) {
      return null;
    }
    return actions[this.clampedActionIndex(actions)] ?? null;
  }

  private defaultFocusRegion(): FocusRegion {
    if (!this.state.authUser || this.state.view === "login") {
      return "auth";
    }
    if (this.state.view === "settings") {
      return "settings";
    }
    return "left";
  }

  private focusableRegions(): FocusRegion[] {
    if (!this.state.authUser || this.state.view === "login") {
      return ["auth"];
    }
    if (this.state.view === "settings") {
      return getLeftNavEntries(this.state).length ? ["left", "settings"] : ["settings"];
    }
    return getLeftNavEntries(this.state).length ? ["left", "center"] : ["center"];
  }

  private async movePersonSelection(delta: number): Promise<void> {
    const entries = getLeftNavEntries(this.state);
    if (!entries.length) {
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(this.state.people.selectedIndex + delta, entries.length - 1)
    );
    if (nextIndex === this.state.people.selectedIndex) {
      return;
    }
    this.state.people.selectedIndex = nextIndex;
    const nextEntry = entries[nextIndex] || null;
    if (nextEntry?.kind === "person" && nextEntry.handle) {
      this.syncPageIndexForSelectionKey(nextEntry.key);
    }
    this.state.status = this.leftSelectionStatus(nextEntry);
    this.openLeftSelectionInBackground(nextEntry);
    this.schedulePersistUiCache();
    this.playUiSound("focus");
  }

  private changePeoplePage(delta: number): void {
    const pageCount = peoplePageCount(this.state);
    if (pageCount <= 1) {
      return;
    }
    const nextPage = Math.max(0, Math.min(this.state.people.pageIndex + delta, pageCount - 1));
    if (nextPage === this.state.people.pageIndex) {
      return;
    }
    this.state.people.pageIndex = nextPage;
    this.setLeftSelectionByKey(`people_page:${nextPage}`);
    this.state.status = `people page ${nextPage + 1}/${pageCount}`;
    this.warmVisiblePeopleEntries();
    this.scheduleLeftPrefetch(this.state.people.selectedIndex);
    this.schedulePersistUiCache();
    this.playUiSound("focus");
  }

  private moveFocusAction(delta: number): void {
    if (this.state.view === "notifications" && this.state.focus === "center") {
      this.moveNotificationSelection(delta);
      return;
    }
    if (this.state.view === "creation" && this.state.focus === "center" && !this.state.composer.active) {
      this.moveCreationSelection(delta);
      return;
    }
    const actions = this.currentFocusActions();
    if (!actions.length) {
      return;
    }
    const nextIndex = Math.max(0, Math.min(this.clampedActionIndex(actions) + delta, actions.length - 1));
    if (nextIndex === this.state.actions.selectedIndex) {
      return;
    }
    this.state.actions.selectedIndex = nextIndex;
    this.state.status = actions[nextIndex]?.label || this.state.status;
    this.playUiSound("focus");
  }

  private moveNotificationSelection(delta: number): void {
    const items = this.state.notifications.items;
    if (!items.length) {
      return;
    }
    const nextIndex = Math.max(0, Math.min(this.state.notifications.selectedIndex + delta, items.length - 1));
    if (nextIndex === this.state.notifications.selectedIndex) {
      return;
    }
    this.state.notifications.selectedIndex = nextIndex;
    const selected = items[nextIndex];
    this.state.status = selected?.acknowledged_at
      ? "notification"
      : "notification unread";
    this.playUiSound("focus");
  }

  private currentThreadWrapWidth(): number {
    const layout = calculateLayout(this.#viewport);
    return layout.mode === "columns" ? layout.centerWidth : layout.contentWidth;
  }

  private currentThreadContentHeight(): number {
    const layout = calculateLayout(this.#viewport);
    const centerHeight = layout.mode === "columns" ? layout.bodyHeight : layout.bottomSectionHeight;
    const footerRows = 3;
    const staticHeaderRows = this.state.view === "room"
      ? this.wrapTextForPagination(
          [
            "users: "
              + Array.from(new Set(
                this.state.social.threadMessages
                  .map((message) => message.authorHandle)
                  .filter(Boolean)
              ))
                .map((handle) => `@${handle}`)
                .join(" "),
            ""
          ].join("\n"),
          this.currentThreadWrapWidth()
        ).length
      : 0;
    return Math.max(1, centerHeight - footerRows - staticHeaderRows);
  }

  private wrapTextForPagination(text: string, width: number): string[] {
    if (width <= 0) {
      return [];
    }
    const normalized = sanitizeTextForTui(text).replace(/\r/g, "").replace(/\t/g, "  ");
    const lines = normalized.split("\n");
    const wrapped: string[] = [];
    for (const line of lines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      let remaining = line;
      while (remaining.length > width) {
        wrapped.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      wrapped.push(remaining);
    }
    return wrapped;
  }

  private threadPageMetrics(): { pageCount: number; pageIndex: number } {
    if (this.state.view !== "dm" && this.state.view !== "room") {
      return { pageCount: 1, pageIndex: 0 };
    }
    const width = this.currentThreadWrapWidth();
    const availableRows = this.currentThreadContentHeight();
    const wrappedRows = this.state.social.threadMessages.flatMap((message) =>
      this.wrapTextForPagination(`@${message.authorHandle}: ${message.text}`, width)
    );

    if (!wrappedRows.length || wrappedRows.length <= availableRows) {
      return { pageCount: 1, pageIndex: 0 };
    }

    const pageSize = Math.max(1, availableRows - 1);
    const pageCount = Math.max(1, Math.ceil(wrappedRows.length / pageSize));
    const pageIndex = Math.max(0, Math.min(this.state.social.threadPageIndex, pageCount - 1));
    return { pageCount, pageIndex };
  }

  private pageThreadHistory(delta: number): boolean {
    if ((this.state.view !== "dm" && this.state.view !== "room") || this.state.composer.active) {
      return false;
    }
    const { pageCount, pageIndex } = this.threadPageMetrics();
    if (pageCount <= 1) {
      return false;
    }
    const nextPageIndex = Math.max(0, Math.min(pageIndex + delta, pageCount - 1));
    if (nextPageIndex === pageIndex) {
      return false;
    }
    this.state.social.threadPageIndex = nextPageIndex;
    this.state.status = `history ${nextPageIndex + 1}/${pageCount}`;
    this.playUiSound("focus");
    return true;
  }

  private moveCreationSelection(delta: number): void {
    const commentCount = this.state.creations.activity.length;
    const visibleCommentCount = 4;
    const actions = this.currentFocusActions("center");

    if (!commentCount) {
      this.state.creations.selectionMode = "actions";
      const nextIndex = Math.max(0, Math.min(this.clampedActionIndex(actions) + delta, Math.max(0, actions.length - 1)));
      this.state.actions.selectedIndex = nextIndex;
      this.state.status = actions[nextIndex]?.label || this.state.status;
      this.playUiSound("focus");
      return;
    }

    if (this.state.creations.selectionMode === "comments") {
      if (delta > 0) {
        if (this.state.creations.selectedCommentIndex < commentCount - 1) {
          this.state.creations.selectedCommentIndex += 1;
          if (this.state.creations.selectedCommentIndex >= this.state.creations.commentScrollOffset + visibleCommentCount) {
            this.state.creations.commentScrollOffset += 1;
          }
          this.state.status = `comment ${this.state.creations.selectedCommentIndex + 1}/${commentCount}`;
        } else {
          this.state.creations.selectionMode = "actions";
          this.state.actions.selectedIndex = 0;
          this.state.status = actions[0]?.label || this.state.status;
        }
      } else if (delta < 0 && this.state.creations.selectedCommentIndex > 0) {
        this.state.creations.selectedCommentIndex -= 1;
        if (this.state.creations.selectedCommentIndex < this.state.creations.commentScrollOffset) {
          this.state.creations.commentScrollOffset = this.state.creations.selectedCommentIndex;
        }
        this.state.status = `comment ${this.state.creations.selectedCommentIndex + 1}/${commentCount}`;
      }
      this.playUiSound("focus");
      return;
    }

    if (delta < 0 && this.state.actions.selectedIndex === 0) {
      this.state.creations.selectionMode = "comments";
      this.state.creations.selectedCommentIndex = commentCount - 1;
      this.state.creations.commentScrollOffset = Math.max(0, commentCount - visibleCommentCount);
      this.state.status = `comment ${commentCount}/${commentCount}`;
      this.playUiSound("focus");
      return;
    }

    const nextIndex = Math.max(0, Math.min(this.clampedActionIndex(actions) + delta, Math.max(0, actions.length - 1)));
    this.state.actions.selectedIndex = nextIndex;
    this.state.status = actions[nextIndex]?.label || this.state.status;
    this.playUiSound("focus");
  }

  private cycleFocus(reverse = false): void {
    const focusable = this.focusableRegions();
    if (!focusable.length) {
      return;
    }
    const currentIndex = focusable.indexOf(this.state.focus);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + (reverse ? -1 : 1) + focusable.length) % focusable.length;
    this.state.focus = focusable[nextIndex]!;
    this.#lastNonSlashFocus = this.state.focus;
    this.state.actions.selectedIndex = 0;
    this.state.status = `focus ${this.state.focus}`;
    this.playUiSound("focus");
  }

  private moveSlashSelection(delta: number): void {
    const matches = this.currentSlashMatches();
    if (!matches.length) {
      this.state.slash.selectedIndex = 0;
      return;
    }
    const currentIndex = Math.max(0, Math.min(this.state.slash.selectedIndex, matches.length - 1));
    this.state.slash.selectedIndex = (currentIndex + delta + matches.length) % matches.length;
    const selected = this.selectedSlashCommand(matches);
    this.state.status = selected ? selected.path : "slash";
    this.playUiSound("focus");
  }

  private completeSlashInput(): void {
    const matches = this.currentSlashMatches();
    if (!matches.length) {
      return;
    }
    const currentPath = this.currentSlashPath();
    const remainder = this.currentSlashRemainder();
    const selected = this.selectedSlashCommand(matches);
    const prefix = longestCommonCommandPrefix(matches);
    const nextPath = prefix.length > currentPath.length ? prefix : selected?.path || currentPath;
    this.state.slash.input = `${nextPath}${remainder}`;
    this.state.slash.selectedIndex = 0;
    this.state.status = selected ? selected.path : "slash";
    this.playUiSound("focus");
  }

  private closeSlash(): void {
    this.state.slash.open = false;
    this.state.slash.input = "/";
    this.state.slash.selectedIndex = 0;
    if (this.state.focus === "slash") {
      const focusable = this.focusableRegions();
      this.state.focus = focusable.includes(this.#lastNonSlashFocus)
        ? this.#lastNonSlashFocus
        : this.defaultFocusRegion();
    }
  }

  private async invokeFocusedAction(): Promise<void> {
    if (this.state.focus === "left") {
      const selection = this.currentLeftSelection();
      if (!selection) {
        return;
      }
      if (selection.kind === "exit") {
        this.shutdown();
        return;
      }
      if (selection.kind === "placeholder" || selection.kind === "people_page") {
        return;
      }
      if (selection.kind === "new-room") {
        this.startRoomJoinComposer();
        return;
      }
      const targetFocus = this.state.view === "settings" ? "settings" : "center";
      if (this.focusableRegions().includes(targetFocus)) {
        this.state.focus = targetFocus;
        this.#lastNonSlashFocus = targetFocus;
        this.state.actions.selectedIndex = 0;
        this.state.status = this.selectedFocusAction(targetFocus)?.label || `focus ${targetFocus}`;
        this.playUiSound("focus");
        return;
      }
    }
    if (this.state.view === "notifications" && this.state.focus === "center") {
      await this.acknowledgeSelectedNotification();
      return;
    }
    if (this.state.view === "creation" && this.state.creations.selectionMode === "comments") {
      return;
    }
    const action = this.selectedFocusAction();
    if (!action) {
      return;
    }
    await this.runFocusAction(action.id);
  }

  private async runFocusAction(actionId: string): Promise<void> {
    switch (actionId) {
      case "open_api_help":
        await this.openApiKeyHelp();
        break;
      case "paste_api_key":
        this.startApiKeyEntry();
        break;
      case "toggle_mute":
        await this.toggleMute();
        break;
      case "open_creations":
        if (this.currentSelectedHandle()) {
          await this.openCreations(this.currentSelectedHandle()!);
        }
        break;
      case "open_dm":
        if (this.currentSelectedHandle()) {
          await this.openDm(this.currentSelectedHandle()!);
        }
        break;
      case "open_feed":
        await this.openFeed();
        break;
      case "mark_notification_read":
        await this.acknowledgeSelectedNotification();
        break;
      case "mark_all_notifications_read":
        await this.acknowledgeAllNotifications();
        break;
      case "open_settings":
        this.openSettings();
        break;
      case "previous_art":
        await this.previousCreation();
        break;
      case "next_art":
        await this.nextCreation();
        break;
      case "toggle_preview":
        await this.togglePreview();
        break;
      case "toggle_full_view":
        await this.toggleFullView();
        break;
      case "comment_compose":
        this.startCommentComposer();
        break;
      case "chat_compose":
        this.startChatComposer("room");
        break;
      case "dm_compose":
        this.startChatComposer("dm");
        break;
      case "open_active_creations":
        if (this.state.social.dmHandle) {
          await this.openCreations(this.state.social.dmHandle);
        }
        break;
      case "save_art":
        await this.saveCurrentArt("png");
        break;
      case "open_saved_art":
        await this.openSavedArt();
        break;
      case "open_saved_folder":
        await this.openSavedArtFolder();
        break;
      case "previous_feed":
        await this.previousFeed();
        break;
      case "next_feed":
        await this.nextFeed();
        break;
      case "connect_live":
        await this.connectRealtime();
        break;
      case "disconnect_live":
        await this.disconnectRealtime();
        break;
      case "join_lobby":
        await this.joinRealtimeRoom("lobby");
        break;
      default:
        throw new Error(`Unknown focus action: ${actionId}`);
    }
  }

  private async submitSlashSelection(): Promise<void> {
    const line = this.state.slash.input.trim();
    const exactPath = this.currentSlashPath();
    const exactCommand = this.commands.find((command) => command.path === exactPath);
    if (exactCommand && line !== "/") {
      await this.executeCommandString(line);
      return;
    }

    const selected = this.selectedSlashCommand();
    if (!selected) {
      throw new Error("No matching command");
    }
    const commandLine = `${selected.path}${this.currentSlashRemainder()}`;
    await this.executeCommandString(commandLine.trimEnd());
  }

  private testSlashEnabled(): boolean {
    return process.env.PARATUI_ENABLE_TEST_SLASH === "1";
  }

  private peopleSortKeyTimestamp(value: string | null | undefined): number {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private sortPeople(items: CliUserSummary[]): CliUserSummary[] {
    const authHandle = this.state.authUser?.handle || "";
    const dmOrder = new Map(
      this.state.social.dms.map((dm) => [dm.handle, this.peopleSortKeyTimestamp(dm.lastMessageAt)] as const)
    );

    return [...items].sort((left, right) => {
      if (left.handle === authHandle && right.handle !== authHandle) {
        return -1;
      }
      if (right.handle === authHandle && left.handle !== authHandle) {
        return 1;
      }

      const leftDmStamp = dmOrder.get(left.handle) || 0;
      const rightDmStamp = dmOrder.get(right.handle) || 0;
      if (leftDmStamp || rightDmStamp) {
        if (!leftDmStamp) {
          return 1;
        }
        if (!rightDmStamp) {
          return -1;
        }
        if (leftDmStamp !== rightDmStamp) {
          return rightDmStamp - leftDmStamp;
        }
      }

      const leftCreations = Math.max(0, Number(left.publishedCreations || 0));
      const rightCreations = Math.max(0, Number(right.publishedCreations || 0));
      if (leftCreations !== rightCreations) {
        return rightCreations - leftCreations;
      }

      return left.handle.localeCompare(right.handle);
    });
  }

  private mergePeopleCandidates(people: CliUserSummary[]): CliUserSummary[] {
    const merged = new Map<string, CliUserSummary>();
    const existingByHandle = new Map(
      this.state.people.items.map((person) => [person.handle, person] as const)
    );

    const upsert = (candidate: Partial<CliUserSummary> & { handle: string }): void => {
      const handle = String(candidate.handle || "").replace(/^@/, "").trim().toLowerCase();
      if (!handle) {
        return;
      }
      const existing = merged.get(handle) || existingByHandle.get(handle);
      const statCount = this.freshCachedValue(this.#personStatsCache.get(handle), PERSON_STATS_CACHE_TTL_MS);
      merged.set(handle, {
        id: Number(candidate.id || existing?.id || 0),
        email: String(candidate.email || existing?.email || ""),
        role: String(candidate.role || existing?.role || "user"),
        handle,
        displayName: String(candidate.displayName || existing?.displayName || handle),
        online: Boolean(
          handle === this.state.authUser?.handle
          || candidate.online
          || existing?.online
        ),
        lastActiveAt: candidate.lastActiveAt ?? existing?.lastActiveAt ?? null,
        publishedCreations: candidate.publishedCreations
          ?? existing?.publishedCreations
          ?? statCount
          ?? null
      });
    };

    if (this.state.authUser) {
      upsert({
        id: this.state.authUser.id,
        email: this.state.authUser.email,
        role: this.state.authUser.role,
        handle: this.state.authUser.handle,
        displayName: this.state.authUser.displayName,
        online: true,
        lastActiveAt: new Date().toISOString()
      });
    }

    for (const person of people) {
      upsert(person);
    }

    for (const dm of this.state.social.dms) {
      upsert({
        handle: dm.handle,
        displayName: dm.displayName,
        online: dm.online
      });
    }

    return this.sortPeople(Array.from(merged.values()));
  }

  private prefetchVisiblePersonStats(): void {
    const start = Math.max(0, this.state.people.pageIndex * 8 - 2);
    const end = Math.min(this.state.people.items.length, start + 12);
    const handles = this.state.people.items
      .slice(start, end)
      .map((person) => person.handle)
      .filter((handle) => handle && handle !== this.state.authUser?.handle);

    for (const handle of handles) {
      void this.ensurePersonStats(handle)
        .then((publishedCreations) => {
          if (publishedCreations == null) {
            return;
          }
          const person = this.state.people.items.find((entry) => entry.handle === handle);
          if (!person || person.publishedCreations === publishedCreations) {
            return;
          }
          const previousKey = this.currentLeftSelectionKey();
          this.state.people.items = this.sortPeople(this.state.people.items.map((entry) => (
            entry.handle === handle
              ? { ...entry, publishedCreations }
              : entry
          )));
          if (previousKey) {
            this.setLeftSelectionByKey(previousKey);
          } else {
            this.selectedLeftEntryWithinBounds();
          }
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
        })
        .catch(() => undefined);
    }
  }

  private warmVisiblePeopleEntries(): void {
    const entries = getLeftNavEntries(this.state).filter((entry) => entry.kind === "person" || entry.kind === "room");
    if (!entries.length) {
      return;
    }
    void Promise.allSettled(entries.map((entry) => this.prefetchLeftEntry(entry))).catch(() => undefined);
  }

  async refreshPeople(): Promise<void> {
    this.ensureAuthenticated();
    const people = await this.#client.listUsers(this.state.authUser.handle);
    this.applyPeopleList(people);
    this.state.loaded.people = true;
    this.prefetchVisiblePersonStats();
    this.warmVisiblePeopleEntries();
    this.schedulePersistUiCache();
  }

  async refreshNotifications(): Promise<void> {
    this.ensureAuthenticated();
    const previousId = this.state.notifications.items[this.state.notifications.selectedIndex]?.id ?? null;
    const { items, unreadCount } = await this.loadNotificationsCached(true);
    this.state.notifications.items = items;
    this.state.notifications.unreadCount = unreadCount;
    this.state.loaded.notifications = true;
    this.#notificationsCache = {
      value: {
        items,
        unreadCount
      },
      updatedAt: Date.now()
    };
    if (previousId != null) {
      const nextIndex = items.findIndex((item) => item.id === previousId);
      this.state.notifications.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
    } else {
      this.state.notifications.selectedIndex = 0;
    }
    this.schedulePersistUiCache();
  }

  async setApiKey(token: string): Promise<void> {
    const value = token.trim();
    if (!value) {
      throw new Error("Usage: /auth/key/set psn_<your-secret>");
    }
    await this.#parasceneRealtime.disconnect().catch(() => undefined);
    this.#parasceneRealtimeRetryAt = 0;
    const result = await this.#client.validateBearerToken(value);
    this.config.auth.bearerToken = value;
    this.config.auth.username = result.user.handle;
    await saveConfig(this.config);
    this.state.authUser = result.user;
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.view = "feed";
    this.state.focus = "left";
    this.#lastNonSlashFocus = "left";
    this.state.actions.selectedIndex = 0;
    this.selectLeftEntry("feed");
    this.openLeftSelectionInBackground(this.currentLeftSelection(), true);
    this.state.focus = "left";
    this.#lastNonSlashFocus = "left";
    this.state.status = `api key set for @${result.user.handle}`;
    this.state.loaded.profile = false;
    this.state.loaded.thread = false;
    this.ensureParasceneRealtime();
    this.syncParasceneRealtimeSubscriptions();
    this.kickAuthenticatedBackgroundHydration();
    this.schedulePersistUiCache();
    this.playUiSound("select");
  }

  async logout(): Promise<void> {
    await this.#realtime.disconnect().catch(() => undefined);
    await this.#parasceneRealtime.disconnect().catch(() => undefined);
    this.config.auth.bearerToken = null;
    this.config.auth.username = null;
    await saveConfig(this.config);
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.authUser = null;
    this.state.people.items = [];
    this.state.people.pageIndex = 0;
    this.state.profile = null;
    this.state.creations.items = [];
    this.state.creations.activity = [];
    this.state.creations.ascii = "";
    this.state.social.dmHandle = null;
    this.state.social.roomName = null;
    this.state.social.threadId = null;
    this.state.social.threadMessages = [];
    this.state.social.rooms = [];
    this.state.social.dms = [];
    this.state.feed.items = [];
    this.state.feed.ascii = "";
    this.state.loaded.people = false;
    this.state.loaded.social = false;
    this.state.loaded.notifications = false;
    this.state.loaded.feed = false;
    this.state.loaded.thread = false;
    this.state.loaded.profile = false;
    this.clearRealtimeState();
    this.#profileCache.clear();
    this.#profileLoadPromises.clear();
    this.#dmCache.clear();
    this.#dmLoadPromises.clear();
    this.#roomCache.clear();
    this.#roomLoadPromises.clear();
    this.#feedCache = null;
    this.#feedLoadPromise = null;
    this.#notificationsCache = null;
    this.#notificationsLoadPromise = null;
    this.#socialSummaryCache = null;
    this.#socialSummaryLoadPromise = null;
    this.#personStatsCache.clear();
    this.#personStatsPromises.clear();
    this.state.exports.lastSavedPath = null;
    this.state.view = "login";
    this.state.focus = "auth";
    this.#lastNonSlashFocus = "auth";
    this.state.actions.selectedIndex = 0;
    this.state.status = "api key removed";
    this.#parasceneRealtimeRetryAt = 0;
    this.schedulePersistUiCache();
    this.playUiSound("back");
  }

  async openProfile(handle: string): Promise<void> {
    this.ensureAuthenticated();
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    this.selectHandle(normalized);
    this.state.profile = await this.loadProfileCached(normalized);
    this.state.loaded.profile = true;
    this.state.view = "profile";
    this.state.focus = "left";
    this.#lastNonSlashFocus = "left";
    this.state.actions.selectedIndex = 0;
    this.state.status = `profile @${normalized}`;
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async openCreations(handle: string): Promise<void> {
    this.ensureAuthenticated();
    this.selectHandle(handle);
    await this.closePreview();
    this.state.exports.lastSavedPath = null;
    this.state.creations.ownerHandle = handle;
    this.state.creations.items = await this.#client.loadCreations(handle);
    this.state.creations.currentIndex = 0;
    this.state.view = "creation";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    await this.loadCurrentCreationDetail();
    this.state.status = `creations @${handle}`;
    this.syncParasceneRealtimeSubscriptions();
  }

  async nextCreation(): Promise<void> {
    if (!this.state.creations.items.length) {
      throw new Error("No creations loaded");
    }
    this.state.exports.lastSavedPath = null;
    this.state.creations.currentIndex = Math.min(
      this.state.creations.currentIndex + 1,
      this.state.creations.items.length - 1
    );
    await this.loadCurrentCreationDetail();
    if (this.state.previewOpen) {
      await this.openPreviewForCurrentArt();
    }
    this.state.status = `art ${this.state.creations.currentIndex + 1}/${this.state.creations.items.length}`;
    this.playUiSound("select");
  }

  async previousCreation(): Promise<void> {
    if (!this.state.creations.items.length) {
      throw new Error("No creations loaded");
    }
    this.state.exports.lastSavedPath = null;
    this.state.creations.currentIndex = Math.max(this.state.creations.currentIndex - 1, 0);
    await this.loadCurrentCreationDetail();
    if (this.state.previewOpen) {
      await this.openPreviewForCurrentArt();
    }
    this.state.status = `art ${this.state.creations.currentIndex + 1}/${this.state.creations.items.length}`;
    this.playUiSound("select");
  }

  async togglePreview(): Promise<void> {
    if (this.state.previewOpen) {
      await this.closePreview();
      this.state.status = "preview closed";
      return;
    }
    await this.openPreviewForCurrentArt();
    this.state.status = "preview open";
    this.playUiSound("select");
  }

  async toggleFullView(): Promise<void> {
    if (this.state.fullView.open) {
      this.state.fullView.open = false;
      this.state.status = "full view closed";
      return;
    }
    await this.refreshFullViewAscii();
    this.state.fullView.open = true;
    this.state.status = "full view";
    this.playUiSound("select");
  }

  assignCurrentCreationToSlot(slot: "A" | "B" | "C" | "D" | "E"): void {
    const current = this.currentCreation();
    if (!current) {
      throw new Error("No current creation");
    }
    const value: SlotValue = {
      creationId: current.id,
      title: current.title ?? null
    };
    this.state.slots[slot] = value;
    this.state.status = `assigned ${slot} -> ${current.title || current.id}`;
    this.playUiSound("select");
  }

  openSettings(): void {
    this.selectLeftEntry("settings");
    this.state.view = "settings";
    this.state.focus = "settings";
    this.#lastNonSlashFocus = "settings";
    this.state.actions.selectedIndex = 0;
    this.state.status = "settings";
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async toggleMute(): Promise<void> {
    this.config.audio.muted = !this.config.audio.muted;
    this.state.config.audio.muted = this.config.audio.muted;
    await saveConfig(this.config);
    this.state.status = this.config.audio.muted ? "sounds muted" : "sounds enabled";
  }

  async addComment(text: string): Promise<void> {
    this.ensureAuthenticated();
    const current = this.currentCreation();
    if (!current) {
      throw new Error("No current creation");
    }
    await this.#client.addComment(current.id, text);
    this.#activityCache.delete(current.id);
    await this.loadCurrentCreationDetail();
    this.clearComposerState();
    this.state.status = "comment posted";
    this.playUiSound("select");
  }

  async reactToComment(emoji: string, index: number): Promise<void> {
    this.ensureAuthenticated();
    const comments = this.state.creations.activity.filter((item) => item.type === "comment");
    const target = comments[index];
    if (!target) {
      throw new Error("No comment at that index");
    }
    await this.#client.reactToComment(target.id, emoji);
    const current = this.currentCreation();
    if (current) {
      this.#activityCache.delete(current.id);
    }
    await this.loadCurrentCreationDetail();
    this.state.status = `reacted ${emoji}`;
    this.playUiSound("select");
  }

  async openDm(handle: string): Promise<void> {
    this.ensureAuthenticated();
    const normalized = handle.replace(/^@/, "");
    this.selectHandle(normalized);
    const remembered = this.state.social.dms.find((entry) => entry.handle === normalized) || null;
    const data = await this.loadDmCached(normalized, true, remembered?.threadId);
    const nextDm = remembered && data.dm.displayName === data.dm.handle
      ? { ...data.dm, threadId: data.threadId, displayName: remembered.displayName, online: remembered.online }
      : data.dm;
    this.state.social.dmHandle = nextDm.handle;
    this.state.social.roomName = null;
    this.state.social.threadId = data.threadId;
    this.state.social.threadPageIndex = 0;
    this.state.social.threadMessages = data.messages;
    this.state.loaded.thread = true;
    this.rememberDm(nextDm);
    this.state.view = "dm";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `dm @${nextDm.handle}`;
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async sendDm(text: string): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.social.dmHandle) {
      throw new Error("No DM open");
    }
    let threadId = this.state.social.threadId;
    if (!threadId) {
      const remembered = this.state.social.dms.find((entry) => entry.handle === this.state.social.dmHandle) || null;
      const opened = await this.loadDmCached(this.state.social.dmHandle, true, remembered?.threadId);
      threadId = opened.threadId;
      this.state.social.threadId = threadId;
    }
    const data = await this.#client.sendDm(threadId, this.state.social.dmHandle, text);
    this.state.social.threadMessages = data.messages;
    this.state.social.threadId = data.threadId;
    this.state.social.threadPageIndex = 0;
    this.state.loaded.thread = true;
    this.rememberDm(data.dm);
    this.setCachedMapValue(this.#dmCache, data.dm.handle, {
      threadId: data.threadId,
      dm: data.dm,
      messages: data.messages
    });
    this.state.status = `dm sent @${data.dm.handle}`;
    this.schedulePersistUiCache();
    this.playUiSound("select");
  }

  async openRoom(roomName: string): Promise<void> {
    this.ensureAuthenticated();
    const normalized = roomName.trim().toLowerCase();
    const data = await this.loadRoomCached(normalized, true);
    this.state.social.roomName = data.room.name;
    this.state.social.dmHandle = null;
    this.state.social.threadId = data.threadId;
    this.state.social.threadPageIndex = 0;
    this.state.social.threadMessages = data.messages;
    this.state.loaded.thread = true;
    this.rememberRoom(data.room);
    this.selectRoom(data.room.name);
    this.state.view = "room";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `room ${data.room.name}`;
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async postRoomMessage(text: string): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.social.roomName) {
      throw new Error("No room open");
    }
    let threadId = this.state.social.threadId;
    if (!threadId) {
      const opened = await this.loadRoomCached(this.state.social.roomName, true);
      threadId = opened.threadId;
      this.state.social.threadId = threadId;
    }
    const data = await this.#client.postRoomMessage(threadId, this.state.social.roomName, text);
    this.state.social.threadMessages = data.messages;
    this.state.social.threadId = data.threadId;
    this.state.social.threadPageIndex = 0;
    this.state.loaded.thread = true;
    this.rememberRoom(data.room);
    this.setCachedMapValue(this.#roomCache, data.room.name, {
      threadId: data.threadId,
      room: data.room,
      messages: data.messages
    });
    this.state.status = `room post ${data.room.name}`;
    this.schedulePersistUiCache();
    this.playUiSound("select");
  }

  async openFeed(): Promise<void> {
    this.ensureAuthenticated();
    this.selectLeftEntry("feed");
    this.state.exports.lastSavedPath = null;
    this.state.feed.items = await this.loadFeedCached(true);
    this.state.feed.currentIndex = 0;
    this.state.loaded.feed = true;
    this.state.view = "feed";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    await this.loadCurrentFeedDetail();
    this.state.status = `feed ${this.state.feed.items.length}`;
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async openNotifications(): Promise<void> {
    this.ensureAuthenticated();
    this.selectLeftEntry("notifications");
    const data = await this.loadNotificationsCached(true);
    this.state.notifications.items = data.items;
    this.state.notifications.unreadCount = data.unreadCount;
    this.state.notifications.selectedIndex = 0;
    this.state.loaded.notifications = true;
    this.state.view = "notifications";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = this.state.notifications.unreadCount
      ? `notifications ${this.state.notifications.unreadCount} unread`
      : "notifications";
    this.schedulePersistUiCache();
    this.syncParasceneRealtimeSubscriptions();
  }

  async acknowledgeSelectedNotification(): Promise<void> {
    this.ensureAuthenticated();
    const current = this.state.notifications.items[this.state.notifications.selectedIndex];
    if (!current) {
      throw new Error("No notification selected");
    }
    if (current.acknowledged_at) {
      this.state.status = "notification already read";
      return;
    }
    await this.#client.acknowledgeNotification(current.id);
    await this.refreshNotifications();
    this.state.status = "notification marked read";
    this.playUiSound("select");
  }

  async acknowledgeAllNotifications(): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.notifications.items.length) {
      this.state.status = "no notifications";
      return;
    }
    await this.#client.acknowledgeAllNotifications();
    await this.refreshNotifications();
    this.state.status = "notifications marked read";
    this.playUiSound("select");
  }

  openRealtime(): void {
    this.state.view = "live";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = this.state.realtime.connected
      ? `live ${this.state.realtime.room || "connected"}`
      : "live offline";
    this.syncParasceneRealtimeSubscriptions();
  }

  async connectRealtime(room = "lobby"): Promise<void> {
    this.ensureAuthenticated();
    this.#realtime.setUrl(this.config.realtimeBaseUrl);
    await this.#realtime.connect(room, `${this.state.authUser.handle}-${Date.now().toString(36)}`);
    this.state.view = "live";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `live ${room}`;
    this.syncParasceneRealtimeSubscriptions();
    this.playUiSound("select");
  }

  async disconnectRealtime(): Promise<void> {
    await this.#realtime.disconnect();
    this.clearRealtimeState();
    this.state.status = "live offline";
    this.syncParasceneRealtimeSubscriptions();
  }

  async joinRealtimeRoom(room: string): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.realtime.connected) {
      await this.connectRealtime(room);
      return;
    }
    await this.#realtime.join(room);
    this.state.realtime.room = room;
    this.state.view = "live";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `live ${room}`;
    this.playUiSound("select");
  }

  async sendRealtimeRoomChat(text: string): Promise<void> {
    if (!this.state.realtime.connected) {
      throw new Error("Realtime is not connected");
    }
    await this.#realtime.sendRoomChat(text);
    this.state.status = `live room sent ${this.state.realtime.room || "room"}`;
    this.playUiSound("select");
  }

  async sendRealtimeDirect(handle: string, text: string): Promise<void> {
    const peer = this.findRealtimePeer(handle);
    if (!peer) {
      throw new Error(`No live peer for @${handle.replace(/^@/, "")}`);
    }
    await this.#realtime.sendDirectChat(peer.peerId, text);
    this.state.status = `live dm @${peer.handle}`;
    this.playUiSound("select");
  }

  async sendRealtimeSignal(
    handle: string,
    signalType: "offer" | "answer" | "candidate",
    payload: string,
    callId?: string | null
  ): Promise<void> {
    const peer = this.findRealtimePeer(handle);
    if (!peer) {
      throw new Error(`No live peer for @${handle.replace(/^@/, "")}`);
    }
    await this.#realtime.sendSignal(peer.peerId, signalType, payload, callId || null);
    this.state.status = `live signal ${signalType} @${peer.handle}`;
    this.playUiSound("select");
  }

  async nextFeed(): Promise<void> {
    if (!this.state.feed.items.length) {
      throw new Error("Feed is empty");
    }
    this.state.exports.lastSavedPath = null;
    this.state.feed.currentIndex = Math.min(this.state.feed.currentIndex + 1, this.state.feed.items.length - 1);
    await this.loadCurrentFeedDetail();
    this.state.status = `feed ${this.state.feed.currentIndex + 1}/${this.state.feed.items.length}`;
    this.playUiSound("select");
  }

  async previousFeed(): Promise<void> {
    if (!this.state.feed.items.length) {
      throw new Error("Feed is empty");
    }
    this.state.exports.lastSavedPath = null;
    this.state.feed.currentIndex = Math.max(this.state.feed.currentIndex - 1, 0);
    await this.loadCurrentFeedDetail();
    this.state.status = `feed ${this.state.feed.currentIndex + 1}/${this.state.feed.items.length}`;
    this.playUiSound("select");
  }

  async generatePrompt(options: {
    prompt: string;
    title?: string | null;
    server?: string | null;
    method?: string | null;
    share?: boolean;
  }): Promise<CreationSummary> {
    this.ensureAuthenticated();
    const image = await this.#client.generatePrompt(options);
    this.state.creations.ownerHandle = this.state.authUser.handle;
    this.state.creations.items = [image];
    this.state.creations.currentIndex = 0;
    this.state.view = "creation";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    await this.loadCurrentCreationDetail();
    this.state.status = `prompt ${image.title || "generated"}`;
    this.playUiSound("select");
    return image;
  }

  async saveCurrentArt(formatInput: string): Promise<string> {
    const format = normalizeFormat(formatInput);
    const creation = this.currentCreation() || this.currentFeedItem();
    if (!creation?.url) {
      throw new Error("No art to save");
    }

    const buffer = await this.#client.fetchImageBuffer(creation.url);
    const outputPath = await exportImageWithMetadata({
      buffer,
      directory: this.config.exports.directory,
      title: creation.title ?? null,
      ownerHandle: creation.ownerHandle || this.state.creations.ownerHandle || this.state.authUser?.handle || null,
      format,
      metadata: {
        source: "paratui",
        exportedAt: new Date().toISOString(),
        creationId: creation.id,
        title: creation.title ?? null,
        ownerHandle: creation.ownerHandle || this.state.creations.ownerHandle || this.state.authUser?.handle || null,
        description: creation.description ?? null,
        prompt: creation.prompt ?? null,
        serverBaseUrl: this.config.serverBaseUrl,
        originalUrl: creation.url ?? null,
        sourceMetadata: creation.metadata ?? null
      }
    });
    this.state.exports.lastSavedPath = outputPath;
    this.state.status = `saved ${path.basename(outputPath)}`;
    return outputPath;
  }

  async openSavedArt(): Promise<void> {
    const savedPath = this.state.exports.lastSavedPath;
    if (!savedPath) {
      throw new Error("No saved art yet");
    }
    await this.openExternalTarget(savedPath);
    this.state.status = `opened ${path.basename(savedPath)}`;
  }

  async openSavedArtFolder(): Promise<void> {
    const savedPath = this.state.exports.lastSavedPath;
    if (!savedPath) {
      throw new Error("No saved art yet");
    }
    await this.openExternalTarget(path.dirname(savedPath));
    this.state.status = `opened folder ${path.basename(path.dirname(savedPath))}`;
  }

  openSlash(): void {
    this.openSlashWithInput("/");
  }

  openSlashWithInput(input: string): void {
    this.state.authInput.active = false;
    if (this.state.focus !== "slash") {
      this.#lastNonSlashFocus = this.state.focus;
    }
    this.state.slash.open = true;
    this.state.slash.input = input;
    this.state.slash.selectedIndex = 0;
    this.state.focus = "slash";
    this.state.status = "slash";
  }

  startApiKeyEntry(initialDraft = ""): void {
    this.state.view = "login";
    this.state.focus = "auth";
    this.#lastNonSlashFocus = "auth";
    this.state.authInput.active = true;
    this.state.authInput.draft = initialDraft;
    this.state.actions.selectedIndex = 0;
    this.state.status = initialDraft ? "paste api key" : "api key input";
  }

  startCommentComposer(initialDraft = ""): void {
    const returnFocus = this.state.focus;
    this.state.composer.active = true;
    this.state.composer.kind = "comment";
    this.state.composer.text = initialDraft;
    this.state.composer.returnFocus = returnFocus;
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.status = initialDraft ? "edit comment" : "comment input";
  }

  startChatComposer(kind: "room" | "dm", initialDraft = ""): void {
    const returnFocus = this.state.focus;
    this.state.composer.active = true;
    this.state.composer.kind = kind;
    this.state.composer.text = initialDraft;
    this.state.composer.returnFocus = returnFocus;
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.status = initialDraft ? `${kind} draft` : `${kind} input`;
  }

  startRoomJoinComposer(initialDraft = ""): void {
    const returnFocus = this.state.focus;
    this.state.composer.active = true;
    this.state.composer.kind = "room_join";
    this.state.composer.text = initialDraft;
    this.state.composer.returnFocus = returnFocus;
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.status = initialDraft ? "room draft" : "join room";
  }

  cancelApiKeyEntry(): void {
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.focus = "auth";
    this.#lastNonSlashFocus = "auth";
    this.state.status = "api key input cancelled";
  }

  cancelComposer(): void {
    const cancelledKind = this.state.composer.kind;
    this.clearComposerState(cancelledKind !== "room_join");
    if (cancelledKind === "room_join") {
      this.state.focus = "left";
      this.#lastNonSlashFocus = "left";
      this.state.status = "room join cancelled";
      return;
    }
    this.state.status = cancelledKind === "dm"
      ? "dm cancelled"
      : cancelledKind === "room"
        ? "chat cancelled"
        : "comment cancelled";
  }

  async submitApiKeyDraft(): Promise<void> {
    if (!this.state.authInput.draft.trim()) {
      throw new Error("Paste an API key first");
    }
    await this.setApiKey(this.state.authInput.draft);
  }

  async submitComposer(): Promise<void> {
    const text = this.state.composer.text.trim();
    if (!text) {
      throw new Error("Type something first");
    }
    if (this.state.composer.kind !== "room_join" && await this.tryShareImageInput(text, { clearComposer: true })) {
      return;
    }
    if (this.state.composer.kind === "comment") {
      await this.addComment(text);
      return;
    }
    if (this.state.composer.kind === "room") {
      await this.postRoomMessage(text);
      this.clearComposerState();
      return;
    }
    if (this.state.composer.kind === "dm") {
      await this.sendDm(text);
      this.clearComposerState();
      return;
    }
    if (this.state.composer.kind === "room_join") {
      this.clearComposerState(false);
      await this.openRoom(text);
      return;
    }
  }

  async shareImageInput(text: string): Promise<boolean> {
    return this.tryShareImageInput(text);
  }

  async openApiKeyHelp(): Promise<void> {
    const url = "https://www.parascene.com/help/developer/api";
    await this.openExternalTarget(url);
    if (this.state.status !== url) {
      this.state.status = "opened api key help";
      this.playUiSound("select");
    }
  }

  private async openExternalTarget(target: string): Promise<void> {
    if (this.config.preview.disableExternalOpen) {
      this.state.status = target;
      return;
    }

    const opener = process.platform === "darwin"
      ? { command: "open", args: [target] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", target] }
        : { command: "xdg-open", args: [target] };

    try {
      const child = spawn(opener.command, opener.args, {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    } catch {
      this.state.status = target;
    }
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    const overridePath = process.env.PARATUI_TEST_CLIPBOARD_FILE;
    if (overridePath) {
      await fs.writeFile(overridePath, text, "utf8");
      return true;
    }

    const candidates = process.platform === "darwin"
      ? [{ command: "pbcopy", args: [] as string[] }]
      : process.platform === "win32"
        ? [{ command: "cmd", args: ["/c", "clip"] }]
        : [
            { command: "wl-copy", args: [] as string[] },
            { command: "xclip", args: ["-selection", "clipboard"] },
            { command: "xsel", args: ["--clipboard", "--input"] }
          ];

    for (const candidate of candidates) {
      const copied = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn(candidate.command, candidate.args, {
            stdio: ["pipe", "ignore", "ignore"]
          });
          child.once("error", () => resolve(false));
          child.once("close", (code) => resolve(code === 0));
          child.stdin.end(text);
        } catch {
          resolve(false);
        }
      });
      if (copied) {
        return true;
      }
    }

    return false;
  }

  async cancel(): Promise<void> {
    if (this.state.composer.active) {
      this.cancelComposer();
      return;
    }

    if (this.state.authInput.active) {
      this.cancelApiKeyEntry();
      return;
    }

    if (this.state.slash.open) {
      this.closeSlash();
      this.state.status = "slash cancelled";
      return;
    }

    if (this.state.view === "settings") {
      const fallbackHandle = this.currentSelectedHandle() || this.state.profile?.profile.user_name || this.state.authUser?.handle || null;
      if (fallbackHandle) {
        await this.openProfile(fallbackHandle);
      } else {
        this.state.view = "profile";
      }
      this.state.status = "back";
      return;
    }

    if (this.state.view === "creation" && this.state.creations.ownerHandle) {
      await this.openProfile(this.state.creations.ownerHandle);
      this.state.status = "back";
      return;
    }

    const fallbackHandle = this.currentSelectedHandle() || this.state.profile?.profile.user_name || this.state.authUser?.handle || null;
    if ((this.state.view === "dm" || this.state.view === "room" || this.state.view === "feed" || this.state.view === "live") && fallbackHandle) {
      await this.openProfile(fallbackHandle);
      this.state.status = "back";
    }
  }

  async executeCommand(parsed: ParsedCommand): Promise<void> {
    const command = this.commands.find((item) => item.path === parsed.path);
    if (!command) {
      throw new Error(`Unknown command: ${parsed.path}`);
    }
    await command.run(this, parsed);
  }

  async executeCommandString(line: string): Promise<void> {
    const parsed = parseCommandText(line);
    await this.executeCommand(parsed);
    this.closeSlash();
    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
  }

  async runMacroFile(macroPath: string): Promise<void> {
    this.bridge.emit({ type: "macro:start", path: macroPath });
    try {
      await runMacroFile(this, macroPath);
      this.render();
      this.bridge.emit({ type: "macro:success", path: macroPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bridge.emit({ type: "macro:error", path: macroPath, error: message });
      throw error;
    }
  }

  async runInteractive(): Promise<void> {
    this.#runningInteractive = true;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    this.activateTerminalUi();
    this.startPeopleRefreshLoop();
    this.render();

    const onResize = () => {
      this.#viewport = this.readViewport();
      if (this.state.fullView.open) {
        void this.refreshFullViewAscii().catch(() => undefined);
      }
      this.render();
      this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
      void this.refreshVisibleAsciiForViewport()
        .then(() => {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
        })
        .catch(() => undefined);
    };

    if (process.stdout.isTTY) {
      process.stdout.on("resize", onResize);
    }

    const onKeypress = async (str: string, key: readline.Key) => {
      try {
        this.#inputSeq += 1;
        if (key.ctrl && key.name === "c") {
          this.shutdown();
          return;
        }

        if (this.state.fullView.open) {
          this.state.fullView.open = false;
          this.state.status = "full view closed";
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (this.state.authInput.active) {
          if (key.name === "escape") {
            this.cancelApiKeyEntry();
          } else if (key.name === "backspace") {
            this.state.authInput.draft = this.state.authInput.draft.slice(0, -1);
          } else if (key.name === "return") {
            await this.submitApiKeyDraft();
            this.render();
            this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
            return;
          } else if (str && !key.ctrl && !key.meta) {
            this.state.authInput.draft += str.replace(/[\r\n]/g, "");
          }
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (
          str &&
          str.length > 1 &&
          !key.ctrl &&
          !key.meta &&
          this.state.authUser &&
          !this.state.slash.open &&
          await this.tryShareImageInput(str)
        ) {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (
          this.testSlashEnabled()
          && !this.state.slash.open
          && !this.state.composer.active
          && str === "/"
          && !key.ctrl
          && !key.meta
        ) {
          this.openSlash();
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (this.testSlashEnabled() && this.state.slash.open) {
          if (key.name === "escape") {
            this.closeSlash();
            this.state.status = "command cancelled";
          } else if (key.name === "backspace") {
            this.state.slash.input = this.state.slash.input.length > 1
              ? this.state.slash.input.slice(0, -1)
              : "/";
            this.state.slash.selectedIndex = 0;
          } else if (key.name === "return") {
            await this.submitSlashSelection();
            return;
          } else if (key.name === "tab") {
            this.completeSlashInput();
          } else if (key.name === "left") {
            this.moveSlashSelection(-1);
          } else if (key.name === "right") {
            this.moveSlashSelection(1);
          } else if (str && !key.ctrl && !key.meta) {
            this.state.slash.input += str.replace(/[\r\n]/g, "");
            this.state.slash.selectedIndex = 0;
            this.state.status = this.selectedSlashCommand()?.path || this.state.slash.input;
          }
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (
          str &&
          !key.ctrl &&
          !key.meta &&
          !this.state.composer.active &&
          this.beginContextInput(str.replace(/[\r\n]/g, ""))
        ) {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (this.state.composer.active) {
          if (key.name === "escape") {
            this.cancelComposer();
          } else if (key.name === "backspace") {
            this.state.composer.text = this.state.composer.text.slice(0, -1);
          } else if (key.name === "return") {
            await this.submitComposer();
            this.render();
            this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
            return;
          } else if (str && !key.ctrl && !key.meta) {
            this.state.composer.text += str.replace(/[\r\n]/g, "");
          }
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (!this.state.authUser && this.state.view === "login") {
          if (key.name === "return") {
            await this.invokeFocusedAction();
            this.render();
            this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
            return;
          }
          if ((str || "").toLowerCase() === "p") {
            this.startApiKeyEntry();
            this.render();
            this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
            return;
          }
        }

        if (key.name === "tab" && key.shift) {
          this.cycleFocus(true);
        } else if (key.name === "tab") {
          this.cycleFocus(false);
        } else if (key.name === "up" && this.state.focus === "left") {
          await this.movePersonSelection(-1);
        } else if (key.name === "down" && this.state.focus === "left") {
          await this.movePersonSelection(1);
        } else if (key.name === "left" && this.state.focus === "left" && this.currentLeftSelection()?.kind === "people_page") {
          this.changePeoplePage(-1);
        } else if (key.name === "right" && this.state.focus === "left" && this.currentLeftSelection()?.kind === "people_page") {
          this.changePeoplePage(1);
        } else if (key.name === "left" && this.pageThreadHistory(-1)) {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        } else if (key.name === "right" && this.pageThreadHistory(1)) {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        } else if (key.name === "up" && this.state.focus !== "left") {
          this.moveFocusAction(-1);
        } else if (key.name === "down" && this.state.focus !== "left") {
          this.moveFocusAction(1);
        } else if ((key.name === "return" || key.name === "space")) {
          await this.invokeFocusedAction();
        } else if (key.name === "right" && this.state.focus === "left") {
          const selection = this.currentLeftSelection();
          if (selection?.kind === "person" && selection.handle) {
            await this.openCreations(selection.handle);
          } else if (selection?.kind === "room" && selection.roomName) {
            await this.openRoom(selection.roomName);
          } else if (selection?.kind === "new-room") {
            this.startRoomJoinComposer();
          }
        } else if (key.name === "left" && this.state.view === "creation") {
          await this.previousCreation();
        } else if (key.name === "right" && this.state.view === "creation") {
          await this.nextCreation();
        } else if (key.name === "left" && this.state.view === "feed") {
          await this.previousFeed();
        } else if (key.name === "right" && this.state.view === "feed") {
          await this.nextFeed();
        } else if (key.name === "escape") {
          await this.cancel();
        } else if (!this.state.authUser && this.state.view === "login" && str && !key.ctrl && !key.meta) {
          const nextDraft = `${this.state.authInput.draft}${str}`.trim();
          if (nextDraft.startsWith("psn_")) {
            this.startApiKeyEntry(nextDraft);
          }
        }

        this.render();
        this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
      } catch (error) {
        this.state.status = this.formatUiError(error);
        this.render();
        this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
      }
    };

    process.stdin.on("keypress", onKeypress);
    await new Promise<void>((resolve) => {
      this.#interactiveResolver = resolve;
    });
    process.stdin.off("keypress", onKeypress);
    if (process.stdout.isTTY) {
      process.stdout.off("resize", onResize);
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    this.#runningInteractive = false;
  }

  render(): void {
    if (this.options.headless) {
      return;
    }
    if (!this.#terminalUiActive) {
      this.bridge.emit({ type: "state", snapshot: this.snapshot() });
      return;
    }
    this.#viewport = this.readViewport();
    const screen = renderApp(this.state, this.commands, this.#viewport);
    this.paintScreen(screen);
    this.bridge.emit({ type: "state", snapshot: this.snapshot() });
  }

  shutdown(): void {
    void this.#realtime.disconnect().catch(() => undefined);
    void this.#parasceneRealtime.disconnect().catch(() => undefined);
    this.stopPeopleRefreshLoop();
    if (this.#persistUiCacheTimer) {
      clearTimeout(this.#persistUiCacheTimer);
      this.#persistUiCacheTimer = null;
    }
    void this.persistUiCacheNow().catch(() => undefined);
    this.deactivateTerminalUi();
    if (this.#runningInteractive && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    this.#runningInteractive = false;
    this.bridge.close();
    if (this.#interactiveResolver) {
      this.#interactiveResolver();
      this.#interactiveResolver = null;
    }
  }

  private playUiSound(_kind: "focus" | "select" | "back"): void {
    void _kind;
    if (this.options.headless || this.config.audio.muted) {
      return;
    }
  }

  private async loadCurrentCreationDetail(): Promise<void> {
    const current = this.currentCreation();
    if (!current) {
      this.state.creations.ascii = "";
      this.state.creations.activity = [];
      return;
    }

    const asciiSize = this.currentCreationAsciiSize();
    const asciiPromise = current.url
      ? this.asciiCache.get(current.url, asciiSize, () => this.#client.fetchImageBuffer(current.url!))
      : Promise.resolve("(no image)");
    const activityPromise = this.getCreationActivity(current.id);
    const [ascii, activity] = await Promise.all([asciiPromise, activityPromise]);
    this.state.creations.ascii = ascii;
    this.state.creations.activity = activity;
    this.state.creations.selectedCommentIndex = Math.max(0, Math.min(this.state.creations.selectedCommentIndex, Math.max(0, activity.length - 1)));
    this.state.creations.commentScrollOffset = Math.max(0, Math.min(this.state.creations.commentScrollOffset, this.state.creations.selectedCommentIndex));
    this.state.creations.selectionMode = activity.length ? "comments" : "actions";
    this.preloadCreationNeighborhood();
  }

  private async loadCurrentFeedDetail(): Promise<void> {
    const current = this.currentFeedItem();
    if (!current) {
      this.state.feed.ascii = "";
      return;
    }
    const asciiSize = this.currentFeedAsciiSize();
    this.state.feed.ascii = current.url
      ? await this.asciiCache.get(current.url, asciiSize, () => this.#client.fetchImageBuffer(current.url!))
      : "(no image)";
    this.preloadFeedNeighborhood();
  }

  private currentCreationAsciiSize(): AsciiRenderSize {
    const layout = calculateLayout(this.#viewport);
    const availableWidth = layout.mode === "columns" ? layout.centerWidth : layout.contentWidth;
    const commentRows = Math.min(this.state.creations.activity.length, 4);
    const footerRows = this.state.composer.active && this.state.composer.kind === "comment"
      ? 3
      : getFocusActions(this.state, "center").length + 1;
    const reservedRows = (commentRows ? commentRows + 1 : 0) + footerRows + 1;
    return {
      width: Math.max(18, availableWidth - 2),
      height: Math.max(8, layout.bodyHeight - reservedRows)
    };
  }

  private currentFeedAsciiSize(): AsciiRenderSize {
    const layout = calculateLayout(this.#viewport);
    const availableWidth = layout.mode === "columns" ? layout.centerWidth : layout.contentWidth;
    const footerRows = getFocusActions(this.state, "center").length + 1;
    const reservedRows = footerRows + 3;
    return {
      width: Math.max(18, availableWidth - 2),
      height: Math.max(8, layout.bodyHeight - reservedRows)
    };
  }

  private currentFullAsciiSize(): AsciiRenderSize {
    return {
      width: Math.max(24, this.#viewport.columns - 2),
      height: Math.max(8, this.#viewport.rows - 2)
    };
  }

  private getCreationActivity(creationId: number): Promise<ActivityItem[]> {
    if (!this.#activityCache.has(creationId)) {
      this.#activityCache.set(
        creationId,
        this.#client.loadActivity(creationId).then((activity) => activity.items)
      );
      while (this.#activityCache.size > 64) {
        const oldestKey = this.#activityCache.keys().next().value;
        if (oldestKey == null) {
          break;
        }
        this.#activityCache.delete(oldestKey);
      }
    }
    const cached = this.#activityCache.get(creationId)!;
    this.#activityCache.delete(creationId);
    this.#activityCache.set(creationId, cached);
    return cached;
  }

  private preloadCreationNeighborhood(radius = 2): void {
    const asciiSize = this.currentCreationAsciiSize();
    for (let offset = 1; offset <= radius; offset += 1) {
      for (const index of [this.state.creations.currentIndex - offset, this.state.creations.currentIndex + offset]) {
        const item = this.state.creations.items[index];
        if (!item) {
          continue;
        }
        if (item.url) {
          void this.asciiCache.get(item.url, asciiSize, () => this.#client.fetchImageBuffer(item.url!)).catch(() => undefined);
        }
        void this.getCreationActivity(item.id).catch(() => undefined);
      }
    }
  }

  private preloadFeedNeighborhood(radius = 2): void {
    const asciiSize = this.currentFeedAsciiSize();
    for (let offset = 1; offset <= radius; offset += 1) {
      for (const index of [this.state.feed.currentIndex - offset, this.state.feed.currentIndex + offset]) {
        const item = this.state.feed.items[index];
        if (!item?.url) {
          continue;
        }
        void this.asciiCache.get(item.url, asciiSize, () => this.#client.fetchImageBuffer(item.url!)).catch(() => undefined);
      }
    }
  }

  private async refreshVisibleAsciiForViewport(): Promise<void> {
    if (this.state.view === "creation") {
      const current = this.currentCreation();
      if (current?.url) {
        this.state.creations.ascii = await this.asciiCache.get(
          current.url,
          this.currentCreationAsciiSize(),
          () => this.#client.fetchImageBuffer(current.url!)
        );
        this.preloadCreationNeighborhood();
      }
      return;
    }

    if (this.state.view === "feed") {
      const current = this.currentFeedItem();
      if (current?.url) {
        this.state.feed.ascii = await this.asciiCache.get(
          current.url,
          this.currentFeedAsciiSize(),
          () => this.#client.fetchImageBuffer(current.url!)
        );
        this.preloadFeedNeighborhood();
      }
    }
  }

  private async refreshFullViewAscii(): Promise<void> {
    const creation = this.currentCreation() || this.currentFeedItem();
    if (!creation?.url) {
      this.state.fullView.ascii = "";
      return;
    }
    this.state.fullView.ascii = await this.asciiCache.get(
      creation.url,
      this.currentFullAsciiSize(),
      () => this.#client.fetchImageBuffer(creation.url!)
    );
  }

  private async loadSocialLists(): Promise<void> {
    if (!this.state.authUser) {
      return;
    }
    const { rooms, dms } = await this.loadSocialSummariesCached(true).catch(() => ({
      rooms: [],
      dms: []
    }));
    this.applySocialSummaries(rooms, dms);
  }

  private rememberDm(dm: DmSummary): void {
    const previousKey = this.currentLeftSelectionKey();
    const next = [...this.state.social.dms];
    const existingIndex = next.findIndex((entry) => entry.handle === dm.handle);
    if (existingIndex >= 0) {
      next[existingIndex] = dm;
    } else {
      next.push(dm);
    }
    this.state.social.dms = next
      .slice(0, 24)
      .sort((left, right) => this.peopleSortKeyTimestamp(right.lastMessageAt) - this.peopleSortKeyTimestamp(left.lastMessageAt));
    this.state.people.items = this.mergePeopleCandidates(this.state.people.items);
    if (previousKey) {
      this.setLeftSelectionByKey(previousKey);
    }
    this.schedulePersistUiCache();
  }

  private rememberRoom(room: RoomSummary): void {
    const previousKey = this.currentLeftSelectionKey();
    const next = [...this.state.social.rooms];
    const existingIndex = next.findIndex((entry) => entry.name === room.name);
    if (existingIndex >= 0) {
      next[existingIndex] = room;
    } else {
      next.push(room);
    }
    this.state.social.rooms = mergeRoomSummaries(
      next.slice(0, 24),
      this.config.social.recentRooms.map((roomName) => recentRoomSummary(roomName))
    );
    this.config.social.recentRooms = this.state.social.rooms.map((entry) => entry.name).slice(0, 12);
    if (previousKey) {
      this.setLeftSelectionByKey(previousKey);
    }
    this.schedulePersistUiCache();
  }

  private applySocialSummaries(rooms: RoomSummary[], dms: DmSummary[]): void {
    const previousKey = this.currentLeftSelectionKey();
    this.state.social.rooms = mergeRoomSummaries(
      rooms,
      this.config.social.recentRooms.map((roomName) => recentRoomSummary(roomName))
    );
    this.state.social.dms = [...dms];
    this.state.loaded.social = true;
    this.state.people.items = this.mergePeopleCandidates(this.state.people.items);
    if (previousKey) {
      this.setLeftSelectionByKey(previousKey);
    } else {
      this.selectedLeftEntryWithinBounds();
    }
    this.schedulePersistUiCache();
  }

  private async refreshPeoplePresence(): Promise<boolean> {
    this.ensureAuthenticated();
    const people = await this.#client.listPresenceUsers();
    if (!people) {
      return false;
    }
    const previousKey = this.currentLeftSelectionKey();
    const before = this.peopleSignature();
    const presenceByHandle = new Map(
      people.map((person) => [person.handle, person] as const)
    );
    this.state.people.items = this.state.people.items.map((person) => {
      const presence = presenceByHandle.get(person.handle);
      if (!presence) {
        return person;
      }
      return {
        ...person,
        online: presence.online,
        lastActiveAt: presence.lastActiveAt
      };
    });
    this.state.social.dms = this.state.social.dms.map((dm) => {
      const presence = presenceByHandle.get(dm.handle);
      return {
        ...dm,
        online: presence?.online || false
      };
    });
    if (previousKey) {
      this.setLeftSelectionByKey(previousKey);
    }
    this.schedulePersistUiCache();
    return before !== this.peopleSignature();
  }

  private async refreshSocialSummary(): Promise<boolean> {
    this.ensureAuthenticated();
    const before = JSON.stringify({
      rooms: this.state.social.rooms.map((room) => [room.name, room.lastMessageAt, room.lastMessageText]),
      dms: this.state.social.dms.map((dm) => [dm.handle, dm.lastMessageAt, dm.lastMessageText])
    });
    const social = await this.loadSocialSummariesCached(true);
    this.applySocialSummaries(social.rooms, social.dms);
    const after = JSON.stringify({
      rooms: this.state.social.rooms.map((room) => [room.name, room.lastMessageAt, room.lastMessageText]),
      dms: this.state.social.dms.map((dm) => [dm.handle, dm.lastMessageAt, dm.lastMessageText])
    });
    this.schedulePersistUiCache();
    return before !== after;
  }

  private async refreshNotificationSummary(): Promise<boolean> {
    this.ensureAuthenticated();
    const before = this.state.notifications.unreadCount;
    const unreadCount = await this.#client.loadNotificationUnreadCount();
    this.state.notifications.unreadCount = unreadCount;
    if (this.#notificationsCache) {
      this.#notificationsCache = {
        value: {
          items: this.#notificationsCache.value.items,
          unreadCount
        },
        updatedAt: Date.now()
      };
    }
    this.schedulePersistUiCache();
    return unreadCount !== before;
  }

  private kickAuthenticatedBackgroundHydration(): void {
    if (!this.state.authUser) {
      return;
    }

    void Promise.allSettled([
      this.refreshPeople(),
      this.loadSocialLists(),
      this.refreshNotifications()
    ]).then(() => {
      if (!this.state.authUser) {
        return;
      }
      this.render();
      this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
    });
  }

  private explicitParasceneRealtimeConfig(): ParasceneRealtimeConfig | null {
    const url = String(this.config.parasceneRealtime.url || "").trim();
    const anonKey = String(this.config.parasceneRealtime.anonKey || "").trim();
    if (!url || !anonKey) {
      return null;
    }
    return {
      url,
      anonKey
    };
  }

  private shouldEnableParasceneRealtime(): boolean {
    return Boolean(
      this.config.parasceneRealtime.enabled
      && this.state.authUser
      && this.config.auth.bearerToken
    );
  }

  private currentParasceneRealtimeThreadId(): number | null {
    if ((this.state.view === "room" || this.state.view === "dm") && this.state.social.threadId) {
      return this.state.social.threadId;
    }
    return null;
  }

  private ensureParasceneRealtime(): void {
    if (!this.shouldEnableParasceneRealtime()) {
      this.#parasceneRealtimeRetryAt = 0;
      void this.#parasceneRealtime.disconnect().catch(() => undefined);
      return;
    }
    if (this.#parasceneRealtime.connected()) {
      return;
    }
    if (this.#parasceneRealtimeBootstrapPromise || Date.now() < this.#parasceneRealtimeRetryAt) {
      return;
    }

    const userId = this.state.authUser?.id || 0;
    const token = this.config.auth.bearerToken || "";
    this.#parasceneRealtimeBootstrapPromise = this.#client.bootstrapHostedRealtime(this.explicitParasceneRealtimeConfig())
      .then(async (bootstrap) => {
        if (!bootstrap || !this.state.authUser || this.config.auth.bearerToken !== token || this.state.authUser.id !== userId) {
          throw new Error("Hosted realtime unavailable");
        }
        const connected = await this.#parasceneRealtime.connect(bootstrap.config, bootstrap.session, userId);
        if (!connected) {
          throw new Error("Hosted realtime unavailable");
        }
        await this.#parasceneRealtime.setThread(this.currentParasceneRealtimeThreadId());
        this.#parasceneRealtimeRetryAt = 0;
        return true;
      })
      .catch(() => {
        this.#parasceneRealtimeRetryAt = Date.now() + 60_000;
        return false;
      })
      .finally(() => {
        this.#parasceneRealtimeBootstrapPromise = null;
      });
  }

  private syncParasceneRealtimeSubscriptions(): void {
    if (!this.shouldEnableParasceneRealtime()) {
      void this.#parasceneRealtime.setThread(null).catch(() => undefined);
      return;
    }
    if (!this.#parasceneRealtime.connected()) {
      this.ensureParasceneRealtime();
    }
    if (!this.#parasceneRealtime.connected()) {
      return;
    }
    void this.#parasceneRealtime.setThread(this.currentParasceneRealtimeThreadId()).catch(() => undefined);
  }

  private queueParasceneUserRefresh(): void {
    if (this.#parasceneUserRefreshPromise) {
      this.#parasceneUserRefreshQueued = true;
      return;
    }
    this.#parasceneUserRefreshPromise = this.runParasceneUserRefresh()
      .catch(() => undefined)
      .finally(() => {
        this.#parasceneUserRefreshPromise = null;
        if (this.#parasceneUserRefreshQueued) {
          this.#parasceneUserRefreshQueued = false;
          this.queueParasceneUserRefresh();
        }
      });
  }

  private async runParasceneUserRefresh(): Promise<void> {
    if (!this.state.authUser) {
      return;
    }
    const [peopleChanged, notificationChanged, socialChanged] = await Promise.all([
      this.refreshPeoplePresence().catch(() => false),
      this.refreshNotificationSummary().catch(() => false),
      this.refreshSocialSummary().catch(() => false)
    ]);
    if (this.state.view === "notifications") {
      await this.refreshNotifications().catch(() => undefined);
    }
    if (!peopleChanged && !notificationChanged && !socialChanged) {
      return;
    }
    this.prefetchVisiblePersonStats();
    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
  }

  private queueParasceneThreadRefresh(threadId: number): void {
    if (this.#parasceneThreadRefreshPromise) {
      this.#parasceneThreadRefreshQueuedThreadId = threadId;
      return;
    }
    this.#parasceneThreadRefreshPromise = this.runParasceneThreadRefresh(threadId)
      .catch(() => undefined)
      .finally(() => {
        this.#parasceneThreadRefreshPromise = null;
        const queued = this.#parasceneThreadRefreshQueuedThreadId;
        this.#parasceneThreadRefreshQueuedThreadId = null;
        if (queued != null) {
          this.queueParasceneThreadRefresh(queued);
        }
      });
  }

  private async runParasceneThreadRefresh(threadId: number): Promise<void> {
    if (!this.state.authUser || this.state.social.threadId !== threadId || (this.state.view !== "room" && this.state.view !== "dm")) {
      return;
    }

    if (this.state.view === "room" && this.state.social.roomName) {
      const roomName = this.state.social.roomName;
      const data = await this.loadRoomCached(roomName, true);
      if (this.state.view !== "room" || this.state.social.roomName !== roomName || this.state.social.threadId !== threadId) {
        return;
      }
      this.state.social.threadId = data.threadId;
      this.state.social.threadMessages = data.messages;
      this.rememberRoom(data.room);
    } else if (this.state.view === "dm" && this.state.social.dmHandle) {
      const handle = this.state.social.dmHandle;
      const remembered = this.state.social.dms.find((item) => item.handle === handle) || null;
      const data = await this.loadDmCached(handle, true, remembered?.threadId);
      if (this.state.view !== "dm" || this.state.social.dmHandle !== handle || this.state.social.threadId !== threadId) {
        return;
      }
      const nextDm = remembered && data.dm.displayName === data.dm.handle
        ? { ...data.dm, threadId: data.threadId, displayName: remembered.displayName, online: remembered.online }
        : data.dm;
      this.state.social.threadId = data.threadId;
      this.state.social.threadMessages = data.messages;
      this.rememberDm(nextDm);
    } else {
      return;
    }

    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
  }

  private showCachedModeStatus(message: string): void {
    if (!this.state.authUser || this.options.headless) {
      return;
    }
    this.state.status = message;
    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
  }

  private applyPeopleList(people: CliUserSummary[]): void {
    const previousKey = this.currentLeftSelectionKey();
    this.state.people.items = this.mergePeopleCandidates(people);
    this.state.loaded.people = true;
    if (previousKey) {
      if (this.setLeftSelectionByKey(previousKey)) {
        this.schedulePersistUiCache();
        return;
      }
    }
    const preferredHandle = this.state.authUser?.handle || this.state.people.items[0]?.handle || null;
    if (preferredHandle && this.setLeftSelectionByKey(`person:${preferredHandle}`)) {
      this.schedulePersistUiCache();
      return;
    }
    this.state.people.pageIndex = 0;
    this.selectedLeftEntryWithinBounds();
    this.schedulePersistUiCache();
  }

  private startPeopleRefreshLoop(): void {
    this.stopPeopleRefreshLoop();
    this.#pollTick = 0;
    this.#peopleRefreshTimer = setInterval(() => {
      if (!this.state.authUser) {
        return;
      }
      this.#pollTick += 1;
      const enhancedRealtime = this.#parasceneRealtime.connected();
      const shouldPollSummary = !enhancedRealtime || this.#pollTick % 3 === 0;
      void Promise.all([
        this.refreshPeoplePresence().catch(() => false),
        shouldPollSummary
          ? this.refreshNotificationSummary().catch(() => false)
          : Promise.resolve(false),
        shouldPollSummary
          ? this.refreshSocialSummary().catch(() => false)
          : Promise.resolve(false)
      ])
        .then(([peopleChanged, notificationChanged, socialChanged]) => {
          if (!peopleChanged && !notificationChanged && !socialChanged) {
            return;
          }
          if (this.state.view === "notifications") {
            void this.refreshNotifications().catch(() => undefined);
          }
          this.prefetchVisiblePersonStats();
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
        })
        .catch(() => undefined);
    }, 10_000);
  }

  private stopPeopleRefreshLoop(): void {
    if (!this.#peopleRefreshTimer) {
      if (this.#leftPrefetchTimer) {
        clearTimeout(this.#leftPrefetchTimer);
        this.#leftPrefetchTimer = null;
      }
      return;
    }
    clearInterval(this.#peopleRefreshTimer);
    this.#peopleRefreshTimer = null;
    if (this.#leftPrefetchTimer) {
      clearTimeout(this.#leftPrefetchTimer);
      this.#leftPrefetchTimer = null;
    }
  }

  private activateTerminalUi(): void {
    if (this.options.headless || this.#terminalUiActive) {
      return;
    }
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H");
    this.#terminalUiActive = true;
    this.#lastRenderedLines = [];
    this.#lastRenderedViewport = null;
  }

  private deactivateTerminalUi(): void {
    if (this.options.headless || !this.#terminalUiActive) {
      return;
    }
    process.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    this.#terminalUiActive = false;
    this.#lastRenderedLines = [];
    this.#lastRenderedViewport = null;
  }

  private peopleSignature(): string {
    return JSON.stringify(this.state.people.items.map((person) => ({
      handle: person.handle,
      online: person.online,
      lastActiveAt: person.lastActiveAt
    })));
  }

  private ensureAuthenticated(): asserts this is this & { state: { authUser: CliAuthUser } } {
    if (!this.state.authUser) {
      throw new Error("Not authenticated");
    }
  }

  private findRealtimePeer(handle: string): RealtimePeerSummary | null {
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    return this.state.realtime.peers.find((peer) => peer.handle.toLowerCase() === normalized) || null;
  }

  private clearRealtimeState(): void {
    this.state.realtime.connected = false;
    this.state.realtime.room = null;
    this.state.realtime.selfPeerId = null;
    this.state.realtime.peers = [];
    this.state.realtime.messages = [];
    this.state.realtime.iceServerCount = 0;
    this.state.realtime.lastSignalType = null;
  }

  private pushRealtimeMessage(message: RealtimeMessage): void {
    this.state.realtime.messages = [...this.state.realtime.messages.slice(-39), message];
  }

  private renderRealtimeEvent(): void {
    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
  }

  private async tryShareImageInput(text: string, options: {
    clearComposer?: boolean;
  } = {}): Promise<boolean> {
    if (!this.state.authUser) {
      return false;
    }

    const filePath = await this.resolveImageInputPath(text);
    if (!filePath) {
      return false;
    }

    const labels = deriveUploadLabels(filePath);
    this.state.status = `uploading ${path.basename(filePath)}`;
    this.render();
    this.bridge.emit({ type: "idle", snapshot: this.snapshot() });

    const buffer = await fs.readFile(filePath);
    const result = await this.#client.uploadImageBufferAsPublic({
      buffer,
      filename: path.basename(filePath),
      title: labels.title,
      description: labels.description
    });

    if (options.clearComposer) {
      this.clearComposerState();
    }

    const copied = await this.copyTextToClipboard(result.shareUrl);
    this.state.status = copied
      ? `uploaded ${labels.title} and copied link`
      : `uploaded ${labels.title}`;
    this.bridgeLog(result.shareUrl);
    this.playUiSound("select");
    return true;
  }

  private async resolveImageInputPath(input: string): Promise<string | null> {
    const raw = normalizePastedPath(input);
    if (!raw || !looksLikeImagePath(raw)) {
      return null;
    }

    let candidate = raw;
    if (candidate.startsWith("file://")) {
      try {
        candidate = fileURLToPath(new URL(candidate));
      } catch {
        return null;
      }
    } else if (candidate.startsWith("~")) {
      candidate = path.join(os.homedir(), candidate.slice(1));
    }

    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(candidate);

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return null;
      }
      return resolved;
    } catch {
      return null;
    }
  }

  private readViewport(): ViewportSize {
    const columns = Number(process.stdout.columns) || Number(process.env.COLUMNS) || 80;
    const rows = Number(process.stdout.rows) || Number(process.env.LINES) || 24;
    return {
      columns,
      rows
    };
  }

  private paintScreen(screen: string): void {
    const nextLines = screen.split("\n");
    const viewportChanged = !this.#lastRenderedViewport
      || this.#lastRenderedViewport.columns !== this.#viewport.columns
      || this.#lastRenderedViewport.rows !== this.#viewport.rows;
    process.stdout.write(viewportChanged ? "\x1b[H\x1b[2J" : "\x1b[H");
    process.stdout.write(nextLines.join("\n"));
    this.#lastRenderedLines = nextLines;
    this.#lastRenderedViewport = { ...this.#viewport };
  }

  private async openPreviewForCurrentArt(): Promise<void> {
    const previewPath = await this.ensurePreviewPath();
    this.#previewPath = previewPath;
    if (this.config.preview.disableExternalOpen) {
      this.state.previewOpen = true;
      this.state.status = previewPath;
      return;
    }

    if (process.platform === "darwin") {
      await this.closePreview(false);
      const child = spawn("qlmanage", ["-p", previewPath], {
        stdio: "ignore"
      });
      child.unref();
      this.#previewProcess = child;
      child.on("exit", () => {
        if (this.#previewProcess === child) {
          this.#previewProcess = null;
          this.state.previewOpen = false;
        }
      });
    } else {
      await this.openExternalTarget(previewPath);
    }
    this.state.previewOpen = true;
  }

  private async closePreview(updateStatus = true): Promise<void> {
    if (this.#previewProcess && !this.#previewProcess.killed) {
      this.#previewProcess.kill("SIGTERM");
      this.#previewProcess = null;
    }
    this.state.previewOpen = false;
    if (updateStatus) {
      this.state.status = "preview closed";
    }
  }

  private async ensurePreviewPath(): Promise<string> {
    const creation = this.currentCreation() || this.currentFeedItem();
    if (!creation?.url) {
      throw new Error("No art to preview");
    }

    const extension = path.extname(new URL(creation.url, this.config.serverBaseUrl).pathname) || ".png";
    const fileName = `paratui-preview-${creation.id}${extension}`;
    const previewPath = path.join(os.tmpdir(), fileName);
    const buffer = await this.#client.fetchImageBuffer(creation.url);
    await fs.writeFile(previewPath, buffer);
    return previewPath;
  }

  private beginContextInput(initialText: string): boolean {
    if (!initialText || !this.state.authUser) {
      return false;
    }
    if (this.state.view === "room") {
      this.startChatComposer("room", initialText);
      return true;
    }
    if (this.state.view === "dm") {
      this.startChatComposer("dm", initialText);
      return true;
    }
    if (this.state.view === "creation") {
      this.startCommentComposer(initialText);
      return true;
    }
    if (this.state.focus === "left" && this.currentLeftSelection()?.kind === "new-room") {
      this.startRoomJoinComposer(initialText);
      return true;
    }
    return false;
  }

  private clearComposerState(restoreFocus = true): void {
    const returnFocus = this.state.composer.returnFocus;
    this.state.composer.active = false;
    this.state.composer.kind = null;
    this.state.composer.text = "";
    this.state.composer.returnFocus = null;
    if (restoreFocus && returnFocus && returnFocus !== "auth" && returnFocus !== "slash") {
      this.state.focus = returnFocus;
      this.#lastNonSlashFocus = returnFocus;
    }
  }

  private selectLeftEntry(key: string): boolean {
    return this.setLeftSelectionByKey(key);
  }

  private setLeftViewContext(): void {
    if (this.state.authUser) {
      this.state.focus = "left";
      this.#lastNonSlashFocus = "left";
    }
  }

  private primeLeftSelection(entry: LeftNavEntry): void {
    if (entry.kind === "feed") {
      const cached = this.freshCachedValue(this.#feedCache, FEED_CACHE_TTL_MS);
      if (cached) {
        this.state.feed.items = cached;
        this.state.feed.currentIndex = Math.max(0, Math.min(this.state.feed.currentIndex, Math.max(0, cached.length - 1)));
      }
      this.state.loaded.feed = Boolean(cached || this.state.loaded.feed);
      this.state.view = "feed";
      this.state.actions.selectedIndex = 0;
      this.state.status = cached ? `feed ${cached.length}` : "loading feed";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "notifications") {
      const cached = this.freshCachedValue(this.#notificationsCache, NOTIFICATIONS_CACHE_TTL_MS);
      if (cached) {
        this.state.notifications.items = cached.items;
        this.state.notifications.unreadCount = cached.unreadCount;
        this.state.notifications.selectedIndex = Math.max(
          0,
          Math.min(this.state.notifications.selectedIndex, Math.max(0, cached.items.length - 1))
        );
      }
      this.state.loaded.notifications = Boolean(cached || this.state.loaded.notifications);
      this.state.view = "notifications";
      this.state.actions.selectedIndex = 0;
      this.state.status = cached
        ? (cached.unreadCount ? `notifications ${cached.unreadCount} unread` : "notifications")
        : "loading notifications";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "settings") {
      this.state.view = "settings";
      this.state.actions.selectedIndex = 0;
      this.state.status = "settings";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "exit") {
      this.state.status = "press enter to exit";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "placeholder") {
      this.state.status = "loading";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "person" && entry.handle) {
      if (entry.handle === this.state.authUser?.handle) {
        const cached = this.freshCachedValue(this.#profileCache.get(entry.handle), PROFILE_CACHE_TTL_MS);
        this.state.profile = cached
          || (this.state.profile?.profile.user_name === entry.handle
            ? this.state.profile
            : {
                user: {
                  id: this.state.authUser?.id || 0,
                  role: this.state.authUser?.role || "user",
                  created_at: null,
                  email: this.state.authUser?.email || undefined
                },
                profile: {
                  user_name: entry.handle,
                  display_name: this.state.authUser?.displayName || entry.handle,
                  about: null
                },
                stats: {
                  creations_total: 0,
                  creations_published: 0,
                  likes_received: 0,
                  followers_count: 0,
                  member_since: null
                },
                is_self: true,
                viewer_follows: false,
                plan: "free"
              });
        this.state.loaded.profile = Boolean(cached || this.state.loaded.profile);
        this.state.view = "profile";
        this.state.actions.selectedIndex = 0;
        this.state.status = cached ? `profile @${entry.handle}` : `loading @${entry.handle}`;
        this.setLeftViewContext();
        return;
      }

      const cachedDm = this.freshCachedValue(this.#dmCache.get(entry.handle), THREAD_CACHE_TTL_MS);
      this.state.social.dmHandle = entry.handle;
      this.state.social.roomName = null;
      this.state.social.threadId = cachedDm?.threadId || null;
      this.state.social.threadPageIndex = 0;
      this.state.social.threadMessages = cachedDm?.messages || [];
      this.state.loaded.thread = Boolean(cachedDm);
      this.state.view = "dm";
      this.state.actions.selectedIndex = 0;
      this.state.status = cachedDm ? `dm @${entry.handle}` : `loading dm @${entry.handle}`;
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "room" && entry.roomName) {
      const roomName = entry.roomName.replace(/^#/, "").trim().toLowerCase();
      const cachedRoom = this.freshCachedValue(this.#roomCache.get(roomName), THREAD_CACHE_TTL_MS);
      this.state.social.roomName = roomName;
      this.state.social.dmHandle = null;
      this.state.social.threadId = cachedRoom?.threadId || null;
      this.state.social.threadPageIndex = 0;
      this.state.social.threadMessages = cachedRoom?.messages || [];
      this.state.loaded.thread = Boolean(cachedRoom);
      this.state.view = "room";
      this.state.actions.selectedIndex = 0;
      this.state.status = cachedRoom ? `room ${roomName}` : `loading room ${roomName}`;
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "new-room") {
      this.state.status = "create room";
      this.setLeftViewContext();
      return;
    }

    if (entry.kind === "people_page") {
      this.state.status = `people page ${(entry.pageIndex || 0) + 1}/${entry.pageCount || 1}`;
      this.setLeftViewContext();
    }
  }

  private isCurrentLeftSelectionRequest(entry: LeftNavEntry, requestId: number): boolean {
    return requestId === this.#leftSelectionLoadVersion && this.currentLeftSelection()?.key === entry.key;
  }

  private async hydrateLeftSelection(entry: LeftNavEntry, requestId: number, force = false): Promise<void> {
    if (entry.kind === "feed") {
      const items = await this.loadFeedCached(force);
      if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
        return;
      }
      this.state.feed.items = items;
      this.state.loaded.feed = true;
      this.state.feed.currentIndex = Math.max(0, Math.min(this.state.feed.currentIndex, Math.max(0, items.length - 1)));
      if (this.isCurrentLeftSelectionRequest(entry, requestId)) {
        await this.loadCurrentFeedDetail();
      }
      if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
        return;
      }
      this.state.status = `feed ${items.length}`;
      this.schedulePersistUiCache();
      return;
    }

    if (entry.kind === "notifications") {
      const data = await this.loadNotificationsCached(force);
      if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
        return;
      }
      const previousId = this.state.notifications.items[this.state.notifications.selectedIndex]?.id ?? null;
      this.state.notifications.items = data.items;
      this.state.notifications.unreadCount = data.unreadCount;
      this.state.loaded.notifications = true;
      if (previousId != null) {
        const nextIndex = data.items.findIndex((item) => item.id === previousId);
        this.state.notifications.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
      } else {
        this.state.notifications.selectedIndex = 0;
      }
      this.state.status = data.unreadCount
        ? `notifications ${data.unreadCount} unread`
        : "notifications";
      this.schedulePersistUiCache();
      return;
    }

    if (entry.kind === "settings" || entry.kind === "new-room" || entry.kind === "people_page" || entry.kind === "exit" || entry.kind === "placeholder") {
      return;
    }

    if (entry.kind === "person" && entry.handle) {
      if (entry.handle === this.state.authUser?.handle) {
        const profile = await this.loadProfileCached(entry.handle, force);
        if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
          return;
        }
        this.state.profile = profile;
        this.state.loaded.profile = true;
        this.state.status = `profile @${entry.handle}`;
        this.schedulePersistUiCache();
        return;
      }

      const remembered = this.state.social.dms.find((item) => item.handle === entry.handle) || null;
      const data = await this.loadDmCached(entry.handle, force, remembered?.threadId);
      if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
        return;
      }
      const nextDm = remembered && data.dm.displayName === data.dm.handle
        ? { ...data.dm, threadId: data.threadId, displayName: remembered.displayName, online: remembered.online }
        : data.dm;
      this.state.social.dmHandle = nextDm.handle;
      this.state.social.roomName = null;
      this.state.social.threadId = data.threadId;
      this.state.social.threadMessages = data.messages;
      this.state.loaded.thread = true;
      this.rememberDm(nextDm);
      this.state.status = `dm @${nextDm.handle}`;
      this.schedulePersistUiCache();
      return;
    }

    if (entry.kind === "room" && entry.roomName) {
      const data = await this.loadRoomCached(entry.roomName, force);
      if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
        return;
      }
      this.state.social.roomName = data.room.name;
      this.state.social.dmHandle = null;
      this.state.social.threadId = data.threadId;
      this.state.social.threadMessages = data.messages;
      this.state.loaded.thread = true;
      this.rememberRoom(data.room);
      this.state.status = `room ${data.room.name}`;
      this.schedulePersistUiCache();
    }
  }

  private async prefetchLeftEntry(entry: LeftNavEntry | null): Promise<void> {
    if (!entry) {
      return;
    }
    if (entry.kind === "feed") {
      await this.loadFeedCached();
      return;
    }
    if (entry.kind === "notifications") {
      await this.loadNotificationsCached();
      return;
    }
    if (entry.kind === "person" && entry.handle) {
      if (entry.handle === this.state.authUser?.handle) {
        await this.loadProfileCached(entry.handle);
      } else {
        await this.loadDmCached(entry.handle);
      }
      return;
    }
    if (entry.kind === "room" && entry.roomName) {
      await this.loadRoomCached(entry.roomName);
    }
  }

  private scheduleLeftPrefetch(anchorIndex = this.state.people.selectedIndex): void {
    if (this.#leftPrefetchTimer) {
      clearTimeout(this.#leftPrefetchTimer);
    }
    this.prefetchVisiblePersonStats();
    this.#leftPrefetchTimer = setTimeout(() => {
      const entries = getLeftNavEntries(this.state);
      const targets: LeftNavEntry[] = [];
      for (let offset = -2; offset <= 2; offset += 1) {
        if (offset === 0) {
          continue;
        }
        const entry = entries[anchorIndex + offset];
        if (entry) {
          targets.push(entry);
        }
      }
      void Promise.allSettled(targets.map((entry) => this.prefetchLeftEntry(entry))).catch(() => undefined);
    }, LEFT_PREFETCH_DELAY_MS);
  }

  private openLeftSelectionInBackground(entry: LeftNavEntry | null, force = false): void {
    if (!entry) {
      return;
    }
    const requestId = ++this.#leftSelectionLoadVersion;
    this.primeLeftSelection(entry);
    this.syncParasceneRealtimeSubscriptions();
    this.scheduleLeftPrefetch(this.state.people.selectedIndex);
    void this.hydrateLeftSelection(entry, requestId, force || this.shouldForceHydrateLeftSelection(entry))
      .then(() => {
        if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
          return;
        }
        this.syncParasceneRealtimeSubscriptions();
        this.render();
        this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
      })
      .catch((error) => {
        if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
          return;
        }
        this.state.status = this.formatUiError(error);
        this.render();
        this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
      });
  }

  private async openLeftSelection(entry: LeftNavEntry | null, force = false): Promise<void> {
    if (!entry) {
      return;
    }
    if (entry.kind !== "new-room" && entry.kind !== "people_page") {
      this.selectLeftEntry(entry.key);
    }
    const requestId = ++this.#leftSelectionLoadVersion;
    this.primeLeftSelection(entry);
    this.syncParasceneRealtimeSubscriptions();
    await this.hydrateLeftSelection(entry, requestId, force || this.shouldForceHydrateLeftSelection(entry));
    if (!this.isCurrentLeftSelectionRequest(entry, requestId)) {
      return;
    }
    this.syncParasceneRealtimeSubscriptions();
    this.scheduleLeftPrefetch(this.state.people.selectedIndex);
    this.setLeftViewContext();
  }

  private currentLeftSelection(): LeftNavEntry | null {
    return getLeftNavEntry(this.state, this.state.people.selectedIndex);
  }

  private shouldForceHydrateLeftSelection(entry: LeftNavEntry): boolean {
    if (entry.kind === "room") {
      return true;
    }
    return Boolean(
      entry.kind === "person"
      && entry.handle
      && entry.handle !== this.state.authUser?.handle
    );
  }

  private preferredHomeHandle(): string | null {
    const firstOtherPerson = this.state.people.items.find((person) => person.handle !== this.state.authUser?.handle);
    if (firstOtherPerson?.handle) {
      return firstOtherPerson.handle;
    }
    const firstDm = this.state.social.dms.find((dm) => dm.handle !== this.state.authUser?.handle);
    if (firstDm?.handle) {
      return firstDm.handle;
    }
    return this.currentSelectedHandle();
  }

  private leftSelectionStatus(entry: LeftNavEntry | null): string {
    if (!entry) {
      return "selected none";
    }
    if (entry.kind === "feed") {
      return "feed";
    }
    if (entry.kind === "notifications") {
      return "notifications";
    }
    if (entry.kind === "settings") {
      return "settings";
    }
    if (entry.kind === "exit") {
      return "press enter to exit";
    }
    if (entry.kind === "person" && entry.handle) {
      return `selected @${entry.handle}`;
    }
    if (entry.kind === "people_page") {
      return entry.pageCount
        ? `people page ${(entry.pageIndex || 0) + 1}/${entry.pageCount}`
        : "people page 0/0";
    }
    if (entry.kind === "room" && entry.roomName) {
      return `selected room ${entry.roomName}`;
    }
    if (entry.kind === "placeholder") {
      return "loading";
    }
    return "create room";
  }
}

function recentRoomSummary(roomName: string): RoomSummary {
  const normalized = String(roomName || "").replace(/^#/, "").trim().toLowerCase();
  return {
    name: normalized,
    title: `#${normalized}`,
    messageCount: 0,
    lastMessageText: null
  };
}

function mergeRoomSummaries(primary: RoomSummary[], secondary: RoomSummary[]): RoomSummary[] {
  const merged = new Map<string, RoomSummary>();
  for (const room of [...primary, ...secondary]) {
    if (!room?.name) {
      continue;
    }
    if (!merged.has(room.name)) {
      merged.set(room.name, room);
    }
  }
  return Array.from(merged.values());
}

function normalizePastedPath(input: string): string {
  const trimmed = String(input || "")
    .replace(/\x1b\[\?2004[hl]/g, "")
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!trimmed) {
    return "";
  }

  const firstLine = trimmed.split("\n")[0]?.trim() || "";
  const unquoted = (
    (firstLine.startsWith("\"") && firstLine.endsWith("\""))
    || (firstLine.startsWith("'") && firstLine.endsWith("'"))
  )
    ? firstLine.slice(1, -1)
    : firstLine;

  if (/^[a-zA-Z]:\\/.test(unquoted) || unquoted.startsWith("\\\\")) {
    return unquoted;
  }

  let unescaped = "";
  let escaping = false;
  for (const char of unquoted) {
    if (escaping) {
      unescaped += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    unescaped += char;
  }
  if (escaping) {
    unescaped += "\\";
  }

  return unescaped.trim();
}

function looksLikeImagePath(input: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(input);
}

function deriveUploadLabels(filePath: string): {
  title: string;
  description: string;
} {
  const stem = path.basename(filePath, path.extname(filePath)).trim();
  const title = (stem || `upload ${new Date().toLocaleString()}`)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const createdAt = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return {
    title: title || "uploaded image",
    description: `Uploaded from ${path.basename(filePath)} via paratui on ${createdAt}`
  };
}
