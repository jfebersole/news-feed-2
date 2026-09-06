import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { dedupeByUrl } = await import("../server.js");

test("deduplicates repeated Money Stuff email deliveries with different entry URLs", () => {
  const common = {
    source: "Money Stuff (Bloomberg)",
    title: "Money Stuff: The Clippers Got Some Consulting",
    summary: "Clippers The National Basketball Association has rules limiting how much teams can pay players.",
    feedContentHtml: "<h2>Clippers</h2><p>The National Basketball Association has rules limiting pay.</p>",
  };
  const older = {
    ...common,
    url: "https://kill-the-newsletter.com/feeds/money/entries/older.html",
    publishedAt: "2026-09-03T18:27:18.013Z",
  };
  const newer = {
    ...common,
    url: "https://kill-the-newsletter.com/feeds/money/entries/newer.html",
    publishedAt: "2026-09-03T18:47:18.826Z",
  };

  assert.deepEqual(dedupeByUrl([older, newer]), [newer]);
});

test("does not title-dedupe other sources or different Money Stuff editions", () => {
  const otherSourceItems = [
    {
      source: "Another Source",
      title: "Repeated title",
      summary: "The same summary is deliberately reused here for two distinct source entries.",
      url: "https://example.com/first",
      publishedAt: "2026-09-03T18:00:00.000Z",
    },
    {
      source: "Another Source",
      title: "Repeated title",
      summary: "The same summary is deliberately reused here for two distinct source entries.",
      url: "https://example.com/second",
      publishedAt: "2026-09-03T18:20:00.000Z",
    },
  ];
  const distinctMoneyStuffItems = [
    {
      source: "Money Stuff (Bloomberg)",
      title: "A reused title",
      feedContentHtml: "<h2>First edition</h2><p>Distinct article body one.</p>",
      url: "https://kill-the-newsletter.com/feeds/money/entries/first.html",
      publishedAt: "2026-09-03T18:00:00.000Z",
    },
    {
      source: "Money Stuff (Bloomberg)",
      title: "A reused title",
      feedContentHtml: "<h2>Second edition</h2><p>Distinct article body two.</p>",
      url: "https://kill-the-newsletter.com/feeds/money/entries/second.html",
      publishedAt: "2026-09-03T18:20:00.000Z",
    },
  ];

  assert.equal(dedupeByUrl(otherSourceItems).length, 2);
  assert.equal(dedupeByUrl(distinctMoneyStuffItems).length, 2);
});
