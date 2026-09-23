import { TPQ } from './tables.js';
import { CHANNELS, chipOf } from './chips.js';

export { CHANNELS };
const WHOLE = TPQ * 4;
// 拍子 M3/4 を読む（展開後の文字列から）。@m（ビブラート）と dmc の m は除く
const METER_RE = /(?<![@\w])m\s*(\d+)\s*\/\s*(\d+)/g;
const meterTicks = (a, b) => (b > 0 && a > 0 && Number.isInteger(WHOLE * a / b) ? WHOLE * a / b : null);
const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// ループの目印（展開した文字列にだけ入る）。ITER は「ここから k 回目」、LOOP_END は「ループの終わり」。
// 位置の配列には ps＝'[' の元の位置、pe＝回数（k または n）を入れ、解析で tick を記録する
const ITER = '', LOOP_END = '';

// 同じ tick では off → 設定 → note の順に処理する（連続した同じ音を鳴らし直せるように）
const PRIORITY = { off: 0, note: 2 };

// 展開しても「元の文字列のどこから来た文字か」を失わないよう、文字ごとに元の範囲 [ps, pe) を持ち運ぶ。
// 再生中の音符を入力欄で光らせるのに使う
const makeSrc = s => ({ s, ps: Array.from(s, (_, k) => k), pe: Array.from(s, (_, k) => k + 1) });
const blank = m => m.replace(/[^\n]/g, ' ');     // 削る代わりに空白で埋めて、位置をずらさない

// $name = ... の定義を全チャンネルから集める（どのチャンネルに書いても全体で使える）
function collectMacros(set) {
  const defs = {}, stripped = {};
  for (const ch of CHANNELS) {
    if (!set[ch]) continue;
    stripped[ch] = set[ch]
      .toLowerCase()
      .replace(/;[^\n]*/g, blank)
      .replace(/^[ \t]*\$(\w+)[ \t]*=(.*)$/gm, (m, name, body) => { defs[name] = body; return blank(m); });
  }
  return { defs, stripped };
}

// マクロの中身は、呼び出した $name の位置から来たものとして扱う
function expandMacros(src, defs, ch, errors) {
  for (let depth = 0; depth < 8 && src.s.includes('$'); depth++) {
    let s = '', ps = [], pe = [], last = 0;
    for (const m of src.s.matchAll(/\$(\w+)/g)) {
      s += src.s.slice(last, m.index);
      ps = ps.concat(src.ps.slice(last, m.index));
      pe = pe.concat(src.pe.slice(last, m.index));
      let body = ' ';
      if (m[1] in defs) body = ` ${defs[m[1]]} `;
      else errors.push(`${ch}: 未定義のマクロ $${m[1]}`);
      const a = src.ps[m.index], b = src.pe[m.index + m[0].length - 1];
      s += body;
      for (let k = 0; k < body.length; k++) { ps.push(a); pe.push(b); }
      last = m.index + m[0].length;
    }
    s += src.s.slice(last);
    ps = ps.concat(src.ps.slice(last));
    pe = pe.concat(src.pe.slice(last));
    src = { s, ps, pe };
  }
  return src;
}

// [ ... ]n を内側から展開する（n 省略時は2回）
function expandLoops(src) {
  const re = /\[([^\[\]]*)\](\d*)/;
  let m;
  while ((m = re.exec(src.s))) {
    const n = m[2] === '' ? 2 : +m[2];
    const a = m.index + 1, b = a + m[1].length, end = m.index + m[0].length;
    let s = src.s.slice(0, m.index), ps = src.ps.slice(0, m.index), pe = src.pe.slice(0, m.index);
    const open = src.ps[m.index];
    for (let k = 0; k < n; k++) {
      s += ITER;
      ps.push(open);
      pe.push(k);
      s += m[1];
      ps = ps.concat(src.ps.slice(a, b));
      pe = pe.concat(src.pe.slice(a, b));
    }
    s += LOOP_END;
    ps.push(open);
    pe.push(n);
    s += src.s.slice(end);
    ps = ps.concat(src.ps.slice(end));
    pe = pe.concat(src.pe.slice(end));
    src = { s, ps, pe };
  }
  return src;
}

// ctx：他のチャンネルの参照 {p1 13-20 >16} を読むための情報（1回目の解析結果）。null なら参照は休符として読む
function parseChannel(ch, src, errors, ctx = null, bar = WHOLE) {
  const refs = new Set();      // このチャンネルが参照しているチャンネル
  const s = src.s;
  const events = [];
  const notes = [];
  // 改行の位置（元のテキスト上）→ その時点の状態。-1 は先頭。ピアノロールの打ち込みで行を置き換えるのに使う
  const lines = new Map([[-1, { tick: 0, oct: 4, len: WHOLE / 4, q: 8 }]]);
  // ループの実際の範囲：{ pos（'[' の位置）, n, start, end, iters: [各回の開始 tick] }
  const loops = [];
  const openLoops = new Map();
  const markLoop = (c, pos, v) => {
    if (c === ITER) {
      if (v === 0) {
        const inst = { pos, n: 0, start: tick, end: tick, iters: [], startState: { oct, len, q } };
        openLoops.set(pos, inst);
        loops.push(inst);
      }
      openLoops.get(pos)?.iters.push(tick);
    } else {
      const inst = openLoops.get(pos);
      if (inst) { inst.n = v; inst.end = tick; inst.endState = { oct, len, q }; openLoops.delete(pos); }
    }
  };
  let i = 0, tick = 0, oct = 4, len = WHOLE / 4, q = 8, tie = false, lastNote = null, loopTick = null;

  const num = () => {
    const m = /^\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return +m[0];
  };
  const list = () => {
    const m = /^\d+(\s*,\s*\d+)*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].split(',').map(Number);
  };
  const braces = () => {
    if (s[i] !== '{') return null;
    const j = s.indexOf('}', i);
    if (j < 0) { i = s.length; return null; }
    const arr = s.slice(i + 1, j).split(/[\s,]+/).filter(Boolean).map(Number);
    i = j + 1;
    return arr.some(Number.isNaN) ? null : arr;
  };
  const length = (fallback) => {
    const n = num();
    let l = n ? WHOLE / n : fallback, add = l;
    while (s[i] === '.') { add /= 2; l += add; i++; }
    return Math.round(l);
  };
  // from：設定を書いた元の文字の位置（マクロの中なら $名前 を呼んだ位置）。画面で「どのマクロの設定か」を出すのに使う
  let tokenStart = 0;
  const set = (type, value) => events.push({ tick, ch, type, value, from: src.ps[tokenStart] });
  const note = (midi, l, st) => {
    const from = src.ps[st], to = src.pe[i - 1];
    if (tie && lastNote) {
      lastNote.len += l;
      if (to > lastNote.to) lastNote.to = to;
    } else {
      lastNote = { tick, midi, len: l, q, from, to };
      notes.push(lastNote);
    }
    tie = false;
    tick += l;
  };

  while (i < s.length) {
    const c = s[i];
    const st = i;
    tokenStart = i;
    if (c === ITER || c === LOOP_END) { markLoop(c, src.ps[i], src.pe[i]); i++; continue; }
    if (c in SEMI) {
      i++;
      let semi = SEMI[c];
      while (s[i] === '+' || s[i] === '#' || s[i] === '-') semi += s[i++] === '-' ? -1 : 1;
      const l = length(len);
      note((oct + 1) * 12 + semi, l, st);
    } else if (c === 'n') {
      i++;
      const v = num();
      if (v === null) { errors.push(`${ch}: n の後に数字がない`); continue; }
      let l = len;
      if (s[i] === ',') { i++; l = length(len); }
      note(v, l, st);
    } else if (c === 'r') {
      i++;
      tick += length(len);
      tie = false;
      lastNote = null;
    } else if (c === 'o') { i++; oct = num() ?? oct; }
    else if (c === '<') { i++; oct--; }
    else if (c === '>') { i++; oct++; }
    else if (c === 'l') { i++; len = length(len); }
    else if (c === 't') { i++; const v = num(); if (v) set('tempo', v); }
    else if (c === 'v') { i++; const v = num(); if (v !== null) set('vol', v); }
    else if (c === 'q') { i++; const v = num(); if (v !== null) q = Math.min(8, Math.max(1, v)); }
    else if (c === '@') {
      i++;
      const k = s[i];
      if (k === 'e') { i++; const v = num(); if (v !== null) set('env', v); }
      else if (k === 'v' || k === 'd' || k === 'p' || k === 'a') {
        // @v{} 音量の推移 ／ @d{} デューティの推移 ／ @p{} 音程の推移（半音） ／ @a{} アルペジオ（半音、繰り返す）
        i++;
        const arr = braces();
        if (arr) set({ v: 'venv', d: 'denv', p: 'penv', a: 'arp' }[k], arr);
        else errors.push(`${ch}: @${k} の後は {数字 数字 ...}`);
      }
      else if (k === 'w') {
        // @w{…} 波形。WD-1：0〜63 を並べる（64 個でなければ引き伸ばす） ／ WaveMem：0〜15 を 4〜64 個（並べた長さがそのまま波形の長さ）
        i++;
        const arr = braces();
        const isWm8 = chipOf(ch) === 'wm8';
        if (!arr?.length) errors.push(`${ch}: @w の後は {数字を並べる}`);
        else if (ch !== 'wd' && !isWm8) errors.push(`${ch}: @w（波形）は wd と w1〜w8 だけで使える`);
        else if (isWm8 && arr.length > 64) errors.push(`${ch}: WM-8 の波形は 64 個まで`);
        else set('wave', arr);
      }
      else if (k === 'f') {
        // @f{…} WD-1 の変調テーブル（0〜7 を並べる） ／ @f深さ,速さ WD-1 の変調（深さ 0〜63、速さ 0〜4095。@f0 で解除）
        i++;
        const arr = s[i] === '{' ? braces() : null;
        const a = arr ? null : list();
        if (!arr?.length && !a) errors.push(`${ch}: @f の後は {0〜7 の数字を並べる} か 深さ,速さ`);
        else if (ch !== 'wd') errors.push(`${ch}: @f（変調）は wd だけで使える`);
        else if (arr) set('modtable', arr);
        else set('fdsmod', [a[0], a[1] ?? 0]);
      }
      else if (k === 'b' || k === 'n') {
        // SQ-3：@b形,オクターブ ブザー（エンベロープを音の高さで回す。@b0 で解除） ／ @n周期 ノイズの高さ（0〜31、3ch で共有）
        i++;
        const a = list();
        if (!a) errors.push(`${ch}: @${k} の後は ${k === 'b' ? '形,オクターブ（例 @b8）' : '数字（例 @n12）'}`);
        else if (chipOf(ch) !== 'sq3') errors.push(`${ch}: @${k} は s1〜s3（SQ-3）だけで使える`);
        else if (k === 'b') set('buzz', [a[0], a[1] ?? 0]);
        else set('noise5b', a[0]);
      }
      else if (k === 'k') {
        // FM6：@k{8 バイト} 自作の音色（FM 音源 と同じ並び。0〜255）。@0 と同じく自作の音色を使う
        i++;
        const arr = braces();
        if (!arr || arr.length !== 8) errors.push(`${ch}: @k の後は {0〜255 の数字を 8 個}`);
        else if (chipOf(ch) !== 'fm6') errors.push(`${ch}: @k は f1〜f6（FM6）だけで使える`);
        else set('fmpatch', arr);
      }
      else if (k === 'r') { i++; const v = num(); if (v !== null) set('rel', v); }
      else if (k === 'm') {
        i++;
        const a = list();
        if (a) set('vib', a);
        else errors.push(`${ch}: @m の後は 遅延,深さ,速さ`);
      }
      else { const v = num(); if (v !== null) set('duty', v); else errors.push(`${ch}: @ の後が読めない`); }
    }
    else if (c === 'm') {
      // M3/4 拍子。小節の長さだけを決める（曲全体で1つ。値は parseMML が先に読んでおく）。ここでは書き方と位置を確かめるだけ
      const m = /^m\s*(\d+)\s*\/\s*(\d+)/.exec(s.slice(i));
      if (!m) { errors.push(`${ch}: M の後は 拍子（例 M3/4）`); i++; continue; }
      i += m[0].length;
      if (!meterTicks(+m[1], +m[2])) errors.push(`${ch}: M${m[1]}/${m[2]} は使えない拍子`);
      else if (tick !== 0) errors.push(`${ch}: 拍子 M は曲の頭（最初の音符や休符より前）に書く`);
    }
    else if (c === '&') { i++; tie = true; }
    else if (c === '*') { i++; loopTick = tick; }
    else if (c === '{') {
      // 他のチャンネルの参照 {p1 13-20 >16}：p1 の 13〜20小節の音を 16分遅らせてここに入れる。
      // 音色・音量はこのチャンネルのもの。遅らせてはみ出た分は範囲の終わりで切る。> を省くとそのままコピー
      const j = s.indexOf('}', i);
      const inner = j < 0 ? '' : s.slice(i + 1, j);
      const m = /^\s*(\w+)\s+(\d+)\s*-\s*(\d+)\s*(?:>\s*(\d+)(\.*))?\s*$/.exec(inner);
      if (!m || !CHANNELS.includes(m[1]) || +m[2] < 1 || +m[3] < +m[2] || m[4] === '0') {
        errors.push(`${ch}: 参照の書き方が違う（例：{p1 13-20 >16}）`);
        i = j < 0 ? s.length : j + 1;
        continue;
      }
      const [, refCh, bar0, bar1, dn, dots] = m;
      let delay = 0;
      if (dn) {
        let add = WHOLE / +dn;
        delay = add;
        for (let d = 0; d < dots.length; d++) { add /= 2; delay += add; }
        delay = Math.round(delay);
      }
      const base = (+bar0 - 1) * bar, span = (+bar1 - +bar0 + 1) * bar;
      const from = src.ps[i], to = src.pe[j];
      refs.add(refCh);
      if (ctx) {
        if (refCh === ch) errors.push(`${ch}: 自分自身は参照できない`);
        else if (ctx.first[refCh]?.refs.size) errors.push(`${ch}: ${refCh} も他のチャンネルを参照しているので参照できない（参照の連鎖）`);
        else {
          for (const n of ctx.notes[refCh] || []) {
            if (n.tick < base || n.tick >= base + span) continue;
            const t = n.tick - base + delay;
            if (t >= span) continue;
            notes.push({ tick: tick + t, midi: n.midi, len: Math.min(n.end - n.tick, span - t), q, from, to, ref: refCh });
          }
        }
      }
      tick += span;
      tie = false;
      lastNote = null;
      i = j + 1;
    }
    else if (/[\s|]/.test(c)) {
      if (c === '\n' && !lines.has(src.ps[i])) lines.set(src.ps[i], { tick, oct, len, q });
      i++;
    }
    else { errors.push(`${ch}: 読めない文字 "${c}"`); i++; }
  }

  const spans = [];
  for (const nt of notes) {
    events.push({ tick: nt.tick, ch, type: 'note', value: nt.midi });
    events.push({ tick: nt.tick + Math.max(1, Math.round(nt.len * nt.q / 8)), ch, type: 'off' });
    spans.push({ tick: nt.tick, end: nt.tick + nt.len, midi: nt.midi, from: nt.from, to: nt.to, ...(nt.ref ? { ref: nt.ref } : {}) });
  }
  return { events, end: tick, loopTick, spans, lines, loops, refs, last: { tick, oct, len, q } };
}

// ループの入れ子の深さ（0＝いちばん外側）。開始の早い順・同じなら長い順に並べ、包んでいるループの数を数える
function withDepth(loops) {
  const sorted = [...loops].sort((a, b) => a.start - b.start || b.end - a.end);
  const ends = [];
  for (const l of sorted) {
    while (ends.length && ends[ends.length - 1] <= l.start) ends.pop();
    l.depth = ends.length;
    ends.push(l.end);
  }
  return sorted;
}

// notes[ch] = [{ tick, end, from, to }]  … tick 順。from/to は入力文字列上の位置
export function parseMML(set) {
  const errors = [];
  const { defs, stripped } = collectMacros(set);
  const notes = {}, lines = {}, loops = {};
  let events = [], length = 0, loopStart = null;
  // 1回目：他のチャンネルの参照 {p1 13-20 >16} は休符として読む。
  // 2回目：参照を含むチャンネルだけ、1回目に読んだ参照先の音符を使って読み直す
  const srcs = {}, first = {}, firstErrors = {};
  for (const ch of CHANNELS) {
    if (!stripped[ch]) continue;
    srcs[ch] = expandLoops(expandMacros(makeSrc(stripped[ch]), defs, ch, errors));
  }
  // 小節の長さ（拍子 M3/4 など）。参照 {p1 13-20} の位置に要るので、読む前に全チャンネルから探す
  let barTicks = WHOLE, meter = null;
  for (const ch of CHANNELS) {
    for (const m of srcs[ch]?.s.matchAll(METER_RE) ?? []) {
      const t = meterTicks(+m[1], +m[2]);
      if (!t) continue;
      const name = `${+m[1]}/${+m[2]}`;
      if (meter === null) { meter = name; barTicks = t; }
      else if (t !== barTicks) errors.push(`${ch}: 拍子 M${name} が他のチャンネル（M${meter}）と違う`);
    }
  }
  for (const ch of CHANNELS) {
    if (!srcs[ch]) continue;
    firstErrors[ch] = [];
    first[ch] = parseChannel(ch, srcs[ch], firstErrors[ch], null, barTicks);
  }
  const ctx = { first, notes: Object.fromEntries(Object.entries(first).map(([c, fr]) => [c, fr.spans])) };
  for (const ch of CHANNELS) {
    if (!stripped[ch]) continue;
    let r = first[ch];
    if (r.refs.size) r = parseChannel(ch, srcs[ch], errors, ctx, barTicks);
    else errors.push(...firstErrors[ch]);
    events = events.concat(r.events);
    notes[ch] = r.spans;
    r.lines.set(stripped[ch].length, r.last);    // テキストの終わり
    lines[ch] = r.lines;
    loops[ch] = withDepth(r.loops);
    length = Math.max(length, r.end);
    if (r.loopTick !== null) {
      if (loopStart === null) loopStart = r.loopTick;
      else if (loopStart !== r.loopTick) errors.push(`${ch}: ループ位置 * が他のチャンネルとずれている`);
    }
  }
  events.sort((a, b) => a.tick - b.tick || (PRIORITY[a.type] ?? 1) - (PRIORITY[b.type] ?? 1));
  loopStart = loopStart !== null && loopStart < length ? loopStart : 0;
  return { events, length, loopStart, notes, lines, loops, errors, barTicks, meter: meter ?? '4/4' };
}

// tick の時点で効いている設定（音量・音色・テンポなど）。ch を指定すると、そのチャンネルとテンポだけ。
// 同じ種類は最後のものだけを、最後に起きた順に並べる（@d{} の後の @0 で推移が消える、などの順序を保つ）
export function settingsAt(events, tick, ch) {
  const last = new Map();
  for (const e of events) {
    if (e.tick > tick) break;
    if (e.type === 'note' || e.type === 'off') continue;
    if (ch && e.ch !== ch && e.type !== 'tempo') continue;
    const key = e.type === 'tempo' ? 'tempo' : `${e.ch}:${e.type}`;
    last.delete(key);
    last.set(key, e);
  }
  return [...last.values()];
}

// 1小節の tick。既定は 4/4（全音符と同じ 192）。
// 画面（ピアノロールなど）は今の曲の拍子に合わせて setTicksPerBar(parseMML(…).barTicks) で変える。
// import した側でも値が変わる（ES モジュールのライブバインディング）。parseMML 自体はこの値を使わず、曲の M を読む
export let ticksPerBar = WHOLE;
export function setTicksPerBar(t) { ticksPerBar = t > 0 ? t : WHOLE; }
// 全音符の tick（音長の計算用。拍子では変わらない）
export const wholeTicks = WHOLE;
