import type { SearchResult, WebSearchProvider } from "./types.js";

// SearXNG API のレスポンス想定形（未知の値なので防御的に検証する）
interface SearxngResultItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface SearxngResponse {
  results?: unknown;
}

function isSearxngResultItem(value: unknown): value is SearxngResultItem {
  return typeof value === "object" && value !== null;
}

export class SearxngProvider implements WebSearchProvider {
  readonly name = "searxng";

  constructor(private readonly baseUrl: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=ja`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`SearXNG検索に失敗しました: status=${res.status} body=${body}`);
    }

    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) {
      return [];
    }

    const results = (data as SearxngResponse).results;
    if (!Array.isArray(results)) {
      return [];
    }

    const parsed: SearchResult[] = [];
    for (const item of results) {
      if (!isSearxngResultItem(item)) continue;
      const { title, url: itemUrl, content } = item;
      if (typeof title !== "string" || typeof itemUrl !== "string") continue;
      if (title.length === 0 || itemUrl.length === 0) continue;
      parsed.push({
        title,
        url: itemUrl,
        snippet: typeof content === "string" ? content : "",
      });
      if (parsed.length >= limit) break;
    }

    return parsed;
  }
}
