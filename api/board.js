// Go get it — the shared leaderboard, stored in this repo.
//
// The boards used to live in localStorage, which meant your phone and your laptop kept
// different scores and nobody could ever beat anybody. This keeps one board for everyone.
//
// There is no database and nothing to rent. The board is a single JSON file on its own
// branch of this repository, and the API reads and writes it through the GitHub Contents
// API. The branch is deliberately not the site: it carries a vercel.json that turns
// deployments off, and main's vercel.json turns them off for that branch too, so posting a
// score never triggers a build.
//
//   GET  /api/board   -> { configured, scores: [ … ] }
//   POST /api/board   -> { configured, scores: [ … ] }   body: one finished game
//
// A public write endpoint is a public write endpoint, so it is treated as hostile input:
// every field is rebuilt here from validated pieces rather than trusted from the browser,
// and points are clamped to the same 92 the game caps at. The thing that actually stops
// somebody hammering it is that a score which would not make the board is never written at
// all — junk comes back with the current top ten and leaves no commit behind.
//
// It is a leaderboard for a fantasy league, not a bank. Somebody determined can still post a
// score they did not earn. They cannot wipe it, store junk in it, or fill the repo with
// commits — and because every write IS a commit, anything that does go wrong is visible in
// the history and revertible in one click.

const TOKEN  = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
// Vercel sets the repo owner and slug itself, so the token is the only thing to configure.
const OWNER  = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO   = process.env.BOARD_REPO       || process.env.VERCEL_GIT_REPO_SLUG  || "";
const BRANCH = process.env.BOARD_BRANCH     || "board-data";
const FILE   = "board.json";

const KEEP = 10;          // how many the board shows
const MAX_PTS = 92;       // the game's own ceiling; anything above it did not happen
const MAX_YDS = 600;

const TEAM = /^[A-Z]{2,3}$/;
const API = "https://api.github.com";

function gh(path, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: {
      authorization: "Bearer " + TOKEN,
      accept: "application/vnd.github+json",
      "user-agent": "crownorclown-board",
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
}

// Everything stored is rebuilt from scratch out of validated pieces, so a field the browser
// invented cannot ride along into the board.
function clean(body) {
  const ini = String(body.i || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  if (!ini) return null;
  const p = clampNum(body.p, 0, MAX_PTS);
  const y = clampNum(body.y, 0, MAX_YDS);
  if (p === null || y === null) return null;
  const team = String(body.team || "").toUpperCase();
  const opp  = String(body.opp  || "").toUpperCase();
  const pf = clampNum(body.pf, 0, 99), pa = clampNum(body.pa, 0, 99);
  return {
    i: ini, p, y: Math.round(y),
    team: TEAM.test(team) ? team : "",
    opp:  TEAM.test(opp)  ? opp  : "",
    res: ["W", "L", "T"].includes(String(body.res)) ? String(body.res) : "T",
    pf: pf === null ? 0 : Math.round(pf),
    pa: pa === null ? 0 : Math.round(pa),
    ts: Date.now(),
  };
}

async function readBoard() {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`);
  if (r.status === 404) return { scores: [], sha: null };
  if (!r.ok) throw new Error("read " + r.status);
  const j = await r.json();
  let scores = [];
  try {
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    if (Array.isArray(parsed)) scores = parsed;
  } catch (e) { /* a corrupt file is an empty board, not a 500 */ }
  return { scores, sha: j.sha || null };
}

async function writeBoard(scores, sha, who) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Board: ${who}`,
      content: Buffer.from(JSON.stringify(scores, null, 1) + "\n", "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 409 || r.status === 422) return false;   // somebody else wrote first
  if (!r.ok) throw new Error("write " + r.status);
  return true;
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");

  if (!TOKEN || !OWNER || !REPO) {
    // Not an error the visitor caused, and not worth a scary status: the page only needs to
    // know the board is not shared yet so it can say so instead of pretending.
    res.status(200).json({ configured: false, scores: [], note: "Board storage not configured." });
    return;
  }

  try {
    if (req.method === "GET") {
      const { scores } = await readBoard();
      res.status(200).json({ configured: true, scores: scores.slice(0, KEEP) });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== "object") { res.status(400).json({ error: "Bad body" }); return; }

      const entry = clean(body);
      if (!entry) { res.status(400).json({ error: "Bad entry" }); return; }

      // Two goes, because a second player finishing at the same moment invalidates the sha.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { scores, sha } = await readBoard();

        // A score that would not make the board is not worth a commit. This is what keeps
        // somebody posting garbage in a loop from filling the repository with history.
        const sorted = scores.slice().sort((a, b) => b.p - a.p || b.y - a.y);
        if (sorted.length >= KEEP && entry.p <= Number(sorted[KEEP - 1].p)) {
          res.status(200).json({ configured: true, scores: sorted.slice(0, KEEP), stored: false });
          return;
        }

        sorted.push(entry);
        sorted.sort((a, b) => b.p - a.p || b.y - a.y);
        const next = sorted.slice(0, KEEP);

        if (await writeBoard(next, sha, `${entry.i} ${entry.p} (${entry.team || "?"})`)) {
          res.status(200).json({ configured: true, scores: next, stored: true });
          return;
        }
      }
      res.status(503).json({ configured: true, error: "Board busy, try again." });
      return;
    }

    res.setHeader("allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(200).json({ configured: false, scores: [], note: "Board store unreachable." });
  }
};
