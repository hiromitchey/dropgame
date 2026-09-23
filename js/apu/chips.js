// 音源チップの一覧。曲ごとに使うチップを選ぶ（CORE-4 は必ず使う）。
// 拡張音源を足すときは、ここにチップとチャンネルを書き足す（並び順＝画面の一覧・解析の順）。
// maxChannels があるチップ（WM-8）は、使うチャンネル数を曲ごとに選ぶ。曲の chips には "wm8:4" のように数を付けて書く。
// 名前はこのプロジェクトのもの。実在の音源チップの名前ではない
export const CHIPS = [
  {
    id: 'core', name: 'CORE-4', label: '基本（矩形波2・三角波・ノイズ）', required: true,
    channels: [
      { id: 'p1', label: 'CORE-4 矩形1' },
      { id: 'p2', label: 'CORE-4 矩形2' },
      { id: 'tri', label: 'CORE-4 三角' },
      { id: 'noi', label: 'CORE-4 ノイズ' },
    ],
  },
  {
    id: 'ex6', name: 'EX-6', label: '拡張（矩形波2・のこぎり波1）',
    channels: [
      { id: 'e1', label: 'EX-6 矩形1' },
      { id: 'e2', label: 'EX-6 矩形2' },
      { id: 'saw', label: 'EX-6 のこぎり' },
    ],
  },
  {
    id: 'wd1', name: 'WD-1', label: '波形を描ける1ch（変調つき）',
    channels: [
      { id: 'wd', label: 'WD-1 波形' },
    ],
  },
  {
    id: 'wm8', name: 'WM-8', label: '波形メモリ（描いた波形・1〜8ch。多いほど1chの音は小さい）', maxChannels: 8, defaultChannels: 4,
    channels: Array.from({ length: 8 }, (_, i) => ({ id: `w${i + 1}`, label: `WM-8 ${i + 1}` })),
  },
  {
    id: 'sq3', name: 'SQ-3', label: '矩形波3・ノイズ・ブザー',
    channels: [
      { id: 's1', label: 'SQ-3 1' },
      { id: 's2', label: 'SQ-3 2' },
      { id: 's3', label: 'SQ-3 3' },
    ],
  },
  {
    id: 'fm6', name: 'FM-6', label: 'FM 音源（6ch、用意した音色 15＋自作）',
    channels: Array.from({ length: 6 }, (_, i) => ({ id: `f${i + 1}`, label: `FM-6 ${i + 1}` })),
  },
  {
    id: 'smp', name: 'SMP-1', label: 'サンプル再生（キック・スネアなど）',
    channels: [
      { id: 'smp', label: 'SMP-1 サンプル' },
    ],
  },
];

export const CHANNELS = CHIPS.flatMap(c => c.channels.map(x => x.id));
export const CHANNEL_LABEL = Object.fromEntries(CHIPS.flatMap(c => c.channels.map(x => [x.id, x.label])));

export const chipOf = ch => CHIPS.find(c => c.channels.some(x => x.id === ch))?.id ?? null;

// "wm8:4" → { id: 'wm8', count: 4 }、"ex6" → { id: 'ex6', count: null }
export function parseChip(entry) {
  const m = /^([a-z0-9]+)(?::(\d+))?$/.exec(String(entry));
  return m ? { id: m[1], count: m[2] ? +m[2] : null } : { id: null, count: null };
}

// 知らないチップを除き、必ず使うチップを足して、一覧の順に並べる。
// チャンネル数を選ぶチップは数を 1〜最大に収めて付ける（数が無ければ最大。同じチップが複数あれば大きいほう）
export function normalizeChips(list) {
  const want = new Map();
  for (const e of list ?? []) {
    const { id, count } = parseChip(e);
    const chip = CHIPS.find(c => c.id === id);
    if (!chip) continue;
    const n = chip.maxChannels ? Math.max(1, Math.min(chip.maxChannels, count ?? chip.maxChannels)) : 1;
    want.set(id, Math.max(want.get(id) ?? 0, n));
  }
  return CHIPS.filter(c => c.required || want.has(c.id)).map(c => c.maxChannels ? `${c.id}:${want.get(c.id) ?? c.maxChannels}` : c.id);
}

// そのチップのチャンネル数（使っていなければ 0）
export function chipCount(chips, id) {
  for (const e of normalizeChips(chips)) {
    const p = parseChip(e);
    if (p.id === id) return p.count ?? CHIPS.find(c => c.id === id).channels.length;
  }
  return 0;
}

// チップを付ける（count はチャンネル数。チャンネル数を選ばないチップは 1）・外す（count = 0）
export function withChip(chips, id, count) {
  const chip = CHIPS.find(c => c.id === id);
  const rest = normalizeChips(chips).filter(e => parseChip(e).id !== id);
  if (!chip || count <= 0) return normalizeChips(rest);
  return normalizeChips([...rest, chip.maxChannels ? `${id}:${count}` : id]);
}

// 使うチップのチャンネル（一覧の順）
export function chipChannels(chips) {
  return CHIPS.flatMap(c => {
    const n = chipCount(chips, c.id);
    return n ? c.channels.slice(0, n).map(x => x.id) : [];
  });
}

// 中身（空白以外）が書いてあるチャンネルのチップ。チャンネル数を選ぶチップは、書いてある一番後ろのチャンネルまで
export function chipsFor(set) {
  const out = [];
  for (const c of CHIPS) {
    const used = c.channels.map(x => !!(set?.[x.id] ?? '').trim());
    const last = used.lastIndexOf(true);
    if (last >= 0) out.push(c.maxChannels ? `${c.id}:${last + 1}` : c.id);
  }
  return normalizeChips(out);
}

// 曲の使うチップ：保存してあるもの ＋ 中身が書いてあるチャンネルのチップ（中身を隠さない）。
// 保存していない古い曲は中身から決まる
export function resolveChips(set, chips) {
  return normalizeChips([...(chips ?? []), ...chipsFor(set)]);
}
