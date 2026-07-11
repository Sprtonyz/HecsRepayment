import { describe, expect, it } from "vitest";
import { calculatePortfolioScenarioComparison } from "@/lib/domain/portfolioScenario";

describe("portfolio scenario comparison", () => {
  it("uses the fixed benchmark snapshot and live price without extrapolating AAPL", () => {
    const result = calculatePortfolioScenarioComparison({
      benchmarkTicker: "AAPL",
      benchmarkShares: 2,
      trades: [
        {
          id: "trade-spcx",
          date: "2026-06-15",
          ticker: "SPCX",
          side: "BUY",
          shares: 4.462,
          pricePerShare: 171.99,
          currencyEntered: "USD",
          fxRateToUsd: 1,
          pricePerShareUsd: 171.99,
          grossAmountUsd: 767.41,
          feesUsd: 0,
          totalAmountUsd: 767.41,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
      ],
      dailyPrices: [
        { symbol: "AAPL", date: "2026-05-01", closeUsd: 10, provider: "manual" },
        { symbol: "AAPL", date: "2026-06-20", closeUsd: 12, provider: "manual" },
        { symbol: "SPCX", date: "2026-06-20", closeUsd: 181.69, provider: "manual" },
      ],
      splits: [],
      asOfDate: "2026-06-20",
      anchorDate: "2026-05-01",
      projectionMonths: 53,
      portfolioContributionAud: 600,
      audUsdRate: 0.67,
      benchmarkTolerancePercent: 0,
    });

    expect(result.benchmarkSnapshotValueUsd).toBe(20);
    expect(result.benchmarkCurrentValueUsd).toBe(24);
    expect(result.benchmarkProjectedValueUsd).toBe(24);
    expect(result.benchmarkGrowthPercent).toBe(20);
    expect(result.benchmarkProjectedGrowthPercent).toBe(20);
    expect(result.portfolioContributionTotalAud).toBe(0);
    expect(result.portfolioContributionTotalUsd).toBe(0);
    expect(result.portfolioProjectedValueUsd).toBe(result.portfolioCurrentValueUsd);
    expect(result.portfolioGrowthMultiplier).toBe(1);

    const spcx = result.holdings.find((holding) => holding.ticker === "SPCX");
    expect(spcx).toBeDefined();
    expect(spcx?.anchorDate).toBe("2026-06-15");
    expect(spcx?.anchorPriceUsd).toBe(171.99);
    expect(spcx?.growthMultiplier).toBeGreaterThan(1);
    expect(spcx?.activeTradingDaysUsed).toBe(0);
    expect(spcx?.projectedValueUsd).toBe(spcx?.currentValueUsd);
  });

  it("projects ledger holdings from the last three active daily price moves only", () => {
    const result = calculatePortfolioScenarioComparison({
      benchmarkTicker: "AAPL",
      benchmarkShares: 1,
      trades: [
        trade("spcx-day-one", "2026-05-01", "SPCX", 2, 1),
        trade("spcx-day-two", "2026-05-02", "SPCX", 2, 2),
      ],
      dailyPrices: [
        { symbol: "AAPL", date: "2026-05-01", closeUsd: 10, provider: "manual" },
        { symbol: "AAPL", date: "2026-05-03", closeUsd: 10, provider: "manual" },
        { symbol: "SPCX", date: "2026-05-01", closeUsd: 1, provider: "manual" },
        { symbol: "SPCX", date: "2026-05-02", closeUsd: 1, provider: "manual" },
        { symbol: "SPCX", date: "2026-05-03", closeUsd: 2, provider: "manual" },
        { symbol: "SPCX", date: "2026-05-04", closeUsd: 2, provider: "manual" },
        { symbol: "SPCX", date: "2026-05-05", closeUsd: 3, provider: "manual" },
      ],
      quotes: [],
      splits: [],
      asOfDate: "2026-05-05",
      anchorDate: "2026-05-01",
      projectionMonths: 3,
      benchmarkTolerancePercent: 0,
    });
    const spcx = result.holdings[0];

    expect(spcx.currentValueUsd).toBe(12);
    expect(spcx.activeTradingDaysUsed).toBe(2);
    expect(spcx.rollingDailyReturnPercent).toBe(75);
    expect(spcx.remainingTradingDays).toBe(42);
    const expectedProjectedValue = Number((12 * Math.pow(1.75, 42)).toFixed(2));
    expect(spcx.projectedValueUsd).toBe(expectedProjectedValue);
    expect(result.portfolioProjectedValueUsd).toBe(expectedProjectedValue);
    expect(result.projectedDifferenceUsd).toBe(expectedProjectedValue - 10);
  });

  it("uses the first market close after a weekend or holiday snapshot date", () => {
    const result = calculatePortfolioScenarioComparison({
      benchmarkTicker: "AAPL",
      benchmarkShares: 2,
      trades: [],
      dailyPrices: [
        { symbol: "AAPL", date: "2026-05-01", closeUsd: 10, provider: "manual" },
        { symbol: "AAPL", date: "2026-06-01", closeUsd: 12, provider: "manual" },
      ],
      quotes: [],
      splits: [],
      asOfDate: "2026-06-01",
      anchorDate: "2026-04-30",
      projectionMonths: 53,
      benchmarkTolerancePercent: 0,
    });

    expect(result.benchmarkAnchorPriceUsd).toBe(10);
    expect(result.benchmarkGrowthPercent).toBe(20);
  });

  it("uses the first buy price as the anchor when a holding starts after May 19", () => {
    const result = calculatePortfolioScenarioComparison({
      benchmarkTicker: "AAPL",
      benchmarkShares: 1,
      trades: [
        {
          id: "trade-spcx",
          date: "2026-06-15",
          ticker: "SPCX",
          side: "BUY",
          shares: 4.462,
          pricePerShare: 171.99,
          currencyEntered: "USD",
          fxRateToUsd: 1,
          pricePerShareUsd: 171.99,
          grossAmountUsd: 767.41,
          feesUsd: 0,
          totalAmountUsd: 767.41,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
      ],
      dailyPrices: [{ symbol: "SPCX", date: "2026-06-20", closeUsd: 181.69, provider: "manual" }],
      splits: [],
      asOfDate: "2026-06-20",
      anchorDate: "2026-05-19",
      projectionMonths: 53,
      benchmarkTolerancePercent: 0,
    });

    const spcx = result.holdings[0];
    expect(spcx.ticker).toBe("SPCX");
    expect(spcx.anchorDate).toBe("2026-06-15");
    expect(spcx.anchorPriceUsd).toBe(171.99);
    expect(spcx.currentPriceUsd).toBe(181.69);
    expect(spcx.growthMultiplier).toBeCloseTo(1.0564, 4);
  });

  it("keeps a live holding in the mix when loss extrapolation would go below zero", () => {
    const result = calculatePortfolioScenarioComparison({
      benchmarkTicker: "AAPL",
      benchmarkShares: 1,
      trades: [
        {
          id: "trade-spcx",
          date: "2026-05-01",
          ticker: "SPCX",
          side: "BUY",
          shares: 5.462,
          pricePerShare: 171.99,
          currencyEntered: "USD",
          fxRateToUsd: 1,
          pricePerShareUsd: 171.99,
          grossAmountUsd: 939.82,
          feesUsd: 0,
          totalAmountUsd: 939.82,
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      dailyPrices: [
        { symbol: "AAPL", date: "2026-05-19", closeUsd: 100, provider: "manual" },
        { symbol: "AAPL", date: "2026-07-11", closeUsd: 100, provider: "manual" },
        { symbol: "SPCX", date: "2026-07-11", closeUsd: 147.56, provider: "manual" },
      ],
      splits: [],
      asOfDate: "2026-07-11",
      anchorDate: "2026-05-19",
      projectionMonths: 53,
      benchmarkTolerancePercent: 0,
    });

    const spcx = result.holdings[0];
    expect(spcx.shares).toBe(5.462);
    expect(spcx.currentValueUsd).toBeCloseTo(805.97, 2);
    expect(spcx.projectedValueUsd).toBe(spcx.currentValueUsd);
    expect(result.portfolioGrowthMultiplier).toBe(1);
  });
});

function trade(id: string, date: string, ticker: string, shares: number, pricePerShareUsd: number) {
  const grossAmountUsd = shares * pricePerShareUsd;
  return {
    id,
    date,
    ticker,
    side: "BUY" as const,
    shares,
    pricePerShare: pricePerShareUsd,
    currencyEntered: "USD" as const,
    fxRateToUsd: 1,
    pricePerShareUsd,
    grossAmountUsd,
    feesUsd: 0,
    totalAmountUsd: grossAmountUsd,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
  };
}
