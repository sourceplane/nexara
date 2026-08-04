// The provider seam (design §6.1).
//
// Everything above this interface — handlers, repository, contracts, console,
// SDK, CLI — is provider-generic. Only `stripe.ts` and `shopify.ts` know their
// provider, and `CanonicalSaleEvent` is the single normalisation target and the
// only shape the ledger accepts.
//
// Two disciplines carried over from the shipped integrations adapter, both of
// which exist because the alternative fails open:
//
//   * `completeConnect` returning null means the account could not be
//     verified. Callers **fail closed** — no channel row, no ledger.
//   * `verifyInboundSignature` is the gate on the only unauthenticated ingress
//     in the epic. It returns a boolean and never throws, so a malformed
//     header is a rejection rather than a 500 that a caller could use to
//     distinguish "bad signature" from "bad request".

import type { CanonicalSaleEvent, ProviderAccountFacts } from "@saas/contracts/channels";

export interface HistoryPage {
  events: CanonicalSaleEvent[];
  /** Null when the walk has exhausted history or reached the floor. */
  nextCursor: string | null;
}

export interface SalesProvider {
  id: "stripe" | "shopify";
  displayName: string;

  buildAuthorizeUrl(input: { state: string; redirectUri: string }): string;

  /** Null means "could not verify this account" — the caller fails closed. */
  completeConnect(input: {
    code: string;
    nowMs: number;
  }): Promise<ProviderAccountFacts | null>;

  /**
   * The gate on the only unauthenticated ingress in this epic.
   *
   * Takes the RAW body, not a parsed one: every provider signs the bytes as
   * sent, and re-serialising a parsed object changes them.
   */
  verifyInboundSignature(rawBody: ArrayBuffer, headers: Headers): Promise<boolean>;

  /** One page of history, walking BACKWARDS from `before` down to `floor`. */
  fetchHistoryPage(input: {
    cursor: string | null;
    before: Date;
    floor: Date;
    credentials: string;
  }): Promise<HistoryPage>;

  /** A signature-verified webhook payload → zero or more canonical events. */
  normalize(payload: unknown): CanonicalSaleEvent[];

  revoke(input: { credentials: string; nowMs: number }): Promise<boolean>;
}

/**
 * A provider whose credentials are incomplete in this environment.
 *
 * The registry returns null rather than a half-configured adapter, and callers
 * report a parked, safe error. An adapter that "works" until it reaches the
 * network is worse than one that says up front that it cannot.
 */
export type ProviderResolution = SalesProvider | null;
