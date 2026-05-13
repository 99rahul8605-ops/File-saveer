const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !MONGO_URI) {
  console.error("❌ Missing env variables: BOT_TOKEN aur MONGO_URI required hai.");
  process.exit(1);
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => { console.error("❌ MongoDB error:", err.message); process.exit(1); });

const fileSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  file_id: { type: String, required: true },
  file_type: { type: String, required: true },
  file_name: { type: String, default: "file" },
  uploaded_by: { type: Number },
  created_at: { type: Date, default: Date.now },
});

const FileRecord = mongoose.model("FileRecord", fileSchema);

// ─── Health Server (Render ke liye) ──────────────────────────────────────────
const app = express();
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});
app.listen(PORT, () => console.log(`✅ Health server on port ${PORT}`));

// ─── Short Code Generator (6 characters) ─────────────────────────────────────
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
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

// ─── File Type Extractor ──────────────────────────────────────────────────────
function extractFileInfo(msg) {
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name || "document" };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length - 1].file_id, file_type: "photo", file_name: "photo.jpg" };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name || "video.mp4" };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name || "audio.mp3" };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4" };
  return null;
}

// ─── File Send Helper ─────────────────────────────────────────────────────────
async function sendFile(chatId, record) {
  const caption = `📎 *${record.file_name}*\n🔑 Code: \`${record.code}\``;
  switch (record.file_type) {
    case "photo":      await bot.sendPhoto(chatId, record.file_id, { caption, parse_mode: "Markdown" }); break;
    case "video":      await bot.sendVideo(chatId, record.file_id, { caption, parse_mode: "Markdown" }); break;
    case "audio":      await bot.sendAudio(chatId, record.file_id, { caption, parse_mode: "Markdown" }); break;
    case "voice":      await bot.sendVoice(chatId, record.file_id, { caption, parse_mode: "Markdown" }); break;
    case "video_note": await bot.sendVideoNote(chatId, record.file_id); break;
    default:           await bot.sendDocument(chatId, record.file_id, { caption, parse_mode: "Markdown" });
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("✅ Bot started!");

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Hello ${msg.from.first_name}!*\n\n` +
    `Koi bhi file bhejo — main ek *6-digit code* dunga.\n` +
    `Code use karke kabhi bhi woh file wapis paa sakte ho!\n\n` +
    `📥 *File pane ke liye:*\n` +
    `\`/get ABC123\`\n\n` +
    `📋 *Apni saari files:*\n` +
    `/myfiles`,
    { parse_mode: "Markdown" }
  );
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *Commands:*\n\n` +
    `📤 File bhejo → code milega\n` +
    `/get CODE — file retrieve karo\n` +
    `/myfiles — apni saari files dekho\n` +
    `/delete CODE — file delete karo`,
    { parse_mode: "Markdown" }
  );
});

// /get CODE
bot.onText(/\/get (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();

  try {
    const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${code}$`, "i") } });
    if (!record) {
      return bot.sendMessage(chatId,
        `❌ Code \`${code}\` nahi mila!\nCheck karke dobara try karo.`,
        { parse_mode: "Markdown" }
      );
    }
    await sendFile(chatId, record);
  } catch (err) {
    console.error("Get error:", err.message);
    bot.sendMessage(chatId, `⚠️ Error aaya. Dobara try karo.`);
  }
});

// /myfiles
bot.onText(/\/myfiles/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const files = await FileRecord.find({ uploaded_by: userId }).sort({ created_at: -1 }).limit(20);

    if (files.length === 0) {
      return bot.sendMessage(chatId, `📂 Abhi tak koi file upload nahi ki.`);
    }

    const emoji = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
    let text = `📋 *Aapki Files (${files.length}):*\n\n`;
    files.forEach((f) => {
      const date = f.created_at.toLocaleDateString("en-IN");
      text += `${emoji[f.file_type] || "📎"} \`${f.code}\` — ${f.file_name} _(${date})_\n`;
    });
    text += `\n💡 \`/get CODE\` bhejo file paane ke liye`;

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Error aaya. Dobara try karo.`);
  }
});

// /delete CODE
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();

  try {
    const record = await FileRecord.findOneAndDelete({
      code: { $regex: new RegExp(`^${code}$`, "i") },
      uploaded_by: msg.from.id
    });

    if (!record) {
      return bot.sendMessage(chatId, `❌ Code \`${code}\` nahi mila ya yeh aapki file nahi hai.`, { parse_mode: "Markdown" });
    }
    bot.sendMessage(chatId, `🗑️ File delete ho gayi! (\`${code}\`)`, { parse_mode: "Markdown" });
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Delete nahi hua. Dobara try karo.`);
  }
});

// File receive → code generate
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

    await bot.deleteMessage(chatId, processing.message_id);

    await bot.sendMessage(chatId,
      `✅ *File Save Ho Gayi!*\n\n` +
      `📎 ${fileInfo.file_name}\n\n` +
      `🔑 *Aapka Code:*\n` +
      `\`\`\`\n${code}\n\`\`\`\n\n` +
      `File paane ke liye:\n\`/get ${code}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "📥 File Wapis Lo", callback_data: `get:${code}` }
          ]]
        }
      }
    );
  } catch (err) {
    console.error("Save error:", err.message);
    bot.editMessageText(`❌ Save nahi hua. Dobara try karo.`, {
      chat_id: chatId, message_id: processing.message_id
    });
  }
});

// Inline button handler
bot.on("callback_query", async (query) => {
  const [action, code] = query.data.split(":");
  if (action !== "get") return;

  await bot.answerCallbackQuery(query.id, { text: "📥 File bhej raha hoon..." });

  try {
    const record = await FileRecord.findOne({ code });
    if (!record) return bot.sendMessage(query.message.chat.id, `❌ File nahi mili.`);
    await sendFile(query.message.chat.id, record);
  } catch (err) {
    bot.sendMessage(query.message.chat.id, `⚠️ Error aaya. \`/get ${code}\` try karo.`, { parse_mode: "Markdown" });
  }
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));
