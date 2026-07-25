import type { ToolDefinition } from "../../llm.js";
import { config } from "../../config.js";
import {
  initArchiveDb,
  indexArchiveRecords,
  searchArchive,
  getArchiveCount,
} from "./db.js";
import { parseTwitterArchive } from "./parse-twitter.js";
import { parseBlueskyArchive } from "./parse-bluesky.js";

// ツール定義
export const searchArchiveTool: ToolDefinition = {
  type: "function",
  function: {
    name: "search_archive",
    description:
      "ボットの運営者のTwitter(X)やBlueskyの過去のツイート・いいねを全文検索する。話題の種を探すときや、過去の発言を参照したいときに使う。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索キーワード(3文字以上)",
        },
      },
      required: ["query"],
    },
  },
};

// ツール実行
export async function executeArchiveSearch(args: unknown): Promise<string> {
  const { query } = args as { query?: string };
  if (!query || query.trim().length < 3) {
    return "検索クエリは3文字以上にしてください。";
  }

  const hits = searchArchive(query.trim(), config.archiveSearchResults);
  if (hits.length === 0) {
    return `「${query}」に該当するアーカイブは見つかりませんでした。`;
  }

  const lines = hits.map((h) => {
    const sourceLabel = h.source === "twitter" ? "Twitter" : "Bluesky";
    const kindLabel = h.kind === "like" ? "いいね" : "投稿";
    const date = h.createdAt ? ` (${h.createdAt})` : "";
    return `[${sourceLabel}/${kindLabel}${date}]\n${h.content}`;
  });

  return lines.join("\n---\n");
}

/** アーカイブが設定されているか(ツール有効化の判定用) */
export function isArchiveConfigured(): boolean {
  return config.twitterArchivePath !== null || config.blueskyArchivePath !== null;
}

/**
 * 起動時にアーカイブをロードしてインデックスする。
 * 既にインデックス済み(テーブルにデータあり)ならスキップする。
 */
export async function loadArchives(): Promise<void> {
  try {
    initArchiveDb();

    const existing = getArchiveCount();
    if (existing > 0) {
      console.log(`[archive] 既存インデックス利用: ${existing}件`);
      return;
    }

    let total = 0;

    // Twitter
    if (config.twitterArchivePath) {
      console.log(`[archive] Twitterアーカイブ読み込み中: ${config.twitterArchivePath}`);
      const records = parseTwitterArchive(config.twitterArchivePath);
      indexArchiveRecords(records);
      total += records.length;
      console.log(`[archive] Twitter: ${records.length}件インデックス`);
    }

    // Bluesky
    if (config.blueskyArchivePath) {
      console.log(`[archive] Blueskyアーカイブ読み込み中: ${config.blueskyArchivePath}`);
      const records = await parseBlueskyArchive(config.blueskyArchivePath);
      indexArchiveRecords(records);
      total += records.length;
      console.log(`[archive] Bluesky: ${records.length}件インデックス`);
    }

    console.log(`[archive] インデックス完了: 合計${total}件`);
  } catch (error) {
    console.error("[archive] アーカイブ読み込み中にエラーが発生しました:", error);
  }
}
