import { contentHash, normalizedTitle } from "@/lib/news/automation/normalization";
import type { PerceptionKind, PerceptionSignal, RetrievedNewsCandidate } from "@/lib/news/automation/types";

const REPORTED_PATTERN = /\b(reports?|reported(?:ly)?|sources? (?:say|said)|according to|people familiar|is said to)\b/i;
const RUMOUR_PATTERN = /\b(rumou?r|speculat|may be|could be|considering|in talks|weighing|expected to)\b/i;
const ANALYST_PATTERN = /\b(analyst(?:s)? (?:expect|believe|see)|consensus expects?)\b/i;
const DENIAL_PATTERN = /\b(den(?:y|ies|ied)|no plans?|not considering|incorrect report)\b/i;

export function toPerceptionSignal(candidate: RetrievedNewsCandidate): PerceptionSignal | undefined {
  const text = `${candidate.title}\n${candidate.cleanText ?? candidate.summary ?? ""}`;
  const perceptionKind = perceptionKindFor(text);
  if (!perceptionKind || !isEligiblePerception(candidate)) return undefined;

  const sourceReliability = baselineReliability(candidate.sourceTier);
  const specificity = REPORTED_PATTERN.test(text) ? 25 : RUMOUR_PATTERN.test(text) ? 17 : 12;
  const focus = Math.min(15, Math.round(candidate.companyFocusScore / 2));
  const score = Math.min(100, Math.round(sourceReliability * 35 + specificity + focus + 20 + (candidate.publishedAt ? 5 : 0)));
  if (score < 60) return undefined;

  const published = candidate.publishedAt ? new Date(candidate.publishedAt) : new Date(candidate.retrievedAt);
  const expiry = new Date(published.getTime() + 14 * 86_400_000).toISOString();
  return {
    ...candidate,
    perceptionKind,
    perceptionScore: score,
    corroborationKey: perceptionKey(candidate.title),
    independentSourceCount: candidate.independentSourceCount ?? 1,
    sourceReliability,
    catalystTags: catalystTagsFor(candidate),
    resolutionStatus: "open",
    expiresAt: expiry,
  };
}

export function perceptionKey(title: string) {
  const tokens = normalizedTitle(title)
    .replace(/\b(reports?|reported|reportedly|sources?|rumou?r|speculation|analyst|expects?|considering|could|may)\b/g, " ")
    .split(" ")
    .filter((token) => token.length > 3)
    .sort();
  return `perception:${contentHash(tokens.slice(0, 10).join(" ")).slice(0, 18)}`;
}

export function isPrimaryEvidenceDenial(candidate: RetrievedNewsCandidate) {
  return candidate.sourceTier === "primary" && DENIAL_PATTERN.test(`${candidate.title}\n${candidate.cleanText ?? ""}`);
}

function isEligiblePerception(candidate: RetrievedNewsCandidate) {
  const disallowedFlags = candidate.qualityFlags.filter(
    (flag) => flag !== "below-strong-evidence-threshold" && flag !== "commentary-without-business-event",
  );
  return (
    candidate.retrievalStatus === "read" &&
    candidate.sourceTier !== "primary" &&
    candidate.sourceTier !== "aggregator" &&
    candidate.companyFocusScore >= 20 &&
    (candidate.cleanText?.length ?? 0) >= 800 &&
    disallowedFlags.length === 0
  );
}

function perceptionKindFor(text: string): PerceptionKind | undefined {
  if (REPORTED_PATTERN.test(text)) return "reported";
  if (RUMOUR_PATTERN.test(text)) return "rumour";
  if (ANALYST_PATTERN.test(text)) return "analystView";
  return undefined;
}

function baselineReliability(tier: RetrievedNewsCandidate["sourceTier"]) {
  return tier === "reputable" ? 0.8 : tier === "specialist" ? 0.68 : tier === "general" ? 0.55 : 0.35;
}

function catalystTagsFor(candidate: RetrievedNewsCandidate) {
  const text = `${candidate.title} ${candidate.cleanText ?? candidate.summary ?? ""}`.toLowerCase();
  const tags = new Set<string>([candidate.topic]);
  if (/earnings|revenue|guidance|margin/.test(text)) tags.add("earnings");
  if (/launch|iphone|gpu|aws|starship|model [0-9]/.test(text)) tags.add("product-or-launch");
  if (/regulat|antitrust|lawsuit|court|doj|ftc|nhtsa/.test(text)) tags.add("regulatory");
  if (/deliver(?:y|ies)|production|launch window|mission/.test(text)) tags.add("operations");
  return [...tags].filter((tag) => tag !== "other");
}
