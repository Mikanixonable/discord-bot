import type { Message } from "discord.js";
import { config } from "../../config.js";
import type { ToolDefinition } from "../../llm.js";
import { indexMessage, searchMessages, type MessageHit } from "./db.js";

/** モデルに渡す search_messages ツールの定義。 */
export const searchMessagesTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search_messages",
    description:
      "このDiscordサーバーの過去の発言を検索する。誰かが以前言ったこと・話題の経緯を調べるのに使う。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語(3文字以上)。会話の代名詞や省略を解決した具体的な語にする",
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

/** epoch ms を YYYY-MM-DD に整形する。 */
function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 検索結果を、tool メッセージに載せるコンパクトなテキストへ整形する(ジャンプリンク付き)。 */
function formatHits(query: string, hits: MessageHit[]): string {
  const lines = hits.map((h, i) => {
    const snippet = h.content.replace(/\s+/g, " ").slice(0, 200);
    const link = h.guildId
      ? ` https://discord.com/channels/${h.guildId}/${h.channelId}/${h.id}`
      : "";
    return `${i + 1}. ${h.authorName} (${formatDate(h.createdAt)}): ${snippet}${link}`;
  });
  return `「${query}」に一致する過去の発言:\n${lines.join("\n")}`;
}

/**
 * search_messages ツールを実行する。ローカルのFTS5インデックスを検索する。
 */
export async function executeMessageSearch(args: unknown): Promise<string> {
  const query = extractQuery(args);
  if (query.length < 3) {
    return "検索語は3文字以上にしてください。";
  }

  const hits = searchMessages(query, config.messageSearchResults);
  if (hits.length === 0) {
    return `「${query}」に一致する過去の発言はありませんでした。`;
  }

  return formatHits(query, hits);
}

/**
 * Discordメッセージを検索インデックスに登録する。本文が空なら何もしない。
 */
export function indexDiscordMessage(msg: Message): void {
  if (!msg.content || msg.content.trim() === "") return;
  indexMessage({
    id: msg.id,
    channelId: msg.channelId,
    guildId: msg.guildId ?? null,
    authorId: msg.author.id,
    authorName: msg.author.displayName ?? msg.author.username,
    content: msg.content,
    createdAt: msg.createdTimestamp,
  });
}
