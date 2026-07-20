import test from "node:test";
import assert from "node:assert/strict";

process.env.NEWS_FEED_DISABLE_SERVER = "1";
const { extractDailyDigit } = await import("../server.js");

test("extracts the current Capital Weather daily-digit format", () => {
  assert.deepEqual(
    extractDailyDigit(
      "<p><strong>Today’s daily digit — 8/10: </strong>Worry-free weather today. | 🤚 <a>Your call</a>?<br><em>The digit is subjective.</em></p>"
    ),
    {
      value: 8,
      summary: "Worry-free weather today.",
    }
  );
});

test("accepts the site's past-tense daily-digit wording and a 10", () => {
  assert.deepEqual(extractDailyDigit("Today’s daily digit was — 10/10: A perfect day. | Your call?"), {
    value: 10,
    summary: "A perfect day.",
  });
});

test("decodes the numeric dash entity used by the RSS feed", () => {
  assert.deepEqual(extractDailyDigit("Today&apos;s daily digit &#x2014; 6/10: Some clouds. | Your call?"), {
    value: 6,
    summary: "Some clouds.",
  });
});

test("rejects text without a valid rating", () => {
  assert.equal(extractDailyDigit("Today's forecast is warm and sunny."), null);
  assert.equal(extractDailyDigit("Today's daily digit — 11/10: Impossible."), null);
});
