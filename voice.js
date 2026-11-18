// 음성 입력(누르고 말하기)과 음성 출력(문장 단위 읽기). 브라우저 기본 기능만 쓴다.
'use strict';

const Speaker = {
  voice: null,
  rate: 1.05,
  buf: '',
  pending: 0,

  init() {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const ko = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('ko'));
      // Edge의 'Natural' 음성이 가장 자연스럽다. 없으면 온라인 음성, 그다음 아무 한국어 음성.
      this.voice = ko.find(v => /natural/i.test(v.name)) || ko.find(v => /online/i.test(v.name)) || ko[0] || null;
    };
    pick();
    speechSynthesis.addEventListener('voiceschanged', pick);
  },

  get busy() {
    return 'speechSynthesis' in window && (speechSynthesis.speaking || this.pending > 0);
  },

  clean(text) {
    return text.replace(/[*#`_>]/g, ' ').replace(/\s+/g, ' ').trim();
  },

  say(text) {
    const t = this.clean(text);
    if (!t || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'ko-KR';
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    this.pending++;
    u.onend = u.onerror = () => { this.pending = Math.max(0, this.pending - 1); };
    speechSynthesis.speak(u);
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
