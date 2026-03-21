import fs from "node:fs/promises";
import { createRealtimeServer, type RealtimeIdentity } from "../src/realtime.js";

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadDevTokens(): Promise<Record<string, RealtimeIdentity>> {
  const filePath = process.env.PARATUI_SIGNAL_DEV_TOKENS_FILE;
  const inlineJson = process.env.PARATUI_SIGNAL_DEV_TOKENS_JSON;
  if (!filePath && !inlineJson) {
    return {};
  }

  const raw = filePath
    ? await fs.readFile(filePath, "utf8")
    : inlineJson || "{}";
  const parsed = JSON.parse(raw) as Record<string, RealtimeIdentity>;
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, RealtimeIdentity] => {
      const [, value] = entry;
      return Boolean(value && typeof value.handle === "string" && value.handle.trim());
    })
  );
}

async function main(): Promise<void> {
  const devBearerTokens = await loadDevTokens();
  const stunServers = String(process.env.PARATUI_SIGNAL_STUN_SERVERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const server = await createRealtimeServer({
    host: process.env.HOST || "127.0.0.1",
    port: parseInteger(process.env.PORT, 8788),
    publicHost: process.env.PARATUI_SIGNAL_PUBLIC_HOST || null,
    authBaseUrl: process.env.PARATUI_SIGNAL_AUTH_BASE_URL || null,
    devBearerTokens,
    stunServers,
    turnHost: process.env.PARATUI_SIGNAL_TURN_HOST || null,
    turnPort: parseInteger(process.env.PARATUI_SIGNAL_TURN_PORT, 3478),
    turnSecret: process.env.PARATUI_SIGNAL_TURN_SECRET || null,
    turnTtlSeconds: parseInteger(process.env.PARATUI_SIGNAL_TURN_TTL_SECONDS, 3600),
    logger: (message) => {
      process.stdout.write(`[signal] ${message}\n`);
    }
  });

  process.stdout.write(`PARATUI_SIGNAL_READY http://${server.host}:${server.port}\n`);

  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
