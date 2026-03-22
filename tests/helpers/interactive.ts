import assert from "node:assert/strict";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { assertSnapshotValue } from "../../src/macros.js";
import type { AppSnapshot } from "../../src/types.js";

const ROOT_DIR = path.resolve(path.join(import.meta.dirname, "..", ".."));
const TSX_CLI = path.join(ROOT_DIR, "node_modules", "tsx", "dist", "cli.mjs");
const PTY_RELAY = path.join(ROOT_DIR, "tests", "helpers", "pty_relay.py");
const CLEAR_MARKERS = ["\x1b[2J\x1b[H", "\x1b[H\x1b[2J"];

type BridgeEvent =
  | { type: "ready"; snapshot: AppSnapshot }
  | { type: "state"; snapshot: AppSnapshot }
  | { type: "idle"; snapshot: AppSnapshot }
  | { type: "macro:start"; path: string }
  | { type: "macro:success"; path: string }
  | { type: "macro:error"; path: string; error: string }
  | { type: "log"; message: string };

type RecordedEvent = BridgeEvent & { seq: number };

interface Waiter {
  resolve: (event: RecordedEvent) => void;
  reject: (error: Error) => void;
  type: BridgeEvent["type"];
  afterSeq: number;
  predicate?: (event: RecordedEvent) => boolean;
  timer: NodeJS.Timeout;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\u0007/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function resolvePath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseExpected(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function keyToBytes(key: string): string {
  switch (key) {
    case "enter":
      return "\r";
    case "escape":
    case "esc":
      return "\x1b";
    case "space":
      return " ";
    case "tab":
      return "\t";
    case "shift-tab":
      return "\x1b[Z";
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "right":
      return "\x1b[C";
    case "left":
      return "\x1b[D";
    case "slash":
      return "/";
    default:
      if (key.length === 1) {
        return key;
      }
      throw new Error(`Unsupported key: ${key}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Process did not exit in time"));
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function getFreePort(): Promise<number> {
  const server = net.createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a local port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function runTsxScript(scriptPath: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const child = spawn(process.execPath, [TSX_CLI, scriptPath], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(`Script failed: ${scriptPath}\n${stdout}${stderr}`);
  }

  return `${stdout}${stderr}`;
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [TSX_CLI, "src/cli.ts", ...args], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    throw new Error(`CLI failed\n${stdout}${stderr}`);
  }

  return { stdout, stderr };
}

export async function seedFixtures(): Promise<void> {
  const output = await runTsxScript("scripts/setup-parascene-fixtures.ts");
  assert.match(output, /PARASCENE_FIXTURES_READY/);
}

export class ManagedServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly child: ChildProcess;
  stdout = "";
  stderr = "";

  constructor(port: number, child: ChildProcess) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.child = child;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode != null) {
      return;
    }

    const pid = this.child.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        this.child.kill();
      }
    } else {
      this.child.kill();
    }
    try {
      await waitForExit(this.child);
    } catch {
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          this.child.kill("SIGKILL");
        }
      } else {
        this.child.kill("SIGKILL");
      }
      await waitForExit(this.child, 2_000).catch(() => undefined);
    }
  }
}

export async function startLocalServer(port: number): Promise<ManagedServer> {
  const child = spawn(process.execPath, [TSX_CLI, "scripts/parascene-local-server.ts"], {
    cwd: ROOT_DIR,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const managed = new ManagedServer(port, child);
  (child.stdout as Readable).on("data", (chunk: Buffer | string) => {
    managed.stdout += String(chunk);
  });
  (child.stderr as Readable).on("data", (chunk: Buffer | string) => {
    managed.stderr += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server did not become ready\n${managed.stdout}${managed.stderr}`));
    }, 10_000);

    const onData = () => {
      if (managed.stdout.includes("PARASCENE_LOCAL_READY")) {
        clearTimeout(timer);
        (child.stdout as Readable).off("data", onData);
        (child.stderr as Readable).off("data", onData);
        resolve();
      }
    };

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}\n${managed.stdout}${managed.stderr}`));
    });
    (child.stdout as Readable).on("data", onData);
    (child.stderr as Readable).on("data", onData);
  });

  return managed;
}

class BridgeHarness {
  readonly server = net.createServer();
  readonly sockets = new Set<net.Socket>();
  readonly events: RecordedEvent[] = [];
  readonly waiters = new Set<Waiter>();
  latestSnapshot: AppSnapshot | null = null;
  seq = 0;
  port = 0;

  static async create(): Promise<BridgeHarness> {
    const bridge = new BridgeHarness();
    bridge.server.on("connection", (socket) => {
      bridge.sockets.add(socket);
      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += String(chunk);
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            bridge.record(JSON.parse(line) as BridgeEvent);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      });

      socket.on("close", () => {
        bridge.sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      bridge.server.once("error", reject);
      bridge.server.listen(0, "127.0.0.1", () => {
        const address = bridge.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Bridge failed to bind"));
          return;
        }
        bridge.port = address.port;
        resolve();
      });
    });

    return bridge;
  }

  record(event: BridgeEvent): void {
    const recorded: RecordedEvent = {
      ...event,
      seq: ++this.seq
    };

    if ("snapshot" in recorded) {
      this.latestSnapshot = recorded.snapshot;
    }

    this.events.push(recorded);

    for (const waiter of Array.from(this.waiters)) {
      if (recorded.type !== waiter.type) {
        continue;
      }
      if (recorded.seq <= waiter.afterSeq) {
        continue;
      }
      if (waiter.predicate && !waiter.predicate(recorded)) {
        continue;
      }

      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(recorded);
    }
  }

  async waitForEvent(
    type: BridgeEvent["type"],
    afterSeq: number,
    predicate?: (event: RecordedEvent) => boolean,
    timeoutMs = 10_000
  ): Promise<RecordedEvent> {
    const existing = this.events.find((event) => {
      if (event.type !== type) return false;
      if (event.seq <= afterSeq) return false;
      return predicate ? predicate(event) : true;
    });
    if (existing) {
      return existing;
    }

    return new Promise<RecordedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);

      const waiter: Waiter = {
        resolve,
        reject,
        type,
        afterSeq,
        predicate,
        timer
      };

      this.waiters.add(waiter);
    });
  }

  async waitForIdle(
    afterSeq: number,
    predicate?: (snapshot: AppSnapshot) => boolean,
    timeoutMs = 10_000
  ): Promise<AppSnapshot> {
    const event = await this.waitForEvent(
      "idle",
      afterSeq,
      predicate
        ? (candidate) => "snapshot" in candidate && predicate(candidate.snapshot)
        : undefined,
      timeoutMs
    );
    if (!("snapshot" in event)) {
      throw new Error("Idle event did not include a snapshot");
    }
    return event.snapshot;
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Bridge closed"));
    }
    this.waiters.clear();

    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

export class InteractiveAppHarness {
  readonly serverBaseUrl: string;
  readonly bridge: BridgeHarness;
  readonly configDir: string;
  readonly configPath: string;
  readonly exportDir: string;
  readonly clipboardPath: string;
  readonly terminal: ChildProcessWithoutNullStreams;
  #rawOutput = "";
  #latestScreen = "";

  private constructor(
    serverBaseUrl: string,
    bridge: BridgeHarness,
    configDir: string,
    exportDir: string,
    clipboardPath: string,
    terminal: ChildProcessWithoutNullStreams
  ) {
    this.serverBaseUrl = serverBaseUrl;
    this.bridge = bridge;
    this.configDir = configDir;
    this.configPath = path.join(configDir, "config.json");
    this.exportDir = exportDir;
    this.clipboardPath = clipboardPath;
    this.terminal = terminal;
  }

  static async start(serverBaseUrl: string, options: {
    realtimeBaseUrl?: string;
  } = {}): Promise<InteractiveAppHarness> {
    const bridge = await BridgeHarness.create();
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paratui-test-"));
    const exportDir = path.join(configDir, "exports");
    const clipboardPath = path.join(configDir, "clipboard.txt");
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      `${JSON.stringify({
        serverBaseUrl,
        realtimeBaseUrl: options.realtimeBaseUrl || process.env.PARATUI_REALTIME_BASE_URL || "ws://127.0.0.1:8788/realtime",
        auth: {
          bearerToken: null,
          username: null
        },
        audio: {
          muted: false
        },
        exports: {
          directory: exportDir
        },
        preview: {
          disableExternalOpen: true
        }
      }, null, 2)}\n`,
      "utf8"
    );
    const shell = process.env.SHELL || "/bin/zsh";
    const command = `${shellQuote(process.execPath)} ${shellQuote(TSX_CLI)} src/cli.ts`;
    const ptyRelay = process.env.PARATUI_TEST_PTY_RELAY || PTY_RELAY;
    const terminal = spawn("python3", [ptyRelay, shell, "-lc", command], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PARATUI_TEST_PORT: String(bridge.port),
        PARATUI_CONFIG_DIR: configDir,
        PARATUI_SERVER_BASE_URL: serverBaseUrl,
        PARATUI_ENABLE_TEST_SLASH: "1",
        PARATUI_DISABLE_EXTERNAL_OPEN: "1",
        PARATUI_TEST_CLIPBOARD_FILE: clipboardPath,
        TERM: process.env.TERM || "xterm-256color"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const harness = new InteractiveAppHarness(serverBaseUrl, bridge, configDir, exportDir, clipboardPath, terminal);
    const onChunk = (chunk: Buffer | string) => {
      harness.#rawOutput += String(chunk);
      if (harness.#rawOutput.length > 100_000) {
        harness.#rawOutput = harness.#rawOutput.slice(-50_000);
      }

      const lastClear = CLEAR_MARKERS.reduce((max, marker) => {
        const index = harness.#rawOutput.lastIndexOf(marker);
        return Math.max(max, index);
      }, -1);
      const visible = lastClear >= 0
        ? harness.#rawOutput.slice(lastClear + CLEAR_MARKERS.find((marker) => harness.#rawOutput.lastIndexOf(marker) === lastClear)!.length)
        : harness.#rawOutput;
      harness.#latestScreen = stripAnsi(visible);
    };
    terminal.stdout.on("data", onChunk);
    terminal.stderr.on("data", onChunk);

    await Promise.race([
      bridge.waitForEvent("ready", 0, undefined, 10_000).catch((error) => {
        throw new Error(`${error.message}\nTerminal output:\n${stripAnsi(harness.#rawOutput)}`);
      }),
      new Promise<never>((_resolve, reject) => {
        terminal.once("exit", (code, signal) => {
          reject(
            new Error(
              `Interactive app exited before ready (code=${code}, signal=${signal})\nTerminal output:\n${stripAnsi(harness.#rawOutput)}`
            )
          );
        });
      })
    ]);
    return harness;
  }

  snapshot(): AppSnapshot {
    if (!this.bridge.latestSnapshot) {
      throw new Error("No snapshot available");
    }
    return this.bridge.latestSnapshot;
  }

  screen(): string {
    return this.#latestScreen;
  }

  async readConfig(): Promise<unknown> {
    const raw = await fs.readFile(this.configPath, "utf8");
    return JSON.parse(raw);
  }

  async readClipboard(): Promise<string> {
    try {
      return await fs.readFile(this.clipboardPath, "utf8");
    } catch {
      return "";
    }
  }

  async pressKey(key: string, predicate?: (snapshot: AppSnapshot) => boolean): Promise<AppSnapshot> {
    const afterSeq = this.bridge.seq;
    const beforeInputSeq = this.snapshot().meta.inputSeq;
    this.terminal.stdin.write(keyToBytes(key));
    return this.bridge.waitForIdle(afterSeq, (snapshot) => (
      snapshot.meta.inputSeq > beforeInputSeq && (!predicate || predicate(snapshot))
    ));
  }

  async pasteText(text: string, predicate?: (snapshot: AppSnapshot) => boolean): Promise<AppSnapshot> {
    const afterSeq = this.bridge.seq;
    const beforeInputSeq = this.snapshot().meta.inputSeq;
    this.terminal.stdin.write(text);
    return this.bridge.waitForIdle(afterSeq, (snapshot) => (
      snapshot.meta.inputSeq > beforeInputSeq && (!predicate || predicate(snapshot))
    ));
  }

  async typeText(text: string, predicate?: (snapshot: AppSnapshot) => boolean): Promise<AppSnapshot | null> {
    let snapshot: AppSnapshot | null = null;
    const chars = [...text];
    if (!chars.length) {
      return predicate ? this.bridge.waitForIdle(this.bridge.seq, predicate) : this.snapshot();
    }
    for (let index = 0; index < chars.length; index += 1) {
      const afterSeq = this.bridge.seq;
      const beforeInputSeq = this.snapshot().meta.inputSeq;
      this.terminal.stdin.write(chars[index]!);
      snapshot = await this.bridge.waitForIdle(
        afterSeq,
        (nextSnapshot) => {
          if (nextSnapshot.meta.inputSeq <= beforeInputSeq) {
            return false;
          }
          if (predicate && index === chars.length - 1) {
            return predicate(nextSnapshot);
          }
          return true;
        }
      );
    }
    return snapshot;
  }

  async waitForSnapshot(pathName: string, expectedRaw: string, timeoutMs = 10_000): Promise<AppSnapshot> {
    const expected = parseExpected(expectedRaw);
    const current = this.snapshot();
    if (resolvePath(current, pathName) === expected) {
      return current;
    }
    return this.bridge.waitForIdle(
      this.bridge.seq,
      (snapshot) => resolvePath(snapshot, pathName) === expected,
      timeoutMs
    );
  }

  async runCommand(command: string): Promise<AppSnapshot> {
    assert.match(command, /^\//);
    await this.pressKey("slash", (snapshot) => snapshot.slash.open === true);
    if (command.length > 1) {
      await this.typeText(command.slice(1));
    }
    return this.pressKey("enter", (snapshot) => snapshot.slash.open === false);
  }

  assertSnapshot(pathName: string, expectedRaw: string): void {
    assertSnapshotValue(this.snapshot(), pathName, expectedRaw);
  }

  assertScreenContains(text: string): void {
    assert.match(this.screen(), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  async close(): Promise<void> {
    try {
      this.terminal.stdin.write("\u0003");
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 2_000);
        this.terminal.once("exit", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });
      if (this.terminal.exitCode == null) {
        this.terminal.kill();
      }
    } finally {
      await this.bridge.close();
      await fs.rm(this.configDir, { recursive: true, force: true });
    }
  }
}

export async function runPtmScript(harness: InteractiveAppHarness, scriptPath: string): Promise<void> {
  const absolutePath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(ROOT_DIR, scriptPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const originalLine of lines) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("/")) {
      await harness.runCommand(line);
      continue;
    }

    if (line.startsWith("!press ")) {
      await harness.pressKey(line.slice("!press ".length).trim());
      continue;
    }

    if (line.startsWith("!type ")) {
      await harness.typeText(line.slice("!type ".length));
      continue;
    }

    if (line.startsWith("!wait ")) {
      const body = line.slice("!wait ".length).trim();
      const idx = body.indexOf("=");
      if (idx < 1) {
        throw new Error(`Invalid wait directive: ${line}`);
      }
      const key = body.slice(0, idx).trim();
      const expectedRaw = body.slice(idx + 1).trim();
      await harness.waitForSnapshot(key, expectedRaw);
      continue;
    }

    if (line.startsWith("!assert ")) {
      const body = line.slice("!assert ".length).trim();
      const idx = body.indexOf("=");
      if (idx < 1) {
        throw new Error(`Invalid assert directive: ${line}`);
      }
      const key = body.slice(0, idx).trim();
      const expectedRaw = body.slice(idx + 1).trim();
      harness.assertSnapshot(key, expectedRaw);
      continue;
    }

    if (line.startsWith("!screen-contains ")) {
      harness.assertScreenContains(line.slice("!screen-contains ".length));
      continue;
    }

    throw new Error(`Unsupported script line: ${line}`);
  }
}

export function resolveTestPath(relativePath: string): string {
  return pathToFileURL(path.resolve(ROOT_DIR, relativePath)).href;
}
