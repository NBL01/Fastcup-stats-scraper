import fs from "node:fs/promises";
import path from "node:path";

const RADAR_BASE =
  "https://www.hltv.org/img/static/stats/heatmap/new/";

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function isPng(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a";
}

async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

async function main() {
  const outDir = process.argv[2] || "out";
  const mapsDir = path.join(outDir, "maps");
  await fs.mkdir(mapsDir, { recursive: true });

  const files = await fs.readdir(outDir);
  const mapsFile = files.filter((f) => f.includes("GetMaps")).sort().pop();
  if (!mapsFile) {
    throw new Error("No GetMaps JSON found in out/");
  }

  const mapById = new Map();
  const mapsData = await readJson(path.join(outDir, mapsFile));
  for (const map of mapsData.data?.maps || []) {
    if (map?.id) mapById.set(map.id, map);
  }

  const statsFiles = files.filter((f) => f.includes("GetMatchStats"));
  const rawNames = new Set();
  for (const file of statsFiles) {
    const data = await readJson(path.join(outDir, file));
    const match = data.data?.match;
    const mapEntry = match?.maps?.[0];
    const mapId = mapEntry?.mapId || mapEntry?.map?.id || null;
    const mapMeta = mapId ? mapById.get(mapId) || null : null;
    const rawName = mapMeta?.rawName || mapEntry?.map?.rawName || null;
    if (rawName && /^(de|cs|ar|dz|gd)_/i.test(rawName)) {
      rawNames.add(rawName);
    }
  }

  if (rawNames.size === 0) {
    process.stderr.write(
      "warning: no radar-compatible map names found in match stats; skipping map downloads.\n"
    );
    return;
  }

  const mapFiles = new Set(
    Array.from(rawNames).map((raw) => `${raw}_radar_trans.png`)
  );

  const existingFiles = await fs.readdir(mapsDir);
  await Promise.all(
    existingFiles.map((file) => {
      if (!mapFiles.has(file)) {
        return fs.unlink(path.join(mapsDir, file)).catch(() => null);
      }
      return null;
    })
  );

  let downloaded = 0;
  let skipped = 0;

  for (const file of mapFiles) {
    const dest = path.join(mapsDir, file);
    let hasValid = false;

    try {
      const existing = await fs.readFile(dest);
      if (isPng(existing)) {
        skipped += 1;
        continue;
      }
    } catch {
      // No existing file.
    }

    const url = RADAR_BASE + file;
    try {
      const buffer = await fetchBinary(url);
      if (!buffer || buffer.length < 10) {
        throw new Error("empty");
      }
      await fs.writeFile(dest, buffer);
      downloaded += 1;
      hasValid = true;
      process.stdout.write(`downloaded ${file}\n`);
    } catch {
      process.stdout.write(`failed ${file}\n`);
    }
  }

  process.stdout.write(
    `done, downloaded=${downloaded}, skipped=${skipped}, total=${mapFiles.size}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
