import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import {
  InteractiveAppHarness,
  getFreePort,
  runCli,
  runPtmScript,
  seedFixtures,
  startLocalServer,
  type ManagedServer
} from "./helpers/interactive.js";

const SCRIPT_DIR = path.resolve(path.join(import.meta.dirname, "scripts"));

let server: ManagedServer;

before(async () => {
  await seedFixtures();
  server = await startLocalServer(await getFreePort());
});

after(async () => {
  if (server) {
    await server.stop();
  }
});

async function withApp(run: (app: InteractiveAppHarness) => Promise<void>): Promise<void> {
  const app = await InteractiveAppHarness.start(server.baseUrl);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test("interactive PTY scripts stay in sync with the live TUI", { concurrency: false }, async (t) => {
  await t.test("login and profile navigation", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "login-profile.ptm"));
      const config = await app.readConfig() as {
        auth: { bearerToken: string | null; username: string | null };
      };
      assert.ok(config.auth.bearerToken);
      assert.equal(config.auth.username, "sharkgod");
    });
  });

  await t.test("commands stay scriptable while the visible UI stays keyboard-first", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "slash-menu.ptm"));
    });
  });

  await t.test("creation browser preloads neighbors and assigns slots", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "creations-browser.ptm"));
    });
  });

  await t.test("direct messages stay scriptable", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "dm-social.ptm"));
    });
  });

  await t.test("rooms stay scriptable", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "room-social.ptm"));
    });
  });

  await t.test("latest feed browsing stays scriptable", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "feed-latest.ptm"));
    });
  });

  await t.test("room uploads can publish and copy a share link without leaving chat", async () => {
    await withApp(async (app) => {
      await app.runCommand("/auth/key/set psn_test_sharkgod");
      await app.runCommand("/rooms/join noir");

      const tempImagePath = path.join(app.configDir, "drop-share.png");
      await sharp({
        create: {
          width: 24,
          height: 24,
          channels: 3,
          background: { r: 240, g: 240, b: 240 }
        }
      })
        .png()
        .toFile(tempImagePath);

      const beforeMessages = app.snapshot().room.messageCount;
      await app.pressKey("space", (snapshot) => snapshot.composer.active === true && snapshot.composer.kind === "room");
      await app.typeText(tempImagePath);
      await app.pressKey("enter");
      await app.waitForSnapshot("status", "uploaded drop share and copied link", 20_000);

      assert.equal(app.snapshot().view, "room");
      assert.equal(app.snapshot().room.name, "noir");
      assert.equal(app.snapshot().room.messageCount, beforeMessages);

      const clipboard = await app.readClipboard();
      assert.match(clipboard, /\/s\/[a-z0-9]+\/.+/i);
    });
  });

  await t.test("prompt generation and export packing stay scriptable", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "prompt-export.ptm"));
      const exportPath = app.snapshot().export.lastSavedPath;
      assert.ok(exportPath);
      assert.equal(path.dirname(exportPath), app.exportDir);
      const metadata = await sharp(exportPath).metadata();
      assert.match(metadata.xmpAsString || "", /acid rain alley/);
      assert.match(metadata.xmpAsString || "", /generation_method/);
      assert.match(metadata.xmpAsString || "", /mutate/);
    });
  });

  await t.test("comments, settings, and logout persist through config", async () => {
    await withApp(async (app) => {
      await runPtmScript(app, path.join(SCRIPT_DIR, "comments-settings-logout.ptm"));
      const config = await app.readConfig() as {
        auth: { bearerToken: string | null; username: string | null };
        audio: { muted: boolean };
      };
      assert.equal(config.audio.muted, true);
      assert.equal(config.auth.bearerToken, null);
      assert.equal(config.auth.username, null);
    });
  });

  await t.test("headless prompt mode emits JSON and saves packed exports", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paratui-headless-"));
    const outDir = path.join(tempDir, "out");
    const configDir = path.join(tempDir, "config");
    await fs.mkdir(outDir, { recursive: true });
    const result = await runCli([
      "--prompt", "orbital fungus",
      "--title", "orbital fungus",
      "--server", "mutations",
      "--method", "chain",
      "--format", "jpg",
      "--out-dir", outDir,
      "--api-key", "psn_test_sharkgod"
    ], {
      PARATUI_SERVER_BASE_URL: server.baseUrl,
      PARATUI_CONFIG_DIR: configDir,
      PARATUI_DISABLE_EXTERNAL_OPEN: "1"
    });
    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      savedPath: string;
      image: { title: string | null };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.image.title, "orbital fungus");
    assert.match(parsed.savedPath, /orbital-fungus-sharkgod\.jpg$/);
    const metadata = await sharp(parsed.savedPath).metadata();
    assert.match(metadata.xmpAsString || "", /orbital fungus/);
    assert.match(metadata.xmpAsString || "", /chain/);
    assert.match(metadata.xmpAsString || "", /mutations/);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
