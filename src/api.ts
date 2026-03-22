import type {
  ActivityItem,
  CliAuthUser,
  CliUserSummary,
  CreationSummary,
  DmSummary,
  FeedItem,
  NotificationSummary,
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

interface FollowingResponse {
  following: Array<{
    user_id?: number;
    user_name?: string | null;
    display_name?: string | null;
    followed_at?: string | null;
  }>;
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

interface NotificationsResponse {
  notifications: NotificationSummary[];
}

interface NotificationUnreadCountResponse {
  count?: number;
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

interface UploadedImageResponse {
  ok?: boolean;
  key: string;
  url: string;
}

interface CreateImageResponse {
  id: number;
  status?: string | null;
}

interface CreateImageDetailResponse {
  id: number;
  url?: string | null;
  thumbnail_url?: string | null;
  created_at?: string | null;
  published?: boolean;
  published_at?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  media_type?: string | null;
  nsfw?: boolean;
  meta?: Record<string, unknown> | null;
  creator?: {
    user_name?: string | null;
    display_name?: string | null;
  } | null;
}

interface ShareCreationResponse {
  url?: string | null;
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

interface ServerMethodField {
  type?: string | null;
  required?: boolean;
}

interface ServerMethodConfig {
  fields?: Record<string, ServerMethodField> | null;
  intent?: string | null;
  intents?: string[] | null;
  default?: boolean;
}

interface ServerConfigResponse {
  methods?: Record<string, ServerMethodConfig> | null;
}

interface ServerSummary {
  id: number;
  server_config?: ServerConfigResponse | string | null;
}

interface ServersResponse {
  servers?: ServerSummary[];
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

interface UploadTarget {
  serverId: number;
  method: string;
}

interface SocialListSummary {
  rooms: RoomSummary[];
  dms: DmSummary[];
}

interface SupabaseSessionResponse {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  expires_at?: number | null;
  token_type?: string | null;
}

export interface ParasceneRealtimeConfig {
  url: string;
  anonKey: string;
}

export interface ParasceneRealtimeSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  expiresAt: number | null;
  tokenType: string;
}

export class ParasceneClient {
  #baseUrl: string;
  #getToken: () => string | null;
  #profileCacheById = new Map<number, CachedUserIdentity>();
  #uploadTargetPromise: Promise<UploadTarget> | null = null;

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

  async listUsers(viewerHandle?: string | null): Promise<CliUserSummary[]> {
    const presenceUsers = await this.listPresenceUsers();
    const presenceByHandle = new Map(
      (presenceUsers || []).map((user) => [user.handle, user] as const)
    );

    if (viewerHandle) {
      try {
        const data = await this.#requestJson<FollowingResponse>(
          `api/users/by-username/${encodeURIComponent(viewerHandle)}/following?limit=100`
        );
        const followed = data.following
          .map((user) => {
            const handle = String(user.user_name || "").trim();
            if (!handle) {
              return null;
            }
            const presence = presenceByHandle.get(handle);
            return {
              id: Number(user.user_id || presence?.id || 0),
              email: presence?.email || "",
              role: presence?.role || "user",
              handle,
              displayName: String(user.display_name || handle),
              online: presence?.online || false,
              lastActiveAt: presence?.lastActiveAt || user.followed_at || null
            } satisfies CliUserSummary;
          })
          .filter((user): user is CliUserSummary => Boolean(user));
        if (followed.length > 0) {
          return followed;
        }
      } catch {
        // Fall through to presence/feed discovery.
      }
    }

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

  async loadNotifications(limit = 40): Promise<NotificationSummary[]> {
    const data = await this.#requestJson<NotificationsResponse>(`api/notifications?limit=${limit}`);
    return Array.isArray(data.notifications) ? data.notifications : [];
  }

  async loadNotificationUnreadCount(): Promise<number> {
    const data = await this.#requestJson<NotificationUnreadCountResponse>("api/notifications/unread-count");
    return Number(data.count || 0);
  }

  async acknowledgeNotification(notificationId: number): Promise<void> {
    await this.#requestJson<unknown>("api/notifications/acknowledge", {
      method: "POST",
      body: JSON.stringify({ id: notificationId })
    });
  }

  async acknowledgeAllNotifications(): Promise<void> {
    await this.#requestJson<unknown>("api/notifications/acknowledge-all", {
      method: "POST",
      body: JSON.stringify({})
    });
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
    const social = await this.listSocialSummaries();
    if (social.rooms.length || this.#usesOfficialHostedApi()) {
      return social.rooms;
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
    const social = await this.listSocialSummaries();
    if (social.dms.length || this.#usesOfficialHostedApi()) {
      return social.dms;
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

  async uploadImageBufferAsPublic(options: {
    buffer: Buffer;
    filename: string;
    title: string;
    description: string;
    timeoutMs?: number;
  }): Promise<{
    creation: CreationSummary;
    shareUrl: string;
  }> {
    const upload = await this.#uploadGenericImage(options.buffer, options.filename);
    const target = await this.#resolveUploadTarget();
    const created = await this.#requestJson<CreateImageResponse>("api/create", {
      method: "POST",
      body: JSON.stringify({
        server_id: target.serverId,
        method: target.method,
        args: {
          image_url: upload.url
        },
        creation_token: createCreationToken()
      })
    });

    const completed = await this.#waitForCreationComplete(created.id, options.timeoutMs);
    const published = await this.#requestJson<CreateImageDetailResponse>(`api/create/images/${created.id}/publish`, {
      method: "POST",
      body: JSON.stringify({
        title: options.title,
        description: options.description,
        nsfw: false
      })
    });

    let shareUrl = "";
    try {
      const share = await this.#requestJson<ShareCreationResponse>(`api/create/images/${created.id}/share`, {
        method: "POST"
      });
      shareUrl = String(share.url || "").trim();
    } catch {
      shareUrl = "";
    }

    return {
      creation: mapCreateImageDetail(published.url ? published : completed),
      shareUrl: shareUrl || this.#fallbackCreationUrl(created.id)
    };
  }

  async createHostedRealtimeSession(): Promise<ParasceneRealtimeSession | null> {
    try {
      const session = await this.#requestJson<SupabaseSessionResponse>("api/auth/supabase-session", {
        method: "POST",
        body: JSON.stringify({})
      });
      const accessToken = String(session.access_token || "").trim();
      const refreshToken = String(session.refresh_token || "").trim();
      if (!accessToken || !refreshToken) {
        return null;
      }
      return {
        accessToken,
        refreshToken,
        expiresIn: Number.isFinite(Number(session.expires_in)) ? Number(session.expires_in) : null,
        expiresAt: Number.isFinite(Number(session.expires_at)) ? Number(session.expires_at) : null,
        tokenType: String(session.token_type || "bearer")
      };
    } catch {
      return null;
    }
  }

  async discoverHostedRealtimeConfig(): Promise<ParasceneRealtimeConfig | null> {
    const token = this.#getToken();
    const url = this.#hostedAppDiscoveryUrl();
    if (!token || !url) {
      return null;
    }

    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/html",
          authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) {
        return null;
      }
      return parseHostedRealtimeConfigFromHtml(await response.text());
    } catch {
      return null;
    }
  }

  async bootstrapHostedRealtime(explicitConfig: ParasceneRealtimeConfig | null = null): Promise<{
    config: ParasceneRealtimeConfig;
    session: ParasceneRealtimeSession;
  } | null> {
    const config = explicitConfig || await this.discoverHostedRealtimeConfig();
    if (!config) {
      return null;
    }
    const session = await this.createHostedRealtimeSession();
    if (!session) {
      return null;
    }
    return {
      config,
      session
    };
  }

  async listSocialSummaries(): Promise<SocialListSummary> {
    const threads = await this.#listThreads();
    if (threads) {
      return {
        rooms: threads
          .filter((thread) => thread.type === "channel" && thread.channel_slug)
          .map((thread) => ({
            name: String(thread.channel_slug || "").toLowerCase(),
            title: thread.title || `#${String(thread.channel_slug || "").toLowerCase()}`,
            messageCount: 0,
            lastMessageText: thread.last_message?.body || null,
            lastMessageAt: thread.last_message?.created_at || null
          }))
          .sort(compareThreadActivity),
        dms: threads
          .filter((thread) => thread.type === "dm" && thread.other_user?.user_name)
          .map((thread) => {
            const handle = String(thread.other_user?.user_name || "").replace(/^@/, "");
            const displayName = String(thread.other_user?.display_name || handle);
            return {
              handle,
              displayName,
              online: false,
              lastMessageText: thread.last_message?.body || null,
              lastMessageAt: thread.last_message?.created_at || null
            };
          })
          .sort(compareThreadActivity)
      };
    }

    if (this.#usesOfficialHostedApi()) {
      return {
        rooms: [],
        dms: []
      };
    }

    const [rooms, dms] = await Promise.allSettled([
      this.#requestJson<RoomsResponse>("api/cli/social/rooms"),
      this.#requestJson<DmsResponse>("api/cli/social/dms")
    ]);

    return {
      rooms: rooms.status === "fulfilled" ? rooms.value.rooms : [],
      dms: dms.status === "fulfilled" ? dms.value.dms : []
    };
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
        lastMessageText: messages[messages.length - 1]?.text || null,
        lastMessageAt: messages[messages.length - 1]?.createdAt || null
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
        lastMessageText: messages[messages.length - 1]?.text || null,
        lastMessageAt: messages[messages.length - 1]?.createdAt || null
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

  async #uploadGenericImage(buffer: Buffer, filename: string): Promise<UploadedImageResponse> {
    const response = await fetch(new URL("api/images/generic", this.#baseUrl), {
      method: "POST",
      headers: {
        ...this.#authHeaders(),
        "content-type": guessImageContentType(filename),
        "x-upload-kind": "edited",
        "x-upload-name": filename
      },
      body: new Uint8Array(buffer)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Upload failed: ${response.status}`);
    }

    return response.json() as Promise<UploadedImageResponse>;
  }

  async #resolveUploadTarget(): Promise<UploadTarget> {
    if (!this.#uploadTargetPromise) {
      this.#uploadTargetPromise = this.#loadUploadTarget().catch((error) => {
        this.#uploadTargetPromise = null;
        throw error;
      });
    }
    return this.#uploadTargetPromise;
  }

  async #loadUploadTarget(): Promise<UploadTarget> {
    try {
      const data = await this.#requestJson<ServersResponse | ServerSummary[]>("api/servers");
      const servers = Array.isArray(data) ? data : data.servers || [];
      for (const server of servers) {
        const config = normalizeServerConfig(server.server_config);
        const methods = config?.methods || {};
        if (methods.uploadImage) {
          return {
            serverId: Number(server.id),
            method: "uploadImage"
          };
        }
      }

      for (const server of servers) {
        const config = normalizeServerConfig(server.server_config);
        const methods = config?.methods || {};
        for (const [methodKey, method] of Object.entries(methods)) {
          const fields = method?.fields || {};
          const fieldEntries = Object.entries(fields);
          if (fieldEntries.length !== 1) {
            continue;
          }
          const [fieldKey, fieldConfig] = fieldEntries[0]!;
          if (fieldKey === "image_url" && fieldConfig?.type === "image_url") {
            return {
              serverId: Number(server.id),
              method: methodKey
            };
          }
        }
      }
    } catch {
      // Fall through to the known hosted default.
    }

    return {
      serverId: 1,
      method: "uploadImage"
    };
  }

  async #waitForCreationComplete(creationId: number, timeoutMs = 30_000): Promise<CreateImageDetailResponse> {
    const deadline = Date.now() + timeoutMs;
    let lastDetail: CreateImageDetailResponse | null = null;

    while (Date.now() <= deadline) {
      const detail = await this.#requestJson<CreateImageDetailResponse>(`api/create/images/${creationId}`);
      lastDetail = detail;
      if (detail.status === "completed" && detail.url) {
        return detail;
      }
      if (detail.status === "failed") {
        throw new Error("Image upload failed on parascene");
      }
      await sleep(500);
    }

    throw new Error(`Timed out waiting for uploaded image ${creationId}${lastDetail?.status ? ` (${lastDetail.status})` : ""}`);
  }

  #fallbackCreationUrl(creationId: number): string {
    try {
      const base = new URL(this.#baseUrl);
      if (base.hostname === "api.parascene.com") {
        return `https://www.parascene.com/creations/${creationId}`;
      }
      if (base.hostname === "www.parascene.com" || base.hostname === "parascene.com") {
        return `https://${base.hostname}/creations/${creationId}`;
      }
      return new URL(`creations/${creationId}`, this.#baseUrl).toString();
    } catch {
      return `/creations/${creationId}`;
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

  #hostedAppDiscoveryUrl(): URL | null {
    try {
      const base = new URL(this.#baseUrl);
      if (base.hostname === "api.parascene.com") {
        return new URL("https://www.parascene.com/connect");
      }
      if (base.hostname.startsWith("api.")) {
        base.hostname = `www.${base.hostname.slice(4)}`;
      }
      base.pathname = "/connect";
      base.search = "";
      base.hash = "";
      return base;
    } catch {
      return null;
    }
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

function compareThreadActivity(
  left: { name?: string; handle?: string; lastMessageAt?: string | null },
  right: { name?: string; handle?: string; lastMessageAt?: string | null }
): number {
  const leftStamp = Date.parse(left.lastMessageAt || "");
  const rightStamp = Date.parse(right.lastMessageAt || "");
  if (Number.isFinite(leftStamp) || Number.isFinite(rightStamp)) {
    if (!Number.isFinite(leftStamp)) {
      return 1;
    }
    if (!Number.isFinite(rightStamp)) {
      return -1;
    }
    if (leftStamp !== rightStamp) {
      return rightStamp - leftStamp;
    }
  }
  const leftName = String(left.handle || left.name || "");
  const rightName = String(right.handle || right.name || "");
  return leftName.localeCompare(rightName);
}

export function parseHostedRealtimeConfigFromHtml(html: string): ParasceneRealtimeConfig | null {
  const match = String(html || "").match(/window\.__PRSN_SUPABASE__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as Partial<ParasceneRealtimeConfig>;
    const url = String(parsed.url || "").trim();
    const anonKey = String(parsed.anonKey || "").trim();
    if (!url || !anonKey) {
      return null;
    }
    return {
      url,
      anonKey
    };
  } catch {
    return null;
  }
}

function normalizeServerConfig(value: ServerSummary["server_config"]): ServerConfigResponse | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ServerConfigResponse;
    } catch {
      return null;
    }
  }
  return value;
}

function mapCreateImageDetail(detail: CreateImageDetailResponse): CreationSummary {
  return {
    id: Number(detail.id),
    title: detail.title || null,
    description: detail.description || null,
    url: detail.url || null,
    thumbnail_url: detail.thumbnail_url || detail.url || null,
    created_at: detail.created_at || new Date(0).toISOString(),
    published: Boolean(detail.published),
    published_at: detail.published_at || null,
    media_type: detail.media_type || "image",
    nsfw: Boolean(detail.nsfw),
    ownerHandle: detail.creator?.user_name || null,
    ownerDisplayName: detail.creator?.display_name || detail.creator?.user_name || null,
    prompt: null,
    metadata: detail.meta || null
  };
}

function createCreationToken(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `crt_${stamp}_${random}`;
}

function guessImageContentType(filename: string): string {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".bmp")) {
    return "image/bmp";
  }
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
    return "image/tiff";
  }
  return "image/png";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
