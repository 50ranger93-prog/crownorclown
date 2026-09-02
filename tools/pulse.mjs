#!/usr/bin/env node
/**
 * Crown or Clown — channel pulse.
 *
 * Keeps the Discord alive without anyone having to remember to post. Each "beat" writes to one
 * channel on its own schedule, and every beat answers a different question, so no channel ever
 * repeats another. Nothing here is chatter for its own sake: every line is drawn from the actual
 * leagues, so a manager reading it learns something about their own team.
 *
 * The beats:
 *   slate      → who plays today, with the lines already on the site      (Sun morning)
 *   inactives  → YOUR players ruled out, 90 minutes before kickoff        (Sun late morning)
 *   injuries   → designations that landed on rostered players this week   (Wed + Fri)
 *   crownvest  → last week's crown and the vest, per league               (Tue)
 *   faab       → who still has budget and who has spent it                (Thu)
 *   hottake    → one true, arguable stat pulled from the standings        (Fri)
 *
 * Each beat posts only if its webhook is set, so you can switch channels on and off by adding
 * or removing repo secrets — no code change.
 *
 * Usage:
 *   node tools/pulse.mjs --beat slate
 *   node tools/pulse.mjs --beat injuries --dry     # print, don't post
 *   node tools/pulse.mjs --all --dry               # every beat, printed
 *
 * No dependencies. Node 18+.
 */

const SEASON = Number(process.env.PULSE_SEASON || 2026);
const LEAGUES = [
  { name: "League 1", id: 951407474,  hook: "PULSE_WEBHOOK_LEAGUE1" },
  { name: "League 2", id: 1963204215, hook: "PULSE_WEBHOOK_LEAGUE2" },
  { name: "League 3", id: 976183547,  hook: "PULSE_WEBHOOK_LEAGUE3" },
];

const SITE = "https://crownorclown.com";
const UA = { accept: "application/json", "user-agent": "Mozilla/5.0 CrownOrClownBot" };

function arg(n) { const i = process.argv.indexOf("--" + n); if (i === -1) return null; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true; }
const DRY = !!arg("dry");

const fantasy = (id, q) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}?${q}`;

async function get(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// A beat that can't read its data says nothing at all. A channel that stays quiet reads as
// "nothing happened"; a channel posting "couldn't reach ESPN" reads as broken.
async function safe(fn) {
  try { return await fn(); } catch (e) { console.error("  skipped:", String(e.message || e)); return null; }
}

const teamName = (t) => (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`;
const BENCH = new Set([20, 21]);       // bench + IR: not in the lineup, not worth alerting on

// ── beats ────────────────────────────────────────────────────────────────────

// Who plays today. Pulled from the public scoreboard, which is keyed to the real slate rather
// than to a hardcoded week, so byes and flex scheduling take care of themselves.
async function slate() {
  const j = await get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
  const events = j.events || [];
  if (!events.length) return null;

  const today = new Date().toDateString();
  const games = events.filter(e => new Date(e.date).toDateString() === today);
  if (!games.length) return null;

  const rows = games.map(e => {
    const c = (e.competitions || [])[0] || {};
    const teams = (c.competitors || []).slice().sort((a) => (a.homeAway === "away" ? -1 : 1));
    const away = teams[0]?.team?.abbreviation || "?";
    const home = teams[1]?.team?.abbreviation || "?";
    const kick = new Date(e.date).toLocaleTimeString("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit" });
    const odds = (c.odds || [])[0];
    const line = odds ? ` · ${odds.details || ""}${odds.overUnder ? ` O/U ${odds.overUnder}` : ""}`.trimEnd() : "";
    return `\`${kick} MT\`  **${away} @ ${home}**${line}`;
  });

  return [
    `**Today's slate — ${games.length} game${games.length === 1 ? "" : "s"}**`,
    ...rows,
    "",
    `Spreads, totals, weather and the out list are on the site: ${SITE}#gameday`,
  ].join("\n");
}

// The one that actually saves people money: starters ruled OUT while there is still time to
// move them. Only starters — nobody needs an alert about their bench.
async function inactives() {
  const out = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mRoster&view=mTeam")));
    if (!j) continue;
    const hits = [];
    for (const t of j.teams || []) {
      for (const e of (t.roster && t.roster.entries) || []) {
        if (BENCH.has(e.lineupSlotId)) continue;
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p) continue;
        if (p.injuryStatus === "OUT" || p.injuryStatus === "DOUBTFUL") {
          hits.push(`**${teamName(t)}** — ${p.fullName} is ${p.injuryStatus}`);
        }
      }
    }
    if (hits.length) out.push(`__${l.name}__\n` + hits.join("\n"));
  }
  if (!out.length) return null;
  return [`**Starting someone who isn't playing**`, "", ...out, "", "_Lineups lock at kickoff._"].join("\n");
}

// Midweek designations, starters and bench alike — this one is for planning, not panic, so the
// bench counts here where it doesn't for inactives.
async function injuries() {
  const out = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mRoster&view=mTeam")));
    if (!j) continue;
    const hits = [];
    for (const t of j.teams || []) {
      for (const e of (t.roster && t.roster.entries) || []) {
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p || !p.injuryStatus || p.injuryStatus === "ACTIVE") continue;
        hits.push(`${p.fullName} — ${p.injuryStatus} _(${teamName(t)})_`);
      }
    }
    if (hits.length) out.push(`__${l.name}__\n` + hits.slice(0, 15).join("\n") + (hits.length > 15 ? `\n_+${hits.length - 15} more_` : ""));
  }
  if (!out.length) return null;
  return [`**Injury report — rostered players only**`, "", ...out].join("\n");
}

// Last week's high and low. The whole brand in two numbers.
async function crownvest() {
  const blocks = [];
  for (const l of LEAGUES) {
    const meta = await safe(() => get(fantasy(l.id, "view=mTeam")));
    if (!meta) continue;
    const wk = Math.max(0, ((meta.status && meta.status.latestScoringPeriod) || 0) - 1);
    if (wk < 1) continue;

    const box = await safe(() => get(fantasy(l.id, `view=mMatchupScore&view=mTeam&scoringPeriodId=${wk}`)));
    if (!box) continue;
    const names = {}; for (const t of box.teams || []) names[t.id] = teamName(t);

    const scores = [];
    for (const m of box.schedule || []) {
      if (m.matchupPeriodId !== wk) continue;
      for (const side of ["home", "away"]) {
        const s = m[side];
        if (s && s.totalPoints != null) scores.push({ team: names[s.teamId] || `Team ${s.teamId}`, pts: s.totalPoints });
      }
    }
    if (scores.length < 2) continue;
    scores.sort((a, b) => b.pts - a.pts);
    const hi = scores[0], lo = scores[scores.length - 1];
    blocks.push(`__${l.name} · Week ${wk}__\n👑 **${hi.team}** — ${hi.pts.toFixed(1)}\n🤡 **${lo.team}** — ${lo.pts.toFixed(1)}`);
  }
  if (!blocks.length) return null;
  return [`**The crown and the vest**`, "", ...blocks, "", `Full standings: ${SITE}#standings`].join("\n");
}

// Who can still bid. FAAB is continuous here, so a manager sitting on budget in November is a
// live threat and everyone should know it.
async function faab() {
  const blocks = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mTeam&view=mSettings")));
    if (!j) continue;
    const budget = (j.settings && j.settings.acquisitionSettings && j.settings.acquisitionSettings.acquisitionBudget) || 100;
    const rows = (j.teams || [])
      .map(t => ({ team: teamName(t), left: budget - (t.transactionCounter && t.transactionCounter.acquisitionBudgetSpent || 0) }))
      .sort((a, b) => b.left - a.left);
    if (!rows.length) continue;
    // Before anyone has bid, every team is on the full budget and a leaderboard of identical
    // numbers is noise. Wait for a real spread to exist.
    if (rows[0].left === rows[rows.length - 1].left) continue;
    const rich = rows.slice(0, 3).map(r => `**${r.team}** $${r.left}`).join(" · ");
    const broke = rows.slice(-2).map(r => `${r.team} $${r.left}`).join(" · ");
    blocks.push(`__${l.name}__\nDeepest pockets: ${rich}\nRunning dry: ${broke}`);
  }
  if (!blocks.length) return null;
  return [`**FAAB check**`, "", ...blocks, "", "_Post what you're shopping. Best offer wins, no vetoes._"].join("\n");
}

// One true thing worth arguing about. Picked from real standings so nobody can call it made up.
async function hottake() {
  const takes = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mTeam")));
    if (!j) continue;
    const teams = (j.teams || []).map(t => ({
      name: teamName(t),
      w: (t.record && t.record.overall && t.record.overall.wins) || 0,
      losses: (t.record && t.record.overall && t.record.overall.losses) || 0,
      pf: (t.record && t.record.overall && t.record.overall.pointsFor) || 0,
    }));
    if (!teams.length || teams.every(t => !t.w && !t.losses)) continue;

    // The most arguable team in any league is the one whose record and scoring disagree: most
    // points but not the best record, or the reverse. That gap is the whole argument.
    const byPf = [...teams].sort((a, b) => b.pf - a.pf);
    const byRec = [...teams].sort((a, b) => b.w - a.w || b.pf - a.pf);
    const topScorer = byPf[0], topRecord = byRec[0];

    if (topScorer.name !== topRecord.name) {
      takes.push(`__${l.name}__ — **${topScorer.name}** has scored the most points (${topScorer.pf.toFixed(0)}) and still isn't first. **${topRecord.name}** is ${topRecord.w}-${topRecord.losses}. One of them is getting robbed. Which?`);
    } else {
      takes.push(`__${l.name}__ — **${topRecord.name}** leads in record *and* points (${topRecord.pf.toFixed(0)}). Anybody actually beating them, or are we playing for second?`);
    }
  }
  if (!takes.length) return null;
  return [`**Hot take of the week**`, "", ...takes].join("\n");
}

// ── wiring ───────────────────────────────────────────────────────────────────

const BEATS = {
  slate:     { fn: slate,     hook: "PULSE_WEBHOOK_GENERAL" },
  inactives: { fn: inactives, hook: "PULSE_WEBHOOK_GENERAL" },
  injuries:  { fn: injuries,  hook: "PULSE_WEBHOOK_GENERAL" },
  crownvest: { fn: crownvest, hook: "PULSE_WEBHOOK_CROWNVEST" },
  faab:      { fn: faab,      hook: "PULSE_WEBHOOK_TRADE" },
  hottake:   { fn: hottake,   hook: "PULSE_WEBHOOK_HOTTAKE" },
};

async function post(hookEnv, text) {
  const url = process.env[hookEnv];
  if (!url) { console.log(`  (no ${hookEnv} set — not posted)`); return; }
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // allowed_mentions empty: these post on a schedule, and a schedule should never ping anyone.
    body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
  });
  console.log(r.ok ? "  posted" : `  post failed: HTTP ${r.status}`);
}

// Feb–Jul there are no games and nothing truthful to say.
const month = new Date().getUTCMonth();
if (month > 0 && month < 7) { console.log("Off-season — pulse is quiet."); process.exit(0); }

const which = arg("all") ? Object.keys(BEATS) : [arg("beat")].filter(Boolean);
if (!which.length) { console.error("Need --beat <name> or --all. Beats: " + Object.keys(BEATS).join(", ")); process.exit(1); }

for (const name of which) {
  const beat = BEATS[name];
  if (!beat) { console.error(`unknown beat: ${name}`); continue; }
  console.log(`\n=== ${name} ===`);
  const text = await safe(beat.fn);
  if (!text) { console.log("  nothing to say"); continue; }
  console.log(text);
  if (!DRY) await post(beat.hook, text);
}
