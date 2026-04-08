const state = {
  loading: true,
  items: [],
  sources: [],
  selectedSource: "all",
  searchText: "",
  generatedAt: null,
  cached: false,
  error: "",
};

const cardGrid = document.querySelector("#cardGrid");
const sourceChips = document.querySelector("#sourceChips");
const metaStrip = document.querySelector("#metaStrip");
const cardTemplate = document.querySelector("#cardTemplate");
const searchInput = document.querySelector("#searchInput");
const refreshBtn = document.querySelector("#refreshBtn");
const lastUpdated = document.querySelector("#lastUpdated");
const homeLink = document.querySelector("#homeLink");

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
  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});

homeLink.addEventListener("click", (event) => {
  event.preventDefault();
  state.selectedSource = "all";
  state.searchText = "";
  searchInput.value = "";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

loadFeed().catch((error) => {
  console.error(error);
});

async function loadFeed(force = false) {
  state.loading = true;
  state.error = "";
  render();

  const url = `/api/feed?limit=220${force ? "&force=1" : ""}`;
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load feed (HTTP ${response.status})`);
    }

    const payload = await response.json();
    state.items = payload.items || [];
    state.sources = payload.sources || [];
    state.generatedAt = payload.generatedAt || payload.fetchedAt || new Date().toISOString();
    state.cached = Boolean(payload.cached);
  } catch (error) {
    state.error =
      error instanceof Error
        ? error.message
        : "Feed request failed. Check the server logs and try again.";
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
}

function renderMeta() {
  const visible = getVisibleItems();
  const sourceModes = summarizeModes();

  metaStrip.replaceChildren(
    createMetaPill(`${state.items.length} total stories`),
    createMetaPill(`${visible.length} shown`),
    createMetaPill(`${state.sources.length} sources`),
    createMetaPill(sourceModes),
    createMetaPill(state.cached ? "From cache" : "Live fetch")
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
      } else {
        acc.failed += 1;
      }
      return acc;
    },
    { rss: 0, scrape: 0, failed: 0 }
  );

  return `RSS ${modeCount.rss} | Scrape ${modeCount.scrape} | Failed ${modeCount.failed}`;
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
