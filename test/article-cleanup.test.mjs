import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { extractArticleFromHtml } = await import("../server.js");

test("removes the promotional image tail from fetched Money Stuff articles", () => {
  const article = extractArticleFromHtml({
    html: `
      <html><head><title>Money Stuff Test</title></head><body><article>
        <h2>The actual article</h2>
        <p>This is substantive article copy that must remain in the reader after source cleanup.</p>
        <img src="https://example.com/chart.png" alt="A useful chart">
        <p id="footnote-1">[1] A final substantive footnote after the useful chart.</p>
        <img src="https://assets.bwbx.io/podcast.png" alt="Listen to the Money Stuff Podcast">
        <img src="https://assets.bwbx.io/footer-one.png">
        <img src="https://assets.bwbx.io/footer-two.png">
        <img src="https://assets.bwbx.io/ad-choices.png" alt="Ad Choices">
      </article></body></html>
    `,
    url: "https://kill-the-newsletter.com/feeds/money/entries/test.html",
    sourceName: "Money Stuff (Bloomberg)",
  });

  assert.match(article.contentHtml, /The actual article/);
  assert.match(article.contentHtml, /chart\.png/);
  assert.doesNotMatch(article.contentHtml, /Money Stuff Podcast|footer-one|footer-two|Ad Choices/i);
  assert.equal(article.imageCount, 1);
});

test("flattens fetched Brew Shop email layout tables into reader blocks", () => {
  const article = extractArticleFromHtml({
    html: `
      <html><head><title>Brew Shop Test</title></head><body><article>
        <table id="bodyTable"><tbody><tr><td><table><tbody>
          <tr><td><p><a href="https://example.com/browser">View this email in your browser</a></p></td></tr>
          <tr><td><img src="https://example.com/beer.jpg" width="520"></td></tr>
          <tr><td><p>Hey Brew Shop Fam! Here are this week's new beer drops and tasting notes.</p></td></tr>
          <tr><td><table><tbody>
            <tr>
              <td><img src="https://example.com/beer-one.jpg" width="298"><p>Beer one has a detailed description for the weekly update.</p></td>
              <td><img src="https://example.com/beer-two.jpg" width="298"><p>Beer two has another detailed description.</p></td>
            </tr>
            <tr><td>Beer three has enough copy to resemble tabular data.</td><td>Beer four completes the email product grid.</td></tr>
          </tbody></table></td></tr>
        </tbody></table></td></tr></tbody></table>
      </article></body></html>
    `,
    url: "https://kill-the-newsletter.com/feeds/brew/entries/test.html",
    sourceName: "Brew Shop",
  });

  assert.doesNotMatch(article.contentHtml, /<table|<tbody|<tr|<td/i);
  assert.doesNotMatch(article.contentHtml, /View this email in your browser/i);
  assert.match(article.contentHtml, /beer\.jpg/);
  assert.match(article.contentHtml, /Hey Brew Shop Fam/);
  assert.match(article.contentHtml, /class="reader-image-row reader-brew-grid"/);
  assert.match(article.contentHtml, /<figure><img[^>]+beer-one\.jpg[\s\S]+<figcaption><p>Beer one/);
  assert.match(article.contentHtml, /<figure><img[^>]+beer-two\.jpg[\s\S]+<figcaption><p>Beer two/);
});

test("removes the Listen to this post label from fetched Stratechery articles", () => {
  const article = extractArticleFromHtml({
    html: `
      <html><head><title>Stratechery Test</title></head><body><article>
        <p><strong>Listen to this post:</strong></p>
        <p>The actual Stratechery article begins here and should remain untouched.</p>
      </article></body></html>
    `,
    url: "https://stratechery.com/2026/test/",
    sourceName: "Stratechery",
  });

  assert.doesNotMatch(article.contentHtml, /Listen to this post/i);
  assert.match(article.contentHtml, /actual Stratechery article/);
});

test("keeps a repeated Capital Weather description in the body instead of the subtitle", () => {
  const happeningNow =
    "HAPPENING NOW: Partly sunny today with humidity slow to budge and highs in the mid- to upper 80s.";
  const html = `
    <html><head>
      <title>DC-area forecast test</title>
      <meta property="og:description" content="${happeningNow}">
    </head><body><article>
      <p><em>Always a human at the helm: Updated around-the-clock by Capital Weather meteorologists.</em></p>
      <p><strong>Happening now: </strong>Partly sunny today with humidity slow to budge and highs in the mid- to upper 80s.</p>
      <p><strong>What’s next?</strong> Nicer tomorrow into the weekend.</p>
    </article></body></html>
  `;
  const article = extractArticleFromHtml({
    html,
    url: "https://www.capitalweather.com/dc-area-forecast-test/",
    sourceName: "Capital Weather",
  });

  assert.equal(article.subtitle, null);
  assert.match(article.contentHtml, /<strong>Happening now: <\/strong>Partly sunny today/);

  const otherSourceArticle = extractArticleFromHtml({
    html,
    url: "https://example.com/forecast-test/",
    sourceName: "Another Source",
  });
  assert.equal(otherSourceArticle.subtitle, happeningNow);
});
