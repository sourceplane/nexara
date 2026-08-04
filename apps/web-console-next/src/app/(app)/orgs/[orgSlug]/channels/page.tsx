"use client";

/**
 * Connected sales channels, and the ingestion inbox behind them.
 *
 * Two honesty rules, both of which are the difference between a compliance
 * product and a dashboard:
 *
 *   - A channel mid-backfill reads as **backfilling**, with the positions
 *     marked incomplete. It is not "connected" until it has actually finished
 *     ingesting (design §12).
 *   - The inbox is visible to the tenant, including terminal failures. A
 *     silently dropped delivery is a hole in the ledger, and a hole in the
 *     ledger reads as a quiet month.
 *
 * The delivery list carries no payload and never will — the raw provider body
 * holds customer names and addresses and lives under the Q6 retention policy.
 */

import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Plug, Inbox } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChannelConnectCard,
  REVOKE_CONFIRMATION,
} from "@/components/nexus/channel-connect-card";
import { presentDelivery, toneVariant } from "@/components/nexus/nexus";
import { wrap } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useSession } from "@/lib/session";
import type { ChannelProviderId, PublicChannel } from "@saas/contracts/channels";

const OAUTH_PROVIDERS: { id: ChannelProviderId; label: string; blurb: string }[] = [
  { id: "stripe", label: "Stripe", blurb: "Charges and refunds, with their ship-to address." },
  { id: "shopify", label: "Shopify", blurb: "Orders and refunds, including marketplace-facilitated sales." },
];

export default function ChannelsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const search = useSearchParams();
  const [reloadSeq, setReloadSeq] = React.useState(0);

  const channels = useAsync(
    () => wrap(() => client.channels.list(orgId)),
    [client, orgId, reloadSeq],
  );
  const deliveries = useAsync(
    () => wrap(() => client.channels.listDeliveries(orgId)),
    [client, orgId, reloadSeq],
  );

  const [pendingRevoke, setPendingRevoke] = React.useState<PublicChannel | null>(null);
  const [connecting, setConnecting] = React.useState<ChannelProviderId | null>(null);

  // The provider bounces the operator back here with `?code=…&state=…`. The
  // org binding is carried by our own signed state, not by this URL — the
  // completion call re-verifies it server-side and fails closed on a mismatch.
  const code = search?.get("code") ?? null;
  const state = search?.get("state") ?? null;
  const returnedProvider = search?.get("provider") ?? null;
  const completedRef = React.useRef(false);

  React.useEffect(() => {
    if (!code || !state || !returnedProvider || completedRef.current) return;
    completedRef.current = true;
    void (async () => {
      const r = await wrap(() =>
        client.channels.completeConnect(orgId, {
          provider: returnedProvider as ChannelProviderId,
          code,
          state,
        }),
      );
      if (r.ok) {
        toast({ kind: "success", title: `Connected ${r.data.channel.displayName}` });
        setReloadSeq((n) => n + 1);
      } else {
        toast({ kind: "error", title: "Could not complete the connection", description: r.error.message });
      }
    })();
  }, [client, orgId, code, state, returnedProvider, toast]);

  const startConnect = React.useCallback(
    async (provider: ChannelProviderId) => {
      setConnecting(provider);
      const redirectUri = `${window.location.origin}${window.location.pathname}?provider=${provider}`;
      const r = await wrap(() => client.channels.startConnect(orgId, { provider, redirectUri }));
      setConnecting(null);
      if (r.ok && r.data.authorizeUrl) {
        window.location.assign(r.data.authorizeUrl);
        return;
      }
      toast({
        kind: "error",
        title: "Could not start the connection",
        description: r.ok ? "This provider returned no authorize URL." : r.error.message,
      });
    },
    [client, orgId, toast],
  );

  const revoke = React.useCallback(async () => {
    if (!pendingRevoke) return;
    const r = await wrap(() => client.channels.revoke(orgId, pendingRevoke.id));
    if (r.ok) {
      toast({ kind: "success", title: `Disconnected ${pendingRevoke.displayName}` });
      setReloadSeq((n) => n + 1);
    } else {
      toast({ kind: "error", title: "Could not disconnect", description: r.error.message });
    }
    setPendingRevoke(null);
  }, [client, orgId, pendingRevoke, toast]);

  const rows = channels.data?.channels ?? [];
  const active = rows.filter((c) => c.status !== "revoked");
  const revoked = rows.filter((c) => c.status === "revoked");

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Where your sale events come from. Positions are computed from the ledger these channels
          write, so a channel that stops delivering makes a board look calmer than it is.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect a channel</CardTitle>
          <CardDescription>
            History is imported back 36 months, and live orders are captured from the moment you
            connect — the two overlap deliberately, and duplicates are rejected by the database.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {OAUTH_PROVIDERS.map((p) => (
            <div key={p.id} className="flex min-w-56 flex-1 flex-col justify-between gap-2 rounded-md border p-3">
              <div>
                <div className="font-medium">{p.label}</div>
                <p className="text-xs text-muted-foreground">{p.blurb}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={connecting !== null}
                onClick={() => void startConnect(p.id)}
              >
                <Plug className="mr-1.5 h-3.5 w-3.5" />
                {connecting === p.id ? "Starting…" : `Connect ${p.label}`}
              </Button>
            </div>
          ))}
          <ManualChannelForm orgId={orgId} onCreated={() => setReloadSeq((n) => n + 1)} />
        </CardContent>
      </Card>

      {channels.loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : channels.error ? (
        <Card>
          <CardContent className="p-4">
            <div className="font-medium text-destructive">{channels.error.code}</div>
            <div className="text-sm text-muted-foreground">{channels.error.message}</div>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No channels connected"
          description="Connect Stripe or Shopify, or add a CSV channel to import a ledger by hand."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {active.map((c) => (
              <ChannelConnectCard key={c.id} channel={c} onRevoke={setPendingRevoke} />
            ))}
          </div>
          {revoked.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {revoked.length} disconnected channel{revoked.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {revoked.map((c) => (
                  <ChannelConnectCard key={c.id} channel={c} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}

      <DeliveryInbox
        loading={deliveries.loading}
        rows={deliveries.data?.deliveries ?? []}
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title={REVOKE_CONFIRMATION.title}
        description={REVOKE_CONFIRMATION.body}
        resourceName={pendingRevoke?.displayName}
        confirmLabel={REVOKE_CONFIRMATION.confirmLabel}
        onConfirm={revoke}
      />
    </div>
  );
}

function ManualChannelForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [displayName, setDisplayName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await wrap(() =>
      client.channels.createManual(orgId, {
        displayName,
        // The operator names the channel; the stable label is derived so two
        // channels called the same thing cannot silently share a dedupe scope.
        externalAccountId: displayName.trim().toLowerCase().replace(/[^\w.-]+/g, "-").slice(0, 64),
      }),
    );
    setBusy(false);
    if (r.ok) {
      setDisplayName("");
      toast({ kind: "success", title: `Added ${r.data.channel.displayName}` });
      onCreated();
    } else {
      toast({ kind: "error", title: "Could not add the channel", description: r.error.message });
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex min-w-56 flex-1 flex-col justify-between gap-2 rounded-md border border-dashed p-3"
    >
      <div>
        <div className="font-medium">CSV import</div>
        <p className="text-xs text-muted-foreground">
          A channel to attribute hand-imported rows to, so no ledger row is orphaned.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="csv-name" className="text-xs">
          Label
        </Label>
        <Input
          id="csv-name"
          placeholder="2024 Amazon export"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={busy || displayName.trim() === ""}>
        {busy ? "Adding…" : "Add CSV channel"}
      </Button>
    </form>
  );
}

function DeliveryInbox({
  loading,
  rows,
}: {
  loading: boolean;
  rows: readonly import("@saas/contracts/channels").PublicChannelDelivery[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" /> Recent deliveries
        </CardTitle>
        <CardDescription>
          Every webhook we received, and what happened to it. Payloads are not shown here and are
          purged once a delivery settles.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing received yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => {
                  const p = presentDelivery(d);
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {d.receivedAt.slice(0, 16).replace("T", " ")}
                      </TableCell>
                      <TableCell className="text-xs">{d.provider}</TableCell>
                      <TableCell>
                        <Badge variant={toneVariant(p.tone)} className="text-[10px]">
                          {p.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{d.attempts}</TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {d.lastError ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
