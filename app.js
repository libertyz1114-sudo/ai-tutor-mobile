// AI 튜터 모바일 — 서버 없이 휴대폰 안에서만 도는 앱.
// 학습 내용(외출 팩)과 기록, API 키는 이 기기의 저장소에만 있다. AI 질문만 Claude API로 직접 나간다.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.10.0/+esm';
const MODELS = { 'claude-opus-5-5': 'Opus 5.5 (기본)', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };
const MARK = { o: '○', t: '△', x: '×' };

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nowIso = () => { const d = new Date(); return `${isoDay(d)}T${[d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')}`; };   // 기기 현지 시각
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };

// ───────────────────────── 저장소 ─────────────────────────

const db = {
  get(k, fallback) { try { const v = localStorage.getItem(`tutor:${k}`); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
  set(k, v) { try { localStorage.setItem(`tutor:${k}`, JSON.stringify(v)); return true; } catch (_) { toast('저장 공간이 부족해요. 결과를 내보낸 뒤 기록을 비워 주세요.'); return false; } },
};
let pack = db.get('pack', null);
let log = db.get('log', { sessions: [], marks: [], memos: [] });
let itemState = db.get('items', {});      // 복습 항목의 기기 안 진행 상태 { id: {due, step} }
let setState = db.get('sets', {});        // 문제 세트 풀이 상태 { setId: { index: {mark, sec, pick} } }
const saveLog = () => db.set('log', log);

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ───────────────────────── PC와 주고받기 (주소에 실어서) ─────────────────────────
// PC 화면의 QR을 찍으면 PC가 팩을 압축해 이 앱 주소 뒤(#pack=...)에 붙여 넘겨준다.
// 결과는 반대로, 압축해서 PC 주소 뒤(#d=...)에 붙여 연다. # 뒷부분은 인터넷으로 나가지 않는다.

async function unsqueeze(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
async function squeeze(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function receivePack() {
  if (!location.hash.startsWith('#pack=')) return false;
  const data = location.hash.slice(6);
  history.replaceState(null, '', location.pathname);      // 주소창에서 팩 내용을 지운다
  try {
    const p = await unsqueeze(data);
    if (!p.prompts || !p.id) throw new Error('팩 내용이 맞지 않아요.');
    if (!db.set('pack', p)) return false;
    pack = p;
    if (p.pc) db.set('pc', p.pc);
    if (p.synced) {       // 동기화로 받은 팩: 결과는 PC에 이미 들어갔으니 휴대폰 기록을 비운다
      log = { sessions: [], marks: [], memos: [] }; saveLog();
      itemState = {}; db.set('items', itemState);
    }
    toast(`PC에서 팩을 받았어요: 복습 ${p.items.length}개 · 문제 세트 ${p.sets.length}개`, 5000);
  } catch (e) { toast(`팩을 받지 못했어요: ${e.message}`, 6000); }
  return true;
}
function resultBody() { return { pack_id: pack?.id || null, exported_at: nowIso(), ...log }; }

// PC와 동기화: 이 휴대폰의 결과를 PC로 보내고, PC의 최신 팩을 받아 온다. 한 번 누르면 PC 화면을 거쳐 앱으로 돌아온다.
// 처음에는 PC 화면에 보이는 주소와 연결 코드를 한 번 입력한다. 그 뒤로는 팩에 담겨 온 정보로 바로 간다.
async function syncWithPc() {
  let pc = pack?.pc || db.get('pc', null);
  if (!pc) {
    const ip = prompt('PC 주소 (PC 튜터 홈의 외출 팩 칸에 보여요)\n예: 192.168.0.10');
    if (!ip) return;
    const code = prompt('연결 코드 6자리');
    if (!code) return;
    pc = { url: `http://${ip.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '')}:8765`, token: code.trim() };
    db.set('pc', pc);
  }
  closeSession();
  const has = log.sessions.length + log.marks.length + log.memos.length;
  const t = encodeURIComponent(pc.token);
  location.href = has
    ? `${pc.url}/lan/recv#next=pull&t=${t}&d=${await squeeze(resultBody())}`
    : `${pc.url}/lan/pull?t=${t}`;
}
function forgetPc() { db.set('pc', null); if (pack?.pc) { delete pack.pc; db.set('pack', pack); } }

// ───────────────────────── 복습 항목 ─────────────────────────

function allItems() {
  const base = (pack?.items || []).map(it => ({ ...it, ...(itemState[it.id] || {}) }));
  const extra = Object.values(itemState).filter(s => s.local);    // 휴대폰에서 새로 생긴 항목
  return base.concat(extra);
}
function dueItems(subject) {
  const today = isoDay();
  return allItems().filter(it => it.due && it.due <= today && (!subject || it.subject === subject));
}
function gradeItem(it, mark) {
  const steps = pack?.intervals || [1, 3, 7, 14, 30];
  let step = it.step || 0, due;
  if (mark === 'o') { step += 1; due = step <= steps.length ? addDays(steps[step - 1]) : null; }
  else if (mark === 't') due = addDays(1);
  else { step = 0; due = addDays(1); }
  itemState[it.id] = { ...(itemState[it.id] || {}), ...(it.local ? it : {}), due, step };
  db.set('items', itemState);
}
function addMark(session, { item, title, answer, mark, sec, inSet }) {
  let it = item;
  if (!it && title && !(inSet && mark === 'o')) {
    it = allItems().find(x => x.subject === session.subject && x.title === title)
      || { id: `m-${uid()}`, local: true, subject: session.subject || '기타', title, answer: answer || '', step: 0 };
  }
  if (it) gradeItem(it, mark);
  log.marks.push({
    uid: uid(), session: session.uid, item_id: it && !it.local ? it.id : null, subject: (it && it.subject) || session.subject || '기타',
    title: it ? it.title : title, answer: answer || (it && it.answer) || '', mark, sec: sec ?? null, in_set: !!inSet, ts: nowIso(),
  });
  session.marks[mark] += 1;
  saveLog();
}

// ───────────────────────── 세션 (집중 기록 포함) ─────────────────────────

let current = null;     // 지금 열려 있는 세션
let tracker = null;

function openSession(fields) {
  closeSession();
  current = { uid: uid(), date: isoDay(), started_at: nowIso(), ended_at: null, goal: '', subject: '', mode: 'ask',
    plan_id: null, plan_text: '', segments: [], away_count: 0, messages: [], marks: { o: 0, t: 0, x: 0 }, ...fields };
  tracker = new FocusTracker({
    segments: [], idleMinutes: Number(pack?.settings?.idle_minutes) || 3, deepMinutes: Number(pack?.settings?.deep_minutes) || 10,
    onChange: (changed) => { if (changed) keepSession(); },
  });
  return current;
}
function keepSession() {
  if (!current || !tracker) return;
  current.segments = tracker.segments; current.away_count = tracker.awayCount;
}
function closeSession() {
  if (!current) return;
  if (tracker) { tracker.stop(); keepSession(); tracker = null; }
  current.ended_at = nowIso();
  const focus = current.segments.reduce((a, s) => a + (s.e - s.s), 0);
  const used = focus >= 30 || current.messages.length || current.marks.o + current.marks.t + current.marks.x;
  if (used) {
    const { marks, ...rest } = current;
    log.sessions.push({ ...rest, messages: rest.messages.map(m => ({ role: m.role, text: m.text, ts: m.ts })) });
    saveLog();
  }
  current = null;
}
function focusToday() {
  const deepMin = (Number(pack?.settings?.deep_minutes) || 10) * 60;
  let focus = 0, deep = 0;
  for (const s of log.sessions.filter(x => x.date === isoDay()))
    for (const g of s.segments || []) { const n = g.e - g.s; focus += n; if (n >= deepMin) deep += n; }
  return { focus: Math.floor(focus / 60), deep: Math.floor(deep / 60) };
}

// ───────────────────────── Claude API (공식 SDK, 스트리밍) ─────────────────────────

let Anthropic = null;
async function sdk() {
  if (!Anthropic) Anthropic = (await import(SDK_URL)).default;
  return Anthropic;
}

// 답을 글자 단위로 흘려보낸다. 끝나면 전체 답을 돌려준다.
async function* tutorStream(system, messages) {
  const key = db.get('key', '');
  if (!key) throw new Error('설정에서 API 키를 먼저 넣어 주세요.');
  const A = await sdk();
  const client = new A({ apiKey: key, dangerouslyAllowBrowser: true });   // 개인 기기에서 본인 키로 직접 호출
  const model = db.get('model', 'claude-opus-5-5');
  const params = {
    model, max_tokens: 16000, system, messages,
    cache_control: { type: 'ephemeral' },          // 튜터 지침과 앞 대화를 캐시해 빠르고 싸게
    output_config: { effort: 'low' },              // 음성 대화라 짧고 빠른 답이 우선
  };
  // 안전 분류기가 답을 거절하면 서버가 대체 모델로 이어서 답한다 (Haiku는 이 기능이 없다)
  const stream = model === 'claude-haiku-5-5'
    ? client.messages.stream(params)
    : client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('이 질문에는 답하지 못했어요. 다르게 물어봐 주세요.');
  } catch (e) {
    if (e instanceof A.AuthenticationError) throw new Error('API 키가 맞지 않아요. 설정에서 다시 넣어 주세요.');
    if (e instanceof A.PermissionDeniedError) throw new Error('이 키로는 이 모델을 쓸 수 없어요. 설정에서 모델을 바꿔 보세요.');
    if (e instanceof A.RateLimitError) throw new Error('요청이 잠깐 몰렸어요. 조금 뒤에 다시 해 주세요.');
    if (e instanceof A.APIConnectionError) throw new Error('인터넷 연결이 없어요. 복습 카드와 받아 둔 문제는 그대로 쓸 수 있어요.');
    if (e instanceof A.APIError) throw new Error(`AI 호출 오류 (${e.status ?? ''}): ${e.message}`);
    throw e;
  }
}

const TAG_RE = /\[\[채점\|([otx])\|([^\]|]+)(?:\|([^\]]*))?\]\]/g;

function modeBlock(mode, due) {
  const m = pack.prompts.modes[mode] || pack.prompts.modes.ask;
  let text = `[모드: ${m.name}] ${m.rule}`;
  if (due.length && ['quiz', 'formula', 'recite'].includes(mode))
    text += '\n[복습 차례 항목]\n' + due.slice(0, 15).map(d => `#${d.id} ${d.title}${d.answer ? ` — ${d.answer}` : ''}`).join('\n');
  return text;
}
function firstContext(session, material) {
  const parts = [];
  if (material) {
    parts.push(`[학습 자료: ${material.title}]`, material.transcript || '');
    parts.push('[수업 순서]', ...material.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.show}`));
  }
  const plan = pack.plans?.[isoDay()];
  if (plan?.items?.length) parts.push('[학습자의 오늘 계획]', ...plan.items.map(i => `- ${i.label}: ${i.text}`));
  if (session.goal) parts.push(`[이번 세션 목표] ${session.goal}`);
  parts.push('(학습자는 지금 휴대폰으로 이동 중에 공부한다. 답을 더 짧게 한다.)');
  return parts.join('\n');
}

// ───────────────────────── 화면 전환 ─────────────────────────

let leave = null;
function go(hash) { location.hash = hash; }
async function route() {
  if (leave) { leave(); leave = null; }
  Speaker.stop();
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  if (name !== 'talk' && name !== 'cards' && name !== 'set' && name !== 'lesson') closeSession();
  if (!pack && name !== 'settings') return viewSetup();
  if (name === 'talk') return viewTalk(arg);
  if (name === 'cards') return viewCards();
  if (name === 'set' && arg) return viewSet(Number(arg));
  if (name === 'lesson' && arg) return viewLesson(Number(arg));
  if (name === 'settings') return viewSettings();
  return viewHome();
}
window.addEventListener('hashchange', async () => { await receivePack(); route(); });
window.addEventListener('pagehide', () => { keepSession(); if (current) db.set('open', current); });

// ───────────────────────── 처음 설정 ─────────────────────────

function viewSetup() {
  app.innerHTML = `<main class="page">
    <header class="top"><h1>AI 튜터</h1><button class="btn small ghost" data-go="#/settings">설정</button></header>
    <section class="card">
      <h2>외출 팩이 아직 없어요</h2>
      <ol>
        <li>PC에서 튜터를 켜 둬요. (휴대폰과 같은 와이파이)</li>
        <li>아래 <b>PC와 동기화</b>를 누르고, PC 튜터 홈의 "외출 팩" 칸에 보이는 주소와 연결 코드를 넣어요. 처음 한 번만 해요.</li>
      </ol>
      <button class="btn primary wide" id="sync">🔄 PC와 동기화</button>
      <p class="muted small">와이파이가 다르면: PC에서 "파일로 만들기" → 구글 드라이브 → 아래 버튼.</p>
      <button class="btn wide" id="load">파일에서 팩 불러오기</button>
      <input id="file" type="file" accept=".json,application/json" hidden>
    </section>
  </main>`;
  wirePackLoader();
  $('#sync').onclick = startSync;
  app.onclick = navClick;
}
function startSync() { syncWithPc().catch(e => toast(e.message)); }
function navClick(e) { const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); }
function wirePackLoader() {
  $('#load').onclick = () => $('#file').click();
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!p.prompts || !p.id) throw new Error('외출 팩 파일이 아니에요.');
      if (!db.set('pack', p)) return;
      pack = p;
      toast(`팩을 받았어요: 복습 ${p.items.length}개 · 문제 세트 ${p.sets.length}개`);
      go('#/'); route();
    } catch (err) { toast(`불러오지 못했어요: ${err.message}`, 6000); }
  };
}

// ───────────────────────── 홈 ─────────────────────────

function viewHome() {
  const today = isoDay();
  const plan = pack.plans?.[today];
  const due = dueItems();
  const f = focusToday();
  const sets = pack.sets || [];
  const setDone = (s) => Object.values(setState[s.id] || {}).filter(x => x.mark).length;
  app.innerHTML = `<main class="page">
    <header class="top">
      <div><div class="kpi">${f.deep}<small>분</small></div><div class="muted small">오늘 딥 포커스 · 집중 ${f.focus}분</div></div>
      <div class="row">${navigator.onLine ? '' : '<span class="offline">오프라인</span>'}<button class="btn small ghost" data-go="#/settings">설정</button></div>
    </header>

    <div class="row"><button class="btn primary grow" data-start="free">🎤 바로 질문하기</button><button class="btn" id="sync">🔄 PC와 동기화</button></div>

    ${due.length ? `<section class="card"><div class="row"><div class="grow"><h2>다시 볼 것 ${due.length}개</h2>
        <div class="muted small">${[...new Set(due.map(d => d.subject))].join(' · ')}</div></div></div>
      <div class="row" style="margin-top:10px"><button class="btn grow" data-go="#/cards">카드로 (오프라인)</button><button class="btn primary grow" data-start="review">말로 문답</button></div></section>` : ''}

    <section class="card"><h2>오늘 할 것</h2>
      ${plan?.items?.length ? `<div class="list">${plan.items.map((it, i) => `<button class="item" data-plan="${i}">
          <span class="item-main"><span class="badge">${esc(it.label)}</span><span class="item-meta">${esc(pack.prompts.modes[pack.prompts.plan_mode[it.id] || 'ask'].name)}</span>
          <div class="item-title">${esc(it.head)}</div></span><span>›</span></button>`).join('')}</div>`
      : `<p class="muted">이 날짜의 계획이 팩에 없어요. PC에서 새 팩을 만들어 주세요.</p>`}
    </section>

    ${sets.length ? `<section class="card"><h2>받아 둔 문제 <span class="muted small">· 오프라인 가능</span></h2>
      <div class="list">${sets.map(s => `<button class="item" data-go="#/set/${s.id}">
        <span class="item-main"><span class="badge">${esc(s.subject)}</span><span class="item-meta">${esc(s.date.slice(5))} · ${s.problems.length}문항</span>
        <div class="item-title">${setDone(s)} / ${s.problems.length} 풂</div></span><span>›</span></button>`).join('')}</div></section>` : ''}

    ${pack.materials?.length ? `<section class="card"><h2>교재 수업 <span class="muted small">· 오프라인 가능</span></h2>
      <div class="list">${pack.materials.map(m => `<button class="item" data-go="#/lesson/${m.id}">
        <span class="item-main"><span class="badge">${esc(m.subject || '')}</span><div class="item-title">${esc(m.title)}</div></span><span>›</span></button>`).join('')}</div></section>` : ''}

    <section class="card"><h2>잡생각 메모</h2>
      <div class="row"><input id="memo" type="text" placeholder="떠오른 것을 적어 두면 PC에서 보여 줘요"><button class="btn" id="memo-save">저장</button></div>
      <div class="muted small" style="margin-top:6px">저장된 메모 ${log.memos.length}개</div></section>
  </main>`;

  app.onclick = (e) => {
    navClick(e);
    const st = e.target.closest('[data-start]');
    if (st) {
      if (st.dataset.start === 'review') openSession({ goal: '복습', mode: 'quiz', subject: '' });
      else openSession({ goal: '자유 질문', mode: 'ask', subject: '' });
      return go('#/talk');
    }
    const pl = e.target.closest('[data-plan]');
    if (pl) {
      const it = plan.items[Number(pl.dataset.plan)];
      const mode = pack.prompts.plan_mode[it.id] || 'ask';
      const subject = it.id === 'primary' ? it.head.split(' ')[0] : it.label;
      // 문제 풀이 칸은 받아 둔 세트로 간다 (없으면 대화로)
      const set = mode === 'set' && (pack.sets || []).find(s => s.kind === it.id && s.date === today);
      if (set) return go(`#/set/${set.id}`);
      openSession({ goal: it.head, mode: mode === 'set' ? 'ask' : mode, subject, plan_id: it.id, plan_text: it.text });
      return go('#/talk');
    }
  };
  $('#sync').onclick = startSync;
  $('#memo-save').onclick = () => {
    const v = $('#memo').value.trim();
    if (!v) return;
    log.memos.push({ uid: uid(), text: v, ts: nowIso(), session: null });
    saveLog(); Beep.saved(); route();
  };
}

// ───────────────────────── 대화 (AI, 인터넷 필요) ─────────────────────────

function viewTalk(materialId) {
  if (!current) { current = db.get('open', null); if (current) { current.marks ||= { o: 0, t: 0, x: 0 }; openTracker(); } }
  if (!current) return go('#/');
  const s = current;
  const material = materialId ? pack.materials.find(m => m.id === Number(materialId)) : null;
  let mode = s.mode, modeSent = null, busy = false, holding = false;
  const api = [];   // Claude API에 보내는 대화 (채점 표시가 붙은 원문 그대로)

  app.innerHTML = `<div class="study">
    <header class="study-top"><button class="btn small ghost" id="back">‹</button>
      <div class="goal">${esc(s.goal || '자유 질문')}</div><span class="tally" id="tally"></span>
      <button class="btn small" id="end">끝</button></header>
    <div class="modes" id="modes"></div>
    <div class="log" id="log"><div class="msg hint" id="hint"></div></div>
    <div class="dock">
      <div class="heard" id="heard"></div><div class="meter"><i id="meter"></i></div>
      <button class="talk" id="talk">🎤 누르고 말하기</button>
      <div class="row"><input id="q" type="text" placeholder="글로 적어도 돼요" enterkeyhint="send"><button class="btn" id="send">보내기</button></div>
    </div></div>`;
  const logEl = $('#log');
  const HINT = { ask: '막힌 것을 물어보세요.', recite: '읽은 내용을 자기 말로 설명해 보세요.', quiz: '튜터가 먼저 물어요.', formula: '튜터가 공식 이름을 말하면 식을 말해요.', solve: '풀이를 한 줄씩 말해요.' };
  const renderModes = () => {
    $('#modes').innerHTML = ['ask', 'recite', 'quiz', 'formula', 'solve'].map(k => `<button class="mode ${k === mode ? 'on' : ''}" data-mode="${k}">${esc(pack.prompts.modes[k].name)}</button>`).join('');
    $('#hint').textContent = navigator.onLine ? HINT[mode] : '지금은 인터넷이 없어서 질문은 못 해요. 홈의 카드와 받아 둔 문제는 쓸 수 있어요.';
  };
  const renderTally = () => { const m = s.marks; $('#tally').innerHTML = m.o + m.t + m.x ? `<b class="o">○${m.o}</b><b class="t">△${m.t}</b><b class="x">×${m.x}</b>` : ''; };
  const addMsg = (role, text) => { const el = document.createElement('div'); el.className = `msg ${role}`; el.textContent = text; logEl.appendChild(el); logEl.scrollTop = logEl.scrollHeight; return el; };

  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    Speaker.stop();
    addMsg('user', text);
    const el = addMsg('assistant', ''); el.classList.add('thinking');
    let prompt = '';
    if (!api.length) prompt += firstContext(s, material) + '\n\n';
    if (modeSent !== mode) { prompt += modeBlock(mode, dueItems(s.subject || undefined)) + '\n\n'; modeSent = mode; s.mode = mode; }
    prompt += `학습자: ${text}`;
    api.push({ role: 'user', content: prompt });
    s.messages.push({ role: 'user', text, ts: nowIso() });
    let answer = '', shown = 0;
    try {
      for await (const delta of tutorStream(pack.prompts.system, api)) {
        answer += delta;
        // 채점 표시([[...]])는 보여 주지도 읽어 주지도 않는다
        const cut = answer.indexOf('[[');
        const end = cut >= 0 ? cut : (answer.endsWith('[') ? answer.length - 1 : answer.length);
        if (end > shown) {
          const piece = answer.slice(shown, end);
          el.classList.remove('thinking');
          el.textContent += piece; Speaker.feed(piece); shown = end;
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      const cut = answer.indexOf('[[');
      if (cut < 0 && shown < answer.length) { el.textContent += answer.slice(shown); Speaker.feed(answer.slice(shown)); }
      Speaker.flush();
      api.push({ role: 'assistant', content: answer });
      s.messages.push({ role: 'assistant', text: el.textContent.trim(), ts: nowIso() });
      for (const m of answer.matchAll(TAG_RE)) {
        let [, mark, title, detail] = m;
        title = title.trim();
        const item = /^#\d+$/.test(title) ? allItems().find(x => String(x.id) === title.slice(1)) : null;
        addMark(s, { item, title: item ? item.title : title, answer: (detail || '').trim(), mark });
        const b = document.createElement('div');
        b.className = `markline ${mark}`; b.textContent = `${MARK[mark]} ${item ? item.title : title}`;
        logEl.appendChild(b);
      }
      renderTally();
    } catch (e) {
      api.pop(); s.messages.pop();
      el.classList.add('error'); el.textContent = e.message;
    } finally {
      el.classList.remove('thinking');
      logEl.scrollTop = logEl.scrollHeight;
      busy = false;
    }
  }

  $('#modes').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || busy || b.dataset.mode === mode) return;
    mode = b.dataset.mode; renderModes();
    if (pack.prompts.modes[mode].starts) ask('시작할게요');
  };
  const send = () => { const q = $('#q'); const v = q.value; q.value = ''; ask(v); };
  $('#send').onclick = send;
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') send(); };

  // 누르고 말하기
  const talk = $('#talk');
  const down = (e) => {
    e.preventDefault();
    if (holding || busy) return;
    if (!Mic.supported) return toast('이 브라우저는 음성 입력이 안 돼요. Chrome에서 열어 주세요.');
    Speaker.stop();
    if (!Mic.start((t) => { $('#heard').textContent = t; }, (code) => toast(code === 'not-allowed' ? '마이크 권한을 허용해 주세요.' : `음성 입력 오류: ${code}`))) return;
    holding = true; talk.classList.add('on'); talk.textContent = '듣는 중… 손을 떼면 보내요';
    $('#heard').textContent = ''; Beep.start();
    Meter.start((lv) => { $('#meter').style.width = `${Math.round(lv * 100)}%`; });
  };
  const up = async () => {
    if (!holding) return;
    const text = await Mic.stop();
    holding = false; Meter.stop(); $('#meter').style.width = '0';
    talk.classList.remove('on'); talk.textContent = '🎤 누르고 말하기'; Beep.end();
    if (text) ask(text); else toast('말이 안 잡혔어요. 다시 눌러 주세요.');
  };
  talk.onpointerdown = down; talk.onpointerup = up; talk.onpointercancel = up; talk.onpointerleave = up;
  talk.oncontextmenu = (e) => e.preventDefault();

  $('#back').onclick = () => { closeSession(); db.set('open', null); go('#/'); };
  $('#end').onclick = () => { closeSession(); db.set('open', null); toast('기록했어요.'); go('#/'); };

  renderModes(); renderTally();
  if (material) addMsg('assistant', `「${material.title}」 수업에 대해 물어보세요.`);
  else if (pack.prompts.modes[mode].starts && navigator.onLine) ask('시작할게요');
  leave = () => { if (Mic.listening) Mic.stop(); Meter.stop(); };
}
function openTracker() {
  tracker = new FocusTracker({ segments: current.segments || [], idleMinutes: Number(pack?.settings?.idle_minutes) || 3,
    deepMinutes: Number(pack?.settings?.deep_minutes) || 10, onChange: (c) => { if (c) keepSession(); } });
}

// ───────────────────────── 복습 카드 (오프라인) ─────────────────────────

function viewCards() {
  const queue = dueItems();
  if (!current || current.mode !== 'cards') openSession({ goal: '복습 카드', mode: 'quiz', subject: '' });
  const s = current;
  let i = 0, shown = false;
  // 앞면: 답이 그대로 보이지 않게, '=' 나 ':' 앞까지만 보여 준다
  const front = (it) => {
    if (it.answer && it.answer !== it.title) return it.title;
    const cut = it.title.search(/[=:→]/);
    return cut > 2 ? `${it.title.slice(0, cut).trim()} = ?` : `${it.title.slice(0, 8)}… (이어서 떠올리기)`;
  };
  const render = () => {
    if (i >= queue.length) {
      app.innerHTML = `<div class="study"><div class="stage"><h2>복습 끝</h2>
        <p>○${s.marks.o} △${s.marks.t} ×${s.marks.x}</p><p class="muted">틀린 것은 내일 다시 나와요.</p>
        <button class="btn primary wide" id="done">홈으로</button></div></div>`;
      $('#done').onclick = () => { closeSession(); go('#/'); };
      return;
    }
    const it = queue[i];
    app.innerHTML = `<div class="study">
      <header class="study-top"><button class="btn small ghost" id="back">‹</button><div class="goal">복습 ${i + 1} / ${queue.length}</div><span class="badge">${esc(it.subject)}</span></header>
      <div class="stage"><div class="front">${esc(front(it))}</div>
        ${shown ? `<div class="back">${esc(it.answer || it.title)}</div>` : ''}</div>
      <div class="dock">${shown
        ? `<div class="grade"><button class="btn x" data-g="x">× 모름</button><button class="btn t" data-g="t">△ 반쯤</button><button class="btn o" data-g="o">○ 앎</button></div>`
        : `<button class="talk" id="flip">답 보기</button>`}</div></div>`;
    $('#back').onclick = () => { closeSession(); go('#/'); };
    if (!shown) $('#flip').onclick = () => { shown = true; render(); };
    else $$('[data-g]').forEach(b => b.onclick = () => { addMark(s, { item: it, mark: b.dataset.g }); i++; shown = false; render(); });
  };
  render();
}

// ───────────────────────── 받아 둔 문제 (오프라인) ─────────────────────────

function viewSet(setId) {
  const set = (pack.sets || []).find(x => x.id === setId);
  if (!set) return go('#/');
  if (!current || current.set_id !== setId) openSession({ goal: `${set.subject} 문제 풀이`, mode: 'set', subject: set.subject, plan_id: set.kind, set_id: setId });
  const s = current;
  const st = setState[setId] ||= {};
  let i = set.problems.findIndex((_, n) => !st[n]);
  if (i < 0) i = set.problems.length;
  let t0 = Date.now();
  const timer = setInterval(() => { const el = $('#timer'); if (el && !st[i]) { const n = Math.round((Date.now() - t0) / 1000); el.textContent = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; } }, 1000);
  const render = () => {
    if (i >= set.problems.length) {
      const done = Object.values(st).filter(x => x.mark), right = done.filter(x => x.mark === 'o').length;
      const secs = done.filter(x => x.sec).map(x => x.sec);
      app.innerHTML = `<div class="study"><div class="stage"><h2>${right} / ${done.length} 맞음</h2>
        ${secs.length ? `<p>문항당 평균 ${Math.round(secs.reduce((a, b) => a + b, 0) / secs.length)}초</p>` : ''}
        <ul>${set.problems.map((p, n) => `<li>${n + 1}. ${esc(p.type || '')} — ${st[n] ? (st[n].flag ? '신고함' : MARK[st[n].mark]) : '안 풂'}</li>`).join('')}</ul>
        <button class="btn primary wide" id="done">홈으로</button></div></div>`;
      $('#done').onclick = () => { closeSession(); go('#/'); };
      return;
    }
    const p = set.problems[i], r = st[i];
    app.innerHTML = `<div class="study">
      <header class="study-top"><button class="btn small ghost" id="back">‹</button>
        <div class="goal">문제 ${i + 1} / ${set.problems.length} · ${esc(p.type || '')}</div><span class="muted" id="timer"></span></header>
      <div class="stage"><div class="prob-q">${esc(p.q)}</div>
        <div class="choices">${p.choices.map((c, n) => `<button class="choice ${r && n + 1 === p.answer ? 'right' : ''} ${r && r.pick === n + 1 && r.mark === 'x' ? 'wrong' : ''}" data-c="${n + 1}" ${r ? 'disabled' : ''}>${set.kind === 'ncs' ? `${n + 1}) ` : ''}${esc(c)}</button>`).join('')}</div>
        ${r && !r.flag ? `<div class="back"><b>${r.mark === 'o' ? '○ 맞았어요' : '× 틀렸어요'}</b> · 정답 ${p.answer}번\n${esc(p.explain || '')}</div>` : ''}</div>
      <div class="dock"><div class="row"><button class="btn ghost" id="flag">문제 이상함</button>
        <button class="btn ${r ? 'primary' : 'ghost'} grow" id="next">${r ? '다음 문제 →' : '건너뛰기'}</button></div></div></div>`;
    $('#back').onclick = () => { closeSession(); go('#/'); };
    $('#next').onclick = () => { i++; while (i < set.problems.length && st[i]) i++; t0 = Date.now(); render(); };
    $('#flag').onclick = () => { st[i] = { flag: true }; db.set('sets', setState); toast('이 문제는 빼 둘게요.'); $('#next').click(); };
    $$('[data-c]').forEach(b => b.onclick = () => {
      const pick = Number(b.dataset.c), mark = pick === p.answer ? 'o' : 'x', sec = Math.round((Date.now() - t0) / 1000);
      st[i] = { mark, sec, pick };
      db.set('sets', setState);
      addMark(s, { title: p.type || set.subject, answer: p.explain || '', mark, sec, inSet: true });
      render();
    });
  };
  render();
  leave = () => clearInterval(timer);
}

// ───────────────────────── 교재 수업 (오프라인) ─────────────────────────

function viewLesson(materialId) {
  const m = pack.materials.find(x => x.id === materialId);
  if (!m) return go('#/');
  if (!current || current.material_id !== materialId) openSession({ goal: m.title, mode: 'ask', subject: m.subject || '', material_id: materialId });
  let i = 0;
  const render = () => {
    const last = i >= m.steps.length, st = m.steps[i];
    app.innerHTML = `<div class="study">
      <header class="study-top"><button class="btn small ghost" id="back">‹</button><div class="goal">${esc(m.title)}</div>
        <span class="muted">${last ? '정리' : `${i + 1} / ${m.steps.length}`}</span></header>
      <div class="stage">${last
        ? `<h2>암기 포인트</h2><ul>${m.memory_points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
           <h2>확인 질문</h2>${m.check_questions.map(c => `<details><summary>${esc(c.q)}</summary><p>${esc(c.a)}</p></details>`).join('')}`
        : `<h2>${esc(st.title)}</h2><div class="back">${esc(st.show)}</div>${st.svg ? `<div class="figure">${st.svg}</div>` : ''}<div class="say">${esc(st.say)}</div>`}</div>
      <div class="dock"><div class="row"><button class="btn" id="prev" ${i === 0 ? 'disabled' : ''}>←</button>
        <button class="btn" id="say">▶ 듣기</button><button class="btn" id="askit">질문</button>
        <button class="btn primary grow" id="nextb" ${last ? 'disabled' : ''}>다음 →</button></div></div></div>`;
    $('#back').onclick = () => { closeSession(); go('#/'); };
    $('#prev').onclick = () => { i--; render(); speak(); };
    $('#nextb').onclick = () => { i++; render(); speak(); };
    $('#say').onclick = speak;
    $('#askit').onclick = () => go(`#/talk/${materialId}`);
  };
  const speak = () => { Speaker.stop(); if (i < m.steps.length) Speaker.say(m.steps[i].say); };
  render();
}

// ───────────────────────── 설정 · 결과 내보내기 ─────────────────────────

function viewSettings() {
  const key = db.get('key', '');
  const n = log.sessions.length + log.marks.length + log.memos.length;
  app.innerHTML = `<main class="page">
    <header class="top"><h1>설정</h1><button class="btn small ghost" data-go="#/">홈</button></header>
    <section class="card"><h2>API 키</h2>
      <p class="muted small">Claude Console에서 만든 키. 이 휴대폰 안에만 저장되고 Claude API를 부를 때만 쓰여요.</p>
      <input id="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(key)}">
      <div class="label">모델</div>
      <select id="model">${Object.entries(MODELS).map(([id, name]) => `<option value="${id}" ${id === db.get('model', 'claude-opus-5-5') ? 'selected' : ''}>${name}</option>`).join('')}</select>
      <div class="row end"><button class="btn" id="test">연결 시험</button><button class="btn primary" id="save">저장</button></div>
      <p class="small" id="test-out"></p></section>
    <section class="card"><h2>외출 팩</h2>
      <p class="muted small">${pack ? `받은 팩: ${esc(pack.created.slice(0, 16).replace('T', ' '))} · ${pack.days}일 분량` : '아직 없어요.'}</p>
      <button class="btn wide" id="load">새 팩 불러오기</button><input id="file" type="file" accept=".json,application/json" hidden></section>
    <section class="card"><h2>결과 내보내기</h2>
      <p class="muted small">세션 ${log.sessions.length} · 채점 ${log.marks.length} · 메모 ${log.memos.length}. 파일을 구글 드라이브에 올리고, PC 튜터 홈의 "휴대폰 결과 가져오기"로 넣어요. 여러 번 넣어도 한 번만 반영돼요.</p>
      <button class="btn primary wide" id="sync">🔄 PC와 동기화 (같은 와이파이)</button>
      <p class="muted small">결과를 PC로 보내고 새 팩을 받아 와요. ${db.get('pc', null) || pack?.pc ? `연결된 PC: ${esc((pack?.pc || db.get('pc', {})).url)} <a href="#" id="forget">다시 연결</a>` : '처음에는 PC 주소와 연결 코드를 물어봐요.'}</p>
      <button class="btn wide" id="export" ${n ? '' : 'disabled'}>결과 파일 만들기 (드라이브용)</button>
      <button class="btn ghost wide" id="clear" style="margin-top:8px" ${n ? '' : 'disabled'}>PC에 넣은 뒤 기록 비우기</button></section>
  </main>`;
  app.onclick = navClick;
  wirePackLoader();
  const save = () => { db.set('key', $('#key').value.trim()); db.set('model', $('#model').value); };
  $('#save').onclick = () => { save(); toast('저장했어요.'); };
  $('#test').onclick = async () => {
    save();
    const out = $('#test-out');
    out.textContent = '시험 중…';
    const t0 = Date.now();
    try {
      let text = '', first = 0;
      for await (const d of tutorStream('한 문장으로만 답한다.', [{ role: 'user', content: '연결 시험이에요. "연결됐어요"라고만 답해 주세요.' }])) { first ||= Date.now() - t0; text += d; }
      out.textContent = `됐어요: "${text.trim()}" · 첫 글자 ${(first / 1000).toFixed(1)}초`;
    } catch (e) { out.textContent = `실패: ${e.message}`; out.className = 'small err'; }
  };
  $('#sync').onclick = startSync;
  const forget = $('#forget');
  if (forget) forget.onclick = (e) => { e.preventDefault(); forgetPc(); toast('연결 정보를 지웠어요. 동기화를 누르면 다시 물어봐요.'); route(); };
  $('#export').onclick = async () => {
    closeSession();
    const body = JSON.stringify(resultBody());
    const name = `tutor-result-${isoDay()}.json`;
    const file = new File([body], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'AI 튜터 결과' }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    toast('파일을 내려받았어요. 드라이브에 올려 주세요.');
  };
  $('#clear').onclick = () => {
    if (!confirm('PC에 결과를 넣었나요? 이 휴대폰의 세션·채점·메모 기록을 비워요.')) return;
    log = { sessions: [], marks: [], memos: [] }; saveLog(); route();
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('online', () => { if (!location.hash || location.hash === '#/') route(); });
window.addEventListener('offline', () => { if (!location.hash || location.hash === '#/') route(); });
receivePack().then(route);
