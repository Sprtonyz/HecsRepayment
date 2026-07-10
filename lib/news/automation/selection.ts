import { contentHash, normalizedTitle } from "@/lib/news/automation/normalization";
import type {
  DiscoveredNewsCandidate,
  EvidenceMateriality,
  EvidenceSourceTier,
  EvidenceType,
  RejectedNewsCandidate,
  RetrievedNewsCandidate,
  TickerNewsProfile,
} from "@/lib/news/automation/types";

export const STRONG_EVIDENCE_THRESHOLD = 70;

const NOISE_PATTERNS = [
  /\b(stock (is|to|price|forecast|prediction|quote)|share price|buy or sell|is .* a buy)\b/i,
  /\b(analyst (says|rating|upgrades?|downgrades?)|price target)\b/i,
  /\b(top \d+|best stocks?|market recap)\b/i,
];
const ROUNDUP_PATTERNS = [
  /\b(top (stock|analyst|research) reports?|research daily|analyst blog highlights?|market recap|daily roundup)\b/i,
  /\b(highlights? (apple|nvidia|amazon|tesla|spacex).*(and|,).*)\b/i,
];
const EXTRACTION_NOISE_PATTERNS = [
  /\boops,? something went wrong\b/i,
  /\bskip to (navigation|main content|right column)\b/i,
  /\bterms and privacy\b/i,
  /\byour privacy choices\b/i,
  /\bsign up (there|to|get)\b/i,
];
const MATERIAL_EVENT_PATTERN = /\b(earnings|revenue|guidance|margin|launch(?:es|ed|ing)?|introduc(?:es|ed|ing)?|announc(?:es|ed|ing)?|files?|approval|regulat(?:ion|ory)|antitrust|lawsuit|investigation|settlement|tariff|export controls?|supply (?:constraint|shortage)|recall|deliver(?:y|ies)|production|contract|partnership|acquisition|buyback|repurchase|dividend)\b/i;
const DIRECT_DISCLOSURE_PATTERN = /\b(announc(?:es|ed|ing)?|launch(?:es|ed|ing)?|reports?|file[sd]?|approv(?:es|ed|al)|wins?|secures?|introduc(?:es|ed|ing)?)\b/i;
const COMMENTARY_PATTERN = /\b(prediction|forecast|price target|what investors|buy rating|sell rating|outlook for the stock)\b/i;

export function scoreCandidate(candidate: DiscoveredNewsCandidate, profile: TickerNewsProfile) {
  const text = `${candidate.title} ${candidate.summary ?? ""}`.toLowerCase();
  const aliasMatches = profile.aliases.filter((alias) => text.includes(alias.toLowerCase())).length;
  const topicMatches = profile.topics.filter((topic) => text.includes(topic.toLowerCase())).length;
  const sourceBoost = candidate.sourceMethod === "directFeed"
    ? 35
    : candidate.sourceId.includes("official")
      ? 30
      : candidate.sourceId.includes("fundamentals")
        ? 18
        : 10;
  const noisePenalty = NOISE_PATTERNS.some((pattern) => pattern.test(text)) ? 35 : 0;
  const roundupPenalty = hasRoundupHeadline(candidate.title) ? 40 : 0;
  const stalePenalty = candidate.publishedAt && Date.now() - Date.parse(candidate.publishedAt) > 7 * 86_400_000 ? 20 : 0;
  return Math.max(0, sourceBoost + aliasMatches * 25 + topicMatches * 9 - noisePenalty - roundupPenalty - stalePenalty);
}

export function rejectUnsuitableCandidates(
  candidates: DiscoveredNewsCandidate[],
  profile: TickerNewsProfile,
  rejectedAt: string,
) {
  const accepted: DiscoveredNewsCandidate[] = [];
  const rejected: RejectedNewsCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const text = `${candidate.title} ${candidate.summary ?? ""}`.toLowerCase();
    const aliases = profile.aliases.some((alias) => text.includes(alias.toLowerCase()));
    const titleKey = normalizedTitle(candidate.title);
    const key = `${candidate.symbol}:${titleKey}`;
    const reason = !aliases && candidate.sourceMethod !== "directFeed"
      ? "company-not-mentioned"
      : hasRoundupHeadline(candidate.title)
        ? "multi-company-roundup"
        : NOISE_PATTERNS.some((pattern) => pattern.test(text))
          ? "headline-noise-or-price-action"
          : seen.has(key)
            ? "exact-duplicate-title"
            : undefined;
    if (reason) {
      rejected.push({ candidate, reason, rejectedAt });
      continue;
    }
    seen.add(key);
    accepted.push(candidate);
  }

  return { accepted, rejected };
}

export function assessStrongEvidence(
  candidate: RetrievedNewsCandidate,
  profile: TickerNewsProfile,
): RetrievedNewsCandidate {
  const text = `${candidate.title}\n${candidate.cleanText ?? candidate.summary ?? ""}`.replace(/\s+/g, " ").trim();
  const aliasPattern = companyAliasPattern(profile);
  const companyMentions = countMatches(text, aliasPattern);
  aliasPattern.lastIndex = 0;
  const titleMentionsCompany = aliasPattern.test(candidate.title);
  const sourceTier = sourceTierFor(candidate);
  const extractionNoiseCount = EXTRACTION_NOISE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const textLength = (candidate.cleanText ?? candidate.summary ?? "").trim().length;
  const eventDetected = MATERIAL_EVENT_PATTERN.test(text);
  const commentaryOnly = COMMENTARY_PATTERN.test(text) && !eventDetected;
  const companyFocusScore = Math.min(30, (titleMentionsCompany ? 14 : 0) + Math.min(16, companyMentions * 4));
  const evidenceDepthScore = evidenceDepth(text);
  const materiality = materialityFor(candidate.topic, eventDetected, evidenceDepthScore);
  const materialityScore = materiality === "high" ? 25 : materiality === "medium" ? 17 : 8;
  const sourceScore = sourceQualityScore(sourceTier);
  const textScore = textQualityScore(candidate.retrievalStatus, textLength, extractionNoiseCount, sourceTier);
  const recencyScore = recencyScoreFor(candidate.publishedAt);
  const thesisRelevanceScore = thesisRelevanceScoreFor(text, profile);
  const qualityScore = Math.min(
    100,
    companyFocusScore + materialityScore + sourceScore + textScore + recencyScore + thesisRelevanceScore,
  );
  const qualityFlags = [
    ...(hasRoundupHeadline(candidate.title) ? ["multi-company-roundup"] : []),
    ...(companyFocusScore < 20 ? ["not-company-focused"] : []),
    ...(candidate.retrievalStatus !== "read" && textScore < 8 ? ["thin-summary"] : []),
    ...(textLength < 600 ? ["insufficient-evidence-text"] : []),
    ...(extractionNoiseCount >= 2 ? ["unusable-extracted-text"] : []),
    ...(recencyScore === 0 ? ["stale-candidate"] : []),
    ...(commentaryOnly ? ["commentary-without-business-event"] : []),
    ...(qualityScore < STRONG_EVIDENCE_THRESHOLD ? ["below-strong-evidence-threshold"] : []),
  ];

  return {
    ...candidate,
    qualityScore,
    companyFocusScore,
    evidenceDepthScore,
    sourceTier,
    materiality,
    evidenceType: evidenceTypeFor(sourceTier, eventDetected),
    eventDate: eventDetected ? candidate.publishedAt : undefined,
    evidencePolicyVersion: "strong-evidence-v1",
    qualityFlags,
  };
}

export function strongEvidenceRejectionReason(candidate: RetrievedNewsCandidate) {
  return candidate.qualityFlags[0];
}

export function groupNearDuplicates(candidates: RetrievedNewsCandidate[]) {
  const groups = new Map<string, RetrievedNewsCandidate[]>();
  for (const candidate of candidates) {
    const tokens = normalizedTitle(candidate.title).split(" ").filter((token) => token.length > 3).sort();
    const signature = contentHash(tokens.slice(0, 8).join(" ")).slice(0, 16);
    const group = groups.get(signature) ?? [];
    group.push(candidate);
    groups.set(signature, group);
  }

  const representatives: RetrievedNewsCandidate[] = [];
  let removed = 0;
  for (const [signature, group] of groups) {
    group.sort((left, right) => right.qualityScore - left.qualityScore || right.relevanceScore - left.relevanceScore);
    const representative = { ...group[0], duplicateGroupId: `dup:${signature}` };
    representatives.push(representative);
    removed += Math.max(0, group.length - 1);
  }
  return { representatives, removed };
}

export function selectBestTickerStory(candidates: RetrievedNewsCandidate[]) {
  return [...candidates]
    .filter(
      (candidate) =>
        candidate.retrievalStatus !== "blocked" &&
        candidate.retrievalStatus !== "paywalled" &&
        candidate.qualityScore >= STRONG_EVIDENCE_THRESHOLD &&
        candidate.qualityFlags.length === 0,
    )
    .sort(
      (left, right) =>
        right.qualityScore - left.qualityScore ||
        right.relevanceScore - left.relevanceScore ||
        (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
    )[0];
}

function hasRoundupHeadline(title: string) {
  return ROUNDUP_PATTERNS.some((pattern) => pattern.test(title));
}

function companyAliasPattern(profile: TickerNewsProfile) {
  const aliases = Array.from(new Set(profile.aliases.map((alias) => alias.trim()).filter(Boolean)))
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex);
  return new RegExp(`\\b(?:${aliases.join("|")})\\b`, "gi");
}

function countMatches(value: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return Array.from(value.matchAll(pattern)).length;
}

function sourceTierFor(candidate: RetrievedNewsCandidate): EvidenceSourceTier {
  if (candidate.sourceMethod === "directFeed") return "primary";
  let hostname = "";
  try {
    hostname = new URL(candidate.canonicalUrl).hostname.toLowerCase();
  } catch {
    return "aggregator";
  }
  if (matchesDomain(hostname, ["sec.gov", "apple.com", "aboutamazon.com", "nvidianews.nvidia.com", "ir.tesla.com", "spacex.com"])) {
    return "primary";
  }
  if (matchesDomain(hostname, ["reuters.com", "apnews.com", "ft.com", "bloomberg.com", "wsj.com", "nytimes.com"])) {
    return "reputable";
  }
  if (matchesDomain(hostname, ["theverge.com", "techcrunch.com", "arstechnica.com", "cnbc.com", "theinformation.com"])) {
    return "specialist";
  }
  if (matchesDomain(hostname, ["news.google.com", "feeds.finance.yahoo.com"])) return "aggregator";
  return "general";
}

function matchesDomain(hostname: string, domains: string[]) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function sourceQualityScore(tier: EvidenceSourceTier) {
  return tier === "primary" ? 15 : tier === "reputable" ? 12 : tier === "specialist" ? 9 : tier === "general" ? 6 : 0;
}

function textQualityScore(
  status: RetrievedNewsCandidate["retrievalStatus"],
  textLength: number,
  extractionNoiseCount: number,
  tier: EvidenceSourceTier,
) {
  if (status === "read" && textLength >= 1_000 && extractionNoiseCount === 0) return 15;
  if (status === "read" && textLength >= 800 && extractionNoiseCount <= 1) return 11;
  if (status === "read" && textLength >= 600) return 7;
  if (status === "summaryOnly" && textLength >= 700 && (tier === "primary" || tier === "reputable")) return 6;
  return 0;
}

function recencyScoreFor(publishedAt: string | undefined) {
  if (!publishedAt) return 0;
  const ageMs = Date.now() - Date.parse(publishedAt);
  if (!Number.isFinite(ageMs) || ageMs > 7 * 86_400_000) return 0;
  if (ageMs <= 3 * 86_400_000) return 10;
  return 6;
}

function thesisRelevanceScoreFor(text: string, profile: TickerNewsProfile) {
  const lower = text.toLowerCase();
  const matches = profile.topics.filter((topic) => lower.includes(topic.toLowerCase())).length;
  return Math.min(5, matches * 2 + (matches > 0 ? 1 : 0));
}

function evidenceDepth(text: string) {
  const numericFacts = (text.match(/\b\d+(?:[,.]\d+)?(?:%|\s?(?:million|billion|m|bn))?\b/gi) ?? []).length;
  const eventStatements = (text.match(/\b(announced|launched|reported|filed|approved|delivered|produced|secured|signed)\b/gi) ?? []).length;
  return Math.min(25, Math.min(10, numericFacts) + Math.min(15, eventStatements * 5));
}

function materialityFor(topic: string, eventDetected: boolean, evidenceDepthScore: number): EvidenceMateriality {
  if (eventDetected && evidenceDepthScore >= 15 && topic !== "other") return "high";
  if (eventDetected || (evidenceDepthScore >= 12 && topic !== "other")) return "medium";
  return "low";
}

function evidenceTypeFor(sourceTier: EvidenceSourceTier, eventDetected: boolean): EvidenceType {
  if (sourceTier === "primary") return "primaryDisclosure";
  return eventDetected ? "reportedEvent" : "commentary";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
