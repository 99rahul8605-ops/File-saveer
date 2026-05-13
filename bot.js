const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !MONGO_URI) {
  console.error("Missing env: BOT_TOKEN aur MONGO_URI required hai.");
  process.exit(1);
}

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  file_id: { type: String, required: true },
  file_type: { type: String, required: true },
  file_name: { type: String, default: "file" },
  uploaded_by: { type: Number },
  created_at: { type: Date, default: Date.now },
});
const FileRecord = mongoose.model("FileRecord", fileSchema);

// Health server
const app = express();
app.get("/health", (req, res) => res.status(200).json({
  status: "ok",
  uptime: process.uptime(),
  mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));
app.listen(PORT, () => console.log(`Health server on port ${PORT}`));

// Code generator
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
async function getUniqueCode() {
  let code, exists;
  do { code = generateCode(); exists = await FileRecord.findOne({ code }); } while (exists);
  return code;
}

function extractFileInfo(msg) {
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name || "document" };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length - 1].file_id, file_type: "photo", file_name: "photo.jpg" };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name || "video.mp4" };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name || "audio.mp3" };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4" };
  return null;
}

async function sendFile(chatId, record) {
  const caption = `📎 ${record.file_name}`;
  switch (record.file_type) {
    case "photo":      await bot.sendPhoto(chatId, record.file_id, { caption }); break;
    case "video":      await bot.sendVideo(chatId, record.file_id, { caption }); break;
    case "audio":      await bot.sendAudio(chatId, record.file_id, { caption }); break;
    case "voice":      await bot.sendVoice(chatId, record.file_id, { caption }); break;
    case "video_note": await bot.sendVideoNote(chatId, record.file_id); break;
    default:           await bot.sendDocument(chatId, record.file_id, { caption });
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Startup pe API se username lo
let BOT_USERNAME = "";
bot.getMe().then((me) => {
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);
}).catch((err) => {
  console.error("getMe failed:", err.message);
  process.exit(1);
});

// /start — normal + deep link
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1].trim();

  if (param) {
    try {
      const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${param}$`, "i") } });
      if (!record) return bot.sendMessage(chatId, `File nahi mili. Link galat ya delete ho gaya.`);
      await sendFile(chatId, record);
    } catch (err) {
      console.error("Deep link error:", err.message);
      bot.sendMessage(chatId, `Error aaya. Dobara try karo.`);
    }
    return;
  }

  bot.sendMessage(chatId,
    `👋 Hello ${msg.from.first_name}!\n\n` +
    `Koi bhi file bhejo — main ek link dunga.\n` +
    `Link pe click karo — file seedha aa jaayegi!\n\n` +
    `/myfiles — apni saari files dekho`
  );
});

bot.onText(/\/myfiles/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const files = await FileRecord.find({ uploaded_by: msg.from.id }).sort({ created_at: -1 }).limit(20);
    if (files.length === 0) return bot.sendMessage(chatId, `Abhi tak koi file upload nahi ki.`);

    const emoji = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
    let text = `Aapki Files (${files.length}):\n\n`;
    files.forEach((f) => {
      text += `${emoji[f.file_type] || "📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;
    });
    bot.sendMessage(chatId, text, { disable_web_page_preview: true });
  } catch (err) {
    bot.sendMessage(chatId, `Error aaya. Dobara try karo.`);
  }
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  try {
    const record = await FileRecord.findOneAndDelete({
      code: { $regex: new RegExp(`^${code}$`, "i") },
      uploaded_by: msg.from.id
    });
    if (!record) return bot.sendMessage(chatId, `Code nahi mila ya yeh aapki file nahi hai.`);
    bot.sendMessage(chatId, `File delete ho gayi!`);
  } catch (err) {
    bot.sendMessage(chatId, `Delete nahi hua. Dobara try karo.`);
  }
});

// File receive → link generate
bot.on("message", async (msg) => {
  if (msg.text) return;
  const chatId = msg.chat.id;
  const fileInfo = extractFileInfo(msg);
  if (!fileInfo) return;

  const processing = await bot.sendMessage(chatId, `⏳ Saving...`);
  try {
    const code = await getUniqueCode();
    await FileRecord.create({
      code,
      file_id: fileInfo.file_id,
      file_type: fileInfo.file_type,
      file_name: fileInfo.file_name,
      uploaded_by: msg.from?.id,
    });

    const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
    await bot.deleteMessage(chatId, processing.message_id);

    await bot.sendMessage(chatId,
      `✅ ${fileInfo.file_name}\n\nLink pe click karo — file aa jaayegi:`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "📥 File Lo", url: link }]]
        }
      }
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

// Conflict aaye to process band karo — Render automatically restart karega
bot.on("polling_error", (err) => {
  if (err.message.includes("409")) {
    console.error("409 Conflict: Dusra instance chal raha hai. Shutting down...");
    process.exit(1);
  }
});

process.on("SIGTERM", () => {
  bot.stopPolling();
  mongoose.connection.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  bot.stopPolling();
  mongoose.connection.close();
  process.exit(0);
});
