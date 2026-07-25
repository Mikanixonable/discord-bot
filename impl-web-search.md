# 実装計画: function calling による一般Web検索

着手用の実装レディな計画。設計背景・比較は [rag-search-design.md](rag-search-design.md) を参照。
ここでは **一般Web検索を function calling(モデルがツール呼び出しで検索)** で実装する前提でまとめる。

## スコープ
- モデルが必要と判断したとき `web_search(query)` ツールを呼び、一般Web検索の結果を踏まえて応答する。
- 検索プロバイダは **プラガブル**: SearXNG(セルフホスト・キー不要)を主、Tavily(要APIキー)を代替。
- **env 未設定なら検索は無効**(ツール自体を渡さない or 「未設定」を返す)。その場合は従来どおり通常応答。
- Wikipedia / Bluesky は将来 `source` 追加やツール追加で拡張可能（今回は一般Webのみ）。

## 未確定(着手前に1つだけ決める)
- **検索プロバイダ**: SearXNG インスタンスを用意する(推奨・`SEARXNG_URL`)か、Tavily キーを使う(`TAVILY_API_KEY`)か。どちらか一方が有効なら動く。
- **スパイク検証(必須・後述)**: この abliterated モデル + LM Studio が整形された `tool_calls` を安定して返すか。ここがNGなら function calling は諦め、ヒューリスティック案(rag-search-design.md 案1)へ切替。

---

## 共通型とプロバイダ抽象

```ts
// src/tools/search/types.ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}
```

- `src/tools/search/searxng.ts`: `GET {SEARXNG_URL}/search?q=&format=json&language=ja` → `results[]` を `SearchResult[]` にマップ。(Sonnetに委任可)
- `src/tools/search/tavily.ts`: `POST https://api.tavily.com/search`(`api_key`, `query`, `max_results`)→ マップ。(Sonnetに委任可)
- `src/tools/search/provider.ts`: env を見て有効なプロバイダを1つ選ぶ。両方未設定なら `null`。

## ツール定義とディスパッチ

```ts
// src/tools/search/index.ts
export const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "最新の出来事・知らない事柄・固有名詞などを一般Web検索で調べる。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索語。会話の代名詞や省略を解決した具体的な語にする" },
      },
      required: ["query"],
    },
  },
} as const;

// name/argsを受けてプロバイダ検索を実行し、コンパクトなテキストを返す(判断を含むので自前)
export async function executeTool(name: string, args: unknown): Promise<string>;
```

- `executeTool` は `web_search` のみ対応。`args.query` を検証し、プロバイダで検索、上位N件(既定4)を
  `「タイトル — snippet (url)」` の数行テキストにまとめて返す。
- 結果ゼロ/プロバイダ無効時は「検索結果なし」等の短い文字列を返す(モデルがそれを見て通常回答に倒す)。

## ツール呼び出しループ(llm.ts)

`chatCompletionWithTools(messages, tools)` を追加(詳細は rag-search-design.md 付録)。要点:
1. `POST /chat/completions { model, messages, tools, tool_choice:"auto", stream:false, max_tokens }`
2. `msg.tool_calls` があれば assistant を積み、各 call を `executeTool` 実行 → `role:"tool"` 結果を積んで再ループ。
3. `tool_calls` 無し → `msg.content` が最終回答。
4. `MAX_TOOL_ROUNDS`(例3)到達で打ち切り、**tools無しで最終回答を強制取得**。

**防御(必須)**:
- **空content + tool_calls を正常系に**（現行 `chatCompletionRequest` の「content空=例外」をツール考慮に修正）。
- `JSON.parse(arguments)` は try/catch、壊れたら空クエリ扱い。
- ループ上限 + tools無し最終呼び出しで暴走防止。
- 検索が絡む回は `max_tokens` を上げる（往復+思考でトークン消費）。
- (任意) content に `<tool_call>{...}</tool_call>` が生漏れした場合の正規表現フォールバック。

## chat.ts の配線
- `generateReply` で、プロバイダが有効なときだけ `tools=[webSearchTool]` を付けて `chatCompletionWithTools` を呼ぶ。無効なら従来の `chatCompletion`。
- システムプロンプトに指示を追記: 「知らないこと・最近のことは web_search を使ってから答える。検索結果が無関係なら使わない。出典を踏まえて自然に答える。ペルソナは維持」。

## config / env
- `SEARXNG_URL`(任意) / `TAVILY_API_KEY`(任意): どちらか有効なプロバイダを選択。
- `WEB_SEARCH_RESULTS`(既定4): 注入件数。
- `MAX_TOOL_ROUNDS`(既定3)。
- `.env.example` と README に追記。

## ファイル変更まとめ
- 追加: `src/tools/search/{types.ts, provider.ts, searxng.ts, tavily.ts, index.ts}`
- 変更: `src/llm.ts`(ループ追加・空contentガード修正)、`src/chat.ts`(tools配線・指示追加)、`src/config.ts`(env追加)、`.env.example`/`README.md`

---

## 実装ステップと担当
0. **スパイク検証(最初にやる)**: LM Studio へ `tools` 付きリクエストを1本投げ、`tool_calls` が整形されて返るか確認。NGなら案1へ切替。→ 小スクリプト(自前/すぐ)
1. 共通型 `types.ts` + プロバイダ選択 `provider.ts` + `searxng.ts`/`tavily.ts` → **Sonnetに委任**(HTTPクライアント)
2. ツール定義 + `executeTool`(結果整形・検証)→ 自前(判断含む)
3. `chatCompletionWithTools` ループ + 空contentガード修正 → 自前(複雑・防御が肝)
4. `chat.ts` 配線 + システム指示 → 自前 or Sonnet
5. `config.ts`/`.env.example`/`README` → **Sonnetに委任**
6. コミット: スパイク後に機能単位で(例: 「add: function callingによる一般Web検索」)

## リスクと撤退ライン
- スパイクで `tool_calls` が不安定 → function calling を捨て、案1(ヒューリスティックゲート + LLM rewriting)へ。`types.ts`/プロバイダ/結果整形は流用可能。
- 検索が絡む回は往復で遅くなる → `max_tokens`・件数N・`MAX_TOOL_ROUNDS` で調整。
