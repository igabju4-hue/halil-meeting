// 할일먼저 — 화면·녹음·공유 담당. 할 일 뽑기와 보낼 글 만들기는 Rust(core.wasm)가 한다.
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_REQUEST = '부탁: 이 회의 할 일을 확인하고, 담당·기한이 빠진 일과 오늘 먼저 할 일을 짚어 줘.';
const LS = { draft: 'hm.draft', hist: 'hm.history', bot: 'hm.bot', req: 'hm.request' };

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
        if (add) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + add;
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
  toast(`문장 ${a.sentence_count}개 중 할 일 ${a.todos.length}개를 찾았어요.`);
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
  $('botName').value = localStorage.getItem(LS.bot) || '';
  $('request').value = localStorage.getItem(LS.req) ?? DEFAULT_REQUEST;
  setupSpeech(); renderHistory();

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
