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

/* ---- keeping people out of it ------------------------------------------------------------
   A leaderboard that accepts any POST is one line in a browser console away from being
   worthless. Two things close that, and neither asks an honest player for anything.

   A ticket. Picking a team asks the server for one: a timestamp signed with a key only the
   server has. A score is only accepted with a valid, unexpired, unused ticket that was issued
   at least forty seconds earlier — you cannot finish four possessions in five seconds, and
   you cannot mint your own. Tickets that land a score are remembered so the same one cannot
   be replayed.

   Arithmetic. The score has to be reachable from the rest of what was submitted. Team points
   have to decompose into actual touchdowns and field goals, and the DraftKings total cannot
   exceed what those yards, those catches and those scores could possibly have produced. "92
   points, no yards, lost nothing to nothing" stops being submittable.

   Straight about the limit: the ticket lives in the browser, so somebody determined enough to
   read their own network traffic can still play the game honestly and then submit a different
   number. Closing that last gap means simulating the game server-side, which is a much bigger
   build. This stops the console one-liner, the replay and the fabricated number.
--------------------------------------------------------------------------------------- */
const crypto = require("crypto");

// Long enough that a ticket cannot be requested and spent in the same breath, short enough
// that a real game never trips it. Forty seconds did: four possessions that stall on downs
// are over in well under that, and the score was refused and then quietly kept on the phone.
const TICKET_MIN_AGE = 8 * 1000;
const TICKET_MAX_AGE = 3 * 60 * 60 * 1000; // stale after three hours
const USED_KEEP = 200;

// Derived from the token rather than adding another variable to configure. It never leaves
// the server and is not the token itself.
function signingKey() {
  return crypto.createHash("sha256").update("coc-board-v1|" + TOKEN).digest();
}
function sign(ts) {
  return crypto.createHmac("sha256", signingKey()).update(String(ts)).digest("hex").slice(0, 32);
}
function issueTicket() {
  const ts = Date.now();
  return ts + "." + sign(ts);
}
function checkTicket(t) {
  const m = /^(\d{10,16})\.([a-f0-9]{32})$/.exec(String(t || ""));
  if (!m) return { ok: false, why: "no ticket" };
  const ts = Number(m[1]);
  const want = sign(ts);
  const got = m[2];
  // constant-time, so the signature cannot be guessed a character at a time
  if (want.length !== got.length ||
      !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) {
    return { ok: false, why: "bad ticket" };
  }
  const age = Date.now() - ts;
  if (age < TICKET_MIN_AGE) return { ok: false, why: "too quick" };
  if (age > TICKET_MAX_AGE) return { ok: false, why: "ticket expired" };
  return { ok: true, id: got.slice(0, 16) };
}

// The score has to be reachable from the rest of the submission. Team points decompose into
// touchdowns and field goals; everything the DraftKings total could have come from is bounded
// by the yards, a ceiling on receptions, and those scores.
const MAX_RECS = 40;          // four possessions is not fifty catches
function plausible(e) {
  let cap = -1;
  for (let td = 0; td * 7 <= e.pf; td++) {
    const rest = e.pf - td * 7;
    if (rest % 3) continue;                    // not reachable with touchdowns and threes
    const fg = rest / 3;
    const kick = td * 1 + fg * 5;              // extra points, and every kick a fifty-plus
    const here = e.y * 0.1 + MAX_RECS + td * 6 + kick + 6;   // +6 = both hundred-yard bonuses
    if (here > cap) cap = here;
  }
  if (cap < 0) return false;
  return e.p <= cap + 0.05;
}

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
  if (r.status === 404) return { scores: [], used: [], sha: null };
  if (!r.ok) throw new Error("read " + r.status);
  const j = await r.json();
  let scores = [], used = [];
  try {
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    // The file started life as a bare array of scores; both shapes still read.
    if (Array.isArray(parsed)) scores = parsed;
    else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.scores)) scores = parsed.scores;
      if (Array.isArray(parsed.used)) used = parsed.used;
    }
  } catch (e) { /* a corrupt file is an empty board, not a 500 */ }
  return { scores, used, sha: j.sha || null };
}

async function writeBoard(scores, used, sha, who) {
  const body = { scores, used: used.slice(-USED_KEEP) };
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Board: ${who}`,
      content: Buffer.from(JSON.stringify(body, null, 1) + "\n", "utf8").toString("base64"),
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
      // Starting a game asks for a ticket. It is only a signed clock reading — it says
      // nothing about who you are and carries no score.
      if ((req.query && String(req.query.ticket) === "1") || /[?&]ticket=1(&|$)/.test(req.url || "")) {
        res.status(200).json({ configured: true, ticket: issueTicket() });
        return;
      }
      const { scores } = await readBoard();
      res.status(200).json({ configured: true, scores: scores.slice(0, KEEP) });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== "object") { res.status(400).json({ error: "Bad body" }); return; }

      const tick = checkTicket(body.ticket);
      if (!tick.ok) { res.status(403).json({ error: "Play the game first.", why: tick.why }); return; }

      const entry = clean(body);
      if (!entry) { res.status(400).json({ error: "Bad entry" }); return; }
      if (!plausible(entry)) { res.status(422).json({ error: "That score does not add up." }); return; }

      // Two goes, because a second player finishing at the same moment invalidates the sha.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { scores, used, sha } = await readBoard();

        if (used.indexOf(tick.id) > -1) {
          res.status(409).json({ error: "That game has already been posted." });
          return;
        }

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

        if (await writeBoard(next, used.concat(tick.id), sha,
                             `${entry.i} ${entry.p} (${entry.team || "?"})`)) {
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
