import type { Client } from "discord.js";

// 全参加サーバーのカスタム絵文字名の集合。
let emojiNames: Set<string> = new Set();

// プロンプトに載せる絵文字名の最大数(肥大化防止)
const MAX_PROMPT_EMOJIS = 60;

/**
 * Clientが把握している全ギルドのカスタム絵文字名から集合を再構築する。
 */
export function refreshEmojiNames(client: Client): void {
  const names = new Set<string>();

  for (const guild of client.guilds.cache.values()) {
    for (const emoji of guild.emojis.cache.values()) {
      if (emoji.name) names.add(emoji.name);
    }
  }

  emojiNames = names;
}

/**
 * システムプロンプトに載せる、使用可能な絵文字の一覧(":name:" 形式、空白区切り)を返す。
 * 絵文字が無ければ空文字列。多すぎる場合は先頭 MAX_PROMPT_EMOJIS 個に切り詰める。
 */
export function getEmojiListForPrompt(): string {
  const names = [...emojiNames].slice(0, MAX_PROMPT_EMOJIS);
  if (names.length === 0) return "";
  return names.map((name) => `:${name}:`).join(" ");
}
