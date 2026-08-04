import type { MigrationManifest } from "./types.js";

export const manifest: MigrationManifest = {
  version: 1,
  migrations: [
    {
      id: "000_control_baseline",
      context: "control",
      path: "000_control/up.sql",
      checksum:
        "2a5d7f30684c99e3ff441ca8a2c38038dedd1bab4db4a40e92cd36bb22be297f",
      description:
        "Baseline control migration — creates the migration tracking schema",
    },
    {
      id: "010_identity_core",
      context: "identity",
      path: "010_identity_core/up.sql",
      checksum:
        "f8db63c83e2b1b29e6d0b9b133a7db490e2adcfdf26bfc6ce55c63c8a629075d",
      description:
        "Identity persistence foundation — users, auth identities, login challenges, sessions",
    },
    {
      id: "020_membership_core",
      context: "membership",
      path: "020_membership_core/up.sql",
      checksum:
        "50da482998db74431866aa5285737026239a28618017019320ee7bb20e49381d",
      description:
        "Membership persistence foundation — organizations, members, invitations, role assignments",
    },
    {
      id: "030_events_audit_core",
      context: "events",
      path: "030_events_audit_core/up.sql",
      checksum:
        "388aa634380200595ff3a3d15c638e696bf9b93e46330327e84ef10cec8a3f58",
      description:
        "Events/audit persistence foundation — canonical event log and audit entry projections",
    },
    {
      id: "040_projects_core",
      context: "projects",
      path: "040_projects_core/up.sql",
      checksum:
        "d7cb842130856986157629965fd9afba6b36e737e73b125884b64976d2f8b7f6",
      description:
        "Projects persistence foundation — projects and environments tables with tenant isolation",
    },
    {
      id: "050_identity_security_events",
      context: "identity",
      path: "050_identity_security_events/up.sql",
      checksum:
        "a1bb9f50075ea93e389feb7c7282bdbd5b5ebf6671f789b0f7a707110ae74ca2",
      description:
        "Identity-owned security-event source facts — pre-organization user activity log",
    },
    {
      id: "060_identity_api_keys",
      context: "identity",
      path: "060_identity_api_keys/up.sql",
      checksum:
        "834e71e40f729cdf1cd4db32a4071b62c09fd63c9ea4bbf0c035c15c94ff99a1",
      description:
        "Identity-owned service principals and API keys — org-bound automation actors and credential persistence",
    },
    {
      id: "070_config_settings_flags",
      context: "config",
      path: "070_config_settings_flags/up.sql",
      checksum:
        "be2b60f0ddb6f342a8c9038db602e142a34d36ffa7f7a17f4d218231087d6562",
      description:
        "Config persistence foundation — scoped settings, feature flags, and secret metadata",
    },
    {
      id: "080_webhooks_core",
      context: "webhooks",
      path: "080_webhooks_core/up.sql",
      checksum:
        "bfffc592f82028dd06865833bfd5e8124dbfe51e2e02aecccea4b14b42e9f2a6",
      description:
        "Webhook persistence foundation — endpoints, subscriptions, and delivery attempts",
    },
    {
      id: "090_webhooks_delivery",
      context: "webhooks",
      path: "090_webhooks_delivery/up.sql",
      checksum:
        "a881356b376afd2cccbf326a9bfb7e393e073cd88b3923a38d34907457c39021",
      description:
        "Webhook delivery runtime — fixes event_id type, adds dispatch cursor and delivery indexes",
    },
    {
      id: "100_metering_foundation",
      context: "metering",
      path: "100_metering_foundation/up.sql",
      checksum:
        "d02693e6ec3d76193d58b9038a211c877adbf1c141e4f40d9ca8bb7a78c90930",
      description:
        "Metering persistence foundation — usage records, rollups, quota definitions, and quota violations",
    },
    {
      id: "110_billing_foundation",
      context: "billing",
      path: "110_billing_foundation/up.sql",
      checksum:
        "980564a806e89c0039f012f7c0ec49267920aea549b394c5af3712722e4b9f8f",
      description:
        "Billing persistence foundation — provider-neutral plans, billing customers, subscriptions, invoices, and entitlements",
    },
    {
      id: "120_notifications_core",
      context: "notifications",
      path: "120_notifications_core/up.sql",
      checksum:
        "868cc1092b4b385b6ed3d203efe5302191865131bb98d0e9f5fe5ad6d16f01bb",
      description:
        "Notifications persistence foundation — preferences, notifications, attempts, suppressions",
    },
    {
      id: "130_webhook_secret_rotation_grace",
      context: "webhooks",
      path: "130_webhook_secret_rotation_grace/up.sql",
      checksum:
        "4c5474e7b5ca228adc18ca09b7cd2387938efab8f1e55b675fd4aee6e3ec4e5a",
      description:
        "Dual-secret rotation window — adds previous_secret_{ciphertext,version,expires_at} for grace-period delivery signing",
    },
    {
      id: "140_support_action_records",
      context: "support",
      path: "140_support_action_records/up.sql",
      checksum:
        "50262de186b5ec91797e25532b56cf69028f3975dcc58751c07de6ef1517f190",
      description:
        "Support persistence foundation — append-only audited support-action ledger owned by the admin-support worker",
    },
    {
      id: "150_entitlement_decision_observations",
      context: "billing",
      path: "150_entitlement_decision_observations/up.sql",
      checksum:
        "ba7a1a00ad723752e1bdedc8bcd47c210b24ae18bd3245cb71af84432aefa7f8",
      description:
        "Entitlement-decision observability — append-only, counts-only observation table (org × entitlement key × outcome) owned by the billing context",
    },
    {
      id: "160_identity_user_last_org",
      context: "identity",
      path: "160_identity_user_last_org/up.sql",
      checksum:
        "d102ce426114b032407f6e03ee2e02de65ccb25e4f42df25b340e5a641829dc6",
      description:
        "Per-user last-viewed organization preference (nullable slug hint on identity.users) backing the console's cross-device default landing",
    },
    {
      id: "170_membership_org_parent",
      context: "membership",
      path: "170_membership_org_parent/up.sql",
      checksum:
        "8af612994d6ad4f76e416ec034cdcfc9e2e416bed04c4fde405481627b4093b2",
      description:
        "Optional parent-organization pointer (nullable parent_org_id on membership.organizations) — the dormant seam for the saas-multi-org-billing epic; NULL = standalone, no behavior change",
    },
    {
      id: "180_integrations_foundation",
      context: "integrations",
      path: "180_integrations_foundation/up.sql",
      checksum:
        "e86ac972013587fcd3b04be5c1daa1306a456990ebbb9d30e9b5d79770772497",
      description:
        "Integrations persistence foundation (IG0, dormant) — provider-agnostic connections, GitHub installation facts, repo links with branch→environment maps, the durable inbound-delivery inbox, and the encrypted installation-token cache",
    },
    {
      id: "190_integrations_delivery_attribution",
      context: "integrations",
      path: "190_integrations_delivery_attribution/up.sql",
      checksum:
        "535487194c9c4a129e013282a5f51a5c3e6e2afb3f15c5a0b5f1028e0c5af73f",
      description:
        "Connection pointer on the inbound-delivery inbox (nullable connection_id + partial index) — lets the per-connection delivery log scope precisely; attributed by the IG2 cron drain",
    },
    {
      id: "200_nexus_core",
      context: "nexus",
      path: "200_nexus_core/up.sql",
      checksum:
        "2873326c14359486494fcff32ac4766218ac810556980c1e3baff6bcf5a81021",
      description:
        "Nexus persistence foundation (NX1) — connected sales channels and the append-only sale-event ledger, with the dedupe unique index that IS the idempotency guarantee and the single-scan aggregation index",
    },
    {
      id: "210_nexus_ingestion",
      context: "channels",
      path: "210_nexus_ingestion/up.sql",
      checksum:
        "ce823cce237f1ee0ef68752c926fdf7add6e1097ad2ae0abb10b0a4a7d13e8c1",
      description:
        "Durable inbound-delivery inbox drained by the channels-worker cron — unique on (provider, provider_delivery_id), due-work partial index, and a retention pointer for the raw provider payload",
    },
    {
      id: "220_nexus_rules",
      context: "nexus",
      path: "220_nexus_rules/up.sql",
      checksum:
        "856db92aad3e4b7af4fe77112a6a15bd5e44e1e88e1fa43b0123389f351e4041",
      description:
        "Versioned rule sets and per-jurisdiction rules — GLOBAL reference data, deliberately not tenant-scoped, with the verified gate and constraints tying threshold_logic to the threshold columns it needs",
    },
    {
      id: "230_nexus_determinations",
      context: "nexus",
      path: "230_nexus_determinations/up.sql",
      checksum:
        "c7bd552851902f9208e4195791848e609e7a7aab05a5e6ab9e99c32390960289",
      description:
        "The immutable determination record — the reproducibility triple (rule_set_version, rule_id, engine_version) plus the exact inputs, never updated, with the internal-only flag carrying the unverified-rule-set gate",
    },
    {
      id: "240_nexus_registrations",
      context: "nexus",
      path: "240_nexus_registrations/up.sql",
      checksum:
        "0f5b122439ca6a06052ec2716ca9f0c8462f7b7c24736e1ba09ed7dae1698cb4",
      description:
        "Seller registration state, the append-only alert log whose unique index is the exactly-once guarantee, and the per-org evaluation watermark keyed on ingested_at",
    },
    {
      id: "250_nexus_synthetic_rule_set",
      context: "nexus",
      path: "250_nexus_synthetic_rule_set/up.sql",
      checksum:
        "d3206f8c610b645049651c7475a6c84890cf136c80f66c937305925d0e734bb4",
      description:
        "The UNVERIFIED starter rule set (NX4) — 51 US jurisdictions plus two display-only international rows, covering every measurement basis, period, marketplace treatment, threshold logic, and deadline variant. verified = false by design §11: every determination it produces is internal-only until a named human with tax-practice accountability verifies a set against primary sources (Q1)",
    },
    {
      id: "260_nexus_alert_contact",
      context: "nexus",
      path: "260_nexus_alert_contact/up.sql",
      checksum:
        "ddac1cf522e0ef4aff99389291fefebd490490aa026af8ce9afb4a81e15a5da6",
      description:
        "Where a seller's threshold alerts go (R10). One accountable contact per org, owned by the nexus context rather than resolved from membership — the evaluation cron has no actor to authorize a cross-context read as, and a second SQL surface on another context's tables is the failure the tenancy scan exists to prevent, arriving from the other direction",
    },
  ],
};
