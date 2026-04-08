import express from "express";
import * as cheerio from "cheerio";
import Parser from "rss-parser";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const ARTICLE_CACHE_TTL_MS = 30 * 60 * 1000;
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
const articleCache = new Map();

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

app.get("/api/article", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const sourceName = typeof req.query.source === "string" ? req.query.source.trim() : "";
  const fallbackTitle = typeof req.query.title === "string" ? cleanText(req.query.title) : "";
  const fallbackSummary = typeof req.query.summary === "string" ? cleanText(req.query.summary) : "";

  const url = sanitizeUrl(rawUrl);
  if (!url) {
    return res.status(400).json({ error: "Missing or invalid article URL." });
  }

  const access = inferAccessLevel(sourceName, url);
  const cacheKey = canonicalizeUrl(url);
  const cached = cacheKey ? articleCache.get(cacheKey) : null;
  const now = Date.now();

  if (cached && now - cached.fetchedAt < ARTICLE_CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  if (access === "paywalled") {
    const payload = buildExcerptPayload({
      url,
      sourceName,
      title: fallbackTitle,
      summary: fallbackSummary,
      reason: "This source is typically paywalled.",
      paywalled: true,
    });

    if (cacheKey) {
      articleCache.set(cacheKey, { payload, fetchedAt: now });
    }

    return res.json({ ...payload, cached: false });
  }

  try {
    const html = await fetchText(url, 15_000);
    const extracted = extractArticleFromHtml({ html, url, sourceName });

    const tooThinForReader =
      extracted.wordCount < 70 && extracted.imageCount === 0 && extracted.linkCount < 2;
    if (extracted.isLikelyPaywalled || tooThinForReader) {
      const payload = buildExcerptPayload({
        url,
        sourceName,
        title: extracted.title || fallbackTitle,
        summary: fallbackSummary || extracted.subtitle || "",
        reason: extracted.isLikelyPaywalled
          ? "This article appears to be behind a paywall."
          : "Full text is unavailable in-app for this article.",
        paywalled: extracted.isLikelyPaywalled,
      });

      if (cacheKey) {
        articleCache.set(cacheKey, { payload, fetchedAt: now });
      }

      return res.json({ ...payload, cached: false });
    }

    const payload = {
      mode: "full",
      paywalled: false,
      access: "open",
      url,
      source: sourceName,
      title: extracted.title || fallbackTitle || "Article",
      subtitle: extracted.subtitle || null,
      byline: extracted.byline || null,
      publishedAt: extracted.publishedAt || null,
      contentHtml: extracted.contentHtml,
      wordCount: extracted.wordCount,
      imageCount: extracted.imageCount,
      linkCount: extracted.linkCount,
    };

    if (cacheKey) {
      articleCache.set(cacheKey, { payload, fetchedAt: now });
    }

    return res.json({ ...payload, cached: false });
  } catch (error) {
    const payload = buildExcerptPayload({
      url,
      sourceName,
      title: fallbackTitle,
      summary: fallbackSummary,
      reason:
        error instanceof Error ? `Unable to fetch full text: ${error.message}` : "Unable to fetch full text.",
      paywalled: false,
    });

    return res.json({ ...payload, cached: false });
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
    access: inferAccessLevel(source.name, link),
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
          access: inferAccessLevel(source.name, url),
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
      access: inferAccessLevel(source.name, url),
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

    if (baseUrl) {
      return new URL(value, baseUrl).toString();
    }

    return new URL(value).toString();
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

function inferAccessLevel(sourceName, url) {
  const source = (sourceName || "").toLowerCase();
  const host = (safeHostname(url) || "").toLowerCase();

  if (
    source.includes("nyt") ||
    source.includes("athletic") ||
    source.includes("bloomberg") ||
    source.includes("stratechery") ||
    host.includes("nytimes.com") ||
    host.includes("theathletic.com") ||
    host.includes("bloomberg.com") ||
    host.includes("stratechery.com")
  ) {
    return "paywalled";
  }

  return "open";
}

function buildExcerptPayload({ url, sourceName, title, summary, reason, paywalled }) {
  return {
    mode: "excerpt",
    paywalled: Boolean(paywalled),
    access: paywalled ? "paywalled" : "open",
    url,
    source: sourceName,
    title: title || "Article",
    excerpt:
      summary ||
      "This article is best read on the original site. Open the original link to continue reading.",
    reason,
  };
}

function extractArticleFromHtml({ html, url, sourceName }) {
  const $ = cheerio.load(html);
  const jsonLd = extractArticleJsonLd($);

  const ogTitle = cleanText($("meta[property='og:title']").attr("content") || "");
  const docTitle = cleanText($("title").first().text() || "");
  const title = cleanText(jsonLd.headline || jsonLd.name || ogTitle || docTitle);
  const subtitle = extractSubtitle($, jsonLd, title);
  const byline = extractByline($, jsonLd);
  const publishedAt = normalizeDate(
    jsonLd.datePublished ||
      $("meta[property='article:published_time']").attr("content") ||
      $("meta[name='parsely-pub-date']").attr("content")
  );

  const paywallSignal = detectPaywallSignals($, html);
  const bestContainer = findBestArticleContainer($, { url, sourceName });
  let content = collectContentBlocks($, bestContainer, url);
  if (subtitle) {
    content = stripDuplicativeLeadHeading(content, subtitle);
  }

  if (!content.contentHtml) {
    const fallbackJsonLdBody = cleanText(jsonLd.articleBody || "");
    if (fallbackJsonLdBody.length > 100) {
      const paragraphs = dedupeParagraphs(splitIntoParagraphs(fallbackJsonLdBody, 25)).slice(0, 180);
      const fallbackHtml = paragraphsToHtml(paragraphs);
      content = {
        contentHtml: fallbackHtml,
        wordCount: countWords(fallbackJsonLdBody),
        imageCount: 0,
        linkCount: 0,
      };
    }
  }

  const isLikelyPaywalled =
    paywallSignal &&
    content.wordCount < 450 &&
    content.imageCount < 1 &&
    inferAccessLevel(sourceName, url) !== "open";

  return {
    title,
    subtitle,
    byline,
    publishedAt,
    contentHtml: content.contentHtml,
    wordCount: content.wordCount,
    imageCount: content.imageCount,
    linkCount: content.linkCount,
    isLikelyPaywalled,
  };
}

function extractSubtitle($, jsonLd, title) {
  const candidates = [
    cleanText($("meta[property='og:description']").attr("content") || ""),
    cleanText($("meta[name='description']").attr("content") || ""),
    cleanText(jsonLd.description || ""),
    cleanText($(".subtitle").first().text() || ""),
    cleanText($("h2.subtitle, h3.subtitle, .post-subtitle, .article-subtitle, .deck").first().text() || ""),
  ];

  const normalizedTitle = (title || "").toLowerCase();
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate.length < 20 || candidate.length > 260) {
      continue;
    }

    if (candidate.toLowerCase() === normalizedTitle) {
      continue;
    }

    return candidate;
  }

  return null;
}

function extractArticleJsonLd($) {
  let best = {};

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
        if (!type.includes("article") && !type.includes("posting") && !type.includes("news")) {
          return;
        }

        const candidateScore =
          cleanText(node.articleBody || "").length +
          cleanText(node.headline || node.name || "").length * 4 +
          cleanText(node.description || "").length * 2;
        const bestScore =
          cleanText(best.articleBody || "").length +
          cleanText(best.headline || best.name || "").length * 4 +
          cleanText(best.description || "").length * 2;

        if (candidateScore > bestScore) {
          best = node;
        }
      });
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  return best;
}

function findBestArticleContainer($, { url, sourceName }) {
  const host = (safeHostname(url) || "").toLowerCase();
  const source = (sourceName || "").toLowerCase();

  const preferred = [];
  if (host.includes("substack.com") || host.includes("worksinprogress.news") || source.includes("substack")) {
    preferred.push(
      ".available-content .body.markup",
      ".body.markup",
      ".post.typography .body",
      ".post-content",
      "article"
    );
  }

  if (host.includes("marginalrevolution.com")) {
    preferred.push(".entry-content", ".entry", ".post", "article");
  }

  const generic = [
    "article",
    "main article",
    "[itemprop='articleBody']",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".single-post-content",
    ".post-body",
    ".content-body",
    ".body-copy",
    ".post",
  ];
  const selectors = [...preferred, ...generic];

  let best = null;
  let bestScore = 0;

  selectors.forEach((selector) => {
    $(selector)
      .slice(0, 14)
      .each((_idx, element) => {
        const node = $(element);
        const score = scoreContainer(node);

        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      });
  });

  if (!best || !best.length) {
    best = $("article").first();
  }

  if (!best || !best.length) {
    best = $("main").first();
  }

  if (!best || !best.length) {
    best = $("body");
  }

  return best;
}

function scoreContainer(node) {
  const textLength = cleanText(node.text()).length;
  const paragraphCount = node.find("p").length;
  const listItemCount = node.find("li").length;
  const imageCount = node.find("img").length;
  const linkCount = node.find("a[href]").length;
  const headingCount = node.find("h2,h3,h4").length;
  const penalty = node.find("nav,footer,header,aside,form,.share,.social,.newsletter,.related,.comments")
    .length;

  return (
    textLength +
    paragraphCount * 180 +
    listItemCount * 180 +
    imageCount * 260 +
    linkCount * 12 +
    headingCount * 120 -
    penalty * 420
  );
}

function collectContentBlocks($, container, baseUrl) {
  if (!container || !container.length) {
    return {
      contentHtml: "",
      wordCount: 0,
      imageCount: 0,
      linkCount: 0,
    };
  }

  const blocks = [];
  container
    .find("h2,h3,h4,p,ul,ol,figure,blockquote,pre,hr")
    .slice(0, 900)
    .each((_idx, element) => {
      if (!shouldKeepContentBlock($, element)) {
        return;
      }

      const html = sanitizeContentBlock($, element, baseUrl);
      if (html) {
        blocks.push(html);
      }
    });

  const dedupedBlocks = dedupeHtmlBlocks(blocks);
  const contentHtml = dedupedBlocks.join("\n");

  if (!contentHtml) {
    return {
      contentHtml: "",
      wordCount: 0,
      imageCount: 0,
      linkCount: 0,
    };
  }

  const $preview = cheerio.load(`<div id="reader-content">${contentHtml}</div>`);
  const $root = $preview("#reader-content");

  return {
    contentHtml: $root.html() || "",
    wordCount: countWords(cleanText($root.text())),
    imageCount: $root.find("img").length,
    linkCount: $root.find("a[href]").length,
  };
}

function shouldKeepContentBlock($, element) {
  const node = $(element);
  const marker = `${node.attr("class") || ""} ${node.attr("id") || ""}`.toLowerCase();
  if (/(footnote|fnref|share|social|newsletter|related|comment|popup|cookie|paywall)/.test(marker)) {
    return false;
  }

  if (
    node.closest(
      "nav,footer,header,aside,.share,.social,.newsletter-signup,.related-posts,.comments,.post-meta,.entry-footer"
    ).length
  ) {
    return false;
  }

  const tag = (element.tagName || "").toLowerCase();
  if (!tag) {
    return false;
  }

  const text = cleanText(node.text());
  const hasLinks = node.find("a[href]").length > 0;
  const hasImages = node.find("img").length > 0;

  if (tag === "p" && text.length < 18 && !hasLinks && !hasImages) {
    return false;
  }

  if ((tag === "ul" || tag === "ol") && node.find("li").length === 0) {
    return false;
  }

  if (tag === "figure" && !hasImages && text.length < 20) {
    return false;
  }

  if (tag === "blockquote" && text.length < 24) {
    return false;
  }

  return true;
}

function sanitizeContentBlock($, element, baseUrl) {
  const allowedTags = new Set([
    "p",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "em",
    "strong",
    "a",
    "img",
    "figure",
    "figcaption",
    "h2",
    "h3",
    "h4",
    "hr",
    "br",
    "sup",
    "sub",
    "span",
  ]);

  const block = $(element).clone();
  block.find("script,style,noscript,iframe,form,button,input,textarea,select,svg,canvas").remove();
  block.find("[aria-hidden='true']").remove();

  const nodes = [block.get(0), ...block.find("*").toArray()];
  nodes.forEach((node) => {
    if (!node || node.type !== "tag") {
      return;
    }

    const $node = $(node);
    const tag = (node.tagName || "").toLowerCase();
    if (!tag) {
      return;
    }

    if (isDisallowedWithinReaderNode($node)) {
      $node.remove();
      return;
    }

    if (!allowedTags.has(tag)) {
      $node.replaceWith($node.contents());
      return;
    }

    const attrs = { ...(node.attribs || {}) };
    Object.keys(attrs).forEach((attr) => $node.removeAttr(attr));

    if (tag === "a") {
      normalizeLinkElement($node, attrs, baseUrl);
      return;
    }

    if (tag === "img") {
      normalizeImageElement($node, attrs, baseUrl);
      return;
    }
  });

  block.find("*").each((_idx, node) => {
    const $node = $(node);
    const tag = (node.tagName || "").toLowerCase();
    if (!tag) {
      return;
    }

    if (["p", "li", "span", "figcaption", "blockquote"].includes(tag)) {
      const text = cleanText($node.text());
      const hasImage = $node.find("img").length > 0;
      if (!text && !hasImage) {
        $node.remove();
      }
    }
  });

  const html = $.html(block).trim();
  if (!html || html === "<p></p>") {
    return "";
  }

  return html;
}

function isDisallowedWithinReaderNode(node) {
  const marker = `${node.attr("class") || ""} ${node.attr("id") || ""}`.toLowerCase();
  return /(share|social|signup|newsletter|related|comment|cookie|advert|promo|paywall|footer|nav|toolbar|footnote|fnref|popup)/.test(
    marker
  );
}

function normalizeLinkElement(node, attrs, baseUrl) {
  const href = sanitizeUrl(attrs.href || "", baseUrl);
  if (!href || href.toLowerCase().startsWith("javascript:")) {
    node.replaceWith(node.contents());
    return;
  }

  node.attr("href", href);
  node.attr("target", "_blank");
  node.attr("rel", "noopener noreferrer");
}

function normalizeImageElement(node, attrs, baseUrl) {
  const srcCandidate =
    attrs.src ||
    attrs["data-src"] ||
    attrs["data-image-src"] ||
    attrs["data-original-src"] ||
    attrs["data-lazy-src"] ||
    extractFirstUrlFromSrcset(attrs.srcset || attrs["data-srcset"] || "");
  const src = sanitizeUrl(srcCandidate || "", baseUrl);

  if (!src) {
    node.remove();
    return;
  }

  node.attr("src", src);

  const alt = cleanText(attrs.alt || attrs.title || "");
  if (alt) {
    node.attr("alt", alt);
  }

  node.attr("loading", "lazy");
  node.attr("decoding", "async");
}

function extractFirstUrlFromSrcset(srcset) {
  if (!srcset) {
    return "";
  }

  const first = srcset.trim().split(/\s+/)[0];
  if (!first) {
    return "";
  }

  return first.replace(/,+$/, "");
}

function stripDuplicativeLeadHeading(content, subtitle) {
  if (!content?.contentHtml || !subtitle) {
    return content;
  }

  const normalizedSubtitle = cleanText(subtitle).toLowerCase();
  if (!normalizedSubtitle) {
    return content;
  }

  const $preview = cheerio.load(`<div id="reader-content">${content.contentHtml}</div>`);
  const $root = $preview("#reader-content");
  const first = $root.children().first();
  const tag = (first.get(0)?.tagName || "").toLowerCase();

  if (!first.length || !["h1", "h2", "h3", "h4", "p"].includes(tag)) {
    return content;
  }

  if (cleanText(first.text() || "").toLowerCase() !== normalizedSubtitle) {
    return content;
  }

  first.remove();

  return {
    contentHtml: $root.html() || "",
    wordCount: countWords(cleanText($root.text())),
    imageCount: $root.find("img").length,
    linkCount: $root.find("a[href]").length,
  };
}

function splitIntoParagraphs(text, minLength = 45) {
  return text
    .split(/\n{1,}|\r{1,}/g)
    .map((part) => cleanText(part))
    .filter((part) => part.length > minLength);
}

function dedupeParagraphs(paragraphs) {
  const seen = new Set();
  const output = [];

  paragraphs.forEach((paragraph) => {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push(paragraph);
  });

  return output;
}

function dedupeHtmlBlocks(blocks) {
  const seen = new Set();
  const output = [];

  blocks.forEach((block) => {
    const key = cleanText(block).toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push(block);
  });

  return output;
}

function detectPaywallSignals($, html) {
  const pageText = cleanText($("body").text() || html || "").toLowerCase();
  const paywallPatterns = [
    "subscribe to continue",
    "subscriber-only",
    "this content is for subscribers",
    "already a subscriber",
    "log in to continue",
    "full access",
    "start your subscription",
    "metered",
    "sign in to read",
    "this post is for subscribers",
    "unlock this post",
    "to continue reading this post",
  ];

  return paywallPatterns.some((pattern) => pageText.includes(pattern));
}

function extractByline($, jsonLd) {
  const fromJsonLd = extractAuthorFromJsonLd(jsonLd);
  if (fromJsonLd) {
    return fromJsonLd;
  }

  const bylineSelectors = [
    "meta[name='author']",
    "meta[property='article:author']",
    "[rel='author']",
    ".author-name",
    ".byline",
    "[itemprop='author']",
  ];

  for (const selector of bylineSelectors) {
    const node = $(selector).first();
    const content = cleanText(node.attr("content") || node.text() || "");
    if (content) {
      return content;
    }
  }

  return null;
}

function extractAuthorFromJsonLd(jsonLd) {
  if (!jsonLd || !jsonLd.author) {
    return null;
  }

  if (typeof jsonLd.author === "string") {
    return cleanText(jsonLd.author);
  }

  if (Array.isArray(jsonLd.author)) {
    const names = jsonLd.author
      .map((author) => {
        if (typeof author === "string") {
          return cleanText(author);
        }
        return cleanText(author?.name || "");
      })
      .filter(Boolean);
    return names.length ? names.join(", ") : null;
  }

  return cleanText(jsonLd.author.name || "");
}

function paragraphsToHtml(paragraphs) {
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function countWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
