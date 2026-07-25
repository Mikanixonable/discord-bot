import { config } from "../../config.js";
import { SearxngProvider } from "./searxng.js";
import { TavilyProvider } from "./tavily.js";
import type { WebSearchProvider } from "./types.js";

// config から有効なプロバイダを1つ選ぶ。SearXNG優先、無ければTavily、どちらも未設定ならnull。
export function getWebSearchProvider(): WebSearchProvider | null {
  if (config.searxngUrl) {
    return new SearxngProvider(config.searxngUrl);
  }
  if (config.tavilyApiKey) {
    return new TavilyProvider(config.tavilyApiKey);
  }
  return null;
}
