"use client";

/**
 * One jurisdiction, in full.
 *
 * The rule in force, the current position, the determination history, and the
 * explainer for whichever determination the reader selects. Selecting a *past*
 * determination re-renders the explainer against that determination's own
 * stored inputs — which is the point: history here is a record of what was
 * decided and why, not a chart of how a number moved.
 */

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ScrollText } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DeterminationExplainer } from "@/components/nexus/determination-explainer";
import { NexusErrorState } from "@/components/nexus/error-state";
import { ThresholdMeter } from "@/components/nexus/threshold-meter";
import {
  describeLogic,
  formatCents,
  formatDate,
  presentStatus,
  toneVariant,
} from "@/components/nexus/nexus";
import { wrap } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSession } from "@/lib/session";

export default function JurisdictionPage() {
  const params = useParams<{ orgSlug: string; code: string }>();
  const slug = params?.orgSlug ?? "";
  const code = params?.code ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <Inner orgId={org.id} orgSlug={org.slug} code={decodeURIComponent(code)} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug, code }: { orgId: string; orgSlug: string; code: string }) {
  const { client } = useSession();
  const orgBase = `/orgs/${orgSlug}`;
  const { data, loading, error, reload } = useAsync(
    () => wrap(() => client.exposure.getJurisdiction(orgId, code)),
    [client, orgId, code],
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const determinations = data?.determinations ?? [];
  const selected =
    determinations.find((d) => d.id === selectedId) ?? determinations[0] ?? null;

  return (
    <div className="space-y-5">
      <Link
        href={`${orgBase}/exposure`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Exposure
      </Link>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : error ? (
        <NexusErrorState error={error} surface="this jurisdiction" onRetry={reload} />
      ) : !data ? (
        <EmptyState icon={ScrollText} title="Jurisdiction not found" />
      ) : (
        <>
          <Position exposure={data.exposure} rule={data.rule} />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              {selected ? (
                <DeterminationExplainer
                  determination={selected}
                  rule={data.rule}
                  jurisdictionName={data.exposure.jurisdictionName}
                />
              ) : (
                <EmptyState
                  icon={ScrollText}
                  title="No determination yet"
                  description="Nothing has been decided about this jurisdiction. Run an evaluation once there is ledger data."
                />
              )}
            </div>

            <History
              determinations={determinations}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          </div>

          {data.registration ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your registration</CardTitle>
                <CardDescription>
                  Tracked by you. Nexara never files with a jurisdiction on your behalf.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-6 text-sm">
                <Field label="Status" value={data.registration.status} />
                <Field label="Registered on" value={formatDate(data.registration.registeredOn)} />
                <Field label="Permit reference" value={data.registration.permitRef ?? "—"} />
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function Position({
  exposure: e,
  rule,
}: {
  exposure: import("@saas/contracts/nexus").PublicJurisdictionExposure;
  rule: import("@saas/contracts/nexus").PublicRule;
}) {
  const status = presentStatus(e.status);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-xl">{e.jurisdictionName}</CardTitle>
            <CardDescription className="font-mono text-xs">{e.jurisdiction}</CardDescription>
          </div>
          <Badge variant={toneVariant(status.tone)}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{status.description}</p>
        <ThresholdMeter
          fraction={e.fractionOfThreshold}
          emptyLabel={
            e.thresholdLogic === "none"
              ? "This jurisdiction enforces no economic-nexus threshold, so there is nothing to measure against."
              : "Not yet evaluated."
          }
          label={`${e.jurisdictionName} progress toward threshold`}
        />
        <p className="text-sm">
          {describeLogic(rule.thresholdLogic, rule.salesThresholdCents, rule.transactionThreshold)}
        </p>
        <div className="flex flex-wrap gap-6 text-sm">
          <Field label="Measured sales" value={formatCents(e.measuredSalesCents)} />
          <Field
            label="Measured transactions"
            value={e.measuredTransactions.toLocaleString("en-US")}
          />
          <Field label="Rule effective from" value={formatDate(rule.effectiveFrom)} />
          <Field
            label="Rule effective to"
            value={rule.effectiveTo ? formatDate(rule.effectiveTo) : "still in force"}
          />
        </div>
        {rule.notes ? <p className="text-xs text-muted-foreground">{rule.notes}</p> : null}
      </CardContent>
    </Card>
  );
}

function History({
  determinations,
  selectedId,
  onSelect,
}: {
  determinations: readonly import("@saas/contracts/nexus").PublicDetermination[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Determination history</CardTitle>
        <CardDescription>
          Newest first. Each entry is immutable; a changed position writes a new one rather than
          editing the last.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {determinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          determinations.map((d) => {
            const s = presentStatus(d.status);
            const active = d.id === selectedId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onSelect(d.id)}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  active ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate">{formatDate(d.evaluatedAt)}</span>
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {d.ruleSetVersion} · engine {d.engineVersion}
                  </span>
                </span>
                <Badge variant={toneVariant(s.tone)} className="shrink-0 text-[10px]">
                  {s.label}
                </Badge>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
