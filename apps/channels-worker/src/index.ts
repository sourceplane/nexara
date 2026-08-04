import type { Env } from "./env.js";
import { route } from "./router.js";
import { drainInbox } from "./drain.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * The inbox drain, every minute — the same cadence as the outbound webhooks
   * dispatcher, because the two are the same problem in opposite directions.
   *
   * `controller.scheduledTime` rather than a fresh clock read: the retention
   * sweep's predicate is relative to `now`, and a tick that starts late should
   * purge the window it was scheduled for, not a slightly different one.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) return;
    const now = new Date(controller.scheduledTime);
    const executor = createSqlExecutor(env.PLATFORM_DB);
    ctx.waitUntil(
      drainInbox(executor, env, now)
        .then((summary) => {
          // Design §12: a delivery reaching terminal `failed` is a permanently
          // dropped sale and therefore a wrong board — and the drain's own
          // retries make it look like a success path until attempt five. Ids
          // and counts only; never a payload.
          if (summary.failed > 0 || summary.divergent > 0 || summary.applied > 0) {
            console.warn(JSON.stringify({ level: "info", msg: "channels.drain_tick", ...summary }));
          }
        })
        .catch(() => undefined)
        .finally(() => executor.dispose()),
    );
  },
} satisfies ExportedHandler<Env>;
