// 음성 입력(누르고 말하기)과 음성 출력(문장 단위 읽기). 브라우저 기본 기능만 쓴다.
'use strict';

const Speaker = {
  voice: null,      // 한국어 음성
  enVoice: null,    // 영어 음성 (영어 단어·문장은 이 목소리로 읽는다)
  rate: 1.05,
  buf: '',
  pending: 0,

  // 좋은 음성 순서: 여러 언어를 자연스럽게 읽는 음성(Multilingual) > Natural > Online > 나머지
  rank(v) { return (/multilingual/i.test(v.name) ? 0 : /natural/i.test(v.name) ? 1 : /online/i.test(v.name) ? 2 : 3); },
  list(lang) {
    if (!('speechSynthesis' in window)) return [];
    return speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith(lang))
      .sort((a, b) => this.rank(a) - this.rank(b) || (lang === 'en' ? (b.lang === 'en-US') - (a.lang === 'en-US') : 0));
  },
  saved(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } },
  choose(key, name) { try { localStorage.setItem(key, name); } catch (_) { /* 저장이 안 돼도 이번에는 적용된다 */ } this.pick(); },
  pick() {
    const ko = this.list('ko'), en = this.list('en');
    this.voice = ko.find(v => v.name === this.saved('tts_ko')) || ko[0] || null;
    this.enVoice = en.find(v => v.name === this.saved('tts_en')) || en[0] || null;
  },

  init() {
    if (!('speechSynthesis' in window)) return;
    this.pick();
    speechSynthesis.addEventListener('voiceschanged', () => this.pick());
  },

  get busy() {
    return 'speechSynthesis' in window && (speechSynthesis.speaking || this.pending > 0);
  },

  clean(text) {
    return text.replace(/[*#`_>]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  // 숫자 뒤의 단위는 한국어로 읽게 바꾼다 (영어 음성으로 넘어가지 않게)
  UNITS: [['kN·m', '킬로뉴턴미터'], ['kN', '킬로뉴턴'], ['MPa', '메가파스칼'], ['GPa', '기가파스칼'], ['kPa', '킬로파스칼'],
    ['mm²', '제곱밀리미터'], ['cm²', '제곱센티미터'], ['m²', '제곱미터'], ['cm³', '세제곱센티미터'], ['m³', '세제곱미터'],
    ['mm', '밀리미터'], ['cm', '센티미터'], ['km', '킬로미터'], ['kg', '킬로그램'], ['kV', '킬로볼트'], ['mA', '밀리암페어']],
  units(text) {
    for (const [u, word] of this.UNITS) {
      const re = new RegExp('(?<=[0-9]) ?' + u.replace('·', '[·.]?') + '(?![A-Za-z])', 'g');
      text = text.replace(re, word);
    }
    return text.replace(/p[.] ?p[.]?/gi, '과거분사 ');      // 문법 설명의 p.p.
  },

  // 글을 한국어 토막과 영어 토막으로 나눈다. 영어 단어가 섞이면 그 부분만 영어 음성으로 읽는다.
  // 식에 쓰는 한두 글자 기호(P, L, Va, Mmax 등)는 한국어 음성에 둔다.
  split(text) {
    const parts = [];
    const re = /[A-Za-z][A-Za-z'’-]*(?:[ ,;:]+[A-Za-z][A-Za-z'’-]*)*/g;
    let last = 0, m;
    const push = (lang, s) => { if (!s.trim()) { if (parts.length) parts[parts.length - 1].text += s; return; }
      if (parts.length && parts[parts.length - 1].lang === lang) parts[parts.length - 1].text += s; else parts.push({ lang, text: s }); };
    while ((m = re.exec(text))) {
      const words = m[0].split(/[ ,;:]+/).filter(Boolean);
      const english = words.length >= 2 ? words.some(w => w.length >= 2) : (words[0].length >= 3 && !/^[A-Z]?[a-z]?max$|^[A-Z][a-z]?\d*$/.test(words[0]));
      if (!english) continue;
      push('ko', text.slice(last, m.index));
      push('en', m[0]);
      last = m.index + m[0].length;
    }
    push('ko', text.slice(last));
    return parts;
  },

  say(text) {
    const t = this.units(this.clean(text));
    if (!t || !('speechSynthesis' in window)) return;
    // 여러 언어를 읽는 음성이면 통째로 맡기고, 아니면 영어 부분만 영어 음성으로 넘긴다
    const whole = !this.enVoice || (this.voice && /multilingual/i.test(this.voice.name));
    const parts = whole ? [{ lang: 'ko', text: t }] : this.split(t);
    for (const p of parts) {
      if (!/[0-9A-Za-z가-힣]/.test(p.text)) continue;      // 기호뿐인 토막은 읽을 것이 없다
      const u = new SpeechSynthesisUtterance(p.text.trim());
      const en = p.lang === 'en';
      u.lang = en ? (this.enVoice.lang || 'en-US') : 'ko-KR';
      const v = en ? this.enVoice : this.voice;
      if (v) u.voice = v;
      u.rate = en ? Math.min(this.rate, 1) : this.rate;      // 영어는 조금 천천히
      this.pending++;
      u.onend = u.onerror = () => { this.pending = Math.max(0, this.pending - 1); };
      speechSynthesis.speak(u);
    }
  },

  // 글자가 흘러들어오는 대로 넣으면, 문장이 끝날 때마다 바로 읽기 시작한다.
  feed(delta) {
    this.buf += delta;
    let m;
    while ((m = this.buf.match(/^[\s\S]*?(?:[.!?](?=\s)|\n)/))) {
      this.say(m[0]);
      this.buf = this.buf.slice(m[0].length);
    }
  },

  flush() {
    if (this.buf.trim()) this.say(this.buf);
    this.buf = '';
  },

  stop() {
    this.buf = '';
    this.pending = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  },
};

const Mic = {
  Rec: window.SpeechRecognition || window.webkitSpeechRecognition,
  rec: null,
  listening: false,
  finalText: '',
  interim: '',

  get supported() { return !!this.Rec; },

  // onInterim(지금까지 들은 글). 실패하면 onError(코드).
  start(onInterim, onError) {
    if (!this.supported || this.listening) return false;
    this.finalText = '';
    this.interim = '';
    const rec = new this.Rec();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      this.interim = interim;
      if (onInterim) onInterim((this.finalText + interim).trim());
    };
    this.lastError = null;
    rec.onerror = (e) => { this.lastError = e.error; if (onError && e.error !== 'aborted' && e.error !== 'no-speech') onError(e.error); };
    rec.onend = () => { this.listening = false; if (this._resolve) this._resolve(); };
    try { rec.start(); } catch (_) { return false; }
    this.rec = rec;
    this.listening = true;
    return true;
  },

  // 듣기를 끝내고 들은 글을 돌려준다.
  stop() {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        this._resolve = null;
        clearTimeout(timer);
        resolve((this.finalText + this.interim).trim());
      };
      // 인식이 이미 끝나 있으면(오류·자동 종료) 지금까지 들은 것만 돌려준다
      if (!this.rec || !this.listening) return done();
      timer = setTimeout(done, 2000);   // 마지막 결과가 늦게 오는 경우를 기다린다
      this._resolve = done;
      try { this.rec.stop(); } catch (_) { done(); }
    });
  },
};

// 마이크에 실제로 소리가 들어오는지 보는 수준계. 음성 인식이 안 될 때 원인을 가른다.
const Meter = {
  stream: null, ctx: null, raf: 0, peak: 0, error: null,
  async start(onLevel) {
    this.peak = 0;
    this.error = null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.error = e.name;   // NotAllowedError(권한 꺼짐), NotFoundError(마이크 없음) 등
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    this.ctx.createMediaStreamSource(this.stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let max = 0;
      for (const v of buf) max = Math.max(max, Math.abs(v - 128));
      const level = Math.min(1, max / 60);
      this.peak = Math.max(this.peak, level);
      onLevel(level);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  },
  stop() {
    cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = null;
  },
};

// 짧은 확인음: 듣기 시작(높게), 끝(낮게), 메모 저장(두 번)
const Beep = {
  ctx: null,
  tone(freq, ms = 70, when = 0) {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      const t = this.ctx.currentTime + when;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + ms / 1000 + 0.02);
    } catch (_) { /* 소리가 안 나도 기능에는 지장 없다 */ }
  },
  start() { this.tone(880); },
  end() { this.tone(520); },
  saved() { this.tone(660, 60); this.tone(880, 60, 0.09); },
};

Speaker.init();
