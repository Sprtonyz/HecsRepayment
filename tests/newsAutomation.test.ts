import { describe, expect, it } from "vitest";
import { getActiveDeepContextSymbols, getNewsSourcesForSymbol, getTickerNewsProfile } from "@/lib/news/automation/sourceRegistry";
import {
  assessStrongEvidence,
  groupNearDuplicates,
  isSupportingContext,
  rejectUnsuitableCandidates,
  scoreCandidate,
  selectBestTickerStory,
  strongEvidenceRejectionReason,
} from "@/lib/news/automation/selection";
import { toPerceptionSignal } from "@/lib/news/automation/perception";
import type { DiscoveredNewsCandidate, RetrievedNewsCandidate } from "@/lib/news/automation/types";

describe("automated Deep Context news selection", () => {
  it("defaults to the five configured Deep Context tickers", () => {
    expect(getActiveDeepContextSymbols()).toEqual(["AAPL", "NVDA", "AMZN", "TSLA", "SPCX"]);
  });

  it("uses a first-party source before discovery feeds for every active ticker", () => {
    for (const symbol of getActiveDeepContextSymbols()) {
      const source = getNewsSourcesForSymbol(symbol)[0];
      expect(source?.priority).toBe(100);
      expect(["directFeed", "directPage"]).toContain(source?.method);
    }
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

  it("keeps credible sub-threshold context out of the daily target", () => {
    const context = {
      ...retrieved("Apple reports an update", 60, "read", "Apple announced a material update. ".repeat(40), "https://www.apple.com/newsroom/update"),
      qualityScore: 62,
      companyFocusScore: 24,
      materiality: "medium" as const,
      sourceTier: "primary" as const,
      qualityFlags: ["below-strong-evidence-threshold"],
    };
    expect(isSupportingContext(context)).toBe(true);
    expect(selectBestTickerStory([context])).toBeUndefined();
  });

  it("keeps reputable reporting about an unconfirmed catalyst in the perception lane", () => {
    const report = {
      ...retrieved(
        "Reuters reports Apple is considering a new services partnership",
        60,
        "read",
        "Reuters reports that people familiar with the matter say Apple is considering a new services partnership. Apple may announce terms before its next earnings release. The discussions remain ongoing and Apple has not confirmed the plan. ".repeat(8),
        "https://www.reuters.com/technology/apple-services-partnership",
      ),
      companyFocusScore: 26,
      sourceTier: "reputable" as const,
      materiality: "medium" as const,
      qualityFlags: ["below-strong-evidence-threshold", "commentary-without-business-event"],
      independentSourceCount: 2,
    };
    const signal = toPerceptionSignal(report);

    expect(signal?.perceptionKind).toBe("reported");
    expect(signal?.perceptionScore).toBeGreaterThanOrEqual(60);
    expect(signal?.independentSourceCount).toBe(2);
    expect(signal?.catalystTags).toContain("earnings");
    expect(selectBestTickerStory([report])).toBeUndefined();
  });

  it("rejects uncorroborated aggregator speculation from the perception lane", () => {
    const aggregatorRumour = {
      ...retrieved("Apple may make a major move", 60, "read", "Apple may make a major move. ".repeat(60)),
      companyFocusScore: 26,
      sourceTier: "aggregator" as const,
      materiality: "medium" as const,
      qualityFlags: ["below-strong-evidence-threshold", "commentary-without-business-event"],
    };
    expect(toPerceptionSignal(aggregatorRumour)).toBeUndefined();
  });

  it("allows an attributable analyst expectation into perception, but still rejects price targets", () => {
    const profile = getTickerNewsProfile("AAPL");
    const expectation = candidate("Analyst expects Apple Services momentum to continue", "The analyst expects Services growth to remain resilient.");
    const priceTarget = candidate("Analyst raises Apple price target", "A price target update without a business development.");
    const filtered = rejectUnsuitableCandidates([expectation, priceTarget], profile, "2026-07-10T00:00:00.000Z");

    expect(filtered.accepted).toEqual([expectation]);
    expect(filtered.rejected[0]?.reason).toBe("headline-noise-or-price-action");
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
