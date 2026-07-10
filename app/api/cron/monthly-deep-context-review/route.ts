import { NextRequest, NextResponse } from "next/server";
import { generateAutomatedMonthlyNewsReview } from "@/lib/ai/monthlyNewsReview";
import { getActiveDeepContextSymbols } from "@/lib/news/automation/sourceRegistry";
import { upsertSharedCodexReview } from "@/lib/shared-news/store";
import {
  getAutomatedMonthlyCoverage,
  getAutomatedMonthlyReportStatus,
  getAutomatedNewsArticlesForMonth,
  saveAutomatedMonthlyReport,
} from "@/lib/shared-news/automationStore";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const reviewMonth = previousMonth();
  try {
    const coverage = await getAutomatedMonthlyCoverage(reviewMonth);
    const coverageStatus = coverage.daysWithShortfall > 0 ? "limited" : "complete";
    const results = [];

    for (const symbol of getActiveDeepContextSymbols()) {
      if ((await getAutomatedMonthlyReportStatus(symbol, reviewMonth)) === "published") {
        results.push({ symbol, status: "skipped-published" });
        continue;
      }
      const articles = await getAutomatedNewsArticlesForMonth(symbol, reviewMonth);
      try {
        await saveAutomatedMonthlyReport({
          symbol,
          reviewMonth,
          status: "processing",
          coverageStatus,
          collectedArticleCount: articles.length,
          shortfallDayCount: coverage.daysWithShortfall,
        });
        const generated = await generateAutomatedMonthlyNewsReview({
          symbol,
          reviewMonth,
          articles,
          coverageStatus,
          shortfallDayCount: coverage.daysWithShortfall,
        });
        await upsertSharedCodexReview({
          symbol,
          reviewMonth,
          generatedAt: new Date().toISOString(),
          includedArticleCount: articles.length,
          sourceUpdatedAt: new Date().toISOString(),
          codexReview: generated.review,
        });
        await saveAutomatedMonthlyReport({
          symbol,
          reviewMonth,
          status: "published",
          coverageStatus,
          collectedArticleCount: articles.length,
          shortfallDayCount: coverage.daysWithShortfall,
          model: generated.model,
          report: generated.review,
        });
        results.push({ symbol, status: "published", articleCount: articles.length });
      } catch (error) {
        await saveAutomatedMonthlyReport({
          symbol,
          reviewMonth,
          status: "failed",
          coverageStatus,
          collectedArticleCount: articles.length,
          shortfallDayCount: coverage.daysWithShortfall,
          errorSummary: error instanceof Error ? error.message : "Unknown report generation failure.",
        });
        results.push({ symbol, status: "failed", error: error instanceof Error ? error.message : "Unknown error" });
      }
    }

    const anyPublished = results.some((result) => result.status === "published");
    const anyFailed = results.some((result) => result.status === "failed");
    return noStoreJson({ reviewMonth, coverage, results }, { status: anyFailed && !anyPublished ? 500 : 200 });
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : "Could not generate monthly Deep Context reviews." },
      { status: 500 },
    );
  }
}

function isAuthorizedCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function previousMonth() {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return previous.toISOString().slice(0, 7);
}

function noStoreJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "cache-control": "no-store" },
  });
}
