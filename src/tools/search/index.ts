import { config } from "../../config.js";
import type { ToolDefinition } from "../../llm.js";
import { getWebSearchProvider } from "./provider.js";
import type { SearchResult } from "./types.js";

/** モデルに渡す web_search ツールの定義。 */
export const webSearchTool: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "最新の出来事・知らない事柄・固有名詞などを一般Web検索で調べる。確信が持てない事実はこれで確認する。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語。会話の代名詞や省略を解決した具体的な語にする",
        },
      },
      required: ["query"],
    },
  },
};

/** args から query 文字列を取り出す(防御的)。 */
function extractQuery(args: unknown): string {
  if (typeof args === "object" && args !== null && "query" in args) {
    const query = (args as { query: unknown }).query;
    if (typeof query === "string") return query.trim();
  }
  return "";
}

/** 検索結果を、tool メッセージに載せるコンパクトなテキストへ整形する。 */
function formatResults(query: string, results: SearchResult[]): string {
  const lines = results.map((r, i) => {
    const snippet = r.snippet.replace(/\s+/g, " ").slice(0, 200);
    return `${i + 1}. ${r.title} — ${snippet} (${r.url})`;
  });
  return `「${query}」の検索結果:\n${lines.join("\n")}`;
}

/**
 * モデルからのツール呼び出しを実行する。web_search のみ対応。
 */
export async function executeTool(name: string, args: unknown): Promise<string> {
  if (name !== "web_search") {
    return `未知のツール: ${name}`;
  }

  const query = extractQuery(args);
  if (!query) {
    return "検索クエリが空です。";
  }

  const provider = getWebSearchProvider();
  if (!provider) {
    return "Web検索は設定されていません。";
  }

  const results = await provider.search(query, config.webSearchResults);
  if (results.length === 0) {
    return `「${query}」の検索結果はありませんでした。`;
  }

  return formatResults(query, results);
}
