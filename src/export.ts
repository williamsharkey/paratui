import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export interface ExportMetadata {
  source: "paratui";
  exportedAt: string;
  creationId: number;
  title: string | null;
  ownerHandle: string | null;
  description: string | null;
  prompt: string | null;
  serverBaseUrl: string;
  originalUrl: string | null;
  sourceMetadata: Record<string, unknown> | null;
}

export function normalizeFormat(format: string | null | undefined): "png" | "jpg" {
  const normalized = String(format || "png").trim().toLowerCase();
  return normalized === "jpg" || normalized === "jpeg" ? "jpg" : "png";
}

function slugifyPart(input: string | null | undefined, fallback: string): string {
  const normalized = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildExportFilename(
  title: string | null,
  ownerHandle: string | null,
  format: "png" | "jpg"
): string {
  const slug = slugifyPart(title, "untitled");
  const owner = slugifyPart(ownerHandle, "unknown");
  return `${slug}-${owner}.${format}`;
}

export function buildExportXmp(metadata: ExportMetadata): string {
  const payload = escapeXml(JSON.stringify(metadata));
  return [
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">`,
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `    <rdf:Description rdf:about="" xmlns:paratui="https://paratui.local/ns/1.0/">`,
    `      <paratui:payload>${payload}</paratui:payload>`,
    `    </rdf:Description>`,
    `  </rdf:RDF>`,
    `</x:xmpmeta>`,
    `<?xpacket end="w"?>`
  ].join("");
}

export async function exportImageWithMetadata(options: {
  buffer: Buffer;
  directory: string;
  title: string | null;
  ownerHandle: string | null;
  format: "png" | "jpg";
  metadata: ExportMetadata;
}): Promise<string> {
  const filename = buildExportFilename(options.title, options.ownerHandle, options.format);
  const outputPath = path.join(options.directory, filename);
  await fs.mkdir(options.directory, { recursive: true });

  let pipeline = sharp(options.buffer).withXmp(buildExportXmp(options.metadata));
  pipeline = options.format === "jpg"
    ? pipeline.jpeg({ quality: 92 })
    : pipeline.png();

  await pipeline.toFile(outputPath);
  return outputPath;
}
