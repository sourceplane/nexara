import type { Env } from "../env.js";
import { successResponse } from "../http.js";
import { resolveProvider } from "../providers/registry.js";

export function handleHealth(env: Env, requestId: string): Response {
  return successResponse(
    {
      status: "ok",
      service: "channels-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: {
        database: { configured: !!env.PLATFORM_DB },
        membership: { configured: !!env.MEMBERSHIP_WORKER },
        policy: { configured: !!env.POLICY_WORKER },
        events: { configured: !!env.EVENTS_WORKER },
        connectState: { configured: !!env.CONNECT_STATE_SECRET },
        encryption: { configured: !!env.SECRET_ENCRYPTION_KEY },
        // Reported per provider rather than as one boolean: "channels are
        // configured" is not a fact, it is a fact per provider, and an
        // operator debugging a parked connect flow needs to know which.
        providers: {
          stripe: { configured: resolveProvider(env, "stripe") !== null },
          shopify: { configured: resolveProvider(env, "shopify") !== null },
        },
      },
    },
    requestId,
  );
}
