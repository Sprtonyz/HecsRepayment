import type { CachedNewsAnalysis, CachedNewsArticle } from "@/lib/storage/types";
import { fetchReadableArticleText, type ArticleTextResult } from "@/lib/news/articleText";
import { buildCodexReviewBrief } from "@/lib/news/codexReviewBundle";
import { buildReviewerSpec } from "@/lib/news/reviewerSpec";

const DEFAULT_ARTICLE_LIMIT = 40;
const MAX_BUNDLE_TEXT_CHARS = 8_000;

export type CodexReviewAnalysisInput = {
  articleId: string;
  analyzedAt: string;
  analysisMode: CachedNewsAnalysis["analysisMode"];
  finalModel: string;
  escalatedModel?: string;
  signal: CachedNewsAnalysis["signal"];
  confidence: CachedNewsAnalysis["confidence"];
  materiality: CachedNewsAnalysis["materiality"];
  thesisImpactScore: number;
  category: string;
  timeHorizon: string;
  rationale: string;
  evidence: string[];
  riskFlags: string[];
  opportunities: string[];
};

export type BuildCodexReviewBundleInput = {
  symbol: string;
  reviewMonth: string;
  articles: CachedNewsArticle[];
  analyses: CodexReviewAnalysisInput[];
  guideContext?: Record<string, unknown>;
  existingCodexReview?: Record<string, unknown>;
  articleLimit?: number;
};

export async function buildCodexReviewBundle({
  symbol,
  reviewMonth,
  articles,
  analyses,
  guideContext,
  existingCodexReview,
  articleLimit = DEFAULT_ARTICLE_LIMIT,
}: BuildCodexReviewBundleInput) {
  const normalizedSymbol = symbol.toUpperCase();
  const reviewerSpec = buildReviewerSpec({
    symbol: normalizedSymbol,
    guideContext,
  });
  const analysesByArticleId = new Map(analyses.map((analysis) => [analysis.articleId, analysis]));
  const selectedArticles = articles
    .filter((article) => article.symbol.toUpperCase() === normalizedSymbol)
    .filter(
      (article) =>
        monthKey(article.collectedAt || article.cachedAt || article.publishedAt) === reviewMonth,
    )
    .sort((left, right) => compareBundleArticles(left, right, analysesByArticleId))
    .slice(0, articleLimit);

  const articlesWithText = [];
  for (const article of selectedArticles) {
    const storedText = storedArticleText(article.raw);
    const articleText = storedText ?? (await fetchReadableArticleText(
      article.url,
      `${article.title}\n\n${article.summary ?? ""}`,
    ));
    const existingAnalysis = analysesByArticleId.get(article.id);
    articlesWithText.push({
      id: article.id,
      symbol: article.symbol,
      title: article.title,
      source: article.source,
      provider: article.provider,
      url: article.url,
      publishedAt: article.publishedAt,
      collectedAt: article.collectedAt || article.cachedAt,
      lastFetchedAt: article.lastFetchedAt || article.cachedAt,
      ageBucket: ageBucket(article.publishedAt || article.collectedAt || article.cachedAt),
      headlineRuleSignal: article.signal,
      headlineRuleScore: article.signalScore,
      matchedTerms: article.matchedTerms,
      summary: article.summary,
      articleTextStatus: articleText.status,
      readableTextExcerpt: articleText.text.slice(0, MAX_BUNDLE_TEXT_CHARS),
      existingApiAnalysis: existingAnalysis
        ? {
            analyzedAt: existingAnalysis.analyzedAt,
            mode: existingAnalysis.analysisMode,
            model: existingAnalysis.finalModel,
            escalatedModel: existingAnalysis.escalatedModel,
            signal: existingAnalysis.signal,
            confidence: existingAnalysis.confidence,
            materiality: existingAnalysis.materiality,
            thesisImpactScore: existingAnalysis.thesisImpactScore,
            category: existingAnalysis.category,
            timeHorizon: existingAnalysis.timeHorizon,
            rationale: existingAnalysis.rationale,
            evidence: existingAnalysis.evidence,
            riskFlags: existingAnalysis.riskFlags,
            opportunities: existingAnalysis.opportunities,
          }
        : undefined,
    });
  }

  const generatedAt = new Date().toISOString();
  const reviewBrief = buildCodexReviewBrief({
    symbol: normalizedSymbol,
    reviewMonth,
    requestedArticleCount: articles.length,
    includedArticleCount: articlesWithText.length,
    guideContext,
    reviewerSpec,
    articles: articlesWithText,
  });

  const bundle = {
    kind: "codex-monthly-news-review",
    symbol: normalizedSymbol,
    reviewMonth,
    generatedAt,
    articleLimit,
    requestedArticleCount: articles.length,
    includedArticleCount: articlesWithText.length,
    guideContext,
    reviewBrief,
    reviewerSpec,
    instructions: buildReviewInstructions(reviewerSpec),
    codexReview: existingCodexReview,
    articles: articlesWithText,
  };

  return {
    generatedAt,
    includedArticleCount: articlesWithText.length,
    reviewBrief,
    bundle,
    filename: reviewBundleFilename(normalizedSymbol, reviewMonth),
  };
}

function storedArticleText(raw: unknown): ArticleTextResult | undefined {
  if (!isRecord(raw) || typeof raw.cleanedText !== "string" || !raw.cleanedText.trim()) {
    return undefined;
  }
  const status: ArticleTextResult["status"] =
    raw.retrievalStatus === "read" || raw.retrievalStatus === "summaryOnly"
      ? raw.retrievalStatus
      : "summaryOnly";
  return {
    text: raw.cleanedText,
    status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function reviewBundleFilename(symbol: string, reviewMonth: string) {
  return `${reviewMonth}-${symbol.toLowerCase()}-codex-review.json`;
}

function compareBundleArticles(
  left: CachedNewsArticle,
  right: CachedNewsArticle,
  analysesByArticleId: Map<string, CodexReviewAnalysisInput>,
) {
  const leftAnalysis = analysesByArticleId.get(left.id);
  const rightAnalysis = analysesByArticleId.get(right.id);
  const scoreDiff =
    articlePriority(right, rightAnalysis) - articlePriority(left, leftAnalysis);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  return (right.collectedAt || right.cachedAt || right.publishedAt || "").localeCompare(
    left.collectedAt || left.cachedAt || left.publishedAt || "",
  );
}

function articlePriority(article: CachedNewsArticle, analysis?: CodexReviewAnalysisInput) {
  const materiality =
    analysis?.materiality === "high" ? 8 : analysis?.materiality === "medium" ? 4 : 0;
  const signal = Math.abs(analysis?.thesisImpactScore ?? article.signalScore);
  const recency =
    ageBucket(article.publishedAt || article.collectedAt || article.cachedAt) === "0-3d"
      ? 3
      : 0;
  return materiality + signal + recency;
}

function monthKey(value: string | undefined) {
  return value?.slice(0, 7);
}

function ageBucket(value: string | undefined) {
  if (!value) {
    return "unknown";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays <= 3) {
    return "0-3d";
  }
  if (ageDays <= 7) {
    return "4-7d";
  }
  if (ageDays <= 30) {
    return "8-30d";
  }
  return "30d+";
}

const DEFAULT_REVIEW_INSTRUCTIONS = [
  "Review this local bundle for the monthly stock review.",
  "Read reviewerSpec first; it defines the standing analyst charter and company-context overlay for this ticker.",
  "Prioritize durable thesis impact, unresolved legal/regulatory risk, earnings/product/service trends, and material competitive changes.",
  "Downweight stale market chatter, repeated analyst/price-action articles, tokenization mechanics with no company-specific impact, and articles with only summary text.",
  "Return a concise JSON review that the app can later load: signal, confidence, material items, stale/noisy items, unresolved themes, suggested guide impact, and rationale.",
];

function buildReviewInstructions(reviewerSpec: ReturnType<typeof buildReviewerSpec>) {
  return [
    ...DEFAULT_REVIEW_INSTRUCTIONS,
    `Reviewer charter version: ${reviewerSpec.version}.`,
    `Company context: ${reviewerSpec.companyContext.companyName} (${reviewerSpec.companyContext.symbol}) in ${reviewerSpec.companyContext.sector}.`,
  ];
}
