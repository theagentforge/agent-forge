import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// MASTER_PLAN §10.4. Timestamps are milliseconds since epoch. No email addresses anywhere.

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const humans = sqliteTable("humans", {
  id: id(),
  githubId: integer("github_id").notNull().unique(),
  githubLogin: text("github_login").notNull(),
  githubCreatedAt: integer("github_created_at").notNull(),
  tier: text("tier", { enum: ["verified", "sandbox"] }).notNull(),
  /** Why this human is verified: founder approval, a vouch, or real public GitHub activity. Null when sandbox. */
  verifiedVia: text("verified_via", { enum: ["approval", "vouch", "activity"] }),
  /** The Forge's own test agents (MASTER_PLAN §7.2): labelled "House" and left out of every proof number (§7.5). */
  isHouse: integer("is_house", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

/** Approvals and vouches, keyed by GitHub login so they can be granted before the person first signs in. */
export const trustGrants = sqliteTable(
  "trust_grants",
  {
    id: id(),
    githubLogin: text("github_login").notNull(), // lowercased
    /** Bound on the person's first sign-in, so a later owner of the same username doesn't inherit the grant. */
    githubId: integer("github_id"),
    source: text("source", { enum: ["approval", "vouch"] }).notNull(),
    grantedByHumanId: text("granted_by_human_id").references(() => humans.id),
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("trust_grants_login").on(t.githubLogin),
    index("trust_grants_granted_by").on(t.grantedByHumanId),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: id(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    handle: text("handle").notNull().unique(),
    framework: text("framework").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    publicKey: text("public_key"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    scoutPoints: integer("scout_points").notNull().default(0),
    /** ADR 0023 §6: the owner has made this agent's Proving Ground score page public. Private by default. */
    scorecardPublic: integer("scorecard_public", { mode: "boolean" }).notNull().default(false),
    /** When the score page was last made public (ms), or null while it's private. */
    scorecardSince: integer("scorecard_since"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agents_human_client").on(t.humanId, t.oauthClientId)],
);

export const tools = sqliteTable("tools", {
  id: id(),
  kind: text("kind").notNull(),
  canonicalId: text("canonical_id").notNull().unique(),
  sourceUrl: text("source_url"),
  registryRefs: text("registry_refs", { mode: "json" }).$type<string[]>(),
  publisherGithub: text("publisher_github"),
  createdAt: createdAt(),
});

/** Other ids that refer to the same tool (e.g. its npm package, GitHub repo and MCP Registry name). */
export const toolAliases = sqliteTable("tool_aliases", {
  alias: text("alias").primaryKey(),
  toolId: text("tool_id")
    .notNull()
    .references(() => tools.id),
});

export const toolVersions = sqliteTable(
  "tool_versions",
  {
    id: id(),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    version: text("version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    advisoryMatch: integer("advisory_match", { mode: "boolean" }).notNull().default(false),
    confirmedMalicious: integer("confirmed_malicious", { mode: "boolean" }).notNull().default(false),
    firstSeenAt: integer("first_seen_at").notNull(),
  },
  (t) => [uniqueIndex("tool_versions_tool_fingerprint").on(t.toolId, t.fingerprint), index("tool_versions_fp").on(t.fingerprint)],
);

export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    toolVersionId: text("tool_version_id")
      .notNull()
      .references(() => toolVersions.id),
    taskCategory: text("task_category").notNull(),
    framework: text("framework").notNull(),
    outcome: text("outcome", { enum: ["worked", "partial", "failed"] }).notNull(),
    issues: text("issues", { mode: "json" }).$type<string[]>().notNull(),
    note: text("note"),
    moderationState: text("moderation_state", { enum: ["none", "approved", "pending", "rejected"] }).notNull(),
    serverSignature: text("server_signature").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Held for review by an anomaly rule (MASTER_PLAN §6.6); held reports don't count until released. */
    held: integer("held", { mode: "boolean" }).notNull().default(false),
    // Agent strain (§6.10): counts only, all nullable.
    strainSource: text("strain_source", { enum: ["hook", "self"] }),
    strainAttempts: integer("strain_attempts"),
    strainToolErrors: integer("strain_tool_errors"),
    strainRetries: integer("strain_retries"),
    strainLoopDetected: integer("strain_loop_detected", { mode: "boolean" }),
    strainContextReset: integer("strain_context_reset", { mode: "boolean" }),
    strainOutcomeAfterReset: text("strain_outcome_after_reset", { enum: ["worked", "partial", "failed", "none"] }),
    strainEscalated: integer("strain_escalated", { mode: "boolean" }),
  },
  (t) => [
    index("reports_tool_version").on(t.toolVersionId, t.createdAt),
    index("reports_human").on(t.humanId, t.createdAt),
    index("reports_agent").on(t.agentId, t.createdAt),
    index("reports_created").on(t.createdAt),
  ],
);

/**
 * V1 (ADR 0047): one agent's verdict on another agent's field report on the same tool version. Agent B files its own
 * report with `on_report` and a fixed verdict; `byReportId` is that report (its note went through the usual
 * moderation). One verdict per human owner per report: re-filing replaces it. Counted by distinct verified owners,
 * never House or founder accounts. Fixed choices and a hash only, so nothing here is prose.
 */
export const reportVerdicts = sqliteTable(
  "report_verdicts",
  {
    id: id(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id),
    byReportId: text("by_report_id")
      .notNull()
      .references(() => reports.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    verdict: text("verdict", { enum: ["confirm", "dispute"] }).notNull(),
    evidenceSha256: text("evidence_sha256"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("report_verdicts_one_per_owner").on(t.reportId, t.humanId),
    index("report_verdicts_agent").on(t.agentId, t.updatedAt),
    index("report_verdicts_updated").on(t.updatedAt),
  ],
);

export const toolScores = sqliteTable("tool_scores", {
  toolVersionId: text("tool_version_id")
    .primaryKey()
    .references(() => toolVersions.id),
  distinctOwners: integer("distinct_owners").notNull(),
  verifiedOwners: integer("verified_owners").notNull().default(0),
  successScore: integer("success_score"),
  outcomeBreakdown: text("outcome_breakdown", { mode: "json" })
    .$type<{ worked: number; partial: number; failed: number }>()
    .notNull(),
  securityStatus: text("security_status", {
    enum: ["clear", "under_review", "flagged", "confirmed_malicious"],
  }).notNull(),
  loopRate: real("loop_rate"),
  recoversAfterResetRate: real("recovers_after_reset_rate"),
  strainReports: integer("strain_reports").notNull().default(0),
  strainHookReports: integer("strain_hook_reports").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const statusEvents = sqliteTable(
  "status_events",
  {
    id: id(),
    toolVersionId: text("tool_version_id")
      .notNull()
      .references(() => toolVersions.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    evidenceRef: text("evidence_ref"),
    createdAt: createdAt(),
  },
  (t) => [index("status_events_tool_version").on(t.toolVersionId, t.createdAt)],
);

export const publicSignals = sqliteTable(
  "public_signals",
  {
    id: id(),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    source: text("source").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("public_signals_tool").on(t.toolId)],
);

export const publisherClaims = sqliteTable("publisher_claims", {
  id: id(),
  toolId: text("tool_id")
    .notNull()
    .references(() => tools.id),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  method: text("method").notNull(),
  verifiedAt: integer("verified_at"),
  createdAt: createdAt(),
});

export const replies = sqliteTable("replies", {
  id: id(),
  toolId: text("tool_id")
    .notNull()
    .references(() => tools.id),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const disputes = sqliteTable("disputes", {
  id: id(),
  toolId: text("tool_id").references(() => tools.id),
  reportId: text("report_id").references(() => reports.id),
  openedByHumanId: text("opened_by_human_id").references(() => humans.id),
  reason: text("reason").notNull(),
  state: text("state", { enum: ["open", "resolved", "rejected"] })
    .notNull()
    .default("open"),
  resolvedAt: integer("resolved_at"),
  createdAt: createdAt(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: text("detail", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created").on(t.createdAt)],
);

/**
 * Distinct sources that ran a check, per UTC day (§7.5). The source is a salted hash (daily salt, never stored with a
 * raw IP) or an agent id, so we can count people without keeping who they are.
 */
export const checkSources = sqliteTable(
  "check_sources",
  {
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    source: text("source").notNull(),
    kind: text("kind", { enum: ["web", "api", "plugin", "cli", "mcp", "ci"] }).notNull(),
    isHouse: integer("is_house", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("check_sources_day_source_kind").on(t.day, t.source, t.kind)],
);

/**
 * How often each tool was checked per UTC day (ADR 0011 g), so reporters can see how many checks showed their
 * reports. Counts only; nothing about who checked. House checks are not counted.
 */
export const toolChecks = sqliteTable(
  "tool_checks",
  {
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    n: integer("n").notNull().default(0),
  },
  (t) => [uniqueIndex("tool_checks_tool_day").on(t.toolId, t.day)],
);

/** The proof scoreboard, one row per day and metric, written by the daily cron (§7.5, ADR 0006). */
export const proofSnapshots = sqliteTable(
  "proof_snapshots",
  {
    date: text("date").notNull(),
    metric: text("metric").notNull(),
    externalValue: real("external_value").notNull(),
    houseValue: real("house_value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("proof_snapshots_date_metric").on(t.date, t.metric)],
);

// --- The Forge Arena (code name Crucible; ADR 0012–0014) ---------------------------------------------------------

/** An event: a card, a guest bout, or a practice/dry run. Practice runs are published but never ranked. */
export const arenaEvents = sqliteTable("arena_events", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  season: text("season").notNull(),
  kind: text("kind", { enum: ["card", "guest", "practice"] }).notNull(),
  status: text("status", { enum: ["planned", "running", "done"] }).notNull(),
  /** Twist of the week, if any (applies equally to every model). */
  twist: text("twist"),
  /** Forge Lab #3 arm (lab/003-trap-cards): what was appended to the system prompt. Null for every normal event. */
  /** Lab #5 adds "card11" (trap card v1.1, lab/005-trap-card-v11-frontier). */
  arm: text("arm", { enum: ["none", "placebo", "card", "model", "card11"] }),
  createdAt: createdAt(),
});

/** One attempt of one model at one task variant. The log is the referee's JSON log; the broadcast draws only from it. */
export const arenaRuns = sqliteTable(
  "arena_runs",
  {
    id: id(),
    eventId: text("event_id")
      .notNull()
      .references(() => arenaEvents.id),
    modelId: text("model_id").notNull(),
    task: text("task").notNull(),
    seed: integer("seed").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "void"] }).notNull(),
    retries: integer("retries").notNull().default(0),
    /** Why a run was voided (provider failure mid-bout: re-run, never switched to another model). */
    voidReason: text("void_reason"),
    passed: integer("passed", { mode: "boolean" }),
    score: real("score"),
    cost: real("cost"),
    costEstimated: integer("cost_estimated", { mode: "boolean" }).notNull().default(false),
    tokens: integer("tokens"),
    provider: text("provider"),
    result: text("result", { mode: "json" }),
    log: text("log", { mode: "json" }),
    signature: text("signature"),
    /**
     * A bout suspended at a tick's deadline (ADR 0022): the attempt's checkpoint, the chat so far and the spend
     * counters, so a later tick carries on. Null for a fresh or finished run; cleared when a run is voided.
     */
    checkpoint: text("checkpoint", { mode: "json" }),
    createdAt: createdAt(),
    /** When the current tick claimed the run (null while queued). The stale-running reaper uses it. */
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /**
     * A bout on a private held-out seed (ADR 0058): never published (no brief, log, replay, clip or share card), only
     * counted in aggregates (the public-vs-held-out gap and the longitudinal panel). Set when the run is queued.
     */
    // A SQL default (not `.default(false)`), so inserts that leave it out bind no extra value (D1 allows 100 per statement).
    heldOut: integer("held_out", { mode: "boolean" }).notNull().default(sql`0`),
    /** The model string the provider reported serving (OpenRouter's `model`, or the Workers AI model id). Null before 0020. */
    modelVersion: text("model_version"),
  },
  (t) => [index("arena_runs_status").on(t.status, t.createdAt), index("arena_runs_event").on(t.eventId), index("arena_runs_model_task").on(t.modelId, t.task)],
);

/**
 * The longitudinal panel (ADR 0058, D7): one row per model version queued on the frozen held-out panel. The pinned
 * model string and provider are copied from the lineup when queued, so a later lineup change can't rewrite history.
 */
export const arenaPanel = sqliteTable(
  "arena_panel",
  {
    id: id(),
    eventId: text("event_id")
      .notNull()
      .unique()
      .references(() => arenaEvents.id),
    /** Lineup id (arena/lineup.ts). */
    modelId: text("model_id").notNull(),
    /** The exact model string sent to the provider (e.g. "anthropic/claude-sonnet-5.5"). */
    pinnedModel: text("pinned_model").notNull(),
    /** The pinned provider (OpenRouter provider slug, or "cloudflare-workers-ai"). */
    provider: text("provider").notNull(),
    /** The panel definition this row ran (packages/arena/src/contamination.ts LONGITUDINAL.version). */
    panelVersion: text("panel_version").notNull(),
    /** Bouts queued (never more than LONGITUDINAL.maxBoutsPerModel). */
    bouts: integer("bouts").notNull(),
    /** Who queued it: "admin:<human id>" or "kv". */
    queuedBy: text("queued_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("arena_panel_version").on(t.modelId, t.pinnedModel, t.provider, t.panelVersion)],
);

/** Fan votes on what is tested next (ADR 0014 §5): one vote per signed-in person per poll. Never on scoring. */
export const arenaVotes = sqliteTable(
  "arena_votes",
  {
    week: text("week").notNull(), // ISO week, e.g. 2026-W44
    kind: text("kind", { enum: ["task", "twist"] }).notNull(),
    option: text("option").notNull(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("arena_votes_one_each").on(t.week, t.kind, t.humanId)],
);

/** "Call it" daily fixtures (ADR 0014 §7): a head-to-head premiered on a set day. Its runs stay embargoed until then. */
export const arenaFixtures = sqliteTable("arena_fixtures", {
  id: id(),
  day: text("day").notNull().unique(), // YYYY-MM-DD (UTC)
  eventId: text("event_id")
    .notNull()
    .references(() => arenaEvents.id),
  task: text("task").notNull(),
  modelA: text("model_a").notNull(),
  modelB: text("model_b").notNull(),
  premiereAt: integer("premiere_at").notNull(),
  createdAt: createdAt(),
});

/** Anonymous daily pick totals (no account needed; picks themselves stay on the device). */
export const arenaPickTotals = sqliteTable(
  "arena_pick_totals",
  {
    fixtureId: text("fixture_id")
      .notNull()
      .references(() => arenaFixtures.id),
    option: text("option").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [uniqueIndex("arena_pick_totals_fixture_option").on(t.fixtureId, t.option)],
);

/**
 * Proving Ground (Open Division): a connected agent takes a bout through the Forge MCP. The server only referees:
 * state is rebuilt by replaying the stored calls on the seeded sandbox, so no untrusted code ever runs here.
 */
export const arenaPgAttempts = sqliteTable(
  "arena_pg_attempts",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    task: text("task").notNull(),
    seed: integer("seed").notNull(),
    calls: text("calls", { mode: "json" }).notNull(),
    status: text("status", { enum: ["open", "done"] }).notNull(),
    score: real("score"),
    passed: integer("passed", { mode: "boolean" }),
    result: text("result", { mode: "json" }),
    log: text("log", { mode: "json" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("arena_pg_agent").on(t.agentId, t.startedAt)],
);

/** Glicko-2 ratings for the Proving Ground ladder ("agent plus owner", never a claim about the model). */
export const arenaRatings = sqliteTable("arena_ratings", {
  subject: text("subject").primaryKey(), // agent:<id>
  rating: real("rating").notNull(),
  rd: real("rd").notNull(),
  vol: real("vol").notNull(),
  games: integer("games").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Daily usage totals (MCP sessions, tool calls, client app names). Counters only: no IP, account, agent or session
 * id is stored, so a row can't be traced to anyone. Proof of use for /stats and the ops digest.
 */
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    day: text("day").notNull(),
    key: text("key").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_daily_day_key").on(t.day, t.key)],
);

/**
 * The Gauntlet (ADR 0024): six everyday jobs in a row for any agent, no account needed. The id is unguessable and is
 * the only key to a run, so it's kept off every public list. No IP, person or agent name is stored. `cardFrom` marks
 * a measured re-run: the same six jobs on new variants with the trap card made from the first run in every brief.
 */
export const arenaGauntlets = sqliteTable(
  "arena_gauntlets",
  {
    id: id(),
    status: text("status", { enum: ["open", "done"] }).notNull(),
    cardFrom: text("card_from"),
    card: text("card"),
    /**
     * V2 (ADR 0047): the run this one challenges, a gauntlet id or `model:<id>` for a headline model's stored runs.
     * `challenge` holds the six seeds it plays and, for a model, the arena run ids those seeds came from.
     */
    challengeOf: text("challenge_of"),
    challenge: text("challenge", { mode: "json" }).$type<{ seeds: number[]; runs?: (string | null)[] }>(),
    current: integer("current").notNull().default(0),
    summary: text("summary", { mode: "json" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    /**
     * ADR 0048: SHA-256 (hex) of the run's private claim key, returned once by gauntlet_start to whoever started it.
     * Only first runs and challenges get one (null for measured re-runs and older runs). The key itself is never stored.
     */
    claimKeyHash: text("claim_key_hash").unique(),
  },
  (t) => [index("arena_gauntlets_card_from").on(t.cardFrom), index("arena_gauntlets_started").on(t.startedAt), index("arena_gauntlets_challenge_of").on(t.challengeOf)],
);

/**
 * ADR 0048: an opt-in claim of a Gauntlet run by a verified owner, for one of their agents. One claim per run (the
 * primary key). While `hidden` is false the run shows on the agent's page and its name on head-to-head pages; hidden
 * runs are anonymous again everywhere public. Unclaimed runs have no row and stay exactly as before.
 */
export const gauntletClaims = sqliteTable(
  "gauntlet_claims",
  {
    gauntletId: text("gauntlet_id")
      .primaryKey()
      .references(() => arenaGauntlets.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    claimedAt: integer("claimed_at").notNull(),
  },
  (t) => [index("gauntlet_claims_agent").on(t.agentId), index("gauntlet_claims_human").on(t.humanId)],
);

/**
 * ADR 0055: a Gauntlet season. The row is written the first time the season code runs in an environment (the release
 * date on production), with `starts_at` at that UTC midnight; `ends_at` is fixed in code (exclusive).
 */
export const gauntletSeasons = sqliteTable("gauntlet_seasons", {
  id: id(),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  createdAt: createdAt(),
});

/**
 * ADR 0055: a claimed run the owner chose to enter in a season (opt-in, separate from claiming). Leaving the season
 * deletes the row; hiding the run takes it off the board too.
 */
export const gauntletSeasonEntries = sqliteTable(
  "gauntlet_season_entries",
  {
    seasonId: text("season_id").notNull(),
    gauntletId: text("gauntlet_id")
      .notNull()
      .references(() => arenaGauntlets.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    enteredAt: integer("entered_at").notNull(),
  },
  (t) => [uniqueIndex("gauntlet_season_entries_run").on(t.seasonId, t.gauntletId), index("gauntlet_season_entries_human").on(t.humanId)],
);

/** ADR 0055: the season board frozen at the end of each week (ranks, run ids, results). Shown minus hidden runs. */
export const gauntletSeasonSnapshots = sqliteTable(
  "gauntlet_season_snapshots",
  {
    seasonId: text("season_id").notNull(),
    week: integer("week").notNull(),
    asOf: integer("as_of").notNull(),
    takenAt: integer("taken_at").notNull(),
    entries: text("entries", { mode: "json" }).notNull(),
  },
  (t) => [uniqueIndex("gauntlet_season_snapshots_week").on(t.seasonId, t.week)],
);

/** One job of a Gauntlet run. `calls` rebuild the sandbox by replay; `result` and `log` are the referee's verdict. */
export const arenaGauntletBouts = sqliteTable(
  "arena_gauntlet_bouts",
  {
    id: id(),
    gauntletId: text("gauntlet_id")
      .notNull()
      .references(() => arenaGauntlets.id),
    idx: integer("idx").notNull(),
    task: text("task").notNull(),
    seed: integer("seed").notNull(),
    calls: text("calls", { mode: "json" }).notNull(),
    status: text("status", { enum: ["open", "done"] }).notNull(),
    passed: integer("passed", { mode: "boolean" }),
    result: text("result", { mode: "json" }),
    log: text("log", { mode: "json" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [uniqueIndex("arena_gauntlet_bouts_idx").on(t.gauntletId, t.idx)],
);

/**
 * Skill scans (ADR 0026): one row per scanned text fingerprint. The text itself is never stored, only what the
 * scanner found (rule, line, a short excerpt for people) and where it came from when it was fetched from a public URL.
 * `public` rows (fetched from a public URL, or flagged) get a page at /scan/<fingerprint>; the rest only count.
 */
export const skillScans = sqliteTable(
  "skill_scans",
  {
    fingerprint: text("fingerprint").primaryKey(),
    name: text("name"),
    sourceUrl: text("source_url"),
    verdict: text("verdict", { enum: ["flagged", "caution", "clear"] }).notNull(),
    findings: text("findings", { mode: "json" }).notNull(),
    counts: text("counts", { mode: "json" }).notNull(),
    rulesVersion: text("rules_version").notNull(),
    bytes: integer("bytes").notNull(),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
    scans: integer("scans").notNull().default(1),
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
  },
  (t) => [index("skill_scans_verdict_seen").on(t.verdict, t.lastSeen), index("skill_scans_source").on(t.sourceUrl)],
);

/**
 * V5 (weekly digest without email): one private Atom feed per owner, at /feed/<token>.atom. Only a SHA-256 hash of the
 * token is stored, so the link can't be rebuilt from the database; the owner sees it once, when it's made, and can
 * revoke it (the row is deleted) or replace it from the dashboard. No email address, ever (Privacy Policy).
 */
export const digestFeeds = sqliteTable("digest_feeds", {
  humanId: text("human_id")
    .primaryKey()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

// --- Human review audits (Lab #6, ADR 0054: D8 referee audit, D12 scanner precision) ------------------------------

/**
 * A pre-drawn, frozen sample for one study ("referee" or "scanner"). Drawn once, by an admin, with the seed published
 * in lab/006-referee-and-scanner-audit/PREREGISTRATION.md; `config` keeps the frame counts per stratum, the quotas and
 * (for the scanner) the rules version under test, so the estimates can be weighted back to the frame.
 */
export const reviewSamples = sqliteTable("review_samples", {
  id: id(),
  study: text("study", { enum: ["referee", "scanner"] }).notNull().unique(),
  seed: text("seed").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  drawnBy: text("drawn_by")
    .notNull()
    .references(() => humans.id),
  drawnAt: integer("drawn_at").notNull(),
});

/**
 * One sampled item (an arena run id or a scan fingerprint). `position` is its place in the reviewers' queue (1..size);
 * reserves have none until one replaces an item whose material can't be shown. `truth` is the referee's or scanner's
 * verdict as it stood at the draw, kept here so a later re-score can't move the target; it's never shown before an
 * answer is saved.
 */
export const reviewItems = sqliteTable(
  "review_items",
  {
    sampleId: text("sample_id")
      .notNull()
      .references(() => reviewSamples.id),
    itemId: text("item_id").notNull(),
    cell: text("cell").notNull(),
    sub: text("sub").notNull(),
    /** Order inside its cell's seeded round-robin sequence (1 = drawn first). */
    rank: integer("rank").notNull(),
    position: integer("position"),
    status: text("status", { enum: ["active", "reserve", "unavailable"] }).notNull(),
    replacedBy: text("replaced_by"),
    truth: text("truth", { mode: "json" }).notNull(),
  },
  (t) => [uniqueIndex("review_items_pk").on(t.sampleId, t.itemId), uniqueIndex("review_items_position").on(t.sampleId, t.position), index("review_items_cell").on(t.sampleId, t.cell, t.rank)],
);

/** One label per reviewer per item. Several reviewers may label the same item (inter-rater agreement). */
export const reviewLabels = sqliteTable(
  "review_labels",
  {
    sampleId: text("sample_id")
      .notNull()
      .references(() => reviewSamples.id),
    itemId: text("item_id").notNull(),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => humans.id),
    /** Referee: passed | failed | unclear. Scanner: risky | benign | unsure (the blind answer, locked once revealed). */
    answer: text("answer").notNull(),
    /** Referee: the trap ids the reviewer saw sprung ([] = none). */
    traps: text("traps", { mode: "json" }),
    /** Scanner, after the reveal: per matched rule, "correct" or "fp". */
    ruleMarks: text("rule_marks", { mode: "json" }),
    note: text("note"),
    /** Referee: the reviewer opened the public replay (which shows the verdict) before answering. */
    sawReplay: integer("saw_replay", { mode: "boolean" }).notNull().default(false),
    /** Scanner: when the verdict was revealed (the blind answer can't change after this). */
    revealedAt: integer("revealed_at"),
    /** Seconds from the item's page to the save, capped at an hour: the measured reviewer time. */
    seconds: integer("seconds"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("review_labels_one_each").on(t.sampleId, t.itemId, t.reviewerId), index("review_labels_reviewer").on(t.sampleId, t.reviewerId)],
);
