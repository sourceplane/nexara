// R10 — where a seller's threshold alerts go.
//
// NX5 shipped the alert path with a per-environment `NEXUS_ALERT_EMAIL` and
// called it a stopgap in writing: the right answer is that a seller names
// their own tax contact, and the console is the place to ask. These are the
// endpoint's half of that closure. The precedence itself — seller's contact
// over the environment default, a failed lookup degrading to the default
// rather than losing the determination — is asserted in `evaluation.test.ts`,
// where the alert is actually raised.
//
// The property this file cares about most is the **three-way** read. A single
// null cannot distinguish "alerts go nowhere" from "alerts go somewhere you
// did not choose", and telling a seller the wrong one of those is worse than
// telling them nothing.

import {
  handleClearAlertContact,
  handleGetAlertContact,
  handleSetAlertContact,
} from "@nexus-worker/handlers/alert-contact";
import type { Env } from "@nexus-worker/env";
import type { AlertContactRow, NexusRepository, NexusResult } from "@saas/db/nexus";

const ORG_UUID = "00000000-0000-4000-8000-000000000001";
const ORG = ORG_UUID as never;
const ACTOR = { subjectId: "usr_1", subjectType: "user" };

const ok = <T>(value: T): NexusResult<T> => ({ ok: true, value });

function membershipStub(role: string | null): Fetcher {
  return {
    async fetch(_input: RequestInfo, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body ?? "{}")) as { orgId?: string };
      if (role === null || body.orgId !== ORG_UUID) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return Response.json({
        data: {
          memberships: [
            { kind: "role_assignment", role, scope: { kind: "organization", orgId: ORG_UUID } },
          ],
        },
      });
    },
  } as unknown as Fetcher;
}

const MATRIX: Record<string, Set<string>> = {
  owner: new Set(["organization.nexus.read", "organization.nexus.evaluate"]),
  builder: new Set(["organization.nexus.read", "organization.nexus.evaluate"]),
  // A viewer reads the board and cannot change who is told about it.
  viewer: new Set(["organization.nexus.read"]),
};

function policyStub(): Fetcher {
  return {
    async fetch(_input: RequestInfo, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
        context?: { memberships?: Array<{ role?: string }> };
      };
      const role = body.context?.memberships?.[0]?.role ?? "";
      const allow = MATRIX[role]?.has(body.action ?? "") ?? false;
      return Response.json({ data: { allow, reason: allow ? role : "no_matching_role" } });
    },
  } as unknown as Fetcher;
}

function envFor(role: string | null, alertEmail?: string): Env {
  const env: Env = {
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: membershipStub(role),
    POLICY_WORKER: policyStub(),
    ENVIRONMENT: "test",
  };
  if (alertEmail !== undefined) env.NEXUS_ALERT_EMAIL = alertEmail;
  return env;
}

const CONTACT: AlertContactRow = {
  orgId: ORG_UUID,
  email: "bookkeeper@acme.test",
  label: "Our bookkeeper",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

function repoDouble(initial: AlertContactRow | null) {
  let current = initial;
  const deletes: number[] = [];
  const repo = {
    getAlertContact: async () => ok(current),
    upsertAlertContact: async (_org: never, input: { email: string; label: string | null; now: Date }) => {
      current = {
        orgId: ORG_UUID,
        email: input.email,
        label: input.label,
        createdAt: current?.createdAt ?? input.now,
        updatedAt: input.now,
      };
      return ok(current);
    },
    deleteAlertContact: async () => {
      deletes.push(1);
      const existed = current !== null;
      current = null;
      return ok(existed);
    },
  } as unknown as NexusRepository;
  return { repo, deletes, get current() { return current; } };
}

const NOW = () => new Date("2026-08-04T12:00:00.000Z");

async function json(res: Response): Promise<Record<string, never>> {
  return (await res.json()) as Record<string, never>;
}

describe("GET alert contact — three states, not two", () => {
  it("returns the seller's own contact when one is set", async () => {
    const { repo } = repoDouble(CONTACT);
    const res = await handleGetAlertContact(envFor("viewer"), "req_1", ACTOR, ORG, { repo });
    expect(res.status).toBe(200);
    const body = (await json(res)) as unknown as {
      data: { contact: { email: string; label: string }; hasEnvironmentFallback: boolean };
    };
    expect(body.data.contact.email).toBe("bookkeeper@acme.test");
    expect(body.data.contact.label).toBe("Our bookkeeper");
  });

  it("reports the environment fallback separately from the contact", async () => {
    // The middle state. Without `hasEnvironmentFallback`, a console reading a
    // null contact would tell this seller nobody is being told — which is
    // false, and the opposite mistake is worse.
    const { repo } = repoDouble(null);
    const res = await handleGetAlertContact(
      envFor("viewer", "ops@nexara.test"),
      "req_1",
      ACTOR,
      ORG,
      { repo },
    );
    const body = (await json(res)) as unknown as {
      data: { contact: null; hasEnvironmentFallback: boolean };
    };
    expect(body.data.contact).toBeNull();
    expect(body.data.hasEnvironmentFallback).toBe(true);
  });

  it("reports no fallback when the environment has none", async () => {
    const { repo } = repoDouble(null);
    const res = await handleGetAlertContact(envFor("viewer"), "req_1", ACTOR, ORG, { repo });
    const body = (await json(res)) as unknown as {
      data: { contact: null; hasEnvironmentFallback: boolean };
    };
    expect(body.data.contact).toBeNull();
    expect(body.data.hasEnvironmentFallback).toBe(false);
  });

  it("treats a whitespace-only fallback as no fallback", async () => {
    const { repo } = repoDouble(null);
    const res = await handleGetAlertContact(envFor("viewer", "   "), "req_1", ACTOR, ORG, { repo });
    const body = (await json(res)) as unknown as { data: { hasEnvironmentFallback: boolean } };
    expect(body.data.hasEnvironmentFallback).toBe(false);
  });
});

describe("PUT alert contact", () => {
  const put = (body: unknown) =>
    new Request("https://n/x", { method: "PUT", body: JSON.stringify(body) });

  it("saves a normalised address", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put({ email: "  Finance@ACME.test ", label: " Finance " }),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(200);
    // Trimmed and lowercased, so a capitalised entry does not become a
    // recipient that differs from the one an operator searches for.
    expect(double.current?.email).toBe("finance@acme.test");
    expect(double.current?.label).toBe("Finance");
  });

  it("accepts an omitted label as null rather than the string 'undefined'", async () => {
    const double = repoDouble(null);
    await handleSetAlertContact(
      put({ email: "a@b.co" }),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(double.current?.label).toBeNull();
  });

  it("treats a blank label as no label", async () => {
    const double = repoDouble(null);
    await handleSetAlertContact(
      put({ email: "a@b.co", label: "   " }),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(double.current?.label).toBeNull();
  });

  it.each([
    ["missing", {}],
    ["not a string", { email: 42 }],
    ["no at-sign", { email: "nobody" }],
    ["no domain dot", { email: "a@b" }],
    ["whitespace inside", { email: "a b@c.co" }],
    ["absurdly long", { email: `${"a".repeat(250)}@b.co` }],
  ])("422s an email that is %s", async (_what, body) => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put(body),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(422);
    expect(double.current).toBeNull();
  });

  it("422s a label past the length bound", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put({ email: "a@b.co", label: "x".repeat(81) }),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(422);
  });

  it("422s a malformed body without touching the repository", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      new Request("https://n/x", { method: "PUT", body: "{" }),
      envFor("owner"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(422);
    expect(double.current).toBeNull();
  });

  // Validation runs BEFORE the gate here, deliberately: a malformed body is
  // not an authorization question, and consulting membership to reject it
  // would spend two subrequests on a typo. The gate still runs before any
  // write, which is what matters.
  it("denies a viewer as 404 — deny-as-not-found, not 403", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put({ email: "a@b.co" }),
      envFor("viewer"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(404);
    expect(double.current).toBeNull();
  });

  it("allows a builder — running the product includes saying who is told", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put({ email: "a@b.co" }),
      envFor("builder"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(200);
  });

  it("denies a non-member entirely", async () => {
    const double = repoDouble(null);
    const res = await handleSetAlertContact(
      put({ email: "a@b.co" }),
      envFor(null),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo, now: NOW },
    );
    expect(res.status).toBe(404);
    expect(double.current).toBeNull();
  });
});

describe("DELETE alert contact", () => {
  it("clears the contact and reports the fallback that now applies", async () => {
    const double = repoDouble(CONTACT);
    const res = await handleClearAlertContact(
      envFor("owner", "ops@nexara.test"),
      "req_1",
      ACTOR,
      ORG,
      { repo: double.repo },
    );
    expect(res.status).toBe(200);
    expect(double.current).toBeNull();
    const body = (await json(res)) as unknown as {
      data: { contact: null; hasEnvironmentFallback: boolean };
    };
    expect(body.data.contact).toBeNull();
    expect(body.data.hasEnvironmentFallback).toBe(true);
  });

  it("is idempotent — clearing a contact that was never set is success", async () => {
    const double = repoDouble(null);
    const res = await handleClearAlertContact(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: double.repo,
    });
    expect(res.status).toBe(200);
  });

  it("denies a viewer", async () => {
    const double = repoDouble(CONTACT);
    const res = await handleClearAlertContact(envFor("viewer"), "req_1", ACTOR, ORG, {
      repo: double.repo,
    });
    expect(res.status).toBe(404);
    expect(double.current).not.toBeNull();
  });
});
