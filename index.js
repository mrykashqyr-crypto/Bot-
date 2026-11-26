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

// ===================================================
//           🧠 العقل الداخلي لطارق
// ===================================================

// ذاكرة المحادثات - يتذكر كل شخص
const memory = new Map();

function getMemory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, {
      messages: [],      // آخر 10 رسائل
      mood: 'neutral',   // مزاج الشخص
      name: null,        // اسمه لو قاله
      askedCount: 0,     // كم مرة سأل
    });
  }
  return memory.get(userId);
}

function saveToMemory(userId, userText, botReply) {
  const mem = getMemory(userId);
  mem.messages.push({ user: userText, bot: botReply, time: Date.now() });
  if (mem.messages.length > 10) mem.messages.shift(); // احتفظ بآخر 10 فقط
  mem.askedCount++;
}

// ===== تحليل المزاج =====
function analyzeMood(text) {
  const angry = ['زعلان', 'غاضب', 'معصوب', 'تعبان', 'زهقت', 'بكيت', 'مشكلة', 'ما بدي'];
  const happy = ['مبسوط', 'سعيد', 'عظيم', 'ممتاز', 'رائع', 'احبك', 'شكرا', 'تسلم', 'هههه', '😂', '❤️'];
  const curious = ['كيف', 'ليش', 'شو', 'وين', 'متى', 'مين', 'لماذا', 'هل', '؟'];

  const lower = text.toLowerCase();
  if (angry.some(w => lower.includes(w))) return 'angry';
  if (happy.some(w => lower.includes(w))) return 'happy';
  if (curious.some(w => lower.includes(w))) return 'curious';
  return 'neutral';
}

// ===== استخراج الاسم =====
function extractName(text) {
  const patterns = [
    /اسمي\s+(\w+)/,
    /انا\s+(\w+)/,
    /أنا\s+(\w+)/,
    /نادني\s+(\w+)/,
    /اسمك\s+(\w+)/,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[1];
  }
  return null;
}

// ===== فهم قصد الجملة =====
function detectIntent(text) {
  const lower = text.toLowerCase().trim();

  // تحيات
  if (/^(اهلا|أهلا|هلا|مرحبا|مرحباً|السلام|سلام|هاي|hi|hello|صباح|مساء)/.test(lower)) return 'greet';

  // وداع
  if (/(باي|مع السلامة|وداعا|وداعاً|اشوفك|يسلمك)/.test(lower)) return 'bye';

  // سؤال عن الوقت
  if (/(وقت|ساعة|الساعة|كم الساعة|몇시)/.test(lower)) return 'time';

  // سؤال عن التاريخ
  if (/(تاريخ|اليوم|اليوم كم|يوم كم)/.test(lower)) return 'date';

  // سؤال عن البوت نفسه
  if (/(مين انت|من انت|شو انت|اسمك|عمرك|كيف حالك|كيفك|شو بتعمل|بتفهم|ذكي)/.test(lower)) return 'about';

  // شكر
  if (/(شكرا|شكراً|تسلم|يسلمو|مشكور|ممنون)/.test(lower)) return 'thanks';

  // طلب مساعدة
  if (/(مساعدة|help|اوامر|أوامر|شو تعمل|قديش تعرف)/.test(lower)) return 'help';

  // سؤال عام بصيغة سؤال
  if (lower.includes('؟') || lower.startsWith('هل') || lower.startsWith('كيف') || lower.startsWith('ليش') || lower.startsWith('شو') || lower.startsWith('وين') || lower.startsWith('لماذا')) return 'question';

  // جملة عاطفية
  if (/(زعلان|تعبان|مبسوط|سعيد|وحيد|خايف|قلقان|فرحان)/.test(lower)) return 'emotional';

  // مدح
  if (/(ذكي|رائع|ممتاز|عظيم|احسنت|برافو|كفو|تمام)/.test(lower)) return 'praise';

  return 'unknown';
}

// ===== قاعدة معرفة طارق =====
const knowledgeBase = {
  // أسئلة شائعة
  'ما هو الذكاء الاصطناعي': 'الذكاء الاصطناعي هو تقنية تجعل الحاسوب يفكر ويتعلم مثل البشر! 🤖',
  'ما هو واتساب': 'واتساب تطبيق مراسلة شهير يملكه ميتا، يستخدمه أكثر من 2 مليار شخص حول العالم 📱',
  'ما هي سوريا': 'سوريا دولة عربية جميلة في الشرق الأوسط، عاصمتها دمشق أقدم عاصمة مأهولة في العالم 🌍',
  'كيف احفظ رقم': 'افتح واتساب ← جهات الاتصال ← أضف جهة اتصال جديدة ثم أدخل الاسم والرقم ✅',
  'كيف اعمل مجموعة': 'واتساب ← المجموعات ← مجموعة جديدة ← اختار الأعضاء ← سمّي المجموعة ✅',
};

function searchKnowledge(text) {
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(knowledgeBase)) {
    const keywords = key.split(' ').filter(w => w.length > 2);
    const matchCount = keywords.filter(k => lower.includes(k)).length;
    if (matchCount >= 2) return value;
  }
  return null;
}

// ===== ردود حسب المزاج =====
function getMoodPrefix(mood) {
  switch (mood) {
    case 'angry': return ['خذ نفس عميق 😌 ', 'هدّي شوي، ', 'أنا هون معك، '];
    case 'happy': return ['يسعدني! 😄 ', 'رائع! 🌟 ', 'ممتاز! 🎉 '];
    case 'curious': return ['سؤال ممتاز! 🤔 ', 'خلّيني أفكر... ', 'فكرة ذكية! 💡 '];
    default: return ['', 'حسناً، ', 'تفضل، '];
  }
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===== العقل الرئيسي =====
function think(userId, text) {
  const mem = getMemory(userId);
  const intent = detectIntent(text);
  const mood = analyzeMood(text);
  const extractedName = extractName(text);
  const moodPrefix = randomFrom(getMoodPrefix(mood));

  // تحديث المزاج والاسم
  mem.mood = mood;
  if (extractedName) mem.name = extractedName;

  const name = mem.name ? `يا ${mem.name}` : '';
  const isFirstTime = mem.askedCount === 0;

  // ===== ردود حسب القصد =====
  switch (intent) {

    case 'greet':
      if (isFirstTime) {
        return `${moodPrefix}أهلاً وسهلاً ${name}! 👋\nأنا *${BOT_NAME}*، مساعدك الذكي\nاكتب *!مساعدة* لترى شو أقدر أعمله 😊`;
      }
      return randomFrom([
        `أهلاً ${name}! كيف أقدر أساعدك؟ 😊`,
        `هلا ${name}! شو في؟ 👋`,
        `أهلاً ${name}! معك ${BOT_NAME} 🤖`,
      ]);

    case 'bye':
      return randomFrom([
        `مع السلامة ${name}! 👋 كن بخير`,
        `وداعاً ${name}! إذا احتجت شي أنا هون 😊`,
        `يسلمك ${name}! إلى اللقاء 🌟`,
      ]);

    case 'time': {
      const now = new Date().toLocaleString('ar-SY', {
        timeZone: 'Asia/Damascus',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      return `🕐 الوقت الآن ${name}: ${now} (توقيت دمشق)`;
    }

    case 'date': {
      const today = new Date().toLocaleDateString('ar-SY', {
        timeZone: 'Asia/Damascus',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      return `📅 اليوم ${name}: ${today}`;
    }

    case 'about':
      return randomFrom([
        `أنا *${BOT_NAME}* 🤖\nبوت ذكي بعقل داخلي\nأفهم قصدك، أتذكر محادثتنا، وأرد بأسلوب يناسبك!\nسألتني ${mem.askedCount + 1} مرة حتى الآن 😄`,
        `اسمي *${BOT_NAME}* وأنا مش بوت عادي!\nعندي ذاكرة، أفهم المشاعر، وأفكر بنفسي 🧠`,
        `${BOT_NAME} خادمك! 😊\nأعرف أدير المجموعات، أفهم حكيك، وأتذكر شو قلته قبل 💪`,
      ]);

    case 'thanks':
      return randomFrom([
        `على الرحب ${name}! 😊`,
        `هلا فيك! إذا بدك شي تاني أنا هون 🌟`,
        `يسعدني خدمتك ${name}! 💙`,
      ]);

    case 'help':
      return `🤖 *أوامر ${BOT_NAME}:*\n\n` +
        `*للمجموعات (مشرفين):*\n` +
        `!طرد @شخص - طرد عضو\n` +
        `!كتم @شخص - كتم عضو\n` +
        `!قفل - قفل المجموعة\n` +
        `!فتح - فتح المجموعة\n` +
        `!منشن نص - منشن الكل\n\n` +
        `*للجميع:*\n` +
        `!وقت - الوقت الحالي\n` +
        `!تاريخ - تاريخ اليوم\n` +
        `!مساعدة - هذه القائمة\n\n` +
        `أو كلمني بشكل طبيعي وأنا أفهمك 😊`;

    case 'emotional':
      if (mood === 'angry') {
        return randomFrom([
          `أنا حاسس إنك تعبان ${name} 😔\nكيف أقدر أساعدك؟`,
          `يبدو إنك مش بأحسن حالاتك ${name}\nأنا هون إذا بدك تحكي 💙`,
        ]);
      }
      if (mood === 'happy') {
        return randomFrom([
          `يسعدني إنك مبسوط ${name}! 😄🎉`,
          `جميل لما تكون بهالمزاج ${name}! 🌟`,
        ]);
      }
      return `أنا هون ${name} 😊 شو في؟`;

    case 'praise':
      return randomFrom([
        `شكراً ${name}! هاد يشجعني 😄🌟`,
        `يسلمك ${name}! بحاول دائماً أكون أحسن 💪`,
        `ممنون ${name}! إذا عندك اقتراح قولي 😊`,
      ]);

    case 'question': {
      // ابحث في قاعدة المعرفة
      const knowledge = searchKnowledge(text);
      if (knowledge) return `${moodPrefix}${knowledge}`;

      // تحقق إذا سأل عن نفس الشي من قبل
      const lastMessages = mem.messages.slice(-3);
      const repeated = lastMessages.some(m => m.user.toLowerCase().includes(text.toLowerCase().substring(0, 10)));
      if (repeated) {
        return `${name} سألتني عن هاد الشي قبل شوي 😄\nما عندي معلومة أضافية، بس إذا بدك أساعدك بشي ثاني أنا هون!`;
      }

      return randomFrom([
        `${moodPrefix}سؤال ممتاز ${name}! 🤔\nللأسف ما عندي جواب كافي هلق، بس أقدر أساعدك بالأوامر والمجموعات 😊`,
        `${moodPrefix}هاد سؤال بحتاج تفكير ${name}!\nجرب تسأل بشكل أكثر تحديداً وبحاول أساعدك 💡`,
      ]);
    }

    default:
      // إذا ما عرف القصد، شيك على المحادثة السابقة
      if (mem.messages.length > 0) {
        const last = mem.messages[mem.messages.length - 1];
        if (Date.now() - last.time < 60000) { // آخر دقيقة
          return randomFrom([
            `${moodPrefix}فاهمك ${name}! بس ما عرفت كيف أرد بشكل صح 😅\nجرب تسألني بطريقة ثانية`,
            `${moodPrefix}حكيك وصلني ${name}!\nبس أقدر أساعدك أكثر إذا سألتني بوضوح 😊`,
          ]);
        }
      }
      return randomFrom([
        `${moodPrefix}مرحبا ${name}! شو بتقصد بالضبط؟ 🤔`,
        `${moodPrefix}وصلني حكيك ${name}! بس بحتاج أكثر وضوح 😊`,
        `${moodPrefix}أنا ${BOT_NAME} ${name}، قولي كيف أقدر أساعدك؟ 💙`,
      ]);
  }
}

// ===== الكلمات السيئة =====
const BAD_WORDS = [
  'كلب', 'حمار', 'غبي', 'احمق', 'معرص', 'ابن الحرام',
  'يلعن', 'عرص', 'شرموط', 'قحبة', 'زبالة', 'خنزير',
  'تبان', 'منيوك', 'زاني', 'فاسق', 'لقيط', 'عاهرة', 'ديوث'
];

function hasBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => lower.includes(word));
}

// ===================================================
//              🚀 تشغيل البوت
// ===================================================

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
      console.log(`✅ ${BOT_NAME} متصل بعقله الداخلي جاهز!`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const sender = msg.key.remoteJid;
      const isGroup = sender.endsWith('@g.us');
      const senderUser = msg.key.participant || msg.key.remoteJid;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;
      const body = text.trim();
      console.log(`📩 ${senderUser}: ${body}`);

      // ===== فلتر الكلام السيء =====
      if (isGroup && hasBadWord(body)) {
        try {
          await sock.sendMessage(sender, { delete: msg.key });
          await sock.sendMessage(sender, {
            text: `⚠️ تحذير @${senderUser.split('@')[0]}\nالكلام السيء ممنوع هنا!`,
            mentions: [senderUser]
          });
        } catch (err) {
          console.error('خطأ حذف:', err.message);
        }
        continue;
      }

      // ===== أوامر المشرف =====
      if (isGroup && body.startsWith('!')) {
        try {
          const groupMeta = await sock.groupMetadata(sender);
          const isAdmin = groupMeta.participants.find(p => p.id === senderUser)?.admin != null;

          if (body.startsWith('!طرد')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) { await sock.sendMessage(sender, { text: '⚠️ منشن الشخص: !طرد @شخص' }); continue; }
            await sock.groupParticipantsUpdate(sender, mentioned, 'remove');
            await sock.sendMessage(sender, { text: `✅ تم الطرد` });
            continue;
          }

          if (body.startsWith('!كتم')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) { await sock.sendMessage(sender, { text: '⚠️ منشن الشخص: !كتم @شخص' }); continue; }
            await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
            await sock.sendMessage(sender, { text: `🔇 تم الكتم`, mentions: mentioned });
            continue;
          }

          if (body === '!قفل') {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            await sock.groupSettingUpdate(sender, 'announcement');
            await sock.sendMessage(sender, { text: '🔒 المجموعة مقفلة' });
            continue;
          }

          if (body === '!فتح') {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            await sock.groupSettingUpdate(sender, 'not_announcement');
            await sock.sendMessage(sender, { text: '🔓 المجموعة مفتوحة' });
            continue;
          }

          if (body.startsWith('!منشن')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const members = groupMeta.participants.map(p => p.id);
            const mentionText = body.replace('!منشن', '').trim() || '📢 تنبيه!';
            const mentions = members.map(m => `@${m.split('@')[0]}`).join(' ');
            await sock.sendMessage(sender, { text: `${mentionText}\n\n${mentions}`, mentions: members });
            continue;
          }

          if (body === '!وقت') {
            const now = new Date().toLocaleString('ar-SY', { timeZone: 'Asia/Damascus', hour: '2-digit', minute: '2-digit', hour12: true });
            await sock.sendMessage(sender, { text: `🕐 الوقت: ${now}` });
            continue;
          }

          if (body === '!تاريخ') {
            const today = new Date().toLocaleDateString('ar-SY', { timeZone: 'Asia/Damascus', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            await sock.sendMessage(sender, { text: `📅 ${today}` });
            continue;
          }

          if (body === '!مساعدة' || body === '!help') {
            await sock.sendMessage(sender, {
              text: `🤖 *أوامر ${BOT_NAME}:*\n\n!طرد @شخص\n!كتم @شخص\n!قفل\n!فتح\n!منشن نص\n!وقت\n!تاريخ\n!مساعدة`
            });
            continue;
          }
        } catch (err) {
          console.error('خطأ أوامر:', err.message);
        }
        continue;
      }

      // ===== العقل الداخلي يفكر ويرد =====
      try {
        await sock.sendPresenceUpdate('composing', sender);
        const reply = think(senderUser, body);
        saveToMemory(senderUser, body, reply);
        await sock.sendMessage(sender, { text: reply });
      } catch (err) {
        console.error('خطأ:', err.message);
      }
    }
  });
}

startBot();
