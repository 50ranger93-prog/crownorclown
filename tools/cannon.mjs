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
const DRY = has("dry");
const FORCE = has("force");
const LEDGER = "said.json";
const SEASON = Number(process.env.SEASON) || 2026;
const API = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/`;
const r1 = n => Math.round(n * 10) / 10;
const clean = s => String(s || "").replace(/[*_`~|]/g, "").trim();
const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Three tiers of ordnance, picked by what the week actually did rather than by a coin toss.
 *
 *   cannon  — the standard weekly barrage
 *   plane   — a bombing run: one pass, a bomb dropped on every board
 *   nuke    — held back for a genuine massacre, so it still means something when it goes
 *
 * The escalation is the point. If the big one goes off every week it is just the weekly post with
 * a louder picture on it.
 */
const SITE = process.env.PUBLIC_URL || "https://www.crownorclown.com";
const ART = {
  cannon: `${SITE}/cards/art/cannon.png`,
  plane:  `${SITE}/cards/art/plane.png`,
  nuke:   `${SITE}/cards/art/nuke.png`,
};

const OPENERS = {
  cannon: w => `**THE CANNON IS LOADED.** Week ${w} is settled, and somebody has to answer for it.`,
  plane: w => `**WHEELS UP.** One pass over all three boards. Week ${w}, bomb bay open.`,
  nuke: w => `**THIS ONE IS NOT A CANNON.**\nWeek ${w} produced something that needed the big one.\n\n**3…**\n**2…**\n**1…**`,
};

const CLOSERS = {
  cannon: `**Guns cold.** Reload is Sunday.\n-# Whose turn is it to take one next week? Name them.`,
  plane: `**Back to base.** Everybody check your roof.\n-# Who deserves the next run? Make your case.`,
  nuke: `**Fallout settles Sunday.**\n-# Nothing like that has happened all season. Think you can beat it?`,
};

/** Last completed week's matchups across all three boards, worst beatings first. */
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
 * Which tier the week has earned. A seventy-point beating is a different event from a tight week,
 * and the gun should say so. Held to a real threshold so the nuke stays rare enough to matter.
 */
export function pickTier(fights, forced) {
  if (forced && ART[forced]) return forced;
  const worst = fights.length ? fights[0].margin : 0;
  if (worst >= 75) return "nuke";
  if (worst >= 45) return "plane";
  return "cannon";
}

/** Everything the gun is pointed at, in the order it fires. */
export function loadShells(fights, facts, tier = "cannon") {
  const shells = [];
  const wk = fights.length ? fights[0].week : 0;

  if (tier === "nuke") {
    const f = fights[0];
    shells.push(`☢️ **GROUND ZERO** · ${f.league}
${f.win.name} **${f.win.pts}** — ${f.lose.name} **${f.lose.pts}**.
**${f.margin} points.** That is not a loss, that is a weather event.`);
  }

  const hits = tier === "plane" ? 3 : tier === "nuke" ? 2 : 4;
  for (const f of (tier === "nuke" ? fights.slice(1, 1 + hits) : fights.slice(0, hits))) {
    const mark = tier === "plane" ? "🛩️ **BOMB AWAY**" : tier === "nuke" ? "💥 **SECONDARY**" : "💥 **DIRECT HIT**";
    shells.push(`${mark} · ${f.league}\n${f.win.name} **${f.win.pts}** — ${f.lose.name} **${f.lose.pts}**. ${f.margin} points of daylight.`);
  }

  // "Nothing else came close" has to be true before it is said. Every score that week, both
  // sides of every matchup, sorted — and the line only claims daylight when there is daylight.
  const allScores = fights.flatMap(f => [f.win, f.lose]).sort((a, b) => a.pts - b.pts);
  if (allScores.length >= 2) {
    const low = allScores[0], next = allScores[1];
    const clear = r1(next.pts - low.pts);
    shells.push(clear >= 10
      ? `💥 **LOWEST SCORE ON THE BOARD** · ${low.name}, ${low.pts}. The next worst was ${next.pts}, so that one stands alone.`
      : `💥 **LOWEST SCORE ON THE BOARD** · ${low.name}, ${low.pts}. ${next.name} was right behind on ${next.pts}.`);
  }

  const worst = facts.filter(f => f.kind === "bunk").sort((a, b) => b.short - a.short)[0];
  if (worst) {
    shells.push(`💥 **CASUALTY REPORT** · ${worst.player} was down for ${worst.projected} and finished on ${worst.scored}. ${worst.shared > 1 ? `${worst.shared} of you were holding him.` : ""}`.trim());
  }

  const bench = facts.filter(f => f.kind === "benched").sort((a, b) => b.gap - a.gap)[0];
  if (bench) {
    shells.push(`💥 **FRIENDLY FIRE** · ${bench.sat} scored ${bench.satPts} in a shirt and tie, while ${bench.played} started and managed ${bench.playedPts}.`);
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
    if (!art) { console.log("already tidy"); return; }
    await edit(chan.id, open.id, cleaned, { image: art });
    console.log("tidied", open.id);
    return;
  }

  const fights = await battles();
  if (!fights.length) { console.log("No settled week to fire at yet."); return; }
  const facts = await everything().catch(() => []);
  const forced = (process.argv[process.argv.indexOf("--tier") + 1] || "").trim();
  const tier = pickTier(fights, has("tier") ? forced : "");
  const { week, shells } = loadShells(fights, facts, tier);

  const key = `cannon:${SEASON}:w${week}`;   // one set piece a week, whichever tier it earned
  const ledger = configured()
    ? (await readJSON(LEDGER, null).catch(() => ({ data: null }))).data || {}
    : {};
  if (!FORCE && (ledger.keys || []).includes(key)) {
    console.log(`Week ${week} cannon has already fired.`);
    return;
  }

  // Words first, then the picture — Discord puts the embed under the text, so this reads as the
  // announcement followed by the thing going off rather than a stray link with a caption.
  const open = `${OPENERS[tier](week)}\n${ART[tier]}`;
  const close = CLOSERS[tier];
  // The last word is a poll. A barrage that ends in a question gets read; one that ends in four
  // buttons gets answered, and being answered is the entire point of firing it.
  const sitting = [...new Set(fights.map(f => f.lose.name))].slice(0, 4);
  const closePoll = sitting.length >= 2
    ? { question: "Who takes the next one?", answers: sitting.map(n => ({ text: n })), hours: 48 }
    : null;

  if (DRY) {
    console.log([open, ...shells, close].join("\n\n— — —\n\n"));
    if (closePoll) console.log("\nPOLL → " + closePoll.question + "\n" + closePoll.answers.map(a => "       ( ) " + a.text).join("\n"));
    console.log(`\n(tier: ${tier} — ${shells.length + 2} messages, ~${((shells.length + 1) * 1.4).toFixed(1)}s to fire)`);
    return;
  }
  if (!ready()) { console.error("No DISCORD_BOT_TOKEN — nothing fired."); process.exitCode = 1; return; }

  const chan = await findChannel(["trash-talk", "trash", "general"]);
  if (!chan) { console.error("No channel to fire into."); process.exitCode = 1; return; }

  await say(chan.id, open, { image: ART[tier] });
  for (const s of shells) { await wait(1400); await say(chan.id, s); }
  await wait(1400);
  await say(chan.id, close, closePoll ? { poll: closePoll } : {});

  if (configured()) {
    await update(LEDGER, { keys: [] }, `Cannon week ${week}`,
      L => ({ ...(L || {}), keys: ((L && L.keys) || []).concat(key) })).catch(() => {});
  }
  console.log(`fired ${tier}: ${shells.length + 2} rounds into #${chan.name}`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
