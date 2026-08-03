import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { buildArticlePayload, cleanFeedSummary, extractArticleFromHtml } = await import("../server.js");

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

test("keeps links in very short Marginal Revolution posts and removes its RSS footer", async () => {
  const description = "Here is criticism from Revana Sharfuddin. Here is criticism from JFV.";
  const article = extractArticleFromHtml({
    html: `
      <html><head>
        <title>On the fertility result</title>
        <meta property="og:description" content="${description}">
      </head><body><article><div class="entry-content">
        <p>Here is <a href="https://example.com/revana">criticism from Revana Sharfuddin</a>.
        Here is <a href="https://example.com/jfv">criticism from JFV</a>.</p>
      </div></article></body></html>
    `,
    url: "https://marginalrevolution.com/marginalrevolution/2026/08/test.html",
    sourceName: "Marginal Revolution",
  });

  assert.equal(article.subtitle, null);
  assert.equal(article.linkCount, 2);
  assert.match(article.contentHtml, /href="https:\/\/example\.com\/revana"/);
  assert.match(article.contentHtml, /href="https:\/\/example\.com\/jfv"/);

  const feedContentHtml = `
    <p>Here is <a href="https://example.com/revana">criticism from Revana Sharfuddin</a>.
    Here is <a href="https://example.com/jfv">criticism from JFV</a>.</p>
    <p>The post <a href="https://marginalrevolution.com/test">On the fertility result</a>
    appeared first on <a href="https://marginalrevolution.com">Marginal REVOLUTION</a>.</p>
  `;
  const fallback = await buildArticlePayload({
    url: "data:text/html,<html><body><p>Unavailable</p></body></html>",
    sourceName: "Marginal Revolution",
    fallbackTitle: "On the fertility result",
    fallbackSummary: cleanFeedSummary(feedContentHtml, "Marginal Revolution"),
    fallbackContentHtml: feedContentHtml,
    accessLevel: "open",
  });

  assert.equal(fallback.mode, "full");
  assert.equal(fallback.linkCount, 2);
  assert.doesNotMatch(fallback.contentHtml, /appeared first on|The post/i);
  assert.doesNotMatch(cleanFeedSummary(feedContentHtml, "Marginal Revolution"), /appeared first on|The post/i);
});

test("renders Substack prediction-market and X embeds as reader cards", () => {
  const predictionAttrs = JSON.stringify({
    url: "https://manifold.markets/embed/strutheo/will-linear-a",
    thumbnail_url: "https://substack-post-media.s3.amazonaws.com/linear-a.png",
  }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const secondPredictionAttrs = JSON.stringify({
    url: "https://www.metaculus.com/questions/embed/43900/",
    thumbnail_url: "https://substack-post-media.s3.amazonaws.com/metaculus.png",
  }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const tweetAttrs = JSON.stringify({
    url: "https://x.com/juddrosenblatt/status/123",
    full_text: "We're hiring AI engineers.\n\nThe thesis may contain something useful.",
    username: "juddrosenblatt",
    name: "Judd Rosenblatt",
    profile_image_url: "https://pbs.substack.com/profile.jpg",
    date: "2026-06-22T22:33:52.000Z",
    reply_count: 109,
    retweet_count: 36,
    like_count: 705,
    impression_count: 332000,
    quoted_tweet: {
      full_text: "A strange signal keeps showing up in my personal life.",
      username: "shiraeis",
      name: "shira",
    },
  }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const article = extractArticleFromHtml({
    html: `
      <html><head><title>ACX embeds</title></head><body><article>
        <p><strong>46:</strong> The markets are skeptical:</p>
        <div data-component-name="PredictionMarketToDOM" data-attrs="${predictionAttrs}">
          <iframe src="https://manifold.markets/embed/strutheo/will-linear-a"></iframe>
        </div>
        <div data-component-name="PredictionMarketToDOM" data-attrs="${secondPredictionAttrs}">
          <iframe src="https://www.metaculus.com/questions/embed/43900/"></iframe>
        </div>
        <p><strong>48:</strong> More interesting things happening in AI alignment:</p>
        <a href="https://x.com/juddrosenblatt/status/123" data-component-name="Twitter2ToDOM">
          <div data-attrs="${tweetAttrs}">Unstyled fallback tweet content</div>
        </a>
      </article></body></html>
    `,
    url: "https://www.astralcodexten.com/p/acx-embeds",
    sourceName: "Astral Codex Ten",
  });

  assert.match(article.contentHtml, /class="reader-embed-card reader-prediction-embed"/);
  assert.match(article.contentHtml, /substack-post-media\.s3\.amazonaws\.com\/linear-a\.png/);
  assert.match(article.contentHtml, /manifold\.markets\/embed\/strutheo\/will-linear-a/);
  assert.match(article.contentHtml, /metaculus\.com\/questions\/embed\/43900/);
  assert.equal((article.contentHtml.match(/reader-prediction-embed/g) || []).length, 2);
  assert.match(article.contentHtml, /class="reader-embed-card reader-social-embed"/);
  assert.match(article.contentHtml, /Judd Rosenblatt/);
  assert.match(article.contentHtml, /We(?:'|&#x27;)re hiring AI engineers/);
  assert.match(article.contentHtml, /A strange signal keeps showing up/);
  assert.doesNotMatch(article.contentHtml, /<iframe/i);
});
