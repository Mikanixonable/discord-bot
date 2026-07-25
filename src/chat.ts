import type { Message, TextBasedChannel } from "discord.js";
import { chatCompletion, type ChatMessage } from "./llm.js";
import { loadPersona } from "./persona.js";
import { config } from "./config.js";
import { getEmojiListForPrompt } from "./emoji.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * チャンネルの直近メッセージ履歴を取得し、「ユーザー名: 内容」形式の文字列配列にして返す。
 * 取得順は古い→新しい順に並べ替える。
 */
async function fetchRecentHistory(channel: TextBasedChannel, limit: number): Promise<string[]> {
  if (!("messages" in channel) || typeof channel.messages?.fetch !== "function") {
    return [];
  }

  const fetched = await channel.messages.fetch({ limit });
  const sorted = [...fetched.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  return sorted
    .filter((m) => m.content && m.content.trim() !== "")
    .map((m) => `${m.author.displayName ?? m.author.username}: ${m.content}`);
}

/**
 * メッセージ履歴とキャラ設定からLLM応答を生成する。
 */
export async function generateReply(triggerMessage: Message): Promise<string> {
  const persona = loadPersona();
  const history = await fetchRecentHistory(triggerMessage.channel, config.historyLimit);

  const emojiList = getEmojiListForPrompt();
  const systemContent =
    emojiList.length > 0
      ? `${persona}\n\n使用可能なサーバー絵文字（文中にそのまま :name: と書けば実際の絵文字に変換される。バッククォートやコードブロックで囲まないこと。使いすぎない）: ${emojiList}`
      : persona;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    {
      role: "user",
      content:
        history.length > 0
          ? `これまでの会話:\n${history.join("\n")}\n\n上記の文脈を踏まえて、直近のメッセージに自然に返答してください。`
          : "会話の文脈を踏まえて自然に返答してください。",
    },
  ];

  return chatCompletion(messages);
}

/**
 * Discordの2000文字制限に合わせてテキストを分割する。
 * 改行を優先的な分割点として使い、それでも収まらない場合は強制的に切る。
 */
export function splitForDiscord(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cutIndex = remaining.lastIndexOf("\n", limit);
    if (cutIndex <= 0) {
      cutIndex = limit;
    }
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex).replace(/^\n+/, "");
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
