// `nexara demo seed` — stand up the demo tenant's ledger.
//
// The seeding path is the **product's own public API**: a CSV channel is
// created through `channels.createManual`, and the ledger is written through
// `ledger.import`. There is no seeding backdoor, and that is the point — a
// demo that used a private path would prove only that the demo works. This
// proves that the import works, which is what a real customer's first day
// looks like.
//
// Two consequences worth naming:
//
//   * Re-running is safe. The dedupe index makes a second seed a no-op, and
//     the command reports `duplicates` rather than hiding them, so "I ran it
//     twice" is visible instead of doubling every threshold.
//   * The generated ledger is deterministic (see `../demo/ledger.ts`), so the
//     board it produces is a property rather than a coincidence. Texas is
//     crossed because the numbers say so, every time.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";
import { DEMO_PLAN, DEMO_NO_OBLIGATION, generateDemoLedger } from "../demo/ledger.js";

/** Import in batches, so a large seed is not one enormous request. */
const BATCH = 250;

function strFlag(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

export async function demoSeedCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);

  // `--as-of` is a parameter rather than a clock read, for the same reason the
  // engine takes one: a demo you can reproduce next week is worth more than a
  // demo that is subtly different every time you show it.
  const asOfFlag = strFlag(ctx.flags["as-of"]);
  if (asOfFlag && Number.isNaN(Date.parse(asOfFlag))) {
    throw new UsageError(`--as-of must be an ISO-8601 timestamp (got ${asOfFlag})`);
  }
  const asOf = asOfFlag ? new Date(asOfFlag) : new Date();

  const client = await ctx.sdk();

  // Two channels, because the demo's story includes a channel mid-backfill
  // next to a finished one. Both are CSV channels: an OAuth connect needs a
  // real provider account, and a demo that cannot be seeded without one is a
  // demo nobody runs.
  const channels = await Promise.all(
    [
      { displayName: "Demo Storefront (Shopify export)", externalAccountId: "demo-shopify" },
      { displayName: "Demo Payments (Stripe export)", externalAccountId: "demo-stripe" },
    ].map(async (input) => {
      try {
        const created = await client.channels.createManual(orgId, input);
        return created.channel;
      } catch (e) {
        // A 409 means the demo has been seeded before. Find the existing
        // channel rather than failing — re-seeding must be safe.
        const existing = await client.channels.list(orgId);
        const match = existing.channels.find(
          (c) => c.externalAccountId === input.externalAccountId,
        );
        if (!match) throw e;
        return match;
      }
    }),
  );

  const events = generateDemoLedger({
    asOf,
    shopifyChannelId: channels[0]!.id,
    stripeChannelId: channels[1]!.id,
  });

  let submitted = 0;
  let applied = 0;
  let duplicates = 0;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const result = await client.ledger.import(
      orgId,
      { events: batch },
      // A stable key per batch, so an interrupted seed resumes rather than
      // re-appending. `applied + duplicates === submitted` either way.
      { idempotencyKey: `demo-seed-${asOf.toISOString().slice(0, 10)}-${i}` },
    );
    submitted += result.submitted;
    applied += result.applied;
    duplicates += result.duplicates;
  }

  // A registration for California, so the board shows `registered` next to
  // `crossed` — the two look nothing alike and a demo should prove it.
  await client.registrations.upsert(orgId, {
    jurisdiction: "US-CA",
    status: "active",
    registeredOn: new Date(asOf.getTime() - 150 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    permitRef: "DEMO-CA-SR-88213",
  });

  const evaluation = await client.exposure.evaluate(orgId, { asOf: asOf.toISOString() });

  const summary = {
    asOf: asOf.toISOString(),
    channels: channels.map((c) => c.id),
    submitted,
    applied,
    duplicates,
    jurisdictions: [...DEMO_PLAN.map((p) => p.jurisdiction), DEMO_NO_OBLIGATION.jurisdiction],
    evaluated: evaluation.evaluated,
    positionsChanged: evaluation.determinations.length,
    ruleSetVersion: evaluation.ruleSetVersion,
    ruleSetVerified: evaluation.ruleSetVerified,
  };

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: summary }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        as_of: summary.asOf,
        events_submitted: String(submitted),
        events_applied: String(applied),
        // Not an error. A non-zero count here on a re-seed is the dedupe index
        // doing its job, and hiding it would make a double-seed invisible.
        duplicates_skipped: String(duplicates),
        jurisdictions: summary.jurisdictions.join(", "),
        positions_changed: String(summary.positionsChanged),
        rule_set: `${summary.ruleSetVersion}${summary.ruleSetVerified ? "" : " (unverified)"}`,
      },
    }),
  );

  if (!summary.ruleSetVerified) {
    ctx.stderr(
      "! The seeded rule set is UNVERIFIED, by design. Every determination is " +
        "internal-only and the console shows the §11 banner instead of a status. " +
        "That is the demo working, not the demo broken.",
    );
  }
  return { exitCode: 0 };
}
