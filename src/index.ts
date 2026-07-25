import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { config } from "./config.js";
import { generateReplyStream, createParagraphSegmenter, splitForDiscord } from "./chat.js";
import { buildEmojiMap, replaceEmojiShortcodes } from "./emoji.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildExpressions,
  ],
  partials: [Partials.Channel],
});

client.once("clientReady", (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);
  console.log(`自動返信チャンネル: ${[...config.autoReplyChannelIds].join(", ") || "(なし)"}`);

  buildEmojiMap(readyClient);
});

// カスタム絵文字の追加/更新/削除に追従してマップを再構築する
client.on("emojiCreate", () => buildEmojiMap(client));
client.on("emojiUpdate", () => buildEmojiMap(client));
client.on("emojiDelete", () => buildEmojiMap(client));

type ResponseTrigger = "mention" | "auto" | null;

function shouldRespond(message: Message): ResponseTrigger {
  // bot自身や他のbotのメッセージは無視
  if (message.author.bot) return null;

  // botへの直接メンションが最優先(@everyone やロールメンションでは反応しない)
  if (
    client.user &&
    message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true })
  ) {
    return "mention";
  }

  // allowlistに含まれるチャンネル/スレッドでは全メッセージに応答
  if (config.autoReplyChannelIds.has(message.channelId)) return "auto";

  return null;
}

client.on("messageCreate", async (message) => {
  try {
    const trigger = shouldRespond(message);
    if (!trigger) return;

    if (!("sendTyping" in message.channel)) return;

    await message.channel.sendTyping();

    // 段落(空白行区切り)ごとに順次投稿する。最初の投稿のみ、メンション時はリプライ(ping)。
    let isFirst = true;
    const segmenter = createParagraphSegmenter(async (segment) => {
      const withEmojis = replaceEmojiShortcodes(segment);
      const chunks = splitForDiscord(withEmojis);
      for (const chunk of chunks) {
        if (isFirst && trigger === "mention") {
          await message.reply(chunk);
        } else if ("send" in message.channel) {
          await message.channel.send(chunk);
        }
        isFirst = false;
      }
    });

    await generateReplyStream(message, (delta) => segmenter.push(delta));
    await segmenter.flush();
  } catch (err) {
    console.error("メッセージ処理中にエラーが発生しました:", err);
    try {
      if ("send" in message.channel) {
        await message.channel.send("ごめん、ちょっとエラーが起きちゃった…もう一回試してみて。");
      }
    } catch (sendErr) {
      console.error("エラー通知の送信にも失敗しました:", sendErr);
    }
  }
});

client.login(config.discordToken);

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`${signal} を受信しました。シャットダウンします...`);
    try {
      await client.destroy();
      console.log("クライアントを正常に破棄しました。");
    } catch (err) {
      console.error("シャットダウン処理中にエラーが発生しました:", err);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

setupGracefulShutdown();
