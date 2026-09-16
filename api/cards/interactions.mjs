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
  // card straight into our #introductions. Turning Public Bot off in the portal closes the
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
    const link = `${origin}/cards?cmd=${cmd}&t=${encodeURIComponent(t)}`;
    const label = cmd === "intro" ? "Build your card" : "Build your trade block";
    const where = cmd === "intro" ? "#introductions" : "#trade-block";
    return json({
      type: 4,
      data: {
        flags: 64,
        content: `Only you can see this. Build it, hit **Post it**, and it lands in ${where}. Link is good for 45 minutes.`,
        components: [{ type: 1, components: [{ type: 2, style: 5, label, url: link }] }]
      }
    });
  }
  return json({ type: 4, data: { flags: 64, content: "That command isn't set up." } });
}
export function GET() { return new Response("Crown or Clown interactions endpoint is up."); }
