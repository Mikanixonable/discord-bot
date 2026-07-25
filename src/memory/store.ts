import { getDb } from "../tools/messages/db.js";

export interface ChannelMemory {
  channelId: string;
  shortSummary: string;
  longSummary: string;
  coveredUntil: number | null; // 短期記憶に畳み込んだ最後のメッセージの created_at(epoch ms)
  shortUpdates: number; // 短期記憶の更新回数(長期記憶トリガ用)
}

export interface RecentMessage {
  authorName: string;
  content: string;
  createdAt: number;
}

interface ChannelMemoryRow {
  channel_id: string;
  short_summary: string;
  long_summary: string;
  covered_until: number | null;
  short_updates: number;
}

interface RecentMessageRow {
  author_name: string;
  content: string;
  created_at: number;
}

// 記憶ストアを初期化する(messagesと同一のDB接続を共有)
export function initMemoryStore(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS channel_memory (
      channel_id    TEXT PRIMARY KEY,
      short_summary TEXT NOT NULL DEFAULT '',
      long_summary  TEXT NOT NULL DEFAULT '',
      covered_until INTEGER,
      short_updates INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER
    );
  `);
}

// チャンネルの記憶を取得する。無ければ空の既定値を返す
export function getChannelMemory(channelId: string): ChannelMemory {
  const row = getDb()
    .prepare(
      `SELECT channel_id, short_summary, long_summary, covered_until, short_updates
       FROM channel_memory WHERE channel_id = ?`
    )
    .get(channelId) as ChannelMemoryRow | undefined;

  if (!row) {
    return { channelId, shortSummary: "", longSummary: "", coveredUntil: null, shortUpdates: 0 };
  }
  return {
    channelId: row.channel_id,
    shortSummary: row.short_summary,
    longSummary: row.long_summary,
    coveredUntil: row.covered_until,
    shortUpdates: row.short_updates,
  };
}

// チャンネルの記憶を保存する(upsert)
export function saveChannelMemory(mem: ChannelMemory): void {
  getDb()
    .prepare(
      `INSERT INTO channel_memory (channel_id, short_summary, long_summary, covered_until, short_updates, updated_at)
       VALUES (@channelId, @shortSummary, @longSummary, @coveredUntil, @shortUpdates, @updatedAt)
       ON CONFLICT(channel_id) DO UPDATE SET
         short_summary = @shortSummary,
         long_summary  = @longSummary,
         covered_until = @coveredUntil,
         short_updates = @shortUpdates,
         updated_at    = @updatedAt`
    )
    .run({
      channelId: mem.channelId,
      shortSummary: mem.shortSummary,
      longSummary: mem.longSummary,
      coveredUntil: mem.coveredUntil,
      shortUpdates: mem.shortUpdates,
      updatedAt: Date.now(),
    });
}

// 索引済みメッセージから、指定チャンネルの created_at > sinceMs の発言を古い順で取得する
export function getMessagesSince(
  channelId: string,
  sinceMs: number | null,
  limit: number
): RecentMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT author_name, content, created_at
       FROM messages
       WHERE channel_id = ? AND created_at > ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(channelId, sinceMs ?? 0, limit) as RecentMessageRow[];

  return rows.map((r) => ({
    authorName: r.author_name,
    content: r.content,
    createdAt: r.created_at,
  }));
}

// プロンプトに注入する記憶コンテキスト(長期→短期)を返す。空なら空文字
export function getMemoryContext(channelId: string): string {
  const mem = getChannelMemory(channelId);
  const parts: string[] = [];
  if (mem.longSummary.trim()) {
    parts.push(`長期記憶(恒常的な背景):\n${mem.longSummary.trim()}`);
  }
  if (mem.shortSummary.trim()) {
    parts.push(`短期記憶(これまでの流れ):\n${mem.shortSummary.trim()}`);
  }
  return parts.join("\n\n");
}
