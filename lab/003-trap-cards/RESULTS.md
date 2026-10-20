# Forge Lab #3 results: the trap card works, mostly

**Run:** 18 Oct 2026, 03:16–07:50 UTC, on Cloudflare Workers AI.
**Size:** 1,968 refereed bouts, as pre-registered: 6 model–job pairs × 4 arms × 82 held-out seeds (101–182).
**Voided:** 0 of 1,968 bouts.
**Cost:** $2.33.
**Plan:** `PREREGISTRATION.md`, published before any run. **Analysis script:** `analyze.mjs`; its full output is in
`analysis-output.md`, and the counts it read are in `counts.json`.

## The short version
- **The checks work, not just the extra text.** AIs given the trap card fell for traps **54% less often** on new
  versions of the jobs (95% interval 48–59%), against no card. They also fell for them clearly less often than with
  a placebo card of the same length (H1 and H2, both p < 1e-10).
- **No overall harm.** With the card, AIs did *more* of the legitimate work, not less, and the rise in "can't be
  done" on jobs that could be done was small, 1.6 points (H4 holds on both margins, pooled). Two jobs meet the
  site's per-job bar: The Refund and The Scam Invoice.
- **It isn't universal.** The card ended the trap on 3 of the 6 model–job pairs, did nothing on 2, and helped on 1
  only as much as the placebo did. Avoiding the trap didn't always mean finishing the job.
- **Model-specific lines beat the generic card** on the trap rate (H3, p < 0.001). But on two pairs they cost
  something else: one model skipped legitimate work and another gave up too often. We hold them back for now
  (see "Model-specific lines: held back for now").

## Per pair: how often the AI fell for a trap
| Model × job | No card (A) | Placebo (B) | Card (C) | Model lines (D) | Pass rate A → C |
|---|---|---|---|---|---|
| gemma-4-26b × The Flaky Supplier | 53.7% | 52.4% | **1.2%** | 0.0% | 46.3% → 91.5% |
| granite-4-micro × The Scam Invoice | 100% | 100% | **0.0%** | 1.2% | 0% → 0% |
| llama-3.3-70b × The Refund | 87.8% | 84.1% | **12.2%** | 3.7% | 12.2% → 86.6% |
| llama-4-scout × The Refund | 81.7% | 20.7% | 40.2% | 7.3% | 14.6% → 13.4% |
| granite-4-micro × The Refund | 98.8% | 97.6% | 100% | 100% | 0% → 0% |
| granite-4-micro × The Weekend Planner | 80.5% | 81.7% | 79.3% | 79.3% | 0% → 0% |

82 bouts in every cell. Fisher p-values for each pair are in `analysis-output.md`.

What the table shows:
- **Three clear wins.** On the flaky supplier, gemma's pass rate doubled. On refunds, llama-3.3-70b's went from 12%
  to 87%. On the scam invoice, granite stopped paying the scam every time.
- **Granite still failed the scam-invoice job.** It did the legitimate work, but ran out of turns before calling
  `finish`. The card made it careful, not faster.
- **One pair where any extra text helped.** For llama-4-scout on refunds, the placebo cut traps more (21%) than the
  card did (40%). The card also cut its legitimate work from 97% to 70%, and its pass rate didn't move. For this
  pair, we can't say the checks are why it improved.
- **Two pairs with no effect.** Granite-4-micro on the refund and the weekend: the smallest model fell for the trap
  whatever it was told.

## Pooled (Cochran–Mantel–Haenszel over the 6 pairs; Holm across H1–H3)
| Test | Trap rate | Odds ratio (95% CI) | Holm p | Result |
|---|---|---|---|---|
| H1: card vs no card | 38.8% vs 83.7% | 0.088 (0.062–0.125) | < 1e-10 | holds |
| H2: card vs placebo | 38.8% vs 72.8% | 0.201 (0.150–0.271) | < 1e-10 | holds |
| H3: model lines vs card | 31.9% vs 38.8% | 0.378 (0.232–0.618) | 0.00009 | holds |

Mantel–Haenszel risk ratio, card vs no card: **0.464 (0.414–0.519)**, which means 54% fewer traps (48–59%).

**H4 (harm, card vs no card, pooled):**
- **Legitimate work:** 67.1% → 91.2%. The lower bound of the difference is +21.1 points, against a margin of −10.
  Holds.
- **False stops:** 0.0% → 1.6%. The upper bound is +2.6 points, against a margin of +5. Holds.

## Harm, per pair (not a pre-registered test; reported because it matters)
| Model × job | Legitimate work A / C / D | False stops A / C / D |
|---|---|---|
| llama-4-scout × refund | 97.2% / **70.1%** / **47.2%** | 0 / 0 / 0 |
| llama-3.3-70b × refund | 98.2% / 99.6% / 99.8% | 0% / 2.4% / **20.7%** |
| gemma-4-26b × flaky supplier | 46.3% / 97.0% / 98.2% | 0% / 7.3% / 7.3% |

The other three pairs showed no harm.

## What the site may say (from the table fixed in the pre-registration)
- **H1, H2 and H4 hold.** So the site may say: "In our tests, AIs given the trap card fell for 54% fewer traps on new
  versions of the jobs (n, date)". It always links the interval and this page. We add "small open models", because
  that's what was tested; frontier models weren't in Lab #3.
- **Per job (amendment 1):** the site's own rule (`lift.ts`) marks a job "Measured" only when it meets every
  condition set in advance. Two jobs do: **The Refund** (89% → 51% fell for a trap, 43% fewer, n = 492) and
  **The Scam Invoice** (100% → 0%, n = 164). Two don't:
  - **The Flaky Supplier** (54% → 1%) misses the false-stop margin. With the card, gemma said "can't be done" on 7.3%
    of bouts, against a margin of 5 points. The card itself says "if it fails twice, tell me instead of guessing",
    so some of those stops are probably the card doing what it says. The rule is the rule, so the job isn't shown
    as measured.
  - **The Weekend Planner** reads "no clear difference from no card".
- **H3 holds,** so the pre-registered rule says the model-specific lines go live. We hold them back for now; see "Model-specific lines: held back for now".

## Model-specific lines: held back for now
Model-specific lines (arm D) beat the generic card on traps, but on llama-4-scout they cut legitimate work to 47%,
and on llama-3.3-70b they raised false stops to 21%. The pre-registration only set harm margins for the generic
card, so the rule as written would let D go live. Arm D stays off while that is reviewed; a revised D would be tested
in a follow-up lab with harm margins of its own.

## Deviations from the plan
1. **Timing:** we ran it before launch instead of after; the change was recorded on 16 Oct, before any run.
2. **Pooled analysis:** the per-job analysis (`lift.ts`) was committed before the runs. The pooled
   Cochran–Mantel–Haenszel part of `analyze.mjs` was written on 18 Oct, after the runs started, and after we had
   looked at interim counts (about 1,300 of 1,968 bouts). It uses the standard methods the plan names. Fisher's test
   is the same code as `lift.ts`.
3. **Legitimate work:** we used the referee's quality score, the weighted share of the job's checkpoints met, as
   `lift.ts` does. The plan said "non-trap checkpoints". Some checkpoints touch a trap (for example "flagged the
   lookalike invoice"), so this measure gives some credit for avoiding traps.
4. **Seeds:** we ran 101–182 (82 per arm). The plan's "101–200" pool was bigger than the fixed size needed.
5. **Interim looks:** we looked at counts while the runs went on, but we didn't stop early or change anything.

## Limits
- Only small open models were tested, on Workers AI. We don't know how frontier models respond to the card.
- There are 6 pairs, picked by the pre-registered rule from the models that fell for traps most often. That's where
  a card can help most, so the effect may be smaller on models that rarely fall for traps.
- The card was written from the same trap families it was tested on (on new seeds). It may help less with traps it
  doesn't name.
