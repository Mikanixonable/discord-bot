# 実装計画: ストリーミング漸次投稿(空白行で区切って投稿)

## 目的
- 生成完了を待たず、**空白行(段落境界)ごとに Discord へ順次投稿**する。
- 体感レイテンシを下げ、会話を止まらせない。
- トークン上限で途中終了しても、それまでの段落は失われない。

## 前提(確認済み)
- LM Studio は思考を `reasoning_content`、回答を `content` に**分離**して返す。ストリームでも `delta.content` だけ拾えば思考は混ざらない。
- 直列化キュー(KVキャッシュ枯渇対策)は維持。ストリーミング1本=1スロットで serialize。

## 今回のスコープ: 案A(漸次投稿のみ)
- 段落ストリーミングを実装。トークン上限対策は `LLM_MAX_TOKENS` を上げる運用でカバー。
- 案B(`finish_reason=="length"` で自動継続)は**次段**。本計画の末尾に記載。

---

## 設計

### レイヤ構成
- `src/llm.ts` … 低レベルのストリーミング + ツール往復ループ。`content` の delta を `onContent(delta)` で通知。
- `src/chat.ts` … メッセージ/tools/システムプロンプト組み立て(既存 generateReply と共通化)+ ストリーミング呼び出し。段落セグメンタ。
- `src/index.ts` … セグメント(段落)を受け取るたびに Discord へ投稿。

### llm.ts
`chatCompletionStream(messages, tools, executeTool, onContent)` を追加。
- `stream: true` でSSEを受信。`res.body.getReader()` + `TextDecoder` で行単位パース(`data: {...}` / `data: [DONE]`、行またぎのバッファ保持)。
- 各 delta:
  - `delta.content` → バッファに足しつつ `onContent(delta)` を即時呼ぶ(`delta.reasoning_content`=思考は無視)。
  - `delta.tool_calls` → index ごとに `id`/`name`/`arguments` を連結して組み立て。
  - `finish_reason` を保持。
- ラウンド終了時:
  - tool_calls あり → assistant(tool_calls付き) と各 `role:"tool"` 結果を積んで次ラウンドへ(ツール中は content 空なので投稿なし)。
  - tool_calls なし → content は既に stream 済みなので終了。
- `MAX_TOOL_ROUNDS` 到達時は tools 無しで最終回答を1回取得し `onContent` で流す(フォールバック)。
- キューは `chatCompletionStream` 全体を1つ enqueue(内部リクエストは再enqueueしない)。

### chat.ts
- メッセージ/tools 組み立てを既存 `generateReply` と共通化(ヘルパ抽出)。
- `generateReplyStream(message, onContent)` を追加。検索プロバイダ有効時は tools 付き。
- 段落セグメンタ `createParagraphSegmenter(onSegment)`:
  - `push(delta)`: バッファに足し、`\n\n`(空白行)が現れるたびに手前を1セグメントとして `onSegment` へ(順序保証のため内部で Promise チェーン)。
  - `flush()`: 残りを1セグメントとして流し、投稿完了まで await。

### index.ts
- `messageCreate` で `sendTyping` 後、セグメンタを作り、
  - `onSegment`: 絵文字置換 → `splitForDiscord` → 最初の投稿のみ #8 の trigger に従い reply/send、以降 send。
  - `generateReplyStream(message, (d) => segmenter.push(d))` を実行 → `await segmenter.flush()`。
- エラー時は従来どおり謝罪メッセージ(途中まで投稿済みのことはある)。

### 既存関数の扱い
- `chatCompletion` / `chatCompletionWithTools`(非ストリーミング)はストリーミング版に置換され不要になるため削除。`postChat`(低レベル・フォールバック)は残す。

---

## リスク/留意
- **ツール前置きの content 漏れ**: ツールラウンドで稀にモデルが可視 content を出すと段落に混じる。Qwenは思考を `reasoning_content` に出し tool ラウンドの content は空なので実害は低い。問題が出たら「tool_calls を伴うラウンドの content は捨てる」ガードを追加。
- **Discord レート制限**: 段落数は通常少ないので概ね安全。多すぎる場合は投稿間隔の下限を設ける。
- **途中終了(max_tokens)**: 案Aでは段落は残るが最後の段落は切れる。`LLM_MAX_TOKENS` を上げて緩和。恒久対策は案B。

## 案B(次段): 自動継続
- ラウンドの `finish_reason == "length"` を検知したら、`assistant` の途中出力を履歴に積み「続き」を生成する追加リクエストを行い、段落ストリーミングを継続する。
- 上限・ループ回数のガードを設ける。
