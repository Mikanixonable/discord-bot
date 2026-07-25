// function calling スパイク検証:
// LM Studio(等のOpenAI互換サーバー)に tools 付きリクエストを投げ、
// 整形された tool_calls が安定して返るかを確認する。
//
// 使い方: .env を設定した上で `node scripts/spike-tool-calling.mjs`
// LLM_BASE_URL / LLM_MODEL / LLM_API_KEY を .env から読む。

import "dotenv/config";

const baseUrl = (process.env.LLM_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
const model = process.env.LLM_MODEL || "llama3.1";
const apiKey = process.env.LLM_API_KEY || "ollama";

const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "最新の出来事・知らない事柄・固有名詞などを一般Web検索で調べる。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索語" },
        },
        required: ["query"],
      },
    },
  },
];

// 検索を誘発しやすいプロンプト
const messages = [
  { role: "system", content: "あなたは調査アシスタント。知らないことや最近のことは web_search ツールで調べてから答える。" },
  { role: "user", content: "2025年の日本の首相は誰? 最新情報を調べて教えて。" },
];

const body = {
  model,
  messages,
  tools,
  tool_choice: "auto",
  stream: false,
  max_tokens: 4096
};

console.log(`POST ${baseUrl}/chat/completions  (model=${model})`);

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}:`, await res.text().catch(() => ""));
  process.exit(1);
}

const text = await res.text();
console.log("\n=== 生レスポンス ===");
console.log(text);

let data;
try {
  data = JSON.parse(text);
} catch (e) {
  console.error("\nJSONパース失敗:", e);
  process.exit(1);
}

const msg = data.choices?.[0]?.message;
const toolCalls = msg?.tool_calls;

console.log("\n=== 判定 ===");
if (Array.isArray(toolCalls) && toolCalls.length > 0) {
  console.log(`tool_calls: ${toolCalls.length}件`);
  let ok = true;
  for (const [i, call] of toolCalls.entries()) {
    const name = call?.function?.name;
    const rawArgs = call?.function?.arguments;
    let argsOk = false;
    try {
      const parsed = JSON.parse(rawArgs ?? "");
      argsOk = typeof parsed?.query === "string" && parsed.query.length > 0;
    } catch {
      argsOk = false;
    }
    console.log(`  [${i}] name=${name} id=${call?.id} arguments=${rawArgs} → argsOk=${argsOk}`);
    if (name !== "web_search" || !argsOk) ok = false;
  }
  console.log(ok
    ? "\n✅ 整形された tool_calls が返った。function calling 採用可。"
    : "\n⚠️ tool_calls は返ったが name/arguments が想定外。要確認。");
} else if (typeof msg?.content === "string" && msg.content.includes("<tool_call>")) {
  console.log("⚠️ content に <tool_call> が生漏れしている(LM Studioがパース未対応)。フォールバック実装が必要。");
} else {
  console.log("❌ tool_calls が返らなかった。content=", JSON.stringify(msg?.content));
  console.log("→ このモデル/設定では function calling が不安定。ヒューリスティック案(案1)への切替を検討。");
}
