import type { Env } from "./env.js";
import { route } from "./router.js";
import { handleScheduled } from "./scheduled.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /**
   * The hourly evaluation (design §8), at `7 * * * *`.
   *
   * Offset from `metering-worker`'s `5 * * * *` so the two do not contend for
   * the same Hyperdrive pool at the top of the hour.
   *
   * `controller.scheduledTime` rather than `new Date()`: the whole evaluation
   * path takes `asOf` as a parameter, and taking it from the scheduler means a
   * tick that starts late still measures the window it was scheduled for.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env, new Date(controller.scheduledTime)).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
