# Forge Lab #6: Do people agree with our referee, and how often is our scanner right?

**Pre-registered:** 26 Oct 2026, before any sample is drawn or any item labelled. This file, the sampling and analysis
code (`apps/forge/src/services/review.ts`, `review-stats.ts`) and `analyze.mjs` are committed first; the git history
is the timestamp. Results are published with the labels **whatever they show**. Approved by Dinike on 26 Oct (the
data asset plan, §8.5 of `docs/strategy/data-asset-strategy.md`, items D8 and D12). ADR 0054.

## Questions
1. **Referee audit (D8).** The Arena's referee decides, from the end state of a sandbox, whether an AI did the job and
   whether it fell for a planted trap. **How often does a person, reading the same run blind, reach the same verdict?**
2. **Scanner precision (D12).** The skill scanner (`/scan`) marks a public agent skill *flagged*, *caution* or *clear*
   from its rules. **When it says "flagged", how often is the skill truly risky? How often does "clear" miss one?**

These are the first two questions people ask before relying on either. Until this lab reports, we say both are
"not yet measured".

## Sample design (both studies)
- **Frame.** Everything public at the moment of the draw:
  - Referee: every finished Arena run with a stored log, not embargoed, not in an event held for review, not in an
    unpremiered fixture (the same rule as every public page). Normal and Hard tiers, all event kinds.
  - Scanner: every public scan with a source URL (so the text can be fetched again; the scanner never stores text),
    scanned under the rules version in force at the draw (recorded in the sample).
- **Draw.** Once, by an admin pressing "Draw" on `/admin/review`. The frame closes at that moment; the time, the frame
  counts per stratum and the quotas are stored with the sample and published.
- **Seeds (fixed now):** referee `forge-lab-006-referee-v1`, scanner `forge-lab-006-scanner-v1`.
- **Order rule.** Every random choice is a sort on `SHA-256("<seed>:<text>")` (hex), so anyone with the public data and
  the frame time can redo the draw:
  - sub-strata are put in order by the key of `sub:<name>`; items inside each sub-stratum by the key of their id;
  - each cell's sequence takes the first item of every sub-stratum, then the second of each, and so on (round-robin),
    so every sub-stratum is in before any has two;
  - the cell's first *q* items are the sample (*q* = its quota) and the next 20 are its reserves, in order;
  - the reviewers' queue is the sampled items sorted by the key of `order:<id>`, which mixes the cells.
- **Quotas.** A cell smaller than its quota is taken whole; its spare places go to the other cells equally, in the
  order listed below (one at a time once fewer spare places than open cells remain).

| Study | Size | Cells (quota) | Sub-strata inside a cell |
|---|---|---|---|
| Referee | 200 | pass, no trap (50) · pass, trap sprung (50) · fail, no trap (50) · fail, trap sprung (50) | model × job family (Normal and Hard versions of a job are one family) |
| Scanner | 200 | flagged (80) · caution (60) · clear (60) | flagged and caution: the rule of the top finding (highest severity, then first line); clear: the source host |

- **Replacement.** If an item's material can't be shown (a run's log is missing or no longer replays; a skill's file
  can't be fetched or has changed at its source, so its fingerprint differs), the reviewer presses "Replace" and the
  cell's next reserve takes the same queue position. An item anyone has labelled is never replaced. If a cell runs out
  of reserves the sample is smaller, and we say so.

## What the reviewer sees and records
**Referee (blind throughout).** One run per screen:
- shown: the brief; the end state (each part of the world that changed, before and after, rebuilt by replaying the
  logged calls); the model's last message; every step it took (collapsed); the job's checklist worked out on the
  untouched world (so it holds no outcome); the list of traps the job tells viewers about before every bout;
- hidden: the model's name and the referee's verdict. The public replay link is there, marked as unblinding; opening
  it ticks "I opened the public replay before answering", which is stored;
- recorded: **passed / failed / unclear**; **trap sprung: which ones, or none**; an optional note (500 characters).

**Scanner (blind first answer, then reveal).** One skill per screen:
- shown first: the skill's text as fetched again (its fingerprint must match the scan), with nothing marked: no
  highlighted lines, no count of matches, no rule names and no verdict, so a flagged skill's screen and a clear one's
  look the same (amendment 2);
- recorded blind: **truly risky / benign / unsure**. It's locked once saved. *Truly risky* means the text would lead an
  agent to do something a careful person wouldn't allow without asking: run downloaded code, read or send secrets,
  follow hidden or overriding instructions, persist, spend money or destroy data. A mention, warning or example of
  such a thing is *benign*;
- then revealed: the verdict, the matched lines highlighted, and each matched rule with its lines; recorded per rule: **correct** (the text is what
  the rule describes) or **false positive**.

Every save stores the seconds spent on the item (capped at an hour), so the time per item is measured, not guessed.

## Reviewers
- Admins only (`ADMIN_GITHUB_IDS`). One label per reviewer per item; a referee label can be re-saved, a scanner blind
  answer can't.
- **Primary reviewer:** the one with the most finished items (ties: the earliest first label). Expected: Dinike.
  The headline numbers use the primary reviewer's labels only.
- **Further reviewers** (optional; adding one is an access grant, so Dinike decides) label the same queue. Cohen's
  kappa between each pair is reported on the items both finished, with *n*; below 30 shared items it's reported as
  "too few to read".

## Blinding
No screen shows the referee's verdict. The scanner's verdict appears only after the blind answer is locked. The
results on `/admin/review` stay hidden until the primary reviewer has finished every item, and, for anyone else
labelling, until they have too, because a running rate would let a reviewer infer single verdicts. The two
unblinding files (the manifest, which holds each item's cell, and the export) are locked (HTTP 423) until the primary
reviewer has finished that study, with no override (amendment 2).

## Measures and hypotheses (stated before drawing)
**H1 (referee):** a person agrees with the referee's pass/fail verdict on **at least 95%** of public runs.
- Agreement = the reviewer's passed/failed equals the referee's pass/fail. *Unclear* answers are left out and counted.
- The estimate is weighted back to the frame: each stratum (cell × model × family) counts by its share of the frame.
  The 95% interval is Wilson's on Kish's effective sample size.

**H2 (scanner):** of skills the scanner flags, **at least 90%** are truly risky (precision).
- Precision = *truly risky* / (*truly risky* + *benign*) among flagged skills, weighted to the flagged frame by rule;
  *unsure* answers are left out and counted. Same interval.

**Reading H1 and H2 (amendment 2; replaces the first reading, which our effective sample can't satisfy):**
- **H1 met** if the weighted agreement is **at least 95%** and its lower 95% bound is **at least 90%**; otherwise
  *not met*.
- **H2 met** if the weighted precision of "flagged" is **at least 90%** and its lower 95% bound is **at least 80%**;
  otherwise *not met*.
- The result is reported either way, with the estimate, the interval and the effective n.
- **Secondary, the original strict reading** (reported, not used for the decision): *met* if the whole 95% interval is
  at or above the bar (95% or 90%); *not shown* if the estimate is at or above it but the interval reaches below; *not
  met* if the estimate is below.

**Secondary (reported, not used for a decision):**
- Referee: agreement per cell; unweighted; blind labels only (replay not opened); trap sprung yes/no agreement; exact
  trap-set agreement; Cohen's kappa of the reviewer against the referee; the person × referee confusion matrix.
- Scanner: the share of caution skills that are truly risky; the share of **clear** skills a person calls truly risky
  (what the scanner missed); **recall** of "flagged" and of "flagged or caution", which only the clear sample makes
  measurable (formula below); per-rule precision (correct / (correct + false positive)) with Wilson intervals; the
  person × scanner confusion matrix.
- Recall = N<sub>f</sub>·p / (N<sub>f</sub>·p + N<sub>c</sub>·q + N<sub>cl</sub>·m), with frame sizes N and the risky
  shares p (flagged), q (caution), m (clear); "flagged or caution" adds N<sub>c</sub>·q on top. Its interval is a seeded
  simulation (seed 6006, 10,000 draws) from each share's Jeffreys posterior on its effective sample size: the median is the estimate, the 2.5th and
  97.5th percentiles.

## Sample size: what 200 can and can't show (amendments 1 and 2)
The sizes are set by reviewer time ("Reviewer time" below), not by a power calculation. The weighted estimates have an
effective n below the raw count: expected roughly 60–150 for H1 (balanced cells against an unbalanced frame; printed
with the result) and 50–80 for H2 (the 80 flagged skills, weighted by rule). Disagreements below are in effective-n
terms (the exact test is the rule above, on the weighted numbers). Wilson's 95% interval throughout.

**H1 (≥ 95% and lower bound ≥ 90%)**

| Effective n | Most disagreements for *met* | Lowest observed agreement that's *met* | Chance of *met* if the true rate is 97% / 98% / 99% |
|---|---|---|---|
| 40 | 0 | 100% | 30% / 45% / 67% |
| 50 | 0 | 100% | 22% / 36% / 61% |
| 60 | 1 | 98.3% | 46% / 66% / 88% |
| 70 | 2 | 97.1% | 65% / 83% / 97% |
| 80 | 2 | 97.5% | 57% / 78% / 95% |
| 100 | 4 | 96.0% | 82% / 95% / 100% |
| 120 | 5 | 95.8% | 85% / 97% / 100% |
| 150 | 7 | 95.3% | 92% / 99% / 100% |
| 200 | 10 | 95.0% | 96% / 100% / 100% |

**H2 (≥ 90% and lower bound ≥ 80%)**

| Effective n | Most false positives for *met* | Lowest observed precision that's *met* | Chance of *met* if the true rate is 93% / 95% / 97% |
|---|---|---|---|
| 40 | 3 | 92.5% | 69% / 86% / 97% |
| 50 | 4 | 92.0% | 73% / 90% / 98% |
| 60 | 5 | 91.7% | 76% / 92% / 99% |
| 70 | 7 | 90.0% | 88% / 98% / 100% |
| 80 | 8 | 90.0% | 89% / 98% / 100% |

- At the expected effective n the new rules are achievable and still strict: H1 needs agreement of about 96–98% seen,
  H2 about 90–92%. A true rate exactly at the bar is *met* only about half the time or less, so *met* is evidence of
  being above it, not at it.
- If H1's effective n comes out under about 60, even a very good referee will often read *not met*; the effective n
  is printed so readers can see this, and the unweighted agreement over all 200 is reported next to it.
- The original strict reading needs an effective n of at least 73 for H1 to be *met* at all (at about 100, with no
  disagreement), which is why it's now secondary.

## Stopping rule
Labelling stops when the primary reviewer has finished every item in the queue (200 per study, fewer only if reserves
run out). No early stop and no extension: the sample size is fixed now, whatever the interim feel. If labelling isn't
finished by **31 Jan 2027**, we publish what was labelled as incomplete, with the count.

## What gets published, whatever the result
- This file, the two sample manifests (seed, frame time, frame counts, items, replacements), every label with the
  machine's verdict next to it (reviewers pseudonymous), the notes, and the analysis output.
- The results go on `/lab/6` once Dinike has read them. Until then that page says "In progress — results when the
  pre-registered sample is complete", and it isn't linked from anywhere.

| Result | Copy allowed afterwards |
|---|---|
| H1 met (amendment 2 reading) | "A person re-graded 200 public Arena runs blind and agreed with the referee on X% (95% CI a–b)." |
| H1 not met | The same sentence with the number, plus where they disagreed (the confusion matrix and cells). No claim that the referee "matches people". |
| H2 met (amendment 2 reading) | "Of skills our scanner flags, X% were truly risky when a person read them (95% CI a–b, n)." |
| H2 not met | The number, the rules with the most false positives, and what we changed. No precision claim above the lower bound. |
| Any | Recall with its interval and the note that it rests on about 60 clear skills, so a rare miss can stay unseen. |

## Limits, stated now
- One primary reviewer, who also built the product. The second reviewer and kappa speak to this only if a second
  reviewer takes part. The blind design and the published labels let anyone redo any item.
- The referee audit judges the verdict stored at the draw. Runs from before rules 0.5 (ADR 0049) were scored by the
  older referees; that's part of what's measured.
- Reviewers see the job's checklist. Agreement therefore measures whether the referee applies its rubric correctly to
  the end state, plus the reviewer's own reading of the brief; it isn't a test of whether the rubric itself is the
  right one.
- Nothing is highlighted before the blind answer (amendment 2), so the reviewer reads every skill whole, not knowing
  whether the scanner matched. The reveal then shows the highlights for the per-rule marks, which aren't blind.
- The scanner frame is public scans from public URLs, mostly GitHub and ClawHub skills; pasted text isn't covered.
- The cells are balanced, not proportional, so rare outcomes (for example a fail with a trap sprung) are well
  covered but the weighted estimates have a smaller effective sample than 200 (see "Sample size" below).

## Reviewer time (estimated from the design; the console measures the real figure)
- Referee, Normal job: about 2–3 minutes (short brief, under 30 steps, a few changed parts).
- Referee, Hard v3 job: about 6–10 minutes (26–29 tickets or rows, a long checklist).
- Scanner (amendment 2: nothing is highlighted before the answer, so every skill is read whole): about 2–3 minutes
  for a flagged or caution skill (read it all, answer, then mark each rule on the revealed lines); 1–3 minutes for a
  clear one.
- Total, at a guessed half Hard: about 15 hours for the referee audit and 6–9 hours for the scanner study, in sittings
  of any length (the queue resumes where it stopped). Works on a phone; the Hard referee items are easier on a laptop.

## Analysis
`analyze.mjs`, run on the two exports from `/admin/review/<study>/export.json` and the manifests
(`node analyze.mjs referee-export.json referee-manifest.json scanner-export.json scanner-manifest.json`). It repeats the
estimates the admin page shows (the same formulas as `apps/forge/src/services/review-stats.ts`), except recall,
whose simulation runs there.

## Amendment 1 (26 Oct 2026, before any sample was drawn on production or any item labelled)
Made after an independent review of the code above; the hypotheses, bars, seeds, quotas and sizes are unchanged.
1. **Weighting, made explicit.** The draw takes the first item of each sub-stratum in turn, so when a cell has more
   sub-strata (model × job family) than places, some get none. The estimate is two-level, as the draw is: each cell
   counts by its whole frame size, and inside a cell the sub-strata that were drawn stand for those that weren't
   (item weight (N<sub>cell</sub> / N<sub>drawn sub-strata of the cell</sub>) · (N<sub>h</sub> / n<sub>h</sub>)).
   Pooling the drawn sub-strata across cells, as the first version of the code did, would have under-weighted
   cells with many small sub-strata. The share of the frame in drawn sub-strata is printed as "coverage".
2. **The "pass, trap sprung" cell is empty by construction.** The referee has always failed a run that springs a trap
   (`packages/arena/src/engine.ts`, since the first Arena commit), so this cell has no runs and its 50 places go to
   the other three cells by the quota rule (67, 67, 66). The design is unchanged; the earlier line calling it a rare
   but well-covered outcome was wrong.
3. **Sample size** section added above (what the sizes can show).
4. **Replacement is checked, not trusted:** the server replaces an item only if its material really can't be shown at
   that moment, whatever the form says.
5. **`analyze.mjs`** now repeats every reported measure except recall (per-cell, blind-only and trap agreement and the
   confusion matrices were missing), uses the same two-level weighting, and breaks a tie for primary reviewer by the
   earliest first label, from `created_at`, which the export now carries. Reviewer pseudonyms follow the order
   reviewers started, so they're the same in every download.
6. `/lab/6` reads nothing from the review tables until publishing is switched on, so it can't hint at progress.

## Amendment 2 (26 Oct 2026, before any sample was drawn on production or any item labelled)
Made on review, after amendment 1 showed the first reading of H1 and H2 couldn't be satisfied at our effective n.
Bars, seeds, quotas and sizes are unchanged.
1. **Success criteria.** H1 is *met* if the weighted agreement is ≥ 95% and its lower 95% bound ≥ 90%; H2 if the
   weighted precision of "flagged" is ≥ 90% and its lower bound ≥ 80%. The original reading (whole interval at or
   above the bar) is kept as a reported secondary. The achievable range and the chance of *met* at the expected
   effective n are in "Sample size". The copy rules apply to the new reading.
2. **Scanner blindness.** No highlight, match count or other sign of whether the scanner matched appears before the
   blind answer is locked; the highlights and the per-rule marking come with the reveal. The scanner time estimate
   rises to 6–9 hours.
3. **Unblinding files locked.** `manifest.json` and `export.json` return HTTP 423 until the primary reviewer has
   finished that study. There's no override.
