import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEED_LIMIT = parsePositiveInt(process.env.STATIC_FEED_LIMIT, 220);
const RECENT_REFRESH_COUNT = parsePositiveInt(process.env.STATIC_REFRESH_RECENT_COUNT, 40);
const FETCH_CONCURRENCY = parsePositiveInt(process.env.STATIC_CONCURRENCY, 5);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "public", "data");
const articlesDir = path.join(dataDir, "articles");
const feedPath = path.join(dataDir, "feed.json");
const indexPath = path.join(articlesDir, "index.json");

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { aggregateSources, buildArticlePayload, canonicalizeUrl, inferAccessLevel } = await import(
  new URL("../server.js", import.meta.url)
);

await fs.mkdir(articlesDir, { recursive: true });

const existingIndex = await readJson(indexPath, { version: 1, entries: {} });
const previousFeed = await readJson(feedPath, null);
const entries = normalizeEntries(existingIndex.entries);

console.log(
  `Building static feed (limit=${FEED_LIMIT}, refresh_recent=${RECENT_REFRESH_COUNT}, concurrency=${FETCH_CONCURRENCY})`
);

const liveFeed = await aggregateSources();
const feed = stabilizeFeedWithPreviousSnapshot(liveFeed, previousFeed);
const nowIso = new Date().toISOString();
const items = (feed.items || []).slice(0, FEED_LIMIT).map((item) => ({ ...item }));

const articleTasks = [];
for (let index = 0; index < items.length; index += 1) {
  const item = items[index];
  const canonicalUrl = canonicalizeUrl(item.url) || item.url;
  const existingEntry = entries[canonicalUrl];
  const articleId = existingEntry?.id || createArticleId(canonicalUrl);
  const articlePath = path.join(articlesDir, `${articleId}.json`);
  const hasArticleFile = await fileExists(articlePath);
  const shouldRefresh = index < RECENT_REFRESH_COUNT;

  item.articleId = articleId;
  if (!item.access) {
    item.access = inferAccessLevel(item.source, item.url);
  }

  entries[canonicalUrl] = {
    id: articleId,
    source: item.source || "",
    title: item.title || "",
    firstSeenAt: existingEntry?.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    updatedAt: existingEntry?.updatedAt || null,
  };

  if (!hasArticleFile || shouldRefresh) {
    articleTasks.push({
      index,
      item,
      canonicalUrl,
      articleId,
      articlePath,
    });
  }
}

console.log(`Stories: ${items.length}. Article payloads to build/refresh: ${articleTasks.length}.`);

await runWithConcurrency(articleTasks, FETCH_CONCURRENCY, async (task, taskIndex) => {
  const payload = await safeBuildArticlePayload(task.item);
  const outputPayload = { ...payload };
  delete outputPayload.cached;

  await writeJson(task.articlePath, outputPayload);

  const previous = entries[task.canonicalUrl] || {};
  entries[task.canonicalUrl] = {
    ...previous,
    id: task.articleId,
    source: task.item.source || "",
    title: task.item.title || "",
    lastSeenAt: nowIso,
    updatedAt: nowIso,
    mode: outputPayload.mode,
    access: outputPayload.access || task.item.access || inferAccessLevel(task.item.source, task.item.url),
  };

  const marker = `[${taskIndex + 1}/${articleTasks.length}]`;
  console.log(`${marker} ${task.item.source} :: ${task.item.title}`);
});

const feedPayload = {
  generatedAt: nowIso,
  fetchedAt: feed.fetchedAt || nowIso,
  sourceCount: feed.sourceCount || (feed.sources || []).length,
  itemCount: items.length,
  totalItemCount: feed.itemCount || items.length,
  items,
  sources: feed.sources || [],
};

await writeJson(feedPath, feedPayload);
await writeJson(indexPath, { version: 1, generatedAt: nowIso, entries });

console.log(`Wrote ${feedPath}`);
console.log(`Wrote ${indexPath}`);
console.log("Static feed build complete.");

async function safeBuildArticlePayload(item) {
  try {
    return await buildArticlePayload({
      url: item.url,
      sourceName: item.source || "",
      fallbackTitle: item.title || "",
      fallbackSummary: item.summary || "",
    });
  } catch (error) {
    const access = item.access || inferAccessLevel(item.source, item.url);
    const message =
      error instanceof Error ? `Unable to fetch full text: ${error.message}` : "Unable to fetch full text.";

    return {
      mode: "excerpt",
      paywalled: access === "paywalled",
      access,
      url: item.url,
      source: item.source || "",
      title: item.title || "Article",
      excerpt: item.summary || "Open the original article to continue reading.",
      reason: message,
    };
  }
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, serialized, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeEntries(entries) {
  if (!entries || typeof entries !== "object") {
    return {};
  }

  const output = {};
  Object.entries(entries).forEach(([key, value]) => {
    if (!key || !value || typeof value !== "object" || typeof value.id !== "string") {
      return;
    }

    output[key] = value;
  });

  return output;
}

function stabilizeFeedWithPreviousSnapshot(currentFeed, previousFeed) {
  if (!currentFeed || !Array.isArray(currentFeed.items) || !Array.isArray(currentFeed.sources)) {
    return currentFeed;
  }

  if (!previousFeed || !Array.isArray(previousFeed.items) || !previousFeed.items.length) {
    return currentFeed;
  }

  const previousBySource = new Map();
  previousFeed.items.forEach((item) => {
    if (!item?.source || !item?.url) {
      return;
    }

    const list = previousBySource.get(item.source) || [];
    list.push({ ...item });
    previousBySource.set(item.source, list);
  });

  const mergedSources = currentFeed.sources.map((source) => ({ ...source }));
  const mergedItems = [...currentFeed.items];
  const fallbackSummary = [];

  mergedSources.forEach((source) => {
    const failed = source.mode === "failed" || Number(source.itemCount || 0) === 0;
    if (!failed) {
      return;
    }

    const fallbackItems = (previousBySource.get(source.name) || []).slice(0, 24);
    if (!fallbackItems.length) {
      return;
    }

    mergedItems.push(...fallbackItems);
    source.mode = "fallback-cache";
    source.itemCount = fallbackItems.length;
    source.error = source.error
      ? `${source.error} Using previous snapshot data.`
      : "Using previous snapshot data.";
    fallbackSummary.push(`${source.name} (${fallbackItems.length})`);
  });

  if (fallbackSummary.length) {
    console.log(`Reused previous snapshot for failed sources: ${fallbackSummary.join(", ")}`);
  }

  const dedupedItems = dedupeAndSortFeedItems(mergedItems);
  return {
    ...currentFeed,
    itemCount: dedupedItems.length,
    items: dedupedItems,
    sources: mergedSources,
  };
}

function dedupeAndSortFeedItems(items) {
  const seen = new Map();
  items.forEach((item) => {
    if (!item?.url) {
      return;
    }

    const canonical = canonicalizeUrl(item.url);
    if (!canonical) {
      return;
    }

    const normalized = { ...item, url: canonical };
    const existing = seen.get(canonical);
    if (!existing) {
      seen.set(canonical, normalized);
      return;
    }

    const existingDate = existing.publishedAt ? Date.parse(existing.publishedAt) : 0;
    const candidateDate = normalized.publishedAt ? Date.parse(normalized.publishedAt) : 0;
    if (candidateDate > existingDate) {
      seen.set(canonical, normalized);
    }
  });

  return [...seen.values()].sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });
}

function createArticleId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

async function runWithConcurrency(items, limit, worker) {
  if (!items.length) {
    return;
  }

  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const taskIndex = cursor;
      cursor += 1;

      if (taskIndex >= items.length) {
        return;
      }

      await worker(items[taskIndex], taskIndex);
    }
  });

  await Promise.all(workers);
}
