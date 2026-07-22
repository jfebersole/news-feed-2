import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { SOURCES, applySourceItemRules, excludeFeedItemsByUrl } = await import("../server.js");

test("configures Silver Bulletin with its Models & Forecasts exclusion feed", () => {
  const source = SOURCES.find((candidate) => candidate.name === "Silver Bulletin");

  assert.deepEqual(source, {
    name: "Silver Bulletin",
    url: "https://www.natesilver.net/",
    feedUrl: "https://www.natesilver.net/feed",
    excludeFeedUrl: "https://www.natesilver.net/feed?section=models-and-forecasts",
    accessStrategy: "substack-rss",
  });
});

test("removes items listed in an exclusion feed by canonical URL", () => {
  const source = {
    name: "Example",
    url: "https://example.com/",
    excludeFeedUrl: "https://example.com/feed?section=models",
  };
  const article = { title: "Analysis", url: "https://example.com/p/analysis" };
  const model = {
    title: "Daily model",
    url: "https://example.com/p/daily-model?utm_source=substack&utm_medium=email",
  };
  const proxyModel = { title: "Proxy model", url: "https://example.com/p/proxy-model" };

  assert.deepEqual(
    excludeFeedItemsByUrl(
      source,
      [article, model, proxyModel],
      [{ link: "/p/daily-model" }, { url: "https://example.com/p/proxy-model" }]
    ),
    [article]
  );
});

test("fails closed when a configured exclusion feed has no valid item URLs", () => {
  const source = {
    name: "Example",
    url: "https://example.com/",
    excludeFeedUrl: "https://example.com/feed?section=models",
  };

  assert.throws(
    () => excludeFeedItemsByUrl(source, [{ title: "Analysis", url: "https://example.com/p/analysis" }], []),
    /Exclusion feed returned no valid item URLs/
  );
});

test("configures Kenji's Patreon newsletter and excludes its signup confirmation", () => {
  const source = SOURCES.find((candidate) => candidate.name === "J. Kenji López-Alt");
  const confirmation = {
    title: "Confirm your email to get started on Patreon",
    url: "https://kill-the-newsletter.com/feeds/example/entries/confirmation.html",
  };
  const article = {
    title: "Introducing: Kenji Eats Japan!",
    url: "https://kill-the-newsletter.com/feeds/example/entries/article.html",
  };

  assert.deepEqual(source, {
    name: "J. Kenji López-Alt",
    url: "https://frienji.kenjilopezalt.com/",
    feedUrl: "https://kill-the-newsletter.com/feeds/1f43x14oa0jh1nq3ojfk.xml",
  });
  assert.deepEqual(applySourceItemRules(source, [confirmation, article]), [article]);
});
