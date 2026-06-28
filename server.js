const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || "0"); // Telegram user ID
const LOG_CHAT_ID = parseInt(process.env.LOG_CHAT_ID || "0"); // Log channel ID
const PORT = process.env.PORT || 3000;

if (!TOKEN || !MONGO_URI || !ADMIN_ID || !LOG_CHAT_ID) {
  console.error("Missing env: BOT_TOKEN, MONGO_URI, ADMIN_ID, LOG_CHAT_ID required hai.");
  process.exit(1);
}

function isAdmin(userId) { return userId === ADMIN_ID; }

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ─── Schemas ────────────────────────────────────────────────────────────────

const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  file_id: { type: String, required: true },
  file_type: { type: String, required: true },
  file_name: { type: String, default: "file" },
  uploaded_by: { type: Number },
  expires_at: { type: Date, default: null },
  delivered_to: [{ type: Number }], // chat_ids jo already receive kar chuke hain (within 24hr)
  created_at: { type: Date, default: Date.now },
});
// TTL index — expires_at set ho to auto delete
fileSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expires_at: { $type: "date" } } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

// Bulk batch: ek user ke pending files store karta hai
const bulkBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true, index: true },
  user_id: { type: Number, required: true },
  files: [
    {
      file_id:   { type: String, required: true },
      file_type: { type: String, required: true },
      file_name: { type: String, default: "file" },
    }
  ],
  created_at: { type: Date, default: Date.now },
});
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

// Pending DM deletes — server restart pe bhi recover hoga
const pendingDeleteSchema = new mongoose.Schema({
  chat_id:    { type: Number, required: true },
  message_id: { type: Number, required: true },
  delete_at:  { type: Date,   required: true },
});
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

// ─── Health server ───────────────────────────────────────────────────────────

const app = express();
app.get("/health", (req, res) => res.status(200).json({
  status: "ok",
  uptime: process.uptime(),
  mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));
app.listen(PORT, () => console.log(`Health server on port ${PORT}`));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getUniqueCode() {
  let code, exists;
  do {
    code = generateCode();
    exists = await FileRecord.findOne({ code });
  } while (exists);
  return code;
}

async function getUniqueBatchCode() {
  let code, exists;
  do {
    code = "B" + generateCode(); // Batch codes 'B' se start honge
    exists = await BulkBatch.findOne({ batch_code: code });
  } while (exists);
  return code;
}

function extractFileInfo(msg) {
  if (msg.document)   return { file_id: msg.document.file_id,  file_type: "document",   file_name: msg.document.file_name || "document" };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg" };
  if (msg.video)      return { file_id: msg.video.file_id,      file_type: "video",      file_name: msg.video.file_name || "video.mp4" };
  if (msg.audio)      return { file_id: msg.audio.file_id,      file_type: "audio",      file_name: msg.audio.file_name || "audio.mp3" };
  if (msg.voice)      return { file_id: msg.voice.file_id,      file_type: "voice",      file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4" };
  return null;
}

async function sendFile(bot, chatId, record) {
  const caption = `📎 ${record.file_name}`;
  switch (record.file_type) {
    case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption });
    case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, protect_content: true });
    case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption });
    case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption });
    case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: true });
    default:           return await bot.sendDocument(chatId, record.file_id, { caption });
  }
}

// ─── In-memory bulk session store ────────────────────────────────────────────
// { userId: { files: [...], timer: timeoutRef } }
const bulkSessions = new Map();

const BULK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min baad auto-cancel

// ─── Bot startup ─────────────────────────────────────────────────────────────

async function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// DM delete schedule karo — DB mein save + setTimeout
async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  await PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  const delay = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
      await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId });
    } catch (err) {
      console.error("Auto DM delete error:", err.message);
      await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
    }
  }, delay);
}

// Server start pe pending deletes recover karo
async function recoverPendingDeletes(bot) {
  const pending = await PendingDelete.find({});
  console.log(`Recovering ${pending.length} pending DM deletes...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try {
        await bot.deleteMessage(p.chat_id, p.message_id);
      } catch (err) {
        console.error("Recovered delete error:", err.message);
      }
      await PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
      // delivered_to se bhi remove karo
      await FileRecord.updateMany({}, { $pull: { delivered_to: p.chat_id } }).catch(() => {});
    }, delay);
  }
}

async function startBot() {
  // Purani polling clear karo — agar fail ho to ignore karo
  try {
    console.log("Purani polling clear kar raha hoon...");
    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) console.warn("getUpdates response:", res.status);
  } catch (err) {
    console.warn("getUpdates skip (network issue):", err.message);
    // Fatal nahi — aage badhte hain
  }

  // Bot banao — retry logic ke saath
  let bot;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      bot = new TelegramBot(TOKEN, {
        polling: {
          interval: 2000,
          autoStart: false,
          params: { timeout: 30 },
        },
      });
      await bot.getMe(); // Connection test
      break;
    } catch (err) {
      console.error(`Bot init attempt ${attempt} failed: ${err.message}`);
      if (attempt === 5) throw err;
      await wait(5000 * attempt); // 5s, 10s, 15s...
    }
  }

  bot.startPolling();
  const me = await bot.getMe();
  const BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  // Server restart pe pending deletes recover karo
  await recoverPendingDeletes(bot);

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();

    if (param) {
      // Bulk batch link?
      if (param.startsWith("B")) {
        try {
          const batch = await BulkBatch.findOne({ batch_code: param });
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid or expired.`);
          for (const f of batch.files) {
            await sendFile(bot, chatId, f);
          }
          return;
        } catch (err) {
          console.error("Batch deep link error:", err.message);
          return bot.sendMessage(chatId, `Error occurred. Please try again.`);
        }
      }

      // Single file link
      try {
        const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${param}$`, "i") } });
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid or expired.`);

        const isVideo = record.file_type === "video" || record.file_type === "video_note";

        // Agar video hai — check karo 24hr ke andar already deliver ho chuki hai kya
        if (isVideo && record.delivered_to.includes(chatId)) {
          return bot.sendMessage(chatId, `⚠️ This video has already been delivered to you. It will be auto-deleted from your DM within 24 hours of first delivery.`);
        }

        // Video bhejo
        const sentMsg = await sendFile(bot, chatId, record);

        // Agar video hai — 24hr baad user ke DM se delete karo (DB mein save)
        if (isVideo) {
          const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
          // delivered_to mein chatId add karo, 24hr baad remove karne ke liye bhi schedule karo
          await FileRecord.updateOne({ _id: record._id }, { $addToSet: { delivered_to: chatId } });
          setTimeout(async () => {
            await FileRecord.updateOne({ _id: record._id }, { $pull: { delivered_to: chatId } }).catch(() => {});
          }, 24 * 60 * 60 * 1000);
          await bot.sendMessage(chatId, `⚠️ Ye video aapke DM se 24 ghante baad automatically delete ho jaayegi.`);
        }
      } catch (err) {
        console.error("Deep link error:", err.message);
        bot.sendMessage(chatId, `Error occurred. Please try again.`);
      }
      return;
    }

    // No param — sirf admin ko welcome, baaki ko kuch nahi
    if (isAdmin(userId)) {
      bot.sendMessage(chatId,
        `👋 Hello Admin!\n\n` +
        `🎬 Send a file — you will get a link.\n` +
        `📦 For bulk files:\n` +
        `   1️⃣ Type /bulk to start bulk mode\n` +
        `   2️⃣ Send files one by one\n` +
        `   3️⃣ Type /done to get a single link\n\n` +
        `/myfiles — view saved files\n` +
        `/cancel — cancel bulk mode`
      );
    }
    // Non-admin ko kuch nahi
  });

  // ── /bulk — bulk mode shuru karo ────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(userId)) return; // Non-admin ignore

    if (bulkSessions.has(userId)) {
      return bot.sendMessage(chatId,
        `⚠️ Bulk mode pehle se active hai!\n` +
        `Files bhejo ya /done se complete karo.\n` +
        `Cancel karna ho to /cancel bhejo.`
      );
    }

    // Naya session
    const timer = setTimeout(async () => {
      if (bulkSessions.has(userId)) {
        bulkSessions.delete(userId);
        try {
          await bot.sendMessage(chatId,
            `⏰ Bulk session timeout ho gaya (5 min). Dobara /bulk se shuru karo.`
          );
        } catch (_) {}
      }
    }, BULK_TIMEOUT_MS);

    bulkSessions.set(userId, { files: [], chatId, timer });

    bot.sendMessage(chatId,
      `📦 Bulk mode ON!\n\n` +
      `Ab saari files ek ek karke bhejo.\n` +
      `Sab files bhejne ke baad /done likho — ek single link milega!\n\n` +
      `❌ Cancel: /cancel`
    );
  });

  // ── /done — batch finalize karo ─────────────────────────────────────────────
  bot.onText(/\/done/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(userId)) return;

    const session = bulkSessions.get(userId);
    if (!session) {
      return bot.sendMessage(chatId,
        `Koi active bulk session nahi hai. Pehle /bulk se shuru karo.`
      );
    }

    if (session.files.length === 0) {
      return bot.sendMessage(chatId,
        `⚠️ Koi file nahi bheji abhi tak! Pehle files bhejo, phir /done karo.`
      );
    }

    // Timer clear karo
    clearTimeout(session.timer);
    bulkSessions.delete(userId);

    const processing = await bot.sendMessage(chatId, `⏳ Batch save ho rahi hai...`);

    try {
      const batchCode = await getUniqueBatchCode();
      await BulkBatch.create({
        batch_code: batchCode,
        user_id: userId,
        files: session.files,
      });

      const link = `https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId, processing.message_id);

      const fileList = session.files
        .map((f, i) => `${i + 1}. ${f.file_name}`)
        .join("\n");

      await bot.sendMessage(chatId,
        `✅ Batch ready! ${session.files.length} files save ho gayi.\n\n` +
        `📋 Files:\n${fileList}\n\n` +
        `Link share karo — saari files ek saath milegi:`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "📥 Saari Files Lo", url: link }]]
          }
        }
      );
      await bot.sendMessage(chatId, link, { disable_web_page_preview: true });

    } catch (err) {
      console.error("Batch save error:", err.message);
      try {
        await bot.editMessageText(`Batch save nahi hui. Dobara try karo.`, {
          chat_id: chatId, message_id: processing.message_id
        });
      } catch (_) {
        bot.sendMessage(chatId, `Batch save nahi hui. Dobara try karo.`);
      }
    }
  });

  // ── /cancel — bulk session band karo ────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(userId)) return;

    const session = bulkSessions.get(userId);
    if (!session) {
      return bot.sendMessage(chatId, `Koi active bulk session nahi hai.`);
    }

    clearTimeout(session.timer);
    bulkSessions.delete(userId);
    bot.sendMessage(chatId,
      `❌ Bulk session cancel ho gaya. ${session.files.length > 0 ? `(${session.files.length} files discard ho gayi)` : ""}`
    );
  });

  // ── /myfiles ─────────────────────────────────────────────────────────────────
  bot.onText(/\/myfiles/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return;
    try {
      const files = await FileRecord.find({ uploaded_by: msg.from.id }).sort({ created_at: -1 }).limit(20);
      const batches = await BulkBatch.find({ user_id: msg.from.id }).sort({ created_at: -1 }).limit(10);

      if (files.length === 0 && batches.length === 0) {
        return bot.sendMessage(chatId, `Abhi tak koi file ya batch upload nahi ki.`);
      }

      const emoji = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
      let text = "";

      if (files.length > 0) {
        text += `📁 Single Files (${files.length}):\n\n`;
        files.forEach((f) => {
          text += `${emoji[f.file_type] || "📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;
        });
      }

      if (batches.length > 0) {
        text += `📦 Bulk Batches (${batches.length}):\n\n`;
        batches.forEach((b) => {
          text += `🗂️ Batch (${b.files.length} files) — ${b.created_at.toLocaleDateString("en-IN")}\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;
        });
      }

      bot.sendMessage(chatId, text, { disable_web_page_preview: true });
    } catch (err) {
      bot.sendMessage(chatId, `Error aaya. Dobara try karo.`);
    }
  });

  // ── /delete ──────────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return;
    const code = match[1].trim();
    try {
      // Single file check
      const record = await FileRecord.findOneAndDelete({
        code: { $regex: new RegExp(`^${code}$`, "i") },
        uploaded_by: msg.from.id
      });
      if (record) return bot.sendMessage(chatId, `✅ File delete ho gayi!`);

      // Batch check
      const batch = await BulkBatch.findOneAndDelete({
        batch_code: { $regex: new RegExp(`^${code}$`, "i") },
        user_id: msg.from.id
      });
      if (batch) return bot.sendMessage(chatId, `✅ Batch delete ho gayi! (${batch.files.length} files)`);

      bot.sendMessage(chatId, `Code nahi mila ya yeh aapka nahi hai.`);
    } catch (err) {
      bot.sendMessage(chatId, `Delete nahi hua. Dobara try karo.`);
    }
  });

  // ── Telegram message link se file save karo ─────────────────────────────────
  // Supported: https://t.me/username/123  ya  https://t.me/c/1234567890/123
  const TG_LINK_RE = /https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;

  bot.onText(TG_LINK_RE, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!isAdmin(userId)) return;

    const isPrivate  = !!match[2];
    const rawId      = match[2];
    const username   = match[3];
    const messageId  = parseInt(match[4], 10);

    let fromChatId = isPrivate ? parseInt(`-100${rawId}`, 10) : `@${username}`;

    const processing = await bot.sendMessage(chatId, `⏳ Link se file fetch kar raha hoon...`);

    // Public group hai to pehle bot membership check karo
    if (!isPrivate && username) {
      try {
        const botMember = await bot.getChatMember(`@${username}`, (await bot.getMe()).id);
        if (!botMember || botMember.status === "left" || botMember.status === "kicked") {
          return bot.editMessageText(
            `❌ Bot @${username} group/channel ka member nahi hai.\n\n` +
            `✅ Fix karo:\n` +
            `1. Pehle bot ko @${username} mein add karo (member ke roop mein)\n` +
            `2. Phir dobara yeh link bhejo.\n\n` +
            `💡 Public group bhi ho to bot ko add karna zaroori hai — Telegram ka rule hai.`,
            { chat_id: chatId, message_id: processing.message_id }
          );
        }
      } catch (memberErr) {
        // getChatMember fail hua matlab bot wahan hai hi nahi
        return bot.editMessageText(
          `❌ Bot @${username} mein nahi hai ya access nahi.\n\n` +
          `✅ Pehle bot ko us group/channel mein add karo, phir dobara try karo.`,
          { chat_id: chatId, message_id: processing.message_id }
        );
      }
    }

    try {
      // Log channel mein copy karo — file_id lo — delete karo
      // User ke DM mein kuch nahi aayega
      const fileInfo = await new Promise(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 15000);

        const handler = async (m) => {
          // channel_post aur message dono handle karo (group ya channel dono ke liye)
          if (m.chat.id === LOG_CHAT_ID) {
            clearTimeout(timer);
            bot.removeListener("channel_post", handler);
            bot.removeListener("message", handler);
            const info = extractFileInfo(m);
            // Log channel se copied message delete karo
            await bot.deleteMessage(LOG_CHAT_ID, m.message_id).catch(() => {});
            resolve(info);
          }
        };
        // Dono events listen karo — channel ho ya group
        bot.on("channel_post", handler);
        bot.on("message", handler);

        try {
          await bot.copyMessage(LOG_CHAT_ID, fromChatId, messageId);
        } catch (err) {
          clearTimeout(timer);
          bot.removeListener("channel_post", handler);
          bot.removeListener("message", handler);
          reject(err);
        }
      });

      if (!fileInfo) {
        return bot.editMessageText(
          `⚠️ Is message mein koi file nahi mili.\n(sirf document, photo, video, audio save hoti hai)`,
          { chat_id: chatId, message_id: processing.message_id }
        );
      }

      // Bulk session active hai?
      const session = bulkSessions.get(userId);
      if (session) {
        session.files.push(fileInfo);
        const count = session.files.length;
        return bot.editMessageText(
          `✅ File ${count} bulk mein add ho gayi: ${fileInfo.file_name}\n` +
          `📦 Total: ${count} file(s)\n\nAur links/files bhejo ya /done likhke link lo.`,
          { chat_id: chatId, message_id: processing.message_id }
        );
      }

      // Normal single save
      const code = await getUniqueCode();
      await FileRecord.create({
        code, file_id: fileInfo.file_id, file_type: fileInfo.file_type,
        file_name: fileInfo.file_name, uploaded_by: userId, expires_at: null,
      });
      const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
      await bot.deleteMessage(chatId, processing.message_id);
      const caption = `✅ ${fileInfo.file_name}\n\nLink pe click karo — file aa jaayegi:`;
      await bot.sendMessage(chatId, caption,
        { reply_markup: { inline_keyboard: [[{ text: "📥 File Lo", url: link }]] } }
      );
      await bot.sendMessage(chatId, link, { disable_web_page_preview: true });

    } catch (err) {
      console.error("Link fetch error:", err.message);
      const errText =
        err.message.includes("chat not found") || err.message.includes("CHAT_ADMIN_REQUIRED")
          ? `❌ Bot us group/channel ka member nahi hai.\nPehle bot ko wahan add karo.`
        : err.message.includes("MESSAGE_ID_INVALID") || err.message.includes("not found")
          ? `❌ Message nahi mila. Link sahi hai?`
        : err.message.includes("PEER_ID_INVALID")
          ? `❌ Is group/channel tak access nahi.\nBot ko wahan member banao.`
        : `❌ Error: ${err.message}`;
      try {
        await bot.editMessageText(errText, { chat_id: chatId, message_id: processing.message_id });
      } catch (_) { bot.sendMessage(chatId, errText); }
    }
  });

  // ── Message handler (file receive) ──────────────────────────────────────────
  bot.on("message", async (msg) => {
    if (msg.text && TG_LINK_RE.test(msg.text)) return;
    if (msg.text) return;
    if (!isAdmin(msg.from?.id)) return; // Non-admin ki files ignore

    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const fileInfo = extractFileInfo(msg);
    if (!fileInfo) return;

    // ── Bulk session active hai? ─────────────────────────────────────────────
    const session = bulkSessions.get(userId);
    if (session) {
      session.files.push(fileInfo);
      const count = session.files.length;
      await bot.sendMessage(chatId,
        `✅ File ${count} add ho gayi: ${fileInfo.file_name}\n` +
        `📦 Total: ${count} file(s)\n\n` +
        `Aur files bhejo ya /done likhke link lo.`,
        { reply_to_message_id: msg.message_id }
      );
      return;
    }

    // ── Normal single file upload ────────────────────────────────────────────
    const processing = await bot.sendMessage(chatId, `⏳ Saving...`);
    try {
      const code = await getUniqueCode();
      await FileRecord.create({
        code,
        file_id: fileInfo.file_id,
        file_type: fileInfo.file_type,
        file_name: fileInfo.file_name,
        uploaded_by: userId,
        expires_at: null,
      });

      const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
      await bot.deleteMessage(chatId, processing.message_id);
      const caption = `✅ ${fileInfo.file_name}\n\nLink pe click karo — file aa jaayegi:`;
      await bot.sendMessage(chatId, caption,
        { reply_markup: { inline_keyboard: [[{ text: "📥 File Lo", url: link }]] } }
      );
      await bot.sendMessage(chatId, link, { disable_web_page_preview: true });

    } catch (err) {
      console.error("Save error:", err.message);
      try {
        await bot.editMessageText(`Save nahi hua. Dobara try karo.`, {
          chat_id: chatId, message_id: processing.message_id
        });
      } catch (_) {
        bot.sendMessage(chatId, `Save nahi hua. Dobara try karo.`);
      }
    }
  });

  // ── Polling error ────────────────────────────────────────────────────────────
  bot.on("polling_error", (err) => console.error("Polling error:", err.message));

  process.on("SIGTERM", () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
  process.on("SIGINT",  () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
}

startBot().catch((err) => {
  console.error("Bot startup error:", err.message);
  process.exit(1);
});
