import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ParasceneRealtimeConfig, ParasceneRealtimeSession } from "./api.js";

type ChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR" | string;

export interface ParasceneRealtimeCallbacks {
  onUserDirty?: () => void;
  onThreadDirty?: (threadId: number) => void;
  onStateChange?: (connected: boolean) => void;
  onError?: (message: string) => void;
}

interface SubscribeOptions {
  topic: string;
  event: string;
  debounceMs: number;
  onBroadcast: () => void;
  onReconnect?: () => void;
  storeStatus: (status: ChannelStatus) => void;
}

const USER_DEBOUNCE_MS = 280;
const THREAD_DEBOUNCE_MS = 220;
const SUBSCRIBE_TIMEOUT_MS = 5_000;

export class ParasceneRealtimeClient {
  readonly #callbacks: ParasceneRealtimeCallbacks;
  #client: SupabaseClient | null = null;
  #configKey: string | null = null;
  #userId: number | null = null;
  #threadId: number | null = null;
  #userChannel: RealtimeChannel | null = null;
  #threadChannel: RealtimeChannel | null = null;
  #userStatus: ChannelStatus | null = null;
  #threadStatus: ChannelStatus | null = null;

  constructor(callbacks: ParasceneRealtimeCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  connected(): boolean {
    return this.#userStatus === "SUBSCRIBED";
  }

  async connect(
    config: ParasceneRealtimeConfig,
    session: ParasceneRealtimeSession,
    userId: number
  ): Promise<boolean> {
    const normalizedUserId = Number(userId);
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
      return false;
    }

    const key = `${config.url}\n${config.anonKey}`;
    if (!this.#client || this.#configKey !== key) {
      await this.disconnect();
      this.#client = createClient(config.url, config.anonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      });
      this.#configKey = key;
    }

    const auth = await this.#client.auth.setSession({
      access_token: session.accessToken,
      refresh_token: session.refreshToken
    });
    if (auth.error) {
      this.#callbacks.onError?.(auth.error.message);
      await this.disconnect();
      return false;
    }

    this.#userId = normalizedUserId;
    try {
      await this.#bindUserChannel();
      if (this.#threadId != null) {
        await this.#bindThreadChannel(this.#threadId);
      }
      return this.connected();
    } catch (error) {
      this.#callbacks.onError?.(error instanceof Error ? error.message : String(error));
      await this.disconnect();
      return false;
    }
  }

  async setThread(threadId: number | null): Promise<void> {
    const normalizedThreadId = Number(threadId);
    const nextThreadId = Number.isFinite(normalizedThreadId) && normalizedThreadId > 0
      ? normalizedThreadId
      : null;
    if (this.#threadId === nextThreadId) {
      return;
    }
    this.#threadId = nextThreadId;

    await this.#removeChannel(this.#threadChannel);
    this.#threadChannel = null;
    this.#threadStatus = null;
    if (this.#client && this.connected() && this.#threadId != null) {
      try {
        await this.#bindThreadChannel(this.#threadId);
      } catch (error) {
        this.#callbacks.onError?.(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async disconnect(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#configKey = null;
    this.#userId = null;
    this.#threadId = null;
    this.#userStatus = null;
    this.#threadStatus = null;

    await this.#removeChannel(this.#threadChannel);
    await this.#removeChannel(this.#userChannel);
    this.#threadChannel = null;
    this.#userChannel = null;

    if (client) {
      try {
        await client.auth.signOut();
      } catch {
        // ignore
      }
    }
    this.#callbacks.onStateChange?.(false);
  }

  async #bindUserChannel(): Promise<void> {
    if (!this.#client || !this.#userId) {
      return;
    }
    await this.#removeChannel(this.#userChannel);
    this.#userChannel = this.#client.channel(`user:${this.#userId}`, { config: { private: true } });
    await this.#subscribeChannel(this.#userChannel, {
      topic: `user:${this.#userId}`,
      event: "dirty",
      debounceMs: USER_DEBOUNCE_MS,
      onBroadcast: () => this.#callbacks.onUserDirty?.(),
      onReconnect: () => this.#callbacks.onUserDirty?.(),
      storeStatus: (status) => {
        this.#userStatus = status;
        this.#callbacks.onStateChange?.(this.connected());
      }
    });
    this.#callbacks.onStateChange?.(this.connected());
  }

  async #bindThreadChannel(threadId: number): Promise<void> {
    if (!this.#client) {
      return;
    }
    await this.#removeChannel(this.#threadChannel);
    this.#threadChannel = this.#client.channel(`room:${threadId}`, { config: { private: true } });
    await this.#subscribeChannel(this.#threadChannel, {
      topic: `room:${threadId}`,
      event: "dirty",
      debounceMs: THREAD_DEBOUNCE_MS,
      onBroadcast: () => this.#callbacks.onThreadDirty?.(threadId),
      onReconnect: () => this.#callbacks.onThreadDirty?.(threadId),
      storeStatus: (status) => {
        this.#threadStatus = status;
      }
    });
  }

  async #subscribeChannel(channel: RealtimeChannel, options: SubscribeOptions): Promise<void> {
    let debounceTimer: NodeJS.Timeout | null = null;
    let previousStatus: ChannelStatus | null = null;
    let droppedAfterLive = false;

    const run = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      options.onBroadcast();
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out subscribing to ${options.topic}`));
      }, SUBSCRIBE_TIMEOUT_MS);

      channel
        .on("broadcast", { event: options.event }, () => {
          if (options.debounceMs <= 0) {
            run();
            return;
          }
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(run, options.debounceMs);
        })
        .subscribe((status, error) => {
          const nextStatus = status as ChannelStatus;
          options.storeStatus(nextStatus);

          if (previousStatus === "SUBSCRIBED" && nextStatus !== "SUBSCRIBED") {
            droppedAfterLive = true;
          }

          if (nextStatus === "SUBSCRIBED") {
            clearTimeout(timeout);
            if (droppedAfterLive) {
              droppedAfterLive = false;
              options.onReconnect?.();
            }
            resolve();
          } else if (nextStatus === "CHANNEL_ERROR" || nextStatus === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(new Error(error?.message || `Realtime ${nextStatus.toLowerCase()} for ${options.topic}`));
          } else if (error?.message) {
            this.#callbacks.onError?.(error.message);
          }

          previousStatus = nextStatus;
        });
    }).finally(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    });
  }

  async #removeChannel(channel: RealtimeChannel | null): Promise<void> {
    if (!channel || !this.#client) {
      return;
    }
    try {
      await this.#client.removeChannel(channel);
    } catch {
      // ignore
    }
  }
}
