# 実装計画: サーバー内の過去投稿検索 (search_messages)

Web検索(`web_search`)と同様に、モデルが **`search_messages` ツール**を呼んで同一サーバーの過去発言を検索できるようにする。実装は未着手。

## 中核の課題
Discord の **Bot API には全文検索が無い**(search エンドポイントはユーザートークン専用)。よって**自前のインデックス**を持つ必要がある。plan.md #5 の結論どおり SQLite FTS5 で索引する。

## 全体設計
1. 受信メッセージを **SQLite に逐次記録**(FTS5 で全文索引)。
2. 起動時などに**バックフィル**(チャンネル履歴を遡って取り込み)。
3. モデルが **`search_messages(query)` ツール**を呼ぶと FTS5 を検索し、ヒットした発言(著者・日時・抜粋・ジャンプリンク)を返す。
4. 既存の function calling 基盤(`executeTool` ディスパッチ、tools 配列)にツールを1つ足すだけで統合できる。

---

## 依存ライブラリ: better-sqlite3(推奨)
- ローカルは Node 20、Docker は node:22-slim(Debian/glibc)。**better-sqlite3** は両方で prebuilt バイナリが使え、コンパイル不要。FTS5 と trigram トークナイザを同梱。
- 代替: `node:sqlite`(Node22の実験的組み込み)はローカルNode20で使えず不可。`sql.js`(wasm)はネイティブ不要だが遅く永続化に手間。→ **better-sqlite3 が最適**。

## 日本語対応: FTS5 の trigram トークナイザ
- 既定の unicode61 は空白区切り前提で**日本語(分かち書きなし)に弱い**。
- **trigram トークナイザ**(3文字以上の部分一致・大小無視)を使えば、形態素解析なしで日本語の部分文字列検索ができる。クエリは3文字以上が前提。`bm25()` でランキング可能。
- 形態素解析(MeCab等)は過剰。trigram で十分。

## スキーマ(外部コンテンツFTS + トリガで同期)
```sql
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,  -- Discord snowflake(int64に収まる)
  channel_id TEXT, guild_id TEXT,
  author_id  TEXT, author_name TEXT,
  content    TEXT NOT NULL,
  created_at INTEGER              -- epoch ms
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, tokenize='trigram',
  content='messages', content_rowid='id'
);
-- INSERT/UPDATE/DELETE を messages_fts に反映するトリガを張る
```
- 重複は `INSERT OR IGNORE`(id が PRIMARY KEY)で防ぐ。
- ジャンプリンクは `https://discord.com/channels/{guild}/{channel}/{id}` で生成(保存不要)。
- 簡易版として「UNINDEXEDメタ列を持つ単一FTS5表 + 挿入成否での重複判定」でも可。まず動かすならこちらでも良い。

## 取り込み (ingestion)
- **ライブ記録**: `messageCreate` で(bot応答対象か否かに関わらず)本文が空でない全メッセージを `INSERT OR IGNORE`。bot自身の発言も索引に含める(「namakoが前に言ったこと」も検索可能に)。
- **編集/削除の追従**: `messageUpdate` で content 更新、`messageDelete` で行削除(索引の鮮度維持)。任意だが推奨。
- **バックフィル**: 起動時に対象チャンネルの履歴を `channel.messages.fetch({limit:100, before})` でページングして取り込む。
  - 重い処理なのでバックグラウンド実行 + レート制限に配慮(スロットリング)。
  - チャンネルごとに「最後に索引した message id」を保存し、次回は差分のみ取得(増分バックフィル)。
  - 取り込み上限(チャンネル数・件数)を config 化。
- 対象範囲は intent とアクセス権のあるギルドのテキストチャンネル。DM は対象外。

## ツール定義と統合
```jsonc
{
  "type": "function",
  "function": {
    "name": "search_messages",
    "description": "このDiscordサーバーの過去の発言を検索する。誰かが以前言ったこと・話題の経緯を調べる。",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "検索語(3文字以上)" }
      },
      "required": ["query"]
    }
  }
}
```
- `executeTool` に `search_messages` 分岐を追加 → FTS5 を `bm25()` 順で上位N件取得 → `著者 (日付): 抜粋 (ジャンプリンク)` に整形して返す。
- `chat.ts` で tools 配列に `search_messages` を追加(索引が有効なら常に付与)。web_search と併存。
- システムプロンプトに「サーバー内の過去の話題は search_messages で調べる」を追記。

## ボーナス: リンク/返信の解決(決定的・ツール不要)
- トリガーメッセージが `message.reference`(返信)や Discord メッセージリンクを含む場合、`channel.messages.fetch(id)` で参照先を取得し、文脈に注入。
- これはツールと別で、検索なしに「これ」「さっきの」を解決できる。#5 の一部として同時 or 別途実装。

## 永続化 (Docker)
- SQLite ファイルは `/app/data/messages.db` 等に置き、**ボリュームマウント**でリビルド後も残す。
  ```yaml
  # compose.yml の bot サービスに
  volumes:
    - ./data:/app/data
  ```
- Dockerfile は `USER node` なので、`/app/data` が node ユーザーで書けること(ホストマウントのパーミッション)を確認。
- DBパスは `MESSAGE_DB_PATH`(既定 `./data/messages.db`)で config 化。

## 設定 / env(案)
- `MESSAGE_SEARCH_ENABLED`(既定 true/自動): DBが用意できれば有効。
- `MESSAGE_DB_PATH`(既定 `./data/messages.db`)。
- `MESSAGE_SEARCH_RESULTS`(既定 5)。
- `BACKFILL_CHANNELS`(任意: 対象チャンネルID)/ `BACKFILL_MAX`(1チャンネルあたり上限)。

## プライバシー / 留意
- 索引はローカルの自宅サーバー内に保存。外部送信はしない(web検索と違い外に出ない)。
- 他人の発言を保存・検索する性質があるため、運用はプライベートサーバー前提。必要なら索引対象チャンネルを allowlist 化。
- 削除追従を入れておくと「消した発言が検索に残る」問題を避けられる。

## 未確定・決めること
- スキーマ(外部コンテンツ+トリガ vs 単一FTS5表の簡易版)
- バックフィルの範囲と上限、増分方式
- 編集/削除追従を入れるか(推奨: 入れる)
- リンク/返信解決を同時にやるか

## 実装ステップと担当
1. `better-sqlite3` 追加、`src/tools/messages/db.ts`(スキーマ初期化・upsert・search)→ 機械的部分は **Sonnetに委任可**
2. ライブ記録フック(index.ts の messageCreate に追加)+ 編集/削除 → 自前(既存フローとの整合)
3. バックフィル(ページング・スロットリング・増分)→ 自前(レート制限の判断)
4. ツール定義 + `executeTool` 分岐 + chat.ts 配線 + システム指示 → 自前(既存tool基盤への統合)
5. compose.yml にボリューム、config/.env.example/README 追記 → **Sonnetに委任可**
6. コミット: 機能単位(例「add: サーバー内過去発言検索(search_messages)」)

## 既存基盤の再利用
- function calling の往復ループ(`chatCompletionStream`)は**汎用**なので変更不要。ツールを1つ増やすだけ。
- 結果整形の考え方(タイトル/抜粋/リンクのコンパクトテキスト)は web_search と共通。
