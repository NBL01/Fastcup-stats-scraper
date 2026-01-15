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

  let counter = 0;
  const seen = new Set();
  const matchIdsFromResponses = new Set();

  function extractMatchIds(value) {
    const ids = new Set();
    const stack = [value];

    while (stack.length) {
      const current = stack.pop();
      if (!current) continue;
      if (Array.isArray(current)) {
        for (const item of current) stack.push(item);
        continue;
      }
      if (typeof current === "object") {
        for (const [key, item] of Object.entries(current)) {
          if ((key === "matchId" || key === "match_id") && item) {
            ids.add(String(item));
          }
          if (key === "id" && typeof item === "number") {
            // Heuristic: match ids are long numeric ids.
            if (String(item).length >= 7) ids.add(String(item));
          }
          stack.push(item);
        }
      }
    }

    return ids;
  }

  function hasMatchPayload(value) {
    if (!value || typeof value !== "object") return false;
    if (value.match || value.matchByPk || value.matchById) return true;
    if (Array.isArray(value.matches) && value.matches.length) return true;
    return false;
  }

  page.on("response", async (response) => {
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

      if (bodyJson) {
        for (const matchId of extractMatchIds(bodyJson)) {
          matchIdsFromResponses.add(matchId);
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
  for (let i = 0; i < 10; i += 1) {
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

  let uniqueIds = Array.from(new Set([...matchIds, ...matchIdsFromResponses]));
  const idsFile = path.join(outDir, "match_ids.json");

  try {
    const saved = JSON.parse(await fs.readFile(idsFile, "utf8"));
    if (Array.isArray(saved) && saved.length) {
      uniqueIds = saved;
    }
  } catch {
    await fs.writeFile(idsFile, JSON.stringify(uniqueIds, null, 2), "utf8");
  }

  const selectedIds = uniqueIds.slice(startIndex, startIndex + maxMatches);
  process.stdout.write(
    `found ${uniqueIds.length} match id(s); processing ${selectedIds.length} from index ${startIndex}\n`
  );

  for (const matchId of selectedIds) {
    const statsUrl = `https://cs2.fastcup.net/matches/${matchId}/stats`;
    await page.goto(statsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(matchWaitMs);

    // Try to capture inline Nuxt payload if present.
    const nuxtPayload = await page.evaluate(() => {
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

    // Wait for a GraphQL match response tied to this match ID.
    try {
      const response = await page.waitForResponse((res) => {
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
  }

  // Give any late network calls a chance to finish.
  await page.waitForTimeout(2000);

  await browser.close();
  process.stdout.write(`done, saved ${counter} JSON response(s)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
