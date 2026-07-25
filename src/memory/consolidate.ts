import { config } from "../config.js";
import { completeOnce, type ChatMessage } from "../llm.js";
import {
  getChannelMemory,
  saveChannelMemory,
  getMessagesSince,
  type RecentMessage,
} from "./store.js";

// 同一チャンネルの consolidation が多重に走らないようにするためのガード
const inProgress = new Set<string>();

/** 短期記憶(要約)を更新する。旧要約と新しい会話を統合する。 */
async function summarizeShort(oldSummary: string, conversation: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "あなたは会話ログを簡潔に要約するアシスタント。要約本文のみを出力する。",
    },
    {
      role: "user",
      content: `これまでの要約:\n${oldSummary || "(なし)"}\n\n新しい会話:\n${conversation}\n\n上の2つを統合し、重要な事実・決定・話題・人物の傾向を残して${config.memoryShortMaxChars}字以内の日本語で要約を更新して。要約本文のみを出力。`,
    },
  ];
  const out = await completeOnce(messages);
  // 上限を大きく超えた場合の安全クランプ
  return out.slice(0, config.memoryShortMaxChars * 2);
}

/** 長期記憶(圧縮)を更新する。旧長期記憶と現短期記憶を蒸留する。 */
async function summarizeLong(oldLong: string, shortSummary: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "あなたは記憶を圧縮するアシスタント。本文のみを出力する。",
    },
    {
      role: "user",
      content: `長期記憶:\n${oldLong || "(なし)"}\n\n最近の短期要約:\n${shortSummary}\n\n恒常的な事実・人物像・繰り返す話題・進行中の状態を抽出し、一過性のノイズを除いて${config.memoryLongMaxChars}字以内の日本語に圧縮した長期記憶を出力して。本文のみを出力。`,
    },
  ];
  const out = await completeOnce(messages);
  return out.slice(0, config.memoryLongMaxChars * 2);
}

function toConversationText(messages: RecentMessage[]): string {
  return messages.map((m) => `${m.authorName}: ${m.content}`).join("\n");
}

/**
 * チャンネルの記憶を必要に応じて更新する。応答後にバックグラウンドで呼ぶ想定。
 * 新規メッセージがしきい値未満なら何もしない。
 */
export async function consolidateChannel(channelId: string): Promise<void> {
  if (inProgress.has(channelId)) return;
  inProgress.add(channelId);
  try {
    const mem = getChannelMemory(channelId);
    const newMessages = getMessagesSince(channelId, mem.coveredUntil, 500);
    if (newMessages.length < config.memoryFoldThreshold) return;

    // L2: 短期記憶を更新
    const conversation = toConversationText(newMessages);
    const shortSummary = await summarizeShort(mem.shortSummary, conversation);
    if (!shortSummary) return; // 要約が空なら記憶を進めない(covered_untilも据え置き)

    const coveredUntil = newMessages[newMessages.length - 1].createdAt;
    let shortUpdates = mem.shortUpdates + 1;
    let longSummary = mem.longSummary;

    // L3: 一定回数ごとに長期記憶を更新
    if (shortUpdates >= config.memoryLongEvery) {
      const compressed = await summarizeLong(mem.longSummary, shortSummary);
      if (compressed) {
        longSummary = compressed;
        shortUpdates = 0;
      }
    }

    saveChannelMemory({ channelId, shortSummary, longSummary, coveredUntil, shortUpdates });
    console.log(
      `[memory] ${channelId} 更新: 新規${newMessages.length}件, short=${shortSummary.length}字, long=${longSummary.length}字`
    );
  } catch (err) {
    console.error("[memory] consolidationに失敗:", err);
  } finally {
    inProgress.delete(channelId);
  }
}
