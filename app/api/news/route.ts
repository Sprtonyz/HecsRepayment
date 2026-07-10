import { NextRequest, NextResponse } from "next/server";
import { getAiNewsAnalysisMode } from "@/lib/ai/articleAnalysis";
import { fetchFreeNewsDigest } from "@/lib/news/freeNewsProvider";
import { buildNewsDigest } from "@/lib/news/sentiment";
import { getAutomatedNewsArticles } from "@/lib/shared-news/automationStore";
import { isSharedNewsSyncEnabled } from "@/lib/shared-news/config";
import { upsertSharedNewsArticles } from "@/lib/shared-news/store";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") || "AAPL").toUpperCase();

  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol." }, { status: 400 });
  }

  try {
    if (isSharedNewsSyncEnabled()) {
      const articles = await getAutomatedNewsArticles(symbol);
      const digest = buildNewsDigest(symbol, articles);
      return NextResponse.json({
        ...digest,
        automated: true,
        aiAnalysisMode: getAiNewsAnalysisMode(),
        sharedSync: {
          enabled: true,
          synced: true,
          articleCount: articles.length,
          sourceUpdatedAt: articles[0]?.lastFetchedAt || articles[0]?.cachedAt,
        },
      });
    }

    const digest = await fetchFreeNewsDigest(symbol);
    const syncedAt = new Date().toISOString();
    let sharedSync:
      | {
          enabled: boolean;
          synced: boolean;
          message?: string;
          reviewMonth?: string;
          articleCount?: number;
          sourceUpdatedAt?: string;
        }
      | undefined;

    try {
      sharedSync = await upsertSharedNewsArticles(
        digest.articles.map((article) => ({
          ...article,
          collectedAt: syncedAt,
          cachedAt: syncedAt,
          lastFetchedAt: syncedAt,
          raw: article,
        })),
        syncedAt,
      );
    } catch (error) {
      sharedSync = {
        enabled: true,
        synced: false,
        message: error instanceof Error ? error.message : "Shared news sync failed.",
      };
    }

    return NextResponse.json({
      ...digest,
      automated: false,
      aiAnalysisMode: getAiNewsAnalysisMode(),
      sharedSync,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to fetch news.",
      },
      { status: 502 },
    );
  }
}
