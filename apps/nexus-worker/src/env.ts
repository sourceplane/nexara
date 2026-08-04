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
  /**
   * Where threshold alerts are emailed, per environment.
   *
   * **This is a stopgap and it is labelled as one.** The right answer is that a
   * seller names their own tax contact, and the place to ask them is the
   * console — which does not exist until NX8. Resolving "who should hear about
   * this" from membership would mean a second SQL surface on another context's
   * tables, or an email-resolution chain through identity; both are worse than
   * an explicitly temporary var.
   *
   * When unset, the alert row and the outgoing webhook still fire and the row
   * records that no email was sent. The gap is visible rather than silent, and
   * `nexus.alerts.notification_ref` is where you look for it.
   */
  /** Service binding to billing-worker for the §9 plan-limit check. Optional:
   *  an unbound environment monitors every jurisdiction rather than none. */
  BILLING_WORKER?: Fetcher;
  NEXUS_ALERT_EMAIL?: string;
}
