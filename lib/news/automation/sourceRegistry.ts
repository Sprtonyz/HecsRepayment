import type { NewsSourceDefinition, TickerNewsProfile } from "@/lib/news/automation/types";

const profiles: Record<string, TickerNewsProfile> = {
  AAPL: {
    symbol: "AAPL",
    companyName: "Apple",
    aliases: ["Apple", "Apple Inc", "AAPL"],
    topics: ["earnings", "services", "iPhone", "Apple Intelligence", "App Store", "China", "regulation"],
    officialDomains: ["apple.com", "investor.apple.com"],
  },
  NVDA: {
    symbol: "NVDA",
    companyName: "NVIDIA",
    aliases: ["NVIDIA", "Nvidia", "NVDA"],
    topics: ["data center", "AI", "GPU", "Blackwell", "earnings", "China", "supply chain"],
    officialDomains: ["nvidianews.nvidia.com", "investor.nvidia.com"],
  },
  AMZN: {
    symbol: "AMZN",
    companyName: "Amazon",
    aliases: ["Amazon", "Amazon.com", "AMZN", "AWS"],
    topics: ["AWS", "retail", "advertising", "Prime", "earnings", "regulation"],
    officialDomains: ["aboutamazon.com", "ir.aboutamazon.com"],
  },
  TSLA: {
    symbol: "TSLA",
    companyName: "Tesla",
    aliases: ["Tesla", "TSLA"],
    topics: ["EV", "deliveries", "FSD", "energy storage", "China", "margins", "regulation"],
    officialDomains: ["ir.tesla.com", "tesla.com"],
  },
  SPCX: {
    symbol: "SPCX",
    companyName: "SpaceX",
    aliases: ["SpaceX", "Space Exploration Technologies", "SPCX"],
    topics: ["Starlink", "Starship", "launch", "NASA", "valuation", "satellite"],
    officialDomains: ["spacex.com"],
  },
};

const googleNewsUrl = (query: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

const commonSources: NewsSourceDefinition[] = [
  {
    id: "google-news-official-source-rss",
    label: "Official company sources via Google News RSS",
    method: "rss",
    priority: 90,
    allowedDomains: ["news.google.com"],
    buildUrl: (profile) =>
      googleNewsUrl(
        `${(profile.officialDomains ?? []).map((domain) => `site:${domain}`).join(" OR ")} "${profile.companyName}" when:7d`,
      ),
  },
  {
    id: "yahoo-finance-rss",
    label: "Yahoo Finance RSS",
    method: "rss",
    priority: 50,
    allowedDomains: ["feeds.finance.yahoo.com", "finance.yahoo.com"],
    buildUrl: (profile) =>
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(profile.symbol)}&region=US&lang=en-US`,
  },
  {
    id: "google-news-company-rss",
    label: "Google News company RSS",
    method: "rss",
    priority: 40,
    allowedDomains: ["news.google.com"],
    buildUrl: (profile) => googleNewsUrl(`"${profile.companyName}" OR ${profile.symbol} when:7d`),
  },
  {
    id: "google-news-fundamentals-rss",
    label: "Google News fundamentals RSS",
    method: "rss",
    priority: 45,
    allowedDomains: ["news.google.com"],
    buildUrl: (profile) =>
      googleNewsUrl(`"${profile.companyName}" (${profile.topics.slice(0, 4).join(" OR ")}) when:7d`),
  },
];

const aaplDirectSources: NewsSourceDefinition[] = [
  {
    id: "apple-newsroom-rss",
    label: "Apple Newsroom RSS",
    method: "directFeed",
    priority: 100,
    allowedDomains: ["apple.com"],
    buildUrl: () => "https://www.apple.com/newsroom/rss-feed.rss",
  },
];

// First-party publication surfaces only. A no-result or unavailable source is
// recorded in monitoring rather than silently substituted with weak coverage.
const directSourcesBySymbol: Record<string, NewsSourceDefinition[]> = {
  AAPL: aaplDirectSources,
  NVDA: [{
    id: "nvidia-newsroom-releases-rss",
    label: "NVIDIA Newsroom releases RSS",
    method: "directFeed",
    priority: 100,
    allowedDomains: ["nvidianews.nvidia.com"],
    buildUrl: () => "https://nvidianews.nvidia.com/releases.xml",
  }],
  AMZN: [{
    id: "amazon-press-centre",
    label: "Amazon Global Press Center",
    method: "directPage",
    priority: 100,
    allowedDomains: ["press.aboutamazon.com", "aboutamazon.com"],
    buildUrl: () => "https://press.aboutamazon.com/press-release-archive",
  }],
  TSLA: [{
    id: "tesla-investor-relations-press",
    label: "Tesla Investor Relations press releases",
    method: "directPage",
    priority: 100,
    allowedDomains: ["ir.tesla.com"],
    buildUrl: () => "https://ir.tesla.com/press",
  }],
  SPCX: [{
    id: "spacex-official-updates",
    label: "SpaceX official updates",
    method: "directPage",
    priority: 100,
    allowedDomains: ["spacex.com"],
    buildUrl: () => "https://www.spacex.com/updates/",
  }],
};

export function getTickerNewsProfile(symbol: string): TickerNewsProfile {
  const normalized = symbol.toUpperCase();
  return (
    profiles[normalized] ?? {
      symbol: normalized,
      companyName: normalized,
      aliases: [normalized],
      topics: ["earnings", "revenue", "regulation", "competition"],
    }
  );
}

export function getActiveDeepContextSymbols() {
  const configured = process.env.DEEP_CONTEXT_NEWS_SYMBOLS
    ?.split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9.-]{1,12}$/.test(symbol));
  return configured && configured.length > 0 ? Array.from(new Set(configured)) : Object.keys(profiles);
}

export function getNewsSourcesForSymbol(symbol: string): NewsSourceDefinition[] {
  return [...(directSourcesBySymbol[symbol.toUpperCase()] ?? []), ...commonSources];
}
