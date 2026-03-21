import { once } from "node:events";
import { WebSocket } from "ws";

interface ProbeArgs {
  url: string;
  tokenA: string;
  tokenB: string;
  room: string;
  hostHeader?: string;
}

interface ProbeResult {
  ok: boolean;
  room: string;
  clientA: string;
  clientB: string;
  sawJoin: boolean;
  sawSignal: boolean;
  sawDirectChat: boolean;
}

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function openSocket(url: string, hostHeader?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    headers: hostHeader ? { host: hostHeader } : {}
  });
  await once(socket, "open");
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
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

async function waitForMessage(
  socket: WebSocket,
  predicate: (value: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (!predicate(parsed)) {
          return;
        }
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function runProbe(args: ProbeArgs): Promise<ProbeResult> {
  const [socketA, socketB] = await Promise.all([
    openSocket(args.url, args.hostHeader),
    openSocket(args.url, args.hostHeader)
  ]);

  try {
    socketA.send(JSON.stringify({
      type: "auth",
      token: args.tokenA,
      room: args.room,
      peerId: "probe-a",
      capabilities: ["chat", "webrtc"]
    }));
    const welcomeA = await waitForMessage(socketA, (value) => value.type === "welcome");

    socketB.send(JSON.stringify({
      type: "auth",
      token: args.tokenB,
      room: args.room,
      peerId: "probe-b",
      capabilities: ["chat", "camera", "webrtc"]
    }));
    const welcomeB = await waitForMessage(socketB, (value) => value.type === "welcome");
    const joinA = await waitForMessage(
      socketA,
      (value) => value.type === "presence" && value.event === "join" && value.peer?.peerId === "probe-b"
    );

    socketA.send(JSON.stringify({
      type: "signal",
      to: "probe-b",
      signalType: "offer",
      callId: "probe-call",
      payload: {
        sdp: "fake-offer"
      }
    }));
    const signalB = await waitForMessage(
      socketB,
      (value) => value.type === "signal" && value.signalType === "offer" && value.from?.peerId === "probe-a"
    );

    socketB.send(JSON.stringify({
      type: "chat",
      to: "probe-a",
      text: "probe direct chat"
    }));
    const chatA = await waitForMessage(
      socketA,
      (value) => value.type === "chat" && value.scope === "direct" && value.text === "probe direct chat"
    );

    return {
      ok: true,
      room: args.room,
      clientA: welcomeA.self.handle,
      clientB: welcomeB.self.handle,
      sawJoin: Boolean(joinA),
      sawSignal: Boolean(signalB),
      sawDirectChat: Boolean(chatA)
    };
  } finally {
    await Promise.all([
      closeSocket(socketA),
      closeSocket(socketB)
    ]);
  }
}

async function main(): Promise<void> {
  const url = readArg("--url") || process.env.PARATUI_SIGNAL_PROBE_URL || "ws://127.0.0.1:8788/realtime";
  const tokenA = readArg("--token-a") || process.env.TOKEN_A || null;
  const tokenB = readArg("--token-b") || process.env.TOKEN_B || null;
  const room = readArg("--room") || process.env.PARATUI_SIGNAL_PROBE_ROOM || "probe";
  const hostHeader = readArg("--host-header") || undefined;
  if (!tokenA || !tokenB) {
    throw new Error("Usage: realtime-probe --token-a <token> --token-b <token> [--url ws://...]");
  }

  const result = await runProbe({
    url,
    tokenA,
    tokenB,
    room,
    hostHeader
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
