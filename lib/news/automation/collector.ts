import { fetchReadableArticleText } from "@/lib/news/articleText";
import { scoreNewsText } from "@/lib/news/sentiment";
import { contentHash, excerpt, normalizeUrl, stableId } from "@/lib/news/automation/normalization";
import { getNewsSourcesForSymbol, getTickerNewsProfile } from "@/lib/news/automation/sourceRegistry";
import {
  assessStrongEvidence,
  groupNearDuplicates,
  isSupportingContext,
  rejectUnsuitableCandidates,
  scoreCandidate,
  selectBestTickerStory,
  strongEvidenceRejectionReason,
} from "@/lib/news/automation/selection";
import type {
  DailyCollectionOutcome,
  DiscoveredNewsCandidate,
  NewsDiscoveryProvider,
  NewsSourceDefinition,
  RetrievedNewsCandidate,
  SourceAttempt,
  TickerCollectionOutcome,
} from "@/lib/news/automation/types";

const FEED_TIMEOUT_MS = 10_000;
const MAX_RETRIEVALS_PER_TICKER = 10;
const USER_AGENT = "AAPL Catch-Up Tracker/1.0 permitted-news-collector";

export async function collectDailyDeepContextNews({
  symbols,
  marketDate,
}: {
  symbols: string[];
  marketDate: string;
}): Promise<DailyCollectionOutcome> {
  const tickerOutcomes: TickerCollectionOutcome[] = [];
  const sourceAttempts: SourceAttempt[] = [];
  const selected: RetrievedNewsCandidate[] = [];
  const supporting: RetrievedNewsCandidate[] = [];
  const rejected = [];

  const outcomes = await mapWithConcurrency(symbols, 2, async (symbol) =>
    collectTickerNews({ symbol, sourceAttempts }),
  );
  for (const outcome of outcomes) {
    tickerOutcomes.push(outcome);
    rejected.push(...outcome.rejected);
    if (outcome.selected) {
      selected.push(outcome.selected);
    }
    supporting.push(...outcome.supporting);
  }

  return {
    marketDate,
    runKey: `deep-context-news:${marketDate}`,
    targetCount: symbols.length,
    selected,
    supporting,
    sourceAttempts,
    rejected,
    tickerOutcomes,
    duplicateStoriesRemoved: tickerOutcomes.reduce((total, item) => total + item.duplicatesRemoved, 0),
    fullTextRetrievalSuccesses: tickerOutcomes.reduce((total, item) => total + item.retrievalSuccesses, 0),
    fullTextRetrievalFailures: tickerOutcomes.reduce((total, item) => total + item.retrievalFailures, 0),
  };
}

async function collectTickerNews({
  symbol,
  sourceAttempts,
}: {
  symbol: string;
  sourceAttempts: SourceAttempt[];
}): Promise<TickerCollectionOutcome> {
  const profile = getTickerNewsProfile(symbol);
  const discovered: DiscoveredNewsCandidate[] = [];

  await Promise.all(getNewsSourcesForSymbol(symbol).map(async (source) => {
    const provider = source.method === "directPage"
      ? directPageDiscoveryProvider(source, symbol)
      : rssDiscoveryProvider(source, symbol);
    const attemptedAt = new Date().toISOString();
    try {
      const candidates = await provider.discover(profile);
      discovered.push(...candidates);
      sourceAttempts.push({
        sourceId: provider.source.id,
        symbol,
        attemptedAt,
        candidateCount: candidates.length,
        status: "success",
      });
    } catch (error) {
      sourceAttempts.push({
        sourceId: provider.source.id,
        symbol,
        attemptedAt,
        candidateCount: 0,
        status: "failed",
        failureReason: error instanceof Error ? error.message.slice(0, 240) : "source-request-failed",
      });
    }
  }));

  const filtered = rejectUnsuitableCandidates(discovered, profile, new Date().toISOString());
  const ranked = [...filtered.accepted]
    .map((candidate) => ({ candidate, relevanceScore: scoreCandidate(candidate, profile) }))
    .filter((item) => item.relevanceScore >= 25)
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .slice(0, MAX_RETRIEVALS_PER_TICKER);

  const retrieved = await mapWithConcurrency(
    ranked,
    3,
    ({ candidate, relevanceScore }) => retrieveCandidate(candidate, relevanceScore),
  );
  const { representatives, removed } = groupNearDuplicates(
    retrieved.map((candidate) => assessStrongEvidence(candidate, profile)),
  );
  const evidenceRejected = representatives.flatMap((candidate) => {
    const reason = strongEvidenceRejectionReason(candidate);
    return reason
      ? [{
          candidate: {
            ...candidate,
            raw: {
              discovered: candidate.raw,
              qualityScore: candidate.qualityScore,
              companyFocusScore: candidate.companyFocusScore,
              evidenceDepthScore: candidate.evidenceDepthScore,
              sourceTier: candidate.sourceTier,
              materiality: candidate.materiality,
              evidenceType: candidate.evidenceType,
              qualityFlags: candidate.qualityFlags,
            },
          },
          reason,
          rejectedAt: new Date().toISOString(),
        }]
      : [];
  });
  const strongCandidates = representatives.filter((candidate) => !strongEvidenceRejectionReason(candidate));
  const selected = selectBestTickerStory(strongCandidates);
  const supporting = representatives
    .filter((candidate) => candidate.id !== selected?.id)
    .filter(isSupportingContext)
    .sort((left, right) => right.qualityScore - left.qualityScore || right.relevanceScore - left.relevanceScore)
    .slice(0, 2);
  const retrievalSuccesses = retrieved.filter((item) => item.retrievalStatus === "read").length;
  const retrievalFailures = retrieved.length - retrievalSuccesses;
  const allRejected = [...filtered.rejected, ...evidenceRejected];

  return {
    symbol,
    selected,
    supporting,
    discoveredCount: discovered.length,
    rejected: allRejected,
    duplicatesRemoved: removed,
    retrievalSuccesses,
    retrievalFailures,
    shortfallReason: selected
      ? undefined
      : discovered.length === 0
        ? "no-candidates-discovered"
        : ranked.length === 0
          ? "no-suitable-candidates"
          : strongCandidates.length === 0
            ? "no-strong-evidence-candidates"
            : "no-retrievable-qualified-candidates",
  };
}

function rssDiscoveryProvider(source: NewsSourceDefinition, symbol: string): NewsDiscoveryProvider {
  return {
    source,
    discover: (profile) =>
      discoverSource(source.buildUrl(profile), source.id, source.label, source.method, symbol, source.priority),
  };
}

function directPageDiscoveryProvider(source: NewsSourceDefinition, symbol: string): NewsDiscoveryProvider {
  return {
    source,
    discover: (profile) => discoverDirectPage(source.buildUrl(profile), source, symbol),
  };
}

async function retrieveCandidate(candidate: DiscoveredNewsCandidate, relevanceScore: number): Promise<RetrievedNewsCandidate> {
  const articleText = await fetchReadableArticleText(candidate.url, `${candidate.title}\n\n${candidate.summary ?? ""}`);
  const cleanText = articleText.text || undefined;
  const canonicalUrl = normalizeUrl(articleText.canonicalUrl || candidate.url);
  const sentiment = scoreNewsText(candidate.title, candidate.summary);
  const fullTextBoost = articleText.status === "read" ? 30 : articleText.status === "summaryOnly" ? 5 : -25;
  const sourceBoost = candidate.sourceMethod === "directFeed" ? 20 : candidate.sourceId.includes("fundamentals") ? 12 : 0;
  return {
    ...candidate,
    id: stableId("news", `${candidate.symbol}:${canonicalUrl}`),
    canonicalUrl,
    cleanText,
    excerpt: cleanText ? excerpt(cleanText) : candidate.summary,
    contentHash: contentHash(cleanText || `${candidate.title}\n${candidate.summary ?? ""}`),
    retrievalStatus: articleText.failureReason?.startsWith("robots-")
      ? "blocked"
      : articleText.status === "read"
        ? "read"
        : articleText.status === "summaryOnly"
          ? "summaryOnly"
          : "unavailable",
    failureReason: articleText.failureReason,
    retrievedAt: new Date().toISOString(),
    relevanceScore,
    qualityScore: relevanceScore + fullTextBoost + sourceBoost,
    companyFocusScore: 0,
    evidenceDepthScore: 0,
    sourceTier: "aggregator",
    materiality: "low",
    evidenceType: "commentary",
    evidencePolicyVersion: "strong-evidence-v1",
    qualityFlags: [],
    topic: inferTopic(candidate),
    signal: sentiment.signal,
    signalScore: sentiment.signalScore,
    matchedTerms: sentiment.matchedTerms,
  };
}

async function discoverSource(
  url: string,
  sourceId: string,
  source: string,
  sourceMethod: DiscoveredNewsCandidate["sourceMethod"],
  symbol: string,
  sourcePriority?: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetchFeedWithRetry(url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9,*/*;q=0.8",
        "user-agent": USER_AGENT,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`feed-http-${response.status}`);
    }
    const xml = await response.text();
    return parseFeed(xml, { sourceId, source, sourceMethod, symbol, sourcePriority });
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverDirectPage(url: string, source: NewsSourceDefinition, symbol: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetchFeedWithRetry(url, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "user-agent": USER_AGENT },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`page-http-${response.status}`);
    return parseDirectPage(await response.text(), url, source, symbol);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeedWithRetry(url: string, init: RequestInit) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      failure = new Error(`feed-http-${response.status}`);
    } catch (error) {
      failure = error;
    }
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
  }
  throw failure instanceof Error ? failure : new Error("feed-request-failed");
}

function parseFeed(
  xml: string,
  source: Pick<DiscoveredNewsCandidate, "sourceId" | "source" | "sourceMethod" | "symbol" | "sourcePriority">,
) {
  const blocks = [
    ...matchBlocks(xml, "item").map((block) => ({ block, atom: false })),
    ...matchBlocks(xml, "entry").map((block) => ({ block, atom: true })),
  ];
  return blocks.flatMap(({ block, atom }) => {
    const title = readTag(block, "title");
    const url = atom ? readAttribute(block, "link", "href") : readTag(block, "link");
    if (!title || !url) {
      return [];
    }
    const summary = readTag(block, atom ? "summary" : "description") || readTag(block, "content") || undefined;
    const publishedAt = parseDate(readTag(block, atom ? "published" : "pubDate") || readTag(block, "updated"));
    const publisher = readTag(block, "source") || source.source;
    const author = readTag(block, "author") || undefined;
    const normalizedUrl = normalizeUrl(url);
    return [{
      ...source,
      id: stableId("candidate", `${source.sourceId}:${source.symbol}:${normalizedUrl}`),
      title,
      summary,
      url: normalizedUrl,
      publishedAt,
      author,
      source: publisher,
      raw: { feedSource: source.sourceId },
    } satisfies DiscoveredNewsCandidate];
  });
}

function parseDirectPage(html: string, pageUrl: string, source: NewsSourceDefinition, symbol: string) {
  const blocks = [...matchBlocks(html, "article"), ...matchBlocks(html, "li")];
  const seen = new Set<string>();
  return blocks.flatMap((block) => {
    const link = firstLink(block);
    const title = cleanXmlText(readTag(block, "h1") || readTag(block, "h2") || readTag(block, "h3") || link?.text || "");
    if (!link || !title) return [];
    let url: string;
    try {
      url = normalizeUrl(new URL(link.href, pageUrl).toString());
    } catch {
      return [];
    }
    if (!matchesAllowedDomain(url, source.allowedDomains) || seen.has(url)) return [];
    seen.add(url);
    const dateMatch = block.match(/(?:date|published)[^>]*>\s*([^<]{6,80})\s*</i);
    return [{
      id: stableId("candidate", `${source.id}:${symbol}:${url}`),
      symbol,
      title,
      source: source.label,
      sourceId: source.id,
      sourceMethod: source.method,
      sourcePriority: source.priority,
      url,
      publishedAt: dateMatch ? parseDate(cleanXmlText(dateMatch[1])) : undefined,
      raw: { directPageSource: source.id },
    } satisfies DiscoveredNewsCandidate];
  }).slice(0, 30);
}

function inferTopic(candidate: DiscoveredNewsCandidate) {
  const text = `${candidate.title} ${candidate.summary ?? ""}`.toLowerCase();
  if (/antitrust|regulat|doj|dma|lawsuit|court/.test(text)) return "legalRegulatory";
  if (/earnings|revenue|margin|guidance|profit/.test(text)) return "earnings";
  if (/supply|tariff|china|foxconn/.test(text)) return "supplyChain";
  if (/buyback|repurchase|dividend/.test(text)) return "capitalReturn";
  if (/iphone|intelligence|ai|gpu|aws|starlink|starship|model [0-9]/.test(text)) return "product";
  if (/compet|market share/.test(text)) return "competitivePosition";
  return "other";
}

function matchBlocks(xml: string, tag: string) {
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
  return Array.from(xml.matchAll(pattern), (match) => match[0]);
}

function readTag(xml: string, tag: string) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(pattern);
  return match ? cleanXmlText(match[1]) : "";
}

function readAttribute(xml: string, tag: string, attribute: string) {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, "i");
  return xml.match(pattern)?.[1]?.trim() ?? "";
}

function firstLink(html: string) {
  const match = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  return match ? { href: match[1], text: cleanXmlText(match[2]) } : undefined;
}

function matchesAllowedDomain(value: string, domains: string[]) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function cleanXmlText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
) {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
