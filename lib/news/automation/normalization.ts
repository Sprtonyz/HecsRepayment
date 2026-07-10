import { createHash } from "node:crypto";

export function normalizeUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|guce_referrer|ocid|cmpid|ref|src)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function normalizedTitle(value: string) {
  return value
    .replace(/\s+-\s+[a-z][a-z0-9 .&']+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function contentHash(value: string) {
  return createHash("sha256").update(value.replace(/\s+/g, " ").trim()).digest("hex");
}

export function stableId(prefix: string, value: string) {
  return `${prefix}:${contentHash(value).slice(0, 32)}`;
}

export function excerpt(value: string, maxLength = 700) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}
