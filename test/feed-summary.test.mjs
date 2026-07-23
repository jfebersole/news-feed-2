import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { cleanFeedSummary } = await import("../server.js");

test("removes the Money Stuff email header from feed previews", () => {
  const summary = cleanFeedSummary(
    `
      <p>Money Stuff</p>
      <p>Phones, 351s, lockups, zombies.</p>
      <a href="https://example.com">View in browser</a>
      <h2>Personal phones</h2>
      <p>It was illegal, from about 2021 through about 2025, for employees of financial firms to text.</p>
    `,
    "Money Stuff (Bloomberg)"
  );

  assert.equal(
    summary,
    "Personal phones It was illegal, from about 2021 through about 2025, for employees of financial firms to text."
  );
});

test("does not apply the loose View in browser rule to other sources", () => {
  const summary = cleanFeedSummary(
    "A normal introduction. View in browser The article begins here.",
    "Another Source"
  );

  assert.equal(summary, "A normal introduction. View in browser The article begins here.");
});
