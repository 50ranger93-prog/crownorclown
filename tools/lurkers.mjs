#!/usr/bin/env node
/**
 * Crown or Clown — the lurker instigator.
 *
 * A pile of these managers came in off Facebook lead ads. They don't know each other, some are
 * three time zones apart (one's in Sweden), and left alone they'll sit in the server reading and
 * never say a word. This finds the ones who joined but never did anything — no intro card, no
 * trade block — and needles them by name to go do it. Fights-to-friendship: the fastest way to
 * make a stranger a regular is to call them out in front of everyone.
 *
 * There is no member database anywhere in this project, and this doesn't add one. Discord itself
 * is the record: every intro/trade-block card the bot posts carries the poster's <@id>, so the
 * set of "people who've done something" is just the set of ids mentioned in those channels. We
 * diff that against the live guild roster and rib whoever's left.
 *
 * What it needs (both one-time, in the repo's Actions secrets / Discord portal):
 *   DISCORD_BOT_TOKEN     — the same bot token Vercel already uses to register commands
 *   Server Members Intent — toggle ON in the Discord developer portal (Bot tab), or the roster
 *                           read comes back 403. This is the only privileged thing it touches.
 *   PULSE_WEBHOOK_GENERAL — where the rib gets posted (the channel people actually watch)
 *
 * Channel discovery is automatic: it reads the guild's channel list and matches #meet-the-crew /
 * #introductions and #trade-block by name, so nobody has to paste channel IDs.
 *
 * Usage:
 *   node tools/lurkers.mjs --dry     # print who'd get ribbed and the message, post nothing
 *   node tools/lurkers.mjs           # post it for real
 *
 * No dependencies. Node 18+.
 */

const GUILD = process.env.DISCORD_GUILD_ID || "1543364312028946432";
const TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const HOOK = process.env.PULSE_WEBHOOK_GENERAL || "";
const API = "https://discord.com/api/v10";

const AVATARS = "https://www.crownorclown.com/img";
const DUECE = { username: "Duece", avatar_url: `${AVATARS}/duece.png` };

function arg(n) { const i = process.argv.indexOf("--" + n); if (i === -1) return null; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true; }
const DRY = !!arg("dry");

// How many people get pinged in one post. Ping all forty and it reads as spam and nobody feels
// singled out; name three or four and it's a callout. A rotating sample means nobody gets nagged
// with the same line two runs running.
const MAX_PING = 4;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One courteous retry on a 429. Discord hands back how long to wait; we wait it once and move on
// rather than hammering. Everything here is low-volume (one guild, a few dozen members) so this
// almost never fires.
async function dget(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(API + path, { headers: { Authorization: `Bot ${TOKEN}`, "user-agent": "CrownOrClownBot (crownorclown.com, 1.0)" } });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep(Math.min(5000, (Number(j.retry_after) || 1) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path} → rate limited`);
}

// Every human in the guild, keyed by id. Bots don't get ribbed. The members endpoint needs the
// Server Members Intent; without it Discord answers 403 and we say so plainly instead of posting
// a half-right callout.
async function roster() {
  const out = new Map();
  let after = "0";
  for (let page = 0; page < 20; page++) {   // 20 × 1000 = far more than this league will ever be
    const batch = await dget(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
    if (!batch.length) break;
    for (const m of batch) {
      const u = m.user; if (!u || u.bot) continue;
      out.set(u.id, { id: u.id, name: m.nick || u.global_name || u.username || "someone" });
    }
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return out;
}

// The set of user ids that have posted in a channel, read off Discord's own mentions[] rather
// than parsed out of text. A forum channel has no loose messages — each card is a thread whose
// starter message is the card — so those get walked thread by thread. A plain text channel is a
// straight message read. We don't know which kind #meet-the-crew is this month, so handle both.
async function postedIn(channel) {
  const ids = new Set();
  if (!channel) return ids;
  const take = (msgs) => { for (const msg of msgs || []) for (const u of msg.mentions || []) ids.add(u.id); };

  if (channel.type === 15) {   // GUILD_FORUM
    const threads = [];
    const active = await dget(`/guilds/${GUILD}/threads/active`).catch(() => ({ threads: [] }));
    for (const t of active.threads || []) if (t.parent_id === channel.id) threads.push(t);
    const arch = await dget(`/channels/${channel.id}/threads/archived/public?limit=100`).catch(() => ({ threads: [] }));
    for (const t of arch.threads || []) threads.push(t);
    for (const t of threads.slice(0, 100)) {
      // The starter message of a forum post shares the thread's id.
      const m = await dget(`/channels/${t.id}/messages/${t.id}`).catch(() => null);
      if (m) take([m]);
    }
    return ids;
  }

  // Text / announcement: a couple pages back is plenty for a young server.
  let before = "";
  for (let page = 0; page < 3; page++) {
    const msgs = await dget(`/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ""}`);
    take(msgs);
    if (!msgs.length || msgs.length < 100) break;
    before = msgs[msgs.length - 1].id;
  }
  return ids;
}

// Deduped rib pools, same pattern as the matchup lines: {who} is the @-mentions, {n} a count.
// Every line ends by telling them the exact command to type, because a callout with no door out
// is just heckling.
const fill = (t, m) => t.replace(/\{(\w+)\}/g, (_, k) => (m[k] != null ? String(m[k]) : ""));
const INTRO_RIBS = [
  `Caught you lurking, {who}. Everybody else posted a card — you've just been reading over our shoulders. Type \`/intro\`, 60 seconds, you're in the pack.`,
  `{who} — joined, read every message, said nothing. Bold. \`/intro\` and let's see who we're dealing with.`,
  `Roll call: {who} still hasn't shown a face. \`/intro\` or we start writing your backstory for you, and you will not like it.`,
  `{who}, the whole league introduced itself and you ghosted. Shy or plotting? \`/intro\` settles it.`,
  `We know you're in here, {who}. Reading doesn't count. \`/intro\` — one card, then you're one of us.`,
  `{who} has been a fly on the wall long enough. \`/intro\`. Say hi or we assume you're scared of us.`,
];
const BLOCK_RIBS = [
  `{who} did the intro and then went dead quiet on the trades. Nobody wins standing pat. \`/block\` — it already knows your roster.`,
  `Hey {who}, your trade block's emptier than your excuses. \`/block\`, put a name up, let's do business.`,
  `{who}, everybody's shopping but you. \`/block\` — tap a guy you'd move, see who bites.`,
];

const pickU = (used, arr) => { const fresh = arr.filter(t => !used.has(t)); const pool = fresh.length ? fresh : arr; const t = pool[(Math.random() * pool.length) | 0]; used.add(t); return t; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const mentions = (people) => people.map(p => `<@${p.id}>`).join(" ");

async function main() {
  if (!TOKEN) { console.log("No DISCORD_BOT_TOKEN set — instigator is idle. Add it as an Actions secret to turn this on."); return; }

  const chans = await dget(`/guilds/${GUILD}/channels`);
  const find = (rx) => chans.find(c => rx.test(c.name || ""));
  const introCh = find(/meet.*crew|introduc/i) || find(/\bintro\b/i);
  const blockCh = find(/trade.?block/i) || find(/\bblock\b/i);

  const [members, introd, blocked] = await Promise.all([
    roster(),
    postedIn(introCh),
    postedIn(blockCh),
  ]);

  if (!members.size) { console.log("Roster came back empty — check that Server Members Intent is on for the app."); return; }

  const noIntro = [];
  const noBlock = [];
  for (const m of members.values()) {
    if (!introd.has(m.id)) noIntro.push(m);
    else if (!blocked.has(m.id)) noBlock.push(m);
  }

  console.log(`Roster ${members.size} · introduced ${introd.size} · on the block ${blocked.size}`);
  console.log(`No intro: ${noIntro.length} · Intro but no block: ${noBlock.length}`);

  const used = new Set();
  const lines = [];

  // Intro is the front door — that's the priority. Rib a rotating handful.
  if (noIntro.length) {
    const pick = shuffle(noIntro.slice()).slice(0, MAX_PING);
    lines.push(fill(pickU(used, INTRO_RIBS), { who: mentions(pick), n: noIntro.length }));
  }
  // Only nudge trades if the intro front is quiet enough that a second line won't read as pile-on.
  if (noBlock.length && noIntro.length <= 2) {
    const pick = shuffle(noBlock.slice()).slice(0, MAX_PING);
    lines.push(fill(pickU(used, BLOCK_RIBS), { who: mentions(pick), n: noBlock.length }));
  }

  if (!lines.length) { console.log("Everybody's introduced and shopping — nobody to rib. Quiet run."); return; }

  const text = lines.join("\n\n");
  console.log(`\n(as ${DUECE.username})\n${text}`);

  if (DRY) return;
  if (!HOOK) { console.log("No PULSE_WEBHOOK_GENERAL set — not posted."); return; }

  // The whole point is the ping landing, so mentions are allowed here — but only the specific ids
  // we named, never @everyone/@here.
  const pinged = [...new Set([...text.matchAll(/<@(\d+)>/g)].map(x => x[1]))];
  const r = await fetch(HOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1900), username: DUECE.username, avatar_url: DUECE.avatar_url, allowed_mentions: { parse: [], users: pinged } }),
  });
  console.log(r.ok ? "  posted." : `  post failed: HTTP ${r.status}`);
}

main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
