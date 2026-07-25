# 実装計画: 重層的記憶(短期要約 + 長期圧縮)

直近10件の生ログ(L1)に加え、会話を要約した**短期記憶(L2)**、それを更に圧縮した**長期記憶(L3)**を参照する。実装は未着手。世の中のエージェントの記憶手法を調査し、この bot に落とし込む。

## 世間のエージェントの記憶手法(調査)

2024〜2026の実装で共通する枠組み:

- **認知科学の4層分類**: Working(コンテキスト窓)/ Episodic(時刻付きの具体的記録)/ Semantic(統合された抽象知識)/ Procedural(手続き)。
- **MemGPT / Letta**: OS の比喩。core memory(常時in-context=RAM)/ archival(外部検索=ディスク)/ recall(会話履歴)。モデル自身が function call で記憶を出し入れ・自己編集。
- **Mem0**: 会話ログ + 階層的なイベント要約 + 進化するユーザープロファイル。セッション毎に要約を短期記憶として生成し、ターンを観測として長期に蓄積。
- **MemoryOS**: 短期・中期・長期のペルソナ層。
- **要約バッファ(LangChain ConversationSummaryBuffer)**: 直近は逐語で保持しつつ、古い分を running summary に畳み込む。
- **Reflection / Consolidation(Generative Agents)**: 具体的な出来事を定期的に高次の洞察へ圧縮。海馬→新皮質の記憶固定の比喩(ノイズを捨て安定知識を抽出)。

> 本件のユーザー要望(L1生ログ + L2要約 + L3圧縮)は、**要約バッファ + 階層的 consolidation** の組み合わせにそのまま対応する。

## この bot の3層への対応

| 層 | 内容 | 生成方法 | 注入 |
|---|---|---|---|
| **L1 working** | 直近10件の逐語ログ(既存・1000字上限) | Discord履歴fetch | 常時 |
| **L2 short-term** | これまでの会話の running 要約 | 窓から外れた発言を旧要約に畳み込み更新 | 常時 |
| **L3 long-term** | L2を更に圧縮した恒常的背景 | L2を定期的に蒸留(一過性を捨て安定知識を残す) | 常時 |

L2/L3は小さく常に関連するので**検索せず常時注入**(#5のメッセージ検索=episodic retrieval とは別軸。両者は補完的で Mem0 も両方持つ)。

---

## 具体設計

### データモデル(SQLite、#5のDBと共用)
```sql
CREATE TABLE channel_memory (
  channel_id     TEXT PRIMARY KEY,
  short_summary  TEXT DEFAULT '',   -- L2
  long_summary   TEXT DEFAULT '',   -- L3
  covered_until  TEXT,              -- L2に取り込んだ最後のmessage id
  short_updates  INTEGER DEFAULT 0, -- L2更新回数(L3トリガ用)
  updated_at     INTEGER
);
```
- チャンネル単位(会話スレッド単位)で保持。任意で人物ごとの semantic facts テーブルを追加可(下記)。

### 更新トリガと手順(consolidation)
**L2(短期)更新**:
- トリガ: 応答送信後、`covered_until` 以降の新規メッセージが閾値(例15件)以上たまったら。
- 手順: `covered_until` 〜(直近10件を除いた地点)までの発言 + 旧 `short_summary` をLLMへ:
  「既存の要約に新しい会話を統合して更新。重要な事実・決定・話題・人物の傾向を残し冗長は削る。◯字以内」
  → `short_summary` と `covered_until` を更新、`short_updates++`。
- L1の直近10件は要約せず逐語のまま(即時文脈を保つ)。

**L3(長期)更新**:
- トリガ: `short_updates` が K 回(例5)に達した / `short_summary` が肥大 / 日次。
- 手順: 旧 `long_summary` + 現 `short_summary` をLLMへ:
  「長期記憶を更新。恒常的な事実・人物像・繰り返す話題・進行中のプロジェクト状態を抽出し圧縮。一過性のノイズは捨てる。◯字以内」
  → `long_summary` 更新。畳み込み後に `short_summary` を圧縮/リセットして肥大を防ぐ(episodic→semantic の固定)。

### プロンプトへの注入(重層)
```
[長期記憶(恒常的な背景)]: {long_summary}
[短期記憶(これまでの流れ)]: {short_summary}
これまでの会話(直近):
{name}: {content}
...
```
- 空の層は省略。トークン予算: L3 ~300–500字 / L2 ~500–1000字 / L1 既存1000字上限。すべて config 化。

### レイテンシ/コスト(ローカルLLM前提・重要)
- 要約はLLM呼び出しが増えるが、**応答経路では実行しない**。応答送信後に**バックグラウンドで**consolidationチェックを走らせ、返信の体感速度に影響させない。
- 直列化キュー(`chatCompletion`系)に載せるので返信と競合はするが、閾値を高め(15件/5回)にすれば頻度は低い。
- 要約は `max_tokens` を控えめにした専用呼び出し(同一モデル)。

### 人物 semantic memory(任意の発展)
- Generative Agents の reflection 相当。人物ごとに恒常的な傾向・嗜好を抽出(例「みかぶるは退嬰の概念を多用」「最近の関心はローカルLLMと民主主義」)。
- `person_memory(user_id, guild_id, facts TEXT, updated_at)`。L3生成時に併せて更新し、会話相手のfactsを注入。
- ペルソナ(人物に強い意見を持つ)と相性が良いが、まずはL2/L3で足りる。段階導入でよい。

---

## #5(メッセージ検索)との関係
- 本件=**要約/圧縮(semantic方向)**、#5=**過去発言の全文検索(episodic方向)**。補完的。
- SQLite を共用。#5を先に入れると生ログ基盤が整い、L2バックフィルにも流用できる。

## 未確定・決めること
- スコープ: チャンネル単位のみ / 人物factsも持つか
- L2/L3のトリガ閾値(15件 / 5回 / 日次)と各層の文字数上限
- 畳み込み後にL2をリセットするか(肥大防止 vs 情報保持のバランス)
- consolidation をキュー内で回すか、別の低優先実行にするか

## 実装ステップと担当
1. `channel_memory` スキーマ + DBアクセス(get/update)→ **Sonnetに委任可**
2. 注入の配線(`buildRequest` で long/short をシステム/文脈に差し込む)→ 自前
3. consolidation ロジック(トリガ判定・要約プロンプト・畳み込み)→ 自前(判断が要る)
4. バックグラウンド実行(応答後にfire-and-forget、キュー整合)→ 自前
5. config/.env.example/README → **Sonnetに委任可**
6. コミット: 機能単位(例「add: 重層的記憶(短期要約+長期圧縮)」)

## 出典
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arXiv:2504.19413)](https://arxiv.org/pdf/2504.19413)
- [Types of AI Agent Memory: Episodic, Semantic, Procedural and More (Atlan)](https://atlan.com/know/types-of-ai-agent-memory/)
- [Best AI Agent Memory Frameworks in 2026 (Atlan)](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- [AI Agent Memory Architectures: From Context Windows to Persistent Knowledge (Zylos)](https://zylos.ai/research/2026-04-05-ai-agent-memory-architectures-persistent-knowledge/)
- [Memory Consolidation in Long-Running AI Agents (Zylos)](https://zylos.ai/research/2026-04-20-memory-consolidation-ai-agents/)
- [Hierarchical Memory Orchestration for Personalized Persistent Agents (arXiv:2604.01670)](https://arxiv.org/pdf/2604.01670)
- MemGPT / Letta — OS的な階層記憶(core / archival / recall)と自己編集
