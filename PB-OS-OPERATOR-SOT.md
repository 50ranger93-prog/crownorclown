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

## 5. Don't-break list
- Never commit the `x-os-token` or any prompt/master token to the repo.
- Never disable Cekura mocks in a way that writes test bookings into the real CRM (task #63).
- Never patch only the shadow harness to make numbers move (that's how we fooled ourselves).
