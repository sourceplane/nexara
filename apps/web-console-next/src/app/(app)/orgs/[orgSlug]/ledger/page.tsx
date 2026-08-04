"use client";

/**
 * The sale-event ledger.
 *
 * Append-only, and the page says so rather than implying it by omission.
 * There is no edit control and no delete control here, and there will not be
 * one: a refund is a *new row* with negative cents pointing at the row it
 * reverses, which is why a determination taken last week can still be
 * reproduced this week.
 *
 * A reversal renders as a linked reversal, never as a mutation of the
 * original — the original row stays visible, unchanged, above it.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { Receipt, Undo2 } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  describeJurisdictionSource,
  formatCents,
  isReversal,
} from "@/components/nexus/nexus";
import { wrap } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSession } from "@/lib/session";
import type { ListLedgerQuery } from "@saas/sdk";

const KINDS = ["all", "sale", "refund"] as const;

export default function LedgerPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [jurisdictionDraft, setJurisdictionDraft] = React.useState("");
  const [filters, setFilters] = React.useState<{ jurisdiction: string; kind: string }>({
    jurisdiction: "",
    kind: "all",
  });

  const queryArgs = React.useMemo<ListLedgerQuery>(() => {
    const q: ListLedgerQuery = {};
    if (filters.jurisdiction) q.jurisdiction = filters.jurisdiction.toUpperCase();
    if (filters.kind !== "all") q.kind = filters.kind as "sale" | "refund";
    return q;
  }, [filters]);

  const { data, loading, error } = useAsync(
    () => wrap(() => client.ledger.list(orgId, queryArgs)),
    [client, orgId, queryArgs],
  );

  const events = data?.events ?? [];
  // The reversed row's id → the reversing row, so an original can carry a
  // marker without the reader having to scan for its refund.
  const reversedBy = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.reversesEventId) map.set(e.reversesEventId, e.id);
    }
    return map;
  }, [events]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Every sale event behind your positions. Append-only: a refund is a new row with negative
          amounts pointing at the sale it reverses, so a determination taken last month can still
          be reproduced today.
        </p>
      </header>

      <Card>
        <CardContent className="p-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setFilters((f) => ({ ...f, jurisdiction: jurisdictionDraft }));
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="jurisdiction" className="text-xs">
                Jurisdiction
              </Label>
              <Input
                id="jurisdiction"
                placeholder="US-TX"
                className="w-36"
                value={jurisdictionDraft}
                onChange={(e) => setJurisdictionDraft(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kind</Label>
              <Select
                value={filters.kind}
                onValueChange={(v) => setFilters((f) => ({ ...f, kind: v }))}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {k === "all" ? "All" : k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline">
              Apply
            </Button>
            {filters.jurisdiction || filters.kind !== "all" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setJurisdictionDraft("");
                  setFilters({ jurisdiction: "", kind: "all" });
                }}
              >
                Reset
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-4">
            <div className="font-medium text-destructive">{error.code}</div>
            <div className="text-sm text-muted-foreground">{error.message}</div>
          </CardContent>
        </Card>
      ) : events.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No ledger rows"
          description="Connect a channel or import a CSV. Positions are computed from this ledger and nothing else."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Occurred</TableHead>
                <TableHead>Jurisdiction</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Gross</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">Txns</TableHead>
                <TableHead>Attribution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => {
                const reversal = isReversal(e);
                return (
                  <TableRow key={e.id} className={reversal ? "bg-muted/30" : undefined}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {e.occurredAt.slice(0, 10)}
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {e.providerEventId}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.jurisdiction}</TableCell>
                    <TableCell>
                      {reversal ? (
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Undo2 className="h-3 w-3" />
                          reverses{" "}
                          <code className="text-[10px]">{e.reversesEventId}</code>
                        </span>
                      ) : reversedBy.has(e.id) ? (
                        <Badge variant="outline" className="text-[10px]">
                          reversed
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">sale</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                      {formatCents(e.grossCents, e.currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                      {formatCents(e.taxableCents, e.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {e.transactionCount}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {describeJurisdictionSource(e.jurisdictionSource)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
