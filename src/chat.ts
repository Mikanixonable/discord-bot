import type { Message, TextBasedChannel } from "discord.js";
import { chatCompletionStream, type ChatMessage, type ContentHandler } from "./llm.js";
import { loadPersona } from "./persona.js";
import { config } from "./config.js";
import { getEmojiListForPrompt } from "./emoji.js";
import { getWebSearchProvider } from "./tools/search/provider.js";
import { getAvailableTools, executeTool } from "./tools/index.js";
import { getMemoryContext } from "./memory/store.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * チャンネルの直近メッセージ履歴を取得し、「ユーザー名: 内容」形式の文字列配列にして返す。
 * 取得順は古い→新しい順に並べ替える。
 */
async function fetchRecentHistory(
  channel: TextBasedChannel,
  limit: number,
  maxChars: number
): Promise<string[]> {
  if (!("messages" in channel) || typeof channel.messages?.fetch !== "function") {
    return [];
  }

  const fetched = await channel.messages.fetch({ limit });
  const sorted = [...fetched.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const lines = sorted
    .filter((m) => m.content && m.content.trim() !== "")
    .map((m) => `${m.author.displayName ?? m.author.username}: ${m.content}`);

  // 新しい方から文字数を積算し、maxCharsを超える古いメッセージは切り捨てる
  const included: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const cost = line.length + 1; // 行間の改行分を含める
    if (total + cost > maxChars) {
      if (included.length === 0) {
        included.push(line.slice(0, maxChars));
      }
      break;
    }
    included.unshift(line);
    total += cost;
  }

  return included;
}

/**
 * メッセージ履歴とキャラ設定からLLMへ渡すメッセージ列と、使用するツールを組み立てる。
 */
async function buildRequest(
  triggerMessage: Message
): Promise<{ messages: ChatMessage[]; tools: ReturnType<typeof getAvailableTools> }> {
  const persona = loadPersona();
  const history = await fetchRecentHistory(
    triggerMessage.channel,
    config.historyLimit,
    config.historyMaxChars
  );

  const emojiList = getEmojiListForPrompt();
  let systemContent =
    emojiList.length > 0
      ? `${persona}\n\n使用可能なサーバー絵文字（文中にそのまま :name: と書けば実際の絵文字に変換される。バッククォートやコードブロックで囲まないこと。使いすぎない）: ${emojiList}`
      : persona;

  // Web検索が有効なら、function callingで調べてから答えるよう指示を追加する
  if (getWebSearchProvider()) {
    systemContent += `\n\n知らないことや最近の出来事、固有名詞などは web_search ツールで調べてから答える。検索結果が無関係なら使わない。`;
  }
  // メッセージ検索は常時有効
  systemContent += `\n\nこのサーバーの過去の発言や話題の経緯は search_messages ツールで調べる。ツールを使っても不要な言及はせず、ペルソナは維持する。`;

  // 重層的記憶(長期→短期)を文脈の先頭に注入する
  const memoryContext = getMemoryContext(triggerMessage.channelId);
  const memoryBlock = memoryContext ? `${memoryContext}\n\n` : "";

  const userContent =
    history.length > 0
      ? `${memoryBlock}これまでの会話:\n${history.join("\n")}\n\n上記の文脈を踏まえて、直近のメッセージに自然に返答してください。`
      : `${memoryBlock}会話の文脈を踏まえて自然に返答してください。`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return { messages, tools: getAvailableTools() };
}

/**
 * LLM応答をストリーミングで生成し、content の増分を onContent へ流す。
 */
export async function generateReplyStream(
  triggerMessage: Message,
  onContent: ContentHandler
): Promise<void> {
  const { messages, tools } = await buildRequest(triggerMessage);
  await chatCompletionStream(messages, tools, executeTool, onContent);
}

/**
 * ストリーミングされる content を空白行(段落境界)ごとに区切ってセグメントとして流す。
 * push は同期だが、onSegment(投稿)の順序を保つため内部で Promise チェーンにする。
 */
export function createParagraphSegmenter(
  onSegment: (segment: string) => Promise<void>
): { push: (delta: string) => void; flush: () => Promise<void> } {
  let buffer = "";
  let chain: Promise<void> = Promise.resolve();

  const emit = (segment: string): void => {
    const text = segment.trim();
    if (text.length === 0) return;
    chain = chain.then(() => onSegment(text));
  };

  return {
    push(delta: string): void {
      buffer += delta;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    },
    async flush(): Promise<void> {
      emit(buffer);
      buffer = "";
      await chain;
    },
  };
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
