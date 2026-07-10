import { describe, expect, it } from "vitest";
import { getActiveDeepContextSymbols, getTickerNewsProfile } from "@/lib/news/automation/sourceRegistry";
import {
  groupNearDuplicates,
  rejectUnsuitableCandidates,
  scoreCandidate,
  selectBestTickerStory,
} from "@/lib/news/automation/selection";
import type { DiscoveredNewsCandidate, RetrievedNewsCandidate } from "@/lib/news/automation/types";

describe("automated Deep Context news selection", () => {
  it("defaults to the five configured Deep Context tickers", () => {
    expect(getActiveDeepContextSymbols()).toEqual(["AAPL", "NVDA", "AMZN", "TSLA", "SPCX"]);
  });

  it("rejects price-action noise and retains company-specific candidates", () => {
    const profile = getTickerNewsProfile("AAPL");
    const useful = candidate("Apple reports services growth", "Apple revenue and services improved");
    const noisy = candidate("Apple stock is a buy after share price jump", "Analyst price target update");
    const result = rejectUnsuitableCandidates([useful, noisy], profile, "2026-07-10T00:00:00.000Z");

    expect(result.accepted).toEqual([useful]);
    expect(result.rejected[0]?.reason).toBe("headline-noise-or-price-action");
    expect(scoreCandidate(useful, profile)).toBeGreaterThan(25);
  });

  it("keeps one highest-quality representative from a duplicate cluster", () => {
    const first = retrieved("Apple faces App Store pressure in Europe", 65, "summaryOnly");
    const second = retrieved("Apple faces App Store pressure in Europe - Reuters", 90, "read");
    const grouped = groupNearDuplicates([first, second]);

    expect(grouped.removed).toBe(1);
    expect(grouped.representatives).toHaveLength(1);
    expect(grouped.representatives[0]?.title).toContain("Reuters");
    expect(selectBestTickerStory(grouped.representatives)?.retrievalStatus).toBe("read");
  });

  it("does not fabricate a selected article when every candidate is blocked", () => {
    expect(selectBestTickerStory([retrieved("Apple update", 80, "blocked")])).toBeUndefined();
  });
});

function candidate(title: string, summary: string): DiscoveredNewsCandidate {
  return {
    id: title,
    symbol: "AAPL",
    title,
    summary,
    source: "Reuters",
    sourceId: "google-news-company-rss",
    sourceMethod: "rss",
    url: `https://example.com/${encodeURIComponent(title)}`,
    publishedAt: "2026-07-10T00:00:00.000Z",
  };
}

function retrieved(
  title: string,
  qualityScore: number,
  retrievalStatus: RetrievedNewsCandidate["retrievalStatus"],
): RetrievedNewsCandidate {
  return {
    ...candidate(title, title),
    canonicalUrl: `https://example.com/${encodeURIComponent(title)}`,
    cleanText: `${title} full readable article text`,
    excerpt: title,
    contentHash: title,
    retrievalStatus,
    retrievedAt: "2026-07-10T00:00:00.000Z",
    relevanceScore: qualityScore,
    qualityScore,
    topic: "legalRegulatory",
    signal: "negative",
    signalScore: -1,
    matchedTerms: [],
  };
}
