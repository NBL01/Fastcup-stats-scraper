import fs from "node:fs/promises";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";

const DEFAULT_URL = "https://cs2.fastcup.net/id1315180/matches";

function sanitizeFilename(input) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

async function main() {
  const targetUrl = process.argv[2] || DEFAULT_URL;
  const outDir = process.argv[3] || "out";
  const urlFilter = process.argv[4] || "";
  const maxMatches = Number(process.argv[5] || 115);
  const headless = process.env.HEADLESS !== "0";
  const slowMo = Number(process.env.SLOW_MO || 0);
  const browserName = process.env.BROWSER || "chromium";
  const startIndex = Number(process.env.START_INDEX || 0);
  const matchWaitMs = Number(process.env.MATCH_WAIT_MS || 800);
  const responseTimeoutMs = Number(process.env.RESPONSE_TIMEOUT_MS || 8000);
  const gotoRetries = Number(process.env.GOTO_RETRIES || 3);
  const gotoRetryDelayMs = Number(process.env.GOTO_RETRY_DELAY_MS || 1200);
  const skipExisting = process.env.SKIP_EXISTING === "1";
  const incremental = process.env.INCREMENTAL === "1";

  await fs.mkdir(outDir, { recursive: true });

  const browserType =
    browserName === "firefox"
      ? firefox
      : browserName === "webkit"
      ? webkit
      : chromium;

  const launchOptions = {
    headless,
    slowMo,
  };

  if (browserType === chromium) {
    launchOptions.chromiumSandbox = false;
    launchOptions.args = ["--no-sandbox", "--disable-setuid-sandbox"];
  }

  const browser = await browserType.launch(launchOptions);
  const context = await browser.newContext();
  const page = await context.newPage();
  const workerCount = Math.max(1, Number(process.env.SCRAPE_WORKERS || "1"));

  let counter = 0;
  const seen = new Set();
  const matchIdsFromResponses = new Set();

  function hasMatchPayload(value) {
    if (!value || typeof value !== "object") return false;
    if (value.match || value.matchByPk || value.matchById) return true;
    if (Array.isArray(value.matches) && value.matches.length) return true;
    return false;
  }

  context.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("fastcup.net")) return;
      const request = response.request();
      const postData = request.postData() || "";

      let operationName = "";
      let variables = null;
      if (url.includes("graphql") && postData) {
        try {
          const parsed = JSON.parse(postData);
          operationName = parsed.operationName || "";
          variables = parsed.variables || null;
        } catch {
          // Ignore malformed JSON and continue.
        }
      }

      if (urlFilter) {
        const filterHit =
          url.includes(urlFilter) ||
          postData.includes(urlFilter) ||
          (operationName && operationName.includes(urlFilter));
        if (!filterHit) return;
      }

      const contentType = response.headers()["content-type"] || "";
      if (
        !contentType.includes("application/json") &&
        !contentType.includes("application/graphql-response+json")
      ) {
        return;
      }

      const bodyText = await response.text();
      let bodyJson = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        // Ignore JSON parse errors.
      }

      if (bodyJson?.data?.matchMemberships?.length) {
        for (const membership of bodyJson.data.matchMemberships) {
          const matchId = membership?.match?.id;
          if (matchId) matchIdsFromResponses.add(String(matchId));
        }
      }

      if (bodyJson && !hasMatchPayload(bodyJson) && !operationName) {
        // Skip non-match payloads to avoid noise unless this is a named GraphQL op.
        return;
      }

      const matchIdValue = variables?.matchId || variables?.match_id || "";

      // Prevent duplicate saves for identical URLs and operations per match.
      const dedupeKey = `${url}|${operationName}|${matchIdValue || postData}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      let filename = `${String(counter).padStart(3, "0")}-${sanitizeFilename(
        url
      )}.json`;
      if (operationName) {
        const suffix = matchIdValue ? `-${matchIdValue}` : "";
        filename = `${String(counter).padStart(3, "0")}-graphql-${sanitizeFilename(
          operationName
        )}${suffix}.json`;
      }
      counter += 1;

      const payloadText = bodyJson ? JSON.stringify(bodyJson, null, 2) : bodyText;
      await fs.writeFile(path.join(outDir, filename), payloadText, "utf8");
      process.stdout.write(`saved ${filename}\n`);
    } catch (err) {
      process.stderr.write(`response handler error: ${err}\n`);
    }
  });

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

  // Scroll to trigger lazy-loaded match entries and their stats requests.
  const maxScrolls = Number(process.env.SCROLL_ITERATIONS || 20);
  let lastMatchLinkCount = 0;
  let lastResponseIdCount = 0;
  let stagnantRounds = 0;
  for (let i = 0; i < maxScrolls; i += 1) {
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      let target =
        document.scrollingElement || document.documentElement || document.body;
      let maxScroll = 0;
      for (const el of all) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === "visible") continue;
        const scrollable = el.scrollHeight - el.clientHeight;
        if (scrollable > maxScroll) {
          maxScroll = scrollable;
          target = el;
        }
      }
      target.scrollTop = target.scrollHeight;
    });
    await page.waitForTimeout(1500);

    const linkCount = await page.$$eval("a[href*='/matches/']", (anchors) => {
      return anchors.length;
    });
    const responseCount = matchIdsFromResponses.size;
    if (linkCount === lastMatchLinkCount && responseCount === lastResponseIdCount) {
      stagnantRounds += 1;
      if (stagnantRounds >= 2) break;
    } else {
      stagnantRounds = 0;
      lastMatchLinkCount = linkCount;
      lastResponseIdCount = responseCount;
    }
  }

  // Collect match links from the matches page.
  try {
    await page.waitForSelector("a[href*='/matches/']", { timeout: 10000 });
  } catch {
    // Continue with fallback extraction if links are hidden.
  }

  let matchLinks = await page.$$eval("a[href*='/matches/']", (anchors) => {
    const links = anchors
      .map((a) => a.getAttribute("href"))
      .filter(Boolean)
      .map((href) =>
        href.startsWith("http") ? href : `https://cs2.fastcup.net${href}`
      );

    return Array.from(new Set(links));
  });

  if (matchLinks.length === 0) {
    const html = await page.content();
    const regexMatches = Array.from(
      new Set(html.match(/\/matches\/\d+/g) || [])
    );
    matchLinks = regexMatches.map(
      (partial) => `https://cs2.fastcup.net${partial}`
    );
  }

  const matchIds = matchLinks
    .map((link) => {
      const match = link.match(/\/matches\/(\d+)/);
      return match ? match[1] : null;
    })
    .filter(Boolean);

  const idsFile = path.join(outDir, "match_ids.json");

  const allIds = Array.from(new Set([...matchIds, ...matchIdsFromResponses]));
  const sortedAllIds = allIds.sort((a, b) => Number(b) - Number(a));

  let missingIds = sortedAllIds;
  if (skipExisting) {
    const existingIds = new Set();
    const outFiles = await fs.readdir(outDir);
    for (const file of outFiles) {
      const match = file.match(/GetMatchStats-(\d+)\.json$/);
      if (match) existingIds.add(match[1]);
      const matchGraph = file.match(/graphql-match-(\d+)\.json$/);
      if (matchGraph) existingIds.add(matchGraph[1]);
      const nuxtMatch = file.match(/stats-(\d+)\.json$/);
      if (nuxtMatch) existingIds.add(nuxtMatch[1]);
    }
    missingIds = sortedAllIds.filter((id) => !existingIds.has(id));
  }

  let selectedIds = missingIds.slice(startIndex, startIndex + maxMatches);

  if (incremental) {
    const savedSet = new Set();
    try {
      const saved = JSON.parse(await fs.readFile(idsFile, "utf8"));
      if (Array.isArray(saved)) {
        for (const id of saved) savedSet.add(String(id));
      }
    } catch {
      // No saved ids yet.
    }
    selectedIds = selectedIds.filter((id) => !savedSet.has(id));
  }

  await fs.writeFile(idsFile, JSON.stringify(sortedAllIds, null, 2), "utf8");
  process.stdout.write(
    `found ${sortedAllIds.length} match id(s); processing ${selectedIds.length} from index ${startIndex}\n`
  );

  const existingCount = sortedAllIds.length - missingIds.length;
  process.stdout.write(
    `PROGRESS total=${selectedIds.length} found=${sortedAllIds.length} existing=${existingCount}\n`
  );

  let processed = 0;
  const failedMatchIds = [];
  let nextIndex = 0;

  const scrapeMatch = async (pageInstance, matchId) => {
    const statsUrl = `https://cs2.fastcup.net/matches/${matchId}/stats`;
    let navigated = false;
    let lastError = null;
    for (let attempt = 1; attempt <= gotoRetries; attempt += 1) {
      try {
        await pageInstance.goto(statsUrl, { waitUntil: "domcontentloaded" });
        navigated = true;
        break;
      } catch (err) {
        lastError = err;
        process.stderr.write(
          `goto failed for ${matchId} (attempt ${attempt}/${gotoRetries})\n`
        );
        if (attempt < gotoRetries) {
          await pageInstance.waitForTimeout(gotoRetryDelayMs * attempt);
        }
      }
    }
    if (!navigated) {
      failedMatchIds.push(String(matchId));
      process.stderr.write(
        `skipping ${matchId}: failed to navigate after ${gotoRetries} attempt(s)\n`
      );
      return;
    }
    await pageInstance.waitForTimeout(matchWaitMs);

    const nuxtPayload = await pageInstance.evaluate(() => {
      if (typeof window.__NUXT__ !== "undefined") {
        return window.__NUXT__;
      }
      if (typeof window.__NUXT__STATE__ !== "undefined") {
        return window.__NUXT__STATE__;
      }
      return null;
    });

    if (nuxtPayload) {
      const filename = `${String(counter).padStart(3, "0")}-stats-${matchId}.json`;
      counter += 1;
      await fs.writeFile(
        path.join(outDir, filename),
        JSON.stringify(nuxtPayload, null, 2),
        "utf8"
      );
      process.stdout.write(`saved ${filename}\n`);
    }

    try {
      const response = await pageInstance.waitForResponse((res) => {
        if (!res.url().includes("graphql")) return false;
        const postData = res.request().postData() || "";
        return postData.includes(`"matchId":${matchId}`) || postData.includes(`"match_id":${matchId}`);
      }, { timeout: responseTimeoutMs });

      const bodyText = await response.text();
      const filename = `${String(counter).padStart(3, "0")}-graphql-match-${matchId}.json`;
      counter += 1;
      await fs.writeFile(path.join(outDir, filename), bodyText, "utf8");
      process.stdout.write(`saved ${filename}\n`);
    } catch {
      // No match response within timeout.
    }
  };

  const worker = async (pageInstance) => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= selectedIds.length) break;
      const matchId = selectedIds[currentIndex];
      processed += 1;
      process.stdout.write(
        `PROGRESS current=${processed} total=${selectedIds.length}\n`
      );
      await scrapeMatch(pageInstance, matchId);
    }
  };

  const pages = await Promise.all(
    Array.from({ length: workerCount }, () => context.newPage())
  );
  await Promise.all(pages.map((p) => worker(p)));
  await Promise.all(pages.map((p) => p.close()));

  // Give any late network calls a chance to finish.
  await page.waitForTimeout(2000);

  await browser.close();
  if (failedMatchIds.length > 0) {
    process.stderr.write(
      `failed matches: ${failedMatchIds.length} (${failedMatchIds
        .slice(0, 10)
        .join(", ")})\n`
    );
  }
  process.stdout.write(`done, saved ${counter} JSON response(s)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
