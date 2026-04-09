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
const readerPanel = document.querySelector("#readerPanel");
const readerCloseBtn = document.querySelector("#readerCloseBtn");
const readerExternalLink = document.querySelector("#readerExternalLink");
const readerSource = document.querySelector("#readerSource");
const readerAccess = document.querySelector("#readerAccess");
const readerTitle = document.querySelector("#readerTitle");
const readerSubtitle = document.querySelector("#readerSubtitle");
const readerMeta = document.querySelector("#readerMeta");
const readerReason = document.querySelector("#readerReason");
const readerBody = document.querySelector("#readerBody");
const readerSticky = document.querySelector(".reader-sticky");
let readerRequestId = 0;

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
    closeReader();
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
  updateReaderProgress();
});

homeLink.addEventListener("click", (event) => {
  event.preventDefault();
  state.selectedSource = "all";
  state.searchText = "";
  searchInput.value = "";
  closeReader();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

readerCloseBtn.addEventListener("click", closeReader);

loadFeed().catch((error) => {
  console.error(error);
});

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
    state.items = payload.items || [];
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
      if (source.mode === "rss") {
        acc.rss += 1;
      } else if (source.mode === "scrape") {
        acc.scrape += 1;
      } else if (source.mode === "substack-archive") {
        acc.api += 1;
      } else if (source.mode === "fallback-cache") {
        acc.fallback += 1;
      } else {
        acc.failed += 1;
      }
      return acc;
    },
    { rss: 0, scrape: 0, api: 0, fallback: 0, failed: 0 }
  );

  const parts = [`RSS ${modeCount.rss}`, `Scrape ${modeCount.scrape}`];
  if (modeCount.api) {
    parts.push(`API ${modeCount.api}`);
  }
  if (modeCount.fallback) {
    parts.push(`Fallback ${modeCount.fallback}`);
  }
  parts.push(`Failed ${modeCount.failed}`);
  return parts.join(" | ");
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

async function openReader(item) {
  state.readerOpen = true;
  state.readerLoading = true;
  state.readerError = "";
  state.readerItem = item;
  state.readerArticle = null;
  resetReaderProgress();
  cardGrid.hidden = true;
  renderReader();
  if (readerPanel) {
    readerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
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
    }
  }
}

function closeReader() {
  state.readerOpen = false;
  state.readerLoading = false;
  state.readerError = "";
  state.readerItem = null;
  state.readerArticle = null;
  resetReaderProgress();
  cardGrid.hidden = false;
  render();
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

  readerPanel.hidden = false;

  if (item.url) {
    readerExternalLink.href = item.url;
    readerExternalLink.hidden = false;
  } else {
    readerExternalLink.href = "#";
    readerExternalLink.hidden = true;
  }

  readerSource.textContent = item.source || "";
  readerSource.hidden = !readerSource.textContent.trim();

  const access = article?.access || item.access || inferItemAccess(item);
  readerAccess.textContent = access === "paywalled" ? "Excerpt" : "Full Text";
  readerAccess.hidden = !readerAccess.textContent.trim();

  readerTitle.textContent = article?.title || item.title || "Article";
  readerSubtitle.textContent = "";
  readerSubtitle.classList.remove("visible");
  const subtitle = article?.subtitle || "";
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
    readerBody.innerHTML = "<p>Article unavailable. Open the original link.</p>";
    updateReaderProgress();
    return;
  }

  if (article.mode === "excerpt") {
    if (article.reason) {
      readerReason.textContent = article.reason;
      readerReason.classList.add("visible");
    }

    const excerpt = article.excerpt || item.summary || "Open the original article to keep reading.";
    readerBody.innerHTML = `<p>${escapeHtml(excerpt)}</p>`;
    updateReaderProgress();
    return;
  }

  readerBody.innerHTML =
    article.contentHtml || "<p>No extracted content was available for this story.</p>";
  updateReaderProgress();
}

function buildReaderMeta(article, item) {
  const parts = [];

  if (article?.byline) {
    parts.push(article.byline);
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

function buildFallbackArticle(item, reason = "") {
  const access = item.access || inferItemAccess(item);
  return {
    mode: "excerpt",
    paywalled: access === "paywalled",
    access,
    url: item.url,
    source: item.source,
    title: item.title,
    excerpt: item.summary || "Open the original article to continue reading.",
    reason: reason || "Reader extract unavailable for this story.",
  };
}

function updateReaderProgress() {
  if (!readerSticky || !readerPanel) {
    return;
  }

  if (!state.readerOpen || readerPanel.hidden) {
    resetReaderProgress();
    return;
  }

  const stickyRect = readerSticky.getBoundingClientRect();
  const stickyLocked = stickyRect.top <= 0.5;
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
