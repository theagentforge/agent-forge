import { runCycle } from "./poll";

// ADR 0151: the live drift monitor Worker. Cron only (wrangler.jsonc). Everything it may send is in mcp-client.ts.
export default {
  async scheduled(controller, env) {
    const r = await runCycle(env, controller.scheduledTime);
    console.log("drift_monitor_run", JSON.stringify(r));
  },
} satisfies ExportedHandler<Env>;
