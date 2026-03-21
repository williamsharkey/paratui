import fs from "node:fs/promises";
import path from "node:path";
import type { AppSnapshot } from "./types.js";

export interface MacroHost {
  executeCommandString(command: string): Promise<void>;
  assertSnapshot(path: string, expectedRaw: string): void;
  snapshot(): AppSnapshot;
  bridgeLog(message: string): void;
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

async function runDirective(host: MacroHost, line: string): Promise<void> {
  if (line.startsWith("!assert ")) {
    const body = line.slice("!assert ".length).trim();
    const idx = body.indexOf("=");
    if (idx < 1) {
      throw new Error(`Invalid assert directive: ${line}`);
    }
    const key = body.slice(0, idx).trim();
    const rawValue = body.slice(idx + 1).trim();
    host.assertSnapshot(key, rawValue);
    return;
  }

  if (line.startsWith("!echo ")) {
    host.bridgeLog(line.slice("!echo ".length));
    return;
  }

  if (line.startsWith("!sleep ")) {
    const body = line.slice("!sleep ".length).trim();
    const idx = body.indexOf("=");
    const value = idx > -1 ? body.slice(idx + 1) : body;
    const ms = Number(value);
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid sleep directive: ${line}`);
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  if (line.startsWith("!capture ")) {
    const key = line.slice("!capture ".length).trim();
    const value = resolvePath(host.snapshot(), key);
    host.bridgeLog(`capture ${key}=${JSON.stringify(value)}`);
    return;
  }

  throw new Error(`Unsupported directive: ${line}`);
}

export async function runMacroFile(host: MacroHost, macroPath: string): Promise<void> {
  const absolutePath = path.resolve(macroPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const original of lines) {
    const line = original.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("!")) {
      await runDirective(host, line);
      continue;
    }
    if (line.startsWith("/")) {
      await host.executeCommandString(line);
      continue;
    }
    throw new Error(`Unsupported macro line: ${line}`);
  }
}

export function assertSnapshotValue(snapshot: AppSnapshot, dotPath: string, expectedRaw: string): void {
  const actual = resolvePath(snapshot, dotPath);
  const expected = parseExpected(expectedRaw);
  if (actual !== expected) {
    throw new Error(`Assertion failed for ${dotPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
