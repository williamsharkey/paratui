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

export function getConfigDir(): string {
  return resolveDefaultConfigDir();
}

export function getConfigPath(): string {
  return path.join(resolveDefaultConfigDir(), "config.json");
}

export function defaultConfig(): AppConfig {
  return {
    serverBaseUrl: process.env.PARATUI_SERVER_BASE_URL || "https://api.parascene.com",
    realtimeBaseUrl: process.env.PARATUI_REALTIME_BASE_URL || "ws://127.0.0.1:8788/realtime",
    parasceneRealtime: {
      enabled: process.env.PARATUI_PARASCENE_REALTIME !== "0",
      url: process.env.PARATUI_SUPABASE_URL || null,
      anonKey: process.env.PARATUI_SUPABASE_ANON_KEY || null
    },
    auth: {
      bearerToken: null,
      username: null
    },
    audio: {
      muted: false
    },
    social: {
      recentRooms: []
    },
    uiCache: {
      loaded: {
        people: false,
        social: false,
        notifications: false,
        feed: false,
        thread: false,
        profile: false
      },
      selectedLeftKey: null,
      people: [],
      rooms: [],
      dms: [],
      notifications: {
        items: [],
        unreadCount: 0
      },
      feed: {
        items: [],
        currentIndex: 0
      },
      currentThread: {
        view: null,
        dmHandle: null,
        roomName: null,
        threadId: null,
        messages: []
      }
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
      parasceneRealtime: {
        ...base.parasceneRealtime,
        ...(parsed.parasceneRealtime || {})
      },
      auth: {
        ...base.auth,
        ...(parsed.auth || {})
      },
      audio: {
        ...base.audio,
        ...(parsed.audio || {})
      },
      social: {
        ...base.social,
        ...(parsed.social || {})
      },
      uiCache: {
        ...base.uiCache,
        ...(parsed.uiCache || {}),
        loaded: {
          ...base.uiCache.loaded,
          ...((parsed.uiCache || {}).loaded || {})
        },
        notifications: {
          ...base.uiCache.notifications,
          ...((parsed.uiCache || {}).notifications || {})
        },
        feed: {
          ...base.uiCache.feed,
          ...((parsed.uiCache || {}).feed || {})
        },
        currentThread: {
          ...base.uiCache.currentThread,
          ...((parsed.uiCache || {}).currentThread || {})
        }
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
