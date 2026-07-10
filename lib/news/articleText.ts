export type ArticleTextResult = {
  text: string;
  status: "read" | "summaryOnly" | "unavailable";
  canonicalUrl?: string;
  failureReason?: string;
};

const MAX_ARTICLE_CHARS = 12_000;
const MIN_READABLE_CHARS = 800;
const ARTICLE_USER_AGENT = "AAPL Catch-Up Tracker/1.0 permitted-news-collector";
const robotsPolicyCache = new Map<string, Promise<{ allowed: boolean; reason?: string }>>();
const BOILERPLATE_LINE_PATTERNS = [
  /^(oops,? something went wrong|skip to (navigation|main content|right column)|terms and privacy|your privacy choices)$/i,
  /^(subscribe|sign up|advertisement|advertisement - continue reading below)$/i,
];

export async function fetchReadableArticleText(
  url: string,
  fallbackText: string,
): Promise<ArticleTextResult> {
  try {
    const resolvedUrl = await resolveRedirects(url);
    const policy = await robotsPolicyFor(resolvedUrl);
    if (!policy.allowed) {
      return fallbackArticleText(fallbackText, policy.reason || "robots-disallowed", resolvedUrl);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetchWithRetry(resolvedUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "user-agent": ARTICLE_USER_AGENT,
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return fallbackArticleText(fallbackText, `http-${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const readable = contentType.includes("text/plain")
      ? normalizeText(raw)
      : extractTextFromHtml(raw);

    const cleaned = removeArticleBoilerplate(readable);
    if (cleaned.length >= MIN_READABLE_CHARS) {
      return {
        text: cleaned.slice(0, MAX_ARTICLE_CHARS),
        status: "read",
        canonicalUrl: response.url || url,
      };
    }

    return fallbackArticleText(fallbackText || cleaned, "insufficient-readable-text", response.url || url);
  } catch (error) {
    return fallbackArticleText(
      fallbackText,
      error instanceof Error && error.name === "AbortError" ? "timeout" : "request-failed",
    );
  }
}

async function resolveRedirects(initialUrl: string) {
  // Google News RSS exposes an aggregation URL. Resolve it before retrieval so
  // primary/reputable originals do not remain permanently classified as feeds.
  try {
    if (new URL(initialUrl).hostname.toLowerCase() === "news.google.com") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(initialUrl, {
          headers: { "user-agent": ARTICLE_USER_AGENT },
          redirect: "follow",
          signal: controller.signal,
        });
        const resolvedUrl = response.url;
        await response.body?.cancel();
        if (resolvedUrl && resolvedUrl !== initialUrl) return resolvedUrl;
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch {
    // Continue to conservative manual redirects.
  }
  let currentUrl = initialUrl;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(currentUrl, {
        headers: { "user-agent": ARTICLE_USER_AGENT, range: "bytes=0-0" },
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || response.status < 300 || response.status >= 400) {
        return currentUrl;
      }
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      return currentUrl;
    } finally {
      clearTimeout(timeout);
    }
  }
  return currentUrl;
}

async function robotsPolicyFor(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }
  const key = url.origin;
  let policy = robotsPolicyCache.get(key);
  if (!policy) {
    policy = loadRobotsPolicy(url.origin);
    robotsPolicyCache.set(key, policy);
  }
  const result = await policy;
  if (!result.allowed) return result;
  const disallowedPaths = (result as { disallowedPaths?: string[] }).disallowedPaths ?? [];
  return disallowedPaths.some((path) => path && url.pathname.startsWith(path))
    ? { allowed: false, reason: "robots-disallowed" }
    : { allowed: true };
}

async function loadRobotsPolicy(origin: string): Promise<{ allowed: boolean; reason?: string; disallowedPaths?: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": ARTICLE_USER_AGENT, accept: "text/plain,*/*;q=0.5" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 404) return { allowed: true, disallowedPaths: [] };
    if (!response.ok) return { allowed: false, reason: "robots-unavailable" };
    return { allowed: true, disallowedPaths: robotsDisallowPaths(await response.text()) };
  } catch {
    return { allowed: false, reason: "robots-unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function robotsDisallowPaths(robots: string) {
  const wildcardPaths: string[] = [];
  let applies = false;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase() === "aapl catch-up tracker";
    } else if (key === "disallow" && applies && value) {
      wildcardPaths.push(value);
    }
  }
  return wildcardPaths;
}

async function fetchWithRetry(url: string, init: RequestInit) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      failure = new Error(`article-http-${response.status}`);
    } catch (error) {
      failure = error;
    }
    if (attempt < 2) await delay(300 * 2 ** attempt);
  }
  throw failure instanceof Error ? failure : new Error("article-request-failed");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function fallbackArticleText(
  fallbackText: string,
  failureReason?: string,
  canonicalUrl?: string,
): ArticleTextResult {
  const text = normalizeText(fallbackText).slice(0, MAX_ARTICLE_CHARS);
  return {
    text,
    status: text ? "summaryOnly" : "unavailable",
    canonicalUrl,
    failureReason,
  };
}

function extractTextFromHtml(html: string) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form|button|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|h1|h2|h3|li|blockquote|article|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return normalizeText(decodeHtmlEntities(withoutNoise));
}

function normalizeText(value: string) {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeArticleBoilerplate(value: string) {
  return normalizeText(
    value
      .split(/\n+/)
      .filter((line) => !BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
      .join("\n"),
  );
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized === "amp") {
      return "&";
    }
    if (normalized === "lt") {
      return "<";
    }
    if (normalized === "gt") {
      return ">";
    }
    if (normalized === "quot") {
      return "\"";
    }
    if (normalized === "apos") {
      return "'";
    }
    if (normalized === "nbsp") {
      return " ";
    }
    if (normalized.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }
    return entity;
  });
}
