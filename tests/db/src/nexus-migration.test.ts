// NX1 — verification of the nexus/channels migrations (200–240).
//
// These assertions are not "the SQL parses". They are the schema-level
// statements of the epic's three invariants, pinned so that a later edit that
// quietly removes one fails here rather than in a customer's determination
// history:
//
//   * the dedupe unique index exists and covers exactly the four columns the
//     backfill/live-sync overlap depends on (design §6.3–§6.4);
//   * the alert index is unique, because it IS the exactly-once guarantee;
//   * `rule_sets`/`rules` carry no `org_id` — the one deliberate exemption
//     from tenant scoping, which the CI scan of NX3 exempts *by name*;
//   * every other nexus table carries `org_id UUID NOT NULL`;
//   * no monetary column is NUMERIC or a float anywhere in the context.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

const NEXUS_MIGRATION_IDS = [
  "200_nexus_core",
  "210_nexus_ingestion",
  "220_nexus_rules",
  "230_nexus_determinations",
  "240_nexus_registrations",
] as const;

function sqlFor(id: string): string {
  const entry = manifest.migrations.find((m) => m.id === id);
  if (!entry) throw new Error(`migration ${id} is not in the manifest`);
  return readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8");
}

const ALL_NEXUS_SQL = NEXUS_MIGRATION_IDS.map(sqlFor).join("\n");

/** The same SQL with `--` comment text removed, for assertions about types
 *  rather than about prose. The comments in these migrations carry the design
 *  rationale and use English words that collide with SQL keywords. */
const ALL_NEXUS_SQL_NO_COMMENTS = ALL_NEXUS_SQL.replace(/--[^\n]*/g, "");

describe("nexus migrations (NX1)", () => {
  describe("manifest registration", () => {
    it("registers 'nexus' and 'channels' as bounded contexts", () => {
      expect(BOUNDED_CONTEXTS).toContain("nexus");
      expect(BOUNDED_CONTEXTS).toContain("channels");
    });

    it("registers all five migrations", () => {
      const ids = manifest.migrations.map((m) => m.id);
      for (const id of NEXUS_MIGRATION_IDS) expect(ids).toContain(id);
    });

    it("claims the 200 decade and keeps the manifest sorted", () => {
      const ids = manifest.migrations.map((m) => m.id);
      expect([...ids].sort()).toEqual(ids);
      for (const id of NEXUS_MIGRATION_IDS) {
        expect(ids.indexOf(id)).toBeGreaterThan(
          ids.indexOf("190_integrations_delivery_attribution"),
        );
      }
    });

    it("manifest checksums match the on-disk up.sql files", () => {
      for (const id of NEXUS_MIGRATION_IDS) {
        const entry = manifest.migrations.find((m) => m.id === id)!;
        const content = readFileSync(resolve(MIGRATIONS_ROOT, entry.path));
        expect(entry.checksum).toBe(
          createHash("sha256").update(content).digest("hex"),
        );
      }
    });

    it("attributes the inbox to the channels context and the rest to nexus", () => {
      const byId = new Map(manifest.migrations.map((m) => [m.id, m.context]));
      expect(byId.get("210_nexus_ingestion")).toBe("channels");
      for (const id of NEXUS_MIGRATION_IDS) {
        if (id === "210_nexus_ingestion") continue;
        expect(byId.get(id)).toBe("nexus");
      }
    });
  });

  describe("idempotent application", () => {
    it("uses IF NOT EXISTS on every CREATE", () => {
      const creates = ALL_NEXUS_SQL_NO_COMMENTS.match(
        /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|SCHEMA)\s+(?!IF NOT EXISTS)/gi,
      );
      expect(creates).toBeNull();
    });

    it("ships no down.sql", () => {
      for (const id of NEXUS_MIGRATION_IDS) {
        const entry = manifest.migrations.find((m) => m.id === id)!;
        expect(entry.path.endsWith("up.sql")).toBe(true);
      }
    });
  });

  describe("invariant 1 — money is integer cents", () => {
    it("declares every monetary column BIGINT", () => {
      const centsColumns = [...ALL_NEXUS_SQL_NO_COMMENTS.matchAll(/^\s*(\w*_cents)\s+(\w+)/gim)];
      expect(centsColumns.length).toBeGreaterThan(0);
      for (const [, name, type] of centsColumns) {
        expect({ name, type: type!.toUpperCase() }).toEqual({
          name,
          type: "BIGINT",
        });
      }
    });

    it("uses no NUMERIC, DECIMAL, REAL, or DOUBLE anywhere in the context", () => {
      expect(ALL_NEXUS_SQL_NO_COMMENTS).not.toMatch(
        /\b(NUMERIC|DECIMAL|REAL|DOUBLE PRECISION|FLOAT)\b/i,
      );
    });
  });

  describe("invariant 2 — the ledger is append-only", () => {
    it("declares no UPDATE, trigger, or rule against the ledger", () => {
      expect(ALL_NEXUS_SQL_NO_COMMENTS).not.toMatch(/\bUPDATE\s+nexus\.sale_events\b/i);
      expect(ALL_NEXUS_SQL_NO_COMMENTS).not.toMatch(
        /\bCREATE\s+(OR REPLACE\s+)?(TRIGGER|RULE)\b/i,
      );
    });

    it("constrains a refund to reverse something and a sale to reverse nothing", () => {
      const sql = sqlFor("200_nexus_core");
      expect(sql).toContain("nexus_sale_events_refund_reverses_ck");
      expect(sql).toMatch(/kind\s*=\s*'refund'\)\s*=\s*\(reverses_event_id IS NOT NULL\)/);
    });

    it("constrains refund amounts to be non-positive and sale amounts non-negative", () => {
      // A refund carrying positive cents would inflate the measurement it is
      // supposed to reduce, and SUM is sign-blind by design, so nothing
      // downstream would ever notice.
      const sql = sqlFor("200_nexus_core");
      expect(sql).toContain("nexus_sale_events_refund_sign_ck");
      expect(sql).toContain("nexus_sale_events_sale_sign_ck");
    });
  });

  describe("invariant 3 — a determination is reproducible", () => {
    it("stores the reproducibility triple and the inputs, all NOT NULL", () => {
      const sql = sqlFor("230_nexus_determinations");
      for (const col of [
        "rule_set_version",
        "rule_id",
        "engine_version",
        "inputs",
      ]) {
        expect(sql).toMatch(new RegExp(`${col}\\s+\\w+.*NOT NULL`, "i"));
      }
    });

    it("keeps 'no_obligation' distinct from 'clear' in the status CHECK", () => {
      const sql = sqlFor("230_nexus_determinations");
      expect(sql).toContain("'no_obligation'");
      expect(sql).toContain("'clear'");
    });

    it("ties crossed_on to a crossed-or-beyond status", () => {
      const sql = sqlFor("230_nexus_determinations");
      expect(sql).toContain("nexus_determinations_crossed_ck");
    });
  });

  describe("idempotency guarantees are constraints, not code", () => {
    it("dedupes the ledger on (org_id, channel_id, provider_event_id, kind)", () => {
      const sql = sqlFor("200_nexus_core");
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS nexus_sale_events_dedupe_idx\s+ON nexus\.sale_events \(org_id, channel_id, provider_event_id, kind\)/,
      );
    });

    it("dedupes inbound deliveries on (provider, provider_delivery_id)", () => {
      const sql = sqlFor("210_nexus_ingestion");
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS nexus_inbound_deliveries_dedupe_idx\s+ON nexus\.inbound_deliveries \(provider, provider_delivery_id\)/,
      );
    });

    it("makes the alert-once guarantee a UNIQUE index", () => {
      const sql = sqlFor("240_nexus_registrations");
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS nexus_alerts_once_idx\s+ON nexus\.alerts \(org_id, jurisdiction, determination_id, kind\)/,
      );
    });

    it("serves the single-scan aggregate from one index", () => {
      const sql = sqlFor("200_nexus_core");
      expect(sql).toMatch(
        /nexus_sale_events_agg_idx\s+ON nexus\.sale_events \(org_id, jurisdiction, occurred_at DESC\)/,
      );
    });
  });

  describe("tenancy", () => {
    // Every table in the context, and whether it is tenant-scoped. The three
    // exemptions are each deliberate and each has its reason in the SQL.
    const TENANT_SCOPED = [
      "nexus.channels",
      "nexus.sale_events",
      "nexus.determinations",
      "nexus.registrations",
      "nexus.alerts",
      "nexus.evaluation_watermarks",
    ];
    const EXEMPT = ["nexus.rule_sets", "nexus.rules", "nexus.inbound_deliveries"];

    it("enumerates every created table, so a new one cannot slip past this test", () => {
      const created = [...ALL_NEXUS_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (nexus\.\w+)/g)]
        .map((m) => m[1]!)
        .sort();
      expect(created).toEqual([...TENANT_SCOPED, ...EXEMPT].sort());
    });

    it("declares org_id UUID NOT NULL on every tenant-scoped table", () => {
      for (const table of TENANT_SCOPED) {
        const body = tableBody(ALL_NEXUS_SQL, table);
        expect({ table, hasOrg: /org_id\s+UUID(\s+PRIMARY KEY|\s+NOT NULL)/i.test(body) })
          .toEqual({ table, hasOrg: true });
      }
    });

    it("keeps global reference data free of org_id, by name", () => {
      // design §3.3: rule_sets/rules are shared global reference data. The CI
      // scan of NX3 exempts them BY NAME, never by pattern — so the absence
      // has to be asserted, not assumed.
      for (const table of ["nexus.rule_sets", "nexus.rules"]) {
        expect({ table, hasOrg: /org_id/.test(tableBody(ALL_NEXUS_SQL, table)) })
          .toEqual({ table, hasOrg: false });
      }
    });

    it("allows a nullable org_id only on the inbox, and says why in the SQL", () => {
      const sql = sqlFor("210_nexus_ingestion");
      expect(sql).toMatch(/org_id\s+UUID,/);
      expect(sql).toMatch(/NULL until the (cron )?drain attributes/i);
    });

    it("references no other bounded context's schema", () => {
      for (const ref of ["membership.", "identity.", "billing.", "projects.", "integrations."]) {
        expect(ALL_NEXUS_SQL_NO_COMMENTS).not.toContain(ref);
      }
    });
  });

  describe("rules are data, not code", () => {
    it("ties threshold_logic to the threshold columns it needs", () => {
      // A 'sales_only' rule with a null sales threshold divides the meter by
      // null and renders as 0% — confidently wrong, which is the one output
      // this product cannot ship.
      const sql = sqlFor("220_nexus_rules");
      expect(sql).toContain("nexus_rules_threshold_logic_ck");
      expect(sql).toMatch(/threshold_logic = 'none'\s*\n\s*AND sales_threshold_cents IS NULL AND transaction_threshold IS NULL/);
    });

    it("carries a measurement timezone so a UTC row lands in the right year", () => {
      const sql = sqlFor("220_nexus_rules");
      expect(sql).toMatch(/measurement_timezone\s+TEXT NOT NULL/);
    });

    it("constrains the deadline rule to the known tagged-union kinds", () => {
      const sql = sqlFor("220_nexus_rules");
      expect(sql).toContain("nexus_rules_deadline_kind_ck");
      for (const kind of [
        "days_after_crossing",
        "first_of_next_month",
        "end_of_next_month",
        "first_of_next_quarter",
        "first_of_month_after_days",
        "none",
      ]) {
        expect(sql).toContain(`'${kind}'`);
      }
    });

    it("allows one rule per (rule set, jurisdiction, effective_from)", () => {
      const sql = sqlFor("220_nexus_rules");
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS nexus_rules_set_jurisdiction_from_idx/,
      );
    });
  });
});

/** The column list of a `CREATE TABLE IF NOT EXISTS <name> ( … );` block. */
function tableBody(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`table ${table} is not created in these migrations`);
  const end = sql.indexOf("\n);", start);
  if (end < 0) throw new Error(`table ${table} has no terminating );`);
  return sql.slice(start, end);
}
