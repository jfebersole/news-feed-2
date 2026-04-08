import express from "express";
import * as cheerio from "cheerio";
import Parser from "rss-parser";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const parser = new Parser({
  timeout: 15_000,
  headers: {
    "user-agent": USER_AGENT,
  },
  customFields: {
    item: ["summary", "description", "content:encoded"],
  },
});

const SOURCES = [
  {
    name: "Marginal Revolution",
    url: "https://marginalrevolution.com/",
    feedUrl: "https://marginalrevolution.com/feed",
  },
  {
    name: "Tyler Cowen's Ethnic Dining Guide",
    url: "https://tylercowensethnicdiningguide.com/",
    feedUrl: "https://tylercowensethnicdiningguide.com/feed",
  },
  {
    name: "Astral Codex Ten",
    url: "https://www.astralcodexten.com/",
    feedUrl: "https://www.astralcodexten.com/feed",
  },
  {
    name: "Understanding AI",
    url: "https://www.understandingai.org/",
    feedUrl: "https://www.understandingai.org/feed",
  },
  {
    name: "Works in Progress",
    url: "https://www.worksinprogress.news/",
    feedUrl: "https://www.worksinprogress.news/feed",
  },
  {
    name: "Walking the World",
    url: "https://walkingtheworld.substack.com/",
    feedUrl: "https://walkingtheworld.substack.com/feed",
  },
  {
    name: "Scott Sumner",
    url: "https://scottsumner.substack.com/",
    feedUrl: "https://scottsumner.substack.com/feed",
  },
  {
    name: "One Useful Thing",
    url: "https://www.oneusefulthing.org/",
    feedUrl: "https://www.oneusefulthing.org/feed",
  },
  {
    name: "Construction Physics",
    url: "https://www.construction-physics.com/",
    feedUrl: "https://www.construction-physics.com/feed",
  },
  {
    name: "Neil Paine",
    url: "https://neilpaine.substack.com/",
    feedUrl: "https://neilpaine.substack.com/feed",
  },
  {
    name: "Noahpinion",
    url: "https://www.noahpinion.blog/",
    feedUrl: "https://www.noahpinion.blog/feed",
  },
  {
    name: "Slow Boring",
    url: "https://www.slowboring.com/",
    feedUrl: "https://www.slowboring.com/feed",
  },
  {
    name: "Dan Duggan (The Athletic)",
    url: "https://www.nytimes.com/athletic/author/dan-duggan/",
  },
  {
    name: "Ross Douthat (NYT)",
    url: "https://www.nytimes.com/column/ross-douthat",
  },
  {
    name: "Ezra Klein (NYT)",
    url: "https://www.nytimes.com/by/ezra-klein",
  },
  {
    name: "David French (NYT)",
    url: "https://www.nytimes.com/by/david-french",
  },
  {
    name: "Stratechery",
    url: "https://stratechery.com/",
    feedUrl: "https://stratechery.com/feed",
  },
  {
    name: "Money Stuff (Bloomberg)",
    url: "https://www.bloomberg.com/account/newsletters/money-stuff",
  },
];

let cache = {
  data: null,
  fetchedAt: 0,
};

app.use(express.static("public"));

app.get("/api/sources", (_req, res) => {
  res.json({
    sources: SOURCES.map((source) => ({
      name: source.name,
      url: source.url,
    })),
  });
});

app.get("/api/feed", async (req, res) => {
  const forceRefresh = req.query.force === "1";
  const limit = Number.parseInt(req.query.limit, 10) || 180;
  const now = Date.now();

  if (!forceRefresh && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return res.json({
      ...cache.data,
      cached: true,
      cacheAgeSeconds: Math.floor((now - cache.fetchedAt) / 1000),
      ttlSeconds: Math.floor(CACHE_TTL_MS / 1000),
      generatedAt: new Date(cache.fetchedAt).toISOString(),
      items: cache.data.items.slice(0, limit),
    });
  }

  try {
    const feed = await aggregateSources();
    cache = { data: feed, fetchedAt: Date.now() };

    return res.json({
      ...feed,
      cached: false,
      cacheAgeSeconds: 0,
      ttlSeconds: Math.floor(CACHE_TTL_MS / 1000),
      generatedAt: new Date(cache.fetchedAt).toISOString(),
      items: feed.items.slice(0, limit),
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to aggregate feed right now.",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`News feed running at http://localhost:${PORT}`);
});

async function aggregateSources() {
  const sourceResults = await Promise.all(SOURCES.map((source) => pullSource(source)));
  const allItems = sourceResults.flatMap((result) => result.items);
  const deduped = dedupeByUrl(allItems);

  deduped.sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });

  return {
    fetchedAt: new Date().toISOString(),
    sourceCount: SOURCES.length,
    itemCount: deduped.length,
    items: deduped,
    sources: sourceResults.map((result) => ({
      name: result.source.name,
      url: result.source.url,
      mode: result.mode,
      itemCount: result.items.length,
      feedUrl: result.feedUrl || null,
      error: result.error || null,
    })),
  };
}

async function pullSource(source) {
  let sourceHtml = null;
  const candidates = new Set();

  if (source.feedUrl) {
    candidates.add(source.feedUrl);
  }

  try {
    sourceHtml = await fetchText(source.url);
    discoverFeedLinks(source.url, sourceHtml).forEach((link) => candidates.add(link));
  } catch {
    sourceHtml = null;
  }

  heuristicFeedLinks(source.url).forEach((link) => candidates.add(link));

  for (const candidate of candidates) {
    try {
      const parsed = await parser.parseURL(candidate);
      const normalized = (parsed.items || [])
        .map((item) => normalizeFeedItem(item, source))
        .filter(Boolean)
        .slice(0, 24);

      if (normalized.length) {
        return {
          source,
          mode: "rss",
          feedUrl: candidate,
          items: normalized,
        };
      }
    } catch {
      // Keep trying other candidates.
    }
  }

  try {
    const html = sourceHtml ?? (await fetchText(source.url));
    const scraped = scrapeItemsFromHtml(source, html).slice(0, 24);

    if (scraped.length) {
      return {
        source,
        mode: "scrape",
        items: scraped,
      };
    }
  } catch (error) {
    return {
      source,
      mode: "failed",
      items: [],
      error: error instanceof Error ? error.message : "Unknown scrape error",
    };
  }

  return {
    source,
    mode: "failed",
    items: [],
    error: "No parsable RSS feed or article links found.",
  };
}

function normalizeFeedItem(item, source) {
  const title = cleanText(item.title || "");
  const link = sanitizeUrl(item.link || item.guid || "", source.url);

  if (!title || !link) {
    return null;
  }

  const publishedAt = normalizeDate(item.isoDate || item.pubDate || item.published);
  const summary = cleanText(item.contentSnippet || item.summary || item.description || "");

  return {
    id: createItemId(link, source.name),
    title,
    url: link,
    source: source.name,
    sourceUrl: source.url,
    summary,
    publishedAt,
  };
}

function scrapeItemsFromHtml(source, html) {
  const $ = cheerio.load(html);
  const fromJsonLd = collectFromJsonLd($, source);
  const fromLinks = collectFromAnchors($, source);

  return dedupeByUrl([...fromJsonLd, ...fromLinks]).filter((item) => item.title && item.url);
}

function collectFromJsonLd($, source) {
  const collected = [];

  $("script[type='application/ld+json']").each((_idx, element) => {
    const raw = $(element).text().trim();
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const nodes = flattenJsonLd(parsed);

      nodes.forEach((node) => {
        const type = asArray(node["@type"]).join(",").toLowerCase();
        const headline = cleanText(node.headline || node.name || "");
        const url = sanitizeUrl(node.url || node.mainEntityOfPage || "", source.url);
        const publishedAt = normalizeDate(node.datePublished || node.dateCreated);

        if (!headline || !url) {
          return;
        }

        if (
          !type.includes("article") &&
          !type.includes("posting") &&
          !type.includes("news") &&
          !looksLikeArticleUrl(url)
        ) {
          return;
        }

        collected.push({
          id: createItemId(url, source.name),
          title: headline,
          url,
          source: source.name,
          sourceUrl: source.url,
          summary: cleanText(node.description || ""),
          publishedAt,
        });
      });
    } catch {
      // Skip invalid JSON-LD blocks.
    }
  });

  return collected;
}

function collectFromAnchors($, source) {
  const base = source.url;
  const baseHost = safeHostname(base);
  const results = [];

  $("a[href]").each((_idx, element) => {
    const href = $(element).attr("href") || "";
    const url = sanitizeUrl(href, base);
    const title = cleanText($(element).text());

    if (!url || !title || title.length < 12) {
      return;
    }

    const host = safeHostname(url);
    if (!host || !baseHost || !host.endsWith(baseHost.replace(/^www\./, ""))) {
      return;
    }

    if (!looksLikeArticleUrl(url)) {
      return;
    }

    results.push({
      id: createItemId(url, source.name),
      title,
      url,
      source: source.name,
      sourceUrl: source.url,
      summary: "",
      publishedAt: inferDateFromUrl(url),
    });
  });

  return results;
}

function flattenJsonLd(input) {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => flattenJsonLd(item));
  }

  const nodes = [input];

  if (Array.isArray(input["@graph"])) {
    nodes.push(...flattenJsonLd(input["@graph"]));
  }

  if (Array.isArray(input.itemListElement)) {
    nodes.push(
      ...input.itemListElement.flatMap((entry) => flattenJsonLd(entry.item || entry))
    );
  }

  return nodes;
}

function discoverFeedLinks(pageUrl, html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $(
    "link[rel='alternate'][type*='rss'], link[rel='alternate'][type*='atom'], a[href*='feed'], a[href*='rss'], a[href*='atom']"
  ).each((_idx, element) => {
    const raw = $(element).attr("href");
    const resolved = sanitizeUrl(raw || "", pageUrl);

    if (resolved) {
      links.add(resolved);
    }
  });

  return [...links];
}

function heuristicFeedLinks(pageUrl) {
  const url = new URL(pageUrl);
  const root = `${url.protocol}//${url.host}`;
  const pathname = url.pathname.replace(/\/$/, "");

  const guesses = [
    `${root}/feed`,
    `${root}/feed/`,
    `${root}/rss`,
    `${root}/rss.xml`,
    `${root}/feed.xml`,
    `${root}/atom.xml`,
  ];

  if (pathname) {
    guesses.push(`${root}${pathname}/feed`);
    guesses.push(`${root}${pathname}/rss`);
  }

  return guesses;
}

function dedupeByUrl(items) {
  const seen = new Map();

  for (const item of items) {
    const key = canonicalizeUrl(item.url);
    if (!key) {
      continue;
    }

    if (!seen.has(key)) {
      seen.set(key, { ...item, url: key });
      continue;
    }

    const current = seen.get(key);
    const currentDate = current.publishedAt ? Date.parse(current.publishedAt) : 0;
    const candidateDate = item.publishedAt ? Date.parse(item.publishedAt) : 0;

    if (candidateDate > currentDate) {
      seen.set(key, { ...item, url: key });
    }
  }

  return [...seen.values()];
}

async function fetchText(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeArticleUrl(url) {
  if (!url) {
    return false;
  }

  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i.test(url)) {
    return false;
  }

  const denyList = ["/about", "/contact", "/privacy", "/terms", "/login", "/signup"];
  if (denyList.some((segment) => url.toLowerCase().includes(segment))) {
    return false;
  }

  return (
    /\/\d{4}\/\d{2}\/\d{2}\//.test(url) ||
    /\/article\//.test(url) ||
    /\/p\//.test(url) ||
    /\/athletic\//.test(url) ||
    /\/by\//.test(url) ||
    /\/column\//.test(url)
  );
}

function inferDateFromUrl(url) {
  const match = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!match) {
    return null;
  }

  const iso = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function sanitizeUrl(value, baseUrl = "") {
  try {
    if (!value) {
      return null;
    }

    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function canonicalizeUrl(value) {
  try {
    if (!value) {
      return null;
    }

    const url = new URL(value);
    const blockedParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
    blockedParams.forEach((param) => url.searchParams.delete(param));

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function asArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function createItemId(url, sourceName) {
  return `${sourceName}:${url}`;
}
