import type { NewsSignal } from "@/lib/news/types";

export const ACTIVE_DEEP_CONTEXT_SYMBOLS = ["AAPL", "NVDA", "AMZN", "TSLA", "SPCX"] as const;

export type ActiveDeepContextSymbol = (typeof ACTIVE_DEEP_CONTEXT_SYMBOLS)[number];
export type NewsSourceMethod = "rss" | "directFeed" | "directPage" | "api";
export type RetrievalStatus = "read" | "summaryOnly" | "unavailable" | "paywalled" | "blocked";
export type EvidenceSourceTier = "primary" | "reputable" | "specialist" | "general" | "aggregator";
export type EvidenceMateriality = "high" | "medium" | "low";
export type EvidenceType = "primaryDisclosure" | "reportedEvent" | "commentary";

export type TickerNewsProfile = {
  symbol: string;
  companyName: string;
  aliases: string[];
  topics: string[];
  officialDomains?: string[];
  /** Regulators and mission authorities that can publish primary evidence. */
  primaryDomains?: string[];
};

export type NewsSourceDefinition = {
  id: string;
  label: string;
  method: NewsSourceMethod;
  priority: number;
  allowedDomains: string[];
  buildUrl(profile: TickerNewsProfile): string;
};

// A paid search/news API can implement this interface later without changing
// selection, retrieval, persistence, duplicate detection, or reporting.
export type NewsDiscoveryProvider = {
  source: NewsSourceDefinition;
  discover(profile: TickerNewsProfile): Promise<DiscoveredNewsCandidate[]>;
};

export type DiscoveredNewsCandidate = {
  id: string;
  symbol: string;
  title: string;
  summary?: string;
  source: string;
  sourceId: string;
  sourceMethod: NewsSourceMethod;
  url: string;
  publishedAt?: string;
  author?: string;
  sourcePriority?: number;
  raw?: unknown;
};

export type RetrievedNewsCandidate = DiscoveredNewsCandidate & {
  canonicalUrl: string;
  cleanText?: string;
  excerpt?: string;
  contentHash: string;
  retrievalStatus: RetrievalStatus;
  failureReason?: string;
  retrievedAt: string;
  relevanceScore: number;
  qualityScore: number;
  companyFocusScore: number;
  evidenceDepthScore: number;
  sourceTier: EvidenceSourceTier;
  materiality: EvidenceMateriality;
  evidenceType: EvidenceType;
  eventDate?: string;
  evidencePolicyVersion: "strong-evidence-v1";
  qualityFlags: string[];
  topic: string;
  duplicateGroupId?: string;
  signal: NewsSignal;
  signalScore: number;
  matchedTerms: string[];
};

export type RejectedNewsCandidate = {
  candidate: DiscoveredNewsCandidate;
  reason: string;
  rejectedAt: string;
};

export type SourceAttempt = {
  sourceId: string;
  symbol: string;
  attemptedAt: string;
  candidateCount: number;
  status: "success" | "failed";
  failureReason?: string;
};

export type TickerCollectionOutcome = {
  symbol: string;
  selected?: RetrievedNewsCandidate;
  supporting: RetrievedNewsCandidate[];
  discoveredCount: number;
  rejected: RejectedNewsCandidate[];
  duplicatesRemoved: number;
  retrievalSuccesses: number;
  retrievalFailures: number;
  shortfallReason?: string;
};

export type DailyCollectionOutcome = {
  marketDate: string;
  runKey: string;
  targetCount: number;
  selected: RetrievedNewsCandidate[];
  supporting: RetrievedNewsCandidate[];
  sourceAttempts: SourceAttempt[];
  rejected: RejectedNewsCandidate[];
  tickerOutcomes: TickerCollectionOutcome[];
  duplicateStoriesRemoved: number;
  fullTextRetrievalSuccesses: number;
  fullTextRetrievalFailures: number;
};
