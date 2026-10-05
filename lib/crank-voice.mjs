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
    `${f.player}: projected ${f.projected}, scored ${f.scored}.`,
    hook: () => `Anybody else own him?` },

  { id: "receipt", solo: true, line: f =>
    `${f.manager} started ${f.player} for ${f.scored}. The projection said ${f.projected}.`,
    hook: () => `Bad luck or bad call? One word.` },

  { id: "goose", line: f => f.scored <= 0
      ? `${f.player} finished on zero. Not low. Zero.`
      : `${f.player} managed ${f.scored}. Zero would at least have been a story.`,
    hook: () => `Beat that. Somebody must have.` },

  { id: "shortfall", line: f =>
    `${f.player} finished ${f.short} under. That's a starter's whole afternoon, gone.`,
    hook: () => `What do you do with ${f.short} more points this week?` },

  { id: "crowd", priority: 1, line: f => f.shared > 1
      ? `${f.shared} of you started ${f.player}. He scored ${f.scored}.`
      : null,
    hook: () => `Show of hands.` },

  { id: "arith", line: f =>
    `${f.player}: ${f.projected} expected, ${f.scored} actual.`,
    hook: () => `Still trusting projections, or going on feel now?` },

  { id: "position", line: f =>
    `${f.pos} watch — ${f.player}, ${f.scored}. Kickers beat that.`,
    hook: () => `${f.pos} problem, or him problem?` },

  { id: "percent", line: f =>
    `${f.player} returned ${pct(f.scored, f.projected)}% of his projection.`,
    hook: () => `Starting him next week? Yes or no.` },

  { id: "quiet-one", line: f =>
    `Quietest ${f.scored} points of the weekend: ${f.player}.`,
    hook: () => `Who was quieter?` },
];

// ── the points left on the bench ─────────────────────────────────────────────
// Always about the decision, never about the person. Everyone has done it.
export const BENCHED = [
  { id: "gap", solo: true, line: f =>
    `${f.manager} benched ${f.sat} (${f.satPts}) and started ${f.played} (${f.playedPts}).`,
    hook: () => `Worst you've ever left on the bench. Go.` },

  { id: "crowd", priority: 1, line: f => f.shared > 1
      ? `${f.sat} put up ${f.satPts} this week. ${f.shared} of you had him on the bench.`
      : null,
    hook: () => `Own up.` },

  { id: "coin", line: f =>
    `${f.pos} coin flip: ${f.played} ${f.playedPts}, ${f.sat} ${f.satPts}.`,
    hook: () => `Which way were you going?` },

  { id: "math", line: f =>
    `${f.sat} ${f.satPts}. ${f.played} ${f.playedPts}. Same roster, same ${f.pos} slot.`,
    hook: () => `Lineup set Saturday night or Sunday morning?` },

  { id: "left-behind", solo: true, line: f =>
    `${f.gap} points sat on ${f.manager}'s bench this week.`,
    hook: () => `Anybody leave more behind?` },
];

// ── the waiver wire ──────────────────────────────────────────────────────────
export const FAAB = [
  { id: "price", needs: ["player"], line: f =>
    `${f.manager} paid ${money(f.bid)} for ${f.player}${f.pts != null ? `. He scored ${f.pts}` : ""}.`,
    hook: f => f.pts != null && f.pts <= 3 ? `Worst money you've spent all year. Name it.` : `Good buy, or lucky?` },

  // Only ever on the bid that actually is the biggest. A superlative the data doesn't support is
  // the fastest way to stop being believed.
  { id: "bold", priority: 1, needs: ["player"], line: f => f.isTop
      ? `Biggest bid in ${f.league} so far: ${money(f.bid)} on ${f.player}.`
      : null,
    hook: () => `Who's sitting on budget waiting for somebody nobody's thought of?` },

  { id: "season-spend", line: f =>
    `${f.manager} is ${money(f.spentTotal)} into the budget for the season.`,
    hook: () => `Spend early or hold for the run?` },

  { id: "terse", needs: ["player"], line: f => f.pts != null
      ? `${f.player}. ${money(f.bid)}. ${f.pts} points.`
      : null,
    hook: () => `Verdict?` },

  { id: "share", needs: ["player"], line: f => f.spentTotal >= f.bid && f.bid >= 5
      ? `${f.manager} put ${money(f.bid)} on ${f.player} — ${Math.round((f.bid / Math.max(f.spentTotal, 1)) * 100)}% of everything they've spent all season.`
      : null,
    hook: () => `One big swing or lots of small ones?` },

  { id: "anonymous", needs: ["player"], line: f =>
    `Somebody in ${f.league} paid ${money(f.bid)} for ${f.player}.`,
    hook: () => `Worth it? Owner can stay quiet if they like.` },

  { id: "steal", priority: 1, needs: ["player"], line: f => f.pts != null && f.bid <= 3 && f.pts >= 12
      ? `${money(f.bid)} for ${f.player}, and he went for ${f.pts}. That's the whole game.`
      : null,
    hook: () => `Best dollar you've ever spent in this league?` },
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
    // A missing name renders as "$11 on ." — the sort of thing that reads as broken rather than
    // dry. A fact that can't fill its own sentence doesn't get that sentence.
    if (angle.needs) for (const k of angle.needs) if (!fact[k] && fact[k] !== 0) return null;
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
