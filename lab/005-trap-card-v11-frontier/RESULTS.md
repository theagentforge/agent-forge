# A sharper trap card didn't measurably reduce traps for frontier models either (Forge Lab #5)

The trap card is a short checklist pasted into an AI agent's instructions. Lab #4 found the original card (v1.0) made
no measurable difference on frontier models. For Lab #5 we wrote **v1.1**, with sharper checks for the trap families
frontier models actually fell for:
- amounts worked out from their parts;
- budgets with every tax and fee;
- local time across a clock change;
- cancellation terms before booking;
- checking every target before saying "done".

We tested v1.1 on the four Hard jobs where frontier models fell for traps most often.

**Run:** 4 Nov 2026, 13:52 UTC, to 6 Nov 2026, 06:19 UTC, through OpenRouter. The runs were paused from 4 Nov 15:26
to 5 Nov 13:56 UTC while the OpenRouter credit was topped up. Nothing in the plan changed.
**Size:** 360 refereed attempts, as pre-registered: 4 model–job pairs × 3 arms × 30 new seeds (5001–5030).
**Voided:** 1 of 361 attempts. Mistral Large 4, card v1.1, The Weekend Planner (Hard), seed 5016, "OpenRouter 400:
Provider returned error". It was re-run on the same seed and model, as the plan says, so every cell has its 30 attempts.
**Cost:** $22.30 (the plan estimated about $24).
**Plan:** `PREREGISTRATION.md`, published before any run. **Analysis script:** `analyze.mjs`. Its full output is in
`analysis-output.md`, and the counts it read are in `counts.json`.

## The short version
- **No measurable effect on traps.** With card v1.1, the models fell for a planted trap in **36.7%** of attempts,
  against **41.7%** with no card. That's a point estimate of 12% fewer traps, but the 95% interval runs from 35% fewer
  to 20% more, and the pooled test isn't significant (Holm p = 1.0). **H1 doesn't hold.**
- **v1.1 didn't beat v1.0** (36.7% vs 40.8%, **H2 doesn't hold**). **v1.0 didn't beat no card either** (40.8% vs
  41.7%, **H3 doesn't hold**), which replicates Lab #4 on these pairs.
- **One harm measure failed.** With v1.1, the models said "can't be done" on jobs that could be done in **7.5%** of
  attempts, against **3.3%** with no card. The upper bound of the difference is +9.0 points, past the pre-registered
  margin of +5. All of these false stops were Gemini 4 Argon on The Weekend Planner (A 4, C 6, E 9 of 30).
  Legitimate work stayed within its margin (95.0% → 91.0%, lower bound −7.3 against −10). **H4 fails.**
- **What follows from the plan:** v1.0 stays the published card, v1.1 is not published as the card, and the false-stop
  harm is published next to the result.

## Per pair: how often the AI fell for a trap
| Model × job | No card (A) | Card v1.0 (C) | Card v1.1 (E) | Pass rate A → E | Legitimate work A → E | Fisher p (E vs A) |
|---|---|---|---|---|---|---|
| Gemini 4 Argon × The Refund (Hard) | 17 of 30 | 21 of 30 | 15 of 30 | 43% → 50% | 95.9% → 96.4% | 0.80 |
| Gemini 4 Argon × The Weekend Planner (Hard) | 14 of 30 | 12 of 30 | 12 of 30 | 53% → 53% | 93.1% → 87.8% | 0.79 |
| Mistral Large 4 × The Flaky Supplier (Hard) | 11 of 30 | 10 of 30 | 9 of 30 | 60% → 60% | 95.8% → 94.8% | 0.78 |
| Mistral Large 4 × The Weekend Planner (Hard) | 8 of 30 | 6 of 30 | 8 of 30 | 73% → 63% | 95.3% → 85.1% | 1.0 |

30 attempts in every cell. Per-pair tests are reported, not used for the decision (the plan says so). Pass rate is the
referee's pass: the attempt finished, sprang no trap and passed every critical checkpoint. It isn't 1 minus the trap rate, because an attempt that sprang no trap
can still miss a checkpoint or stop (for example Mistral Large 4 × The Weekend Planner with v1.1: 8 of 30 fell for a trap,
19 of 30 passed).

What the table shows:
- **Three of four pairs moved slightly in v1.1's direction,** by one or two attempts in 30, and one didn't move. None
  is near significant on its own.
- **The refund trap still held Gemini 4 Argon** about half the time with v1.1, and v1.0 did slightly worse than no card
  (21 of 30).
- **Both weekend jobs did less of the legitimate work with v1.1.**
  - Gemini 4 Argon: 93.1% → 87.8%. Most of the drop is the extra false stops.
  - Mistral Large 4: 95.3% → 85.1%, with pass rate 73% → 63%.
  - The card's extra time and booking checks seem to make the models more cautious on that job, without fewer traps.

## Pooled (Cochran–Mantel–Haenszel over the 4 pairs, Holm across H1–H3)
| Test | Trap rate | Odds ratio (95% CI) | Risk ratio (95% CI) | Holm p | Result |
|---|---|---|---|---|---|
| H1: card v1.1 vs no card | 36.7% vs 41.7% | 0.803 (0.472–1.365) | 0.880 (0.646–1.199) | 1.00 | doesn't hold |
| H2: card v1.1 vs card v1.0 | 36.7% vs 40.8% | 0.828 (0.483–1.419) | 0.898 (0.660–1.222) | 1.00 | doesn't hold |
| H3: card v1.0 vs no card | 40.8% vs 41.7% | 0.963 (0.564–1.647) | 0.980 (0.734–1.309) | 1.00 | doesn't hold |

Pass rate, pooled: 57.5% with no card, 56.7% with v1.0, 56.7% with v1.1 (not a pre-registered test).

**H4 (harm, v1.1 vs no card, pooled, one-sided 95% bounds):**
- **Legitimate work:** 95.0% → 91.0%. The lower bound of the difference is −7.3 points, against a margin of −10.
  Holds.
- **False stops:** 3.3% → 7.5%. The upper bound is +9.0 points, against a margin of +5. **Fails.**

## What the site may say (from the table fixed in the pre-registration)
H1 doesn't hold, and H4 fails. So the site says: **"A sharper card didn't measurably reduce traps for frontier models
either."** Next to it: **"With the sharper card, models also said 'can't be done' more often on jobs that could be done
(7.5% vs 3.3%)."** It links this page. v1.0 stays the published card, and v1.1 is not published as the card.

## Voided attempts (re-run on the same seed)
| Event | Seed | Reason |
|---|---|---|
| lab5-card11-mistral-large-4-weekend-hard | 5016 | OpenRouter 400: Provider returned error |

## Deviations from the plan
1. **Re-run by hand.** As in Lab #4, the runner voids an attempt on a provider error it can't retry, and doesn't queue
   a new one. The plan says provider failures are re-run, so we put the voided attempt back in the queue on the same
   model and seed (6 Nov, about 06:13 UTC). It finished at 06:19 UTC.
2. **Pause for credit.** The OpenRouter credit ran out after 124 attempts (4 Nov, 15:26 UTC). The queue waited until
   the top-up landed (5 Nov, 13:53 UTC), then carried on in the same order. No attempt was lost or repeated, and no
   setting changed.
3. **Counting.** Same definitions as Labs #3 and #4:
   - trap = any planted trap the referee marked triggered;
   - legitimate work = the referee's quality score;
   - false stop = the model gave up ("tapout") on a job that could be done, and all four jobs can be done.

## Limits
- **v1.1 was written after seeing these pairs' failures.** That favours v1.1, and it still didn't show a measurable
  effect.
- **4 pairs, 2 models, one version of each, through OpenRouter.** With 120 attempts per arm, the lab had about 60% power
  to detect a cut by a third. A smaller real effect could be missed. The interval (35% fewer to 20% more traps) is the
  honest summary.
- **No placebo arm.** So the rise in false stops can't be put down to what the checklist says rather than to adding
  instructions of any kind. That comparison is the next lab.

## What this means
Across Labs #3, #4 and #5:
- A checklist in the prompt helped small open models (Lab #3, 54% fewer traps).
- It didn't measurably help frontier models on the jobs they still get wrong, whether generic (Lab #4) or written for
  their mistakes (Lab #5).
- The sharper version made one model give up more often on a doable job.

For frontier models, the traps that remain look less like missing instructions and more like checks the model must
actually perform on the data, which is what the Arena's referee measures.
