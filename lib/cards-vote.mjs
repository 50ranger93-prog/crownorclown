/**
 * Card of the year — the ballot and the rules.
 *
 * The ballot is not a list somebody maintains. It is whatever cards are actually sitting in
 * #meet-the-crew: every card the bot has posted there, with the member it was posted for. That
 * was the instruction — "all of them posted in the discord" — and it means a card can never be
 * left off a ballot by an archive that failed, which has already happened once.
 *
 * Three rules, and they are enforced on the server, not in the page:
 *   - one vote each
 *   - you cannot vote for your own card
 *   - only inside the window
 *
 * A vote can be changed until voting closes; the last one is the one that counts. Votes are
 * stored by voter id, so changing one overwrites it rather than adding to it — one row per
 * person is what makes "one vote each" true no matter what the page does.
 */

const BOT = process.env.DISCORD_BOT_TOKEN || "";
const D = "https://discord.com/api/v10";

// Mountain time, which is the clock the league runs on. Opens at the top of the 15th and runs
// 48 hours. Stored as UTC so no server's own timezone can move it.
export const OPENS = Date.parse("2026-10-15T06:00:00Z");
export const CLOSES = Date.parse("2026-10-17T06:00:00Z");
export const VOTES_FILE = "votes.json";
// The prize, named once so the ballot, the bot's reply and the announcement can't drift apart.
export const PRIZE = "25 bonus FAAB";

export const phase = (now = Date.now()) => now < OPENS ? "before" : now < CLOSES ? "open" : "closed";

const dapi = (path, opts = {}) => fetch(D + path, {
  ...opts,
  headers: { authorization: "Bot " + BOT, "content-type": "application/json", ...(opts.headers || {}) },
});

/**
 * Which channel the cards are in. Rather than keep a channel id in a second place where it can
 * drift, ask the webhook that posts them — a webhook knows its own channel, and that is the
 * same webhook the card builder uses, so the two can never disagree.
 */
let channelId = null;
export async function cardsChannel() {
  if (channelId) return channelId;
  const hook = process.env.WEBHOOK_INTRODUCTIONS || "";
  if (!hook) return null;
  const r = await fetch(hook.split("?")[0]);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return (channelId = (j && j.channel_id) || null);
}

/**
 * Every card in the channel, newest first. A card post is a message from the app that carries
 * a PNG and mentions the member it belongs to — that mention is the owner, and it is what the
 * self-vote rule is checked against.
 */
export async function ballot() {
  const ch = await cardsChannel();
  if (!ch || !BOT) return [];
  const out = [];
  let before = "";
  for (let page = 0; page < 4; page++) {
    const r = await dapi(`/channels/${ch}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!r.ok) break;
    const msgs = await r.json().catch(() => []);
    if (!Array.isArray(msgs) || !msgs.length) break;
    for (const m of msgs) {
      const png = (m.attachments || []).find(a => /\.png$/i.test(a.filename || ""));
      if (!png) continue;
      const owner = (m.mentions && m.mentions[0] && m.mentions[0].id) || mentionIn(m.content);
      if (!owner) continue;
      out.push({
        id: m.id,
        owner,
        image: png.url,
        width: png.width || 0,
        height: png.height || 0,
        team: teamIn(m.content),
        at: m.timestamp || "",
      });
    }
    before = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
  }
  // Oldest first, so the numbers people already know run in the order they were minted.
  return out.reverse();
}

const mentionIn = s => (/<@!?(\d{5,})>/.exec(String(s || "")) || [])[1] || "";
const teamIn = s => {
  const m = /\*\*(.+?)\*\*/.exec(String(s || ""));
  return m ? m[1].slice(0, 80) : "";
};

/** What a voter is allowed to do right now, and why not when they aren't. */
export function check({ voter, card, cards, now = Date.now() }) {
  const p = phase(now);
  if (p === "before") return { ok: false, why: "Voting opens on the 15th." };
  if (p === "closed") return { ok: false, why: "Voting is closed." };
  const pick = cards.find(c => c.id === card);
  if (!pick) return { ok: false, why: "That card isn't on the ballot." };
  if (pick.owner === voter) return { ok: false, why: "You can't vote for your own card." };
  return { ok: true, pick };
}

/** Tally, highest first. Votes for a card that has since been deleted are dropped. */
export function tally(votes, cards) {
  const live = new Set(cards.map(c => c.id));
  const n = {};
  for (const v of Object.values(votes || {})) {
    if (v && live.has(v.card)) n[v.card] = (n[v.card] || 0) + 1;
  }
  return cards
    .map(c => ({ ...c, votes: n[c.id] || 0 }))
    .sort((a, b) => b.votes - a.votes || a.at.localeCompare(b.at));
}
