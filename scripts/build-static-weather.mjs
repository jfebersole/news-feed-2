import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "public", "data");
const articlesDir = path.join(dataDir, "articles");
const feedPath = path.join(dataDir, "feed.json");
const indexPath = path.join(articlesDir, "index.json");

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { buildArticlePayload, canonicalizeUrl, pullDailyWeather } = await import(
  new URL("../server.js", import.meta.url)
);

await fs.mkdir(articlesDir, { recursive: true });

const feed = await readJson(feedPath, null);
if (!feed || typeof feed !== "object") {
  throw new Error("Build the static feed before building the weather ticket.");
}

const articleIndex = await readJson(indexPath, { version: 1, entries: {} });
const entries = articleIndex.entries && typeof articleIndex.entries === "object" ? articleIndex.entries : {};
const { item: weather } = await pullDailyWeather();
const canonicalUrl = canonicalizeUrl(weather.url) || weather.url;
const existingEntry = entries[canonicalUrl];
const articleId = existingEntry?.id || createArticleId(canonicalUrl);
const nowIso = new Date().toISOString();

const payload = await buildArticlePayload({
  url: weather.url,
  sourceName: weather.source,
  fallbackTitle: weather.title,
  fallbackSummary: weather.summary,
  fallbackContentHtml: weather.feedContentHtml,
});
const outputPayload = { ...payload };
delete outputPayload.cached;

const weatherPayload = { ...weather, articleId };
delete weatherPayload.feedContentHtml;

entries[canonicalUrl] = {
  ...existingEntry,
  id: articleId,
  source: weather.source,
  title: weather.title,
  firstSeenAt: existingEntry?.firstSeenAt || nowIso,
  lastSeenAt: nowIso,
  updatedAt: nowIso,
  mode: outputPayload.mode,
  access: outputPayload.access || weather.access || "open",
};

await writeJson(path.join(articlesDir, `${articleId}.json`), outputPayload);
await writeJson(feedPath, {
  ...feed,
  weather: weatherPayload,
  weatherGeneratedAt: nowIso,
  weatherError: null,
});
await writeJson(indexPath, {
  ...articleIndex,
  version: 1,
  generatedAt: nowIso,
  entries,
});

console.log(`Weather: ${weather.dailyDigitLabel} :: ${weather.title}`);
console.log(`Wrote ${feedPath}`);

async function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createArticleId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
