import net from "node:net";
import type { AppSnapshot } from "./types.js";

type BridgeEvent =
  | { type: "ready"; snapshot: AppSnapshot }
  | { type: "state"; snapshot: AppSnapshot }
  | { type: "idle"; snapshot: AppSnapshot }
  | { type: "macro:start"; path: string }
  | { type: "macro:success"; path: string }
  | { type: "macro:error"; path: string; error: string }
  | { type: "log"; message: string };

export class TestBridge {
  #socket: net.Socket | null = null;
  #enabled = false;

  constructor() {
    const rawPort = process.env.PARATUI_TEST_PORT;
    const port = rawPort ? Number(rawPort) : NaN;
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }

    this.#enabled = true;
    this.#socket = net.createConnection({ host: "127.0.0.1", port });
    this.#socket.on("error", () => {
      this.#enabled = false;
    });
  }

  emit(event: BridgeEvent): void {
    if (!this.#enabled || !this.#socket) {
      return;
    }
    this.#socket.write(`${JSON.stringify(event)}\n`);
  }

  close(): void {
    if (this.#socket) {
      this.#socket.end();
      this.#socket.destroy();
      this.#socket = null;
    }
    this.#enabled = false;
  }
}
