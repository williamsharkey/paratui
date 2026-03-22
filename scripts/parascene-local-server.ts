import path from "node:path";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import sharp from "sharp";

process.env.NODE_ENV = "production";
process.env.DB_ADAPTER = "sqlite";

function resolveParasceneModule(relativePath: string): string {
  const baseDir = process.env.PARASCENE_REFERENCE_DIR
    ? path.resolve(process.env.PARASCENE_REFERENCE_DIR)
    : path.resolve(process.cwd(), "..", "parascene-reference");
  return pathToFileURL(path.join(baseDir, relativePath)).href;
}

const [
  { default: innerApp },
  { openDb },
  authModule
] = await Promise.all([
  import(resolveParasceneModule("api/index.js")),
  import(resolveParasceneModule("db/index.js")),
  import(resolveParasceneModule("api_routes/auth.js"))
]);

const { getJwtSecret, hashToken, ONE_WEEK_MS } = authModule;
const dbInstance = await openDb();
const { db, queries, storage } = dbInstance;

const app = express();
app.use(express.json());

function mergeCookie(req: express.Request, token: string): void {
  const cookiePart = `ps_session=${encodeURIComponent(token)}`;
  const existing = req.headers.cookie?.trim();
  req.headers.cookie = existing ? `${existing}; ${cookiePart}` : cookiePart;
}

app.use((req, _res, next) => {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) {
      mergeCookie(req, devApiKeys.get(token)?.sessionToken || token);
    }
  }
  next();
});

function normalizeUsername(input: string): string | null {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9][a-z0-9_]{2,23}$/.test(raw)) return null;
  return raw;
}

async function resolveLoginUser(raw: string): Promise<any | null> {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.includes("@")) {
    return queries.selectUserByEmail.get(value.toLowerCase());
  }

  const normalized = normalizeUsername(value);
  if (normalized && queries.selectUserProfileByUsername?.get && queries.selectUserByIdForLogin?.get) {
    const profile = await queries.selectUserProfileByUsername.get(normalized);
    if (profile?.user_id) {
      return queries.selectUserByIdForLogin.get(profile.user_id);
    }
  }
  return queries.selectUserByEmail.get(value.toLowerCase());
}

async function loadCliUser(userId: number) {
  const user = await queries.selectUserById.get(userId);
  const profile = await queries.selectUserProfileByUserId?.get?.(userId);
  const handle = profile?.user_name || String(user.email).split("@")[0];
  return {
    id: Number(user.id),
    email: String(user.email),
    role: String(user.role),
    handle,
    displayName: profile?.display_name || handle
  };
}

async function authenticateBearer(req: express.Request): Promise<number | null> {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return null;
  }

  const devRecord = devApiKeys.get(token);
  if (devRecord) {
    return devRecord.userId;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as { userId?: number };
    const userId = Number(decoded.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return null;
    }
    const session = await queries.selectSessionByTokenHash?.get?.(hashToken(token), userId);
    if (!session) {
      return null;
    }
    return userId;
  } catch {
    return null;
  }
}

function onlineFrom(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false;
  const delta = Date.now() - Date.parse(lastActiveAt);
  return Number.isFinite(delta) && delta <= 15 * 60 * 1000;
}

function parseJsonSafe(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function slugify(input: string, fallback: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function colorPair(seed: string): { background: string; accent: string } {
  let hash = 0;
  for (const char of seed) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const base = ((hash >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  const accent = ((((hash >>> 0) * 1103515245) >>> 8) & 0xffffff).toString(16).padStart(6, "0");
  return {
    background: `#${base}`,
    accent: `#${accent}`
  };
}

type SocialMessage = {
  id: number;
  authorId: number;
  authorHandle: string;
  authorDisplayName: string;
  text: string;
  createdAt: string;
};

type SocialRoom = {
  name: string;
  title: string;
  messages: SocialMessage[];
};

type SocialChatThread = {
  id: number;
  type: "dm" | "channel";
  dmPairKey: string | null;
  channelSlug: string | null;
  createdAt: string;
  memberUserIds: number[];
};

type CliUserRecord = {
  id: number;
  email: string;
  role: string;
  handle: string;
  displayName: string;
  online: boolean;
  lastActiveAt: string | null;
};

type DevApiKeyRecord = {
  userId: number;
  sessionToken: string;
};

const socialState: {
  nextMessageId: number;
  nextThreadId: number;
  rooms: Map<string, SocialRoom>;
  dms: Map<string, SocialMessage[]>;
  threadsById: Map<number, SocialChatThread>;
  threadIdByDmKey: Map<string, number>;
  threadIdByChannel: Map<string, number>;
} = {
  nextMessageId: 1,
  nextThreadId: 1,
  rooms: new Map(),
  dms: new Map(),
  threadsById: new Map(),
  threadIdByDmKey: new Map(),
  threadIdByChannel: new Map()
};

const devApiKeys = new Map<string, DevApiKeyRecord>();

function socialMessage(author: {
  id: number;
  handle: string;
  displayName: string;
}, text: string): SocialMessage {
  return {
    id: socialState.nextMessageId++,
    authorId: author.id,
    authorHandle: author.handle,
    authorDisplayName: author.displayName,
    text,
    createdAt: new Date().toISOString()
  };
}

async function listCliUsers() {
  const rows = await queries.selectUsers.all();
  return rows
    .filter((row: any) => row.role !== "admin")
    .map((row: any): CliUserRecord => ({
      id: Number(row.id),
      email: String(row.email),
      role: String(row.role),
      handle: row.user_name || String(row.email).split("@")[0],
      displayName: row.display_name || row.user_name || String(row.email).split("@")[0],
      online: onlineFrom(row.last_active_at || null),
      lastActiveAt: row.last_active_at || null
    }));
}

function devApiKeyForHandle(handle: string): string {
  return `psn_test_${handle.toLowerCase()}`;
}

async function seedDevApiKeys(): Promise<void> {
  if (devApiKeys.size > 0) {
    return;
  }

  const users = await listCliUsers();
  for (const user of users) {
    const apiKey = devApiKeyForHandle(user.handle);
    const sessionToken = jwt.sign({
      userId: user.id,
      jti: `${user.handle}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }, getJwtSecret(), {
      expiresIn: "7d"
    });
    await queries.insertSession.run(
      user.id,
      hashToken(sessionToken),
      new Date(Date.now() + ONE_WEEK_MS).toISOString()
    );
    devApiKeys.set(apiKey, {
      userId: user.id,
      sessionToken
    });
  }
}

async function findCliUserByHandle(handle: string) {
  const normalized = handle.replace(/^@/, "").trim().toLowerCase();
  const users = await listCliUsers();
  return users.find((user: CliUserRecord) => user.handle.toLowerCase() === normalized) || null;
}

function dmKey(firstUserId: number, secondUserId: number): string {
  return [firstUserId, secondUserId].sort((a, b) => a - b).join(":");
}

function roomSummary(room: SocialRoom) {
  const last = room.messages[room.messages.length - 1] || null;
  return {
    name: room.name,
    title: room.title,
    messageCount: room.messages.length,
    lastMessageText: last?.text || null
  };
}

function normalizeChannelTag(input: string): string | null {
  const normalized = String(input || "").replace(/^#/, "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function chatThreadSummary(thread: SocialChatThread) {
  return {
    id: thread.id,
    type: thread.type,
    dm_pair_key: thread.dmPairKey,
    channel_slug: thread.channelSlug,
    created_at: thread.createdAt
  };
}

async function chatThreadListEntry(thread: SocialChatThread, viewerId: number) {
  const messages = messagesForThread(thread);
  const last = messages[messages.length - 1] || null;

  if (thread.type === "channel") {
    return {
      ...chatThreadSummary(thread),
      title: `#${thread.channelSlug || "room"}`,
      last_message: last
        ? {
            body: last.text,
            created_at: last.createdAt,
            sender_id: last.authorId
          }
        : null
    };
  }

  const otherUserId = thread.memberUserIds.find((userId) => userId !== viewerId) || viewerId;
  const otherUser = await loadCliUser(otherUserId);
  return {
    ...chatThreadSummary(thread),
    other_user_id: otherUser.id,
    title: `@${otherUser.handle}`,
    other_user: {
      id: otherUser.id,
      display_name: otherUser.displayName,
      user_name: otherUser.handle,
      avatar_url: null
    },
    last_message: last
      ? {
          body: last.text,
          created_at: last.createdAt,
          sender_id: last.authorId
        }
      : null
  };
}

function ensureThreadMembers(thread: SocialChatThread, ...userIds: number[]): void {
  for (const userId of userIds) {
    if (!thread.memberUserIds.includes(userId)) {
      thread.memberUserIds.push(userId);
    }
  }
}

function ensureRoomThread(roomName: string, memberUserIds: number[] = []): SocialChatThread {
  const normalized = normalizeChannelTag(roomName);
  if (!normalized) {
    throw new Error("Invalid channel");
  }

  let threadId = socialState.threadIdByChannel.get(normalized);
  if (threadId) {
    const existing = socialState.threadsById.get(threadId);
    if (!existing) {
      throw new Error("Missing channel thread");
    }
    ensureThreadMembers(existing, ...memberUserIds);
    if (!socialState.rooms.has(normalized)) {
      socialState.rooms.set(normalized, {
        name: normalized,
        title: `room:${normalized}`,
        messages: []
      });
    }
    return existing;
  }

  const thread: SocialChatThread = {
    id: socialState.nextThreadId++,
    type: "channel",
    dmPairKey: null,
    channelSlug: normalized,
    createdAt: new Date().toISOString(),
    memberUserIds: [...memberUserIds]
  };
  socialState.threadsById.set(thread.id, thread);
  socialState.threadIdByChannel.set(normalized, thread.id);
  if (!socialState.rooms.has(normalized)) {
    socialState.rooms.set(normalized, {
      name: normalized,
      title: `room:${normalized}`,
      messages: []
    });
  }
  return thread;
}

function ensureDmThread(firstUserId: number, secondUserId: number): SocialChatThread {
  const key = dmKey(firstUserId, secondUserId);
  let threadId = socialState.threadIdByDmKey.get(key);
  if (threadId) {
    const existing = socialState.threadsById.get(threadId);
    if (!existing) {
      throw new Error("Missing dm thread");
    }
    ensureThreadMembers(existing, firstUserId, secondUserId);
    if (!socialState.dms.has(key)) {
      socialState.dms.set(key, []);
    }
    return existing;
  }

  const thread: SocialChatThread = {
    id: socialState.nextThreadId++,
    type: "dm",
    dmPairKey: key,
    channelSlug: null,
    createdAt: new Date().toISOString(),
    memberUserIds: [firstUserId, secondUserId]
  };
  socialState.threadsById.set(thread.id, thread);
  socialState.threadIdByDmKey.set(key, thread.id);
  if (!socialState.dms.has(key)) {
    socialState.dms.set(key, []);
  }
  return thread;
}

function messagesForThread(thread: SocialChatThread): SocialMessage[] {
  if (thread.type === "channel") {
    return socialState.rooms.get(String(thread.channelSlug || ""))?.messages || [];
  }
  return socialState.dms.get(String(thread.dmPairKey || "")) || [];
}

function replaceMessagesForThread(thread: SocialChatThread, messages: SocialMessage[]): void {
  if (thread.type === "channel") {
    const key = String(thread.channelSlug || "");
    const room = socialState.rooms.get(key) || {
      name: key,
      title: `room:${key}`,
      messages: []
    };
    room.messages = messages;
    socialState.rooms.set(key, room);
    return;
  }
  socialState.dms.set(String(thread.dmPairKey || ""), messages);
}

function serializeChatMessage(threadId: number, message: SocialMessage) {
  return {
    id: message.id,
    thread_id: threadId,
    sender_id: message.authorId,
    body: message.text,
    created_at: message.createdAt,
    sender_user_name: message.authorHandle,
    sender_avatar_url: null,
    reactions: {},
    viewer_reactions: []
  };
}

function encodeBeforeCursor(message: SocialMessage | null): string | null {
  if (!message) {
    return null;
  }
  return Buffer.from(JSON.stringify({ id: message.id }), "utf8").toString("base64url");
}

function decodeBeforeCursor(input: string): number | null {
  try {
    const decoded = JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as { id?: number };
    const id = Number(decoded.id);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

async function seedSocialState(): Promise<void> {
  if (socialState.rooms.size > 0) {
    return;
  }

  const sharkgod = await findCliUserByHandle("sharkgod");
  const crosshj = await findCliUserByHandle("crosshj");
  const noirguy = await findCliUserByHandle("noirguy");
  if (!sharkgod || !crosshj || !noirguy) {
    return;
  }

  socialState.rooms.set("noir", {
    name: "noir",
    title: "room:noir",
    messages: [
      socialMessage(crosshj, "night feed is clean"),
      socialMessage(noirguy, "dropping rain studies")
    ]
  });
  socialState.rooms.set("mutations", {
    name: "mutations",
    title: "room:mutations",
    messages: [
      socialMessage(sharkgod, "slot A is locked"),
      socialMessage(crosshj, "chain two prompts and post it")
    ]
  });

  socialState.dms.set(dmKey(sharkgod.id, crosshj.id), [
    socialMessage(crosshj, "you should see the latest tunnel pass"),
    socialMessage(sharkgod, "opening it now")
  ]);
  socialState.dms.set(dmKey(sharkgod.id, noirguy.id), [
    socialMessage(noirguy, "room noir is live")
  ]);

  ensureRoomThread("noir", [sharkgod.id, crosshj.id, noirguy.id]);
  ensureRoomThread("mutations", [sharkgod.id, crosshj.id]);
  ensureDmThread(sharkgod.id, crosshj.id);
  ensureDmThread(sharkgod.id, noirguy.id);
}

function serializeCreationRow(row: any) {
  const meta = parseJsonSafe(row.meta);
  return {
    id: Number(row.id),
    title: row.title || null,
    description: row.description || null,
    url: row.file_path || null,
    thumbnail_url: row.file_path ? `${row.file_path}?variant=thumbnail` : null,
    created_at: row.created_at,
    published: Boolean(row.published),
    published_at: row.published_at || null,
    media_type: String(meta?.media_type || "image"),
    nsfw: Boolean(meta?.nsfw),
    ownerHandle: row.owner_handle || null,
    ownerDisplayName: row.owner_display_name || row.owner_handle || null,
    prompt: typeof meta?.prompt === "string" ? meta.prompt : null,
    metadata: meta
  };
}

async function generatePromptImage(options: {
  userId: number;
  prompt: string;
  title: string;
  server: string | null;
  method: string | null;
  share: boolean;
}) {
  const user = await loadCliUser(options.userId);
  const colors = colorPair(`${options.prompt}:${options.title}`);
  const promptLabel = options.prompt.slice(0, 48);
  const titleLabel = options.title.slice(0, 28);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="192" viewBox="0 0 256 192">
      <rect width="256" height="192" fill="${colors.background}" />
      <rect x="18" y="18" width="220" height="156" rx="14" fill="none" stroke="${colors.accent}" stroke-width="5" />
      <circle cx="64" cy="64" r="24" fill="${colors.accent}" opacity="0.75" />
      <rect x="28" y="118" width="200" height="12" rx="6" fill="${colors.accent}" opacity="0.35" />
      <text x="28" y="92" fill="${colors.accent}" font-size="20" font-family="monospace">${titleLabel}</text>
      <text x="28" y="150" fill="${colors.accent}" font-size="12" font-family="monospace">${promptLabel}</text>
    </svg>
  `;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const baseSlug = slugify(options.title || options.prompt, "prompt");
  const filename = `${baseSlug}-${user.handle}-${Date.now()}.png`;
  await storage.uploadImage(buffer, filename);
  const filePath = `/api/images/created/${filename}`;
  const meta = {
    nsfw: false,
    media_type: "image",
    prompt: options.prompt,
    generation_server: options.server,
    generation_method: options.method,
    generated_by: "paratui-local"
  };
  const insert = await queries.insertCreatedImage.run(
    options.userId,
    filename,
    filePath,
    256,
    192,
    colors.background,
    "completed",
    meta
  );
  const creationId = Number(insert.insertId || insert.lastInsertRowid);
  await queries.publishCreatedImage.run(creationId, options.userId, options.title, options.prompt, false);
  const row = db.prepare(
    `SELECT ci.id, ci.file_path, ci.created_at, ci.published, ci.published_at, ci.title, ci.description, ci.meta,
            up.user_name AS owner_handle, up.display_name AS owner_display_name
     FROM created_images ci
     LEFT JOIN user_profiles up ON up.user_id = ci.user_id
     WHERE ci.id = ?`
  ).get(creationId);
  return serializeCreationRow(row);
}

await seedSocialState();
await seedDevApiKeys();

app.get("/api/cli/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/cli/auth/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const user = await resolveLoginUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ userId: user.id }, getJwtSecret(), {
    expiresIn: "7d"
  });
  await queries.insertSession.run(user.id, hashToken(token), new Date(Date.now() + ONE_WEEK_MS).toISOString());
  await queries.updateUserLastActive?.run?.(user.id);
  const cliUser = await loadCliUser(Number(user.id));
  return res.json({
    ok: true,
    token,
    user: cliUser
  });
});

app.post("/api/cli/auth/revoke", async (req, res) => {
  const userId = await authenticateBearer(req);
  const header = req.header("authorization");
  if (!userId || !header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice("Bearer ".length).trim();
  await queries.deleteSessionByTokenHash?.run?.(hashToken(token), userId);
  return res.json({ ok: true });
});

app.get("/api/cli/me", async (req, res) => {
  const userId = await authenticateBearer(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = await loadCliUser(userId);
  return res.json({ ok: true, user });
});

app.get("/api/cli/users", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const rows = await queries.selectUsers.all();
  const users = rows
    .map((row: any) => {
      const handle = row.user_name || String(row.email).split("@")[0];
      return {
        id: Number(row.id),
        email: String(row.email),
        role: String(row.role),
        handle,
        displayName: row.display_name || handle,
        online: Number(row.id) === viewerId || onlineFrom(row.last_active_at || null),
        lastActiveAt: row.last_active_at || null
      };
    })
    .filter((row: any) => row.role !== "admin")
    .sort((a: any, b: any) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return String(a.handle).localeCompare(String(b.handle));
    });

  return res.json({ users });
});

app.post("/api/chat/dm", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const rawTargetId = req.body?.other_user_id ?? req.body?.otherUserId;
  const rawTargetName = req.body?.other_user_name ?? req.body?.otherUsername ?? req.body?.username;
  let targetUserId = Number(rawTargetId);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    const normalized = normalizeUsername(String(rawTargetName || ""));
    if (!normalized) {
      return res.status(400).json({ error: "Bad request", message: "other user required" });
    }
    const target = await findCliUserByHandle(normalized);
    if (!target) {
      return res.status(404).json({ error: "Not found", message: "user not found" });
    }
    targetUserId = target.id;
  }
  if (targetUserId === viewerId) {
    return res.status(400).json({ error: "Bad request", message: "cannot DM yourself" });
  }

  try {
    await loadCliUser(targetUserId);
  } catch {
    return res.status(404).json({ error: "Not found", message: "user not found" });
  }

  await seedSocialState();
  const thread = ensureDmThread(viewerId, targetUserId);
  return res.json({
    thread: chatThreadSummary(thread)
  });
});

app.post("/api/chat/channels", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const normalized = normalizeChannelTag(req.body?.tag ?? req.body?.channel);
  if (!normalized) {
    return res.status(400).json({ error: "Bad request", message: "tag required" });
  }

  await seedSocialState();
  const thread = ensureRoomThread(normalized, [viewerId]);
  return res.json({
    thread: chatThreadSummary(thread)
  });
});

app.get("/api/chat/threads", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  await seedSocialState();
  const visibleThreads = Array.from(socialState.threadsById.values())
    .filter((thread) => thread.memberUserIds.includes(viewerId));

  const entries = await Promise.all(visibleThreads.map((thread) => chatThreadListEntry(thread, viewerId)));
  entries.sort((left, right) => {
    const leftStamp = left.last_message?.created_at || left.created_at || "";
    const rightStamp = right.last_message?.created_at || right.created_at || "";
    return rightStamp.localeCompare(leftStamp);
  });

  return res.json({
    viewer_id: viewerId,
    threads: entries
  });
});

app.get("/api/chat/threads/:threadId", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const threadId = Number(req.params.threadId);
  const thread = socialState.threadsById.get(threadId);
  if (!thread) {
    return res.status(404).json({ error: "Not found", message: "thread not found" });
  }
  if (!thread.memberUserIds.includes(viewerId)) {
    return res.status(403).json({ error: "Forbidden", message: "not a member" });
  }
  return res.json({
    thread: chatThreadSummary(thread)
  });
});

app.get("/api/chat/threads/:threadId/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const threadId = Number(req.params.threadId);
  if (!Number.isFinite(threadId) || threadId <= 0) {
    return res.status(400).json({ error: "Bad request", message: "invalid threadId" });
  }
  const thread = socialState.threadsById.get(threadId);
  if (!thread) {
    return res.status(404).json({ error: "Not found", message: "thread not found" });
  }
  if (!thread.memberUserIds.includes(viewerId)) {
    return res.status(403).json({ error: "Forbidden", message: "not a member" });
  }

  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50) || 50));
  const beforeRaw = typeof req.query.before === "string" ? req.query.before : "";
  const messages = messagesForThread(thread);
  let eligible = messages;
  if (beforeRaw) {
    const beforeId = decodeBeforeCursor(beforeRaw);
    if (!beforeId) {
      return res.status(400).json({ error: "Bad request", message: "invalid before" });
    }
    eligible = messages.filter((message) => message.id < beforeId);
  }
  const page = eligible.slice(-limit);
  const hasMore = eligible.length > page.length;
  const nextBefore = hasMore ? encodeBeforeCursor(page[0] || null) : null;
  return res.json({
    messages: page.map((message) => serializeChatMessage(thread.id, message)),
    hasMore,
    nextBefore
  });
});

app.post("/api/chat/threads/:threadId/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const threadId = Number(req.params.threadId);
  if (!Number.isFinite(threadId) || threadId <= 0) {
    return res.status(400).json({ error: "Bad request", message: "invalid threadId" });
  }
  const thread = socialState.threadsById.get(threadId);
  if (!thread) {
    return res.status(404).json({ error: "Not found", message: "thread not found" });
  }
  if (!thread.memberUserIds.includes(viewerId)) {
    return res.status(403).json({ error: "Forbidden", message: "not a member" });
  }

  const body = String(req.body?.body || "").trim();
  if (!body) {
    return res.status(400).json({ error: "Bad request", message: "body required" });
  }
  if (body.length > 4000) {
    return res.status(400).json({ error: "Bad request", message: "body too long" });
  }

  const author = await loadCliUser(viewerId);
  const nextMessages = [...messagesForThread(thread), socialMessage(author, body)];
  replaceMessagesForThread(thread, nextMessages);
  const message = nextMessages[nextMessages.length - 1]!;
  return res.status(201).json({
    message: serializeChatMessage(thread.id, message)
  });
});

app.get("/api/cli/social/rooms", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await seedSocialState();
  return res.json({
    rooms: Array.from(socialState.rooms.values()).map(roomSummary)
  });
});

app.get("/api/cli/social/rooms/:room/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await seedSocialState();
  const room = socialState.rooms.get(String(req.params.room || "").toLowerCase());
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  return res.json({
    room: roomSummary(room),
    messages: room.messages
  });
});

app.post("/api/cli/social/rooms/:room/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "Message text is required" });
  }
  await seedSocialState();
  const room = socialState.rooms.get(String(req.params.room || "").toLowerCase());
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  const author = await loadCliUser(viewerId);
  room.messages.push(socialMessage(author, text));
  return res.json({
    room: roomSummary(room),
    messages: room.messages
  });
});

app.get("/api/cli/social/dms", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await seedSocialState();
  const users = await listCliUsers();
  const dms = users
    .filter((user: CliUserRecord) => user.id !== viewerId)
    .map((user: CliUserRecord) => {
      const messages = socialState.dms.get(dmKey(viewerId, user.id)) || [];
      const last = messages[messages.length - 1] || null;
      return {
        handle: user.handle,
        displayName: user.displayName,
        online: user.online,
        lastMessageText: last?.text || null
      };
    })
    .sort((a: { online: boolean; handle: string }, b: { online: boolean; handle: string }) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
  return res.json({ dms });
});

app.get("/api/cli/social/dms/:handle/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await seedSocialState();
  const target = await findCliUserByHandle(String(req.params.handle || ""));
  if (!target) {
    return res.status(404).json({ error: "User not found" });
  }
  const messages = socialState.dms.get(dmKey(viewerId, target.id)) || [];
  return res.json({
    dm: {
      handle: target.handle,
      displayName: target.displayName,
      online: target.online,
      lastMessageText: messages[messages.length - 1]?.text || null
    },
    messages
  });
});

app.post("/api/cli/social/dms/:handle/messages", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ error: "Message text is required" });
  }
  await seedSocialState();
  const target = await findCliUserByHandle(String(req.params.handle || ""));
  if (!target) {
    return res.status(404).json({ error: "User not found" });
  }
  const author = await loadCliUser(viewerId);
  const key = dmKey(viewerId, target.id);
  const messages = socialState.dms.get(key) || [];
  messages.push(socialMessage(author, text));
  socialState.dms.set(key, messages);
  return res.json({
    dm: {
      handle: target.handle,
      displayName: target.displayName,
      online: target.online,
      lastMessageText: messages[messages.length - 1]?.text || null
    },
    messages
  });
});

app.get("/api/cli/social/feed/latest", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const rows = db.prepare(
    `SELECT ci.id, ci.file_path, ci.created_at, ci.published, ci.published_at, ci.title, ci.description, ci.meta,
            up.user_name AS owner_handle, up.display_name AS owner_display_name
     FROM created_images ci
     LEFT JOIN user_profiles up ON up.user_id = ci.user_id
     WHERE ci.published = 1 AND (ci.unavailable_at IS NULL OR ci.unavailable_at = '')
     ORDER BY COALESCE(ci.published_at, ci.created_at) DESC, ci.id DESC
     LIMIT 25`
  ).all();
  return res.json({
    items: rows.map(serializeCreationRow)
  });
});

app.post("/api/cli/prompts", async (req, res) => {
  const viewerId = await authenticateBearer(req);
  if (!viewerId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const prompt = String(req.body?.prompt || "").trim();
  const title = String(req.body?.title || prompt || "untitled").trim();
  const serverName = req.body?.server ? String(req.body.server) : null;
  const method = req.body?.method ? String(req.body.method) : null;
  const share = req.body?.share !== false;
  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  const image = await generatePromptImage({
    userId: viewerId,
    prompt,
    title,
    server: serverName,
    method,
    share
  });
  return res.json({ ok: true, image });
});

app.use(innerApp);

const port = Number(process.env.PORT || "2367");
app.listen(port, () => {
  console.log(`PARASCENE_LOCAL_READY http://127.0.0.1:${port}`);
});
