// Instance identity for the web console (saas-bootstrap-factory BF3 seam).
//
// Branding strings, deployment hostnames, contact addresses, and storage-key
// namespaces live here so a new instance of the starter retargets one file.
// Do not add behavior — values and trivial derivations only.

/** Product/brand name shown across the console. */
export const PRODUCT_NAME = "Nexara";

/** Browser/document title of the console. */
export const CONSOLE_TITLE = `${PRODUCT_NAME} Console`;

/** Marketing-facing product description (document metadata). */
export const PRODUCT_DESCRIPTION =
  "Economic-nexus threshold monitoring for online sellers. Connect your sales channels, " +
  "see where you have crossed a state's threshold, and show the working.";

/** The Cloudflare account's workers.dev subdomain serving this instance. */
export const WORKERS_DEV_SUBDOMAIN = "rahulvarghesepullely";

/** api-edge workers.dev URL for a given environment name. */
export function apiEdgeWorkersDevUrl(environment: string): string {
  return `https://nexara-api-edge-${environment}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
}

/** Sales contact surfaced by the billing upgrade UX. */
export const SALES_EMAIL = "sales@sourceplane.ai";

/** Namespace prefix for console localStorage keys. */
export const STORAGE_PREFIX = "nexara.next";
