export type FocusRegion = "left" | "center" | "slash" | "settings" | "auth";

export type AppView = "login" | "profile" | "creation" | "settings" | "dm" | "room" | "feed" | "notifications" | "live";

export interface AppConfig {
  serverBaseUrl: string;
  realtimeBaseUrl: string;
  parasceneRealtime: {
    enabled: boolean;
    url: string | null;
    anonKey: string | null;
  };
  auth: {
    bearerToken: string | null;
    username: string | null;
  };
  audio: {
    muted: boolean;
  };
  social: {
    recentRooms: string[];
  };
  uiCache: {
    loaded: {
      people: boolean;
      social: boolean;
      notifications: boolean;
      feed: boolean;
      thread: boolean;
      profile: boolean;
    };
    selectedLeftKey: string | null;
    people: CliUserSummary[];
    rooms: RoomSummary[];
    dms: DmSummary[];
    notifications: {
      items: NotificationSummary[];
      unreadCount: number;
    };
    feed: {
      items: FeedItem[];
      currentIndex: number;
    };
    currentThread: {
      view: "dm" | "room" | null;
      dmHandle: string | null;
      roomName: string | null;
      threadId: number | null;
      messages: SocialMessage[];
    };
  };
  exports: {
    directory: string;
  };
  preview: {
    disableExternalOpen: boolean;
  };
}

export interface CliUserSummary {
  id: number;
  email: string;
  role: string;
  handle: string;
  displayName: string;
  online: boolean;
  lastActiveAt: string | null;
  publishedCreations?: number | null;
}

export interface CliAuthUser {
  id: number;
  email: string;
  role: string;
  handle: string;
  displayName: string;
}

export interface UserProfileData {
  user: {
    id: number;
    role: string;
    created_at: string | null;
    email?: string;
    email_prefix?: string;
  };
  profile: {
    user_name: string | null;
    display_name: string | null;
    about: string | null;
  };
  stats: {
    creations_total: number;
    creations_published: number;
    likes_received: number;
    followers_count: number;
    member_since: string | null;
  };
  is_self: boolean;
  viewer_follows: boolean;
  plan: string;
}

export interface CreationSummary {
  id: number;
  title: string | null;
  description: string | null;
  url: string | null;
  thumbnail_url: string | null;
  created_at: string;
  published: boolean;
  published_at: string | null;
  media_type: string;
  nsfw: boolean;
  ownerHandle?: string | null;
  ownerDisplayName?: string | null;
  prompt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ActivityItem {
  type: "comment" | "tip";
  id: number;
  user_id: number;
  text?: string;
  message?: string;
  amount?: number;
  user_name?: string | null;
  display_name?: string | null;
  created_at?: string | null;
  reactions?: Record<string, Array<string | number>>;
  viewer_reactions?: string[];
}

export interface SocialMessage {
  id: number;
  authorHandle: string;
  authorDisplayName: string;
  text: string;
  createdAt: string;
}

export interface RoomSummary {
  name: string;
  title: string;
  messageCount: number;
  lastMessageText: string | null;
  lastMessageAt?: string | null;
}

export interface DmSummary {
  threadId?: number | null;
  handle: string;
  displayName: string;
  online: boolean;
  lastMessageText: string | null;
  lastMessageAt?: string | null;
}

export interface FeedItem extends CreationSummary {
  ownerHandle: string | null;
  ownerDisplayName: string | null;
}

export interface NotificationSummary {
  id: number;
  title: string;
  message: string;
  link: string | null;
  type: string | null;
  created_at: string;
  acknowledged_at: string | null;
  count?: number;
  unread_count?: number;
}

export interface SlotValue {
  creationId: number;
  title: string | null;
}

export interface RealtimePeerSummary {
  peerId: string;
  handle: string;
  displayName: string;
  room: string;
  capabilities: string[];
}

export interface RealtimeMessage {
  kind: "system" | "chat" | "signal";
  scope: "system" | "room" | "direct" | "signal";
  fromHandle: string | null;
  text: string;
  signalType?: "offer" | "answer" | "candidate" | null;
  createdAt: string;
}

export interface SlashState {
  open: boolean;
  input: string;
  selectedIndex: number;
}

export interface ComposerState {
  active: boolean;
  kind: "comment" | "room" | "dm" | "room_join" | null;
  text: string;
  returnFocus: FocusRegion | null;
}

export interface AppState {
  view: AppView;
  focus: FocusRegion;
  status: string;
  config: {
    audio: {
      muted: boolean;
    };
  };
  authInput: {
    active: boolean;
    draft: string;
  };
  authUser: CliAuthUser | null;
  people: {
    items: CliUserSummary[];
    selectedIndex: number;
    pageIndex: number;
  };
  profile: UserProfileData | null;
  creations: {
    ownerHandle: string | null;
    items: CreationSummary[];
    currentIndex: number;
    activity: ActivityItem[];
    ascii: string;
    selectedCommentIndex: number;
    commentScrollOffset: number;
    selectionMode: "comments" | "actions";
  };
  social: {
    threadId: number | null;
    dmHandle: string | null;
    roomName: string | null;
    threadPageIndex: number;
    threadMessages: SocialMessage[];
    rooms: RoomSummary[];
    dms: DmSummary[];
  };
  feed: {
    items: FeedItem[];
    currentIndex: number;
    ascii: string;
  };
  notifications: {
    items: NotificationSummary[];
    unreadCount: number;
    selectedIndex: number;
  };
  loaded: {
    people: boolean;
    social: boolean;
    notifications: boolean;
    feed: boolean;
    thread: boolean;
    profile: boolean;
  };
  realtime: {
    connected: boolean;
    room: string | null;
    selfPeerId: string | null;
    peers: RealtimePeerSummary[];
    messages: RealtimeMessage[];
    iceServerCount: number;
    lastSignalType: "offer" | "answer" | "candidate" | null;
  };
  settings: {
    selectedKey: "mute_sounds";
  };
  actions: {
    selectedIndex: number;
  };
  slash: SlashState;
  composer: ComposerState;
  slots: Record<"A" | "B" | "C" | "D" | "E", SlotValue | null>;
  previewOpen: boolean;
  fullView: {
    open: boolean;
    ascii: string;
  };
  exports: {
    lastSavedPath: string | null;
  };
}

export interface AppSnapshot {
  meta: {
    inputSeq: number;
  };
  view: AppView;
  focus: FocusRegion;
  status: string;
  auth: {
    loggedIn: boolean;
    handle: string | null;
    inputActive: boolean;
    draftLength: number;
  };
  selected: {
    handle: string | null;
  };
  profile: {
    handle: string | null;
  };
  creation: {
    title: string | null;
    index: number;
    count: number;
    ownerHandle: string | null;
    preloaded: {
      previous: boolean;
      next: boolean;
    };
  };
  activity: {
    count: number;
    firstCommentText: string | null;
  };
  dm: {
    handle: string | null;
    messageCount: number;
  };
  room: {
    name: string | null;
    messageCount: number;
  };
  feed: {
    title: string | null;
    index: number;
    count: number;
  };
  notifications: {
    count: number;
    unreadCount: number;
    selectedId: number | null;
  };
  realtime: {
    connected: boolean;
    room: string | null;
    peerCount: number;
    peerHandles: string[];
    messageCount: number;
    lastMessageText: string | null;
    iceServerCount: number;
    lastSignalType: "offer" | "answer" | "candidate" | null;
  };
  settings: {
    audio: {
      muted: boolean;
    };
  };
  actions: {
    selectedIndex: number;
    selectedId: string | null;
    count: number;
  };
  slots: Record<string, { assigned: boolean; title: string | null }>;
  previewOpen: boolean;
  fullView: {
    open: boolean;
    asciiLength: number;
  };
  export: {
    lastSavedPath: string | null;
  };
  composer: {
    active: boolean;
    kind: "comment" | "room" | "dm" | "room_join" | null;
    textLength: number;
  };
  slash: {
    open: boolean;
    input: string;
    selectedPath: string | null;
    matchCount: number;
  };
}

export interface ParsedCommand {
  path: string;
  positional: string[];
  named: Record<string, string>;
}
