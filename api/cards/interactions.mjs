import crypto from "node:crypto";
import { makeToken } from "../../lib/cards-token.mjs";

function verify(pubHex, sigHex, ts, body) {
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubHex, "hex").toString("base64url") }, format: "jwk" });
    return crypto.verify(null, Buffer.from(ts + body), key, Buffer.from(sigHex, "hex"));
  } catch { return false; }
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export async function POST(request) {
  const body = await request.text();
  const sig = request.headers.get("x-signature-ed25519") || "";
  const ts = request.headers.get("x-signature-timestamp") || "";
  if (!verify(process.env.DISCORD_PUBLIC_KEY || "", sig, ts, body)) {
    return new Response("bad signature", { status: 401 });
  }
  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 });

  // This app serves exactly one server. post.js writes to a fixed webhook no matter where the
  // command came from, so without this an install anywhere else would drop that stranger's
  // card straight into our #meet-the-crew. Turning Public Bot off in the portal closes the
  // same hole, but the whole defence should not rest on one toggle nobody will check again.
  const GUILD = process.env.DISCORD_GUILD_ID || "1543364312028946432";
  if (i.guild_id && i.guild_id !== GUILD) {
    return json({ type: 4, data: { flags: 64, content: "This one's only for The Expansion League." } });
  }

  if (i.type === 2) {
    const cmd = i.data?.name === "block" ? "block" : "intro";
    const user = i.member?.user || i.user || {};
    const name = user.global_name || user.username || "";
    const t = makeToken({ u: user.id, n: name, c: cmd });
    const origin = process.env.PUBLIC_URL || new URL(request.url).origin;
    // The trailing slash matters. Served at /cards the browser resolves a relative
    // URL against the site root, so /cards/treat.js was fetched as /treat.js and
    // 404ed. Absolute srcs fix today's case; the slash fixes the next one too.
    const link = `${origin}/cards/?cmd=${cmd}&t=${encodeURIComponent(t)}`;
    const label = cmd === "intro" ? "Build your card" : "Build your trade block";
    // Lead with what they get, not with the mechanics. The old copy opened by explaining the
    // privacy of a message they were already reading.
    const content = cmd === "intro"
      ? `Let's get you in the pack${name ? ", " + name.split(" ")[0] : ""}. Tap below, fill it out, hit **Post it** — your card drops in #meet-the-crew and that's it.\n-# Only you can see this. Link's good for 45 minutes.`
      : `Your roster's already loaded — just tap whoever you're shopping. Hit **Post it** and it lands in #trade-block where all 36 can see it.\n-# Only you can see this. Link's good for 45 minutes.`;
    return json({
      type: 4,
      data: {
        flags: 64,
        content,
        components: [{ type: 1, components: [{ type: 2, style: 5, label, url: link }] }]
      }
    });
  }
  return json({ type: 4, data: { flags: 64, content: "That command isn't set up." } });
}
export function GET() { return new Response("Crown or Clown interactions endpoint is up."); }
