import { CPU_HZ, DUTY, TRI_SEQ, NOISE_PERIOD, noteToHz } from './tables.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// advance(n) は n CPUサイクル進める。1サイクルずつ関数を呼ぶと重いので、まとめて進める。

class EnvChannel {
  constructor() {
    this.vol = 15;        // V
    this.env = 0;         // @e  0 = 固定音量、1〜15 = 減衰の速さ（小さいほど速い）
    this.decay = 15;
    this.div = 0;
    this.envStart = false;
    this.gate = false;
    this.mute = false;
  }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setEnv(v)    { this.env = clamp(v, 0, 15); }
  keyOn()      { this.gate = true; this.envStart = true; }
  keyOff()     { this.gate = false; }
  clockEnv() {                         // 240Hz
    if (this.envStart) {
      this.envStart = false;
      this.decay = 15;
      this.div = this.env - 1;
    } else if (--this.div < 0) {
      this.div = this.env - 1;
      if (this.decay > 0) this.decay--;
    }
  }
  level() { return this.env ? Math.round(this.decay * this.vol / 15) : this.vol; }
}

// CORE-4 Pulse — タイマーは CPU 2サイクルごと、8ステップ → CPU_HZ / (16 * (timer+1))
export class Pulse extends EnvChannel {
  constructor() { super(); this.timer = 400; this.count = 0; this.step = 0; this.duty = 2; }
  setDuty(v) { this.duty = v & 3; }
  setNote(n) { this.setHz(noteToHz(n)); }
  setHz(hz)  { this.timer = clamp(Math.round(CPU_HZ / (16 * hz)) - 1, 0, 2047); }
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += (this.timer + 1) * 2;
      this.step = (this.step + 1) & 7;
    }
  }
  output() {
    if (!this.gate || this.mute || this.timer < 8) return 0;   // timer < 8 は実機でも無音
    return DUTY[this.duty][this.step] ? this.level() : 0;
  }
}

// CORE-4 Triangle — 音量なし。CPU 1サイクルごと、32ステップ
export class Triangle {
  constructor() { this.timer = 400; this.count = 0; this.step = 0; this.gate = false; this.mute = false; this.hasVolume = false; }
  setNote(n) { this.setHz(noteToHz(n)); }
  setHz(hz)  { this.timer = clamp(Math.round(CPU_HZ / (32 * hz)) - 1, 0, 2047); }
  keyOn()  { this.gate = true; }
  keyOff() { this.gate = false; }
  setVolume() {}
  setDuty() {}
  setEnv() {}
  clockEnv() {}
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += this.timer + 1;
      if (this.gate) this.step = (this.step + 1) & 31;   // 止めると段の途中で固まる（実機の挙動）
    }
  }
  output() {
    if (this.mute) return 0;
    if (this.timer < 2) return 7.5;
    return TRI_SEQ[this.step];
  }
}

// CORE-4 Noise — 15bit LFSR
export class Noise extends EnvChannel {
  constructor() { super(); this.period = 4; this.short = false; this.lfsr = 1; this.count = 0; }
  setDuty(v) { this.short = (v & 1) === 1; }           // @1 で金属音（93ステップ周期）
  setNote(n) {
    // n0〜n15 は周期テーブルを直接指定。音名で書いた場合は高い音ほど周期を短く
    this.period = n < 16 ? n : clamp(Math.round((96 - n) / 4), 0, 15);
  }
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += NOISE_PERIOD[this.period];
      const bit = this.short ? 6 : 1;
      const fb = (this.lfsr & 1) ^ ((this.lfsr >> bit) & 1);
      this.lfsr = (this.lfsr >> 1) | (fb << 14);
    }
  }
  output() {
    if (!this.gate || this.mute) return 0;
    return (this.lfsr & 1) ? 0 : this.level();
  }
}

// EX-6 Pulse — デューティ 8段階 (duty+1)/16、エンベロープなし
export class ExPulse {
  constructor() { this.timer = 400; this.count = 0; this.step = 15; this.duty = 7; this.vol = 15; this.gate = false; this.mute = false; }
  setNote(n)   { this.setHz(noteToHz(n)); }
  setHz(hz)    { this.timer = clamp(Math.round(CPU_HZ / (16 * hz)) - 1, 0, 4095); }
  setDuty(v)   { this.duty = v & 7; }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setEnv() {}
  clockEnv() {}
  keyOn()  { this.gate = true; }
  keyOff() { this.gate = false; }
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += this.timer + 1;
      this.step = (this.step - 1) & 15;
    }
  }
  output() {
    if (!this.gate || this.mute) return 0;
    return this.step <= this.duty ? this.vol : 0;
  }
}

// EX-6 Saw — 累算器に rate を足していき、14ステップでリセット。rate が音量と音色を兼ねる
export class ExSaw {
  constructor() { this.timer = 400; this.count = 0; this.step = 0; this.acc = 0; this.rate = 30; this.gate = false; this.mute = false; }
  setNote(n)   { this.setHz(noteToHz(n)); }
  setHz(hz)    { this.timer = clamp(Math.round(CPU_HZ / (14 * hz)) - 1, 0, 4095); }
  setVolume(v) { this.rate = clamp(v, 0, 63); }      // 42 を超えると累算器が溢れて歪む
  setDuty() {}
  setEnv() {}
  clockEnv() {}
  keyOn()  { this.gate = true; }
  keyOff() { this.gate = false; }
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += this.timer + 1;
      this.step++;
      if (this.step === 14) {
        this.step = 0;
        this.acc = 0;
      } else if ((this.step & 1) === 0) {
        this.acc = (this.acc + this.rate) & 0xff;
      }
    }
  }
  output() {
    if (!this.gate || this.mute) return 0;
    return this.acc >> 3;                              // 上位5bit
  }
}

// WD-1（波形の音源）— 64 段の波形テーブル（各 0〜63）を 22bit の累算器で読む。周波数 = CPU_HZ × f / 2^22（f は 12bit）
// 音量 0〜15（実機のゲイン 0〜32 に換算）、マスター音量 @0〜@3（1, 2/3, 1/2, 2/5）。
// モジュレーション（周波数変調）：32 段の変調テーブル（各 0〜7）を速さ modSpeed で読み、深さ modDepth で音程を揺らす。
// 出力は実機と同じく 2kHz ほどのローパスを通す（丸い音になる）
export const WD1_MOD_STEP = [0, 1, 2, 4, null, -4, -2, -1];      // 4 はカウンタを 0 に戻す
const WD1_MASTER = [1, 2 / 3, 1 / 2, 2 / 5];
const WD1_LPF_HZ = 2000;
export const WD1_SINE = Array.from({ length: 64 }, (_, i) => Math.round(31.5 + 31.5 * Math.sin(2 * Math.PI * i / 64)));

// 長さの違う並びを n 段に引き伸ばす（近い段の値）
const stretch = (arr, n, max) => Array.from({ length: n }, (_, i) => clamp(Math.round(arr[Math.floor(i * arr.length / n)]), 0, max));

export class WaveDisk {
  constructor() {
    this.wave = WD1_SINE.slice();
    this.freq = 0; this.acc = 0; this.pos = 0;
    this.vol = 15; this.master = 0;
    this.modTable = new Array(32).fill(0);
    this.modDepth = 0; this.modSpeed = 0; this.modAcc = 0; this.modPos = 0; this.modCounter = 0;
    this.lp = 0; this.lpK = [];
    this.gate = false; this.mute = false;
  }
  setNote(n)   { this.setHz(noteToHz(n)); }
  setHz(hz)    { this.freq = clamp(Math.round(hz * 4194304 / CPU_HZ), 0, 4095); }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setDuty(v)   { this.master = v & 3; }
  setEnv() {}
  clockEnv() {}
  setWave(arr)     { if (arr?.length) this.wave = stretch(arr, 64, 63); }
  setModTable(arr) { if (arr?.length) this.modTable = stretch(arr, 32, 7); }
  setMod([depth = 0, speed = 0] = []) { this.modDepth = clamp(depth, 0, 63); this.modSpeed = clamp(speed, 0, 4095); }
  keyOn()  { this.gate = true; this.modCounter = 0; this.modPos = 0; this.modAcc = 0; }
  keyOff() { this.gate = false; }

  // 変調を掛けた周波数（実機の計算をそのまま）
  pitch() {
    if (!this.modDepth) return this.freq;
    let temp = this.modCounter * this.modDepth;
    let rem = temp & 0x0f;
    temp >>= 4;
    if (rem > 0 && (temp & 0x80) === 0) temp += this.modCounter < 0 ? -1 : 2;
    if (temp >= 192) temp -= 256;
    else if (temp < -64) temp += 256;
    temp *= this.freq;
    rem = temp & 0x3f;
    temp >>= 6;
    if (rem >= 32) temp += 1;
    return clamp(this.freq + temp, 0, 4095);
  }

  advance(n) {
    if (this.modSpeed && this.modDepth) {
      this.modAcc += this.modSpeed * n;
      while (this.modAcc >= 65536) {
        this.modAcc -= 65536;
        const step = WD1_MOD_STEP[this.modTable[this.modPos >> 1]];
        this.modCounter = step === null ? 0 : ((this.modCounter + step + 64) & 127) - 64;
        this.modPos = (this.modPos + 1) & 63;
      }
    }
    if (this.gate) {
      this.acc = (this.acc + this.pitch() * n) % 4194304;
      this.pos = this.acc >> 16;
    }
    const x = this.gate && !this.mute ? this.wave[this.pos] * Math.min(32, Math.round(this.vol * 32 / 15)) * WD1_MASTER[this.master] : 0;
    const k = this.lpK[n] ??= 1 - Math.exp(-2 * Math.PI * WD1_LPF_HZ * n / CPU_HZ);
    this.lp += (x - this.lp) * k;
  }
  output() { return this.lp; }      // 最大 63 × 32 = 2016
}

// Namco 163 — 最大 8ch。各チャンネルは 4bit（0〜15）の波形（4〜64 段）を読む。
// 実機はチャンネルを 15 CPU サイクルごとに1つずつ切り替えて鳴らす（時分割）。そのため
//   ・使うチャンネル数が多いほど、1ch あたりの音量は小さい（ここでは全チャンネルの平均で表す）
//   ・周波数 = CPU_HZ × f / (15 × 65536 × チャンネル数 × 波形の長さ)（f は 18bit）
export const WM8_MAX = 8;
export const WM8_SINE = Array.from({ length: 32 }, (_, i) => Math.round(7.5 + 7.5 * Math.sin(2 * Math.PI * i / 32)));

export class WaveMem {
  constructor() {
    this.count = WM8_MAX;
    this.channels = Array.from({ length: WM8_MAX }, () => new WaveMemChannel(this));
  }
  setCount(n) {
    this.count = clamp(n, 1, WM8_MAX);
    for (const c of this.channels) c.applyHz();
  }
  advance(n) { for (let i = 0; i < this.count; i++) this.channels[i].advance(n); }
  output() {
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.channels[i].output();
    return sum / this.count;         // 1ch の最大の振れ幅は (15 - 8) × 15 〜 (0 - 8) × 15
  }
}

export class WaveMemChannel {
  constructor(chip) {
    this.chip = chip;
    this.wave = WM8_SINE.slice();
    this.hz = 440; this.freq = 0; this.phase = 0;
    this.vol = 15; this.gate = false; this.mute = false;
    this.applyHz();
  }
  setNote(n)   { this.setHz(noteToHz(n)); }
  setHz(hz)    { this.hz = hz; this.applyHz(); }
  applyHz()    { this.freq = clamp(Math.round(this.hz * 15 * 65536 * this.chip.count * this.wave.length / CPU_HZ), 0, 262143); }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setDuty() {}
  setEnv() {}
  clockEnv() {}
  setWave(arr) {
    if (!arr?.length) return;
    this.wave = arr.slice(0, 64).map(v => clamp(Math.round(v), 0, 15));
    this.phase %= this.wave.length * 65536;
    this.applyHz();
  }
  keyOn()  { this.gate = true; }
  keyOff() { this.gate = false; }
  advance(n) {
    if (!this.gate) return;
    this.phase = (this.phase + this.freq * n / (15 * this.chip.count)) % (this.wave.length * 65536);
  }
  output() {
    if (!this.gate || this.mute) return 0;
    return (this.wave[Math.floor(this.phase / 65536)] - 8) * this.vol;
  }
}

// Sunsoft SQ-3（YM2149 系）— 矩形波 3ch。ノイズとエンベロープは 3ch で 1 つを共有する。
//   ・音程：周波数 = CPU_HZ / (32 × 周期)（周期は 12bit）
//   ・音量：4bit を内部の 5bit（0〜31）に直し、1 段 1.5dB の対数（4bit では 1 段 3dB）
//   ・ミキサー（@0〜@3）：0 = 矩形波、1 = ノイズ、2 = 両方、3 = どちらも切る（ブザーで使う）
//   ・ノイズ：17bit の LFSR、周期 0〜31（@n）
//   ・エンベロープ：32 段、形 0〜15。ブザー（@b 形,オクターブ）は、エンベロープの周期を音の高さに合わせて回し、のこぎり波・三角波のような太い音にする
export const SQ3_AMP = Array.from({ length: 32 }, (_, l) => (l === 0 ? 0 : Math.pow(2, (l - 31) / 4)));
const SQ3_ENV_STEP = 16;                 // エンベロープ 1 段あたり 16 × 周期 CPU サイクル（32 段で CPU_HZ / (512 × 周期) Hz）

export class Sq3 {
  constructor() {
    this.channels = Array.from({ length: 3 }, () => new Sq3Channel(this));
    this.noisePeriod = 16; this.noiseCount = 0; this.lfsr = 1; this.noiseBit = 1;
    this.envPeriod = 1000; this.envCount = 0;
    this.setEnvShape(0);
  }
  setNoisePeriod(v) { this.noisePeriod = clamp(v, 0, 31); }
  setEnvPeriod(p)   { this.envPeriod = clamp(Math.round(p), 1, 65535); }
  setEnvShape(shape) {
    this.envShape = shape & 15;
    this.envStep = 0;
    this.envAttack = (shape & 4) !== 0;
    this.envHolding = false;
    this.envCount = 0;
    this.envLevel = this.envAttack ? 0 : 31;
  }
  clockEnv() {
    if (this.envHolding) return;
    if (++this.envStep < 32) { this.envLevel = this.envAttack ? this.envStep : 31 - this.envStep; return; }
    const s = this.envShape, cont = s & 8, alt = s & 2, hold = s & 1;
    if (!cont) { this.envHolding = true; this.envLevel = 0; return; }
    if (hold) { this.envHolding = true; this.envLevel = (this.envAttack !== !!alt) ? 31 : 0; return; }
    if (alt) this.envAttack = !this.envAttack;
    this.envStep = 0;
    this.envLevel = this.envAttack ? 0 : 31;
  }
  advance(n) {
    this.noiseCount -= n;
    while (this.noiseCount < 0) {
      this.noiseCount += 16 * Math.max(1, this.noisePeriod);
      const bit = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 16);
      this.noiseBit = this.lfsr & 1;
    }
    this.envCount -= n;
    while (this.envCount < 0) {
      this.envCount += SQ3_ENV_STEP * this.envPeriod;
      this.clockEnv();
    }
    for (const c of this.channels) c.advance(n);
  }
  output() { return this.channels[0].output() + this.channels[1].output() + this.channels[2].output(); }   // 最大 3
}

export class Sq3Channel {
  constructor(chip) {
    this.chip = chip;
    this.period = 127; this.count = 0; this.bit = 1;
    this.vol = 15; this.mixer = 0;
    this.buzz = 0; this.buzzOct = 0; this.hz = 440;
    this.gate = false; this.mute = false;
  }
  setNote(n) { this.setHz(noteToHz(n)); }
  setHz(hz) {
    this.hz = hz;
    this.period = clamp(Math.round(CPU_HZ / (32 * hz)), 1, 4095);
    if (this.buzz) this.chip.setEnvPeriod(CPU_HZ / (512 * hz * Math.pow(2, this.buzzOct)));
  }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setDuty(v)   { this.mixer = v & 3; }
  setEnv() {}
  clockEnv() {}
  setNoisePeriod(v) { this.chip.setNoisePeriod(v); }
  // [形, オクターブ]。形 0 で解除
  setBuzzer([shape = 0, oct = 0] = []) {
    this.buzz = shape & 15;
    this.buzzOct = oct;
    if (this.buzz) this.setHz(this.hz);
  }
  keyOn() {
    this.gate = true;
    if (this.buzz) { this.chip.setEnvShape(this.buzz); this.setHz(this.hz); }
  }
  keyOff() { this.gate = false; }
  advance(n) {
    this.count -= n;
    while (this.count < 0) {
      this.count += 16 * this.period;
      this.bit ^= 1;
    }
  }
  output() {
    if (!this.gate || this.mute) return 0;
    const tone = this.mixer === 1 || this.mixer === 3 ? 1 : this.bit;
    const noise = this.mixer === 1 || this.mixer === 2 ? this.chip.noiseBit : 1;
    if (!(tone & noise)) return 0;
    const level = this.buzz ? this.chip.envLevel : (this.vol ? this.vol * 2 + 1 : 0);
    return SQ3_AMP[level];
  }
}

// FM6（FM 音源 系の FM 音源）— 6ch。2 オペレータ（モジュレータ → キャリア）の FM。
// 音色は 8 バイト（並びは下のとおり）。@1〜@15 は用意した音色、@0 は @k{…} で作った音色。
// 簡易版：エンベロープ（アタック・ディケイ・サステイン・リリース）、フィードバック、半波形、倍率、TL、AM・ビブラートの LFO まで。KSL・KSR は省く
//
// この 15 音色は、実機の内蔵音色データではなく、このプロジェクトで設計したもの。
// レジスタの意味（倍率・変調の深さ・帰還・半波形・エンベロープ）から狙いの音を組み立て、
// 鳴らして立ち上がり・伸び・倍音の重心を測って決めた。実機と同じ音にはならない。
//   0: モジュレータ  bit7 AM / bit6 ビブラート / bit5 持続する / bit0-3 倍率
//   1: キャリア      同上
//   2: モジュレータの TL（0〜63。大きいほど変調が浅い）
//   3: bit4 キャリア半波形 / bit3 モジュレータ半波形 / bit0-2 帰還
//   4: モジュレータ AR<<4 | DR      5: キャリア AR<<4 | DR
//   6: モジュレータ SL<<4 | RR      7: キャリア SL<<4 | RR
export const FM_PATCHES = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],   // 0 自作（@k{…}）
  [0x04, 0x01, 0x0A, 0x13, 0xF5, 0xF4, 0x46, 0x35],   // 1 ブザーっぽいベル
  [0x01, 0x01, 0x06, 0x03, 0xF7, 0xF5, 0x57, 0x46],   // 2 ギター
  [0x02, 0x01, 0x0C, 0x03, 0xF6, 0xF4, 0x56, 0x35],   // 3 エレピ
  [0x21, 0x61, 0x28, 0x00, 0xA3, 0xA2, 0x07, 0x07],   // 4 フルート
  [0x23, 0x21, 0x0E, 0x08, 0xD3, 0xD2, 0x17, 0x07],   // 5 クラリネット
  [0x21, 0xA1, 0x04, 0x04, 0xF4, 0xF3, 0x28, 0x18],   // 6 シンセ
  [0x21, 0x61, 0x06, 0x02, 0xC6, 0xC4, 0x28, 0x18],   // 7 トランペット
  [0x22, 0x21, 0x12, 0x00, 0xF0, 0xF0, 0x09, 0x09],   // 8 オルガン
  [0x07, 0x01, 0x0C, 0x00, 0xF4, 0xF3, 0x25, 0x14],   // 9 ベル
  [0x04, 0x81, 0x1A, 0x00, 0xF5, 0xF3, 0x35, 0x24],   // 10 ビブラフォン
  [0x04, 0x01, 0x0A, 0x02, 0xF7, 0xF6, 0x68, 0x57],   // 11 マリンバ
  [0x61, 0x62, 0x06, 0x03, 0xD5, 0xD4, 0x28, 0x18],   // 12 トゥッティ
  [0x00, 0x01, 0x0E, 0x02, 0xF5, 0xF4, 0x46, 0x35],   // 13 フレットレスベース
  [0x01, 0x00, 0x08, 0x04, 0xF4, 0xF3, 0x38, 0x28],   // 14 シンセベース
  [0xA2, 0xA1, 0x08, 0x03, 0x85, 0x64, 0x38, 0x28],   // 15 スイープ
];
export const FM_PATCH_NAMES = ['自作', 'ブザーっぽいベル', 'ギター', 'エレピ', 'フルート', 'クラリネット', 'シンセ', 'トランペット', 'オルガン', 'ベル', 'ビブラフォン', 'マリンバ', 'トゥッティ', 'フレットレスベース', 'シンセベース', 'スイープ'];
const FM_MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const FM_SIN = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(2 * Math.PI * i / 4096));
const fmWave = (phase, half) => {                      // phase は 1 周 = 1
  const v = FM_SIN[(Math.floor(phase * 4096) % 4096 + 4096) % 4096];
  return half && v < 0 ? 0 : v;
};
const dbGain = db => (db >= 96 ? 0 : Math.pow(10, -db / 20));
// レート 0〜15 → 96dB 動くのにかかる秒数（0 は動かない）
const fmAttackSec = r => (r === 0 ? Infinity : r === 15 ? 0 : 2.826 / Math.pow(2, r - 1));
const fmDecaySec = r => (r === 0 ? Infinity : 39.28 / Math.pow(2, r - 1));

function fmOperator(b, tl, ad, sr, half) {
  return { am: !!(b & 0x80), vib: !!(b & 0x40), sustained: !!(b & 0x20), mult: FM_MULT[b & 15], tl, ar: ad >> 4, dr: ad & 15, sl: sr >> 4, rr: sr & 15, half: !!half };
}
export function decodeFMPatch(p) {
  return {
    mod: fmOperator(p[0], p[2] & 63, p[4], p[6], p[3] & 8),
    car: fmOperator(p[1], 0, p[5], p[7], p[3] & 16),
    fb: p[3] & 7,
  };
}

// エンベロープ（dB。0 = 最大、96 = 無音）を dt 秒進める
function fmEnvelope(op, P, dt) {
  switch (op.stage) {
    case 'attack': {
      const t = fmAttackSec(P.ar);
      op.env = t === 0 ? 0 : op.env - 96 * dt / t;
      if (op.env <= 0) { op.env = 0; op.stage = 'decay'; }
      break;
    }
    case 'decay': {
      const target = P.sl * 3;
      op.env += 96 * dt / fmDecaySec(P.dr);
      if (op.env >= target) { op.env = target; op.stage = P.sustained ? 'sustain' : 'fade'; }
      break;
    }
    case 'fade':                                  // 持続しない音色：サステインレベルのあとも RR で下がる
    case 'release':
      op.env += 96 * dt / fmDecaySec(op.stage === 'release' && !P.rr ? 7 : P.rr);
      if (op.env >= 96) { op.env = 96; op.stage = 'off'; }
      break;
  }
}

export class FM6 {
  constructor() {
    this.channels = Array.from({ length: 6 }, () => new FMChannel(this));
    this.time = 0;
  }
  advance(n) {
    const dt = n / CPU_HZ;
    this.time += dt;
    const am = (1 + Math.sin(2 * Math.PI * 3.7 * this.time)) * 0.5 * 4.8;         // AM：0〜4.8dB
    const vib = Math.pow(2, Math.sin(2 * Math.PI * 6.4 * this.time) * 7 / 1200);   // ビブラート：±7 セント
    for (const c of this.channels) c.advance(dt, am, vib);
  }
  output() { let s = 0; for (const c of this.channels) s += c.output(); return s; }   // 1ch 最大 ±1
}

export class FMChannel {
  constructor(chip) {
    this.chip = chip;
    this.patchNo = 1; this.custom = FM_PATCHES[0].slice();
    this.hz = 440; this.vol = 15;
    this.mod = { phase: 0, env: 96, stage: 'off', out: 0, prev: 0 };
    this.car = { phase: 0, env: 96, stage: 'off' };
    this.out = 0;
    this.gate = false; this.mute = false;
    this.decode();
  }
  decode() { this.P = decodeFMPatch(this.patchNo === 0 ? this.custom : FM_PATCHES[this.patchNo]); }
  setNote(n)   { this.setHz(noteToHz(n)); }
  setHz(hz)    { this.hz = hz; }
  setVolume(v) { this.vol = clamp(v, 0, 15); }
  setDuty(v)   { this.patchNo = clamp(v, 0, 15); this.decode(); }      // @0〜@15 で音色
  setEnv() {}
  clockEnv() {}
  setPatch(arr) {
    if (arr?.length !== 8) return;
    this.custom = arr.map(v => clamp(Math.round(v), 0, 255));
    this.patchNo = 0;
    this.decode();
  }
  keyOn()  { this.gate = true; this.mod.stage = 'attack'; this.car.stage = 'attack'; this.mod.phase = 0; this.car.phase = 0; }
  keyOff() {
    this.gate = false;
    for (const op of [this.mod, this.car]) if (op.stage !== 'off') op.stage = 'release';
  }
  advance(dt, am, vib) {
    const { mod, car, P } = this;
    if (car.stage === 'off') { this.out = 0; return; }
    fmEnvelope(mod, P.mod, dt);
    fmEnvelope(car, P.car, dt);
    mod.phase = (mod.phase + this.hz * P.mod.mult * (P.mod.vib ? vib : 1) * dt) % 1;
    car.phase = (car.phase + this.hz * P.car.mult * (P.car.vib ? vib : 1) * dt) % 1;
    const fb = P.fb ? (mod.out + mod.prev) * 0.5 * Math.pow(2, P.fb - 7) : 0;
    const m = fmWave(mod.phase + fb, P.mod.half) * dbGain(mod.env + P.mod.tl * 0.75 + (P.mod.am ? am : 0));
    mod.prev = mod.out;
    mod.out = m;
    this.out = fmWave(car.phase + m, P.car.half) * dbGain(car.env + (15 - this.vol) * 3 + (P.car.am ? am : 0));
  }
  output() { return this.mute ? 0 : this.out; }
}

// SMP-1（CORE-4 の 5ch 目）— 1bit の差分サンプルを読み、7bit の DAC（0〜127）を ±2 ずつ動かす。音量は無い（hasVolume = false）。
// 音の高さで再生の速さを選ぶ：n0〜n15 は速さの段をそのまま、音名は a4 が最速（15）で半音下がるごとに 1 段遅い
// 発音のあとは、音を離してもサンプルの終わりまで鳴る（実機と同じ）
export const SMP_RATES = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

function makeSmpSamples() {
  const rate = CPU_HZ / SMP_RATES[15];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const render = (sec, fn) => {
    const n = Math.round(sec * rate), bits = new Uint8Array(n);
    let dac = 64, phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const x = fn(t, dt => { phase += dt; return phase; });
      const target = 64 + Math.max(-1, Math.min(1, x)) * 60;
      const b = target > dac ? 1 : 0;
      bits[i] = b;
      dac = clamp(dac + (b ? 2 : -2), 0, 127);
    }
    return bits;
  };
  let lastNoise = 0;
  return [
    { name: 'kick', label: 'キック', bits: render(0.22, (t, ph) => Math.sin(2 * Math.PI * ph((40 + 110 * Math.exp(-t * 30)) / rate)) * Math.exp(-t * 9)) },
    { name: 'snare', label: 'スネア', bits: render(0.18, (t, ph) => rnd() * Math.exp(-t * 18) * 0.8 + Math.sin(2 * Math.PI * ph(180 / rate)) * Math.exp(-t * 25) * 0.5) },
    { name: 'hat', label: 'ハイハット', bits: render(0.06, t => { const nz = rnd(), x = nz - lastNoise; lastNoise = nz; return x * Math.exp(-t * 60); }) },
    { name: 'tom', label: 'タム', bits: render(0.25, (t, ph) => Math.sin(2 * Math.PI * ph((90 + 60 * Math.exp(-t * 12)) / rate)) * Math.exp(-t * 10)) },
    { name: 'clap', label: 'クラップ', bits: render(0.2, t => rnd() * (t < 0.036 ? (Math.floor(t / 0.012) % 1 === 0 ? Math.exp(-((t % 0.012) * 250)) : 0) : Math.exp(-(t - 0.036) * 22))) },
  ];
}
export const SMP_SAMPLES = makeSmpSamples();

export class Sampler {
  constructor() {
    this.dac = 64; this.sample = 0; this.rate = 15;     // DAC は真ん中から（サンプルも 64 から作ってある）
    this.pos = -1; this.count = 0;
    this.gate = false; this.mute = false; this.hasVolume = false;
  }
  setNote(n)   { this.rate = n < 16 ? clamp(n, 0, 15) : clamp(n - 69 + 15, 0, 15); }
  setDuty(v)   { this.sample = clamp(v, 0, SMP_SAMPLES.length - 1); }     // @0〜@4 でサンプル
  setVolume() {}
  setEnv() {}
  clockEnv() {}
  keyOn() {
    this.gate = true;
    this.pos = 0;                  // DAC は前の値のまま続ける（64 に飛ばすと、その段差で「ボン」と鳴る）
    this.count = SMP_RATES[this.rate];
  }
  keyOff() { this.gate = false; }
  advance(n) {
    if (this.pos < 0) return;
    this.count -= n;
    const bits = SMP_SAMPLES[this.sample].bits;
    while (this.count <= 0) {
      this.count += SMP_RATES[this.rate];
      if (this.pos >= bits.length) { this.pos = -1; return; }
      if (bits[this.pos++]) { if (this.dac <= 125) this.dac += 2; }
      else if (this.dac >= 2) this.dac -= 2;
    }
  }
  output() { return this.mute ? 0 : this.dac; }
}
