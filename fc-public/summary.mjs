import fs from "node:fs/promises";
import path from "node:path";

function bytesToMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function pad(value, width, alignRight = false) {
  const str = String(value);
  if (str.length >= width) return str;
  const padStr = " ".repeat(width - str.length);
  return alignRight ? padStr + str : str + padStr;
}

function renderTable(headers, rows) {
  const widths = headers.map((header, idx) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[idx]).length)
    )
  );

  const line = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;
  const headerLine = `| ${headers
    .map((header, idx) => pad(header, widths[idx]))
    .join(" | ")} |`;
  const bodyLines = rows.map(
    (row) =>
      `| ${row
        .map((cell, idx) => pad(cell, widths[idx], idx > 0 && idx < 4))
        .join(" | ")} |`
  );

  return [line, headerLine, line, ...bodyLines, line].join("\n");
}

async function main() {
  const outDir = process.argv[2] || "out";
  const files = await fs.readdir(outDir);

  const stats = new Map();
  let totalBytes = 0;
  let totalFiles = 0;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(outDir, file);
    const info = await fs.stat(filePath);
    totalBytes += info.size;
    totalFiles += 1;

    const match = file.match(/graphql-(.+?)(?:-(\\d+))?\\.json$/);
    const dataset = match ? match[1] : "other";
    const matchId = match && match[2] ? match[2] : null;

    if (!stats.has(dataset)) {
      stats.set(dataset, {
        files: 0,
        bytes: 0,
        matchIds: new Set(),
        example: file,
      });
    }
    const entry = stats.get(dataset);
    entry.files += 1;
    entry.bytes += info.size;
    if (matchId) entry.matchIds.add(matchId);
  }

  const rows = Array.from(stats.entries())
    .map(([dataset, entry]) => [
      dataset,
      entry.files,
      entry.matchIds.size || "-",
      `${bytesToMb(entry.bytes)} MB`,
      entry.example,
    ])
    .sort((a, b) => b[1] - a[1]);

  const table = renderTable(
    ["Dataset", "Files", "Match IDs", "Size", "Example File"],
    rows
  );

  process.stdout.write(
    `Out dir: ${outDir}\nFiles: ${totalFiles}\nSize: ${bytesToMb(
      totalBytes
    )} MB\n\n${table}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
