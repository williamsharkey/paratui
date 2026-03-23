import sharp from "sharp";

const DEFAULT_CHARS = " .:-=+*#%@";
const HORIZONTAL_CHARACTER_SCALE = 2;

export interface AsciiRenderSize {
  width: number;
  height: number;
}

export async function imageBufferToAscii(
  buffer: Buffer,
  width = 38,
  height = 16
): Promise<string> {
  const targetWidth = Math.max(2, Math.floor(width));
  const sampleWidth = Math.max(1, Math.ceil(targetWidth / HORIZONTAL_CHARACTER_SCALE));
  const { data, info } = await sharp(buffer)
    .resize({
      width: sampleWidth,
      height,
      fit: "inside"
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rows: string[] = [];
  for (let y = 0; y < info.height; y += 1) {
    let line = "";
    for (let x = 0; x < info.width; x += 1) {
      const idx = y * info.width + x;
      const brightness = data[idx] ?? 0;
      const bucket = Math.round((brightness / 255) * (DEFAULT_CHARS.length - 1));
      const glyph = DEFAULT_CHARS[bucket] || " ";
      line += glyph.repeat(HORIZONTAL_CHARACTER_SCALE);
    }
    rows.push(line.slice(0, targetWidth));
  }

  return rows.join("\n");
}

export class AsciiArtCache {
  #rawCache = new Map<string, Promise<Buffer>>();
  #asciiCache = new Map<string, Promise<string>>();
  #maxRawEntries: number;
  #maxAsciiEntries: number;

  constructor(options: {
    maxRawEntries?: number;
    maxAsciiEntries?: number;
  } = {}) {
    this.#maxRawEntries = options.maxRawEntries || 48;
    this.#maxAsciiEntries = options.maxAsciiEntries || 96;
  }

  get(url: string, size: AsciiRenderSize, loader: () => Promise<Buffer>): Promise<string> {
    const normalized = normalizeSize(size);
    const cacheKey = asciiCacheKey(url, normalized);
    if (!this.#asciiCache.has(cacheKey)) {
      this.#asciiCache.set(
        cacheKey,
        this.#getRaw(url, loader).then((buffer) => imageBufferToAscii(buffer, normalized.width, normalized.height))
      );
      trimOldest(this.#asciiCache, this.#maxAsciiEntries);
    }
    touch(this.#asciiCache, cacheKey);
    return this.#asciiCache.get(cacheKey)!;
  }

  has(url: string | null | undefined, size?: Partial<AsciiRenderSize> | null): boolean {
    if (!url) {
      return false;
    }
    if (size?.width && size?.height) {
      return this.#asciiCache.has(asciiCacheKey(url, normalizeSize(size as AsciiRenderSize)));
    }
    if (this.#rawCache.has(url)) {
      return true;
    }
    const prefix = `${url}#`;
    return Array.from(this.#asciiCache.keys()).some((key) => key.startsWith(prefix));
  }

  peek(url: string | null | undefined, size: AsciiRenderSize): Promise<string> | null {
    if (!url) {
      return null;
    }
    return this.#asciiCache.get(asciiCacheKey(url, normalizeSize(size))) || null;
  }

  #getRaw(url: string, loader: () => Promise<Buffer>): Promise<Buffer> {
    if (!this.#rawCache.has(url)) {
      this.#rawCache.set(url, loader());
      trimOldest(this.#rawCache, this.#maxRawEntries);
    }
    touch(this.#rawCache, url);
    return this.#rawCache.get(url)!;
  }
}

function normalizeSize(size: AsciiRenderSize): AsciiRenderSize {
  return {
    width: Math.max(8, Math.floor(size.width)),
    height: Math.max(4, Math.floor(size.height))
  };
}

function asciiCacheKey(url: string, size: AsciiRenderSize): string {
  return `${url}#${size.width}x${size.height}`;
}

function touch<T>(cache: Map<string, Promise<T>>, key: string): void {
  const value = cache.get(key);
  if (!value) {
    return;
  }
  cache.delete(key);
  cache.set(key, value);
}

function trimOldest<T>(cache: Map<string, Promise<T>>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
  }
}
