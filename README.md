# NEWS FEED

Static-first personal news feed app that aggregates your configured sources and publishes to GitHub Pages.

## Architecture

- UI is static (`public/index.html`, `public/app.js`, `public/styles.css`).
- Feed data is generated into `public/data/feed.json`.
- Reader payloads are generated into `public/data/articles/*.json`.
- A scheduled GitHub Actions workflow refreshes data every 15 minutes and commits updates.
- A Pages workflow deploys the `public/` directory.

## Local Development

If `npm` is missing, create a Node environment first:

```bash
conda create -y -n news-feed-node -c conda-forge nodejs=20
conda activate news-feed-node
```

Install deps:

```bash
npm install
```

Build static data:

```bash
npm run build:data
```

Run locally:

```bash
npm run dev
```

Then open `http://localhost:3000`.

Node.js `20+` is required.

## GitHub Pages Setup (Public Repo)

1. Push this project to a public GitHub repository.
2. In GitHub: `Settings -> Actions -> General -> Workflow permissions`
   - Set to `Read and write permissions` (needed so scheduled workflow can commit `public/data` updates).
3. In GitHub: `Settings -> Pages`
   - Set `Build and deployment` source to `GitHub Actions`.
4. In `Actions`, run `Update Static Feed` once manually.
5. Confirm `Deploy GitHub Pages` succeeds.
6. Open the Pages URL on laptop + phone.

### Workflows Included

- `.github/workflows/update-static-feed.yml`
  - Runs on schedule (`7,22,37,52 * * * *`) and manual dispatch.
  - Executes `npm run build:data`.
  - Commits updated `public/data` files.

- `.github/workflows/deploy-pages.yml`
  - Deploys `public/` to GitHub Pages on `main` pushes.

## Source Configuration

Update the `SOURCES` array in [`server.js`](./server.js).

### Source-Specific Item Rules

Add per-source filters in `SOURCE_ITEM_RULES` in [`server.js`](./server.js).  
Current example:

- `Astral Codex Ten`: exclude items where the title contains `open thread` (case-insensitive).
- `Neil Paine`: exclude items where description contains `Subscribe to Scoreboard`, and exclude items with emojis in the title.
- `Slow Boring`: exclude items where the title contains `discussion post` (case-insensitive).
- `J. Kenji López-Alt`: exclude Patreon's signup-confirmation email from the Kill the Newsletter feed.

For a source that publishes unwanted items in a separate RSS section, add `excludeFeedUrl` to its entry
in `SOURCES`. Items from the main feed are matched by canonical URL against that exclusion feed. If the
exclusion feed cannot provide valid item URLs, the source fails closed or uses the RSS proxy fallback
instead of allowing unwanted items through.

`Silver Bulletin` uses its `Models & Forecasts` section as an exclusion feed, so the main feed retains
articles while omitting updating dashboards, rankings, and prediction pages.

### Substack Paywall Flags

Substack sources opt into per-article detection with `accessStrategy: "substack-rss"` in
[`server.js`](./server.js). The feed builder looks for Substack's terminal paid-preview marker and writes:

- `access: "paywalled"` for any restricted article.
- `paywallType: "partial"` when the public feed includes a meaningful preview.
- `paywallType: "full"` when little or no article text is public.

The homepage displays a lock beside the article date for either paywall type. For a publication-specific
exception, add `accessRules.openTitleIncludes` or `accessRules.paywalledTitleIncludes` to that source;
`accessRules.paywalledTitleType` can be `"partial"` (default) or `"full"`.

### Substack CI Fallback

Some `*.substack.com` feeds may return `403` from GitHub Actions IP ranges.  
The fetcher now includes a Substack-only RSS proxy fallback.

Optional environment variables:

- `SUBSTACK_PROXY_FALLBACK_ENABLED` (default: `1`)
- `RSS_PROXY_TEMPLATE` (template with `{url}` placeholder)
- `RSS2JSON_API_KEY` (used with default proxy endpoint if set)

## Notes

- This setup is optimized for personal use and fast page loads.
- Because the repo is public, generated feed/article JSON is public too.
- Paywalled sources stay excerpt-only in generated reader payloads.

## Static Feed Window

Optional build-time environment variables:

- `STATIC_MAX_AGE_DAYS` (default: `30`) includes only items with `publishedAt` in the last N days.
- `STATIC_REFRESH_RECENT_COUNT` (default: `40`) rebuilds article payloads for the newest N retained items.
- `STATIC_CONCURRENCY` (default: `5`) controls article payload fetch/build concurrency.
