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
import { ballot, tally, phase, CLOSES, VOTES_FILE, PRIZE } from "../../lib/cards-vote.mjs";

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

  // ?cards=1 — the ballot with message ids and owners, at any phase. Votes are stored by message
  // id, so without this there is no way to say whose card a vote was actually for.
  if (u.searchParams.get("cards") === "1") {
    const cards = await ballot();
    let votes = {};
    try { votes = (await readJSON(VOTES_FILE, {})).data || {}; } catch { /* unconfigured */ }
    const meta = new Set(["announced", "openedAnnounced"]);
    const count = {};
    for (const [k, v] of Object.entries(votes)) if (!meta.has(k) && v && v.card) count[v.card] = (count[v.card] || 0) + 1;
    return text(cards.map(c =>
      `${String(count[c.id] || 0).padStart(2)} vote(s)  ${c.at.slice(0, 10)}  ${c.id}  owner ${c.owner}  ${c.team || ""}`
    ).join("\n") + `\n\ntotal cast: ${Object.keys(votes).filter(k => !meta.has(k)).length}`);
  }

  // Voting opening is an event too, and it only happens once. Announcing it from the same endpoint
  // that announces the winner means one thing to schedule and one place where "has this already
  // been said" is answered, rather than a second job that can quietly not fire.
  if (phase() === "open") {
    const { data: v } = await readJSON(VOTES_FILE, {}).catch(() => ({ data: {} }));
    if (v && v.openedAnnounced && !dry) return text(`Opening already announced: ${v.openedAnnounced}`);
    const cards = await ballot();
    const open = [
      `**VOTING IS OPEN.** Card of the Year, ${cards.length} cards on the ballot, and **${PRIZE}** for the winner.`,
      "",
      "**How to vote — three taps:**",
      "**1.** Type `/vote` in any channel in here",
      "**2.** Tap **Open the ballot** in the private reply only you can see",
      "**3.** Tap **Vote** under the card you like",
      "",
      "One vote each. You cannot vote for your own card. You can change your pick any time until it closes.",
      "",
      // "Saturday 12:00 AM" is midnight at the END of Friday, and everybody reads it as Saturday
      // night. Name the night it actually ends on.
      `Closes **Friday night at midnight Mountain** — last chance is Friday 11:59 PM.`,
      "-# Winner gets the FAAB inside 24 hours of it closing.",
    ].join("\n");
    if (dry) return text(open + "\n\n--- would post to #announcements ---");
    const ch = await announcementsChannel();
    if (!ch) return text("Couldn't find #announcements — check the bot can see it.", 502);
    const r = await dapi(`/channels/${ch}/messages`, { method: "POST", body: JSON.stringify({ content: open, allowed_mentions: { parse: [] } }) });
    if (!r.ok) return text(`Discord said no (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
    const msg = await r.json().catch(() => ({}));
    await update(VOTES_FILE, {}, "Voting opened", x => ({ ...(x || {}), openedAnnounced: String(msg.id || "posted") })).catch(() => {});
    return text(`Opening posted to #announcements as ${msg.id}.

${open}`);
  }

  // A dry run works before the close too, and reports what the ballot reads. The bot needing
  // Read Message History in #meet-the-crew is the one thing that would silently produce an
  // empty ballot on the day, so it has to be checkable before the day.
  if (phase() !== "closed") {
    if (!dry) return text(`Voting is still ${phase()}. It closes ${new Date(CLOSES).toISOString()}.`, 409);
    const cards = await ballot();
    const lines = cards.map(c => `  ${c.at.slice(0, 10)}  owner ${c.owner}  ${c.team || "(no team in the text)"}`);
    return text(
      `Voting is ${phase()}; closes ${new Date(CLOSES).toISOString()}.\n` +
      `Ballot reads ${cards.length} card(s) out of the channel:\n` +
      (lines.join("\n") || "  (none — check the bot can read #meet-the-crew)") + "\n"
    );
  }

  const { data: votes } = await readJSON(VOTES_FILE, {});
  const already = votes && votes.announced;
  if (already && !dry) return text(`Already announced: message ${already}`);

  const cards = await ballot();
  const everyCard = tally(votes || {}, cards);            // all of them, zeroes included
  const ranked = everyCard.filter(c => c.votes > 0);
  const cast = Object.keys(votes || {}).filter(k => k !== "announced").length;
  if (!ranked.length) return text("Nobody voted, so there is nothing to announce.", 409);

  const top = ranked[0];
  const tied = ranked.filter(c => c.votes === top.votes);
  const runners = ranked.slice(tied.length, tied.length + 3);

  const head = tied.length > 1
    ? `**Card of the Year — a ${tied.length}-way tie.** ${tied.map(c => `<@${c.owner}>`).join(" and ")}, ${top.votes} votes each.

Both win it — **${PRIZE} each**, nothing split. Same as the Grammys do it.`
    : `**Card of the Year goes to <@${top.owner}>**${top.team ? ` — ${top.team}` : ""}, with ${top.votes} vote${top.votes === 1 ? "" : "s"}. That's **${PRIZE}**, posted within 24 hours.`;
  // Every card and every count, including the zeroes. The tally stays hidden while voting is open
  // so nobody bandwagons onto whoever is ahead, and then all of it goes up at once — if a result
  // is going to be argued about, the argument should start from the numbers everybody can see.
  void runners;
  const full = ranked
    .map(c => `\`${String(c.votes).padStart(2)}\`  <@${c.owner}>${c.team ? ` · ${c.team}` : ""}`)
    .join("\n");
  const content = `${head}\n\n**Every vote, in full:**\n${full}\n\n${cast} voted. Nobody could vote for their own card, and no count was visible to anyone until now.`;

  // One manager can own more than one card on the ballot — John owns two — and Discord rejects
  // the whole message if the same id appears twice in allowed_mentions.users. Dedupe, don't trim.
  const ping = [...new Set(ranked.map(c => c.owner))].slice(0, 6);

  if (dry) return text(content + `\n\n--- would post to #announcements ---\nalready announced: ${already || "no"}`);

  const ch = await announcementsChannel();
  if (!ch) return text("Couldn't find #announcements — check the bot can see it.", 502);
  // The winner gets a picture. A result that is just text reads like a scoreboard; this is the one
  // moment in the whole thing somebody actually won something.
  const art = await fetch(`${process.env.PUBLIC_URL || "https://www.crownorclown.com"}/cards/art/winner.png`)
    .then(z => (z.ok ? z.arrayBuffer() : null)).catch(() => null);
  let r;
  if (art) {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({
      content, allowed_mentions: { users: ping },
      attachments: [{ id: 0, filename: "winner" }],
    }));
    // The artwork came in as a JPEG with a .png name. Discord usually sniffs the bytes and
    // renders it anyway, but "usually" is not a thing to bet an announcement on — so the type
    // and the filename are taken from what the bytes actually are.
    const b = Buffer.from(art);
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const ext = isPng ? "png" : "jpg";
    fd.append("files[0]", new Blob([b], { type: isPng ? "image/png" : "image/jpeg" }), `winner.${ext}`);
    r = await fetch(`${D}/channels/${ch}/messages`, { method: "POST", headers: { authorization: "Bot " + BOT }, body: fd });
  } else {
    r = await dapi(`/channels/${ch}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, allowed_mentions: { users: ping } }),
    });
  }
  if (!r.ok) return text(`Discord said no (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`, 502);
  const msg = await r.json().catch(() => ({}));

  // Written after the post, so a failure here can never silence the announcement — at worst the
  // next call sees no mark and refuses only because Discord already has it.
  await update(VOTES_FILE, {}, "Card of the year announced",
    v => ({ ...(v || {}), announced: String(msg.id || "posted") })).catch(() => {});

  return text(`Posted to #announcements as ${msg.id}.\n\n${content}`);
}
