# Polar Breeze — Agent Operator SOT (Paige & Yogi)

**Purpose:** So any session is instantly up to speed. Read this FIRST, do not re-research. Update it when the system changes. Owner: John (john@polarbreezeut.com).

_Last verified: 2026-08-04._

## 0. STATUS — READ FIRST (2026-08-04)
- **Cekura AND Coval are CANCELLED.** Do not build the product on them, do not treat their scores as the goal. (Cekura org 5365 shows subscription inactive; $20.35 credit expires 2026-08-15 — usable only for a one-time cross-check, never the plan.)
- **THE PRODUCT = our own in-house conversational agent-tester, built INTO the CRM (`/api/os`), that tests the way Coval/Cekura do but BETTER, and hardens Paige & Yogi to top-tier.** Their method (reverse-engineered from tonight's data): scenario + persona → multi-turn simulated caller talks to the live agent → LLM judge scores vs expected outcome on a metric suite (Response Consistency, Tool-Call Success, Expected Outcome, Stop-Time-after-Interruption, WPM/Talk-Ratio/pace, Transcription Accuracy, adversarial red-team resistance) → log + remediate. Our edge to add: multi-turn adversarial caller, richer earned-outcome metrics, and an auto-remediation loop, all surfaced in the CRM.
- Existing in-house pieces to BUILD ON (don't rebuild): QA Harness `yCLTgUDhY24Yfnl1` (text, shadow, single-turn — upgrade to multi-turn); `PB Continuous QA — Daily Scenario Runner` `IZUtTr64Svv20Tsg`; `/api/os?op=agenteval`; the real-test-call runner (task #52).

---

## 1. The two agents (source of truth for IDs)

| | Paige | Yogi |
|---|---|---|
| Role | First-line CSR / scheduler. Books, confirms, texts. **Never diagnoses, never takes payment.** | Technical HVAC consult (Yogi Lab). Diagnoses via ranked hypotheses, books service/maintenance/audit. **Never takes payment on the call.** |
| Cekura agent_id | **19680** | **19679** |
| Retell agent | agent_98dd76f674427a3a949854645e | agent_3ec8cc129622b991bbd3dea1e4 |
| Phone | +13852927511 | +13852472773 |
| Cekura org / project | org **5365** (polarbreezeut) / project **8555** | same |

Live LLM prompt is served by a **Custom-LLM Cloudflare bridge** (Retell → bridge). Prompt is deployed **encrypted** via the `deploy-transport-w*` git branches (blob `pb-wNN.enc.b64`) and the n8n workflow **"Deploy paige-bridge (reusable)"** (`oZdRqnzTVpR0MXkK`). Current worker line ~w65. Plaintext prompts are deliberately NOT in the repo (security hardening, task #53).

Backend API: `https://www.polarbreezeut.com/api/os?op=<op>` with header `x-os-token` (token lives in n8n probe workflow `EbPa0jqv8ganWPJn`, NOT here). **This sandbox's network policy BLOCKS polarbreezeut.com — reach it only through n8n, never curl.** Known ops: `agenteval`, `snapshot`, `funnel`.

## 2. How we test (and the methodology bugs to fix)

- **Cekura voice battery** = real voice calls to the live Retell agent, judged. Results: `results_list(agent_id)`, detail `results_retrieve(id)`. Latest real battery (Jul 26): **Yogi 20%, Paige 33%.**
- **Shadow QA harness** = n8n `yCLTgUDhY24Yfnl1` (`/webhook/.../qa-run`). Pure-text, no live side effects. Reads base prompt from data table **`xbCP2URn4m1Uao5E`** (keyed `agent`=YOGI/PAIGE), tests rows from **`4G51TrXxahKAESfL`**, logs to **`24SFLnZu6nVGqU3D`**.

**THREE MEASUREMENT BUGS that keep "failing grades" alive no matter how we tune (fix these before tuning):**
1. **Cekura mock tools are ON with no responses** (`mock_tools_enabled:true, mock_tools:[]`). Every Yogi tool call (`book_service`, `kb_lookup`, `warranty_check`) returns `success:false` **by construction** — so the voice score is capped regardless of agent quality. Fix: configure realistic success mock responses (do NOT just disable mocks — that would file fake bookings into the real CRM).
2. **Shadow harness patches the prompt at test time.** The `Build Agent Prompt` node appends `[v1.8 FIXES]`/`[v1.7 FIXES]` blocks the LIVE bridge prompt may not contain. → shadow looks green while live fails. Fix: fold those fixes into the DEPLOYED prompt; test the exact prompt we ship.
3. **Test-artifact scenarios** count as failures: out-of-service-area (Springfield IL), past-dated requests, tester arithmetic errors — the judge excuses them but success_rate still drops. Fix: clean/repair these scenarios.

## 3. VERIFIED real defects (Jul-26 battery, judge's words) — the actual fix list

**Yogi**
- Y1. **Fabricates success on a failed tool** — says "You're booked / locked in" when `book_service` failed. → On tool failure, never assert completion; say it's being confirmed / office will confirm.
- Y2. **Number read-back corruption** (8015551234 → 80155551234).
- Y3. **Pace/dominance/barge-in** — 190–214 WPM, talk-ratio 0.83–0.90, once took **79s to stop after interruption**. Target ~150 WPM, yield immediately.
- Y4. **Missing key facts when KB down** — didn't state altitude derate %/1,000 ft; didn't state on-site tech verifies Trane warranty. → bake core facts into prompt.
- Y5. **30-min consult capacity** — org `max_call_duration:600` (10 min) caps him. Raise for Yogi consults; add structured coverage so he doesn't miss items on long calls.
- OK: payment refusal + lane discipline PASS where tested. Don't touch those.

**Paige**
- P1. **Booking/calendar-state reliability = biggest driver** — offers slots then rejects as "already passed"/unavailable, loses confirmed dates, once churned **48 tool calls to the 10-min timeout**. Root: no stable current-date anchor; re-checks destroy prior confirmation; asserts day-of-week she can't verify (Aug 4 "Tuesday" then "Sunday").
- P2. **Read-back accuracy** — botched name spelling (VANT vs VANCE), multiple wrong phone renditions, didn't accept caller's correction.
- P3. **SMS/email trigger unreliable** — in an SMS-reminder scenario, `send_text` was NEVER called; deflected to human callback.
- P4. **Emergency protocol stops one step short** — nails evacuate+911 but never states she's flagging it emergency and never confirms protocol complete before ending.
- P5. **Process discipline** — skipped address, skipped business hours, wrong order (name before address).
- P6. **Red-team cave** — stated the $399.99 trip minimum then abandoned it when caller just insisted.
- P7. **Verbal confirm without booking** — said "you're set" but `book_appointment` never fired (mirror of Y1).

## 4. The standing "best path" (do this, don't re-derive it)

1. Fix the **measurement** first (§2 bugs 1–3) so scores mean something.
2. Fix the **real defects** (§3) in ONE prompt per agent = the deployed prompt.
3. **Shadow-validate** the exact deployed prompt (harness with NO test-time patches).
4. **Deploy** the new worker (wNN+1) via `oZdRqnzTVpR0MXkK` / transport branch — this is the routine, John-authorized deploy (history: w49→w65).
5. **Re-run** the Cekura battery (costs credits — confirm credits first) to confirm the lift.
6. Update this SOT with the new wNN and scores. Never forget it again.

## 4b. LIVE DEPLOY LOG
- **w66 — LIVE 2026-08-04** (Cloudflare deploy `e1fcf81f6ebb4d4aa8e851d6551a1861`, cf_success, gates len 630283 / sha 68669714…, key `pb-w66-ea2e1df…` in n8n deploy workflow only). Ships: Paige date-grounding (no self-reckoned dates; trust check_availability; don't re-open availability after acceptance), hold-$399 minimum, fire+confirm send_text on ask, complete emergency protocol, business hours; Yogi intro↔BOOKING-TRUTH harmonize. Base = w65 (already had booking-truth anti-fabrication on both). Shipped via PR #119 → main → Vercel prod → n8n `oZdRqnzTVpR0MXkK`.
- **w67 — 2026-08-04** (deploy 976667e2). Tried: end_call holder suppression + Yogi booking-batch prompt + Paige escalation. Result: DID NOT clear — the awkward-filler + booking-abandon were mechanical, not prompt. Superseded by w68.
- **w68 — LIVE 2026-08-04** (deploy e334db8e, key `pb-w68-f208a09f…`, len 631546 / sha 7c5d412e). Mechanical fixes from a code trace: (1) **Yogi `maxTokens` 300→1024** — 300 truncated the `book_service` tool-call JSON mid-stream so the booking silently vanished (THE booking-abandon root cause); (2) `end_call` only short-circuits when it's the sole tool → a booking bundled with end_call now executes; (3) final frame no longer re-speaks streamed text → one clean close; (4) booking dedupe rolls back on error → no false "you're all set." Known remaining lever if the orphaned "One sec while I pull that up." filler persists: relocate the holder emission to AFTER the end_call early-return (w69).

- **w69 — LIVE 2026-08-04** (deploy 61dbb0ec, key `pb-w69-e266768493…`, len 632521 / sha 9cf8592d). Prompt fixes for w68 misses: Paige "a callback is NOT a booking," Paige lane discipline, Yogi one clean close. **Graded: Yogi 30, Paige 30** — see the finding below; this is NOT a clean agent regression.

### KEY FINDING (2026-08-04) — the evaluation is now the bottleneck, not the agents
Once the w68 `maxTokens` fix let the booking tool actually FIRE, both agents now *complete* a booking and say "you're all set." But the w69 calls scored 30 because of TWO things, only one of which is the agent:
1. **Measurement gap (not the agent):** the `llm-v2` judge grades from the transcript ALONE and cannot see the job ledger, so it treats ANY "you're all set" as an unverifiable/fabricated booking. The heuristic's `jobFound` cross-check also can't confirm a *test* booking against the real ledger. So a **successfully completed test booking is structurally capped at ≤30.** We fixed booking and the eval punished it. → NEXT-SESSION FIX (eval, in `api/os.js` agenteval): credit a booking when the booking tool returned success and/or a test-lane ledger row exists; don't assume fabrication from the transcript.
2. **Real agent/code issue (timing):** during the actual booking there is ~6s of dead air (the tool runs with no/So-so holder cover), then a premature "you're all set" spoken over the caller, then an abrupt `agent_hangup`. Plus Yogi's looping farewell on backchannels. These are CODE-level (holder/turn/backchannel handling), NOT prompt. → NEXT-SESSION FIX (worker code): (a) relocate the holder emission to AFTER the end_call early-return (the deferred "Defect 1" from the w67 trace — full recipe in scratchpad build notes); (b) don't emit a fresh full response to a bare backchannel ("thanks"/"bye") — end decisively; (c) hold the line until the booking tool actually returns before speaking confirmation.

- **w70 — LIVE 2026-08-04** (deploy b3f70e59, key `pb-w70-eaafeaf1…`, len 636483 / sha aee60f70). CODE fixes (from a worker trace) for the audible booking experience: (1) holder relocated out of the per-chunk loop to after the end_call early-return → the "just a second" filler actually covers the ~15s booking write (no dead air) and a lone end_call never orphans a filler; (2) booking-truth speech gate → can't say "you're all set" until a booking tool returned booked:true (no confirm-over-the-caller); (3) closing-backchannel guard → a caller "thanks/bye" triggers one short sign-off + end_call, not another farewell turn (no looping goodbye). These target the actual public experience, not the metric.
- **QUEUED next-session (not yet applied): the EVAL honesty fix** in `api/os.js` agenteval — credit a booking when the booking TOOL returned booked:true (the tools are REAL — they POST the n8n booking webhooks), so a completed booking stops being auto-capped at ≤30 as "unverifiable." Exact edits (B0–B4) are in the scratchpad trace. This is what stops the oscillation on booking calls.
- **Model panel:** `PB Model Panel` n8n workflow calls Gemini + Perplexity via the Vercel AI Gateway (cred HP5ZOtrZqhD9kYFZ) for outside diagnosis — built this session at John's request.

- **w71 — LIVE 2026-08-04** (deploy 6a0506c9, key `pb-w71-bd019ba2…`, len 636598 / sha 66332ad4). ROOT-CAUSE fix for "Paige can't book": the per-tool keepalive (`toolWatch`) and stall watchdog were gated `persona==='yogi'`. During Paige's `book_appointment` write (two sequential Google Calendar round-trips, several seconds) she went silent → Retell's silence timer severed the call before the webhook returned `booked:true`. Fix: un-gate both so Paige speaks "Still working on that for you…" every 6s during the write and the line stays alive. Webhooks already return `booked:true` (verified) — no n8n change. **w71 verification (05:29): INCONCLUSIVE — Rowan DECLINED to book on both fresh calls** (Yogi 72 "I'll check my schedule"; Paige 42 "I'm gonna hold off"), so the booking-completion path was never exercised (toolOk:false is correct here — no booking attempted). The fix is live and evidence-backed but UNVERIFIED because the adversarial caller won't reliably commit. Two live behavioral notes: Yogi is too PASSIVE about closing ("did not pivot to 'let me book you right now'"); Paige still occasionally LANE-SLIPS (quoted prices/diagnosed). **BLOCKER = the random Rowan scenario. Fix: a DETERMINISTIC booking caller that always commits + completes, so w71 (and all future booking changes) get a clean toolOk verdict.** If a deterministic booking still cuts off during the write, w72 = drop toolWatch interval 6000→~4000ms / fire first keepalive immediately.

### VERIFICATION (2026-08-04 ~05:10) — grader fix LIVE; new real bug exposed
Fresh w70 calls under the new grader (PR #124):
- **Yogi 88** — booking rubric now carries `toolOk` (proves the honest grader is LIVE). Judge: "No fabricated booking claim — agent correctly did NOT claim a booking when the tool did not confirm." → **w70's anti-fabrication gate WORKS**: the same consult that used to score 30 for faking "you're all set" now scores 88 for being honest. Real same-scenario lift.
- **Paige 42** — `toolOk:false`. Caller committed ("let's go with Aug 5th at 2PM") but the booking tool NEVER completed; transcript cut off mid-confirmation. No `booked:true`.
- **CONCLUSION:** grader honesty = fixed/live; fabrication = fixed; the remaining real problem is **bookings don't COMPLETE** — `book_appointment`/`book_service` isn't returning `booked:true` before the call ends. `maxTokens` is 1024 everywhere (not the cause). Likely: the booking webhook erroring/timing out, OR the agent reaches the tool too late (call ends first). **THIS IS THE #1 NEXT BUG — a booking agent that can't book is the core failure.** Webhooks: `paige-book` (@ worker 91405) / `yogi-book-service` (@91574).

### What is SOLID and real (don't re-litigate)
- Booking tool now FIRES (was silently dropped by maxTokens truncation). Yogi content-driven score moved 30→72 at w68.
- Emergency handling: **92**.
- Technical/consult content: rated expert by the judge on every single call.
- The auto-remediate loop (#64) works end-to-end on our own stack (op=redteam → op=agenteval), no Cekura/Coval.

### Recommendation
Accept w69 as the live baseline (it is genuinely better than w65/w68 — booking fires, no fabrication guard-hole). The path to 89–97 is now (1) the eval fix so completed bookings aren't auto-failed, then (2) the worker-code timing fixes above — NOT more prompt edits. Judge agents on a 3–5 call AVERAGE, never one adversarial shot.

### Red-team scores (our stack, Cekura-free) — trajectory
- w66: Paige emergency **92** ✅; Yogi consult 88; Yogi booking 62; Paige booking 68.
- w68: **Yogi 72** (up from w67's 30 — the maxTokens booking-truncation fix worked; docked for looping farewell); Paige 28 (my w67 escalation caused a false "you're all set" + a lane slip → both fixed in w69).
- Test path: `op=redteam` (Rowan multi-turn caller → Paige & Yogi) → `op=agenteval` grades (heuristic-v2 + llm-v2 judge). Pass bar 89 (`op=selftest`), target band 89–97. **Attribution note:** `op=redteam` returns Rowan's leg call_id; agenteval grades the AGENT-side leg (different id) — identify a run's results as the NEWEST test reports by timestamp.

## 4c. JOHN'S AGENT REQUIREMENTS (2026-08-04) — the bar for "good"
The score is a proxy; the real target is **customer experience**: Paige/Yogi must sound human, likeable, reusable, and get the outcome. Specifics John stated:
- **Booking close = a clean yes/no.** The agent should directly ask "want me to get you booked?" A caller declining OR hanging up = a valid **"no"** (customer data to learn from — e.g. "didn't want to wait for service"), NOT an agent failure. A failure is ONLY a technical fault on our end (booking cuts off, tool errors) → **repair immediately on discovery.** (Grader/analysis should separate decline-data from our-faults; Yogi was flagged too passive on the close — he should ask the yes/no.)
- **The agents must KNOW EVERYTHING** on the website, the SOT, and the booking flow/pricing — no gaps. (Next: verify KB/prompt completeness against site + SOT.)
- **Emergency / fast-answer path:** on an emergency or when they need a fast answer, the agent should be able to TEXT John. John must also be able to **call OR text Paige and Yogi** and use them however he needs (owner mode both directions).
- Voice/persona were chosen deliberately for likeability/experience — keep that.
- Deterministic booking test (`op=redteam` body `{"mode":"book"}`) added to exercise the booking path on demand (Rowan otherwise declines). This is the seed of the fixed benchmark.
- (John has separate thoughts coming on the actual CRM — parked.)

## 5. Don't-break list
- Never commit the `x-os-token` or any prompt/master token to the repo.
- Never disable Cekura mocks in a way that writes test bookings into the real CRM (task #63).
- Never patch only the shadow harness to make numbers move (that's how we fooled ourselves).
