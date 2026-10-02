/**
 * Replace the image on a card that already posted.
 *
 *   POST /api/cards/repair   { key, cmd, messageId, png }
 *
 * BOLTGNG_801 built card #007, the photo was in the preview, and the posted image came back with
 * a black panel where it should have been. The bug that caused it is fixed, but his card was
 * already in the channel — and the fix for an already-posted card cannot be "build it again".
 * A second card means a second mint number, a second post, and a number he did not earn twice.
 *
 * So this edits the message in place. Same post, same number, same spot in the channel; only the
 * attached image changes. The text is left alone by not sending it.
 *
 * A webhook can only edit messages it sent itself, which is the whole reason this lives on the
 * server: the webhook URL is a Vercel env var and never leaves it.
 *
 * The key is the app's own public key — readable only from the Discord developer portal, same
 * gate register.mjs uses. Nothing about this endpoint is guessable from the outside, and the
 * worst a caller with the key can do is change a picture on a card the bot already posted.
 */

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export async function POST(request) {
  let p;
  try { p = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  const want = process.env.DISCORD_PUBLIC_KEY || "";
  if (!want || p.key !== want) return new Response("Not open.", { status: 404 });

  const hook = p.cmd === "block" ? process.env.WEBHOOK_TRADE_BLOCK : process.env.WEBHOOK_INTRODUCTIONS;
  if (!hook) return json({ error: "That channel's webhook isn't set up." }, 500);

  const id = String(p.messageId || "");
  if (!/^\d{17,20}$/.test(id)) return json({ error: "messageId doesn't look like a Discord id." }, 400);

  const m = /^data:image\/png;base64,(.+)$/.exec(p.png || "");
  if (!m) return json({ error: "Card image missing." }, 400);
  const png = Buffer.from(m[1], "base64");
  if (png.length > 7.5 * 1024 * 1024) return json({ error: "Card image is too big." }, 413);

  // Sending `attachments` with one new file replaces what is on the message. `content` is left
  // out on purpose so the welcome line and the mention stay exactly as they were posted.
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ attachments: [{ id: 0, filename: "card.png" }] }));
  fd.append("files[0]", new Blob([png], { type: "image/png" }), "card.png");

  const base = hook.split("?")[0].replace(/\/+$/, "");
  const r = await fetch(`${base}/messages/${id}`, { method: "PATCH", body: fd });
  if (!r.ok) return json({ error: `Discord said no (${r.status}): ${(await r.text()).slice(0, 200)}` }, 502);
  return json({ ok: true, messageId: id });
}

export function GET() { return new Response("Repair is POST only.", { status: 405, headers: { allow: "POST" } }); }
