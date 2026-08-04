import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      status: "ok",
      service: "nexus-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: {
        database: { configured: !!env.PLATFORM_DB },
        membership: { configured: !!env.MEMBERSHIP_WORKER },
        policy: { configured: !!env.POLICY_WORKER },
        events: { configured: !!env.EVENTS_WORKER },
        notifications: { configured: !!env.NOTIFICATIONS_WORKER },
      },
    },
    requestId,
  );
}
