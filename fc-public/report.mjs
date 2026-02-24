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

const MAP_OVERRIDES = {
  de_mirage: { shiftX: -0.03, shiftY: 0.02 },
  de_inferno: { shiftX: -0.04, shiftY: 0.0 },
};

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

async function buildMatchIndex(outDir) {
  const files = await fs.readdir(outDir);
  const statsFiles = files.filter((file) => file.includes("GetMatchStats-"));
  const killsByMatch = new Map();
  const damagesByMatch = new Map();
  const mapsFiles = files.filter((file) => file.includes("GetMaps"));
  const mapsFile = mapsFiles.sort().pop();
  const weaponsFile = files.find((file) => file.includes("GetWeapons"));
  const mapById = new Map();
  const mapBoundsByKey = new Map();
  const weaponNameById = new Map();

  if (mapsFile) {
    const mapsData = await readJson(path.join(outDir, mapsFile));
    for (const map of mapsData.data?.maps || []) {
      mapById.set(map.id, {
        id: map.id,
        name: map.name,
        rawName: map.rawName || null,
        topview: map.topview || null,
        overview: map.overview || null,
        preview: map.preview || null,
        offset: map.offset || null,
        scale: map.scale || null,
        flipH: map.flipH || false,
        flipV: map.flipV || false,
      });
    }
  }

  if (weaponsFile) {
    const weaponsData = await readJson(path.join(outDir, weaponsFile));
    for (const weapon of weaponsData.data?.weapons || []) {
      const name = weapon.name || weapon.internalName || `weapon-${weapon.id}`;
      weaponNameById.set(weapon.id, name);
    }
  }

  for (const file of files) {
    const match = file.match(/GetMatchKills-(\d+)\.json$/);
    if (match) killsByMatch.set(match[1], file);
  }
  for (const file of files) {
    const match = file.match(/GetMatchDamages-(\d+)\.json$/);
    if (match) damagesByMatch.set(match[1], file);
  }

  const matches = [];
  const seen = new Set();

  for (const file of statsFiles) {
    const matchIdMatch = file.match(/GetMatchStats-(\d+)\.json$/);
    if (!matchIdMatch) continue;
    const matchId = matchIdMatch[1];
    if (seen.has(matchId)) continue;
    seen.add(matchId);
    const statsData = await readJson(path.join(outDir, file));
    const match = statsData.data?.match;
    if (!match) continue;

    const mapEntry = match.maps?.[0];
    const mapName = mapEntry?.map?.name || "Unknown";
    const mapId = mapEntry?.mapId || mapEntry?.map?.id || null;
    const mapMeta = mapId ? mapById.get(mapId) || null : null;
    const mapRawName = mapMeta?.rawName || mapEntry?.map?.rawName || null;
    const mapKey = mapId ? `id:${mapId}` : mapRawName ? `raw:${mapRawName}` : `name:${mapName}`;
    const mapImages = [];
    const addMapImage = (src) => {
      if (!src || mapImages.includes(src)) return;
      mapImages.push(src);
    };
    if (mapRawName && /^(de|cs|ar|dz|gd)_/i.test(mapRawName)) {
      addMapImage(`${mapRawName}_radar_trans.png`);
      addMapImage(
        `https://www.hltv.org/img/static/stats/heatmap/new/${mapRawName}_radar_trans.png`
      );
    }
    const rounds = match.rounds?.length || 0;
    const startedAt = match.startedAt || null;
    const teams = match.teams || [];

    let tScore = null;
    let ctScore = null;
    const fallbackScores = [];
    const teamMeta = {};
    for (const team of teams) {
      const mapStats = team.mapStats?.[0];
      if (!mapStats) continue;
      fallbackScores.push(mapStats.score);
      if (team.id) {
        teamMeta[team.id] = {
          name: team.name || null,
          initialSide: mapStats.initialSide || null,
        };
      }
      if (mapStats.initialSide === "TERRORIST") {
        tScore = mapStats.score;
      } else if (mapStats.initialSide === "CT") {
        ctScore = mapStats.score;
      }
    }

    if (tScore === null || ctScore === null) {
      if (fallbackScores.length >= 2) {
        tScore = fallbackScores[0];
        ctScore = fallbackScores[1];
      }
    }

    const members = match.members || [];
    const teamIds = (match.teams || []).map((team) => team.id).filter(Boolean);
    const players = new Map();
    for (const member of members) {
      const user = member.private?.user;
      if (!user) continue;
      players.set(user.id, {
        id: user.id,
        nick: user.nickName || `user-${user.id}`,
        teamId: member.matchTeamId || null,
        kills: 0,
        deaths: 0,
        headshots: 0,
        damage: 0,
      });
    }

    const roundIndexById = new Map();
    (match.rounds || []).forEach((round, idx) => {
      roundIndexById.set(round.id, idx + 1);
    });

    const sideForRound = (initialSide, roundIndex) => {
      if (!initialSide || !roundIndex) return null;
      const baseSide = initialSide === "TERRORIST" ? "T" : "CT";
      if (roundIndex <= 12) return baseSide;
      if (roundIndex <= 24) return baseSide === "T" ? "CT" : "T";
      const otIndex = roundIndex - 25;
      const segment = Math.floor(otIndex / 3);
      const swap = segment % 2 === 1;
      return swap ? (baseSide === "T" ? "CT" : "T") : baseSide;
    };

    const heatmapPoints = new Map();

    const killsFile = killsByMatch.get(matchId);
    if (killsFile) {
      const killsData = await readJson(path.join(outDir, killsFile));
      for (const kill of killsData.data?.kills || []) {
        if (kill.isTeamkill) continue;
        const killer = players.get(kill.killerId);
        const victim = players.get(kill.victimId);
        if (killer) {
          killer.kills += 1;
          if (kill.isHeadshot) killer.headshots += 1;
          const roundIndex = roundIndexById.get(kill.roundId);
          const teamInitialSide =
            teamMeta[killer.teamId]?.initialSide || null;
          const side = sideForRound(teamInitialSide, roundIndex);
          if (
            typeof kill.killerPositionX === "number" &&
            typeof kill.killerPositionY === "number"
          ) {
            const list = heatmapPoints.get(killer.id) || [];
            const victimName =
              victim?.nick ||
              (kill.victimId ? `user-${kill.victimId}` : "unknown");
            const weaponName =
              weaponNameById.get(kill.weaponId) ||
              (kill.weaponId ? `weapon-${kill.weaponId}` : "unknown");
            const flashAssist =
              kill.victimBlindedBy === kill.killerId ||
              (kill.assistantId && kill.victimBlindedBy === kill.assistantId) ||
              false;
            const flashed =
              typeof kill.killerBlindDuration === "number" &&
              kill.killerBlindDuration > 0;
            const point = {
              x: kill.killerPositionX,
              y: kill.killerPositionY,
              side,
              roundIndex: roundIndex || null,
              createdAt: kill.createdAt || null,
              victimId: kill.victimId || null,
              victimName,
              weaponId: kill.weaponId || null,
              weaponName,
              isHeadshot: Boolean(kill.isHeadshot),
              isWallbang: Boolean(kill.isWallbang),
              isNoscope: Boolean(kill.isNoscope),
              flashed,
              flashAssist,
            };
            list.push(point);
            heatmapPoints.set(killer.id, list);
            const bounds =
              mapBoundsByKey.get(mapKey) || {
                minX: Number.POSITIVE_INFINITY,
                minY: Number.POSITIVE_INFINITY,
                maxX: Number.NEGATIVE_INFINITY,
                maxY: Number.NEGATIVE_INFINITY,
              };
            bounds.minX = Math.min(bounds.minX, point.x);
            bounds.maxX = Math.max(bounds.maxX, point.x);
            bounds.minY = Math.min(bounds.minY, point.y);
            bounds.maxY = Math.max(bounds.maxY, point.y);
            mapBoundsByKey.set(mapKey, bounds);
          }
        }
        if (victim) {
          victim.deaths += 1;
        }
      }
    }

    const damagesFile = damagesByMatch.get(matchId);
    if (damagesFile) {
      const damagesData = await readJson(path.join(outDir, damagesFile));
      for (const damage of damagesData.data?.damages || []) {
        const inflictor = players.get(damage.inflictorId);
        if (inflictor) {
          inflictor.damage += Number(damage.damageReal || 0);
        }
      }
    }

    const playersList = Array.from(players.values()).map((player) => {
      const adr = rounds > 0 ? player.damage / rounds : 0;
      const hs = player.kills > 0 ? (player.headshots / player.kills) * 100 : 0;
      return {
        ...player,
        adr: Number(adr.toFixed(1)),
        hs: Number(hs.toFixed(1)),
      };
    });

    matches.push({
      id: matchId,
      startedAt,
      mapName,
      mapId,
      mapKey,
      mapRawName,
      mapImages,
      mapImageBase: "maps/",
      mapMeta,
      rounds,
      tScore,
      ctScore,
      teamIds,
      teamMeta,
      roundsList: (match.rounds || []).map((round) => ({
        id: round.id,
        winMatchTeamId: round.winMatchTeamId || null,
      })),
      players: playersList,
      heatmapPoints: Object.fromEntries(heatmapPoints),
    });
  }

  for (const [key, bounds] of mapBoundsByKey.entries()) {
    if (
      !Number.isFinite(bounds.minX) ||
      !Number.isFinite(bounds.minY) ||
      !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.maxY)
    ) {
      mapBoundsByKey.delete(key);
      continue;
    }
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    if (spanX <= 0 || spanY <= 0) {
      mapBoundsByKey.delete(key);
      continue;
    }
    const padX = spanX * 0.05;
    const padY = spanY * 0.05;
    bounds.minX -= padX;
    bounds.maxX += padX;
    bounds.minY -= padY;
    bounds.maxY += padY;
  }

  for (const match of matches) {
    const bounds = mapBoundsByKey.get(match.mapKey) || null;
    match.mapBounds = bounds;
  }

  matches.sort((a, b) => {
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bTime - aTime;
  });

  return matches;
}

async function main() {
  const outDir = process.argv[2] || "out";
  const targetArg = process.argv[3] || "";
  const outputArg = process.argv[4] || process.env.REPORT_OUTPUT;
  const outputFile = outputArg
    ? path.resolve(outputArg)
    : path.join(outDir, "report.html");

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
        topKnifeVictims: [],
        monthly: [],
        weekly: [],
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

  const matchIndex = await buildMatchIndex(outDir);

  const allWeekLabels = Array.from(
    new Set(
      players.flatMap((player) =>
        (player.weekly || [])
          .map((row) => row.weekKey)
          .filter((key) => key && key !== "unknown")
      )
    )
  ).sort();

  const seriesData = players.map((player, idx) => {
    const label = player.displayName || player.targetArg.split(",")[0];
    const key = normalizeKey(player.targetArg);
    const weekMap = new Map(
      (player.weekly || []).map((row) => [row.weekKey, Number(row.rating)])
    );
    const values = allWeekLabels.map((week) =>
      Number.isFinite(weekMap.get(week)) ? weekMap.get(week) : null
    );
    return {
      key,
      label,
      color: palette[idx % palette.length],
      values,
    };
  });

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  const tabs = [
    `<button class="tab matches-tab" data-target="matches">Matches</button>`,
    `<span class="tab-divider"></span>`,
    ...players.map((player, idx) => {
      const displayName = player.displayName || player.targetArg.split(",")[0];
      const key = normalizeKey(player.targetArg);
      return `
        <button class="tab ${idx === 0 ? "active" : ""}" data-target="${key}">${escapeHtml(
        displayName
      )}</button>`;
    }),
  ].join("");

  const metricValues = players.map((player) => {
    const kd = Number(player.overall.kd);
    return {
      kd: Number.isFinite(kd) ? kd : 2,
      adr: Number(player.overall.adr) || 0,
      hs: Number(player.overall.hs) || 0,
      rating: Number(player.overall.rating) || 0,
    };
  });

  const average = (values) => {
    const valid = values.filter((value) => Number.isFinite(value));
    if (!valid.length) return 0;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
  };

  const metricAverages = {
    kd: average(metricValues.map((value) => value.kd)),
    adr: average(metricValues.map((value) => value.adr)),
    hs: average(metricValues.map((value) => value.hs)),
    rating: average(metricValues.map((value) => value.rating)),
  };

  const metricColor = (value, avg) => {
    if (!avg) return "#efb560";
    const ratio = value / avg;
    if (ratio >= 1.08) return "#4bd37b";
    if (ratio <= 0.92) return "#ff7b7b";
    return "#efb560";
  };

  const metricColorClass = (value, avg) => {
    if (!avg) return "metric-mid";
    const ratio = value / avg;
    if (ratio >= 1.08) return "metric-good";
    if (ratio <= 0.92) return "metric-bad";
    return "metric-mid";
  };

  const formatDelta = (value, avg, decimals) => {
    if (!Number.isFinite(value) || !Number.isFinite(avg)) return "0";
    const diff = value - avg;
    const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
    return `${sign}${Math.abs(diff).toFixed(decimals)}`;
  };

  const monthlyAverages = {
    kd: new Map(),
    adr: new Map(),
    hs: new Map(),
    rating: new Map(),
  };
  const monthlyCounts = new Map();

  for (const player of players) {
    for (const row of player.monthly || []) {
      const key = row.monthKey;
      const kd = Number(row.kd);
      const adr = Number(row.adr);
      const hs = Number(row.hs);
      const rating = Number(row.rating);
      if (!monthlyAverages.kd.has(key)) {
        monthlyAverages.kd.set(key, 0);
        monthlyAverages.adr.set(key, 0);
        monthlyAverages.hs.set(key, 0);
        monthlyAverages.rating.set(key, 0);
        monthlyCounts.set(key, 0);
      }
      if (Number.isFinite(kd)) monthlyAverages.kd.set(key, monthlyAverages.kd.get(key) + kd);
      if (Number.isFinite(adr)) monthlyAverages.adr.set(key, monthlyAverages.adr.get(key) + adr);
      if (Number.isFinite(hs)) monthlyAverages.hs.set(key, monthlyAverages.hs.get(key) + hs);
      if (Number.isFinite(rating)) {
        monthlyAverages.rating.set(key, monthlyAverages.rating.get(key) + rating);
      }
      monthlyCounts.set(key, monthlyCounts.get(key) + 1);
    }
  }

  for (const [key, count] of monthlyCounts.entries()) {
    if (!count) continue;
    monthlyAverages.kd.set(key, monthlyAverages.kd.get(key) / count);
    monthlyAverages.adr.set(key, monthlyAverages.adr.get(key) / count);
    monthlyAverages.hs.set(key, monthlyAverages.hs.get(key) / count);
    monthlyAverages.rating.set(key, monthlyAverages.rating.get(key) / count);
  }


  const playerSections = players
    .map((data, idx) => {
      const mapRowsRaw = data.mapRows
        .map((row) => {
          const weaponList = row.topWeapons
            .map((weapon) => weapon.name)
            .join(", ");
          const kdValue = row.kd === "∞" ? Number.POSITIVE_INFINITY : Number(row.kd);
          return `
        <tr>
          <td data-key="map" data-value="${escapeHtml(row.mapName.toLowerCase())}">${escapeHtml(
            row.mapName
          )}</td>
          <td data-key="matches" data-value="${row.matches}">${row.matches}</td>
          <td data-key="rounds" data-value="${row.rounds}">${row.rounds}</td>
          <td data-key="kd" data-value="${Number.isFinite(kdValue) ? kdValue : 999}">${
            row.kd
          }</td>
          <td data-key="adr" data-value="${row.adr}">${row.adr}</td>
          <td data-key="hs" data-value="${row.hs}">${row.hs}%</td>
          <td>${escapeHtml(weaponList || "-")}</td>
        </tr>`;
        })
        .join("");

      const mapRows =
        mapRowsRaw || `<tr><td colspan="7">No map stats available.</td></tr>`;

      const victimsRows = data.topVictims
        .map((victim, idx) => {
          const duel = victim.duels || { kills: 0, deaths: 0 };
          const duelTotal = Math.max(1, duel.kills + duel.deaths);
          const duelWinShare = ((duel.kills / duelTotal) * 100).toFixed(1);
          const duelLossShare = ((duel.deaths / duelTotal) * 100).toFixed(1);
          return `
        <div class="list-row">
          <div class="rank">${idx + 1}</div>
          <div class="label">
            <div>${escapeHtml(victim.name)}</div>
            <div class="victim-meta">
              <span class="duel-bar">
                <span class="duel-fill win" style="--duel-share:${duelWinShare}"></span>
                <span class="duel-fill loss" style="--duel-share:${duelLossShare}"></span>
                <span class="duel-counts">
                  <span class="win">${duel.kills}</span>
                  <span class="loss">${duel.deaths}</span>
                </span>
              </span>
              <span class="duel-rate">${duelWinShare}%</span>
            </div>
          </div>
          <div class="value">${formatNumber(victim.count)}</div>
        </div>`
        })
        .join("");

      const knifeVictims = new Map(
        (data.topKnifeVictims || []).map((victim) => [victim.id, victim])
      );
      const zeusVictims = new Map(
        (data.topZeusVictims || []).map((victim) => [victim.id, victim])
      );
      const trollEntries = new Map();
      for (const victim of data.topKnifeVictims || []) {
        const entry = trollEntries.get(victim.id) || {
          id: victim.id,
          name: victim.name,
          count: 0,
          knife: 0,
          zeus: 0,
        };
        entry.count += victim.count;
        entry.knife += victim.count;
        trollEntries.set(victim.id, entry);
      }
      for (const victim of data.topZeusVictims || []) {
        const entry = trollEntries.get(victim.id) || {
          id: victim.id,
          name: victim.name,
          count: 0,
          knife: 0,
          zeus: 0,
        };
        entry.count += victim.count;
        entry.zeus += victim.count;
        trollEntries.set(victim.id, entry);
      }
      const trollRows = Array.from(trollEntries.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((victim, idx) => {
          const total = victim.count || 0;
          const knife = victim.knife || 0;
          const zeus = victim.zeus || 0;
          const knifeShare = total ? ((knife / total) * 100).toFixed(1) : "0";
          const zeusShare = total ? ((zeus / total) * 100).toFixed(1) : "0";
          return `
        <div class="list-row troll-row">
          <div class="rank">${idx + 1}</div>
          <div class="label">
            <div class="troll-name">
              ${escapeHtml(victim.name)}
              <span class="troll-total-left">${formatNumber(total)}</span>
            </div>
            <div class="victim-meta">
              <span class="duel-bar troll-bar">
                <span class="duel-fill win" style="--duel-share:${knifeShare}"></span>
                <span class="duel-fill loss" style="--duel-share:${zeusShare}"></span>
                <span class="duel-counts">
                <span class="win">${knife}</span>
                <span class="loss">${zeus}</span>
              </span>
              </span>
            </div>
          </div>
          <div class="value">${formatNumber(total)}</div>
        </div>`;
        })
        .join("");

      const weekRowsRaw = (data.weekly || [])
        .map((row, index, list) => {
          const prev = index > 0 ? list[index - 1] : null;
          const deltaCell = (value, prevValue, decimals, suffix = "") => {
            const current = Number(value);
            const previous = prevValue !== null && prevValue !== undefined ? Number(prevValue) : null;
            if (!prev || !Number.isFinite(current) || !Number.isFinite(previous)) {
              return `<span class="week-value">${value}${suffix}</span>`;
            }
            const diff = current - previous;
            const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
            const cls = diff > 0 ? "week-up" : diff < 0 ? "week-down" : "week-flat";
            const formatted = `${sign}${Math.abs(diff).toFixed(decimals)}`;
            return `<span class="week-value">${value}${suffix}</span><span class="week-delta ${cls}">${formatted}</span>`;
          };
          const ratingCell = deltaCell(row.rating, prev?.rating, 2);
          const kdCell = deltaCell(row.kd, prev?.kd, 2);
          const adrCell = deltaCell(row.adr, prev?.adr, 1);
          const hsCell = deltaCell(row.hs, prev?.hs, 1, "%");
          return `
        <tr>
          <td>${escapeHtml(row.weekKey)}</td>
          <td>${row.matches}</td>
          <td>${row.rounds}</td>
          <td class="week-stat">${ratingCell}</td>
          <td class="week-stat">${kdCell}</td>
          <td class="week-stat">${adrCell}</td>
          <td class="week-stat">${hsCell}</td>
        </tr>`;
        })
        .join("");

      const weekRows =
        weekRowsRaw ||
        `<tr><td colspan="7">No weekly stats available.</td></tr>`;

      const kdMonthlyRows = data.monthly
        .map((row) => {
          const avg = monthlyAverages.kd.get(row.monthKey) || 0;
          const value = Number(row.kd);
          const cls = metricColorClass(value, avg);
          const delta = formatDelta(value, avg, 2);
          return `
          <div class="metric-row">
            <span>${escapeHtml(row.monthKey)}</span>
            <span class="metric-value-block">
              <span class="metric-delta ${cls}">${delta}</span>
              <span class="${cls}">${row.kd}</span>
            </span>
          </div>`;
        })
        .join("");

      const adrMonthlyRows = data.monthly
        .map((row) => {
          const avg = monthlyAverages.adr.get(row.monthKey) || 0;
          const value = Number(row.adr);
          const cls = metricColorClass(value, avg);
          const delta = formatDelta(value, avg, 1);
          return `
          <div class="metric-row">
            <span>${escapeHtml(row.monthKey)}</span>
            <span class="metric-value-block">
              <span class="metric-delta ${cls}">${delta}</span>
              <span class="${cls}">${row.adr}</span>
            </span>
          </div>`;
        })
        .join("");

      const hsMonthlyRows = data.monthly
        .map((row) => {
          const avg = monthlyAverages.hs.get(row.monthKey) || 0;
          const value = Number(row.hs);
          const cls = metricColorClass(value, avg);
          const delta = formatDelta(value, avg, 1);
          return `
          <div class="metric-row">
            <span>${escapeHtml(row.monthKey)}</span>
            <span class="metric-value-block">
              <span class="metric-delta ${cls}">${delta}</span>
              <span class="${cls}">${row.hs}%</span>
            </span>
          </div>`;
        })
        .join("");

      const ratingMonthlyRows = data.monthly
        .map((row) => {
          const avg = monthlyAverages.rating.get(row.monthKey) || 0;
          const value = Number(row.rating);
          const cls = metricColorClass(value, avg);
          const delta = formatDelta(value, avg, 2);
          const ratingText = Number.isFinite(value) ? value.toFixed(2) : "0.00";
          return `
          <div class="metric-row">
            <span>${escapeHtml(row.monthKey)}</span>
            <span class="metric-value-block">
              <span class="metric-delta ${cls}">${delta}</span>
              <span class="${cls}">${ratingText}</span>
            </span>
          </div>`;
        })
        .join("");

      const entryAttempts = data.overall.entryAttempts || 0;
      const entrySummary = entryAttempts
        ? `${data.overall.entryKills} K / ${data.overall.entryDeaths} D · ${data.overall.entrySuccess}%`
        : "No entry data";
      const clutchSummary = data.overall.clutchAttempts
        ? `${data.overall.clutchWins}/${data.overall.clutchAttempts} · ${data.overall.clutchRate}%`
        : "No clutches";
      const entryByMap = escapeHtml(JSON.stringify(data.entryByMap || {}));
      const clutchByMap = escapeHtml(JSON.stringify(data.clutchByMap || {}));
      const mapOptions = ["All", ...data.mapRows.map((row) => row.mapName)];
      const mapOptionsHtml = mapOptions
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join("");

      const compareLabels = escapeHtml(JSON.stringify(allWeekLabels));
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
      const weekLabels = (data.weekly || []).map((row) => row.weekKey);
      const weekKd = (data.weekly || []).map((row) => Number(row.kd));
      const weekAdr = (data.weekly || []).map((row) => Number(row.adr));
      const mapLabels = data.mapRows.map((row) => row.mapName);
      const mapKd = data.mapRows.map((row) => (row.kd === "∞" ? 0 : Number(row.kd)));
      const dataKey = normalizeKey(data.targetArg);

      const errorBanner = data.error
        ? `<div class="error">${escapeHtml(data.error)}</div>`
        : data.bestMonth
        ? `<div class="tag">Best month: ${escapeHtml(data.bestMonth)}</div>`
        : "";

      const kdValue = Number(data.overall.kd) === Infinity ? 2 : Number(data.overall.kd);
      const kdProgress = Math.max(0, Math.min(1, kdValue / 2));
      const adrValue = Number(data.overall.adr) || 0;
      const hsValue = Number(data.overall.hs) || 0;
      const ratingValue = Number(data.overall.rating) || 0;
      const adrProgress = Math.max(0, Math.min(1, adrValue / 200));
      const hsProgress = Math.max(0, Math.min(1, hsValue / 100));
      const ratingProgress = Math.max(0, Math.min(1, ratingValue / 2));
      const kdColor = metricColor(kdValue, metricAverages.kd);
      const adrColor = metricColor(adrValue, metricAverages.adr);
      const hsColor = metricColor(hsValue, metricAverages.hs);
      const ratingColor = metricColor(ratingValue, metricAverages.rating);

      return `
        <section class="player ${
          idx === 0 ? "active" : ""
        }" data-player="${dataKey}">
          ${errorBanner}
          <section class="summary">
            <div class="card metric-card expandable kd-card">
              <div class="card-head">
                <h3>Overall K/D</h3>
                <svg class="metric-ring" viewBox="0 0 64 64">
                  <circle class="ring-bg" cx="32" cy="32" r="26"></circle>
                  <circle class="ring-fill" cx="32" cy="32" r="26"
                    data-progress="${kdProgress.toFixed(3)}"
                    style="--ring-color: ${kdColor}"></circle>
                </svg>
              </div>
              <div class="value">${data.overall.kd}</div>
              <div class="sub">Kills ${formatNumber(
                data.overall.kills
              )} · Deaths ${formatNumber(data.overall.deaths)}</div>
              <div class="metric-expand">
                <div class="metric-expand-title">Monthly K/D</div>
                <div class="metric-grid">
                  ${kdMonthlyRows || "<div class=\"metric-empty\">No data.</div>"}
                </div>
              </div>
            </div>
            <div class="card metric-card expandable">
              <div class="card-head">
                <h3>ADR</h3>
                <svg class="metric-ring" viewBox="0 0 64 64">
                  <circle class="ring-bg" cx="32" cy="32" r="26"></circle>
                  <circle class="ring-fill" cx="32" cy="32" r="26"
                    data-progress="${adrProgress.toFixed(3)}"
                    style="--ring-color: ${adrColor}"></circle>
                </svg>
              </div>
              <div class="value">${data.overall.adr}</div>
              <div class="sub">Damage ${formatNumber(
                data.overall.damage
              )}</div>
              <div class="metric-expand">
                <div class="metric-expand-title">Monthly ADR</div>
                <div class="metric-grid">
                  ${adrMonthlyRows || "<div class=\"metric-empty\">No data.</div>"}
                </div>
              </div>
            </div>
            <div class="card metric-card expandable">
              <div class="card-head">
                <h3>Headshot%</h3>
                <svg class="metric-ring" viewBox="0 0 64 64">
                  <circle class="ring-bg" cx="32" cy="32" r="26"></circle>
                  <circle class="ring-fill" cx="32" cy="32" r="26"
                    data-progress="${hsProgress.toFixed(3)}"
                    style="--ring-color: ${hsColor}"></circle>
                </svg>
              </div>
              <div class="value">${data.overall.hs}%</div>
              <div class="sub">Headshots ${formatNumber(
                data.overall.headshots
              )}</div>
              <div class="metric-expand">
                <div class="metric-expand-title">Monthly Headshot%</div>
                <div class="metric-grid">
                  ${hsMonthlyRows || "<div class=\"metric-empty\">No data.</div>"}
                </div>
              </div>
            </div>
            <div class="card metric-card expandable">
              <div class="card-head">
                <h3>Rating 2.0</h3>
                <svg class="metric-ring" viewBox="0 0 64 64">
                  <circle class="ring-bg" cx="32" cy="32" r="26"></circle>
                  <circle class="ring-fill" cx="32" cy="32" r="26"
                    data-progress="${ratingProgress.toFixed(3)}"
                    style="--ring-color: ${ratingColor}"></circle>
                </svg>
              </div>
              <div class="value">${ratingValue.toFixed(2)}</div>
              <div class="sub">Matches ${data.overall.matches} · Rounds ${
        data.overall.rounds
      }</div>
              <div class="metric-expand">
                <div class="metric-expand-title">Monthly Rating</div>
                <div class="metric-grid">
                  ${ratingMonthlyRows || "<div class=\"metric-empty\">No data.</div>"}
                </div>
              </div>
            </div>
            <div class="card wide entry-card" data-entry='${entryByMap}'>
              <div class="card-head">
                <h3>Entry</h3>
                <div class="card-controls">
                  <select class="card-select entry-map">
                    ${mapOptionsHtml}
                  </select>
                  <div class="side-toggle">
                    <button class="side-btn active" data-side="all">All</button>
                    <button class="side-btn" data-side="CT">CT</button>
                    <button class="side-btn" data-side="T">T</button>
                  </div>
                </div>
              </div>
              <div class="value entry-value">${escapeHtml(entrySummary)}</div>
              <div class="sub entry-sub">Attempts ${formatNumber(entryAttempts)}</div>
              <div class="entry-bar"><span></span></div>
            </div>
            <div class="card wide clutch-card" data-clutch='${clutchByMap}'>
              <div class="card-head">
                <h3>Clutches</h3>
                <div class="card-controls">
                  <select class="card-select clutch-map">
                    ${mapOptionsHtml}
                  </select>
                  <div class="side-toggle">
                    <button class="side-btn active" data-side="all">All</button>
                    <button class="side-btn" data-side="CT">CT</button>
                    <button class="side-btn" data-side="T">T</button>
                  </div>
                </div>
              </div>
              <div class="value clutch-value">${escapeHtml(clutchSummary)}</div>
              <div class="clutch-bars"></div>
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
                  <th class="sortable" data-key="map">Map</th>
                  <th class="sortable" data-key="matches">Matches</th>
                  <th class="sortable" data-key="rounds">Rounds</th>
                  <th class="sortable" data-key="kd">K/D</th>
                  <th class="sortable" data-key="adr">ADR</th>
                  <th class="sortable" data-key="hs">HS%</th>
                  <th>Top 3 Weapons</th>
                </tr>
              </thead>
              <tbody>
                ${mapRows}
              </tbody>
            </table>
          </section>

          <section class="section">
            <h2>Duels</h2>
            <div class="list duels-list">
              ${victimsRows || "<p>No data available.</p>"}
            </div>
          </section>

          <section class="section">
            <h2>Troll stats</h2>
            <div class="list troll-list">
              ${trollRows || "<p>No troll kills.</p>"}
            </div>
          </section>

          <section class="section">
            <h2>Performance Compare</h2>
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
                  <th>Week</th>
                  <th>Matches</th>
                  <th>Rounds</th>
                  <th>Rating</th>
                  <th>K/D</th>
                  <th>ADR</th>
                  <th>HS%</th>
                </tr>
              </thead>
              <tbody>
                ${weekRows}
              </tbody>
            </table>
          </section>
        </section>
      `;
    })
    .join("");

  const matchIndexJson = JSON.stringify(matchIndex).replace(/</g, "\\u003c");

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
        min-height: auto;
        padding-bottom: 0;
      }

      .hero {
        padding: 28px 24px 12px;
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
        max-width: 1460px;
        margin: 0 auto;
        padding: 0 24px 0;
      }

      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
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

      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .card-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .card-select {
        background: rgba(18, 24, 35, 0.7);
        color: var(--text);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 12px;
      }

      .side-toggle {
        display: inline-flex;
        gap: 6px;
      }

      .side-btn {
        background: rgba(18, 24, 35, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: var(--text);
        border-radius: 999px;
        font-size: 11px;
        padding: 4px 8px;
        cursor: pointer;
      }

      .side-btn.active {
        border-color: rgba(255, 255, 255, 0.5);
        background: rgba(255, 255, 255, 0.08);
      }

      .card.wide {
        grid-column: span 2;
      }

      @media (min-width: 1200px) {
        .summary {
          grid-template-columns: repeat(4, minmax(240px, 1fr));
        }
      }

      @media (max-width: 900px) {
        .card.wide {
          grid-column: span 1;
        }
      }

      .clutch-bars {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }

      .clutch-row {
        display: grid;
        grid-template-columns: 50px 1fr 52px 80px;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }

      .clutch-bar {
        position: relative;
        height: 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }

      .clutch-bar span {
        position: absolute;
        inset: 0;
        width: 0%;
        background: linear-gradient(90deg, rgba(255, 110, 64, 0.8), rgba(255, 199, 94, 0.9));
      }

      .entry-bar {
        position: relative;
        height: 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        margin-top: 10px;
        overflow: hidden;
      }

      .entry-bar span {
        position: absolute;
        inset: 0;
        width: 0%;
        background: linear-gradient(90deg, rgba(77, 196, 255, 0.7), rgba(86, 220, 151, 0.9));
      }

      .card .value {
        font-size: 26px;
        font-weight: 600;
      }

      .metric-ring {
        width: 64px;
        height: 64px;
      }

      .metric-ring circle {
        fill: none;
        stroke-width: 8;
      }

      .metric-ring .ring-bg {
        stroke: rgba(255, 255, 255, 0.08);
      }

      .metric-ring .ring-fill {
        stroke-linecap: round;
        stroke: var(--ring-color, #4dc4ff);
        transition: stroke-dashoffset 0.4s ease;
      }

      .card.metric-card .card-head {
        align-items: center;
      }

      .metric-card.kd-card {
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .card.expandable {
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .metric-card.kd-card.expanded,
      .card.expandable.expanded {
        transform: translateY(-2px);
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.4);
      }

      .metric-card .value {
        transition: transform 0.2s ease;
      }

      .card.expandable.expanded .value {
        transform: translateY(-4px);
      }

      .metric-expand {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        display: none;
      }

      .metric-card.kd-card.expanded .metric-expand {
        display: block;
      }

      .card.expandable.expanded .metric-expand {
        display: block;
      }

      .metric-expand-title {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--muted);
        margin-bottom: 8px;
      }

      .metric-grid {
        display: grid;
        gap: 6px;
      }

      .metric-row {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        color: #d7dbea;
      }

      .metric-value-block {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .metric-delta {
        font-size: 11px;
        opacity: 0.75;
        min-width: 42px;
        text-align: right;
      }

      .metric-empty {
        color: var(--muted);
        font-size: 13px;
      }

      .metric-row .metric-good {
        color: #4bd37b;
      }

      .metric-row .metric-mid {
        color: #efb560;
      }

      .metric-row .metric-bad {
        color: #ff7b7b;
      }


      .victim-meta {
        color: var(--muted);
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .duel-bar {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 16px;
        min-width: 220px;
        width: 100%;
        border-radius: 999px;
        padding: 0 10px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        overflow: hidden;
      }

      .duel-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        width: calc(var(--duel-share) * 1%);
        opacity: 0.35;
      }

      .duel-fill.win {
        left: 0;
        background: rgba(75, 211, 123, 0.35);
      }

      .duel-fill.loss {
        right: 0;
        background: rgba(255, 123, 123, 0.35);
      }

      .duel-counts {
        position: relative;
        display: flex;
        justify-content: space-between;
        width: 100%;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      .duel-counts .win {
        color: #4bd37b;
      }

      .duel-counts .loss {
        color: #ff7b7b;
      }

      .duels-list .value {
        display: none;
      }

      .duel-rate {
        margin-left: 6px;
        font-size: 12px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }

      .card .sub {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
      }

      .section {
        margin-bottom: 20px;
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
        position: relative;
      }

      th.sortable {
        cursor: pointer;
        user-select: none;
        padding-right: 30px;
      }

      th.sortable::after {
        content: "▲";
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-55%);
        font-size: 9px;
        opacity: 0.35;
      }

      th.sortable::before {
        content: "▼";
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(35%);
        font-size: 9px;
        opacity: 0.35;
      }

      th.sortable[data-sort="asc"]::after,
      th.sortable[data-sort="desc"]::before {
        opacity: 0.8;
      }

      .week-stat {
        white-space: nowrap;
      }

      .week-value {
        display: inline-block;
        min-width: 48px;
      }

      .week-delta {
        margin-left: 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }

      .week-up {
        color: #4bd37b;
      }

      .week-down {
        color: #ff7b7b;
      }

      .week-flat {
        color: #9aa3b2;
      }

      tr:nth-child(even) td {
        background: rgba(255, 255, 255, 0.02);
      }

      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }

      .troll-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }

      .troll-grid .list h3 {
        margin: 0 0 12px;
        font-size: 16px;
        color: #f4f6ff;
      }

      .troll-bar .duel-fill.win {
        background: linear-gradient(90deg, rgba(148, 193, 224, 0.85), rgba(148, 193, 224, 0.35));
      }

      .troll-bar .duel-fill.loss {
        background: linear-gradient(270deg, rgba(255, 215, 75, 0.9), rgba(255, 215, 75, 0.35));
      }

      .troll-list .value {
        display: none;
      }

      .troll-name {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .troll-total-left {
        font-size: 14px;
        font-weight: 600;
        color: #ffd74b;
      }

      .troll-list .duel-counts .win {
        color: #a6d3f2;
      }

      .troll-list .duel-counts .loss {
        color: #ffd74b;
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

      .match-panel {
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr);
        gap: 16px;
        background: var(--panel);
        border-radius: 18px;
        padding: 16px;
        box-shadow: var(--shadow);
        border: 1px solid rgba(255, 255, 255, 0.06);
        min-height: 70vh;
        height: 70vh;
        max-height: 70vh;
        overflow: hidden;
        margin-bottom: 0;
      }

      .match-sidebar {
        display: flex;
        flex-direction: column;
        gap: 8px;
        height: 100%;
        min-height: 0;
        overflow: auto;
        padding-right: 4px;
      }

      .match-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        cursor: pointer;
      }

      .match-item.active {
        border-color: rgba(239, 181, 96, 0.6);
        box-shadow: 0 10px 18px rgba(0, 0, 0, 0.25);
      }

      .match-item .map {
        font-weight: 600;
      }

      .match-meta {
        font-size: 11px;
        color: var(--muted);
      }

      .match-left {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .match-divider {
        margin: 8px 4px 4px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(77, 196, 255, 0.16);
        color: var(--text);
        font-size: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 600;
      }

      .match-score {
        display: flex;
        gap: 6px;
        font-weight: 600;
      }

      .score-t {
        color: #ef8a47;
      }

      .score-ct {
        color: #4dc4ff;
      }

      .match-detail {
        background: rgba(255, 255, 255, 0.02);
        border-radius: 14px;
        padding: 16px;
        min-height: 0;
        overflow: auto;
      }

      .match-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .match-header h3 {
        margin: 0;
        font-size: 18px;
      }

      .match-date {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 12px;
      }

      .match-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .match-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0 8px;
      }

      .match-table thead th {
        text-align: left;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.8px;
      }

      .match-table tbody tr {
        background: rgba(255, 255, 255, 0.03);
      }

      .match-table tbody td {
        padding: 10px 12px;
        font-size: 13px;
      }

      .match-table tbody tr td:first-child {
        border-top-left-radius: 10px;
        border-bottom-left-radius: 10px;
        font-weight: 600;
      }

      .match-table tbody tr td:last-child {
        border-top-right-radius: 10px;
        border-bottom-right-radius: 10px;
      }

      .stat-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        font-variant-numeric: tabular-nums;
      }

      .stat-green {
        color: #7ddf94;
      }

      .stat-green-strong {
        color: #1fdf77;
      }

      .stat-yellow {
        color: #f4d35e;
      }

      .stat-red {
        color: #ff6b6b;
      }

      .mvp-row {
        position: relative;
        background: linear-gradient(90deg, rgba(239, 181, 96, 0.22), rgba(239, 181, 96, 0.05));
        box-shadow: inset 0 0 0 1px rgba(239, 181, 96, 0.25);
      }

      .heat-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: var(--text);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 11px;
        cursor: pointer;
      }

      .heat-row td {
        padding: 12px;
      }

      .heatmap-wrap {
        position: relative;
        width: 100%;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 12px;
        overflow: hidden;
      }

      .heatmap-controls {
        position: absolute;
        top: 10px;
        right: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        z-index: 3;
      }

      .heatmap-control-btn {
        background: rgba(18, 24, 35, 0.75);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: var(--text);
        font-size: 11px;
        padding: 4px 6px;
        cursor: pointer;
      }

      .heatmap-guide {
        position: absolute;
        left: 10px;
        bottom: 10px;
        background: rgba(18, 24, 35, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: var(--text);
        font-size: 11px;
        padding: 6px 8px;
        border-radius: 8px;
        z-index: 3;
        display: none;
      }

      .heatmap-container {
        width: 100%;
      }

      .heatmap-img {
        width: 100%;
        display: block;
        opacity: 0.9;
      }

      .heatmap-canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      .heatmap-canvas.calibrating {
        pointer-events: auto;
        cursor: crosshair;
      }

      .team-block {
        background: rgba(255, 255, 255, 0.02);
        border-radius: 14px;
        padding: 12px;
        margin-bottom: 16px;
      }


      .team-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        font-weight: 600;
      }

      .round-timeline {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 8px;
        margin: 8px 0 16px;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 12px;
        overflow-x: auto;
      }

      .round-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 28px;
        gap: 4px;
        font-size: 10px;
        color: var(--muted);
      }

      .round-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
        border: 2px solid rgba(255, 255, 255, 0.2);
      }

      .round-win-1 .round-dot {
        background: #4dc4ff;
        border-color: #4dc4ff;
      }

      .round-win-2 .round-dot {
        background: #ef8a47;
        border-color: #ef8a47;
      }

      .round-divider {
        width: 2px;
        height: 36px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 999px;
        position: relative;
      }

      .round-divider::after {
        content: "";
        position: absolute;
        right: -6px;
        top: 50%;
        transform: translateY(-50%);
        border-left: 6px solid rgba(255, 255, 255, 0.6);
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
      }

      .match-empty {
        color: var(--muted);
        font-size: 13px;
      }

      .matches-page {
        display: none;
        padding-bottom: 0;
      }

      .matches-page.active {
        display: block;
      }

      .matches-page .section {
        margin-bottom: 0;
      }

      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
        padding: 0 24px 8px;
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

      .matches-tab {
        background: rgba(77, 196, 255, 0.15);
        border-color: rgba(77, 196, 255, 0.4);
        color: #c9f0ff;
        font-weight: 600;
      }

      .matches-tab.active {
        background: #4dc4ff;
        color: #12131a;
        box-shadow: 0 10px 30px rgba(77, 196, 255, 0.35);
      }

      .tab-divider {
        width: 1px;
        background: rgba(255, 255, 255, 0.12);
        margin: 0 4px;
        align-self: stretch;
        border-radius: 999px;
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
        padding: 6px 0 8px;
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
        white-space: normal;
        max-width: 320px;
      }

      .tooltip.kill-tooltip {
        padding: 8px 10px;
      }

      .tooltip .kill-line {
        display: flex;
        align-items: center;
        gap: 6px;
        line-height: 1.2;
      }

      .tooltip .kill-line + .kill-line {
        margin-top: 4px;
        color: var(--muted);
      }

      .tooltip .weapon-icon {
        width: 18px;
        height: 18px;
        object-fit: contain;
        flex: 0 0 auto;
        filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
      }

      .tooltip .kill-tags {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-left: 4px;
      }

      .tooltip .kill-tag {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.06);
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

        .match-panel {
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
      <section class="matches-page" data-page="matches">
        <section class="section">
          <h2>Matches</h2>
          <div class="match-panel" data-match-ids='${escapeHtml(
            JSON.stringify(matchIndex.map((match) => match.id))
          )}'>
            <div class="match-sidebar"></div>
            <div class="match-detail">
              <div class="match-empty">Select a match to see full stats.</div>
            </div>
          </div>
        </section>
      </section>
    </main>
    <div id="tooltip" class="tooltip"></div>
    <script>
      window.MATCH_INDEX = ${matchIndexJson};
    </script>
    <script>
      const tabs = document.querySelectorAll(".tab");
      const playerPanels = document.querySelectorAll(".player");
      const matchesPage = document.querySelector(".matches-page");
      const tooltip = document.getElementById("tooltip");
      const CHART_PADDING = 28;
      const LABEL_PAD_RIGHT = 90;
      const MAP_OVERRIDES = ${JSON.stringify(MAP_OVERRIDES)};
      const matchIndexById = new Map(
        (window.MATCH_INDEX || []).map((match) => [String(match.id), match])
      );

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

      function drawCompareChart(canvas, labels, series, activeKeys, hoverIndex) {
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
        const activeIndices = new Set();
        active.forEach((item) => {
          item.values.forEach((value, idx) => {
            if (value !== null) activeIndices.add(idx);
          });
        });
        const activeIndexList = Array.from(activeIndices).sort((a, b) => a - b);
        const minIdx = activeIndexList.length ? activeIndexList[0] : 0;
        const maxIdx = activeIndexList.length
          ? activeIndexList[activeIndexList.length - 1]
          : labels.length - 1;
        const idxRange = Math.max(1, maxIdx - minIdx);

        active.forEach((item) => {
          const points = item.values.map((value, idx) => {
            if (value === null) return null;
            const x = padding + (innerWidth * (idx - minIdx)) / idxRange;
            const y =
              h - padding - ((value - minVal) / range) * (h - padding * 2);
            return { x, y, value };
          });

          const segments = [];
          let current = [];
          points.forEach((point) => {
            if (point) {
              current.push(point);
            } else if (current.length) {
              segments.push(current);
              current = [];
            }
          });
          if (current.length) segments.push(current);

          ctx.strokeStyle = item.color;
          ctx.lineWidth = 2;
          segments.forEach((segment) => {
            ctx.beginPath();
            segment.forEach((point, idx) => {
              if (idx === 0) ctx.moveTo(point.x, point.y);
              else ctx.lineTo(point.x, point.y);
            });
            ctx.stroke();
          });

          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = item.color;
          segments.forEach((segment) => {
            const firstPoint = segment[0];
            const lastPoint = segment[segment.length - 1];
            ctx.beginPath();
            segment.forEach((point, idx) => {
              if (idx === 0) ctx.moveTo(point.x, point.y);
              else ctx.lineTo(point.x, point.y);
            });
            ctx.lineTo(lastPoint.x, h - padding);
            ctx.lineTo(firstPoint.x, h - padding);
            ctx.closePath();
            ctx.fill();
          });
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
            const x = padding + (innerWidth * (idx - minIdx)) / idxRange;
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
          if (idx < minIdx || idx > maxIdx) return;
          if (idx % 2 !== 0 && labels.length > 6) return;
          const x = padding + (innerWidth * (idx - minIdx)) / idxRange;
          ctx.fillText(label, x - 16, h - 8);
        });

        if (typeof hoverIndex === "number" && hoverIndex >= minIdx && hoverIndex <= maxIdx) {
          const x = padding + (innerWidth * (hoverIndex - minIdx)) / idxRange;
          ctx.save();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, padding - 4);
          ctx.lineTo(x, h - padding + 6);
          ctx.stroke();
          ctx.restore();

          active.forEach((item) => {
            const value = item.values[hoverIndex];
            if (value === null || value === undefined) return;
            const y =
              h - padding - ((value - minVal) / range) * (h - padding * 2);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.fill();
            ctx.strokeStyle = "rgba(10, 12, 18, 0.7)";
            ctx.lineWidth = 1;
            ctx.stroke();
          });
        }
      }

      function showTooltip(event, text, className) {
        tooltip.innerHTML = text;
        tooltip.className = "tooltip" + (className ? " " + className : "");
        tooltip.style.left = event.clientX + "px";
        tooltip.style.top = event.clientY + "px";
        tooltip.style.opacity = "1";
      }

      function hideTooltip() {
        tooltip.style.opacity = "0";
        tooltip.className = "tooltip";
      }

      function safeJsonParse(value, fallback) {
        try {
          if (value == null || value === "") return fallback;
          return JSON.parse(value);
        } catch {
          return fallback;
        }
      }

      function attachTooltip(canvas) {
        const labels = safeJsonParse(canvas.dataset.labels, []);
        const values = safeJsonParse(canvas.dataset.values, []);
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
        const labels = safeJsonParse(canvas.dataset.labels, []);
        const series = safeJsonParse(canvas.dataset.series, []);
        let rafId = null;
        let pendingEvent = null;

        const handleMove = (event) => {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const width = rect.width;
          const padding = CHART_PADDING;
          const innerWidth = width - padding * 2 - LABEL_PAD_RIGHT;
          const activeKeys = (canvas.dataset.active || "")
            .split(",")
            .filter(Boolean);
          const active = series.filter((item) => activeKeys.includes(item.key));
          const activeIndices = new Set();
          active.forEach((item) => {
            item.values.forEach((value, idx) => {
              if (value !== null) activeIndices.add(idx);
            });
          });
          const activeIndexList = Array.from(activeIndices).sort((a, b) => a - b);
          const minIdx = activeIndexList.length ? activeIndexList[0] : 0;
          const maxIdx = activeIndexList.length
            ? activeIndexList[activeIndexList.length - 1]
            : labels.length - 1;
          const idxRange = Math.max(1, maxIdx - minIdx);
          if (x < padding || x > padding + innerWidth) {
            hideTooltip();
            if (canvas.dataset.hoverIndex) {
              delete canvas.dataset.hoverIndex;
              drawCompareChart(canvas, labels, series, activeKeys);
            }
            return;
          }
          const raw = (x - padding) / innerWidth;
          const index = Math.round(raw * idxRange) + minIdx;
          if (canvas.dataset.hoverIndex && Number(canvas.dataset.hoverIndex) === index) {
            return;
          }
          if (index < 0 || index >= labels.length) {
            hideTooltip();
            if (canvas.dataset.hoverIndex) {
              delete canvas.dataset.hoverIndex;
              drawCompareChart(canvas, labels, series, activeKeys);
            }
            return;
          }
          if (!active.length) return;
          canvas.dataset.hoverIndex = String(index);
          drawCompareChart(canvas, labels, series, activeKeys, index);
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
        };

        canvas.addEventListener("mousemove", (event) => {
          pendingEvent = event;
          if (rafId) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (pendingEvent) handleMove(pendingEvent);
            pendingEvent = null;
          });
        });

        canvas.addEventListener("mouseleave", () => {
          hideTooltip();
          if (canvas.dataset.hoverIndex) {
            delete canvas.dataset.hoverIndex;
            const activeKeys = (canvas.dataset.active || "")
              .split(",")
              .filter(Boolean);
            drawCompareChart(canvas, labels, series, activeKeys);
          }
        });
      }

      function renderCharts(root) {
        root.querySelectorAll("canvas").forEach((canvas) => {
          try {
            const labels = safeJsonParse(canvas.dataset.labels, []);
            const values = safeJsonParse(canvas.dataset.values, []);
          if (canvas.dataset.chart === "bar") {
            drawBarChart(canvas, labels, values);
          } else if (canvas.dataset.chart === "compare") {
            const series = safeJsonParse(canvas.dataset.series, []);
            const activeKeys = (canvas.dataset.active || "")
              .split(",")
              .filter(Boolean);
            drawCompareChart(
              canvas,
              labels,
              series,
              activeKeys,
              canvas.dataset.hoverIndex
                ? Number(canvas.dataset.hoverIndex)
                : undefined
            );
            attachCompareTooltip(canvas);
            return;
            } else {
              drawLineChart(canvas, labels, values);
            }
            attachTooltip(canvas);
          } catch (err) {
            console.error("Chart render failed", err);
          }
        });

        root.querySelectorAll(".metric-ring .ring-fill").forEach((ring) => {
          const progress = Number(ring.dataset.progress || 0);
          const radius = Number(ring.getAttribute("r")) || 26;
          const circumference = 2 * Math.PI * radius;
          ring.setAttribute("stroke-dasharray", String(circumference));
          ring.setAttribute(
            "stroke-dashoffset",
            String(circumference * (1 - Math.max(0, Math.min(1, progress))))
          );
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

      function setupSortTables(root) {
        root.querySelectorAll("th.sortable").forEach((th) => {
          th.addEventListener("click", () => {
            const table = th.closest("table");
            const tbody = table ? table.querySelector("tbody") : null;
            if (!tbody) return;

            const key = th.dataset.key;
            const current = th.dataset.sort || "";
            const direction = current === "asc" ? "desc" : "asc";

            table.querySelectorAll("th.sortable").forEach((header) => {
              header.removeAttribute("data-sort");
            });
            th.dataset.sort = direction;

            const rows = Array.from(tbody.querySelectorAll("tr"));
            rows.sort((a, b) => {
              const selector = 'td[data-key="' + key + '"]';
              const aCell = a.querySelector(selector);
              const bCell = b.querySelector(selector);
              const aValue = aCell ? aCell.dataset.value ?? aCell.textContent.trim() : "";
              const bValue = bCell ? bCell.dataset.value ?? bCell.textContent.trim() : "";
              const aNum = Number(aValue);
              const bNum = Number(bValue);
              let compare = 0;

              if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
                compare = aNum - bNum;
              } else {
                compare = String(aValue).localeCompare(String(bValue));
              }

              return direction === "asc" ? compare : -compare;
            });

            rows.forEach((row) => tbody.appendChild(row));
          });
        });
      }

      function setupMetricExpand(root) {
        root.querySelectorAll(".card.expandable").forEach((card) => {
          card.addEventListener("click", (event) => {
            if (event.target.closest("button, a, select, input, label")) return;
            const summary = card.closest(".summary");
            const siblings = summary
              ? summary.querySelectorAll(".card.expandable")
              : [];
            const anyExpanded = Array.from(siblings).some((item) =>
              item.classList.contains("expanded")
            );
            if (anyExpanded) {
              siblings.forEach((item) => item.classList.remove("expanded"));
            } else {
              siblings.forEach((item) => item.classList.add("expanded"));
            }
          });
        });
      }

      function setupEntryClutch(root) {
        root.querySelectorAll(".entry-card").forEach((card) => {
          const entryData = safeJsonParse(card.dataset.entry, {});
          const mapSelect = card.querySelector(".entry-map");
          const sideButtons = card.querySelectorAll(".side-btn");
          const valueEl = card.querySelector(".entry-value");
          const subEl = card.querySelector(".entry-sub");
          const barEl = card.querySelector(".entry-bar span");

          const update = () => {
            const mapKey = mapSelect?.value || "All";
            const side = card.dataset.side || "all";
            const mapData = entryData[mapKey] || entryData.All || null;
            const sideData =
              side === "CT" || side === "T"
                ? mapData?.[side] || mapData?.all
                : mapData?.all;
            const kills = sideData?.kills || 0;
            const deaths = sideData?.deaths || 0;
            const attempts = kills + deaths;
            const rate = attempts ? ((kills / attempts) * 100).toFixed(1) : "0.0";
            valueEl.textContent = attempts
              ? String(kills) +
                " K / " +
                String(deaths) +
                " D · " +
                String(rate) +
                "%"
              : "No entry data";
            subEl.textContent = "Attempts " + String(attempts);
            if (barEl) {
              barEl.style.width = attempts ? String(Math.round(rate)) + "%" : "0%";
            }
          };

          sideButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
              sideButtons.forEach((b) => b.classList.remove("active"));
              btn.classList.add("active");
              card.dataset.side = btn.dataset.side;
              update();
            });
          });
          mapSelect?.addEventListener("change", update);
          card.dataset.side = "all";
          update();
        });

        root.querySelectorAll(".clutch-card").forEach((card) => {
          const clutchData = safeJsonParse(card.dataset.clutch, {});
          const mapSelect = card.querySelector(".clutch-map");
          const sideButtons = card.querySelectorAll(".side-btn");
          const valueEl = card.querySelector(".clutch-value");
          const barsEl = card.querySelector(".clutch-bars");

          const renderBars = (rows) => {
            if (!rows.length) {
              barsEl.innerHTML = "<div class='muted'>No clutch data.</div>";
              return;
            }
            barsEl.innerHTML = rows
              .map((row) => {
                const rate = row.attempts
                  ? Math.round((row.wins / row.attempts) * 100)
                  : 0;
                return (
                  "<div class='clutch-row'>" +
                  "<span>1v" +
                  String(row.amount) +
                  "</span>" +
                  "<div class='clutch-bar'><span style='width:" +
                  String(rate) +
                  "%'></span></div>" +
                  "<span>" +
                  String(rate) +
                  "%</span>" +
                  "<span>" +
                  String(row.wins) +
                  "/" +
                  String(row.attempts) +
                  "</span>" +
                  "</div>"
                );
              })
              .join("");
          };

          const update = () => {
            const mapKey = mapSelect?.value || "All";
            const side = card.dataset.side || "all";
            const mapData = clutchData[mapKey] || clutchData.All || null;
            const sideData =
              side === "CT" || side === "T"
                ? mapData?.[side] || mapData?.all
                : mapData?.all;
            const attempts = sideData?.attempts || 0;
            const wins = sideData?.wins || 0;
            const rate = attempts ? ((wins / attempts) * 100).toFixed(1) : "0.0";
            valueEl.textContent = attempts
              ? String(wins) + "/" + String(attempts) + " · " + String(rate) + "%"
              : "No clutches";
            const rows = (sideData?.byAmount || [])
              .filter((row) => row.amount > 0)
              .sort((a, b) => a.amount - b.amount);
            renderBars(rows);
          };

          sideButtons.forEach((btn) => {
            btn.addEventListener("click", () => {
              sideButtons.forEach((b) => b.classList.remove("active"));
              btn.classList.add("active");
              card.dataset.side = btn.dataset.side;
              update();
            });
          });
          mapSelect?.addEventListener("change", update);
          card.dataset.side = "all";
          update();
        });
      }

      function mapPointToNormalized(point, meta, bounds, imgWidth, imgHeight) {
        if (meta && meta.offset && meta.scale) {
          const offsetX = meta.offset.x ?? meta.offset[0] ?? 0;
          const offsetY = meta.offset.y ?? meta.offset[1] ?? 0;
          const scale = meta.scale || 1;
          let x = (point.x - offsetX) * scale;
          let y = (offsetY - point.y) * scale;
          if (meta.flipH) x = imgWidth - x;
          if (meta.flipV) y = imgHeight - y;
          return { x: x / imgWidth, y: y / imgHeight };
        }
        if (bounds) {
          const spanX = bounds.maxX - bounds.minX;
          const spanY = bounds.maxY - bounds.minY;
          if (spanX <= 0 || spanY <= 0) return null;
          let x = (point.x - bounds.minX) / spanX;
          let y = (bounds.maxY - point.y) / spanY;
          if (meta?.flipH) x = 1 - x;
          if (meta?.flipV) y = 1 - y;
          return { x, y };
        }
        return null;
      }

      function applyMapOverrideNormalized(nx, ny, override) {
        if (!override) return { x: nx, y: ny };
        const rotate = Number(override.rotate || 0);
        if (rotate) {
          const cx = 0.5;
          const cy = 0.5;
          const angle = (rotate * Math.PI) / 180;
          const dx = nx - cx;
          const dy = ny - cy;
          const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
          const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
          nx = rx + cx;
          ny = ry + cy;
        }
        const scale = Number(override.scale || 1);
        if (scale !== 1) {
          nx = (nx - 0.5) * scale + 0.5;
          ny = (ny - 0.5) * scale + 0.5;
        }
        const shiftX = Number(override.shiftX || 0);
        const shiftY = Number(override.shiftY || 0);
        nx += shiftX;
        ny += shiftY;
        return { x: nx, y: ny };
      }

      function applyCalibration(nx, ny, calibration) {
        if (!calibration) return { x: nx, y: ny };
        const { src1, src2, dst1, dst2 } = calibration;
        if (!src1 || !src2 || !dst1 || !dst2) return { x: nx, y: ny };
        const sx = src2.x - src1.x;
        const sy = src2.y - src1.y;
        const tx = dst2.x - dst1.x;
        const ty = dst2.y - dst1.y;
        const sLen = Math.hypot(sx, sy);
        const tLen = Math.hypot(tx, ty);
        if (sLen === 0 || tLen === 0) return { x: nx, y: ny };
        const angle = Math.atan2(ty, tx) - Math.atan2(sy, sx);
        const scale = tLen / sLen;
        const dx = nx - src1.x;
        const dy = ny - src1.y;
        const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
        const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
        return { x: rx * scale + dst1.x, y: ry * scale + dst1.y };
      }

      function mapPointToImage(point, meta, bounds, imgWidth, imgHeight, override) {
        const base = mapPointToNormalized(point, meta, bounds, imgWidth, imgHeight);
        if (!base) return null;
        let nx = base.x;
        let ny = base.y;
        if (override) {
          const adjusted = applyMapOverrideNormalized(nx, ny, override);
          nx = adjusted.x;
          ny = adjusted.y;
          if (override.calibration) {
            const calibrated = applyCalibration(nx, ny, override.calibration);
            nx = calibrated.x;
            ny = calibrated.y;
          }
        }
        return { x: nx * imgWidth, y: ny * imgHeight };
      }

      function renderHeatmap(container, match, playerId) {
        const points = (match.heatmapPoints || {})[playerId] || [];
        if (!match.mapImages || match.mapImages.length === 0) {
          container.innerHTML = '<div class="match-empty">No map image available.</div>';
          return;
        }
        if (!points.length) {
          container.innerHTML = '<div class="match-empty">No kill positions available.</div>';
          return;
        }

        const mapBase = match.mapImageBase || "maps/";
        const sources = match.mapImages
          .map((src) => (src.startsWith("http") ? src : mapBase + src))
          .filter(Boolean);
        if (sources.length === 0) {
          container.innerHTML = '<div class="match-empty">No map image available.</div>';
          return;
        }

        const mapKey = match.mapRawName || match.mapKey || match.mapName || "unknown";
        const baseOverride = match.mapRawName
          ? MAP_OVERRIDES[match.mapRawName] || null
          : null;
        const readStoredOverride = () => {
          if (!match.mapRawName) return null;
          try {
            const raw = localStorage.getItem(
              "heatmap-override:" + match.mapRawName
            );
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        };
        const writeStoredOverride = (override) => {
          if (!match.mapRawName) return;
          localStorage.setItem(
            "heatmap-override:" + match.mapRawName,
            JSON.stringify(override)
          );
        };
        const mergeOverride = (override) => {
          const merged = {
            rotate: 0,
            scale: 1,
            shiftX: 0,
            shiftY: 0,
            calibration: null,
          };
          if (baseOverride) Object.assign(merged, baseOverride);
          if (override) Object.assign(merged, override);
          return merged;
        };
        let override = mergeOverride(readStoredOverride());

        container.innerHTML =
          '<div class="heatmap-wrap">' +
          '<img class="heatmap-img" alt="Map" />' +
          '<canvas class="heatmap-canvas"></canvas>' +
          '<div class="heatmap-guide"></div>' +
          "</div>";

        const wrap = container.querySelector(".heatmap-wrap");
        const img = container.querySelector(".heatmap-img");
        const canvas = container.querySelector(".heatmap-canvas");
        const ctx = canvas.getContext("2d");
        // Avoid canvas security errors when a remote map image is used.
        img.crossOrigin = "anonymous";

        let srcIndex = 0;
        const tryNextSource = () => {
          if (srcIndex >= sources.length) {
            container.innerHTML =
              '<div class="match-empty">Map image not found.</div>';
            return;
          }
          img.src = encodeURI(sources[srcIndex]);
          srcIndex += 1;
        };
        img.addEventListener("error", () => {
          tryNextSource();
        });

        let displayPoints = [];
        let heatmapFilter = "all";
        let calibrationState = null;
        const guide = container.querySelector(".heatmap-guide");

        const updateGuide = (text) => {
          if (!guide) return;
          guide.textContent = text || "";
          guide.style.display = text ? "block" : "none";
        };

        let imageBounds = null;
        const normalizedToPixel = (nx, ny) => {
          if (imageBounds) {
            const width = imageBounds.maxX - imageBounds.minX;
            const height = imageBounds.maxY - imageBounds.minY;
            return {
              x: imageBounds.minX + nx * width,
              y: imageBounds.minY + ny * height,
            };
          }
          return { x: nx * canvas.width, y: ny * canvas.height };
        };
        const pixelToNormalized = (px, py) => {
          if (imageBounds) {
            const width = imageBounds.maxX - imageBounds.minX;
            const height = imageBounds.maxY - imageBounds.minY;
            return {
              x: width ? (px - imageBounds.minX) / width : 0.5,
              y: height ? (py - imageBounds.minY) / height : 0.5,
            };
          }
          return { x: px / canvas.width, y: py / canvas.height };
        };
        const computeImageBounds = () => {
          try {
            const src = String(img.src || "");
            const isRemote = /^https?:\/\//i.test(src);
            const isSameOrigin = src.startsWith(window.location.origin);
            // Remote images will taint the canvas; skip bounds detection.
            if (isRemote && !isSameOrigin) return null;
          } catch {
            // Fall through and try; worst case we catch below.
          }
          const tmp = document.createElement("canvas");
          tmp.width = canvas.width;
          tmp.height = canvas.height;
          const tctx = tmp.getContext("2d");
          try {
            tctx.drawImage(img, 0, 0, tmp.width, tmp.height);
          } catch {
            return null;
          }
          let data;
          try {
            data = tctx.getImageData(0, 0, tmp.width, tmp.height).data;
          } catch {
            // Canvas is tainted (likely remote image). Gracefully skip bounds.
            return null;
          }
          let minX = tmp.width;
          let minY = tmp.height;
          let maxX = 0;
          let maxY = 0;
          let found = false;
          for (let y = 0; y < tmp.height; y += 1) {
            for (let x = 0; x < tmp.width; x += 1) {
              const idx = (y * tmp.width + x) * 4;
              const alpha = data[idx + 3];
              if (alpha > 10) {
                found = true;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (!found) return null;
          return { minX, minY, maxX, maxY };
        };

        const escapeHtmlClient = (value) =>
          String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");

        const weaponSpritePath = (weaponName) => {
          const slug = String(weaponName || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
          if (!slug) return null;
          return "weapons/" + slug + ".png";
        };

        const describeKill = (pt) => {
          const tags = [];
          if (pt.isHeadshot) tags.push("HS");
          if (pt.isWallbang) tags.push("wallbang");
          if (pt.isNoscope) tags.push("noscope");
          if (pt.flashed) tags.push("flashed");
          if (pt.flashAssist) tags.push("+flash");
          const roundLabel = pt.roundIndex ? "R" + pt.roundIndex : "R?";
          const victimLabel = escapeHtmlClient(pt.victimName || "unknown");
          const weaponLabel = escapeHtmlClient(pt.weaponName || "weapon");
          const spritePath = weaponSpritePath(pt.weaponName);
          const spriteHtml = spritePath
            ? "<img class='weapon-icon' src='" +
              spritePath +
              "' alt='' onerror='this.style.display=&quot;none&quot;'>"
            : "";
          const tagsHtml = tags.length
            ? "<span class='kill-tags'>" +
              tags
                .map(
                  (tag) =>
                    "<span class='kill-tag'>" + escapeHtmlClient(tag) + "</span>"
                )
                .join("") +
              "</span>"
            : "";
          const line1 =
            "<div class='kill-line'><strong>" +
            roundLabel +
            "</strong><span>· " +
            victimLabel +
            "</span></div>";
          const line2 =
            "<div class='kill-line'>" +
            spriteHtml +
            "<span class='weapon-name'>" +
            weaponLabel +
            "</span>" +
            tagsHtml +
            "</div>";
          return line1 + line2;
        };

        const drawPoints = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          displayPoints = [];
          points.forEach((point) => {
            if (heatmapFilter === "ct" && point.side !== "CT") return;
            if (heatmapFilter === "t" && point.side !== "T") return;
            const base = mapPointToNormalized(
              point,
              match.mapMeta,
              match.mapBounds,
              canvas.width,
              canvas.height
            );
            if (!base) return;
            let nx = base.x;
            let ny = base.y;
            if (override) {
              const adjusted = applyMapOverrideNormalized(nx, ny, override);
              nx = adjusted.x;
              ny = adjusted.y;
              if (override.calibration) {
                const calibrated = applyCalibration(nx, ny, override.calibration);
                nx = calibrated.x;
                ny = calibrated.y;
              }
            }
            const mapped = normalizedToPixel(nx, ny);
            displayPoints.push({
              nx: base.x,
              ny: base.y,
              px: mapped.x,
              py: mapped.y,
              side: point.side || null,
              roundIndex: point.roundIndex || null,
              createdAt: point.createdAt || null,
              victimId: point.victimId || null,
              victimName: point.victimName || "unknown",
              weaponName: point.weaponName || "unknown",
              isHeadshot: Boolean(point.isHeadshot),
              isWallbang: Boolean(point.isWallbang),
              isNoscope: Boolean(point.isNoscope),
              flashed: Boolean(point.flashed),
              flashAssist: Boolean(point.flashAssist),
            });
          });

          if (!displayPoints.length) return;

          const imgData = ctx.createImageData(canvas.width, canvas.height);
          const data = imgData.data;
          const size = canvas.width * canvas.height;
          const ctHeat = new Float32Array(size);
          const tHeat = new Float32Array(size);
          const radius = 24;
          const denom = Math.max(1, radius * radius);
          for (const pt of displayPoints) {
            const minX = Math.max(0, Math.floor(pt.px - radius));
            const maxX = Math.min(canvas.width - 1, Math.ceil(pt.px + radius));
            const minY = Math.max(0, Math.floor(pt.py - radius));
            const maxY = Math.min(canvas.height - 1, Math.ceil(pt.py + radius));
            for (let y = minY; y <= maxY; y += 1) {
              for (let x = minX; x <= maxX; x += 1) {
                const dx = x - pt.px;
                const dy = y - pt.py;
                const distSq = dx * dx + dy * dy;
                if (distSq > radius * radius) continue;
                const value = Math.exp(-distSq / denom);
                const cell = y * canvas.width + x;
                if (pt.side === "CT") {
                  ctHeat[cell] += value;
                } else if (pt.side === "T") {
                  tHeat[cell] += value;
                } else {
                  // Unknown side: contribute lightly to both.
                  ctHeat[cell] += value * 0.5;
                  tHeat[cell] += value * 0.5;
                }
              }
            }
          }

          let maxCt = 0;
          let maxT = 0;
          for (let i = 0; i < size; i += 1) {
            if (ctHeat[i] > maxCt) maxCt = ctHeat[i];
            if (tHeat[i] > maxT) maxT = tHeat[i];
          }
          const ctDen = maxCt > 0 ? maxCt : 1;
          const tDen = maxT > 0 ? maxT : 1;

          for (let i = 0; i < size; i += 1) {
            const ctI = Math.min(1, ctHeat[i] / ctDen);
            const tI = Math.min(1, tHeat[i] / tDen);
            const intensity = Math.max(ctI, tI);
            const idx = i * 4;
            if (intensity <= 0) {
              data[idx + 3] = 0;
              continue;
            }
            // Blend CT blue and T orange by their relative strength.
            const mixDen = ctI + tI || 1;
            const ctW = ctI / mixDen;
            const tW = tI / mixDen;
            const r = 77 * ctW + 239 * tW;
            const g = 196 * ctW + 138 * tW;
            const b = 255 * ctW + 71 * tW;
            const alpha = Math.min(0.75, intensity * 0.95);
            data[idx] = Math.round(r);
            data[idx + 1] = Math.round(g);
            data[idx + 2] = Math.round(b);
            data[idx + 3] = Math.round(alpha * 255);
          }
          ctx.putImageData(imgData, 0, 0);

          // Draw semi-transparent colored dots on top for readability.
          const dotRadius = 4;
          for (const pt of displayPoints) {
            const isCT = pt.side === "CT";
            const isT = pt.side === "T";
            const fillColor = isCT
              ? "rgba(77, 196, 255, 0.35)"
              : isT
              ? "rgba(239, 138, 71, 0.35)"
              : "rgba(255, 255, 255, 0.3)";
            const strokeColor = isCT
              ? "rgba(77, 196, 255, 0.95)"
              : isT
              ? "rgba(239, 138, 71, 0.95)"
              : "rgba(255, 255, 255, 0.85)";
            ctx.fillStyle = fillColor;
            ctx.beginPath();
            ctx.arc(pt.px, pt.py, dotRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = strokeColor;
            ctx.stroke();
          }

          if (calibrationState) {
            ctx.fillStyle = "rgba(255,255,255,0.7)";
            displayPoints.forEach((pt) => {
              ctx.beginPath();
              ctx.arc(pt.px, pt.py, 3, 0, Math.PI * 2);
              ctx.fill();
            });
          }
        };

        img.addEventListener("load", () => {
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          imageBounds = computeImageBounds();
          drawPoints();
          if (match.mapRawName) {
            const controls = document.createElement("div");
            controls.className = "heatmap-controls";
            controls.innerHTML =
              "<button class='heatmap-control-btn' data-action='left'>◀</button>" +
              "<button class='heatmap-control-btn' data-action='right'>▶</button>" +
              "<button class='heatmap-control-btn' data-action='up'>▲</button>" +
              "<button class='heatmap-control-btn' data-action='down'>▼</button>" +
              "<button class='heatmap-control-btn' data-action='rotl'>⟲</button>" +
              "<button class='heatmap-control-btn' data-action='rotr'>⟳</button>" +
              "<button class='heatmap-control-btn' data-action='zoomIn'>＋</button>" +
              "<button class='heatmap-control-btn' data-action='zoomOut'>－</button>" +
              "<button class='heatmap-control-btn' data-action='filterAll'>All</button>" +
              "<button class='heatmap-control-btn' data-action='filterCT'>CT</button>" +
              "<button class='heatmap-control-btn' data-action='filterT'>T</button>" +
              "<button class='heatmap-control-btn' data-action='calibrate'>Calibrate</button>" +
              "<button class='heatmap-control-btn' data-action='reset'>Reset</button>";
            container.querySelector(".heatmap-wrap").appendChild(controls);
            controls.addEventListener("click", (event) => {
              const action = event.target?.dataset?.action;
              if (!action) return;
              const step = 0.02;
              const zoomStep = 0.06;
              if (action === "left") override.shiftX -= step;
              if (action === "right") override.shiftX += step;
              if (action === "up") override.shiftY -= step;
              if (action === "down") override.shiftY += step;
              if (action === "rotl") override.rotate = (override.rotate || 0) - 90;
              if (action === "rotr") override.rotate = (override.rotate || 0) + 90;
              if (action === "zoomIn") override.scale = (override.scale || 1) + zoomStep;
              if (action === "zoomOut") override.scale = Math.max(0.5, (override.scale || 1) - zoomStep);
              if (action === "filterAll") heatmapFilter = "all";
              if (action === "filterCT") heatmapFilter = "ct";
              if (action === "filterT") heatmapFilter = "t";
              if (action === "calibrate") {
                calibrationState = {
                  step: "pickSource",
                  pairs: [],
                  pending: null,
                };
                canvas.classList.add("calibrating");
                updateGuide(
                  "Calibration: click a dot to select source (1/2)."
                );
                return;
              }
              if (action === "reset") {
                override = mergeOverride(null);
                writeStoredOverride(null);
                drawPoints();
                calibrationState = null;
                canvas.classList.remove("calibrating");
                updateGuide("");
                return;
              }
              writeStoredOverride(override);
              drawPoints();
            });
          }
        });

        // Hover tooltip for kill dots.
        if (wrap) {
          wrap.addEventListener("mousemove", (event) => {
            if (!displayPoints.length || calibrationState) {
              hideTooltip();
              return;
            }
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const px = (event.clientX - rect.left) * scaleX;
            const py = (event.clientY - rect.top) * scaleY;
            const threshold = 10 * Math.max(scaleX, scaleY);
            let best = null;
            let bestDist = threshold * threshold;
            for (const pt of displayPoints) {
              const dx = pt.px - px;
              const dy = pt.py - py;
              const dist = dx * dx + dy * dy;
              if (dist <= bestDist) {
                best = pt;
                bestDist = dist;
              }
            }
            if (!best) {
              hideTooltip();
              return;
            }
            showTooltip(event, describeKill(best), "kill-tooltip");
          });
          wrap.addEventListener("mouseleave", hideTooltip);
        }

        canvas.addEventListener("click", (event) => {
          if (!calibrationState) return;
          const rect = canvas.getBoundingClientRect();
          const clickX = event.clientX - rect.left;
          const clickY = event.clientY - rect.top;
          const scaleX = canvas.width / rect.width;
          const scaleY = canvas.height / rect.height;
          const clickCanvasX = clickX * scaleX;
          const clickCanvasY = clickY * scaleY;
          if (calibrationState.step === "pickSource") {
            if (!displayPoints.length) {
              updateGuide("No dots available for calibration.");
              return;
            }
            let best = null;
            let bestDist = Infinity;
            for (const pt of displayPoints) {
              const dx = pt.px - clickCanvasX;
              const dy = pt.py - clickCanvasY;
              const dist = Math.hypot(dx, dy);
              if (dist < bestDist) {
                best = pt;
                bestDist = dist;
              }
            }
            if (!best || bestDist > 24) {
              updateGuide("Click closer to a dot for source (1/2).");
              return;
            }
            calibrationState.pending = { src: { x: best.nx, y: best.ny } };
            calibrationState.step = "pickTarget";
            updateGuide("Click target position on the map (1/2).");
            return;
          }
          if (calibrationState.step === "pickTarget") {
            const target = pixelToNormalized(clickCanvasX, clickCanvasY);
            const nx = target.x;
            const ny = target.y;
            calibrationState.pending.dst = { x: nx, y: ny };
            calibrationState.pairs.push(calibrationState.pending);
            calibrationState.pending = null;
            if (calibrationState.pairs.length >= 2) {
              const [p1, p2] = calibrationState.pairs;
              override.calibration = {
                src1: p1.src,
                src2: p2.src,
                dst1: p1.dst,
                dst2: p2.dst,
              };
              writeStoredOverride(override);
              drawPoints();
              calibrationState = null;
              canvas.classList.remove("calibrating");
              updateGuide("Calibration saved.");
              return;
            }
            calibrationState.step = "pickSource";
            updateGuide("Click a second dot to select source (2/2).");
          }
        });

        tryNextSource();
      }

      function formatMatchScore(match) {
        const tScore = match.tScore ?? "-";
        const ctScore = match.ctScore ?? "-";
        return (
          '<span class="score-t">' +
          tScore +
          '</span>:<span class="score-ct">' +
          ctScore +
          "</span>"
        );
      }

      function renderMatchPanel(panel) {
        const sidebar = panel.querySelector(".match-sidebar");
        const detail = panel.querySelector(".match-detail");
        let matchIds = [];
        try {
          matchIds = JSON.parse(panel.dataset.matchIds || "[]");
        } catch {
          matchIds = [];
        }
        const matches = matchIds
          .map((id) => matchIndexById.get(String(id)))
          .filter(Boolean);
        if (!matches.length) {
          sidebar.innerHTML = '<div class="match-empty">No matches available.</div>';
          detail.innerHTML = '<div class="match-empty">No match data to display.</div>';
          return;
        }

        const monthNames = [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ];
        let lastDate = null;
        sidebar.innerHTML = matches
          .map((match, idx) => {
            const active = idx === 0 ? "active" : "";
            let dateLabel = "Unknown date";
            let yearLabel = "";
            if (match.startedAt) {
              const date = new Date(match.startedAt);
              const day = String(date.getDate()).padStart(2, "0");
              const month = monthNames[date.getMonth()];
              const year = date.getFullYear();
              dateLabel = day + " " + month;
              yearLabel = String(year);
            }
            const divider =
              dateLabel !== lastDate
                ? '<div class="match-divider"><span>' +
                  dateLabel +
                  "</span><span>" +
                  yearLabel +
                  "</span></div>"
                : "";
            lastDate = dateLabel;
            return (
              divider +
              '<div class="match-item ' +
              active +
              '" data-id="' +
              match.id +
              '">' +
              '<div class="match-left">' +
              '<div class="map">' +
              match.mapName +
              "</div>" +
              "</div>" +
              '<div class="match-score">' +
              formatMatchScore(match) +
              "</div>" +
              "</div>"
            );
          })
          .join("");

        const renderDetail = (match) => {
          const dateLabel = match.startedAt
            ? new Date(match.startedAt).toLocaleString()
            : "Unknown date";
          const teamIds = match.teamIds || [];
          const team1Id = teamIds[0] || null;
          const team2Id = teamIds[1] || null;
          const team1Label = "Team 1";
          const team2Label = "Team 2";
          const team1 = match.players
            .filter((player) => player.teamId === team1Id)
            .sort((a, b) => b.kills - a.kills);
          const team2 = match.players
            .filter((player) => player.teamId === team2Id)
            .sort((a, b) => b.kills - a.kills);
          const allPlayers = [...team1, ...team2];
          const mvp = allPlayers.reduce((best, player) => {
            if (!best) return player;
            if (player.kills > best.kills) return player;
            if (player.kills === best.kills && player.adr > best.adr) return player;
            return best;
          }, null);

          const renderTeamRows = (players) => {
            const totalKills = players.reduce((sum, p) => sum + p.kills, 0);
            const avgKills = players.length ? totalKills / players.length : 0;
            const upperKill = avgKills * 1.1;
            const lowerKill = avgKills * 0.9;

            return players
              .map((player) => {
                const kdValue =
                  player.deaths > 0
                    ? player.kills / player.deaths
                    : Number.POSITIVE_INFINITY;
                const kdDisplay =
                  player.deaths > 0 ? kdValue.toFixed(2) : "∞";

                let killClass = "";
                if (player.kills > upperKill) killClass = "stat-green";
                else if (player.kills < lowerKill) killClass = "stat-red";

                let kdClass = "";
                if (kdValue >= 1.5) kdClass = "stat-green-strong";
                else if (kdValue >= 1.1) kdClass = "stat-green";
                else if (kdValue >= 0.9) kdClass = "stat-yellow";
                else kdClass = "stat-red";

                const rowClass =
                  mvp && mvp.id === player.id ? "mvp-row" : "";
                return (
                  '<tr class="' +
                  rowClass +
                  '">' +
                  "<td>" +
                  player.nick +
                  "</td>" +
                  "<td><span class='stat-chip " +
                  killClass +
                  "'>" +
                  player.kills +
                  "</span></td>" +
                  "<td><span class='stat-chip'>" +
                  player.deaths +
                  "</span></td>" +
                  "<td><span class='stat-chip " +
                  kdClass +
                  "'>" +
                  kdDisplay +
                  "</span></td>" +
                  "<td><span class='stat-chip'>" +
                  player.adr +
                  "</span></td>" +
                  "<td><span class='stat-chip'>" +
                  player.hs +
                  "%</span></td>" +
                  "<td><button class='heat-btn' data-player='" +
                  player.id +
                  "'>Heat</button></td>" +
                  "</tr>"
                );
              })
              .join("");
          };

          const rounds = match.roundsList || [];
          let score1 = 0;
          let score2 = 0;
          const dividerPositions = new Set();
          if (rounds.length > 12) dividerPositions.add(12);
          if (rounds.length > 24) dividerPositions.add(24);
          if (rounds.length > 24) {
            for (let idx = 30; idx < rounds.length; idx += 6) {
              dividerPositions.add(idx);
            }
          }

          let timeline = '<div class="round-timeline">';
          rounds.forEach((round, idx) => {
            const winner = round.winMatchTeamId || null;
            if (winner && winner === team1Id) score1 += 1;
            if (winner && winner === team2Id) score2 += 1;
            const winClass =
              winner === team1Id
                ? "round-win-1"
                : winner === team2Id
                ? "round-win-2"
                : "";
            timeline +=
              '<div class="round-item ' +
              winClass +
              '">' +
              '<div class="round-top">' +
              score1 +
              "</div>" +
              '<div class="round-dot"></div>' +
              '<div class="round-bottom">' +
              score2 +
              "</div>" +
              "</div>";
            if (dividerPositions.has(idx + 1)) {
              timeline += '<div class="round-divider"></div>';
            }
          });
          timeline += "</div>";

          detail.innerHTML =
            '<div class="match-header">' +
            '<div class="match-header-left">' +
            '<h3>' +
            match.mapName +
            '</h3>' +
            '<div class="match-date">' +
            dateLabel +
            '</div>' +
            '</div>' +
            '<div class="match-score">' +
            formatMatchScore(match) +
            '</div>' +
            '</div>' +
            '<div class="team-block">' +
            '<div class="team-title">' +
            team1Label +
            "</div>" +
            '<table class="match-table">' +
            '<thead>' +
            '<tr>' +
            '<th>Player</th>' +
            '<th>K</th>' +
            '<th>D</th>' +
            '<th>K/D</th>' +
            '<th>ADR</th>' +
            '<th>HS%</th>' +
            '<th></th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            (renderTeamRows(team1) ||
              '<tr><td colspan="7">No stats available.</td></tr>') +
            '</tbody>' +
            '</table>' +
            '</div>' +
            timeline +
            '<div class="team-block">' +
            '<div class="team-title">' +
            team2Label +
            "</div>" +
            '<table class="match-table">' +
            '<thead>' +
            '<tr>' +
            '<th>Player</th>' +
            '<th>K</th>' +
            '<th>D</th>' +
            '<th>K/D</th>' +
            '<th>ADR</th>' +
            '<th>HS%</th>' +
            '<th></th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            (renderTeamRows(team2) ||
              '<tr><td colspan="7">No stats available.</td></tr>') +
            '</tbody>' +
            '</table>' +
            '</div>';

          detail.querySelectorAll(".heat-btn").forEach((button) => {
            button.addEventListener("click", () => {
              const playerId = button.dataset.player;
              const row = button.closest("tr");
              if (!row) return;
              const existing = row.nextElementSibling;
              if (existing && existing.classList.contains("heat-row")) {
                existing.remove();
                return;
              }
              const openRow = row.parentElement.querySelector(".heat-row");
              if (openRow) openRow.remove();
              const heatRow = document.createElement("tr");
              heatRow.className = "heat-row";
              heatRow.innerHTML =
                '<td colspan="7"><div class="heatmap-container"></div></td>';
              row.insertAdjacentElement("afterend", heatRow);
              const container = heatRow.querySelector(".heatmap-container");
              renderHeatmap(container, match, playerId);
            });
          });
        };

        const firstMatch = matches[0];
        renderDetail(firstMatch);

        sidebar.querySelectorAll(".match-item").forEach((item) => {
          item.addEventListener("click", () => {
            sidebar.querySelectorAll(".match-item").forEach((row) =>
              row.classList.toggle("active", row === item)
            );
            const match = matches.find((m) => String(m.id) === item.dataset.id);
            if (match) renderDetail(match);
          });
        });
      }

      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const target = tab.dataset.target;
          tabs.forEach((t) => t.classList.toggle("active", t === tab));

          if (target === "matches") {
            playerPanels.forEach((panel) => panel.classList.remove("active"));
            if (matchesPage) {
              matchesPage.classList.add("active");
              matchesPage
                .querySelectorAll(".match-panel")
                .forEach(renderMatchPanel);
            }
            return;
          }

          if (matchesPage) matchesPage.classList.remove("active");

          playerPanels.forEach((panel) => {
            const active = panel.dataset.player === target;
            panel.classList.toggle("active", active);
            if (active) {
              renderCharts(panel);
              setupCompare(panel);
              setupSortTables(panel);
              setupMetricExpand(panel);
              setupEntryClutch(panel);
            }
          });
        });
      });

      playerPanels.forEach((panel, idx) => {
        if (idx === 0) {
          renderCharts(panel);
          setupCompare(panel);
          setupSortTables(panel);
          setupMetricExpand(panel);
          setupEntryClutch(panel);
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
