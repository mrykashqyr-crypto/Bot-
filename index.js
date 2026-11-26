const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const NodeCache = require('node-cache');

const BOT_NAME = 'طارق';
const msgRetryCounterCache = new NodeCache();

// ===== سيرفر HTTP عشان Render =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`${BOT_NAME} شغال ✅`);
}).listen(PORT, () => {
  console.log(`🌐 ${BOT_NAME} يستمع على بورت ${PORT}`);
});

const PHONE_NUMBER = process.env.PHONE_NUMBER;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ===== كاش للردود عشان أقصى سرعة =====
const responseCache = new Map();

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false, // أسرع
    syncFullHistory: false,                // أسرع
    markOnlineOnConnect: true,
  });

  // ===== ربط برقم الهاتف =====
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.log('❌ حط PHONE_NUMBER في Environment Variables');
      process.exit(1);
    }
    const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`\n✅ كود الربط: ${code}`);
        console.log('واتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف\n');
      } catch (err) {
        console.error('خطأ في الكود:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log(`❌ انقطع الاتصال...`);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} متصل وجاهز!`);
    }
  });

  // ===== استقبال الرسائل بأقصى سرعة =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    // معالجة كل الرسائل بالتوازي عشان أقصى سرعة
    await Promise.all(messages.map(async (msg) => {
      if (msg.key.fromMe) return;
      if (!msg.message) return;

      const sender = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) return;

      const body = text.trim().toLowerCase();
      console.log(`📩 ${sender}: ${text}`);

      // ===== أوامر خاصة =====
      if (body === '!مساعدة' || body === '!help') {
        return sock.sendMessage(sender, {
          text:
            `🤖 أنا *${BOT_NAME}*، مساعدك الذكي!\n\n` +
            `الأوامر المتاحة:\n` +
            `!مساعدة - قائمة الأوامر\n` +
            `!وقت - الوقت الحالي\n` +
            `!من - من أنا\n\n` +
            `أو اكتب أي سؤال وسأرد فوراً 🧠`
        });
      }

      if (body === '!وقت' || body === '!time') {
        const now = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
        return sock.sendMessage(sender, { text: `🕐 الوقت: ${now}` });
      }

      if (body === '!من' || body === '!whoami') {
        return sock.sendMessage(sender, {
          text: `أنا *${BOT_NAME}* 🤖\nبوت ذكي بقوة Gemini AI\nجاهز أساعدك في أي شيء!`
        });
      }

      // ===== تحقق من الكاش أولاً =====
      if (responseCache.has(body)) {
        return sock.sendMessage(sender, { text: responseCache.get(body) });
      }

      // ===== Gemini AI بأقصى سرعة =====
      try {
        await sock.sendPresenceUpdate('composing', sender);
        const aiReply = await getGeminiResponse(text);

        // احفظ في الكاش
        if (responseCache.size > 100) responseCache.clear();
        responseCache.set(body, aiReply);

        await sock.sendMessage(sender, { text: aiReply });
      } catch (err) {
        console.error('خطأ Gemini:', err.message);
        await sock.sendMessage(sender, { text: '⚠️ جرب مرة ثانية.' });
      }
    }));
  });
}

// ===== Gemini بأقصى سرعة =====
async function getGeminiResponse(userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const response = await axios.post(url, {
    system_instruction: {
      parts: [{
        text: `اسمك ${BOT_NAME}، مساعد ذكي على واتساب.
ردودك:
- مختصرة وسريعة
- بالعربية دائماً
- ودودة ومحترمة
- بدون Markdown معقد`
      }]
    },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      maxOutputTokens: 512,   // أقل = أسرع
      temperature: 0.7,
      topP: 0.9,
    }
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000 // 10 ثواني max
  });

  return response.data.candidates[0].content.parts[0].text;
}

startBot();
