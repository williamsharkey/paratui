#!/usr/bin/env node
import { ParatuiApp } from "./app.js";

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function main(): Promise<void> {
  const prompt = readArg("--prompt");
  const apiKey = readArg("--api-key");
  const title = readArg("--title");
  const generationServer = readArg("--server");
  const method = readArg("--method");
  const format = readArg("--format") || "png";
  const outDir = readArg("--out-dir");
  const macroPath = readArg("--macro");
  const exitAfterMacro = process.argv.includes("--exit-after-macro");
  const app = new ParatuiApp({
    macroPath,
    exitAfterMacro,
    headless: Boolean(prompt)
  });

  try {
    await app.init();
    if (outDir) {
      app.config.exports.directory = outDir;
    }

    if (apiKey && !app.state.authUser) {
      await app.setApiKey(apiKey);
    }

    if (prompt) {
      if (!app.state.authUser) {
        if (!apiKey) {
          throw new Error("Headless prompt mode requires saved auth or --api-key");
        }
        await app.setApiKey(apiKey);
      }
      const image = await app.generatePrompt({
        prompt,
        title,
        server: generationServer,
        method,
        share: true
      });
      const savedPath = await app.saveCurrentArt(format);
      process.stdout.write(`${JSON.stringify({ ok: true, image, savedPath })}\n`);
      app.shutdown();
      return;
    }

    if (macroPath) {
      await app.runMacroFile(macroPath);
      if (exitAfterMacro) {
        app.shutdown();
        return;
      }
    }

    await app.runInteractive();
  } finally {
    app.shutdown();
  }
}

async function flushAndExit(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve()))
  ]);
  process.exit(code);
}

main()
  .then(() => flushAndExit(typeof process.exitCode === "number" ? process.exitCode : 0))
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    await flushAndExit(1);
  });
