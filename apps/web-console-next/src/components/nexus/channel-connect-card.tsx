"use client";

/**
 * One connected channel, and the connect affordances.
 *
 * The honesty rule this card holds: **`backfilling` never reads as
 * `connected`.** A channel serving a partial ledger that looks complete is the
 * failure mode the state exists to make visible (design §12), and this card is
 * the only place a seller sees it. The same applies to `degraded`: R3 says
 * absence of data is indistinguishable from absence of sales, so the copy
 * names which one we cannot tell rather than picking one.
 *
 * Revoking stops ingestion and does not touch the ledger — the confirmation
 * says so, because a seller who expects a disconnect to erase history is a
 * seller about to be surprised by a determination that did not move.
 */

import * as React from "react";
import { Plug, ShieldOff, Store, CreditCard, FileSpreadsheet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PublicChannel } from "@saas/contracts/channels";
import { describeBackfill, formatDate, presentChannel, toneVariant } from "./nexus";

const PROVIDER_ICON: Record<string, typeof Plug> = {
  stripe: CreditCard,
  shopify: Store,
  csv: FileSpreadsheet,
};

export interface ChannelConnectCardProps {
  channel: PublicChannel;
  /** Absent when the viewer lacks `organization.channel.revoke`. */
  onRevoke?: (channel: PublicChannel) => void;
  revoking?: boolean;
}

export function ChannelConnectCard({ channel, onRevoke, revoking }: ChannelConnectCardProps) {
  const health = presentChannel(channel);
  const backfill = describeBackfill(channel);
  const Icon = PROVIDER_ICON[channel.provider] ?? Plug;
  const revoked = channel.status === "revoked";

  return (
    <Card data-testid={`channel-card-${channel.id}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium">{channel.displayName}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {channel.provider} · {channel.externalAccountId}
              </div>
            </div>
          </div>
          <Badge variant={toneVariant(health.tone)} className="shrink-0">
            {health.label}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">{health.detail}</p>

        {!revoked ? (
          <div className="rounded-md border bg-muted/30 p-2.5">
            <div className="flex items-center gap-2 text-xs font-medium">
              {backfill.done ? "History imported" : "Importing history"}
              {!backfill.done ? (
                // Indeterminate on purpose — see `describeBackfill`. A
                // fabricated percentage on a compliance surface is worse than
                // no percentage.
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <span className="block h-1.5 w-1/3 animate-pulse rounded-full bg-primary" />
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{backfill.detail}</p>
          </div>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
          <div className="flex justify-between gap-2">
            <dt>Last event</dt>
            <dd className="text-foreground">{formatDate(channel.lastEventAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>Connected</dt>
            <dd className="text-foreground">{formatDate(channel.createdAt)}</dd>
          </div>
        </dl>

        {onRevoke && !revoked ? (
          <div className="flex justify-end pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={revoking}
              onClick={() => onRevoke(channel)}
            >
              <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
              {revoking ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Copy for the disconnect confirmation. Kept next to the button that raises it. */
export const REVOKE_CONFIRMATION = {
  title: "Disconnect this channel?",
  body:
    "New orders will stop arriving from this channel. Sale events already in your ledger are " +
    "kept — the ledger is append-only, so your existing positions do not change.",
  confirmLabel: "Disconnect",
} as const;
