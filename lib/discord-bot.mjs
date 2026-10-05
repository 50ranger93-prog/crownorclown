/**
 * Posting as the bot, and finding the room to post in.
 *
 * A webhook points at exactly one channel, so every new channel needs a new secret. The bot token
 * can reach any channel it can see, so a channel is resolved by name off the live guild list
 * instead — which also means a rename follows the channel, the way #introductions → #meet-the-crew
 * did without breaking anything.
 *
 * tools/pulse.mjs grew its own copy of this first and still has it. Anything new uses this.
 */

import { readFile } from "node:fs/promises";

const API = "https://discord.com/api/v10";
const GUILD = process.env.DISCORD_GUILD_ID || "1543364312028946432";
const TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const HEAD = { authorization: `Bot ${TOKEN}`, "content-type": "application/json", "user-agent": "CrownOrClownBot (crownorclown.com, 1.0)" };

export const ready = () => Boolean(TOKEN);

let cache = null;
async function channels() {
  if (cache) return cache;
  const r = await fetch(`${API}/guilds/${GUILD}/channels`, { headers: HEAD });
  if (!r.ok) return (cache = []);
  const all = await r.json().catch(() => []);
  return (cache = (Array.isArray(all) ? all : []).filter(c => c.type === 0));
}

/** First channel whose name contains one of the candidates, most specific first. */
export async function findChannel(candidates) {
  const list = await channels();
  for (const want of candidates) {
    const hit = list.find(c => (c.name || "").toLowerCase().includes(String(want).toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** The bot's own recent messages in a channel — used to avoid saying two things back to back. */
export async function recent(channelId, limit = 50) {
  if (!TOKEN || !channelId) return [];
  const r = await fetch(`${API}/channels/${channelId}/messages?limit=${limit}`, { headers: HEAD });
  if (!r.ok) return [];
  const msgs = await r.json().catch(() => []);
  return (Array.isArray(msgs) ? msgs : [])
    .filter(m => m && m.author && m.author.bot)
    .map(m => ({ content: String(m.content || "").trim(), ts: Date.parse(m.timestamp) || 0 }));
}

/**
 * Send it. Mentions are off by default and @everyone/@here can never be sent from here at all —
 * a scheduled thing that can ping a whole server is one bad loop away from being unbearable.
 */
/**
 * Attaching the picture rather than linking it.
 *
 * A link in the content renders the image but leaves the raw URL above it. An embed pointing at
 * the URL looked tidier but Discord has to go and fetch it through its own proxy, and when that
 * does not happen the message shows an empty coloured bar and nothing else — which is what
 * happened the first time the cannon fired. An uploaded file is the only version that is always
 * there the instant the message lands.
 */
async function withFile(url, body, filePath) {
  const bytes = await readFile(filePath);
  const name = filePath.split(/[\/]/).pop();
  body.attachments = [{ id: 0, filename: name }];
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify(body));
  fd.append("files[0]", new Blob([bytes], { type: "image/png" }), name);
  return fetch(url, { method: body._method || "POST", headers: { authorization: HEAD.authorization, "user-agent": HEAD["user-agent"] }, body: fd });
}

export async function say(channelId, content, { mentionUsers = [], poll = null, image = "", file = "" } = {}) {
  if (!TOKEN) throw new Error("no DISCORD_BOT_TOKEN");
  const body = {
    content: String(content).slice(0, 1900),
    allowed_mentions: { parse: [], users: mentionUsers.slice(0, 5) },
  };
  // A bare link in the content renders the picture AND leaves the raw URL sitting above it, which
  // looks like a mistake. An embed shows the image on its own.
  if (image) body.embeds = [{ image: { url: image }, color: 0xE24B4A }];
  // A poll is the cheapest thing in the world to answer — one tap, no typing, no opinion to
  // defend in front of thirty-five people. The members who will never write a message will
  // absolutely vote, which is the whole difference between posting at a room and hearing back.
  if (poll && poll.question && Array.isArray(poll.answers) && poll.answers.length >= 2) {
    body.poll = {
      question: { text: String(poll.question).slice(0, 300) },
      answers: poll.answers.slice(0, 10).map(a => ({
        poll_media: { text: String(a.text).slice(0, 55), ...(a.emoji ? { emoji: { name: a.emoji } } : {}) },
      })),
      duration: poll.hours || 24,
      allow_multiselect: false,
    };
  }
  let r = file
    ? await withFile(`${API}/channels/${channelId}/messages`, body, file)
    : await fetch(`${API}/channels/${channelId}/messages`, { method: "POST", headers: HEAD, body: JSON.stringify(body) });
  // A channel that won't take a poll should still get the question.
  if (!r.ok && body.poll) {
    delete body.poll;
    r = await fetch(`${API}/channels/${channelId}/messages`, { method: "POST", headers: HEAD, body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}`);
  return r.json().catch(() => ({}));
}

/** Put a reaction on a message — used to show somebody their answer was seen. */
export async function react(channelId, messageId, emoji) {
  if (!TOKEN) return false;
  const r = await fetch(`${API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    { method: "PUT", headers: HEAD });
  return r.ok;
}

/** Recent messages from everyone, not just the bot — for noticing who replied. */
export async function conversation(channelId, limit = 50) {
  if (!TOKEN || !channelId) return [];
  const r = await fetch(`${API}/channels/${channelId}/messages?limit=${limit}`, { headers: HEAD });
  if (!r.ok) return [];
  const msgs = await r.json().catch(() => []);
  return Array.isArray(msgs) ? msgs : [];
}

/** Edit one of the bot's own messages — used to tidy something already posted. */
export async function edit(channelId, messageId, content, { image = "", file = "" } = {}) {
  if (!TOKEN) throw new Error("no DISCORD_BOT_TOKEN");
  const body = { content: String(content).slice(0, 1900), allowed_mentions: { parse: [] }, embeds: [] };
  if (image && !file) body.embeds = [{ image: { url: image }, color: 0xE24B4A }];
  const url = `${API}/channels/${channelId}/messages/${messageId}`;
  const r = file
    ? await withFile(url, { ...body, _method: "PATCH" }, file)
    : await fetch(url, { method: "PATCH", headers: HEAD, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}`);
  return r.json().catch(() => ({}));
}
