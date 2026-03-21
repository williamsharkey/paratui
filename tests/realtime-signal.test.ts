import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createRealtimeServer, type IceServer, type RealtimeServerHandle } from "../src/realtime.js";
import { getFreePort, runTsxScript, seedFixtures, startLocalServer, type ManagedServer } from "./helpers/interactive.js";

type AnyMessage = Record<string, any>;
const SHARKGOD_API_KEY = "psn_test_sharkgod";
const CROSSHJ_API_KEY = "psn_test_crosshj";

class WsClient {
  readonly socket: WebSocket;
  readonly messages: AnyMessage[] = [];
  readonly pending = new Set<{
    predicate: (value: AnyMessage) => boolean;
    resolve: (value: AnyMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString("utf8")) as AnyMessage;
      for (const entry of this.pending) {
        if (!entry.predicate(parsed)) {
          continue;
        }
        clearTimeout(entry.timer);
        this.pending.delete(entry);
        entry.resolve(parsed);
        return;
      }
      this.messages.push(parsed);
    });
    socket.on("error", (error) => {
      for (const entry of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(entry);
        entry.reject(error);
      }
    });
  }

  static async connect(url: string): Promise<WsClient> {
    const socket = new WebSocket(url);
    await once(socket, "open");
    return new WsClient(socket);
  }

  send(payload: AnyMessage): void {
    this.socket.send(JSON.stringify(payload));
  }

  async next(predicate: (value: AnyMessage) => boolean, timeoutMs = 4000): Promise<AnyMessage> {
    const existingIndex = this.messages.findIndex(predicate);
    if (existingIndex >= 0) {
      const [existing] = this.messages.splice(existingIndex, 1);
      return existing;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(entry);
        reject(new Error("Timed out waiting for websocket message"));
      }, timeoutMs);
      const entry = {
        predicate,
        resolve,
        reject,
        timer
      };
      this.pending.add(entry);
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

let authServer: ManagedServer;
let signalServer: RealtimeServerHandle;

before(async () => {
  await seedFixtures();
  authServer = await startLocalServer(await getFreePort());
  signalServer = await createRealtimeServer({
    port: await getFreePort(),
    authBaseUrl: authServer.baseUrl,
    publicHost: "paratui.local.test",
    turnHost: "turn.local.test",
    turnSecret: "super-secret-turn-key",
    turnTtlSeconds: 1800
  });
});

after(async () => {
  await signalServer.stop();
  await authServer.stop();
});

test("realtime signaling stack stays live end to end", { concurrency: false }, async () => {
  const sharkgodToken = SHARKGOD_API_KEY;
  const crosshjToken = CROSSHJ_API_KEY;

  const [clientA, clientB] = await Promise.all([
    WsClient.connect(`ws://127.0.0.1:${signalServer.port}/realtime`),
    WsClient.connect(`ws://127.0.0.1:${signalServer.port}/realtime`)
  ]);

  try {
    clientA.send({
      type: "auth",
      token: sharkgodToken,
      room: "noir",
      peerId: "peer-a",
      capabilities: ["chat", "webrtc"]
    });
    const welcomeA = await clientA.next((message) => message.type === "welcome");
    assert.equal(welcomeA.self.handle, "sharkgod");
    assert.equal(welcomeA.room, "noir");
    assert.equal(welcomeA.peers.length, 0);
    assert.ok(Array.isArray(welcomeA.iceServers));

    clientB.send({
      type: "auth",
      token: crosshjToken,
      room: "noir",
      peerId: "peer-b",
      capabilities: ["chat", "camera", "webrtc"]
    });
    const welcomeB = await clientB.next((message) => message.type === "welcome");
    assert.equal(welcomeB.self.handle, "crosshj");
    assert.equal(welcomeB.peers[0]?.peerId, "peer-a");

    const joinA = await clientA.next(
      (message) => message.type === "presence" && message.event === "join" && message.peer?.peerId === "peer-b"
    );
    assert.equal(joinA.room, "noir");

    clientA.send({
      type: "signal",
      to: "peer-b",
      signalType: "offer",
      callId: "call-1",
      payload: {
        sdp: "fake-offer"
      }
    });
    const offerB = await clientB.next(
      (message) => message.type === "signal" && message.signalType === "offer" && message.from?.peerId === "peer-a"
    );
    assert.equal(offerB.callId, "call-1");
    assert.equal(offerB.payload.sdp, "fake-offer");

    clientB.send({
      type: "chat",
      to: "peer-a",
      text: "quiet direct ping"
    });
    const directA = await clientA.next(
      (message) => message.type === "chat" && message.scope === "direct" && message.text === "quiet direct ping"
    );
    assert.equal(directA.from.handle, "crosshj");
  } finally {
    await Promise.all([
      clientA.close(),
      clientB.close()
    ]);
  }

  const response = await fetch(`http://127.0.0.1:${signalServer.port}/rtc-config`, {
    headers: {
      authorization: `Bearer ${sharkgodToken}`
    }
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    ok: boolean;
    publicHost: string | null;
    iceServers: IceServer[];
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.publicHost, "paratui.local.test");
  assert.equal(payload.iceServers.length, 2);
  assert.match(payload.iceServers[0]?.urls[0] || "", /^stun:/);
  assert.match(payload.iceServers[1]?.urls[0] || "", /^turn:/);
  assert.match(payload.iceServers[1]?.username || "", /:sharkgod$/);
  assert.ok(payload.iceServers[1]?.credential);

  const output = await runTsxScript(new URL("../scripts/realtime-probe.ts", import.meta.url).pathname, {
    PARATUI_SIGNAL_PROBE_URL: `ws://127.0.0.1:${signalServer.port}/realtime`,
    TOKEN_A: sharkgodToken,
    TOKEN_B: crosshjToken
  });

  const parsed = JSON.parse(output.trim()) as {
    ok: boolean;
    clientA: string;
    clientB: string;
    sawJoin: boolean;
    sawSignal: boolean;
    sawDirectChat: boolean;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.clientA, "sharkgod");
  assert.equal(parsed.clientB, "crosshj");
  assert.equal(parsed.sawJoin, true);
  assert.equal(parsed.sawSignal, true);
  assert.equal(parsed.sawDirectChat, true);
});
