/**
 * TermuxWeb — محاكي Termux على المتصفح
 * بيئة تطوير كاملة على Render
 */
'use strict';

const http   = require('http');
const { spawn, exec } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const PORT      = process.env.PORT || 3000;
const WORK_DIR  = path.join(__dirname, 'workspace');
const PASS      = process.env.PANEL_PASS || '1234';

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────
const sessions  = new Map(); // id → { proc, logs[], cwd }
const globalLog = [];
let   cmdHistory= [];

function addLog(text, src = 'out', sid = 'global') {
  const line = { ts: Date.now(), src, text: String(text) };
  globalLog.push(line);
  if (globalLog.length > 1000) globalLog.shift();
  if (sid !== 'global' && sessions.has(sid)) {
    const s = sessions.get(sid);
    s.logs.push(line);
    if (s.logs.length > 500) s.logs.shift();
  }
}

// ── Run command ───────────────────────────────────────────────
function runCmd(cmd, sid) {
  const session = {
    id:     sid,
    cmd,
    logs:   [],
    cwd:    WORK_DIR,
    status: 'running',
    start:  Date.now(),
    proc:   null,
  };
  sessions.set(sid, session);
  addLog(`$ ${cmd}`, 'cmd', sid);

  const proc = spawn('bash', ['-c', cmd], {
    cwd: WORK_DIR,
    env: { ...process.env, HOME: WORK_DIR, PATH: process.env.PATH + ':/usr/local/bin' },
  });

  session.proc = proc;

  proc.stdout.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l) addLog(l, 'out', sid); })
  );
  proc.stderr.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l) addLog(l, 'err', sid); })
  );
  proc.on('close', code => {
    session.status = code === 0 ? 'done' : 'error';
    addLog(`[EXIT ${code}]`, code === 0 ? 'sys' : 'err', sid);
  });
  proc.on('error', e => {
    session.status = 'error';
    addLog(`[ERR] ${e.message}`, 'err', sid);
  });
}

function killSession(sid) {
  if (!sessions.has(sid)) return;
  const s = sessions.get(sid);
  if (s.proc) { try { s.proc.kill('SIGTERM'); } catch {} }
  s.status = 'killed';
  addLog('[KILLED]', 'sys', sid);
}

// ── Multipart ─────────────────────────────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=([^\s;]+)/);
  if (!bm) return cb(new Error('no boundary'));
  const boundary = '--' + bm[1];
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf   = Buffer.concat(chunks);
    const files = [];
    let pos = 0;
    while (pos < buf.length) {
      const bs = buf.indexOf(boundary, pos);
      if (bs === -1) break;
      pos = bs + boundary.length;
      if (buf.slice(pos, pos + 2).toString() === '--') break;
      pos += 2;
      const he = buf.indexOf('\r\n\r\n', pos);
      if (he === -1) break;
      const headers = buf.slice(pos, he).toString();
      pos = he + 4;
      const nm = headers.match(/filename="([^"]+)"/);
      if (!nm) { pos++; continue; }
      const nb = buf.indexOf('\r\n' + boundary, pos);
      if (nb === -1) break;
      files.push({ filename: path.basename(nm[1]), data: buf.slice(pos, nb) });
      pos = nb + 2;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch(e) { cb(e); } });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ── HTML ──────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>TermuxWeb — بيئة تطوير سحابية</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0e1a;--surface:#0f1623;--surface2:#151d2e;--border:rgba(34,211,238,.12);--accent:#22d3ee;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--text:#e2e8f0;--muted:#64748b}
html,body{height:100%;overflow:hidden}
body{font-family:'Cairo',sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column}

/* Header */
header{background:rgba(10,14,26,.95);border-bottom:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-shrink:0}
.logo{display:flex;align-items:center;gap:8px}
.logo-icon{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,rgba(34,211,238,.25),rgba(16,185,129,.15));border:1px solid rgba(34,211,238,.35);display:flex;align-items:center;justify-content:center;font-size:17px}
.logo-text{font-size:16px;font-weight:900;color:#fff}
.logo-text span{color:var(--accent)}
.header-actions{display:flex;align-items:center;gap:8px}

/* Layout */
.layout{display:flex;flex:1;overflow:hidden;gap:0}
.sidebar{width:200px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.terminal-area{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* Sidebar */
.sidebar-title{padding:10px 12px;font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.06em;border-bottom:1px solid var(--border)}
.sessions-list{flex:1;overflow-y:auto;padding:6px}
.session-item{padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid transparent;transition:.15s}
.session-item:hover{background:var(--surface2)}
.session-item.active{background:rgba(34,211,238,.08);border-color:rgba(34,211,238,.2)}
.session-name{font-size:11px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-status{font-size:10px;margin-top:2px}
.s-running{color:var(--amber)}
.s-done{color:var(--green)}
.s-error{color:var(--red)}
.s-killed{color:var(--muted)}
.sidebar-actions{padding:8px;border-top:1px solid var(--border)}

/* Terminal */
.term-tabs{display:flex;align-items:center;gap:0;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0}
.term-tab{padding:8px 14px;font-size:11px;font-weight:700;color:var(--muted);cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;transition:.15s}
.term-tab:hover{color:var(--text)}
.term-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.term-output{flex:1;overflow-y:auto;background:#020509;padding:12px 14px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.75}
.term-output .out{color:#cbd5e1}
.term-output .err{color:var(--red)}
.term-output .sys{color:var(--accent)}
.term-output .cmd{color:var(--green);font-weight:600}
.term-output .info{color:var(--amber)}

/* Input bar */
.input-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface);border-top:1px solid var(--border);flex-shrink:0}
.prompt{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--green);font-weight:700;white-space:nowrap}
#cmdInput{flex:1;background:transparent;border:none;outline:none;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text);padding:4px 0}
#cmdInput::placeholder{color:var(--muted)}

/* Buttons */
.btn{padding:7px 14px;border-radius:9px;font-size:12px;font-weight:800;font-family:'Cairo',sans-serif;cursor:pointer;border:1px solid transparent;transition:.15s;white-space:nowrap}
.btn-run{background:rgba(74,222,128,.15);color:var(--green);border-color:rgba(74,222,128,.3)}
.btn-run:hover{background:rgba(74,222,128,.25)}
.btn-stop{background:rgba(248,113,113,.12);color:var(--red);border-color:rgba(248,113,113,.25)}
.btn-stop:hover{background:rgba(248,113,113,.22)}
.btn-clear{background:var(--surface2);color:var(--muted);border-color:var(--border)}
.btn-clear:hover{color:var(--text)}
.btn-upload{background:rgba(34,211,238,.12);color:var(--accent);border-color:rgba(34,211,238,.25)}
.btn-upload:hover{background:rgba(34,211,238,.22)}
.btn-new{width:100%;background:rgba(74,222,128,.1);color:var(--green);border-color:rgba(74,222,128,.2);font-size:11px;padding:6px}

/* Quick cmds */
.quick-bar{display:flex;gap:5px;padding:6px 12px;background:var(--surface2);border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0}
.qbtn{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;border:1px solid var(--border);background:var(--surface);color:var(--muted);transition:.12s;font-family:'JetBrains Mono',monospace}
.qbtn:hover{color:var(--text);border-color:var(--accent)}

/* Upload modal */
#uploadModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);z-index:50;align-items:center;justify-content:center}
#uploadModal.show{display:flex}
.modal-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;width:90%;max-width:420px}
.modal-title{font-size:15px;font-weight:900;color:#fff;margin-bottom:16px}
#dropZone{border:2px dashed var(--border);border-radius:12px;padding:28px;text-align:center;cursor:pointer;transition:.2s;margin-bottom:14px}
#dropZone:hover,#dropZone.over{border-color:var(--accent);background:rgba(34,211,238,.03)}
#dropZone p{color:var(--muted);font-size:12px;margin:5px 0}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}

/* Toast */
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);color:var(--text);padding:9px 20px;border-radius:999px;font-size:12px;font-weight:700;opacity:0;transition:opacity .2s;z-index:999;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1}

/* Scrollbar */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(100,116,139,.35);border-radius:2px}
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">⌨</div>
    <div>
      <div class="logo-text">Termux<span>Web</span></div>
      <div style="font-size:10px;color:var(--muted)">بيئة تطوير سحابية على Render</div>
    </div>
  </div>
  <div class="header-actions">
    <button class="btn btn-upload" onclick="showUpload()">📁 رفع ملف</button>
    <button class="btn btn-clear" onclick="clearTerm()">🗑 تنظيف</button>
  </div>
</header>

<div class="layout">

  <!-- Sidebar: Sessions -->
  <div class="sidebar">
    <div class="sidebar-title">⚡ الجلسات</div>
    <div class="sessions-list" id="sessionsList"></div>
    <div class="sidebar-actions">
      <button class="btn btn-new" onclick="newSession()">+ جلسة جديدة</button>
    </div>
  </div>

  <!-- Terminal -->
  <div class="terminal-area">
    <div class="term-tabs" id="termTabs"></div>

    <div class="quick-bar">
      <span style="font-size:10px;color:var(--muted);white-space:nowrap;align-self:center">سريع:</span>
      <button class="qbtn" data-cmd="ls -la">ls</button>
      <button class="qbtn" data-cmd="pwd">pwd</button>
      <button class="qbtn" data-cmd="node --version">node -v</button>
      <button class="qbtn" data-cmd="npm --version">npm -v</button>
      <button class="qbtn" data-cmd="npm install">npm install</button>
      <button class="qbtn" data-cmd="npm install @whiskeysockets/baileys pino">install baileys</button>
      <button class="qbtn" data-cmd="npm install @google/generative-ai">install gemini</button>
      <button class="qbtn" data-cmd="node index.js">node index.js</button>
      <button class="qbtn" data-cmd="node bot.js">node bot.js</button>
      <button class="qbtn" data-cmd="python3 bot.py">python3 bot.py</button>
      <button class="qbtn" data-cmd="kill">⏹ إيقاف</button>
      <button class="qbtn" data-cmd="cat package.json">cat package</button>
    </div>

    <div class="term-output" id="termOutput">
      <div class="info">مرحباً بك في TermuxWeb ⚡</div>
      <div class="info">اكتب أي أمر أو استخدم الأزرار السريعة بالأعلى</div>
      <div class="sys">─────────────────────────────────</div>
    </div>

    <div class="input-bar">
      <span class="prompt">workspace $</span>
      <input id="cmdInput" type="text" dir="ltr" autocomplete="off" placeholder="npm install / node bot.js / ls -la ..."/>
      <button class="btn btn-run" id="runBtn" onclick="runCmd()">▶ تشغيل</button>
      <button class="btn btn-stop" onclick="stopCurrent()">⏹</button>
    </div>
  </div>
</div>

<!-- Upload Modal -->
<div id="uploadModal">
  <div class="modal-box">
    <div class="modal-title">📁 رفع ملف للـ workspace</div>
    <div id="dropZone">
      <div style="font-size:28px">⬆️</div>
      <p>اسحب الملف هنا أو</p>
      <label style="display:inline-block;margin-top:8px;padding:7px 18px;border-radius:9px;background:rgba(34,211,238,.15);color:var(--accent);border:1px solid rgba(34,211,238,.3);font-size:12px;font-weight:700;cursor:pointer">
        اختر ملف
        <input type="file" id="fileInput" multiple hidden/>
      </label>
      <p style="font-size:10px;margin-top:6px">أي نوع ملف مدعوم</p>
    </div>
    <div id="uploadStatus" style="font-size:12px;color:var(--muted);margin-bottom:10px"></div>
    <div class="modal-actions">
      <button class="btn btn-clear" onclick="hideUpload()">إغلاق</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
'use strict';

const S = {
  sessions:   {},
  currentSid: null,
  logSince:   0,
  history:    [],
  histIdx:    -1,
  pollTimer:  null,
};

const $ = id => document.getElementById(id);

// Toast
let toastT;
function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.style.color       = ok ? '#4ade80' : '#f87171';
  t.style.borderColor = ok ? 'rgba(74,222,128,.35)' : 'rgba(248,113,113,.35)';
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── API ───────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return r.json();
}

// ── Sessions ──────────────────────────────────────────────────
let sidCounter = 1;

function newSession() {
  const sid = 'sess_' + (sidCounter++);
  S.sessions[sid] = { logs: [], status: 'idle', cmd: 'جلسة ' + sidCounter };
  S.currentSid = sid;
  renderSidebar();
  renderTabs();
  clearTermOutput();
  appendLine('جلسة جديدة — اكتب أي أمر', 'info');
}

function switchSession(sid) {
  S.currentSid = sid;
  renderSidebar();
  renderTabs();
  clearTermOutput();
  const sess = S.sessions[sid];
  if (sess && sess.logs) sess.logs.forEach(l => appendLine(l.text, l.src));
}

function renderSidebar() {
  const el = $('sessionsList');
  el.innerHTML = Object.entries(S.sessions).map(([sid, s]) => \`
    <div class="session-item \${sid === S.currentSid ? 'active' : ''}" onclick="switchSession('\${sid}')">
      <div class="session-name">\${escHtml(s.cmd || sid)}</div>
      <div class="session-status s-\${s.status || 'idle'}">\${statusLabel(s.status)}</div>
    </div>
  \`).join('') || '<div style="font-size:11px;color:var(--muted);padding:8px">لا توجد جلسات</div>';
}

function renderTabs() {
  $('termTabs').innerHTML = Object.entries(S.sessions).map(([sid, s]) => \`
    <div class="term-tab \${sid === S.currentSid ? 'active' : ''}" onclick="switchSession('\${sid}')">\${escHtml(s.cmd?.slice(0,20) || sid)}</div>
  \`).join('');
}

function statusLabel(s) {
  return { running:'يعمل…', done:'انتهى ✓', error:'خطأ ✗', killed:'أُوقف', idle:'جاهز' }[s] || s || '';
}

// ── Terminal output ───────────────────────────────────────────
function clearTermOutput() { $('termOutput').innerHTML = ''; }
function clearTerm() { clearTermOutput(); appendLine('تم التنظيف', 'info'); }

function appendLine(text, src = 'out') {
  const el   = $('termOutput');
  const line = document.createElement('div');
  line.className  = src;
  line.textContent = text;
  el.appendChild(line);
  while (el.children.length > 800) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ── Run command ───────────────────────────────────────────────
async function runCmd() {
  const input = $('cmdInput');
  const cmd   = input.value.trim();
  if (!cmd) return;

  S.history.unshift(cmd);
  if (S.history.length > 50) S.history.pop();
  S.histIdx = -1;
  input.value = '';

  if (!S.currentSid) newSession();

  // kill shortcut
  if (cmd === 'kill' || cmd === 'stop') { stopCurrent(); return; }
  if (cmd === 'clear' || cmd === 'cls') { clearTerm(); return; }
  if (cmd === 'ls files') { listFiles(); return; }

  appendLine('$ ' + cmd, 'cmd');

  try {
    const d = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({ cmd, sid: S.currentSid }),
    });
    if (!d.ok) appendLine('[ERR] ' + d.error, 'err');
    else {
      if (S.sessions[S.currentSid]) {
        S.sessions[S.currentSid].cmd    = cmd;
        S.sessions[S.currentSid].status = 'running';
      }
      renderSidebar(); renderTabs();
    }
  } catch (e) { appendLine('[ERR] ' + e.message, 'err'); }
}

async function stopCurrent() {
  if (!S.currentSid) return;
  await api('/api/kill', { method: 'POST', body: JSON.stringify({ sid: S.currentSid }) });
  appendLine('[STOPPED]', 'sys');
  toast('تم الإيقاف');
}

async function listFiles() {
  const d = await api('/api/files');
  if (d.ok) {
    appendLine('── الملفات في workspace ──', 'sys');
    (d.files || []).forEach(f => appendLine(f, 'out'));
  }
}

// ── Poll logs ─────────────────────────────────────────────────
async function poll() {
  if (!S.currentSid) return;
  try {
    const r = await fetch(\`/api/logs/\${S.currentSid}?since=\${S.logSince}\`);
    const d = await r.json();
    if (d.logs && d.logs.length) {
      d.logs.forEach(l => appendLine(l.text, l.src));
      S.logSince = d.logs.at(-1).ts;
    }
    if (d.status && S.sessions[S.currentSid]) {
      S.sessions[S.currentSid].status = d.status;
      renderSidebar(); renderTabs();
    }
  } catch {}
}

// ── Upload ────────────────────────────────────────────────────
function showUpload() { $('uploadModal').classList.add('show'); }
function hideUpload() { $('uploadModal').classList.remove('show'); }

async function uploadFiles(files) {
  if (!files.length) return;
  $('uploadStatus').textContent = 'جاري الرفع…';
  const form = new FormData();
  for (const f of files) form.append('files', f);
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: form });
    const d = await r.json();
    if (d.ok) {
      $('uploadStatus').textContent = '✓ تم رفع: ' + d.uploaded.join(', ');
      toast('تم رفع الملفات ✓');
      appendLine('تم رفع: ' + d.uploaded.join(', '), 'sys');
    } else {
      $('uploadStatus').textContent = 'خطأ: ' + d.error;
      toast(d.error, false);
    }
  } catch { toast('فشل الرفع', false); }
}

$('fileInput').addEventListener('change', () => { uploadFiles([...$('fileInput').files]); $('fileInput').value = ''; });
const dz = $('dropZone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });

// ── Keyboard shortcuts ────────────────────────────────────────
$('cmdInput').addEventListener('keydown', e => {
  if (e.key === 'Enter')     { runCmd(); return; }
  if (e.key === 'ArrowUp')   { S.histIdx = Math.min(S.histIdx + 1, S.history.length - 1); $('cmdInput').value = S.history[S.histIdx] || ''; }
  if (e.key === 'ArrowDown') { S.histIdx = Math.max(S.histIdx - 1, -1); $('cmdInput').value = S.histIdx >= 0 ? S.history[S.histIdx] : ''; }
});

document.querySelectorAll('.qbtn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.cmd === 'kill') { stopCurrent(); return; }
  $('cmdInput').value = b.dataset.cmd;
  $('cmdInput').focus();
}));

function escHtml(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ── Init ──────────────────────────────────────────────────────
newSession();
S.pollTimer = setInterval(poll, 1200);
</script>
</body>
</html>`;

// ── Multipart ─────────────────────────────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=([^\s;]+)/);
  if (!bm) return cb(new Error('no boundary'));
  const boundary = '--' + bm[1];
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const files = [];
    let pos = 0;
    while (pos < buf.length) {
      const bs = buf.indexOf(boundary, pos);
      if (bs === -1) break;
      pos = bs + boundary.length;
      if (buf.slice(pos, pos + 2).toString() === '--') break;
      pos += 2;
      const he = buf.indexOf('\r\n\r\n', pos);
      if (he === -1) break;
      const headers = buf.slice(pos, he).toString();
      pos = he + 4;
      const nm = headers.match(/filename="([^"]+)"/);
      if (!nm) { pos++; continue; }
      const nb = buf.indexOf('\r\n' + boundary, pos);
      if (nb === -1) break;
      files.push({ filename: path.basename(nm[1]), data: buf.slice(pos, nb) });
      pos = nb + 2;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch(e) { cb(e); } });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url    = req.url.split('?')[0];
  const method = req.method;
  const qs     = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  // Run command
  if (method === 'POST' && url === '/api/run') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON error' });
      const { cmd, sid } = body;
      if (!cmd) return json(res, 400, { ok: false, error: 'no command' });
      runCmd(cmd, sid || 'default');
      json(res, 200, { ok: true });
    });
    return;
  }

  // Kill session
  if (method === 'POST' && url === '/api/kill') {
    readBody(req, (err, body) => {
      killSession(body?.sid || 'default');
      json(res, 200, { ok: true });
    });
    return;
  }

  // Logs
  if (method === 'GET' && url.startsWith('/api/logs/')) {
    const sid   = url.replace('/api/logs/', '');
    const since = parseInt(qs.get('since') || '0', 10);
    const sess  = sessions.get(sid);
    if (!sess) return json(res, 200, { ok: true, logs: [], status: 'idle' });
    json(res, 200, {
      ok:     true,
      logs:   sess.logs.filter(l => l.ts > since),
      status: sess.status,
    });
    return;
  }

  // Upload
  if (method === 'POST' && url === '/api/upload') {
    parseMultipart(req, (err, files) => {
      if (err || !files.length) return json(res, 400, { ok: false, error: 'no files' });
      const saved = [];
      for (const f of files) {
        fs.writeFileSync(path.join(WORK_DIR, f.filename), f.data);
        saved.push(f.filename);
        addLog(`[UPLOAD] ${f.filename}`, 'sys', 'global');
      }
      json(res, 200, { ok: true, uploaded: saved });
    });
    return;
  }

  // List files
  if (method === 'GET' && url === '/api/files') {
    const files = fs.readdirSync(WORK_DIR)
      .filter(f => !fs.statSync(path.join(WORK_DIR, f)).isDirectory());
    return json(res, 200, { ok: true, files });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('[TermuxWeb] يعمل على المنفذ ' + PORT);
});
