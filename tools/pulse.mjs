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
          hits.push(`${p.fullName} ${p.injuryStatus === "OUT" ? "OUT" : "DTD"} _(${teamName(t)})_`);
        }
      }
    }
    if (hits.length) out.push(`__${l.name}__ ` + hits.join(" · "));
  }
  if (!out.length) return null;
  return [`⚠️ **Starter's not playing — move 'em**`, ...out].join("\n");
}

// Midweek designations, starters and bench alike — planning, not panic. Tight: initials, capped,
// one line a league. The manager scans for his own guys; he doesn't need a phone book.
async function injuries() {
  const CODE = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", SUSPENSION: "S", "INJURY_RESERVE": "IR" };
  const out = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mRoster&view=mTeam")));
    if (!j) continue;
    const hits = [];
    for (const t of j.teams || []) {
      for (const e of (t.roster && t.roster.entries) || []) {
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p || !p.injuryStatus || p.injuryStatus === "ACTIVE") continue;
        hits.push(`${p.fullName} ${CODE[p.injuryStatus] || p.injuryStatus[0]}`);
      }
    }
    if (hits.length) out.push(`__${l.name}__ ` + hits.slice(0, 8).join(" · ") + (hits.length > 8 ? ` _+${hits.length - 8}_` : ""));
  }
  if (!out.length) return null;
  return [`🩹 **Injury tags this week**`, ...out].join("\n");
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
      const split = [
        `__${l.name}__ — **${topScorer.name}** has scored the most points (${topScorer.pf.toFixed(0)}) and still isn't first. **${topRecord.name}** is ${topRecord.w}-${topRecord.losses}. One of them is getting robbed. Which?`,
        `__${l.name}__ — most points in the league belongs to **${topScorer.name}**, but the top record is **${topRecord.name}** (${topRecord.w}-${topRecord.losses}). Luckiest team or best team — pick a side.`,
        `__${l.name}__ — **${topRecord.name}** is winning games; **${topScorer.name}** is winning the scoreboard (${topScorer.pf.toFixed(0)}). Who'd you rather be right now?`,
      ];
      takes.push(pick(split));
    } else {
      const lead = [
        `__${l.name}__ — **${topRecord.name}** leads in record *and* points (${topRecord.pf.toFixed(0)}). Anybody actually beating them, or are we playing for second?`,
        `__${l.name}__ — nobody has an argument in ${l.name}: **${topRecord.name}** tops record and scoring (${topRecord.pf.toFixed(0)}). Change my mind.`,
        `__${l.name}__ — **${topRecord.name}** is the whole story so far — best record, most points (${topRecord.pf.toFixed(0)}). Who's got the guts to catch them?`,
      ];
      takes.push(pick(lead));
    }
  }
  if (!takes.length) return null;
  return [`**Hot take of the week**`, "", ...takes].join("\n");
}

// The instigator. Every other beat talks AT the room; this one names two people and starts a
// fight, because 36 strangers only start talking when it's about them specifically. Short by
// design — one line a matchup, drawn from real records so nobody can call it made up. Capped to
// the spiciest few per league so it stays a quick read, not a wall.
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const winpct = (t) => (t.w + t.l) ? t.w / (t.w + t.l) : 0;
const rec = (t) => `${t.w}-${t.l}`;

// Deep, deduped pools. A Week-2 slate is mostly 1-0-vs-0-1, so a few templates read like the
// same sentence six times. `used` is shared across the whole post, so a line can never repeat in
// one drop, and each pool is deep enough to cover a 12-team board without running dry.
const fill = (t, m) => t.replace(/\{(\w+)\}/g, (_, k) => (m[k] != null ? String(m[k]) : ""));
function pickU(used, arr) {
  const fresh = arr.filter(t => !used.has(t));
  const pool = fresh.length ? fresh : arr;
  const t = pool[Math.floor(Math.random() * pool.length)];
  used.add(t);
  return t;
}
const FAVE = [
  `**{F}** ({rf}) should handle **{D}** ({rd}). "Should."`,
  `**{D}** ({rd}) drew **{F}** ({rf}). Nobody's walking through that door to save you.`,
  `Everybody's got **{F}** over **{D}** this week. Everybody's been wrong before, {D}.`,
  `**{F}** ({rf}) is the pick. **{D}**, spoil it or wear it.{vest}`,
  `**{D}** ({rd}) is a live dog against **{F}** — or a dead one. We'll know by Monday.`,
  `**{F}** ({rf}) vs **{D}** ({rd}): one of you feels real good Monday, one feels real dumb.`,
  `**{D}**, you drew **{F}** ({rf}). Set a real lineup or don't bother.`,
  `**{F}** ({rf}) over **{D}** ({rd}) is the smart money. Smart money loses all the time.`,
  `**{F}** ({rf}) is favored. **{D}** ({rd}) is why they invented the word upset.`,
  `Prove me right, **{F}** ({rf}). Prove me wrong, **{D}** ({rd}). One of you will.`,
];
const EVEN = [
  `**{a}** ({ra}) vs **{b}** ({rb}) — coin flip. Loser's got no excuse.`,
  `Dead heat: **{a}** vs **{b}**. This is the one you'll be chirping about all week.`,
  `Nothing separates **{a}** ({ra}) and **{b}** ({rb}). Go make it personal.{vest}`,
  `**{a}** vs **{b}**, pick 'em. Whoever loses earned every bit of it.`,
  `**{a}** and **{b}** are even on paper. Somebody's about to look real stupid.`,
];
const UNDEF = [
  `Both perfect: **{a}** vs **{b}**. One of these clean records dies this week.`,
  `**{a}** ({ra}) vs **{b}** ({rb}) — somebody's first L is loading.`,
  `Undefeated meets undefeated: **{a}** vs **{b}**. Winner struts, loser goes quiet.`,
  `**{a}** and **{b}**, both spotless. Not for much longer.`,
];
const WINLESS = [
  `**{D}** ({rd}) still hasn't won a game, and now it's **{F}** ({rf}). Woof.{vest}`,
  `**{F}** ({rf}) draws winless **{D}**. Should be easy — unless {D} finally wakes up.`,
  `**{D}** is {rd} and drew **{F}** ({rf}). Somebody go check on {D}.{vest}`,
  `**{D}** ({rd}) vs **{F}** ({rf}). Turn it around now, or measure for the vest.`,
];
const SKID = [
  `**{D}** drags a {n}-game skid into **{F}** ({rf}). Make it stop or make it worse.`,
  `**{F}** ({rf}) vs **{D}**, loser of {n} straight. Bounce back, or the wheels come off?`,
  `**{D}** has dropped {n} in a row and now gets **{F}** ({rf}). This could get ugly.{vest}`,
];

function matchupLine(a, b, vest, used) {
  let fav = a, dog = b;
  if (winpct(b) > winpct(a) || (winpct(b) === winpct(a) && b.pf > a.pf)) { fav = b; dog = a; }
  const skid = dog.streakType === "LOSS" && dog.streakLen >= 2;
  const undef = fav.l === 0 && dog.l === 0 && fav.w > 0 && dog.w > 0;
  const even = fav.w === dog.w && Math.abs(fav.pf - dog.pf) < 15;
  const m = { F: fav.name, D: dog.name, rf: rec(fav), rd: rec(dog),
    a: a.name, b: b.name, ra: rec(a), rb: rec(b), n: dog.streakLen,
    vest: vest.has(dog.name) ? ` Lose and **${dog.name}** is fitting the vest.` : "" };
  const pool = undef ? UNDEF : (dog.w === 0 && dog.l >= 2) ? WINLESS : skid ? SKID : even ? EVEN : FAVE;
  return fill(pickU(used, pool), m);
}
// ── who's who ──────────────────────────────────────────────────────────────
// The intro card already ties a person to a team: every card the bot posts reads
// "Welcome <@id> of **Team**" (or "<@id> is dealing for **Team**"). So there's no claim form and
// no member database to keep — the mapping lives in #meet-the-crew, and we read it back off
// Discord's own message content. With this, the fights stop naming teams and start pinging the
// actual human. Needs DISCORD_BOT_TOKEN (the token Vercel already has) + Server Members Intent;
// without it, handles() returns null and the matchups fall back to plain team names.
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD = process.env.DISCORD_GUILD_ID || "1543364312028946432";
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
async function dget(path) {
  const r = await fetch("https://discord.com/api/v10" + path, { headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "user-agent": "CrownOrClownBot (crownorclown.com, 1.0)" } });
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
}
async function handles() {
  if (!DISCORD_TOKEN) return null;
  const chans = await dget(`/guilds/${DISCORD_GUILD}/channels`);
  const ch = chans.find(c => /meet.*crew|introduc/i.test(c.name || "")) || chans.find(c => /\bintro\b/i.test(c.name || ""));
  if (!ch) return null;
  const map = new Map();
  // <@id> ... **Team** — the id and the team name the bot itself wrote onto the card. Reading the
  // card text needs the Message Content Intent; without it Discord returns empty content and this
  // stays empty, so the fights fall back to plain team names.
  const scan = (msgs) => { for (const msg of msgs || []) { const x = /<@!?(\d+)>[^*]*\*\*(.+?)\*\*/.exec(msg.content || ""); if (x) map.set(norm(x[2]), x[1]); } };
  if (ch.type === 15) {   // forum: each card is a thread, starter message shares the thread id
    const active = await dget(`/guilds/${DISCORD_GUILD}/threads/active`).catch(() => ({ threads: [] }));
    const arch = await dget(`/channels/${ch.id}/threads/archived/public?limit=100`).catch(() => ({ threads: [] }));
    const threads = [...(active.threads || []).filter(t => t.parent_id === ch.id), ...(arch.threads || [])].slice(0, 100);
    for (const t of threads) { const m = await dget(`/channels/${t.id}/messages/${t.id}`).catch(() => null); if (m) scan([m]); }
  } else {
    let before = "";
    for (let p = 0; p < 3; p++) {
      const msgs = await dget(`/channels/${ch.id}/messages?limit=100${before ? `&before=${before}` : ""}`);
      scan(msgs); if (!msgs.length || msgs.length < 100) break; before = msgs[msgs.length - 1].id;
    }
  }
  return map.size ? map : null;
}

// how loud a matchup is, so a 12-team board can be trimmed to its 4 best fights
function spice(a, b) {
  const even = a.w === b.w && Math.abs(a.pf - b.pf) < 12;
  const winless = a.w === 0 && a.l >= 2 || b.w === 0 && b.l >= 2;
  const skid = (a.streakType === "LOSS" && a.streakLen >= 2) || (b.streakType === "LOSS" && b.streakLen >= 2);
  const undef = a.l === 0 && b.l === 0 && a.w > 0;
  return (even ? 3 : 0) + (winless ? 3 : 0) + (skid ? 2 : 0) + (undef ? 2 : 0) + 1;
}

async function matchups() {
  const blocks = [];
  const used = new Set();   // no line repeats anywhere in the post, across all three leagues
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mMatchupScore&view=mTeam")));
    if (!j) continue;
    const period = (j.status && (j.status.currentMatchupPeriod || j.status.latestScoringPeriod)) || 0;
    if (period < 1) continue;
    const T = {};
    for (const t of j.teams || []) {
      const r = (t.record && t.record.overall) || {};
      T[t.id] = { name: teamName(t), w: r.wins || 0, l: r.losses || 0, pf: r.pointsFor || 0,
        streakType: r.streakType, streakLen: r.streakLength || 0 };
    }
    const byPf = Object.values(T).sort((a, b) => a.pf - b.pf);
    const vest = new Set(byPf.slice(0, 2).map(t => t.name));   // bottom two = real vest danger
    const games = [];
    for (const m of j.schedule || []) {
      if (m.matchupPeriodId !== period) continue;
      const a = T[m.away && m.away.teamId], b = T[m.home && m.home.teamId];
      if (a && b) games.push({ a, b });
    }
    if (!games.length) continue;
    games.sort((x, y) => spice(y.a, y.b) - spice(x.a, x.b));
    const lines = games.slice(0, 4).map(g => "· " + matchupLine(g.a, g.b, vest, used));
    blocks.push(`__${l.name} · Week ${period}__\n` + lines.join("\n"));
  }
  if (!blocks.length) return null;
  let text = [`**This week's fights** ⚔️`, "", ...blocks, "", `_Your board, your channel. Answer for it._`].join("\n");

  // If we can see who's who, swap the bold team names for the actual person. A team we can't match
  // (never introduced, or typed their name differently than ESPN has it) just stays bold — better a
  // plain name than a wrong ping. The header/footer aren't team names so they never match.
  const H = await safe(handles);
  // On a dry run, show exactly which intro cards we could read and map, so we can confirm the
  // person↔team link is landing (a team only becomes a ping if it also shows up in the fights).
  if (DRY) console.log(`(handles: ${H ? `${H.size} card(s) read — ${[...H.keys()].join(", ")}` : "none — no cards read / intro channel not found"})`);
  if (H) text = text.replace(/\*\*(.+?)\*\*/g, (m, name) => { const id = H.get(norm(name)); return id ? `<@${id}>` : m; });
  return text;
}

// The everyday needle. One short line, pulled live, that pokes exactly one team about exactly one
// true thing — a skid, a heater, the vest bubble, a record that doesn't match the points. This is
// what the heartbeat fires most, so it has to stay fresh: a random league, a random true angle, a
// deduped line. Nothing arguable-but-made-up; a manager can always look it up and see it's real.
const JAB = {
  skid:    [`**{t}** has lost {n} straight. Somebody put them out of their misery.`, `{n} losses in a row for **{t}**. Rock bottom, or is there a basement?`, `**{t}** is on a {n}-game slide. This is fine. Everything's fine.`],
  heater:  [`**{t}** has won {n} in a row. Anybody in here man enough to end it?`, `{n} straight for **{t}**. Beatable, or are we playing for second?`, `**{t}** is riding a {n}-game heater. Feels cheap. Prove it isn't, {t}.`],
  vest:    [`**{t}** is scoring the least in {L}. The vest is trying on names.`, `Fewest points in {L}: **{t}**. 🤡 season's calling.`, `**{t}** is dead last in points in {L}. Wake up before it's a costume.`],
  crown:   [`**{t}** is putting up the most points in {L}. Scared yet?`, `Most points in {L} belongs to **{t}**. Somebody knock 'em off.`, `**{t}** leads {L} in scoring. Loud about it too, probably.`],
  undef:   [`**{t}** still hasn't lost. That's an invitation, not a stat.`, `**{t}** is undefeated. Feels like a problem somebody should fix.`, `Nobody's beaten **{t}** yet. Volunteers?`],
  winless: [`**{t}** is still hunting win number one. It's getting late early.`, `**{t}** hasn't won a game. Somebody let 'em have one — no, don't.`, `Still 0-fer: **{t}**. The vest fits, just saying.`],
  fraud:   [`**{t}** is {r} on {p} points. Fraud, or getting robbed? Discuss.`, `**{t}** put up {p} points and has a {r} record to show for it. Explain that.`, `{p} points, {r} record: **{t}** is the argument this week. Pick a side.`],
};
async function jab() {
  const facts = [];
  for (const l of LEAGUES) {
    const j = await safe(() => get(fantasy(l.id, "view=mMatchupScore&view=mTeam")));
    if (!j) continue;
    const T = (j.teams || []).map(t => {
      const r = (t.record && t.record.overall) || {};
      return { name: teamName(t), w: r.wins || 0, ls: r.losses || 0, pf: r.pointsFor || 0, st: r.streakType, sl: r.streakLength || 0 };
    }).filter(t => t.w || t.ls);
    if (T.length < 2) continue;
    const byPf = [...T].sort((a, b) => b.pf - a.pf);
    const byRec = [...T].sort((a, b) => (b.w - b.ls) - (a.w - a.ls) || b.pf - a.pf);
    const skids = T.filter(t => t.st === "LOSS" && t.sl >= 2).sort((a, b) => b.sl - a.sl);
    const heats = T.filter(t => t.st === "WIN" && t.sl >= 2).sort((a, b) => b.sl - a.sl);
    const undef = T.filter(t => t.ls === 0 && t.w >= 2);
    const winless = T.filter(t => t.w === 0 && t.ls >= 2);
    const add = (angle, m) => facts.push({ angle, m: { L: l.name, ...m } });
    if (skids[0])   add("skid",    { t: skids[0].name, n: skids[0].sl });
    if (heats[0])   add("heater",  { t: heats[0].name, n: heats[0].sl });
    if (undef[0])   add("undef",   { t: pick(undef).name });
    if (winless[0]) add("winless", { t: pick(winless).name });
    add("vest",  { t: byPf[byPf.length - 1].name });
    add("crown", { t: byPf[0].name });
    if (byPf[0].name !== byRec[0].name) add("fraud", { t: byPf[0].name, r: `${byPf[0].w}-${byPf[0].ls}`, p: byPf[0].pf.toFixed(0) });
  }
  if (!facts.length) return null;
  const f = pick(facts);
  return fill(pick(JAB[f.angle]), f.m);
}

// ── wiring ───────────────────────────────────────────────────────────────────

// The two bots the server already knows by name. A webhook can borrow a name and face per
// message, which is how these get faces at all - a real bot's avatar belongs to whoever owns
// the bot, and Carl-bot gates it behind Premium.
//
// Chip helps you on gameday; Duece deals in numbers. Splitting the beats that way means the
// name on a post already tells you whether it needs action or is just the story of the week.
// Pinned to the www host on purpose: the bare domain 308s to www, and Discord fetches an
// avatar_url once and caches whatever it gets. Handing it the final URL removes the redirect
// as something that could ever quietly cost us the face.
const AVATARS = "https://www.crownorclown.com/img";
const CHIP  = { username: "Chip",  avatar_url: `${AVATARS}/chip.png` };
const DUECE = { username: "Duece", avatar_url: `${AVATARS}/duece.png` };

const BEATS = {
  slate:     { fn: slate,     hook: "PULSE_WEBHOOK_GENERAL",   as: CHIP,  sig: "Today's slate",         cooldownH: 10 },
  inactives: { fn: inactives, hook: "PULSE_WEBHOOK_GENERAL",   as: CHIP,  sig: "Starter's not playing", cooldownH: 6 },
  injuries:  { fn: injuries,  hook: "PULSE_WEBHOOK_GENERAL",   as: CHIP,  sig: "Injury tags this week", cooldownH: 18 },
  matchups:  { fn: matchups,  hook: "PULSE_WEBHOOK_GENERAL",   as: DUECE, ping: true, sig: "This week's fights", cooldownH: 18 },
  jab:       { fn: jab,       hook: "PULSE_WEBHOOK_GENERAL",   as: DUECE },
  crownvest: { fn: crownvest, hook: "PULSE_WEBHOOK_CROWNVEST", as: DUECE, chan: ["crown-and-vest", "crown", "vest", "standings", "awards"] },
  faab:      { fn: faab,      hook: "PULSE_WEBHOOK_TRADE",     as: DUECE, chan: ["trade-block", "trade", "faab", "waiver"] },
  hottake:   { fn: hottake,   hook: "PULSE_WEBHOOK_HOTTAKE",   as: DUECE, chan: ["hot-take", "hottake", "hot", "debate", "trash-talk", "trash"] },
};

// ── Discord bot fallback ─────────────────────────────────────────────────────
// A webhook targets exactly one channel, so a beat whose webhook secret isn't set has nowhere to
// go and drops silently. But the bot token (already used by the instigator) can post to ANY channel
// it can see. So when a beat has no webhook, we resolve its channel by name off the live guild list
// and post as the bot — no per-channel webhook to create. Content is identical; only the poster
// identity differs (the bot's name, since only webhooks can override username/avatar per message).
const DISCORD_API = "https://discord.com/api/v10";
const GUILD_ID = process.env.DISCORD_GUILD_ID || "1543364312028946432";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const BOT_HEADERS = { Authorization: `Bot ${BOT_TOKEN}`, "user-agent": "CrownOrClownBot (crownorclown.com, 1.0)" };

let _channelCache = null;
async function guildChannels() {
  if (_channelCache) return _channelCache;
  try {
    const r = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, { headers: BOT_HEADERS });
    if (!r.ok) { console.log(`  bot channel lookup failed: HTTP ${r.status}`); return (_channelCache = []); }
    return (_channelCache = await r.json());
  } catch (e) { console.log(`  bot channel lookup errored: ${e.message || e}`); return (_channelCache = []); }
}

// Match a text channel (type 0) by trying each name candidate as a case-insensitive substring,
// most-specific first. Logs the available channel names when nothing matches, so a missed name is
// obvious rather than silent.
async function findChannel(candidates) {
  const chans = (await guildChannels()).filter(c => c.type === 0);
  for (const want of candidates) {
    const w = want.toLowerCase();
    const hit = chans.find(c => (c.name || "").toLowerCase().includes(w));
    if (hit) return hit;
  }
  if (chans.length) console.log(`  no channel matched [${candidates.join(", ")}] — available: ${chans.map(c => "#" + c.name).join(", ")}`);
  return null;
}

// The bot's recent messages in a channel, with timestamps, for the double-post + cooldown guards.
// Reads via the bot token; returns [] if it can't (the guards then fail OPEN — never worse than
// before them).
async function recentBotMessages(channelId, limit = 50) {
  if (!BOT_TOKEN || !channelId) return [];
  try {
    const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`, { headers: BOT_HEADERS });
    if (!r.ok) return [];
    return (await r.json())
      .filter(m => m && m.author && m.author.bot)
      .map(m => ({ content: String(m.content || "").trim(), ts: Date.parse(m.timestamp) || 0 }));
  } catch { return []; }
}

async function post(hookEnv, text, as, ping, chan, sig, cooldownH) {
  // Most beats never ping — a schedule pinging people reads as spam. The fights are the exception:
  // calling someone out by name is the whole point, so that beat pings exactly the ids it named
  // (never @everyone/@here). The parse:[] guard keeps that true even if copy ever changes.
  const users = ping ? [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map(x => x[1]))] : [];
  const url = process.env[hookEnv];

  // Which channel does this land in? The general webhook posts to #general; a webhook-less beat
  // resolves its channel by name. We read that channel's recent history to guard against repeats.
  const targetChan = url ? await findChannel(["general"]) : (BOT_TOKEN && chan && chan.length ? await findChannel(chan) : null);
  const history = targetChan ? await recentBotMessages(targetChan.id) : [];

  // Guard 1 — exact: never post the same message text twice.
  const want = text.slice(0, 1900).trim();
  if (history.some(m => m.content === want)) {
    console.log(`  skip: identical message already in #${targetChan.name} — not double-posting`);
    return;
  }
  // Guard 2 — type cooldown: a "report" beat (the fights, crown/vest, FAAB…) reposts the same thing
  // with different wording, so exact-match won't catch it. If this beat's signature line is already
  // in the channel within its cooldown window, skip regardless of wording.
  if (sig && cooldownH && targetChan) {
    const cutoff = Date.now() - cooldownH * 3600 * 1000;
    if (history.some(m => m.ts >= cutoff && m.content.includes(sig))) {
      console.log(`  skip: "${sig}" already posted in #${targetChan.name} within ${cooldownH}h — not reposting`);
      return;
    }
  }

  if (!url) {
    // No webhook for this channel — fall back to the bot token if we have one and know the channel.
    if (targetChan) {
      const r = await fetch(`${DISCORD_API}/channels/${targetChan.id}/messages`, {
        method: "POST",
        headers: { ...BOT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [], users } }),
      });
      console.log(r.ok ? `  posted to #${targetChan.name} as bot (no ${hookEnv})` : `  bot post to #${targetChan.name} failed: HTTP ${r.status}`);
      return;
    }
    console.log(`  (no ${hookEnv} set${BOT_TOKEN ? ", bot fallback found no channel" : ""} — not posted)`);
    return;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: text.slice(0, 1900),
      username: as.username,
      avatar_url: as.avatar_url,
      allowed_mentions: { parse: [], users },
    }),
  });
  console.log(r.ok ? `  posted as ${as.username}` : `  post failed: HTTP ${r.status}`);
}

// What the bot has talked about lately: the set of bolded subjects (team names) in its most recent
// posts across the active channels. Each heartbeat is a fresh process with no memory, so the only
// way to avoid calling out the same team twice in a row is to read it back off the channels. Header
// lines like "Hot take of the week" are filtered out. Fails safe to an empty set (posts normally).
async function recentSubjects() {
  const names = new Set();
  if (!BOT_TOKEN) return names;
  const want = ["general", "hot-take", "crown-and-vest", "trade-block", "trash", "waiver"];
  const chans = (await guildChannels()).filter(c => c.type === 0 && want.some(w => (c.name || "").toLowerCase().includes(w)));
  for (const c of chans.slice(0, 6)) {
    try {
      const r = await fetch(`${DISCORD_API}/channels/${c.id}/messages?limit=3`, { headers: BOT_HEADERS });
      if (!r.ok) continue;
      for (const m of await r.json()) {
        if (!(m.author && m.author.bot)) continue;
        for (const mt of String(m.content || "").matchAll(/\*\*(.+?)\*\*/g)) names.add(mt[1].trim().toLowerCase());
      }
    } catch { /* a read failure just means no dedup this tick */ }
  }
  return names;
}

// The bolded team subjects a candidate post is about (headers filtered out).
function subjectsOf(text) {
  return [...String(text).matchAll(/\*\*(.+?)\*\*/g)]
    .map(m => m[1].trim().toLowerCase())
    .filter(s => s && !/^(hot take|the crown|today's slate)/i.test(s));
}

// The always-on heartbeat. Runs every half hour, all week, but does NOT post every time — it rolls
// the dice, so something lands at a time nobody can predict instead of on a visible clock. That's
// what makes a channel feel alive rather than automated. Guardrails that keep "alive" from turning
// into "muted": quiet hours (no 3am pings — managers span time zones, one's in Sweden), and a fire
// rate you can crank. jab is the light everyday needle and gets fired most; the heavier beats drop
// in now and then. Turn the whole thing up or down with PULSE_FIRE_RATE (0..1).
// The reliable gametime signal: the NFL's fixed weekly brackets (times UTC; ET = UTC-4 in season).
// These mirror the gametime cron windows in heartbeat.yml and need no network call, so they work
// even though ESPN's public scoreboard 403s GitHub's runners. This is what actually drives the
// "dial up around gametime" behavior; gameWindow() below only refines it when reachable.
function inGameBracket(d = new Date()) {
  const day = d.getUTCDay();   // 0 Sun … 6 Sat
  const h = d.getUTCHours();
  if (day === 0 && h >= 16) return true;   // Sun 10:00 MT onward — early + afternoon slate
  if (day === 1 && h <= 4)  return true;   // → Sunday Night Football (UTC Mon early)
  if (day === 4 && h === 23) return true;  // Thu pregame lead-in
  if (day === 5 && h <= 4)  return true;   // → Thursday Night Football (UTC Fri early)
  if (day === 1 && h === 23) return true;  // Mon pregame lead-in
  if (day === 2 && h <= 4)  return true;   // → Monday Night Football (UTC Tue early)
  return false;
}

// A bonus refinement: when we're NOT already in a bracket, try the live NFL scoreboard for an
// off-schedule game (international window, flex, playoffs). Returns true if a game is live or kicks
// off within the hour. ESPN's public scoreboard currently 403s datacenter IPs, so this often just
// returns false — that's fine, the brackets above carry the feature on their own. Fails safe.
async function gameWindow() {
  try {
    const j = await get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    const now = Date.now();
    for (const e of j.events || []) {
      const state = e.status && e.status.type && e.status.type.state;   // 'pre' | 'in' | 'post'
      if (state === "in") return true;                                  // a game is live right now
      if (state === "pre") {
        const mins = (new Date(e.date).getTime() - now) / 60000;
        if (mins <= 60 && mins > -20) return true;                      // within the hour before kickoff
      }
    }
  } catch (e) { console.log(`  gameWindow check failed: ${String(e.message || e)}`); }
  return false;
}

async function heartbeat() {
  const mtHour = (new Date().getUTCHours() + 18) % 24;   // MDT = UTC-6 in season
  // Gametime = we're in a known NFL bracket (reliable, no network), OR — only when we're not —
  // the live scoreboard catches an off-schedule game. Skipping the call inside brackets keeps the
  // common path fast and quiet instead of logging a 403 every gametime tick.
  let hot = inGameBracket();
  if (!hot) hot = await gameWindow();
  // Quiet hours keep 3am pings away — but a live game overrides them, since night games (SNF/MNF)
  // run past 11pm MT and that's exactly when the room is talking.
  if ((mtHour < 8 || mtHour >= 23) && !hot) { console.log(`Heartbeat: quiet hours (${mtHour}:00 MT) — holding.`); return; }
  // Around gametime the channel should feel busy; the rest of the day it's an occasional needle.
  // Two dials so you can tune each independently from repo variables without touching code.
  const baseRate = Math.max(0, Math.min(1, Number(process.env.PULSE_FIRE_RATE || 0.9)));
  const gameRate = Math.max(0, Math.min(1, Number(process.env.PULSE_FIRE_RATE_GAME || 1)));
  const rate = hot ? gameRate : baseRate;
  if (Math.random() > rate) { console.log(`Heartbeat: quiet this tick (${hot ? "gametime" : "normal"} rate ${rate}).`); return; }
  // During games the room wants takes and callouts (the stuff that makes people reply); off-hours
  // stay lighter so it never reads as spam. matchups pings the named managers — kept modest so a
  // busy game day is a few callouts, not a firehose of notifications.
  // Spread the ambient chatter across channels instead of piling every post in #general: the
  // channel-routed beats (hottake→#hot-take, crownvest→#crown-and-vest, faab→#trade-block) carry
  // real weight, so different rooms light up. jab stays the #general needle but no longer dominates.
  // matchups (the fights) is deliberately NOT here — it's an instigator that fires from its own
  // afternoon slot with jitter, so it feels spontaneous and never gets duplicated by ambient ticks.
  const weights = hot
    ? { jab: 4, hottake: 4, crownvest: 2, faab: 1, injuries: 1 }
    : { jab: 3, hottake: 3, crownvest: 3, faab: 2, injuries: 1, slate: 1 };
  const bag = [];
  for (const [n, w] of Object.entries(weights)) for (let i = 0; i < w; i++) bag.push(n);
  // Don't call out a team the bot just talked about. Try a few beats and take the first whose
  // subject isn't already on the channel's recent posts, so it never reads as the same needle twice.
  const recent = await recentSubjects();
  let name, beat, text = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    name = bag[Math.floor(Math.random() * bag.length)];
    beat = BEATS[name];
    const cand = await safe(beat.fn);
    if (!cand) continue;
    const dupes = subjectsOf(cand).filter(s => recent.has(s));
    if (!dupes.length) { text = cand; break; }
    console.log(`  reroll: ${name} repeats a recent subject (${dupes.join(", ")})`);
    text = cand;   // keep the last candidate as a fallback if every try collides
  }
  if (!text) { console.log("  nothing to say — quiet tick"); return; }
  console.log(`\n=== heartbeat${hot ? " (gametime)" : ""} → ${name} ===`);
  console.log(`(as ${beat.as.username})\n${text}`);
  // Where it lands: the channel-routed beats keep their own room (hottake→#hot-take/#trash-talk,
  // crownvest→#crown-and-vest, faab→#trade-block). jab is the frequent needle and fits any room, so
  // ROTATE it across channels — that's what keeps the whole server active instead of every ambient
  // post stacking in #general. A bot-token target (unset hook) posts to the picked channel by name.
  let hook = beat.hook, chan = beat.chan;
  if (name === "jab") {
    const rooms = [
      { hook: "PULSE_WEBHOOK_GENERAL", chan: ["general"] },
      { hook: "PULSE_WEBHOOK_UNUSED",  chan: ["trash-talk", "trash", "smack"] },
      { hook: "PULSE_WEBHOOK_UNUSED",  chan: ["trade-block", "trade", "waiver"] },
      { hook: "PULSE_WEBHOOK_UNUSED",  chan: ["crown-and-vest", "crown", "vest"] },
    ];
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    hook = room.hook; chan = room.chan;
  }
  if (!DRY) await post(hook, text, beat.as, beat.ping, chan, beat.sig, beat.cooldownH);
}

// A one-off announcement: post an arbitrary line to a channel by name (default #general). Runs
// year-round (before the off-season guard) since announcements aren't tied to the slate. Posts via
// the general webhook when targeting #general, otherwise via the bot-token fallback to the named
// channel. Usage: node tools/pulse.mjs --say "text" [--to channel] [--dry]
const sayText = arg("say");
if (typeof sayText === "string") {
  const to = arg("to");
  const toName = typeof to === "string" ? to : "general";
  const hookEnv = /general/i.test(toName) ? "PULSE_WEBHOOK_GENERAL" : "PULSE_WEBHOOK_UNUSED";
  console.log(`\n=== announce → #${toName} ===\n${sayText}`);
  if (!DRY) await post(hookEnv, sayText, CHIP, false, [toName]);
  process.exit(0);
}

// Feb–Jul there are no games and nothing truthful to say.
const month = new Date().getUTCMonth();
if (month > 0 && month < 7) { console.log("Off-season — pulse is quiet."); process.exit(0); }

if (arg("heartbeat")) { await heartbeat(); process.exit(0); }

const which = arg("all") ? Object.keys(BEATS) : [arg("beat")].filter(Boolean);
if (!which.length) { console.error("Need --beat <name> or --all. Beats: " + Object.keys(BEATS).join(", ")); process.exit(1); }

for (const name of which) {
  const beat = BEATS[name];
  if (!beat) { console.error(`unknown beat: ${name}`); continue; }
  console.log(`\n=== ${name} ===`);
  const text = await safe(beat.fn);
  if (!text) { console.log("  nothing to say"); continue; }
  console.log(`(as ${beat.as.username})\n${text}`);
  if (!DRY) await post(beat.hook, text, beat.as, beat.ping, beat.chan, beat.sig, beat.cooldownH);
}
