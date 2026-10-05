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
export async function say(channelId, content, { mentionUsers = [] } = {}) {
  if (!TOKEN) throw new Error("no DISCORD_BOT_TOKEN");
  const r = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST", headers: HEAD,
    body: JSON.stringify({
      content: String(content).slice(0, 1900),
      allowed_mentions: { parse: [], users: mentionUsers.slice(0, 5) },
    }),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}`);
  return r.json().catch(() => ({}));
}
