import type { Client } from "discord.js";

interface EmojiInfo {
  id: string;
  animated: boolean;
}

// 絵文字名 -> { id, animated } のマップ。全参加サーバーの絵文字を集約する。
let emojiMap: Map<string, EmojiInfo> = new Map();

// プロンプトに載せる絵文字名の最大数(肥大化防止)
const MAX_PROMPT_EMOJIS = 60;

/**
 * Clientが把握している全ギルドのカスタム絵文字からマップを再構築する。
 */
export function buildEmojiMap(client: Client): void {
  const map = new Map<string, EmojiInfo>();

  for (const guild of client.guilds.cache.values()) {
    for (const emoji of guild.emojis.cache.values()) {
      if (!emoji.name) continue;
      map.set(emoji.name, { id: emoji.id, animated: emoji.animated ?? false });
    }
  }

  emojiMap = map;
}

/**
 * システムプロンプトに載せる、使用可能な絵文字の一覧(":name:" 形式、空白区切り)を返す。
 * 絵文字が無ければ空文字列。多すぎる場合は先頭 MAX_PROMPT_EMOJIS 個に切り詰める。
 */
export function getEmojiListForPrompt(): string {
  const names = [...emojiMap.keys()].slice(0, MAX_PROMPT_EMOJIS);
  if (names.length === 0) return "";
  return names.map((name) => `:${name}:`).join(" ");
}

// 既に "<:name:id>" や "<a:name:id>" になっている箇所は再変換しないよう、
// 直前が "<" または "<a" でない ":name:" のみにマッチさせる(Node 20はlookbehind対応)。
const SHORTCODE_PATTERN = /(?<!<a?):([A-Za-z0-9_]+):/g;

// モデルが絵文字をバッククォート(インラインコード/コードブロック)で囲むと、
// 展開後もDiscordが絵文字として描画せず文字列のまま表示してしまう。
// 完成した絵文字トークンを直接囲むバッククォートを除去して描画されるようにする。
const WRAPPED_EMOJI_PATTERN = /`+(<a?:[A-Za-z0-9_]+:\d+>)`+/g;

/**
 * テキスト中の ":name:" をDiscordの絵文字表記("<:name:id>" / "<a:name:id>")に置換する。
 * マップに存在しない名前はそのまま残す。展開後、絵文字を囲むバッククォートは除去する。
 */
export function replaceEmojiShortcodes(text: string): string {
  const expanded = text.replace(SHORTCODE_PATTERN, (match, name: string) => {
    const info = emojiMap.get(name);
    if (!info) return match;
    return info.animated ? `<a:${name}:${info.id}>` : `<:${name}:${info.id}>`;
  });

  return expanded.replace(WRAPPED_EMOJI_PATTERN, "$1");
}
