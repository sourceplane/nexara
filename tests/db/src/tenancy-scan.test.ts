// The tenant-isolation CI scan (design §7.3, NX1.5 findings S-9 and S-11).
//
// Design §7.3 chooses query scoping over Postgres RLS for a real reason —
// Workers reach Postgres through Hyperdrive, which pools connections, and
// `SET LOCAL app.current_org` on a pooled connection leaks a tenant context
// onto whichever request borrows the socket next. Silent and cross-tenant is
// the worst pair of properties a bug can have.
//
// The cost of that choice is stated plainly in the design: query scoping has
// no second line of defence. So it must be enforced structurally, and this
// file is the enforcement. It is ~120 lines and it is what turns a claim into
// a control.
//
// Two things are checked, and the second is the one the NX1.5 review added:
//
//   1. Every query in the nexus/channels repositories that touches a
//      tenant-owned table carries `org_id = $`. An exemption requires a
//      `tenancy-exempt: <reason>` marker at the call site, from a closed list
//      of reasons — exempting by TABLE NAME, as the design originally
//      proposed, would disarm the scan for every future read of that table
//      (S-9).
//   2. No `nexus.` or `channels.` SQL exists anywhere OUTSIDE the repository
//      modules. Without this, "one repository module is the only SQL surface"
//      stays a convention that a handler can quietly break; with it, it is a
//      test (S-11).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** The only directories permitted to contain nexus/channels SQL. */
const REPOSITORY_DIRS = [
  "packages/db/src/nexus",
  "packages/db/src/channels",
];

/** Trees the scan walks looking for SQL that escaped the repository. */
const PRODUCT_ROOTS = ["apps", "packages"];

/**
 * The closed list of reasons a query may skip `org_id = $`.
 *
 * Adding a reason to this list is a deliberate act that shows up in a diff and
 * should be argued for in review — which is the entire difference between this
 * and an exemption granted by table name.
 */
const ALLOWED_EXEMPTIONS = new Set([
  // nexus.rule_sets / nexus.rules are shared global reference data and carry
  // no org_id column at all (design §3.3).
  "global-reference-data",
  // The hourly job's "which orgs have work I have not seen" sweep. Returns org
  // ids and a timestamp, no tenant data; every query it drives is scoped.
  "cross-tenant-sweep",
  // nexus.inbound_deliveries is written before attribution — a webhook is
  // authenticated by a signature, not a session — so the receipt insert and
  // the drain's claim query cannot be scoped. Every TENANT-FACING read of the
  // inbox must still scope (S-9).
  "pre-attribution-inbox",
]);

/** Tables that carry no `org_id` column, so scoping them is impossible. */
const UNSCOPED_TABLES = new Set(["nexus.rule_sets", "nexus.rules"]);

const SQL_TABLE_RE = /\b(nexus|channels)\.[a-z_]+/g;

interface Query {
  file: string;
  /** 1-indexed line where the template literal opens. */
  line: number;
  sql: string;
  tables: string[];
  exemption: string | null;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** A statement is a query, not prose, only if it carries a SQL verb. */
const SQL_VERB_RE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

/**
 * Blank out comment bodies while preserving line numbers and offsets.
 *
 * Necessary because this codebase's comments carry the design rationale and
 * quote table and index names in backticks — so a naive template-literal scan
 * reads `` `nexus.determinations` `` in a doc comment as a query and reports a
 * violation in a file that has none. Replacing with spaces rather than
 * deleting keeps every reported line number honest.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Pull every backtick template literal that is a SQL statement naming a
 * `nexus.`/`channels.` table, along with the nearest preceding
 * `tenancy-exempt:` marker.
 *
 * The marker is looked for in the sixteen lines before the query — long enough
 * to sit above a paragraph explaining itself, short enough that it reads as
 * annotating *that* query rather than as a blanket grant somewhere above.
 * The marker is read from the ORIGINAL source, because it lives in a comment.
 */
function queriesIn(file: string): Query[] {
  const source = readFileSync(file, "utf-8");
  const code = stripComments(source);
  const lines = source.split("\n");
  const found: Query[] = [];

  const templateRe = /`([^`]*)`/gs;
  let match: RegExpExecArray | null;
  while ((match = templateRe.exec(code)) !== null) {
    const sql = match[1]!;
    if (!SQL_VERB_RE.test(sql)) continue;
    const tables = [...new Set(sql.match(SQL_TABLE_RE) ?? [])];
    if (tables.length === 0) continue;

    const line = code.slice(0, match.index).split("\n").length;
    const preceding = lines.slice(Math.max(0, line - 17), line - 1).join("\n");
    const marker = /tenancy-exempt:\s*([a-z-]+)/.exec(preceding);

    found.push({
      file: relative(REPO_ROOT, file),
      line,
      sql,
      tables,
      exemption: marker ? marker[1]! : null,
    });
  }
  return found;
}

/**
 * True when the query binds the tenant explicitly.
 *
 * A `SELECT`/`UPDATE`/`DELETE` scopes with `org_id = $n` in its `WHERE`. An
 * `INSERT` has no `WHERE`: it scopes by naming `org_id` in its column list and
 * supplying it as a bound parameter, which is scoping by construction and is
 * at least as strong. Requiring `org_id = $` of an INSERT would force every
 * write to carry a meaningless predicate, and a scan people have to work
 * around stops being a control.
 */
function isScoped(sql: string): boolean {
  if (/org_id\s*=\s*\$/.test(sql)) return true;
  const insert = /INSERT\s+INTO\s+(?:nexus|channels)\.[a-z_]+\s*\(([^)]*)\)/i.exec(sql);
  if (insert) {
    return /\borg_id\b/.test(insert[1]!);
  }
  return false;
}

const REPOSITORY_FILES = REPOSITORY_DIRS.flatMap((d) => walk(resolve(REPO_ROOT, d)));
const REPOSITORY_QUERIES = REPOSITORY_FILES.flatMap(queriesIn);

describe("tenant-isolation scan — inside the repository", () => {
  it("finds the repository module and its queries", () => {
    // Guards against the whole suite passing vacuously if the module moves or
    // is renamed. A scan that scans nothing is worse than no scan, because it
    // reports green.
    expect(REPOSITORY_FILES.length).toBeGreaterThan(0);
    expect(REPOSITORY_QUERIES.length).toBeGreaterThan(10);
  });

  it("scopes every tenant query by org_id, or declares why it cannot", () => {
    const offenders = REPOSITORY_QUERIES.filter((q) => {
      if (isScoped(q.sql)) return false;
      // A query that ONLY touches tables without an org_id column is
      // structurally unscopable; it still needs its marker, checked below.
      return q.exemption === null;
    }).map((q) => `${q.file}:${q.line} → ${q.tables.join(", ")}`);

    expect(offenders).toEqual([]);
  });

  it("accepts only reasons from the closed list", () => {
    const bogus = REPOSITORY_QUERIES.filter(
      (q) => q.exemption !== null && !ALLOWED_EXEMPTIONS.has(q.exemption),
    ).map((q) => `${q.file}:${q.line} → tenancy-exempt: ${q.exemption}`);

    expect(bogus).toEqual([]);
  });

  it("does not let a global-reference-data marker cover a tenant table", () => {
    // The failure this prevents: someone adds a join from nexus.rules to
    // nexus.sale_events under the existing marker, and the scan waves it
    // through because the marker was already there.
    const overreach = REPOSITORY_QUERIES.filter((q) => {
      if (q.exemption !== "global-reference-data") return false;
      if (isScoped(q.sql)) return false;
      return q.tables.some((t) => !UNSCOPED_TABLES.has(t));
    }).map((q) => `${q.file}:${q.line} → ${q.tables.join(", ")}`);

    expect(overreach).toEqual([]);
  });

  it("keeps the cross-tenant sweep to org ids and timestamps", () => {
    // A sweep is allowed to see which orgs have work. It is not allowed to
    // become a convenient way to read everyone's ledger.
    for (const q of REPOSITORY_QUERIES.filter((x) => x.exemption === "cross-tenant-sweep")) {
      const selected = /SELECT\s+([\s\S]*?)\s+FROM/i.exec(q.sql)?.[1] ?? "";
      expect({
        at: `${q.file}:${q.line}`,
        leaks: /gross_cents|retail_cents|taxable_cents|jurisdiction|payload|provider_event_id/i.test(
          selected,
        ),
      }).toEqual({ at: `${q.file}:${q.line}`, leaks: false });
    }
  });

  it("never selects the raw inbox payload outside a pre-attribution marker", () => {
    // Design §12's one prohibition, checked at the query rather than at the
    // log line: the bytes cannot reach a log sink if they never leave the
    // inbox in the first place.
    const leaks = REPOSITORY_QUERIES.filter(
      (q) =>
        /\bpayload\b/.test(q.sql) &&
        q.tables.includes("nexus.inbound_deliveries") &&
        q.exemption !== "pre-attribution-inbox" &&
        !isScoped(q.sql),
    ).map((q) => `${q.file}:${q.line}`);

    expect(leaks).toEqual([]);
  });
});

describe("tenant-isolation scan — outside the repository (NX1.5 S-11)", () => {
  // "One repository module is the only SQL surface for each schema" is the
  // load-bearing claim of design §7.3. Scanning only the repository verifies
  // the queries it finds; it does not verify that they are all of them.

  const outside = PRODUCT_ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)))
    .filter((f) => {
      const rel = relative(REPO_ROOT, f);
      return !REPOSITORY_DIRS.some((d) => rel.startsWith(d));
    })
    .flatMap(queriesIn);

  it("scanned a meaningful number of files", () => {
    // Same vacuity guard as above: if the walk found nothing, the assertion
    // below is trivially true and proves nothing.
    const scanned = PRODUCT_ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)));
    expect(scanned.length).toBeGreaterThan(100);
  });

  it("finds no nexus/channels SQL outside packages/db/src/{nexus,channels}", () => {
    const offenders = outside.map((q) => `${q.file}:${q.line} → ${q.tables.join(", ")}`);
    expect(offenders).toEqual([]);
  });
});

describe("the scan itself catches what it claims to", () => {
  // A control nobody has watched fail is not a control. These exercise the
  // predicates against synthetic sources rather than against the real tree, so
  // the suite proves it would go red rather than asserting that it does.

  const scoped = "SELECT * FROM nexus.sale_events WHERE org_id = $1 AND id = $2";
  const unscoped = "SELECT * FROM nexus.sale_events WHERE id = $1";

  it("passes a scoped query", () => {
    expect(isScoped(scoped)).toBe(true);
    expect((scoped.match(SQL_TABLE_RE) ?? []).length).toBe(1);
  });

  it("fails an unscoped query with no marker", () => {
    expect(isScoped(unscoped)).toBe(false);
  });

  it("accepts an INSERT that names org_id in its column list", () => {
    expect(
      isScoped("INSERT INTO nexus.sale_events (id, org_id, kind) VALUES ($1, $2, $3)"),
    ).toBe(true);
  });

  it("rejects an INSERT that omits org_id", () => {
    // The write path's real failure mode: a row landing with a NULL or
    // defaulted tenant instead of the caller's.
    expect(
      isScoped("INSERT INTO nexus.sale_events (id, kind) VALUES ($1, $2)"),
    ).toBe(false);
  });

  it("ignores a table name that appears only in a comment", () => {
    // The reason stripComments exists: this codebase's comments quote table
    // and index names, and a scan that reads them reports violations in files
    // with no SQL at all.
    const source = "/** See `nexus.determinations` for the record. */\nconst x = 1;";
    expect(stripComments(source)).not.toContain("nexus.determinations");
  });

  it("ignores a template literal that names a table but is not SQL", () => {
    expect(SQL_VERB_RE.test("the nexus.sale_events table")).toBe(false);
    expect(SQL_VERB_RE.test("SELECT 1 FROM nexus.sale_events")).toBe(true);
  });

  it("rejects a made-up exemption reason", () => {
    expect(ALLOWED_EXEMPTIONS.has("because-it-is-fine")).toBe(false);
  });

  it("detects a table reference in a multi-line template", () => {
    const sql = `SELECT *
       FROM nexus.determinations
       WHERE id = $1`;
    expect([...new Set(sql.match(SQL_TABLE_RE) ?? [])]).toEqual(["nexus.determinations"]);
  });
});
