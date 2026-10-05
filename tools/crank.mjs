/**
 * The daily bot. Posts between 9am and 8pm Mountain, never overnight, and never the same thing
 * twice — not the same fact, not the same wording, not ever.
 *
 *   node tools/crank.mjs --dry            what it would say right now
 *   node tools/crank.mjs --dry --plan 12  twelve posts in a row, to read the variety
 *   node tools/crank.mjs                  post, if this hour is one of today's slots
 *   node tools/crank.mjs --force          post now regardless of the hour or the day's count
 *
 * Why the old one repeated, for anyone who finds this later: it chose from twenty-one hand-written
 * sentences and only remembered its recent posts. Finite words plus a short memory is a loop. This
 * one writes about numbers that happened — a projection missed by 11.4, a $15 waiver claim that
 * returned 0.7 — which are never the same twice, and it keeps every fact key and every line it has
 * ever said in a permanent ledger that it refuses to reuse.
 *
 * The rules it will not break:
 *   - 9am to 8pm Mountain. Nobody wants a notification at 3am.
 *   - Players get called out. Managers get teased about decisions. Members are never attacked and
 *     never set against each other.
 *   - Clean. Checked on the finished text, not trusted to the writing.
 *   - Every post ends with something to answer, because the point is a room that talks.
 */

import { createHash } from "node:crypto";
import { everything } from "../lib/crank-material.mjs";
import { ANGLES, POLLS, render, clean } from "../lib/crank-voice.mjs";
import { update, readJSON, configured } from "../lib/board-data.mjs";
import { findChannel, say, react, conversation, ready } from "../lib/discord-bot.mjs";

const arg = n => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const has = n => process.argv.includes("--" + n);
const DRY = has("dry");
const FORCE = has("force");
const PLAN = Number(arg("plan") || 0);
const LEDGER = "said.json";
const EMPTY = { keys: [], texts: [], managers: {}, angles: {}, kinds: {}, days: {}, lastKind: "" };

const hash = s => createHash("sha256").update(String(s).toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

// Mountain time without pulling in a library: ask the runtime what the hour is over there.
const mt = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

const OPEN_HOUR = 9, CLOSE_HOUR = 20;      // 9am through 8pm, inclusive of the 8pm hour

// A stable number per day, so every run on the same day agrees how many posts today gets without
// anybody having to store it. Some days are busy, some are quiet; that unpredictability is the
// point — a room learns a fixed schedule in a week and stops looking.
function targetForDay(day) {
  const n = parseInt(hash("target:" + day).slice(0, 6), 16);
  return 3 + (n % 7);                       // 3 to 9
}

// Which rooms each kind of material belongs in.
// Each kind has more than one home, and they rotate, so the bot fans out across the server
// instead of filling one channel and leaving the rest dead.
const ROOM = {
  poll:     [["general"], ["trash-talk", "trash"], ["waivers-and-lineups", "waiver"]],
  member:   [["general"], ["trash-talk", "trash"]],
  news:     [["general"], ["waivers-and-lineups", "waiver"]],
  ref:      [["trash-talk", "trash"], ["general"]],
  roundup:  [["general"]],
  bunk:     [["trash-talk", "trash"], ["general"]],
  benched:  [["waivers-and-lineups", "waiver", "lineup"], ["trash-talk", "general"]],
  faab:     [["waivers-and-lineups", "waiver"], ["trade-block", "trade"]],
  tightwad: [["trade-block", "trade"], ["waivers-and-lineups", "waiver"]],
  quiet:    [["general"]],
  surprise: [["general"], ["trash-talk", "trash"]],
};
const roomFor = (kind, n) => {
  const sets = ROOM[kind] || [["general"]];
  return sets[n % sets.length];
};

/**
 * Choose what to say. Everything already said is off the table, and managers who have been in the
 * bot's mouth most recently go to the back of the queue — the instruction was call everyone out,
 * not find three people and live there.
 */
export function choose(facts, ledger, want = 1) {
  const usedKeys = new Set(ledger.keys || []);
  const usedText = new Set(ledger.texts || []);
  const seenBy = ledger.managers || {};        // manager -> times featured, all season
  const seenAngle = { ...(ledger.angles || {}) };  // "kind/angle" -> times used, all season
  const seenKind = { ...(ledger.kinds || {}) };

  const fresh = facts.filter(f => !usedKeys.has(f.key));
  const out = [];
  const takenKey = new Set();
  const batchManager = new Map();
  const batchSubject = new Map();              // the player being talked about
  let lastKind = ledger.lastKind || "";

  // Worst offences first, but a manager the bot has already been talking about drops down the
  // list, and so does a kind of post it just made. The instruction was call everyone out — not
  // find three people and live there, and not say the same shape of sentence all afternoon.
  // The same name three times in an afternoon reads as a repeat even when every number is
  // different, so the player being talked about is pushed down hard once he's had his turn.
  const subjectOf = f => f.player || f.sat || f.manager;
  // Everyone gets talked about. A manager the bot has never mentioned outranks whatever happened
  // to be the worst afternoon this week — "no favourites, no 'these guys'" was the instruction,
  // and a soft penalty wasn't enough to guarantee it.
  const neverMentioned = f => f.manager && !(f.manager in seenBy) && !batchManager.has(f.manager);
  const factScore = f => {
    const batch = batchManager.get(f.manager) || 0;
    const subj = batchSubject.get(subjectOf(f)) || 0;
    const history = seenBy[f.manager] || 0;
    const kindRun = f.kind === lastKind ? 25 : 0;
    const kindUse = (seenKind[f.kind] || 0) * 1.5;
    const unseen = neverMentioned(f) ? 1000 : 0;
    return f.weight + unseen - history * 2.5 - batch * 40 - subj * 60 - kindRun - kindUse;
  };

  // Each kind gets a share of the output rather than competing on weight. Weight answers "how
  // bad was it", which polls, members, news and the officials always lose — and those are exactly
  // the posts that get answered and that keep everybody in the conversation. Shares are measured
  // against everything the bot has ever said, so the mix corrects itself over a season rather
  // than over an afternoon.
  const SHARE = {
    poll: 0.26,      // the ones people actually answer
    member: 0.22,    // nobody is invisible — 36 managers, all of them, on rotation
    bunk: 0.15,
    faab: 0.11,
    benched: 0.10,
    news: 0.08,
    ref: 0.04,
    roundup: 0.04,   // one board a week, every name in it
    surprise: 0.02,
    quiet: 0.01,
    tightwad: 0.01,
  };
  const said = { ...seenKind };
  let allSaid = Object.values(said).reduce((a, b) => a + b, 0);

  for (let n = 0; n < want; n++) {
    let pool = fresh.filter(f => !takenKey.has(f.key));
    if (!pool.length) break;

    // Whichever kind is furthest behind its share, and still has something fresh to say, goes next.
    const available = new Set(pool.map(f => f.kind));
    const behind = Object.keys(SHARE)
      .filter(k => available.has(k) && k !== lastKind)
      .sort((x, y) => (SHARE[y] - (said[y] || 0) / Math.max(allSaid, 1)) - (SHARE[x] - (said[x] || 0) / Math.max(allSaid, 1)));
    const wantKind = behind[0];
    if (wantKind) pool = pool.filter(f => f.kind === wantKind);
    pool.sort((a, b) => factScore(b) - factScore(a));

    let picked = null;
    for (const f of pool.slice(0, 40)) {
      // Rotate the wording: the angle used least gets first refusal, so a shape can't dominate
      // an afternoon just because it happens to be first in the list.
      // A fact can only be used once, so whichever angle takes it is the only line it will ever
      // get. The specific ones — the genuine biggest bid, the dollar that returned twenty — fit
      // only a handful of facts, so they get a head start or a generic line eats the fact and the
      // good line never fires. A head start, not a free pass: it is worth three quarters of a use,
      // so a sharp angle wins the close calls and then falls back in line. Letting it win outright
      // just swaps one repeated sentence for another, which is the whole thing we are fixing.
      const angles = (ANGLES[f.kind] || [])
        .map(a => ({ a, used: seenAngle[`${f.kind}/${a.id}`] || 0, pri: a.priority || 0 }))
        .sort((x, y) => (x.used - x.pri * 0.75) - (y.used - y.pri * 0.75));

      for (const { a } of angles) {
        // A line that names one manager is only allowed when that manager was actually alone in
        // it. Half the league starts the same players; singling one person out for something six
        // of them did is unfair, and everyone reading knows it.
        if (a.solo && !f.solo) continue;
        const r = render(f, a);
        if (!r) continue;
        const full = r.hook ? `${r.text}\n-# ${r.hook}` : r.text;
        if (!clean(full)) continue;
        if (usedText.has(hash(full))) continue;
        picked = { fact: f, ...r, full, textHash: hash(full) };
        break;
      }
      if (picked) break;
    }
    if (!picked) break;

    out.push(picked);
    takenKey.add(picked.fact.key);
    usedText.add(picked.textHash);
    batchManager.set(picked.fact.manager, (batchManager.get(picked.fact.manager) || 0) + 1);
    const s = subjectOf(picked.fact);
    batchSubject.set(s, (batchSubject.get(s) || 0) + 1);
    seenAngle[`${picked.fact.kind}/${picked.angleId}`] = (seenAngle[`${picked.fact.kind}/${picked.angleId}`] || 0) + 1;
    seenKind[picked.fact.kind] = (seenKind[picked.fact.kind] || 0) + 1;
    lastKind = picked.fact.kind;
    said[picked.fact.kind] = (said[picked.fact.kind] || 0) + 1;
    allSaid++;
  }
  return out;
}

/**
 * The material that isn't a stat line: the nudges about using the place, and the surprises.
 *
 * Both are keyed by the day, so each one can be said exactly once ever and then never again. The
 * nudges never name anybody — a joke about a specific quiet person has to be funny to that person
 * first, and a schedule can't judge that. The surprises are built out of the week's own facts, so
 * they're true, and they're the only posts that aren't about somebody falling short.
 */
export function extras(facts, day) {
  const out = [];

  // One board a week, every manager in it named. Keyed by league and week so each board comes
  // round once and never repeats.
  const mem = facts.filter(f => f.kind === "member");
  const byLeague = {};
  for (const m of mem) (byLeague[m.league] ||= []).push(m);
  for (const [lg, rows] of Object.entries(byLeague)) {
    if (rows.length < 4) continue;
    const sorted = [...rows].sort((a, b) => b.pf - a.pf).map((r, i) => ({ ...r, rank: i + 1 }));
    out.push({
      kind: "roundup", key: `roundup:${lg}:${rows[0].week}`, manager: "", weight: 12,
      league: lg, weeks: rows[0].w + rows[0].l, rows: sorted,
    });
  }

  // Polls, built from the week's own numbers. Weighted high on purpose: the people who will never
  // type a message will still tap a button, and that is the difference between posting at a room
  // and hearing back from it. Keyed by week so each one runs once and never comes round again.
  const wk = (facts.find(f => f.week) || {}).week || 0;
  for (const p of POLLS) {
    const built = p.build(facts);
    if (!built) continue;
    out.push({
      kind: "poll", key: `poll:${p.id}:${wk}`, manager: "", weight: 14,
      text: built.text, poll: { question: built.question, answers: built.answers, hours: 24 },
    });
  }
  out.push({ kind: "quiet", key: `quiet:${day}`, manager: "", weight: 3, who: "Somebody in here" });

  // Something true that reads as improbable: the same player started by several managers and
  // letting all of them down on the same afternoon.
  const byPlayer = {};
  for (const f of facts) if (f.kind === "bunk") (byPlayer[f.player] ||= []).push(f);
  const shared = Object.entries(byPlayer)
    .filter(([, l]) => l.length >= 3)
    .sort((a, b) => b[1][0].short - a[1][0].short)[0];
  if (shared) {
    const [name, list] = shared;
    out.push({
      kind: "surprise", key: `surprise:shouldnt:${day}:${name}`, manager: list[0].manager, weight: 9,
      stat: `${name} was started by ${list.length} different managers across the three boards this week. He scored ${list[0].scored} for every one of them.`,
    });
  }

  // A quiet, genuine one. Nobody expects the robot to be nice, which is exactly why it lands.
  const best = {};
  for (const f of facts) if (f.kind === "bunk") best[f.manager] = (best[f.manager] || 0) + 1;
  const cleanest = Object.entries(best).sort((a, b) => a[1] - b[1])[0];
  if (cleanest) {
    out.push({
      kind: "surprise", key: `surprise:praise:${day}:${cleanest[0]}`, manager: cleanest[0], weight: 6,
      reason: "having fewer starters let them down than anybody else on the board",
    });
  }
  return out;
}

/**
 * Notice the people who answered.
 *
 * A room stops replying to something that never replies back. Every run, before it says anything
 * new, the bot looks at the rooms it posts in, finds real messages that landed after one of its
 * own, and puts a reaction on them. It costs one API call and it is the difference between a
 * noticeboard and a conversation.
 *
 * It only ever reacts — it never argues, never corrects anybody, and never replies in words,
 * because a bot with opinions about what a member said is exactly the thing that starts fights.
 */
const NODS = ["👀", "🔥", "😂", "💀", "🫡", "📈", "🤝", "🏈"];
async function noticeReplies(ledger) {
  const seen = new Set(ledger.noticed || []);
  const fresh = [];
  const rooms = ["general", "trash-talk", "waivers-and-lineups", "trade-block"];
  for (const name of rooms) {
    const chan = await findChannel([name]).catch(() => null);
    if (!chan) continue;
    const msgs = await conversation(chan.id, 30).catch(() => []);
    // Newest first from Discord; walk back to the bot's most recent post and take the humans
    // who have spoken since.
    const since = [];
    for (const m of msgs) {
      if (m.author && m.author.bot) break;
      since.push(m);
    }
    for (const m of since) {
      if (seen.has(m.id)) continue;
      if (!m.id || (m.author && m.author.bot)) continue;
      const nod = NODS[parseInt(hash(m.id).slice(0, 4), 16) % NODS.length];
      if (await react(chan.id, m.id, nod).catch(() => false)) fresh.push(m.id);
    }
  }
  return fresh;
}

async function readLedger() {
  if (!configured()) return EMPTY;
  const { data } = await readJSON(LEDGER, null).catch(() => ({ data: null }));
  return data || EMPTY;
}

async function remember(pick, day, extraNoticed = []) {
  return update(LEDGER, EMPTY, `Said: ${pick.fact.kind} ${pick.angleId}`, L => {
    const next = {
      keys: (L.keys || []).concat(pick.fact.key),
      texts: (L.texts || []).concat(pick.textHash),
      managers: { ...(L.managers || {}) },
      angles: { ...(L.angles || {}) },
      kinds: { ...(L.kinds || {}) },
      days: { ...(L.days || {}) },
      noticed: (L.noticed || []).concat(extraNoticed).slice(-500),
      lastKind: pick.fact.kind,
    };
    const a = `${pick.fact.kind}/${pick.angleId}`;
    next.managers[pick.fact.manager] = (next.managers[pick.fact.manager] || 0) + 1;
    next.angles[a] = (next.angles[a] || 0) + 1;
    next.kinds[pick.fact.kind] = (next.kinds[pick.fact.kind] || 0) + 1;
    next.days[day] = (next.days[day] || 0) + 1;
    return next;
  });
}

async function main() {
  // Off switch that needs no deploy and no code change: set repo variable CRANK_OFF to anything
  // and the next run says nothing. The last kill-switch lived in the source and meant the bot
  // stayed off for three weeks because turning it back on was a commit.
  if (process.env.CRANK_OFF && !DRY && !PLAN) { console.log("CRANK_OFF is set — nothing posts."); return; }
  const now = mt();
  const ledger = await readLedger();

  if (PLAN) {
    const base = await everything();
    const facts = base.concat(extras(base, now.day));
    const picks = choose(facts, ledger, PLAN);
    console.log(`${facts.length} facts available, ${picks.length} distinct posts planned:\n`);
    const seen = {};
    picks.forEach((p, i) => {
      const n = (seen[p.fact.kind] = (seen[p.fact.kind] || 0) + 1) - 1;
      const poll = p.fact.poll
        ? `\n    POLL → ${p.fact.poll.question}\n` + p.fact.poll.answers.map(a => `           ( ) ${a.text}`).join("\n")
        : "";
      console.log(`${String(i + 1).padStart(2)}. [${p.fact.kind}/${p.angleId}] → #${roomFor(p.fact.kind, n)[0]}\n    ${p.full.replace(/\n/g, "\n    ")}${poll}\n`);
    });
    return;
  }

  if (!FORCE) {
    if (now.hour < OPEN_HOUR || now.hour > CLOSE_HOUR) {
      console.log(`${now.hour}:00 Mountain — outside 9am–8pm. Nothing posts.`);
      return;
    }
    const done = (ledger.days || {})[now.day] || 0;
    const target = targetForDay(now.day);
    if (done >= target) {
      console.log(`${done}/${target} already posted today. Done.`);
      return;
    }
    // Spread what's left over the hours that are left, so the day fills naturally rather than
    // firing everything at 9am.
    const left = CLOSE_HOUR - now.hour + 1;
    const need = target - done;
    const chance = Math.min(1, need / Math.max(left, 1));
    if (Math.random() > chance) {
      console.log(`${done}/${target} today, ${left} hour(s) left — skipping this slot.`);
      return;
    }
  }

  // Acknowledge anybody who spoke since the bot last did, whether or not this run posts.
  let noticed = [];
  if (!DRY && ready()) noticed = await noticeReplies(ledger).catch(() => []);
  if (noticed.length) console.log(`noticed ${noticed.length} message(s) from members`);

  const base = await everything();
  const facts = base.concat(extras(base, now.day));
  const [pick] = choose(facts, ledger, 1);
  if (!pick) { console.log("Nothing fresh to say — every fact on the board has been used."); return; }

  const rooms = roomFor(pick.fact.kind, (ledger.kinds || {})[pick.fact.kind] || 0);
  if (DRY) {
    console.log(`→ #${rooms[0]}  [${pick.fact.kind}/${pick.angleId}]\n${pick.full}`);
    return;
  }
  if (!ready()) { console.error("No DISCORD_BOT_TOKEN — nothing posted."); process.exitCode = 1; return; }

  const chan = await findChannel(rooms);
  if (!chan) { console.error(`No channel matched ${rooms.join(", ")}`); process.exitCode = 1; return; }

  await say(chan.id, pick.full, pick.fact.poll ? { poll: pick.fact.poll } : {});
  await remember(pick, now.day, noticed);
  console.log(`posted to #${chan.name} [${pick.fact.kind}/${pick.angleId}]`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
