# The card mint

Turns the league's own season into collectible cards — art plus metadata, one pair of files per
card. Zero dependencies, same as everything else in `tools/`.

```bash
node tools/mint.mjs                   # everything it can build
node tools/mint.mjs --week 1          # one NFL week's moments and players
node tools/mint.mjs --offline         # skip ESPN, build from weeks/<season>/ only
node tools/mint.test.mjs              # 33 tests, no network
```

Output lands in `cards/collection/` and is served at
[crownorclown.com/cards/collection/](https://www.crownorclown.com/cards/collection/).

## The five kinds

| Kind | Supply | Comes from |
|---|---|---|
| **Franchise** | one per team, per season | ESPN — record, points for and against, logo, manager |
| **Crown** | one per league, per week | the week's high score. That is the whole supply |
| **Clown** | one per league, per week | the week's low score |
| **Moment** | one per finished NFL game | `weeks/<season>/wkNN.json` — score, venue, weather, the line |
| **Player** | top 24 of the week | the DraftKings scores in that same archive |

Rarity is never rolled. A crown card is rare because exactly one team scored the most that week;
a moment is Legendary because the game was a tie or a double-digit dog won it; a player is
Legendary at 30+ DraftKings points. The reason is printed on the card and stored as a trait.

**A game still in progress gets no card.** A card minted off a live score is wrong the moment
somebody scores, and there is no taking it back once it is in a wallet.

## Token ids

An id has to mean the same card forever, or every card anyone saved starts pointing at something
else. So it is not a counter and not a hash — it is the card's identity written in decimal:

```
K SSSS WW L III      12026001003  →  a franchise card, 2026, League 1, slot 3
│ │    │  │ └── slot    which team / game / player, in a sorted order
│ │    │  └───── league 0 when the card isn't league-specific
│ │    └──────── week   0 for season-long cards
│ └───────────── season
└─────────────── kind   1 franchise · 2 crown · 3 clown · 4 moment · 5 player
```

Eleven digits: an exact integer in JavaScript, and a valid `uint256` with room to spare. Slots
come from a **sorted** order, not ESPN's response order, so re-running the mint never renumbers
anything. The mint refuses to write if two cards ever claim one id.

Re-running is therefore safe and is the normal case: a franchise card re-minted in week 9 shows
that week's record under the same id it had in week 1.

## Going on-chain, later

Nothing here touches a blockchain, needs a wallet, or costs anything. What it does is emit
metadata already in ERC-721 shape, so minting is an add-on rather than a rewrite:

1. Upload `cards/collection/img/` and `cards/collection/meta/` somewhere content-addressed.
2. Re-run with the new base so every image URI points at that upload:
   `node tools/mint.mjs --base ipfs://<CID>`
3. Deploy any standard ERC-721 whose `tokenURI(id)` returns `<base>/meta/<id>.json`.

The ids in `collection.json` **are** the on-chain ids — step 3 mints them as they already are.
`contract.json` is the collection-level metadata marketplaces read. `manifest.json` carries a
sha256 of every file, which is what lets you show later that the thing on-chain is the thing
that was minted here.

Worth knowing before you spend anything: putting these on a chain adds gas, a wallet to keep
safe, and a marketplace's rules. It does not make the cards better art or better proof — the
league already agrees on what happened, and git already timestamps it. Do it because minting is
fun, not because it secures anything.

## Notes

- **Logos are inlined.** Each card embeds its logo as a data URI, fetched once, so the file still
  draws correctly years after ESPN moves the image. Only the four hosts already allow-listed in
  `api/cards/img.mjs` are fetched, SVG logos are skipped (a second document inside the card,
  scripts and all), and anything over 400 KB is dropped. A logo that won't load falls back to
  initials rather than failing the card.
- **Team names are somebody else's text.** Everything drawn is XML-escaped and stripped of
  control characters on the way in; the tests include a team named after a `<script>` tag.
- **A league ESPN won't answer for is skipped, not fatal.** Half a collection beats a crashed
  run. `--offline` does this deliberately.
- **The order of `LEAGUES` in `mint.mjs` is load-bearing** — the index is part of every id in
  that league. Append, never reorder.
