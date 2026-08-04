import { uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

// Public id prefixes for this context. `chn_`, `sev_`, `det_`, `reg_`, `dlv_`
// are fixed by the epic charter; `rst_` and `rul_` were added at NX1 because
// rule and rule-set ids also cross the boundary — `PublicDetermination.ruleId`
// is one third of the reproducibility triple.

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}
export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function channelPublicId(uuid: string): string {
  return `chn_${uuidToHex(uuid)}`;
}
export function parseChannelPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "chn");
}

export function saleEventPublicId(uuid: string): string {
  return `sev_${uuidToHex(uuid)}`;
}
export function parseSaleEventPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "sev");
}

export function determinationPublicId(uuid: string): string {
  return `det_${uuidToHex(uuid)}`;
}
export function parseDeterminationPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "det");
}

export function registrationPublicId(uuid: string): string {
  return `reg_${uuidToHex(uuid)}`;
}

export function ruleSetPublicId(uuid: string): string {
  return `rst_${uuidToHex(uuid)}`;
}

export function rulePublicId(uuid: string): string {
  return `rul_${uuidToHex(uuid)}`;
}

export function alertPublicId(uuid: string): string {
  return `alr_${uuidToHex(uuid)}`;
}
