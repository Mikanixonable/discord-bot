import { readFileSync, existsSync } from "node:fs";
import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import type { ArchiveRecord } from "./db.js";

/**
 * Bluesky の repo.car をパースし、app.bsky.feed.post のテキストを抽出する。
 *
 * CARファイルはMST(Merkle Search Tree)のブロックも含むため、
 * 各ブロックをデコードして $type が "app.bsky.feed.post" のものだけ拾う。
 */
export async function parseBlueskyArchive(carPath: string): Promise<ArchiveRecord[]> {
  if (!existsSync(carPath)) return [];

  const bytes = readFileSync(carPath);
  const reader = await CarReader.fromBytes(new Uint8Array(bytes));

  const records: ArchiveRecord[] = [];

  for await (const { cid, bytes: blockBytes } of reader.blocks()) {
    let decoded: unknown;
    try {
      decoded = dagCbor.decode(blockBytes);
    } catch {
      // MSTノードなど、DAG-CBORでないブロックはスキップ
      continue;
    }

    if (typeof decoded !== "object" || decoded === null) continue;
    const obj = decoded as Record<string, unknown>;

    // app.bsky.feed.post のレコードのみ対象
    if (obj.$type !== "app.bsky.feed.post") continue;

    const text = typeof obj.text === "string" ? obj.text : "";
    if (text.trim() === "") continue;

    // createdAt は AT Protocol の標準フィールド
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : "";

    records.push({
      id: cid.toString(),
      source: "bluesky",
      kind: "post",
      content: text,
      createdAt,
    });
  }

  return records;
}
