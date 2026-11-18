// 딥 포커스 기록.
// 집중 구간 = 학습 화면이 앞에 있고, 최근에 입력·말하기·듣기가 있었던 시간.
// 구간 사이 틈이 1분 미만이면 이어 붙이고, 1~30분이면 돌아왔을 때 한 번 물어본다
// ("책 보고 있었어요?"). 30분이 넘으면 계획된 휴식(매매 등)으로 보고 묻지 않는다.
'use strict';

const BRIDGE_SEC = 60;
const LONG_BREAK_SEC = 30 * 60;

class FocusTracker {
  constructor({ segments, idleMinutes, deepMinutes, onAsk, onChange }) {
    this.segments = (segments || []).map(s => ({ s: s.s, e: s.e }));
    this.idleSec = idleMinutes * 60;
    this.deepSec = deepMinutes * 60;
    this.onAsk = onAsk;          // (틈 초, 대답 콜백(공부 중이었는지))
    this.onChange = onChange;
    this.lastActivity = this.now();
    this.on = false;             // 지금 집중 구간이 열려 있는지
    this.dirty = false;
    this.pendingAsk = null;
    this._activity = () => { this.lastActivity = this.now(); };
    this._events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'];
    this._events.forEach(ev => window.addEventListener(ev, this._activity, { passive: true }));
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  now() { return Math.floor(Date.now() / 1000); }

  stop() {
    clearInterval(this.timer);
    this._events.forEach(ev => window.removeEventListener(ev, this._activity));
    this.tick(true);
  }

  tick(closing = false) {
    const now = this.now();
    if (Speaker.busy || Mic.listening) this.lastActivity = now;   // 듣고 말하는 동안은 집중으로 본다
    const inFront = document.visibilityState === 'visible' && document.hasFocus();
    const idle = now - this.lastActivity >= this.idleSec;
    const active = !closing && inFront && !idle;
    const last = this.segments[this.segments.length - 1];

    if (active) {
      if (!this.on) {
        const gap = last ? now - last.e : Infinity;
        if (last && gap < BRIDGE_SEC) {
          // 잠깐 한눈판 정도는 같은 구간으로 본다
        } else {
          this.segments.push({ s: now, e: now });
          if (last && gap <= LONG_BREAK_SEC) this.ask(gap);
        }
        this.on = true;
      }
      this.segments[this.segments.length - 1].e = now;
      this.dirty = true;
    } else if (this.on) {
      // 입력이 없어서 끊긴 경우, 마지막 입력 시점까지만 집중으로 친다
      if (last && inFront && idle) last.e = Math.max(last.s, this.lastActivity);
      this.on = false;
      this.dirty = true;
      if (this.onChange) this.onChange(true);
      return;
    }
    if (this.onChange) this.onChange(false);
  }

  ask(gapSec) {
    if (!this.onAsk) return;
    const idx = this.segments.length - 1;
    this.pendingAsk = idx;
    this.onAsk(gapSec, (wasStudying) => {
      if (this.pendingAsk !== idx) return;
      this.pendingAsk = null;
      if (wasStudying && idx > 0 && this.segments[idx]) {
        // 책을 보고 있었다면 앞 구간과 이어 붙인다
        this.segments[idx - 1].e = this.segments[idx].e;
        this.segments.splice(idx, 1);
        this.dirty = true;
        if (this.onChange) this.onChange(true);
      }
    });
  }

  get focusSec() { return this.segments.reduce((a, s) => a + (s.e - s.s), 0); }
  get deepSec_() { return this.segments.reduce((a, s) => a + ((s.e - s.s) >= this.deepSec ? s.e - s.s : 0), 0); }
  get currentRunSec() {
    const last = this.segments[this.segments.length - 1];
    return this.on && last ? last.e - last.s : 0;
  }
  // 이탈 횟수 = 1~30분짜리 틈의 개수
  get awayCount() {
    let n = 0;
    for (let i = 1; i < this.segments.length; i++) {
      const gap = this.segments[i].s - this.segments[i - 1].e;
      if (gap >= BRIDGE_SEC && gap <= LONG_BREAK_SEC) n++;
    }
    return n;
  }
}
