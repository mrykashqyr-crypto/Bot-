const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const readline = require('readline');
const pino = require('pino');

// ===== إدخال رقم الهاتف =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // بدون QR
    logger: pino({ level: 'silent' }),
  });

  // ===== ربط برقم الهاتف (Pairing Code) =====
  if (!sock.authState.creds.registered) {
    const phoneNumber = await question('أدخل رقم هاتفك مع كود الدولة (مثال: 9627XXXXXXXX): ');
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    
    setTimeout(async () => {
      const code = await sock.requestPairingCode(cleanNumber);
      console.log(`\n✅ كود الربط: ${code}`);
      console.log('روح لواتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف');
      console.log('وأدخل الكود هناك\n');
    }, 3000);
  }

  // ===== حفظ بيانات الجلسة =====
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
      console.log('✅ البوت متصل وشغال!');
      rl.close();
    }
  });

  // ===== استقبال الرسائل =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // تجاهل رسائلنا نحن
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
            'أو اكتب أي سؤال وسأجيبك بالذكاء الاصطناعي 🧠'
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
          text: '👋 أهلاً وسهلاً!\nأنا بوتك الذكي، كيف أقدر أساعدك اليوم؟'
        });
        continue;
      }

      // ===== ذكاء اصطناعي =====
      try {
        await sock.sendPresenceUpdate('composing', sender); // يظهر "يكتب..."
        const aiReply = await getAIResponse(text);
        await sock.sendMessage(sender, { text: aiReply });
      } catch (err) {
        console.error('خطأ في الذكاء الاصطناعي:', err.message);
        await sock.sendMessage(sender, { text: '⚠️ صار خطأ، جرب مرة ثانية.' });
      }
    }
  });
}

// ===== دالة الذكاء الاصطناعي =====
async function getAIResponse(userMessage) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `أنت مساعد ذكي ومفيد على واتساب. ردودك تكون:
- مختصرة وواضحة
- باللغة العربية دائماً
- ودودة ومحترمة
- بدون تنسيق Markdown معقد`,
      messages: [{ role: 'user', content: userMessage }]
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }
  );

  return response.data.content[0].text;
}

// ===== ابدأ =====
startBot();
