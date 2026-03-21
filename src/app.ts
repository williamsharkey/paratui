import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { AsciiArtCache, type AsciiRenderSize } from "./ascii.js";
import { ParasceneClient } from "./api.js";
import {
  createCommandRegistry,
  findMatchingCommands,
  longestCommonCommandPrefix,
  parseCommandText,
  type CommandSpec
} from "./commands.js";
import { loadConfig, saveConfig } from "./config.js";
import { exportImageWithMetadata, normalizeFormat } from "./export.js";
import { getFocusActions } from "./focus-actions.js";
import { calculateLayout, type ViewportSize } from "./layout.js";
import { assertSnapshotValue, runMacroFile } from "./macros.js";
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
      selectedIndex: 0
    },
    profile: null,
    creations: {
      ownerHandle: null,
      items: [],
      currentIndex: 0,
      activity: [],
      ascii: ""
    },
    social: {
      threadId: null,
      dmHandle: null,
      roomName: null,
      threadMessages: [],
      rooms: [],
      dms: []
    },
    feed: {
      items: [],
      currentIndex: 0,
      ascii: ""
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
      text: ""
    },
    slots: {
      A: null,
      B: null,
      C: null,
      D: null,
      E: null
    },
    previewOpen: false,
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
  #interactiveResolver: (() => void) | null = null;
  #runningInteractive = false;
  #viewport: ViewportSize = this.readViewport();
  #lastNonSlashFocus: FocusRegion = "auth";
  #activityCache = new Map<number, Promise<ActivityItem[]>>();
  #peopleRefreshTimer: NodeJS.Timeout | null = null;

  constructor(options: AppOptions = {}) {
    this.options = options;
  }

  async init(): Promise<void> {
    this.config = await loadConfig();
    this.state.config.audio.muted = this.config.audio.muted;
    this.#client.setBaseUrl(this.config.serverBaseUrl);
    this.#realtime.setUrl(this.config.realtimeBaseUrl);

    if (this.config.auth.bearerToken) {
      try {
        const me = await this.#client.me();
        this.state.authUser = me.user;
        await this.refreshPeople().catch(() => undefined);
        await this.loadSocialLists();
      } catch {
        this.config.auth.bearerToken = null;
        this.config.auth.username = null;
        await saveConfig(this.config);
      }
    }

    this.state.view = this.state.authUser ? "profile" : "login";
    this.state.focus = this.defaultFocusRegion();
    this.#lastNonSlashFocus = this.state.focus;
    this.state.status = this.state.authUser
      ? `signed in as @${this.state.authUser.handle}`
      : "set api key";

    if (this.state.authUser) {
      const initialHandle = this.currentSelectedHandle() || this.state.authUser.handle;
      await this.openProfile(initialHandle).catch(() => undefined);
    }

    if (!this.options.headless) {
      this.render();
      this.bridge.emit({ type: "ready", snapshot: this.snapshot() });
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

  bridgeLog(message: string): void {
    this.bridge.emit({ type: "log", message });
  }

  assertSnapshot(pathName: string, expectedRaw: string): void {
    assertSnapshotValue(this.snapshot(), pathName, expectedRaw);
  }

  currentSelectedHandle(): string | null {
    const person = this.state.people.items[this.state.people.selectedIndex];
    return person?.handle ?? null;
  }

  selectHandle(handle: string): void {
    const normalized = handle.replace(/^@/, "");
    const index = this.state.people.items.findIndex((person) => person.handle === normalized);
    if (index >= 0) {
      this.state.people.selectedIndex = index;
      this.state.status = `selected @${normalized}`;
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
    return this.state.view === "profile" ? "left" : "center";
  }

  private focusableRegions(): FocusRegion[] {
    if (!this.state.authUser || this.state.view === "login") {
      return ["auth"];
    }
    if (this.state.view === "settings") {
      return this.state.people.items.length ? ["left", "settings"] : ["settings"];
    }
    return this.state.people.items.length ? ["left", "center"] : ["center"];
  }

  private movePersonSelection(delta: number): void {
    if (!this.state.people.items.length) {
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(this.state.people.selectedIndex + delta, this.state.people.items.length - 1)
    );
    if (nextIndex === this.state.people.selectedIndex) {
      return;
    }
    this.state.people.selectedIndex = nextIndex;
    this.state.status = `selected @${this.currentSelectedHandle() || "none"}`;
    this.playUiSound("focus");
  }

  private moveFocusAction(delta: number): void {
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
    if (this.state.focus === "left" && this.currentSelectedHandle()) {
      await this.openProfile(this.currentSelectedHandle()!);
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
      case "open_feed":
        await this.openFeed();
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
      case "save_art":
        await this.saveCurrentArt("png");
        break;
      case "previous_feed":
        await this.previousFeed();
        break;
      case "next_feed":
        await this.nextFeed();
        break;
      case "open_active_profile":
        if (this.state.social.dmHandle) {
          await this.openProfile(this.state.social.dmHandle);
        }
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

  async refreshPeople(): Promise<void> {
    this.ensureAuthenticated();
    const people = await this.#client.listUsers();
    this.applyPeopleList(people);
    this.state.status = `loaded ${this.state.people.items.length} people`;
  }

  async setApiKey(token: string): Promise<void> {
    const value = token.trim();
    if (!value) {
      throw new Error("Usage: /auth/key/set psn_<your-secret>");
    }
    const result = await this.#client.validateBearerToken(value);
    this.config.auth.bearerToken = value;
    this.config.auth.username = result.user.handle;
    await saveConfig(this.config);
    this.state.authUser = result.user;
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.view = "profile";
    this.state.focus = "left";
    this.#lastNonSlashFocus = "left";
    this.state.actions.selectedIndex = 0;
    await this.refreshPeople().catch(() => undefined);
    await this.loadSocialLists();
    const initialHandle = this.currentSelectedHandle() || result.user.handle;
    await this.openProfile(initialHandle).catch(() => {
      this.state.profile = null;
    });
    this.state.status = `api key set for @${result.user.handle}`;
    this.playUiSound("select");
  }

  async logout(): Promise<void> {
    await this.#realtime.disconnect().catch(() => undefined);
    this.config.auth.bearerToken = null;
    this.config.auth.username = null;
    await saveConfig(this.config);
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.authUser = null;
    this.state.people.items = [];
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
    this.clearRealtimeState();
    this.state.exports.lastSavedPath = null;
    this.state.view = "login";
    this.state.focus = "auth";
    this.#lastNonSlashFocus = "auth";
    this.state.actions.selectedIndex = 0;
    this.state.status = "api key removed";
    this.playUiSound("back");
  }

  async openProfile(handle: string): Promise<void> {
    this.ensureAuthenticated();
    this.selectHandle(handle);
    this.state.profile = await this.#client.loadProfile(handle);
    this.state.view = "profile";
    this.state.focus = "left";
    this.#lastNonSlashFocus = "left";
    this.state.actions.selectedIndex = 0;
    this.state.status = `profile @${handle}`;
  }

  async openCreations(handle: string): Promise<void> {
    this.ensureAuthenticated();
    this.selectHandle(handle);
    this.state.creations.ownerHandle = handle;
    this.state.creations.items = await this.#client.loadCreations(handle);
    this.state.creations.currentIndex = 0;
    this.state.view = "creation";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    await this.loadCurrentCreationDetail();
    this.state.status = `creations @${handle}`;
  }

  async nextCreation(): Promise<void> {
    if (!this.state.creations.items.length) {
      throw new Error("No creations loaded");
    }
    this.state.creations.currentIndex = Math.min(
      this.state.creations.currentIndex + 1,
      this.state.creations.items.length - 1
    );
    await this.loadCurrentCreationDetail();
    this.state.status = `art ${this.state.creations.currentIndex + 1}/${this.state.creations.items.length}`;
    this.playUiSound("select");
  }

  async previousCreation(): Promise<void> {
    if (!this.state.creations.items.length) {
      throw new Error("No creations loaded");
    }
    this.state.creations.currentIndex = Math.max(this.state.creations.currentIndex - 1, 0);
    await this.loadCurrentCreationDetail();
    this.state.status = `art ${this.state.creations.currentIndex + 1}/${this.state.creations.items.length}`;
    this.playUiSound("select");
  }

  async togglePreview(): Promise<void> {
    this.state.previewOpen = !this.state.previewOpen;
    this.state.status = this.state.previewOpen ? "preview open" : "preview closed";
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
    this.state.view = "settings";
    this.state.focus = "settings";
    this.#lastNonSlashFocus = "settings";
    this.state.actions.selectedIndex = 0;
    this.state.status = "settings";
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
    const data = await this.#client.loadDmMessages(normalized);
    this.state.social.dmHandle = data.dm.handle;
    this.state.social.roomName = null;
    this.state.social.threadId = data.threadId;
    this.state.social.threadMessages = data.messages;
    this.rememberDm(data.dm);
    this.state.view = "dm";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `dm @${data.dm.handle}`;
  }

  async sendDm(text: string): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.social.dmHandle || !this.state.social.threadId) {
      throw new Error("No DM open");
    }
    const data = await this.#client.sendDm(this.state.social.threadId, this.state.social.dmHandle, text);
    this.state.social.threadMessages = data.messages;
    this.state.social.threadId = data.threadId;
    this.rememberDm(data.dm);
    this.state.status = `dm sent @${data.dm.handle}`;
    this.playUiSound("select");
  }

  async openRoom(roomName: string): Promise<void> {
    this.ensureAuthenticated();
    const normalized = roomName.trim().toLowerCase();
    const data = await this.#client.loadRoomMessages(normalized);
    this.state.social.roomName = data.room.name;
    this.state.social.dmHandle = null;
    this.state.social.threadId = data.threadId;
    this.state.social.threadMessages = data.messages;
    this.rememberRoom(data.room);
    this.state.view = "room";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = `room ${data.room.name}`;
  }

  async postRoomMessage(text: string): Promise<void> {
    this.ensureAuthenticated();
    if (!this.state.social.roomName || !this.state.social.threadId) {
      throw new Error("No room open");
    }
    const data = await this.#client.postRoomMessage(this.state.social.threadId, this.state.social.roomName, text);
    this.state.social.threadMessages = data.messages;
    this.state.social.threadId = data.threadId;
    this.rememberRoom(data.room);
    this.state.status = `room post ${data.room.name}`;
    this.playUiSound("select");
  }

  async openFeed(): Promise<void> {
    this.ensureAuthenticated();
    this.state.feed.items = await this.#client.loadLatestFeed();
    this.state.feed.currentIndex = 0;
    this.state.view = "feed";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    await this.loadCurrentFeedDetail();
    this.state.status = `feed ${this.state.feed.items.length}`;
  }

  openRealtime(): void {
    this.state.view = "live";
    this.state.focus = "center";
    this.#lastNonSlashFocus = "center";
    this.state.actions.selectedIndex = 0;
    this.state.status = this.state.realtime.connected
      ? `live ${this.state.realtime.room || "connected"}`
      : "live offline";
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
    this.playUiSound("select");
  }

  async disconnectRealtime(): Promise<void> {
    await this.#realtime.disconnect();
    this.clearRealtimeState();
    this.state.status = "live offline";
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
    this.state.feed.currentIndex = Math.min(this.state.feed.currentIndex + 1, this.state.feed.items.length - 1);
    await this.loadCurrentFeedDetail();
    this.state.status = `feed ${this.state.feed.currentIndex + 1}/${this.state.feed.items.length}`;
    this.playUiSound("select");
  }

  async previousFeed(): Promise<void> {
    if (!this.state.feed.items.length) {
      throw new Error("Feed is empty");
    }
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

  openSlash(): void {
    this.state.authInput.active = false;
    if (this.state.focus !== "slash") {
      this.#lastNonSlashFocus = this.state.focus;
    }
    this.state.slash.open = true;
    this.state.slash.input = "/";
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

  cancelApiKeyEntry(): void {
    this.state.authInput.active = false;
    this.state.authInput.draft = "";
    this.state.focus = "auth";
    this.#lastNonSlashFocus = "auth";
    this.state.status = "api key input cancelled";
  }

  async submitApiKeyDraft(): Promise<void> {
    if (!this.state.authInput.draft.trim()) {
      throw new Error("Paste an API key first");
    }
    await this.setApiKey(this.state.authInput.draft);
  }

  async openApiKeyHelp(): Promise<void> {
    const url = "https://www.parascene.com/help/developer/api";
    if (this.config.preview.disableExternalOpen) {
      this.state.status = url;
      return;
    }

    const opener = process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

    try {
      const child = spawn(opener.command, opener.args, {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      this.state.status = "opened api key help";
      this.playUiSound("select");
    } catch {
      this.state.status = url;
    }
  }

  async cancel(): Promise<void> {
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
      if (this.currentSelectedHandle()) {
        await this.openProfile(this.currentSelectedHandle()!);
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

    if ((this.state.view === "dm" || this.state.view === "room" || this.state.view === "feed" || this.state.view === "live") && this.currentSelectedHandle()) {
      await this.openProfile(this.currentSelectedHandle()!);
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
    this.startPeopleRefreshLoop();

    const onResize = () => {
      this.#viewport = this.readViewport();
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
        if (key.ctrl && key.name === "c") {
          this.shutdown();
          return;
        }

        if (this.state.slash.open) {
          if (key.name === "escape") {
            await this.cancel();
          } else if (key.name === "backspace") {
            if (this.state.slash.input.length > 1) {
              this.state.slash.input = this.state.slash.input.slice(0, -1);
            } else {
              this.state.slash.input = "/";
            }
            this.state.slash.selectedIndex = 0;
          } else if (key.name === "tab") {
            this.completeSlashInput();
          } else if (key.name === "left") {
            this.moveSlashSelection(-1);
          } else if (key.name === "right") {
            this.moveSlashSelection(1);
          } else if (key.name === "return") {
            await this.submitSlashSelection();
            return;
          } else if (key.name === "space") {
            const exactCommand = this.commands.find((command) => command.path === this.currentSlashPath());
            if (!/\s/.test(this.state.slash.input.trim()) && this.currentSlashMatches().length && !exactCommand) {
              await this.submitSlashSelection();
              return;
            }
            this.state.slash.input += " ";
            this.state.slash.selectedIndex = 0;
          } else if (str && !key.ctrl && !key.meta && !["return"].includes(key.name || "")) {
            this.state.slash.input += str;
            this.state.slash.selectedIndex = 0;
          }
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
            return;
          } else if (str && !key.ctrl && !key.meta) {
            this.state.authInput.draft += str.replace(/[\r\n]/g, "");
          }
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
          return;
        }

        if (str === "/") {
          this.openSlash();
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
          this.movePersonSelection(-1);
        } else if (key.name === "down" && this.state.focus === "left") {
          this.movePersonSelection(1);
        } else if (key.name === "up" && this.state.focus !== "left") {
          this.moveFocusAction(-1);
        } else if (key.name === "down" && this.state.focus !== "left") {
          this.moveFocusAction(1);
        } else if ((key.name === "return" || key.name === "space") && this.state.focus !== "slash") {
          await this.invokeFocusedAction();
        } else if (key.name === "right" && this.state.view === "profile" && this.currentSelectedHandle()) {
          await this.openCreations(this.currentSelectedHandle()!);
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
        this.state.status = error instanceof Error ? error.message : String(error);
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
  }

  render(): void {
    if (this.options.headless) {
      return;
    }
    this.#viewport = this.readViewport();
    const screen = renderApp(this.state, this.commands, this.#viewport);
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(screen);
    this.bridge.emit({ type: "state", snapshot: this.snapshot() });
  }

  shutdown(): void {
    void this.#realtime.disconnect().catch(() => undefined);
    this.stopPeopleRefreshLoop();
    if (this.#runningInteractive && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
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
    const actionRows = getFocusActions(this.state, "center").length + 1;
    const reservedRows = layout.mode === "compact"
      ? 6
      : 7 + actionRows + 6;
    return {
      width: Math.max(18, availableWidth - 2),
      height: Math.max(8, layout.bodyHeight - reservedRows)
    };
  }

  private currentFeedAsciiSize(): AsciiRenderSize {
    const layout = calculateLayout(this.#viewport);
    const availableWidth = layout.mode === "columns" ? layout.centerWidth : layout.contentWidth;
    const reservedRows = layout.mode === "compact" ? 5 : 8;
    return {
      width: Math.max(18, availableWidth - 2),
      height: Math.max(8, layout.bodyHeight - reservedRows)
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

  private async loadSocialLists(): Promise<void> {
    if (!this.state.authUser) {
      return;
    }
    try {
      const [rooms, dms] = await Promise.all([
        this.#client.listRooms(),
        this.#client.listDms()
      ]);
      this.state.social.rooms = rooms;
      this.state.social.dms = dms;
    } catch {
      this.state.social.rooms = [];
      this.state.social.dms = [];
    }
  }

  private rememberDm(dm: DmSummary): void {
    const next = this.state.social.dms.filter((entry) => entry.handle !== dm.handle);
    next.unshift(dm);
    this.state.social.dms = next.slice(0, 12);
  }

  private rememberRoom(room: RoomSummary): void {
    const next = this.state.social.rooms.filter((entry) => entry.name !== room.name);
    next.unshift(room);
    this.state.social.rooms = next.slice(0, 12);
  }

  private async refreshPeoplePresence(): Promise<void> {
    this.ensureAuthenticated();
    const people = await this.#client.listPresenceUsers();
    if (!people) {
      return;
    }
    this.applyPeopleList(people);
  }

  private applyPeopleList(people: CliUserSummary[]): void {
    const previousHandle = this.currentSelectedHandle();
    const filtered = people.filter((person) => person.handle);
    if (!filtered.some((person) => person.handle === this.state.authUser?.handle)) {
      filtered.unshift({
        id: this.state.authUser?.id || 0,
        email: this.state.authUser?.email || "",
        role: this.state.authUser?.role || "user",
        handle: this.state.authUser?.handle || "user",
        displayName: this.state.authUser?.displayName || this.state.authUser?.handle || "user",
        online: true,
        lastActiveAt: new Date().toISOString()
      });
    }
    this.state.people.items = filtered;
    const preservedIndex = previousHandle
      ? filtered.findIndex((person) => person.handle === previousHandle)
      : -1;
    if (preservedIndex >= 0) {
      this.state.people.selectedIndex = preservedIndex;
      return;
    }
    const preferredIndex = filtered.findIndex((person) => person.handle !== this.state.authUser?.handle);
    this.state.people.selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
  }

  private startPeopleRefreshLoop(): void {
    this.stopPeopleRefreshLoop();
    this.#peopleRefreshTimer = setInterval(() => {
      if (!this.state.authUser) {
        return;
      }
      void this.refreshPeoplePresence()
        .then(() => {
          this.render();
          this.bridge.emit({ type: "idle", snapshot: this.snapshot() });
        })
        .catch(() => undefined);
    }, 10_000);
  }

  private stopPeopleRefreshLoop(): void {
    if (!this.#peopleRefreshTimer) {
      return;
    }
    clearInterval(this.#peopleRefreshTimer);
    this.#peopleRefreshTimer = null;
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

  private readViewport(): ViewportSize {
    const columns = Number(process.stdout.columns) || Number(process.env.COLUMNS) || 80;
    const rows = Number(process.stdout.rows) || Number(process.env.LINES) || 24;
    return {
      columns,
      rows
    };
  }
}
