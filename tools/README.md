# DraftKings reconciliation — weekly checklist

The league is scored on **ESPN** using **DraftKings scoring**. ESPN and DraftKings
both compute from the same official NFL stats, so they match the vast majority of
the time. `reconcile.mjs` finds the only two places they can ever diverge and
hands you a checklist.

## The two divergences (the whole job)

1. **D/ST points allowed** — ESPN's bracket splits at **21**, DraftKings' at **20**.
   A defense allowing **exactly 21** earns **+1 on ESPN, 0 on DraftKings** → adjust **−1**.
2. **Yardage bonus timing** — DraftKings pays **+3** at 100 rush / 100 rec / 300 pass.
   A late official stat correction can move a player across that line *after*
   DraftKings has locked → adjust **±3** to match DraftKings.

## When to run it

**After ESPN's official stat corrections are final** — ESPN's correction deadline
is the **Saturday following the game week**. Run it that Saturday/Sunday, before
the next week kicks off.

> ⚠️ **Do not adjust before ESPN settles.** If you apply a correction manually and
> ESPN then applies the same one automatically, the team gets **double-credited**.
> Wait until the numbers are final, then true up.

## How to run

```bash
node tools/reconcile.mjs --season 2026 --week 1
node tools/reconcile.mjs --week 1 --league 951407474   # just one league
node tools/reconcile.mjs --week 1 --json               # machine-readable
```

It prints, per league and team, every starter sitting on a bonus line and every
D/ST to eyeball for exactly-21. **It never changes a score.** You confirm each
flag against DraftKings, then enter the delta in
**ESPN → League Manager Tools → Adjust Scoring**.

## Validate it once before you trust it (Week 1)

The first real week, run the script and, for a handful of players, check its
yardage against the ESPN box score and against DraftKings by hand. Confirm the
bonus-line flags line up. Only after that eyeball should you lean on it for
payouts. (If ESPN ever changes its D/ST points-allowed stat id from `187`, the
D/ST auto-flag falls back to a manual "eyeball for 21" prompt — the report says
so, so you're never silently wrong.)

## DraftKings scoring reference (what "exact" means)

Passing: 0.04/yd · 4/TD · −1/INT · +3 at 300 yds ·
Rush/Rec: 0.1/yd · 1/reception (full PPR) · 6/TD · +3 at 100 yds ·
−1 fumble lost · 2-pt conversions 2 · return/recovery TD 6.
Kicking and D/ST per the sheet on the site. The only ESPN-vs-DK gaps are the two
above; everything else is DraftKings to the decimal.
