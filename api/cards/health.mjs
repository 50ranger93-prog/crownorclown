/**
 * What the live site has, and whether the parts that write anything actually work.
 *
 * Listing environment variables only proves somebody typed something into Vercel. The board
 * token is a GitHub fine-grained personal access token, and those EXPIRE — when that happens
 * every write silently stops: no mint numbers, no card copies, no votes recorded. Nothing
 * announces it. So this asks GitHub whether the token still opens the door, rather than whether
 * a value is present.
 *
 *   /api/cards/health
 */

const TOKEN = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
const OWNER = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO = process.env.BOARD_REPO || process.env.VERCEL_GIT_REPO_SLUG || "";
const BRANCH = process.env.BOARD_BRANCH || "board-data";

async function board() {
  if (!TOKEN) return "MISSING  board token (GH_TOKEN) — no mint numbers, no card copies, no votes";
  if (!OWNER || !REPO) return "MISSING  board repo owner/name";
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/mints.json?ref=${encodeURIComponent(BRANCH)}`, {
      headers: { authorization: "Bearer " + TOKEN, accept: "application/vnd.github+json", "user-agent": "crownorclown-health" },
    });
    if (r.status === 401) return "EXPIRED  board token is rejected by GitHub — renew it in Vercel (GH_TOKEN)";
    if (r.status === 403) return "DENIED   board token has no access to this repo or branch";
    if (r.status === 404) return `MISSING  ${BRANCH} branch or mints.json not found`;
    if (!r.ok) return `FAILED   GitHub said ${r.status}`;
    return "OK       board token works — writes to board-data are live";
  } catch (e) {
    return `FAILED   couldn't reach GitHub: ${String(e.message || e).slice(0, 80)}`;
  }
}

export async function GET() {
  const need = ["DISCORD_APP_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID",
                "LINK_SECRET", "WEBHOOK_INTRODUCTIONS", "WEBHOOK_TRADE_BLOCK"];
  const lines = need.map(k => `${process.env[k] ? "OK     " : "MISSING"}  ${k}`);
  lines.push(await board());
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}
