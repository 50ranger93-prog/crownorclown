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
  // A forum channel has no loose messages — every post is a thread, and a webhook has to name
  // the one it is creating or Discord refuses it. A plain text channel refuses the opposite.
  // Rather than keep a flag in sync with whatever the channel happens to be this month, ask for
  // a thread first and fall back once if the channel turns out not to want one. Costs an extra
  // round trip only on a text channel, and #trade-block can be flipped either way without a deploy.
  const names = Array.isArray(p.names) ? p.names.filter(n => typeof n === "string" && n.trim()).slice(0, 3).map(n => n.trim().slice(0, 40)) : [];
  const title = (tok.c === "block"
    ? (names.length ? `${team || "On the block"} — ${names.join(", ")}` : `${team || "Someone"} is dealing`)
    : `${team || "New card"}${names.length ? "" : ""}`).slice(0, 100);

  const send = withThread => {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({
      content, username: "Crown or Clown",
      allowed_mentions: { users: [tok.u] },
      attachments: [{ id: 0, filename: "card.png" }],
      ...(withThread ? { thread_name: title } : {})
    }));
    fd.append("files[0]", new Blob([png], { type: "image/png" }), "card.png");
    return fetch(hook + (hook.includes("?") ? "&" : "?") + "wait=true", { method: "POST", body: fd });
  };

  let r = await send(true);
  if (!r.ok) r = await send(false);
  if (!r.ok) return json({ error: `Discord said no (${r.status}). Tell the commish.` }, 502);
  return json({ ok: true });
}
