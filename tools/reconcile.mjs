#!/usr/bin/env node
/**
 * Crown or Clown — weekly DraftKings reconciliation.
 *
 * The league runs on ESPN with DraftKings scoring. ESPN and DraftKings both
 * score off the same official NFL stats, so they match almost all the time.
 * There are exactly two spots they can diverge:
 *
 *   1. D/ST points allowed: ESPN's bracket splits at 21, DraftKings at 20. A
 *      defense allowing EXACTLY 21 earns +1 on ESPN, 0 on DraftKings → adjust −1.
 *   2. A yardage bonus (100 rush, 100 rec, 300 pass = +3 on DraftKings) that a
 *      late official stat correction moves a player across after DraftKings has
 *      locked → adjust ±3 to match DraftKings.
 *
 * This pulls each league's box score from ESPN's public read API and flags every
 * starter sitting in either danger zone. IT APPLIES NOTHING — it reads yardage
 * only and hands you a checklist; you confirm against DraftKings and enter the
 * delta via ESPN → League Manager Tools → Adjust Scoring. A bad guess can never
 * move money.
 *
 *   ⚠ TIMING: run AFTER ESPN's official corrections are final (the Saturday
 *   following the game week). Adjusting before ESPN applies the same correction
 *   double-credits the team. The GitHub Action is scheduled for Sunday for this
 *   reason.
 *
 * Usage:
 *   node tools/reconcile.mjs --week 1            # a specific NFL week
 *   node tools/reconcile.mjs --week auto         # the most-recently-settled week (per ESPN)
 *   node tools/reconcile.mjs --week auto --md    # markdown (for CI job summaries)
 *   node tools/reconcile.mjs --week auto --json  # machine-readable
 *   RECONCILE_WEBHOOK=<discord/slack url> node tools/reconcile.mjs --week auto  # also POST the report
 *
 * No dependencies. Node 18+ (built-in fetch).
 */

const SEASON = Number(env("RECONCILE_SEASON") || arg("season") || 2026);
const LEAGUES = [
  { name: "The Expansion League",   id: 951407474 },
  { name: "The Expansion League 2", id: 1963204215 },
  { name: "The Expansion League 3", id: 976183547 },
];
const BONUS = [
  { key: "3",  line: 300, unit: "pass yds" },
  { key: "24", line: 100, unit: "rush yds" },
  { key: "42", line: 100, unit: "rec yds" },
];
const NEAR = 3;
const BENCH = new Set([20, 21]);
const DST_POS = 16;

function arg(name) { const i = process.argv.indexOf("--" + name); if (i === -1) return null; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true; }
function env(name) { return process.env[name]; }
const WEEK_ARG = arg("week");
const MD = !!arg("md");
const JSON_OUT = !!arg("json");
const WEBHOOK = env("RECONCILE_WEBHOOK");

const base = (id) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}`;
async function get(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 CrownOrClownBot" } });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  return r.json();
}
function weekStats(pl, wk) {
  const s = (pl.stats || []).find((x) => x.scoringPeriodId === wk && x.statSourceId === 0 && x.statSplitTypeId === 1);
  return { stats: (s && s.stats) || {}, applied: (s && s.appliedTotal) != null ? s.appliedTotal : null };
}

async function targetWeekFor(id) {
  if (WEEK_ARG && WEEK_ARG !== "auto") return Number(WEEK_ARG);
  const meta = await get(base(id) + "?view=mTeam");
  const latest = (meta.status && meta.status.latestScoringPeriod) || meta.scoringPeriodId || 0;
  return Math.max(0, latest - 1); // the most-recently-completed (and by Sunday, settled) week
}

async function reconcileLeague(l) {
  let wk;
  try { wk = await targetWeekFor(l.id); } catch (e) { return { league: l.name, error: String(e.message || e) }; }
  if (!wk || wk < 1) return { league: l.name, week: wk || 0, flags: [], note: "no completed week yet" };
  let box;
  try { box = await get(base(l.id) + `?view=mMatchup&view=mMatchupScore&view=mRoster&scoringPeriodId=${wk}`); }
  catch (e) { return { league: l.name, week: wk, error: String(e.message || e) }; }
  const tn = {}; for (const t of box.teams || []) tn[t.id] = (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`;
  const flags = [];
  for (const m of box.schedule || []) {
    for (const side of ["home", "away"]) {
      const s = m[side]; if (!s || !s.rosterForCurrentScoringPeriod) continue;
      const team = tn[s.teamId] || `Team ${s.teamId}`;
      for (const e of s.rosterForCurrentScoringPeriod.entries || []) {
        if (BENCH.has(e.lineupSlotId)) continue;
        const pl = e.playerPoolEntry && e.playerPoolEntry.player; if (!pl) continue;
        const { stats } = weekStats(pl, wk); const nm = pl.fullName || "Unknown";
        for (const b of BONUS) {
          const y = Number(stats[b.key]); if (!isFinite(y)) continue;
          if (Math.abs(y - b.line) <= NEAR) {
            const over = y >= b.line;
            flags.push(`[${team}] ${nm} — ${Math.round(y)} ${b.unit}, ${over ? "AT/OVER" : "just under"} the ${b.line} line (DK +3). Confirm DraftKings ${over ? "gives" : "withholds"} the +3; adjust ±3 if ESPN disagrees.`);
          }
        }
        if (pl.defaultPositionId === DST_POS || e.lineupSlotId === DST_POS) {
          const pa = Number(stats["187"]);
          if (isFinite(pa) && pa === 21) flags.push(`[${team}] ${nm} D/ST — allowed EXACTLY 21 (ESPN +1 vs DK 0). Adjust −1.`);
        }
      }
    }
  }
  return { league: l.name, week: wk, flags };
}

// ── season guard: silence Feb–Jul (no games) ──
const mo = new Date().getUTCMonth();
if ((WEEK_ARG === "auto" || !WEEK_ARG) && mo > 0 && mo < 7) {
  if (!JSON_OUT) console.log("Off-season — nothing to reconcile.");
  process.exit(0);
}
if (!WEEK_ARG) { console.error("Need --week N or --week auto."); process.exit(1); }

const results = [];
for (const l of LEAGUES) results.push(await reconcileLeague(l));
const week = (results.find((r) => r.week) || {}).week || 0;
const total = results.reduce((n, r) => n + ((r.flags && r.flags.length) || 0), 0);

if (JSON_OUT) { console.log(JSON.stringify({ season: SEASON, week, total, results }, null, 2)); process.exit(0); }

// ── build the report (markdown doubles as plain-ish text) ──
const lines = [];
lines.push(`**Crown or Clown — Week ${week} DraftKings true-up**`);
lines.push(`_Apply in ESPN → League Manager Tools → Adjust Scoring. Safe now — ESPN's corrections are final by the Saturday after the games._`);
for (const r of results) {
  lines.push(`\n**${r.league}**`);
  if (r.error) { lines.push(`- ⚠ couldn't read ESPN: ${r.error}`); continue; }
  if (!r.flags || !r.flags.length) { lines.push(`- ✓ clean — no yardage-bonus edges (eyeball any D/ST that allowed exactly 21)`); continue; }
  for (const f of r.flags) lines.push(`- ${f}`);
}
lines.push(`\n_Nothing applied automatically — you're the referee. First real week, sanity-check a couple against the box score + DraftKings before trusting it for payouts._`);
const report = lines.join("\n");

if (MD && process.env.GITHUB_STEP_SUMMARY) {
  try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n"); } catch { /* ignore */ }
}
console.log(report);

if (WEBHOOK) {
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: report.slice(0, 1900), text: report.slice(0, 1900) }) });
  } catch (e) { console.error("webhook post failed:", String(e.message || e)); }
}
