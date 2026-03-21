import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";

export interface RealtimeIdentity {
  userId?: number | null;
  handle: string;
  displayName: string;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface RealtimeServerOptions {
  host?: string;
  port?: number;
  publicHost?: string | null;
  authBaseUrl?: string | null;
  devBearerTokens?: Record<string, RealtimeIdentity>;
  stunServers?: string[];
  turnHost?: string | null;
  turnPort?: number;
  turnSecret?: string | null;
  turnTtlSeconds?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

export interface RealtimeServerHandle {
  host: string;
  port: number;
  server: http.Server;
  stop: () => Promise<void>;
}

type ClientToServerMessage =
  | {
      type: "auth";
      token: string;
      room?: string;
      peerId?: string;
      capabilities?: string[];
    }
  | {
      type: "join";
      room: string;
    }
  | {
      type: "chat";
      text: string;
      to?: string;
    }
  | {
      type: "signal";
      to: string;
      signalType: "offer" | "answer" | "candidate";
      payload: unknown;
      callId?: string;
    }
  | {
      type: "ping";
    };

type ServerToClientMessage =
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "welcome";
      self: RealtimePeer;
      room: string;
      peers: RealtimePeer[];
      iceServers: IceServer[];
    }
  | {
      type: "presence";
      event: "join" | "leave" | "snapshot";
      room: string;
      peers?: RealtimePeer[];
      peer?: RealtimePeer;
    }
  | {
      type: "chat";
      scope: "room" | "direct";
      room: string;
      from: RealtimePeer;
      to?: string;
      text: string;
    }
  | {
      type: "signal";
      room: string;
      from: RealtimePeer;
      signalType: "offer" | "answer" | "candidate";
      payload: unknown;
      callId?: string;
    }
  | {
      type: "pong";
    };

interface RealtimePeer {
  peerId: string;
  handle: string;
  displayName: string;
  room: string;
  capabilities: string[];
}

interface ClientState {
  socket: WebSocket;
  connectionId: string;
  authed: boolean;
  room: string | null;
  peerId: string | null;
  capabilities: string[];
  identity: RealtimeIdentity | null;
}

function normalizeRoom(input: string | null | undefined): string {
  const value = String(input || "").trim().toLowerCase();
  const safe = value.replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "lobby";
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function toPeer(state: ClientState): RealtimePeer {
  if (!state.authed || !state.peerId || !state.room || !state.identity) {
    throw new Error("Cannot serialize unauthenticated peer");
  }

  return {
    peerId: state.peerId,
    handle: state.identity.handle,
    displayName: state.identity.displayName,
    room: state.room,
    capabilities: [...state.capabilities]
  };
}

function parseJsonMessage(raw: RawData): ClientToServerMessage | null {
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientToServerMessage;
    if (!value || typeof value !== "object" || typeof value.type !== "string") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function normalizeStunServers(options: RealtimeServerOptions): string[] {
  const configured = (options.stunServers || [])
    .map((item) => item.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  if (options.turnHost) {
    return [`stun:${options.turnHost}:${options.turnPort || 3478}`];
  }

  return ["stun:stun.l.google.com:19302"];
}

function buildIceServers(options: RealtimeServerOptions, identity: RealtimeIdentity): IceServer[] {
  const now = options.now || Date.now;
  const iceServers: IceServer[] = [];
  const stunServers = normalizeStunServers(options);
  if (stunServers.length > 0) {
    iceServers.push({
      urls: stunServers
    });
  }

  if (options.turnHost && options.turnSecret) {
    const ttlSeconds = Math.max(60, options.turnTtlSeconds || 3600);
    const expiry = Math.floor(now() / 1000) + ttlSeconds;
    const username = `${expiry}:${identity.handle}`;
    const credential = crypto
      .createHmac("sha1", options.turnSecret)
      .update(username)
      .digest("base64");
    const turnPort = options.turnPort || 3478;
    iceServers.push({
      urls: [
        `turn:${options.turnHost}:${turnPort}?transport=udp`,
        `turn:${options.turnHost}:${turnPort}?transport=tcp`
      ],
      username,
      credential
    });
  }

  return iceServers;
}

async function authenticateToken(
  token: string,
  options: RealtimeServerOptions
): Promise<RealtimeIdentity | null> {
  const devIdentity = options.devBearerTokens?.[token];
  if (devIdentity) {
    return devIdentity;
  }

  const authBaseUrl = options.authBaseUrl?.trim();
  if (!authBaseUrl) {
    return null;
  }

  const url = new URL("api/profile", authBaseUrl.endsWith("/") ? authBaseUrl : `${authBaseUrl}/`);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as {
    id?: number;
    email?: string | null;
    profile?: {
      user_name?: string | null;
      display_name?: string | null;
    } | null;
  };

  const email = String(payload.email || "");
  const fallbackHandle = email.includes("@") ? email.split("@")[0]! : "";
  const handle = String(payload.profile?.user_name || fallbackHandle);
  if (!handle) {
    return null;
  }

  return {
    userId: Number.isFinite(Number(payload.id)) ? Number(payload.id) : null,
    handle,
    displayName: String(payload.profile?.display_name || handle)
  };
}

export async function createRealtimeServer(options: RealtimeServerOptions = {}): Promise<RealtimeServerHandle> {
  const host = options.host || "127.0.0.1";
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: "/realtime"
  });
  const clients = new Set<ClientState>();
  const peersById = new Map<string, ClientState>();
  const httpSockets = new Set<net.Socket>();

  server.on("connection", (socket) => {
    httpSockets.add(socket);
    socket.on("close", () => {
      httpSockets.delete(socket);
    });
  });

  function log(message: string): void {
    options.logger?.(message);
  }

  function send(state: ClientState, message: ServerToClientMessage): void {
    if (state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(message));
    }
  }

  function sendError(state: ClientState, code: string, message: string): void {
    send(state, {
      type: "error",
      code,
      message
    });
  }

  function peersInRoom(room: string, excludePeerId?: string): RealtimePeer[] {
    const peers: RealtimePeer[] = [];
    for (const client of clients) {
      if (!client.authed || !client.room || client.room !== room || !client.peerId) {
        continue;
      }
      if (excludePeerId && client.peerId === excludePeerId) {
        continue;
      }
      peers.push(toPeer(client));
    }
    return peers.sort((left, right) => left.handle.localeCompare(right.handle));
  }

  function broadcastRoom(room: string, message: ServerToClientMessage, excludePeerId?: string): void {
    for (const client of clients) {
      if (!client.authed || client.room !== room || !client.peerId) {
        continue;
      }
      if (excludePeerId && client.peerId === excludePeerId) {
        continue;
      }
      send(client, message);
    }
  }

  function detachClient(state: ClientState): void {
    clients.delete(state);
    if (state.peerId) {
      peersById.delete(state.peerId);
    }
  }

  function moveToRoom(state: ClientState, nextRoom: string): void {
    if (!state.authed || !state.peerId || !state.identity) {
      return;
    }

    const previousRoom = state.room;
    if (previousRoom && previousRoom !== nextRoom) {
      broadcastRoom(previousRoom, {
        type: "presence",
        event: "leave",
        room: previousRoom,
        peer: toPeer(state)
      }, state.peerId);
    }

    state.room = nextRoom;
    send(state, {
      type: "presence",
      event: "snapshot",
      room: nextRoom,
      peers: peersInRoom(nextRoom, state.peerId)
    });

    broadcastRoom(nextRoom, {
      type: "presence",
      event: "join",
      room: nextRoom,
      peer: toPeer(state)
    }, state.peerId);
  }

  app.get("/health", (_req, res) => {
    const rooms = new Map<string, number>();
    for (const client of clients) {
      if (!client.authed || !client.room) {
        continue;
      }
      rooms.set(client.room, (rooms.get(client.room) || 0) + 1);
    }

    res.json({
      ok: true,
      host,
      connections: Array.from(clients).filter((client) => client.authed).length,
      rooms: Array.from(rooms.entries())
        .map(([room, peers]) => ({ room, peers }))
        .sort((left, right) => left.room.localeCompare(right.room))
    });
  });

  app.get("/rtc-config", async (req, res) => {
    const header = String(req.header("authorization") || "");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing bearer token" });
    }
    const token = header.slice("Bearer ".length).trim();
    const identity = await authenticateToken(token, options);
    if (!identity) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.json({
      ok: true,
      publicHost: options.publicHost || options.turnHost || null,
      iceServers: buildIceServers(options, identity)
    });
  });

  wss.on("connection", (socket) => {
    const state: ClientState = {
      socket,
      connectionId: randomId("conn"),
      authed: false,
      room: null,
      peerId: null,
      capabilities: [],
      identity: null
    };
    clients.add(state);
    log(`socket open ${state.connectionId}`);

    socket.on("message", async (raw) => {
      const message = parseJsonMessage(raw);
      if (!message) {
        sendError(state, "bad_json", "Invalid JSON message");
        return;
      }

      try {
        if (!state.authed) {
          if (message.type !== "auth") {
            sendError(state, "unauthorized", "Authenticate first");
            return;
          }

          const identity = await authenticateToken(String(message.token || ""), options);
          if (!identity) {
            sendError(state, "unauthorized", "Invalid bearer token");
            socket.close(1008, "unauthorized");
            return;
          }

          state.authed = true;
          state.identity = identity;
          state.capabilities = Array.isArray(message.capabilities)
            ? message.capabilities.filter((value): value is string => typeof value === "string").slice(0, 8)
            : [];

          const requestedPeerId = String(message.peerId || "").trim();
          const peerId = requestedPeerId && !peersById.has(requestedPeerId)
            ? requestedPeerId
            : randomId(identity.handle);
          state.peerId = peerId;
          peersById.set(peerId, state);
          state.room = normalizeRoom(message.room);

          send(state, {
            type: "welcome",
            self: toPeer(state),
            room: state.room,
            peers: peersInRoom(state.room, state.peerId),
            iceServers: buildIceServers(options, identity)
          });
          moveToRoom(state, state.room);
          log(`auth ok ${identity.handle} ${peerId} ${state.room}`);
          return;
        }

        if (message.type === "ping") {
          send(state, { type: "pong" });
          return;
        }

        if (message.type === "join") {
          moveToRoom(state, normalizeRoom(message.room));
          return;
        }

        if (message.type === "chat") {
          const text = String(message.text || "").trim();
          if (!text) {
            sendError(state, "bad_request", "Message text is required");
            return;
          }

          const from = toPeer(state);
          if (message.to) {
            const target = peersById.get(String(message.to));
            if (!target || !target.authed || !target.room) {
              sendError(state, "not_found", "Target peer not connected");
              return;
            }
            const outbound: ServerToClientMessage = {
              type: "chat",
              scope: "direct",
              room: target.room,
              from,
              to: target.peerId || undefined,
              text
            };
            send(target, outbound);
            send(state, outbound);
            return;
          }

          if (!state.room) {
            sendError(state, "bad_request", "Join a room first");
            return;
          }
          broadcastRoom(state.room, {
            type: "chat",
            scope: "room",
            room: state.room,
            from,
            text
          });
          return;
        }

        if (message.type === "signal") {
          const target = peersById.get(String(message.to));
          if (!target || !target.authed || !target.room) {
            sendError(state, "not_found", "Target peer not connected");
            return;
          }
          send(target, {
            type: "signal",
            room: target.room,
            from: toPeer(state),
            signalType: message.signalType,
            payload: message.payload,
            callId: message.callId
          });
          return;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        sendError(state, "server_error", messageText);
      }
    });

    socket.on("close", () => {
      if (state.authed && state.room && state.peerId) {
        broadcastRoom(state.room, {
          type: "presence",
          event: "leave",
          room: state.room,
          peer: toPeer(state)
        }, state.peerId);
      }
      detachClient(state);
      log(`socket close ${state.connectionId}`);
    });

    socket.on("error", (error) => {
      log(`socket error ${state.connectionId} ${error.message}`);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port || 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine realtime server address");
  }

  return {
    host,
    port: address.port,
    server,
    stop: async () => {
      for (const client of clients) {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.terminate();
        }
      }
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      for (const socket of httpSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
