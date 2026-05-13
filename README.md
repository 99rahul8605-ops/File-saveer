# 📁 Telegram File-to-Link Bot

Ek Telegram bot jo aapki files ko shareable links mein convert karta hai.  
File bhejo → Link milega → Link se file download ho!

---

## 🚀 Features

- ✅ Files ko unique links mein convert karta hai
- ✅ MongoDB mein file IDs save karta hai
- ✅ Documents, Photos, Videos, Audio, Voice support
- ✅ Health check endpoint (`/health`) — Render ke liye
- ✅ Docker se easy deployment
- ✅ Download button bhi milta hai

---

## 📋 Prerequisites

1. **Telegram Bot Token** — [@BotFather](https://t.me/BotFather) se banao
2. **MongoDB Atlas** — [atlas.mongodb.com](https://atlas.mongodb.com) pe free cluster banao
3. **Render account** — [render.com](https://render.com) pe account banao

---

## 🛠️ Local Setup (Docker Compose)

```bash
# 1. Clone / files download karo
cd telegram-file-bot

# 2. .env file banao
cp .env.example .env
# .env file mein apni values dalo

# 3. Run karo
docker-compose up --build
```

---

## ☁️ Render pe Deploy karna

### Step 1 — GitHub pe push karo
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/telegram-file-bot.git
git push -u origin main
```

### Step 2 — Render pe New Web Service banao
1. [render.com](https://render.com) pe login karo
2. **New → Web Service** click karo
3. GitHub repo connect karo
4. Settings:
   - **Environment:** `Docker`
   - **Plan:** Free

### Step 3 — Environment Variables set karo
Render dashboard → Environment tab mein ye variables dalo:

| Variable    | Value |
|-------------|-------|
| `BOT_TOKEN` | Telegram bot token |
| `BASE_URL`  | `https://your-app.onrender.com` |
| `MONGO_URI` | MongoDB Atlas connection string |
| `PORT`      | `3000` |

### Step 4 — Deploy!
- Save karo, Render automatically deploy karega
- Health check: `https://your-app.onrender.com/health`

---

## 💡 Important Notes

### Render Free Tier
> ⚠️ Render free tier pe app **15 min inactivity** ke baad sleep ho jaata hai.  
> Bot ko active rakhne ke liye [UptimeRobot](https://uptimerobot.com) se `/health` endpoint ko har 10 min pe ping karwao (free hai).

### MongoDB Atlas Setup
1. [atlas.mongodb.com](https://atlas.mongodb.com) pe free cluster banao
2. Database user banao
3. Network Access mein `0.0.0.0/0` allow karo (Render ke liye)
4. Connection string copy karo

---

## 📡 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Bot status check |
| `GET /file/:uuid` | File download redirect |

---

## 🗄️ Database Schema

```js
{
  uuid: String,       // Unique link ID
  file_id: String,    // Telegram file ID
  file_type: String,  // document/photo/video/audio/voice
  file_name: String,  // Original filename
  uploaded_by: Number,// Telegram user ID
  created_at: Date    // Upload time
}
```

---

## 🤖 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Bot start karo |
| `/help` | Help dekho |
| _(any file)_ | Link generate karo |
