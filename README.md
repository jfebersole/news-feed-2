# Signal Feed

Custom news feed app that aggregates the requested blogs, Substacks, NYT/Athletic writers, and other sources into a single stream.

## Features

- Aggregates all configured sources through RSS first.
- Auto-discovers feed links when possible.
- Falls back to HTML scraping when RSS is unavailable.
- De-duplicates stories by canonical URL.
- Caches results for 10 minutes to keep load times fast.
- Custom UI with source filters, keyword search, and one-click refresh.
- In-app reader for open sources with paywalled fallback excerpts.

## Run

If `npm` is missing, create a Node environment first:

```bash
conda create -y -n news-feed-node -c conda-forge nodejs=20
conda activate news-feed-node
```

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Node.js `20+` is required.

## Edit Sources

Update the `SOURCES` array in [`server.js`](./server.js) to add/remove feeds or adjust names.

## API

- `GET /api/feed`
  - Query params:
    - `limit` (number): max stories returned (default `180`)
    - `force=1`: bypass cache
- `GET /api/sources`
- `GET /api/article`
  - Query params:
    - `url` (required): article URL
    - `source` (optional): source name
    - `title` (optional): fallback title
    - `summary` (optional): fallback excerpt
