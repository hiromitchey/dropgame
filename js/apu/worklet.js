import { CPU_HZ, FRAME_PERIOD, TPQ, noteToHz } from './tables.js';
import { Pulse, Triangle, Noise, ExPulse, ExSaw, WaveDisk, WaveMem, WM8_MAX, Sq3, FM6, Sampler } from './channels.js';
import { chipOf, chipCount } from './chips.js';

const EX6_GAIN = 0.5;
const WD1_GAIN = 0.18 / 2016;    // WD-1 の最大音量 ≒ CORE-4 の矩形波 1ch の最大音量くらい
const FM6_GAIN = 0.11;         // FM6 の 1ch（最大 ±1）。メロディで鳴らして CORE-4 の矩形波（V12）と同じくらい
const SQ3_GAIN = 0.24;          // SQ-3 の 1ch（V13）の音の大きさ ≒ CORE-4 の矩形波（V12）くらい
const WM8_GAIN = 0.6 / 225;    // 4ch で使ったとき 1ch の音量 ≒ EX-6 の矩形波くらい（数を増やすと平均で小さく、1〜2ch だと大きい）
const OUT_GAIN = 2;         // ミックス後は ±0.3 程度しか振れないので持ち上げる
const CHUNK = 10;           // 1サンプル（約40 CPUサイクル）を4分割して平均する。エイリアスを抑える
const MACRO_PERIOD = CPU_HZ / 60;

function mixCore(p1, p2, tri, noise, dmc = 0) {
  const p = p1 + p2;
  const pulseOut = p === 0 ? 0 : 95.88 / (8128 / p + 100);
  const tnd = tri / 8227 + noise / 12241 + dmc / 22638;
  const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
  return pulseOut + tndOut;
}

// 楽器 — 60Hz で音量・デューティ・ピッチを書き換える。実機のサウンドドライバがやっていたこと
class Voice {
  constructor(chip) {
    this.chip = chip;
    this.vol = chip.rate ?? chip.vol ?? 15;
    this.venv = null;       // @v{...} 音量の推移（最後の値を保持）
    this.denv = null;       // @d{...} デューティの推移
    this.rel = 0;           // @r  ノートオフ後、何フレームごとに音量を1下げるか（0 = 即切る）
    this.vib = null;        // @m  [遅延フレーム, 深さ(セント), 1周のフレーム数]
    this.penv = null;       // @p{...} 音程の推移（半音、最後の値を保持）
    this.arp = null;        // @a{...} アルペジオ（半音、繰り返す）
    this.on = false;
    this.releasing = false;
    this.frame = 0;
    this.relFrame = 0;
    this.note = 60;
  }

  noteOn(n) {
    this.note = n;
    this.frame = 0;
    this.relFrame = 0;
    this.releasing = false;
    this.on = true;
    this.chip.setNote(n);
    this.clock();
    this.chip.keyOn();
  }

  noteOff() {
    if (!this.on) return;
    if (this.rel > 0 && this.chip.hasVolume !== false) { this.releasing = true; this.relFrame = 0; }
    else this.kill();
  }

  kill() {
    this.on = false;
    this.releasing = false;
    this.chip.keyOff();
  }

  clock() {
    if (!this.on) return;
    const f = this.frame++;
    let v = this.venv ? this.venv[Math.min(f, this.venv.length - 1)] : 15;
    if (this.releasing) {
      v -= Math.floor(++this.relFrame / this.rel);
      if (v <= 0) { this.kill(); return; }
    }
    this.chip.setVolume(Math.round(v * this.vol / 15));
    if (this.denv) this.chip.setDuty(this.denv[Math.min(f, this.denv.length - 1)]);
    // 音程：音程の推移 ＋ アルペジオ ＋ ビブラート。どれかがあるときだけ毎フレーム設定し直す
    if (this.penv || this.arp || this.vib) {
      const bend = (this.penv ? this.penv[Math.min(f, this.penv.length - 1)] : 0)
        + (this.arp ? this.arp[f % this.arp.length] : 0);
      let cents = 0;
      if (this.vib) {
        const [delay, depth, speed] = this.vib;
        const t = f - delay;
        cents = t < 0 ? 0 : depth * Math.sin(2 * Math.PI * t / speed);
      }
      if (this.chip.setHz) {
        this.chip.setHz(noteToHz(this.note + bend + cents / 100));
      } else {
        // noi：周期のずれとして効かせる（n0〜n15 で書いた音はその範囲に収める）
        const v = Math.round(this.note + bend);
        this.chip.setNote(this.note < 16 ? Math.max(0, Math.min(15, v)) : v);
      }
    }
  }
}

class ChiptuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = {};
    this.loop = true;
    this.masterGain = 0.7;
    this.ex6On = true;        // EX-6 を使うか（使わない曲では計算もミックスもしない）
    this.wd1On = true;         // WD-1 を使うか
    this.wm8On = true;        // WaveMem を使うか
    this.sq3On = true;         // SQ-3 を使うか
    this.fm6On = true;        // FM6 を使うか
    this.smpOn = true;         // SMP-1 を使うか
    this.wm8Count = WM8_MAX; // WaveMem のチャンネル数（時分割の数。音程と音量に効く）
    this.cyclesPerSample = CPU_HZ / sampleRate;
    this.cycAcc = 0;
    this.frameCount = FRAME_PERIOD;
    this.macroCount = MACRO_PERIOD;
    this.last = 0;

    // 実機の出力段に近いフィルタ：HPF 90Hz（直流カット）+ LPF 14kHz
    const dt = 1 / sampleRate;
    const rcHp = 1 / (2 * Math.PI * 90), rcLp = 1 / (2 * Math.PI * 14000);
    this.hpA = rcHp / (rcHp + dt);
    this.lpB = dt / (rcLp + dt);
    this.hpX = 0; this.hpY = 0; this.lpY = 0;

    this.posEvery = Math.round(sampleRate / 60);   // 画面側で音符を光らせるので細かめに
    this.posCount = 0;

    this.reset();
    this.settleFilter();
    this.port.onmessage = e => this.onMessage(e.data);
  }

  // 直流カットのフィルタを、今の出力の値に合わせる。
  // 三角波（止まっている段の値）や SMP-1（DAC の値）は無音でも一定の値を出しているので、合わせないと再生を始めた瞬間に
  // その段差がフィルタを通って「ボン」と鳴る。鳴っている途中で呼んでも、フィルタの出力はなめらかにつながる
  settleFilter() {
    const x = this.mix();
    this.hpX = x;
    this.last = x;
  }

  reset() {
    this.ch = {
      p1: new Pulse(), p2: new Pulse(), tri: new Triangle(), noi: new Noise(),
      e1: new ExPulse(), e2: new ExPulse(), saw: new ExSaw(),
      wd: new WaveDisk(),
    };
    this.wm8 = new WaveMem();
    this.wm8.setCount(this.wm8Count);
    this.wm8.channels.forEach((c, i) => { this.ch[`w${i + 1}`] = c; });
    this.sq3 = new Sq3();
    this.sq3.channels.forEach((c, i) => { this.ch[`s${i + 1}`] = c; });
    this.fm6 = new FM6();
    this.fm6.channels.forEach((c, i) => { this.ch[`f${i + 1}`] = c; });
    this.ch.smp = new Sampler();
    this.voices = {};
    for (const k in this.ch) {
      this.ch[k].mute = !!this.muted[k];
      this.voices[k] = new Voice(this.ch[k]);
    }
    this.voiceList = Object.values(this.voices);
    this.events = [];
    this.evIdx = 0;
    this.tick = 0;
    this.length = 0;
    this.loopStart = 0;
    this.loopIdx = 0;
    this.tickAcc = 0;
    this.playing = false;
    this.previewLeft = {};     // 試聴中のチャンネル → 止めるまでの残りサンプル数
    this.setTempo(120);
  }

  onMessage(m) {
    switch (m.type) {
      case 'play':
        this.reset();
        this.events = m.events;
        this.length = m.length;
        this.loopStart = m.loopStart ?? 0;
        this.loopIdx = this.events.findIndex(e => e.tick >= this.loopStart);
        if (this.loopIdx < 0) this.loopIdx = this.events.length;
        this.loop = m.loop;
        if (m.chips) {
          this.ex6On = chipCount(m.chips, 'ex6') > 0;
          this.wd1On = chipCount(m.chips, 'wd1') > 0;
          this.wm8On = chipCount(m.chips, 'wm8') > 0;
          if (this.wm8On) { this.wm8Count = chipCount(m.chips, 'wm8'); this.wm8.setCount(this.wm8Count); }
          this.sq3On = chipCount(m.chips, 'sq3') > 0;
          this.fm6On = chipCount(m.chips, 'fm6') > 0;
          this.smpOn = chipCount(m.chips, 'smp') > 0;
        }
        this.playing = m.length > 0;
        if (m.from > 0 && m.from < m.length) this.seek(m.from);
        this.settleFilter();
        break;
      case 'preview': {
        const v = this.voices[m.ch];
        if (!v) break;
        if (chipOf(m.ch) === 'ex6') this.ex6On = true;     // 試聴するチャンネルのチップは鳴らす
        if (chipOf(m.ch) === 'wd1') this.wd1On = true;
        if (chipOf(m.ch) === 'wm8') this.wm8On = true;
        if (chipOf(m.ch) === 'sq3') this.sq3On = true;
        if (chipOf(m.ch) === 'fm6') this.fm6On = true;
        if (chipOf(m.ch) === 'smp') this.smpOn = true;
        this.settleFilter();                                 // チップを使い始めたときの段差で鳴らないように
        for (const e of m.setup) if (e.type !== 'tempo') this.apply(e);
        v.noteOn(m.midi);
        this.previewLeft[m.ch] = Math.round(m.seconds * sampleRate);
        break;
      }
      case 'stop':
        this.allOff();
        this.playing = false;
        break;
      case 'gain': this.masterGain = m.v; break;
      case 'loop': this.loop = m.on; break;
      case 'mute':
        this.muted[m.ch] = m.on;
        if (this.ch[m.ch]) this.ch[m.ch].mute = m.on;
        this.settleFilter();                                 // 三角波などを止めた・戻したときの段差で鳴らないように
        break;
    }
  }

  allOff() { for (const v of this.voiceList) v.kill(); }

  // 途中から始める：それより前の設定（音量・音色・テンポ）だけ順に反映し、音は鳴らさない
  seek(from) {
    let i = 0;
    for (; i < this.events.length && this.events[i].tick < from; i++) {
      const e = this.events[i];
      if (e.type !== 'note' && e.type !== 'off') this.apply(e);
    }
    this.evIdx = i;
    this.tick = from;
  }

  setTempo(bpm) { this.ticksPerSample = bpm * TPQ / 60 / sampleRate; }

  seqTick() {
    if (this.tick >= this.length) {
      if (!this.loop) { this.allOff(); this.playing = false; return; }
      this.tick = this.loopStart;          // * があればそこへ戻る
      this.evIdx = this.loopIdx;
    }
    const ev = this.events;
    while (this.evIdx < ev.length && ev[this.evIdx].tick <= this.tick) this.apply(ev[this.evIdx++]);
    this.tick++;
  }

  apply(e) {
    if (e.type === 'tempo') { this.setTempo(e.value); return; }
    const v = this.voices[e.ch];
    if (!v) return;
    switch (e.type) {
      case 'note': v.noteOn(e.value); break;
      case 'off':  v.noteOff(); break;
      case 'vol':  v.vol = e.value; break;
      case 'duty': v.denv = null; v.chip.setDuty(e.value); break;
      case 'env':  v.chip.setEnv(e.value); break;
      case 'venv': v.venv = e.value.length ? e.value : null; break;
      case 'denv': v.denv = e.value.length ? e.value : null; break;
      case 'rel':  v.rel = e.value; break;
      case 'vib':  v.vib = e.value[1] ? [e.value[0], e.value[1], Math.max(1, e.value[2] ?? 8)] : null; break;
      case 'penv': v.penv = e.value.length ? e.value : null; break;
      case 'arp':  v.arp = e.value.length ? e.value : null; break;
      case 'wave':     v.chip.setWave?.(e.value); break;       // WD-1 だけ
      case 'modtable': v.chip.setModTable?.(e.value); break;
      case 'fdsmod':   v.chip.setMod?.(e.value); break;
      case 'buzz':     v.chip.setBuzzer?.(e.value); break;      // SQ-3 だけ
      case 'noise5b':  v.chip.setNoisePeriod?.(e.value); break;
      case 'fmpatch':  v.chip.setPatch?.(e.value); break;       // FM6 だけ
    }
  }

  mix() {
    const { p1, p2, tri, noi, e1, e2, saw } = this.ch;
    const core = mixCore(p1.output(), p2.output(), tri.output(), noi.output(), this.smpOn ? this.ch.smp.output() : 0);
    const ex6 = this.ex6On ? (e1.output() + e2.output() + saw.output()) / 61 * EX6_GAIN : 0;
    const wd1 = this.wd1On ? this.ch.wd.output() * WD1_GAIN : 0;
    const wm8 = this.wm8On ? this.wm8.output() * WM8_GAIN : 0;
    const sq3 = this.sq3On ? this.sq3.output() * SQ3_GAIN : 0;
    const fm6 = this.fm6On ? this.fm6.output() * FM6_GAIN : 0;
    return core + ex6 + wd1 + wm8 + sq3 + fm6;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const { p1, p2, tri, noi, e1, e2, saw } = this.ch;

    for (let i = 0; i < out.length; i++) {
      if (this.playing) {
        this.tickAcc += this.ticksPerSample;
        while (this.tickAcc >= 1 && this.playing) { this.tickAcc -= 1; this.seqTick(); }
      }

      this.cycAcc += this.cyclesPerSample;
      let n = this.cycAcc | 0;
      this.cycAcc -= n;

      let sum = 0, total = 0;
      while (n > 0) {
        const c = n < CHUNK ? n : CHUNK;
        n -= c;
        p1.advance(c); p2.advance(c); tri.advance(c); noi.advance(c);
        if (this.ex6On) { e1.advance(c); e2.advance(c); saw.advance(c); }
        if (this.wd1On) this.ch.wd.advance(c);
        if (this.wm8On) this.wm8.advance(c);
        if (this.sq3On) this.sq3.advance(c);
        if (this.fm6On) this.fm6.advance(c);
        if (this.smpOn) this.ch.smp.advance(c);
        this.frameCount -= c;
        if (this.frameCount <= 0) {
          this.frameCount += FRAME_PERIOD;
          p1.clockEnv(); p2.clockEnv(); noi.clockEnv();
        }
        this.macroCount -= c;
        if (this.macroCount <= 0) {
          this.macroCount += MACRO_PERIOD;
          for (const v of this.voiceList) v.clock();
        }
        sum += this.mix() * c;
        total += c;
      }
      const x = total ? sum / total : this.last;
      this.last = x;

      const hp = this.hpA * (this.hpY + x - this.hpX);
      this.hpX = x; this.hpY = hp;
      this.lpY += this.lpB * (hp - this.lpY);
      out[i] = this.lpY * this.masterGain * OUT_GAIN;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    for (const ch in this.previewLeft) {
      this.previewLeft[ch] -= out.length;
      if (this.previewLeft[ch] <= 0) {
        delete this.previewLeft[ch];
        this.voices[ch].noteOff();
      }
    }

    this.posCount += out.length;
    if (this.posCount >= this.posEvery) {
      this.posCount = 0;
      this.port.postMessage({ type: 'pos', tick: this.tick, length: this.length, playing: this.playing });
    }
    return true;     // false を返すと止まる
  }
}

registerProcessor('chiptune', ChiptuneProcessor);
