/**
 * The cannon.
 *
 * Not another post. A set piece: the channel goes quiet, the gun loads, and then a burst of
 * direct hits lands one after another, fast enough that it reads as incoming fire rather than a
 * list. Fired once a week, after the games settle, at whatever the week actually did to people.
 *
 *   node tools/cannon.mjs --dry       print the whole barrage, fire nothing
 *   node tools/cannon.mjs             fire it, if this week's hasn't gone already
 *   node tools/cannon.mjs --force     fire it again anyway
 *
 * What it fires at: the biggest blowouts, the lowest score on the board, the worst start of the
 * week. Teams and NFL players take the hits. Members never get aimed at each other — "your team
 * got shelled" is the game; "go argue with him" is not, and never appears here.
 *
 * Paced at 1.4 seconds a shot. Discord lets a bot send five messages per five seconds in one
 * channel, so this sits comfortably under the limit and still reads as a barrage.
 */

import { createHash } from "node:crypto";
import { LEAGUES } from "../lib/crank-material.mjs";
import { everything } from "../lib/crank-material.mjs";
import { update, readJSON, configured } from "../lib/board-data.mjs";
import { findChannel, say, ready, conversation, edit } from "../lib/discord-bot.mjs";

const has = n => process.argv.includes("--" + n);
const arg = n => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const DRY = has("dry");
const FORCE = has("force");
const LEDGER = "said.json";
const SEASON = Number(process.env.SEASON) || 2026;
const API = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/`;
const r1 = n => Math.round(n * 10) / 10;
const clean = s => String(s || "").replace(/[*_`~|]/g, "").trim();
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Three pieces of ordnance, picked by what the week actually did rather than by a coin toss.
 *
 *   cannon  — the standard weekly barrage
 *   plane   — a bombing run: one pass, a bomb dropped on every board
 *   nuke    — held back for a genuine massacre, so it still means something when it goes
 *
 * The escalation is the point. If the big one goes off every week it is just the weekly post with
 * a louder picture on it.
 */
const FILE = {
  cannon: "cards/art/cannon.png",
  bomber: "cards/art/plane.png",
  nuke:   "cards/art/nuke.png",
};

const OPENERS = {
  cannon: w => `**THE CANNON IS LOADED.** Week ${w} is settled, and somebody has to answer for it.`,
  bomber: w => `**WHEELS UP.** Bombing run on week ${w}. These are the ones who didn't turn up.`,
  nuke: w => `**THIS IS NOT A DRILL.**
Week ${w} just set a season record, and that only gets one response.

**3…**
**2…**
**1…**`,
};

const CLOSERS = {
  cannon: `**Guns cold.** Reload Tuesday.`,
  bomber: `**Back to base.** Check your lineup before you do that again.`,
  nuke: `**Fallout settles Sunday.** Nothing like that has happened all season.`,
};

/** Last completed week's matchups across all three boards, worst beatings first. */
// Every settled week of the season, not just the last one, so the piece can be judged against
// what this league actually produces rather than a number I guessed at.
async function allWeeks() {
  const byWeek = {};
  for (const L of LEAGUES) {
    const r = await fetch(`${API}${L.id}?view=mMatchupScore&view=mTeam`);
    if (!r.ok) continue;
    const j = await r.json();
    const now = (j.scoringPeriodId || 1) - 1;
    for (const m of j.schedule || []) {
      const wk = m.matchupPeriodId;
      if (!wk || wk > now || !m.away || !m.home) continue;
      const hp = r1(m.home.totalPoints || 0), ap = r1(m.away.totalPoints || 0);
      if (!hp && !ap) continue;
      (byWeek[wk] ||= []).push(Math.abs(r1(hp - ap)));
    }
  }
  return byWeek;
}

async function battles() {
  const out = [];
  for (const L of LEAGUES) {
    const r = await fetch(`${API}${L.id}?view=mMatchupScore&view=mTeam`);
    if (!r.ok) continue;
    const j = await r.json();
    const wk = (j.scoringPeriodId || 1) - 1;
    if (wk < 1) continue;
    const names = {};
    for (const t of j.teams || []) names[t.id] = clean(t.name) || `Team ${t.id}`;
    for (const m of j.schedule || []) {
      if (m.matchupPeriodId !== wk || !m.away || !m.home) continue;
      const h = { name: names[m.home.teamId], pts: r1(m.home.totalPoints || 0) };
      const a = { name: names[m.away.teamId], pts: r1(m.away.totalPoints || 0) };
      if (!h.pts && !a.pts) continue;
      const [win, lose] = h.pts >= a.pts ? [h, a] : [a, h];
      out.push({ league: L.name, week: wk, win, lose, margin: r1(win.pts - lose.pts) });
    }
  }
  return out.sort((x, y) => y.margin - x.margin);
}

/**
 * Which piece the week has earned. A seventy-point beating is a different event from a tight week,
 * and the gun should say so. Held to a real threshold so the nuke stays rare enough to matter.
 */
/**
 * Three separate set pieces, each with its own day and its own subject. They are not rungs of one
 * ladder any more: the first version escalated by margin, and because a 75-point beating happens
 * most weeks across three twelve-team leagues, the nuke went off every single time and the cannon
 * it was named after never fired once.
 *
 *   cannon  Tuesday   — the head-to-head beatings. Who got run off the field.
 *   bomber  Thursday  — the bust run. Carpet-bombs the starters who didn't turn up.
 *   nuke    when earned — a season record actually falling, and nothing less.
 */
export function recordFell(fights, history) {
  const worst = fights.length ? fights[0].margin : 0;
  const thisWeek = fights.length ? fights[0].week : 0;
  const priors = Object.entries(history)
    .filter(([wk]) => Number(wk) < thisWeek)
    .flatMap(([, margins]) => margins);
  if (!priors.length) return false;
  return worst > Math.max(...priors);
}

/**
 * What each piece fires at. Separate subjects on purpose — the cannon is about who beat whom,
 * the bomber is about players who didn't turn up, and the nuke only speaks when a record falls.
 */
export function loadShells(fights, facts, piece = "cannon") {
  const shells = [];
  const wk = fights.length ? fights[0].week : 0;

  if (piece === "nuke") {
    const f = fights[0];
    shells.push(`☢️ **GROUND ZERO** · ${f.league}
${f.win.name} **${f.win.pts}** — ${f.lose.name} **${f.lose.pts}**.
**${f.margin} points.** Biggest beating anyone has handed out all season.`);
    const allScores = fights.flatMap(x => [x.win, x.lose]).sort((x, y) => y.pts - x.pts);
    if (allScores.length) shells.push(`☢️ **BLAST RADIUS** · ${allScores[0].name} put up ${allScores[0].pts} the same week. Nobody was safe.`);
    return { week: wk, shells };
  }

  if (piece === "bomber") {
    // The bust run. Lots of small targets rather than one big one, which is what a bombing run is.
    const seen = new Set();
    const busts = facts.filter(f => f.kind === "bunk")
      .sort((x, y) => y.short - x.short)
      .filter(f => !seen.has(f.player) && seen.add(f.player))
      .slice(0, 5);
    for (const f of busts) {
      shells.push(`🛩️ **BOMB AWAY** · ${f.player} (${f.pos}) — down for ${f.projected}, finished on ${f.scored}.${f.shared > 1 ? ` ${f.shared} of you were holding him.` : ""}`);
    }
    const bench = facts.filter(f => f.kind === "benched").sort((x, y) => y.gap - x.gap)[0];
    if (bench) shells.push(`🛩️ **FRIENDLY FIRE** · ${bench.sat} scored ${bench.satPts} in a shirt and tie, while ${bench.played} started and managed ${bench.playedPts}.`);
    return { week: wk, shells };
  }

  // cannon — the head-to-head beatings
  for (const f of fights.slice(0, 4)) {
    shells.push(`💥 **DIRECT HIT** · ${f.league}
${f.win.name} **${f.win.pts}** — ${f.lose.name} **${f.lose.pts}**. ${f.margin} points of daylight.`);
  }
  const allScores = fights.flatMap(f => [f.win, f.lose]).sort((x, y) => x.pts - y.pts);
  if (allScores.length >= 2) {
    const low = allScores[0], next = allScores[1];
    shells.push(r1(next.pts - low.pts) >= 10
      ? `💥 **LOWEST SCORE ON THE BOARD** · ${low.name}, ${low.pts}. The next worst was ${next.pts}, so that one stands alone.`
      : `💥 **LOWEST SCORE ON THE BOARD** · ${low.name}, ${low.pts}. ${next.name} was right behind on ${next.pts}.`);
  }
  return { week: wk, shells };
}

async function main() {
  if (process.env.CRANK_OFF && !DRY) { console.log("CRANK_OFF is set — the gun stays cold."); return; }

  // --tidy: the first barrage went out with the artwork as a bare link, so the raw URL sat above
  // the picture. Re-sends that opening shot as a proper embed. Harmless to run again.
  if (has("tidy")) {
    const chan = await findChannel(["trash-talk", "trash", "general"]);
    if (!chan) { console.error("no channel"); return; }
    const msgs = await conversation(chan.id, 30);
    const open = msgs.find(m => m.author && m.author.bot && /IS NOT A CANNON|CANNON IS LOADED|WHEELS UP/.test(m.content || ""));
    if (!open) { console.log("nothing to tidy"); return; }
    const LINK = /https:\/\/\S+\/cards\/art\/\S+\.png/;
    const art = (LINK.exec(open.content || "") || [])[0];
    const cleaned = String(open.content || "").replace(new RegExp(`\\s*${LINK.source}\\s*`, "g"), "").trim();
    void art;
    const pieceNow = /IS NOT A CANNON/.test(open.content) ? "nuke" : /WHEELS UP/.test(open.content) ? "plane" : "cannon";
    await edit(chan.id, open.id, cleaned, { file: FILE[pieceNow] });
    console.log("tidied", open.id);
    return;
  }

  const fights = await battles();
  if (!fights.length) { console.log("No settled week to fire at yet."); return; }
  const facts = await everything().catch(() => []);
  // "auto" runs every day and fires whichever piece has something worth firing at and has not
  // already gone off for this week. That is what spreads them across the week instead of stacking
  // everything on a Tuesday: the nuke goes the day a record actually falls, the cannon once the
  // beatings are settled, the bomber on the busts — each at most once a week, on whatever day it
  // earns.
  const asked = (arg("piece") || "auto").trim();
  if (asked !== "auto" && !FILE[asked]) { console.error("--piece must be auto, cannon, bomber or nuke"); process.exitCode = 1; return; }

  const ledgerNow = configured()
    ? (await readJSON(LEDGER, null).catch(() => ({ data: null }))).data || {}
    : {};
  const fired = new Set(ledgerNow.keys || []);
  const weekNow = fights.length ? fights[0].week : 0;
  const history = await allWeeks().catch(() => ({}));

  const order = asked === "auto" ? ["nuke", "cannon", "bomber"] : [asked];
  let piece = null, shells = [], week = weekNow;
  for (const cand of order) {
    if (!FORCE && fired.has(`${cand}:${SEASON}:w${weekNow}`)) continue;
    if (cand === "nuke" && !FORCE && !recordFell(fights, history)) continue;
    const got = loadShells(fights, facts, cand);
    if (!got.shells.length) continue;
    piece = cand; shells = got.shells; week = got.week;
    break;
  }
  if (!piece) { console.log("Nothing worth firing at today — everything this week has already gone."); return; }

  const key = `${piece}:${SEASON}:w${week}`;   // one set piece a week, whichever piece it earned
  if (!FORCE && fired.has(key)) {
    console.log(`Week ${week} cannon has already fired.`);
    return;
  }

  // Words first, then the picture — Discord puts the embed under the text, so this reads as the
  // announcement followed by the thing going off rather than a stray link with a caption.
  const open = OPENERS[piece](week);
  const close = CLOSERS[piece];
  // The last word is a poll. A barrage that ends in a question gets read; one that ends in four
  // buttons gets answered, and being answered is the entire point of firing it.
  const sitting = [...new Set(fights.map(f => f.lose.name))].slice(0, 4);
  const closePoll = sitting.length >= 2
    ? { question: "Who takes the next one?", answers: sitting.map(n => ({ text: n })), hours: 48 }
    : null;

  if (DRY) {
    console.log([open, ...shells, close].join("\n\n— — —\n\n"));
    if (closePoll) console.log("\nPOLL → " + closePoll.question + "\n" + closePoll.answers.map(a => "       ( ) " + a.text).join("\n"));
    console.log(`\n(piece: ${piece} — ${shells.length + 2} messages, ~${((shells.length + 1) * 1.4).toFixed(1)}s to fire)`);
    return;
  }
  if (!ready()) { console.error("No DISCORD_BOT_TOKEN — nothing fired."); process.exitCode = 1; return; }

  const chan = await findChannel(["trash-talk", "trash", "general"]);
  if (!chan) { console.error("No channel to fire into."); process.exitCode = 1; return; }

  await say(chan.id, open, { file: FILE[piece] });
  for (const s of shells) { await wait(1400); await say(chan.id, s); }
  await wait(1400);
  await say(chan.id, close, closePoll ? { poll: closePoll } : {});

  if (configured()) {
    await update(LEDGER, { keys: [] }, `Cannon week ${week}`,
      L => ({ ...(L || {}), keys: ((L && L.keys) || []).concat(key) })).catch(() => {});
  }
  console.log(`fired ${piece}: ${shells.length + 2} rounds into #${chan.name}`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
