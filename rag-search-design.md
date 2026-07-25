# #3 Web検索 — 検索トリガ/RAG方式の判断材料

「いつ・どう検索するか」を決めるための調査メモ。実装方式の選択は保留（このノートを見て後で判断する）。
確定済み前提: ソースは Wikipedia + Bluesky（キー不要）から着手。SearXNG/Tavily は env 設定時のみ有効のプラガブル。

---

## RAGパイプラインの3つの決定ポイント

一般的なRAG/検索付きチャットボットは、次の3段階それぞれに実装選択がある。

### A. 検索するか否か（retrieval trigger / gating）
全メッセージで検索するのは逆効果（品質低下・レイテンシ増・トークン増）というのが2026年の共通見解。「いつ検索するか」を決めるゲートが要る。

| 方式 | 概要 | 長所 | 短所 | この bot への適合 |
|---|---|---|---|---|
| **ヒューリスティック/ルール** | 「調べて」「最近」「とは」、URL、メンション+疑問 などの語/パターンで判定 | 追加LLM呼び出しゼロ・高速・予測可能 | 暗黙の検索ニーズを見逃す | ◎ 雑談botで大半が非検索。高速化を活かせる |
| **LLM分類器 / function calling** | LLMに「検索が必要か」を判定させる（few-shot or ツール定義） | 柔軟・曖昧なケースに強い・複数回検索も可 | 毎メッセージ+1呼び出しで遅い。**ローカルの abliterated モデルは tool_calls が不安定**（実際に空応答バグを観測） | △ function calling は不採用が妥当 |
| **不確実性ゲート（TARG等）** | ドラフト出力のエントロピー/logit差で「自信がない=検索」と判定 | 学習不要・モデル非依存 | トークンlogit/entropyが必要。**LM StudioのOpenAI互換APIでは安定取得できない** | ✕ 実装困難 |

> 実務の勘所（2026）: 「単純クエリはルール、曖昧なものだけagentic」というハイブリッドが latency/cost のスイートスポット。

### B. 検索語の作り方（query construction / rewriting）
生の雑談文はそのままだと検索語として弱い（会話フィラーが混じる、エンティティが埋もれる）。

| 方式 | 概要 | 長所 | 短所 |
|---|---|---|---|
| **生クエリそのまま** | メッセージ本文を検索APIへ | 実装ゼロ | ヒット率が低い。特にWikipediaのタイトル検索と相性が悪い |
| **ルールベース抽出** | メンション/コマンド語を除去、名詞抽出 | LLM不要・高速 | 日本語の名詞抽出は精度限界 |
| **LLM query rewriting** | 生文→検索に最適な語へ書き換え（フィラー除去・エンティティ特定・語彙拡張） | ヒット率が大きく上がる。実運用では「書き換え後クエリ」を実際に流すのが標準 | LLM呼び出しが要る（検索する回だけに限定すれば影響は小） |
| **multi-query / 分解** | 1メッセージを複数検索に分解 | 複雑な質問に強い | 呼び出し数・複雑度が増える。v1には過剰 |
| **履歴の standalone 化** | 会話履歴+今の発言を「独立した1問」に凝縮してから検索 | 代名詞・省略に強い（「それ」「さっきの」を解決） | LLM呼び出し・プロンプト設計が要る |

### C. 取得結果の扱い（retrieval → generation）
| 論点 | 一般的な実装 |
|---|---|
| 件数 | 上位N件（3〜5）を注入。多すぎるとノイズ・トークン増 |
| **relevance checkpoint** | retrieval と generation の間に関連性チェックを1つ挟むと「自信満々な誤答」が激減。簡易版は「無関係な資料は使うな」とプロンプトで指示 |
| 出典 | 結果にタイトル/URLを付け、モデルに引用させる（Wikipedia記事・Blueskyポスト） |
| one-shot vs iterative | 1回検索→生成（one-shot）で多くは足りる。多段（iterative/agentic）は複雑質問向けだが遅く不安定 |

---

## フレームワークの一般的パターン（参考）

- **LangChain / LangGraph**: chain（LLM呼び出し・ツール・変換の連鎖）と、条件分岐する stateful graph で agentic routing を組む。history+query を standalone question に凝縮する前処理チェーンが定番。
- **LlamaIndex**: query router、recursive retrieval、sub-question 分解を一次機能として持つ。RAG特化。
- **function calling**: LLMがクエリを見て「検索が必要か・何を検索するか」を自分で決める。柔軟だが**ローカル不安定モデルでは信頼性が課題**。

> このbotの結論（既定路線）: フレームワークは使わず **TypeScript側でオーケストレーション**する。function calling には頼らない（tool_calls 空応答バグの実績）。上記パターンを素の関数で実装する。

---

## 方式の候補（Aの選択肢を軸に整理）

| 案 | A 検索判定 | B 検索語 | LLM呼び出し数 | 実装量 | 精度 |
|---|---|---|---|---|---|
| **案1 ハイブリッド（推奨）** | ヒューリスティックゲート | ゲート通過時のみLLMで rewriting | 非検索:1 / 検索:2 | 中 | 高 |
| **案2 ルールのみ（最速）** | ヒューリスティックゲート | ルールベース抽出 | 常に1 | 小 | 中 |
| **案3 LLM毎回判定** | LLM分類器 | LLM rewriting（同一パス可） | 常に2 | 中 | 高だが遅い・不安定 |

補足:
- 案1は「先の高速化を活かしつつ、検索する回だけ精度に投資」できる。relevance checkpoint はプロンプトで代替。
- 案2は最小実装。日本語クエリ抽出の弱さでWikipediaヒット率が落ちる可能性。
- 案3は毎メッセージ+1呼び出しで遅く、ローカルモデルの出力不安定の影響を最も受ける。

---

## 未確定・後で決めること
- A/B の方式（案1〜3、または別案）
- ヒューリスティックゲートの具体条件（トリガ語・URL・メンション+疑問 など）
- 注入件数N、relevance checkpoint の強度
- standalone 化（会話の代名詞解決）を入れるか

---

## 付録: function calling を使う場合の実装案

「案3(LLM毎回判定)」を、ヒューリスティックではなく **OpenAI互換の function calling** で実現する場合の具体設計。検索トリガ・検索語生成・ソース選択を、専用ロジックではなく**モデルのツール呼び出し1機構**に委ねる。

### 前提と最大の懸念
- LM Studio は OpenAI 互換の `tools` / `tool_calls` に対応。Qwen3系はHermes形式(`<tool_call>...</tool_call>`)で吐き、LM Studioが `tool_calls` にパースする。

### ツール定義
案A: 単一ツール(v1推奨・シンプル)
```jsonc
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "知らないこと・最近の出来事・固有名詞などを調べる。Wikipedia記事とBluesky投稿を検索する。",
    "parameters": {
      "type": "object",
      "properties": {
        "query":  { "type": "string", "description": "検索語。会話の代名詞や省略を解決した具体的な語にする" },
        "source": { "type": "string", "enum": ["wikipedia", "bluesky", "auto"], "description": "情報源。既定はauto" }
      },
      "required": ["query"]
    }
  }
}
```
案B: ソース別ツール(`search_wikipedia` / `search_bluesky`)。意図は明確だがモデルが選択を誤るリスク。v1は案Aで十分。

### 呼び出しループ(llm.ts に追加)
```
chatCompletionWithTools(messages, tools):
  for round in 1..MAX_TOOL_ROUNDS:            // 例: 3
    res = POST /chat/completions {
      model, messages, tools, tool_choice: "auto", stream: false, max_tokens
    }
    msg = res.choices[0].message
    if msg.tool_calls?.length > 0:
      messages.push(msg)                       // tool_calls付き assistant を履歴に積む
      for call in msg.tool_calls:
        args = safeParseJSON(call.function.arguments)   // 失敗時は空扱い
        result = await executeTool(call.function.name, args)
        messages.push({ role: "tool", tool_call_id: call.id, content: result })
      continue                                 // 結果を持って再度生成
    return msg.content                         // ツール呼び出しなし = 最終回答
  // ラウンド上限に達したら tools なしで最終回答を強制取得
  return finalAnswerWithoutTools(messages)
```

### ツール実行(tools/search/)
- `executeTool(name, args)` が `web_search` を受け、`source` に応じて `wikipedia.ts` / `bluesky.ts`(未指定なら両方)を呼ぶ。
- 結果は **コンパクトなテキスト**(タイトル + 抜粋 + URL を数件)にして tool メッセージの content へ。件数は3〜5。

### システムプロンプトの指示
- 「知らないこと・最近のこと・固有名詞は web_search を使ってから答える。検索結果が無関係なら使わない(=relevance checkpoint)。出典を踏まえて自然に答える。ペルソナは維持」。

### 既存バグ・不安定性への防御(重要)
1. **空content + tool_calls を正常系として扱う**: 現行 `chatCompletionRequest` は content空を例外にしている。ツール呼び出し時はcontentが空になるのが正常なので、tool_calls優先で判定する分岐が必須。
2. **arguments の JSON.parse を try/catch**: 壊れたJSONが来たら握りつぶし、そのツールはスキップ or 空クエリ扱い。
3. **ループ上限 + tools無し最終呼び出し**: 無限ループと「延々ツールを呼ぶ」暴走を防ぐ。
4. **Hermesタグ漏れのフォールバック**: LM Studioがパースに失敗し content に `<tool_call>{...}</tool_call>` が生で出るケースを正規表現で救済(任意)。
5. **max_tokens**: ツール往復 + 思考でトークンを食うため、検索が絡む回は上限を上げる or 別値にする。

### 既存コードへの影響
- `src/llm.ts`: `chatCompletionWithTools`(ループ)を追加。content空ガードを tool_calls 考慮に修正。
- `src/tools/search/`: `wikipedia.ts` / `bluesky.ts`(HTTPクライアント、Sonnetに委任可) + `index.ts`(ツール定義 + `executeTool` ディスパッチ、判断を含むので自前)。
- `src/chat.ts`: tools とシステム指示を組み立て、`generateReply` から tool 対応版を呼ぶ。
- `src/config.ts`: `MAX_TOOL_ROUNDS` 等。

### ヒューリスティック案(案1)との比較
| 観点 | function calling(案3) | ハイブリッド(案1) |
|---|---|---|
| トリガ判定 | モデルが担う(実装少) | ヒューリスティック(要ルール設計) |
| 検索語生成 | モデルが担う(implicit rewriting) | ゲート通過時にLLM rewriting |
| 多段検索 | 自然に可能 | 追加実装が要る |
| 速度 | 毎回tools付き・往復で遅くなりがち | 非検索は最速 |
| **信頼性** | **LM Studioのtool解析に依存(不安定実績)** | 決定的で安定 |
| デバッグ | tool往復で追いにくい | 追いやすい |

### 採否を決める前のスパイク検証(必須)
実装本体に入る前に、この1点だけ確認する:
- LM Studio にこのモデルで `tools` 付きリクエストを1本投げ、**整形された `tool_calls` が安定して返るか**を確認(`curl` or 小さなスクリプト)。
- 安定して返る → function calling(案3)を本採用。
- 返らない/壊れる → 案1(ハイブリッド)に切り替え。設計の大半(ソースアダプタ・注入)は流用できる。

**結果(2026-07-25)**: `scripts/spike-tool-calling.mjs` で検証 → ✅ 整形された `tool_calls` が安定して返った。**function calling を本採用で確定**。案1への撤退は不要。

## 出典
- [Retrieval as a Decision: Training-Free Adaptive Gating for Efficient RAG (arXiv:2511.09803)](https://arxiv.org/abs/2511.09803)
- [12 Advanced RAG Techniques: Beyond Naive Retrieval (2026)](https://atlan.com/know/advanced-rag-techniques/)
- [Beyond Naive RAG: A Step-by-Step Guide to Building Agentic RAG in 2026](https://medium.com/@vkrishnan9074/beyond-naive-rag-a-step-by-step-guide-to-building-agentic-rag-in-2026-fceddd989c74)
- [Agentic RAG: Letting LLMs Choose What to Retrieve (TechAhead)](https://www.techaheadcorp.com/blog/agentic-rag-when-llms-decide-what-and-how-to-retrieve/)
- [The Architecture Behind Web Search in AI Chatbots (Towards Data Science)](https://towardsdatascience.com/the-architecture-behind-web-search-in-ai-chatbots-2/)
- [Query Rewriting: Transforming User Queries into More Effective Search Inputs](https://www.sandgarden.com/learn/query-rewriting)
- [Query rewriting strategies for LLMs & search engines (Elasticsearch Labs)](https://www.elastic.co/search-labs/blog/query-rewriting-llm-search-improve)
