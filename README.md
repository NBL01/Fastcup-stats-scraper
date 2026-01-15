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

If you need to resume or batch:

```bash
START_INDEX=0 MATCH_WAIT_MS=500 RESPONSE_TIMEOUT_MS=6000 \
  node scrape.mjs "https://cs2.fastcup.net/id<user_id>/matches" out graphql <batch_size>  # resume/batch
```

## 4) Generate HTML report

Provide comma-separated nicknames (aliases are merged automatically when detected).
You can also pass numeric user IDs if you prefer:

```bash
node report.mjs out "NicknameOne,NicknameTwo,NicknameThree"  # build report for selected users
node report.mjs out "1234567,2345678"  # build report by user IDs
```

Output:

- `out/report.html`

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
