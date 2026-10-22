# Forge Lab #5: Does a sharper trap card help frontier models where they actually fail?

**Pre-registered:** 21 Oct 2026, before any run. This file, `selection.json`, both arm texts in `prompts/` and
`analyze.mjs` are committed first; the git history is the timestamp. Results are published with the raw counts
**whatever they show**. Approved by Dinike on 21 Oct ("go with option 2 and 3 in November").
**Runs:** from 1 Nov 2026, inside November's budget.

## Question
[Lab #4](https://theagentforge.io/lab/4/results) found no measurable effect of the trap card on frontier models.
Two things limited it:
- it included pairs that rarely fell for traps without the card, so there was little room to improve;
- the card's checks were written from the small models' mistakes.

**On the Hard jobs where frontier models fall for traps most often, does a card written for their mistakes (v1.1)
reduce traps, and does it beat the original card (v1.0), without harm?**

## Arms (appended to the same harness system prompt, as custom instructions would be)
| Arm | Text | Purpose |
|---|---|---|
| A | None (harness prompt only) | Baseline |
| C | `prompts/C-card.txt`: trap card v1.0, the same frozen text as Labs #3 and #4 | The card as published |
| E | `prompts/E-card-v1.1.txt`: trap card v1.1 | The sharper card |

**How v1.1 was written:**
- It keeps v1.0's checks.
- It sharpens and adds checks for the trap families frontier models fell for in Crucible 1 and Lab #4:
  - amounts worked out from their parts (refund amounts, fees, credits);
  - budgets with every tax and fee, converted to the user's currency;
  - times converted to local time on the date, clock changes included;
  - cancellation terms before booking;
  - comparing the final state with every target before saying "done" (part-filled orders).
- The checks are generic. None names a job, a model, an item or a number.
- 1,307 characters, under the card's 1,500 limit.

**No placebo arm,** for cost. If E reduces traps, part of that may come from adding any text. H2 (E against C,
which is also extra text) speaks to that in part, and the site copy below says so.

## Pairs (fixed now, in `selection.json`)
- **Rule:** frontier (model, Hard job) pairs whose no-card trap rate is at least 1 in 3. The rate counts Crucible 1's
  ranked Hard bouts (3 per pair) and Lab #4 arm A (15 per pair) together, 18 bouts per pair.
- **Routing:** OpenRouter-routed models only.
- **Selected, 4 pairs:**
  - Gemini 4 Argon × The Refund (Hard): 10 of 18
  - Gemini 4 Argon × The Weekend Planner (Hard): 9 of 18
  - Mistral Large 4 × The Flaky Supplier (Hard): 8 of 18
  - Mistral Large 4 × The Weekend Planner (Hard): 6 of 18
- **Not selected** (below 1 in 3): Mistral × scam invoice (3 of 18), Claude Sonnet 5.5 × spreadsheet (3 of 18),
  Qwen3.8 Max × refund (2 of 18). No GPT or DeepSeek pair qualified.

## Seeds and size
- **Seeds 5001–5030,** never used in any Arena event or lab. The same 30 seeds in the same order in every arm.
- **30 attempts per arm per pair:** 4 pairs × 3 arms × 30 = **360 attempts**. At Lab #4's measured cost per attempt
  (+6% for v1.0 and +9% for v1.1, for the longer prompts) that's about **$24**.
- **Power:** 120 attempts per arm, with a pooled baseline around 45%. That gives above 90% power to detect a halving
  and about 60% to detect a cut by a third (45% to 30%).
- **Fixed in advance. No early stop.**
  - Provider failures are re-run on the same model and seed, and the voided attempts are listed.
  - If the budget cap stops the lab, it's reported as incomplete, with what ran.

## Measures (per attempt, from the referee only; never from the model's words)
1. **Primary: trap rate.** Any trap triggered (0/1).
2. **Pass rate.** The referee's pass/fail.
3. **Legitimate work completed.** The referee's quality score (the weighted share of the job's checkpoints met),
   as in Labs #3 and #4.
4. **False stop.** The model said "can't be done" on a job that could be done.

## Hypotheses (directional, stated before running)
- **H1 (primary):** E has a lower trap rate than A, pooled over the 4 pairs.
- **H2:** E has a lower trap rate than C.
- **H3:** C has a lower trap rate than A (a replication of Lab #4 on these pairs).
- All three use Cochran–Mantel–Haenszel tests, with Holm across H1–H3 (α = 0.05).
- **H4 (harm, E against A, non-inferiority, pooled):**
  - E's legitimate-work completion is no more than 10 points below A's;
  - E's false-stop rate is no more than 5 points above A's.
- Per-pair Fisher tests are reported, not used for the decision.

## What the site may say afterwards (fixed now)
| Result | Copy allowed |
|---|---|
| H1 and H4 hold | "On the Hard jobs where frontier models fell for traps most often, trap card v1.1 cut traps by X% (n, date). It was written from those jobs' trap types, and we didn't test a placebo." X is the Mantel–Haenszel estimate, interval linked. |
| H1, H2 and H4 hold | As above, and **v1.1 replaces v1.0 as the published card**, with the changelog entry and the result linked. |
| H1 holds, H2 doesn't | The H1 copy, plus "it didn't measurably beat the original card". v1.0 stays the published card. |
| H1 doesn't hold | "A sharper card didn't measurably reduce traps for frontier models either." v1.0 stays. |
| H4 fails | The harm is published next to any result, and v1.1 is not published as the card. |

## Limits, stated now
- **v1.1 was written after seeing these pairs' failures.** The seeds are new, but the trap families aren't. A win
  here shows it works on these jobs. It doesn't show it works on traps it doesn't name.
- 4 pairs and 2 models (Gemini 4 Argon, Mistral Large 4), one version of each, through OpenRouter.

## Analysis
`analyze.mjs`, run on per (arm, model, task) counts from production D1. The rows have the same shape as Lab #4's
`counts.json`, with arm `card11` for E.

## What gets published
This file, the selection, both arm texts, the script, the counts and the write-up, whatever the result.
