"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatCurrency, formatPercent, formatShares, roundMoney } from "@/lib/domain/money";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  FileText,
  GraduationCap,
  Landmark,
  ListChecks,
  RefreshCw,
  TrendingUp,
  Trash2,
  Wallet,
} from "lucide-react";
import { ContributionBarChart } from "@/components/charts/contribution-bar-chart";
import { GapAreaChart } from "@/components/charts/gap-area-chart";
import { SchoolDecisionChart } from "@/components/charts/school-decision-chart";
import { ValueLineChart } from "@/components/charts/value-line-chart";
import { MarketDataStatus } from "@/components/dashboard/market-data-status";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  buildHistoricalValueSeries,
  calculateCatchUpMetrics,
} from "@/lib/domain/calculations";
import {
  calculateDepositGuide,
  type DepositGuideNewsInput,
} from "@/lib/domain/depositGuide";
import { formatDisplayDate, monthsElapsedInclusive, todayIso } from "@/lib/domain/dates";
import { buildAiNewsDigest } from "@/lib/ai/articleAnalysis";
import { getCompanyReviewProfile } from "@/lib/news/companyReviewProfiles";
import { isRelevantNewsArticle } from "@/lib/news/relevance";
import {
  COMPARISON_HIGH_CONFIDENCE_THRESHOLD,
  comparisonScoreToPercent,
  scoreCodexReviewForComparison,
} from "@/lib/news/codexReviewRanking";
import { buildNewsDigest } from "@/lib/news/sentiment";
import { REVIEWER_SPEC_VERSION, type ReviewerContextOverride } from "@/lib/news/reviewerSpec";
import { projectCatchUp } from "@/lib/domain/projections";
import {
  buildSchoolDecisionCompoundTimeline,
  buildCurrentMonthSchoolDecision,
  findSchoolDecisionCrossDate,
  type CurrentMonthSchoolDecision,
} from "@/lib/domain/schoolDecision";
import {
  calculateStudyLoanMonthlyRepaymentAud,
  projectFreedRepaymentIntoAapl,
  projectStudyLoanDebtRange,
} from "@/lib/domain/studyLoan";
import { useTrackerData } from "@/lib/storage/useTrackerData";
import { withTimeout } from "@/lib/utils/async";
import type { CachedDailyPrice, CachedNewsArticle, CachedQuote } from "@/lib/storage/types";
import { cn } from "@/lib/utils";

function moneyUsd(value: number) {
  return formatCurrency(value, "USD");
}

function moneyAud(value: number) {
  return formatCurrency(value, "AUD");
}

type CodexReviewLookupResponse = {
  codexReview?: CodexReviewDetails | null;
};

type CodexReviewPrepareResponse = {
  error?: string;
  path?: string;
  includedArticleCount?: number;
  reviewerProfile?: {
    version?: string;
    role?: string;
    posture?: string;
    companyContext?: {
      companyName?: string;
      sector?: string;
    };
  };
  reviewBrief?: {
    reviewerProfile?: {
      version?: string;
      role?: string;
      companyContext?: {
        companyName?: string;
        sector?: string;
      };
    };
    duplicateGroupCount?: number;
    likelyNoiseArticleCount?: number;
    articleTextStatusCounts?: Record<string, number>;
  };
};

type CodexReviewDetails = {
  appliedNewsDigest?: DepositGuideNewsInput;
  longTermThesisSignals?: CodexReviewTheme[];
  staleOrNoisyItems?: Array<{ reason?: string }>;
  unresolvedThemes?: string[];
  suggestedGuideImpact?: {
    rationale?: string;
    expectedAdjustmentPercent?: number;
    recommendedDepositAud?: number;
    depositSuggestion?: string;
    newsSignal?: string;
  };
  rationale?: string;
};

type StockReviewComparisonCard = {
  symbol: string;
  reviewMonth: string;
  status: "loaded" | "prepared" | "missing" | "error";
  filename?: string;
  generatedAt?: string;
  rankScore: number;
  codexReview?: CodexReviewDetails;
  error?: string;
};

type CodexReviewTheme = {
  theme?: string;
  direction?: string;
  materiality?: string;
  judgement?: string;
};

type ReviewerDraft = {
  role: string;
  mandate: string;
  posture: string;
  companyName: string;
  sector: string;
  thesisDrivers: string;
  keyRisks: string;
  materialityKeywords: string;
};

const COMPARISON_SYMBOLS = ["AAPL", "NVDA", "AMZN", "TSLA", "SPCX"] as const;

export function DashboardClient() {
  const tracker = useTrackerData();
  const {
    snapshot,
    settings,
    saleEvent,
    quote,
    currentPriceUsd,
    latestUsdToAudRate,
    latestAudToUsdRate,
    isLoading,
    isRefreshing,
    warning,
    refreshMarketData,
    refreshNewsArticles,
    refreshNewsArticlesForSymbols,
    clearNewsCacheForSymbol,
    clearMarketDataCacheForSymbol,
  } = tracker;
  const [isPreparingCodexReview, setIsPreparingCodexReview] = useState(false);
  const [isPreparingComparisonReviews, setIsPreparingComparisonReviews] = useState(false);
  const [isFetchingCodexArticles, setIsFetchingCodexArticles] = useState(false);
  const [isClearingCodexArticles, setIsClearingCodexArticles] = useState(false);
  const [isClearingMarketCache, setIsClearingMarketCache] = useState(false);
  const [codexReviewStatus, setCodexReviewStatus] = useState<{
    tone: "success" | "error";
    message: string;
    path?: string;
  }>();
  const [codexReviewLookup, setCodexReviewLookup] = useState<{
    lookupKey: string;
    digest?: DepositGuideNewsInput;
    review?: CodexReviewDetails;
  }>();
  const [comparisonReviews, setComparisonReviews] = useState<StockReviewComparisonCard[]>([]);
  const [comparisonLoading, setComparisonLoading] = useState(true);
  const [comparisonError, setComparisonError] = useState<string | undefined>();
  const [comparisonRefreshTick, setComparisonRefreshTick] = useState(0);
  const [selectedComparisonSymbol, setSelectedComparisonSymbol] = useState<string | undefined>(
    () => loadSelectedComparisonSymbol(),
  );
  const reviewerDraftRef = useRef<ReviewerDraft>(createReviewerDraft(settings.baseTicker));
  const syncReviewerDraftRef = useCallback((draft: ReviewerDraft) => {
    reviewerDraftRef.current = draft;
  }, []);
  const refreshComparisonReviews = useCallback(() => {
    setComparisonLoading(true);
    setComparisonError(undefined);
    setComparisonRefreshTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    reviewerDraftRef.current = loadReviewerDraft(settings.baseTicker);
  }, [settings.baseTicker]);

  const metrics = useMemo(
    () =>
      calculateCatchUpMetrics({
        settings,
        saleEvent,
        contributions: snapshot.contributions,
        trades: snapshot.trades,
        dividends: settings.includeDividends ? snapshot.dividends : [],
        splits: settings.includeSplits ? snapshot.splits : [],
        currentPriceUsd,
        latestUsdToAudRate,
        asOfDate: todayIso(),
      }),
    [
      currentPriceUsd,
      latestUsdToAudRate,
      saleEvent,
      settings,
      snapshot.contributions,
      snapshot.dividends,
      snapshot.splits,
      snapshot.trades,
    ],
  );

  const series = useMemo(
    () =>
      buildHistoricalValueSeries(
        settings,
        saleEvent,
        snapshot.contributions,
        snapshot.trades,
        settings.includeDividends ? snapshot.dividends : [],
        settings.includeSplits ? snapshot.splits : [],
        snapshot.dailyPrices,
        currentPriceUsd,
        latestUsdToAudRate,
        todayIso(),
      ),
    [
      currentPriceUsd,
      latestUsdToAudRate,
      saleEvent,
      settings,
      snapshot.contributions,
      snapshot.dailyPrices,
      snapshot.dividends,
      snapshot.splits,
      snapshot.trades,
    ],
  );

  const projection4 = projectCatchUp({
    startDate: todayIso(),
    months: 48,
    monthlyContributionAud: settings.planMonthlyContributionAud,
    audUsdRate: latestAudToUsdRate,
    annualGrowthRatePercent: 6,
    annualDividendYieldPercent: settings.includeDividends ? 0.5 : 0,
    includeDividends: settings.includeDividends,
    startingPriceUsd: currentPriceUsd,
    hadHeldShares: metrics.equivalentSharesToday,
    rebuildShares: metrics.currentRebuildShares,
    rebuildCashUsd: metrics.cashBalanceUsd,
    hadHeldDividendCashUsd: metrics.hadHeldDividendCashUsd,
    rebuildDividendCashUsd: metrics.rebuildDividendCashUsd,
  });

  const projection5 = projectCatchUp({
    startDate: todayIso(),
    months: 60,
    monthlyContributionAud: settings.planMonthlyContributionAud,
    audUsdRate: latestAudToUsdRate,
    annualGrowthRatePercent: 6,
    annualDividendYieldPercent: settings.includeDividends ? 0.5 : 0,
    includeDividends: settings.includeDividends,
    startingPriceUsd: currentPriceUsd,
    hadHeldShares: metrics.equivalentSharesToday,
    rebuildShares: metrics.currentRebuildShares,
    rebuildCashUsd: metrics.cashBalanceUsd,
    hadHeldDividendCashUsd: metrics.hadHeldDividendCashUsd,
    rebuildDividendCashUsd: metrics.rebuildDividendCashUsd,
  });
  const newsDigest = useMemo(
    () =>
      buildNewsDigest(
        settings.baseTicker,
        (snapshot.newsArticles || []).filter(
          (article) =>
            article.symbol === settings.baseTicker &&
            isRelevantNewsArticle(article, settings.baseTicker),
        ),
      ),
    [settings.baseTicker, snapshot.newsArticles],
  );
  const aiNewsDigest = useMemo(
    () => buildAiNewsDigest(settings.baseTicker, snapshot.newsAnalyses || []),
    [settings.baseTicker, snapshot.newsAnalyses],
  );
  const codexReviewMonth = todayIso().slice(0, 7);
  const codexReviewLookupKey = `${settings.baseTicker}:${codexReviewMonth}`;
  useEffect(() => {
    let isActive = true;
    const lookupKey = codexReviewLookupKey;
    const params = new URLSearchParams({
      symbol: settings.baseTicker,
      reviewMonth: codexReviewMonth,
    });

    fetch(`/api/codex-review-bundle?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return undefined;
        }
        return (await response.json()) as CodexReviewLookupResponse;
      })
      .then((result) => {
        if (isActive) {
          setCodexReviewLookup({
            lookupKey,
            digest: result?.codexReview?.appliedNewsDigest,
            review: result?.codexReview ?? undefined,
          });
        }
      })
      .catch(() => {
        if (isActive) {
          setCodexReviewLookup({ lookupKey });
        }
      });

    return () => {
      isActive = false;
    };
  }, [codexReviewLookupKey, codexReviewMonth, settings.baseTicker]);

  useEffect(() => {
    let isActive = true;

    queueMicrotask(() => {
      if (!isActive) {
        return;
      }
      setComparisonLoading(true);
      setComparisonError(undefined);
    });

    Promise.all(
      COMPARISON_SYMBOLS.map(async (symbol) => {
        try {
          const params = new URLSearchParams({
            symbol,
            reviewMonth: codexReviewMonth,
          });
          const response = await withTimeout(
            fetch(`/api/codex-review-bundle?${params.toString()}`, {
              cache: "no-store",
            }),
            7000,
          );
          if (!response) {
            return {
              symbol,
              reviewMonth: codexReviewMonth,
              status: "missing" as const,
              rankScore: -999,
            };
          }
          if (!response.ok) {
            return {
              symbol,
              reviewMonth: codexReviewMonth,
              status: "missing" as const,
              rankScore: -999,
            };
          }
          const payload = (await response.json()) as CodexReviewLookupResponse & {
            filename?: string;
            generatedAt?: string;
          };
          const review = payload.codexReview ?? undefined;
          return {
            symbol,
            reviewMonth: codexReviewMonth,
            status: review ? "loaded" : "prepared",
            filename: payload.filename,
            generatedAt: payload.generatedAt,
            codexReview: review,
            rankScore: review ? scoreCodexReviewForComparison(review) : 0,
          } as StockReviewComparisonCard;
        } catch (error) {
          return {
            symbol,
            reviewMonth: codexReviewMonth,
            status: "error" as const,
            rankScore: -999,
            error: error instanceof Error ? error.message : "Could not load review.",
          };
        }
      }),
    )
      .then((results) => {
        if (!isActive) {
          return;
        }
        setComparisonReviews(results.sort((left, right) => right.rankScore - left.rankScore));
      })
      .catch((error) => {
        if (!isActive) {
          return;
        }
        setComparisonError(error instanceof Error ? error.message : "Could not load comparison reviews.");
      })
      .finally(() => {
        if (isActive) {
          setComparisonLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [codexReviewMonth, comparisonRefreshTick]);

  const codexReviewDigest =
    codexReviewLookup?.lookupKey === codexReviewLookupKey
      ? codexReviewLookup.digest
      : undefined;
  const codexReviewDetails =
    codexReviewLookup?.lookupKey === codexReviewLookupKey
      ? codexReviewLookup.review
      : undefined;
  const loadedComparisonReviews = comparisonReviews.filter((item) => item.status === "loaded");
  const bestComparisonReview = loadedComparisonReviews[0];
  const selectedComparisonReview =
    loadedComparisonReviews.find((item) => item.symbol === selectedComparisonSymbol) ??
    bestComparisonReview;
  const effectiveSelectedComparisonSymbol =
    selectedComparisonReview?.symbol ?? bestComparisonReview?.symbol ?? loadedComparisonReviews[0]?.symbol;
  useEffect(() => {
    persistSelectedComparisonSymbol(selectedComparisonSymbol);
  }, [selectedComparisonSymbol]);
  const comparisonStatusRows = useMemo(
    () =>
      COMPARISON_SYMBOLS.map((symbol) => {
        const monthArticleCount = (snapshot.newsArticles || []).filter(
          (article) => article.symbol === symbol && articleMonthKey(article) === codexReviewMonth,
        ).length;
        const comparisonEntry = comparisonReviews.find(
          (item) => item.symbol === symbol && item.status !== "error",
        );
        return {
          symbol,
          fetched: monthArticleCount > 0,
          articleCount: monthArticleCount,
          prepared: Boolean(comparisonEntry),
          reviewed: comparisonEntry?.status === "loaded",
        };
      }),
    [codexReviewMonth, comparisonReviews, snapshot.newsArticles],
  );
  const fetchedComparisonCount = comparisonStatusRows.filter((item) => item.fetched).length;
  const preparedComparisonCount = comparisonStatusRows.filter((item) => item.prepared).length;
  const reviewedComparisonCount = comparisonStatusRows.filter((item) => item.reviewed).length;
  const selectedComparisonDigest = selectedComparisonReview?.codexReview?.appliedNewsDigest;
  const guideNewsDigest =
    selectedComparisonDigest ??
    codexReviewDigest ??
    (aiNewsDigest.articleCount > 0
      ? {
          ...aiNewsDigest,
          analysisMode: "aiArticleAnalysis" as const,
        }
      : {
          ...newsDigest,
          analysisMode: "headlineRules" as const,
        });
  const codexReviewArticleLimit = 40;
  const codexReviewArticles = useMemo(
    () =>
      (snapshot.newsArticles || [])
        .filter(
          (article) =>
            article.symbol === settings.baseTicker &&
            isRelevantNewsArticle(article, settings.baseTicker) &&
            articleMonthKey(article) === codexReviewMonth,
        )
        .sort(compareArticlesForCodexReview),
    [codexReviewMonth, settings.baseTicker, snapshot.newsArticles],
  );
  const codexReviewIncludedCount = Math.min(
    codexReviewArticles.length,
    codexReviewArticleLimit,
  );
  const cachedAaplArticles = useMemo(
    () =>
      (snapshot.newsArticles || [])
        .filter((article) => article.symbol === settings.baseTicker)
        .sort(compareArticlesForCodexReview),
    [settings.baseTicker, snapshot.newsArticles],
  );
  const cachedAaplArticleDateGroups = useMemo(
    () => groupArticlesByDate(cachedAaplArticles),
    [cachedAaplArticles],
  );
  const marketCacheSummary = useMemo(
    () =>
      summarizeMarketCache({
        symbol: settings.baseTicker,
        dailyPrices: snapshot.dailyPrices,
        quotes: snapshot.quotes,
        includeManual:
          settings.isDemoMode ||
          settings.defaultPriceMode === "manual" ||
          settings.marketDataProvider === "manual",
      }),
    [
      settings.baseTicker,
      settings.defaultPriceMode,
      settings.isDemoMode,
      settings.marketDataProvider,
      snapshot.dailyPrices,
      snapshot.quotes,
    ],
  );
  const depositGuide = calculateDepositGuide({
    planMonthlyContributionAud: settings.planMonthlyContributionAud,
    contributions: snapshot.contributions,
    dailyPrices: snapshot.dailyPrices,
    currentPriceUsd,
    latestUsdToAudRate,
    asOfDate: todayIso(),
    planStartDate: settings.planStartDate,
    news: guideNewsDigest,
    expectedAdjustmentPercent:
      codexReviewLookup?.lookupKey === codexReviewLookupKey
        ? codexReviewLookup.review?.suggestedGuideImpact?.expectedAdjustmentPercent
        : compareReviewExpectedAdjustmentPercent(
            selectedComparisonReview ?? bestComparisonReview,
          ),
  });
  const reviewSummarySource = bestComparisonReview?.codexReview
    ? {
        symbol: effectiveSelectedComparisonSymbol ?? bestComparisonReview.symbol,
        digest: guideNewsDigest,
        codexReview: selectedComparisonReview?.codexReview ?? bestComparisonReview.codexReview,
        rankScore: selectedComparisonReview?.rankScore ?? bestComparisonReview.rankScore,
      }
    : {
        symbol: settings.baseTicker,
        digest: guideNewsDigest,
        codexReview: codexReviewDetails,
        rankScore: undefined as number | undefined,
      };
  const guideReviewSummary = buildGuideReviewSummary({
    reviewSymbol: reviewSummarySource.symbol,
    digest: reviewSummarySource.digest,
    codexReview: reviewSummarySource.codexReview,
    guide: depositGuide,
    bestComparisonReview: typeof reviewSummarySource.rankScore === "number"
      ? {
          symbol: reviewSummarySource.symbol,
          rankScore: reviewSummarySource.rankScore,
        }
      : undefined,
  });

  const studyLoanFormulaMonthlyAud = calculateStudyLoanMonthlyRepaymentAud(
    settings.studyLoanAnnualIncomeAud,
  );
  const activeStudyLoanMonthlyAud = settings.studyLoanUseIncomeFormula
    ? studyLoanFormulaMonthlyAud
    : settings.studyLoanMonthlyRepaymentAud;
  const studyLoanProjectionRange = projectStudyLoanDebtRange({
    startDate: todayIso(),
    months: 120,
    startingBalanceAud: settings.studyLoanBalanceAud,
    monthlyRepaymentAud: activeStudyLoanMonthlyAud,
    annualIndexationRatePercent: settings.studyLoanAnnualIndexationRatePercent,
  });
  const assumedStudyLoanPayoffAud =
    settings.studyLoanPayoffAmountAud > 0
      ? settings.studyLoanPayoffAmountAud
      : settings.studyLoanBalanceAud;
  const debtAfterPayoffAud = Math.max(
    0,
    settings.studyLoanBalanceAud - assumedStudyLoanPayoffAud,
  );
  const freedRepaymentAud =
    settings.studyLoanRedirectFreedRepayment && debtAfterPayoffAud <= 0
      ? activeStudyLoanMonthlyAud
      : 0;
  const freedRepaymentValue = projectFreedRepaymentIntoAapl({
    startDate: todayIso(),
    months: 60,
    monthlyFreedCashAud: freedRepaymentAud,
    audUsdRate: latestAudToUsdRate,
    startingPriceUsd: currentPriceUsd,
    annualGrowthRatePercent: 6,
  });

  if (isLoading) {
    return (
      <AppShell title="Dashboard" subtitle="Loading your local tracker.">
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent>
        </Card>
      </AppShell>
    );
  }

  if (!saleEvent) {
    return (
      <AppShell
        title="Create dashboard"
        subtitle="Enter the original AAPL sale details or load demo data to explore the app first."
      >
        <Card>
          <CardContent className="flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium">No sale event is saved yet.</p>
              <p className="text-sm text-muted-foreground">
                The Had I Held benchmark depends on the sale date, shares sold, and sale proceeds.
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild>
                <Link href="/setup">
                  Start setup <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" onClick={tracker.loadDemo}>
                Load demo data
              </Button>
            </div>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const displayUsdValue = (usd: number) =>
    settings.displayCurrency === "AUD"
      ? moneyAud(usd * latestUsdToAudRate)
      : moneyUsd(usd);
  const displayAudValue = (aud: number) =>
    settings.displayCurrency === "USD"
      ? moneyUsd(aud * latestAudToUsdRate)
      : moneyAud(aud);
  const signedDisplayValue = (usd: number) => {
    const value = displayUsdValue(Math.abs(usd));
    if (usd < 0) {
      return `${value} ahead`;
    }
    return value;
  };
  const rebuildAaplValueUsd = Math.max(
    0,
    roundMoney(metrics.rebuildMarketValueUsd + metrics.rebuildDividendCashUsd),
  );
  const rebuildHeadlineUsd =
    metrics.rebuildTotalValueUsd < 0 ? rebuildAaplValueUsd : metrics.rebuildTotalValueUsd;
  const hasTrades = snapshot.trades.length > 0;
  const cashNeedsReview = metrics.cashBalanceUsd < -1;
  const quoteLabel =
    quote?.provider === "manual" ? "manual" : quote?.isDelayed ? "delayed" : "live or cached";
  const fiveYearGapText =
    projection5.projectedGapUsd <= 0
      ? `${displayUsdValue(Math.abs(projection5.projectedGapUsd))} ahead`
      : displayUsdValue(projection5.projectedGapUsd);
  const fourYearGapText =
    projection4.projectedGapUsd <= 0
      ? `${displayUsdValue(Math.abs(projection4.projectedGapUsd))} ahead`
      : displayUsdValue(projection4.projectedGapUsd);
  const currentMonthContributionAud = calculateCurrentMonthContributionAud(
    snapshot.contributions,
    todayIso(),
    latestUsdToAudRate,
  );
  const loggedToDateAud = metrics.actualContributionsAud;
  const completedMonths = Math.max(0, monthsElapsedInclusive(settings.planStartDate, todayIso()) - 1);
  const cumulativeTargetAud = completedMonths * settings.planMonthlyContributionAud;
  const cumulativeGapAud = Math.max(0, cumulativeTargetAud - loggedToDateAud);
  const cumulativeProgressPercent =
    cumulativeTargetAud > 0
      ? Math.min(100, (loggedToDateAud / cumulativeTargetAud) * 100)
      : loggedToDateAud > 0
        ? 100
        : 0;
  const hasCurrentValuation = currentPriceUsd > 0 && metrics.hadHeldTotalValueUsd > 0;
  const schoolDecisionHadHeldUsd = hasCurrentValuation
    ? metrics.hadHeldTotalValueUsd
    : saleEvent.netProceedsUsd;
  const schoolDecisionRebuildAssetUsd = Math.max(0, metrics.rebuildTotalValueUsd);
  const currentMonthSchoolDecision = buildCurrentMonthSchoolDecision({
    asOfDate: todayIso(),
    currentHadHeldTotalUsd: schoolDecisionHadHeldUsd,
    originalSaleProceedsUsd: saleEvent.netProceedsUsd,
    currentRebuildAssetValueUsd: schoolDecisionRebuildAssetUsd,
    currentSchoolDebtAud: settings.studyLoanBalanceAud,
    debtAfterPayoffAud,
    totalContributionsAud: metrics.actualContributionsAud,
    latestUsdToAudRate,
    monthlyEducationRepaymentAud: activeStudyLoanMonthlyAud,
    currentMonthContributionAud,
    targetMonthContributionAud: depositGuide.recommendedDepositAud,
    hasCurrentValuation,
  });
  const schoolDecisionProjectionMonths = Math.min(
    240,
    Math.max(180, Math.ceil(settings.studyLoanBalanceAud / Math.max(1, settings.planMonthlyContributionAud))),
  );
  const schoolDecisionMonthlyDepositAud = Math.max(
    depositGuide.recommendedDepositAud,
    freedRepaymentAud,
  );
  const schoolDecisionTimeline = buildSchoolDecisionCompoundTimeline({
    startDate: todayIso(),
    months: schoolDecisionProjectionMonths,
    keepStartingValueAud: currentMonthSchoolDecision.keepAaplValueAud,
    rebuildStartingValueAud: roundMoney(
      currentMonthSchoolDecision.rebuildAssetValueAud +
        currentMonthSchoolDecision.currentMonthDepositTopUpAud,
    ),
    monthlyContributionAud: schoolDecisionMonthlyDepositAud,
    currentSchoolDebtAud: settings.studyLoanBalanceAud,
    debtAfterPayoffAud,
    monthlyDebtRepaymentAud: activeStudyLoanMonthlyAud,
    annualDebtIndexationRatePercent: settings.studyLoanAnnualIndexationRatePercent,
    annualGrowthRatePercent: 6,
  });
  const schoolDecisionCrossDate = findSchoolDecisionCrossDate(schoolDecisionTimeline);
  const decisionGapAud = roundMoney(
    currentMonthSchoolDecision.keepAaplNetAud -
      currentMonthSchoolDecision.cashOutRebuildNetAud,
  );
  const decisionGapUsd =
    latestUsdToAudRate > 0 ? roundMoney(decisionGapAud / latestUsdToAudRate) : 0;
  const decisionGapPrimary = settings.displayCurrency === "AUD"
    ? moneyAud(Math.abs(decisionGapAud))
    : moneyUsd(Math.abs(decisionGapUsd));
  const decisionGapSecondary = settings.displayCurrency === "AUD"
    ? `About ${moneyUsd(Math.abs(decisionGapUsd))} at the latest USD/AUD rate.`
    : `About ${moneyAud(Math.abs(decisionGapAud))} at the latest USD/AUD rate.`;
  const isAhead = decisionGapAud <= 0;
  const loggedProgressPercent = Math.min(Math.max(cumulativeProgressPercent, 0), 100);
  const progressForBar = loggedProgressPercent;
  const schoolPayoffRange =
    studyLoanProjectionRange.earliestPaidOffDate && studyLoanProjectionRange.latestPaidOffDate
      ? `${formatDisplayDate(studyLoanProjectionRange.earliestPaidOffDate)} to ${formatDisplayDate(studyLoanProjectionRange.latestPaidOffDate)}`
      : "Not within 10 years";
  const logThisMonthHref = "/transactions";

  function getReviewArticlesForSymbol(symbol: string) {
    const normalizedSymbol = symbol.toUpperCase();
    return (snapshot.newsArticles || [])
      .filter(
        (article) =>
          article.symbol === normalizedSymbol &&
          isRelevantNewsArticle(article, normalizedSymbol) &&
          articleMonthKey(article) === codexReviewMonth,
      )
      .sort(compareArticlesForCodexReview);
  }

  async function prepareMonthlyCodexReviewBundle() {
    if (codexReviewArticles.length === 0) {
      setCodexReviewStatus({
        tone: "error",
        message: `No ${settings.baseTicker} articles are cached for ${codexReviewMonth} yet.`,
      });
      return;
    }

    setIsPreparingCodexReview(true);
    setCodexReviewStatus(undefined);

    try {
      const response = await fetch("/api/codex-review-bundle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: settings.baseTicker,
          reviewMonth: codexReviewMonth,
          articles: codexReviewArticles,
          analyses: snapshot.newsAnalyses || [],
          guideContext: {
            generatedFrom: "dashboard",
            generatedForDate: todayIso(),
            depositGuide: {
              direction: depositGuide.direction,
              confidence: depositGuide.confidence,
              recommendedDepositAud: depositGuide.recommendedDepositAud,
              remainingThisMonthAud: depositGuide.remainingThisMonthAud,
              minThisMonthAud: depositGuide.minThisMonthAud,
              maxThisMonthAud: depositGuide.maxThisMonthAud,
              currentMonthContributedAud: depositGuide.currentMonthContributedAud,
              reasons: depositGuide.reasons,
              sources: depositGuide.sources,
            },
            marketContext: {
              currentPriceUsd,
              latestUsdToAudRate,
              latestAudToUsdRate,
              quoteProvider: quote?.provider,
              quoteAsOf: quote?.asOf,
            },
            catchUpContext: {
              catchUpGapUsd: metrics.catchUpGapUsd,
              rebuildTotalValueUsd: metrics.rebuildTotalValueUsd,
              hadHeldTotalValueUsd: metrics.hadHeldTotalValueUsd,
              currentRebuildShares: metrics.currentRebuildShares,
            },
            newsContext: {
              selectedDigest: guideNewsDigest,
              headlineDigest: newsDigest,
              aiDigest: aiNewsDigest,
              cachedArticleCountForMonth: codexReviewArticles.length,
              localBundleArticleLimit: codexReviewArticleLimit,
            },
            reviewerContext: reviewerDraftToContext(reviewerDraftRef.current),
          },
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        path?: string;
        includedArticleCount?: number;
        reviewerProfile?: {
          version?: string;
          role?: string;
          posture?: string;
          companyContext?: {
            companyName?: string;
            sector?: string;
          };
        };
        reviewBrief?: {
          reviewerProfile?: {
            version?: string;
            role?: string;
            companyContext?: {
              companyName?: string;
              sector?: string;
            };
          };
          duplicateGroupCount?: number;
          likelyNoiseArticleCount?: number;
          articleTextStatusCounts?: Record<string, number>;
        };
      };

      if (!response.ok) {
        throw new Error(result.error || "Could not prepare the Codex review bundle.");
      }

      const reviewerVersion =
        result.reviewerProfile?.version ?? result.reviewBrief?.reviewerProfile?.version;

      setCodexReviewStatus({
        tone: "success",
        message: `Saved ${result.includedArticleCount ?? 0} article${
          result.includedArticleCount === 1 ? "" : "s"
        } for ${codexReviewMonth} with a review brief (${result.reviewBrief?.duplicateGroupCount ?? 0} duplicate group${
          result.reviewBrief?.duplicateGroupCount === 1 ? "" : "s"
        }, ${result.reviewBrief?.likelyNoiseArticleCount ?? 0} likely-noise item${
          result.reviewBrief?.likelyNoiseArticleCount === 1 ? "" : "s"
        }${reviewerVersion ? `, reviewer charter v${reviewerVersion}` : ""}).`,
        path: result.path,
      });
      if (COMPARISON_SYMBOLS.includes(settings.baseTicker as (typeof COMPARISON_SYMBOLS)[number])) {
        refreshComparisonReviews();
      }
    } catch (error) {
      setCodexReviewStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Could not prepare the Codex review bundle.",
      });
    } finally {
      setIsPreparingCodexReview(false);
    }
  }

  async function prepareAllComparisonReviewBundles() {
    setIsPreparingComparisonReviews(true);
    setCodexReviewStatus(undefined);

    try {
      const results = await Promise.allSettled(
        COMPARISON_SYMBOLS.map((symbol) => prepareReviewBundleForSymbol(symbol, "dashboard-batch")),
      );
      const preparedSymbols: string[] = [];
      const skippedSymbols: string[] = [];
      const failedMessages: string[] = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          if (result.value.status === "saved") {
            preparedSymbols.push(result.value.symbol);
          } else {
            skippedSymbols.push(result.value.symbol);
          }
          continue;
        }
        failedMessages.push(
          result.reason instanceof Error ? result.reason.message : "Could not prepare a review bundle.",
        );
      }

      const parts = [];
      if (preparedSymbols.length > 0) {
        parts.push(`Prepared ${preparedSymbols.join(", ")}`);
      }
      if (skippedSymbols.length > 0) {
        parts.push(`Skipped ${skippedSymbols.join(", ")} (no cached articles for ${codexReviewMonth})`);
      }
      if (failedMessages.length > 0) {
        parts.push(`Failed: ${failedMessages[0]}`);
      }

      setCodexReviewStatus({
        tone: failedMessages.length > 0 && preparedSymbols.length === 0 ? "error" : "success",
        message:
          parts.length > 0
            ? `${parts.join(". ")}.`
            : "No comparison review bundles were prepared.",
      });
      refreshComparisonReviews();
    } finally {
      setIsPreparingComparisonReviews(false);
    }
  }

  async function fetchAllComparisonNews() {
    setIsFetchingCodexArticles(true);
    setCodexReviewStatus(undefined);

    try {
      const results = await refreshNewsArticlesForSymbols(Array.from(COMPARISON_SYMBOLS));
      const fetched = results.filter((item) => item.result).map((item) => item.symbol);
      const failed = results.filter((item) => item.error).map((item) => item.symbol);
      const messageParts = [];
      if (fetched.length > 0) {
        messageParts.push(`Loaded stored ${fetched.join(", ")}`);
      }
      if (failed.length > 0) {
        messageParts.push(`Failed for ${failed.join(", ")}`);
      }

      setCodexReviewStatus({
        tone: failed.length > 0 && fetched.length === 0 ? "error" : "success",
        message:
          messageParts.length > 0
            ? `${messageParts.join(". ")}.`
            : "No stored comparison news is available yet.",
      });
      refreshComparisonReviews();
    } catch (error) {
      setCodexReviewStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Could not load stored comparison news.",
      });
    } finally {
      setIsFetchingCodexArticles(false);
    }
  }

  async function prepareReviewBundleForSymbol(
    symbol: string,
    generatedFrom: "dashboard" | "dashboard-batch",
  ) {
    const normalizedSymbol = symbol.toUpperCase();
    const symbolArticles = getReviewArticlesForSymbol(normalizedSymbol);
    if (symbolArticles.length === 0) {
      return {
        symbol: normalizedSymbol,
        status: "missing" as const,
      };
    }

    const selectedDigest =
      normalizedSymbol === settings.baseTicker
        ? guideNewsDigest
        : (() => {
            const aiDigest = buildAiNewsDigest(normalizedSymbol, snapshot.newsAnalyses || []);
            if (aiDigest.articleCount > 0) {
              return { ...aiDigest, analysisMode: "aiArticleAnalysis" as const };
            }
            return {
              ...buildNewsDigest(normalizedSymbol, symbolArticles),
              analysisMode: "headlineRules" as const,
            };
          })();

    const response = await fetch("/api/codex-review-bundle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol: normalizedSymbol,
        reviewMonth: codexReviewMonth,
        articles: symbolArticles,
        analyses: snapshot.newsAnalyses || [],
        guideContext: {
          generatedFrom,
          generatedForDate: todayIso(),
          newsContext: {
            selectedDigest,
            headlineDigest: buildNewsDigest(normalizedSymbol, symbolArticles),
            aiDigest: buildAiNewsDigest(normalizedSymbol, snapshot.newsAnalyses || []),
            cachedArticleCountForMonth: symbolArticles.length,
            localBundleArticleLimit: codexReviewArticleLimit,
          },
        },
      }),
    });

    const result = (await response.json().catch(() => ({}))) as CodexReviewPrepareResponse;
    if (!response.ok) {
      throw new Error(result.error || "Could not prepare the Codex review bundle.");
    }

    return {
      symbol: normalizedSymbol,
      status: "saved" as const,
      result,
    };
  }

  async function fetchCodexReviewArticles() {
    setIsFetchingCodexArticles(true);
    setCodexReviewStatus(undefined);

    try {
      const result = await refreshNewsArticles(settings.baseTicker);
      setCodexReviewLookup({ lookupKey: codexReviewLookupKey });
      setCodexReviewStatus({
        tone: "success",
        message: `Loaded ${result.articleCount} stored ${settings.baseTicker} article${
          result.articleCount === 1 ? "" : "s"
        } from the automated collection. The monthly review publishes automatically.`,
      });
    } catch (error) {
      setCodexReviewStatus({
        tone: "error",
        message: error instanceof Error ? error.message : `Could not fetch ${settings.baseTicker} articles.`,
      });
    } finally {
      setIsFetchingCodexArticles(false);
    }
  }

  async function clearCachedCodexArticles() {
    if (
      cachedAaplArticles.length > 0 &&
      !window.confirm(
        `Remove all cached ${settings.baseTicker} articles and saved article analyses from this browser?`,
      )
    ) {
      return;
    }

    setIsClearingCodexArticles(true);
    setCodexReviewStatus(undefined);

    try {
      const result = await clearNewsCacheForSymbol(settings.baseTicker);
      setCodexReviewLookup({ lookupKey: codexReviewLookupKey });
      setCodexReviewStatus({
        tone: "success",
        message: `Removed ${result.articlesDeleted} cached ${settings.baseTicker} article${
          result.articlesDeleted === 1 ? "" : "s"
        } and ${result.analysesDeleted} saved analysis record${
          result.analysesDeleted === 1 ? "" : "s"
        } from local storage.`,
      });
    } catch (error) {
      setCodexReviewStatus({
        tone: "error",
        message: error instanceof Error ? error.message : `Could not clear ${settings.baseTicker} articles.`,
      });
    } finally {
      setIsClearingCodexArticles(false);
    }
  }

  async function clearMarketCacheAndRefresh() {
    if (
      !window.confirm(
        `Clear cached ${settings.baseTicker} quotes, price history, dividends, and splits from this browser, then fetch them again?`,
      )
    ) {
      return;
    }

    setIsClearingMarketCache(true);

    try {
      await clearMarketDataCacheForSymbol(settings.baseTicker);
      await refreshMarketData(true);
    } finally {
      setIsClearingMarketCache(false);
    }
  }

  return (
    <AppShell
      title="Overview"
      subtitle="Track where you stand, what changed, and what needs attention in one clean view."
    >
      <div className="space-y-5">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.85fr)]">
          <Card
            className={cn(
              isAhead ? "border-accent bg-accent/30" : "border-[#f4cf76] bg-[#fff8e7] dark:bg-[#33280f]",
            )}
          >
            <CardContent className="space-y-6 p-5 md:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-3">
                  <Badge variant={isAhead ? "success" : "warning"}>
                    {isAhead ? "Rebuild ahead" : "Rebuild catching up"}
                  </Badge>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium uppercase text-muted-foreground">
                        {isAhead ? "Monthly position" : "Monthly gap"}
                      </p>
                      <InfoTip title="Debt-adjusted gap">
                        <p>
                          This is the gap between the debt-adjusted school-decision paths:
                          Keep AAPL while making the monthly school repayment versus pay off the
                          debt and rebuild with this month&apos;s guided AAPL deposit. It is different
                          from the AAPL-only catch-up gap in the detailed numbers.
                        </p>
                      </InfoTip>
                    </div>
                    <h2 className="mt-2 text-4xl font-semibold tracking-normal md:text-5xl">
                      {decisionGapPrimary}
                    </h2>
                  <p className="mt-2 text-base text-muted-foreground">
                    {isAhead
                      ? "A simple signal that the rebuild path is currently ahead."
                      : decisionGapSecondary}
                  </p>
                </div>
              </div>

                <div className="rounded-lg border bg-background/80 p-4 lg:min-w-[260px]">
                  <p className="text-sm font-medium text-muted-foreground">12-month cycle</p>
                  <p className="mt-1 text-3xl font-semibold">
                    {formatPercent(loggedProgressPercent)}%
                  </p>
                  <Progress className="mt-3" value={progressForBar} />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {formatCurrency(cumulativeGapAud, "AUD")} remains to reach the cumulative target of {formatCurrency(cumulativeTargetAud, "AUD")}.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <HeroStat
                  label="Suggested deposit"
                  value={displayAudValue(depositGuide.recommendedDepositAud)}
                  note={`${displayAudValue(depositGuide.minThisMonthAud)} to ${displayAudValue(depositGuide.maxThisMonthAud)} guardrail range.`}
                  tip="This is the deposit guide amount for the current month. It starts from your normal plan and then applies the guardrail."
                />
                <HeroStat
                  label="Left to log"
                  value={displayAudValue(depositGuide.remainingThisMonthAud)}
                  note="Based on contributions already dated this month."
                  tip="This is the remaining amount to log to reach the suggested deposit for this month."
                />
              </div>

              <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row">
                <Button asChild>
                  <Link href={logThisMonthHref}>
                    Log this month <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/projections">
                    Open projections <BarChart3 className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="h-5 w-5 text-primary" />
                Next steps
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <AttentionItem
                icon={<Wallet className="h-4 w-4" />}
                title={hasTrades ? "Monthly buy tracking" : "Start with your first buy"}
                text={
                  hasTrades
                    ? `${formatShares(metrics.currentRebuildShares)} AAPL shares are currently logged.`
                    : "Add a contribution and let the app estimate shares from the latest AAPL price."
                }
                tone={hasTrades ? "ok" : "action"}
              />
              <AttentionItem
                icon={<TrendingUp className="h-4 w-4" />}
                title="This month deposit guide"
                text={
                  `${guideLabel(depositGuide.direction)}: target ${displayAudValue(depositGuide.recommendedDepositAud)} this month, with ${displayAudValue(depositGuide.remainingThisMonthAud)} left to log.`
                }
                tone={depositGuide.direction === "hold" ? "ok" : "action"}
              />
              <AttentionItem
                icon={<CircleDollarSign className="h-4 w-4" />}
                title="Cash balance"
                text={
                  cashNeedsReview
                    ? "Logged buys are greater than logged funding. Add a matching contribution or check the trade cost."
                    : `${displayUsdValue(metrics.cashBalanceUsd)} available after logged contributions and trades.`
                }
                tone={cashNeedsReview ? "action" : "ok"}
              />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <SummaryTile
            icon={<Landmark className="h-5 w-5" />}
            title="If you'd held"
            value={displayUsdValue(metrics.hadHeldTotalValueUsd)}
            description="What the original AAPL position is worth today."
            rows={[
              ["Equivalent shares", formatShares(metrics.equivalentSharesToday)],
              ["AAPL price", moneyUsd(currentPriceUsd)],
              ["Dividends included", displayUsdValue(metrics.hadHeldDividendCashUsd)],
            ]}
          />
          <SummaryTile
            icon={<Wallet className="h-5 w-5" />}
            title="Current rebuild"
            value={displayUsdValue(rebuildHeadlineUsd)}
            description={
              metrics.cashBalanceUsd < 0
                ? "Your AAPL value. Funding shortfall is shown below."
                : "Your logged AAPL rebuild, cash, and dividends."
            }
            rows={[
              ["Shares owned", formatShares(metrics.currentRebuildShares)],
              ["Stock received in USD", displayUsdValue(metrics.totalContributionsUsd)],
              ["Market value", displayUsdValue(metrics.rebuildMarketValueUsd)],
              ["Cash balance", displayUsdValue(metrics.cashBalanceUsd)],
            ]}
          />
          <SummaryTile
            icon={<TrendingUp className="h-5 w-5" />}
            title="Deposit guide"
            value={displayAudValue(depositGuide.recommendedDepositAud)}
            description={`Remaining this month: ${displayAudValue(depositGuide.remainingThisMonthAud)}.`}
            rows={[
              ["Guide", guideLabel(depositGuide.direction)],
              ["Monthly range", `${displayAudValue(depositGuide.minThisMonthAud)} to ${displayAudValue(depositGuide.maxThisMonthAud)}`],
              ["Flex bank", displayAudValue(depositGuide.bankedFlexAud)],
            ]}
          />
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Deposit guide
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {bestComparisonReview ? (
              <div className="grid gap-3 rounded-lg border bg-background p-4 text-sm text-muted-foreground md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <p className="font-medium text-foreground">
                    Strongest comparison ticket: {bestComparisonReview.symbol}
                  </p>
                  <p className="mt-1">
                    The main deposit guide follows the selected comparison ticket, while the rest
                    of the tickets stay fetched in the background.
                  </p>
                </div>
                <div className="min-w-[220px]">
                  <Label className="text-xs uppercase text-muted-foreground">
                    Use this ticket
                  </Label>
                  <Select
                    value={effectiveSelectedComparisonSymbol ?? bestComparisonReview.symbol}
                    onValueChange={(value) => setSelectedComparisonSymbol(value)}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Choose ticket" />
                    </SelectTrigger>
                    <SelectContent>
                      {loadedComparisonReviews.map((item) => (
                        <SelectItem key={item.symbol} value={item.symbol}>
                          {item.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
              <PlainMetric
                label="Guide"
                value={guideLabel(depositGuide.direction)}
                note={`${depositGuide.confidence} confidence, ${formatSignedPercent(depositGuide.adjustmentPercent)} vs neutral.`}
                tip="This is the app's plain suggestion for this month only. Confidence controls how aggressively the guide leans inside the 20% guardrail."
              />
              <PlainMetric
                label="Target this month"
                value={displayAudValue(depositGuide.recommendedDepositAud)}
                note={`${displayAudValue(depositGuide.remainingThisMonthAud)} left after current-month deposits.`}
                tip="This is the amount the guide suggests for this calendar month. If you already logged some of it, the app shows only what is left."
              />
              <PlainMetric
                label="Allowed range"
                value={`${displayAudValue(depositGuide.minThisMonthAud)} to ${displayAudValue(depositGuide.maxThisMonthAud)}`}
                note={`${formatPercent(depositGuide.flexPercent * 100, 0)}% guardrail, used continuously.`}
                tip="This is the guardrail. The app can recommend any amount inside this range, not only the endpoints."
              />
              <PlainMetric
                label="News signal"
                value={newsSignalLabel(guideNewsDigest.signal)}
                note={`${guideNewsDigest.articleCount} ${newsArticleLabel(guideNewsDigest.analysisMode)}${guideNewsDigest.articleCount === 1 ? "" : "s"} from ${newsPublisherText(guideNewsDigest)}.`}
                tip="This reads recent free RSS headlines. When OpenAI API access is configured, the app analyzes article text with gpt-5.4-mini and escalates important or uncertain articles to gpt-5.4 before folding the digest into this month's guide."
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border bg-background p-4">
                <p className="text-sm font-medium">Why this guide?</p>
                <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                  {depositGuide.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border bg-background p-4">
                <p className="text-sm font-medium">
                  News summary for {reviewSummarySource.symbol}
                </p>
                <div className="mt-3 grid gap-3">
                  {guideReviewSummary.map((section) => (
                    <div key={section.label} className="rounded-md border bg-muted/30 p-3">
                      <p className={cn("text-xs font-semibold uppercase tracking-normal", section.className)}>
                        {section.label}
                      </p>
                      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                        {section.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
              {settings.showMonthlyCodexReview && (
                <div className="rounded-lg border bg-background p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">Automatic monthly Codex review</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {codexReviewIncludedCount} of {codexReviewArticles.length} stored{" "}
                        {settings.baseTicker} article{codexReviewArticles.length === 1 ? "" : "s"}{" "}
                        ready for {codexReviewMonth}. {cachedAaplArticles.length} total collected{" "}
                        {settings.baseTicker} article{cachedAaplArticles.length === 1 ? "" : "s"}.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      <Button
                        className="shrink-0"
                        disabled={isFetchingCodexArticles || isPreparingCodexReview || isClearingCodexArticles}
                        onClick={fetchCodexReviewArticles}
                        size="sm"
                        variant="outline"
                      >
                        {isFetchingCodexArticles ? "Loading..." : `Load stored ${settings.baseTicker} articles`}
                        <RefreshCw className={cn("h-4 w-4", isFetchingCodexArticles && "animate-spin")} />
                      </Button>
                      <Button
                        className="shrink-0"
                        disabled={
                          isPreparingCodexReview ||
                          isFetchingCodexArticles ||
                          isClearingCodexArticles ||
                          codexReviewArticles.length === 0
                        }
                        onClick={prepareMonthlyCodexReviewBundle}
                        size="sm"
                        variant="outline"
                      >
                        {isPreparingCodexReview ? "Preparing..." : "Prepare local fallback"}
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        className="shrink-0"
                        disabled={
                          isClearingCodexArticles ||
                          isFetchingCodexArticles ||
                          isPreparingCodexReview ||
                          cachedAaplArticles.length === 0
                        }
                        onClick={clearCachedCodexArticles}
                        size="sm"
                        variant="destructive"
                      >
                        {isClearingCodexArticles
                          ? "Removing..."
                          : `Remove all cached ${settings.baseTicker}`}
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <ReviewerCharterEditor
                    key={settings.baseTicker}
                    symbol={settings.baseTicker}
                    version={REVIEWER_SPEC_VERSION}
                    defaultOpen={settings.showReviewerCharter}
                    onDraftChange={syncReviewerDraftRef}
                  />
                  <details className="mt-3 rounded-md border bg-muted/20 text-sm">
                    <summary className="cursor-pointer list-none p-3 font-medium">
                      Cached articles by date ({cachedAaplArticles.length} total)
                    </summary>
                    <div className="border-t p-3">
                      {cachedAaplArticleDateGroups.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">
                            Grouped by published date when available, otherwise collected or cached date.
                          </p>
                          {cachedAaplArticleDateGroups.map((group) => (
                            <div
                              className="flex items-start justify-between gap-3 rounded-md border bg-background px-3 py-2"
                              key={group.dateKey}
                            >
                              <div>
                                <p className="font-medium">{group.label}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {group.publisherCount} publisher{group.publisherCount === 1 ? "" : "s"}
                                  {group.providerCount > 0
                                    ? ` across ${group.providerCount} feed${group.providerCount === 1 ? "" : "s"}`
                                    : ""}
                                </p>
                              </div>
                              <p className="shrink-0 text-sm font-semibold">
                                {group.count} article{group.count === 1 ? "" : "s"}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">
                          No cached {settings.baseTicker} articles in local storage.
                        </p>
                      )}
                    </div>
                  </details>
                  {codexReviewStatus ? (
                    <div
                      aria-live="polite"
                      className={cn(
                        "mt-3 rounded-md border px-3 py-2 text-sm",
                        codexReviewStatus.tone === "success"
                          ? "border-accent bg-accent/30 text-accent-foreground"
                          : "border-destructive/30 bg-destructive/10 text-destructive",
                      )}
                    >
                      <p>{codexReviewStatus.message}</p>
                      {codexReviewStatus.path ? (
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {codexReviewStatus.path}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Cross-stock comparison</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Ranks your saved reviews for AAPL, TSLA, NVDA, AMZN, and SPCX so you can see
                which one looks strongest for the current A$600 budget. Use the batch buttons to
                prepare them all in one pass.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Review month {codexReviewMonth}</Badge>
              <Button
                disabled={comparisonLoading || isPreparingComparisonReviews || isFetchingCodexArticles}
                onClick={fetchAllComparisonNews}
                size="sm"
                variant="default"
              >
                {isFetchingCodexArticles ? "Loading all..." : "Load stored news"}
                <RefreshCw className={cn("h-4 w-4", isFetchingCodexArticles && "animate-spin")} />
              </Button>
              <Button
                disabled={comparisonLoading || isPreparingComparisonReviews || isFetchingCodexArticles}
                onClick={prepareAllComparisonReviewBundles}
                size="sm"
                variant="default"
              >
                {isPreparingComparisonReviews ? "Preparing all..." : "Prepare all bundles"}
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                disabled={comparisonLoading}
                onClick={refreshComparisonReviews}
                size="sm"
                variant="outline"
              >
                {comparisonLoading ? "Refreshing..." : "Refresh comparison"}
                <RefreshCw className={cn("h-4 w-4", comparisonLoading && "animate-spin")} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Status:</span>{" "}
              {fetchedComparisonCount}/{COMPARISON_SYMBOLS.length} fetched this month,{" "}
              {preparedComparisonCount}/{COMPARISON_SYMBOLS.length} bundles ready,{" "}
              {reviewedComparisonCount}/{COMPARISON_SYMBOLS.length} published.{" "}
              {" "}
              {comparisonStatusRows
                .map((item) => {
                  if (item.reviewed) {
                    return `${item.symbol} published`;
                  }
                  if (item.prepared) {
                    return `${item.symbol} bundle ready`;
                  }
                  if (item.fetched) {
                    return `${item.symbol} fetched`;
                  }
                  return `${item.symbol} pending`;
                })
                .join(" · ")}
            </div>
            {comparisonLoading ? (
              <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                Loading comparison reviews...
              </div>
            ) : null}
            {comparisonError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                {comparisonError}
              </div>
            ) : null}
            <div className="rounded-lg border bg-background p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {bestComparisonReview
                      ? bestComparisonReview.rankScore >= 0
                        ? `${bestComparisonReview.symbol} looks strongest right now`
                        : `${bestComparisonReview.symbol} is the least weak review right now`
                      : "No published comparison review yet"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {bestComparisonReview?.codexReview?.suggestedGuideImpact?.rationale ??
                      "Prepare and publish the comparison reviews to get a ranked recommendation."}
                  </p>
                </div>
                {bestComparisonReview ? (
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        bestComparisonReview.codexReview?.appliedNewsDigest?.signal === "positive"
                          ? "success"
                          : bestComparisonReview.codexReview?.appliedNewsDigest?.signal === "negative"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      {bestComparisonReview.codexReview?.appliedNewsDigest?.signal
                        ? newsSignalLabel(bestComparisonReview.codexReview.appliedNewsDigest.signal)
                        : "Mixed"}
                    </Badge>
                    <Badge variant="outline">Fit {bestComparisonReview.rankScore.toFixed(2)}/5</Badge>
                  </div>
                ) : null}
              </div>
              {bestComparisonReview ? (
                <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                    <span>Fit scale</span>
                    <span>High confidence starts at +2.0</span>
                  </div>
                  <div className="relative mt-2">
                    <div className="h-2 overflow-hidden rounded-full bg-emerald-950/30">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-lime-400 to-emerald-300 transition-[width] duration-300"
                        style={{ width: `${comparisonScoreToPercent(bestComparisonReview.rankScore)}%` }}
                      />
                    </div>
                    <div
                      className="absolute top-1/2 h-4 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${comparisonScoreToPercent(COMPARISON_HIGH_CONFIDENCE_THRESHOLD)}%` }}
                    >
                      <div className="h-4 w-0.5 rounded-full bg-white/90 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]" />
                      <div className="absolute left-1/2 top-[-0.3rem] h-2 w-2 -translate-x-1/2 rounded-full border border-white/80 bg-emerald-400 shadow-sm" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>-5 weaker</span>
                    <span>0 neutral</span>
                    <span>+5 stronger</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground/90">
                    The score is a signed 5-point fit score from -5 to 5, with 0 treated as
                    neutral. It starts from the review digest score, then adds boosts for signal,
                    confidence, and the suggested tilt before a soft calibration curve turns it
                    into a readable human score.
                  </p>
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {comparisonReviews.map((item) => {
                const digest = item.codexReview?.appliedNewsDigest;
                return (
                  <div className="rounded-lg border bg-background p-4" key={item.symbol}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">{item.symbol}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.status === "loaded"
                            ? `Loaded ${item.generatedAt ? formatDisplayDate(item.generatedAt.slice(0, 10)) : "review"}`
                            : item.status === "prepared"
                              ? "Bundle ready, not published yet"
                              : item.status === "missing"
                                ? "No bundle found yet"
                                : item.error ?? "Could not load review"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={digest?.signal === "positive" ? "success" : digest?.signal === "negative" ? "warning" : "secondary"}>
                          {digest?.signal ? newsSignalLabel(digest.signal) : item.status === "prepared" ? "Ready" : "Pending"}
                        </Badge>
                        <Badge variant="outline">
                          {item.status === "prepared" && !digest ? "Bundle ready" : `Fit ${item.rankScore.toFixed(2)}/5`}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm">
                      <DetailRow
                        label="Confidence"
                        value={
                          digest?.confidence
                            ? `${digest.confidence} confidence`
                            : item.status === "prepared"
                              ? "Pending publish"
                              : "Pending"
                        }
                        note="Higher confidence means the source quality and evidence strength were better, not that the headline was louder."
                      />
                      <DetailRow
                        label="Signal mix"
                        value={
                          digest
                            ? `${digest.positiveArticleCount ?? 0} / ${digest.negativeArticleCount ?? 0} / ${digest.neutralArticleCount ?? 0}`
                            : item.status === "prepared"
                              ? "Pending publish"
                              : "Pending"
                        }
                        note="Counts positive, negative, and neutral items after duplicate and stale-noise filtering."
                      />
                      <DetailRow
                        label="Material items"
                        value={
                          digest?.materialArticleCount !== undefined
                            ? String(digest.materialArticleCount)
                            : item.status === "prepared"
                            ? "Pending publish"
                            : "Pending"
                        }
                        note="Material items are the ones that can change revenue, margins, regulation, or product competitiveness."
                      />
                      <DetailRow
                        label="Suggested tilt"
                        value={
                          item.codexReview?.suggestedGuideImpact?.depositSuggestion ??
                          (item.status === "prepared" ? "Review Latest" : "Prepare bundle")
                        }
                        note="This is the final lean after signal, confidence, and guardrail limits are blended."
                      />
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {item.codexReview?.suggestedGuideImpact?.rationale ??
                        item.codexReview?.rationale ??
                        "No review rationale saved yet."}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Higher scores mean the review is pointing more toward the A$600 budget. If the
              review is missing, publish it first and the panel will rank it automatically.
            </p>
          </CardContent>
        </Card>

        {settings.studyLoanEnabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GraduationCap className="h-5 w-5 text-primary" />
                Debt vs rebuild
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="max-w-3xl text-sm text-muted-foreground">
                This compares two paths: cashing out AAPL to clear the school repayment and
                rebuild, versus keeping the original AAPL position while the school debt is paid
                down from income.
              </p>
              <SchoolMonthSummary
                decision={currentMonthSchoolDecision}
                formatAud={displayAudValue}
              />
              <div className="grid gap-3 md:grid-cols-2">
                <PlainMetric
                  label="Projected paid-off range"
                  value={schoolPayoffRange}
                  note={`Indexation range ${studyLoanProjectionRange.lowRatePercent.toFixed(1)}% to ${studyLoanProjectionRange.highRatePercent.toFixed(1)}%.`}
                  tip="This is not one exact date. It is a safe range because the debt can be indexed each June, and future indexation is only an estimate."
                />
                <PlainMetric
                  label="Freed repayment into AAPL"
                  value={displayAudValue(freedRepaymentValue.futureValueAud)}
                  note={`${displayAudValue(freedRepaymentAud)}/month redirected in the model.`}
                  tip="If clearing the school debt stops the monthly repayment, this estimates what that freed-up money could become if it goes into AAPL instead."
                />
              </div>
              <DetailsPanel
                title="School-decision break-even graph"
                description={
                  schoolDecisionCrossDate
                    ? `The debt-adjusted paths break even around ${formatDisplayDate(schoolDecisionCrossDate)} in this model.`
                    : "The debt-adjusted rebuild path does not catch the keep-AAPL path in this model window."
                }
              >
                <div className="space-y-4">
                  <SchoolDecisionChart data={schoolDecisionTimeline} />
                  <p className="text-sm text-muted-foreground">
                    Estimate uses a cash-flow-adjusted AAPL opportunity gap, a 6.0% annual
                    AAPL growth assumption, current AUD/USD conversion, and the school-debt
                    repayment and indexation settings saved in this tracker.
                  </p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <PlainMetric
                      label="Keep AAPL line"
                      value={displayAudValue(schoolDecisionTimeline.at(-1)?.keepAaplNetAud ?? 0)}
                      note="AAPL value after the monthly school repayment."
                      tip="This line assumes you kept the original AAPL position and continued paying the school debt from income. It does not subtract the full loan principal from the AAPL value."
                    />
                    <PlainMetric
                      label="Pay off + rebuild line"
                      value={displayAudValue(schoolDecisionTimeline.at(-1)?.cashOutRebuildNetAud ?? 0)}
                      note={`${displayAudValue(schoolDecisionMonthlyDepositAud)}/month into AAPL in the model.`}
                      tip="This line assumes the payoff is applied first, then monthly AAPL deposits rebuild from your current logged value."
                    />
                    <PlainMetric
                      label="School-decision break-even"
                      value={schoolDecisionCrossDate ? formatDisplayDate(schoolDecisionCrossDate) : "Not shown"}
                      note="Debt-adjusted date, not the AAPL-only catch-up date."
                      tip="This is the first month where the pay-off-and-rebuild line is at or above the keep-AAPL line. It can move a lot if AAPL growth, FX, or contributions change."
                    />
                  </div>
                </div>
              </DetailsPanel>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild variant="outline">
                  <Link href="/projections">
                    Compare scenarios <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/settings">Edit assumptions</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <DetailsPanel
          title="Detailed numbers"
          description="Open this when you want the formula-level breakdown."
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <DetailRow label="Original shares sold" value={formatShares(saleEvent.sharesSold)} />
            <DetailRow label="Sale date" value={formatDisplayDate(saleEvent.saleDate)} />
            <DetailRow label="Equivalent shares today" value={formatShares(metrics.equivalentSharesToday)} />
            <DetailRow label="Had I Held market value" value={displayUsdValue(metrics.hadHeldMarketValueUsd)} />
            <DetailRow label="Had I Held dividends" value={displayUsdValue(metrics.hadHeldDividendCashUsd)} />
            <DetailRow label="Total Had I Held" value={displayUsdValue(metrics.hadHeldTotalValueUsd)} strong />
            <DetailRow label="Rebuild shares" value={formatShares(metrics.currentRebuildShares)} />
            <DetailRow label="Rebuild market value" value={displayUsdValue(metrics.rebuildMarketValueUsd)} />
            <DetailRow label="Rebuild dividends" value={displayUsdValue(metrics.rebuildDividendCashUsd)} />
            <DetailRow label="Cash balance" value={displayUsdValue(metrics.cashBalanceUsd)} />
            <DetailRow label="Total rebuild value" value={displayUsdValue(metrics.rebuildTotalValueUsd)} strong />
            <DetailRow label="AAPL rebuild gap" value={signedDisplayValue(metrics.catchUpGapUsd)} strong />
            <DetailRow label="Deposit progress" value={`${formatPercent(metrics.depositProgressPercent)}%`} />
            <DetailRow label="Portfolio gain" value={displayUsdValue(metrics.portfolioGainUsd)} />
            <DetailRow label="Opportunity cost since sale" value={displayUsdValue(metrics.opportunityCostSinceSaleUsd)} />
            <DetailRow label="Plan target date" value={formatDisplayDate(metrics.planTargetDate)} />
          </div>
        </DetailsPanel>

        <DetailsPanel
          title="Charts"
          description="Useful when you want to inspect the trend rather than the answer."
        >
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartBlock title="Had I Held vs Rebuild Portfolio">
              <ValueLineChart data={series} />
            </ChartBlock>
            <ChartBlock title="Catch-up gap over time">
              <GapAreaChart data={series} />
            </ChartBlock>
            <ChartBlock title="Contributions vs Portfolio Gain">
              <ContributionBarChart
                contributionsUsd={metrics.totalContributionsUsd}
                gainUsd={metrics.portfolioGainUsd}
              />
            </ChartBlock>
            <ChartBlock title="Projection Snapshot">
              <div className="grid gap-3 sm:grid-cols-2">
                <PlainMetric
                  label="4-year catch-up gap"
                  value={fourYearGapText}
                  note={projection4.catchUpDate ? `Catch-up date ${formatDisplayDate(projection4.catchUpDate)}.` : "No catch-up date in this window."}
                />
                <PlainMetric
                  label="5-year catch-up gap"
                  value={fiveYearGapText}
                  note={projection5.catchUpDate ? `Catch-up date ${formatDisplayDate(projection5.catchUpDate)}.` : "No catch-up date in this window."}
                />
              </div>
            </ChartBlock>
          </div>
        </DetailsPanel>

        <DetailsPanel
          title="Market data and assumptions"
          description={`${settings.baseTicker} price is ${quoteLabel}; refresh only when you need a current value.`}
        >
          <div className="space-y-4">
            <MarketDataStatus
              quote={quote}
              priceUsd={currentPriceUsd}
              isRefreshing={isRefreshing}
              warning={warning}
              onRefresh={() => refreshMarketData(true)}
            />
            <MarketCacheDebugger
              isBusy={isClearingMarketCache}
              onClearAndRefresh={clearMarketCacheAndRefresh}
              summary={marketCacheSummary}
              symbol={settings.baseTicker}
            />
            <div className="grid gap-3 md:grid-cols-3">
              <Factor
                icon={<CircleDollarSign className="h-4 w-4" />}
                text="The selected ticker trades in USD, so the main comparison stays USD-based."
              />
              <Factor
                icon={<TrendingUp className="h-4 w-4" />}
                text="If the selected ticker rises quickly, the Had I Held benchmark rises too."
              />
              <Factor
                icon={<Wallet className="h-4 w-4" />}
                text="AUD contributions depend on the AUD/USD rate used on each contribution date."
              />
            </div>
          </div>
        </DetailsPanel>
      </div>
    </AppShell>
  );
}

function HeroStat({
  label,
  value,
  note,
  tip,
}: {
  label: string;
  value: string;
  note: string;
  tip?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-[0_10px_30px_rgba(3,7,18,0.12)] backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        {tip ? (
          <InfoTip title={label}>
            <p>{tip}</p>
          </InfoTip>
        ) : null}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function articleMonthKey(article: {
  collectedAt?: string;
  cachedAt?: string;
  publishedAt?: string;
}) {
  return articleReviewTimestamp(article).slice(0, 7);
}

function groupArticlesByDate(articles: CachedNewsArticle[]) {
  const groups = new Map<
    string,
    {
      dateKey: string;
      label: string;
      count: number;
      publishers: Set<string>;
      providers: Set<string>;
    }
  >();

  for (const article of articles) {
    const timestamp = articleDisplayTimestamp(article);
    const dateKey = timestamp ? timestamp.slice(0, 10) : "undated";
    const existing = groups.get(dateKey);
    if (existing) {
      existing.count += 1;
      existing.publishers.add(article.source);
      existing.providers.add(article.provider);
      continue;
    }
    groups.set(dateKey, {
      dateKey,
      label: dateKey === "undated" ? "Undated" : formatDisplayDate(dateKey),
      count: 1,
      publishers: new Set([article.source]),
      providers: new Set([article.provider]),
    });
  }

  return Array.from(groups.values())
    .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
    .map((group) => ({
      dateKey: group.dateKey,
      label: group.label,
      count: group.count,
      publisherCount: group.publishers.size,
      providerCount: group.providers.size,
    }));
}

function summarizeMarketCache({
  symbol,
  dailyPrices,
  quotes,
  includeManual,
}: {
  symbol: string;
  dailyPrices: CachedDailyPrice[];
  quotes: CachedQuote[];
  includeManual: boolean;
}) {
  const normalizedSymbol = symbol.toUpperCase();
  const allSymbolPrices = dailyPrices.filter((price) => price.symbol === normalizedSymbol);
  const usablePrices = allSymbolPrices
    .filter((price) => includeManual || price.provider !== "manual")
    .sort((left, right) => left.date.localeCompare(right.date));
  const latestPrice = usablePrices.at(-1);
  const latestQuote = [...quotes]
    .filter((quote) => quote.symbol === normalizedSymbol)
    .sort((left, right) => (right.asOf || "").localeCompare(left.asOf || ""))[0];
  const providers = Array.from(new Set(usablePrices.map((price) => price.provider))).sort();

  return {
    allPriceCount: allSymbolPrices.length,
    usablePriceCount: usablePrices.length,
    latestPriceDate: latestPrice?.date,
    latestPriceProvider: latestPrice?.provider,
    latestPriceUsd: latestPrice?.adjustedCloseUsd ?? latestPrice?.closeUsd,
    latestQuoteAsOf: latestQuote?.asOf,
    latestQuoteProvider: latestQuote?.provider,
    providers,
  };
}

function compareArticlesForCodexReview(
  left: { signalScore: number; collectedAt?: string; cachedAt?: string; publishedAt?: string },
  right: { signalScore: number; collectedAt?: string; cachedAt?: string; publishedAt?: string },
) {
  const scoreDiff = Math.abs(right.signalScore) - Math.abs(left.signalScore);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  return articleReviewTimestamp(right).localeCompare(articleReviewTimestamp(left));
}

function articleReviewTimestamp(article: {
  collectedAt?: string;
  cachedAt?: string;
  publishedAt?: string;
}) {
  return article.cachedAt || article.collectedAt || article.publishedAt || "";
}

function articleDisplayTimestamp(article: {
  collectedAt?: string;
  cachedAt?: string;
  publishedAt?: string;
}) {
  return article.publishedAt || article.collectedAt || article.cachedAt || "";
}

function buildGuideReviewSummary({
  reviewSymbol,
  digest,
  codexReview,
  guide,
  bestComparisonReview,
}: {
  reviewSymbol: string;
  digest: DepositGuideNewsInput;
  codexReview?: CodexReviewDetails;
  guide: ReturnType<typeof calculateDepositGuide>;
  bestComparisonReview?: { symbol: string; rankScore: number };
}) {
  const thesisSignals = codexReview?.longTermThesisSignals ?? [];
  const positiveItems = thesisSignals
    .filter((signal) => signal.direction === "positive")
    .map(formatThesisSignal)
    .slice(0, 2);
  const negativeItems = thesisSignals
    .filter((signal) => signal.direction === "negative")
    .map(formatThesisSignal)
    .slice(0, 2);
  const neutralItems = [
    ...thesisSignals
      .filter((signal) => signal.direction !== "positive" && signal.direction !== "negative")
      .map(formatThesisSignal),
    ...(codexReview?.staleOrNoisyItems ?? []).map((item) => item.reason).filter(isPresent),
  ].slice(0, 3);

  const scoreItems = [
    bestComparisonReview
      ? `${reviewSymbol} is the active comparison ticket at ${bestComparisonReview.rankScore.toFixed(
          2,
        )}/5 fit score. In the signed 5-point framing, 0 is neutral, higher is a stronger fit, and lower is weaker. The green bar marks the start of the strong-positive band at +2.0.`
      : `Guide score ${guide.signalScore.toFixed(
          2,
        )} is an internal tilt score, not a percent. In the 10-point framing, 5.0 is neutral, higher leans into a bigger monthly deposit, and lower leans into a lighter month. This score produced ${formatSignedPercent(
          guide.adjustmentPercent,
        )} vs the neutral plan and a target of ${formatCurrency(guide.recommendedDepositAud, "AUD")}.`,
    bestComparisonReview
      ? `${reviewSymbol} is the selected ticket for the main guide right now at ${bestComparisonReview.rankScore.toFixed(
          2,
        )}/5, so the main guide uses that cross-stock read rather than leaning on a single headline.`
      : undefined,
    codexReview?.suggestedGuideImpact?.rationale ?? codexReview?.rationale,
  ].filter(isPresent);

  return [
    {
      label: `Positives (${digest.positiveArticleCount ?? 0})`,
      className: "text-emerald-700 dark:text-emerald-300",
      items:
        positiveItems.length > 0
          ? positiveItems
          : [`${digest.positiveArticleCount ?? 0} positive article signals were counted.`],
    },
    {
      label: `Negatives (${digest.negativeArticleCount ?? 0})`,
      className: "text-destructive",
      items:
        negativeItems.length > 0
          ? negativeItems
          : [`${digest.negativeArticleCount ?? 0} negative article signals were counted.`],
    },
    {
      label: `Neutral / Mixed (${digest.neutralArticleCount ?? 0})`,
      className: "text-muted-foreground",
      items:
        neutralItems.length > 0
          ? neutralItems
          : [`${digest.neutralArticleCount ?? 0} neutral article signals were counted.`],
    },
    {
      label: "Why This Guide",
      className: "text-primary",
      items:
        scoreItems.length > 0
          ? scoreItems
          : guide.reasons.slice(0, 2),
    },
  ];
}

function formatThesisSignal(signal: CodexReviewTheme) {
  const materiality = signal.materiality ? `${signal.materiality} impact` : "reviewed";
  return `${signal.theme ?? "Reviewed theme"} (${materiality}): ${
    signal.judgement ?? "No extra judgement was saved for this theme."
  }`;
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function reviewerDraftStorageKey(symbol: string) {
  return `codex-reviewer-draft:${symbol.toUpperCase()}`;
}

function selectedComparisonSymbolStorageKey() {
  return "codex-comparison-ticket";
}

function compareReviewExpectedAdjustmentPercent(
  review?:
    | {
        rankScore: number;
        codexReview?: {
          suggestedGuideImpact?: {
            expectedAdjustmentPercent?: number;
          };
        };
      }
    | undefined,
) {
  if (typeof review?.rankScore === "number" && Number.isFinite(review.rankScore)) {
    return Math.min(20, Math.max(-20, Math.round(review.rankScore * 4)));
  }
  const explicit = review?.codexReview?.suggestedGuideImpact?.expectedAdjustmentPercent;
  if (typeof explicit === "number") {
    return Math.min(20, Math.max(-20, explicit));
  }
  return undefined;
}

function loadSelectedComparisonSymbol() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const value = window.localStorage.getItem(selectedComparisonSymbolStorageKey());
    return value?.toUpperCase() || undefined;
  } catch {
    return undefined;
  }
}

function persistSelectedComparisonSymbol(symbol?: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (symbol) {
      window.localStorage.setItem(selectedComparisonSymbolStorageKey(), symbol.toUpperCase());
    } else {
      window.localStorage.removeItem(selectedComparisonSymbolStorageKey());
    }
  } catch {
    // Best effort only.
  }
}

function createReviewerDraft(symbol: string): ReviewerDraft {
  const profile = getCompanyReviewProfile(symbol);
  return {
    role: "Thesis Impact Analyst",
    mandate:
      "Review each article like a senior fundamental equity analyst deciding whether the news meaningfully changes an investment thesis.",
    posture: "Skeptical, evidence-weighted, and conservative about turning headlines into material signals.",
    companyName: profile.companyName,
    sector: profile.sector,
    thesisDrivers: profile.thesisDrivers.join("\n"),
    keyRisks: profile.keyRisks.join("\n"),
    materialityKeywords: profile.materialityKeywords.join("\n"),
  };
}

function loadReviewerDraft(symbol: string): ReviewerDraft {
  const fallback = createReviewerDraft(symbol);
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(reviewerDraftStorageKey(symbol));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<ReviewerDraft>;
    return {
      role: typeof parsed.role === "string" ? parsed.role : fallback.role,
      mandate: typeof parsed.mandate === "string" ? parsed.mandate : fallback.mandate,
      posture: typeof parsed.posture === "string" ? parsed.posture : fallback.posture,
      companyName: typeof parsed.companyName === "string" ? parsed.companyName : fallback.companyName,
      sector: typeof parsed.sector === "string" ? parsed.sector : fallback.sector,
      thesisDrivers:
        typeof parsed.thesisDrivers === "string" ? parsed.thesisDrivers : fallback.thesisDrivers,
      keyRisks: typeof parsed.keyRisks === "string" ? parsed.keyRisks : fallback.keyRisks,
      materialityKeywords:
        typeof parsed.materialityKeywords === "string"
          ? parsed.materialityKeywords
          : fallback.materialityKeywords,
    };
  } catch {
    return fallback;
  }
}

function persistReviewerDraft(symbol: string, reviewerDraft: ReviewerDraft) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(reviewerDraftStorageKey(symbol), JSON.stringify(reviewerDraft));
  } catch {
    // Ignore storage failures so review prep still works.
  }
}

function reviewerDraftToContext(reviewerDraft: ReviewerDraft): ReviewerContextOverride {
  return {
    role: reviewerDraft.role.trim(),
    mandate: reviewerDraft.mandate.trim(),
    posture: reviewerDraft.posture.trim(),
    companyContext: {
      companyName: reviewerDraft.companyName.trim(),
      sector: reviewerDraft.sector.trim(),
      thesisDrivers: splitReviewerLines(reviewerDraft.thesisDrivers),
      keyRisks: splitReviewerLines(reviewerDraft.keyRisks),
      materialityKeywords: splitReviewerLines(reviewerDraft.materialityKeywords),
    },
  };
}

function splitReviewerLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function guideLabel(direction: "increase" | "hold" | "decrease") {
  if (direction === "increase") {
    return "Lean higher";
  }
  if (direction === "decrease") {
    return "Lean lower";
  }
  return "Keep steady";
}

function newsSignalLabel(signal: "positive" | "neutral" | "negative") {
  if (signal === "positive") {
    return "Positive";
  }
  if (signal === "negative") {
    return "Negative";
  }
  return "Neutral";
}

function newsArticleLabel(analysisMode: DepositGuideNewsInput["analysisMode"]) {
  if (analysisMode === "aiArticleAnalysis") {
    return "AI-analyzed article";
  }
  if (analysisMode === "codexReview") {
    return "Codex-reviewed article";
  }
  return "recent headline";
}

function newsPublisherText(digest: DepositGuideNewsInput) {
  const count = digest.publisherCount ?? digest.providerCount;
  if (count <= 0) {
    return "no publishers";
  }
  if (count === 1) {
    return "1 publisher";
  }
  return `${count} publishers`;
}

function formatSignedPercent(value: number) {
  if (Math.abs(value) < 0.01) {
    return "0.00%";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function calculateCurrentMonthContributionAud(
  contributions: Array<{ date: string; currencyEntered: string; amount: number; amountUsd: number }>,
  asOfDate: string,
  latestUsdToAudRate: number,
) {
  const month = asOfDate.slice(0, 7);
  return roundMoney(
    contributions
      .filter((contribution) => contribution.date.slice(0, 7) === month)
      .reduce((total, contribution) => {
        if (contribution.currencyEntered === "AUD") {
          return total + contribution.amount;
        }
        return total + contribution.amountUsd * latestUsdToAudRate;
      }, 0),
  );
}

function ReviewerCharterEditor({
  symbol,
  version,
  defaultOpen = false,
  onDraftChange,
}: {
  symbol: string;
  version: string;
  defaultOpen?: boolean;
  onDraftChange: (draft: ReviewerDraft) => void;
}) {
  const [draft, setDraft] = useState(() => loadReviewerDraft(symbol));

  useEffect(() => {
    persistReviewerDraft(symbol, draft);
    onDraftChange(draft);
  }, [draft, onDraftChange, symbol]);

  return (
    <details className="mt-4 rounded-lg border bg-muted/20 p-4" open={defaultOpen}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium">Reviewer charter</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Collapsed by default unless you turn it on in Settings. This draft is injected into
              every review bundle for {symbol} and saved locally in this browser.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{draft.role || "Thesis Impact Analyst"}</Badge>
            <Badge variant="outline">v{version}</Badge>
          </div>
        </div>
      </summary>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Role">
          <Input value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} />
        </Field>
        <Field label="Posture">
          <Input
            value={draft.posture}
            onChange={(event) => setDraft((current) => ({ ...current, posture: event.target.value }))}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Mandate">
            <Textarea
              className="min-h-24"
              value={draft.mandate}
              onChange={(event) => setDraft((current) => ({ ...current, mandate: event.target.value }))}
            />
          </Field>
        </div>
        <Field label="Company name">
          <Input
            value={draft.companyName}
            onChange={(event) => setDraft((current) => ({ ...current, companyName: event.target.value }))}
          />
        </Field>
        <Field label="Sector">
          <Input
            value={draft.sector}
            onChange={(event) => setDraft((current) => ({ ...current, sector: event.target.value }))}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Thesis drivers">
            <Textarea
              className="min-h-24"
              value={draft.thesisDrivers}
              onChange={(event) =>
                setDraft((current) => ({ ...current, thesisDrivers: event.target.value }))
              }
              placeholder="One driver per line"
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Key risks">
            <Textarea
              className="min-h-24"
              value={draft.keyRisks}
              onChange={(event) => setDraft((current) => ({ ...current, keyRisks: event.target.value }))}
              placeholder="One risk per line"
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Materiality keywords">
            <Textarea
              className="min-h-24"
              value={draft.materialityKeywords}
              onChange={(event) =>
                setDraft((current) => ({ ...current, materialityKeywords: event.target.value }))
              }
              placeholder="One keyword per line"
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => setDraft(createReviewerDraft(symbol))} size="sm" variant="outline">
          Reset to stock profile
        </Button>
      </div>
    </details>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function AttentionItem({
  icon,
  title,
  text,
  tone,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  tone: "ok" | "action";
}) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border/70 bg-card/70 p-3 shadow-[0_10px_30px_rgba(3,7,18,0.18)] backdrop-blur-sm">
      <div
        className={cn(
          "mt-0.5 rounded-xl p-2",
          tone === "ok"
            ? "bg-accent text-accent-foreground"
            : "bg-[#fff3cf] text-[#765100] dark:bg-[#4b390d] dark:text-[#ffe49c]",
        )}
      >
        {tone === "ok" ? <CheckCircle2 className="h-4 w-4" /> : icon}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function SummaryTile({
  icon,
  title,
  value,
  description,
  rows,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  description: string;
  rows: Array<[string, string]>;
}) {
  return (
    <Card>
      <CardContent className="relative p-5">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-primary/70 via-cyan-400/70 to-transparent" />
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-primary/12 p-2.5 text-primary ring-1 ring-primary/15">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="mt-2 text-[2rem] font-semibold tracking-tight leading-none">{value}</p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="mt-5 grid gap-2 border-t border-border/60 pt-4">
          {rows.map(([label, rowValue]) => (
            <div
              key={label}
              className="flex items-start justify-between gap-3 rounded-xl bg-background/45 px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="text-right font-medium">{rowValue}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function PlainMetric({
  label,
  value,
  note,
  tip,
}: {
  label: string;
  value: string;
  note?: string;
  tip?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-[0_10px_30px_rgba(3,7,18,0.15)] backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        {tip ? (
          <InfoTip title={label}>
            <p>{tip}</p>
          </InfoTip>
        ) : null}
      </div>
      <p className="mt-1 text-xl font-semibold tracking-tight">{value}</p>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function MarketCacheDebugger({
  symbol,
  summary,
  isBusy,
  onClearAndRefresh,
}: {
  symbol: string;
  summary: ReturnType<typeof summarizeMarketCache>;
  isBusy: boolean;
  onClearAndRefresh: () => void;
}) {
  const hasEnoughHistory = summary.usablePriceCount >= 7;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-[0_10px_30px_rgba(3,7,18,0.15)] backdrop-blur-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-medium">Market cache debugger</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Shows the price-history cache used by the deposit guide in this browser.
          </p>
        </div>
        <Button
          disabled={isBusy}
          onClick={onClearAndRefresh}
          size="sm"
          variant="outline"
        >
          <RefreshCw className={cn("h-4 w-4", isBusy && "animate-spin")} />
          Clear and refresh market cache
        </Button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <CacheDebugStat
          label="Usable price points"
          note={
            hasEnoughHistory
              ? `${summary.allPriceCount} total cached ${symbol} price rows.`
              : `Needs at least 7; ${summary.allPriceCount} total cached ${symbol} price rows.`
          }
          value={String(summary.usablePriceCount)}
        />
        <CacheDebugStat
          label="Latest price row"
          note={
            summary.latestPriceProvider
              ? `${summary.latestPriceProvider}, ${formatCurrency(summary.latestPriceUsd ?? 0, "USD")}`
              : "No cached price-history row found."
          }
          value={summary.latestPriceDate ? formatDisplayDate(summary.latestPriceDate) : "None"}
        />
        <CacheDebugStat
          label="Price providers"
          note={
            summary.latestQuoteProvider
              ? `Latest quote: ${summary.latestQuoteProvider}`
              : "No cached quote found."
          }
          value={summary.providers.length > 0 ? summary.providers.join(", ") : "None"}
        />
      </div>
    </div>
  );
}

function CacheDebugStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-base font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function SchoolMonthSummary({
  decision,
  formatAud,
}: {
  decision: CurrentMonthSchoolDecision;
  formatAud: (value: number) => string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 p-4 shadow-[0_10px_30px_rgba(3,7,18,0.15)] backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Debt decision</p>
          <p className="mt-1 text-sm text-muted-foreground">This is a net-worth check for today.</p>
        </div>
        <InfoTip title="Debt decision">
          <p>
            In plain terms: keep AAPL counts the old AAPL holding value, then
            subtracts this month&apos;s school repayment. Pay off and rebuild counts
            the rebuilt AAPL value plus this month&apos;s top-up, then subtracts any
            school debt still left after the payoff assumption.
          </p>
        </InfoTip>
      </div>
      <SchoolVerdictCard decision={decision} formatAud={formatAud} />
    </div>
  );
}

function SchoolVerdictCard({
  decision,
  formatAud,
}: {
  decision: CurrentMonthSchoolDecision;
  formatAud: (value: number) => string;
}) {
  const isCashOut = decision.verdict === "cashOut";
  const isKeepAapl = decision.verdict === "keepAapl";
  const verdictText = isCashOut
    ? "Pay off debt + rebuild AAPL is ahead"
    : isKeepAapl
      ? "Keep AAPL + keep paying debt is ahead"
      : "Both paths are roughly even";
  const reason = isCashOut
    ? `The rebuild path is ahead by ${formatAud(Math.abs(decision.differenceAud))} for this month.`
    : isKeepAapl
      ? `Keeping AAPL is ahead by ${formatAud(Math.abs(decision.differenceAud))} for this month.`
      : `The difference is only ${formatAud(Math.abs(decision.differenceAud))}, so it is too close to call.`;
  const topUpText =
    decision.currentMonthDepositTopUpAud > 0
      ? `${formatAud(decision.currentMonthDepositTopUpAud)} still to log to reach this month's guide.`
      : "This month's guided deposit is already logged.";

  return (
    <div
      className={cn(
        "rounded-[1.5rem] border p-4 shadow-[0_14px_40px_rgba(3,7,18,0.2)]",
        isCashOut && "border-accent bg-accent/35",
        isKeepAapl && "border-[#f4cf76] bg-[#fff8e7] dark:bg-[#33280f]",
      )}
    >
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          {formatDisplayDate(decision.date)}
        </p>
        <p className="mt-1 text-xl font-semibold">{verdictText}</p>
        <p className="mt-2 text-sm text-muted-foreground">{reason}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {topUpText} This view is cash-flow-adjusted, so the keep-AAPL path is
          reduced by the monthly school repayment while the rebuild path reflects
          the payoff assumption.
        </p>
      </div>
      <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
        <PathBreakdown
          title="Keep AAPL + pay debt"
          value={formatAud(decision.keepAaplNetAud)}
          lines={[
            `Starting AAPL value: ${formatAud(decision.keepAaplStartingValueAud)}`,
            `AAPL movement since sale: ${formatAud(decision.keepAaplMovementAud)}`,
            `AAPL value now: ${formatAud(decision.keepAaplValueAud)}`,
            `Monthly debt repayment: -${formatAud(decision.monthlyEducationRepaymentAud)}`,
            `School debt after this payment: ${formatAud(decision.keepAaplDebtAud)}`,
          ]}
          tip="This answers: if you still had the old AAPL holding today, what would it look like after the current month's school repayment cash flow?"
        />
        <PathBreakdown
          title="Pay off + rebuild"
          value={formatAud(decision.cashOutRebuildNetAud)}
          lines={[
            `Guided deposit: ${formatAud(decision.aaplDepositAud)}`,
            `Still to log this month: ${formatAud(decision.currentMonthDepositTopUpAud)}`,
            `Logged AAPL value: ${formatAud(decision.rebuildAssetValueAud)}`,
            `Remaining debt after payoff: -${formatAud(decision.debtAfterPayoffAud)}`,
            `Rebuild movement so far: ${formatAud(decision.rebuildMovementAud)}`,
          ]}
          tip="This answers: after applying the payoff assumption, what is your rebuilt AAPL position worth after including this month's guided deposit and any remaining school debt?"
        />
      </div>
    </div>
  );
}

function PathBreakdown({
  title,
  value,
  lines,
  tip,
}: {
  title: string;
  value: string;
  lines: string[];
  tip: string;
}) {
  return (
    <div className="rounded-md border bg-background/80 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground">{title}</p>
        <InfoTip title={title}>
          <p>{tip}</p>
        </InfoTip>
      </div>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </div>
  );
}

function DetailsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [shouldRenderContent, setShouldRenderContent] = useState(false);
  const renderFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (renderFrameRef.current !== null) {
        window.cancelAnimationFrame(renderFrameRef.current);
      }
    };
  }, []);

  return (
    <details
      className="group rounded-[1.5rem] border border-border/70 bg-card/75 text-card-foreground shadow-[0_14px_40px_rgba(3,7,18,0.18)] backdrop-blur-xl"
      onToggle={(event) => {
        if (renderFrameRef.current !== null) {
          window.cancelAnimationFrame(renderFrameRef.current);
          renderFrameRef.current = null;
        }

        if (!event.currentTarget.open) {
          setShouldRenderContent(false);
          return;
        }

        renderFrameRef.current = window.requestAnimationFrame(() => {
          renderFrameRef.current = null;
          setShouldRenderContent(true);
        });
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5">
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      {shouldRenderContent ? <div className="border-t border-border/60 p-5">{children}</div> : null}
    </details>
  );
}

function DetailRow({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-background/50 px-3 py-2">
      <div className="min-w-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <span className={cn("shrink-0 text-right text-sm font-medium", strong && "font-semibold")}>
        {value}
      </span>
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-[0_10px_30px_rgba(3,7,18,0.14)] backdrop-blur-sm">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function Factor({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border/70 bg-card/65 p-3 shadow-[0_10px_30px_rgba(3,7,18,0.12)] backdrop-blur-sm">
      <div className="mt-0.5 text-primary">{icon}</div>
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
    </div>
  );
}
