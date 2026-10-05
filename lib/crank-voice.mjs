/**
 * How the daily bot talks.
 *
 * The rules this was written to, in the order they matter:
 *
 *   1. Clean. No cursing, nothing sexual, nothing a kid reading over a shoulder couldn't read.
 *      Dry Bar, not a roast battle — the laugh comes from understatement and a real number, not
 *      from heat.
 *   2. Players are fair game. Managers get teased for decisions. Members are never attacked, never
 *      set against each other, and never told to go argue with somebody. A joke that would make a
 *      real person feel got-at in front of thirty-five others is not funny enough to be worth it.
 *   3. Every line is built out of a number that happened. That is what stops repetition: the
 *      numbers are never the same twice, so the sentences aren't either.
 *   4. Every post ends with something to answer. A room reads a joke and scrolls; it answers a
 *      question. The whole point is getting people talking, not performing at them.
 *
 * An angle takes a fact and returns { text, hook }. The hook is the invitation. Angles are keyed
 * so the ledger can see exactly which one was used, and a fact can only ever be used once anyway.
 */

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const money = n => `$${n}`;

// ── the players who didn't show ──────────────────────────────────────────────
// About the player's afternoon. The manager is mentioned the way weather is mentioned.
export const BUNK = [
  { id: "ledger", line: f =>
    `${f.player} was down for ${f.projected} and delivered ${f.scored}. That's ${pct(f.scored, f.projected)}% of the assignment.`,
    hook: () => `Anybody else own this man? Say so now, it's cheaper than saying it later.` },

  { id: "receipt", line: f =>
    `Receipt from ${f.league}: ${f.player}, projected ${f.projected}, final ${f.scored}. ${f.manager} started him in good faith.`,
    hook: () => `Was that bad luck or a bad start? One word.` },

  { id: "goose", line: f => f.scored <= 0
      ? `${f.player} finished with a zero. Not a low number — the number.`
      : `${f.player} managed ${f.scored}. A zero would have been a story; this was just quiet.`,
    hook: () => `Who had the worse afternoon than this? Prove it.` },

  { id: "shortfall", line: f =>
    `${f.player} came up ${f.short} short of his projection. That's a whole other starter's day, gone.`,
    hook: () => `What would you have done with ${f.short} more points this week?` },

  { id: "paid-for", line: f =>
    `Somewhere in ${f.league}, ${f.manager} spent a roster spot on ${f.scored} points from ${f.player}.`,
    hook: () => `Dropping him, or running it back? Genuinely asking.` },

  { id: "arith", line: f =>
    `${f.player}: ${f.projected} expected, ${f.scored} actual. The projection has filed a complaint.`,
    hook: () => `Do you still trust the projections, or are you going on feel now?` },

  { id: "quiet-part", line: f =>
    `Nobody wants to say it, so the robot will: ${f.player} did ${f.scored} on a ${f.projected} projection.`,
    hook: () => `Say the quiet part. Who's the next one to fall off?` },

  { id: "position", line: f =>
    `${f.pos} watch: ${f.player}, ${f.scored} points. There were kickers who beat that.`,
    hook: () => `Is this a ${f.pos} problem or a him problem?` },

  { id: "startable", line: f =>
    `${f.player} was a start-him-and-forget-him. The forgetting went fine.`,
    hook: () => `Who's on your roster you've stopped checking on?` },

  { id: "percent", line: f =>
    `${f.player} returned ${pct(f.scored, f.projected)}% of what he was projected. In most jobs that's a conversation.`,
    hook: () => `Bench him next week? Yes or no, no essays.` },
];

// ── the points left on the bench ─────────────────────────────────────────────
// Always about the decision, never about the person. Everyone has done it.
export const BENCHED = [
  { id: "gap", line: f =>
    `${f.manager} had ${f.sat} on the bench for ${f.satPts} and started ${f.played} for ${f.playedPts}. ${f.gap} points, sat down, watching.`,
    hook: () => `We've all done it. What's the worst one you've ever left on the bench?` },

  { id: "so-close", line: f =>
    `The right answer was on the roster. ${f.sat} put up ${f.satPts} from the bench in ${f.league}.`,
    hook: () => `Do you set and forget, or tinker until kickoff? There's a right answer and it's neither.` },

  { id: "coin", line: f =>
    `${f.pos} coin flip of the week: ${f.played} (${f.playedPts}) over ${f.sat} (${f.satPts}). The coin was not kind.`,
    hook: () => `Which way would you have gone? Be honest, it's already happened.` },

  { id: "owned-it", line: f =>
    `${f.gap} points on ${f.manager}'s bench this week. Nothing to fix — just something to carry.`,
    hook: () => `Anybody beat ${f.gap} left behind? There's no trophy, but there is attention.` },

  { id: "math", line: f =>
    `${f.sat} ${f.satPts}. ${f.played} ${f.playedPts}. Same roster, same ${f.pos} slot, same Sunday.`,
    hook: () => `Lineup decided Saturday night or Sunday morning? Settle it.` },
];

// ── the waiver wire ──────────────────────────────────────────────────────────
export const FAAB = [
  { id: "price", line: f =>
    `${f.manager} paid ${money(f.bid)} for ${f.player}${f.pts != null ? `, who scored ${f.pts}` : ""}.`,
    hook: f => f.pts != null && f.pts <= 3
      ? `Worst money you've spent all year — go on, name it.`
      : `Good buy or lucky buy? There's a difference and everyone knows it.` },

  { id: "per-point", line: f => f.pts > 0
      ? `${money(f.bid)} for ${f.player} worked out at about ${money(Math.round(f.bid / Math.max(f.pts, 0.1)))} a point.`
      : `${money(f.bid)} for ${f.player}, who scored ${f.pts}. The per-point maths refuses to run.`,
    hook: () => `What's the most you've ever paid for one good week?` },

  { id: "bold", line: f =>
    `Boldest bid in ${f.league}: ${money(f.bid)} on ${f.player}. Say what you want, that is a person with conviction.`,
    hook: () => `Who's holding budget for a player nobody's thought of yet?` },

  { id: "season-spend", line: f =>
    `${f.manager} is ${money(f.spentTotal)} deep into the budget for the season.`,
    hook: () => `Spend it early or hoard it for the playoff run? Pick a side.` },
];

export const TIGHTWAD = [
  { id: "untouched", line: f =>
    `${f.manager} has not spent a single dollar of waiver budget all season. Either a plan or a very long nap.`,
    hook: () => `What are you saving it for? Genuinely, tell us.` },

  { id: "pristine", line: f =>
    `There is a budget in ${f.league} that has never been opened. It belongs to ${f.manager}.`,
    hook: () => `Who do you grab if you finally spend it?` },
];

/**
 * The gentle stuff — being quiet, lurking, not using the place. Light, never pointed, never a
 * complaint. The joke is always "we'd like you here", and it has to still read that way to the
 * person it names.
 */
export const QUIET = [
  { id: "lurk", line: () =>
    `Some of you have been here long enough to know where everything is and have never said a word. That is genuine discipline.`,
    hook: () => `One word in the chat and the streak dies. No pressure.` },

  { id: "read-receipts", line: () =>
    `We know you're reading these. The little eyes at the bottom say so.`,
    hook: () => `React to this with anything at all and you're off the list.` },

  { id: "missing-out", line: () =>
    `A reminder that the funniest thing that happened this week happened in here, and some of you missed it.`,
    hook: () => `Scroll up. Then say something. That's the whole ask.` },

  { id: "could-be-better", line: () =>
    `This channel could be better. Not broken — better. There's a difference and it's about four messages wide.`,
    hook: () => `What would actually make you post in here? Say it and it'll get built.` },
];

/** The surprises. Rare, unannounced, and never the same shape twice in a row. */
export const SURPRISE = [
  { id: "award", line: f =>
    `Handing out a small, meaningless award: **${f.manager}**, for ${f.reason}. No prize. Just noted.`,
    hook: () => `Who deserves next week's? Nominations open.` },

  { id: "shouldnt-be-true", line: f =>
    `A stat that shouldn't be true: ${f.stat}`,
    hook: () => `Explain that one. Anybody.` },

  { id: "quiet-praise", line: f =>
    `No joke today: ${f.manager} has quietly been doing this properly all season.`,
    hook: () => `Credit where it's due — who else has been better than you expected?` },
];

export const ANGLES = { bunk: BUNK, benched: BENCHED, faab: FAAB, tightwad: TIGHTWAD, quiet: QUIET, surprise: SURPRISE };

/** Render a fact with one angle. Returns null if the angle can't speak to this fact. */
export function render(fact, angle) {
  try {
    const text = angle.line(fact);
    if (!text || typeof text !== "string") return null;
    const hook = typeof angle.hook === "function" ? angle.hook(fact) : angle.hook;
    return { text: text.trim(), hook: (hook || "").trim(), angleId: angle.id };
  } catch { return null; }
}

/**
 * The guard rails, checked on the finished text rather than trusted to the writing. Anything that
 * trips these never leaves the process — a bad line costs more than a missed post.
 */
const BANNED = [
  /\b(damn|hell|crap|sucks?|stupid|idiot|moron|pathetic|loser|trash|garbage)\b/i,
  /\b(sex|sexy|nude|naked|drunk|beer|booze|bet|betting|odds|wager|gambl)/i,
  /@(everyone|here)\b/i,
  /\b(fight|beef|call .*out|go at|shut up)\b/i,
];
export function clean(text) {
  if (!text) return false;
  return !BANNED.some(re => re.test(text));
}
