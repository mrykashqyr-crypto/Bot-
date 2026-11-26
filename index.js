/**
 * أميرتي AutoBot — index.js
 * يثبّت البوت تلقائياً ويشغّله بدون أي أوامر
 */
'use strict';

const http   = require('http');
const { spawn, execSync } = require('child_process');
const fs     = require('fs');
const path   = require('path');

const PORT     = process.env.PORT || 3000;
const WORK_DIR = path.join(__dirname, 'workspace');

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────
const state = {
  phase:       'idle',   // idle | installing | starting | pairing | online | error
  pairingCode: null,
  pairingExp:  null,
  logs:        [],
  geminiKey:   process.env.GEMINI_API_KEY || '',
  phone:       (process.env.BOT_PHONE     || '').replace(/\D/g, ''),
  botName:     process.env.BOT_NAME       || 'أميرتي',
};

let botProc    = null;
let pairDone   = false;
let logSinceTs = 0;

function addLog(text, src = 'out') {
  const line = { ts: Date.now(), src, text: String(text).trim() };
  if (!line.text) return;
  state.logs.push(line);
  if (state.logs.length > 600) state.logs.shift();
  process.stdout.write(line.text + '\n');

  // استخراج كود الربط تلقائياً
  const m = line.text.match(/PAIRING CODE[:\s]+([A-Z0-9\-]{6,12})/i);
  if (m) {
    state.pairingCode = m[1];
    state.pairingExp  = Date.now() + 60000;
    state.phase       = 'pairing';
  }
  if (line.text.includes('[OK]') && line.text.includes('متصل')) {
    state.phase       = 'online';
    state.pairingCode = null;
  }
}

// ── كتابة ملف البوت تلقائياً ─────────────────────────────────
function writeBotFile() {
  const botCode = `
'use strict';
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const fs   = require('fs');

const GEMINI_KEY = '${state.geminiKey}';
const BOT_PHONE  = '${state.phone}';
const BOT_NAME   = '${state.botName}';
const AUTH_DIR   = './auth_info';

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: 'أنت ' + BOT_NAME + '، مساعدة ذكية على واتساب. ردودك قصيرة ومفيدة.',
  generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
});

const chats    = new Map();
const processed = new Set();
let sock, pairDone = false;

async function start() {
  try {
    if (sock) { try { sock.end(); } catch {} sock = null; }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let ver = [2,3000,1015901307];
    try { ver = (await fetchLatestBaileysVersion()).version; } catch {}
    sock = makeWASocket({
      version: ver, auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu','Chrome','22.04.4'],
      connectTimeoutMs: 90000,
      keepAliveIntervalMs: 30000,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (!state.creds.registered && connection === 'connecting' && !pairDone) {
        pairDone = true;
        try {
          await new Promise(r => setTimeout(r, 3500));
          const code = await sock.requestPairingCode(BOT_PHONE);
          console.log('=================================');
          console.log('PAIRING CODE: ' + code);
          console.log('=================================');
        } catch(e) { console.log('[ERR] ' + e.message); pairDone = false; }
      }
      if (connection === 'open') { pairDone = false; console.log('[OK] ' + BOT_NAME + ' متصل ⚡'); }
      if (connection === 'close') {
        pairDone = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(start, 5000);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg?.message || processed.has(msg.key?.id) || msg.key.fromMe) continue;
          processed.add(msg.key?.id);
          if (processed.size > 300) processed.delete(processed.values().next().value);
          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast') continue;
          const isGroup = jid.endsWith('@g.us');
          const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          if (!body.trim() || (isGroup && !body.includes(BOT_NAME))) continue;
          const name = msg.pushName || 'صديقي';
          if (body.replace(BOT_NAME,'').trim() === 'انسى') {
            chats.delete(jid);
            await sock.sendMessage(jid, { text: '🧠 تم! نبدأ من جديد.' }, { quoted: msg });
            continue;
          }
          if (!chats.has(jid)) chats.set(jid, model.startChat({ history: [] }));
          const reply = (await chats.get(jid).sendMessage(name + ': ' + body)).response.text().trim();
          if (reply) await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        } catch(e) { console.log('[ERR] ' + e.message); }
      }
    });
  } catch(e) {
    console.log('[ERR] ' + e.message);
    setTimeout(start, 8000);
  }
}
start();
`.trim();

  fs.writeFileSync(path.join(WORK_DIR, 'bot.js'), botCode);
  fs.writeFileSync(path.join(WORK_DIR, 'package.json'), JSON.stringify({
    name: 'amirati-bot',
    version: '1.0.0',
    main: 'bot.js',
    dependencies: {
      '@whiskeysockets/baileys': '^6.7.0',
      '@google/generative-ai':  '^0.21.0',
      'pino': '^9.0.0',
    },
  }, null, 2));
}

// ── تثبيت وتشغيل تلقائي ──────────────────────────────────────
function installAndStart() {
  if (!state.geminiKey || !state.phone) {
    state.phase = 'error';
    addLog('[ERR] أدخل مفتاح Gemini ورقم الواتساب أولاً', 'err');
    return;
  }

  state.phase = 'installing';
  pairDone    = false;
  writeBotFile();
  addLog('[AUTO] جاري تثبيت المكتبات…', 'sys');

  const install = spawn('npm', ['install'], {
    cwd: WORK_DIR,
    env: { ...process.env, HOME: WORK_DIR },
  });

  install.stdout.on('data', d => addLog(d.toString().trim(), 'out'));
  install.stderr.on('data', d => {
    const t = d.toString().trim();
    if (t && !t.startsWith('npm warn')) addLog(t, 'err');
  });

  install.on('close', code => {
    if (code !== 0) {
      state.phase = 'error';
      addLog('[ERR] فشل التثبيت', 'err');
      return;
    }
    addLog('[AUTO] تم التثبيت — جاري تشغيل البوت…', 'sys');
    startBotProc();
  });
}

function startBotProc() {
  if (botProc) { try { botProc.kill('SIGTERM'); } catch {} botProc = null; }
  state.phase = 'starting';
  pairDone    = false;

  botProc = spawn('node', ['bot.js'], {
    cwd: WORK_DIR,
    env: { ...process.env, HOME: WORK_DIR },
  });

  botProc.stdout.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l.trim()) addLog(l, 'out'); })
  );
  botProc.stderr.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l.trim()) addLog(l, 'err'); })
  );
  botProc.on('close', code => {
    addLog(`[EXIT ${code}]`, code === 0 ? 'sys' : 'err');
    if (state.phase !== 'idle') {
      state.phase = 'starting';
      setTimeout(startBotProc, 6000);
    }
  });
}

function stopBot() {
  if (botProc) { try { botProc.kill('SIGTERM'); } catch {} botProc = null; }
  state.phase       = 'idle';
  state.pairingCode = null;
  pairDone          = false;
  // حذف الجلسة
  const auth = path.join(WORK_DIR, 'auth_info');
  fs.rmSync(auth, { recursive: true, force: true });
  addLog('[PANEL] تم الإيقاف وحذف الجلسة', 'sys');
}

// ── HTML ──────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>أميرتي — تشغيل تلقائي</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060a13;--surface:#0c1322;--surface2:#111b30;--border:rgba(34,211,238,.15);--accent:#22d3ee;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--text:#e2e8f0;--muted:#64748b}
body{font-family:'Cairo',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;
background-image:radial-gradient(circle at 15% 10%,rgba(34,211,238,.1),transparent 40%),radial-gradient(circle at 85% 15%,rgba(16,185,129,.08),transparent 35%)}
header{background:rgba(6,10,19,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,rgba(34,211,238,.2),rgba(16,185,129,.15));border:1px solid rgba(34,211,238,.3);display:flex;align-items:center;justify-content:center;font-size:20px}
.logo-text{font-size:18px;font-weight:900;color:#fff}.logo-text span{color:var(--accent)}
#statusPill{padding:6px 16px;border-radius:999px;font-size:12px;font-weight:800;display:flex;align-items:center;gap:7px;border:1px solid var(--border);background:var(--surface)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
main{max-width:700px;margin:0 auto;padding:28px 16px 60px;display:flex;flex-direction:column;gap:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:22px}
.card-title{font-size:14px;font-weight:900;color:#fff;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.card-title::before{content:'';width:3px;height:16px;background:var(--accent);border-radius:2px}

/* Pairing */
#pairCard{display:none;background:linear-gradient(135deg,rgba(16,185,129,.12),rgba(34,211,238,.08));border-color:rgba(74,222,128,.45);text-align:center;padding:32px 20px}
#pairCard.show{display:block}
.pair-label{font-size:12px;font-weight:900;color:var(--green);letter-spacing:.06em;margin-bottom:14px}
.pair-code{font-family:'JetBrains Mono',monospace;font-size:clamp(32px,9vw,58px);font-weight:700;color:#fff;letter-spacing:.2em;background:rgba(0,0,0,.45);border:2px solid rgba(74,222,128,.45);border-radius:16px;padding:18px 28px;display:inline-block;text-shadow:0 0 40px rgba(74,222,128,.5);margin:8px 0}
.pair-steps{font-size:12px;color:rgba(226,232,240,.75);line-height:2;margin-top:12px}
.pair-steps b{color:var(--accent)}
#pairTimer{font-size:13px;font-weight:800;color:var(--amber);margin-top:10px}

/* Form */
.field{margin-bottom:14px}
label{display:block;font-size:11px;font-weight:800;color:var(--muted);margin-bottom:5px}
input{width:100%;padding:11px 14px;border-radius:11px;background:rgba(0,0,0,.35);border:1px solid var(--border);color:var(--text);font-size:13px;font-family:'Cairo',sans-serif;outline:none;transition:.15s}
input:focus{border-color:var(--accent)}
input[dir=ltr]{text-align:left;font-family:'JetBrains Mono',monospace}

/* Buttons */
#startBtn{width:100%;padding:14px;border-radius:13px;font-size:15px;font-weight:900;font-family:'Cairo',sans-serif;cursor:pointer;border:none;background:linear-gradient(135deg,var(--accent),#10b981);color:#000;transition:.15s;margin-top:4px}
#startBtn:hover{opacity:.88}
#startBtn:disabled{opacity:.45;cursor:not-allowed}
.btn-sm{padding:8px 16px;border-radius:10px;font-size:12px;font-weight:800;font-family:'Cairo',sans-serif;cursor:pointer;border:1px solid transparent;transition:.15s}
.btn-stop{background:rgba(248,113,113,.12);color:var(--red);border-color:rgba(248,113,113,.3)}
.btn-stop:hover{background:rgba(248,113,113,.22)}
.btn-reset{background:var(--surface2);color:var(--muted);border-color:var(--border)}
.btn-reset:hover{color:var(--red)}

/* Log */
#logBox{height:260px;overflow-y:auto;background:#020509;border-radius:12px;padding:12px 14px;font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.75}
#logBox .out{color:#cbd5e1}#logBox .err{color:var(--red)}#logBox .sys{color:var(--accent)}

/* Toast */
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);color:var(--text);padding:9px 22px;border-radius:999px;font-size:12px;font-weight:800;opacity:0;transition:opacity .2s;z-index:999;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(100,116,139,.3);border-radius:2px}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">🤖</div>
    <div>
      <div class="logo-text">أميرتي <span>AutoBot</span></div>
      <div style="font-size:10px;color:var(--muted)">تشغيل تلقائي بدون أوامر</div>
    </div>
  </div>
  <div id="statusPill"><span class="dot" id="sDot"></span><span id="sTxt">جاري…</span></div>
</header>

<main>

  <!-- كود الربط -->
  <div class="card" id="pairCard">
    <div class="pair-label">🔑 كود ربط واتساب — أدخله الآن</div>
    <div class="pair-code" id="pairCode">--------</div>
    <div class="pair-steps">
      افتح <b>واتساب</b> ← النقاط ⋮ ← <b>الأجهزة المرتبطة</b> ← <b>ربط جهاز</b> ← <b>ربط برقم الهاتف</b> ← أدخل الكود
    </div>
    <div id="pairTimer">⏱ ينتهي خلال <span id="pairSec">60</span> ثانية</div>
  </div>

  <!-- إعدادات -->
  <div class="card">
    <div class="card-title">الإعدادات</div>
    <div class="field">
      <label>🔑 مفتاح Gemini API</label>
      <input id="geminiKey" type="password" dir="ltr" placeholder="AIzaSy..."/>
    </div>
    <div class="field">
      <label>📱 رقم الواتساب (مع رمز الدولة، بدون +)</label>
      <input id="botPhone" type="text" dir="ltr" placeholder="963958414394"/>
    </div>
    <div class="field">
      <label>🤖 اسم البوت في الجروبات</label>
      <input id="botName" type="text" placeholder="أميرتي" value="أميرتي"/>
    </div>
    <button id="startBtn" onclick="startBot()">🚀 تثبيت وتشغيل تلقائي</button>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn-sm btn-stop"  onclick="stopBot()">⏹ إيقاف</button>
      <button class="btn-sm btn-reset" onclick="resetSession()">🗑 حذف الجلسة وإعادة الربط</button>
    </div>
  </div>

  <!-- لوج -->
  <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div class="card-title" style="margin-bottom:0">📋 السجل الحي</div>
      <button onclick="document.getElementById('logBox').innerHTML=''" style="font-size:11px;padding:5px 12px;border-radius:8px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);cursor:pointer">تنظيف</button>
    </div>
    <div id="logBox"></div>
  </div>

</main>
<div id="toast"></div>

<script>
'use strict';
const S = { logSince: 0, pairTimer: null };
const $ = id => document.getElementById(id);
let toastT;
function toast(msg, ok=true){const t=$('toast');t.textContent=msg;t.style.color=ok?'#4ade80':'#f87171';t.style.borderColor=ok?'rgba(74,222,128,.35)':'rgba(248,113,113,.35)';t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),3000)}
const meta={idle:{t:'جاهز',d:'#64748b'},installing:{t:'يثبّت…',d:'#fbbf24'},starting:{t:'يبدأ…',d:'#fbbf24'},pairing:{t:'انتظار الربط',d:'#4ade80'},online:{t:'متصل ⚡',d:'#4ade80'},error:{t:'خطأ',d:'#f87171'}};
function syncState(d){
  const m=meta[d.phase]||meta.idle;
  $('sTxt').textContent=m.t; $('sDot').style.background=m.d;
  const pc=$('pairCard');
  if(d.phase==='pairing'&&d.pairingCode){pc.classList.add('show');$('pairCode').textContent=d.pairingCode;startTimer(d.pairingExp)}
  else{pc.classList.remove('show');clearInterval(S.pairTimer)}
  if(d.logs&&d.logs.length){d.logs.forEach(l=>appendLog(l.text,l.src));S.logSince=d.logs.at(-1).ts}
}
function startTimer(exp){clearInterval(S.pairTimer);S.pairTimer=setInterval(()=>{const l=Math.max(0,Math.round((exp-Date.now())/1000));$('pairSec').textContent=l;if(l===0)clearInterval(S.pairTimer)},1000)}
function appendLog(text,src){const el=$('logBox');const d=document.createElement('div');d.className=src;d.textContent=text;el.appendChild(d);while(el.children.length>500)el.removeChild(el.firstChild);el.scrollTop=el.scrollHeight}
async function poll(){try{const r=await fetch('/api/state?since='+S.logSince);const d=await r.json();syncState(d)}catch{}}
async function startBot(){
  const key=$('geminiKey').value.trim();
  const phone=$('botPhone').value.trim().replace(/\\D/g,'');
  const name=$('botName').value.trim()||'أميرتي';
  if(!key){toast('أدخل مفتاح Gemini',false);return}
  if(!phone){toast('أدخل رقم الواتساب',false);return}
  $('startBtn').disabled=true;
  try{
    const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,phone,name})});
    const d=await r.json();
    if(d.ok)toast('جاري التثبيت والتشغيل تلقائياً…');
    else{toast(d.error||'خطأ',false);$('startBtn').disabled=false}
  }catch{toast('فشل الاتصال',false);$('startBtn').disabled=false}
}
async function stopBot(){await fetch('/api/stop',{method:'POST'});toast('تم الإيقاف');$('startBtn').disabled=false}
async function resetSession(){await fetch('/api/reset',{method:'POST'});toast('تم حذف الجلسة — سيطلب كود جديد');$('startBtn').disabled=false}
poll();setInterval(poll,2500);
</script>
</body>
</html>`;

// ── HTTP ──────────────────────────────────────────────────────
function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b||'{}')); } catch(e) { cb(e); } });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url    = req.url.split('?')[0];
  const method = req.method;
  const qs     = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (method === 'GET' && url === '/api/state') {
    const since = parseInt(qs.get('since') || '0', 10);
    return json(res, 200, {
      phase:       state.phase,
      pairingCode: state.pairingCode,
      pairingExp:  state.pairingExp,
      logs:        state.logs.filter(l => l.ts > since),
    });
  }

  if (method === 'POST' && url === '/api/start') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON error' });
      if (!body.key)   return json(res, 400, { ok: false, error: 'مفتاح Gemini مطلوب' });
      if (!body.phone) return json(res, 400, { ok: false, error: 'رقم الواتساب مطلوب' });
      state.geminiKey = body.key;
      state.phone     = body.phone.replace(/\D/g, '');
      state.botName   = body.name || 'أميرتي';
      installAndStart();
      json(res, 200, { ok: true });
    });
    return;
  }

  if (method === 'POST' && url === '/api/stop') {
    stopBot();
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/reset') {
    stopBot();
    setTimeout(installAndStart, 2000);
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('[SERVER] أميرتي AutoBot جاهز على المنفذ ' + PORT);
  // تشغيل تلقائي إذا في متغيرات
  if (state.geminiKey && state.phone) installAndStart();
});
             
