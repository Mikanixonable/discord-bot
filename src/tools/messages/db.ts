import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../../config.js";

export interface MessageRecord {
  id: string; // Discordスノーフレーク
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number; // epoch ms
}

export interface MessageHit {
  id: string;
  channelId: string;
  guildId: string | null;
  authorName: string;
  content: string;
  createdAt: number;
}

// FTS5検索結果の生の行の型
interface MessageRow {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author_name: string;
  content: string;
  created_at: number;
}

let db: Database.Database | null = null;

let insertStmt: Database.Statement | null = null;
let deleteStmt: Database.Statement | null = null;
let updateContentStmt: Database.Statement | null = null;
let countStmt: Database.Statement | null = null;

// DB接続を初期化する。既に開いている場合は何もしない
export function initMessageDb(): void {
  if (db) return;

  mkdirSync(dirname(config.messageDbPath), { recursive: true });
  db = new Database(config.messageDbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
      id UNINDEXED,
      channel_id UNINDEXED,
      guild_id UNINDEXED,
      author_id UNINDEXED,
      author_name UNINDEXED,
      content,
      created_at UNINDEXED,
      tokenize = 'trigram'
    );
  `);
}

// 未初期化なら遅延初期化してDB接続を返す
function getDb(): Database.Database {
  if (!db) {
    initMessageDb();
  }
  return db!;
}

function getInsertStmt(): Database.Statement {
  if (!insertStmt) {
    insertStmt = getDb().prepare(
      `INSERT INTO messages (id, channel_id, guild_id, author_id, author_name, content, created_at)
       VALUES (@id, @channelId, @guildId, @authorId, @authorName, @content, @createdAt)`
    );
  }
  return insertStmt;
}

function getDeleteStmt(): Database.Statement {
  if (!deleteStmt) {
    deleteStmt = getDb().prepare(`DELETE FROM messages WHERE id = ?`);
  }
  return deleteStmt;
}

function getUpdateContentStmt(): Database.Statement {
  if (!updateContentStmt) {
    updateContentStmt = getDb().prepare(`UPDATE messages SET content = ? WHERE id = ?`);
  }
  return updateContentStmt;
}

function getCountStmt(): Database.Statement {
  if (!countStmt) {
    countStmt = getDb().prepare(`SELECT count(*) AS count FROM messages`);
  }
  return countStmt;
}

// メッセージをインデックスに登録(idで既存があれば入れ替え)。内容が空/空白のみの場合はスキップ
export function indexMessage(rec: MessageRecord): void {
  if (!rec.content || rec.content.trim() === "") return;

  getDb();
  getDeleteStmt().run(rec.id);
  getInsertStmt().run({
    id: rec.id,
    channelId: rec.channelId,
    guildId: rec.guildId,
    authorId: rec.authorId,
    authorName: rec.authorName,
    content: rec.content,
    createdAt: rec.createdAt,
  });
}

// 既存メッセージの本文を更新する(空になった場合は削除する)
export function updateMessageContent(id: string, content: string): void {
  getDb();
  if (!content || content.trim() === "") {
    deleteMessage(id);
    return;
  }
  getUpdateContentStmt().run(content, id);
}

// メッセージをインデックスから削除する
export function deleteMessage(id: string): void {
  getDb();
  getDeleteStmt().run(id);
}

// クエリ文字列をFTS5に安全に渡すため、二重引用符でエスケープしたリテラル文字列として包む
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

// メッセージを全文検索する。クエリが3文字未満(トライグラムの最小長)なら空配列を返す
export function searchMessages(query: string, limit: number, guildId?: string | null): MessageHit[] {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const database = getDb();
  const ftsQuery = escapeFtsQuery(trimmed);

  let sql = `
    SELECT id, channel_id, guild_id, author_name, content, created_at
    FROM messages
    WHERE messages MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (guildId !== undefined && guildId !== null) {
    sql += ` AND guild_id = ?`;
    params.push(guildId);
  }

  sql += ` ORDER BY bm25(messages) ASC LIMIT ?`;
  params.push(limit);

  const rows = database.prepare(sql).all(...params) as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
  }));
}

// インデックス済みメッセージ件数を取得する(起動時ログ用)
export function getIndexedCount(): number {
  const row = getCountStmt().get() as { count: number };
  return row.count;
}
