import type { Message } from "discord.js";

/**
 * メッセージの実効テキストを返す。
 * 通常の本文に加え、転送メッセージ(messageSnapshots)の内容も含める。
 * 転送は本文が空で、実際の内容はスナップショット側に入るため。
 */
export function getMessageText(msg: Message): string {
  const parts: string[] = [];

  if (msg.content && msg.content.trim() !== "") {
    parts.push(msg.content);
  }

  const snapshots = msg.messageSnapshots;
  if (snapshots && snapshots.size > 0) {
    for (const snap of snapshots.values()) {
      if (snap.content && snap.content.trim() !== "") {
        parts.push(`[転送] ${snap.content}`);
      }
    }
  }

  return parts.join("\n");
}
