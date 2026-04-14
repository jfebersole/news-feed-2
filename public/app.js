const state = {
  loading: true,
  items: [],
  sources: [],
  selectedSource: "all",
  searchText: "",
  generatedAt: null,
  cached: false,
  error: "",
  readerOpen: false,
  readerLoading: false,
  readerError: "",
  readerItem: null,
  readerArticle: null,
};
const FEED_DATA_URL = "./data/feed.json";
const ARTICLES_DATA_DIR = "./data/articles";

const cardGrid = document.querySelector("#cardGrid");
const sourceChips = document.querySelector("#sourceChips");
const metaStrip = document.querySelector("#metaStrip");
const cardTemplate = document.querySelector("#cardTemplate");
const searchInput = document.querySelector("#searchInput");
const refreshBtn = document.querySelector("#refreshBtn");
const lastUpdated = document.querySelector("#lastUpdated");
const homeLink = document.querySelector("#homeLink");
const brandBlock = document.querySelector(".brand-block");
const issueKicker = document.querySelector(".issue-kicker");
const readerPanel = document.querySelector("#readerPanel");
const readerRailTitle = document.querySelector("#readerRailTitle");
const readerLink = document.querySelector("#readerLink");
const readerRailSource = document.querySelector("#readerRailSource");
const readerRailLink = document.querySelector("#readerRailLink");
const readerBylineRow = document.querySelector("#readerBylineRow");
const readerSource = document.querySelector("#readerSource");
const readerTitle = document.querySelector("#readerTitle");
const readerSubtitle = document.querySelector("#readerSubtitle");
const readerMeta = document.querySelector("#readerMeta");
const readerReason = document.querySelector("#readerReason");
const readerBody = document.querySelector("#readerBody");
const readerSticky = document.querySelector(".reader-sticky");
const htmlEntityDecoder = document.createElement("textarea");
const textMeasureCanvas = document.createElement("canvas");
const textMeasureContext = textMeasureCanvas.getContext("2d");
const brandLockupObserver =
  typeof ResizeObserver === "function" && brandBlock && issueKicker && homeLink
    ? new ResizeObserver(syncBrandLockup)
    : null;
let readerRequestId = 0;
let pendingCardGridFocus = false;

searchInput.addEventListener("input", (event) => {
  state.searchText = event.target.value.trim().toLowerCase();
  render();
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing";

  try {
    await loadFeed(true);
  } catch (error) {
    console.error(error);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.readerOpen) {
    navigateBackFromReader();
    return;
  }

  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});

window.addEventListener(
  "scroll",
  () => {
    updateReaderProgress();
  },
  { passive: true }
);

window.addEventListener("resize", () => {
  syncBrandLockup();
  updateReaderProgress();
});

window.addEventListener("popstate", (event) => {
  if (event.state?.reader && event.state.readerId) {
    const item = state.items.find((candidate) => resolveReaderStateId(candidate) === event.state.readerId);
    if (item) {
      openReader(item, { fromHistory: true }).catch((error) => {
        console.error(error);
      });
      return;
    }
  }

  if (state.readerOpen) {
    closeReader({ fromHistory: true });
  }
});

homeLink.addEventListener("click", (event) => {
  event.preventDefault();
  state.selectedSource = "all";
  state.searchText = "";
  searchInput.value = "";
  navigateBackFromReader();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

if (readerBody) {
  readerBody.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href^='#']") : null;
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }

    const anchorId = sanitizeReaderAnchorId(link.getAttribute("href") || "");
    if (!anchorId) {
      return;
    }

    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(anchorId) : anchorId;
    const target = readerBody.querySelector(`#${escaped}`);
    if (!target) {
      return;
    }

    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

loadFeed().catch((error) => {
  console.error(error);
});

syncBrandLockup();
brandLockupObserver?.observe(issueKicker);
brandLockupObserver?.observe(homeLink);
document.fonts?.ready
  ?.then(() => {
    syncBrandLockup();
  })
  .catch(() => {});

async function loadFeed(force = false) {
  state.loading = true;
  state.error = "";
  render();

  const url = `${FEED_DATA_URL}${force ? `?ts=${Date.now()}` : ""}`;
  try {
    const response = await fetch(url, { cache: force ? "no-store" : "default" });

    if (!response.ok) {
      throw new Error(`Failed to load feed (HTTP ${response.status})`);
    }

    const payload = await response.json();
    state.items = (payload.items || []).map(normalizeFeedItemText);
    state.sources = payload.sources || [];
    state.generatedAt = payload.generatedAt || payload.fetchedAt || new Date().toISOString();
    state.cached = true;
  } catch (error) {
    state.error =
      error instanceof Error
        ? error.message
        : "Feed request failed. Static data may not be published yet.";
  } finally {
    state.loading = false;
  }

  render();
}

function render() {
  renderMeta();
  renderLastUpdated();
  renderSourceChips();
  renderCards();
  renderReader();
}

function normalizeFeedItemText(item) {
  if (!item || typeof item !== "object") {
    return item;
  }

  return {
    ...item,
    title: decodeHtmlEntities(item.title),
    summary: decodeHtmlEntities(item.summary),
  };
}

function renderMeta() {
  const visible = getVisibleItems();
  const sourceModes = summarizeModes();

  metaStrip.replaceChildren(
    createMetaPill(`${state.items.length} total stories`),
    createMetaPill(`${visible.length} shown`),
    createMetaPill(`${state.sources.length} sources`),
    createMetaPill(sourceModes),
    createMetaPill("Static build")
  );
}

function renderLastUpdated() {
  if (!state.generatedAt) {
    lastUpdated.textContent = "Loading...";
    return;
  }

  const date = new Date(state.generatedAt);
  lastUpdated.textContent = `Updated ${date.toLocaleString()}`;
}

function renderSourceChips() {
  const chips = [];
  chips.push(createSourceChip("all", "All Sources", state.items.length));

  state.sources
    .filter((source) => source.itemCount > 0)
    .sort((a, b) => b.itemCount - a.itemCount)
    .forEach((source) => {
      chips.push(createSourceChip(source.name, source.name, source.itemCount));
    });

  sourceChips.replaceChildren(...chips);
}

function createSourceChip(value, label, count) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chip ${state.selectedSource === value ? "active" : ""}`.trim();
  button.setAttribute("data-source", value);
  button.innerHTML = `${escapeHtml(label)} <span class="chip-count">(${count})</span>`;

  button.addEventListener("click", () => {
    state.selectedSource = value;
    if (state.readerOpen) {
      pendingCardGridFocus = true;
      navigateBackFromReader();
      return;
    }
    render();
  });

  return button;
}

function renderCards() {
  if (state.readerOpen) {
    cardGrid.hidden = true;
    return;
  }

  cardGrid.hidden = false;
  const items = getVisibleItems();

  if (state.loading) {
    cardGrid.innerHTML = `<div class="empty">Loading your feed...</div>`;
    return;
  }

  if (state.error) {
    cardGrid.innerHTML = `<div class="empty">${escapeHtml(state.error)}</div>`;
    return;
  }

  if (!items.length) {
    cardGrid.innerHTML =
      '<div class="empty">No stories match your filters. Try clearing search or switching source filters.</div>';
    return;
  }

  const cards = items.map((item, index) => {
    const fragment = cardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".feed-card");
    const rankPill = fragment.querySelector(".rank-pill");
    const sourcePill = fragment.querySelector(".source-pill");
    const timePill = fragment.querySelector(".time-pill");
    const titleLink = fragment.querySelector(".card-title-link");
    const title = fragment.querySelector(".card-title");
    const summary = fragment.querySelector(".card-summary");
    const link = fragment.querySelector(".card-link");

    card.style.setProperty("--idx", index.toString());
    card.classList.add(`tone-${toneForSource(item.source)}`);

    rankPill.textContent = String(index + 1).padStart(2, "0");
    sourcePill.textContent = item.source;
    timePill.textContent = item.publishedAt ? formatRelative(item.publishedAt) : "Date unknown";
    title.textContent = item.title;
    titleLink.href = item.url;
    titleLink.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      event.preventDefault();
      openReader(item);
    });
    summary.textContent = truncateSummary(item.summary) || "Summary unavailable.";
    link.href = item.url;
    link.textContent = "Open Story";

    return fragment;
  });

  cardGrid.replaceChildren(...cards);
}

function getVisibleItems() {
  const filteredBySource =
    state.selectedSource === "all"
      ? state.items
      : state.items.filter((item) => item.source === state.selectedSource);

  if (!state.searchText) {
    return filteredBySource;
  }

  return filteredBySource.filter((item) =>
    [item.title, item.summary, item.source]
      .join(" ")
      .toLowerCase()
      .includes(state.searchText)
  );
}

function summarizeModes() {
  const modeCount = state.sources.reduce(
    (acc, source) => {
      if (source.mode === "failed") {
        acc.failed += 1;
      } else {
        acc.rss += 1;
      }
      return acc;
    },
    { rss: 0, failed: 0 }
  );

  return `RSS ${modeCount.rss} | Failed ${modeCount.failed}`;
}

function toneForSource(sourceName) {
  const tones = ["a", "b", "c", "d"];
  let hash = 0;
  for (let index = 0; index < sourceName.length; index += 1) {
    hash = (hash << 5) - hash + sourceName.charCodeAt(index);
    hash |= 0;
  }
  return tones[Math.abs(hash) % tones.length];
}

function truncateSummary(value) {
  if (!value) {
    return "";
  }

  const clean = value.trim();
  if (clean.length <= 190) {
    return clean;
  }

  return `${clean.slice(0, 187)}...`;
}

function formatRelative(input) {
  const date = new Date(input);
  const now = new Date();
  const deltaSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (abs < 60) {
    return rtf.format(deltaSeconds, "second");
  }
  if (abs < 3600) {
    return rtf.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (abs < 86400) {
    return rtf.format(Math.round(deltaSeconds / 3600), "hour");
  }
  if (abs < 604800) {
    return rtf.format(Math.round(deltaSeconds / 86400), "day");
  }

  return date.toLocaleDateString();
}

function createMetaPill(text) {
  const span = document.createElement("span");
  span.className = "meta-pill";
  span.textContent = text;
  return span;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlEntities(value) {
  if (typeof value !== "string") {
    return "";
  }

  if (!value.includes("&")) {
    return value;
  }

  htmlEntityDecoder.innerHTML = value;
  return htmlEntityDecoder.value;
}

async function openReader(item, options = {}) {
  const { fromHistory = false } = options;

  if (!fromHistory) {
    const currentUrl = new URL(window.location.href);
    currentUrl.hash = "";
    history.pushState({ reader: true, readerId: resolveReaderStateId(item) }, "", currentUrl.toString());
  }

  state.readerOpen = true;
  state.readerLoading = true;
  state.readerError = "";
  state.readerItem = item;
  state.readerArticle = null;
  resetReaderProgress();
  cardGrid.hidden = true;
  renderReader();
  if (!fromHistory) {
    scrollToReaderTitle();
  }
  updateReaderProgress();

  const requestId = ++readerRequestId;

  try {
    const articlePath = resolveArticlePath(item);
    if (!articlePath) {
      state.readerArticle = buildFallbackArticle(item, "Reader file missing for this story.");
      return;
    }

    const response = await fetch(`${articlePath}?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      state.readerArticle = buildFallbackArticle(item, "Reader extract unavailable for this story.");
      return;
    }

    const payload = await response.json();
    if (requestId !== readerRequestId) {
      return;
    }

    state.readerArticle = payload?.mode ? payload : buildFallbackArticle(item, "Reader file was invalid.");
  } catch (error) {
    if (requestId !== readerRequestId) {
      return;
    }

    state.readerError = error instanceof Error ? error.message : "Could not load this article in-app right now.";
    state.readerArticle = buildFallbackArticle(item, state.readerError);
  } finally {
    if (requestId === readerRequestId) {
      state.readerLoading = false;
      renderReader();
      if (!fromHistory) {
        scrollToReaderTitle();
      }
    }
  }
}

function closeReader(options = {}) {
  const { fromHistory = false } = options;

  if (!fromHistory && history.state?.reader) {
    history.back();
    return;
  }

  state.readerOpen = false;
  state.readerLoading = false;
  state.readerError = "";
  state.readerItem = null;
  state.readerArticle = null;
  resetReaderProgress();
  cardGrid.hidden = false;
  render();
  if (pendingCardGridFocus) {
    pendingCardGridFocus = false;
    cardGrid.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function navigateBackFromReader() {
  if (!state.readerOpen) {
    return;
  }

  closeReader();
}

function scrollToReaderTitle() {
  if (!readerTitle) {
    return;
  }

  const setWindowScrollTop = (value) => {
    window.scrollTo(0, value);
    document.documentElement.scrollTop = value;
    if (document.body) {
      document.body.scrollTop = value;
    }
  };

  const alignTitleNearTop = () => {
    const titleRect = readerTitle.getBoundingClientRect();
    const targetTop = Math.max(0, window.scrollY + titleRect.top - 18);
    setWindowScrollTop(targetTop);
  };

  window.requestAnimationFrame(() => {
    alignTitleNearTop();
    window.requestAnimationFrame(() => {
      alignTitleNearTop();
    });
  });
}

function renderReader() {
  if (!readerPanel) {
    return;
  }

  if (!state.readerOpen || !state.readerItem) {
    readerPanel.hidden = true;
    resetReaderProgress();
    return;
  }

  const item = state.readerItem;
  const article = state.readerArticle;
  const heading = decodeHtmlEntities(article?.title || item.title || "Article");

  readerPanel.hidden = false;
  readerRailTitle.textContent = heading;
  readerRailSource.textContent = item.source || "";
  readerRailSource.hidden = !readerRailSource.textContent.trim();

  if (item.url) {
    readerLink.href = item.url;
    readerLink.hidden = false;
    readerRailLink.href = item.url;
    readerRailLink.hidden = false;
  } else {
    readerLink.href = "#";
    readerLink.hidden = true;
    readerRailLink.href = "#";
    readerRailLink.hidden = true;
  }

  readerSource.textContent = item.source || "";
  readerSource.hidden = !readerSource.textContent.trim();

  readerTitle.textContent = heading;
  readerSubtitle.textContent = "";
  readerSubtitle.classList.remove("visible");
  const subtitleRaw = decodeHtmlEntities(article?.subtitle || "");
  const subtitle = subtitleRaw.length > 320 ? "" : subtitleRaw;
  if (subtitle) {
    readerSubtitle.textContent = subtitle;
    readerSubtitle.classList.add("visible");
  }
  readerMeta.textContent = buildReaderMeta(article, item);
  readerReason.textContent = "";
  readerReason.classList.remove("visible");

  if (state.readerLoading) {
    readerBody.innerHTML = "<p>Loading article...</p>";
    updateReaderProgress();
    return;
  }

  if (state.readerError) {
    readerBody.innerHTML = `<p>${escapeHtml(state.readerError)}</p>`;
    updateReaderProgress();
    return;
  }

  if (!article) {
    readerBody.innerHTML = "<p>Article unavailable. Open the source link.</p>";
    updateReaderProgress();
    return;
  }

  if (article.mode === "excerpt") {
    if (article.reason) {
      readerReason.textContent = article.reason;
      readerReason.classList.add("visible");
    }

    const excerpt = decodeHtmlEntities(article.excerpt || item.summary || "Open the source link to keep reading.");
    readerBody.innerHTML = `<p>${escapeHtml(excerpt)}</p>`;
    updateReaderProgress();
    return;
  }

  readerBody.innerHTML =
    article.contentHtml || "<p>No extracted content was available for this story.</p>";
  normalizeReaderAnchors(readerBody);
  updateReaderProgress();
}

function normalizeReaderAnchors(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll("none,null,undefined").forEach((node) => {
    node.remove();
  });

  const referencedIds = new Set();
  container.querySelectorAll("a[href^='#']").forEach((anchor) => {
    const safeId = sanitizeReaderAnchorId(anchor.getAttribute("href") || "");
    if (!safeId) {
      anchor.removeAttribute("href");
      return;
    }

    anchor.setAttribute("href", `#${safeId}`);
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    referencedIds.add(safeId);
  });

  if (!referencedIds.size) {
    return;
  }

  const existingIds = new Set();
  container.querySelectorAll("[id]").forEach((node) => {
    const safeId = sanitizeReaderAnchorId(node.id || "");
    if (!safeId) {
      return;
    }

    if (node.id !== safeId) {
      node.id = safeId;
    }
    existingIds.add(safeId);
  });

  const refsByNumber = new Map();
  referencedIds.forEach((id) => {
    const number = extractReaderFootnoteNumber(id);
    if (number) {
      refsByNumber.set(number, id);
    }
  });

  if (!refsByNumber.size) {
    return;
  }

  container.querySelectorAll("p,li,div").forEach((node) => {
    if (node.id) {
      return;
    }

    const number = extractReaderLeadingFootnoteNumber(node.textContent || "");
    if (!number) {
      return;
    }

    const targetId = refsByNumber.get(number);
    if (!targetId || existingIds.has(targetId)) {
      return;
    }

    node.id = targetId;
    existingIds.add(targetId);
  });
}

function sanitizeReaderAnchorId(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^#+/, "");
  if (!raw) {
    return "";
  }

  const cleaned = raw.replace(/[^A-Za-z0-9:_.-]/g, "");
  return cleaned.slice(0, 96);
}

function extractReaderFootnoteNumber(id) {
  const value = String(id || "").toLowerCase();
  const match = value.match(/^(?:footnote-|fn-?|note-?)(\d{1,4})$/i) || value.match(/^(\d{1,4})$/);
  return match && match[1] ? match[1] : "";
}

function extractReaderLeadingFootnoteNumber(text) {
  const value = String(text || "").trim();
  const bracketMatch = value.match(/^\[(\d{1,4})\]/);
  if (bracketMatch && bracketMatch[1]) {
    return bracketMatch[1];
  }

  const plainMatch = value.match(/^(\d{1,4})[\).:\-]\s+/);
  return plainMatch && plainMatch[1] ? plainMatch[1] : "";
}

function syncBrandLockup() {
  if (!brandBlock || !issueKicker || !homeLink) {
    return;
  }

  const kickerRect = issueKicker.getBoundingClientRect();
  const titleRect = homeLink.getBoundingClientRect();
  const kickerInsets = getTextInkInsets(issueKicker);
  const titleInsets = getTextInkInsets(homeLink);
  const logoOffset = kickerInsets.top;
  const stackHeight = (titleRect.bottom - titleInsets.bottom) - (kickerRect.top + logoOffset);

  if (stackHeight <= 0) {
    return;
  }

  brandBlock.style.setProperty("--brand-logo-offset", `${logoOffset.toFixed(2)}px`);
  brandBlock.style.setProperty("--brand-stack-height", `${stackHeight.toFixed(2)}px`);
}

function getTextInkInsets(element) {
  if (!textMeasureContext || !element) {
    return { top: 0, bottom: 0 };
  }

  const text = element.textContent?.trim();
  if (!text) {
    return { top: 0, bottom: 0 };
  }

  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 0;

  const font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontSize, style.fontFamily]
    .filter(Boolean)
    .join(" ");

  textMeasureContext.font = font;

  // 1. Ask Canvas for the true typographic height of a flat letter
  let measureText = "H";
  if (style.textTransform === "lowercase") {
    measureText = "x";
  } else if (style.textTransform === "none" || !style.textTransform) {
    measureText = "Hx"; 
  }

  const metrics = textMeasureContext.measureText(measureText);
  const capHeight = metrics.actualBoundingBoxAscent ?? metrics.fontBoundingBoxAscent ?? (fontSize * 0.72);

  // 2. THE FIX: DOM Baseline Injection
  // Inject a 0x0 invisible marker to find the EXACT pixel coordinate of the CSS baseline
  const marker = document.createElement("span");
  marker.style.display = "inline-block";
  marker.style.width = "0px";
  marker.style.height = "0px";
  marker.style.lineHeight = "0";
  marker.style.verticalAlign = "baseline";
  
  element.appendChild(marker);
  const baselineY = marker.getBoundingClientRect().bottom; // This is the exact CSS baseline
  marker.remove();

  const elementRect = element.getBoundingClientRect();

  // 3. Calculate true insets based on exact viewport coordinates
  const inkTop = baselineY - capHeight;
  
  return {
    top: Math.max(0, inkTop - elementRect.top),
    bottom: Math.max(0, elementRect.bottom - baselineY),
  };
}

function buildReaderMeta(article, item) {
  const parts = [];

  if (article?.byline) {
    parts.push(decodeHtmlEntities(article.byline));
  }

  const publishedAt = article?.publishedAt || item?.publishedAt;
  if (publishedAt) {
    parts.push(new Date(publishedAt).toLocaleString());
  }

  if (article?.wordCount) {
    parts.push(`${article.wordCount} words`);
  }

  return parts.join(" · ");
}

function inferItemAccess(item) {
  const source = (item.source || "").toLowerCase();
  const url = (item.url || "").toLowerCase();
  const isMoneyStuffNewsletter =
    source.includes("money stuff") &&
    (url.includes("kill-the-newsletter.com") || url.includes("bloomberg.com"));

  if (isMoneyStuffNewsletter) {
    return "open";
  }

  if (
    source.includes("nyt") ||
    source.includes("athletic") ||
    source.includes("bloomberg") ||
    source.includes("stratechery") ||
    url.includes("nytimes.com") ||
    url.includes("bloomberg.com") ||
    url.includes("theathletic.com") ||
    url.includes("stratechery.com")
  ) {
    return "paywalled";
  }

  return "open";
}

function resolveArticlePath(item) {
  const rawId = typeof item?.articleId === "string" ? item.articleId : "";
  if (!rawId) {
    return "";
  }

  const safeId = rawId.replace(/[^a-z0-9_-]/gi, "");
  if (!safeId) {
    return "";
  }

  return `${ARTICLES_DATA_DIR}/${safeId}.json`;
}

function resolveReaderStateId(item) {
  if (!item) {
    return "";
  }

  return item.articleId || item.url || item.title || "";
}

function buildFallbackArticle(item, reason = "") {
  const access = item.access || inferItemAccess(item);
  return {
    mode: "excerpt",
    paywalled: access === "paywalled",
    access,
    url: item.url,
    source: item.source,
    title: item.title,
    excerpt: item.summary || "Open the source link to continue reading.",
    reason: reason || "Reader extract unavailable for this story.",
  };
}

function updateReaderProgress() {
  if (!readerSticky || !readerPanel || !readerBylineRow) {
    return;
  }

  if (!state.readerOpen || readerPanel.hidden) {
    resetReaderProgress();
    return;
  }

  const bylineRect = readerBylineRow.getBoundingClientRect();
  const railVisible = bylineRect.top <= 1;
  readerSticky.classList.toggle("rail-visible", railVisible);

  const stickyRect = readerSticky.getBoundingClientRect();
  const stickyLocked = stickyRect.top <= 0.5;
  if (!railVisible) {
    readerSticky.classList.remove("progress-visible");
    setReaderProgress(0);
    return;
  }

  if (!stickyLocked) {
    readerSticky.classList.remove("progress-visible");
    return;
  }

  readerSticky.classList.add("progress-visible");

  const rect = readerPanel.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;

  if (rect.height <= viewportHeight) {
    setReaderProgress(rect.top <= 0 ? 1 : 0);
    return;
  }

  const totalDistance = Math.max(1, rect.height - viewportHeight);
  const travelled = clamp(-rect.top, 0, totalDistance);
  setReaderProgress(travelled / totalDistance);
}

function resetReaderProgress() {
  if (!readerSticky) {
    return;
  }

  readerSticky.classList.remove("rail-visible");
  readerSticky.classList.remove("progress-visible");
  readerSticky.style.setProperty("--reader-progress", "0%");
}

function setReaderProgress(value) {
  if (!readerSticky) {
    return;
  }

  const progress = clamp(value, 0, 1);
  readerSticky.style.setProperty("--reader-progress", `${(progress * 100).toFixed(2)}%`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
