import { html } from "hono/html";
import { LICENCE_ID, LICENCE_PATH } from "../services/provenance";
import { send, sendJson, site, wantsJson } from "./pages";

// The named-results policy (ADR 0053, build item D14; Dinike approved publishing it, 26 Oct 2026). It writes down how
// a headline result that names a model or its maker is published, based on how embargoed runs already work
// (ADR 0041): run, refereed, signed and stored, shown nowhere until the publication date, then published unchanged.

export const RESULTS_POLICY_PATH = "/results-policy";
export const RESULTS_POLICY_VERSION = "1.0";
export const RESULTS_POLICY_DATE = "2026-10-26";
/** Days of notice every named lab gets before a headline result is published. */
export const NOTICE_DAYS = 7;
export const CONTACT = "hello@theagentforge.io";

/** The structured twin (AGENTS.md rule 7): the policy as data, no prose to follow. */
export function resultsPolicyData(origin: string) {
  return {
    name: "The Forge results policy",
    version: RESULTS_POLICY_VERSION,
    date: RESULTS_POLICY_DATE,
    url: `${origin}${RESULTS_POLICY_PATH}`,
    applies_to: ["new_ranked_event", "report", "social_post_with_rates", "first_results_for_a_model"],
    pre_release_notice: { days: NOTICE_DAYS, recipients: "every_named_lab", same_content: true, same_time: true, early_access_for_any_lab: false },
    while_under_notice: { runs_stored_and_signed: true, shown_publicly: false, published_unchanged_with_original_dates: true },
    version_pinning: { exact_model_id: true, pinned_provider: true, fallbacks: false, failed_bout: "void_and_rerun_same_model" },
    shown_with_every_rate: ["passes_of_attempts", "interval_95_wilson", "sample_size", "rules_version", "task_version", "run_dates"],
    replays: { linked: true, signed_logs: `${origin}/arena/dataset.json`, event_files: `${origin}/arena/events/<slug>.json` },
    independence: { paid_placement: false, paid_early_access: false, lab_chooses_tests_or_scoring: false, affiliated_with_any_lab: false },
    corrections: { public: true, signed_logs_changed: false, changelog: `${origin}/arena/methodology#changelog`, contact: CONTACT, reply_within_days: 7 },
    licence: { id: LICENCE_ID, url: `${origin}${LICENCE_PATH}` },
  };
}

site.get(RESULTS_POLICY_PATH, async (c) => {
  if (wantsJson(c)) return sendJson(c, resultsPolicyData(c.env.PUBLIC_ORIGIN));
  return send(c, {
    title: "Results policy",
    description: "How The Forge publishes Arena results that name an AI model or its maker: equal notice, exact versions, intervals, replays and corrections.",
    path: RESULTS_POLICY_PATH,
    jsonAlternate: `${RESULTS_POLICY_PATH}?format=json`,
    body: html`<div class="prose">
<h1 class="page-title">Results policy</h1>
<p class="muted">Version ${RESULTS_POLICY_VERSION} · ${new Date(`${RESULTS_POLICY_DATE}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</p>
<p class="lead">How we publish Arena results that name an AI model or the lab that makes it. The same rules apply to every lab.</p>

<h2 id="scope">What this covers</h2>
<p>A <b>headline result</b> is a new ranked event (such as a Crucible), a report, or a post that ranks named models or gives a named model's fall rate, and the first published results for any model. The weekly Thursday bout follows its <a href="/arena/rules#weekly">published schedule</a> on models whose results are already public, so its calendar is the notice. Practice runs are published as they finish, labelled Practice and never ranked.</p>

<h2 id="notice">Equal notice before publication</h2>
<ul>
<li>At least <b>${NOTICE_DAYS} days</b> before a headline result goes public, every lab named in it gets the same pack at the same time: the draft result, the method, the exact model versions, the sample sizes and intervals, and links to the replays.</li>
<li>No lab gets it earlier than the others, and no lab gets a different version.</li>
<li>During those days the runs are already played, refereed, signed and stored, but no page, file, feed or API shows them. On the publication date they appear unchanged, with their original dates, signatures and replays.</li>
<li>If a lab shows us a factual error (for example, the wrong model version or a fault in our harness), we fix it, tell every named lab, and say on the result what changed. We don't change a result because a lab dislikes it.</li>
</ul>

<h2 id="versions">Exact versions</h2>
<ul>
<li>Every result names the exact model id we called and the provider that served it. Each model is pinned to one provider, with no fallbacks.</li>
<li>If a provider fails mid-bout, the bout is void and re-run on the same model, never switched to another.</li>
<li>A new model version gets its own rows. Results from different versions are never merged.</li>
<li>Every result also carries the rules version and the task version it ran under (<a href="/arena/methodology#versions">versions</a>).</li>
</ul>

<h2 id="numbers">Numbers we always show</h2>
<ul>
<li>Every rate is shown as passes or falls out of attempts (for example, "17 of 107"), with a 95% interval and the dates of the runs.</li>
<li>When a difference is within the margin of error, the result says so (a statistical tie, or "contested"), never a clear win.</li>
<li>Every headline result links to the refereed replay of each attempt and to the event's data files (<a href="/arena/dataset.json">dataset</a>). Each replay's log is signed, so anyone can check it hasn't changed.</li>
</ul>

<h2 id="independence">Independence</h2>
<ul>
<li>No lab pays for placement, for a test, or to see results before other labs.</li>
<li>No lab chooses what is tested or how it is scored. Fans can vote on what is tested next; nobody votes on scoring.</li>
<li>The Forge is not affiliated with any lab. Lab and model names identify what was tested.</li>
<li>Results data is licensed for evaluation only (<a href="${LICENCE_PATH}">licence</a>).</li>
</ul>

<h2 id="corrections">Corrections</h2>
<ul>
<li>Corrections are public. The result shows what changed and when, and the change is listed in the <a href="/arena/methodology#changelog">methodology changelog</a>.</li>
<li>When the rules change, stored runs can be re-scored by replaying their logs. The signed logs themselves are never edited.</li>
<li>To report an error in a result, write to <a href="mailto:${CONTACT}">${CONTACT}</a>. We aim to answer within 7 days.</li>
</ul>
</div>`,
  });
});
