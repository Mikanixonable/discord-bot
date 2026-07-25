import type { Message } from "discord.js";
import { completeOnce, type ChatMessage } from "./llm.js";
import { getMessageText } from "./message-text.js";

const REACTION_EMOJI = "🐙";

// 好意的かどうか判定する短いプロンプト
const JUDGE_SYSTEM = `あなたはDiscordボット「namako(なまこ)」です。与えられたメッセージが、あなた(namako)に対して好意的・友好的・感謝・褒め・ねぎらい・応援などのポジティブな感情を含んでいるかを判定してください。
単に話しかけているだけや、質問、ニュートラルな会話は「好意的」とは判定しない。
好意的なら YES、そうでなければ NO とだけ出力。`;

/**
 * メッセージがボットに好意的なら🐙リアクションを付ける。
 * バックグラウンドで呼ぶ想定(応答をブロックしない)。
 */
export async function maybeReactOctopus(message: Message): Promise<void> {
  if (message.author.bot) return;

  const text = getMessageText(message);
  if (text.trim().length === 0) return;

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: text },
    ];
    // 短い応答で十分(YES/NOのみ)
    const result = await completeOnce(messages, 16);

    if (result.trim().toUpperCase().startsWith("YES")) {
      await message.react(REACTION_EMOJI);
      console.log(`[reaction] 🐙 リアクション付与: ${message.id}`);
    }
  } catch (err) {
    console.error("[reaction] 判定/リアクション失敗:", err);
  }
}
