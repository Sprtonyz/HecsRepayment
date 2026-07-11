"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  CircleDollarSign,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Target,
  Wallet,
} from "lucide-react";
import { format } from "date-fns";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { calculateCatchUpMetrics } from "@/lib/domain/calculations";
import { calculateDepositGuide } from "@/lib/domain/depositGuide";
import { todayIso, targetEndDate } from "@/lib/domain/dates";
import { calculatePortfolioScenarioComparison } from "@/lib/domain/portfolioScenario";
import { formatCurrencyCode, formatShares, roundMoney } from "@/lib/domain/money";
import { scoreCodexReviewForComparison } from "@/lib/news/codexReviewRanking";
import type { ComparisonReviewSeed } from "@/lib/news/codexReviewLookup";
import { useTrackerData } from "@/lib/storage/useTrackerData";
import { cn } from "@/lib/utils";

type TrackerDataOptions = NonNullable<Parameters<typeof useTrackerData>[0]>;
const COMPARISON_SYMBOLS = ["AAPL", "NVDA", "AMZN", "TSLA", "SPCX"] as const;

function sortComparisonReviews<T extends { rankScore: number }>(reviews: T[]) {
  return [...reviews].sort((left, right) => right.rankScore - left.rankScore);
}

function getEarliestLoggedMonthKey(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
) {
  const dates = [...contributions.map((item) => item.date), ...trades.map((item) => item.date)]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return dates[0]?.slice(0, 7);
}

type ComparisonReviewCard = {
  symbol: string;
  reviewMonth: string;
  status: "loaded" | "prepared" | "missing" | "error";
  generatedAt?: string;
  rankScore: number;
  codexReview?: {
    appliedNewsDigest?: {
      signal?: "positive" | "neutral" | "negative";
      confidence?: "low" | "medium" | "high";
      positiveArticleCount?: number;
      negativeArticleCount?: number;
      neutralArticleCount?: number;
      materialArticleCount?: number;
    };
    suggestedGuideImpact?: {
      rationale?: string;
      depositSuggestion?: string;
      newsSignal?: string;
    };
    rationale?: string;
  };
  error?: string;
};

type AutomatedDailyBrief = {
  symbol: string;
  asOf?: string;
  automated: boolean;
  article?: {
    title: string;
    source?: string;
    url?: string;
    publishedAt?: string;
    raw?: {
      retrievalStatus?: string;
      qualityScore?: number;
      companyFocusScore?: number;
      sourceTier?: string;
      materiality?: string;
      evidencePolicyVersion?: string;
    };
  };
  error?: string;
};

export function DashboardOverview({
  initialTrackerSnapshot,
  initialTrackerSyncState,
  initialDisplayCurrency,
  initialComparisonReviews,
  initialComparisonLoading,
}: {
  initialTrackerSnapshot?: TrackerDataOptions["initialSnapshot"];
  initialTrackerSyncState?: TrackerDataOptions["initialSyncState"];
  initialDisplayCurrency?: TrackerDataOptions["initialDisplayCurrency"];
  initialComparisonReviews?: ComparisonReviewSeed[];
  initialComparisonLoading?: boolean;
}) {
  const tracker = useTrackerData({
    initialSnapshot: initialTrackerSnapshot,
    initialSyncState: initialTrackerSyncState,
    initialDisplayCurrency,
  });
  const searchParams = useSearchParams();
  const {
    snapshot,
    settings,
    saleEvent,
    currentPriceUsd,
    latestUsdToAudRate,
    latestAudToUsdRate,
    isLoading,
    isRefreshing,
  } = tracker;

  const asOfDate = todayIso();

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
        asOfDate,
      }),
    [
      asOfDate,
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

  const depositGuide = useMemo(
    () =>
      calculateDepositGuide({
        planMonthlyContributionAud: settings.planMonthlyContributionAud,
        contributions: snapshot.contributions,
        dailyPrices: snapshot.dailyPrices,
        currentPriceUsd,
        latestUsdToAudRate,
        asOfDate,
        planStartDate: settings.planStartDate,
      }),
    [
      asOfDate,
      currentPriceUsd,
      latestUsdToAudRate,
      settings.planMonthlyContributionAud,
      settings.planStartDate,
      snapshot.contributions,
      snapshot.dailyPrices,
    ],
  );
  const portfolioScenarioComparison = useMemo(
    () =>
      calculatePortfolioScenarioComparison({
        benchmarkTicker: settings.baseTicker,
        benchmarkShares: metrics.equivalentSharesToday,
        trades: snapshot.trades,
        dailyPrices: snapshot.dailyPrices,
        quotes: snapshot.quotes,
        splits: settings.includeSplits ? snapshot.splits : [],
        benchmarkCurrentPriceUsd: currentPriceUsd,
        asOfDate,
        anchorDate: settings.planStartDate,
        projectionMonths: 53,
        portfolioContributionAud: settings.planMonthlyContributionAud,
        audUsdRate: latestAudToUsdRate,
        benchmarkTolerancePercent: 1,
      }),
    [
      asOfDate,
      currentPriceUsd,
      latestAudToUsdRate,
      metrics.equivalentSharesToday,
      settings.baseTicker,
      settings.includeSplits,
      settings.planMonthlyContributionAud,
      snapshot.dailyPrices,
      snapshot.splits,
      snapshot.trades,
    ],
  );
  const currentMonthLoggedAud = useMemo(
    () => {
      const currentMonth = calculateCurrentMonthLoggedAud(
        snapshot.contributions,
        snapshot.trades,
        asOfDate,
        latestUsdToAudRate,
      );
      if (currentMonth > 0) {
        return currentMonth;
      }
      const latestActivityMonth = getLatestLoggedMonthKey(snapshot.contributions, snapshot.trades);
      return latestActivityMonth
        ? calculateLoggedTransactionsAud(
            snapshot.contributions,
            snapshot.trades,
            latestActivityMonth,
            latestUsdToAudRate,
          )
        : 0;
    },
    [asOfDate, latestUsdToAudRate, snapshot.contributions, snapshot.trades],
  );
  const differencePreviewOverride = searchParams.get("differencePreview");
  const differenceTone =
    differencePreviewOverride === "positive"
      ? "positive"
      : differencePreviewOverride === "negative"
        ? "negative"
        : portfolioScenarioComparison.projectedDifferenceUsd >= 0
          ? "positive"
          : "negative";

  const progressPercent =
    settings.planMonthlyContributionAud > 0
      ? Math.min(100, (currentMonthLoggedAud / settings.planMonthlyContributionAud) * 100)
      : 0;

  const currency = settings.displayCurrency;
  const convert = (amountAud: number) =>
    currency === "USD" ? amountAud * latestAudToUsdRate : amountAud;

  const formatMoney = (amountAud: number, digits = 0) => {
    const amount = convert(amountAud);
    const intlCurrency = currency === "USD" ? "USD" : "AUD";
    return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-AU", {
      style: "currency",
      currency: intlCurrency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  };
  const formatScenarioMoney = (amountUsd: number, digits = 0) =>
    currency === "USD"
      ? formatCurrencyCode(amountUsd, "USD", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : formatCurrencyCode(amountUsd * latestUsdToAudRate, "AUD", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });

  const newPortfolioValueUsd = useMemo(
    () =>
      roundMoney(
        portfolioScenarioComparison.holdings.reduce(
          (total, holding) => total + holding.currentValueUsd,
          0,
        ),
      ),
    [portfolioScenarioComparison.holdings],
  );
  const newPortfolioValue = formatScenarioMoney(newPortfolioValueUsd, 0);
  const newPortfolioSummary = `Your current portfolio is worth ${newPortfolioValue}, based on the live value of the holdings you currently hold.`;
  const gapRemainingAud = Math.max(0, settings.planMonthlyContributionAud - currentMonthLoggedAud);
  const catchUpLabel = metrics.catchUpGapAud >= 0 ? "Gap remaining" : "Ahead of plan";
  const catchUpValue = formatMoney(Math.abs(metrics.catchUpGapAud));
  const monthAhead = currentMonthLoggedAud >= settings.planMonthlyContributionAud;
  const monthValueLabel = monthAhead ? "ahead" : "short";
  const activityStartDate =
    getEarliestLoggedMonthKey(snapshot.contributions, snapshot.trades) ||
    settings.planStartDate;
  const recentBars = useMemo(
    () =>
      buildRecentContributionBars(
        snapshot.contributions,
        snapshot.trades,
        activityStartDate,
        targetEndDate(settings.planStartDate, settings.planYears),
        latestUsdToAudRate,
      ),
    [
      activityStartDate,
      latestUsdToAudRate,
      settings.planStartDate,
      settings.planYears,
      snapshot.contributions,
      snapshot.trades,
    ],
  );
  const defaultRecentBarIndex = useMemo(() => {
    if (recentBars.length === 0) {
      return 0;
    }
    for (let index = recentBars.length - 1; index >= 0; index -= 1) {
      if (recentBars[index]?.valueAud > 0) {
        return index;
      }
    }
    return 0;
  }, [recentBars]);
  const [selectedRecentBarIndex, setSelectedRecentBarIndex] = useState<number | null>(null);
  const safeRecentBarIndex =
    recentBars.length > 0
      ? Math.min(selectedRecentBarIndex ?? defaultRecentBarIndex, recentBars.length - 1)
      : 0;
  const selectedRecentBar =
    recentBars[safeRecentBarIndex] ?? recentBars[recentBars.length - 1] ?? null;
  const recentWindowSize = 12;
  const [recentWindowStart, setRecentWindowStart] = useState(0);
  const maxRecentWindowStart = Math.max(0, recentBars.length - recentWindowSize);
  const safeRecentWindowStart = Math.min(recentWindowStart, maxRecentWindowStart);
  const visibleRecentBars = recentBars.slice(safeRecentWindowStart, safeRecentWindowStart + recentWindowSize);
  const visibleWindowEnd = Math.min(safeRecentWindowStart + recentWindowSize, recentBars.length);
  const [isGraphProjectionExpanded, setIsGraphProjectionExpanded] = useState(false);
  const codexReviewMonth = asOfDate.slice(0, 7);
  const [comparisonLoading, setComparisonLoading] = useState(
    initialComparisonLoading ?? Boolean(!initialComparisonReviews),
  );
  const [comparisonError, setComparisonError] = useState<string | undefined>();
  const [comparisonReviews, setComparisonReviews] = useState<ComparisonReviewSeed[]>(() => {
    return sortComparisonReviews(initialComparisonReviews ?? []);
  });
  const [dailyBriefs, setDailyBriefs] = useState<AutomatedDailyBrief[]>([]);
  const [dailyBriefLoading, setDailyBriefLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    Promise.all(
      COMPARISON_SYMBOLS.map(async (symbol) => {
        try {
          const params = new URLSearchParams({
            symbol,
            reviewMonth: codexReviewMonth,
          });
          const response = await fetch(`/api/codex-review-bundle?${params.toString()}`, {
            cache: "no-store",
          });
          if (!response.ok) {
            return {
              symbol,
              reviewMonth: codexReviewMonth,
              status: "missing" as const,
              rankScore: -999,
            };
          }

          const payload = (await response.json()) as {
            filename?: string;
            generatedAt?: string;
            codexReview?: ComparisonReviewCard["codexReview"];
          };
          const review = payload.codexReview ?? undefined;
          return {
            symbol,
            reviewMonth: codexReviewMonth,
            status: review ? "loaded" : "prepared",
            generatedAt: payload.generatedAt,
            codexReview: review,
            rankScore: review
              ? scoreCodexReviewForComparison(
                  review as Parameters<typeof scoreCodexReviewForComparison>[0],
                )
              : 0,
          } satisfies ComparisonReviewCard;
        } catch (error) {
          return {
            symbol,
            reviewMonth: codexReviewMonth,
            status: "error" as const,
            rankScore: -999,
            error: error instanceof Error ? error.message : "Could not load review.",
          } satisfies ComparisonReviewCard;
        }
      }),
    )
      .then((results) => {
        if (!isActive) {
          return;
        }
        setComparisonError(undefined);
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
  }, [codexReviewMonth]);

  useEffect(() => {
    let isActive = true;

    Promise.all(
      COMPARISON_SYMBOLS.map(async (symbol) => {
        try {
          const response = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, {
            cache: "no-store",
          });
          if (!response.ok) {
            return {
              symbol,
              automated: false,
              error: "The latest article could not be loaded.",
            } satisfies AutomatedDailyBrief;
          }

          const payload = (await response.json()) as {
            asOf?: string;
            automated?: boolean;
            articles?: AutomatedDailyBrief["article"][];
          };
          return {
            symbol,
            asOf: payload.asOf,
            automated: Boolean(payload.automated),
            article: payload.articles?.[0],
          } satisfies AutomatedDailyBrief;
        } catch (error) {
          return {
            symbol,
            automated: false,
            error: error instanceof Error ? error.message : "The latest article could not be loaded.",
          } satisfies AutomatedDailyBrief;
        }
      }),
    ).then((results) => {
      if (!isActive) {
        return;
      }
      setDailyBriefs(results);
      setDailyBriefLoading(false);
    });

    return () => {
      isActive = false;
    };
  }, []);

  const loadedComparisonReviews = comparisonReviews.filter((item) => item.status === "loaded");
  const bestComparisonReview = loadedComparisonReviews[0];
  const fetchedComparisonCount = comparisonReviews.filter((item) => item.status !== "missing").length;
  const reviewedComparisonCount = loadedComparisonReviews.length;
  const comparisonSignalLabel = bestComparisonReview?.codexReview?.appliedNewsDigest?.signal
    ? bestComparisonReview.codexReview.appliedNewsDigest.signal
    : "mixed";
  const comparisonLeadingRationale =
    bestComparisonReview?.codexReview?.suggestedGuideImpact?.rationale ??
    bestComparisonReview?.codexReview?.rationale ??
    "Prepare the full comparison bundles to see which ticket is strongest.";
  const dailyCollectedCount = dailyBriefs.filter((item) => item.article).length;
  const dailyAutomatedCount = dailyBriefs.filter((item) => item.automated).length;
  const latestDailyBriefAt = dailyBriefs
    .map((item) => item.asOf)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <AppShell title="Dashboard" subtitle="See your status at a glance. Less jargon, more meaning.">
      <div className="grid gap-4 lg:gap-5">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <Card className="border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.36)]">
            <CardContent className="p-5 sm:p-6 lg:p-7">
              <div className="flex flex-col gap-5">
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-emerald-400">New Portfolio</p>
                  <p className="text-4xl font-semibold tracking-tight text-white sm:text-[3.45rem]">
                    {newPortfolioValue}
                  </p>
                  <p className="max-w-2xl text-sm leading-6 text-slate-300 sm:text-[0.98rem]">
                    {newPortfolioSummary}
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.58fr)]">
                  <div className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.12)]">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold text-white">Monthly pace</p>
                        <p className="mt-2 text-3xl font-semibold tracking-tight text-white">
                          {formatMoney(currentMonthLoggedAud)}
                        </p>
                      </div>
                      <div className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300">
                        {Math.round(progressPercent)}% logged
                      </div>
                    </div>
                    <div className="mt-4">
                      <Progress value={progressPercent} className="h-2.5 bg-white/8" />
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-300">
                      {formatMoney(gapRemainingAud)} remains to hit the monthly target of{" "}
                      {formatMoney(settings.planMonthlyContributionAud)}.
                    </p>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-[#101a32] p-4 shadow-[0_10px_30px_rgba(15,23,42,0.12)]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-emerald-400">On track</p>
                        <p className="mt-2 text-sm leading-6 text-slate-400">Progress</p>
                      </div>
                      <div className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300">
                        {Math.round(progressPercent)}% logged
                      </div>
                    </div>
                    <div className="mt-4">
                      <Progress value={progressPercent} className="h-2.5 bg-white/8" />
                    </div>
                    <div className="mt-4 rounded-[1.3rem] border border-white/10 bg-white/5 p-4">
                      <div className="flex items-start gap-3">
                        <div className="rounded-2xl bg-emerald-500/15 p-2 text-emerald-300">
                          <CheckCircle2 className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-white">
                            {Math.round(progressPercent)}% of the catch-up target is already
                            covered. Only one clear decision remains: keep logging, pause, or review
                            the plan.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.28)]">
            <CardContent className="p-4 sm:p-5">
              <div className="flex h-full flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Graph projection</p>
                    <p className="mt-2 text-sm leading-6 text-slate-400">Portfolio vs benchmark</p>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                  >
                    Updated now
                  </Badge>
                </div>

                <div className="rounded-[1.35rem] border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                      Months 0-53
                    </p>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300">
                      53 months
                    </span>
                  </div>
                  <div className="mt-3">
                    <ComparisonLineGraph
                      benchmarkCurrentValueUsd={portfolioScenarioComparison.benchmarkCurrentValueUsd}
                      benchmarkProjectedValueUsd={portfolioScenarioComparison.benchmarkProjectedValueUsd}
                      portfolioCurrentValueUsd={newPortfolioValueUsd}
                      portfolioProjectedValueUsd={portfolioScenarioComparison.portfolioProjectedValueUsd}
                      months={portfolioScenarioComparison.projectionMonths}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-300">
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-1">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      Portfolio
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-1">
                      <span className="h-2 w-2 rounded-full bg-sky-400" />
                      Benchmark
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="hidden gap-4 md:grid md:grid-cols-3">
          <MiniMetricCard
            color="emerald"
            icon={<Wallet className="h-4 w-4" />}
            label="Logged this month"
            value={formatMoney(currentMonthLoggedAud)}
            note="Matches the plan so far."
          />
          <MiniMetricCard
            color="blue"
            icon={<Target className="h-4 w-4" />}
            label="Target this month"
            value={formatMoney(settings.planMonthlyContributionAud)}
            note="What is still expected."
          />
          <MiniMetricCard
            color="amber"
            icon={<CircleDollarSign className="h-4 w-4" />}
            label="Gap to close"
            value={catchUpValue}
            note={catchUpLabel}
          />
        </section>

        <section className="grid gap-3 md:hidden">
          <details className="rounded-[1.4rem] border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_20px_60px_rgba(2,6,23,0.2)]">
            <summary className="cursor-pointer list-none rounded-[1.4rem] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-400">Monthly summary</p>
                  <p className="mt-1 text-base font-semibold text-white">
                    Logged this month, target this month, and gap to close
                  </p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300">
                  Tap to expand
                </span>
              </div>
            </summary>
            <div className="grid gap-3 px-4 pb-4 pt-0">
              <MiniMetricCard
                color="emerald"
                icon={<Wallet className="h-4 w-4" />}
                label="Logged this month"
                value={formatMoney(currentMonthLoggedAud)}
                note="Matches the plan so far."
              />
              <MiniMetricCard
                color="blue"
                icon={<Target className="h-4 w-4" />}
                label="Target this month"
                value={formatMoney(settings.planMonthlyContributionAud)}
                note="What is still expected."
              />
              <MiniMetricCard
                color="amber"
                icon={<CircleDollarSign className="h-4 w-4" />}
                label="Gap to close"
                value={catchUpValue}
                note={catchUpLabel}
              />
            </div>
          </details>
        </section>

        <section className="hidden gap-4 md:grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <Card className="border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.28)]">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-400">What needs attention</p>
                  <h2 className="mt-2 max-w-lg text-xl font-semibold tracking-tight text-white sm:text-2xl">
                    Three plain-language prompts replace the old long checklist.
                  </h2>
                </div>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  3 actions
                </Badge>
              </div>

              <div className="mt-5 grid gap-3">
                <ActionPrompt
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  title="Log today&apos;s deposit"
                  text="One tap gets you back on track."
                  cta="Do now"
                  href="/transactions"
                  tone="emerald"
                />
                <ActionPrompt
                  icon={<Target className="h-4 w-4" />}
                  title="Review transactions"
                  text="Check for anything that looks wrong."
                  cta="Check"
                  href="/transactions"
                  tone="amber"
                />
                <ActionPrompt
                  icon={<ArrowRight className="h-4 w-4" />}
                  title="Open projections"
                  text="See how this month changes the story."
                  cta="View"
                  href="/projections"
                  tone="blue"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.28)]">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-400">Recent activity</p>
                  <h2 className="mt-2 max-w-md text-xl font-semibold tracking-tight text-white sm:text-2xl">
                    A visual feed that feels like a timeline, not a spreadsheet.
                  </h2>
                </div>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  {recentBars.length} months
                </Badge>
              </div>

              <div className="mt-5 rounded-[1.45rem] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] p-3 sm:p-4">
                <div className="rounded-[1.15rem] border border-white/6 bg-[#0b1327] px-3 pt-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                      <span>
                        {safeRecentWindowStart + 1} to {visibleWindowEnd} of {recentBars.length}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-slate-300">
                        12 months at a time
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 border-white/10 bg-white/5 px-3 text-slate-200 hover:bg-white/10"
                        onClick={() =>
                          setRecentWindowStart((current) => Math.max(0, current - recentWindowSize))
                        }
                        disabled={safeRecentWindowStart === 0}
                      >
                        <ChevronLeft className="mr-1 h-4 w-4" />
                        Prev 12
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 border-white/10 bg-white/5 px-3 text-slate-200 hover:bg-white/10"
                        onClick={() =>
                          setRecentWindowStart((current) =>
                            Math.min(maxRecentWindowStart, current + recentWindowSize),
                          )
                        }
                        disabled={safeRecentWindowStart === maxRecentWindowStart}
                      >
                        Next 12
                        <ChevronRight className="ml-1 h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-12 gap-1 overflow-hidden pb-2 sm:gap-2">
                    {visibleRecentBars.map((bar) => {
                      const isSelected = selectedRecentBarIndex === bar.index;
                      return (
                        <button
                          key={`${bar.label}-${bar.index}`}
                          type="button"
                          onClick={() => setSelectedRecentBarIndex(bar.index)}
                          onMouseEnter={() => setSelectedRecentBarIndex(bar.index)}
                          onFocus={() => setSelectedRecentBarIndex(bar.index)}
                          className="group flex h-44 min-w-0 flex-col justify-end gap-1 rounded-none outline-none transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-white/40 sm:h-48"
                          aria-pressed={isSelected}
                          aria-label={`${bar.fullLabel}: ${formatMoney(bar.valueAud)}`}
                        >
                          <div className="flex h-full w-full items-end justify-center overflow-visible">
                            <div
                              className={cn(
                                "w-full rounded-none bg-[#5f88f8] shadow-[0_10px_18px_rgba(59,109,246,0.16)] transition-all duration-200",
                                bar.valueAud <= 0 ? "opacity-30" : "opacity-95",
                                isSelected && "opacity-100 ring-2 ring-white/45",
                              )}
                              style={{ height: `${Math.max(2, bar.height)}%` }}
                            />
                          </div>
                          <span
                            className={cn(
                              "text-[10px] font-medium leading-none tracking-[0.12em]",
                              isSelected ? "text-white" : "text-slate-400",
                            )}
                          >
                            {bar.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 rounded-[1.1rem] border border-white/10 bg-[#101a32] px-3 py-3">
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                          Selected month
                        </p>
                        <p className="mt-1 text-base font-semibold text-white sm:text-lg">
                          {selectedRecentBar?.fullLabel ?? "No activity yet"}
                        </p>
                      </div>
                      <div className="text-left sm:text-right">
                        <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                          Monthly logged
                        </p>
                        <p className="mt-1 text-xl font-semibold text-white sm:text-2xl">
                          {selectedRecentBar ? formatMoney(selectedRecentBar.valueAud) : formatMoney(0)}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-400">
                Hover or click any bar to inspect that month&apos;s logged total.
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-3 md:hidden">
          <div className="rounded-[1.4rem] border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_20px_60px_rgba(2,6,23,0.2)]">
            <div className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-400">Needs attention</p>
                  <p className="mt-1 text-base font-semibold text-white">
                    Three plain-language prompts replace the old long checklist.
                  </p>
                </div>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  3 actions
                </Badge>
              </div>
              <div className="mt-4 grid gap-3">
                <ActionPrompt
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  title="Log today&apos;s deposit"
                  text="One tap gets you back on track."
                  cta="Do now"
                  href="/transactions"
                  tone="emerald"
                />
                <ActionPrompt
                  icon={<Target className="h-4 w-4" />}
                  title="Review transactions"
                  text="Check for anything that looks wrong."
                  cta="Check"
                  href="/transactions"
                  tone="amber"
                />
                <ActionPrompt
                  icon={<ArrowRight className="h-4 w-4" />}
                  title="Open projections"
                  text="See how this month changes the story."
                  cta="View"
                  href="/projections"
                  tone="blue"
                />
              </div>
            </div>
          </div>

          <div className="rounded-[1.4rem] border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_20px_60px_rgba(2,6,23,0.2)]">
            <div className="flex items-start justify-between gap-3 px-4 py-4">
              <div>
                <p className="text-sm font-semibold text-slate-400">Graph projection</p>
                <p className="mt-1 text-base font-semibold text-white">Portfolio vs benchmark</p>
              </div>
              <button
                type="button"
                className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300"
                aria-expanded={isGraphProjectionExpanded}
                onClick={() => setIsGraphProjectionExpanded((current) => !current)}
              >
                {isGraphProjectionExpanded ? "Tap to collapse" : "Tap to expand"}
              </button>
            </div>
            {isGraphProjectionExpanded ? (
              <CardContent className="px-4 pb-4 pt-0">
                <div className="rounded-[1.45rem] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] p-3">
                  <div className="rounded-[1.15rem] border border-white/6 bg-[#0b1327] px-3 pt-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                        <span>
                          {safeRecentWindowStart + 1} to {visibleWindowEnd} of {recentBars.length}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-slate-300">
                          12 months at a time
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 border-white/10 bg-white/5 px-3 text-slate-200 hover:bg-white/10"
                          onClick={() =>
                            setRecentWindowStart((current) => Math.max(0, current - recentWindowSize))
                          }
                          disabled={safeRecentWindowStart === 0}
                        >
                          <ChevronLeft className="mr-1 h-4 w-4" />
                          Prev 12
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 border-white/10 bg-white/5 px-3 text-slate-200 hover:bg-white/10"
                          onClick={() =>
                            setRecentWindowStart((current) =>
                              Math.min(maxRecentWindowStart, current + recentWindowSize),
                            )
                          }
                          disabled={safeRecentWindowStart === maxRecentWindowStart}
                        >
                          Next 12
                          <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-12 gap-1 overflow-hidden pb-2 sm:gap-2">
                      {visibleRecentBars.map((bar) => {
                        const isSelected = selectedRecentBarIndex === bar.index;
                        return (
                          <button
                            key={`${bar.label}-${bar.index}`}
                            type="button"
                            onClick={() => setSelectedRecentBarIndex(bar.index)}
                            onMouseEnter={() => setSelectedRecentBarIndex(bar.index)}
                            onFocus={() => setSelectedRecentBarIndex(bar.index)}
                            className="group flex h-40 min-w-0 flex-col justify-end gap-1 rounded-none outline-none transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-white/40"
                            aria-pressed={isSelected}
                            aria-label={`${bar.fullLabel}: ${formatMoney(bar.valueAud)}`}
                          >
                            <div className="flex h-full w-full items-end justify-center overflow-visible">
                              <div
                                className={cn(
                                  "w-full rounded-none bg-[#5f88f8] shadow-[0_10px_18px_rgba(59,109,246,0.16)] transition-all duration-200",
                                  bar.valueAud <= 0 ? "opacity-30" : "opacity-95",
                                  isSelected && "opacity-100 ring-2 ring-white/45",
                                )}
                                style={{ height: `${Math.max(2, bar.height)}%` }}
                              />
                            </div>
                            <span
                              className={cn(
                                "text-[10px] font-medium leading-none tracking-[0.12em]",
                                isSelected ? "text-white" : "text-slate-400",
                              )}
                            >
                              {bar.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-3 rounded-[1.1rem] border border-white/10 bg-[#101a32] px-3 py-3">
                      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                            Selected month
                          </p>
                          <p className="mt-1 text-base font-semibold text-white sm:text-lg">
                            {selectedRecentBar?.fullLabel ?? "No activity yet"}
                          </p>
                        </div>
                        <div className="text-left sm:text-right">
                          <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                            Monthly logged
                          </p>
                          <p className="mt-1 text-xl font-semibold text-white sm:text-2xl">
                            {selectedRecentBar ? formatMoney(selectedRecentBar.valueAud) : formatMoney(0)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <p className="mt-3 text-sm leading-6 text-slate-400">
                  Hover or click any bar to inspect that month&apos;s logged total.
                </p>
              </CardContent>
            ) : null}
          </div>
        </section>

        <section className="grid gap-4">
          <Card className="overflow-hidden border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.32)]">
            <div className="border-b border-white/10 bg-[#101a32] px-5 py-5 text-white sm:px-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
                    Portfolio scenario check
                  </p>
                  <h2 className="text-2xl font-semibold tracking-tight sm:text-[2rem]">
                    Live AAPL benchmark versus the portfolio mix.
                  </h2>
                  <p className="max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
                    The benchmark starts with {formatShares(portfolioScenarioComparison.benchmarkShares)}{" "}
                    {portfolioScenarioComparison.benchmarkTicker} shares. Its snapshot is the first
                    market close on or after {settings.planStartDate}; the live target is those same
                    shares at today&apos;s AAPL price. It does not extrapolate a recent move to month 53.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className="border-white/10 bg-white/10 text-white"
                    variant={
                      portfolioScenarioComparison.status === "above target"
                        ? "success"
                        : portfolioScenarioComparison.status === "below target"
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {portfolioScenarioComparison.status}
                  </Badge>
                  <Badge className="border-white/10 bg-white/10 text-white" variant="outline">
                    {portfolioScenarioComparison.benchmarkGrowthPercent.toFixed(1)}% since snapshot
                  </Badge>
                  <Badge className="border-white/10 bg-white/10 text-white" variant="outline">
                    Live benchmark
                  </Badge>
                </div>
              </div>
            </div>
            <CardContent className="space-y-4 p-5 sm:p-6">
              <div className="grid gap-3 md:grid-cols-4">
                <ScenarioMetric
                  label="AAPL snapshot value"
                  value={formatScenarioMoney(portfolioScenarioComparison.benchmarkSnapshotValueUsd)}
                  note={`${formatShares(portfolioScenarioComparison.benchmarkShares)} shares at ${formatScenarioMoney(portfolioScenarioComparison.benchmarkAnchorPriceUsd, 2)} on the snapshot date.`}
                />
                <ScenarioMetric
                  label="AAPL benchmark target"
                  value={formatScenarioMoney(portfolioScenarioComparison.benchmarkProjectedValueUsd)}
                  note={`${Math.abs(portfolioScenarioComparison.benchmarkGrowthPercent).toFixed(2)}% ${portfolioScenarioComparison.benchmarkGrowthPercent >= 0 ? "above" : "below"} the snapshot value.`}
                />
                <ScenarioMetric
                  label="Portfolio mix now"
                  value={formatScenarioMoney(portfolioScenarioComparison.portfolioCurrentValueUsd)}
                  note="Current market value of held positions; compared like-for-like with the live benchmark."
                />
                <ScenarioMetric
                  label="Difference"
                  value={formatScenarioMoney(Math.abs(portfolioScenarioComparison.projectedDifferenceUsd))}
                  note={`${portfolioScenarioComparison.projectedDifferencePercent >= 0 ? "+" : ""}${portfolioScenarioComparison.projectedDifferencePercent.toFixed(2)}% vs the benchmark.`}
                  tone={differenceTone}
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-white">
                      {portfolioScenarioComparison.status === "above target"
                        ? "The combined portfolio is ahead of the AAPL benchmark."
                        : portfolioScenarioComparison.status === "below target"
                          ? "The combined portfolio is behind the AAPL benchmark."
                          : "The combined portfolio is tracking the AAPL benchmark."}
                    </p>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                      19 May anchor
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    The growth rate is measured from 19 May to today, then applied linearly to the
                    53-month due date. The mix target uses the full planned contribution stream,
                    then distributes it across the current tickers and applies the same linear
                    growth logic so the estimate stays closer to the portfolio you are actually
                    building.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {portfolioScenarioComparison.holdings.slice(0, 4).map((holding) => (
                      <Badge key={holding.ticker} variant="outline">
                        {holding.ticker} {holding.growthMultiplier.toFixed(2)}x since {holding.anchorDate}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                  <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                    Top holdings
                  </p>
                  <div className="mt-3 space-y-3">
                    {portfolioScenarioComparison.holdings.slice(0, 3).map((holding) => (
                      <div key={holding.ticker} className="rounded-xl border border-white/10 bg-[#101a32] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium text-white">{holding.ticker}</p>
                          <p className="text-sm text-slate-300">{formatScenarioMoney(holding.projectedValueUsd)}</p>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          {formatShares(holding.shares)} shares now, {holding.growthMultiplier.toFixed(2)}x since {holding.anchorDate}.
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          Current price: {formatScenarioMoney(holding.currentPriceUsd, 2)}.
                        </p>
                      </div>
                    ))}
                    {portfolioScenarioComparison.holdings.length === 0 ? (
                      <p className="text-sm text-slate-400">No holdings with usable price history were found.</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

        </section>

        <section className="grid gap-4">
          <Card className="overflow-hidden border border-slate-800/70 bg-[#0f1830] text-slate-100 shadow-[0_30px_100px_rgba(2,6,23,0.32)]">
            <div className="border-b border-white/10 bg-[#101a32] px-5 py-5 text-white sm:px-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                  <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-400">
                    Deep context
                  </p>
                  <h2 className="text-2xl font-semibold tracking-tight sm:text-[2rem]">
                    Your automated market brief, with the deeper planning layers close by.
                  </h2>
                  <p className="max-w-3xl text-sm leading-6 text-slate-300 sm:text-base">
                    One relevant article is collected for each tracked ticker on every US market day.
                    Monthly reviews publish automatically once there is enough coverage to compare the
                    longer-term picture.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-white/10 bg-white/10 text-white" variant="outline">
                    {dailyBriefLoading ? "Checking daily brief" : `${dailyCollectedCount}/${COMPARISON_SYMBOLS.length} collected`}
                  </Badge>
                  <Badge className="border-white/10 bg-white/10 text-white" variant="outline">
                    {dailyAutomatedCount === COMPARISON_SYMBOLS.length && dailyCollectedCount > 0
                      ? "Automated collection active"
                      : `Review month ${codexReviewMonth}`}
                  </Badge>
                </div>
              </div>
            </div>
            <CardContent className="p-5 sm:p-6">
              <Tabs defaultValue="daily" className="w-full">
                <TabsList className="grid h-auto w-full grid-cols-2 rounded-[1.4rem] border border-white/8 bg-white/5 p-1 sm:grid-cols-4">
                  <TabsTrigger value="daily">Daily brief</TabsTrigger>
                  <TabsTrigger value="compare">Monthly review</TabsTrigger>
                  <TabsTrigger value="plan">Plan view</TabsTrigger>
                  <TabsTrigger value="details">Raw details</TabsTrigger>
                </TabsList>

                <TabsContent value="daily" className="mt-5">
                  <div className="grid gap-4">
                    <div className="flex flex-col gap-4 rounded-[1.6rem] border border-white/10 bg-white/5 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
                      <div>
                        <p className="text-sm font-semibold text-slate-400">Today&apos;s collected context</p>
                        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                          {dailyBriefLoading
                            ? "Loading the stored daily brief..."
                            : dailyCollectedCount === COMPARISON_SYMBOLS.length
                              ? "All tracked tickers are covered."
                              : `${dailyCollectedCount} of ${COMPARISON_SYMBOLS.length} tracked tickers are covered.`}
                        </h3>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                          The collector keeps any shortfall visible instead of filling the dashboard with a low-quality article.
                          {latestDailyBriefAt ? ` Last refreshed ${format(new Date(latestDailyBriefAt), "d MMM, h:mm a")}.` : ""}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:min-w-56">
                        <MiniStatusChip label="Target" value={`${COMPARISON_SYMBOLS.length}/day`} note="One per ticker" />
                        <MiniStatusChip label="Collected" value={`${dailyCollectedCount}/${COMPARISON_SYMBOLS.length}`} note="Stored articles" />
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {dailyBriefLoading
                        ? COMPARISON_SYMBOLS.map((symbol) => (
                            <div key={symbol} className="min-h-44 animate-pulse rounded-[1.4rem] border border-white/10 bg-white/5 p-4" />
                          ))
                        : dailyBriefs.map((item) => {
                            const retrievalStatus = item.article?.raw?.retrievalStatus;
                            const strongEvidence =
                              item.article?.raw?.evidencePolicyVersion === "strong-evidence-v1" &&
                              (item.article.raw.qualityScore ?? 0) >= 70;
                            return (
                              <div key={item.symbol} className="flex min-h-44 flex-col rounded-[1.4rem] border border-white/10 bg-white/5 p-4">
                                <div className="flex items-start justify-between gap-3">
                                  <p className="text-lg font-semibold text-white">{item.symbol}</p>
                                  <Badge variant={item.article && strongEvidence ? "success" : "secondary"}>
                                    {item.article ? strongEvidence ? "Strong evidence" : "Stored evidence" : "Shortfall"}
                                  </Badge>
                                </div>
                                {item.article ? (
                                  <>
                                    <a
                                      className="mt-3 line-clamp-3 text-sm font-medium leading-6 text-white transition hover:text-emerald-300"
                                      href={item.article.url}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      {item.article.title}
                                    </a>
                                    <div className="mt-auto flex flex-wrap gap-2 pt-4 text-xs text-slate-400">
                                      <span>{item.article.source ?? "Source recorded"}</span>
                                      <span>•</span>
                                      <span>{retrievalStatus === "read" ? "Full text" : "Source summary"}</span>
                                      {strongEvidence ? (
                                        <>
                                          <span>•</span>
                                          <span>{Math.round(item.article.raw?.qualityScore ?? 0)}/100 quality</span>
                                        </>
                                      ) : null}
                                    </div>
                                  </>
                                ) : (
                                  <p className="mt-3 text-sm leading-6 text-slate-300">
                                    {item.error ?? "No suitable article was stored for this ticker today."}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="compare" className="mt-5">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
                    <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5 sm:p-6">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-slate-400">Automatic monthly review</p>
                          <h3 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                            {bestComparisonReview?.symbol ?? "Loading"}
                          </h3>
                          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
                            {comparisonLoading
                              ? "Loading the current comparison bundles..."
                              : comparisonLeadingRationale}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge
                            variant={
                              comparisonSignalLabel === "positive"
                                ? "success"
                                : comparisonSignalLabel === "negative"
                                  ? "warning"
                                  : "secondary"
                            }
                          >
                            {comparisonSignalLabel}
                          </Badge>
                          <Badge variant="outline">
                            Score {bestComparisonReview ? `${bestComparisonReview.rankScore.toFixed(2)}/5` : "pending"}
                          </Badge>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-3">
                        <MiniStatusChip
                          label="Collected"
                          value={`${fetchedComparisonCount}/${COMPARISON_SYMBOLS.length}`}
                          note="Saved in the current review month"
                        />
                        <MiniStatusChip
                          label="Published"
                          value={`${reviewedComparisonCount}/${COMPARISON_SYMBOLS.length}`}
                          note="Ready to influence the guide"
                        />
                        <MiniStatusChip
                          label="Lead"
                          value={bestComparisonReview?.symbol ?? "Pending"}
                          note="Top-ranked comparison ticket"
                        />
                      </div>

                      {comparisonError ? (
                        <div className="mt-4 rounded-[1.2rem] border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
                          {comparisonError}
                        </div>
                      ) : null}
                    </div>

                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
                      {comparisonReviews.map((item, index) => {
                        const digest = item.codexReview?.appliedNewsDigest;
                        const score = item.rankScore;
                        const normalizedScore =
                          item.status === "loaded"
                            ? Math.max(6, Math.min(100, ((score + 5) / 10) * 100))
                            : item.status === "prepared"
                              ? 24
                              : 10;
                        const scoreLabel =
                          item.status === "loaded"
                            ? score.toFixed(2)
                            : item.status === "prepared"
                              ? "Ready"
                              : item.status === "missing"
                                ? "Missing"
                                : "Error";
                        return (
                          <div
                            key={item.symbol}
                            className="rounded-[1.4rem] border border-white/10 bg-white/5 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.1)]"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                                  Rank {index + 1}
                                </p>
                                <p className="mt-1 text-lg font-semibold text-white">{item.symbol}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-lg font-semibold text-white">{scoreLabel}</p>
                                <p className="text-xs text-slate-400">
                                  {item.status === "loaded" ? "fit / 5" : "review status"}
                                </p>
                              </div>
                            </div>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  digest?.signal === "positive"
                                    ? "bg-emerald-500"
                                    : digest?.signal === "negative"
                                      ? "bg-amber-500"
                                      : "bg-slate-400",
                                )}
                                style={{ width: `${normalizedScore}%` }}
                              />
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Badge
                                variant={
                                  digest?.signal === "positive"
                                    ? "success"
                                    : digest?.signal === "negative"
                                      ? "warning"
                                      : "secondary"
                                }
                              >
                                {digest?.signal ?? "pending"}
                              </Badge>
                              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                                {digest?.confidence ? `${digest.confidence} confidence` : item.status}
                              </Badge>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-slate-300">
                              {item.codexReview?.suggestedGuideImpact?.rationale ??
                                item.codexReview?.rationale ??
                                "No published rationale yet."}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="plan" className="mt-5">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                    <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5 sm:p-6">
                      <p className="text-sm font-semibold text-slate-400">Plan view</p>
                      <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                        A plain-language version of the original planning block.
                      </h3>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
                        The dashboard now leads with the answer, while the planning layer stays
                        reachable for people who want the why behind it.
                      </p>
                      <div className="mt-5 grid gap-3 md:grid-cols-3">
                        <MiniMetricCard
                          color="emerald"
                          icon={<Wallet className="h-4 w-4" />}
                          label="Logged this month"
                          value={formatMoney(currentMonthLoggedAud)}
                          note="What has already landed."
                        />
                        <MiniMetricCard
                          color="blue"
                          icon={<Target className="h-4 w-4" />}
                          label="Monthly target"
                          value={formatMoney(settings.planMonthlyContributionAud)}
                          note="The current guidepost."
                        />
                        <MiniMetricCard
                          color="amber"
                          icon={<CircleDollarSign className="h-4 w-4" />}
                          label="Still to close"
                          value={formatMoney(gapRemainingAud)}
                          note={monthAhead ? "Keep pace to stay ahead." : "A small catch-up remains."}
                        />
                      </div>
                    </div>

                    <div className="rounded-[1.6rem] border border-white/10 bg-[#101a32] p-5 text-white">
                      <p className="text-sm font-semibold text-slate-400">Short answer</p>
                      <p className="mt-3 text-2xl font-semibold tracking-tight">
                        {monthAhead ? "You are ahead this month." : "You are behind this month."}
                      </p>
                      <p className="mt-3 text-sm leading-6 text-slate-300">
                        Open projections if you want the more technical debt and rebuild breakdown.
                      </p>
                      <div className="mt-5 grid gap-3">
                        <div className="rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                            Monthly guide
                          </p>
                          <p className="mt-2 text-xl font-semibold text-white">
                            {formatMoney(depositGuide.recommendedDepositAud)}
                          </p>
                          <p className="mt-1 text-sm text-slate-400">
                            Range {formatMoney(depositGuide.minThisMonthAud)} to{" "}
                            {formatMoney(depositGuide.maxThisMonthAud)}.
                          </p>
                        </div>
                        <Button asChild className="bg-emerald-400 text-slate-950 hover:bg-emerald-300">
                          <Link href="/projections">Open full projections</Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="details" className="mt-5">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <DetailTile label="Value ahead / short" value={`${formatMoney(Math.abs(metrics.paceDifferenceAud))} ${monthValueLabel}`} />
                    <DetailTile label="Current logged" value={formatMoney(currentMonthLoggedAud)} />
                    <DetailTile label="Target" value={formatMoney(settings.planMonthlyContributionAud)} />
                    <DetailTile label="Monthly progress" value={`${Math.round(progressPercent)}%`} />
                    <DetailTile label="Comparison month" value={codexReviewMonth} />
                    <DetailTile label="Signal leader" value={bestComparisonReview?.symbol ?? "Pending"} />
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </section>

        {isLoading ? <p className="px-1 text-sm text-slate-400">Loading your local tracker...</p> : null}
        {isRefreshing ? <p className="px-1 text-sm text-slate-400">Refreshing market data...</p> : null}
      </div>
    </AppShell>
  );
}

function MiniMetricCard({
  color,
  icon,
  label,
  value,
  note,
}: {
  color: "emerald" | "blue" | "amber";
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
}) {
  const palette =
    color === "emerald"
      ? "bg-emerald-500/15 text-emerald-300"
      : color === "amber"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-blue-500/15 text-blue-300";

  return (
    <Card className="border border-white/10 bg-white/5 text-slate-100">
      <CardContent className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-400">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-white">{value}</p>
            <p className="mt-2 text-sm leading-6 text-slate-400">{note}</p>
          </div>
          <div className={cn("rounded-2xl p-2.5", palette)}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActionPrompt({
  icon,
  title,
  text,
  cta,
  href,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  cta: string;
  href: string;
  tone: "emerald" | "amber" | "blue";
}) {
  const accent =
    tone === "emerald"
      ? "bg-emerald-500/15 text-emerald-300"
      : tone === "amber"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-blue-500/15 text-blue-300";

  return (
    <div className="flex items-center gap-3 rounded-[1.35rem] border border-white/10 bg-white/5 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.12)]">
      <div className={cn("rounded-2xl p-2.5", accent)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-white">{title}</p>
        <p className="mt-1 text-sm leading-6 text-slate-400">{text}</p>
      </div>
      <Button
        asChild
        size="sm"
        variant="outline"
        className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
      >
        <Link href={href}>{cta}</Link>
      </Button>
    </div>
  );
}

function MiniStatusChip({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-[1.2rem] border border-white/10 bg-[#101a32] p-4">
      <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
      <p className="mt-1 text-sm leading-6 text-slate-400">{note}</p>
    </div>
  );
}

function ScenarioMetric({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "neutral" | "positive" | "negative";
}) {
  const accent =
    tone === "positive"
      ? "border-emerald-500/20 bg-emerald-500/10"
      : tone === "negative"
        ? "border-rose-500/20 bg-rose-500/10"
        : "border-white/10 bg-[#101a32]";
  const valueTone =
    tone === "positive"
      ? "text-emerald-200"
      : tone === "negative"
        ? "text-rose-200"
        : "text-white";
  const noteTone =
    tone === "positive"
      ? "text-emerald-100/80"
      : tone === "negative"
        ? "text-rose-100/80"
        : "text-slate-400";

  return (
    <div className={cn("rounded-[1.2rem] border p-4", accent)}>
      <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">{label}</p>
      <p className={cn("mt-2 text-lg font-semibold", valueTone)}>{value}</p>
      <p className={cn("mt-1 text-sm leading-6", noteTone)}>{note}</p>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.4rem] border border-white/10 bg-white/5 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.1)]">
      <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function calculateCurrentMonthContributionAud(
  contributions: Array<{ date: string; currencyEntered: string; amount: number; amountUsd: number }>,
  asOfDate: string,
  latestUsdToAudRate: number,
) {
  const month = asOfDate.slice(0, 7);
  return contributions
    .filter((contribution) => contribution.date.slice(0, 7) === month)
    .reduce((total, contribution) => {
      if (contribution.currencyEntered === "AUD") {
        return total + contribution.amount;
      }
      return total + contribution.amountUsd * latestUsdToAudRate;
    }, 0);
}

function calculateCurrentMonthLoggedAud(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
  asOfDate: string,
  latestUsdToAudRate: number,
) {
  return roundMoney(
    calculateLoggedTransactionsAud(contributions, trades, asOfDate.slice(0, 7), latestUsdToAudRate),
  );
}

function calculateTotalLoggedAud(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
  latestUsdToAudRate: number,
) {
  return roundMoney(calculateLoggedTransactionsAud(contributions, trades, undefined, latestUsdToAudRate));
}

function getLatestLoggedMonthKey(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
) {
  const latestContributionDate = contributions.map((item) => item.date).sort().at(-1);
  const latestTradeDate = trades.map((item) => item.date).sort().at(-1);
  const latestDate = [latestContributionDate, latestTradeDate].filter(Boolean).sort().at(-1);
  return latestDate ? latestDate.slice(0, 7) : undefined;
}

function calculateLoggedTransactionsAud(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
  month: string | undefined,
  latestUsdToAudRate: number,
) {
  const totals = new Map<string, number>();
  const matchesMonth = (date: string) => (month ? date.slice(0, 7) === month : true);

  for (const contribution of contributions) {
    if (!matchesMonth(contribution.date)) {
      continue;
    }
    const key = contribution.ledgerGroupId ? `group:${contribution.ledgerGroupId}` : `contribution:${contribution.id}`;
    if (totals.has(key)) {
      continue;
    }
    const amountAud =
      contribution.currencyEntered === "AUD"
        ? contribution.amount
        : contribution.amountUsd * latestUsdToAudRate;
    totals.set(key, amountAud);
  }

  for (const trade of trades) {
    if (!matchesMonth(trade.date) || trade.side !== "BUY") {
      continue;
    }
    const key = trade.ledgerGroupId ? `group:${trade.ledgerGroupId}` : `trade:${trade.id}`;
    if (totals.has(key)) {
      continue;
    }
    const amountAud =
      typeof trade.cashOutAud === "number"
        ? trade.cashOutAud
        : latestUsdToAudRate > 0
          ? trade.totalAmountUsd / latestUsdToAudRate
          : trade.totalAmountUsd;
    totals.set(key, amountAud);
  }

  return Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
}

function buildRecentContributionBars(
  contributions: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
  trades: Array<{
    id: string;
    date: string;
    ledgerGroupId?: string;
    side: "BUY" | "SELL";
    cashOutAud?: number;
    totalAmountUsd: number;
  }>,
  startDate: string,
  endDateIso: string,
  latestUsdToAudRate: number,
) {
  const months: Array<{ label: string; fullLabel: string; valueAud: number }> = [];
  const monthDate = new Date(`${startDate}T00:00:00`);
  monthDate.setDate(1);
  const endDate = new Date(`${endDateIso}T00:00:00`);
  endDate.setDate(1);
  while (monthDate <= endDate) {
    const key = format(monthDate, "yyyy-MM");
    const label = format(monthDate, "MMMyy");
    const fullLabel = format(monthDate, "MMMyy");
    const valueAud = calculateLoggedTransactionsAud(contributions, trades, key, latestUsdToAudRate);
    months.push({ label, fullLabel, valueAud });
    monthDate.setMonth(monthDate.getMonth() + 1);
  }

  const max = Math.max(...months.map((month) => month.valueAud), 1);
  const hasAnyValue = months.some((month) => month.valueAud > 0);

  return months.map((month, index) => ({
    index,
    label: month.label,
    fullLabel: month.fullLabel,
    valueAud: roundMoney(month.valueAud),
    height: hasAnyValue
      ? month.valueAud > 0
        ? Math.max(4, (month.valueAud / max) * 100)
        : 2
      : 2,
    tint: "blue" as const,
  }));
}

function ComparisonLineGraph({
  benchmarkCurrentValueUsd,
  benchmarkProjectedValueUsd,
  portfolioCurrentValueUsd,
  portfolioProjectedValueUsd,
  months,
}: {
  benchmarkCurrentValueUsd: number;
  benchmarkProjectedValueUsd: number;
  portfolioCurrentValueUsd: number;
  portfolioProjectedValueUsd: number;
  months: number;
}) {
  const steps = Math.max(1, months);
  const width = 560;
  const height = 144;
  const paddingX = 12;
  const paddingTop = 10;
  const paddingBottom = 22;
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingTop - paddingBottom;
  const maxValue = Math.max(
    benchmarkCurrentValueUsd,
    benchmarkProjectedValueUsd,
    portfolioCurrentValueUsd,
    portfolioProjectedValueUsd,
    1,
  );

  const points = Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    return {
      index,
      benchmark:
        benchmarkCurrentValueUsd +
        (benchmarkProjectedValueUsd - benchmarkCurrentValueUsd) * progress,
      portfolio:
        portfolioCurrentValueUsd +
        (portfolioProjectedValueUsd - portfolioCurrentValueUsd) * progress,
    };
  });

  const scaleX = (index: number) => paddingX + (index / steps) * chartWidth;
  const scaleY = (value: number) => paddingTop + (1 - value / maxValue) * chartHeight;

  const benchmarkPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${scaleX(point.index)} ${scaleY(point.benchmark)}`)
    .join(" ");
  const portfolioPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${scaleX(point.index)} ${scaleY(point.portfolio)}`)
    .join(" ");
  const majorTicks = [0, Math.floor(steps / 4), Math.floor(steps / 2), Math.floor((steps * 3) / 4), steps]
    .filter((tick, index, array) => array.indexOf(tick) === index)
    .sort((left, right) => left - right);

  return (
    <svg
      aria-label="Portfolio versus benchmark line graph"
      className="block h-[180px] w-full"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
    >
      {Array.from({ length: steps + 1 }, (_, index) => {
        const x = scaleX(index);
        const isMajor = majorTicks.includes(index);
        return (
          <line
            key={`tick-${index}`}
            x1={x}
            x2={x}
            y1={height - paddingBottom - (isMajor ? 10 : 6)}
            y2={height - paddingBottom}
            stroke={isMajor ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)"}
            strokeWidth={1}
          />
        );
      })}

      <line
        x1={paddingX}
        x2={width - paddingX}
        y1={height - paddingBottom}
        y2={height - paddingBottom}
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
      />

      <path d={benchmarkPath} fill="none" stroke="#60a5fa" strokeWidth={2.5} />
      <path d={portfolioPath} fill="none" stroke="#4ade80" strokeWidth={2.5} />

      {majorTicks.map((tick) => (
        <text
          key={`label-${tick}`}
          x={scaleX(tick)}
          y={height - 8}
          fill="rgba(226,232,240,0.72)"
          fontSize="9"
          textAnchor={tick === 0 ? "start" : tick === steps ? "end" : "middle"}
        >
          {tick}
        </text>
      ))}

      <circle
        cx={scaleX(steps)}
        cy={scaleY(benchmarkProjectedValueUsd)}
        r={4}
        fill="#60a5fa"
        stroke="rgba(15,23,42,0.95)"
        strokeWidth={2}
      />
      <circle
        cx={scaleX(steps)}
        cy={scaleY(portfolioProjectedValueUsd)}
        r={4}
        fill="#4ade80"
        stroke="rgba(15,23,42,0.95)"
        strokeWidth={2}
      />
    </svg>
  );
}
