// Nexus resource clients — exposure, ledger, registrations.
//
// Org-scoped: every method takes `orgId` first, matching every other resource
// client here. Maps to `apps/nexus-worker` via the api-edge `nexus-facade`.

import type {
  GetAlertContactResponse,
  SetAlertContactRequest,
  SetAlertContactResponse,
  EvaluateRequest,
  EvaluateResponse,
  GetJurisdictionResponse,
  ImportLedgerRequest,
  ImportLedgerResponse,
  ListExposureResponse,
  ListLedgerResponse,
  ListRegistrationsResponse,
  UpsertRegistrationRequest,
  UpsertRegistrationResponse,
} from "@saas/contracts/nexus";

import type { Transport, RequestOptions } from "./transport.js";

export interface ListLedgerQuery {
  jurisdiction?: string;
  channelId?: string;
  kind?: "sale" | "refund";
  limit?: number;
  cursor?: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/**
 * The exposure board and the jurisdiction detail behind each card.
 *
 * Note what is absent and always will be: there is no method that *sets* a
 * determination. Determinations are produced by the engine and are immutable;
 * an SDK that could write one would make the audit record an opinion.
 */
export class ExposureClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/nexus/exposure */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListExposureResponse> {
    return this.transport.request<ListExposureResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/exposure` },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/nexus/jurisdictions/:code */
  getJurisdiction(
    orgId: string,
    code: string,
    opts: RequestOptions = {},
  ): Promise<GetJurisdictionResponse> {
    return this.transport.request<GetJurisdictionResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/jurisdictions/${encodeURIComponent(code)}`,
      },
      opts,
    );
  }

  /**
   * GET /v1/organizations/:orgId/nexus/alert-contact
   *
   * Lives on this client because a threshold alert is a consequence of a
   * position, and the board is where a seller notices they need one. The
   * response reports whether an environment-level fallback exists, so the
   * console can tell "going somewhere you did not choose" from "going
   * nowhere" — a single null cannot.
   */
  getAlertContact(orgId: string, opts: RequestOptions = {}): Promise<GetAlertContactResponse> {
    return this.transport.request<GetAlertContactResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/alert-contact`,
      },
      opts,
    );
  }

  /** PUT /v1/organizations/:orgId/nexus/alert-contact */
  setAlertContact(
    orgId: string,
    body: SetAlertContactRequest,
    opts: RequestOptions = {},
  ): Promise<SetAlertContactResponse> {
    return this.transport.request<SetAlertContactResponse>(
      {
        method: "PUT",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/alert-contact`,
        body,
      },
      opts,
    );
  }

  /**
   * DELETE /v1/organizations/:orgId/nexus/alert-contact
   *
   * Returns the org to the environment fallback. Its own verb rather than an
   * empty-string update, because "no contact chosen" and "contact set to
   * nothing" are different states and only one should read as a fallback.
   */
  clearAlertContact(orgId: string, opts: RequestOptions = {}): Promise<GetAlertContactResponse> {
    return this.transport.request<GetAlertContactResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/alert-contact`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/nexus/evaluate
   *
   * Runs the same code the hourly cron runs. Writes a determination only for
   * positions whose status or measured value changed, so calling it twice in a
   * row is not a way to manufacture history.
   */
  evaluate(
    orgId: string,
    body: EvaluateRequest = {},
    opts: RequestOptions = {},
  ): Promise<EvaluateResponse> {
    return this.transport.request<EvaluateResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/nexus/evaluate`, body },
      opts,
    );
  }
}

/** The append-only sale-event ledger. */
export class LedgerClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/ledger */
  list(
    orgId: string,
    q: ListLedgerQuery = {},
    opts: RequestOptions = {},
  ): Promise<ListLedgerResponse> {
    return this.transport.request<ListLedgerResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/ledger${query({ ...q })}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/ledger/import
   *
   * A malformed import is rejected wholesale (422) with no partial writes; a
   * duplicate is success, and `applied + duplicates === submitted`. Re-running
   * the same file changes nothing, which is what makes an import safe to
   * retry — pass `idempotencyKey` in `opts` for the response replay as well.
   */
  import(
    orgId: string,
    body: ImportLedgerRequest,
    opts: RequestOptions = {},
  ): Promise<ImportLedgerResponse> {
    return this.transport.request<ImportLedgerResponse>(
      { method: "POST", path: `/v1/organizations/${encodeURIComponent(orgId)}/ledger/import`, body },
      opts,
    );
  }
}

/**
 * Registration state, tracked by the seller.
 *
 * Nexara surfaces the deadline; a human files. There is no `file()` here and
 * there never will be — filing with a state on a seller's behalf is a
 * permanent non-goal.
 */
export class RegistrationsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/registrations */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListRegistrationsResponse> {
    return this.transport.request<ListRegistrationsResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/registrations` },
      opts,
    );
  }

  /** PUT /v1/organizations/:orgId/registrations */
  upsert(
    orgId: string,
    body: UpsertRegistrationRequest,
    opts: RequestOptions = {},
  ): Promise<UpsertRegistrationResponse> {
    return this.transport.request<UpsertRegistrationResponse>(
      { method: "PUT", path: `/v1/organizations/${encodeURIComponent(orgId)}/registrations`, body },
      opts,
    );
  }
}
