import { createHash } from "node:crypto";
import { readToken } from "../../lib/cards-token.mjs";
import { keep } from "./archive.mjs";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const sha = b => createHash("sha256").update(b).digest("hex");

// What Discord actually kept. An attachment is stored byte for byte, so anything other than an
// identical hash means the card in the channel is not the card that was built — which is exactly
// what happened to Wyatt's, and nobody knew until he said so days later.
async function postedBytes(msg) {
  const a = msg && Array.isArray(msg.attachments) && msg.attachments[0];
  if (!a || !a.url) return null;
  const r = await fetch(a.url, { cache: "no-store" });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

// Put the original back on the message. A forum post is a thread and its id has to be named;
// a plain channel refuses that, so try it bare and fall back, the same way the post itself does.
async function replaceImage(base, msg, png) {
  const form = () => {
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ attachments: [{ id: 0, filename: "card.png" }] }));
    fd.append("files[0]", new Blob([png], { type: "image/png" }), "card.png");
    return fd;
  };
  const at = q => fetch(`${base}/messages/${msg.id}${q}`, { method: "PATCH", body: form() });
  let r = await at("");
  if (!r.ok && msg.channel_id) r = await at(`?thread_id=${msg.channel_id}`);
  return r.ok ? await r.json().catch(() => null) : null;
}

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

  // The check, every post: the image that was built is hashed, the image Discord actually kept
  // is pulled back down and hashed, and if the two differ the original goes straight back onto
  // the message — before anyone sees it, without anyone having to notice and complain.
  let msg = await r.clone().json().catch(() => ({}));
  let verified = "unchecked", corrected = false;
  try {
    const want = sha(png);
    let got = await postedBytes(msg);
    if (got && sha(got) !== want) {
      const fixed = await replaceImage(hook.split("?")[0], msg, png);
      corrected = true;
      if (fixed) msg = fixed;
      got = await postedBytes(msg);
    }
    verified = got ? (sha(got) === want ? "match" : "mismatch") : "unchecked";
  } catch { /* the card is in the channel either way; the check must never take it down */ }
  if (verified !== "match") console.error(`card #${p.mint} post check: ${verified}${corrected ? " (after a correction)" : ""}`);

  // Keep a copy of what went out — the image and the settings behind it — so correcting a card
  // later is a lookup instead of reading it back off a PNG in a channel. Best effort: a card
  // that posted must never be reported as failed because its copy didn't save.
  let archived = false;
  try {
    archived = await keep({ n: p.mint, messageId: msg && msg.id, png, state: p.state,
      traits: p.traits, check: { verified, corrected } });
  } catch { /* the card is already in the channel; the copy is a convenience */ }

  return json({ ok: true, archived, verified, corrected });
}
