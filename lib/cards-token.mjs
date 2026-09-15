import crypto from "node:crypto";
const secret = () => process.env.LINK_SECRET || process.env.DISCORD_BOT_TOKEN || "";
const b64 = b => Buffer.from(b).toString("base64url");
export function makeToken(data, minutes = 45) {
  const body = b64(JSON.stringify({ ...data, e: Date.now() + minutes * 60000 }));
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + sig;
}
export function readToken(t) {
  if (!t || !secret()) return null;
  const [body, sig] = String(t).split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const d = JSON.parse(Buffer.from(body, "base64url").toString());
  return d.e > Date.now() ? d : null;
}
