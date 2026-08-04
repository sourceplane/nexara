"use client";

/**
 * The exposure board.
 *
 * One card per jurisdiction, ordered by what needs attention. Two things on
 * this page are acceptance criteria rather than styling:
 *
 *   1. When the rule set behind the board is unverified, the §11 banner
 *      replaces the headline counts. The engine's caller already marks those
 *      determinations internal-only and suppresses their alerts; this is the
 *      half a human sees, and it must never be the only half.
 *   2. A `threshold_logic = 'none'` jurisdiction renders as out of scope
 *      *citing its rule row* — never as `clear`, never as blank. That lives in
 *      `ExposureCard` so a second caller cannot forget it.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { Map as MapIcon, RefreshCw, ShieldAlert } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ExposureCard } from "@/components/nexus/exposure-card";
import {
  AlertContactCard,
  alertContactState,
} from "@/components/nexus/alert-contact-card";
import {
  shouldWarnUnverified,
  sortExposure,
  summarizeExposure,
  unverifiedNotice,
} from "@/components/nexus/nexus";
import { wrap } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSession } from "@/lib/session";

export default function ExposurePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={org.slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const orgBase = `/orgs/${orgSlug}`;
  const { data, loading, error, reload } = useAsync(
    () => wrap(() => client.exposure.list(orgId)),
    [client, orgId],
  );
  const [evaluating, setEvaluating] = React.useState(false);
  const [contactSeq, setContactSeq] = React.useState(0);
  const [savingContact, setSavingContact] = React.useState(false);

  // R10. Loaded alongside the board rather than hidden in settings: the moment
  // a seller reads "crossed" is the moment they care who was told.
  const contact = useAsync(
    () => wrap(() => client.exposure.getAlertContact(orgId)),
    [client, orgId, contactSeq],
  );

  const saveContact = React.useCallback(
    async (email: string, label: string | null) => {
      setSavingContact(true);
      await wrap(() => client.exposure.setAlertContact(orgId, { email, label }));
      setSavingContact(false);
      setContactSeq((n) => n + 1);
    },
    [client, orgId],
  );

  const clearContact = React.useCallback(async () => {
    await wrap(() => client.exposure.clearAlertContact(orgId));
    setContactSeq((n) => n + 1);
  }, [client, orgId]);

  const runEvaluation = React.useCallback(async () => {
    setEvaluating(true);
    await wrap(() => client.exposure.evaluate(orgId, {}));
    setEvaluating(false);
    reload();
  }, [client, orgId, reload]);

  const rows = data ? sortExposure(data.exposure) : [];
  const totals = summarizeExposure(rows);
  const unverified = data ? shouldWarnUnverified(data.ruleSet.verified) : false;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Exposure</h1>
          <p className="text-sm text-muted-foreground">
            Where your measured sales stand against each jurisdiction&rsquo;s economic-nexus
            threshold. Nexara surfaces the position; it does not give tax advice and does not file.
          </p>
        </div>
        <Button variant="outline" onClick={() => void runEvaluation()} disabled={evaluating || loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${evaluating ? "animate-spin" : ""}`} />
          {evaluating ? "Evaluating…" : "Re-evaluate"}
        </Button>
      </header>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-4">
            <div className="font-medium text-destructive">{error.code}</div>
            <div className="text-sm text-muted-foreground">{error.message}</div>
          </CardContent>
        </Card>
      ) : !data || rows.length === 0 ? (
        <EmptyState
          icon={MapIcon}
          title="No positions yet"
          description="Connect a sales channel or import a ledger, then run an evaluation. Until there is data, Nexara claims nothing about any jurisdiction."
          primaryAction={{ label: "Connect a channel", href: `${orgBase}/channels` }}
        />
      ) : (
        <>
          {unverified ? (
            <UnverifiedBanner version={data.ruleSet.version} note={data.ruleSet.sourceNote} />
          ) : (
            <div className="flex flex-wrap gap-5 rounded-lg border bg-card p-4">
              <Stat label="Crossed" value={totals.crossed} tone="text-destructive" />
              <Stat label="Approaching" value={totals.approaching} tone="text-warning-foreground" />
              <Stat label="Registered" value={totals.registered} tone="text-success" />
              <Stat label="Clear" value={totals.clear} />
              <Stat label="Out of scope" value={totals.outOfScope} />
            </div>
          )}

          {contact.data ? (
            <AlertContactCard
              state={alertContactState(contact.data)}
              saving={savingContact}
              onSave={(email, label) => void saveContact(email, label)}
              onClear={contact.data.contact ? () => void clearContact() : undefined}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">
            Rule set <code>{data.ruleSet.version}</code>, published{" "}
            {data.ruleSet.publishedAt.slice(0, 10)}.
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <ExposureCard key={row.jurisdiction} exposure={row} orgBase={orgBase} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tracking-tight ${tone ?? ""}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * The §11 banner. It **replaces** the headline counts rather than sitting
 * above them: a summary line reading "3 crossed" next to a caveat is still a
 * summary line a seller will act on.
 */
function UnverifiedBanner({ version, note }: { version: string; note: string | null }) {
  const notice = unverifiedNotice(version);
  return (
    <div
      className="flex gap-3 rounded-lg border border-warning/50 bg-warning/5 p-4"
      data-testid="unverified-banner"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" />
      <div className="space-y-1">
        <div className="font-medium">{notice.title}</div>
        <p className="text-sm text-muted-foreground">{notice.body}</p>
        {note ? <p className="text-xs text-muted-foreground">Source: {note}</p> : null}
      </div>
    </div>
  );
}
