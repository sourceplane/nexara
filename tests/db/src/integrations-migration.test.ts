import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations",
);

describe("Integrations Migration Verification", () => {
  const integrationsMigrations = manifest.migrations.filter(
    (m) => m.context === "integrations",
  );

  it("registers 'integrations' as a bounded context", () => {
    expect(BOUNDED_CONTEXTS).toContain("integrations");
  });

  it("has the 180_integrations_foundation migration", () => {
    expect(integrationsMigrations.map((m) => m.id)).toContain(
      "180_integrations_foundation",
    );
  });

  // NX1 claimed the 200 decade, so "at the tail" is no longer true and would
  // have to be rewritten by every future context. What the assertion is
  // actually protecting is the ORDER — 190 alters a table 180 creates — so
  // assert that directly instead of a position that decays.
  it("orders 190 immediately after 180, and both after every platform context", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const foundation = ids.indexOf("180_integrations_foundation");
    const attribution = ids.indexOf("190_integrations_delivery_attribution");

    expect(foundation).toBeGreaterThanOrEqual(0);
    expect(attribution).toBe(foundation + 1);

    // Nothing outside the integrations context sits between them or before
    // 180 in a later decade.
    const laterNonProduct = manifest.migrations
      .slice(0, foundation)
      .filter((m) => m.id >= "180_");
    expect(laterNonProduct).toEqual([]);
  });

  it("manifest checksums match the on-disk up.sql files", () => {
    for (const id of ["180_integrations_foundation", "190_integrations_delivery_attribution"]) {
      const entry = manifest.migrations.find((m) => m.id === id)!;
      const content = readFileSync(resolve(MIGRATIONS_ROOT, entry.path));
      const checksum = createHash("sha256").update(content).digest("hex");
      expect(entry.checksum).toBe(checksum);
    }
  });

  it("190 adds the connection pointer additively and idempotently", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "190_integrations_delivery_attribution/up.sql"),
      "utf-8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS connection_id UUID");
    expect(sql).toContain("idx_integrations_inbound_deliveries_connection");
    expect(sql).toContain("WHERE connection_id IS NOT NULL");
  });

  describe("integrations SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "180_integrations_foundation/up.sql"),
      "utf-8",
    );

    it("creates the integrations schema", () => {
      expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS integrations");
    });

    it("creates the five foundation tables", () => {
      expect(sql).toContain("integrations.connections");
      expect(sql).toContain("integrations.github_installations");
      expect(sql).toContain("integrations.repo_links");
      expect(sql).toContain("integrations.inbound_deliveries");
      expect(sql).toContain("integrations.installation_tokens");
    });

    it("is idempotent (IF NOT EXISTS on every CREATE)", () => {
      const creates = sql.match(/^CREATE (TABLE|SCHEMA|INDEX|UNIQUE INDEX)/gm) ?? [];
      const guarded = sql.match(/^CREATE (?:TABLE|SCHEMA|INDEX|UNIQUE INDEX) IF NOT EXISTS/gm) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      expect(guarded.length).toBe(creates.length);
    });

    it("enforces the delivery idempotency ledger (unique provider + delivery_key)", () => {
      expect(sql).toContain("uq_integrations_inbound_delivery_key");
      expect(sql).toMatch(/ON integrations\.inbound_deliveries \(provider, delivery_key\)/);
    });

    it("enforces one active connection per (org, provider, account)", () => {
      expect(sql).toContain("uq_integrations_connection_active_account");
      expect(sql).toMatch(/WHERE status = 'active' AND external_account_id IS NOT NULL/);
    });

    it("enforces one active repo link per (project, repo)", () => {
      expect(sql).toContain("uq_integrations_repo_link_project_repo");
    });

    it("keeps the installation binding unique (tenancy keystone)", () => {
      expect(sql).toContain("uq_integrations_github_installation");
    });

    it("has keyset pagination indexes on org-scoped tables", () => {
      expect(sql).toMatch(/ON integrations\.connections \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations\.repo_links \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations\.inbound_deliveries \(org_id, received_at DESC, id DESC\)/);
    });

    it("never stores platform GitHub credentials as rows", () => {
      // Cached installation tokens are ciphertext envelopes; the App private
      // key / webhook secret / client secret must not have columns.
      expect(sql).not.toMatch(/private_key/i);
      expect(sql).not.toMatch(/webhook_secret/i);
      expect(sql).not.toMatch(/client_secret/i);
      expect(sql).toContain("token_ciphertext");
    });
  });
});
