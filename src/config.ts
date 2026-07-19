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

export interface Config {
  discordToken: string;
  autoReplyChannelIds: Set<string>;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  historyLimit: number;
}

export const config: Config = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  autoReplyChannelIds: parseChannelIds(process.env.AUTO_REPLY_CHANNEL_IDS),
  llmBaseUrl: (process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, ""),
  llmModel: process.env.LLM_MODEL || "llama3.1",
  llmApiKey: process.env.LLM_API_KEY || "ollama",
  historyLimit: 20,
};
