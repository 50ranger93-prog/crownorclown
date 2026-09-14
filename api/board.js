// Go get it — the shared leaderboard.
//
// The boards used to live in localStorage, which meant your phone and your laptop kept
// different scores and nobody could ever beat anybody. This keeps one board for everyone.
//
// Storage is a Redis-over-HTTP store (Vercel KV, or Upstash from the Vercel marketplace —
// both set the same environment variables). Nothing here provisions it: if the variables are
// missing the endpoint says so plainly and the page falls back to the on-device board rather
// than pretending to be global.
//
//   GET  /api/board        -> { configured, scores: [ … ] }
//   POST /api/board        -> { configured, scores: [ … ] }   body: one run
//
// A public write endpoint is a public write endpoint, so it is treated as hostile input:
// every field is re-checked and clamped here rather than trusted from the browser, the score
// ceiling is the same 92 the game caps at, and one address only gets so many submissions an
// hour. It is a leaderboard for a fantasy league, not a bank — someone determined can still
// post a score they did not earn. It just cannot be used to wipe the board or store junk.

const URL_  = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const KEY = "coc:board:v1";
const KEEP = 10;          // how many the board shows
const MAX_PTS = 92;       // the game's own ceiling; anything above it did not happen
const MAX_YDS = 600;
const RATE_MAX = 30;      // submissions per address per hour

const TEAM = /^[A-Z]{2,3}$/;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("store " + r.status);
  const j = await r.json();
  return j.result;
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
}

// Everything that ends up stored is rebuilt from scratch out of validated pieces, so a field
// the browser invented cannot ride along into the board.
function clean(body) {
  const ini = String(body.i || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  if (!ini) return null;
  const p = clampNum(body.p, 0, MAX_PTS);
  const y = clampNum(body.y, 0, MAX_YDS);
  if (p === null || y === null) return null;
  const team = String(body.team || "").toUpperCase();
  const opp = String(body.opp || "").toUpperCase();
  const res = ["W", "L", "T"].includes(String(body.res)) ? String(body.res) : "T";
  const pf = clampNum(body.pf, 0, 99), pa = clampNum(body.pa, 0, 99);
  return {
    i: ini, p, y: Math.round(y),
    team: TEAM.test(team) ? team : "",
    opp: TEAM.test(opp) ? opp : "",
    res, pf: pf === null ? 0 : Math.round(pf), pa: pa === null ? 0 : Math.round(pa),
    ts: Date.now(),
  };
}

async function readBoard() {
  const raw = await redis(["GET", KEY]);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function ipOf(req) {
  const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return f || req.headers["x-real-ip"] || "anon";
}

module.exports = async (req, res) => {
  res.setHeader("cache-control", "no-store");

  if (!URL_ || !TOKEN) {
    // Not an error the visitor caused, and not worth a scary status: the page just needs to
    // know the board is not shared yet so it can say so.
    res.status(200).json({ configured: false, scores: [],
      note: "No KV store connected to this project yet." });
    return;
  }

  try {
    if (req.method === "GET") {
      res.status(200).json({ configured: true, scores: (await readBoard()).slice(0, KEEP) });
      return;
    }

    if (req.method === "POST") {
      const hits = await redis(["INCR", "coc:rl:" + ipOf(req)]);
      if (Number(hits) === 1) await redis(["EXPIRE", "coc:rl:" + ipOf(req), 3600]);
      if (Number(hits) > RATE_MAX) {
        res.status(429).json({ configured: true, error: "Too many submissions this hour." });
        return;
      }

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== "object") { res.status(400).json({ error: "Bad body" }); return; }

      const entry = clean(body);
      if (!entry) { res.status(400).json({ error: "Bad entry" }); return; }

      const board = await readBoard();
      board.push(entry);
      board.sort((a, b) => b.p - a.p || b.y - a.y);
      const next = board.slice(0, KEEP);
      await redis(["SET", KEY, JSON.stringify(next)]);

      res.status(200).json({ configured: true, scores: next });
      return;
    }

    res.setHeader("allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    res.status(200).json({ configured: false, scores: [], note: "Board store unreachable." });
  }
};
