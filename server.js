import express from "express";
import * as cheerio from "cheerio";
import Parser from "rss-parser";

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const ARTICLE_CACHE_TTL_MS = 30 * 60 * 1000;
const SOURCE_FETCH_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SOURCE_FETCH_CONCURRENCY || "6", 10) || 6);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SUBSTACK_PROXY_FALLBACK_ENABLED = process.env.SUBSTACK_PROXY_FALLBACK_ENABLED !== "0";
const RSS_PROXY_TEMPLATE = (process.env.RSS_PROXY_TEMPLATE || "").trim();
const RSS2JSON_API_KEY = (process.env.RSS2JSON_API_KEY || "").trim();
const DEFAULT_RSS_PROXY_BASE_URL = "https://api.rss2json.com/v1/api.json";

const parser = new Parser({
  timeout: 15_000,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8",
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
    feedUrl: "https://tylercowensethnicdiningguide.com/index.php/feed/",
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
    feedUrl: "https://www.nytimes.com/athletic/rss/author/dan-duggan/",
  },
  {
    name: "Ross Douthat (NYT)",
    url: "https://www.nytimes.com/column/ross-douthat",
    feedUrl: "https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/column/ross-douthat/rss.xml",
  },
  {
    name: "Ezra Klein (NYT)",
    url: "https://www.nytimes.com/by/ezra-klein",
    feedUrl: "https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/column/ezra-klein/rss.xml",
  },
  {
    name: "David French (NYT)",
    url: "https://www.nytimes.com/by/david-french",
    feedUrl: "https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/column/david-french/rss.xml",
  },
  {
    name: "Stratechery",
    url: "https://stratechery.com/",
    feedUrl: "https://stratechery.com/feed",
  },
  {
    name: "Money Stuff (Bloomberg)",
    url: "https://www.bloomberg.com/account/newsletters/money-stuff",
    feedUrl: "https://kill-the-newsletter.com/feeds/gny0ji85cmjhbsuwjspj.xml",
  },
  {
    name: "Brew Shop",
    url: "https://www.arlbrew.com/",
    feedUrl: "https://kill-the-newsletter.com/feeds/qj2dfk4wwkor5zxttuy5.xml",
  },
  {
    name: "Can't Get Much Higher",
    url: "https://www.cantgetmuchhigher.com/",
    feedUrl: "https://www.cantgetmuchhigher.com/feed",
  },
  {
    name: "Josh Barro",
    url: "https://www.joshbarro.com/",
    feedUrl: "https://www.joshbarro.com/feed",
  },
];

const SOURCE_ITEM_RULES = Object.freeze({
  "Astral Codex Ten": Object.freeze({
    excludeTitleIncludes: Object.freeze(["open thread"]),
  }),
  "Neil Paine": Object.freeze({
    excludeDescriptionIncludes: Object.freeze(["Subscribe to Scoreboard"]),
    excludeTitleIfContainsEmoji: true,
  }),
  "Slow Boring": Object.freeze({
    excludeTitleIncludes: Object.freeze(["discussion post"]),
  }),
  "Money Stuff (Bloomberg)": Object.freeze({
    excludeTitleIncludes: Object.freeze([
      "you've subscribed",
      "verify your email",
      "to verify your email for bloomberg.com",
      "money stuff: the podcast",
    ]),
    excludeDescriptionIncludes: Object.freeze([
      "thank you for subscribing to money stuff",
      "your code is:",
    ]),
  }),
});

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
  const fallbackSummary =
    typeof req.query.summary === "string" ? cleanFeedSummary(req.query.summary, sourceName) : "";

  const url = sanitizeUrl(rawUrl);
  if (!url) {
    return res.status(400).json({ error: "Missing or invalid article URL." });
  }

  try {
    const payload = await buildArticlePayload({
      url,
      sourceName,
      fallbackTitle,
      fallbackSummary,
    });

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: "Unable to build article payload.",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

if (process.env.NEWS_FEED_DISABLE_SERVER !== "1") {
  app.listen(PORT, () => {
    console.log(`News feed running at http://localhost:${PORT}`);
  });
}

async function buildArticlePayload({
  url,
  sourceName = "",
  fallbackTitle = "",
  fallbackSummary = "",
  fallbackContentHtml = "",
}) {
  const access = inferAccessLevel(sourceName, url);
  const cacheKey = canonicalizeUrl(url);
  const cached = cacheKey ? articleCache.get(cacheKey) : null;
  const now = Date.now();
  const feedFallbackPayload = buildFullPayloadFromFeedFallback({
    url,
    sourceName,
    fallbackTitle,
    fallbackSummary,
    fallbackContentHtml,
  });

  if (cached && now - cached.fetchedAt < ARTICLE_CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }

  if (access === "paywalled") {
    if (feedFallbackPayload) {
      const payload = {
        ...feedFallbackPayload,
        access: "paywalled",
        paywalled: true,
        subtitle: null,
      };

      if (cacheKey) {
        articleCache.set(cacheKey, { payload, fetchedAt: now });
      }

      return { ...payload, cached: false };
    }

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

    return { ...payload, cached: false };
  }

  try {
    const html = await fetchText(url, 15_000);
    const extracted = extractArticleFromHtml({ html, url, sourceName });

    const tooThinForReader =
      extracted.wordCount < 70 && extracted.imageCount === 0 && extracted.linkCount < 2;
    if (extracted.isLikelyPaywalled || tooThinForReader) {
      if (!extracted.isLikelyPaywalled && feedFallbackPayload) {
        if (cacheKey) {
          articleCache.set(cacheKey, { payload: feedFallbackPayload, fetchedAt: now });
        }
        return { ...feedFallbackPayload, cached: false };
      }

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

      return { ...payload, cached: false };
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

    return { ...payload, cached: false };
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

    if (feedFallbackPayload) {
      if (cacheKey) {
        articleCache.set(cacheKey, { payload: feedFallbackPayload, fetchedAt: now });
      }
      return { ...feedFallbackPayload, cached: false };
    }

    return { ...payload, cached: false };
  }
}

async function aggregateSources() {
  const sourceResults = await mapWithConcurrency(SOURCES, SOURCE_FETCH_CONCURRENCY, async (source) => {
    try {
      return await pullSource(source);
    } catch (error) {
      return {
        source,
        mode: "failed",
        items: [],
        error: error instanceof Error ? error.message : "Unknown source error",
      };
    }
  });
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
  if (!source.feedUrl) {
    return {
      source,
      mode: "failed",
      items: [],
      error: "Missing explicit feedUrl for source.",
    };
  }

  try {
    const parsed = await withRetry(() => parser.parseURL(source.feedUrl), { attempts: 3, baseDelayMs: 450 });
    const normalizedBase = (parsed.items || [])
      .map((item) => normalizeFeedItem(item, source))
      .filter(Boolean);
    const normalized = applySourceItemRules(source, normalizedBase);

    if (!normalized.length) {
      if (normalizedBase.length) {
        return {
          source,
          mode: "rss",
          feedUrl: source.feedUrl,
          items: [],
        };
      }

      const proxyResult = await pullSourceViaRssProxy(source);
      if (proxyResult) {
        return proxyResult;
      }

      return {
        source,
        mode: "failed",
        feedUrl: source.feedUrl,
        items: [],
        error: "Feed parsed but returned no valid items.",
      };
    }

    return {
      source,
      mode: "rss",
      feedUrl: source.feedUrl,
      items: normalized,
    };
  } catch (error) {
    const proxyResult = await pullSourceViaRssProxy(source);
    if (proxyResult) {
      return proxyResult;
    }

    return {
      source,
      mode: "failed",
      feedUrl: source.feedUrl,
      items: [],
      error: error instanceof Error ? error.message : "Unknown feed parse error",
    };
  }
}

async function pullSourceViaRssProxy(source) {
  if (!SUBSTACK_PROXY_FALLBACK_ENABLED || !isLikelySubstackSource(source) || !source.feedUrl) {
    return null;
  }

  const proxyUrl = buildRssProxyUrl(source.feedUrl);
  if (!proxyUrl) {
    return null;
  }

  try {
    const payload = await withRetry(() => fetchJson(proxyUrl, 12_000), { attempts: 2, baseDelayMs: 400 });
    const status = String(payload?.status || "").toLowerCase();
    if (status && status !== "ok") {
      return null;
    }

    const normalizedBase = asArray(payload?.items)
      .map((item) => normalizeProxyFeedItem(item, source))
      .filter(Boolean);
    const normalized = applySourceItemRules(source, normalizedBase);

    if (!normalized.length) {
      if (normalizedBase.length) {
        return {
          source,
          mode: "rss-proxy",
          feedUrl: source.feedUrl,
          items: [],
        };
      }

      return null;
    }

    return {
      source,
      mode: "rss-proxy",
      feedUrl: source.feedUrl,
      items: normalized,
    };
  } catch {
    return null;
  }
}

function normalizeFeedItem(item, source) {
  const title = cleanText(item.title || "");
  const link = sanitizeUrl(item.link || item.guid || "", source.url);

  if (!title || !link) {
    return null;
  }

  const publishedAt = normalizeDate(item.isoDate || item.pubDate || item.published);
  const summary = cleanFeedSummary(
    item.summary || item.description || item["content:encoded"] || item.content || item.contentSnippet || "",
    source
  );
  const feedContentHtml = pickFeedContentHtml(
    source.name,
    item["content:encoded"],
    item.content,
    item.description,
    item.summary,
    item.contentSnippet
  );

  return {
    id: createItemId(link, source.name),
    title,
    url: link,
    source: source.name,
    sourceUrl: source.url,
    access: inferAccessLevel(source.name, link),
    summary,
    publishedAt,
    feedContentHtml,
  };
}

function normalizeProxyFeedItem(item, source) {
  const title = cleanText(item?.title || "");
  const link = sanitizeUrl(item?.link || item?.url || item?.guid || "", source.url);

  if (!title || !link) {
    return null;
  }

  const publishedAt = normalizeDate(item?.pubDate || item?.published || item?.isoDate || item?.date);
  const summary = cleanFeedSummary(
    item?.description || item?.content || item?.summary || item?.contentSnippet || "",
    source
  );
  const feedContentHtml = pickFeedContentHtml(
    source.name,
    item?.content,
    item?.description,
    item?.summary,
    item?.contentSnippet
  );

  return {
    id: createItemId(link, source.name),
    title,
    url: link,
    source: source.name,
    sourceUrl: source.url,
    access: inferAccessLevel(source.name, link),
    summary,
    publishedAt,
    feedContentHtml,
  };
}

function applySourceItemRules(source, items) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }

  const sourceRules = SOURCE_ITEM_RULES[source?.name];
  if (!sourceRules) {
    return items;
  }

  return items.filter((item) => !shouldExcludeFeedItem(item, sourceRules));
}

function shouldExcludeFeedItem(item, sourceRules) {
  const title = cleanText(item?.title || "");
  const normalizedTitle = title.toLowerCase();
  const normalizedSummary = cleanText(item?.summary || "").toLowerCase();

  if (textIncludesAny(normalizedTitle, sourceRules?.excludeTitleIncludes)) {
    return true;
  }

  if (textIncludesAny(normalizedSummary, sourceRules?.excludeDescriptionIncludes)) {
    return true;
  }

  if (sourceRules?.excludeTitleIfContainsEmoji && containsEmoji(title)) {
    return true;
  }

  return false;
}

function textIncludesAny(text, rawFragments) {
  if (!text) {
    return false;
  }

  const fragments = asArray(rawFragments)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!fragments.length) {
    return false;
  }

  return fragments.some((fragment) => text.includes(fragment));
}

function containsEmoji(value) {
  if (!value) {
    return false;
  }

  return /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])/u.test(value);
}

function isLikelySubstackSource(source) {
  const sourceUrl = (source?.url || "").toLowerCase();
  const feedUrl = (source?.feedUrl || "").toLowerCase();
  return sourceUrl.includes("substack.com") || feedUrl.includes("substack.com");
}

function buildRssProxyUrl(feedUrl) {
  if (!feedUrl) {
    return null;
  }

  if (RSS_PROXY_TEMPLATE) {
    return RSS_PROXY_TEMPLATE.replace("{url}", encodeURIComponent(feedUrl));
  }

  const url = new URL(DEFAULT_RSS_PROXY_BASE_URL);
  url.searchParams.set("rss_url", feedUrl);
  if (RSS2JSON_API_KEY) {
    url.searchParams.set("api_key", RSS2JSON_API_KEY);
  }
  return url.toString();
}

function pickFeedContentHtml(sourceName, ...candidates) {
  const source = String(sourceName || "").toLowerCase();
  const analyzed = candidates
    .map((value) => analyzeFeedContentCandidate(value))
    .filter((candidate) => candidate.value);

  if (!analyzed.length) {
    return "";
  }

  analyzed.sort((a, b) => {
    // Always prefer real HTML markup over flattened/plain-text candidates.
    if (a.hasMarkup !== b.hasMarkup) {
      return b.hasMarkup - a.hasMarkup;
    }

    if (source.includes("money stuff")) {
      const scoreA = a.paragraphCount * 4 + a.wordCount / 80 + Math.min(a.imageCount || 0, 4) * 3;
      const scoreB = b.paragraphCount * 4 + b.wordCount / 80 + Math.min(b.imageCount || 0, 4) * 3;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      if ((a.imageCount || 0) !== (b.imageCount || 0)) {
        return (b.imageCount || 0) - (a.imageCount || 0);
      }

      if (a.wordCount !== b.wordCount) {
        return b.wordCount - a.wordCount;
      }
    }

    return b.value.length - a.value.length;
  });

  const best = analyzed[0];
  if (!best || best.value.length < 280) {
    return "";
  }

  return best.value;
}

function normalizeFeedContentCandidate(value) {
  if (typeof value !== "string") {
    return "";
  }

  const raw = value.trim();
  if (!raw) {
    return "";
  }

  const decoded = decodeBasicHtmlEntities(raw).trim();
  if (containsHtmlMarkup(decoded)) {
    return decoded;
  }

  return raw;
}

function decodeBasicHtmlEntities(value) {
  return value
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;|&#160;/gi, " ");
}

function containsHtmlMarkup(value) {
  return /<[a-z][\s\S]*>/i.test(value);
}

function analyzeFeedContentCandidate(value) {
  const normalized = normalizeFeedContentCandidate(value);
  if (!normalized) {
    return {
      value: "",
      hasMarkup: 0,
      wordCount: 0,
      paragraphCount: 0,
      imageCount: 0,
    };
  }

  const hasMarkup = containsHtmlMarkup(normalized) ? 1 : 0;
  if (!hasMarkup) {
    return {
      value: normalized,
      hasMarkup,
      wordCount: countWords(cleanText(normalized)),
      paragraphCount: 0,
      imageCount: 0,
    };
  }

  try {
    const $ = cheerio.load(`<article id="feed-content-analysis-root">${normalized}</article>`);
    const $root = $("#feed-content-analysis-root");
    $root.find("script,style,noscript").remove();
    const text = cleanText($root.text());
    const paragraphCount = $root.find("p,li,blockquote").length;
    const imageCount = $root.find("img").length;

    return {
      value: normalized,
      hasMarkup,
      wordCount: countWords(text),
      paragraphCount,
      imageCount,
    };
  } catch {
    return {
      value: normalized,
      hasMarkup,
      wordCount: countWords(cleanText(normalized)),
      paragraphCount: 0,
      imageCount: 0,
    };
  }
}

function buildFullPayloadFromFeedFallback({ url, sourceName, fallbackTitle, fallbackSummary, fallbackContentHtml }) {
  const rawHtml = typeof fallbackContentHtml === "string" ? fallbackContentHtml.trim() : "";
  if (!rawHtml) {
    return null;
  }

  const host = (safeHostname(url) || "").toLowerCase();
  const source = (sourceName || "").toLowerCase();
  const preferSubstackMedia =
    host.includes("substack.com") || host.includes("worksinprogress.news") || source.includes("substack");
  const isMoneyStuffNewsletter = source.includes("money stuff") && host.includes("kill-the-newsletter.com");
  const fallbackSubtitle = isMoneyStuffNewsletter ? null : fallbackSummary || null;

  let content = { contentHtml: "", wordCount: 0, imageCount: 0, linkCount: 0 };
  try {
    const $snippet = cheerio.load(`<article id="feed-fallback-root">${rawHtml}</article>`);
    const $root = $snippet("#feed-fallback-root");
    content = collectContentBlocks($snippet, $root, url, {
      preferSubstackMedia,
      preferEmailFormatting: isMoneyStuffNewsletter,
    });
  } catch {
    content = { contentHtml: "", wordCount: 0, imageCount: 0, linkCount: 0 };
  }

  if (!content.contentHtml || (!isMoneyStuffNewsletter && content.wordCount < 80)) {
    const plainText = cleanText(rawHtml);
    if (plainText.length < 140) {
      if (!content.contentHtml || content.wordCount < 35) {
        return null;
      }
      return {
        mode: "full",
        paywalled: false,
        access: "open",
        url,
        source: sourceName,
        title: fallbackTitle || "Article",
        subtitle: fallbackSubtitle,
        byline: inferFallbackByline(sourceName, rawHtml),
        publishedAt: null,
        contentHtml: content.contentHtml,
        wordCount: content.wordCount,
        imageCount: content.imageCount,
        linkCount: content.linkCount,
      };
    }

    const paragraphs = dedupeParagraphs(splitIntoParagraphs(plainText, 35)).slice(0, 240);
    if (!paragraphs.length) {
      if (!content.contentHtml || content.wordCount < 35) {
        return null;
      }
      return {
        mode: "full",
        paywalled: false,
        access: "open",
        url,
        source: sourceName,
        title: fallbackTitle || "Article",
        subtitle: fallbackSubtitle,
        byline: inferFallbackByline(sourceName, rawHtml),
        publishedAt: null,
        contentHtml: content.contentHtml,
        wordCount: content.wordCount,
        imageCount: content.imageCount,
        linkCount: content.linkCount,
      };
    }

    const plainTextContent = {
      contentHtml: paragraphsToHtml(paragraphs),
      wordCount: countWords(plainText),
      imageCount: 0,
      linkCount: 0,
    };

    if (!content.contentHtml || (!isMoneyStuffNewsletter && plainTextContent.wordCount >= content.wordCount + 120)) {
      content = plainTextContent;
    }
  }

  if (isMoneyStuffNewsletter && content.contentHtml) {
    const cleanedMoneyStuffHtml = cleanupMoneyStuffContentHtml(content.contentHtml, url);
    if (cleanedMoneyStuffHtml) {
      const $clean = cheerio.load(`<article id="money-stuff-clean-root">${cleanedMoneyStuffHtml}</article>`);
      const $cleanRoot = $clean("#money-stuff-clean-root");
      content = {
        contentHtml: $cleanRoot.html() || "",
        wordCount: countWords(cleanText($cleanRoot.text())),
        imageCount: $cleanRoot.find("img").length,
        linkCount: $cleanRoot.find("a[href]").length,
      };
    }
  }

  if (content.wordCount < 35) {
    return null;
  }

  const byline = inferFallbackByline(sourceName, rawHtml);

  return {
    mode: "full",
    paywalled: false,
    access: "open",
    url,
    source: sourceName,
    title: fallbackTitle || "Article",
    subtitle: fallbackSubtitle,
    byline,
    publishedAt: null,
    contentHtml: content.contentHtml,
    wordCount: content.wordCount,
    imageCount: content.imageCount,
    linkCount: content.linkCount,
  };
}

function inferFallbackByline(sourceName, rawHtml = "") {
  const source = (sourceName || "").toLowerCase();
  const text = cleanText(rawHtml);

  if (/matt\s+levine/i.test(text) || source.includes("money stuff")) {
    return "Matt Levine";
  }

  return null;
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

async function fetchText(url, timeoutMs = 12_000, options = {}) {
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
          options.accept ||
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

async function fetchJson(url, timeoutMs = 12_000) {
  const raw = await fetchText(url, timeoutMs, { accept: "application/json,text/plain;q=0.9,*/*;q=0.8" });
  return JSON.parse(raw);
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

  const normalized = value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  const stripped = normalized
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]*>/g, " ");

  return stripped.replace(/\s+/g, " ").trim();
}

function cleanFeedSummary(value, source = null) {
  const sourceName = (
    typeof source === "string" ? source : source?.name || source?.source || ""
  ).toLowerCase();
  let text = cleanText(value);
  if (!text) {
    return "";
  }

  const viewInBrowserMarker = "view in browser -->";
  const viewInBrowserIndex = text.toLowerCase().indexOf(viewInBrowserMarker);
  if (viewInBrowserIndex >= 0 && viewInBrowserIndex <= 2_400) {
    text = text.slice(viewInBrowserIndex + viewInBrowserMarker.length);
  }

  text = stripCssNoise(text);
  text = stripFeedBoilerplate(text);

  const maxLength = sourceName.includes("bloomberg") ? 2_800 : 1_800;
  return truncateAtWordBoundary(text, maxLength);
}

function stripCssNoise(value) {
  if (!value) {
    return "";
  }

  const cssRulePattern =
    /(?:^|\s)(?:@media[^{]{0,160}|[#.]?[a-z][a-z0-9:_-]*(?:\s+[#.]?[a-z][a-z0-9:_-]*)*)\s*\{[^{}]{1,900}\}/gi;
  const head = value.slice(0, 2_400).replace(cssRulePattern, " ");
  return `${head}${value.slice(2_400)}`.replace(/\s+/g, " ").trim();
}

function stripFeedBoilerplate(value) {
  if (!value) {
    return "";
  }

  let text = value;
  const tailPatterns = [
    /if you'd like to get [^.?!]*newsletter[^.?!]*\.[\s\S]*$/i,
    /like getting this newsletter\?[\s\S]*$/i,
    /you received this message because you are subscribed[\s\S]*$/i,
    /want to sponsor this newsletter\?[\s\S]*$/i,
    /kill the newsletter!\s*feed settings[\s\S]*$/i,
    /unsubscribe\s*\|[\s\S]*$/i,
  ];
  tailPatterns.forEach((pattern) => {
    text = text.replace(pattern, " ");
  });

  return text
    .replace(/\bfollow us\b/gi, " ")
    .replace(/\bget the newsletter\b/gi, " ")
    .replace(/\bfeed settings\b/gi, " ")
    .replace(/view in browser\s*-->/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWordBoundary(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }

  const clip = value.slice(0, maxLength);
  const lastSpace = clip.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.65)) {
    return `${clip.slice(0, lastSpace).trim()}...`;
  }

  return `${clip.trim()}...`;
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
  const isMoneyStuffNewsletter =
    source.includes("money stuff") &&
    (host.includes("kill-the-newsletter.com") || host.includes("bloomberg.com"));

  if (isMoneyStuffNewsletter) {
    return "open";
  }

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
  const excerpt = cleanFeedSummary(summary || "", sourceName);
  return {
    mode: "excerpt",
    paywalled: Boolean(paywalled),
    access: paywalled ? "paywalled" : "open",
    url,
    source: sourceName,
    title: title || "Article",
    excerpt:
      excerpt ||
      "This article is best read on the original site. Open the original link to continue reading.",
    reason,
  };
}

function extractArticleFromHtml({ html, url, sourceName }) {
  const $ = cheerio.load(html);
  const jsonLd = extractArticleJsonLd($);
  const host = (safeHostname(url) || "").toLowerCase();
  const source = (sourceName || "").toLowerCase();
  const isSubstackStyle =
    host.includes("substack.com") || host.includes("worksinprogress.news") || source.includes("substack");

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
  let content = collectContentBlocks($, bestContainer, url, { preferSubstackMedia: isSubstackStyle });
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
  const preferredResult = selectBestContainerFromSelectors($, preferred);
  const preferredParagraphs = preferredResult.best?.find("p").length || 0;
  const preferredImages = preferredResult.best?.find("img").length || 0;
  if (
    preferredResult.best &&
    preferredResult.best.length &&
    (preferredResult.score > 2200 || preferredParagraphs >= 6 || preferredImages >= 2)
  ) {
    return preferredResult.best;
  }

  const genericResult = selectBestContainerFromSelectors($, generic);
  let best = genericResult.best;

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

function selectBestContainerFromSelectors($, selectors) {
  let best = null;
  let score = 0;

  selectors.forEach((selector) => {
    $(selector)
      .slice(0, 14)
      .each((_idx, element) => {
        const node = $(element);
        const candidateScore = scoreContainer(node);
        if (candidateScore > score) {
          best = node;
          score = candidateScore;
        }
      });
  });

  return { best, score };
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

function collectContentBlocks($, container, baseUrl, options = {}) {
  if (!container || !container.length) {
    return {
      contentHtml: "",
      wordCount: 0,
      imageCount: 0,
      linkCount: 0,
    };
  }

  const defaultTags = options.preferSubstackMedia
    ? [
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "ul",
        "ol",
        "table",
        "figure",
        "div[data-component-name='DatawrapperToDOM']",
        "div[class*='imageRow']",
        "img",
        "blockquote",
        "pre",
        "hr",
      ]
    : [
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "ul",
        "ol",
        "table",
        "figure",
        "div[data-component-name='DatawrapperToDOM']",
        "img",
        "blockquote",
        "pre",
        "hr",
      ];
  const emailTags = [
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "ul",
    "ol",
    "table",
    "figure",
    "img",
    "blockquote",
    "pre",
    "hr",
  ];
  const blockTags = options.preferEmailFormatting ? emailTags : defaultTags;
  const blockSelector = blockTags.join(",");
  const ancestorSelector = (options.preferEmailFormatting
    ? blockTags.filter((tag) => tag !== "table")
    : blockTags
  ).join(",");

  const blocks = [];
  const rootNode = container.get(0);
  container
    .find(blockSelector)
    .slice(0, 900)
    .each((_idx, element) => {
      if (hasMatchingContentAncestor($, element, rootNode, ancestorSelector)) {
        return;
      }

      if (!shouldKeepContentBlock($, element, options)) {
        return;
      }

      const html = sanitizeContentBlock($, element, baseUrl);
      if (html) {
        blocks.push(html);
      }
    });

  const dedupedBlocks = dedupeHtmlBlocks(blocks);
  const contentHtml = stripPlaceholderNodes(repairInPageFootnoteTargets(dedupedBlocks.join("\n")));

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

function hasMatchingContentAncestor($, element, rootNode, selector) {
  if (!element || !rootNode) {
    return false;
  }

  let cursor = $(element).parent();
  while (cursor.length) {
    const node = cursor.get(0);
    if (!node || node === rootNode) {
      return false;
    }

    if (cursor.is(selector)) {
      return true;
    }

    cursor = cursor.parent();
  }

  return false;
}

function shouldKeepContentBlock($, element, options = {}) {
  const node = $(element);
  const marker = `${node.attr("class") || ""} ${node.attr("id") || ""}`.toLowerCase();
  const componentName = (node.attr("data-component-name") || "").toLowerCase();
  if (/(share|social|newsletter|related|comment|popup|cookie|paywall)/.test(marker)) {
    return false;
  }

  if (
    node.closest(
      ".post-header,.byline-wrapper,.post-ufi,.author,.author-wrap,[data-testid='navbar'],.main-menu,.topBar-pIF0J1,.logoContainer-p12gJb"
    ).length
  ) {
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
  const hasImages = tag === "img" || node.find("img").length > 0;

  if (tag === "div") {
    if (componentName === "datawrappertodom") {
      return true;
    }

    return options.preferSubstackMedia && isSubstackImageRowMarker(marker) && node.find("img").length >= 2;
  }

  if (tag === "img") {
    if (/(avatar|profile|author|byline|logo|icon|emoji|favicon)/.test(marker)) {
      return false;
    }

    if (node.closest("figure").length) {
      return false;
    }

    if (options.preferSubstackMedia && node.closest("div[class*='imageRow']").length) {
      return false;
    }

    const src = node.attr("src") || node.attr("data-src") || node.attr("data-image-src") || "";
    if (!cleanText(src)) {
      return false;
    }

    const width = Number(node.attr("width") || 0);
    const height = Number(node.attr("height") || 0);
    if (width > 0 && height > 0 && width <= 6 && height <= 6) {
      return false;
    }
    if (width > 0 && height > 0 && width <= 64 && height <= 64) {
      return false;
    }

    return true;
  }

  if (tag === "p" && text.length < 18 && !hasLinks && !hasImages) {
    if (/:\s*$/.test(text) && text.length >= 5) {
      return true;
    }

    return false;
  }

  if (
    /view in browser|if you'd like to get .*newsletter|you received this message because|kill the newsletter!\s*feed settings|follow us|get the newsletter|like getting this newsletter|want to sponsor this newsletter|subscribe to bloomberg\.com|ads powered by liveintent|ad choices|bloomberg l\.p\./i.test(
      text
    )
  ) {
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
    "div",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
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
    "h5",
    "h6",
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

    const safeAnchorId = sanitizeAnchorId(attrs.id || attrs.name || "");
    if (safeAnchorId) {
      $node.attr("id", safeAnchorId);
    }

    if (tag === "a") {
      normalizeLinkElement($node, attrs, baseUrl);
      return;
    }

    if (tag === "div") {
      normalizeDivElement($node, attrs, baseUrl);
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
  return /(share|social|signup|newsletter|related|comment|cookie|advert|promo|paywall|footer|nav|toolbar|popup|byline|avatar|profile|author)/.test(
    marker
  );
}

function normalizeLinkElement(node, attrs, baseUrl) {
  const rawHref = typeof attrs.href === "string" ? attrs.href.trim() : "";
  if (!rawHref) {
    if (node.attr("id")) {
      node.removeAttr("href");
      node.removeAttr("target");
      node.removeAttr("rel");
      return;
    }

    node.replaceWith(node.contents());
    return;
  }

  const localAnchorHref = resolveLocalAnchorHref(rawHref, baseUrl);
  if (localAnchorHref) {
    node.attr("href", localAnchorHref);
    node.removeAttr("target");
    node.removeAttr("rel");
    return;
  }

  const href = sanitizeUrl(rawHref, baseUrl);
  if (!href || href.toLowerCase().startsWith("javascript:")) {
    node.replaceWith(node.contents());
    return;
  }

  node.attr("href", href);
  node.attr("target", "_blank");
  node.attr("rel", "noopener noreferrer");
}

function sanitizeAnchorId(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^#+/, "");
  if (!raw) {
    return "";
  }

  const cleaned = raw.replace(/[^A-Za-z0-9:_.-]/g, "");
  if (!cleaned) {
    return "";
  }

  return cleaned.slice(0, 96);
}

function resolveLocalAnchorHref(value, baseUrl = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith("#")) {
    const anchor = sanitizeAnchorId(raw.slice(1));
    return anchor ? `#${anchor}` : null;
  }

  if (!raw.includes("#") || !baseUrl) {
    return null;
  }

  try {
    const resolved = new URL(raw, baseUrl);
    if (!resolved.hash) {
      return null;
    }

    const base = new URL(baseUrl);
    if (
      resolved.origin !== base.origin ||
      resolved.pathname !== base.pathname ||
      resolved.search !== base.search
    ) {
      return null;
    }

    const anchor = sanitizeAnchorId(resolved.hash.slice(1));
    return anchor ? `#${anchor}` : null;
  } catch {
    return null;
  }
}

function normalizeImageElement(node, attrs, baseUrl) {
  const marker = `${attrs.class || ""} ${attrs.id || ""}`.toLowerCase();
  if (/(avatar|profile|author|byline|favicon)/.test(marker)) {
    node.remove();
    return;
  }

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

  const width = Number(attrs.width || 0);
  const height = Number(attrs.height || 0);
  if (width > 0 && height > 0 && width <= 64 && height <= 64) {
    node.remove();
    return;
  }

  node.attr("src", src);
  if (width > 0) {
    node.attr("width", String(Math.round(width)));
  }
  if (height > 0) {
    node.attr("height", String(Math.round(height)));
  }

  if (/\bsizing-large\b/.test(marker)) {
    node.attr("data-size", "large");
  } else if (/\bsizing-normal\b/.test(marker)) {
    node.attr("data-size", "normal");
  } else if (/\bmedium-/i.test(marker) || /\bsizing-small\b/.test(marker)) {
    node.attr("data-size", "small");
  }

  const alt = cleanText(attrs.alt || attrs.title || "");
  if (alt) {
    node.attr("alt", alt);
  }

  node.attr("loading", "lazy");
  node.attr("decoding", "async");
}

function normalizeDivElement(node, attrs, baseUrl) {
  const marker = `${attrs.class || ""} ${attrs.id || ""}`.toLowerCase();
  const componentName = (attrs["data-component-name"] || "").toLowerCase();

  if (componentName === "datawrappertodom") {
    normalizeDatawrapperElement(node, attrs, baseUrl);
    return;
  }

  if (!isSubstackImageRowMarker(marker)) {
    node.replaceWith(node.contents());
    return;
  }

  node.attr("class", "reader-image-row");
  const columns = extractSubstackImageRowColumns(marker);
  if (columns > 1) {
    node.attr("data-columns", String(columns));
  }
}

function normalizeDatawrapperElement(node, attrs, baseUrl) {
  const payload = parseEmbeddedJsonAttr(attrs["data-attrs"] || "");
  const sourceUrl = sanitizeUrl(payload?.url || "", baseUrl);
  const imageUrl = sanitizeUrl(payload?.thumbnail_url_full || payload?.thumbnail_url || "", baseUrl);
  const title = cleanText(payload?.title || "");
  const description = cleanText(payload?.description || "");
  const caption = title || description;

  if (!imageUrl && !sourceUrl) {
    node.remove();
    return;
  }

  node.empty();
  node.attr("class", "reader-datawrapper");

  if (imageUrl) {
    const imageHtml = `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(
      caption || "Embedded chart"
    )}" loading="lazy" decoding="async" />`;
    if (sourceUrl) {
      node.append(
        `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${imageHtml}</a>`
      );
    } else {
      node.append(imageHtml);
    }
  } else if (sourceUrl) {
    node.append(`<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open chart</a>`);
  }

  if (caption) {
    node.append(`<p>${escapeHtml(caption)}</p>`);
  }
}

function isSubstackImageRowMarker(marker) {
  return /imagerow-|imagerow\b/.test(marker);
}

function extractSubstackImageRowColumns(marker) {
  const match = marker.match(/length-(\d+)/);
  if (!match || !match[1]) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(4, Math.round(value)));
}

function parseEmbeddedJsonAttr(rawValue) {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }

  const decoded = rawValue
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
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
    const textKey = cleanText(block).toLowerCase();
    let key = textKey;

    if (!key) {
      const imageSrc = extractFirstImageSrcFromHtml(block);
      if (imageSrc) {
        key = `img:${imageSrc}`;
      } else {
        key = block.replace(/\s+/g, " ").trim().toLowerCase();
      }
    }

    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(block);
  });

  return output;
}

function repairInPageFootnoteTargets(contentHtml) {
  if (!contentHtml) {
    return "";
  }

  let $ = null;
  try {
    $ = cheerio.load(`<article id="reader-footnote-root">${contentHtml}</article>`);
  } catch {
    return contentHtml;
  }

  const $root = $("#reader-footnote-root");
  const referencedIds = new Set();

  $root.find("a[href]").each((_idx, node) => {
    const $node = $(node);
    const href = String($node.attr("href") || "").trim();
    if (!href.startsWith("#")) {
      return;
    }

    const anchorId = sanitizeAnchorId(href.slice(1));
    if (!anchorId) {
      $node.replaceWith($node.contents());
      return;
    }

    $node.attr("href", `#${anchorId}`);
    referencedIds.add(anchorId);
  });

  if (!referencedIds.size) {
    return $root.html() || "";
  }

  const existingIds = new Set();
  $root.find("[id]").each((_idx, node) => {
    const id = sanitizeAnchorId($(node).attr("id") || "");
    if (!id) {
      return;
    }

    if ($(node).attr("id") !== id) {
      $(node).attr("id", id);
    }
    existingIds.add(id);
  });

  const refsByNumber = new Map();
  referencedIds.forEach((id) => {
    const number = extractFootnoteNumber(id);
    if (number) {
      refsByNumber.set(number, id);
    }
  });

  if (!refsByNumber.size) {
    return $root.html() || "";
  }

  $root.find("p,li,div").each((_idx, node) => {
    const $node = $(node);
    if ($node.attr("id")) {
      return;
    }

    const number = extractLeadingFootnoteNumber(cleanText($node.text()));
    if (!number) {
      return;
    }

    const targetId = refsByNumber.get(number);
    if (!targetId || existingIds.has(targetId)) {
      return;
    }

    $node.attr("id", targetId);
    existingIds.add(targetId);
  });

  return $root.html() || "";
}

function stripPlaceholderNodes(contentHtml) {
  if (!contentHtml) {
    return "";
  }

  return String(contentHtml)
    .replace(/<\s*(?:none|null|undefined)\b[^>]*>\s*<\/\s*(?:none|null|undefined)\s*>/gi, "")
    .replace(/<\s*(?:none|null|undefined)\b[^>]*\/\s*>/gi, "")
    .trim();
}

function extractFootnoteNumber(id) {
  const value = String(id || "").toLowerCase();
  const directMatch = value.match(/^(?:footnote-|fn-?|note-?)(\d{1,4})$/i);
  if (directMatch && directMatch[1]) {
    return directMatch[1];
  }

  const looseMatch = value.match(/^(\d{1,4})$/);
  return looseMatch && looseMatch[1] ? looseMatch[1] : "";
}

function extractLeadingFootnoteNumber(text) {
  const value = String(text || "");
  const bracketMatch = value.match(/^\[(\d{1,4})\]/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }

  const plainMatch = value.match(/^(\d{1,4})[\).:\-]\s+/);
  return plainMatch && plainMatch[1] ? plainMatch[1] : "";
}

function cleanupMoneyStuffContentHtml(contentHtml, baseUrl) {
  if (!contentHtml) {
    return "";
  }

  const selector = "h2,h3,h4,h5,h6,p,ul,ol,blockquote,pre,figure,img,hr";
  let $ = null;
  try {
    $ = cheerio.load(`<article id="money-stuff-cleaner-root">${contentHtml}</article>`);
  } catch {
    return contentHtml;
  }

  const $root = $("#money-stuff-cleaner-root");
  const rootNode = $root.get(0);
  const blocks = [];

  $root
    .find(selector)
    .slice(0, 1200)
    .each((_idx, element) => {
      if (hasMatchingContentAncestor($, element, rootNode, selector)) {
        return;
      }

      const node = $(element);
      const tag = (element.tagName || "").toLowerCase();
      const text = cleanText(node.text());
      const normalized = text.toLowerCase();
      const hasImage = tag === "img" || node.find("img").length > 0;

      if (tag === "img") {
        if (isLikelyMoneyStuffPromoImage(node)) {
          return;
        }
      } else {
        if (!text && !hasImage) {
          return;
        }

        if (text && isMoneyStuffBoilerplateText(normalized)) {
          return;
        }

        if (hasImage && !text && hasOnlyLikelyMoneyStuffPromoImages($, node)) {
          return;
        }
      }

      const html = sanitizeContentBlock($, element, baseUrl);
      if (html) {
        blocks.push(html);
      }
    });

  if (!blocks.length) {
    return "";
  }

  let startIndex = blocks.findIndex((block) => {
    const text = cleanText(block).toLowerCase();
    return /<h[2-6]\b/i.test(block) && text.length >= 12 && !isMoneyStuffBoilerplateText(text);
  });

  if (startIndex < 0) {
    startIndex = blocks.findIndex((block) => {
      const text = cleanText(block).toLowerCase();
      return text.length > 80 && !isMoneyStuffBoilerplateText(text);
    });
  }

  const stream = startIndex >= 0 ? blocks.slice(startIndex) : blocks;
  const trimmed = [];
  for (const block of stream) {
    const text = cleanText(block).toLowerCase();
    if (isMoneyStuffTailText(text) || isMoneyStuffTailVisualBlock(block)) {
      break;
    }
    trimmed.push(block);
  }

  if (!trimmed.length) {
    return "";
  }

  return stripPlaceholderNodes(
    repairInPageFootnoteTargets(removeAdjacentQuoteEchoes(dedupeHtmlBlocks(trimmed)).join("\n"))
  );
}

function isLikelyMoneyStuffPromoImage(node) {
  const src = (node.attr("src") || "").toLowerCase();
  const alt = cleanText(node.attr("alt") || node.attr("title") || "").toLowerCase();
  const marker = `${node.attr("class") || ""} ${node.attr("id") || ""}`.toLowerCase();
  const sourceSignal = `${src} ${alt} ${marker}`;
  if (!src) {
    return true;
  }

  if (
    /sli\.bloomberg\.com\/imp|post\.spmailtechnolo\.com|\/open\.aspx\?|data:image\/|liveintent|adchoices|money\s*stuff:\s*the\s*podcast|listen\s+on\s+apple\s+podcasts|bloomberg\s+terminal/i.test(
      sourceSignal
    )
  ) {
    return true;
  }

  const width = Number(node.attr("width") || 0);
  const height = Number(node.attr("height") || 0);
  if ((width > 0 && height > 0 && width <= 72 && height <= 72) || width === 1 || height === 1) {
    return true;
  }

  return false;
}

function hasOnlyLikelyMoneyStuffPromoImages($, node) {
  const images = node.find("img");
  if (!images.length) {
    return false;
  }

  let hasRealImage = false;
  images.each((_idx, imageNode) => {
    if (!isLikelyMoneyStuffPromoImage($(imageNode))) {
      hasRealImage = true;
    }
  });

  return !hasRealImage;
}

function isMoneyStuffBoilerplateText(text) {
  if (!text) {
    return false;
  }

  return /(view in browser|follow us|get the newsletter|like getting this newsletter|subscribe to bloomberg\.com|want to sponsor this newsletter|ads powered by liveintent|ad choices|kill the newsletter!\s*feed settings|you received this message because|bloomberg l\.p\. 731 lexington|money stuff liquidity, resolution, mythos, concierge|money stuff:\s*the podcast|before it[’']s here,\s*it[’']s on the bloomberg terminal|listen on apple podcasts)/i.test(
    text
  );
}

function isMoneyStuffTailText(text) {
  if (!text) {
    return false;
  }

  return /(you received this message because|unsubscribe|contact us|ads powered by liveintent|ad choices|kill the newsletter!\s*feed settings|bloomberg l\.p\. 731 lexington|money stuff:\s*the podcast|before it[’']s here,\s*it[’']s on the bloomberg terminal|listen on apple podcasts)/i.test(
    text
  );
}

function isMoneyStuffTailVisualBlock(blockHtml) {
  const html = String(blockHtml || "");
  if (!html || !/<(?:img|figure|table|div|a)\b/i.test(html)) {
    return false;
  }

  let $ = null;
  try {
    $ = cheerio.load(`<article id="money-stuff-tail-visual-root">${html}</article>`);
  } catch {
    return /liveintent|adchoices|money\s*stuff:\s*the\s*podcast|listen\s+on\s+apple\s+podcasts|bloomberg\s+terminal/i.test(
      cleanText(html).toLowerCase()
    );
  }

  const $root = $("#money-stuff-tail-visual-root");
  const rootText = cleanText($root.text()).toLowerCase();
  if (isMoneyStuffTailText(rootText) || isMoneyStuffBoilerplateText(rootText)) {
    return true;
  }

  let shouldDrop = false;
  $root.find("a,img").each((_idx, node) => {
    if (shouldDrop) {
      return;
    }

    const $node = $(node);
    const marker = [
      $node.attr("href"),
      $node.attr("src"),
      $node.attr("alt"),
      $node.attr("title"),
      $node.attr("class"),
      $node.attr("id"),
      cleanText($node.text()),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (
      /liveintent|adchoices|money\s*stuff:\s*the\s*podcast|listen\s+on\s+apple\s+podcasts|podcasts\.apple\.com|bloomberg\.com\/account\/newsletters|bloomberg\s+terminal|kill-the-newsletter/i.test(
        marker
      )
    ) {
      shouldDrop = true;
    }
  });

  return shouldDrop;
}

function removeAdjacentQuoteEchoes(blocks) {
  const output = [];
  blocks.forEach((block) => {
    if (!block) {
      return;
    }

    const currentText = cleanText(block).toLowerCase();
    if (!output.length) {
      output.push(block);
      return;
    }

    const previous = output[output.length - 1];
    const previousText = cleanText(previous).toLowerCase();
    if (previousText && currentText && previousText === currentText) {
      return;
    }

    const previousTag = extractRootTagName(previous);
    const currentTag = extractRootTagName(block);
    if (
      previousTag === "blockquote" &&
      currentTag === "p" &&
      hasStrongTextOverlap(previousText, currentText, 0.2)
    ) {
      return;
    }

    output.push(block);
  });

  return output;
}

function extractRootTagName(html) {
  const match = String(html || "").match(/^<\s*([a-z0-9]+)/i);
  return match && match[1] ? match[1].toLowerCase() : "";
}

function hasStrongTextOverlap(a, b, minimumRatio = 0.2) {
  if (!a || !b) {
    return false;
  }

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (!shorter || !longer || !longer.includes(shorter)) {
    return false;
  }

  return shorter.length / longer.length >= minimumRatio;
}

function extractFirstImageSrcFromHtml(html) {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!match || !match[1]) {
    return "";
  }

  return match[1].trim();
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

async function withRetry(task, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 1));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs || 0));
  const factor = Math.max(1, Number(options.factor || 2));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs || 4_000));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }

      const exponential = baseDelayMs * factor ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 120);
      const delayMs = Math.min(maxDelayMs, Math.round(exponential + jitter));
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }

  const output = new Array(items.length);
  const workerCount = Math.max(1, Math.min(limit || 1, items.length));
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      output[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return output;
}

export { SOURCES, aggregateSources, buildArticlePayload, canonicalizeUrl, inferAccessLevel };
