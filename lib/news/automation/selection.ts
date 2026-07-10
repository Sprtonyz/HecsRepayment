import { contentHash, normalizedTitle } from "@/lib/news/automation/normalization";
import type {
  DiscoveredNewsCandidate,
  RejectedNewsCandidate,
  RetrievedNewsCandidate,
  TickerNewsProfile,
} from "@/lib/news/automation/types";

const NOISE_PATTERNS = [
  /\b(stock (is|to|price|forecast|prediction|quote)|share price|buy or sell|is .* a buy)\b/i,
  /\b(analyst (says|rating|upgrades?|downgrades?)|price target)\b/i,
  /\b(top \d+|best stocks?|market recap)\b/i,
];

export function scoreCandidate(candidate: DiscoveredNewsCandidate, profile: TickerNewsProfile) {
  const text = `${candidate.title} ${candidate.summary ?? ""}`.toLowerCase();
  const aliasMatches = profile.aliases.filter((alias) => text.includes(alias.toLowerCase())).length;
  const topicMatches = profile.topics.filter((topic) => text.includes(topic.toLowerCase())).length;
  const sourceBoost = candidate.sourceMethod === "directFeed" ? 35 : candidate.sourceId.includes("fundamentals") ? 18 : 10;
  const noisePenalty = NOISE_PATTERNS.some((pattern) => pattern.test(text)) ? 35 : 0;
  const stalePenalty = candidate.publishedAt && Date.now() - Date.parse(candidate.publishedAt) > 7 * 86_400_000 ? 20 : 0;
  return Math.max(0, sourceBoost + aliasMatches * 25 + topicMatches * 9 - noisePenalty - stalePenalty);
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
    .filter((candidate) => candidate.retrievalStatus !== "blocked" && candidate.retrievalStatus !== "paywalled")
    .sort(
      (left, right) =>
        right.qualityScore - left.qualityScore ||
        right.relevanceScore - left.relevanceScore ||
        (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
    )[0];
}
