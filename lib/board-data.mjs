/**
 * The small JSON files that have to outlive a deploy — the mint ledger, the leaderboard, the
 * votes — live on the `board-data` branch and are written through the GitHub Contents API.
 * Deployments are switched off for that branch, so writing to it costs nothing and never
 * rebuilds the site.
 *
 * api/cards/mint.mjs and api/cards/archive.mjs each grew their own copy of this before it
 * existed. Anything new uses this one.
 *
 * `update` is the part that matters: read, change, write, and if somebody else wrote in the
 * gap, do it again on their version instead of flattening it. Two people voting in the same
 * second must not cost one of them a vote.
 */

const TOKEN  = process.env.GH_TOKEN || process.env.BOARD_TOKEN || "";
const OWNER  = process.env.BOARD_REPO_OWNER || process.env.VERCEL_GIT_REPO_OWNER || "";
const REPO   = process.env.BOARD_REPO       || process.env.VERCEL_GIT_REPO_SLUG  || "";
const BRANCH = process.env.BOARD_BRANCH     || "board-data";
const API    = "https://api.github.com";

export const configured = () => !!(TOKEN && OWNER && REPO);

const gh = (path, opts = {}) => fetch(API + path, {
  ...opts,
  headers: {
    authorization: "Bearer " + TOKEN,
    accept: "application/vnd.github+json",
    "user-agent": "crownorclown-board",
    "content-type": "application/json",
    ...(opts.headers || {}),
  },
});

/** Returns { data, sha }. A file that isn't there yet reads as `fallback`, sha null. */
export async function readJSON(file, fallback = null) {
  if (!configured()) throw new Error("board storage not configured");
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURI(file)}?ref=${encodeURIComponent(BRANCH)}`);
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error(`read ${file}: ${r.status}`);
  const j = await r.json();
  try {
    return { data: JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8")), sha: j.sha || null };
  } catch {
    throw new Error(`${file} is not readable JSON`);
  }
}

/** Returns false — not an error — when somebody else wrote first and the sha has moved on. */
export async function writeJSON(file, data, message, sha) {
  if (!configured()) throw new Error("board storage not configured");
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURI(file)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(data, null, 1) + "\n", "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (r.status === 409 || r.status === 422) return false;
  if (!r.ok) throw new Error(`write ${file}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return true;
}

/**
 * Read, hand the value to `change`, write the result. If someone else wrote in between, start
 * again from their version — never from the stale one. `change` may return null to mean
 * "nothing to do", and must not have side effects, since it can run more than once.
 */
export async function update(file, fallback, message, change, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const { data, sha } = await readJSON(file, fallback);
    const next = await change(data);
    if (next == null) return { ok: true, data, changed: false };
    const msg = typeof message === "function" ? message(next) : message;
    if (await writeJSON(file, next, msg, sha)) return { ok: true, data: next, changed: true };
    await new Promise(done => setTimeout(done, 120 * (i + 1)));
  }
  return { ok: false, data: null, changed: false };
}
