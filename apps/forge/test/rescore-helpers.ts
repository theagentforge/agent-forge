import { env } from "cloudflare:workers";
import { applyJobFor, approveApply, RESCORE_JOB_KEY, rescoreTick, type RescoreJob } from "../src/arena/rescore-job";

/**
 * The gated apply path (B2-01, ADR 0088): a finished dry report of published runs, the admin's approval of it, then the
 * apply job that approval allows. Returns the apply job queued (not yet run).
 */
export async function queueApprovedApply(scope: { events: string[]; tasks?: string[] }): Promise<RescoreJob> {
  await env.KV.put(RESCORE_JOB_KEY, JSON.stringify({ ...scope, mode: "dry", publicOnly: true } satisfies RescoreJob));
  let r = await rescoreTick(env);
  for (let i = 0; r && !r.done && i < 50; i++) r = await rescoreTick(env);
  if (!(await approveApply(env, "admin:test"))) throw new Error("approval refused");
  const job = (await applyJobFor(env))!;
  await env.KV.put(RESCORE_JOB_KEY, JSON.stringify(job));
  return job;
}
