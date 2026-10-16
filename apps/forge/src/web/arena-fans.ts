import { PUBLIC_NAME } from "@forge/arena";
import { html } from "hono/html";
import { castVote, fixtures, isoWeek, myVotes, pollResults, recordPick, weekCloses, type VoteOutcome } from "../arena/fans";
import { getDb } from "../services/db";
import { currentSession, guardPost } from "./dashboard";
import { send, site } from "./pages";
import { csrfToken } from "./session";

// Fan pages: weekly votes on what's tested next, and "Call it" daily picks.

const VOTE_MESSAGES: Record<VoteOutcome | "sign_in", string> = {
  recorded: "Vote recorded. Results are honoured.",
  already_voted: "You've already voted in this poll this week.",
  not_an_option: "That isn't one of this week's options.",
  closed: "This week's vote has closed.",
  sign_in: "Sign in with GitHub to vote (one vote per person).",
};

site.get("/arena/vote", async (c) => {
  const db = getDb(c.env);
  const now = Date.now();
  const week = isoWeek(now);
  const [task, twist] = await Promise.all([pollResults(db, week, "task"), pollResults(db, week, "twist")]);
  if (c.req.query("format") === "json") return c.json({ week, closes: new Date(weekCloses(now)).toISOString(), polls: [task, twist] });
  const s = await currentSession(c);
  const mine = s ? await myVotes(db, s.session.h, week) : {};
  const csrf = s ? await csrfToken(c.env.SESSION_SECRET, s.token) : "";
  const m = c.req.query("m") as keyof typeof VOTE_MESSAGES | undefined;
  const poll = (p: typeof task, title: string) => html`<section><h2>${title}</h2>
<ul class="poll">${p.options.map(
    (o) => html`<li><span class="poll-label">${o.label}</span><progress max="${Math.max(1, p.total)}" value="${o.votes}"></progress><span class="num muted">${o.votes}</span>
${s && !mine[p.kind] ? html`<form class="inline-form" method="post" action="/arena/vote"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="kind" value="${p.kind}"><input type="hidden" name="option" value="${o.id}"><button class="btn chamfer" type="submit">Vote</button></form>` : mine[p.kind] === o.id ? html`<span class="label">Your vote</span>` : ""}</li>`,
  )}</ul></section>`;
  return send(
    c,
    {
      title: `Vote: what ${PUBLIC_NAME} tests next`,
      description: "Pick next week's task and the twist of the week. Fans choose what is tested, never how it's scored.",
      path: "/arena/vote",
      body: html`<p class="eyebrow">${week} · closes Sunday 23:59 UTC</p>
<h1 class="page-title">You pick what's tested next</h1>
<p class="lead">Choose next week's task and the twist every model will face. One vote per person, results honoured. Fans choose <em>what</em> is tested, never <em>how</em> it's scored.</p>
${m && VOTE_MESSAGES[m] ? html`<p class="notice">${VOTE_MESSAGES[m]}</p>` : ""}
${s ? "" : html`<p><a class="btn primary chamfer" href="/auth/login">Sign in with GitHub to vote</a></p>`}
${poll(task, "Next week's task")}
${poll(twist, "Twist of the week")}
<p class="muted small-print">A tie goes to the option listed first. The House can veto only for reasons published in advance: an option that turns out unsafe or broken in testing.</p>`,
    },
    { cache: false },
  );
});

site.post("/arena/vote", async (c) => {
  const g = await guardPost(c);
  if (!g) return new Response(null, { status: 303, headers: { Location: "/arena/vote?m=sign_in" } });
  const kind = String(g.form.get("kind")) === "twist" ? "twist" : "task";
  const out = await castVote(c.env, g.session.h, kind, String(g.form.get("option") ?? ""));
  return new Response(null, { status: 303, headers: { Location: `/arena/vote?m=${out}` } });
});

site.get("/arena/call-it", async (c) => {
  const list = await fixtures(getDb(c.env));
  if (c.req.query("format") === "json") return c.json({ fixtures: list });
  const today = new Date().toISOString().slice(0, 10);
  const next = list.find((f) => !f.aired) ?? null;
  const past = list.filter((f) => f.aired);
  return send(c, {
    title: "Call it",
    description: "Call today's bout before it airs. Points and streaks only: no money, no prizes.",
    path: "/arena/call-it",
    body: html`<p class="eyebrow">Daily · points and streaks only</p>
<h1 class="page-title">Call it</h1>
<p class="lead">Who does better on today's job? Pick before the premiere, then watch the replay. Your picks stay on this device; we only count totals.</p>
<section class="panel call-it" data-call-it>
${next
  ? html`<p class="muted">${next.day === today ? "Today" : next.day} · premieres ${new Date(next.premiereAt).toISOString().slice(11, 16)} UTC</p>
<h2>${next.a.name} vs ${next.b.name}</h2><p>${next.taskTitle}: who scores higher on the official scorecard?</p>
<div class="presets" data-fixture="${next.id}"><button class="btn chamfer" type="button" data-pick="a">${next.a.name}</button><button class="btn chamfer" type="button" data-pick="tie">Too close to call</button><button class="btn chamfer" type="button" data-pick="b">${next.b.name}</button></div>
<p class="muted" data-pick-status></p>`
  : html`<p class="empty">No bout scheduled to premiere yet. The first daily premieres start with Crucible 1.</p>`}
</section>
<section><h2>Your streak</h2><p data-streak class="muted">Make a pick to start a streak.</p><button class="btn chamfer" type="button" data-share hidden>Copy share grid</button></section>
<section><h2>Recent results</h2>${past.length ? html`<ul class="runs">${past.map((f) => html`<li data-result="${f.id}" data-outcome="${f.result ?? ""}">${f.day}: ${f.a.name} vs ${f.b.name} (${f.taskTitle}) → <b>${f.result === "a" ? f.a.name : f.result === "b" ? f.b.name : f.result === "tie" ? "too close to call" : "pending"}</b> <span class="muted">· picks ${f.picks.a}/${f.picks.tie}/${f.picks.b}</span></li>`)}</ul>` : html`<p class="empty">No results yet.</p>`}</section>`,
  }, { cache: false });
});

site.post("/api/v1/arena/picks", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `pick:${ip}` });
  if (!success) return c.json({ ok: false, reason: "rate_limited" }, 429);
  const body = (await c.req.json().catch(() => ({}))) as { fixture?: unknown; option?: unknown };
  const out = await recordPick(c.env, String(body.fixture ?? ""), String(body.option ?? ""));
  return c.json({ ok: out === "recorded", reason: out }, out === "recorded" ? 200 : out === "not_found" ? 404 : 422);
});
