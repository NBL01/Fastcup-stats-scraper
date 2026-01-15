import fs from "node:fs/promises";
import path from "node:path";
import { computeStats } from "./stats.mjs";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function getTopPlayers(outDir, limit) {
  const files = await fs.readdir(outDir);
  const statsFiles = files.filter((file) => file.includes("GetMatchStats-"));
  const counts = new Map();

  for (const file of statsFiles) {
    const data = await readJson(path.join(outDir, file));
    const match = data.data?.match;
    const members = match?.members || [];
    const matchAt = match?.startedAt ? new Date(match.startedAt).getTime() : 0;

    for (const member of members) {
      const id = member.private?.user?.id;
      const nick = member.private?.user?.nickName;
      if (!id) continue;
      const entry = counts.get(id) || { count: 0, name: null, at: 0 };
      entry.count += 1;
      if (nick && matchAt >= entry.at) {
        entry.name = nick;
        entry.at = matchAt;
      }
      counts.set(id, entry);
    }
  }

  return Array.from(counts.entries())
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, limit);
}

async function main() {
  const outDir = process.argv[2] || "out";
  const targetArg = process.argv[3] || "";
  const outputFile = process.argv[4] || path.join(outDir, "report.html");

  const normalizeKey = (value) =>
    String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const rawTargets = targetArg
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const aliasGroups = [["NE-Krinzhanul", "Krinzhanul"]];
  let targets = [];
  const headerLabel = rawTargets.length === 0 ? "Top 15 players" : targetArg;

  if (rawTargets.length === 0) {
    const topPlayers = await getTopPlayers(outDir, 15);
    targets = topPlayers.map((player) => String(player.id));
  } else {
    targets = [...rawTargets];
  }

  for (const group of aliasGroups) {
    const present = group.filter((name) =>
      targets.some((entry) => entry.toLowerCase() === name.toLowerCase())
    );
    if (present.length) {
      targets = targets.filter(
        (entry) => !group.some((name) => entry.toLowerCase() === name.toLowerCase())
      );
      targets.push(group.join(","));
    }
  }

  const players = [];
  for (const name of targets) {
    try {
      players.push(await computeStats(outDir, name));
    } catch (err) {
      players.push({
        targetArg: name,
        error: String(err),
        matchesWithTarget: 0,
        matchesScanned: 0,
        overall: {
          matches: 0,
          rounds: 0,
          kills: 0,
          deaths: 0,
          headshots: 0,
          damage: 0,
          kd: "0.00",
          adr: "0.0",
          hs: "0.0",
          favoriteWeapon: "-",
          topWeapons: [],
        },
        mapRows: [],
        topVictims: [],
        topZeusVictims: [],
        monthly: [],
        bestMonth: null,
      });
    }
  }

  const palette = [
    "#4dc4ff",
    "#efb560",
    "#7ddf94",
    "#ff6b6b",
    "#b693ff",
    "#f4d35e",
    "#53d8fb",
    "#f26a4f",
    "#99e2b4",
    "#ffb3c1",
  ];

  const allMonthLabels = Array.from(
    new Set(
      players.flatMap((player) => player.monthly.map((row) => row.monthKey))
    )
  ).sort();

  const seriesData = players.map((player, idx) => {
    const label = player.displayName || player.targetArg.split(",")[0];
    const key = normalizeKey(player.targetArg);
    const monthMap = new Map(
      player.monthly.map((row) => [row.monthKey, Number(row.kd)])
    );
    const values = allMonthLabels.map((month) =>
      Number.isFinite(monthMap.get(month)) ? monthMap.get(month) : null
    );
    return {
      key,
      label,
      color: palette[idx % palette.length],
      values,
    };
  });

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  const tabs = players
    .map((player, idx) => {
      const displayName = player.displayName || player.targetArg.split(",")[0];
      const key = normalizeKey(player.targetArg);
      return `
        <button class="tab ${idx === 0 ? "active" : ""}" data-player="${key}">${escapeHtml(
        displayName
      )}</button>`;
    })
    .join("");

  const playerSections = players
    .map((data, idx) => {
      const mapRowsRaw = data.mapRows
        .map((row) => {
          const weaponList = row.topWeapons
            .map((weapon) => weapon.name)
            .join(", ");
          return `
        <tr>
          <td>${escapeHtml(row.mapName)}</td>
          <td>${row.matches}</td>
          <td>${row.rounds}</td>
          <td>${row.kd}</td>
          <td>${row.adr}</td>
          <td>${row.hs}%</td>
          <td>${escapeHtml(weaponList || "-")}</td>
        </tr>`;
        })
        .join("");

      const mapRows =
        mapRowsRaw || `<tr><td colspan="7">No map stats available.</td></tr>`;

      const victimsRows = data.topVictims
        .map((victim, idx) => {
          const duel = victim.duels || { kills: 0, deaths: 0 };
          return `
        <div class="list-row">
          <div class="rank">${idx + 1}</div>
          <div class="label">${escapeHtml(victim.name)}</div>
          <div class="value">${formatNumber(victim.count)} (${duel.kills}/${duel.deaths})</div>
        </div>`
        })
        .join("");

      const zeusRows = data.topZeusVictims
        .map(
          (victim, idx) => `
        <div class="list-row">
          <div class="rank">${idx + 1}</div>
          <div class="label">${escapeHtml(victim.name)}</div>
          <div class="value">${formatNumber(victim.count)}</div>
        </div>`
        )
        .join("");

      const monthRowsRaw = data.monthly
        .map(
          (row) => `
        <tr>
          <td>${escapeHtml(row.monthKey)}</td>
          <td>${row.matches}</td>
          <td>${row.rounds}</td>
          <td>${row.kd}</td>
          <td>${row.adr}</td>
          <td>${row.hs}%</td>
        </tr>`
        )
        .join("");

      const monthRows =
        monthRowsRaw ||
        `<tr><td colspan="6">No monthly stats available.</td></tr>`;

      const overallWeaponList = data.overall.topWeapons
        .map((weapon) => weapon.name)
        .join(", ");

      const compareLabels = escapeHtml(JSON.stringify(allMonthLabels));
      const compareSeries = escapeHtml(JSON.stringify(seriesData));
      const activeKey = normalizeKey(data.targetArg);
      const compareToggles = seriesData
        .map(
          (series) => `
            <button class="series-toggle ${
              series.key === activeKey ? "active" : ""
            }" data-key="${series.key}" style="--series-color: ${
            series.color
          }">
              <span class="dot"></span>${escapeHtml(series.label)}
            </button>`
        )
        .join("");

      const monthLabels = data.monthly.map((row) => row.monthKey);
      const monthKd = data.monthly.map((row) => Number(row.kd));
      const monthAdr = data.monthly.map((row) => Number(row.adr));
      const mapLabels = data.mapRows.map((row) => row.mapName);
      const mapKd = data.mapRows.map((row) => (row.kd === "∞" ? 0 : Number(row.kd)));
      const dataKey = normalizeKey(data.targetArg);

      const errorBanner = data.error
        ? `<div class="error">${escapeHtml(data.error)}</div>`
        : data.bestMonth
        ? `<div class="tag">Best month: ${escapeHtml(data.bestMonth)}</div>`
        : "";

      return `
        <section class="player ${
          idx === 0 ? "active" : ""
        }" data-player="${dataKey}">
          ${errorBanner}
          <section class="summary">
            <div class="card">
              <h3>Overall K/D</h3>
              <div class="value">${data.overall.kd}</div>
              <div class="sub">Kills ${formatNumber(
                data.overall.kills
              )} · Deaths ${formatNumber(data.overall.deaths)}</div>
            </div>
            <div class="card">
              <h3>ADR</h3>
              <div class="value">${data.overall.adr}</div>
              <div class="sub">Damage ${formatNumber(
                data.overall.damage
              )}</div>
            </div>
            <div class="card">
              <h3>Headshot%</h3>
              <div class="value">${data.overall.hs}%</div>
              <div class="sub">Headshots ${formatNumber(
                data.overall.headshots
              )}</div>
            </div>
            <div class="card">
              <h3>Top Weapons</h3>
              <div class="value">${escapeHtml(overallWeaponList || "-")}</div>
              <div class="sub">Matches ${data.overall.matches} · Rounds ${
        data.overall.rounds
      }</div>
            </div>
          </section>

          <section class="section charts">
            <div class="card chart-card">
              <h3>K/D Trend</h3>
              <canvas
                width="520"
                height="180"
                data-chart="line"
                data-labels='${escapeHtml(JSON.stringify(monthLabels))}'
                data-values='${escapeHtml(JSON.stringify(monthKd))}'
              ></canvas>
            </div>
            <div class="card chart-card">
              <h3>ADR Trend</h3>
              <canvas
                width="520"
                height="180"
                data-chart="line"
                data-labels='${escapeHtml(JSON.stringify(monthLabels))}'
                data-values='${escapeHtml(JSON.stringify(monthAdr))}'
              ></canvas>
            </div>
            <div class="card chart-card full">
              <h3>Map K/D</h3>
              <canvas
                width="900"
                height="220"
                data-chart="bar"
                data-labels='${escapeHtml(JSON.stringify(mapLabels))}'
                data-values='${escapeHtml(JSON.stringify(mapKd))}'
              ></canvas>
            </div>
          </section>

          <section class="section">
            <h2>By Map</h2>
            <table>
              <thead>
                <tr>
                  <th>Map</th>
                  <th>Matches</th>
                  <th>Rounds</th>
                  <th>K/D</th>
                  <th>ADR</th>
                  <th>HS%</th>
                  <th>Top 3 Weapons</th>
                </tr>
              </thead>
              <tbody>
                ${mapRows}
              </tbody>
            </table>
          </section>

          <section class="section split">
            <div class="list">
              <h2>Top Victims</h2>
              ${victimsRows || "<p>No data available.</p>"}
            </div>
            <div class="list">
              <h2>Zeus Victims</h2>
              ${zeusRows || "<p>No Zeus kills.</p>"}
            </div>
          </section>

          <section class="section">
            <h2>Monthly Performance</h2>
            <div class="monthly-compare">
              <div class="series-bar">
                ${compareToggles}
              </div>
              <canvas
                width="980"
                height="340"
                class="monthly-chart"
                data-chart="compare"
                data-labels='${compareLabels}'
                data-series='${compareSeries}'
                data-active='${escapeHtml(activeKey)}'
              ></canvas>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Matches</th>
                  <th>Rounds</th>
                  <th>K/D</th>
                  <th>ADR</th>
                  <th>HS%</th>
                </tr>
              </thead>
              <tbody>
                ${monthRows}
              </tbody>
            </table>
          </section>
        </section>
      `;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fastcup Stats Wrap</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap");

      :root {
        color-scheme: dark;
        --bg: #0b0c10;
        --panel: #14161e;
        --panel-alt: #1a1d28;
        --text: #e8eaf0;
        --muted: #9aa3b2;
        --accent: #efb560;
        --accent-2: #4dc4ff;
        --danger: #ff6b6b;
        --glow: rgba(79, 196, 255, 0.35);
        --shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Space Grotesk", "Segoe UI", sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 10% 10%, #18202f 0%, var(--bg) 45%) fixed,
          linear-gradient(120deg, rgba(79, 196, 255, 0.08), transparent 45%) fixed;
        min-height: 100vh;
      }

      .hero {
        padding: 48px 24px 24px;
        text-align: center;
      }

      .hero h1 {
        font-size: clamp(28px, 4vw, 46px);
        margin: 0 0 12px;
        letter-spacing: 0.5px;
      }

      .hero p {
        margin: 0;
        color: var(--muted);
      }

      .container {
        max-width: 1100px;
        margin: 0 auto;
        padding: 0 24px 60px;
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 28px;
      }

      .card {
        background: var(--panel);
        border-radius: 16px;
        padding: 18px 20px;
        box-shadow: var(--shadow);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .card h3 {
        margin: 0 0 8px;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 1.2px;
        color: var(--muted);
      }

      .card .value {
        font-size: 26px;
        font-weight: 600;
      }

      .card .sub {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
      }

      .section {
        margin-bottom: 28px;
      }

      .section h2 {
        margin: 0 0 12px;
        font-size: 20px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border-radius: 16px;
        overflow: hidden;
        box-shadow: var(--shadow);
      }

      th,
      td {
        padding: 12px 14px;
        text-align: left;
        font-size: 14px;
      }

      th {
        background: var(--panel-alt);
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        font-size: 12px;
      }

      tr:nth-child(even) td {
        background: rgba(255, 255, 255, 0.02);
      }

      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }

      .charts {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 28px;
        align-items: stretch;
      }

      .chart-card canvas {
        display: block;
        width: 100%;
        height: 180px;
      }

      .chart-card.full {
        grid-column: 1 / -1;
      }

      .chart-card {
        width: 100%;
        min-width: 0;
      }

      .monthly-compare {
        background: var(--panel);
        border-radius: 18px;
        padding: 18px;
        margin-bottom: 18px;
        box-shadow: var(--shadow);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .monthly-chart {
        display: block;
        width: 100%;
        height: 340px;
      }

      .series-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }

      .series-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--text);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .series-toggle .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--series-color, #4dc4ff);
        box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
      }

      .series-toggle.active {
        background: rgba(255, 255, 255, 0.08);
        border-color: var(--series-color, #4dc4ff);
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
      }

      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
        padding: 0 24px 16px;
      }

      .tab {
        background: var(--panel);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: var(--text);
        padding: 8px 14px;
        border-radius: 999px;
        cursor: pointer;
        font-size: 13px;
      }

      .tab.active {
        background: var(--accent);
        color: #12131a;
        border-color: transparent;
        box-shadow: 0 10px 30px rgba(239, 181, 96, 0.35);
      }

      .list {
        background: var(--panel);
        border-radius: 16px;
        padding: 16px;
        box-shadow: var(--shadow);
      }

      .list-row {
        display: grid;
        grid-template-columns: 34px 1fr 80px;
        align-items: center;
        padding: 10px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }

      .list-row:last-child {
        border-bottom: none;
      }

      .rank {
        font-weight: 600;
        color: var(--accent);
      }

      .value {
        text-align: right;
      }

      .tag {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        background: rgba(239, 181, 96, 0.12);
        color: var(--accent);
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        margin: 0 0 16px;
      }

      .error {
        background: rgba(255, 107, 107, 0.12);
        color: var(--danger);
        border: 1px solid rgba(255, 107, 107, 0.35);
        padding: 10px 14px;
        border-radius: 12px;
        margin-bottom: 16px;
      }

      .player {
        display: none;
      }

      .player.active {
        display: block;
      }

      .footer {
        text-align: center;
        color: var(--muted);
        font-size: 12px;
        padding: 24px 0;
      }

      .tooltip {
        position: fixed;
        pointer-events: none;
        background: rgba(20, 22, 30, 0.95);
        color: var(--text);
        border: 1px solid rgba(255, 255, 255, 0.12);
        padding: 8px 10px;
        border-radius: 10px;
        font-size: 12px;
        box-shadow: var(--shadow);
        transform: translate(-50%, -120%);
        opacity: 0;
        transition: opacity 0.1s ease;
        z-index: 50;
      }

      @media (max-width: 640px) {
        th:nth-child(3),
        td:nth-child(3),
        th:nth-child(6),
        td:nth-child(6) {
          display: none;
        }

        .charts {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header class="hero">
      <h1>Fastcup Stats Wrap</h1>
      <p>${escapeHtml(headerLabel)} · Generated ${escapeHtml(now)}</p>
    </header>
    <nav class="tabs">${tabs}</nav>
    <main class="container">
      ${playerSections}
    </main>
    <div class="footer">Generated by your Fastcup scraper</div>
    <div id="tooltip" class="tooltip"></div>
    <script>
      const tabs = document.querySelectorAll(".tab");
      const panels = document.querySelectorAll(".player");
      const tooltip = document.getElementById("tooltip");
      const CHART_PADDING = 28;
      const LABEL_PAD_RIGHT = 90;

      function drawLineChart(canvas, labels, values) {
        const ctx = canvas.getContext("2d");
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!values.length) {
          ctx.fillStyle = "#9aa3b2";
          ctx.fillText("No data", 10, 20);
          return;
        }
        const padding = CHART_PADDING;
        const maxVal = Math.max(...values, 1);
        const minVal = Math.min(...values, 0);
        const range = maxVal - minVal || 1;
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i += 1) {
          const y = padding + ((h - padding * 2) * i) / 4;
          ctx.beginPath();
          ctx.moveTo(padding, y);
          ctx.lineTo(w - padding, y);
          ctx.stroke();
        }
        ctx.strokeStyle = "#4dc4ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        values.forEach((value, idx) => {
          const x = padding + ((w - padding * 2) * idx) / (values.length - 1 || 1);
          const y = h - padding - ((value - minVal) / range) * (h - padding * 2);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = "#efb560";
        values.forEach((value, idx) => {
          const x = padding + ((w - padding * 2) * idx) / (values.length - 1 || 1);
          const y = h - padding - ((value - minVal) / range) * (h - padding * 2);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#e8eaf0";
          ctx.font = "11px Space Grotesk, sans-serif";
          ctx.fillText(value.toFixed(2), x - 10, y - 10);
          ctx.fillStyle = "#efb560";
        });
        ctx.fillStyle = "#9aa3b2";
        ctx.font = "11px Space Grotesk, sans-serif";
        labels.forEach((label, idx) => {
          if (idx % 2 !== 0 && labels.length > 6) return;
          const x = padding + ((w - padding * 2) * idx) / (labels.length - 1 || 1);
          ctx.fillText(label, x - 16, h - 8);
        });
      }

      function drawBarChart(canvas, labels, values) {
        const ctx = canvas.getContext("2d");
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (!values.length) {
          ctx.fillStyle = "#9aa3b2";
          ctx.fillText("No data", 10, 20);
          return;
        }
        const padding = CHART_PADDING;
        const maxVal = Math.max(...values, 1);
        const barWidth = (w - padding * 2) / values.length;
        values.forEach((value, idx) => {
          const barHeight = (value / maxVal) * (h - padding * 2);
          const x = padding + idx * barWidth + 6;
          const y = h - padding - barHeight;
          ctx.fillStyle = "rgba(239,181,96,0.7)";
          ctx.fillRect(x, y, barWidth - 12, barHeight);
          ctx.fillStyle = "#e8eaf0";
          ctx.font = "11px Space Grotesk, sans-serif";
          ctx.fillText(value.toFixed(2), x, y - 6);
          ctx.fillStyle = "#9aa3b2";
          ctx.font = "11px Space Grotesk, sans-serif";
          ctx.fillText(labels[idx], x - 2, h - 8);
        });
      }

      function drawCompareChart(canvas, labels, series, activeKeys) {
        const ctx = canvas.getContext("2d");
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const active = series.filter((item) => activeKeys.includes(item.key));
        const activeValues = active.flatMap((item) =>
          item.values.filter((value) => value !== null)
        );

        if (!activeValues.length) {
          ctx.fillStyle = "#9aa3b2";
          ctx.fillText("No data", 10, 20);
          return;
        }

        const padding = CHART_PADDING;
        const maxVal = Math.max(...activeValues, 1);
        const minVal = Math.min(...activeValues, 0);
        const range = maxVal - minVal || 1;

        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i += 1) {
          const y = padding + ((h - padding * 2) * i) / 4;
          ctx.beginPath();
          ctx.moveTo(padding, y);
          ctx.lineTo(w - padding, y);
          ctx.stroke();
        }

        const innerWidth = w - padding * 2 - LABEL_PAD_RIGHT;

        active.forEach((item) => {
          const points = item.values.map((value, idx) => {
            if (value === null) return null;
            const x = padding + (innerWidth * idx) / (labels.length - 1 || 1);
            const y =
              h - padding - ((value - minVal) / range) * (h - padding * 2);
            return { x, y, value };
          });

          ctx.beginPath();
          points.forEach((point, idx) => {
            if (!point) return;
            if (idx === 0 || !points[idx - 1]) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          });
          ctx.strokeStyle = item.color;
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = item.color;
          ctx.beginPath();
          points.forEach((point, idx) => {
            if (!point) return;
            if (idx === 0 || !points[idx - 1]) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          });
          const lastPoint = [...points].reverse().find(Boolean);
          const firstPoint = points.find(Boolean);
          if (lastPoint && firstPoint) {
            ctx.lineTo(lastPoint.x, h - padding);
            ctx.lineTo(firstPoint.x, h - padding);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();

          points.forEach((point) => {
            if (!point) return;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.fill();
          });
        });

        ctx.font = "11px Space Grotesk, sans-serif";
        active.forEach((item) => {
          const points = item.values.map((value, idx) => {
            if (value === null) return null;
            const x = padding + (innerWidth * idx) / (labels.length - 1 || 1);
            const y =
              h - padding - ((value - minVal) / range) * (h - padding * 2);
            return { x, y };
          });
          const firstPoint = points.find(Boolean);
          const lastPoint = [...points].reverse().find(Boolean);
          ctx.fillStyle = item.color;
          if (firstPoint) {
            ctx.textAlign = "left";
            ctx.fillText(item.label, firstPoint.x - 6, firstPoint.y - 8);
          }
          if (lastPoint) {
            ctx.textAlign = "left";
            const labelX = Math.min(lastPoint.x + 8, w - LABEL_PAD_RIGHT + 10);
            ctx.fillText(item.label, labelX, lastPoint.y - 8);
          }
        });
        ctx.textAlign = "left";

        ctx.fillStyle = "#9aa3b2";
        ctx.font = "11px Space Grotesk, sans-serif";
        labels.forEach((label, idx) => {
          if (idx % 2 !== 0 && labels.length > 6) return;
          const x = padding + (innerWidth * idx) / (labels.length - 1 || 1);
          ctx.fillText(label, x - 16, h - 8);
        });
      }

      function showTooltip(event, text) {
        tooltip.textContent = text;
        tooltip.style.left = event.clientX + "px";
        tooltip.style.top = event.clientY + "px";
        tooltip.style.opacity = "1";
      }

      function hideTooltip() {
        tooltip.style.opacity = "0";
      }

      function attachTooltip(canvas) {
        const labels = JSON.parse(canvas.dataset.labels || "[]");
        const values = JSON.parse(canvas.dataset.values || "[]");
        if (!labels.length || !values.length) return;

        canvas.addEventListener("mousemove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const width = rect.width;
          const padding = CHART_PADDING;
          const innerWidth = width - padding * 2 - LABEL_PAD_RIGHT;
          let index = 0;

          if (canvas.dataset.chart === "bar") {
            const barWidth = innerWidth / values.length;
            index = Math.floor((x - padding) / barWidth);
          } else {
            index = Math.round(
              ((x - padding) / innerWidth) * (values.length - 1)
            );
          }

          if (index < 0 || index >= values.length) {
            hideTooltip();
            return;
          }

          const label = labels[index];
          const value = values[index];
          showTooltip(event, label + ": " + value);
        });

        canvas.addEventListener("mouseleave", hideTooltip);
      }

      function attachCompareTooltip(canvas) {
        const labels = JSON.parse(canvas.dataset.labels || "[]");
        const series = JSON.parse(canvas.dataset.series || "[]");

        canvas.addEventListener("mousemove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const width = rect.width;
          const padding = CHART_PADDING;
          const innerWidth = width - padding * 2;
          const index = Math.round(
            ((x - padding) / innerWidth) * (labels.length - 1)
          );
          if (index < 0 || index >= labels.length) {
            hideTooltip();
            return;
          }
          const activeKeys = (canvas.dataset.active || "")
            .split(",")
            .filter(Boolean);
          const active = series.filter((item) => activeKeys.includes(item.key));
          if (!active.length) return;
          const lines = active
            .map((item) => {
              const value = item.values[index];
              if (value === null || value === undefined) return null;
              return item.label + ": " + Number(value).toFixed(2);
            })
            .filter(Boolean)
            .join(" · ");
          const label = labels[index];
          showTooltip(event, label + ": " + lines);
        });

        canvas.addEventListener("mouseleave", hideTooltip);
      }

      function renderCharts(root) {
        root.querySelectorAll("canvas").forEach((canvas) => {
          const labels = JSON.parse(canvas.dataset.labels || "[]");
          const values = JSON.parse(canvas.dataset.values || "[]");
          if (canvas.dataset.chart === "bar") {
            drawBarChart(canvas, labels, values);
          } else if (canvas.dataset.chart === "compare") {
            const series = JSON.parse(canvas.dataset.series || "[]");
            const activeKeys = (canvas.dataset.active || "")
              .split(",")
              .filter(Boolean);
            drawCompareChart(canvas, labels, series, activeKeys);
            attachCompareTooltip(canvas);
            return;
          } else {
            drawLineChart(canvas, labels, values);
          }
          attachTooltip(canvas);
        });
      }

      function setupCompare(root) {
        root.querySelectorAll(".monthly-compare").forEach((block) => {
          const canvas = block.querySelector("canvas");
          const toggles = block.querySelectorAll(".series-toggle");
          const active = new Set((canvas.dataset.active || "").split(",").filter(Boolean));

          toggles.forEach((toggle) => {
            toggle.addEventListener("click", () => {
              const key = toggle.dataset.key;
              if (active.has(key) && active.size > 1) {
                active.delete(key);
              } else {
                active.add(key);
              }
              canvas.dataset.active = Array.from(active).join(",");
              toggles.forEach((button) =>
                button.classList.toggle("active", active.has(button.dataset.key))
              );
              renderCharts(root);
            });
          });
        });
      }

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const target = tab.dataset.player;
          tabs.forEach((t) => t.classList.toggle("active", t === tab));
          panels.forEach((panel) => {
            const active = panel.dataset.player === target;
            panel.classList.toggle("active", active);
            if (active) {
              renderCharts(panel);
              setupCompare(panel);
            }
          });
        });
      });

      panels.forEach((panel, idx) => {
        if (idx === 0) {
          renderCharts(panel);
          setupCompare(panel);
        }
      });
    </script>
  </body>
</html>`;

  await fs.writeFile(outputFile, html, "utf8");
  process.stdout.write(`saved ${outputFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
