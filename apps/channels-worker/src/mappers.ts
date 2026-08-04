import type { PublicChannel, PublicChannelDelivery } from "@saas/contracts/channels";
import type { ChannelRow, DeliveryRow } from "@saas/db/channels";

import { channelPublicId, deliveryPublicId, orgPublicId } from "./ids.js";

export function toPublicChannel(row: ChannelRow): PublicChannel {
  return {
    id: channelPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    provider: row.provider,
    externalAccountId: row.externalAccountId,
    displayName: row.displayName,
    status: row.status,
    backfillStartedAt: row.backfillStartedAt?.toISOString() ?? null,
    backfillCompletedAt: row.backfillCompletedAt?.toISOString() ?? null,
    lookbackFloor: row.lookbackFloor,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    // NOTE: `credentialsRef` is deliberately absent from PublicChannel and
    // therefore cannot be mapped here even by accident. A pointer into the
    // secret store is not something a console needs.
  };
}

export function toPublicDelivery(row: DeliveryRow): PublicChannelDelivery {
  return {
    id: deliveryPublicId(row.id),
    orgId: row.orgId ? orgPublicId(row.orgId) : null,
    channelId: row.channelId ? channelPublicId(row.channelId) : null,
    provider: row.provider,
    providerDeliveryId: row.providerDeliveryId,
    signatureVerified: row.signatureVerified,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastError: row.lastError,
    receivedAt: row.receivedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    // `payload` is absent from PublicChannelDelivery by construction. The raw
    // body carries customer names and addresses; a projection that leaked it
    // would make the Q6 retention policy worthless.
  };
}
