"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addMonths, format, parseISO } from "date-fns";
import { toast } from "sonner";
import { nowIso, todayIso } from "@/lib/domain/dates";
import { roundMoney } from "@/lib/domain/money";
import { isQuoteCacheStale } from "@/lib/market-data/cache";
import { createDefaultSettings, createDemoSnapshot } from "@/lib/storage/demoData";
import { indexedDbAdapter } from "@/lib/storage/indexedDb";
import type {
  AppSettings,
  CachedDailyPrice,
  CachedDividend,
  CachedFxRate,
  CachedNewsAnalysis,
  CachedNewsArticle,
  CachedQuote,
  CachedSplit,
  Contribution,
  Currency,
  SaleEvent,
  TrackerSnapshot,
  Trade,
  TradeSide,
} from "@/lib/storage/types";

function uid(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function latestByDate<T extends { asOf?: string; date?: string; publishedAt?: string; cachedAt?: string }>(
  items: T[],
) {
  return [...items].sort((a, b) => {
    const left = a.asOf || a.date || a.cachedAt || a.publishedAt || "";
    const right = b.asOf || b.date || b.cachedAt || b.publishedAt || "";
    return right.localeCompare(left);
  })[0];
}

const TRACKER_DATA_CHANGED_EVENT = "tracker-data-changed";
const CORE_SNAPSHOT_STORAGE_KEY = "aaplCatchUpTracker:coreSnapshot";
const MIN_PRICE_HISTORY_POINTS = 7;
const MAX_PRICE_HISTORY_AGE_DAYS = 7;
const PRICE_HISTORY_LOOKBACK_MONTHS = 7;
const TICKER_ALIASES: Record<string, string> = {
  SPACEX: "SPCX",
};

function normalizeTickerSymbol(symbol?: string) {
  if (!symbol) {
    return symbol;
  }
  const upper = symbol.toUpperCase();
  return TICKER_ALIASES[upper] || upper;
}

function notifyTrackerDataChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TRACKER_DATA_CHANGED_EVENT));
  }
}

function isGeneratedManualQuote(quote: CachedQuote | undefined, isDemoMode?: boolean) {
  if (!quote || quote.provider !== "manual") {
    return false;
  }
  return (
    Boolean(isDemoMode) ||
    quote.sourceNote?.toLowerCase().includes("fallback") ||
    quote.sourceNote?.toLowerCase().includes("demo") ||
    false
  );
}

function emptySnapshot(): TrackerSnapshot {
  return {
    saleEvents: [],
    contributions: [],
    trades: [],
    quotes: [],
    dailyPrices: [],
    dividends: [],
    splits: [],
    fxRates: [],
    newsArticles: [],
    newsAnalyses: [],
  };
}

function normalizeTrackerSnapshot(snapshot: Partial<TrackerSnapshot>): TrackerSnapshot {
  return {
    ...emptySnapshot(),
    ...snapshot,
    settings: snapshot.settings
      ? {
          ...snapshot.settings,
          baseTicker: normalizeTickerSymbol(snapshot.settings.baseTicker) || snapshot.settings.baseTicker,
        }
      : undefined,
    saleEvents: (snapshot.saleEvents || []).map((saleEvent) => ({
      ...saleEvent,
      ticker: normalizeTickerSymbol(saleEvent.ticker) || saleEvent.ticker,
    })),
    contributions: snapshot.contributions || [],
    trades: (snapshot.trades || []).map((trade) => ({
      ...trade,
      ticker: normalizeTickerSymbol(trade.ticker) || trade.ticker,
    })),
    quotes: (snapshot.quotes || []).map((quote) => ({
      ...quote,
      symbol: normalizeTickerSymbol(quote.symbol) || quote.symbol,
    })),
    dailyPrices: (snapshot.dailyPrices || []).map((price) => ({
      ...price,
      symbol: normalizeTickerSymbol(price.symbol) || price.symbol,
    })),
    dividends: (snapshot.dividends || []).map((dividend) => ({
      ...dividend,
      symbol: normalizeTickerSymbol(dividend.symbol) || dividend.symbol,
    })),
    splits: (snapshot.splits || []).map((split) => ({
      ...split,
      symbol: normalizeTickerSymbol(split.symbol) || split.symbol,
    })),
    fxRates: snapshot.fxRates || [],
    newsArticles: (snapshot.newsArticles || []).map((article) => ({
      ...article,
      symbol: normalizeTickerSymbol(article.symbol) || article.symbol,
    })),
    newsAnalyses: (snapshot.newsAnalyses || []).map((analysis) => ({
      ...analysis,
      symbol: normalizeTickerSymbol(analysis.symbol) || analysis.symbol,
    })),
  };
}

function getCoreSnapshotUpdatedAt(snapshot: Partial<TrackerSnapshot>) {
  const timestamps = [
    snapshot.settings?.updatedAt,
    ...(snapshot.saleEvents || []).map((item) => item.updatedAt),
    ...(snapshot.contributions || []).map((item) => item.updatedAt),
    ...(snapshot.trades || []).map((item) => item.updatedAt),
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  return timestamps.length ? Math.max(...timestamps) : 0;
}

function hasCoreTrackerData(snapshot: Partial<TrackerSnapshot>) {
  return Boolean(
    snapshot.settings &&
      ((snapshot.saleEvents?.length || 0) > 0 ||
        (snapshot.contributions?.length || 0) > 0 ||
        (snapshot.trades?.length || 0) > 0),
  );
}

function pickCoreTrackerSnapshot(snapshot: TrackerSnapshot): Partial<TrackerSnapshot> {
  return {
    settings: snapshot.settings,
    saleEvents: snapshot.saleEvents,
    contributions: snapshot.contributions,
    trades: snapshot.trades,
  };
}

type SetupInput = {
  sale: Omit<SaleEvent, "id" | "createdAt" | "updatedAt">;
  settings: Pick<
    AppSettings,
    | "displayCurrency"
    | "planMonthlyContributionAud"
    | "planStartDate"
    | "planYears"
    | "includeDividends"
    | "dividendMode"
    | "includeSplits"
    | "defaultPriceMode"
    | "marketDataProvider"
    | "manualCurrentPriceUsd"
  >;
};

type QuickTradeInput = {
  date: string;
  side: TradeSide;
  shares: number;
  pricePerShareUsd: number;
  fees: number;
  feeCurrency: Currency;
  feeFxRateToUsd: number;
  createMatchingContribution: boolean;
  contributionAmountAud: number;
  audUsdRate: number;
  notes?: string;
};

type ContributionWithPurchaseInput = {
  contribution: Omit<Contribution, "id" | "createdAt" | "updatedAt" | "amountUsd">;
  purchase?: {
    ticker?: string;
    shares: number;
    pricePerShareUsd: number;
    fees: number;
    feeCurrency: Currency;
    feeFxRateToUsd: number;
    notes?: string;
  };
};

type MarketHistoryApiPrice = {
  symbol: string;
  date: string;
  close: number;
  adjustedClose?: number;
  provider: CachedDailyPrice["provider"];
};

type MarketDividendApiEvent = {
  symbol: string;
  exDate: string;
  payDate?: string;
  amountPerShare: number;
  provider: CachedDividend["provider"];
};

type MarketSplitApiEvent = {
  symbol: string;
  date: string;
  ratio: number;
  fromFactor: number;
  toFactor: number;
  provider: CachedSplit["provider"];
};

type NewsApiArticle = Omit<CachedNewsArticle, "raw" | "cachedAt" | "collectedAt" | "lastFetchedAt">;
type NewsApiResponse = {
  articles?: NewsApiArticle[];
  automated?: boolean;
  aiAnalysisMode?: CachedNewsAnalysis["analysisMode"];
  sharedSync?: {
    enabled: boolean;
    synced: boolean;
    message?: string;
    reviewMonth?: string;
    articleCount?: number;
    sourceUpdatedAt?: string;
  };
};
type NewsAnalysisApiResponse = {
  enabled: boolean;
  mode?: CachedNewsAnalysis["analysisMode"];
  analyses?: CachedNewsAnalysis[];
  failures?: Array<{ articleId: string; message: string }>;
  message?: string;
};

type NewsRefreshResult = {
  articleCount: number;
  savedAnalysisCount: number;
  analysisFailureCount: number;
};

type SharedTrackerSnapshotResponse = {
  enabled: boolean;
  snapshot?: Partial<TrackerSnapshot>;
  updatedAt?: string;
  message?: string;
};

export type TrackerSyncState = {
  state: "loading" | "syncing" | "synced" | "local" | "empty" | "error";
  label: string;
  detail?: string;
  updatedAt?: string;
};

type SharedTrackerSyncResponse = {
  enabled?: boolean;
  synced: boolean;
  updatedAt?: string;
  message?: string;
};

async function fetchSharedTrackerSnapshot() {
  try {
    const response = await fetch("/api/tracker-sync", { cache: "no-store" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      return {
        enabled: false,
        message:
          payload?.error || `Shared tracker snapshot lookup failed with status ${response.status}.`,
      };
    }
    return (await response.json()) as SharedTrackerSnapshotResponse;
  } catch {
    return {
      enabled: false,
      message: "Shared tracker snapshot lookup failed.",
    };
  }
}

async function saveSharedTrackerSnapshot(
  snapshot: Partial<TrackerSnapshot>,
): Promise<SharedTrackerSyncResponse | undefined> {
  try {
    const response = await fetch("/api/tracker-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      cache: "no-store",
      keepalive: true,
      body: JSON.stringify(snapshot),
    });

    const payload = (await response.json().catch(() => undefined)) as
      | { updatedAt?: string; error?: string }
      | undefined;

    if (!response.ok) {
      return {
        enabled: true,
        synced: false,
        updatedAt: payload?.updatedAt,
        message:
          payload?.error || `Shared tracker sync failed with status ${response.status}.`,
      };
    }

    return {
      enabled: true,
      synced: true,
      updatedAt: payload?.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function loadLocalCoreSnapshot() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(CORE_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as Partial<TrackerSnapshot>;
    return hasCoreTrackerData(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveLocalCoreSnapshot(snapshot: Partial<TrackerSnapshot>) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(CORE_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Local backup is best-effort only.
  }
}

function isRecentIso(value: string | undefined, maxAgeHours: number) {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Date.now() - timestamp <= maxAgeHours * 60 * 60 * 1000;
}

function hasUsablePriceHistory(
  prices: CachedDailyPrice[],
  symbol: string,
  asOfDate: string,
  allowManualMarketData: boolean,
) {
  const relevantPrices = prices
    .filter(
      (price) =>
        price.symbol === symbol &&
        price.date <= asOfDate &&
        (allowManualMarketData || price.provider !== "manual"),
    )
    .sort((left, right) => left.date.localeCompare(right.date));

  if (relevantPrices.length < MIN_PRICE_HISTORY_POINTS) {
    return false;
  }

  const latestDate = relevantPrices.at(-1)?.date;
  if (!latestDate) {
    return false;
  }

  const latestTimestamp = Date.parse(`${latestDate}T00:00:00.000Z`);
  const asOfTimestamp = Date.parse(`${asOfDate}T00:00:00.000Z`);
  if (!Number.isFinite(latestTimestamp) || !Number.isFinite(asOfTimestamp)) {
    return false;
  }

  const ageDays = Math.max(0, (asOfTimestamp - latestTimestamp) / 86_400_000);
  return ageDays <= MAX_PRICE_HISTORY_AGE_DAYS;
}

function priceHistoryStartDate(saleDate: string | undefined, asOfDate: string) {
  const lookbackDate = format(
    addMonths(parseISO(asOfDate), -PRICE_HISTORY_LOOKBACK_MONTHS),
    "yyyy-MM-dd",
  );

  if (!saleDate || !/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    return lookbackDate;
  }

  return saleDate < lookbackDate ? saleDate : lookbackDate;
}

function collectTrackedSymbols(baseSymbol: string, trades: Trade[]) {
  return Array.from(
    new Set([
      baseSymbol.toUpperCase(),
      ...trades.map((trade) => trade.ticker.toUpperCase()).filter(Boolean),
    ]),
  );
}

function firstTradeDateForSymbol(trades: Trade[], symbol: string) {
  return trades
    .filter((trade) => trade.ticker.toUpperCase() === symbol.toUpperCase())
    .map((trade) => trade.date)
    .sort((left, right) => left.localeCompare(right))[0];
}

async function saveNewsRefresh({
  data,
  symbol,
  cachedAt,
  existingArticles,
  existingAnalyses,
}: {
  data: NewsApiResponse;
  symbol: string;
  cachedAt: string;
  existingArticles: CachedNewsArticle[];
  existingAnalyses: CachedNewsAnalysis[];
}) {
  const existingArticlesById = new Map(
    existingArticles.map((article) => [article.id, article]),
  );
  const articles: CachedNewsArticle[] = (data.articles || []).map((article) => ({
    ...article,
    collectedAt: existingArticlesById.get(article.id)?.collectedAt ?? cachedAt,
    cachedAt,
    lastFetchedAt: cachedAt,
    raw: article,
  }));

  await indexedDbAdapter.saveNewsArticles(articles);

  const aiAnalysisMode = data.aiAnalysisMode === "performance" ? "performance" : "testing";
  const articlesForAi = !data.automated && shouldRunDailyAiArticleAnalysis(existingAnalyses, symbol, aiAnalysisMode)
    ? selectArticlesForAiAnalysis(articles, existingAnalyses, symbol, aiAnalysisMode)
    : [];
  let savedAnalysisCount = 0;
  let analysisFailureCount = 0;

  if (articlesForAi.length > 0) {
    const analysisResponse = await fetch("/api/news/analyze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        symbol,
        articles: articlesForAi,
      }),
    });
    if (analysisResponse.ok) {
      const analysisData = (await analysisResponse.json()) as NewsAnalysisApiResponse;
      if (analysisData.analyses?.length) {
        savedAnalysisCount = analysisData.analyses.length;
        await indexedDbAdapter.saveNewsAnalyses(analysisData.analyses);
      }
      analysisFailureCount = analysisData.enabled ? (analysisData.failures?.length ?? 0) : 0;
    } else {
      analysisFailureCount = articlesForAi.length;
    }
  }

  return {
    articleCount: articles.length,
    savedAnalysisCount,
    analysisFailureCount,
  };
}

async function fetchAndStoreNewsArticles({
  symbol,
  snapshot,
  load,
  setLastNewsRefreshAt,
  refreshWarning,
}: {
  symbol: string;
  snapshot: TrackerSnapshot;
  load: () => Promise<void>;
  setLastNewsRefreshAt: (value: string) => void;
  refreshWarning?: (value: string | undefined) => void;
}): Promise<NewsRefreshResult> {
  const response = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as NewsApiResponse & {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || `Could not fetch ${symbol} articles.`);
  }

  const cachedAt = nowIso();
  setLastNewsRefreshAt(cachedAt);
  const result = await saveNewsRefresh({
    data,
    symbol,
    cachedAt,
    existingArticles: snapshot.newsArticles || [],
    existingAnalyses: snapshot.newsAnalyses || [],
  });

  await load();
  notifyTrackerDataChanged();
  if (result.analysisFailureCount > 0) {
    const message = `${symbol} articles were fetched, but some AI article analyses failed.`;
    refreshWarning?.(message);
    toast.warning(message);
  } else if (data.sharedSync?.enabled && data.sharedSync.synced) {
    toast.success(
      `Fetched ${result.articleCount} ${symbol} article${
        result.articleCount === 1 ? "" : "s"
      } and synced them for Review Latest`,
    );
  } else if (data.sharedSync?.enabled && !data.sharedSync.synced) {
    const message =
      data.sharedSync.message ||
      `Fetched ${symbol} articles, but shared review sync did not complete.`;
    refreshWarning?.(message);
    toast.warning(message);
  } else {
    toast.success(`Fetched ${result.articleCount} ${symbol} article${result.articleCount === 1 ? "" : "s"}`);
  }

  return result;
}

export function useTrackerData(options?: {
  initialSnapshot?: Partial<TrackerSnapshot>;
  initialSyncState?: TrackerSyncState;
  initialDisplayCurrency?: Currency;
}) {
  const initialSnapshot =
    options?.initialSnapshot && hasCoreTrackerData(options.initialSnapshot)
      ? normalizeTrackerSnapshot(options.initialSnapshot)
      : emptySnapshot();
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>(initialSnapshot);
  const [isLoading, setIsLoading] = useState(!options?.initialSnapshot);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [warning, setWarning] = useState<string | undefined>();
  const [lastNewsRefreshAt, setLastNewsRefreshAt] = useState<string | undefined>();
  const [syncState, setSyncState] = useState<TrackerSyncState>(
    options?.initialSyncState ??
      (options?.initialSnapshot && hasCoreTrackerData(options.initialSnapshot)
        ? {
            state: "synced",
            label: "Synced",
            detail: "Loaded from shared storage.",
          }
        : {
            state: "loading",
            label: "Checking sync",
          }),
  );
  const lastSyncedCoreSnapshotRef = useRef<string>("");

  const syncCoreSnapshot = useCallback(
    async (coreSnapshot?: Partial<TrackerSnapshot>) => {
      const nextCoreSnapshot =
        coreSnapshot || pickCoreTrackerSnapshot(await indexedDbAdapter.getSnapshot());

      if (!hasCoreTrackerData(nextCoreSnapshot)) {
        return undefined;
      }

      const signature = JSON.stringify(nextCoreSnapshot);
      if (lastSyncedCoreSnapshotRef.current === signature) {
        return undefined;
      }

      const previousSignature = lastSyncedCoreSnapshotRef.current;
      lastSyncedCoreSnapshotRef.current = signature;
      setSyncState({
        state: "syncing",
        label: "Syncing",
        detail: "Saving tracker to shared storage...",
      });
      saveLocalCoreSnapshot(nextCoreSnapshot);
      const sharedSync = await saveSharedTrackerSnapshot(nextCoreSnapshot);

      if (sharedSync?.enabled && !sharedSync.synced && sharedSync.message) {
        setWarning(sharedSync.message);
        setSyncState({
          state: "error",
          label: "Sync error",
          detail: sharedSync.message,
          updatedAt: sharedSync.updatedAt,
        });
      } else if (sharedSync?.synced) {
        setSyncState({
          state: "synced",
          label: "Synced",
          detail: "Saved to shared storage.",
          updatedAt: sharedSync.updatedAt,
        });
      } else if (sharedSync?.enabled === false) {
        setSyncState({
          state: "local",
          label: "Local only",
          detail: sharedSync.message || "Shared sync is not available on this deployment.",
        });
      } else if (!sharedSync?.synced) {
        lastSyncedCoreSnapshotRef.current = previousSignature;
      }

      return sharedSync;
    },
    [],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setSyncState((current) =>
      current.state === "synced"
        ? current
        : {
            state: "loading",
            label: "Checking sync",
            detail: "Loading saved tracker data...",
          },
    );
    const [shared, next] = await Promise.all([
      fetchSharedTrackerSnapshot(),
      indexedDbAdapter.getSnapshot(),
    ]);
    const normalizedNext = normalizeTrackerSnapshot(next);

    if (
      shared?.enabled &&
      shared.snapshot &&
      hasCoreTrackerData(shared.snapshot) &&
      getCoreSnapshotUpdatedAt(normalizedNext) <= getCoreSnapshotUpdatedAt(shared.snapshot)
    ) {
      await indexedDbAdapter.importSnapshot({
        ...normalizedNext,
        ...(shared.snapshot as TrackerSnapshot),
      });
      const hydrated = await indexedDbAdapter.getSnapshot();
      setSnapshot(normalizeTrackerSnapshot(hydrated));
      lastSyncedCoreSnapshotRef.current = JSON.stringify(pickCoreTrackerSnapshot(hydrated));
      setSyncState({
        state: "synced",
        label: "Synced",
        detail: "Loaded from shared storage.",
        updatedAt: shared.updatedAt,
      });
      setIsLoading(false);
      return;
    }

    const localBackup = hasCoreTrackerData(normalizedNext) ? normalizedNext : loadLocalCoreSnapshot();
    if (localBackup && hasCoreTrackerData(localBackup)) {
      if (shared?.message) {
        setSyncState({
          state: "local",
          label: "Local only",
          detail: shared.message,
        });
      } else if (shared?.enabled) {
        setSyncState({
          state: "syncing",
          label: "Syncing",
          detail: "Preparing shared snapshot...",
        });
      } else {
        setSyncState({
          state: "local",
          label: "Local only",
          detail: "Shared sync is not available on this deployment.",
        });
      }

      if (!hasCoreTrackerData(normalizedNext)) {
        await indexedDbAdapter.importSnapshot(localBackup as TrackerSnapshot);
        const hydrated = await indexedDbAdapter.getSnapshot();
        setSnapshot(normalizeTrackerSnapshot(hydrated));
        setIsLoading(false);
        return;
      }
    } else if (shared?.message) {
      setSyncState({
        state: "local",
        label: "Local only",
        detail: shared.message,
      });
    } else if (shared?.enabled) {
      setSyncState({
        state: "empty",
        label: "Waiting for setup",
        detail: "No shared tracker snapshot found yet.",
      });
    }

    setSnapshot(normalizeTrackerSnapshot(normalizedNext));
    if (hasCoreTrackerData(normalizedNext)) {
      setSyncState((current) =>
        current.state === "synced" || current.state === "syncing" || current.state === "local"
          ? current
          : {
              state: "syncing",
              label: "Syncing",
              detail: "Preparing shared snapshot...",
            },
      );
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    const handleChange = () => {
      void load();
    };
    window.addEventListener(TRACKER_DATA_CHANGED_EVENT, handleChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(TRACKER_DATA_CHANGED_EVENT, handleChange);
    };
  }, [load]);

  const coreSnapshot = useMemo(() => pickCoreTrackerSnapshot(snapshot), [snapshot]);

  useEffect(() => {
    if (isLoading || !hasCoreTrackerData(coreSnapshot)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void syncCoreSnapshot(coreSnapshot);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [coreSnapshot, isLoading, syncCoreSnapshot]);

  const settings = useMemo(
    () => ({
      ...createDefaultSettings(),
      ...(snapshot.settings || {}),
    }),
    [snapshot.settings],
  );
  const saleEvent = snapshot.saleEvents[0];
  const quote = useMemo(() => {
    const symbolQuotes = snapshot.quotes.filter((item) => item.symbol === settings.baseTicker);
    const manualQuote = latestByDate(symbolQuotes.filter((item) => item.provider === "manual"));
    const marketQuote = latestByDate(symbolQuotes.filter((item) => item.provider !== "manual"));

    if (
      settings.defaultPriceMode === "manual" ||
      settings.marketDataProvider === "manual" ||
      settings.isDemoMode
    ) {
      return manualQuote ?? marketQuote;
    }

    return marketQuote ?? manualQuote;
  }, [
    settings.baseTicker,
    settings.defaultPriceMode,
    settings.isDemoMode,
    settings.marketDataProvider,
    snapshot.quotes,
  ]);
  const manualPriceUsd =
    !settings.isDemoMode && settings.manualCurrentPriceUsd && settings.manualCurrentPriceUsd > 0
      ? settings.manualCurrentPriceUsd
      : undefined;
  const allowManualMarketData =
    settings.isDemoMode ||
    settings.defaultPriceMode === "manual" ||
    settings.marketDataProvider === "manual";
  const latestDailyPrice = latestByDate(
    snapshot.dailyPrices.filter(
      (price) =>
        price.symbol === settings.baseTicker &&
        (allowManualMarketData || price.provider !== "manual"),
    ),
  );
  const latestNewsArticle = latestByDate(
    (snapshot.newsArticles || []).filter((article) => article.symbol === settings.baseTicker),
  );
  const fallbackPriceUsd =
    latestDailyPrice?.adjustedCloseUsd ??
    latestDailyPrice?.closeUsd ??
    saleEvent?.salePricePerShareUsd ??
    0;
  const quotePriceUsd = isGeneratedManualQuote(quote, settings.isDemoMode) && !allowManualMarketData
    ? undefined
    : quote?.priceUsd;
  const currentPriceUsd = manualPriceUsd || quotePriceUsd || fallbackPriceUsd;
  const latestUsdToAudRate =
    latestByDate(
      snapshot.fxRates.filter((rate) => rate.base === "USD" && rate.quote === "AUD"),
    )?.rate || 1.52;
  const latestAudToUsdRate =
    latestByDate(
      snapshot.fxRates.filter((rate) => rate.base === "AUD" && rate.quote === "USD"),
    )?.rate || 1 / latestUsdToAudRate;

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const now = nowIso();
      const next: AppSettings = {
        ...settings,
        ...patch,
        id: "singleton",
        baseTicker: patch.baseTicker || settings.baseTicker || "AAPL",
        baseValuationCurrency: "USD",
        contributionPlanCurrency: "AUD",
        createdAt: settings.createdAt || now,
        updatedAt: now,
      };
      await indexedDbAdapter.saveSettings(next);

      if (next.manualCurrentPriceUsd) {
        await indexedDbAdapter.saveQuote({
          symbol: next.baseTicker,
          priceUsd: next.manualCurrentPriceUsd,
          asOf: now,
          provider: "manual",
          isDelayed: true,
          sourceNote: "Manual current price override.",
        });
      }

      await load();
      notifyTrackerDataChanged();
      toast.success("Settings saved");
    },
    [load, settings],
  );

  const createTracker = useCallback(
    async (input: SetupInput) => {
      const now = nowIso();
      const nextSettings: AppSettings = {
        ...createDefaultSettings(),
        ...input.settings,
        id: "singleton",
        baseTicker: input.sale.ticker || "AAPL",
        baseValuationCurrency: "USD",
        contributionPlanCurrency: "AUD",
        createdAt: now,
        updatedAt: now,
      };
      const sale: SaleEvent = {
        ...input.sale,
        id: uid("sale"),
        ticker: input.sale.ticker || "AAPL",
        createdAt: now,
        updatedAt: now,
      };

      await indexedDbAdapter.saveSettings(nextSettings);
      await indexedDbAdapter.saveSaleEvent(sale);
      if (nextSettings.manualCurrentPriceUsd) {
        await indexedDbAdapter.saveQuote({
          symbol: nextSettings.baseTicker,
          priceUsd: nextSettings.manualCurrentPriceUsd,
          asOf: now,
          provider: "manual",
          isDelayed: true,
          sourceNote: "Manual setup price.",
        });
      }
      await syncCoreSnapshot({
        settings: nextSettings,
        saleEvents: [sale],
        contributions: [],
        trades: [],
      });
      await load();
      toast.success("Planner created");
    },
    [load, syncCoreSnapshot],
  );

  const loadDemo = useCallback(async () => {
    await indexedDbAdapter.importSnapshot(createDemoSnapshot());
    await load();
    toast.success("Demo data loaded");
  }, [load]);

  const addContribution = useCallback(
    async (input: Omit<Contribution, "id" | "createdAt" | "updatedAt" | "amountUsd">) => {
      const now = nowIso();
      const amountUsd =
        input.currencyEntered === "USD"
          ? input.amount
          : roundMoney(input.amount * input.fxRateToUsd);
      await indexedDbAdapter.saveContribution({
        ...input,
        id: uid("contribution"),
        amountUsd,
        createdAt: now,
        updatedAt: now,
      });
      await load();
      toast.success("Contribution added");
    },
    [load],
  );

  const addContributionWithPurchase = useCallback(
    async (input: ContributionWithPurchaseInput) => {
      const now = nowIso();
      const ledgerGroupId = uid("ledger");
      const amountUsd =
        input.contribution.currencyEntered === "USD"
          ? input.contribution.amount
          : roundMoney(input.contribution.amount * input.contribution.fxRateToUsd);

      const contribution: Contribution = {
        ...input.contribution,
        ledgerGroupId,
        id: uid("contribution"),
        amountUsd,
        createdAt: now,
        updatedAt: now,
      };
      await indexedDbAdapter.saveContribution(contribution);

      let trade: Trade | undefined;
      if (input.purchase && input.purchase.shares > 0 && input.purchase.pricePerShareUsd > 0) {
        const feeUsd =
          input.purchase.feeCurrency === "AUD"
            ? roundMoney(input.purchase.fees * input.purchase.feeFxRateToUsd)
            : input.purchase.fees;
        const grossAmountUsd = roundMoney(
          input.purchase.shares * input.purchase.pricePerShareUsd,
        );
        const tradeId = uid("trade");

        trade = {
          id: tradeId,
          ledgerGroupId,
          date: input.contribution.date,
          ticker: input.purchase.ticker || settings.baseTicker,
          side: "BUY",
          shares: input.purchase.shares,
          pricePerShare: input.purchase.pricePerShareUsd,
          currencyEntered: "USD",
          fxRateToUsd: 1,
          pricePerShareUsd: input.purchase.pricePerShareUsd,
          grossAmountUsd,
          feesUsd: feeUsd,
          feeCurrency: input.purchase.feeCurrency,
          totalAmountUsd: roundMoney(grossAmountUsd + feeUsd),
          notes: input.purchase.notes || input.contribution.notes,
          createdAt: now,
          updatedAt: now,
          cashOutAud: input.contribution.currencyEntered === "AUD" ? input.contribution.amount : undefined,
        };

        await indexedDbAdapter.saveTrade(trade);
      }

      const nextSnapshot = normalizeTrackerSnapshot({
        ...snapshot,
        contributions: [...snapshot.contributions, contribution],
        trades: trade ? [...snapshot.trades, trade] : snapshot.trades,
      });
      setSnapshot(nextSnapshot);
      await syncCoreSnapshot(pickCoreTrackerSnapshot(nextSnapshot));
      toast.success(
        input.purchase
          ? `Contribution and ${(input.purchase.ticker || settings.baseTicker).toUpperCase()} buy added`
          : "Contribution added",
      );
    },
    [setSnapshot, snapshot, syncCoreSnapshot, settings.baseTicker],
  );

  const saveSaleEvent = useCallback(
    async (input: SaleEvent) => {
      await indexedDbAdapter.saveSaleEvent({
        ...input,
        updatedAt: nowIso(),
      });
      await load();
      toast.success("Sale event saved");
    },
    [load],
  );

  const deleteSaleEvent = useCallback(
    async (id: string) => {
      await indexedDbAdapter.deleteSaleEvent(id);
      await load();
      toast.success("Sale event deleted");
    },
    [load],
  );

  const addTrade = useCallback(
    async (input: Omit<Trade, "id" | "createdAt" | "updatedAt">) => {
      const now = nowIso();
      const trade: Trade = {
        ...input,
        id: uid("trade"),
        createdAt: now,
        updatedAt: now,
      };
      await indexedDbAdapter.saveTrade(trade);
      const nextSnapshot = normalizeTrackerSnapshot({
        ...snapshot,
        trades: [...snapshot.trades, trade],
      });
      setSnapshot(nextSnapshot);
      await syncCoreSnapshot(pickCoreTrackerSnapshot(nextSnapshot));
      toast.success(`${input.side === "BUY" ? "Buy" : "Sell"} logged`);
    },
    [setSnapshot, snapshot, syncCoreSnapshot],
  );

  const addQuickTrade = useCallback(
    async (input: QuickTradeInput) => {
      const now = nowIso();
      const feeUsd =
        input.feeCurrency === "AUD"
          ? roundMoney(input.fees * input.feeFxRateToUsd)
          : input.fees;
      const grossAmountUsd = roundMoney(input.shares * input.pricePerShareUsd);
      const totalAmountUsd =
        input.side === "BUY"
          ? roundMoney(grossAmountUsd + feeUsd)
          : roundMoney(grossAmountUsd - feeUsd);

      if (input.createMatchingContribution && input.side === "BUY") {
        await indexedDbAdapter.saveContribution({
          id: uid("contribution"),
          date: input.date,
          amount: input.contributionAmountAud,
          currencyEntered: "AUD",
          fxRateToUsd: input.audUsdRate,
          amountUsd: roundMoney(input.contributionAmountAud * input.audUsdRate),
          notes: input.notes || "Matching AUD contribution for AAPL purchase.",
          createdAt: now,
          updatedAt: now,
        });
      }

      await indexedDbAdapter.saveTrade({
        id: uid("trade"),
        date: input.date,
        ticker: settings.baseTicker,
        side: input.side,
        shares: input.shares,
        pricePerShare: input.pricePerShareUsd,
        currencyEntered: "USD",
        fxRateToUsd: 1,
        pricePerShareUsd: input.pricePerShareUsd,
        grossAmountUsd,
        feesUsd: feeUsd,
        feeCurrency: input.feeCurrency,
        totalAmountUsd,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      });

      await load();
      toast.success("Transaction logged");
    },
    [load, settings.baseTicker],
  );

  const deleteContribution = useCallback(
    async (id: string) => {
      const target = snapshot.contributions.find((contribution) => contribution.id === id);
      const matchingTrade =
        target && !target.ledgerGroupId
          ? snapshot.trades.find(
              (trade) =>
                trade.date === target.date &&
                Math.abs((trade.cashOutAud ?? 0) - target.amount) < 0.01 &&
                (trade.notes || "") === (target.notes || ""),
            )
          : undefined;
      const tradeIdsToDelete = snapshot.trades
        .filter(
          (trade) =>
            trade.ledgerGroupId === target?.ledgerGroupId ||
            (matchingTrade ? trade.id === matchingTrade.id : false),
        )
        .map((trade) => trade.id);
      const contributionIdsToDelete = snapshot.contributions
        .filter(
          (contribution) =>
            contribution.id === id ||
            contribution.ledgerGroupId === target?.ledgerGroupId,
        )
        .map((contribution) => contribution.id);
      await Promise.all([
        ...tradeIdsToDelete.map((tradeId) => indexedDbAdapter.deleteTrade(tradeId)),
        ...contributionIdsToDelete.map((contributionId) =>
          indexedDbAdapter.deleteContribution(contributionId),
        ),
      ]);
      const nextSnapshot = normalizeTrackerSnapshot({
        ...snapshot,
        contributions: snapshot.contributions.filter(
          (contribution) =>
            !contributionIdsToDelete.includes(contribution.id) &&
            contribution.ledgerGroupId !== target?.ledgerGroupId,
        ),
        trades: snapshot.trades.filter(
          (trade) =>
            !tradeIdsToDelete.includes(trade.id) &&
            trade.ledgerGroupId !== target?.ledgerGroupId,
        ),
      });
      setSnapshot(nextSnapshot);
      await syncCoreSnapshot(pickCoreTrackerSnapshot(nextSnapshot));
      toast.success(target?.ledgerGroupId ? "Ledger entry deleted" : "Contribution deleted");
    },
    [setSnapshot, snapshot, syncCoreSnapshot],
  );

  const deleteTrade = useCallback(
    async (id: string) => {
      const target = snapshot.trades.find((trade) => trade.id === id);
      const matchingContribution =
        target && !target.ledgerGroupId
          ? snapshot.contributions.find(
              (contribution) =>
                contribution.date === target.date &&
                Math.abs(contribution.amount - (target.cashOutAud ?? contribution.amount)) < 0.01 &&
                (contribution.notes || "") === (target.notes || ""),
            )
          : undefined;
      const tradeIdsToDelete = snapshot.trades
        .filter(
          (trade) =>
            trade.id === id ||
            trade.ledgerGroupId === target?.ledgerGroupId ||
            (matchingContribution ? trade.id === target?.id : false),
        )
        .map((trade) => trade.id);
      const contributionIdsToDelete = snapshot.contributions
        .filter(
          (contribution) =>
            contribution.ledgerGroupId === target?.ledgerGroupId ||
            (matchingContribution ? contribution.id === matchingContribution.id : false),
        )
        .map((contribution) => contribution.id);
      await Promise.all([
        ...tradeIdsToDelete.map((tradeId) => indexedDbAdapter.deleteTrade(tradeId)),
        ...contributionIdsToDelete.map((contributionId) =>
          indexedDbAdapter.deleteContribution(contributionId),
        ),
      ]);
      const nextSnapshot = normalizeTrackerSnapshot({
        ...snapshot,
        contributions: snapshot.contributions.filter(
          (contribution) =>
            !contributionIdsToDelete.includes(contribution.id) &&
            contribution.ledgerGroupId !== target?.ledgerGroupId,
        ),
        trades: snapshot.trades.filter(
          (trade) =>
            !tradeIdsToDelete.includes(trade.id) &&
            trade.ledgerGroupId !== target?.ledgerGroupId,
        ),
      });
      setSnapshot(nextSnapshot);
      await syncCoreSnapshot(pickCoreTrackerSnapshot(nextSnapshot));
      toast.success(target?.ledgerGroupId ? "Ledger entry deleted" : "Trade deleted");
    },
    [setSnapshot, snapshot, syncCoreSnapshot],
  );

  const resetLedger = useCallback(async () => {
    const clearedSnapshot = normalizeTrackerSnapshot({
      ...snapshot,
      contributions: [],
      trades: [],
    });
    await indexedDbAdapter.importSnapshot(clearedSnapshot);
    setSnapshot(clearedSnapshot);
    await syncCoreSnapshot(pickCoreTrackerSnapshot(clearedSnapshot));
    toast.success("Ledger reset");
  }, [setSnapshot, snapshot, syncCoreSnapshot]);

  const refreshMarketData = useCallback(
    async (force = false, options?: { silent?: boolean }) => {
      const activeSale = snapshot.saleEvents[0];
      const symbol = settings.baseTicker || "AAPL";
      const asOfDate = todayIso();
      const trackedSymbols = collectTrackedSymbols(symbol, snapshot.trades);
      const hasFreshPriceHistory = trackedSymbols.every((trackedSymbol) =>
        hasUsablePriceHistory(snapshot.dailyPrices, trackedSymbol, asOfDate, allowManualMarketData),
      );
      if (
        !force &&
        (settings.marketDataProvider === "manual" ||
          !isGeneratedManualQuote(quote, settings.isDemoMode)) &&
        !isQuoteCacheStale(quote) &&
        hasFreshPriceHistory &&
        (isRecentIso(latestNewsArticle?.cachedAt, 6) || isRecentIso(lastNewsRefreshAt, 6))
      ) {
        return;
      }

      setIsRefreshing(true);
      setWarning(undefined);
      const historyFrom = priceHistoryStartDate(activeSale?.saleDate, asOfDate);
      const eventFrom = activeSale?.saleDate || historyFrom;
      const to = asOfDate;
      const extraSymbols = trackedSymbols.filter((trackedSymbol) => trackedSymbol !== symbol);

      try {
        const [
          quoteResponse,
          historyResponse,
          dividendResponse,
          splitResponse,
          usdAudResponse,
          audUsdResponse,
          newsResponse,
        ] =
          await Promise.allSettled([
            fetch(`/api/market/quote?symbol=${symbol}&provider=${settings.marketDataProvider}`),
            fetch(`/api/market/history?symbol=${symbol}&from=${historyFrom}&to=${to}&provider=${settings.marketDataProvider}`),
            fetch(`/api/market/dividends?symbol=${symbol}&from=${eventFrom}&to=${to}&provider=${settings.marketDataProvider}`),
            fetch(`/api/market/splits?symbol=${symbol}&from=${eventFrom}&to=${to}&provider=${settings.marketDataProvider}`),
            fetch("/api/fx?base=USD&quote=AUD"),
            fetch("/api/fx?base=AUD&quote=USD"),
            fetch(`/api/news?symbol=${symbol}`),
          ]);
        let hadRefreshIssue = false;

        if (quoteResponse.status === "fulfilled" && quoteResponse.value.ok) {
          const data = await quoteResponse.value.json();
          const cached: CachedQuote = {
            symbol: data.symbol,
            priceUsd: data.price,
            asOf: data.asOf,
            provider: data.provider,
            isDelayed: data.isDelayed,
            sourceNote: data.sourceNote,
            raw: data,
          };
          await indexedDbAdapter.saveQuote(cached);
        } else {
          hadRefreshIssue = true;
        }

        if (historyResponse.status === "fulfilled" && historyResponse.value.ok) {
          const data = await historyResponse.value.json();
          const prices: CachedDailyPrice[] = ((data.prices || []) as MarketHistoryApiPrice[]).map((price) => ({
            symbol: price.symbol,
            date: price.date,
            closeUsd: price.close,
            adjustedCloseUsd: price.adjustedClose,
            provider: price.provider,
            raw: price,
          }));
          await indexedDbAdapter.saveDailyPrices(prices);
        } else {
          hadRefreshIssue = true;
        }

        if (extraSymbols.length > 0) {
          const extraHistoryResults = await Promise.allSettled(
            extraSymbols.map(async (trackedSymbol) => {
              const firstTradeDate = firstTradeDateForSymbol(snapshot.trades, trackedSymbol);
              const from = priceHistoryStartDate(firstTradeDate, asOfDate);
              const response = await fetch(
                `/api/market/history?symbol=${trackedSymbol}&from=${from}&to=${to}&provider=${settings.marketDataProvider}`,
              );
              if (!response.ok) {
                return {
                  symbol: trackedSymbol,
                  prices: [] as CachedDailyPrice[],
                  ok: false as const,
                };
              }

              const data = (await response.json()) as { prices?: MarketHistoryApiPrice[] };
              const prices = ((data.prices || []) as MarketHistoryApiPrice[]).map((price) => ({
                symbol: price.symbol,
                date: price.date,
                closeUsd: price.close,
                adjustedCloseUsd: price.adjustedClose,
                provider: price.provider,
                raw: price,
              }));
              return {
                symbol: trackedSymbol,
                prices,
                ok: true as const,
              };
            }),
          );

          for (const result of extraHistoryResults) {
            if (result.status === "fulfilled" && result.value.ok) {
              await indexedDbAdapter.saveDailyPrices(result.value.prices);
            } else {
              hadRefreshIssue = true;
            }
          }
        }

        if (dividendResponse.status === "fulfilled" && dividendResponse.value.ok) {
          const data = await dividendResponse.value.json();
          const dividends: CachedDividend[] = ((data.dividends || []) as MarketDividendApiEvent[]).map((dividend) => ({
            symbol: dividend.symbol,
            exDate: dividend.exDate,
            payDate: dividend.payDate,
            amountPerShareUsd: dividend.amountPerShare,
            provider: dividend.provider,
            raw: dividend,
          }));
          await indexedDbAdapter.saveDividends(dividends);
        } else {
          hadRefreshIssue = true;
        }

        if (splitResponse.status === "fulfilled" && splitResponse.value.ok) {
          const data = await splitResponse.value.json();
          const splits: CachedSplit[] = ((data.splits || []) as MarketSplitApiEvent[]).map((split) => ({
            symbol: split.symbol,
            date: split.date,
            ratio: split.ratio,
            fromFactor: split.fromFactor,
            toFactor: split.toFactor,
            provider: split.provider,
            raw: split,
          }));
          await indexedDbAdapter.saveSplits(splits);
        } else {
          hadRefreshIssue = true;
        }

        for (const response of [usdAudResponse, audUsdResponse]) {
          if (response.status === "fulfilled" && response.value.ok) {
            const data = await response.value.json();
            const cached: CachedFxRate = {
              id: `${data.base}-${data.quote}-${data.date}`,
              base: data.base,
              quote: data.quote,
              date: data.date,
              rate: data.rate,
              asOf: data.asOf,
              provider: data.provider,
              raw: data,
            };
            await indexedDbAdapter.saveFxRate(cached);
          } else {
            hadRefreshIssue = true;
          }
        }

        if (newsResponse.status === "fulfilled" && newsResponse.value.ok) {
          const data = (await newsResponse.value.json()) as NewsApiResponse;
          const cachedAt = nowIso();
          setLastNewsRefreshAt(cachedAt);
          const newsResult = await saveNewsRefresh({
            data,
            symbol,
            cachedAt,
            existingArticles: snapshot.newsArticles || [],
            existingAnalyses: snapshot.newsAnalyses || [],
          });
          if (newsResult.analysisFailureCount > 0) {
            hadRefreshIssue = true;
          }
          if (data.sharedSync?.enabled && !data.sharedSync.synced) {
            hadRefreshIssue = true;
          }
        } else {
          setLastNewsRefreshAt(nowIso());
          hadRefreshIssue = true;
        }

        await load();
        if (hadRefreshIssue) {
          const message = "Some market, FX, or news requests failed. Showing cached values where available.";
          setWarning(message);
          if (!options?.silent) {
            toast.warning("Using cached data where needed");
          }
        } else {
          if (!options?.silent) {
            toast.success("Prices and news refreshed");
          }
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Market data or news refresh failed. Showing last cached values.";
        setWarning(message);
        if (!options?.silent) {
          toast.warning("Using cached market and news data");
        }
      } finally {
        setIsRefreshing(false);
      }
    },
    [
      lastNewsRefreshAt,
      latestNewsArticle?.cachedAt,
      load,
      allowManualMarketData,
      quote,
      settings.baseTicker,
      settings.isDemoMode,
      settings.marketDataProvider,
      snapshot.dailyPrices,
      snapshot.newsAnalyses,
      snapshot.newsArticles,
      snapshot.saleEvents,
      snapshot.trades,
    ],
  );

  const marketRefreshAttemptKey = useMemo(
    () =>
      [
        settings.baseTicker,
        ...snapshot.trades.map((trade) => `${trade.ticker}:${trade.date}:${trade.side}:${trade.shares}`),
      ].join("|"),
    [settings.baseTicker, snapshot.trades],
  );
  const marketRefreshAttemptRef = useRef<string>("");

  useEffect(() => {
    if (isLoading || isRefreshing) {
      return;
    }

    const trackedSymbols = collectTrackedSymbols(settings.baseTicker || "AAPL", snapshot.trades);
    const missingHistory = trackedSymbols.some(
      (trackedSymbol) =>
        !hasUsablePriceHistory(
          snapshot.dailyPrices,
          trackedSymbol,
          todayIso(),
          allowManualMarketData,
        ),
    );

    if (!missingHistory || marketRefreshAttemptRef.current === marketRefreshAttemptKey) {
      return;
    }

    marketRefreshAttemptRef.current = marketRefreshAttemptKey;
    void refreshMarketData(false, { silent: true });
  }, [
    allowManualMarketData,
    isLoading,
    isRefreshing,
    marketRefreshAttemptKey,
    refreshMarketData,
    snapshot.dailyPrices,
    snapshot.trades,
    settings.baseTicker,
  ]);

  const refreshNewsArticles = useCallback(
    async (symbolInput?: string) => {
      const symbol = (symbolInput || settings.baseTicker || "AAPL").toUpperCase();
      setIsRefreshing(true);
      setWarning(undefined);

      try {
        return await fetchAndStoreNewsArticles({
          symbol,
          snapshot,
          load,
          setLastNewsRefreshAt,
          refreshWarning: setWarning,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Could not fetch ${symbol} articles.`;
        setWarning(message);
        toast.warning(message);
        throw error;
      } finally {
        setIsRefreshing(false);
      }
    },
    [
      load,
      settings.baseTicker,
      snapshot,
    ],
  );

  const refreshNewsArticlesForSymbols = useCallback(
    async (symbols: string[]) => {
      const uniqueSymbols = Array.from(
        new Set(symbols.map((symbol) => symbol.toUpperCase()).filter(Boolean)),
      );
      if (uniqueSymbols.length === 0) {
        return [];
      }

      setIsRefreshing(true);
      setWarning(undefined);

      const results: Array<{ symbol: string; result?: NewsRefreshResult; error?: string }> = [];
      try {
        for (const symbol of uniqueSymbols) {
          try {
            const result = await fetchAndStoreNewsArticles({
              symbol,
              snapshot,
              load,
              setLastNewsRefreshAt,
              refreshWarning: undefined,
            });
            results.push({ symbol, result });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : `Could not fetch ${symbol} articles.`;
            results.push({ symbol, error: message });
          }
        }

        const fetchedSymbols = results.filter((item) => item.result).map((item) => item.symbol);
        const failedSymbols = results.filter((item) => item.error).map((item) => item.symbol);
        if (failedSymbols.length > 0) {
          const message = `Fetched ${fetchedSymbols.join(", ") || "no"} articles; failed for ${failedSymbols.join(", ")}.`;
          setWarning(message);
          toast.warning(message);
        } else if (fetchedSymbols.length > 0) {
          toast.success(`Fetched ${fetchedSymbols.join(", ")} articles.`);
        }

        return results;
      } finally {
        setIsRefreshing(false);
      }
    },
    [load, snapshot],
  );

  const clearNewsCacheForSymbol = useCallback(
    async (symbolInput?: string) => {
      const symbol = (symbolInput || settings.baseTicker || "AAPL").toUpperCase();
      const result = await indexedDbAdapter.deleteNewsForSymbol(symbol);
      setLastNewsRefreshAt(undefined);
      await load();
      notifyTrackerDataChanged();
      toast.success(
        `Removed ${result.articlesDeleted} cached ${symbol} article${
          result.articlesDeleted === 1 ? "" : "s"
        }`,
      );
      return result;
    },
    [load, settings.baseTicker],
  );

  const clearMarketDataCacheForSymbol = useCallback(
    async (symbolInput?: string) => {
      const symbol = (symbolInput || settings.baseTicker || "AAPL").toUpperCase();
      const result = await indexedDbAdapter.deleteMarketDataForSymbol(symbol);
      await load();
      notifyTrackerDataChanged();
      toast.success(
        `Cleared ${result.pricesDeleted} cached ${symbol} price point${
          result.pricesDeleted === 1 ? "" : "s"
        }`,
      );
      return result;
    },
    [load, settings.baseTicker],
  );

  const exportJson = useCallback(async () => {
    const latest = await indexedDbAdapter.getSnapshot();
    return JSON.stringify(latest, null, 2);
  }, []);

  const importJson = useCallback(
    async (json: string) => {
      const parsed = JSON.parse(json) as TrackerSnapshot;
      await indexedDbAdapter.importSnapshot(parsed);
      await load();
      toast.success("Backup imported");
    },
    [load],
  );

  const reset = useCallback(async () => {
    await indexedDbAdapter.reset();
    await load();
    toast.success("Local data reset");
  }, [load]);

  return {
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
    syncState,
    load,
    createTracker,
    loadDemo,
    saveSettings,
    saveSaleEvent,
    deleteSaleEvent,
    addContribution,
    addContributionWithPurchase,
    addTrade,
    addQuickTrade,
    deleteContribution,
    deleteTrade,
    resetLedger,
    refreshMarketData,
    refreshNewsArticles,
    refreshNewsArticlesForSymbols,
    clearNewsCacheForSymbol,
    clearMarketDataCacheForSymbol,
    exportJson,
    importJson,
    reset,
  };
}

function selectArticlesForAiAnalysis(
  articles: CachedNewsArticle[],
  analyses: CachedNewsAnalysis[],
  symbol: string,
  analysisMode: CachedNewsAnalysis["analysisMode"],
) {
  const analyzedArticleIds = new Set(
    analyses
      .filter((analysis) => analysis.analysisMode === analysisMode)
      .map((analysis) => analysis.articleId),
  );
  return articles
    .filter((article) => article.symbol === symbol && !analyzedArticleIds.has(article.id))
    .sort((left, right) => {
      const dateCompare = (right.publishedAt || "").localeCompare(left.publishedAt || "");
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return Math.abs(right.signalScore) - Math.abs(left.signalScore);
    })
    .slice(0, 20);
}

function shouldRunDailyAiArticleAnalysis(
  analyses: CachedNewsAnalysis[],
  symbol: string,
  analysisMode: CachedNewsAnalysis["analysisMode"],
) {
  const latestAnalysis = latestByDate(
    analyses
      .filter(
        (analysis) =>
          analysis.symbol === symbol &&
          analysis.analysisMode === analysisMode &&
          analysis.finalModel !== "none",
      )
      .map((analysis) => ({
        cachedAt: analysis.analyzedAt,
      })),
  );
  return !isRecentIso(latestAnalysis?.cachedAt, 20);
}
