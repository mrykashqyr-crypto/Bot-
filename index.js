const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const http = require('http');
const NodeCache = require('node-cache');

const BOT_NAME = 'طارق';
const msgRetryCounterCache = new NodeCache();
const PHONE_NUMBER = process.env.PHONE_NUMBER;

// ===== سيرفر HTTP عشان Render =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`${BOT_NAME} شغال ✅`);
}).listen(PORT, () => {
  console.log(`🌐 ${BOT_NAME} يستمع على بورت ${PORT}`);
});

// ===== قائمة الكلمات السيئة بالعربي =====
const BAD_WORDS = [
  'كلب', 'حمار', 'غبي', 'احمق', 'معرص', 'ابن الحرام',
  'يلعن', 'عرص', 'شرموط', 'قحبة', 'زبالة', 'خنزير',
  'تبان', 'مجنون', 'بلطجي', 'كذاب', 'حقير', 'وسخ',
  'منيوك', 'زاني', 'فاسق', 'لقيط', 'عاهرة', 'ديوث'
];

// ===== تحقق إذا الرسالة فيها كلام سيء =====
function hasBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => lower.includes(word));
}

// ===== الأسئلة الشائعة والردود =====
const FAQ = [
  { keywords: ['وقت', 'الساعة', 'كم الساعة'], action: 'time' },
  { keywords: ['اهلا', 'أهلا', 'هلا', 'مرحبا', 'مرحبً', 'السلام'], action: 'welcome' },
  { keywords: ['مساعدة', 'help', 'اوامر', 'أوامر'], action: 'help' },
  { keywords: ['شكرا', 'شكراً', 'تسلم', 'يسلمو'], action: 'thanks' },
];

function getFAQAction(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keywords.some(k => lower.includes(k))) return faq.action;
  }
  return null;
}

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
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
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
        console.error('خطأ:', err.message);
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
      console.log('❌ انقطع الاتصال، جاري إعادة المحاولة...');
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} متصل وجاهز!`);
    }
  });

  // ===== استقبال الرسائل =====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) return;
      if (!msg.message) return;

      const sender = msg.key.remoteJid;
      const isGroup = sender.endsWith('@g.us');
      const senderUser = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;
      const body = text.trim();
      console.log(`📩 [${isGroup ? 'مجموعة' : 'خاص'}] ${senderUser}: ${body}`);

      // ===== فلتر الكلام السيء (للمجموعات فقط) =====
      if (isGroup && hasBadWord(body)) {
        try {
          // احذف الرسالة
          await sock.sendMessage(sender, { delete: msg.key });
          // حذر العضو
          await sock.sendMessage(sender, {
            text: `⚠️ تحذير @${senderUser.split('@')[0]}\nالكلام السيء ممنوع في هذه المجموعة!`,
            mentions: [senderUser]
          });
          console.log(`🚫 حذف رسالة سيئة من ${senderUser}`);
        } catch (err) {
          console.error('خطأ في حذف الرسالة:', err.message);
        }
        continue;
      }

      // ===== أوامر المشرف (للمجموعات فقط) =====
      if (isGroup) {
        // تحقق إذا المرسل أدمن
        const groupMeta = await sock.groupMetadata(sender);
        const isAdmin = groupMeta.participants
          .find(p => p.id === senderUser)?.admin != null;

        if (isAdmin || body.startsWith('!')) {

          // طرد عضو: !طرد @رقم
          if (body.startsWith('!طرد')) {
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ هذا الأمر للمشرفين فقط!' });
              continue;
            }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length === 0) {
              await sock.sendMessage(sender, { text: '⚠️ منشن الشخص اللي تبد تطرده: !طرد @شخص' });
              continue;
            }
            await sock.groupParticipantsUpdate(sender, mentioned, 'remove');
            await sock.sendMessage(sender, { text: `✅ تم طرد ${mentioned.length} عضو` });
            continue;
          }

          // كتم عضو: !كتم @رقم
          if (body.startsWith('!كتم')) {
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ هذا الأمر للمشرفين فقط!' });
              continue;
            }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length === 0) {
              await sock.sendMessage(sender, { text: '⚠️ منشن الشخص: !كتم @شخص' });
              continue;
            }
            // كتم عن طريق تنزيله من المشرفين إذا كان مشرف
            await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
            await sock.sendMessage(sender, {
              text: `🔇 تم كتم @${mentioned[0].split('@')[0]}`,
              mentions: mentioned
            });
            continue;
          }

          // قفل المجموعة: !قفل
          if (body === '!قفل') {
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ هذا الأمر للمشرفين فقط!' });
              continue;
            }
            await sock.groupSettingUpdate(sender, 'announcement');
            await sock.sendMessage(sender, { text: '🔒 تم قفل المجموعة - فقط المشرفون يستطيعون الكتابة' });
            continue;
          }

          // فتح المجموعة: !فتح
          if (body === '!فتح') {
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ هذا الأمر للمشرفين فقط!' });
              continue;
            }
            await sock.groupSettingUpdate(sender, 'not_announcement');
            await sock.sendMessage(sender, { text: '🔓 تم فتح المجموعة - الجميع يستطيع الكتابة' });
            continue;
          }

          // منشن كل الأعضاء: !منشن
          if (body.startsWith('!منشن')) {
            if (!isAdmin) {
              await sock.sendMessage(sender, { text: '❌ هذا الأمر للمشرفين فقط!' });
              continue;
            }
            const members = groupMeta.participants.map(p => p.id);
            const mentionText = body.replace('!منشن', '').trim() || '📢 تنبيه لجميع الأعضاء!';
            const mentions = members.map(m => `@${m.split('@')[0]}`).join(' ');
            await sock.sendMessage(sender, {
              text: `${mentionText}\n\n${mentions}`,
              mentions: members
            });
            continue;
          }

          // قائمة الأوامر: !مساعدة
          if (body === '!مساعدة' || body === '!help') {
            await sock.sendMessage(sender, {
              text:
                `🤖 *أوامر ${BOT_NAME}:*\n\n` +
                `*أوامر المشرفين:*\n` +
                `!طرد @شخص - طرد عضو\n` +
                `!كتم @شخص - كتم عضو\n` +
                `!قفل - قفل المجموعة\n` +
                `!فتح - فتح المجموعة\n` +
                `!منشن [نص] - منشن الكل\n\n` +
                `*أوامر الجميع:*\n` +
                `!وقت - الوقت الحالي\n` +
                `!مساعدة - هذه القائمة`
            });
            continue;
          }
        }
      }

      // ===== ردود تلقائية ذكية (خاص ومجموعات) =====
      const faqAction = getFAQAction(body);

      if (faqAction === 'time') {
        const now = new Date().toLocaleString('ar-SY', { timeZone: 'Asia/Damascus' });
        await sock.sendMessage(sender, { text: `🕐 الوقت الحالي: ${now}` });
        continue;
      }

      if (faqAction === 'welcome') {
        await sock.sendMessage(sender, {
          text: `👋 أهلاً وسهلاً!\nأنا *${BOT_NAME}*، اكتب *!مساعدة* لترى الأوامر`
        });
        continue;
      }

      if (faqAction === 'help') {
        await sock.sendMessage(sender, {
          text:
            `🤖 *أوامر ${BOT_NAME}:*\n\n` +
            `!طرد @شخص - طرد عضو\n` +
            `!كتم @شخص - كتم عضو\n` +
            `!قفل - قفل المجموعة\n` +
            `!فتح - فتح المجموعة\n` +
            `!منشن [نص] - منشن الكل\n` +
            `!وقت - الوقت الحالي`
        });
        continue;
      }

      if (faqAction === 'thanks') {
        await sock.sendMessage(sender, { text: `على الرحب والسعة! 😊` });
        continue;
      }
    }
  });
}

startBot();
