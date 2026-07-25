import type { SearchResult, WebSearchProvider } from "./types.js";

// Tavily API のレスポンス想定形（未知の値なので防御的に検証する）
interface TavilyResultItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface TavilyResponse {
  results?: unknown;
}

function isTavilyResultItem(value: unknown): value is TavilyResultItem {
  return typeof value === "object" && value !== null;
}

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
      }),
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Tavily検索に失敗しました: status=${res.status} body=${body}`);
    }

    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) {
      return [];
    }

    const results = (data as TavilyResponse).results;
    if (!Array.isArray(results)) {
      return [];
    }

    const parsed: SearchResult[] = [];
    for (const item of results) {
      if (!isTavilyResultItem(item)) continue;
      const { title, url, content } = item;
      if (typeof title !== "string" || typeof url !== "string") continue;
      if (title.length === 0 || url.length === 0) continue;
      parsed.push({
        title,
        url,
        snippet: typeof content === "string" ? content : "",
      });
      if (parsed.length >= limit) break;
    }

    return parsed;
  }
}
