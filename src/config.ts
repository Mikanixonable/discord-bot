import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`環境変数 ${name} が設定されていません。.env を確認してください。`);
  }
  return value;
}

function parseChannelIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );
}

function parseMaxTokens(raw: string | undefined): number {
  return parsePositiveInt(raw, 512);
}

// 正の整数を環境変数からパースする共通ヘルパー。不正/未設定時はdefaultValueを返す
function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

// 末尾スラッシュを除去した空でない文字列、または未設定ならnullを返す
function parseOptionalUrl(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  return raw.trim().replace(/\/+$/, "");
}

// 空でない文字列、または未設定ならnullを返す
function parseOptionalString(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}

export interface Config {
  discordToken: string;
  autoReplyChannelIds: Set<string>;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  historyLimit: number;
  historyMaxChars: number;
  maxTokens: number;
  // SearXNGのベースURL（未設定ならnull。末尾スラッシュは除去）
  searxngUrl: string | null;
  // Tavily APIキー（未設定ならnull）
  tavilyApiKey: string | null;
  // Web検索結果の取得件数
  webSearchResults: number;
  // ツール呼び出しの最大ラウンド数
  maxToolRounds: number;
}

export const config: Config = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  autoReplyChannelIds: parseChannelIds(process.env.AUTO_REPLY_CHANNEL_IDS),
  llmBaseUrl: (process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""),
  llmModel: process.env.LLM_MODEL || "llama3.1",
  llmApiKey: process.env.LLM_API_KEY || "ollama",
  historyLimit: 10,
  // プロンプトに注入する会話履歴の合計文字数上限（速度優先の軽量化）
  historyMaxChars: 1000,
  // 生成トークン数の上限（速度優先）。LLM_MAX_TOKENSで変更可能
  maxTokens: parseMaxTokens(process.env.LLM_MAX_TOKENS),
  // SearXNGのベースURL。未設定ならWeb検索プロバイダとして使用しない
  searxngUrl: parseOptionalUrl(process.env.SEARXNG_URL),
  // Tavily APIキー。未設定ならWeb検索プロバイダとして使用しない
  tavilyApiKey: parseOptionalString(process.env.TAVILY_API_KEY),
  // Web検索結果の取得件数（デフォルト4件）。WEB_SEARCH_RESULTSで変更可能
  webSearchResults: parsePositiveInt(process.env.WEB_SEARCH_RESULTS, 4),
  // ツール呼び出しの最大ラウンド数（デフォルト3）。MAX_TOOL_ROUNDSで変更可能
  maxToolRounds: parsePositiveInt(process.env.MAX_TOOL_ROUNDS, 3),
};
