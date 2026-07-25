# discord-bot

TypeScript + discord.js による雑談Discordボット (MVP)。ローカルLLM (Ollama等のOpenAI互換エンドポイント) を使って応答を生成します。

## 機能概要

- 特定のチャンネル/スレッド (ID allowlist) では、投稿されたすべてのメッセージに自動返信します。
- それ以外のチャンネルでは、ボットへのメンション時のみ応答します。
- ボット自身や他のボットのメッセージには反応しません。
- 応答はローカルLLM (OpenAI互換の `/chat/completions`) で生成します。openai SDKには依存せず、`fetch` を使った軽量クライアント (`src/llm.ts`) を自作しています。
- キャラクター設定は `config/persona.md` をシステムプロンプトとして読み込みます。
- 応答生成時、そのチャンネルの直近メッセージ (既定20件) をDiscord APIから取得し、`ユーザー名: 内容` の形式でLLMに文脈として渡します。
- 2000文字を超える応答は自動的に分割送信します。
- 応答生成中は `sendTyping` で入力中表示を出します。
- エラー時はコンソールにログを出し、チャンネルには短い謝罪メッセージを送ります。

## セットアップ手順

### 1. Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセスし、新規アプリケーションを作成します。
2. 左メニューの「Bot」からボットを追加し、トークンを発行します (このトークンを `.env` の `DISCORD_TOKEN` に設定)。
3. 「Bot」設定画面で、以下の **Privileged Gateway Intents** を有効にします。
   - `MESSAGE CONTENT INTENT` (メッセージ内容の取得に必須)
4. 「OAuth2 > URL Generator」で `bot` スコープを選び、必要な権限 (最低限 `Send Messages`, `Read Message History`, `View Channels`) を付与して生成されたURLからサーバーに招待します。
5. コード側で使用しているGateway Intentsは以下の3つです (`src/index.ts` 参照)。
   - `Guilds`
   - `GuildMessages`
   - `MessageContent`

### 2. ローカルLLM (Ollama) の起動

1. [Ollama](https://ollama.com/) をインストールします。
2. 使用したいモデルをpullします。例:
   ```
   ollama pull llama3.1
   ```
3. Ollamaサーバーを起動します (通常はインストール後デフォルトで `http://localhost:11434` で待受)。
   ```
   ollama serve
   ```
4. OllamaはOpenAI互換のエンドポイントを `http://localhost:11434/v1` で提供しているため、これを `.env` の `LLM_BASE_URL` にそのまま設定できます。

### 3. 環境変数の設定

`.env.example` をコピーして `.env` を作成し、値を設定してください。

```
copy .env.example .env
```

| 変数名 | 説明 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Botのトークン (必須) |
| `AUTO_REPLY_CHANNEL_IDS` | 全メッセージに自動返信するチャンネル/スレッドIDのカンマ区切りリスト (任意) |
| `LLM_BASE_URL` | OpenAI互換LLMエンドポイントのベースURL (既定: `http://localhost:11434/v1`) |
| `LLM_MODEL` | 使用するモデル名 (既定: `llama3.1`) |
| `LLM_API_KEY` | LLMのAPIキー (Ollamaでは通常不要。任意のダミー値でも可) |
| `MESSAGE_DB_PATH` | メッセージ全文検索用SQLite DBのファイルパス (既定: `./data/messages.db`) |
| `MESSAGE_SEARCH_RESULTS` | メッセージ検索結果の取得件数 (既定: 5) |
| `BACKFILL_CHANNELS` | 起動時に履歴をバックフィルする対象チャンネル/スレッドIDのカンマ区切りリスト (任意、空なら自動返信チャンネルのみ) |
| `BACKFILL_MAX` | 起動時バックフィルで取得するチャンネルごとの最大メッセージ数 (既定: 500) |

### 4. インストールと起動

```
npm install
npm run dev
```

本番向けビルド:

```
npm run build
npm start
```

## キャラクター設定のカスタマイズ

`config/persona.md` を編集することで、ボットの口調や性格をカスタマイズできます。このファイルの内容はそのままLLMへのシステムプロンプトとして使われます。

## Docker運用

Dockerを使ってボットを起動・運用することもできます。

### 起動

```
docker compose up -d --build
```

### ログ確認

```
docker compose logs -f
```

### persona.mdの変更

`config/persona.md` はボリュームマウントされているため、編集後は再ビルド不要で、コンテナの再起動のみで反映されます。

```
docker compose restart bot
```

### 環境変数 (LLM_BASE_URL) について

Dockerコンテナ内からホストマシン上のOllama等 (`http://localhost:11434`) へ接続する場合、`localhost` はコンテナ自身を指してしまうため到達できません。`.env` の `LLM_BASE_URL` を以下のように設定してください。

```
LLM_BASE_URL=http://host.docker.internal:11434/v1
```

### Docker Desktopの自動起動設定

Windows起動時にDocker Desktopを自動起動し、ボットも自動的に立ち上がるようにするには、Docker Desktopの設定 (Settings > General) で「Start Docker Desktop when you sign in to your computer」を有効にしてください。`compose.yml` では `restart: unless-stopped` を設定しているため、Docker Desktop起動後はコンテナも自動的に再起動されます。

## Web検索の有効化 (SearXNG)

ボットは `web_search` ツール (function calling) で一般Web検索を行えます。`SEARXNG_URL` か `TAVILY_API_KEY` のどちらかが設定されている場合のみ有効になり、未設定なら通常応答します。

`compose.yml` にはセルフホストの SearXNG サービスが含まれています。有効化手順:

1. `searxng/settings.yml` の `server.secret_key` をランダムな文字列に差し替える。
   ```
   openssl rand -hex 32
   ```
2. `.env` に以下を設定する (compose内はサービス名で到達)。
   ```
   SEARXNG_URL=http://searxng:8088
   ```
3. 起動する。
   ```
   docker compose up -d --build
   ```
4. 動作確認 (ホストから)。JSONが返れば成功。
   ```
   curl "http://localhost:8088search?q=test&format=json"
   ```

ホストで直接 `npm run dev` する場合は `SEARXNG_URL=http://localhost:8088 を使い、SearXNG だけ `docker compose up -d searxng` で起動しておく。

Tavily を使う場合は `SEARXNG_URL` を空にして `.env` に `TAVILY_API_KEY` を設定する (SearXNG 優先)。

## サーバー内メッセージ検索

ボットは投稿されたメッセージをローカルのSQLite (FTS5, トライグラムトークナイザ) にインデックスし、モデルがツール呼び出しでそれらを全文検索できます。日本語の部分一致検索にも対応しています。

- インデックスDBは `MESSAGE_DB_PATH` (既定: `./data/messages.db`) に保存され、Docker運用時は `./data` のボリュームマウントによりコンテナ再構築後も永続化されます。
- `MESSAGE_SEARCH_RESULTS` で検索結果の取得件数を調整できます (既定: 5件)。
- メッセージ検索は常時有効で、Web検索のようなオン/オフの切り替えはありません。
- `BACKFILL_CHANNELS` と `BACKFILL_MAX` により、起動時にチャンネル履歴をどこまでインデックスに取り込むかを制御できます。`BACKFILL_CHANNELS` が空の場合は `AUTO_REPLY_CHANNEL_IDS` のチャンネルのみが対象になります。

## ディレクトリ構成

```
config/
  persona.md       # キャラクター設定 (システムプロンプト)
src/
  config.ts        # 環境変数の読み込み・検証
  llm.ts           # LLMクライアント (chatCompletion)
  persona.ts       # persona.md読み込み
  chat.ts          # 履歴取得・プロンプト組み立て・応答生成・メッセージ分割
  index.ts         # discord.jsクライアント本体、応答判定ロジック
```
