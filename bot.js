const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL; // e.g. https://yourapp.onrender.com
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !BASE_URL || !MONGO_URI) {
  console.error(
    "❌ Missing env variables: BOT_TOKEN, BASE_URL, MONGO_URI are required."
  );
  process.exit(1);
}

// ─── MongoDB Setup ───────────────────────────────────────────────────────────
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

const fileSchema = new mongoose.Schema({
  uuid: { type: String, required: true, unique: true, index: true },
  file_id: { type: String, required: true },
  file_type: { type: String, required: true }, // document, photo, video, audio, voice
  file_name: { type: String, default: "file" },
  uploaded_by: { type: Number }, // Telegram user ID
  created_at: { type: Date, default: Date.now },
});

const FileRecord = mongoose.model("FileRecord", fileSchema);

// ─── Express Health + Redirect Server ────────────────────────────────────────
const app = express();

// Health check endpoint for Render
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// File redirect endpoint
app.get("/file/:uuid", async (req, res) => {
  const { uuid } = req.params;

  try {
    const record = await FileRecord.findOne({ uuid });

    if (!record) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:50px">
          <h2>❌ File Not Found</h2>
          <p>This link is invalid or the file has been deleted.</p>
        </body></html>
      `);
    }

    // Get download URL from Telegram
    const fileInfo = await bot.getFile(record.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

    // Redirect to the actual file
    res.redirect(fileUrl);
  } catch (err) {
    console.error("Error fetching file:", err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>⚠️ Error</h2>
        <p>Could not retrieve the file. Please try again later.</p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Express server running on port ${PORT}`);
});

// ─── Telegram Bot Setup ───────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("✅ Telegram bot started (polling)");

// ─── Helper: Extract File Info from Message ───────────────────────────────────
function extractFileInfo(msg) {
  if (msg.document) {
    return {
      file_id: msg.document.file_id,
      file_type: "document",
      file_name: msg.document.file_name || "document",
    };
  }
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // highest res
    return { file_id: photo.file_id, file_type: "photo", file_name: "photo.jpg" };
  }
  if (msg.video) {
    return {
      file_id: msg.video.file_id,
      file_type: "video",
      file_name: msg.video.file_name || "video.mp4",
    };
  }
  if (msg.audio) {
    return {
      file_id: msg.audio.file_id,
      file_type: "audio",
      file_name: msg.audio.file_name || "audio.mp3",
    };
  }
  if (msg.voice) {
    return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg" };
  }
  if (msg.video_note) {
    return {
      file_id: msg.video_note.file_id,
      file_type: "video_note",
      file_name: "video_note.mp4",
    };
  }
  if (msg.sticker) {
    return {
      file_id: msg.sticker.file_id,
      file_type: "sticker",
      file_name: "sticker.webp",
    };
  }
  return null;
}

// ─── /start Command ───────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "User";
  bot.sendMessage(
    msg.chat.id,
    `👋 *Hello ${name}!*\n\n` +
      `Mujhe koi bhi file bhejo aur main uske liye ek *shareable link* bana dunga! 🔗\n\n` +
      `*Supported files:*\n` +
      `📄 Documents\n📷 Photos\n🎬 Videos\n🎵 Audio\n🎤 Voice messages\n\n` +
      `*Commands:*\n` +
      `/start - Bot start karo\n` +
      `/help - Help dekho`,
    { parse_mode: "Markdown" }
  );
});

// ─── /help Command ────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📖 *How to use:*\n\n` +
      `1️⃣ Mujhe koi bhi file bhejo\n` +
      `2️⃣ Main ek unique link generate kar dunga\n` +
      `3️⃣ Us link pe click karo — file seedha download ho jaayegi!\n\n` +
      `⚠️ *Note:* Link tabhi kaam karega jab bot active ho.\n\n` +
      `*Supported:* Documents, Photos, Videos, Audio, Voice`,
    { parse_mode: "Markdown" }
  );
});

// ─── File Handler ─────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  // Ignore commands
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  const fileInfo = extractFileInfo(msg);

  if (!fileInfo) {
    // Only reply if it's a text message (ignore other non-file messages)
    if (msg.text) {
      bot.sendMessage(
        chatId,
        `📂 *Koi file bhejo!*\n\nMain sirf files (documents, photos, videos, audio) ko links mein convert kar sakta hoon.`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // Send "processing" message
  const processingMsg = await bot.sendMessage(
    chatId,
    `⏳ Processing your file...`,
    { parse_mode: "Markdown" }
  );

  try {
    // Generate unique UUID
    const uuid = uuidv4();

    // Save to MongoDB
    const record = new FileRecord({
      uuid,
      file_id: fileInfo.file_id,
      file_type: fileInfo.file_type,
      file_name: fileInfo.file_name,
      uploaded_by: userId,
    });
    await record.save();

    const link = `${BASE_URL}/file/${uuid}`;

    // Delete processing message
    await bot.deleteMessage(chatId, processingMsg.message_id);

    // Send the link
    await bot.sendMessage(
      chatId,
      `✅ *File link ready hai!*\n\n` +
        `📎 *File:* \`${fileInfo.file_name}\`\n` +
        `🔗 *Link:*\n${link}\n\n` +
        `👆 Is link pe click karo — file seedha download ho jaayegi!`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📥 Download File", url: link }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("Error saving file:", err.message);
    await bot.editMessageText(
      `❌ File save karne mein error aaya. Please dobara try karo.`,
      { chat_id: chatId, message_id: processingMsg.message_id }
    );
  }
});

// ─── Polling Error Handler ────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
