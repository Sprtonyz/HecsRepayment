import { NextRequest, NextResponse } from "next/server";
import { collectDailyDeepContextNews } from "@/lib/news/automation/collector";
import { getActiveDeepContextSymbols } from "@/lib/news/automation/sourceRegistry";
import {
  claimAutomatedNewsCollection,
  failAutomatedNewsCollection,
  persistAutomatedNewsCollection,
} from "@/lib/shared-news/automationStore";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const marketDate = newYorkMarketDate();
  const symbols = getActiveDeepContextSymbols();
  const runDefinition = {
    marketDate,
    runKey: `deep-context-news:${marketDate}`,
    targetCount: symbols.length,
  };

  try {
    const claim = await claimAutomatedNewsCollection(runDefinition);
    if (!claim.enabled) {
      return noStoreJson({ error: "Shared news automation is not configured." }, { status: 503 });
    }
    if (!claim.claimed || !claim.runId) {
      return noStoreJson({ skipped: true, marketDate, status: claim.status ?? "unknown" });
    }

    try {
      const outcome = await collectDailyDeepContextNews({ symbols, marketDate });
      const metrics = await persistAutomatedNewsCollection(claim.runId, outcome);
      return noStoreJson({
        completed: true,
        runId: claim.runId,
        marketDate,
        selectedSymbols: outcome.selected.map((article) => article.symbol),
        shortfalls: outcome.tickerOutcomes
          .filter((ticker) => !ticker.selected)
          .map((ticker) => ({ symbol: ticker.symbol, reason: ticker.shortfallReason })),
        metrics,
      });
    } catch (error) {
      await failAutomatedNewsCollection(
        claim.runId,
        error instanceof Error ? error.message : "Unknown automated collection failure.",
      );
      throw error;
    }
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : "Could not collect Deep Context news." },
      { status: 500 },
    );
  }
}

function isAuthorizedCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function newYorkMarketDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function noStoreJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "cache-control": "no-store" },
  });
}
