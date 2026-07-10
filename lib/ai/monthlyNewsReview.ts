import { buildNewsDigest } from "@/lib/news/sentiment";
import { codexReviewSchema } from "@/lib/news/codexReviewSchemas";
import type { CachedNewsArticle } from "@/lib/storage/types";

export const DEFAULT_MONTHLY_NEWS_MODEL = "gpt-5.5";

export async function generateAutomatedMonthlyNewsReview({
  symbol,
  reviewMonth,
  articles,
  coverageStatus,
  shortfallDayCount,
}: {
  symbol: string;
  reviewMonth: string;
  articles: CachedNewsArticle[];
  coverageStatus: "complete" | "limited";
  shortfallDayCount: number;
}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for automatic monthly news publication.");
  if (articles.length === 0) throw new Error(`No persisted ${symbol} articles are available for ${reviewMonth}.`);

  const model = process.env.OPENAI_MONTHLY_NEWS_MODEL?.trim() || DEFAULT_MONTHLY_NEWS_MODEL;
  const deterministicDigest = buildNewsDigest(symbol, articles, `${reviewMonth}-28T23:59:59.000Z`);
  const evidence = articles.map((article) => ({
    title: article.title,
    publisher: article.source,
    publishedAt: article.publishedAt,
    canonicalUrl: rawString(article.raw, "canonicalUrl") || article.url,
    topic: rawString(article.raw, "topic") || "other",
    duplicateGroupId: rawString(article.raw, "duplicateGroupId"),
    retrievalStatus: rawString(article.raw, "retrievalStatus") || "summaryOnly",
    excerpt: (rawString(article.raw, "cleanedText") || article.summary || "").slice(0, 1800),
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      reasoning: { effort: "medium" },
      input: [
        {
          role: "developer",
          content:
            "You are a conservative public-equity news analyst. Use only the supplied evidence. Do not browse, invent facts, give personalized financial advice, or treat repeated/syndicated coverage as independent evidence. Return valid JSON only.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Write an automatically publishable monthly Deep Context review.",
            symbol,
            reviewMonth,
            coverageStatus,
            shortfallDayCount,
            mandatoryDigest: deterministicDigest,
            outputRequirements: {
              appliedNewsDigest: "Preserve the mandatory digest counts and analysisMode codexReview; choose only signal, confidence, score and concise headlines consistently with the evidence.",
              longTermThesisSignals: "Array of mechanism-focused, durable signals; each item includes theme, direction, materiality and judgement.",
              staleOrNoisyItems: "Array of excluded items with a reason. Include duplicate, price-action and thin-summary caveats where relevant.",
              unresolvedThemes: "Array of specific questions that evidence cannot resolve.",
              suggestedGuideImpact: "Object with rationale, expectedAdjustmentPercent, depositSuggestion and newsSignal. This is decision support, not a price target.",
              rationale: "Concise evidence-weighted synthesis that explicitly notes limited coverage when applicable.",
            },
            articles: evidence,
          }),
        },
      ],
      text: { format: { type: "json_object" } },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI monthly news review failed: ${response.status} ${(await response.text()).slice(0, 240)}`);
  }
  const body = (await response.json()) as unknown;
  const parsed = parseReviewJson(extractOutputText(body));
  const validated = codexReviewSchema.safeParse(parsed);
  if (!validated.success) throw new Error("Automatic monthly review did not match the Codex review schema.");

  const review = validated.data as Record<string, unknown>;
  const digest = isRecord(review.appliedNewsDigest) ? review.appliedNewsDigest : {};
  review.appliedNewsDigest = {
    ...deterministicDigest,
    ...digest,
    articleCount: deterministicDigest.articleCount,
    providerCount: deterministicDigest.providerCount,
    providers: deterministicDigest.providers,
    publisherCount: deterministicDigest.publisherCount,
    publishers: deterministicDigest.publishers,
    positiveArticleCount: deterministicDigest.positiveArticleCount,
    negativeArticleCount: deterministicDigest.negativeArticleCount,
    neutralArticleCount: deterministicDigest.neutralArticleCount,
    analysisMode: "codexReview",
  };
  return { model, review };
}

function extractOutputText(value: unknown) {
  const data = value as { output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("").trim();
  if (!text) throw new Error("OpenAI monthly review response did not include output text.");
  return text;
}

function parseReviewJson(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed) && isRecord(parsed.codexReview)) return parsed.codexReview;
    return parsed;
  } catch {
    throw new Error("OpenAI monthly review response was not valid JSON.");
  }
}

function rawString(raw: unknown, key: string) {
  return isRecord(raw) && typeof raw[key] === "string" ? raw[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
