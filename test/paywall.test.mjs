import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { classifyFeedItemAccess } = await import("../server.js");

const substackSource = {
  name: "Example Substack",
  url: "https://example.substack.com/",
  feedUrl: "https://example.substack.com/feed",
  accessStrategy: "substack-rss",
};

test("flags a Substack post with a public preview as partially paywalled", () => {
  const url = "https://example.substack.com/p/paid-preview";
  const preview = `
    <p>This public introduction contains enough words to be a meaningful preview of the article before
    readers encounter the subscription wall and need to become paid members to finish the whole piece.</p>
    <p><a href="${url}">Read more</a></p>
  `;

  assert.deepEqual(
    classifyFeedItemAccess(substackSource, {
      title: "Paid preview",
      url,
      contentCandidates: [preview],
    }),
    { access: "paywalled", paywallType: "partial" }
  );
});

test("flags a Substack post with no meaningful preview as fully paywalled", () => {
  const url = "https://example.substack.com/p/paid-post";
  const preview = `<figure><img src="cover.jpg"></figure><p><a href="${url}">Read more</a></p>`;

  assert.deepEqual(
    classifyFeedItemAccess(substackSource, {
      title: "Paid post",
      url,
      contentCandidates: [preview],
    }),
    { access: "paywalled", paywallType: "full" }
  );
});

test("does not mistake an inline Read more link for a Substack paywall", () => {
  const url = "https://example.substack.com/p/free-post";
  const article = `
    <p><a href="https://example.com/background">Read more</a></p>
    <p>The complete free article continues after that link and ends with its own concluding paragraph.</p>
  `;

  assert.deepEqual(
    classifyFeedItemAccess(substackSource, {
      title: "Free post",
      url,
      contentCandidates: [article],
    }),
    { access: "open" }
  );
});

test("supports source-specific title overrides when a proxy removes paywall markup", () => {
  const source = {
    ...substackSource,
    accessRules: {
      paywalledTitleIncludes: ["subscriber mailbag"],
      paywalledTitleType: "full",
    },
  };

  assert.deepEqual(
    classifyFeedItemAccess(source, {
      title: "The subscriber mailbag",
      url: "https://example.substack.com/p/subscriber-mailbag",
      contentCandidates: ["Questions and answers."],
    }),
    { access: "paywalled", paywallType: "full" }
  );
});

test("uses RSS preview depth before a title fallback when both are available", () => {
  const url = "https://example.substack.com/p/subscriber-mailbag";
  const source = {
    ...substackSource,
    accessRules: { paywalledTitleIncludes: ["subscriber mailbag"] },
  };

  assert.deepEqual(
    classifyFeedItemAccess(source, {
      title: "The subscriber mailbag",
      url,
      contentCandidates: [`<p>Questions welcome.</p><p><a href="${url}">Read more</a></p>`],
    }),
    { access: "paywalled", paywallType: "full" }
  );
});
