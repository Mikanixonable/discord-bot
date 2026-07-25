import { Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import { config } from "./config.js";
import { generateReplyStream, createParagraphSegmenter, splitForDiscord } from "./chat.js";
import { buildEmojiMap, replaceEmojiShortcodes } from "./emoji.js";
import {
  initMessageDb,
  getIndexedCount,
  updateMessageContent,
  deleteMessage,
} from "./tools/messages/db.js";
import { indexDiscordMessage } from "./tools/messages/index.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildExpressions,
  ],
  // 未キャッシュのメッセージの編集/削除イベントも受け取れるように Message を含める
  partials: [Partials.Channel, Partials.Message],
});

client.once("clientReady", (readyClient) => {
  console.log(`ログイン完了: ${readyClient.user.tag}`);
  console.log(`自動返信チャンネル: ${[...config.autoReplyChannelIds].join(", ") || "(なし)"}`);

  buildEmojiMap(readyClient);

  initMessageDb();
  console.log(`メッセージ索引: ${getIndexedCount()}件`);
  // 履歴のバックフィルはバックグラウンドで(応答をブロックしない)
  void backfillMessages(readyClient);
});

// カスタム絵文字の追加/更新/削除に追従してマップを再構築する
client.on("emojiCreate", () => buildEmojiMap(client));
client.on("emojiUpdate", () => buildEmojiMap(client));
client.on("emojiDelete", () => buildEmojiMap(client));

// メッセージの編集/削除を検索インデックスに反映する
client.on("messageUpdate", (_oldMessage, newMessage) => {
  try {
    if (newMessage.partial || typeof newMessage.content !== "string") return;
    updateMessageContent(newMessage.id, newMessage.content);
  } catch (err) {
    console.error("メッセージ更新の索引反映に失敗:", err);
  }
});

client.on("messageDelete", (message) => {
  try {
    deleteMessage(message.id);
  } catch (err) {
    console.error("メッセージ削除の索引反映に失敗:", err);
  }
});

/**
 * 起動時に対象チャンネルの履歴を遡って検索インデックスに取り込む。
 * 対象は BACKFILL_CHANNELS、無ければ AUTO_REPLY_CHANNEL_IDS。
 */
async function backfillMessages(readyClient: Client): Promise<void> {
  const targetIds =
    config.backfillChannels.size > 0 ? config.backfillChannels : config.autoReplyChannelIds;
  if (targetIds.size === 0) return;

  for (const channelId of targetIds) {
    try {
      const channel = await readyClient.channels.fetch(channelId);
      if (
        !channel ||
        !("messages" in channel) ||
        typeof channel.messages?.fetch !== "function"
      ) {
        continue;
      }

      let before: string | undefined;
      let fetched = 0;
      while (fetched < config.backfillMax) {
        const batch = await channel.messages.fetch({
          limit: Math.min(100, config.backfillMax - fetched),
          before,
        });
        if (batch.size === 0) break;
        for (const m of batch.values()) {
          indexDiscordMessage(m);
        }
        fetched += batch.size;
        before = batch.last()?.id;
        if (batch.size < 100) break;
      }
    } catch (err) {
      console.error(`バックフィル失敗 (channel=${channelId}):`, err);
    }
  }

  console.log(`バックフィル完了: メッセージ索引 ${getIndexedCount()}件`);
}

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
  // 応答対象か否かに関わらず、全メッセージを検索インデックスに記録する
  try {
    indexDiscordMessage(message);
  } catch (err) {
    console.error("メッセージ索引への記録に失敗:", err);
  }

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
