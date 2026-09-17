import { readToken } from "../../lib/cards-token.mjs";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export async function POST(request) {
  let p;
  try { p = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const tok = readToken(p.t);
  if (!tok) return json({ error: "This link expired. Type the command in Discord again for a fresh one." }, 401);
  const hook = tok.c === "block" ? process.env.WEBHOOK_TRADE_BLOCK : process.env.WEBHOOK_INTRODUCTIONS;
  if (!hook) return json({ error: "The channel webhook isn't set up yet." }, 500);
  const m = /^data:image\/png;base64,(.+)$/.exec(p.png || "");
  if (!m) return json({ error: "Card image missing." }, 400);
  const png = Buffer.from(m[1], "base64");
  if (png.length > 7.5 * 1024 * 1024) return json({ error: "Card image is too big. Try a smaller photo." }, 413);
  const team = String(p.team || "").slice(0, 80);
  // Every card that lands recruits the next one. Cheaper than another announcement nobody reads,
  // and it shows up at the only moment anyone is actually looking at the channel.
  const content = tok.c === "block"
    ? `<@${tok.u}> is dealing${team ? ` for **${team}**` : ""}. DMs are open.\n-# Your turn — type \`/block\`, it already knows your roster.`
    : `New card in the pack. Welcome <@${tok.u}>${team ? ` of **${team}**` : ""}.\n-# Want yours? Type \`/intro\` — takes about a minute.`;
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({
    content, username: "Crown or Clown",
    allowed_mentions: { users: [tok.u] },
    attachments: [{ id: 0, filename: "card.png" }]
  }));
  fd.append("files[0]", new Blob([png], { type: "image/png" }), "card.png");
  const r = await fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", { method: "POST", body: fd });
  if (!r.ok) return json({ error: `Discord said no (${r.status}). Tell the commish.` }, 502);
  return json({ ok: true });
}
