import { calculateCurrentRebuildShares } from "@/lib/domain/calculations";
import { monthsElapsedInclusive } from "@/lib/domain/dates";
import { decimal, roundMoney, roundPercent, roundShares } from "@/lib/domain/money";
import type { CachedDailyPrice, CachedQuote, CachedSplit, Trade } from "@/lib/storage/types";

export type PortfolioScenarioHoldingComparison = {
  ticker: string;
  shares: number;
  currentPriceUsd: number;
  anchorPriceUsd: number;
  anchorDate: string;
  growthMultiplier: number;
  projectedGrowthPercent: number;
  currentValueUsd: number;
  projectedValueUsd: number;
};

export type PortfolioScenarioComparisonInput = {
  benchmarkTicker: string;
  benchmarkShares: number;
  trades: Trade[];
  dailyPrices: CachedDailyPrice[];
  quotes: CachedQuote[];
  splits: CachedSplit[];
  asOfDate: string;
  anchorDate: string;
  projectionMonths: number;
  portfolioContributionAud?: number;
  audUsdRate?: number;
  benchmarkCurrentPriceUsd?: number;
  benchmarkTolerancePercent?: number;
};

export type PortfolioScenarioComparison = {
  benchmarkTicker: string;
  benchmarkShares: number;
  benchmarkCurrentPriceUsd: number;
  benchmarkAnchorPriceUsd: number;
  benchmarkGrowthMultiplier: number;
  benchmarkGrowthPercent: number;
  benchmarkProjectedGrowthPercent: number;
  benchmarkCurrentValueUsd: number;
  benchmarkProjectedValueUsd: number;
  portfolioContributionTotalAud: number;
  portfolioContributionTotalUsd: number;
  portfolioGrowthMultiplier: number;
  portfolioProjectedValueUsd: number;
  projectedDifferenceUsd: number;
  projectedDifferencePercent: number;
  status: "above target" | "on target" | "below target";
  tolerancePercent: number;
  holdings: PortfolioScenarioHoldingComparison[];
  anchorDate: string;
  projectionMonths: number;
  asOfDate: string;
};

export function calculatePortfolioScenarioComparison(
  input: PortfolioScenarioComparisonInput,
): PortfolioScenarioComparison {
  const benchmarkTicker = input.benchmarkTicker.toUpperCase();
  const asOfDate = input.asOfDate;
  const anchorDate = input.anchorDate;
  const projectionMonths = Math.max(0, input.projectionMonths);
  const tolerancePercent = Math.max(0, input.benchmarkTolerancePercent ?? 1);
  const benchmarkShares = Math.max(0, input.benchmarkShares);

  const benchmarkCurrentPriceUsd = resolvePriceUsd(
    input.dailyPrices,
    benchmarkTicker,
    asOfDate,
    input.benchmarkCurrentPriceUsd,
  );
  const benchmarkAnchorPriceUsd = resolvePriceUsd(
    input.dailyPrices,
    benchmarkTicker,
    anchorDate,
    benchmarkCurrentPriceUsd,
  );
  const benchmarkGrowthMultiplier =
    benchmarkAnchorPriceUsd > 0 ? benchmarkCurrentPriceUsd / benchmarkAnchorPriceUsd : 1;
  const benchmarkElapsedMonths = Math.max(1, monthsElapsedInclusive(anchorDate, asOfDate));
  const projectionRemainingMonths = Math.max(0, projectionMonths - benchmarkElapsedMonths);
  const benchmarkProjectedGrowthPercent =
    roundPercent((benchmarkGrowthMultiplier - 1) * (projectionRemainingMonths / benchmarkElapsedMonths) * 100, 2);
  const benchmarkProjectionMultiplier = Math.max(0, 1 + benchmarkProjectedGrowthPercent / 100);
  const benchmarkCurrentValueUsd = roundMoney(decimal(benchmarkShares).mul(benchmarkCurrentPriceUsd));
  const benchmarkProjectedValueUsd = roundMoney(
    decimal(benchmarkCurrentValueUsd).mul(benchmarkProjectionMultiplier),
  );

  const holdings = buildHoldingComparisons({
    trades: input.trades,
    splits: input.splits,
    dailyPrices: input.dailyPrices,
    quotes: input.quotes,
    asOfDate,
    anchorDate,
    projectionRemainingMonths,
  });
  const holdingsCurrentValueUsd = roundMoney(
    holdings.reduce((total, holding) => total.plus(holding.currentValueUsd), decimal(0)),
  );
  const holdingsProjectedValueUsd = roundMoney(
    holdings.reduce((total, holding) => total.plus(holding.projectedValueUsd), decimal(0)),
  );
  const portfolioGrowthMultiplier =
    holdingsCurrentValueUsd > 0
      ? roundPercent(decimal(holdingsProjectedValueUsd).div(holdingsCurrentValueUsd), 4)
      : benchmarkProjectionMultiplier;
  const portfolioContributionTotalAud = roundMoney(
    decimal(Math.max(0, input.portfolioContributionAud ?? 0)).mul(projectionMonths),
  );
  const portfolioContributionTotalUsd = roundMoney(
    decimal(portfolioContributionTotalAud).mul(Math.max(0, input.audUsdRate ?? 1)),
  );
  const portfolioProjectedValueUsd =
    input.portfolioContributionAud !== undefined
      ? roundMoney(decimal(portfolioContributionTotalUsd).mul(portfolioGrowthMultiplier))
      : holdingsProjectedValueUsd;

  const projectedDifferenceUsd = roundMoney(
    decimal(portfolioProjectedValueUsd).minus(benchmarkProjectedValueUsd),
  );
  const projectedDifferencePercent =
    benchmarkProjectedValueUsd > 0
      ? roundPercent(
          decimal(projectedDifferenceUsd).div(benchmarkProjectedValueUsd).mul(100),
          2,
        )
      : 0;
  const toleranceBandUsd = roundMoney(decimal(benchmarkProjectedValueUsd).mul(tolerancePercent / 100));
  const status =
    Math.abs(projectedDifferenceUsd) <= toleranceBandUsd
      ? "on target"
      : projectedDifferenceUsd > 0
        ? "above target"
        : "below target";

  return {
    benchmarkTicker,
    benchmarkShares: roundShares(benchmarkShares),
    benchmarkCurrentPriceUsd: roundMoney(benchmarkCurrentPriceUsd),
    benchmarkAnchorPriceUsd: roundMoney(benchmarkAnchorPriceUsd),
    benchmarkGrowthMultiplier: roundPercent(benchmarkGrowthMultiplier, 4),
    benchmarkGrowthPercent: roundPercent((benchmarkGrowthMultiplier - 1) * 100, 2),
    benchmarkProjectedGrowthPercent,
    benchmarkCurrentValueUsd,
    benchmarkProjectedValueUsd,
    portfolioContributionTotalAud,
    portfolioContributionTotalUsd,
    portfolioGrowthMultiplier,
    portfolioProjectedValueUsd,
    projectedDifferenceUsd,
    projectedDifferencePercent,
    status,
    tolerancePercent,
    holdings,
    anchorDate,
    projectionMonths,
    asOfDate,
  };
}

function buildHoldingComparisons({
  trades,
  splits,
  dailyPrices,
  quotes,
  asOfDate,
  anchorDate,
  projectionRemainingMonths,
}: {
  trades: Trade[];
  splits: CachedSplit[];
  dailyPrices: CachedDailyPrice[];
  quotes: CachedQuote[];
  asOfDate: string;
  anchorDate: string;
  projectionRemainingMonths: number;
}) {
  const tickers = Array.from(new Set(trades.map((trade) => trade.ticker.toUpperCase()))).sort();
  return tickers
    .map((ticker) => {
      const shares = calculateCurrentRebuildShares(trades, splits, ticker, asOfDate);
      if (shares <= 0) {
        return undefined;
      }
      const currentPriceUsd =
        resolvePriceUsd(dailyPrices, ticker, asOfDate) || resolveQuoteUsd(quotes, ticker);
      const firstBuyDate = trades
        .filter((trade) => trade.ticker.toUpperCase() === ticker && trade.side === "BUY")
        .map((trade) => trade.date)
        .sort((left, right) => left.localeCompare(right))[0];
      const holdingAnchorDate =
        firstBuyDate && firstBuyDate > anchorDate ? firstBuyDate : anchorDate;
      const marketAnchorPriceUsd = resolvePriceUsd(dailyPrices, ticker, holdingAnchorDate);
      const anchorPriceUsd =
        marketAnchorPriceUsd > 0
          ? marketAnchorPriceUsd
          : resolveBuyAnchorPriceUsd(trades, ticker, holdingAnchorDate, asOfDate) || currentPriceUsd;
      const growthMultiplier = anchorPriceUsd > 0 ? currentPriceUsd / anchorPriceUsd : 1;
      const holdingElapsedMonths = Math.max(1, monthsElapsedInclusive(holdingAnchorDate, asOfDate));
      const projectedGrowthPercent = roundPercent(
        (growthMultiplier - 1) * (projectionRemainingMonths / holdingElapsedMonths) * 100,
        2,
      );
      // A short observation window can extrapolate a temporary loss past -100%.
      // Keep the holding's forward value anchored to its live value in that case;
      // a real holding should not disappear from the mix or comparison.
      const projectedMultiplier = Math.max(1, 1 + projectedGrowthPercent / 100);
      const currentValueUsd = roundMoney(decimal(shares).mul(currentPriceUsd));
      const projectedValueUsd = roundMoney(decimal(currentValueUsd).mul(projectedMultiplier));

      return {
        ticker,
        shares: roundShares(shares),
        currentPriceUsd: roundMoney(currentPriceUsd),
        anchorPriceUsd: roundMoney(anchorPriceUsd),
        anchorDate: holdingAnchorDate,
        growthMultiplier: roundPercent(growthMultiplier, 4),
        projectedGrowthPercent,
        currentValueUsd,
        projectedValueUsd,
      };
    })
    .filter(isPresent)
    .sort((left, right) => right.projectedValueUsd - left.projectedValueUsd);
}

function resolvePriceUsd(
  dailyPrices: CachedDailyPrice[],
  ticker: string,
  date: string,
  fallbackPriceUsd?: number,
) {
  const normalizedTicker = ticker.toUpperCase();
  const candidate = dailyPrices
    .filter((price) => price.symbol.toUpperCase() === normalizedTicker && price.date <= date)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  return roundMoney(candidate?.adjustedCloseUsd ?? candidate?.closeUsd ?? fallbackPriceUsd ?? 0);
}

function resolveQuoteUsd(quotes: CachedQuote[], ticker: string) {
  const normalizedTicker = ticker.toUpperCase();
  const candidate = quotes
    .filter((quote) => quote.symbol.toUpperCase() === normalizedTicker)
    .sort((left, right) => {
      const leftTime = left.asOf || "";
      const rightTime = right.asOf || "";
      return rightTime.localeCompare(leftTime);
    })[0];
  return roundMoney(candidate?.priceUsd ?? 0);
}

function resolveBuyAnchorPriceUsd(
  trades: Trade[],
  ticker: string,
  anchorDate: string,
  asOfDate: string,
) {
  const buyTrades = trades.filter(
    (trade) =>
      trade.ticker.toUpperCase() === ticker && trade.side === "BUY" && trade.date <= asOfDate,
  );
  if (buyTrades.length === 0) {
    return 0;
  }

  const relevantTrades = buyTrades.filter((trade) => trade.date <= anchorDate);
  const sourceTrades = relevantTrades.length > 0 ? relevantTrades : buyTrades;
  const totalShares = sourceTrades.reduce((total, trade) => total + Math.max(0, trade.shares), 0);
  if (totalShares <= 0) {
    return 0;
  }

  const totalCostUsd = sourceTrades.reduce(
    (total, trade) => total + Math.max(0, trade.shares) * trade.pricePerShareUsd,
    0,
  );
  return roundMoney(totalCostUsd / totalShares);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
