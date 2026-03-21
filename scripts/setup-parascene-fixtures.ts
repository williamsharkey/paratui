import path from "node:path";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import sharp from "sharp";

process.env.DB_ADAPTER = "sqlite";

function resolveParasceneModule(relativePath: string): string {
  const baseDir = process.env.PARASCENE_REFERENCE_DIR
    ? path.resolve(process.env.PARASCENE_REFERENCE_DIR)
    : path.resolve(process.cwd(), "..", "parascene-reference");
  return pathToFileURL(path.join(baseDir, relativePath)).href;
}

const [{ openDb }] = await Promise.all([
  import(resolveParasceneModule("db/index.js"))
]);

type DbInstance = Awaited<ReturnType<typeof openDb>>;

let dbInstance: DbInstance = await openDb();
let { db, queries, storage, reset } = dbInstance;

if (storage?.clearAll) {
  await storage.clearAll();
}
if (reset) {
  await reset();
  dbInstance = await openDb();
  ({ db, queries, storage, reset } = dbInstance);
}

async function ensureCredits(userId: number): Promise<void> {
  const credits = await queries.selectUserCredits?.get?.(userId);
  if (!credits && queries.insertUserCredits?.run) {
    await queries.insertUserCredits.run(userId, 100, null);
  }
}

async function ensureUser(
  email: string,
  password: string,
  role: string,
  profile: {
    user_name: string;
    display_name: string;
    about: string;
  }
): Promise<number> {
  let user = await queries.selectUserByEmail.get(email);
  if (!user) {
    const result = await queries.insertUser.run(email, bcrypt.hashSync(password, 12), role);
    const id = Number(result.insertId || result.lastInsertRowid);
    user = await queries.selectUserByEmail.get(email);
    await ensureCredits(id);
  }

  const userId = Number(user.id);
  await queries.upsertUserProfile.run(userId, {
    user_name: profile.user_name,
    display_name: profile.display_name,
    about: profile.about,
    socials: {},
    badges: [],
    meta: {}
  });
  await ensureCredits(userId);
  return userId;
}

async function pngFixture(background: string, accent: string): Promise<Buffer> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="96" viewBox="0 0 128 96">
      <rect width="128" height="96" fill="${background}" />
      <rect x="12" y="12" width="104" height="72" rx="8" fill="none" stroke="${accent}" stroke-width="4" />
      <circle cx="64" cy="48" r="20" fill="${accent}" opacity="0.85" />
      <rect x="24" y="60" width="80" height="8" rx="4" fill="${accent}" opacity="0.55" />
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function seedCreation(
  userId: number,
  filename: string,
  title: string,
  description: string,
  background: string,
  accent: string
): Promise<number> {
  const buffer = await pngFixture(background, accent);
  await storage.uploadImage(buffer, filename);
  const filePath = `/api/images/created/${filename}`;
  const insert = await queries.insertCreatedImage.run(
    userId,
    filename,
    filePath,
    128,
    96,
    background,
    "completed",
    { nsfw: false, media_type: "image" }
  );
  const creationId = Number(insert.insertId || insert.lastInsertRowid);
  await queries.publishCreatedImage.run(creationId, userId, title, description, false);
  return creationId;
}

const sharkgodId = await ensureUser("consumer@example.com", "p123@#", "consumer", {
  user_name: "sharkgod",
  display_name: "Sharkgod",
  about: "Local test operator."
});
const crosshjId = await ensureUser("creator@example.com", "p123@#", "creator", {
  user_name: "crosshj",
  display_name: "Crosshj",
  about: "Builds noisy image worlds."
});
const noirguyId = await ensureUser("provider@example.com", "p123@#", "provider", {
  user_name: "noirguy",
  display_name: "Noirguy",
  about: "Lurks in the noir server."
});
const adminId = await ensureUser("admin@example.com", "p123@#", "admin", {
  user_name: "admin",
  display_name: "Admin",
  about: "Keeps the test rig alive."
});
const mossId = await ensureUser("moss@example.com", "p123@#", "consumer", {
  user_name: "mossman",
  display_name: "Mossman",
  about: "Extra profile fixture."
});

await queries.insertUserFollow.run(sharkgodId, crosshjId);
await queries.insertUserFollow.run(sharkgodId, noirguyId);
await queries.insertUserFollow.run(crosshjId, mossId);

const crosshjCreations = [
  await seedCreation(crosshjId, "crosshj-earthworm-jim.png", "earthworm jim", "a loud green cartoon mutation", "#1c2d16", "#c9f84a"),
  await seedCreation(crosshjId, "crosshj-noir-bridge.png", "noir bridge", "wet bridge at midnight", "#101318", "#d9d9d9"),
  await seedCreation(crosshjId, "crosshj-glass-tunnel.png", "glass tunnel", "reflective tunnel with depth", "#0f1c2a", "#7ed7ff")
];

const noirguyCreations = [
  await seedCreation(noirguyId, "noirguy-late-train.png", "late train", "black train lights in rain", "#0b0b0d", "#f5f2d2"),
  await seedCreation(noirguyId, "noirguy-ghost-alley.png", "ghost alley", "narrow alley with white glow", "#141414", "#f0f0f0")
];

await queries.insertCreatedImageComment.run(sharkgodId, crosshjCreations[0], "this rules");
await queries.insertCreatedImageComment.run(crosshjId, crosshjCreations[0], "thanks");
await queries.insertCreatedImageComment.run(noirguyId, noirguyCreations[0], "good tension");

const comments = await queries.selectCreatedImageComments.all(crosshjCreations[0], { order: "asc", limit: 10, offset: 0 });
if (comments[0]?.id) {
  await queries.insertCommentReaction.run(Number(comments[0].id), crosshjId, "thumbsUp");
}

if (comments[1]?.id) {
  await queries.insertCommentReaction.run(Number(comments[1].id), sharkgodId, "heart");
}

await queries.updateUserLastActive.run(sharkgodId);
await queries.updateUserLastActive.run(crosshjId);

db.prepare("UPDATE users SET last_active_at = datetime('now', '-2 days') WHERE id = ?").run(noirguyId);
db.prepare("UPDATE users SET last_active_at = datetime('now', '-10 days') WHERE id = ?").run(mossId);
db.prepare("UPDATE users SET last_active_at = datetime('now', '-1 day') WHERE id = ?").run(adminId);

console.log("PARASCENE_FIXTURES_READY");
