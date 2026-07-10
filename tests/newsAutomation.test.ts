import { describe, expect, it } from "vitest";
import { getActiveDeepContextSymbols, getTickerNewsProfile } from "@/lib/news/automation/sourceRegistry";
import {
  assessStrongEvidence,
  groupNearDuplicates,
  rejectUnsuitableCandidates,
  scoreCandidate,
  selectBestTickerStory,
  strongEvidenceRejectionReason,
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

  it("rejects multi-company stock roundups before they can satisfy the daily target", () => {
    const profile = getTickerNewsProfile("AAPL");
    const roundup = candidate(
      "Top Stock Reports for Apple, KLA Corp. & Western Digital",
      "Apple is one of several companies in this research roundup.",
    );
    const result = rejectUnsuitableCandidates([roundup], profile, "2026-07-10T00:00:00.000Z");

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("multi-company-roundup");
  });

  it("requires a clean, company-focused material event to meet the strong-evidence threshold", () => {
    const profile = getTickerNewsProfile("AAPL");
    const strong = assessStrongEvidence(
      retrieved(
        "Apple launches new enterprise services platform",
        0,
        "read",
        "Apple announced a new enterprise services platform after reporting 18% services revenue growth. The launch expands Apple services with a named partner and a multiyear contract worth $2 billion. Apple said the platform will be available in September. Apple will report additional details in its next earnings release. Apple services remains a central growth driver. The company said the platform combines device management, privacy controls and enterprise support in one service. Apple confirmed that the product will be sold through its existing business sales channel and will be available in 24 countries at launch. Management said the offering addresses demand from large organisations that want to deploy Apple devices while keeping employee data protected. Apple expects the new service to contribute to recurring services revenue over time.",
        "https://www.apple.com/newsroom/2026/07/apple-launches-services-platform/",
      ),
      profile,
    );
    const weak = assessStrongEvidence(
      retrieved(
        "Apple stock could rise next year",
        0,
        "summaryOnly",
        "Apple stock could rise according to an analyst forecast.",
        "https://example.com/apple-stock-forecast",
      ),
      profile,
    );

    expect(strong.qualityScore).toBeGreaterThanOrEqual(70);
    expect(strong.qualityFlags).toEqual([]);
    expect(strong.sourceTier).toBe("primary");
    expect(strongEvidenceRejectionReason(weak)).toBe("thin-summary");
    expect(selectBestTickerStory([weak, strong])?.title).toBe(strong.title);
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
  cleanText = `${title} full readable article text`,
  canonicalUrl = `https://example.com/${encodeURIComponent(title)}`,
): RetrievedNewsCandidate {
  return {
    ...candidate(title, title),
    canonicalUrl,
    cleanText,
    excerpt: title,
    contentHash: title,
    retrievalStatus,
    retrievedAt: "2026-07-10T00:00:00.000Z",
    relevanceScore: qualityScore,
    qualityScore,
    companyFocusScore: 0,
    evidenceDepthScore: 0,
    sourceTier: "general",
    materiality: "low",
    evidenceType: "commentary",
    evidencePolicyVersion: "strong-evidence-v1",
    qualityFlags: [],
    topic: "legalRegulatory",
    signal: "negative",
    signalScore: -1,
    matchedTerms: [],
  };
}
