import type {
  ActivityItem,
  CliAuthUser,
  CliUserSummary,
  CreationSummary,
  DmSummary,
  FeedItem,
  RoomSummary,
  SocialMessage,
  UserProfileData
} from "./types.js";

interface MeResponse {
  ok: true;
  user: CliAuthUser;
}

interface ProfileResponse {
  id?: number;
  email?: string | null;
  role?: string | null;
  profile?: {
    user_name?: string | null;
    display_name?: string | null;
  } | null;
  user?: {
    id?: number;
  } | null;
}

interface UsersResponse {
  users: CliUserSummary[];
}

interface ActivityResponse {
  items: ActivityItem[];
  comment_count: number;
}

interface CommentResponse {
  comment: ActivityItem;
}

interface ReactionResponse {
  added: boolean;
  count: number;
}

interface RoomsResponse {
  rooms: RoomSummary[];
}

interface RoomMessagesResponse {
  threadId: number;
  room: RoomSummary;
  messages: SocialMessage[];
}

interface DmsResponse {
  dms: DmSummary[];
}

interface DmMessagesResponse {
  threadId: number;
  dm: DmSummary;
  messages: SocialMessage[];
}

interface FeedResponse {
  items: Array<{
    type?: string;
    id?: number;
    created_image_id?: number | null;
    title?: string | null;
    summary?: string | null;
    author_user_name?: string | null;
    author_display_name?: string | null;
    image_url?: string | null;
    thumbnail_url?: string | null;
    created_at?: string | null;
    nsfw?: boolean;
    media_type?: string | null;
  }>;
}

interface LegacyFeedResponse {
  items: FeedItem[];
}

interface PromptResponse {
  ok: true;
  image: CreationSummary;
}

interface ChatThread {
  id: number;
  type: "dm" | "channel";
  dm_pair_key: string | null;
  channel_slug: string | null;
  created_at?: string | null;
}

interface ChatThreadResponse {
  thread: ChatThread;
}

interface ChatThreadListMessage {
  body?: string | null;
  created_at?: string | null;
  sender_id?: number | null;
}

interface ChatThreadListOtherUser {
  id?: number;
  display_name?: string | null;
  user_name?: string | null;
  avatar_url?: string | null;
}

interface ChatThreadListItem extends ChatThread {
  title?: string | null;
  other_user_id?: number | null;
  other_user?: ChatThreadListOtherUser | null;
  last_message?: ChatThreadListMessage | null;
}

interface ChatThreadsResponse {
  viewer_id: number;
  threads: ChatThreadListItem[];
}

interface ChatMessageRow {
  id: number;
  thread_id: number;
  sender_id: number;
  body: string;
  created_at: string;
  sender_user_name?: string | null;
  sender_avatar_url?: string | null;
  reactions?: Record<string, number> | null;
  viewer_reactions?: string[] | null;
}

interface ChatMessagesResponse {
  messages: ChatMessageRow[];
  hasMore: boolean;
  nextBefore: string | null;
}

interface ChatSendResponse {
  message: ChatMessageRow;
}

interface CachedUserIdentity {
  id: number;
  handle: string;
  displayName: string;
}

export class ParasceneClient {
  #baseUrl: string;
  #getToken: () => string | null;
  #profileCacheById = new Map<number, CachedUserIdentity>();

  constructor(baseUrl: string, getToken: () => string | null) {
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.#getToken = getToken;
  }

  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  async validateBearerToken(token: string): Promise<MeResponse> {
    return this.#requestJson<ProfileResponse>("api/profile", {
      headers: {
        authorization: `Bearer ${token}`
      }
    }, false).then((profile) => ({
      ok: true,
      user: mapProfileToAuthUser(profile)
    }));
  }

  async me(): Promise<MeResponse> {
    const profile = await this.#requestJson<ProfileResponse>("api/profile");
    return {
      ok: true,
      user: mapProfileToAuthUser(profile)
    };
  }

  async listUsers(): Promise<CliUserSummary[]> {
    const presenceUsers = await this.listPresenceUsers();
    if (presenceUsers) {
      return presenceUsers;
    }

    try {
      const data = await this.#requestJson<FeedResponse>("api/feed?limit=50");
      const seen = new Map<string, CliUserSummary>();
      let syntheticId = 1;
      for (const item of data.items) {
        const handle = String(item.author_user_name || "").trim();
        if (!handle || seen.has(handle)) {
          continue;
        }
        const displayName = String(item.author_display_name || handle);
        seen.set(handle, {
          id: syntheticId,
          email: "",
          role: "user",
          handle,
          displayName,
          online: false,
          lastActiveAt: item.created_at || null
        });
        syntheticId += 1;
      }
      return Array.from(seen.values());
    } catch {
      return [];
    }
  }

  async listPresenceUsers(): Promise<CliUserSummary[] | null> {
    try {
      const data = await this.#requestJson<UsersResponse>("api/cli/users");
      return data.users;
    } catch {
      return null;
    }
  }

  async loadProfile(handle: string): Promise<UserProfileData> {
    return this.#requestJson<UserProfileData>(`api/users/by-username/${encodeURIComponent(handle)}/profile`);
  }

  async loadCreations(handle: string): Promise<CreationSummary[]> {
    const data = await this.#requestJson<{ images: CreationSummary[] }>(
      `api/users/by-username/${encodeURIComponent(handle)}/created-images?limit=50`
    );
    return data.images;
  }

  async loadActivity(creationId: number): Promise<ActivityResponse> {
    return this.#requestJson<ActivityResponse>(`api/created-images/${creationId}/activity?limit=50`);
  }

  async addComment(creationId: number, text: string): Promise<CommentResponse> {
    return this.#requestJson<CommentResponse>(`api/created-images/${creationId}/comments`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
  }

  async reactToComment(commentId: number, emojiKey: string): Promise<ReactionResponse> {
    return this.#requestJson<ReactionResponse>(`api/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji_key: emojiKey })
    });
  }

  async listRooms(): Promise<RoomSummary[]> {
    const threads = await this.#listThreads();
    if (threads) {
      return threads
        .filter((thread) => thread.type === "channel" && thread.channel_slug)
        .map((thread) => ({
          name: String(thread.channel_slug || "").toLowerCase(),
          title: thread.title || `#${String(thread.channel_slug || "").toLowerCase()}`,
          messageCount: 0,
          lastMessageText: thread.last_message?.body || null
        }));
    }

    if (this.#usesOfficialHostedApi()) {
      return [];
    }
    try {
      const data = await this.#requestJson<RoomsResponse>("api/cli/social/rooms");
      return data.rooms;
    } catch {
      return [];
    }
  }

  async loadRoomMessages(roomName: string): Promise<RoomMessagesResponse> {
    const thread = await this.#openChannelThread(roomName);
    return this.#buildRoomMessagesResponse(thread, roomName);
  }

  async postRoomMessage(threadId: number, roomName: string, text: string): Promise<RoomMessagesResponse> {
    await this.#sendThreadMessage(threadId, text);
    return this.#buildRoomMessagesResponse({
      id: threadId,
      type: "channel",
      dm_pair_key: null,
      channel_slug: normalizeChannelTag(roomName)
    }, roomName);
  }

  async listDms(): Promise<DmSummary[]> {
    const threads = await this.#listThreads();
    if (threads) {
      return threads
        .filter((thread) => thread.type === "dm" && thread.other_user?.user_name)
        .map((thread) => {
          const handle = String(thread.other_user?.user_name || "").replace(/^@/, "");
          const displayName = String(thread.other_user?.display_name || handle);
          return {
            handle,
            displayName,
            online: false,
            lastMessageText: thread.last_message?.body || null
          };
        });
    }

    try {
      const data = await this.#requestJson<DmsResponse>("api/cli/social/dms");
      return data.dms;
    } catch {
      return [];
    }
  }

  async loadDmMessages(handle: string): Promise<DmMessagesResponse> {
    const normalized = handle.replace(/^@/, "").trim().toLowerCase();
    const thread = await this.#openDmThread(normalized);
    return this.#buildDmMessagesResponse(thread.id, {
      id: 0,
      handle: normalized,
      displayName: normalized
    });
  }

  async sendDm(threadId: number, handle: string, text: string): Promise<DmMessagesResponse> {
    await this.#sendThreadMessage(threadId, text);
    const target = await this.#loadCachedUserByHandle(handle);
    return this.#buildDmMessagesResponse(threadId, target);
  }

  async loadLatestFeed(): Promise<FeedItem[]> {
    try {
      const data = await this.#requestJson<FeedResponse>("api/feed?limit=50");
      const items = data.items
        .filter((item) => item.type !== "tip" && (item.created_image_id || item.image_url))
        .map((item) => ({
          id: Number(item.created_image_id || item.id || 0),
          title: item.title || null,
          description: item.summary || null,
          url: item.image_url || null,
          thumbnail_url: item.thumbnail_url || null,
          created_at: item.created_at || new Date(0).toISOString(),
          published: true,
          published_at: item.created_at || null,
          media_type: item.media_type || "image",
          nsfw: Boolean(item.nsfw),
          ownerHandle: item.author_user_name || null,
          ownerDisplayName: item.author_display_name || item.author_user_name || null,
          prompt: null,
          metadata: null
        }));
      if (items.length > 0) {
        return items;
      }
    } catch {
      // Fall through to the local compatibility route used by the fixture server.
    }

    const legacy = await this.#requestJson<LegacyFeedResponse>("api/cli/social/feed/latest");
    return legacy.items;
  }

  async generatePrompt(options: {
    prompt: string;
    title?: string | null;
    server?: string | null;
    method?: string | null;
    share?: boolean;
  }): Promise<CreationSummary> {
    const data = await this.#requestJson<PromptResponse>("api/cli/prompts", {
      method: "POST",
      body: JSON.stringify(options)
    });
    return data.image;
  }

  async fetchImageBuffer(imagePath: string): Promise<Buffer> {
    const url = new URL(imagePath.replace(/^\//, ""), this.#baseUrl);
    const response = await fetch(url, {
      headers: this.#authHeaders()
    });
    if (!response.ok) {
      throw new Error(`Image request failed: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes);
  }

  async #buildRoomMessagesResponse(thread: ChatThread, roomName: string): Promise<RoomMessagesResponse> {
    const messages = await this.#loadThreadMessages(thread.id);
    const normalized = thread.channel_slug || normalizeChannelTag(roomName);
    return {
      threadId: thread.id,
      room: {
        name: normalized,
        title: `#${normalized}`,
        messageCount: messages.length,
        lastMessageText: messages[messages.length - 1]?.text || null
      },
      messages
    };
  }

  async #buildDmMessagesResponse(threadId: number, target: CachedUserIdentity): Promise<DmMessagesResponse> {
    const messages = await this.#loadThreadMessages(threadId);
    return {
      threadId,
      dm: {
        handle: target.handle,
        displayName: target.displayName,
        online: false,
        lastMessageText: messages[messages.length - 1]?.text || null
      },
      messages
    };
  }

  async #openDmThread(otherUser: number | string): Promise<ChatThread> {
    const body = typeof otherUser === "number"
      ? { other_user_id: otherUser }
      : { other_user_name: String(otherUser || "").replace(/^@/, "").trim().toLowerCase() };
    const data = await this.#requestJson<ChatThreadResponse>("api/chat/dm", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return data.thread;
  }

  async #openChannelThread(roomName: string): Promise<ChatThread> {
    const tag = normalizeChannelTag(roomName);
    const data = await this.#requestJson<ChatThreadResponse>("api/chat/channels", {
      method: "POST",
      body: JSON.stringify({ tag })
    });
    return data.thread;
  }

  async #sendThreadMessage(threadId: number, text: string): Promise<ChatSendResponse> {
    return this.#requestJson<ChatSendResponse>(`api/chat/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: text })
    });
  }

  async #loadThreadMessages(threadId: number): Promise<SocialMessage[]> {
    const data = await this.#requestJson<ChatMessagesResponse>(`api/chat/threads/${threadId}/messages?limit=50`);
    const senderIds = Array.from(new Set(
      data.messages
        .filter((message) => !message.sender_user_name)
        .map((message) => Number(message.sender_id))
        .filter(Number.isFinite)
    ));
    await Promise.all(senderIds.map((senderId) => this.#loadCachedUserById(senderId)));

    return data.messages.map((message) => {
      const senderId = Number(message.sender_id);
      const directHandle = String(message.sender_user_name || "").replace(/^@/, "").trim();
      if (directHandle) {
        this.#profileCacheById.set(senderId, {
          id: senderId,
          handle: directHandle,
          displayName: directHandle
        });
      }
      const sender = this.#profileCacheById.get(senderId);
      return {
        id: Number(message.id),
        authorHandle: sender?.handle || directHandle || `user${message.sender_id}`,
        authorDisplayName: sender?.displayName || sender?.handle || directHandle || `user${message.sender_id}`,
        text: String(message.body || ""),
        createdAt: message.created_at
      };
    });
  }

  async #loadCachedUserByHandle(handle: string): Promise<CachedUserIdentity> {
    const profile = await this.loadProfile(handle.replace(/^@/, ""));
    const id = Number(profile.user.id);
    const resolvedHandle = String(profile.profile.user_name || handle.replace(/^@/, "").trim());
    const cached: CachedUserIdentity = {
      id: Number.isFinite(id) ? id : 0,
      handle: resolvedHandle,
      displayName: String(profile.profile.display_name || resolvedHandle)
    };
    this.#profileCacheById.set(cached.id, cached);
    return cached;
  }

  async #loadCachedUserById(userId: number): Promise<CachedUserIdentity> {
    const cached = this.#profileCacheById.get(userId);
    if (cached) {
      return cached;
    }
    const profile = await this.#requestJson<UserProfileData>(`api/users/${userId}/profile`);
    const resolved: CachedUserIdentity = {
      id: userId,
      handle: String(profile.profile.user_name || `user${userId}`),
      displayName: String(profile.profile.display_name || profile.profile.user_name || `user${userId}`)
    };
    this.#profileCacheById.set(userId, resolved);
    return resolved;
  }

  async #listThreads(): Promise<ChatThreadListItem[] | null> {
    try {
      const data = await this.#requestJson<ChatThreadsResponse>("api/chat/threads");
      return data.threads;
    } catch {
      return null;
    }
  }

  async #requestJson<T>(pathname: string, init: RequestInit = {}, auth = true): Promise<T> {
    const url = new URL(pathname.replace(/^\//, ""), this.#baseUrl);
    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(auth ? this.#authHeaders() : {}),
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  #authHeaders(): Record<string, string> {
    const token = this.#getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  #usesOfficialHostedApi(): boolean {
    try {
      const url = new URL(this.#baseUrl);
      return url.hostname === "api.parascene.com" || url.hostname === "www.parascene.com" || url.hostname === "parascene.com";
    } catch {
      return false;
    }
  }
}

function mapProfileToAuthUser(profile: ProfileResponse): CliAuthUser {
  const email = String(profile.email || "");
  const fallbackHandle = email.includes("@") ? email.split("@")[0]! : "user";
  const handle = String(profile.profile?.user_name || fallbackHandle);
  const displayName = String(profile.profile?.display_name || handle);
  const role = String(profile.role || "user");
  const rawId = profile.id ?? profile.user?.id;
  const id = Number(rawId);

  return {
    id: Number.isFinite(id) ? id : 0,
    email,
    role,
    handle,
    displayName
  };
}

function normalizeChannelTag(input: string): string {
  return String(input || "")
    .replace(/^#/, "")
    .trim()
    .toLowerCase();
}
