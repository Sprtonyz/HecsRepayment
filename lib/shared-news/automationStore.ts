import { createClient } from "@supabase/supabase-js";
import { stableId } from "@/lib/news/automation/normalization";
import { STRONG_EVIDENCE_THRESHOLD } from "@/lib/news/automation/selection";
import type { DailyCollectionOutcome, PerceptionSignal, RetrievedNewsCandidate } from "@/lib/news/automation/types";
import type { CachedNewsArticle } from "@/lib/storage/types";
import { getSharedNewsConfig, isSharedNewsSyncEnabled } from "@/lib/shared-news/config";

type CollectionClaim = {
  enabled: boolean;
  claimed: boolean;
  runId?: string;
  status?: string;
};

type StoredArticleRow = {
  id: string;
  symbol: string;
  title: string;
  publisher: string;
  original_url: string;
  canonical_url: string;
  published_at: string | null;
  retrieved_at: string;
  excerpt: string | null;
  cleaned_text: string | null;
  source_id: string;
  source_method: string;
  signal: CachedNewsArticle["signal"];
  signal_score: number;
  matched_terms: string[] | null;
  duplicate_group_id: string | null;
  retrieval_status: string;
  failure_reason: string | null;
  content_hash: string;
  market_date: string;
  relevance_score: number;
  quality_score: number;
  raw_source: unknown;
};

type StoredPerceptionRow = StoredArticleRow & {
  source_tier: string;
  perception_kind: string;
  perception_score: number;
  corroboration_key: string;
  independent_source_count: number;
  source_reliability: number;
  catalyst_tags: string[] | null;
  resolution_status: string;
  expires_at: string;
  resolved_at: string | null;
};

export type PerceptionSourceCalibration = {
  publisher: string;
  sourceTier: string;
  resolvedSignalCount: number;
  reliability: number;
  outcomes: Record<string, number>;
};

export async function claimAutomatedNewsCollection(
  outcome: Pick<DailyCollectionOutcome, "runKey" | "marketDate" | "targetCount">,
): Promise<CollectionClaim> {
  if (!isSharedNewsSyncEnabled()) {
    return { enabled: false, claimed: false };
  }
  const { data, error } = await automationClient().rpc("claim_deep_context_news_collection", {
    p_run_key: outcome.runKey,
    p_market_date: outcome.marketDate,
    p_target_count: outcome.targetCount,
  });
  if (error) {
    throw new Error(`Could not claim the automated news collection: ${error.message}`);
  }
  const claim = data as { runId?: string; claimed?: boolean; status?: string } | null;
  return {
    enabled: true,
    claimed: Boolean(claim?.claimed),
    runId: claim?.runId,
    status: claim?.status,
  };
}

export async function persistAutomatedNewsCollection(runId: string, outcome: DailyCollectionOutcome) {
  const supabase = automationClient();
  const articleRows = outcome.selected.map((article) => toArticleRow(runId, outcome.marketDate, article));
  const supportingRows = outcome.supporting.map((article) => toArticleRow(runId, outcome.marketDate, article, "supporting"));
  const perceptionRows = outcome.perception.map((article) => toPerceptionRow(runId, outcome.marketDate, article));
  const sourceRows = outcome.sourceAttempts.map((attempt) => ({
    id: stableId("source-attempt", `${runId}:${attempt.sourceId}:${attempt.symbol}`),
    run_id: runId,
    source_id: attempt.sourceId,
    symbol: attempt.symbol,
    attempted_at: attempt.attemptedAt,
    candidate_count: attempt.candidateCount,
    status: attempt.status,
    failure_reason: attempt.failureReason ?? null,
  }));
  const rejectionRows = outcome.rejected.map((rejection) => ({
    id: stableId("rejection", `${runId}:${rejection.candidate.id}:${rejection.reason}`),
    run_id: runId,
    symbol: rejection.candidate.symbol,
    source_id: rejection.candidate.sourceId,
    title: rejection.candidate.title,
    url: rejection.candidate.url,
    rejection_reason: rejection.reason,
    rejected_at: rejection.rejectedAt,
    raw_candidate: rejection.candidate.raw ?? rejection.candidate,
  }));
  const occurrenceRows = articleRows.map((article) => ({
    id: stableId("occurrence", `${article.id}:${article.original_url}`),
    article_id: article.id,
    source_id: article.source_id,
    source_method: article.source_method,
    source_url: article.original_url,
    discovered_at: article.retrieved_at,
    raw_source: article.raw_source,
  }));

  const articleWrite = articleRows.length
    ? await supabase.from("news_articles").upsert(articleRows, { onConflict: "symbol,market_date" })
    : { error: null };
  if (articleWrite.error) {
    throw new Error(`Could not persist automated news collection: ${articleWrite.error.message}`);
  }

  const writes = [
    perceptionRows.length
      ? supabase.from("news_perception_signals").upsert(perceptionRows, { onConflict: "symbol,market_date,canonical_url" })
      : Promise.resolve({ error: null }),
    supportingRows.length
      ? supabase.from("news_supporting_contexts").upsert(supportingRows, { onConflict: "symbol,market_date,canonical_url" })
      : Promise.resolve({ error: null }),
    sourceRows.length
      ? supabase.from("news_source_attempts").upsert(sourceRows, { onConflict: "run_id,source_id,symbol" })
      : Promise.resolve({ error: null }),
    rejectionRows.length ? supabase.from("news_article_rejections").upsert(rejectionRows) : Promise.resolve({ error: null }),
    occurrenceRows.length ? supabase.from("news_article_occurrences").upsert(occurrenceRows) : Promise.resolve({ error: null }),
  ];
  const results = await Promise.all(writes);
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    throw new Error(`Could not persist automated news collection: ${failed.error.message}`);
  }
  const perceptionReconciliation = await reconcilePerceptionSignals(supabase, outcome);

  const metrics = {
    dailyArticleTarget: outcome.targetCount,
    suitableArticlesCollected: outcome.selected.length,
    strongEvidenceTarget: outcome.targetCount,
    strongEvidenceCollected: outcome.selected.length,
    strongEvidenceThreshold: STRONG_EVIDENCE_THRESHOLD,
    supportingContextCollected: outcome.supporting.length,
    perceptionSignalsCollected: outcome.perception.length,
    perceptionSignalsResolved: perceptionReconciliation.resolved,
    perceptionSignalsExpiredUnresolved: perceptionReconciliation.unresolved,
    fullTextRetrievalSuccesses: outcome.fullTextRetrievalSuccesses,
    fullTextRetrievalFailures: outcome.fullTextRetrievalFailures,
    sourcesAttempted: outcome.sourceAttempts.length,
    sourceFailures: outcome.sourceAttempts.filter((attempt) => attempt.status === "failed").length,
    rejectedArticles: outcome.rejected.length,
    rejectionReasons: countBy(outcome.rejected.map((item) => item.reason)),
    duplicateStoriesRemoved: outcome.duplicateStoriesRemoved,
    shortfallSymbols: outcome.tickerOutcomes.filter((item) => !item.selected).map((item) => ({
      symbol: item.symbol,
      reason: item.shortfallReason,
    })),
  };
  const { error } = await supabase
    .from("news_collection_runs")
    .update({
      status: "completed",
      selected_count: outcome.selected.length,
      metrics,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) {
    throw new Error(`Could not complete automated news collection: ${error.message}`);
  }
  return metrics;
}

export async function failAutomatedNewsCollection(runId: string, errorSummary: string) {
  if (!isSharedNewsSyncEnabled()) return;
  const { error } = await automationClient()
    .from("news_collection_runs")
    .update({
      status: "failed",
      error_summary: errorSummary.slice(0, 1000),
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(`Could not mark news collection as failed: ${error.message}`);
}

export async function getAutomatedNewsArticles(symbol: string, limit = 40): Promise<CachedNewsArticle[]> {
  if (!isSharedNewsSyncEnabled()) return [];
  const { data, error } = await automationClient()
    .from("news_articles")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .order("market_date", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read automated news articles: ${error.message}`);
  return ((data ?? []) as StoredArticleRow[]).map(fromStoredArticleRow);
}

export async function getAutomatedNewsArticlesForMonth(symbol: string, reviewMonth: string) {
  if (!isSharedNewsSyncEnabled()) return [];
  const from = `${reviewMonth}-01`;
  const [year, month] = reviewMonth.split("-").map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const { data, error } = await automationClient()
    .from("news_articles")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .gte("market_date", from)
    .lt("market_date", nextMonth)
    .order("market_date", { ascending: false });
  if (error) throw new Error(`Could not read ${symbol} monthly news articles: ${error.message}`);
  return ((data ?? []) as StoredArticleRow[]).map(fromStoredArticleRow);
}

export async function getAutomatedSupportingNewsForMonth(symbol: string, reviewMonth: string) {
  if (!isSharedNewsSyncEnabled()) return [];
  const { from, nextMonth } = monthBounds(reviewMonth);
  const { data, error } = await automationClient()
    .from("news_supporting_contexts")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .gte("market_date", from)
    .lt("market_date", nextMonth)
    .order("market_date", { ascending: false });
  if (error) throw new Error(`Could not read ${symbol} monthly supporting context: ${error.message}`);
  return ((data ?? []) as StoredArticleRow[]).map(fromStoredArticleRow);
}

export async function getAutomatedPerceptionSignalsForMonth(symbol: string, reviewMonth: string) {
  if (!isSharedNewsSyncEnabled()) return [];
  const { from, nextMonth } = monthBounds(reviewMonth);
  const { data, error } = await automationClient()
    .from("news_perception_signals")
    .select("*")
    .eq("symbol", symbol.toUpperCase())
    .gte("market_date", from)
    .lt("market_date", nextMonth)
    .order("perception_score", { ascending: false });
  if (error) throw new Error(`Could not read ${symbol} monthly perception signals: ${error.message}`);
  return ((data ?? []) as StoredPerceptionRow[]).map(fromStoredPerceptionRow);
}

export async function getPerceptionSourceCalibration(symbol: string): Promise<PerceptionSourceCalibration[]> {
  if (!isSharedNewsSyncEnabled()) return [];
  const from = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await automationClient()
    .from("news_perception_signals")
    .select("publisher,source_tier,resolution_status")
    .eq("symbol", symbol.toUpperCase())
    .gte("market_date", from);
  if (error) throw new Error(`Could not read ${symbol} perception calibration: ${error.message}`);
  const grouped = new Map<string, { sourceTier: string; outcomes: Record<string, number> }>();
  for (const row of (data ?? []) as Array<{ publisher: string; source_tier: string; resolution_status: string }>) {
    const current = grouped.get(row.publisher) ?? { sourceTier: row.source_tier, outcomes: {} };
    current.outcomes[row.resolution_status] = (current.outcomes[row.resolution_status] ?? 0) + 1;
    grouped.set(row.publisher, current);
  }
  return [...grouped.entries()].map(([publisher, value]) => {
    const resolved = Object.entries(value.outcomes).filter(([status]) => status !== "open");
    const resolvedSignalCount = resolved.reduce((total, [, count]) => total + count, 0);
    const measured = resolved.reduce((total, [status, count]) => total + calibrationOutcomeScore(status) * count, 0);
    const reliability = (baselineReliability(value.sourceTier) * 5 + measured) / (5 + resolvedSignalCount);
    return { publisher, sourceTier: value.sourceTier, resolvedSignalCount, reliability: round(reliability), outcomes: value.outcomes };
  }).sort((left, right) => right.resolvedSignalCount - left.resolvedSignalCount || right.reliability - left.reliability);
}

export async function getAutomatedMonthlyCoverage(reviewMonth: string) {
  if (!isSharedNewsSyncEnabled()) {
    return { daysWithShortfall: 0, runCount: 0, strongEvidenceCollected: 0, strongEvidenceTarget: 0, supportingContextCount: 0 };
  }
  const { from, nextMonth } = monthBounds(reviewMonth);
  const { data, error } = await automationClient()
    .from("news_collection_runs")
    .select("selected_count,target_count")
    .gte("market_date", from)
    .lt("market_date", nextMonth)
    .eq("status", "completed");
  if (error) throw new Error(`Could not read monthly collection coverage: ${error.message}`);
  const runs = (data ?? []) as Array<{ selected_count: number; target_count: number }>;
  const supporting = await automationClient()
    .from("news_supporting_contexts")
    .select("id", { count: "exact", head: true })
    .gte("market_date", from)
    .lt("market_date", nextMonth);
  const perceptions = await automationClient()
    .from("news_perception_signals")
    .select("id", { count: "exact", head: true })
    .gte("market_date", from)
    .lt("market_date", nextMonth);
  if (supporting.error || perceptions.error) {
    throw new Error(`Could not read monthly context coverage: ${supporting.error?.message ?? perceptions.error?.message}`);
  }
  return {
    daysWithShortfall: runs.filter((run) => run.selected_count < run.target_count).length,
    runCount: runs.length,
    strongEvidenceCollected: runs.reduce((total, run) => total + run.selected_count, 0),
    strongEvidenceTarget: runs.reduce((total, run) => total + run.target_count, 0),
    supportingContextCount: supporting.count ?? 0,
    perceptionSignalCount: perceptions.count ?? 0,
  };
}

export async function saveAutomatedMonthlyReport(input: {
  symbol: string;
  reviewMonth: string;
  status: "processing" | "published" | "failed";
  coverageStatus: "complete" | "limited";
  collectedArticleCount: number;
  shortfallDayCount: number;
  model?: string;
  report?: Record<string, unknown>;
  errorSummary?: string;
}) {
  if (!isSharedNewsSyncEnabled()) return;
  const { error } = await automationClient().from("monthly_news_reports").upsert(
    {
      id: stableId("monthly-news-report", `${input.symbol}:${input.reviewMonth}`),
      symbol: input.symbol.toUpperCase(),
      review_month: input.reviewMonth,
      status: input.status,
      coverage_status: input.coverageStatus,
      collected_article_count: input.collectedArticleCount,
      shortfall_day_count: input.shortfallDayCount,
      model: input.model ?? null,
      report: input.report ?? null,
      error_summary: input.errorSummary ?? null,
      generated_at: input.status === "published" ? new Date().toISOString() : null,
      published_at: input.status === "published" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "symbol,review_month" },
  );
  if (error) throw new Error(`Could not save automated monthly report: ${error.message}`);
}

export async function getAutomatedMonthlyReportStatus(symbol: string, reviewMonth: string) {
  if (!isSharedNewsSyncEnabled()) return undefined;
  const { data, error } = await automationClient()
    .from("monthly_news_reports")
    .select("status")
    .eq("symbol", symbol.toUpperCase())
    .eq("review_month", reviewMonth)
    .maybeSingle();
  if (error) throw new Error(`Could not read automated monthly report status: ${error.message}`);
  return (data as { status?: string } | null)?.status;
}

function automationClient() {
  const { url, secretKey } = getSharedNewsConfig();
  if (!url || !secretKey) throw new Error("Shared news sync is not configured.");
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function toArticleRow(
  runId: string,
  marketDate: string,
  article: RetrievedNewsCandidate,
  evidenceClass: "strong" | "supporting" = "strong",
) {
  const id = stableId(
    evidenceClass === "strong" ? "daily-news" : "supporting-news",
    evidenceClass === "strong" ? `${article.symbol}:${marketDate}` : `${article.symbol}:${marketDate}:${article.canonicalUrl}`,
  );
  return {
    id,
    run_id: runId,
    market_date: marketDate,
    symbol: article.symbol,
    title: article.title,
    publisher: article.source,
    author: article.author ?? null,
    original_url: article.url,
    canonical_url: article.canonicalUrl,
    published_at: article.publishedAt ?? null,
    retrieved_at: article.retrievedAt,
    cleaned_text: article.cleanText ?? null,
    excerpt: article.excerpt ?? null,
    topic: article.topic,
    source_method: article.sourceMethod,
    source_id: article.sourceId,
    content_hash: article.contentHash,
    duplicate_group_id: article.duplicateGroupId ?? null,
    retrieval_status: article.retrievalStatus,
    failure_reason: article.failureReason ?? null,
    relevance_score: article.relevanceScore,
    quality_score: article.qualityScore,
    signal: article.signal,
    signal_score: article.signalScore,
    matched_terms: article.matchedTerms,
    raw_source: {
      discovered: article.raw,
      cleanedText: article.cleanText,
      canonicalUrl: article.canonicalUrl,
      topic: article.topic,
      retrievalStatus: article.retrievalStatus,
      failureReason: article.failureReason,
      duplicateGroupId: article.duplicateGroupId,
      qualityScore: article.qualityScore,
      companyFocusScore: article.companyFocusScore,
      evidenceDepthScore: article.evidenceDepthScore,
      sourceTier: article.sourceTier,
      materiality: article.materiality,
      evidenceType: article.evidenceType,
      eventDate: article.eventDate,
      evidencePolicyVersion: article.evidencePolicyVersion,
      qualityFlags: article.qualityFlags,
    },
  };
}

function toPerceptionRow(runId: string, marketDate: string, article: PerceptionSignal) {
  const base = toArticleRow(runId, marketDate, article, "supporting");
  return {
    ...base,
    id: stableId("perception-signal", `${article.symbol}:${marketDate}:${article.canonicalUrl}`),
    source_tier: article.sourceTier,
    perception_kind: article.perceptionKind,
    perception_score: article.perceptionScore,
    corroboration_key: article.corroborationKey,
    independent_source_count: article.independentSourceCount,
    source_reliability: article.sourceReliability,
    catalyst_tags: article.catalystTags,
    resolution_status: article.resolutionStatus,
    expires_at: article.expiresAt,
    resolved_at: null,
    raw_source: {
      ...base.raw_source,
      perceptionKind: article.perceptionKind,
      perceptionScore: article.perceptionScore,
      corroborationKey: article.corroborationKey,
      independentSourceCount: article.independentSourceCount,
      sourceReliability: article.sourceReliability,
      catalystTags: article.catalystTags,
      resolutionStatus: article.resolutionStatus,
      expiresAt: article.expiresAt,
    },
  };
}

function monthBounds(reviewMonth: string) {
  const from = `${reviewMonth}-01`;
  const [year, month] = reviewMonth.split("-").map(Number);
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { from, nextMonth };
}

function fromStoredArticleRow(row: StoredArticleRow): CachedNewsArticle {
  const rawSource = isRecord(row.raw_source) ? row.raw_source : {};
  return {
    id: row.id,
    symbol: row.symbol,
    title: row.title,
    summary: row.excerpt ?? undefined,
    url: row.original_url,
    source: row.publisher,
    provider: row.source_id,
    publishedAt: row.published_at ?? undefined,
    collectedAt: `${row.market_date}T00:00:00.000Z`,
    cachedAt: row.retrieved_at,
    lastFetchedAt: row.retrieved_at,
    signal: row.signal,
    signalScore: row.signal_score,
    matchedTerms: row.matched_terms ?? [],
    raw: {
      ...rawSource,
      canonicalUrl: row.canonical_url,
      cleanedText: row.cleaned_text,
      contentHash: row.content_hash,
      duplicateGroupId: row.duplicate_group_id,
      retrievalStatus: row.retrieval_status,
      failureReason: row.failure_reason,
      marketDate: row.market_date,
      relevanceScore: row.relevance_score,
      qualityScore: row.quality_score,
    },
  };
}

function fromStoredPerceptionRow(row: StoredPerceptionRow): CachedNewsArticle {
  const article = fromStoredArticleRow(row);
  return {
    ...article,
    raw: {
      ...(isRecord(article.raw) ? article.raw : {}),
      sourceTier: row.source_tier,
      perceptionKind: row.perception_kind,
      perceptionScore: row.perception_score,
      corroborationKey: row.corroboration_key,
      independentSourceCount: row.independent_source_count,
      sourceReliability: row.source_reliability,
      catalystTags: row.catalyst_tags ?? [],
      resolutionStatus: row.resolution_status,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
    },
  };
}

async function reconcilePerceptionSignals(
  supabase: ReturnType<typeof automationClient>,
  outcome: DailyCollectionOutcome,
) {
  const now = new Date().toISOString();
  const expired = await supabase
    .from("news_perception_signals")
    .update({ resolution_status: "unresolved", resolved_at: now, updated_at: now })
    .eq("resolution_status", "open")
    .lt("expires_at", now)
    .select("id");
  if (expired.error) throw new Error(`Could not expire perception signals: ${expired.error.message}`);

  const primaryEvidence = outcome.selected.filter((article) => article.sourceTier === "primary");
  if (primaryEvidence.length === 0) return { resolved: 0, unresolved: expired.data?.length ?? 0 };
  const { data: openSignals, error } = await supabase
    .from("news_perception_signals")
    .select("id,symbol,topic,title,market_date")
    .eq("resolution_status", "open")
    .gte("market_date", new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  if (error) throw new Error(`Could not reconcile perception signals: ${error.message}`);

  let resolved = 0;
  for (const signal of (openSignals ?? []) as Array<{ id: string; symbol: string; topic: string; title: string; market_date: string }>) {
    const evidence = primaryEvidence.find((article) =>
      article.symbol === signal.symbol && article.topic === signal.topic && sharedMeaningfulTerms(article.title, signal.title) >= 2,
    );
    if (!evidence) continue;
    const status = /\b(den(?:y|ies|ied)|no plans?|not considering|incorrect report)\b/i.test(`${evidence.title}\n${evidence.cleanText ?? ""}`)
      ? "denied"
      : "corroborated";
    const update = await supabase
      .from("news_perception_signals")
      .update({ resolution_status: status, resolved_at: now, updated_at: now })
      .eq("id", signal.id)
      .eq("resolution_status", "open");
    if (update.error) throw new Error(`Could not update perception resolution: ${update.error.message}`);
    resolved += 1;
  }
  return { resolved, unresolved: expired.data?.length ?? 0 };
}

function sharedMeaningfulTerms(left: string, right: string) {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []);
  const leftTerms = tokens(left);
  return [...tokens(right)].filter((term) => leftTerms.has(term)).length;
}

function calibrationOutcomeScore(status: string) {
  return status === "confirmed" ? 1 : status === "corroborated" ? 0.75 : status === "unresolved" ? 0.35 : status === "denied" ? 0 : 0.5;
}

function baselineReliability(sourceTier: string) {
  return sourceTier === "reputable" ? 0.8 : sourceTier === "specialist" ? 0.68 : sourceTier === "general" ? 0.55 : 0.35;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
