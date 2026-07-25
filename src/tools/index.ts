import type { ToolDefinition } from "../llm.js";
import { getWebSearchProvider } from "./search/provider.js";
import { webSearchTool, executeWebSearch } from "./search/index.js";
import { searchMessagesTool, executeMessageSearch } from "./messages/index.js";

/**
 * 現在有効なツール定義の一覧を返す。
 * - web_search: SearXNG/Tavily が設定されている場合のみ
 * - search_messages: ローカルインデックスなので常時有効
 */
export function getAvailableTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (getWebSearchProvider()) {
    tools.push(webSearchTool);
  }
  tools.push(searchMessagesTool);
  return tools;
}

/**
 * モデルからのツール呼び出しを名前でディスパッチして実行する。
 */
export async function executeTool(name: string, args: unknown): Promise<string> {
  switch (name) {
    case "web_search":
      return executeWebSearch(args);
    case "search_messages":
      return executeMessageSearch(args);
    default:
      return `未知のツール: ${name}`;
  }
}
