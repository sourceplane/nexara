export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** Audit + domain events. The append-only event log IS the compliance audit
   *  trail (design §8); we do not build a second one. */
  EVENTS_WORKER?: Fetcher;
  /** Threshold alerts (NX5). Absent means alerts are recorded but not sent. */
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
}
