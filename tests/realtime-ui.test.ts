import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createRealtimeServer, type RealtimeServerHandle } from "../src/realtime.js";
import {
  InteractiveAppHarness,
  getFreePort,
  runPtmScript,
  seedFixtures,
  startLocalServer,
  type ManagedServer
} from "./helpers/interactive.js";

type LiveMessage = Record<string, any>;
const SHARKGOD_API_KEY = "psn_test_sharkgod";
const CROSSHJ_API_KEY = "psn_test_crosshj";

class LivePeer {
  readonly socket: WebSocket;
  readonly messages: LiveMessage[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString("utf8")) as LiveMessage);
    });
  }

  static async connect(options: {
    url: string;
    token: string;
    room: string;
    peerId: string;
  }): Promise<LivePeer> {
    const socket = new WebSocket(options.url);
    await once(socket, "open");
    const peer = new LivePeer(socket);
    peer.send({
      type: "auth",
      token: options.token,
      room: options.room,
      peerId: options.peerId,
      capabilities: ["chat", "camera", "webrtc"]
    });
    const welcome = await peer.next((message) => message.type === "welcome");
    assert.equal(welcome.self.peerId, options.peerId);
    return peer;
  }

  send(payload: LiveMessage): void {
    this.socket.send(JSON.stringify(payload));
  }

  async next(predicate: (message: LiveMessage) => boolean, timeoutMs = 5_000): Promise<LiveMessage> {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = this.messages.splice(existingIndex, 1);
      return existing;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for live peer message"));
      }, timeoutMs);

      const onMessage = (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString("utf8")) as LiveMessage;
        this.messages.push(parsed);
        const matchIndex = this.messages.findIndex(predicate);
        if (matchIndex < 0) {
          return;
        }
        const [match] = this.messages.splice(matchIndex, 1);
        cleanup();
        resolve(match);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("message", onMessage);
        this.socket.off("error", onError);
      };

      this.socket.on("message", onMessage);
      this.socket.on("error", onError);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 250);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}

const SCRIPT_DIR = path.resolve(path.join(import.meta.dirname, "scripts"));

let apiServer: ManagedServer;
let realtimeServer: RealtimeServerHandle;

before(async () => {
  await seedFixtures();
  apiServer = await startLocalServer(await getFreePort());
  realtimeServer = await createRealtimeServer({
    port: await getFreePort(),
    authBaseUrl: apiServer.baseUrl
  });
});

after(async () => {
  if (realtimeServer) {
    await realtimeServer.stop();
  }
  if (apiServer) {
    await apiServer.stop();
  }
});

async function withApp(run: (app: InteractiveAppHarness) => Promise<void>): Promise<void> {
  const app = await InteractiveAppHarness.start(apiServer.baseUrl, {
    realtimeBaseUrl: `ws://127.0.0.1:${realtimeServer.port}/realtime`
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test("live realtime features stay scriptable through the TUI", { concurrency: false }, async () => {
  const peer = await LivePeer.connect({
    url: `ws://127.0.0.1:${realtimeServer.port}/realtime`,
    token: CROSSHJ_API_KEY,
    room: "noir",
    peerId: "peer-crosshj"
  });

  try {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "realtime-live.ptm"));

      const join = await peer.next(
        (message) => message.type === "presence" && message.event === "join" && message.peer?.handle === "sharkgod"
      );
      const sharkgodPeerId = String(join.peer.peerId);
      assert.ok(sharkgodPeerId);

      const roomChat = await peer.next(
        (message) => message.type === "chat" && message.scope === "room" && message.text === "macro live ping"
      );
      assert.equal(roomChat.from.handle, "sharkgod");

      const directChat = await peer.next(
        (message) => message.type === "chat" && message.scope === "direct" && message.text === "macro live dm"
      );
      assert.equal(directChat.from.handle, "sharkgod");

      const signal = await peer.next(
        (message) => message.type === "signal" && message.signalType === "offer" && message.payload === "macro-offer"
      );
      assert.equal(signal.from.handle, "sharkgod");
      assert.equal(signal.callId, "call-1");

      peer.send({
        type: "chat",
        text: "external room ping"
      });
      await app.waitForSnapshot("status", "live room @crosshj");
      app.assertScreenContains("external room ping");

      peer.send({
        type: "chat",
        to: sharkgodPeerId,
        text: "external live dm"
      });
      await app.waitForSnapshot("status", "live direct @crosshj");
      app.assertScreenContains("external live dm");

      peer.send({
        type: "signal",
        to: sharkgodPeerId,
        signalType: "answer",
        payload: "external-answer",
        callId: "call-1"
      });
      await app.waitForSnapshot("realtime.lastSignalType", "answer");
      app.assertScreenContains("external-answer");
    });
  } finally {
    await peer.close();
  }
});
