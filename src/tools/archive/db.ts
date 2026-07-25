import { getDb } from "../messages/db.js";

export interface ArchiveRecord {
  id: string;          // ソース固有のID
  source: string;      // "twitter" | "bluesky"
  kind: string;        // "tweet" | "like" | "post"
  content: string;     // 本文
  createdAt: string;   // ISO風の日付文字列
}

export interface ArchiveHit {
  id: string;
  source: string;
  kind: string;
  content: string;
  createdAt: string;
}

interface ArchiveRow {
  id: string;
  source: string;
  kind: string;
  content: string;
  created_at: string;
}

// アーカイブ検索テーブルを初期化する(messages DBに同居)
export function initArchiveDb(): void {
  getDb().exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS archive USING fts5(
      id UNINDEXED,
      source UNINDEXED,
      kind UNINDEXED,
      content,
      created_at UNINDEXED,
      tokenize = 'trigram'
    );
  `);
}

// レコードをトランザクション内で一括インデックスする
export function indexArchiveRecords(records: ArchiveRecord[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO archive (id, source, kind, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const insertChunk = db.transaction((recs: ArchiveRecord[]) => {
    for (const rec of recs) {
      if (!rec.content || rec.content.trim() === "") continue;
      stmt.run(rec.id, rec.source, rec.kind, rec.content, rec.createdAt);
    }
  });

  // SQLITE_TOOBIG 回避のため1000件ずつチャンク処理する
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    insertChunk(records.slice(i, i + CHUNK_SIZE));
  }
}

// FTS5クエリ文字列をエスケープする
function escapeFtsQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

// アーカイブを全文検索する。3文字未満はトライグラム最小長未満なので空配列
export function searchArchive(query: string, limit: number): ArchiveHit[] {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const ftsQuery = escapeFtsQuery(trimmed);
  const rows = getDb()
    .prepare(
      `SELECT id, source, kind, content, created_at
       FROM archive
       WHERE archive MATCH ?
       ORDER BY bm25(archive) ASC
       LIMIT ?`
    )
    .all(ftsQuery, limit) as ArchiveRow[];

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
  }));
}

// インデックス済みレコード件数を返す
export function getArchiveCount(): number {
  const row = getDb()
    .prepare(`SELECT count(*) AS count FROM archive`)
    .get() as { count: number };
  return row.count;
}
