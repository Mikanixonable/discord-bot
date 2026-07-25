import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveRecord } from "./db.js";

/**
 * Twitter公式アーカイブの .js ファイルを読み込んで JSON 配列にパースする。
 * ファイル先頭の `window.YTD.xxx.partN = ` を除去して JSON.parse する。
 */
function loadTwitterJs(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  // "window.YTD.tweets.part0 = [" のような先頭行を取り除く
  const jsonStart = raw.indexOf("[");
  if (jsonStart < 0) return [];
  return JSON.parse(raw.slice(jsonStart)) as unknown[];
}

interface TweetEntry {
  tweet: {
    id_str?: string;
    full_text?: string;
    created_at?: string;
  };
}

interface LikeEntry {
  like: {
    tweetId?: string;
    fullText?: string;
    expandedUrl?: string;
  };
}

function isTweetEntry(x: unknown): x is TweetEntry {
  return typeof x === "object" && x !== null && "tweet" in x;
}

function isLikeEntry(x: unknown): x is LikeEntry {
  return typeof x === "object" && x !== null && "like" in x;
}

/**
 * Twitterアーカイブのdataディレクトリからツイートといいねをパースして返す。
 */
export function parseTwitterArchive(dataDir: string): ArchiveRecord[] {
  const records: ArchiveRecord[] = [];

  // ツイート系ファイル(tweets.js, tweets-part1.js, community-tweet.js)
  const tweetFiles = ["tweets.js", "tweets-part1.js", "community-tweet.js"];
  for (const file of tweetFiles) {
    const entries = loadTwitterJs(join(dataDir, file));
    for (const entry of entries) {
      if (!isTweetEntry(entry)) continue;
      const t = entry.tweet;
      if (!t.full_text || t.full_text.trim() === "") continue;
      records.push({
        id: t.id_str ?? "",
        source: "twitter",
        kind: "tweet",
        content: t.full_text,
        createdAt: t.created_at ?? "",
      });
    }
  }

  // いいね(like.js)
  const likeEntries = loadTwitterJs(join(dataDir, "like.js"));
  for (const entry of likeEntries) {
    if (!isLikeEntry(entry)) continue;
    const l = entry.like;
    if (!l.fullText || l.fullText.trim() === "") continue;
    records.push({
      id: l.tweetId ?? "",
      source: "twitter",
      kind: "like",
      content: l.fullText,
      createdAt: "",
    });
  }

  return records;
}
