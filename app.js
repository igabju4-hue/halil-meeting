// 할일먼저 — 화면·녹음·공유 담당. 할 일 뽑기와 보낼 글 만들기는 Rust(core.wasm)가 한다.
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_REQUEST = '이 회의 내용에서 할 일을 담당·기한과 함께 짧게 뽑고, 결정·막힌 점과 오늘 먼저 할 일을 짚어 줘.';
const LS = { draft: 'hm.draft', hist: 'hm.history', bot: 'hm.bot', req: 'hm.request.v2',
  token: 'hm.token', chat: 'hm.chat', auto: 'hm.auto', refine: 'hm.refine' };
const TAG = '#할일먼저'; // PC 봇이 이 표시가 붙은 고정(핀) 메시지만 처리한다

// ---------- 텔레그램 봇 직접 호출 (토큰은 이 아이폰 저장소에만) ----------
const tgReady = () => !!($('token').value.trim() && $('chatId').value.trim());
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${$('token').value.trim()}/${method}`;
  const opt = body instanceof FormData ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.description || '텔레그램 오류');
  return j.result;
}
function caption(kind, extra = {}) {
  const lines = [`${TAG} ${kind}`, `제목: ${$('title').value.trim() || '회의'}`, `날짜: ${$('date').value || today()}`];
  for (const [k, v] of Object.entries(extra)) if (v) lines.push(`${k}: ${v}`);
  const req = $('request').value.trim();
  if (req) lines.push(`부탁: ${req}`);
  return lines.join('\n').slice(0, 1000);
}
/// 파일을 봇 대화방에 올리고 고정(핀)한다 → PC 봇이 고정된 것을 찾아 처리하고 고정을 푼다.
async function uploadAndPin(blob, filename, cap) {
  const fd = new FormData();
  fd.append('chat_id', $('chatId').value.trim());
  fd.append('document', blob, filename);
  fd.append('caption', cap);
  fd.append('disable_notification', 'true');
  const m = await tg('sendDocument', fd);
  await tg('pinChatMessage', { chat_id: $('chatId').value.trim(), message_id: m.message_id, disable_notification: true });
  return m;
}
function updateLinkState() { $('linkState').textContent = tgReady() ? '· 연결됨' : '· 연결 안 됨'; }

// ---------- 녹음 보관(IndexedDB): 못 보낸 녹음을 잃지 않게 ----------
function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open('halil', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((ok, no) => {
    const tx = db.transaction('pending', mode); const st = tx.objectStore('pending');
    const req = fn(st); tx.oncomplete = () => ok(req && req.result); tx.onerror = () => no(tx.error);
  });
}
const pendingPut = (v) => idbDo('readwrite', (s) => s.put(v, 'last'));
const pendingGet = () => idbDo('readonly', (s) => s.get('last'));
const pendingDel = () => idbDo('readwrite', (s) => s.delete('last'));

// ---------- ① 녹음만 하기 ----------
let mr = null, recChunks = [], recStream = null, recT0 = 0, recTimer = null, wake = null;
function pickMime() {
  const c = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function startAudio() {
  if (!tgReady()) { toast('먼저 설정에서 봇 토큰과 대화방 번호를 넣어 주세요.', 3500); $('settings').open = true; return; }
  if (listening) stopListening();
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { toast('마이크를 쓸 수 없어요: ' + e.message, 4000); return; }
  const mime = pickMime();
  // 40kbps: 말소리에 충분하고, 봇 한도 20MB 안에 약 60분까지 들어간다
  mr = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 40000 } : undefined);
  recChunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mr.onstop = finishAudio;
  mr.start(1000);
  recT0 = Date.now();
  try { wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  $('audioBtn').textContent = '⏹ 녹음 끝내고 PC로 보내기'; $('audioBtn').classList.add('on');
  $('audioStatus').textContent = '녹음 중… 화면을 켜 둔 채로 두세요(꺼지면 녹음이 멈춰요).';
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recT0) / 1000);
    $('audioTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function stopAudio() { if (mr && mr.state !== 'inactive') mr.stop(); }
async function finishAudio() {
  clearInterval(recTimer);
  try { recStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { wake && wake.release(); } catch (_) {}
  $('audioBtn').textContent = '🔴 녹음 시작'; $('audioBtn').classList.remove('on');
  const type = (mr && mr.mimeType) || 'audio/mp4';
  const blob = new Blob(recChunks, { type });
  const ext = type.includes('webm') ? 'webm' : 'm4a';
  const secs = Math.round((Date.now() - recT0) / 1000);
  const item = { blob, name: `회의_${$('date').value || today()}_${Date.now()}.${ext}`,
    cap: caption('audio', { '화자 수': $('speakers').value.trim(), '길이(초)': String(secs) }), secs };
  try { await pendingPut(item); } catch (_) {}
  await sendAudio(item);
}
async function sendAudio(item) {
  const mb = (item.blob.size / 1048576).toFixed(1);
  if (item.blob.size > 19.5 * 1048576) {
    $('audioStatus').textContent = `녹음이 ${mb}MB라 너무 커요(봇은 20MB까지). 회의를 나눠 녹음해 주세요.`;
    return;
  }
  $('audioStatus').textContent = `PC로 보내는 중… (${mb}MB)`;
  try {
    await uploadAndPin(item.blob, item.name, item.cap);
    await pendingDel().catch(() => {});
    $('retryBtn').classList.add('hidden');
    $('audioStatus').textContent = `보냈어요 (${mb}MB). PC가 전사·화자 구분 후 텔레그램으로 할 일을 보내 드려요. 녹음 1분에 1~2분쯤 걸려요.`;
    toast('녹음을 PC로 보냈어요.');
  } catch (e) {
    $('audioStatus').textContent = '보내기 실패: ' + e.message + ' — 녹음은 이 아이폰에 보관했어요.';
    $('retryBtn').classList.remove('hidden');
  }
}

// ---------- ② 할 일 목록 자동 보내기 ----------
async function autoSend() {
  if (!tgReady()) return false;
  const list = callCore('format_message', {
    title: $('title').value, date: $('date').value,
    todos: readList('todos'), decisions: readList('decisions'), blockers: readList('blockers'), request: '',
  });
  await tg('sendMessage', { chat_id: $('chatId').value.trim(), text: list.replace('[회의 할 일]', '[할일먼저 · 아이폰 정리]') });
  if ($('refine').checked && $('text').value.trim()) {
    const blob = new Blob([$('text').value.trim()], { type: 'text/plain' });
    await uploadAndPin(blob, `회의내용_${$('date').value || today()}.txt`, caption('text'));
    return 'refine';
  }
  return true;
}

// ---------- Rust(WebAssembly) 연결 ----------
let core = null;
async function loadCore() {
  const buf = await (await fetch('core.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, {});
  core = instance.exports;
}
function callCore(fn, obj) {
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const p = core.alloc(enc.length);
  new Uint8Array(core.memory.buffer, p, enc.length).set(enc);
  const out = core[fn](p, enc.length);
  const len = core.out_len();
  const text = new TextDecoder().decode(new Uint8Array(core.memory.buffer, out, len).slice());
  core.dealloc(p, enc.length);
  return text;
}

// ---------- 작은 도구 ----------
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function today() {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function saveDraft() {
  localStorage.setItem(LS.draft, JSON.stringify({ title: $('title').value, date: $('date').value, text: $('text').value }));
}

// ---------- 음성 인식(사파리 Web Speech) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false, startedAt = 0, timer = null;

function setupSpeech() {
  if (!SR) {
    $('recBtn').disabled = true;
    $('recBtn').textContent = '🎙 이 브라우저는 듣기 불가';
    $('recHint').textContent = '대신 아래 칸을 누르고 아이폰 키보드의 🎤(받아쓰기)를 눌러 말하세요.';
    return;
  }
  $('recHint').textContent = '처음 누르면 마이크·음성 인식 허용을 물어봐요. 화면을 켜 둔 채 쓰세요.';
  rec = new SR();
  rec.lang = 'ko-KR';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const ta = $('text');
        const add = r[0].transcript.trim();
        if (add) ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + add; // 줄바꿈 대신 띄어쓰기(문장 나누기는 Rust가)
        ta.scrollTop = ta.scrollHeight;
        saveDraft();
      } else interim += r[0].transcript;
    }
    $('interim').textContent = interim;
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopListening();
      toast('마이크/음성 인식이 막혀 있어요. 설정 > Safari > 마이크를 확인하세요.', 4000);
    }
  };
  // 아이폰은 말이 끊기면 저절로 멈춘다 → 듣는 중이면 다시 켠다
  rec.onend = () => { if (listening) setTimeout(() => { try { rec.start(); } catch (_) {} }, 250); };
}
function startListening() {
  listening = true; startedAt = Date.now();
  try { rec.start(); } catch (_) {}
  $('recBtn').textContent = '⏹ 듣기 멈춤'; $('recBtn').classList.add('on');
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function stopListening() {
  listening = false;
  try { rec && rec.stop(); } catch (_) {}
  clearInterval(timer);
  $('recBtn').textContent = '🎙 듣기 시작'; $('recBtn').classList.remove('on');
  $('interim').textContent = '';
}

// ---------- 결과 목록 ----------
function itemRow(listId, it, on = true) {
  const li = document.createElement('li');
  if (!on) li.classList.add('off');
  li.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>
    <div class="body"><textarea rows="2"></textarea>
    <div class="meta"><input class="owner" placeholder="담당"><input class="due" placeholder="기한"></div></div>`;
  li.querySelector('textarea').value = it.text || '';
  li.querySelector('.owner').value = it.owner || '';
  li.querySelector('.due').value = it.due || '';
  li.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
    li.classList.toggle('off', !e.target.checked); refresh();
  });
  li.addEventListener('input', refresh);
  $(listId).appendChild(li);
}
function readList(listId) {
  return [...$(listId).children]
    .filter((li) => li.querySelector('input[type=checkbox]').checked)
    .map((li) => ({
      text: li.querySelector('textarea').value.trim(),
      owner: li.querySelector('.owner').value.trim() || null,
      due: li.querySelector('.due').value.trim() || null,
    }))
    .filter((x) => x.text);
}
function buildMessage() {
  let msg = callCore('format_message', {
    title: $('title').value, date: $('date').value,
    todos: readList('todos'), decisions: readList('decisions'), blockers: readList('blockers'),
    request: $('request').value,
  });
  if ($('withText').checked && $('text').value.trim()) msg += '\n\n[회의 내용 전체]\n' + $('text').value.trim();
  return msg;
}
function refresh() {
  $('todoCount').textContent = readList('todos').length;
  $('decCount').textContent = readList('decisions').length;
  $('blkCount').textContent = readList('blockers').length;
  $('preview').textContent = buildMessage();
}

function analyze() {
  const text = $('text').value.trim();
  if (!text) { toast('먼저 회의 내용을 받아쓰거나 붙여 넣어 주세요.'); return; }
  if (listening) stopListening();
  const a = JSON.parse(callCore('analyze', { text }));
  for (const id of ['todos', 'decisions', 'blockers']) $(id).innerHTML = '';
  a.todos.forEach((x) => itemRow('todos', x));
  a.decisions.forEach((x) => itemRow('decisions', x));
  a.blockers.forEach((x) => itemRow('blockers', x));
  $('result').classList.remove('hidden');
  refresh();
  saveHistory(a);
  $('result').scrollIntoView({ behavior: 'smooth' });
  if ($('autoSend').checked && tgReady()) {
    autoSend()
      .then((r) => toast(r === 'refine' ? `할 일 ${a.todos.length}개를 봇이 보냈어요. PC Claude 정리본이 곧 와요.` : `할 일 ${a.todos.length}개를 봇이 보냈어요.`, 3500))
      .catch((e) => toast('봇 보내기 실패: ' + e.message, 5000));
  } else {
    toast(`문장 ${a.sentence_count}개 중 할 일 ${a.todos.length}개를 찾았어요.` + (tgReady() ? '' : ' (설정에서 봇을 연결하면 자동으로 보내요)'), 3500);
  }
}

// ---------- 텔레그램으로 보내기 ----------
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (_) {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta);
    ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
function openBot() {
  const bot = $('botName').value.trim().replace(/^@/, '');
  if (bot) location.href = `https://t.me/${encodeURIComponent(bot)}`;
  else location.href = 'tg://';
}
async function send() {
  if (tgReady()) {
    try { const r = await autoSend(); toast(r === 'refine' ? '봇이 보냈어요. PC Claude 정리본이 곧 와요.' : '봇이 보냈어요.'); }
    catch (e) { toast('봇 보내기 실패: ' + e.message, 5000); }
    return;
  }
  const msg = buildMessage();
  const tooLong = msg.length > 4000; // 텔레그램 한 메시지 한도 4096자
  if (navigator.share) {
    try {
      if (tooLong) {
        const file = new File([msg], `회의할일_${$('date').value || today()}.txt`, { type: 'text/plain' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      }
      await navigator.share({ text: msg });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 사용자가 닫음
    }
  }
  // 공유 창이 없으면: 복사 → 봇 대화방 열기
  if (await copyText(msg)) {
    toast('글을 복사했어요. 봇 대화방에서 붙여넣기 하세요.', 3000);
    setTimeout(openBot, 900);
  } else toast('복사에 실패했어요. 미리 보기 글을 길게 눌러 복사하세요.', 4000);
}

// ---------- 지난 회의 ----------
function loadHistory() { try { return JSON.parse(localStorage.getItem(LS.hist)) || []; } catch (_) { return []; } }
function saveHistory(a) {
  const h = loadHistory().filter((x) => !(x.title === $('title').value && x.date === $('date').value));
  h.unshift({ title: $('title').value || '회의', date: $('date').value, text: $('text').value, todos: a.todos.length });
  localStorage.setItem(LS.hist, JSON.stringify(h.slice(0, 30)));
  renderHistory();
}
function renderHistory() {
  const h = loadHistory(); const ul = $('history'); ul.innerHTML = '';
  $('histCount').textContent = h.length ? `(${h.length})` : '';
  h.forEach((x, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><button class="ghost">열기</button><button class="ghost">삭제</button>`;
    li.querySelector('span').textContent = `${x.date} ${x.title} · 할 일 ${x.todos}`;
    const [openB, delB] = li.querySelectorAll('button');
    openB.onclick = () => { $('title').value = x.title; $('date').value = x.date; $('text').value = x.text; saveDraft(); analyze(); };
    delB.onclick = () => {
      if (!confirm('이 회의 기록을 지울까요?')) return;
      const all = loadHistory(); all.splice(i, 1); localStorage.setItem(LS.hist, JSON.stringify(all)); renderHistory();
    };
    ul.appendChild(li);
  });
}

const SAMPLE = '음 오늘 주간 회의 시작할게요 지난주 학예회 준비는 거의 끝났습니다\n' +
  '김민수 선생님이 금요일까지 무대 배치도 보내 주세요\n제가 내일 강당 예약 확인할게요\n' +
  '간식은 학부모회에서 준비하는 걸로 결정했습니다\n음향 장비가 고장 나서 리허설이 어렵습니다\n' +
  '다음 주 화요일까지 안내장 작성 부탁드려요';

// ---------- 시작 ----------
async function main() {
  try { await loadCore(); } catch (e) { toast('앱 핵심(Rust)을 불러오지 못했어요: ' + e, 6000); return; }
  const d = JSON.parse(localStorage.getItem(LS.draft) || '{}');
  $('title').value = d.title || ''; $('date').value = d.date || today(); $('text').value = d.text || '';
  $('botName').value = localStorage.getItem(LS.bot) || 'my_claudetyty_bot';
  $('request').value = localStorage.getItem(LS.req) ?? DEFAULT_REQUEST;
  $('token').value = localStorage.getItem(LS.token) || '';
  $('chatId').value = localStorage.getItem(LS.chat) || '';
  $('autoSend').checked = localStorage.getItem(LS.auto) !== '0';
  $('refine').checked = localStorage.getItem(LS.refine) !== '0';
  setupSpeech(); renderHistory(); updateLinkState();
  if (!tgReady()) $('settings').open = true;

  $('token').addEventListener('input', () => { localStorage.setItem(LS.token, $('token').value.trim()); updateLinkState(); });
  $('chatId').addEventListener('input', () => { localStorage.setItem(LS.chat, $('chatId').value.trim()); updateLinkState(); });
  $('autoSend').addEventListener('change', () => localStorage.setItem(LS.auto, $('autoSend').checked ? '1' : '0'));
  $('refine').addEventListener('change', () => localStorage.setItem(LS.refine, $('refine').checked ? '1' : '0'));
  $('testBtn').onclick = async () => {
    if (!tgReady()) { toast('토큰과 대화방 번호를 먼저 넣어 주세요.'); return; }
    try { await tg('sendMessage', { chat_id: $('chatId').value.trim(), text: '할일먼저 앱 연결 시험: 잘 연결됐어요 ✅' }); toast('연결됐어요! 텔레그램을 확인해 보세요.'); }
    catch (e) { toast('연결 실패: ' + e.message, 5000); }
  };
  $('audioBtn').onclick = () => (mr && mr.state === 'recording' ? stopAudio() : startAudio());
  $('retryBtn').onclick = async () => { const it = await pendingGet().catch(() => null); if (it) sendAudio(it); else $('retryBtn').classList.add('hidden'); };
  pendingGet().then((it) => { if (it) { $('retryBtn').classList.remove('hidden'); $('audioStatus').textContent = '보내지 못한 녹음이 있어요.'; } }).catch(() => {});
  if (!window.MediaRecorder) { $('audioBtn').disabled = true; $('audioStatus').textContent = '이 브라우저는 녹음을 지원하지 않아요.'; }

  $('recBtn').onclick = () => (listening ? stopListening() : startListening());
  $('analyzeBtn').onclick = analyze;
  $('sendBtn').onclick = send;
  $('copyBtn').onclick = async () => toast((await copyText(buildMessage())) ? '복사했어요.' : '복사 실패');
  $('sampleBtn').onclick = () => { $('text').value = SAMPLE; $('title').value ||= '주간 회의'; saveDraft(); };
  $('clearBtn').onclick = () => {
    if (!$('text').value || confirm('회의 내용을 지울까요? (지난 회의 기록은 남아요)')) {
      $('text').value = ''; $('title').value = ''; $('date').value = today(); saveDraft();
      $('result').classList.add('hidden');
    }
  };
  for (const id of ['title', 'date', 'text']) $(id).addEventListener('input', saveDraft);
  $('withText').addEventListener('change', refresh);
  $('botName').addEventListener('input', () => localStorage.setItem(LS.bot, $('botName').value.trim()));
  $('request').addEventListener('input', () => { localStorage.setItem(LS.req, $('request').value); refresh(); });
  document.querySelectorAll('.add').forEach((b) => b.addEventListener('click', () => {
    itemRow(b.dataset.list, { text: '' }); refresh();
    $(b.dataset.list).lastChild.querySelector('textarea').focus();
  }));

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();
