"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleDollarSign,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { ProjectionChart } from "@/components/charts/projection-chart";
import { SchoolDecisionChart } from "@/components/charts/school-decision-chart";
import { MetricCard } from "@/components/dashboard/metric-card";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { buildAiNewsDigest } from "@/lib/ai/articleAnalysis";
import { calculateCatchUpMetrics } from "@/lib/domain/calculations";
import {
  calculateDepositGuide,
  type DepositGuideNewsInput,
} from "@/lib/domain/depositGuide";
import { formatDisplayDate, todayIso } from "@/lib/domain/dates";
import { calculatePortfolioScenarioComparison } from "@/lib/domain/portfolioScenario";
import { formatCurrency, formatShares, roundMoney } from "@/lib/domain/money";
import { projectCatchUp, type ProjectionResult } from "@/lib/domain/projections";
import type { TrackerBootstrapState } from "@/lib/shared-tracker/bootstrap";
import {
  buildCurrentMonthSchoolDecision,
  buildSchoolDecisionCompoundTimeline,
  findSchoolDecisionCrossDate,
  type CurrentMonthSchoolDecision,
} from "@/lib/domain/schoolDecision";
import {
  calculateStudyLoanMonthlyRepaymentAud,
  projectFreedRepaymentIntoAapl,
  projectStudyLoanDebtRange,
} from "@/lib/domain/studyLoan";
import { isRelevantNewsArticle } from "@/lib/news/relevance";
import { buildNewsDigest } from "@/lib/news/sentiment";
import { useTrackerData } from "@/lib/storage/useTrackerData";
import type { CachedDailyPrice, CachedQuote } from "@/lib/storage/types";
import { cn } from "@/lib/utils";

type ScenarioKey = "flat" | "conservative" | "base" | "optimistic" | "custom";
type ContributionMode = "guide" | "plan" | "custom";

type CodexReviewLookupResponse = {
  codexReview?: CodexReviewDetails | null;
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

type CodexReviewTheme = {
  theme?: string;
  direction?: string;
  materiality?: string;
  judgement?: string;
};

const SCENARIOS: Record<
  Exclude<ScenarioKey, "custom">,
  { label: string; growthPercent: number; description: string }
> = {
  flat: {
    label: "Flat",
    growthPercent: 0,
    description: "No price growth, useful for stress-testing deposits.",
  },
  conservative: {
    label: "Conservative",
    growthPercent: 3,
    description: "Muted annual growth with current rebuild behavior.",
  },
  base: {
    label: "Base",
    growthPercent: 6,
    description: "Middle case used by the main tracker views.",
  },
  optimistic: {
    label: "Optimistic",
    growthPercent: 10,
    description: "Stronger annual compounding, still within a simple model.",
  },
};

export function ProjectionsClient({
  initialTrackerSnapshot,
  initialTrackerSyncState,
  initialDisplayCurrency,
}: TrackerBootstrapState) {
  const tracker = useTrackerData({
    initialSnapshot: initialTrackerSnapshot,
    initialSyncState: initialTrackerSyncState,
    initialDisplayCurrency,
  });
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
    clearMarketDataCacheForSymbol,
  } = tracker;
  const ticker = settings.baseTicker || "AAPL";
  const [contributionMode, setContributionMode] = useState<ContributionMode>("guide");
  const [scenario, setScenario] = useState<ScenarioKey>("base");
  const [customGrowthPercent, setCustomGrowthPercent] = useState(6);
  const [customContributionAudOverride, setCustomContributionAudOverride] = useState<number>();
  const [projectionMonthsOverride, setProjectionMonthsOverride] = useState<number>();
  const [audUsdRateOverride, setAudUsdRateOverride] = useState<number>();
  const [includeDividendsOverride, setIncludeDividendsOverride] = useState<boolean>();
  const [dividendYieldPercentOverride, setDividendYieldPercentOverride] = useState<number>();
  const [isClearingMarketCache, setIsClearingMarketCache] = useState(false);
  const [codexReviewLookup, setCodexReviewLookup] = useState<{
    lookupKey: string;
    digest?: DepositGuideNewsInput;
    review?: CodexReviewDetails;
  }>();
  const customContributionAud =
    customContributionAudOverride ?? settings.planMonthlyContributionAud;
  const projectionMonths =
    projectionMonthsOverride ?? clampNumber(settings.planYears * 12, 12, 240, 60);
  const audUsdRate = audUsdRateOverride ?? roundMoney(latestAudToUsdRate);
  const includeDividends = includeDividendsOverride ?? settings.includeDividends;
  const dividendYieldPercent =
    dividendYieldPercentOverride ?? (settings.includeDividends ? 0.5 : 0);

  const reviewMonth = todayIso().slice(0, 7);
  const codexReviewLookupKey = `${settings.baseTicker}:${reviewMonth}`;

  useEffect(() => {
    let isActive = true;
    const params = new URLSearchParams({
      symbol: settings.baseTicker,
      reviewMonth,
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
            lookupKey: codexReviewLookupKey,
            digest: result?.codexReview?.appliedNewsDigest,
            review: result?.codexReview ?? undefined,
          });
        }
      })
      .catch(() => {
        if (isActive) {
          setCodexReviewLookup({ lookupKey: codexReviewLookupKey });
        }
      });

    return () => {
      isActive = false;
    };
  }, [codexReviewLookupKey, reviewMonth, settings.baseTicker]);

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
  const codexReviewDigest =
    codexReviewLookup?.lookupKey === codexReviewLookupKey
      ? codexReviewLookup.digest
      : undefined;
  const codexReviewDetails =
    codexReviewLookup?.lookupKey === codexReviewLookupKey
      ? codexReviewLookup.review
      : undefined;
  const guideNewsDigest: DepositGuideNewsInput =
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

  const depositGuide = calculateDepositGuide({
    planMonthlyContributionAud: settings.planMonthlyContributionAud,
    contributions: snapshot.contributions,
    dailyPrices: snapshot.dailyPrices,
    currentPriceUsd,
    latestUsdToAudRate,
    asOfDate: todayIso(),
    planStartDate: settings.planStartDate,
    news: guideNewsDigest,
  });
  const guideReviewSummary = buildGuideReviewSummary({
    digest: guideNewsDigest,
    codexReview: codexReviewDetails,
    guide: depositGuide,
  });
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

  const annualGrowthRatePercent =
    scenario === "custom" ? customGrowthPercent : SCENARIOS[scenario].growthPercent;
  const selectedMonthlyContributionAud =
    contributionMode === "guide"
      ? depositGuide.recommendedDepositAud
      : contributionMode === "plan"
        ? settings.planMonthlyContributionAud
        : customContributionAud;
  const safeProjectionMonths = clampNumber(projectionMonths, 12, 240, 60);
  const safeAudUsdRate = audUsdRate > 0 ? audUsdRate : latestAudToUsdRate;
  const activeDividendYieldPercent = includeDividends ? Math.max(0, dividendYieldPercent) : 0;

  const planProjection = buildProjection({
    monthlyContributionAud: settings.planMonthlyContributionAud,
    metrics,
    months: safeProjectionMonths,
    audUsdRate: safeAudUsdRate,
    annualGrowthRatePercent,
    dividendYieldPercent: activeDividendYieldPercent,
    includeDividends,
    currentPriceUsd,
  });
  const guideProjection = buildProjection({
    monthlyContributionAud: depositGuide.recommendedDepositAud,
    metrics,
    months: safeProjectionMonths,
    audUsdRate: safeAudUsdRate,
    annualGrowthRatePercent,
    dividendYieldPercent: activeDividendYieldPercent,
    includeDividends,
    currentPriceUsd,
  });
  const selectedProjection = buildProjection({
    monthlyContributionAud: Math.max(0, selectedMonthlyContributionAud),
    metrics,
    months: safeProjectionMonths,
    audUsdRate: safeAudUsdRate,
    annualGrowthRatePercent,
    dividendYieldPercent: activeDividendYieldPercent,
    includeDividends,
    currentPriceUsd,
  });
  const scenarioComparison = calculatePortfolioScenarioComparison({
    benchmarkTicker: ticker,
    benchmarkShares: Math.max(0, metrics.equivalentSharesToday),
    trades: snapshot.trades,
    dailyPrices: snapshot.dailyPrices,
    quotes: snapshot.quotes,
    splits: settings.includeSplits ? snapshot.splits : [],
    benchmarkCurrentPriceUsd: currentPriceUsd,
    asOfDate: todayIso(),
    anchorDate: settings.planStartDate,
    projectionMonths,
    portfolioContributionAud: customContributionAud,
    audUsdRate,
    benchmarkTolerancePercent: 1,
  });

  const studyLoanFormulaMonthlyAud = calculateStudyLoanMonthlyRepaymentAud(
    settings.studyLoanAnnualIncomeAud,
  );
  const activeStudyLoanMonthlyAud = settings.studyLoanUseIncomeFormula
    ? studyLoanFormulaMonthlyAud
    : settings.studyLoanMonthlyRepaymentAud;
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
  const freedMonthlyContributionAud = Math.max(
    selectedMonthlyContributionAud,
    freedRepaymentAud,
  );
  const freedRepaymentProjection = buildProjection({
    monthlyContributionAud: Math.max(0, freedMonthlyContributionAud),
    metrics,
    months: safeProjectionMonths,
    audUsdRate: safeAudUsdRate,
    annualGrowthRatePercent,
    dividendYieldPercent: activeDividendYieldPercent,
    includeDividends,
    currentPriceUsd,
  });
  const freedRepaymentValue = projectFreedRepaymentIntoAapl({
    startDate: todayIso(),
    months: safeProjectionMonths,
    monthlyFreedCashAud: freedRepaymentAud,
    audUsdRate: safeAudUsdRate,
    startingPriceUsd: currentPriceUsd,
    annualGrowthRatePercent,
  });
  const studyLoanProjectionRange = projectStudyLoanDebtRange({
    startDate: todayIso(),
    months: 120,
    startingBalanceAud: settings.studyLoanBalanceAud,
    monthlyRepaymentAud: activeStudyLoanMonthlyAud,
    annualIndexationRatePercent: settings.studyLoanAnnualIndexationRatePercent,
  });

  const currentMonthContributionAud = calculateCurrentMonthContributionAud(
    snapshot.contributions,
    todayIso(),
    latestUsdToAudRate,
  );
  const hasCurrentValuation = currentPriceUsd > 0 && metrics.hadHeldTotalValueUsd > 0;
  const currentMonthSchoolDecision = buildCurrentMonthSchoolDecision({
    asOfDate: todayIso(),
    currentHadHeldTotalUsd: hasCurrentValuation
      ? metrics.hadHeldTotalValueUsd
      : saleEvent?.netProceedsUsd ?? 0,
    originalSaleProceedsUsd: saleEvent?.netProceedsUsd ?? 0,
    currentRebuildAssetValueUsd: Math.max(0, metrics.rebuildTotalValueUsd),
    currentSchoolDebtAud: settings.studyLoanBalanceAud,
    debtAfterPayoffAud,
    totalContributionsAud: metrics.actualContributionsAud,
    latestUsdToAudRate,
    monthlyEducationRepaymentAud: activeStudyLoanMonthlyAud,
    currentMonthContributionAud,
    targetMonthContributionAud: Math.max(0, selectedMonthlyContributionAud),
    hasCurrentValuation,
  });
  const schoolDecisionTimeline = buildSchoolDecisionCompoundTimeline({
    startDate: todayIso(),
    months: safeProjectionMonths,
    keepStartingValueAud: currentMonthSchoolDecision.keepAaplValueAud,
    rebuildStartingValueAud: roundMoney(
      currentMonthSchoolDecision.rebuildAssetValueAud +
        currentMonthSchoolDecision.currentMonthDepositTopUpAud,
    ),
    monthlyContributionAud: Math.max(0, freedMonthlyContributionAud),
    currentSchoolDebtAud: settings.studyLoanBalanceAud,
    debtAfterPayoffAud,
    monthlyDebtRepaymentAud: activeStudyLoanMonthlyAud,
    annualDebtIndexationRatePercent: settings.studyLoanAnnualIndexationRatePercent,
    annualGrowthRatePercent,
  });
  const schoolDecisionCrossDate = findSchoolDecisionCrossDate(schoolDecisionTimeline);
  const comparisonRows = [
    {
      key: "plan",
      label: "Normal plan",
      monthlyAud: settings.planMonthlyContributionAud,
      projection: planProjection,
      note: "Your neutral monthly plan before Codex guide flex.",
    },
    {
      key: "guide",
      label: "This month guide",
      monthlyAud: depositGuide.recommendedDepositAud,
      projection: guideProjection,
      note: `${guideLabel(depositGuide.direction)} with ${depositGuide.confidence} confidence.`,
    },
    {
      key: "selected",
      label: "Selected model",
      monthlyAud: Math.max(0, selectedMonthlyContributionAud),
      projection: selectedProjection,
      note: `${contributionModeLabel(contributionMode)} under the active growth scenario.`,
    },
    ...(settings.studyLoanEnabled && freedRepaymentAud > 0
      ? [
          {
            key: "freed",
            label: "Repayment floor",
            monthlyAud: Math.max(0, freedMonthlyContributionAud),
            projection: freedRepaymentProjection,
            note: "Uses the larger of selected deposit and redirected school repayment.",
          },
        ]
      : []),
  ];

  if (isLoading) {
    return (
      <AppShell title="Projections" subtitle="Loading your local tracker.">
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading...</CardContent>
        </Card>
      </AppShell>
    );
  }

  if (!saleEvent) {
    return (
      <AppShell
        title="Projections"
        subtitle="Set up the original trade details before modelling catch-up paths."
      >
        <Card>
          <CardContent className="flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium">No sale event is saved yet.</p>
              <p className="text-sm text-muted-foreground">
                The projection needs the sale date, proceeds, and share count.
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
      ? formatCurrency(usd * latestUsdToAudRate, "AUD")
      : formatCurrency(usd, "USD");
  const displayAudValue = (aud: number) =>
    settings.displayCurrency === "USD"
      ? formatCurrency(aud * latestAudToUsdRate, "USD")
      : formatCurrency(aud, "AUD");
  const selectedScenarioLabel =
    scenario === "custom" ? "Custom" : SCENARIOS[scenario].label;
  const schoolPayoffRange =
    studyLoanProjectionRange.earliestPaidOffDate && studyLoanProjectionRange.latestPaidOffDate
      ? `${formatDisplayDate(studyLoanProjectionRange.earliestPaidOffDate)} to ${formatDisplayDate(
          studyLoanProjectionRange.latestPaidOffDate,
        )}`
      : "Not within 10 years";

  async function clearAndRefreshMarketCache() {
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
      title="Projections"
      subtitle={`Forward scenarios now use the same guide signal, article review summary, price-history health, and school-decision model as the dashboard for ${ticker}.`}
      initialDisplayCurrency={initialDisplayCurrency}
      initialTrackerSnapshot={initialTrackerSnapshot}
      initialTrackerSyncState={initialTrackerSyncState}
    >
      <div className="space-y-6">
        {warning ? (
          <Card className="border-[#f4cf76] bg-[#fff8e7] dark:bg-[#33280f]">
            <CardContent className="p-4 text-sm">{warning}</CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-4">
          <MetricCard
            title={`${ticker} Rebuild`}
            value={formatCatchUpDate(selectedProjection.catchUpDate)}
            description={`${displayAudValue(Math.max(0, selectedMonthlyContributionAud))}/month, ${selectedScenarioLabel.toLowerCase()} case.`}
            tone={selectedProjection.catchUpDate ? "positive" : "warning"}
            tooltip={`The first projected month where the rebuilt ${ticker} path equals or passes Had I Held.`}
          />
          <MetricCard
            title={`${ticker} Rebuild Gap`}
            value={formatGap(selectedProjection.projectedGapUsd, displayUsdValue)}
            description={`At ${safeProjectionMonths} months from today.`}
            tone={selectedProjection.projectedGapUsd <= 0 ? "positive" : "default"}
          />
          <MetricCard
            title="Required Monthly"
            value={displayAudValue(selectedProjection.requiredMonthlyContributionAud)}
            description="Estimated deposit needed to close the gap by this horizon."
            tooltip="This is recalculated from the selected price growth, FX, dividend, and horizon assumptions."
          />
          <MetricCard
            title="Planner Guide"
            value={formatCurrency(depositGuide.recommendedDepositAud, "AUD")}
            description={`${formatSignedPercent(depositGuide.adjustmentPercent)} from neutral. Score ${depositGuide.signalScore.toFixed(2)}.`}
            tone={depositGuide.direction === "increase" ? "primary" : depositGuide.direction === "decrease" ? "warning" : "default"}
            tooltip="Guide score is an internal tilt score, not a percent: 0.00 is neutral, positive leans higher, negative leans lower."
          />
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Projection Assumptions</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Adjust the guide basis, growth case, FX, horizon, and dividend handling in one place.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={isRefreshing}
                onClick={() => refreshMarketData(true)}
                size="sm"
                variant="outline"
              >
                <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                Refresh prices and news
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/dashboard">
                  Dashboard <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Contribution basis">
                <Select
                  value={contributionMode}
                  onValueChange={(value) => setContributionMode(value as ContributionMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="guide">This month guide</SelectItem>
                    <SelectItem value="plan">Normal plan</SelectItem>
                    <SelectItem value="custom">Custom monthly</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Custom monthly AUD">
                <Input
                  disabled={contributionMode !== "custom"}
                  inputMode="decimal"
                  min={0}
                  onChange={(event) => {
                    setCustomContributionAudOverride(Number(event.target.value) || 0);
                  }}
                  step={50}
                  type="number"
                  value={customContributionAud}
                />
              </Field>
              <Field label="Growth scenario">
                <Select
                  value={scenario}
                  onValueChange={(value) => setScenario(value as ScenarioKey)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="flat">Flat 0%</SelectItem>
                    <SelectItem value="conservative">Conservative 3%</SelectItem>
                    <SelectItem value="base">Base 6%</SelectItem>
                    <SelectItem value="optimistic">Optimistic 10%</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Custom growth %">
                <Input
                  disabled={scenario !== "custom"}
                  inputMode="decimal"
                  onChange={(event) => setCustomGrowthPercent(Number(event.target.value) || 0)}
                  step={0.5}
                  type="number"
                  value={customGrowthPercent}
                />
              </Field>
              <Field label="Horizon months">
                <Input
                  inputMode="numeric"
                  min={12}
                  max={240}
                  onChange={(event) => {
                    setProjectionMonthsOverride(Number(event.target.value) || 12);
                  }}
                  step={6}
                  type="number"
                  value={projectionMonths}
                />
              </Field>
              <Field label="AUD/USD rate">
                <Input
                  inputMode="decimal"
                  min={0.01}
                  onChange={(event) => {
                    setAudUsdRateOverride(Number(event.target.value) || 0);
                  }}
                  step={0.001}
                  type="number"
                  value={audUsdRate}
                />
              </Field>
              <Field label="Dividend yield %">
                <Input
                  disabled={!includeDividends}
                  inputMode="decimal"
                  min={0}
                  onChange={(event) => {
                    setDividendYieldPercentOverride(Number(event.target.value) || 0);
                  }}
                  step={0.1}
                  type="number"
                  value={dividendYieldPercent}
                />
              </Field>
              <div className="flex min-h-16 items-center justify-between gap-4 rounded-lg border bg-background px-3 py-2">
                <div>
                  <Label className="text-sm font-medium">Include dividends</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Uses projected cash dividends in the forward path.
                  </p>
                </div>
                <Switch
                  checked={includeDividends}
                  onCheckedChange={(checked) => {
                    setIncludeDividendsOverride(checked);
                  }}
                />
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
              <AssumptionNote
                icon={<Wallet className="h-4 w-4" />}
                title="Selected deposit"
                text={`${displayAudValue(Math.max(0, selectedMonthlyContributionAud))}/month from ${contributionModeLabel(contributionMode).toLowerCase()}.`}
              />
              <AssumptionNote
                icon={<TrendingUp className="h-4 w-4" />}
                title="Growth case"
                text={`${selectedScenarioLabel}: ${annualGrowthRatePercent.toFixed(1)}% annual price growth. ${scenario === "custom" ? "User-set assumption." : SCENARIOS[scenario].description}`}
              />
              <AssumptionNote
                icon={<CircleDollarSign className="h-4 w-4" />}
                title="FX and quote"
                text={`A$1 = US$${safeAudUsdRate.toFixed(3)}. Current ${settings.baseTicker} price is ${formatCurrency(currentPriceUsd, "USD")} (${quote?.provider ?? "cached"}).`}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>{ticker} Projection</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {ticker} view: Had I Held, rebuilt {ticker}, and the remaining portfolio gap under the selected model.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{selectedScenarioLabel}</Badge>
              <Badge variant="outline">{displayAudValue(Math.max(0, selectedMonthlyContributionAud))}/month</Badge>
              <Badge variant={selectedProjection.catchUpDate ? "success" : "warning"}>
                {selectedProjection.catchUpDate ? "Catch-up projected" : "Gap remains"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <ProjectionChart data={selectedProjection.points} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Portfolio Scenario Check</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Compares the live {scenarioComparison.benchmarkTicker} benchmark against a ledger-only portfolio forecast.
                Each holding uses its rolling three active trading-day return across the remaining market days; unrecorded deposits are excluded.
              </p>
            </div>
            <Badge
              variant={
                scenarioComparison.status === "above target"
                  ? "success"
                  : scenarioComparison.status === "below target"
                    ? "warning"
                    : "secondary"
              }
            >
              {scenarioComparison.status}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-4">
              <ScenarioStat
                label="AAPL snapshot value"
                value={formatCurrency(scenarioComparison.benchmarkSnapshotValueUsd, "USD")}
                note={`${formatShares(scenarioComparison.benchmarkShares)} shares at ${formatCurrency(scenarioComparison.benchmarkAnchorPriceUsd, "USD")} on the plan snapshot.`}
              />
              <ScenarioStat
                label="AAPL benchmark target"
                value={formatCurrency(scenarioComparison.benchmarkProjectedValueUsd, "USD")}
                note={`${scenarioComparison.benchmarkGrowthPercent.toFixed(1)}% change since the snapshot.`}
              />
              <ScenarioStat
                label="Portfolio mix target"
                value={formatCurrency(scenarioComparison.portfolioProjectedValueUsd, "USD")}
                note={`${scenarioComparison.holdings.length} ledger-held ticker${scenarioComparison.holdings.length === 1 ? "" : "s"}; ${scenarioComparison.remainingTradingDays} market days remain.`}
              />
              <ScenarioStat
                label="Projected difference"
                value={formatCurrency(Math.abs(scenarioComparison.projectedDifferenceUsd), "USD")}
                note={`${scenarioComparison.projectedDifferencePercent >= 0 ? "+" : ""}${scenarioComparison.projectedDifferencePercent.toFixed(2)}% vs benchmark.`}
              />
            </div>
            <div className="mt-4 flex flex-col gap-3 rounded-lg border bg-background p-4 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-medium text-foreground">
                  {scenarioComparison.status === "above target"
                    ? "The combined portfolio is ahead of the benchmark."
                    : scenarioComparison.status === "below target"
                      ? "The combined portfolio is behind the benchmark."
                      : "The combined portfolio is on target."}
                </p>
                <p className="mt-1">Projected difference: {formatCurrency(Math.abs(scenarioComparison.projectedDifferenceUsd), "USD")}.</p>
              </div>
              <p className="max-w-xl">
                Assumption: this uses only ledger holdings, excludes future unrecorded deposits, dividends and cash, and ignores unchanged-price days in the rolling return.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ticker} Projection Comparison</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              The guide can now move in fine increments, so this compares neutral, guided, selected, and school-repayment-aware deposits against the catch-up target for {ticker}.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 lg:grid-cols-2">
              {comparisonRows.map((row) => (
                <ProjectionComparisonRow
                  key={row.key}
                  displayAudValue={displayAudValue}
                  displayUsdValue={displayUsdValue}
                  monthlyAud={row.monthlyAud}
                  note={row.note}
                  projection={row.projection}
                  title={row.label}
                />
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Main Deposit Guide</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Summary view replacing the raw source list: positives, negatives, neutral items, and why the score moved.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <GuideStat
                  label="News signal"
                  value={newsSignalLabel(guideNewsDigest.signal)}
                  note={`${guideNewsDigest.articleCount} ${newsArticleLabel(
                    guideNewsDigest.analysisMode,
                  )}s across ${newsPublisherText(guideNewsDigest)}.`}
                />
                <GuideStat
                  label="Balance"
                  value={`${guideNewsDigest.positiveArticleCount ?? 0} / ${guideNewsDigest.negativeArticleCount ?? 0} / ${guideNewsDigest.neutralArticleCount ?? 0}`}
                  note="Positive, negative, and neutral counts."
                />
                <GuideStat
                  label="Materiality"
                  value={`${guideNewsDigest.materialArticleCount ?? 0} material`}
                  note={`${guideNewsDigest.highMaterialityCount ?? 0} high-impact, ${guideNewsDigest.escalatedCount ?? 0} escalated.`}
                />
                <GuideStat
                  label="Guide score (internal)"
                  value={depositGuide.signalScore.toFixed(2)}
                  note={`${formatSignedPercent(depositGuide.adjustmentPercent)} adjustment, not a percent score.`}
                />
              </div>
              <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                Confidence tells you how solid the evidence is, signal mix shows the counted
                positive/negative/neutral split, material items are the headlines that can move
                revenue, margins, regulation, or product competitiveness, and suggested tilt is the
                final lean after those inputs are blended.
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {guideReviewSummary.map((section) => (
                  <SummarySection key={section.label} section={section} />
                ))}
              </div>
              {codexReviewDetails?.unresolvedThemes?.length ? (
                <div className="rounded-lg border bg-background p-4">
                  <p className="text-sm font-medium">Unresolved themes</p>
                  <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {codexReviewDetails.unresolvedThemes.slice(0, 4).map((theme) => (
                      <p key={theme}>{theme}</p>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Market Data Health</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                The guide uses cached/current price points for {ticker}; recent fixes fetch a seven-month lookback.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <GuideStat
                  label="Usable price points"
                  value={String(marketCacheSummary.usablePriceCount)}
                  note={`${marketCacheSummary.allPriceCount} total cached ${ticker} price rows.`}
                />
                <GuideStat
                  label="Latest price row"
                  value={marketCacheSummary.latestPriceDate ? formatDisplayDate(marketCacheSummary.latestPriceDate) : "None"}
                  note={
                    marketCacheSummary.latestPriceProvider
                      ? `${marketCacheSummary.latestPriceProvider}, ${formatCurrency(
                          marketCacheSummary.latestPriceUsd ?? 0,
                          "USD",
                        )}`
                      : "No cached price-history row found."
                  }
                />
                <GuideStat
                  label="Providers"
                  value={
                    marketCacheSummary.providers.length > 0
                      ? marketCacheSummary.providers.join(", ")
                      : "None"
                  }
                  note={
                    marketCacheSummary.latestQuoteProvider
                      ? `Latest quote: ${marketCacheSummary.latestQuoteProvider}`
                      : "No cached quote found."
                  }
                />
              </div>
              <div className="space-y-2 text-sm text-muted-foreground">
                {depositGuide.reasons.slice(0, 3).map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={isRefreshing}
                  onClick={() => refreshMarketData(true)}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                  Refresh prices
                </Button>
                <Button
                  disabled={isClearingMarketCache || isRefreshing}
                  onClick={clearAndRefreshMarketCache}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw
                    className={cn(
                      "h-4 w-4",
                      (isClearingMarketCache || isRefreshing) && "animate-spin",
                    )}
                  />
                  Clear and refresh cache
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {settings.studyLoanEnabled ? (
          <Card>
            <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <CardTitle>School Repayment Decision</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Cash-flow-adjusted comparison of keeping the old {ticker} holding versus paying off school debt and rebuilding {ticker}.
                </p>
              </div>
              <Badge variant={currentMonthSchoolDecision.verdict === "cashOut" ? "success" : "warning"}>
                {schoolVerdictLabel(currentMonthSchoolDecision)}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 md:grid-cols-4">
                <GuideStat
                  label="Decision advantage"
                  value={formatCurrency(Math.abs(currentMonthSchoolDecision.differenceAud), "AUD")}
                  note={`${schoolVerdictLabel(currentMonthSchoolDecision)} as of ${formatDisplayDate(
                    currentMonthSchoolDecision.date,
                  )}.`}
                />
                <GuideStat
                  label={`Keep ${ticker} net`}
                  value={formatCurrency(currentMonthSchoolDecision.keepAaplNetAud, "AUD")}
                  note={`After this month's ${formatCurrency(
                    activeStudyLoanMonthlyAud,
                    "AUD",
                  )} repayment.`}
                />
                <GuideStat
                  label="Pay off + rebuild net"
                  value={formatCurrency(currentMonthSchoolDecision.cashOutRebuildNetAud, "AUD")}
                  note={`${formatCurrency(
                    currentMonthSchoolDecision.currentMonthDepositTopUpAud,
                    "AUD",
                  )} top-up still modelled this month.`}
                />
                <GuideStat
                  label="School-decision break-even"
                  value={schoolDecisionCrossDate ? formatDisplayDate(schoolDecisionCrossDate) : "Not in horizon"}
                  note={`Debt-adjusted date. School payoff range: ${schoolPayoffRange}.`}
                />
              </div>
              <SchoolDecisionChart data={schoolDecisionTimeline} />
              {freedRepaymentAud > 0 ? (
                <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                  Redirected school repayment floor is {formatCurrency(freedRepaymentAud, "AUD")}
                  /month. Over this horizon that adds about{" "}
                  {formatCurrency(freedRepaymentValue.futureValueAud, "AUD")} of projected {ticker}
                  value under the active assumptions.
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}

function buildProjection({
  monthlyContributionAud,
  metrics,
  months,
  audUsdRate,
  annualGrowthRatePercent,
  dividendYieldPercent,
  includeDividends,
  currentPriceUsd,
}: {
  monthlyContributionAud: number;
  metrics: ReturnType<typeof calculateCatchUpMetrics>;
  months: number;
  audUsdRate: number;
  annualGrowthRatePercent: number;
  dividendYieldPercent: number;
  includeDividends: boolean;
  currentPriceUsd: number;
}) {
  return projectCatchUp({
    startDate: todayIso(),
    months,
    monthlyContributionAud,
    audUsdRate,
    annualGrowthRatePercent,
    annualDividendYieldPercent: includeDividends ? dividendYieldPercent : 0,
    includeDividends,
    startingPriceUsd: currentPriceUsd,
    hadHeldShares: metrics.equivalentSharesToday,
    rebuildShares: metrics.currentRebuildShares,
    rebuildCashUsd: metrics.cashBalanceUsd,
    hadHeldDividendCashUsd: metrics.hadHeldDividendCashUsd,
    rebuildDividendCashUsd: metrics.rebuildDividendCashUsd,
  });
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function AssumptionNote({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm shadow-slate-950/5 backdrop-blur-sm">
      <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function ProjectionComparisonRow({
  title,
  note,
  monthlyAud,
  projection,
  displayAudValue,
  displayUsdValue,
}: {
  title: string;
  note: string;
  monthlyAud: number;
  projection: ProjectionResult;
  displayAudValue: (value: number) => string;
  displayUsdValue: (value: number) => string;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{note}</p>
        </div>
        <Badge variant="outline">{displayAudValue(monthlyAud)}/month</Badge>
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <Detail label="Catch-up date" value={formatCatchUpDate(projection.catchUpDate)} />
        <Detail label="End gap" value={formatGap(projection.projectedGapUsd, displayUsdValue)} />
        <Detail label="Required" value={displayAudValue(projection.requiredMonthlyContributionAud)} />
      </div>
    </div>
  );
}

function GuideStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm shadow-slate-950/5 backdrop-blur-sm">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 break-words text-lg font-semibold">{value}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{note}</p>
    </div>
  );
}

function ScenarioStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-lg font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function SummarySection({
  section,
}: {
  section: { label: string; className: string; items: string[] };
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm shadow-slate-950/5 backdrop-blur-sm">
      <p className={cn("font-display text-sm font-semibold", section.className)}>{section.label}</p>
      <div className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
        {section.items.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}

function buildGuideReviewSummary({
  digest,
  codexReview,
  guide,
}: {
  digest: DepositGuideNewsInput;
  codexReview?: CodexReviewDetails;
  guide: ReturnType<typeof calculateDepositGuide>;
}) {
  const thesisSignals = codexReview?.longTermThesisSignals ?? [];
  const positiveItems = thesisSignals
    .filter((signal) => signal.direction === "positive")
    .map(formatThesisSignal)
    .slice(0, 3);
  const negativeItems = thesisSignals
    .filter((signal) => signal.direction === "negative")
    .map(formatThesisSignal)
    .slice(0, 3);
  const neutralItems = [
    ...thesisSignals
      .filter((signal) => signal.direction !== "positive" && signal.direction !== "negative")
      .map(formatThesisSignal),
    ...(codexReview?.staleOrNoisyItems ?? []).map((item) => item.reason).filter(isPresent),
  ].slice(0, 4);
  const scoreItems = [
    `Guide score ${guide.signalScore.toFixed(
      2,
    )} is an internal tilt score, not a percent. In the 10-point framing, 5.0 is neutral, higher leans into a bigger monthly deposit, and lower leans into a lighter month. This score produced ${formatSignedPercent(
      guide.adjustmentPercent,
    )} versus neutral and a target of ${formatCurrency(guide.recommendedDepositAud, "AUD")}.`,
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
      label: "Why This Score",
      className: "text-primary",
      items: scoreItems.length > 0 ? scoreItems : guide.reasons.slice(0, 2),
    },
  ];
}

function formatThesisSignal(signal: CodexReviewTheme) {
  const materiality = signal.materiality ? `${signal.materiality} impact` : "reviewed";
  return `${signal.theme ?? "Reviewed theme"} (${materiality}): ${
    signal.judgement ?? "No extra judgement was saved for this theme."
  }`;
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
    .filter((item) => item.symbol === normalizedSymbol)
    .sort((left, right) => (right.asOf || "").localeCompare(left.asOf || ""))[0];
  const providers = Array.from(new Set(usablePrices.map((price) => price.provider))).sort();

  return {
    allPriceCount: allSymbolPrices.length,
    usablePriceCount: usablePrices.length,
    latestPriceDate: latestPrice?.date,
    latestPriceProvider: latestPrice?.provider,
    latestPriceUsd: latestPrice?.adjustedCloseUsd ?? latestPrice?.closeUsd,
    latestQuoteProvider: latestQuote?.provider,
    providers,
  };
}

function calculateCurrentMonthContributionAud(
  contributions: Array<{
    date: string;
    currencyEntered: string;
    amount: number;
    amountUsd: number;
  }>,
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

function formatCatchUpDate(date?: string) {
  return date ? formatDisplayDate(date) : "Not in horizon";
}

function formatGap(valueUsd: number, displayUsdValue: (value: number) => string) {
  if (valueUsd <= 0) {
    return `${displayUsdValue(Math.abs(valueUsd))} ahead`;
  }
  return `${displayUsdValue(valueUsd)} gap`;
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

function contributionModeLabel(mode: ContributionMode) {
  if (mode === "guide") {
    return "This month guide";
  }
  if (mode === "plan") {
    return "Normal plan";
  }
  return "Custom monthly deposit";
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

function schoolVerdictLabel(decision: CurrentMonthSchoolDecision) {
  if (decision.verdict === "cashOut") {
    return "Pay off + rebuild ahead";
  }
  if (decision.verdict === "keepAapl") {
    return "Keep the plan on track";
  }
  return "Roughly even";
}

function formatSignedPercent(value: number) {
  if (Math.abs(value) < 0.01) {
    return "0.00%";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value?.trim());
}
