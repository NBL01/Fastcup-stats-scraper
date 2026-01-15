import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseMatchId(filename) {
  const match = filename.match(/-(\d+)\.json$/);
  return match ? match[1] : null;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function buildTopWeapons(weaponKills, weaponNameById, limit = 3) {
  const entries = Array.from(weaponKills.entries())
    .map(([weaponId, count]) => ({
      id: weaponId,
      count,
      name: weaponNameById.get(weaponId) || `weapon-${weaponId}`,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return entries;
}

export async function computeStats(outDir, targetArg) {
  const targetId = /^\d+$/.test(targetArg) ? Number(targetArg) : null;
  const targetNames = targetId
    ? []
    : String(targetArg)
        .split(",")
        .map((name) => normalizeName(name.trim()))
        .filter(Boolean);

  const files = await fs.readdir(outDir);
  const weaponsFile = files.find((file) => file.includes("GetWeapons"));
  const matchStatsFiles = files.filter((file) =>
    file.includes("GetMatchStats-")
  );

  const killsFiles = new Map();
  const damagesFiles = new Map();

  for (const file of files) {
    if (file.includes("GetMatchKills-")) {
      const matchId = parseMatchId(file);
      if (matchId) killsFiles.set(matchId, file);
    }
    if (file.includes("GetMatchDamages-")) {
      const matchId = parseMatchId(file);
      if (matchId) damagesFiles.set(matchId, file);
    }
  }

  if (!weaponsFile || matchStatsFiles.length === 0) {
    throw new Error(
      "Missing required files. Ensure GetWeapons and GetMatchStats JSON files are present in out/."
    );
  }

  const weaponsData = await readJson(path.join(outDir, weaponsFile));
  const weaponNameById = new Map();
  const zeusWeaponIds = new Set();
  for (const weapon of weaponsData.data?.weapons || []) {
    const name = weapon.name || weapon.internalName || "unknown";
    weaponNameById.set(weapon.id, name);
    const lower = String(name).toLowerCase();
    if (lower.includes("zeus")) {
      zeusWeaponIds.add(weapon.id);
    }
  }

  const mapStats = new Map();
  const overall = {
    matches: 0,
    rounds: 0,
    kills: 0,
    deaths: 0,
    headshots: 0,
    damage: 0,
  };
  const victimKills = new Map();
  const duelCounts = new Map();
  const zeusVictims = new Map();
  const weaponKillsOverall = new Map();
  const monthly = new Map();
  let matchesWithTarget = 0;
  let matchesScanned = 0;
  let targetUserId = null;

  for (const statsFile of matchStatsFiles) {
    const matchId = parseMatchId(statsFile);
    if (!matchId) continue;

    matchesScanned += 1;
    const statsData = await readJson(path.join(outDir, statsFile));
    const match = statsData.data?.match;
    if (!match) continue;

    const members = match.members || [];
    let userId = targetId;

    if (!userId) {
      const found = members.find((member) => {
        const nick = member.private?.user?.nickName;
        return targetNames.includes(normalizeName(nick));
      });
      if (found) {
        userId = found.private?.user?.id || null;
      }
    }

    if (!userId) continue;
    if (
      targetId &&
      !members.some((member) => member.private?.user?.id === targetId)
    ) {
      continue;
    }
    if (!targetUserId) targetUserId = userId;
    matchesWithTarget += 1;

    const mapNameByMatchMapId = new Map();
    for (const mapEntry of match.maps || []) {
      const mapName = mapEntry.map?.name || `map-${mapEntry.id}`;
      mapNameByMatchMapId.set(mapEntry.id, mapName);
    }

    const roundToMap = new Map();
    const roundsByMap = new Map();
    for (const round of match.rounds || []) {
      const mapName =
        mapNameByMatchMapId.get(round.matchMapId) || `map-${round.matchMapId}`;
      roundToMap.set(round.id, mapName);
      roundsByMap.set(mapName, (roundsByMap.get(mapName) || 0) + 1);
    }

    const killsData = killsFiles.get(matchId)
      ? await readJson(path.join(outDir, killsFiles.get(matchId)))
      : null;
    const damagesData = damagesFiles.get(matchId)
      ? await readJson(path.join(outDir, damagesFiles.get(matchId)))
      : null;

    const kills = killsData?.data?.kills || [];
    const damages = damagesData?.data?.damages || [];

    const ensureMap = (mapName) => {
      if (!mapStats.has(mapName)) {
        mapStats.set(mapName, {
          matches: 0,
          rounds: 0,
          kills: 0,
          deaths: 0,
          headshots: 0,
          damage: 0,
          weaponKills: new Map(),
        });
      }
      return mapStats.get(mapName);
    };

    for (const [mapName, roundCount] of roundsByMap.entries()) {
      const stats = ensureMap(mapName);
      stats.matches += 1;
      stats.rounds += roundCount;
    }

    overall.matches += 1;
    for (const count of roundsByMap.values()) {
      overall.rounds += count;
    }

    const monthKey = match.startedAt
      ? new Date(match.startedAt).toISOString().slice(0, 7)
      : "unknown";
    if (!monthly.has(monthKey)) {
      monthly.set(monthKey, {
        matches: 0,
        rounds: 0,
        kills: 0,
        deaths: 0,
        headshots: 0,
        damage: 0,
      });
    }
    const monthStats = monthly.get(monthKey);
    monthStats.matches += 1;
    for (const count of roundsByMap.values()) {
      monthStats.rounds += count;
    }

    for (const kill of kills) {
      if (kill.isTeamkill) continue;
      const mapName = roundToMap.get(kill.roundId) || "unknown";
      const stats = ensureMap(mapName);

      if (kill.killerId === userId) {
        stats.kills += 1;
        overall.kills += 1;
        monthStats.kills += 1;
        if (kill.isHeadshot) stats.headshots += 1;
        if (kill.isHeadshot) {
          overall.headshots += 1;
          monthStats.headshots += 1;
        }
        const weaponId = kill.weaponId;
        if (weaponId) {
          stats.weaponKills.set(
            weaponId,
            (stats.weaponKills.get(weaponId) || 0) + 1
          );
          weaponKillsOverall.set(
            weaponId,
            (weaponKillsOverall.get(weaponId) || 0) + 1
          );
        }

        if (kill.victimId) {
          victimKills.set(
            kill.victimId,
            (victimKills.get(kill.victimId) || 0) + 1
          );
          const duel = duelCounts.get(kill.victimId) || { kills: 0, deaths: 0 };
          duel.kills += 1;
          duelCounts.set(kill.victimId, duel);
        }

        if (kill.victimId && zeusWeaponIds.has(kill.weaponId)) {
          zeusVictims.set(
            kill.victimId,
            (zeusVictims.get(kill.victimId) || 0) + 1
          );
        }
      }

      if (kill.victimId === userId) {
        stats.deaths += 1;
        overall.deaths += 1;
        monthStats.deaths += 1;

        if (kill.killerId) {
          const duel = duelCounts.get(kill.killerId) || { kills: 0, deaths: 0 };
          duel.deaths += 1;
          duelCounts.set(kill.killerId, duel);
        }
      }
    }

    for (const damage of damages) {
      if (damage.inflictorId !== userId) continue;
      const mapName = roundToMap.get(damage.roundId) || "unknown";
      const stats = ensureMap(mapName);
      stats.damage += Number(damage.damageReal || 0);
      overall.damage += Number(damage.damageReal || 0);
      monthStats.damage += Number(damage.damageReal || 0);
    }
  }

  const rows = Array.from(mapStats.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const overallKd =
    overall.deaths > 0 ? (overall.kills / overall.deaths).toFixed(2) : "∞";
  const overallAdr =
    overall.rounds > 0 ? (overall.damage / overall.rounds).toFixed(1) : "0.0";
  const overallHs =
    overall.kills > 0
      ? ((overall.headshots / overall.kills) * 100).toFixed(1)
      : "0.0";

  let overallFavoriteWeapon = "-";
  let overallFavoriteWeaponCount = 0;
  for (const [weaponId, count] of weaponKillsOverall.entries()) {
    if (count > overallFavoriteWeaponCount) {
      overallFavoriteWeaponCount = count;
      overallFavoriteWeapon = weaponNameById.get(weaponId) || `weapon-${weaponId}`;
    }
  }
  const overallTopWeapons = buildTopWeapons(weaponKillsOverall, weaponNameById, 3);

  const mapRows = rows.map(([mapName, stats]) => {
    const kd =
      stats.deaths > 0
        ? (stats.kills / stats.deaths).toFixed(2)
        : "∞";
    const adr =
      stats.rounds > 0 ? (stats.damage / stats.rounds).toFixed(1) : "0.0";
    const hs =
      stats.kills > 0
        ? ((stats.headshots / stats.kills) * 100).toFixed(1)
        : "0.0";

    const topWeapons = buildTopWeapons(stats.weaponKills, weaponNameById, 3);

    return {
      mapName,
      matches: stats.matches,
      rounds: stats.rounds,
      kills: stats.kills,
      deaths: stats.deaths,
      headshots: stats.headshots,
      damage: stats.damage,
      kd,
      adr,
      hs,
      topWeapons,
    };
  });

  const memberIdToName = new Map();
  let latestTargetName = null;
  let latestTargetAt = null;

  for (const statsFile of matchStatsFiles) {
    const statsData = await readJson(path.join(outDir, statsFile));
    const match = statsData.data?.match;
    const members = match?.members || [];
    const matchAt = match?.startedAt ? new Date(match.startedAt).getTime() : null;
    for (const member of members) {
      const id = member.private?.user?.id;
      const nick = member.private?.user?.nickName;
      if (id && nick) {
        const existing = memberIdToName.get(id);
        if (!existing || (matchAt && matchAt > existing.at)) {
          memberIdToName.set(id, { name: nick, at: matchAt || 0 });
        }
      }
    }

    if (matchAt && targetUserId && members.length) {
      const targetMember = members.find(
        (member) => member.private?.user?.id === targetUserId
      );
      const targetNick = targetMember?.private?.user?.nickName;
      if (targetNick && (!latestTargetAt || matchAt > latestTargetAt)) {
        latestTargetAt = matchAt;
        latestTargetName = targetNick;
      }
    }
  }

  const topVictims = Array.from(victimKills.entries())
    .map(([id, count]) => ({
      id,
      count,
      name: memberIdToName.get(id)?.name || `user-${id}`,
      duels: duelCounts.get(id) || { kills: 0, deaths: 0 },
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const topZeusVictims = Array.from(zeusVictims.entries())
    .map(([id, count]) => ({
      id,
      count,
      name: memberIdToName.get(id)?.name || `user-${id}`,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const monthlyRows = Array.from(monthly.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  let bestMonth = null;
  const monthlyStats = [];
  for (const [monthKey, stats] of monthlyRows) {
    const kd =
      stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : "∞";
    const adr =
      stats.rounds > 0 ? (stats.damage / stats.rounds).toFixed(1) : "0.0";
    const hs =
      stats.kills > 0
        ? ((stats.headshots / stats.kills) * 100).toFixed(1)
        : "0.0";
    monthlyStats.push({
      monthKey,
      matches: stats.matches,
      rounds: stats.rounds,
      kills: stats.kills,
      deaths: stats.deaths,
      headshots: stats.headshots,
      damage: stats.damage,
      kd,
      adr,
      hs,
    });

    if (!bestMonth) {
      bestMonth = { monthKey, kd: Number(kd), adr: Number(adr) };
    } else if (Number(kd) > bestMonth.kd) {
      bestMonth = { monthKey, kd: Number(kd), adr: Number(adr) };
    } else if (Number(kd) === bestMonth.kd && Number(adr) > bestMonth.adr) {
      bestMonth = { monthKey, kd: Number(kd), adr: Number(adr) };
    }
  }

  if (mapStats.size === 0) {
    throw new Error("No stats found for the requested player.");
  }

  return {
    targetArg,
    displayName: latestTargetName || targetArg.split(",")[0],
    matchesScanned,
    matchesWithTarget,
    overall: {
      ...overall,
      kd: overallKd,
      adr: overallAdr,
      hs: overallHs,
      favoriteWeapon: overallFavoriteWeapon,
      topWeapons: overallTopWeapons,
    },
    mapRows,
    topVictims,
    topZeusVictims,
    monthly: monthlyStats,
    bestMonth: bestMonth?.monthKey || null,
  };
}

async function main() {
  const outDir = process.argv[2] || "out";
  const targetArg = process.argv[3] || "NE_Krinzhanul";

  const data = await computeStats(outDir, targetArg);

  process.stdout.write(
    `Processed ${data.matchesScanned} matches, found ${data.matchesWithTarget} with target.\n`
  );

  process.stdout.write(
    `Overall | Matches ${data.overall.matches} | Rounds ${data.overall.rounds} | K/D ${data.overall.kd} | ADR ${data.overall.adr} | HS% ${data.overall.hs}\n`
  );

  process.stdout.write(
    "Map | Matches | Rounds | K/D | ADR | HS% | Top Weapons\n"
  );

  for (const row of data.mapRows) {
    const weaponList = row.topWeapons.map((w) => w.name).join(", ") || "-";
    process.stdout.write(
      `${row.mapName} | ${row.matches} | ${row.rounds} | ${row.kd} | ${row.adr} | ${row.hs}% | ${weaponList}\n`
    );
  }

  process.stdout.write("Top 5 victims | Kills\n");
  for (const victim of data.topVictims) {
    const duel = victim.duels || { kills: 0, deaths: 0 };
    process.stdout.write(
      `${victim.name} (${victim.id}) | ${victim.count} | ${duel.kills}/${duel.deaths}\n`
    );
  }

  if (data.topZeusVictims.length) {
    process.stdout.write("Top 5 Zeus victims | Kills\n");
    for (const victim of data.topZeusVictims) {
      process.stdout.write(`${victim.name} (${victim.id}) | ${victim.count}\n`);
    }
  }

  process.stdout.write("Month | Matches | Rounds | K/D | ADR | HS%\n");
  for (const month of data.monthly) {
    process.stdout.write(
      `${month.monthKey} | ${month.matches} | ${month.rounds} | ${month.kd} | ${month.adr} | ${month.hs}%\n`
    );
  }

  if (data.bestMonth) {
    process.stdout.write(
      `Best month by K/D (tie-break ADR): ${data.bestMonth}\n`
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
