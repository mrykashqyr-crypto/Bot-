const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const http = require('http');

// ===== سيرفر HTTP عشان Render ما يغلق البوت =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('البوت شغال ✅');
}).listen(PORT, () => {
  console.log(`🌐 السيرفر شغال على بورت ${PORT}`);
});

// ===== رقم الهاتف من Environment Variables =====
const PHONE_NUMBER = process.env.PHONE_NUMBER;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  // ===== ربط برقم الهاتف =====
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.log('❌ حط رقم هاتفك في Environment Variables باسم PHONE_NUMBER');
      process.exit(1);
    }
    const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`\n✅ كود الربط: ${code}`);
        console.log('روح لواتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
        console.log('وأدخل الكود هناك\n');
      } catch (err) {
        console.error('خطأ في طلب الكود:', err.message);
      }
    }, 3000);
  }

  // ===== حفظ الجلسة =====
  sock.ev.on('creds.update', saveCreds);

  // ===== حالة الاتصال =====
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('❌ انقطع الاتصال، جاري إعادة المحاولة...');
      if (shouldReconnect) startBot();

    } else if (connection === 'open') {
      console.log('✅ البوت متصل وشغال مع Gemini!');
    }
  });

  // ===== استقبال الرسائل =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const sender = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      const body = text.trim().toLowerCase();
      console.log(`📩 من ${sender}: ${text}`);

      // ===== أوامر خاصة =====
      if (body === '!مساعدة' || body === '!help') {
        await sock.sendMessage(sender, {
          text:
            '🤖 أوامر البوت:\n\n' +
            '!مساعدة - قائمة الأوامر\n' +
            '!وقت - الوقت الحالي\n' +
            '!ترحيب - رسالة ترحيب\n\n' +
            'أو اكتب أي سؤال وسأجيبك بالذكاء الاصطناعي Gemini 🧠'
        });
        continue;
      }

      if (body === '!وقت' || body === '!time') {
        const now = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
        await sock.sendMessage(sender, { text: `🕐 الوقت الحالي: ${now}` });
        continue;
      }

      if (body === '!ترحيب' || body === '!hi') {
        await sock.sendMessage(sender, {
          text: '👋 أهلاً وسهلاً!\nأنا بوتك الذكي بقوة Gemini، كيف أقدر أساعدك؟'
        });
        continue;
      }

      // ===== Gemini AI =====
      try {
        await sock.sendPresenceUpdate('composing', sender);
        const aiReply = await getGeminiResponse(text);
        await sock.sendMessage(sender, { text: aiReply });
      } catch (err) {
        console.error('خطأ في Gemini:', err.message);
        await sock.sendMessage(sender, { text: '⚠️ صار خطأ، جرب مرة ثانية.' });
      }
    }
  });
}

// ===== دالة Gemini AI =====
async function getGeminiResponse(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const response = await axios.post(url, {
    system_instruction: {
      parts: [{
        text: `أنت مساعد ذكي ومفيد على واتساب. ردودك تكون:
- مختصرة وواضحة
- باللغة العربية دائماً
- ودودة ومحترمة
- بدون تنسيق Markdown معقد`
      }]
    },
    contents: [{
      parts: [{ text: userMessage }]
    }]
  }, {
    headers: { 'Content-Type': 'application/json' }
  });

  return response.data.candidates[0].content.parts[0].text;
}

// ===== ابدأ =====
startBot();
