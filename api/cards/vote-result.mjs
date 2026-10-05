/**
 * Announce card of the year, once.
 *
 *   GET /api/cards/vote-result?key=<app public key>          post it if voting has closed
 *   GET /api/cards/vote-result?key=...&dry=1                 show what it would say
 *
 * Gated on the app's public key, the same way /api/cards/repair and /api/cards/register are —
 * it posts to a channel 36 people read, so it is not left open to the internet.
 *
 * Idempotent on purpose. A cron that fires late, twice, or by hand must not announce a winner
 * twice: the posted message id is written into votes.json under `announced`, and a second call
 * returns that instead of posting again.
 */

import { readJSON, update, configured } from "../../lib/board-data.mjs";
import { ballot, tally, phase, CLOSES, VOTES_FILE } from "../../lib/cards-vote.mjs";

const BOT = process.env.DISCORD_BOT_TOKEN || "";
const GUILD = process.env.DISCORD_GUILD_ID || "1543364312028946432";
const D = "https://discord.com/api/v10";
const text = (s, code = 200) => new Response(s, { status: code, headers: { "content-type": "text/plain; charset=utf-8" } });

const dapi = (path, opts = {}) => fetch(D + path, {
  ...opts,
  headers: { authorization: "Bot " + BOT, "content-type": "application/json", ...(opts.headers || {}) },
});

// Find the room by name rather than pinning another channel id in another file — the id is
// already in Discord and a rename follows the channel, as #introductions → #meet-the-crew showed.
async function announcementsChannel() {
  const r = await dapi(`/guilds/${GUILD}/channels`);
  if (!r.ok) return null;
  const list = await r.json().catch(() => []);
  const want = (Array.isArray(list) ? list : []).filter(c => c.type === 0 || c.type === 5);
  const hit = want.find(c => c.name === "announcements") || want.find(c => /announce/i.test(c.name || ""));
  return hit ? hit.id : null;
}

export async function GET(request) {
  const u = new URL(request.url);
  const want = process.env.DISCORD_PUBLIC_KEY || "";
  if (!want || u.searchParams.get("key") !== want) return new Response("Not open.", { status: 404 });
  if (!BOT) return text("No DISCORD_BOT_TOKEN in Vercel.", 500);
  if (!configured()) return text("Board storage isn't configured, so there are no votes to read.", 500);

  const dry = u.searchParams.get("dry") === "1";
  if (phase() !== "closed") return text(`Voting is still ${phase()}. It closes ${new Date(CLOSES).toISOString()}.`, 409);

  const { data: votes } = await readJSON(VOTES_FILE, {});
  const already = votes && votes.announced;
  if (already && !dry) return text(`Already announced: message ${already}`);

  const cards = await ballot();
  const ranked = tally(votes || {}, cards).filter(c => c.votes > 0);
  const cast = Object.keys(votes || {}).filter(k => k !== "announced").length;
  if (!ranked.length) return text("Nobody voted, so there is nothing to announce.", 409);

  const top = ranked[0];
  const tied = ranked.filter(c => c.votes === top.votes);
  const runners = ranked.slice(tied.length, tied.length + 3);

  const head = tied.length > 1
    ? `**Card of the Year — a ${tied.length}-way tie.** ${tied.map(c => `<@${c.owner}>`).join(" and ")}, ${top.votes} votes each.`
    : `**Card of the Year goes to <@${top.owner}>**${top.team ? ` — ${top.team}` : ""}, with ${top.votes} vote${top.votes === 1 ? "" : "s"}.`;
  const rest = runners.length
    ? "\n" + runners.map(c => `-# <@${c.owner}>${c.team ? ` · ${c.team}` : ""} — ${c.votes}`).join("\n")
    : "";
  const content = `${head}\n${cast} of you voted. Nobody could vote for their own.${rest}`;

  if (dry) return text(content + `\n\n--- would post to #announcements ---\nalready announced: ${already || "no"}`);

  const ch = await announcementsChannel();
  if (!ch) return text("Couldn't find #announcements — check the bot can see it.", 502);
  const r = await dapi(`/channels/${ch}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, allowed_mentions: { users: ranked.slice(0, 6).map(c => c.owner) } }),
  });
  if (!r.ok) return text(`Discord said no (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
  const msg = await r.json().catch(() => ({}));

  // Written after the post, so a failure here can never silence the announcement — at worst the
  // next call sees no mark and refuses only because Discord already has it.
  await update(VOTES_FILE, {}, "Card of the year announced",
    v => ({ ...(v || {}), announced: String(msg.id || "posted") })).catch(() => {});

  return text(`Posted to #announcements as ${msg.id}.\n\n${content}`);
}
