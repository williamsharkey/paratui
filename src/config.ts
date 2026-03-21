import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";

function resolveDefaultConfigDir(): string {
  if (process.env.PARATUI_CONFIG_DIR) {
    return process.env.PARATUI_CONFIG_DIR;
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "paratui");
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "paratui");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "paratui");
}

export function getConfigPath(): string {
  return path.join(resolveDefaultConfigDir(), "config.json");
}

export function defaultConfig(): AppConfig {
  return {
    serverBaseUrl: process.env.PARATUI_SERVER_BASE_URL || "https://api.parascene.com",
    realtimeBaseUrl: process.env.PARATUI_REALTIME_BASE_URL || "ws://127.0.0.1:8788/realtime",
    auth: {
      bearerToken: null,
      username: null
    },
    audio: {
      muted: false
    },
    exports: {
      directory: path.join(os.homedir(), "Downloads")
    },
    preview: {
      disableExternalOpen: process.env.PARATUI_DISABLE_EXTERNAL_OPEN === "1"
    }
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  const base = defaultConfig();

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      ...base,
      ...parsed,
      realtimeBaseUrl: parsed.realtimeBaseUrl || base.realtimeBaseUrl,
      auth: {
        ...base.auth,
        ...(parsed.auth || {})
      },
      audio: {
        ...base.audio,
        ...(parsed.audio || {})
      },
      exports: {
        ...base.exports,
        ...(parsed.exports || {})
      },
      preview: {
        ...base.preview,
        ...(parsed.preview || {})
      }
    };
  } catch {
    return base;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
