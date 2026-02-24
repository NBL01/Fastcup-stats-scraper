# Fastcup Stats Wrapper

Simple Playwright scraper + local HTML report for Fastcup match stats.

## 1) Tools to install

- Node.js 18+
- npm (comes with Node)

Install dependencies and browsers (one-time setup):

```bash
npm install
npx playwright install chromium
```

## 2) Build this project

No build step. This is plain Node scripts.

## 3) Scrape stats

Scrape match stats (GraphQL JSON) into `out/`.
`<max_matches>` is how many recent matches to fetch.
Approx time (varies by connection): ~3–6 min for 100 matches, ~6–12 min for 200.

```bash
node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql <max_matches>  # scrape match data
```

Scrape all matches available for the user:

```bash
node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql 9999  # scrape all matches
```

Update only new matches (skip ones already in `out/`):

```bash
SKIP_EXISTING=1 node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql <max_matches>  # only new matches
```

Incremental update (remember last matches via `out/match_ids.json`):

```bash
INCREMENTAL=1 node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql <max_matches>  # only newly seen matches
```

If you need to resume or batch:

```bash
START_INDEX=0 MATCH_WAIT_MS=500 RESPONSE_TIMEOUT_MS=6000 \
  node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql <batch_size>  # resume/batch
```

## 4) Download map images (for heatmaps)

Heatmaps use radar images from HLTV. Run this after scraping so `GetMaps`
and match stats exist in `out/`:

```bash
node maps.mjs out  # download HLTV radar images for maps seen in matches
```

If you prefer npm:

```bash
npm run maps -- out  # same as above
```

If you see "Map image not found" in the report, rerun this step to refresh
missing map files.

## 5) Generate HTML report

Provide comma-separated nicknames (aliases are merged automatically when detected).
You can also pass numeric user IDs if you prefer:

```bash
node report.mjs out "NicknameOne,NicknameTwo,NicknameThree"  # build report for selected users
node report.mjs out "1234567,2345678"  # build report by user IDs
```

Output:

- `out/report.html` (you can move it to the project root if you prefer)

Generate a report for the top 15 most frequent players in the scraped matches
(fewer if the dataset contains less):

```bash
npm run report -- out  # auto-pick top 15 frequent players
```

You can also use the npm scripts:

```bash
npm run scrape -- "https://cs2.fastcup.net/id<user_id>/matches" out graphql <max_matches>  # scrape
npm run report -- out "NicknameOne,NicknameTwo,NicknameThree"  # generate HTML
```

Open `out/report.html` (or `report.html` if you move it) in your browser. The report includes player summaries
and a Matches tab with per-match stats and optional heatmaps (if maps are
downloaded).

If you want the report in the repo root:

```bash
mv out/report.html report.html
```

## 5b) Local control UI (recommended)

Run the local UI with a profile input + live scrape status:

```bash
npm run start
```

Open `http://localhost:5173` and paste a Fastcup profile link or user ID.
The UI shows matches found and scrape progress, then auto-reloads the report.
Use **Refresh (new)** to pull only recent matches (with a confirm prompt).

## 6) Inspect the scraped dataset (optional)

Print a quick table with file counts and sizes by dataset:

```bash
node summary.mjs out  # show dataset summary table
```

## Project structure

```
fc/
├─ out/                     # scraped JSON + maps/ (large, git-ignored)
├─ maps.mjs                 # download radar map images
├─ report.mjs               # HTML report generator
├─ scrape.mjs               # Playwright scraper (GraphQL JSON)
├─ stats.mjs                # stats + rating computation
├─ summary.mjs              # dataset summary table
├─ report.html              # optional: moved from out/
└─ README.md
```

## Notes

- Performance Compare uses a weekly Rating (KD + ADR + HS% + entry + clutch).
- Monthly expansions are still monthly (K/D, ADR, HS%, Top Weapons).
