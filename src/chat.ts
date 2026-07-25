import type { Message, TextBasedChannel } from "discord.js";
import {
  chatCompletionStream,
  type ChatMessage,
  type ContentHandler,
  type StatusHandler,
} from "./llm.js";
import { loadPersona } from "./persona.js";
import { config } from "./config.js";
import { getEmojiListForPrompt } from "./emoji.js";
import { getWebSearchProvider } from "./tools/search/provider.js";
import { getAvailableTools, executeTool } from "./tools/index.js";
import { isArchiveConfigured } from "./tools/archive/index.js";
import { getMemoryContext } from "./memory/store.js";
import { getMessageText } from "./message-text.js";

export const DISCORD_MESSAGE_LIMIT = 2000;

/** 現在の日本時間(JST)を「YYYY年M月D日(曜) HH:MM」形式で返す。 */
function currentJstString(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

// Discordメッセージリンク: https://discord.com/channels/{guild}/{channel}/{message}
const DISCORD_LINK_RE =
  /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/g;
// 1メッセージあたりに解決するリンクの最大数
const MAX_LINKED_MESSAGES = 3;

/**
 * 与えられたテキスト(トリガー本文+履歴)に含まれるDiscordメッセージリンクを解決し、
 * 参照先の「表示名: 内容」を配列で返す。メンションの有無に関わらず、プロンプトに
 * 含まれるリンクを対象にする。取得失敗(権限なし/削除済み)は無視する。
 */
async function resolveLinkedMessages(
  triggerMessage: Message,
  scanText: string
): Promise<string[]> {
  const matches = [...scanText.matchAll(DISCORD_LINK_RE)];
  if (matches.length === 0) return [];
  console.log(`[link] リンクを${matches.length}件検出`);

  const results: string[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    if (results.length >= MAX_LINKED_MESSAGES) break;
    const channelId = match[1];
    const messageId = match[2];
    if (seen.has(messageId)) continue;
    seen.add(messageId);

    try {
      const channel = await triggerMessage.client.channels.fetch(channelId);
      if (!channel || !("messages" in channel) || typeof channel.messages?.fetch !== "function") {
        console.warn(`[link] チャンネル未取得/非対応: ${channelId}`);
        continue;
      }
      const linked = await channel.messages.fetch(messageId);
      const text = getMessageText(linked);
      if (text.trim() !== "") {
        const name = linked.author.displayName ?? linked.author.username;
        results.push(`${name}: ${text}`);
        console.log(`[link] 解決: ${channelId}/${messageId}`);
      } else {
        console.log(`[link] 本文空: ${channelId}/${messageId}`);
      }
    } catch (err) {
      console.error(
        `[link] 取得失敗 ${channelId}/${messageId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return results;
}

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
    .map((m) => ({ name: m.author.displayName ?? m.author.username, text: getMessageText(m) }))
    .filter((m) => m.text.trim() !== "")
    .map((m) => `${m.name}: ${m.text}`);

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

  // 現在の日本時間をシステムプロンプトに入れる(コンテナのTZに依存しないよう明示)
  systemContent += `\n\n現在の日本時間: ${currentJstString()}`;

  // Web検索が有効なら、function callingで調べてから答えるよう指示を追加する
  if (getWebSearchProvider()) {
    systemContent += `\n\n知らないことや最近の出来事、固有名詞などは web_search ツールで調べてから答える。検索結果が無関係なら使わない。`;
  }
  // メッセージ検索は常時有効
  systemContent += `\n\nこのサーバーの過去の発言や話題の経緯は search_messages ツールで調べる。ツールを使っても不要な言及はせず、ペルソナは維持する。`;
  // URL取得は常時有効
  systemContent += `\n\n会話にURLが貼られていて内容が必要なときは fetch_url ツールでそのページを読んでから答える。`;
  // アーカイブ検索が有効なら指示を追加
  if (isArchiveConfigured()) {
    systemContent += `\n\n運営者の過去のツイート(Twitter/X)やBluesky投稿を話題の種にしたいときは search_archive ツールで検索できる。いいねした投稿も含まれる。`;
  }

  // 重層的記憶(長期→短期)を文脈の先頭に注入する
  const memoryContext = getMemoryContext(triggerMessage.channelId);
  const memoryBlock = memoryContext ? `${memoryContext}\n\n` : "";

  // プロンプトに含まれるDiscordリンク(トリガー本文+履歴)を解決して文脈に加える
  const scanText = `${history.join("\n")}\n${getMessageText(triggerMessage)}`;
  const linkedMessages = await resolveLinkedMessages(triggerMessage, scanText);
  const linkedBlock =
    linkedMessages.length > 0 ? `参照されているメッセージ:\n${linkedMessages.join("\n")}\n\n` : "";

  const userContent =
    history.length > 0
      ? `${memoryBlock}${linkedBlock}これまでの会話:\n${history.join("\n")}\n\n上記の文脈を踏まえて、直近のメッセージに自然に返答してください。`
      : `${memoryBlock}${linkedBlock}会話の文脈を踏まえて自然に返答してください。`;

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
  onContent: ContentHandler,
  onStatus?: StatusHandler
): Promise<void> {
  const { messages, tools } = await buildRequest(triggerMessage);
  await chatCompletionStream(messages, tools, executeTool, onContent, onStatus);
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
