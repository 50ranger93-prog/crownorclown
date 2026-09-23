/**
 * Mint numbers.
 *
 *   POST /api/cards/mint   ->  { n: 7 }
 *
 * A card's number is the order it was made in. Not a seat, not a board position,
 * not out of anything — #1 is whoever built the first one and it keeps counting.
 * Somebody making five cards gets five numbers. That is what a mint number is.
 *
 * Stored exactly the way the leaderboard is: one JSON file on the board-data
 * branch of this repository, written through the GitHub Contents API. No
 * database, nothing rented, and every increment is a commit you can read.
 *
 * Numbers are handed out when a card reaches the preview, so the number can be
 * printed on the card before the image is made. Abandon the preview and that
 * number is spent — which is why the sequence can have gaps, and gaps are fine:
 * a mint number says when you turned up, not how many exist.
 */

const TOKEN  = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
const OWNER  = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO   = process.env.BOARD_REPO       || process.env.VERCEL_GIT_REPO_SLUG  || "";
const BRANCH = process.env.BOARD_BRANCH     || "board-data";
const FILE   = "mints.json";
const API    = "https://api.github.com";

const gh = (path, opts = {}) => fetch(API + path, {
  ...opts,
  headers: {
    authorization: "Bearer " + TOKEN,
    accept: "application/vnd.github+json",
    "user-agent": "crownorclown-mint",
    "content-type": "application/json",
    ...(opts.headers || {}),
  },
});

async function read() {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`);
  if (r.status === 404) return { next: 1, sha: null };
  if (!r.ok) throw new Error("read " + r.status);
  const j = await r.json();
  try {
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    const n = Number(parsed && parsed.next);
    // A corrupt or missing counter must never restart at 1 and hand out a number
    // somebody already has. Refusing is better than duplicating.
    if (!Number.isInteger(n) || n < 1) throw new Error("counter unreadable");
    return { next: n, sha: j.sha || null };
  } catch (e) {
    if (String(e.message) === "counter unreadable") throw e;
    throw new Error("counter unreadable");
  }
}

async function write(next, sha) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Mint #${next - 1}`,
      content: Buffer.from(JSON.stringify({ next, updated: new Date().toISOString() }, null, 1) + "\n", "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 409 || r.status === 422) return false;   // somebody minted first
  if (!r.ok) throw new Error("write " + r.status);
  return true;
}

export async function POST() {
  if (!TOKEN || !OWNER || !REPO) {
    // Not configured is not an error the card should die on — it just means no
    // number, and the card says so rather than printing a made-up one.
    return json({ configured: false, note: "Mint storage not configured." });
  }
  try {
    // Two people hitting preview together invalidates one sha; take turns.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { next, sha } = await read();
      if (await write(next + 1, sha)) return json({ configured: true, n: next });
    }
    return json({ configured: false, note: "Mint busy, try again." }, 503);
  } catch (e) {
    return json({ configured: false, note: String(e.message || e) }, 502);
  }
}

// A number must never be handed out by something that only meant to look.
export async function GET() {
  return new Response("Mint numbers are issued on POST.", { status: 405, headers: { allow: "POST" } });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
