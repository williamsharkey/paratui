import fs from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "./config.js";

const EMOJI_PATTERN = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/gu;

const EMOJI_MAP = new Map<string, string>([
  ["😂", ":'D"],
  ["🤣", "XD"],
  ["😭", ":'("],
  ["😢", ":'("],
  ["🙂", ":)"],
  ["😊", ":)"],
  ["😄", ":D"],
  ["😁", ":D"],
  ["😎", "8)"],
  ["😍", "<3"],
  ["❤", "<3"],
  ["❤️", "<3"],
  ["👍", "+1"],
  ["👎", "-1"],
  ["🔥", "*"],
  ["✨", "*"],
  ["🎉", "\\o/"]
]);

const seenEmoji = new Set<string>();
let writeQueue = Promise.resolve();

export function sanitizeTextForTui(input: string): string {
  if (!input) {
    return input;
  }

  return input.replace(EMOJI_PATTERN, (emoji) => {
    noteEncounteredEmoji(emoji);
    return EMOJI_MAP.get(emoji) || ":?:";
  });
}

function noteEncounteredEmoji(emoji: string): void {
  if (seenEmoji.has(emoji)) {
    return;
  }
  seenEmoji.add(emoji);

  const replacement = EMOJI_MAP.get(emoji) || ":?:";
  const logEntry = JSON.stringify({
    emoji,
    replacement,
    seenAt: new Date().toISOString()
  });

  writeQueue = writeQueue
    .then(async () => {
      const configDir = getConfigDir();
      await fs.mkdir(configDir, { recursive: true });
      await fs.appendFile(path.join(configDir, "emoji-log.jsonl"), `${logEntry}\n`, "utf8");
    })
    .catch(() => undefined);
}
