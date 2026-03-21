import { once } from "node:events";
import { WebSocket } from "ws";
import type { IceServer } from "./realtime.js";
import type { RealtimePeerSummary } from "./types.js";

type SignalType = "offer" | "answer" | "candidate";

interface ServerErrorMessage {
  type: "error";
  code: string;
  message: string;
}

interface WelcomeMessage {
  type: "welcome";
  self: RealtimePeerSummary;
  room: string;
  peers: RealtimePeerSummary[];
  iceServers: IceServer[];
}

interface PresenceMessage {
  type: "presence";
  event: "join" | "leave" | "snapshot";
  room: string;
  peers?: RealtimePeerSummary[];
  peer?: RealtimePeerSummary;
}

interface ChatMessage {
  type: "chat";
  scope: "room" | "direct";
  room: string;
  from: RealtimePeerSummary;
  to?: string;
  text: string;
}

interface SignalMessage {
  type: "signal";
  room: string;
  from: RealtimePeerSummary;
  signalType: SignalType;
  payload: unknown;
  callId?: string;
}

type ServerMessage = ServerErrorMessage | WelcomeMessage | PresenceMessage | ChatMessage | SignalMessage | { type: "pong" };

export interface RealtimeClientCallbacks {
  onWelcome?: (message: WelcomeMessage) => void;
  onPresence?: (message: PresenceMessage) => void;
  onChat?: (message: ChatMessage) => void;
  onSignal?: (message: SignalMessage) => void;
  onDisconnect?: () => void;
  onError?: (message: string) => void;
}

export class RealtimeClient {
  #url: string;
  #getToken: () => string | null;
  #callbacks: RealtimeClientCallbacks;
  #socket: WebSocket | null = null;

  constructor(url: string, getToken: () => string | null, callbacks: RealtimeClientCallbacks = {}) {
    this.#url = url;
    this.#getToken = getToken;
    this.#callbacks = callbacks;
  }

  setUrl(url: string): void {
    this.#url = url;
  }

  connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  async connect(room: string, peerId?: string | null): Promise<WelcomeMessage> {
    if (this.connected()) {
      await this.join(room);
      return {
        type: "welcome",
        self: {
          peerId: peerId || "",
          handle: "",
          displayName: "",
          room,
          capabilities: []
        },
        room,
        peers: [],
        iceServers: []
      };
    }

    const token = this.#getToken();
    if (!token) {
      throw new Error("Realtime connect requires a bearer token");
    }

    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    this.#bindSocket(socket);

    await once(socket, "open");

    const welcomePromise = new Promise<WelcomeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for realtime welcome"));
      }, 5_000);

      const onMessage = (raw: Buffer) => {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as ServerMessage;
          if (parsed.type === "error") {
            cleanup();
            reject(new Error(parsed.message));
            return;
          }
          if (parsed.type === "welcome") {
            cleanup();
            resolve(parsed);
          }
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Realtime socket closed before welcome"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };

      socket.on("message", onMessage);
      socket.on("close", onClose);
    });

    socket.send(JSON.stringify({
      type: "auth",
      token,
      room,
      peerId: peerId || undefined,
      capabilities: ["chat", "webrtc"]
    }));

    return welcomePromise;
  }

  async disconnect(): Promise<void> {
    if (!this.#socket) {
      return;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 250);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  }

  async join(room: string): Promise<void> {
    this.#send({
      type: "join",
      room
    });
  }

  async sendRoomChat(text: string): Promise<void> {
    this.#send({
      type: "chat",
      text
    });
  }

  async sendDirectChat(peerId: string, text: string): Promise<void> {
    this.#send({
      type: "chat",
      to: peerId,
      text
    });
  }

  async sendSignal(peerId: string, signalType: SignalType, payload: unknown, callId?: string | null): Promise<void> {
    this.#send({
      type: "signal",
      to: peerId,
      signalType,
      payload,
      callId: callId || undefined
    });
  }

  #send(payload: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime socket is not connected");
    }
    this.#socket.send(JSON.stringify(payload));
  }

  #bindSocket(socket: WebSocket): void {
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString("utf8")) as ServerMessage;
        if (message.type === "error") {
          this.#callbacks.onError?.(message.message);
          return;
        }
        if (message.type === "welcome") {
          this.#callbacks.onWelcome?.(message);
          return;
        }
        if (message.type === "presence") {
          this.#callbacks.onPresence?.(message);
          return;
        }
        if (message.type === "chat") {
          this.#callbacks.onChat?.(message);
          return;
        }
        if (message.type === "signal") {
          this.#callbacks.onSignal?.(message);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#callbacks.onError?.(message);
      }
    });

    socket.on("close", () => {
      this.#socket = null;
      this.#callbacks.onDisconnect?.();
    });

    socket.on("error", (error) => {
      this.#callbacks.onError?.(error.message);
    });
  }
}
