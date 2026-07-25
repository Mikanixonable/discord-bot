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
  // fetch_url で取得するページ本文の最大文字数
  fetchUrlMaxChars: number;
  // fetch_url のタイムアウト(ミリ秒)
  fetchUrlTimeoutMs: number;
  // 短期記憶(要約)の最大文字数
  memoryShortMaxChars: number;
  // 長期記憶(圧縮)の最大文字数
  memoryLongMaxChars: number;
  // 短期記憶を1回更新するのに必要な新規メッセージ数のしきい値
  memoryFoldThreshold: number;
  // 短期記憶を何回更新したら長期記憶を更新するか
  memoryLongEvery: number;
  // メッセージ全文検索用SQLite DBのファイルパス
  messageDbPath: string;
  // メッセージ検索結果の取得件数
  messageSearchResults: number;
  // 起動時に履歴をバックフィルする対象チャンネル/スレッドID(空なら自動返信チャンネルのみ)
  backfillChannels: Set<string>;
  // 起動時バックフィルで取得するチャンネルごとの最大メッセージ数
  backfillMax: number;
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
  // fetch_urlで取得するページ本文の最大文字数（デフォルト4000）。FETCH_URL_MAX_CHARSで変更可能
  fetchUrlMaxChars: parsePositiveInt(process.env.FETCH_URL_MAX_CHARS, 4000),
  // fetch_urlのタイムアウト(ミリ秒)（デフォルト10000）。FETCH_URL_TIMEOUT_MSで変更可能
  fetchUrlTimeoutMs: parsePositiveInt(process.env.FETCH_URL_TIMEOUT_MS, 10000),
  // メッセージ全文検索用SQLite DBのファイルパス。MESSAGE_DB_PATHで変更可能
  messageDbPath: process.env.MESSAGE_DB_PATH || "./data/messages.db",
  // メッセージ検索結果の取得件数（デフォルト5件）。MESSAGE_SEARCH_RESULTSで変更可能
  messageSearchResults: parsePositiveInt(process.env.MESSAGE_SEARCH_RESULTS, 5),
  // 起動時バックフィル対象チャンネル/スレッドID（空なら自動返信チャンネルのみ対象）
  backfillChannels: parseChannelIds(process.env.BACKFILL_CHANNELS),
  // 起動時バックフィルで取得するチャンネルごとの最大メッセージ数（デフォルト500）。BACKFILL_MAXで変更可能
  backfillMax: parsePositiveInt(process.env.BACKFILL_MAX, 500),
  // 短期記憶(要約)の最大文字数（デフォルト800）。MEMORY_SHORT_MAX_CHARSで変更可能
  memoryShortMaxChars: parsePositiveInt(process.env.MEMORY_SHORT_MAX_CHARS, 800),
  // 長期記憶(圧縮)の最大文字数（デフォルト400）。MEMORY_LONG_MAX_CHARSで変更可能
  memoryLongMaxChars: parsePositiveInt(process.env.MEMORY_LONG_MAX_CHARS, 400),
  // 短期記憶を更新するのに必要な新規メッセージ数（デフォルト15）。MEMORY_FOLD_THRESHOLDで変更可能
  memoryFoldThreshold: parsePositiveInt(process.env.MEMORY_FOLD_THRESHOLD, 15),
  // 何回短期記憶を更新したら長期記憶を更新するか（デフォルト5）。MEMORY_LONG_EVERYで変更可能
  memoryLongEvery: parsePositiveInt(process.env.MEMORY_LONG_EVERY, 5),
};
