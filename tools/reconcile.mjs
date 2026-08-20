#!/usr/bin/env node
/**
 * Crown or Clown — weekly DraftKings reconciliation checklist.
 *
 * The league runs on ESPN with DraftKings scoring. ESPN and DraftKings both
 * score off the same official NFL stats, so they match almost all the time.
 * There are exactly two spots they can diverge:
 *
 *   1. D/ST points-allowed bracket: ESPN splits at 21, DraftKings at 20. A
 *      defense that allows EXACTLY 21 points earns +1 on ESPN, 0 on DraftKings.
 *   2. A yardage bonus (100 rush, 100 rec, 300 pass = +3 on DraftKings) that a
 *      late official stat correction moves a player across after DraftKings has
 *      already locked.
 *
 * This script pulls each league's box score from ESPN's public read API and
 * flags every starter sitting in either danger zone, so the commissioner can
 * check DraftKings and, if they differ, apply the exact points via ESPN's
 * League-Manager "Adjust Scoring" tool.
 *
 * IT DOES NOT AUTO-APPLY ANYTHING. It reads yardage only (the stable stat
 * fields) and hands you a checklist — you confirm against DraftKings and enter
 * the adjustment yourself. That keeps a bad guess from ever moving money.
 *
 *   ⚠ TIMING: run this AFTER ESPN's official corrections are final (the
 *   Saturday following the game week). Adjusting before ESPN applies the same
 *   correction double-credits the team.
 *
 * Usage:
 *   node tools/reconcile.mjs --season 2026 --week 1
 *   node tools/reconcile.mjs --week 1 --league 951407474      (one league)
 *   node tools/reconcile.mjs --week 1 --json                  (machine output)
 *
 * No dependencies. Node 18+ (built-in fetch).
 */

const LEAGUES = [
  { name: "The Expansion League",   id: 951407474 },
  { name: "The Expansion League 2", id: 1963204215 },
  { name: "The Expansion League 3", id: 976183547 },
];

// DraftKings bonus thresholds — the only yardage lines that carry points.
const BONUS = [
  { key: "3",  label: "passing",   line: 300, statName: "pass yds" },  // ESPN statId 3  = passing yards
  { key: "24", label: "rushing",   line: 100, statName: "rush yds" },  // ESPN statId 24 = rushing yards
  { key: "42", label: "receiving", line: 100, statName: "rec yds"  },  // ESPN statId 42 = receiving yards
];
const NEAR = 3; // flag a player within this many yards (either side) of a bonus line
const BENCH_SLOTS = new Set([20, 21]); // 20 = bench, 21 = IR — starters are everything else
const DST_POS = 16; // defaultPositionId for D/ST

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SEASON = Number(arg("season", 2026));
const WEEK = Number(arg("week", 0));
const ONE = arg("league", null);
const JSON_OUT = !!arg("json", false);

if (!WEEK) { console.error("Need --week N (the completed NFL week to reconcile)."); process.exit(1); }

const leagues = ONE ? LEAGUES.filter((l) => String(l.id) === String(ONE)) : LEAGUES;

const api = (id) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}` +
  `?view=mMatchup&view=mMatchupScore&view=mRoster&scoringPeriodId=${WEEK}`;

// pull the single-week actual stat line for a player
function weekStats(player) {
  const s = (player.stats || []).find(
    (x) => x.scoringPeriodId === WEEK && x.statSourceId === 0 && x.statSplitTypeId === 1
  );
  return { stats: (s && s.stats) || {}, applied: (s && s.appliedTotal) != null ? s.appliedTotal : null };
}

async function reconcileLeague(l) {
  const flags = [];
  let box;
  try {
    const r = await fetch(api(l.id), { headers: { accept: "application/json" } });
    if (!r.ok) return { league: l.name, error: `ESPN HTTP ${r.status}` };
    box = await r.json();
  } catch (e) {
    return { league: l.name, error: String(e.message || e) };
  }
  const teamName = {};
  for (const t of box.teams || []) teamName[t.id] = (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`;

  const sides = [];
  for (const m of box.schedule || []) {
    if (m.matchupPeriodId !== WEEK && m.home && m.home.rosterForCurrentScoringPeriod == null) continue;
    for (const side of ["home", "away"]) {
      const s = m[side];
      if (!s || !s.rosterForCurrentScoringPeriod) continue;
      sides.push({ teamId: s.teamId, roster: s.rosterForCurrentScoringPeriod });
    }
  }

  for (const side of sides) {
    const tName = teamName[side.teamId] || `Team ${side.teamId}`;
    for (const entry of side.roster.entries || []) {
      if (BENCH_SLOTS.has(entry.lineupSlotId)) continue; // starters only
      const player = entry.playerPoolEntry && entry.playerPoolEntry.player;
      if (!player) continue;
      const { stats, applied } = weekStats(player);
      const nm = player.fullName || "Unknown";

      // 1) yardage bonus danger zone
      for (const b of BONUS) {
        const yds = Number(stats[b.key]);
        if (!isFinite(yds)) continue;
        if (Math.abs(yds - b.line) <= NEAR) {
          const overLine = yds >= b.line;
          flags.push({
            league: l.name, team: tName, player: nm, kind: "yardage-bonus",
            detail: `${Math.round(yds)} ${b.statName} — ${overLine ? "AT/OVER" : "just under"} the ${b.line} line (DK +3). ` +
              `Confirm DraftKings shows ${overLine ? "the +3" : "no +3"}; if ESPN disagrees, adjust ±3.`,
            espnPoints: applied,
          });
        }
      }

      // 2) D/ST allowed exactly 21 (ESPN +1 vs DK 0)
      if ((player.defaultPositionId === DST_POS) || (entry.lineupSlotId === DST_POS)) {
        // ESPN carries points-allowed as statId 187 in most seasons; fall back to a manual prompt.
        const pa = Number(stats["187"]);
        if (isFinite(pa) && pa === 21) {
          flags.push({ league: l.name, team: tName, player: nm, kind: "dst-21",
            detail: `D/ST allowed EXACTLY 21 — ESPN pays +1, DraftKings pays 0. Adjust −1.`, espnPoints: applied });
        } else {
          flags.push({ league: l.name, team: tName, player: nm, kind: "dst-check",
            detail: `Verify points allowed ≠ 21 (ESPN +1 vs DK 0 at exactly 21).`, espnPoints: applied, soft: true });
        }
      }
    }
  }
  return { league: l.name, flags };
}

const results = [];
for (const l of leagues) results.push(await reconcileLeague(l));

if (JSON_OUT) { console.log(JSON.stringify({ season: SEASON, week: WEEK, results }, null, 2)); process.exit(0); }

// ── human report ──
const hr = "─".repeat(64);
console.log(`\nCROWN OR CLOWN · DraftKings reconciliation — Season ${SEASON}, Week ${WEEK}`);
console.log(`Run this AFTER ESPN's official corrections settle (the Saturday after the games).`);
console.log(hr);
let hard = 0, soft = 0;
for (const r of results) {
  console.log(`\n▌ ${r.league}`);
  if (r.error) { console.log(`  ⚠ could not read ESPN: ${r.error}`); continue; }
  const real = r.flags.filter((f) => !f.soft);
  if (!real.length) { console.log(`  ✓ no yardage-bonus edges. (D/ST: eyeball any that allowed exactly 21.)`); }
  for (const f of r.flags) {
    if (f.soft) { soft++; continue; }
    hard++;
    console.log(`  • [${f.team}] ${f.player} — ${f.detail}${f.espnPoints != null ? `  (ESPN: ${f.espnPoints} pts)` : ""}`);
  }
}
console.log(`\n${hr}`);
console.log(`${hard} spot${hard === 1 ? "" : "s"} to confirm against DraftKings${soft ? `, plus ${soft} D/ST to eyeball for exactly-21` : ""}.`);
console.log(`Where DraftKings and ESPN differ, apply the delta in ESPN → League Manager Tools → Adjust Scoring.`);
console.log(`Nothing here is applied automatically — you are the referee.\n`);
