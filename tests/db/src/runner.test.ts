import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";
import type { MigrationEntry } from "@saas/db";
import { buildPlan, runMigrations } from "@saas/db/runner";
import type {
  AppliedMigration,
  MigrationAdapter,
  MigrationPlan,
} from "@saas/db/runner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../..", "packages/db/src/migrations");
const REPO_ROOT = resolve(__dirname, "../../..");

class FakeAdapter implements MigrationAdapter {
  connected = false;
  locked = false;
  appliedMigrations: AppliedMigration[] = [];
  executedSql: string[] = [];
  recorded: MigrationEntry[] = [];
  inTransaction = false;
  shouldFailOnSql: string | null = null;
  lockAcquirable = true;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async acquireAdvisoryLock(_lockId: number): Promise<boolean> {
    if (!this.lockAcquirable) return false;
    this.locked = true;
    return true;
  }

  async releaseAdvisoryLock(_lockId: number): Promise<void> {
    this.locked = false;
  }

  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    return this.appliedMigrations;
  }

  async beginTransaction(): Promise<void> {
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    this.inTransaction = false;
  }

  async executeSql(sql: string): Promise<void> {
    if (this.shouldFailOnSql && sql.includes(this.shouldFailOnSql)) {
      throw new Error(`Simulated SQL failure on: ${this.shouldFailOnSql}`);
    }
    this.executedSql.push(sql);
  }

  async recordMigration(entry: MigrationEntry): Promise<void> {
    this.recorded.push(entry);
    this.appliedMigrations.push({
      id: entry.id,
      context: entry.context,
      checksum: entry.checksum,
      applied_at: new Date().toISOString(),
    });
  }
}

describe("Migration Runner", () => {
  let adapter: FakeAdapter;

  const firstMigration = manifest.migrations[0]!;

  beforeEach(() => {
    adapter = new FakeAdapter();
  });

  describe("no pending migrations", () => {
    it("reports all migrations as skipped when fully applied", async () => {
      adapter.appliedMigrations = manifest.migrations.map((m) => ({
        id: m.id,
        context: m.context,
        checksum: m.checksum,
        applied_at: "2026-01-01T00:00:00Z",
      }));

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toHaveLength(0);
      expect(result.skipped).toEqual(manifest.migrations.map((m) => m.id));
      expect(result.failed).toBeNull();
    });

    it("is idempotent when re-run with no pending migrations", async () => {
      adapter.appliedMigrations = manifest.migrations.map((m) => ({
        id: m.id,
        context: m.context,
        checksum: m.checksum,
        applied_at: "2026-01-01T00:00:00Z",
      }));

      const result1 = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });
      const result2 = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result1).toEqual(result2);
    });
  });

  describe("pending migrations", () => {
    it("applies all pending migrations in manifest order", async () => {
      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toEqual(manifest.migrations.map((m) => m.id));
      expect(result.skipped).toHaveLength(0);
      expect(result.failed).toBeNull();
      expect(adapter.recorded).toHaveLength(manifest.migrations.length);
    });

    it("applies only missing migrations when some are already applied", async () => {
      adapter.appliedMigrations = [
        {
          id: firstMigration.id,
          context: firstMigration.context,
          checksum: firstMigration.checksum,
          applied_at: "2026-01-01T00:00:00Z",
        },
      ];

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.skipped).toContain(firstMigration.id);
      expect(result.applied).toEqual(
        manifest.migrations.slice(1).map((m) => m.id),
      );
      expect(result.failed).toBeNull();
    });
  });

  describe("plan mode", () => {
    it("reports pending migrations without executing SQL", async () => {
      const result = await runMigrations(manifest, {
        mode: "plan",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toEqual(manifest.migrations.map((m) => m.id));
      expect(adapter.executedSql).toHaveLength(0);
      expect(adapter.recorded).toHaveLength(0);
    });
  });

  describe("checksum mismatch", () => {
    it("fails when an applied migration has a different checksum", async () => {
      adapter.appliedMigrations = [
        {
          id: firstMigration.id,
          context: firstMigration.context,
          checksum: "0000000000000000000000000000000000000000000000000000000000000000",
          applied_at: "2026-01-01T00:00:00Z",
        },
      ];

      await expect(
        runMigrations(manifest, {
          mode: "apply",
          migrationsDir: MIGRATIONS_DIR,
          adapter,
        }),
      ).rejects.toThrow("Checksum mismatch for already-applied migrations");
    });
  });

  describe("migration failure rollback", () => {
    it("rolls back the failed migration and reports the error", async () => {
      adapter.shouldFailOnSql = "CREATE SCHEMA";

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.failed).not.toBeNull();
      expect(result.failed!.id).toBe(firstMigration.id);
      expect(result.failed!.error).toContain("Simulated SQL failure");
      expect(adapter.inTransaction).toBe(false);
    });
  });

  describe("deterministic apply order", () => {
    it("applies migrations in manifest array order", async () => {
      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      for (let i = 0; i < result.applied.length; i++) {
        expect(result.applied[i]).toBe(manifest.migrations[i]!.id);
      }
    });
  });

  describe("advisory lock", () => {
    it("fails when advisory lock cannot be acquired", async () => {
      adapter.lockAcquirable = false;

      await expect(
        runMigrations(manifest, {
          mode: "apply",
          migrationsDir: MIGRATIONS_DIR,
          adapter,
        }),
      ).rejects.toThrow("Could not acquire migration advisory lock");
    });

    it("releases lock even when migration fails", async () => {
      adapter.shouldFailOnSql = "CREATE SCHEMA";

      await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(adapter.locked).toBe(false);
    });
  });

  describe("connection lifecycle", () => {
    it("connects before running and disconnects after", async () => {
      await runMigrations(manifest, {
        mode: "plan",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(adapter.connected).toBe(false);
    });
  });
});

describe("buildPlan", () => {
  it("identifies pending, applied, and mismatched migrations", () => {
    const first = manifest.migrations[0]!;
    const appliedMap = new Map([
      [first.id, first.checksum],
    ]);

    const plan: MigrationPlan = buildPlan(manifest, appliedMap, MIGRATIONS_DIR);

    expect(plan.alreadyApplied).toContain(first.id);
    expect(plan.checksumMismatches).toHaveLength(0);
    expect(plan.pending).toEqual(manifest.migrations.slice(1));
  });
});

// ── The credential contract between the runner and its component ──
//
// `infra/db-migrate/component.yaml` declares SUPABASE_ACCESS_TOKEN under
// `optionalSecretEnv` rather than `secretEnv`, and that is only safe because
// the runner provably never reads it in plan mode. These tests pin both halves
// of that contract, because the two files are far apart and the failure mode
// if they drift is bad in both directions:
//
//   * if the runner started reading the token in plan mode, plan would break
//     wherever the token is legitimately absent;
//   * if the component moved it back to `secretEnv`, every PR would again mint
//     a Management-API token it throws away — and would again fail at secret
//     resolution when the integration's broker is rate-limited, having never
//     opened a migration file.

describe("db-migrate credential contract", () => {
  const runnerSrc = readFileSync(
    resolve(REPO_ROOT, "packages/db/src/runner/cli.ts"),
    "utf-8",
  );
  const componentSrc = readFileSync(
    resolve(REPO_ROOT, "infra/db-migrate/component.yaml"),
    "utf-8",
  );

  it("returns from plan mode before reading the management token", () => {
    // The ordering is the whole guarantee: the early return must come first.
    const planReturn = runnerSrc.indexOf('if (mode === "plan")');
    const tokenRead = runnerSrc.indexOf("if (!SUPABASE_ACCESS_TOKEN)");
    expect(planReturn).toBeGreaterThan(-1);
    expect(tokenRead).toBeGreaterThan(-1);
    expect(planReturn).toBeLessThan(tokenRead);
  });

  it("still refuses to apply without the token", () => {
    // Optional at resolution, mandatory at use. Dropping this guard would let
    // an apply proceed with no management credential.
    expect(runnerSrc).toContain("SUPABASE_ACCESS_TOKEN is required for apply mode");
  });

  it("declares the token optional, and the DB identity required", () => {
    // Comments are stripped first: the rationale above `optionalSecretEnv`
    // names the variable, and a naive slice would read prose as declaration.
    // (The first draft of this test did exactly that and failed on its own
    // explanation — which is the failure mode worth stripping for.)
    const yaml = componentSrc
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    const optionalIdx = yaml.indexOf("optionalSecretEnv:");
    const requiredIdx = yaml.indexOf("secretEnv:");
    expect(optionalIdx).toBeGreaterThan(-1);
    expect(requiredIdx).toBeGreaterThan(-1);
    expect(requiredIdx).toBeLessThan(optionalIdx);

    expect(yaml.slice(optionalIdx)).toContain("SUPABASE_ACCESS_TOKEN");

    // The three the runner needs in BOTH modes stay required — making those
    // optional would turn a misconfiguration into a confusing runtime error.
    const requiredBlock = yaml.slice(requiredIdx, optionalIdx);
    for (const key of ["SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD", "SUPABASE_DB_URL"]) {
      expect(requiredBlock).toContain(key);
    }
    expect(requiredBlock).not.toContain("SUPABASE_ACCESS_TOKEN");
  });
});
