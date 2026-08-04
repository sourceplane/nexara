"use client";

/**
 * Registrations — status and deadlines.
 *
 * Tracked by the seller, never filed by us. That is a permanent non-goal, not
 * a v1 gap, and the page says so plainly rather than leaving a "File" button
 * conspicuously missing.
 *
 * The deadline column comes from the *determination*, not from this row: a
 * deadline is a consequence of a crossing, and a seller who marks themselves
 * "planned" has not thereby changed when the jurisdiction expects them.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { CalendarClock, Stamp } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
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
import { formatDate } from "@/components/nexus/nexus";
import { wrap } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSession } from "@/lib/session";
import type { RegistrationStatus } from "@saas/contracts/nexus";

const STATUSES: RegistrationStatus[] = ["planned", "filed", "active", "closed"];

const STATUS_VARIANT: Record<RegistrationStatus, "secondary" | "warning" | "success" | "outline"> = {
  planned: "secondary",
  filed: "warning",
  active: "success",
  closed: "outline",
};

export default function RegistrationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [seq, setSeq] = React.useState(0);

  const registrations = useAsync(
    () => wrap(() => client.registrations.list(orgId)),
    [client, orgId, seq],
  );
  // The deadlines live on the exposure projection, not on the registration
  // row — see the file header.
  const exposure = useAsync(() => wrap(() => client.exposure.list(orgId)), [client, orgId, seq]);

  const deadlines = React.useMemo(() => {
    const map = new Map<string, { dueOn: string | null; name: string }>();
    for (const e of exposure.data?.exposure ?? []) {
      map.set(e.jurisdiction, { dueOn: e.registrationDueOn, name: e.jurisdictionName });
    }
    return map;
  }, [exposure.data]);

  const rows = registrations.data?.registrations ?? [];

  const setStatus = React.useCallback(
    async (jurisdiction: string, status: RegistrationStatus) => {
      const r = await wrap(() => client.registrations.upsert(orgId, { jurisdiction, status }));
      if (r.ok) {
        toast({ kind: "success", title: `${jurisdiction} marked ${status}` });
        setSeq((n) => n + 1);
      } else {
        toast({ kind: "error", title: "Could not update", description: r.error.message });
      }
    },
    [client, orgId, toast],
  );

  // Crossed jurisdictions with no registration row are the actionable set —
  // they are why this page exists, so they lead rather than hide below.
  const outstanding = (exposure.data?.exposure ?? []).filter(
    (e) => e.status === "crossed" && !rows.some((r) => r.jurisdiction === e.jurisdiction),
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Registrations</h1>
        <p className="text-sm text-muted-foreground">
          Your own record of where you are registered. Nexara surfaces the deadline; you file.
          We never submit anything to a jurisdiction on your behalf.
        </p>
      </header>

      {outstanding.length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-destructive" />
              Crossed, with no registration recorded
            </CardTitle>
            <CardDescription>
              A threshold was passed in these jurisdictions and you have not told us what you did
              about it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {outstanding.map((e) => (
              <div
                key={e.jurisdiction}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              >
                <div>
                  <div className="font-medium">{e.jurisdictionName}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.registrationDueOn
                      ? `Deadline ${formatDate(e.registrationDueOn)}`
                      : "This jurisdiction's rule defines no deadline."}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setStatus(e.jurisdiction, "planned")}
                  >
                    Mark planned
                  </Button>
                  <Button size="sm" onClick={() => void setStatus(e.jurisdiction, "active")}>
                    Mark registered
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {registrations.loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : registrations.error ? (
        <Card>
          <CardContent className="p-4">
            <div className="font-medium text-destructive">{registrations.error.code}</div>
            <div className="text-sm text-muted-foreground">{registrations.error.message}</div>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Stamp}
          title="No registrations recorded"
          description="When you register with a jurisdiction, record it here so its card stops reading as an open item."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jurisdiction</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Registered on</TableHead>
                <TableHead>Permit reference</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead className="w-40">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const meta = deadlines.get(r.jurisdiction);
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{meta?.name ?? r.jurisdiction}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {r.jurisdiction}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]} className="text-[10px]">
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{formatDate(r.registeredOn)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.permitRef ?? "—"}</TableCell>
                    <TableCell className="text-xs">{formatDate(meta?.dueOn ?? null)}</TableCell>
                    <TableCell>
                      <Select
                        value={r.status}
                        onValueChange={(v) => void setStatus(r.jurisdiction, v as RegistrationStatus)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUSES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AddRegistration
        onSubmit={(jurisdiction, status) => void setStatus(jurisdiction.toUpperCase(), status)}
      />
    </div>
  );
}

function AddRegistration({
  onSubmit,
}: {
  onSubmit: (jurisdiction: string, status: RegistrationStatus) => void;
}) {
  const [jurisdiction, setJurisdiction] = React.useState("");
  const [status, setStatus] = React.useState<RegistrationStatus>("active");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Record a registration</CardTitle>
        <CardDescription>
          Including one you held before connecting a channel — a pre-existing registration should
          not read as an open item.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!jurisdiction.trim()) return;
            onSubmit(jurisdiction.trim(), status);
            setJurisdiction("");
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="reg-jurisdiction" className="text-xs">
              Jurisdiction
            </Label>
            <Input
              id="reg-jurisdiction"
              placeholder="US-CA"
              className="w-36"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as RegistrationStatus)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" variant="outline">
            Record
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
