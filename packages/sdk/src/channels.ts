// Channels resource client — connect, list, revoke, and the delivery log.
//
// Org-scoped like every other resource client here. Maps to
// `apps/channels-worker` via the api-edge `nexus-facade`, which routes the
// `/channels` sub-tree to a different binding than the rest of nexus.
//
// Note what this client cannot do, by construction:
//
//   * There is no method that returns a delivery **payload**. The raw provider
//     body carries customer names and addresses and lives under the Q6
//     retention policy; an SDK method that handed it out would make that
//     policy decorative.
//   * There is no method that writes a sale event. The ledger is written by
//     the drain from a signature-verified delivery, or by `ledger.import()`.
//     A channel is a source of truth about *where events come from*, not a
//     back door into the ledger.

import type {
  CompleteChannelConnectRequest,
  CompleteChannelConnectResponse,
  CreateManualChannelRequest,
  CreateManualChannelResponse,
  ListChannelsResponse,
  ListDeliveriesResponse,
  RevokeChannelResponse,
  StartChannelConnectRequest,
  StartChannelConnectResponse,
} from "@saas/contracts/channels";

import type { Transport, RequestOptions } from "./transport.js";

export class ChannelsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/channels */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListChannelsResponse> {
    return this.transport.request<ListChannelsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/channels` },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/channels/connect
   *
   * Returns a provider authorize URL carrying a signed, single-use state. The
   * org binding travels in *our* state, never inferred from the provider's
   * redirect — a provider callback says which account authorised, not which of
   * our tenants asked.
   */
  startConnect(
    orgId: string,
    body: StartChannelConnectRequest,
    opts: RequestOptions = {},
  ): Promise<StartChannelConnectResponse> {
    return this.transport.request<StartChannelConnectResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/channels/connect`,
        body,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/channels/connect/complete */
  completeConnect(
    orgId: string,
    body: CompleteChannelConnectRequest,
    opts: RequestOptions = {},
  ): Promise<CompleteChannelConnectResponse> {
    return this.transport.request<CompleteChannelConnectResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/channels/connect/complete`,
        body,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/channels
   *
   * A CSV channel: no OAuth flow, created directly, and complete the moment it
   * exists. It is what a hand-imported ledger is attributed to, so the exposure
   * board never has to explain a nullable channel.
   */
  createManual(
    orgId: string,
    body: CreateManualChannelRequest,
    opts: RequestOptions = {},
  ): Promise<CreateManualChannelResponse> {
    return this.transport.request<CreateManualChannelResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/channels`, body },
      opts,
    );
  }

  /**
   * DELETE /v1/organizations/:orgId/channels/:channelId
   *
   * Stops ingestion. It does **not** remove the rows this channel produced —
   * the ledger is append-only, and a disconnect that silently rewrote history
   * would change past determinations after the fact.
   */
  revoke(
    orgId: string,
    channelId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeChannelResponse> {
    return this.transport.request<RevokeChannelResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/channels/${encodeURIComponent(channelId)}`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/channels/deliveries
   *
   * The tenant's own view of the ingestion inbox: which deliveries arrived,
   * which applied, which are retrying, and which failed terminally. No payload
   * — see the file header.
   */
  listDeliveries(orgId: string, opts: RequestOptions = {}): Promise<ListDeliveriesResponse> {
    return this.transport.request<ListDeliveriesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/channels/deliveries`,
      },
      opts,
    );
  }
}
