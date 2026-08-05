"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { readStoredToken } from "@/lib/session";
import { readLastOrgSlug, defaultOrgDestination } from "@/lib/last-org";

/**
 * App entry.
 *
 * Signed in → the last-used org's exposure board, so a returning seller lands
 * on the answer rather than on a menu. No remembered org → `/onboarding`,
 * which forwards to an existing org or creates the first one.
 *
 * Signed OUT → the storefront at `/nexara`, not `/login`. A bare credential
 * form tells a first-time visitor nothing about what they are signing in to;
 * the storefront says what the product measures and what it deliberately does
 * not do, and its own "Start free" hands off to `/login`. Anyone who wants the
 * form directly still has the URL, and every authenticated route keeps its own
 * `useRequireAuth` guard — this is a landing choice, not an auth boundary.
 *
 * localStorage is client-only, so this resolves on the client and replaces
 * history (no extra entry).
 */
export default function HomePage() {
  const router = useRouter();
  React.useEffect(() => {
    const dest = readStoredToken() ? defaultOrgDestination(readLastOrgSlug()) : "/nexara";
    router.replace(dest);
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}
