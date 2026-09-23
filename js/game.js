// drop delta - Phase 1 + 5
// 落下・堆積・同種3体消去・連鎖・キャンディー（お邪魔）まで。
// 設計書 doc/bp.md 参照。

'use strict';

const { Engine, Composite, Bodies, Body, Events, Query, Sleeping } = Matter;

// ---- 盤面 ----------------------------------------------------------------

const W = 480;              // 論理解像度。実解像度は DPR で拡大
const H = 760;
const WALL = 60;            // 壁の厚み（画面外に置く）
// 落とすフルーツの出る高さ。上の表示（y=4〜42）と重ならないよう少し下げてある
const SPAWN_Y = 84;


// ---- ドロップ（シンプル版）------------------------------------------------
//
// 色ごとに形が違う。**形は見た目だけでなく当たり判定でもある。**
// 頂点リストを1つ作り、それを物理ボディと描画の両方に使うことでズレを防いでいる。
//
// 設計書 4.1 は fromVertices を「凸分解の精度・速度」を理由に不採用としているが、
// それは凹んだ形の話。ここで使うのは全て凸多角形で、
// 分解が発生しないため該当しない。
//
// なお、形が当たり判定と一致する以上、描画の回転は実角度でなければならない。
// pattern は飴の表面の柄。色が種類を見分ける一番の手がかりなので、柄は控えめに重ねる
const DROPS = [
  { id: 'd1', color: '#a3d13f', shine: '#dcf08a', shape: 'circle',   pattern: 'melon'      },
  { id: 'd2', color: '#efd766', shine: '#fff4b8', shape: 'drop',     pattern: 'pear'       },  // ナシ。レモンを白っぽくしたので、はっきり黄色寄りに
  { id: 'd3', color: '#ef5b7d', shine: '#ffb3c4', shape: 'triangle', pattern: 'strawberry' },
  { id: 'd4', color: '#4a9ce6', shine: '#b8dcfa', shape: 'pentagon', pattern: 'blueberry'  },  // ブルーベリー（ラムネ → ブルーベリー → みかん → ブルーベリー。かわいいのでこれに）
  { id: 'd5', color: '#ad62cf', shine: '#e4bdf5', shape: 'ellipse',  pattern: 'grape'      },  // ブルーベリーの青と離すため、少し赤みのある紫
  { id: 'd6', color: '#ff9226', shine: '#ffd7a0', shape: 'hexagon',  pattern: 'orange'     },  // オレンジの輪切り（最初はレモン。黄色いナシと色が近かったのでオレンジに）
];

// 形状の頂点。原点中心・半径 r に収まる凸多角形を返す。circle だけ null。
//
// 最後に必ず凸包を取る。凹んだ頂点列を Bodies.fromVertices に渡すと、Matter は
// poly-decomp による凸分解を要求し、無い場合は黙って凸包に差し替える。
// こちらで先に凸包にしておけば、渡した形と実際の当たり判定が必ず一致する。
// 角は必ず丸める。尖った飴は見た目が固く、積んだときも刺さって気持ちよくない。
// 面取りは頂点列そのものに掛けるので、当たり判定も同じだけ丸くなる
// 面取りは半径に対する比で持つ。固定値にすると、NEXT のように小さく描いたときに
// 面取りの方が形より大きくなって崩れる（五角形が一番目立つ）
const CHAMFER_RATIO = 0.48; // 角の丸み。大きいほど丸に近づく
const CHAMFER_QUALITY = 3;  // 1つの角を何分割するか。増やすと滑らかだが頂点が増える

// 見た目の大きさを揃える基準。多角形は円に内接する上に面取りでさらに痩せるため、
// 半径をそのまま使うと丸だけが大きく見える。全形状をこの面積に正規化する
const AREA_RATIO = 0.90;                                  // 丸の半径を R の何倍にするか
const circleR = r => r * AREA_RATIO;
const targetArea = r => Math.PI * circleR(r) * circleR(r);

function shapeVerts(shape, r) {
  const raw = rawShapeVerts(shape, r);
  if (!raw) return null;
  const hull = Matter.Vertices.hull(raw.map(p => ({ x: p.x, y: p.y })));
  const round = Matter.Vertices.chamfer(hull, r * CHAMFER_RATIO, CHAMFER_QUALITY, 2, 10);
  // 面取り後にもう一度凸包を取る。丸めの計算誤差でわずかに凹むことがあり、
  // そのまま渡すと Matter が凸分解を要求して警告を出す
  const v = Matter.Vertices.hull(round);

  // 面積を丸に合わせる。形が違っても「同じ大きさの飴」に見えるようにする
  const area = Math.abs(Matter.Vertices.area(v, true));
  if (area > 0) {
    const k = Math.sqrt(targetArea(r) / area);
    Matter.Vertices.scale(v, k, k, { x: 0, y: 0 });
  }
  return v;
}

function rawShapeVerts(shape, r) {
  const poly = (n, rot, sx, sy) => {
    const v = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      v.push({ x: Math.cos(a) * r * (sx || 1), y: Math.sin(a) * r * (sy || 1) });
    }
    return v;
  };
  switch (shape) {
    case 'circle':   return null;
    case 'square':   return poly(4, Math.PI / 4);
    // いちご。上が平らで下がとがる三角（面取りで先は丸まる）
    case 'triangle': return poly(3, Math.PI / 2);
    case 'hexagon':  return poly(6, Math.PI / 6);
    case 'pentagon': return poly(5, -Math.PI / 2);
    case 'ellipse':  return poly(14, 0, 0.84, 1.0);   // 縦長（ぶどうの房）。横長だと房に見えない
    // 包んだ飴。横に少し伸ばした枕形。面取りと合わせて角が取れる
    case 'candy':    return poly(10, 0, 1.12, 0.82);
    case 'drop': {
      // しずく。上が尖って下が丸い。
      // **凸でなければならない。** 凹にすると Matter が凸分解を要求し、
      // poly-decomp が無いと凸包に置き換えられて意図した形にならない。
      // 頂点を下半分の円弧 + 頂点1つに絞り、肩を張らせないことで凸に保つ
      // 先端は1点に集めず、少し幅を持たせる。面取りと合わせて丸い頭になる
      const v = [];
      const cy = r * 0.10;
      const rr = r * 0.86;
      const spread = Math.PI * 0.84;
      for (let i = 0; i <= 12; i++) {
        const a = (Math.PI / 2 - spread) + (i / 12) * (spread * 2);
        v.push({ x: Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
      }
      v.push({ x:  r * 0.26, y: -r * 0.98 });
      v.push({ x: -r * 0.26, y: -r * 0.98 });
      return v;
    }
    default: return null;
  }
}

// 消滅エフェクト
const EFFECT_LIFE = 18;         // 消滅エフェクトの表示フレーム数
const EFFECT_HOLD = 0.55;       // この割合までは不透明を保ち、以降で抜く

const MODE_KEY = 'plain';        // 自己ベストの保存先に使う（前の名前の名残。変えると記録が消える）
const TITLE = 'フルーツドロップス';

// ---- グレード（シンプル版）------------------------------------------------
//
// 目標点に達するとクリア。盤面を一掃して次のグレードへ進む。
// グレードが上がると目標点が伸び、キャンディーが速くなり、途中から色の種類が増える。

// ---- 見た目のテーマ（背景と画面の文字色）------------------------------------
//
// 背景・文字・線の色をまとめて持つ。明るい背景では文字を暗くする必要があるため、
// 背景だけでなく画面の文字色もテーマごとに持つ。
// ?bg=名前 で切り替えられる
const THEMES = {
  classic: {
    bgTop: '#1b1f2e', bgBottom: '#101320', pattern: null,
    ink: '#e8ecf8', sub: '#5a6280', mid: '#8a93b0', dim: '#4a5068', soft: '#b8c2dc',
    line: '#2e3448', track: '#252a3c', trackFill: '#454d6b', guide: 'rgba(255,255,255,0.06)',
    overlay: 'rgba(10,12,20,0.78)', outside: 'rgba(4,5,10,0.55)',
    glassWide: 'rgba(170,200,255,0.16)', glassEdge: 'rgba(225,238,255,0.55)',
    accent: '#ffe6a3', rowBg: 'rgba(255,255,255,0.04)', rowSel: 'rgba(255,230,163,0.13)',
    rowBorder: 'rgba(255,230,163,0.7)',
    cardBg: 'rgba(255,255,255,0.06)', cardEdge: 'rgba(255,230,163,0.4)',
  },
  // ゆめかわ。ピンクから薄紫へのグラデーションに白い水玉
  yume: {
    bgTop: '#ffe3ef', bgBottom: '#e6e0ff', pattern: 'dots',
    ink: '#5b3f70', sub: '#a08bb3', mid: '#806a96', dim: '#c9bbd6', soft: '#806a96',
    line: '#d9b6da', track: '#f3dff0', trackFill: '#dcb8e6', guide: 'rgba(255,255,255,0.45)',
    overlay: 'rgba(255,238,247,0.86)', outside: 'rgba(170,130,200,0.22)',
    glassWide: 'rgba(255,255,255,0.6)', glassEdge: 'rgba(170,130,210,0.6)',
    accent: '#e2689c', rowBg: 'rgba(255,255,255,0.45)', rowSel: 'rgba(255,255,255,0.9)',
    rowBorder: '#e2689c',
    cardBg: 'rgba(255,255,255,0.6)', cardEdge: 'rgba(226,104,156,0.45)',
  },
  // よるのおかしやさん。深い紫に、ピンクの水玉と小さな星
  night: {
    bgTop: '#33204b', bgBottom: '#1a1230', pattern: 'stars',
    patternDot: 'rgba(255,170,220,0.10)', patternStar: 'rgba(255,236,170,0.55)',
    ink: '#fbeaff', sub: '#9c88b8', mid: '#c4b1de', dim: '#5f4d7a', soft: '#d8c5f0',
    line: '#4d3a69', track: '#3b2c54', trackFill: '#6d5793', guide: 'rgba(255,220,250,0.07)',
    overlay: 'rgba(22,12,34,0.82)', outside: 'rgba(12,6,22,0.5)',
    glassWide: 'rgba(255,200,240,0.16)', glassEdge: 'rgba(255,228,250,0.6)',
    accent: '#ffd27a', rowBg: 'rgba(255,255,255,0.05)', rowSel: 'rgba(255,200,235,0.15)',
    rowBorder: 'rgba(255,190,230,0.75)',
    cardBg: 'rgba(255,255,255,0.07)', cardEdge: 'rgba(255,190,230,0.45)',
  },
  // そら。上が濃い水色、下へ行くほど白っぽくなるグラデーションに、白いきらきら
  sora: {
    bgTop: '#8fd0fb', bgBottom: '#e6f5ff', pattern: 'stars',
    patternDot: 'rgba(255,255,255,0.30)', patternStar: 'rgba(255,255,255,0.95)',
    ink: '#274766', sub: '#6f8fae', mid: '#4d6c8c', dim: '#a9c1d8', soft: '#4d6c8c',
    line: '#8dbfe6', track: '#cfe6f8', trackFill: '#8cc4ec', guide: 'rgba(255,255,255,0.4)',
    overlay: 'rgba(232,245,255,0.88)', outside: 'rgba(70,130,190,0.16)',
    glassWide: 'rgba(255,255,255,0.65)', glassEdge: 'rgba(80,150,215,0.6)',
    accent: '#e8649a', rowBg: 'rgba(255,255,255,0.45)', rowSel: 'rgba(255,255,255,0.92)',
    rowBorder: '#e8649a',
    cardBg: 'rgba(255,255,255,0.62)', cardEdge: 'rgba(232,100,154,0.45)',
  },
};
const THEME_ID = new URLSearchParams(location.search).get('bg') || 'sora';
const UI = THEMES[THEME_ID] || THEMES.classic;

// 文字は丸ゴシック。ドロップスだけ。読み込み前は system-ui で描かれる
const FONT_FAMILY = '"M PLUS Rounded 1c", system-ui, sans-serif';

// canvas は描いた文字のためにフォントを取りに行かないので、使う字を先に読ませておく
if (document.fonts && document.fonts.load) {
  const glyphs = 'おとがでるよんりょうはバーでちせつMキーオン・フしているあいだめちくなじ3つきえうごかすマウスゆびっぱなEscそとに（）' + 'スコアタップしてはじめる音が出ます上のバーでキーONOFF・フルーツドロップスえらんでクリック押しているあいだ飴が落ちてくる同じつながると消える'
    + 'はこまるぞこすりばちすなどけいベストグレードつぎおじゃまいろれんさ！'
    + 'あたらしいうつわがひらいためでゲームオーバースコアもういちどびょう'
    + '0123456789×Esc';
  for (const w of [700, 800]) document.fonts.load(w + ' 20px "M PLUS Rounded 1c"', glyphs).catch(() => {});
}
const GRADE_BASE = 1200;        // グレード1の目標点
const GRADE_GROWTH = 1.42;      // 目標点の伸び
// クリア時に盤面をどうするか。
//
//   残す（既定）: 山が高いまま次のグレードに入るので緊張が途切れない。
//                 クリアが「ご褒美」ではなく「通過点」になる
//   一掃する    : 毎回まっさらから。リズムは良いが、クリアのたびに危機が消える
//
// ?sweep=1 を付けると一掃する側に切り替わる。比較用
const GRADE_SWEEP = new URLSearchParams(location.search).get('sweep') === '1';
const GRADE_CLEAR_HOLD = GRADE_SWEEP ? 150 : 95;   // 一掃する場合は見せる時間が要る
const GRADE_SWEEP_SCORE = 20;   // 一掃したときの、残っていた1個あたりのボーナス
const WAVE_CARRY = 1;           // グレードが1つ上がるごとに、お邪魔の波をいくつ進めた状態で始めるか
                                // 盤面を持ち越す設定ではお邪魔も残るため、下駄は控えめにする

const gradeTarget = g => Math.round(GRADE_BASE * Math.pow(GRADE_GROWTH, g - 1) / 50) * 50;

// 何色使うか。増えるほど揃わなくなる。
//
// 3グレードごとに1色。2グレードごとだと、色が増えるグレードと目標点が跳ねる
// グレードが重なって、そこだけ急に難しくなる（グレード5がそうだった）
const gradeKinds = g => Math.min(DROPS.length, 2 + Math.ceil(g / 3));

// グレードが上がるほどキャンディーが早く来る。
//
// 5までは緩やかに、6以降で締める。長く続けるほど連打が疲れるので、
// そのあたりで決着が付くようにする。序盤の傾きを変えると、ならしたはずの
// グレード5の跳ねが戻ってしまうため、後半だけを急にしている
const GRADE_RAMP_FROM = 5;
const gradeCandyScale = g => (g <= GRADE_RAMP_FROM
  ? 1 - (g - 1) * 0.05
  : Math.max(0.30, (1 - (GRADE_RAMP_FROM - 1) * 0.05) - (g - GRADE_RAMP_FROM) * 0.145));

// 色が増えたグレードだけ、お邪魔を緩める。
//
// 色が1つ増えると揃う確率が一段下がり、そこへ目標点の上昇と投入ペースの加速が
// 重なると、そのグレードだけ急にきつくなる。新しい色に慣れる時間を渡す
// 緩和は一段で戻さず、次のグレードにかけて徐々に戻す。
// 一気に戻すと、緩和した次のグレードで圧力が跳ね上がり、そこが新しい難所になる
const COLOR_RELIEF = [1.35, 1.18, 1.07];   // 色が増えたグレードから順に掛ける倍率
const COLOR_RELIEF_WAVES = 3;              // 波をいくつ巻き戻すか

const colorAdded = g => g > 1 && gradeKinds(g) > gradeKinds(g - 1);

// ---- 器（ステージ）--------------------------------------------------------
//
// 盤面を箱ではなく「器」にする。器の形で飴の落ち方・溜まり方が変わる。
// グレードを GRADES_PER_STAGE 回クリアするごとに次の器へ進み、そのとき盤面をリセットする
// （形が違うので飴を持ち越せない）。最後の器に着いたらそのままグレードが進む。
//
// 器は「内側の輪郭」を折れ線で持つ。壁はその線分ごとに静的な細い長方形を、輪郭の
// 外側に置いて作る。曲線は細かい折れ線で近似する。
const GRADES_PER_STAGE = 3;
const WALL_T = 36;        // 壁の厚み。外側に張り出すので遊べる範囲は削らない
const WALL_TOP = -420;    // 壁の上端。画面外から降ってくるお邪魔も器の中に収める
const STAGE_BANNER_FRAMES = 150;   // 器が変わったときの表示フレーム数

function arcPoints(cx, cy, r, a0, a1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

const CONTAINERS = [
  {
    id: 'box', name: 'はこ',
    outline: [{ x: 0, y: WALL_TOP }, { x: 0, y: H }, { x: W, y: H }, { x: W, y: WALL_TOP }],
    opening: [0, W],      // 出現高さでの内側の幅
    lineY: 150,           // ゲームオーバーライン
    line: [0, W],         // ラインを引く範囲
  },
  (() => {
    // まるぞこ。上は箱と同じく全幅で開いていて、底だけが半円。
    //
    // 当初は細い首のフラスコにしたが、撃てる幅が飴2個ぶんしかなく「どこに落とすか」
    // という一番の判断が消えてしまった。丸い底で中央に集まる性質だけを残す
    const cx = W / 2, br = W / 2, cy = H - br;
    return {
      id: 'bowl', name: 'まるぞこ',
      outline: [
        { x: 0, y: WALL_TOP }, { x: 0, y: cy },
        ...arcPoints(cx, cy, br, Math.PI, 0, 40),   // 左端から底を通って右端へ
        { x: W, y: cy }, { x: W, y: WALL_TOP },
      ],
      opening: [0, W],
      lineY: 150,
      line: [0, W],
    };
  })(),
  (() => {
    // すり鉢。上が広く下がすぼまる。斜面を滑って中央に集まるので同じ色が寄りやすいが、
    // 中央が高く積み上がりやすい
    const shoulder = 250, bottomHalf = 92;
    return {
      id: 'funnel', name: 'すりばち',
      outline: [
        { x: 0, y: WALL_TOP }, { x: 0, y: shoulder },
        { x: W / 2 - bottomHalf, y: H - 8 }, { x: W / 2 + bottomHalf, y: H - 8 },
        { x: W, y: shoulder }, { x: W, y: WALL_TOP },
      ],
      opening: [0, W],
      lineY: 150,
      line: [0, W],
    };
  })(),
  (() => {
    // すなどけい。上の玉 → くびれ → 下の玉。
    //
    // くびれは飴1個がぎりぎり通る幅にしている。2個同時に来ると引っかかって栓になり、
    // 上に溜まり始める。連鎖で栓を消すと一気に流れ落ちる。これまでの器にない「詰まる」動き
    const cx = W / 2;
    const waistY = 420, waistHalf = 52;       // くびれ（幅104。飴の直径は約56）
    const topY = 190;                         // 上の玉が絞り始める高さ
    const lowY = 610, lowHalf = 222;          // 下の玉のいちばん広いところ
    const ease = t => (1 - Math.cos(Math.PI * t)) / 2;

    // 高さ y での内側の半幅
    const half = y => {
      if (y <= topY) return W / 2;
      if (y <= waistY) return W / 2 + (waistHalf - W / 2) * ease((y - topY) / (waistY - topY));
      if (y <= lowY) return waistHalf + (lowHalf - waistHalf) * ease((y - waistY) / (lowY - waistY));
      const t = (y - lowY) / (H - lowY);      // 丸い底
      return lowHalf * Math.sqrt(Math.max(0, 1 - t * t));
    };

    const ys = [WALL_TOP];
    for (let y = topY; y < H; y += 12) ys.push(y);
    ys.push(H);
    const left = ys.map(y => ({ x: cx - half(y), y }));
    const right = ys.slice().reverse().map(y => ({ x: cx + half(y), y }));

    return {
      id: 'hourglass', name: 'すなどけい',
      outline: left.concat(right),
      opening: [0, W],
      lineY: 150,
      pinch: [110, 150],    // ピンチ版 BGM に入る・戻る山の高さ（updatePinch）
      line: [0, W],
    };
  })(),
];

// 今の器
const container = () => CONTAINERS[state.stage];

// 器ごとに独立したゲームとして遊ぶ。ある器で UNLOCK_GRADE をクリアすると次の器が解放される。
// 解放状態と自己ベスト（器ごと）はブラウザに保存する
const UNLOCK_GRADE = 3;
const UNLOCK_KEY = 'dropdelta.unlocked';

function loadUnlocked() {
  try {
    const n = Number(localStorage.getItem(UNLOCK_KEY));
    return Number.isFinite(n) ? Math.max(0, Math.min(CONTAINERS.length - 1, n)) : 0;
  } catch (e) { return 0; }
}

// 自己ベストの保存先。ドロップスは器ごとに分ける
const bestKey = i => 'dropdelta.best.' + MODE_KEY + '.' + CONTAINERS[i].id;

function readBest(i) {
  try {
    let v = localStorage.getItem(bestKey(i));
    // 器を導入する前の自己ベストは はこ のものとして引き継ぐ
    if (v === null && i === 0) v = localStorage.getItem('dropdelta.best.plain');
    return Number(v || 0);
  } catch (e) { return 0; }
}

function writeBest(i, v) {
  try { localStorage.setItem(bestKey(i), String(v)); } catch (e) { /* 保存できなくても遊べる */ }
}

function unlockStage(i) {
  if (i >= CONTAINERS.length || i <= state.unlocked) return;
  state.unlocked = i;
  try { localStorage.setItem(UNLOCK_KEY, String(i)); } catch (e) { /* 次回は未解放に戻るだけ */ }
  state.bannerStage = i;
  state.stageBanner = STAGE_BANNER_FRAMES;
  Sound.stageOpen();
}
const lineY = () => container().lineY;

// 撃てる範囲。器の口の内側から、飴の半径ぶん内へ寄せる
const dropLo = () => container().opening[0] + R + 2;
const dropHi = () => container().opening[1] - R - 2;

function gradeRelief(g) {
  for (let i = 0; i < COLOR_RELIEF.length; i++) {
    if (colorAdded(g - i)) return COLOR_RELIEF[i];
  }
  return 1;
}

// Phase 1 の円は仮。当たり判定を絵の形（縦長／横広）に合わせるのは Phase 2。
// この R はフルーツの大きさの基準。
const R = 31;               // 半径
const REACH = 33;           // つながり判定の到達距離（重心間）
const MATCH = 3;            // 消去に必要な数
const NEXT_SHOWN = 3;       // NEXT で見せる手数
const MAX_BODIES = 200;     // 盤面上限。負荷の安全弁であり難易度装置ではない。
                            // ゲームオーバーラインより先に効くと負けなくなる

// ---- 物理パラメータ（設計書 4.2）----------------------------------------

// ふわっと落とす。重力を弱め、空気抵抗を上げて終端速度を下げている。
// 落下が速いと「物を投げ落としている」感触になり、ふんわり落ちてこない
const GRAVITY = 0.72;       // 盤面の高さを落ちきるのに約2.0秒（変更前は1.37秒）

const PHYS = {
  restitution: 0.15,
  friction: 0.55,
  frictionStatic: 0.6,
  frictionAir: 0.026,
  density: 0.001,
};

// ---- 判定 ----------------------------------------------------------------

const SETTLE_SPEED = 0.35;      // 静止とみなす速度
const SCAN_INTERVAL = 10;       // 何フレームに1回走査するか
const RECHECK_DELAY = 380;      // 消去後、再判定までの待機 (ms)
const CHAIN_WINDOW = 1000;      // 連鎖とみなす間隔 (ms)
const DROP_COOLDOWN = 100;      // 出現位置の重なり事故を防ぐ最小限
const DROP_BUFFER = 450;        // 撃てない瞬間のクリックを保留しておく時間 (ms)

// 押している間は自動で連射する。1回ずつクリックさせると、長く遊ぶほど指が疲れる
const AUTO_FIRE_MS = 300;       // 連射の間隔
const OVER_HOLD = 1500;         // ライン超過がこの時間続いたらゲームオーバー

const BASE_SCORE = 40;
const CANDY_SCORE = 15;

// ---- キャンディー（設計書 3.2 / 7）--------------------------------------

const CANDY_R = 36;             // 飴より一回り大きい。盤面を強く圧迫する
const CANDY_REACH = 38;

// お邪魔も飴と同じ描き方（グラデーション・色付きの縁・つや）で描く。
// ベタ塗りのままだと、つやのある飴と並んだときに絵柄が浮く。
//
// ただし**美味しそうに見せない**。彩度を落とした包み紙の色にして、
// 中身が見えない「包んだまま」の状態として区別する
const CANDY_TYPE = { id: 'candy', color: '#8b8b99', shine: '#c4c4d0', shape: 'candy' };

// 包み紙の形。中央の丸 + 左右のひねり。
//
// この輪郭は凹んでいるため、1つの凸多角形では表せない。**複合ボディ**で作る
// （中央の円 + ひねり2枚）。設計書 4.1 が凸分解ではなく円の組み合わせを
// 指定しているのと同じ理由で、凹形状はパーツを足して作る。
function candyGeom(r) {
  return {
    cr: r * 0.72,                        // 中央の丸
    wedge: [                             // 右側のひねり。左は x を反転して使う
      { x: r * 0.52, y: -r * 0.17 },
      { x: r * 1.00, y: -r * 0.42 },
      { x: r * 1.00, y:  r * 0.42 },
      { x: r * 0.52, y:  r * 0.17 },
    ],
  };
}
const CANDY_LAYER_CAP = 4;      // 連鎖で広がる巻き込み層の上限

// 投入契機は経過時間。ドロップ回数ではない（連続発射を許可しているため）
const CANDY_FIRST = 3800;       // 初回までの猶予 (ms)
const CANDY_INTERVAL_MAX = 4600;   // 序盤の基準。旧設定のグレード5相当をここに持ってきている
const CANDY_INTERVAL_MIN = 2800;
const CANDY_INTERVAL_STEP = 190;   // 1波ごとに間隔を詰める量。小さいほど増え方が緩やか
const CANDY_COUNT_EVERY = 6;      // 何波ごとに1回の投入数を増やすか

const candyInterval = wave => {
  const base = Math.max(CANDY_INTERVAL_MIN, CANDY_INTERVAL_MAX - wave * CANDY_INTERVAL_STEP);
  return base * gradeCandyScale(state.grade) * gradeRelief(state.grade);
};
// 1回の投入数には上限を置く。目標点が上がるほど1グレードが長くなり、
// 波が進んで投入数だけが際限なく増える。終盤だけ理不尽に重くなるのを防ぐ
// 上限は後半だけ引き上げる。序盤を重くせずに、終盤の決着だけ早める
const CANDY_COUNT_MAX = 2;
const CANDY_COUNT_MAX_LATE = 3;
const CANDY_COUNT_LATE_FROM = 7;   // このグレードから上限を上げる

const candyCount = wave => {
  const cap = (state.grade >= CANDY_COUNT_LATE_FROM)
    ? CANDY_COUNT_MAX_LATE : CANDY_COUNT_MAX;
  return Math.min(cap, 1 + Math.floor(wave / CANDY_COUNT_EVERY));
};

// キャンディーは転がらず「詰まる」（設計書 3.2）
const CANDY_PHYS = {
  restitution: 0.02,
  friction: 0.9,
  frictionStatic: 1.0,
  frictionAir: 0.034,
  density: 0.0014,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- 状態 ----------------------------------------------------------------

// 止まった飴は眠らせて、物理の計算を休ませる（スマホで重くなる対策）。
// 飴が消えたら全部を起こす（afterUpdate）。支えを失った飴が宙に浮いたまま眠り続けないように。
// 眠る基準は既定（0.08）より厳しくする。ゆっくり滑っている飴まで途中で固まると、器の底に集まる動きが変わる
Matter.Sleeping._motionSleepThreshold = 0.02;
const engine = Engine.create({ enableSleeping: true });
engine.gravity.y = GRAVITY;
const world = engine.world;

const canvas = document.getElementById('cv');
const mainCtx = canvas.getContext('2d');
let ctx = mainCtx;          // ふだんは画面。飴の絵をとっておくときだけ一時的に差し替える（spriteFor）

const state = {
  queue: [],          // NEXT。先頭が今構えているフルーツ
  pointerX: W / 2,
  lastDrop: 0,
  frame: 0,
  recheckAt: 0,
  lastClear: -Infinity,
  chain: 0,
  score: 0,
  best: 0,            // 今の器の自己ベスト。開始時に読み込む
  overSince: 0,
  // 「タップして はじめる」の画面。ブラウザは操作があるまで音を出させないので、
  // 最初の1回を押してもらってからタイトルの曲と器の一覧を出す（ドロップスだけ）
  splash: true,
  leaving: null,       // ボタンを押して、画面が移るのを待っている { kind: 'splash' | 'start', at }
  musicDelay: 0,
  pinch: false,        // 山がラインに迫っている（BGM をピンチ版に）
  pinchSince: 0,
  // マウスの星のキラキラ（パソコンのマウスのときだけ）。cursorX はマウスの本当の x（pointerX は落とせる範囲に丸めてある）
  mouse: false,
  cursorX: W / 2,
  trail: [],
  trailFrom: null,
  gameOver: false,
  dropped: false,
  effects: [],
  wave: 0,            // キャンディーを何回投入したか
  nextCandyAt: 0,     // 次の投入時刻
  wantDropAt: 0,      // 保留中のクリック（0 なら無し）
  wantDropX: 0,
  pushEdge: 0,        // 盤面外へはみ出している向き（-1 左 / 0 内側 / 1 右）
  rawX: W / 2,        // クランプ前のポインタ位置
  locked: false,      // ポインタロック中か
  grade: 1,           // シンプル版のグレード
  gradeScore: 0,      // 今のグレードで稼いだ点
  clearT: 0,          // クリア演出の残りフレーム
  stage: 0,           // 今の器（CONTAINERS の添字）
  stageBanner: 0,     // 器が解放されたときの表示フレーム
  bannerStage: 0,     // 解放された器
  unlocked: loadUnlocked(),   // 解放済みの一番先の器
  titleSel: 0,        // タイトルで選んでいる器
  pointerY: H / 2,     // タイトルで器を選ぶのに使う
  lockFlash: 0,       // 未解放の器を選ぼうとしたときの表示フレーム
  holding: false,     // 押しっぱなしで連射中か
  nextAutoAt: 0,      // 次に自動で撃つ時刻
  pressArmed: false,  // タイトル / ゲームオーバーで「押した」ことを覚えておく
  bests: null,        // タイトルに出す器ごとの自己ベスト（null なら読み直す）
  started: false,     // タイトル画面を抜けたか
  titleT: 0,          // タイトルの経過フレーム
};

const removeQueue = [];

// ---- 初期化 --------------------------------------------------------------

// 器の輪郭から壁を作る。線分ごとに細い長方形を置き、内側の面が輪郭にぴったり
// 重なるよう、厚みの半分だけ外側へずらす
function buildWalls() {
  const opts = { isStatic: true, friction: 0.6, restitution: 0, label: 'wall' };
  const pts = container().outline;

  // 外向きは輪郭の回る向きで決める。
  // 「器の内側の1点から見た向き」で決めると、すなどけいのようにくびれた器では、
  // 上の玉の壁から見て基準点（下の玉の中）が外側に来てしまい、壁が内側へ張り出す
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area < 0 ? 1 : -1;

  const walls = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;

    const nx = -dy / len * sign, ny = dx / len * sign;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    // 継ぎ目に隙間ができないよう、長さを少し足す
    walls.push(Bodies.rectangle(
      mx + nx * WALL_T / 2, my + ny * WALL_T / 2,
      len + WALL_T * 0.6, WALL_T,
      Object.assign({ angle: Math.atan2(dy, dx) }, opts)));
  }
  Composite.add(world, walls);
}


// 今のグレードで使うフルーツの一覧
function palette() {
  return DROPS.slice(0, gradeKinds(state.grade));
}

function randomType() {
  const p = palette();
  return p[(Math.random() * p.length) | 0];
}

// ボディを作る。形が当たり判定そのもの
function makePieceBody(type, x, y) {
  const opts = Object.assign({}, PHYS, {
    label: 'drop',
    plugin: { type: type.id, reach: REACH },
  });

  const verts = shapeVerts(type.shape, R);
  if (!verts) return Bodies.circle(x, y, circleR(R), opts);   // 丸も面積を揃える

  const b = Bodies.fromVertices(x, y, [verts], opts);
  // fromVertices は重心に合わせて原点をずらす。描画は body.vertices を直接使うので
  // ここでズレは生じないが、つながり判定用の reach は実際の広がりから取り直す
  if (b) {
    let far = 0;
    for (const v of b.vertices) {
      far = Math.max(far, Math.hypot(v.x - b.position.x, v.y - b.position.y));
    }
    b.plugin.reach = far * 1.04;
  }
  return b || Bodies.circle(x, y, R, opts);
}

function fillQueue() {
  // 先頭が今構えているフルーツ。残りが NEXT として見える分
  while (state.queue.length < 1 + NEXT_SHOWN) state.queue.push(randomType());
}

function reset() {
  Composite.clear(world, false);
  state.stage = state.titleSel;   // 壁を作る前に器を決める
  state.stageBanner = 0;
  buildWalls();

  // グレードを先に戻す。NEXT の補充は palette() を通してグレードを見るため、
  // 順番を逆にすると前回のグレードの色数で補充され、1面から後半の色が出てくる
  state.grade = 1;
  state.gradeScore = 0;
  state.clearT = 0;

  state.queue.length = 0;
  fillQueue();

  state.score = 0;
  state.chain = 0;
  state.frame = 0;
  state.lastDrop = -Infinity;
  state.recheckAt = 0;
  state.lastClear = -Infinity;
  state.overSince = 0;
  state.pinch = false;
  state.pinchSince = 0;
  state.gameOver = false;
  state.effects.length = 0;
  state.wave = 0;
  state.wantDropAt = 0;
  state.nextCandyAt = performance.now() + CANDY_FIRST;
  removeQueue.length = 0;
}

// ---- ドロップ ------------------------------------------------------------

function drops() {
  return Composite.allBodies(world).filter(b => b.plugin && b.plugin.type);
}

function candies() {
  return Composite.allBodies(world).filter(b => b.plugin && b.plugin.candy);
}

// 盤面に存在する全ピース。上限管理とゲームオーバー判定はこちらを見る
function pieces() {
  return Composite.allBodies(world).filter(b => b.plugin && (b.plugin.type || b.plugin.candy));
}

function spawnBlocked(x) {
  // 出現位置に前のフルーツがまだ居るなら撃たせない（重なりによる吹き飛び防止）
  const region = { min: { x: x - R, y: SPAWN_Y - R }, max: { x: x + R, y: SPAWN_Y + R } };
  return Query.region(pieces(), region).length > 0;
}

// クリックを受け付ける入口。撃てない瞬間でも取りこぼさず、少しの間だけ発射を保留する。
//
// 落下中のキャンディーが出現帯を通過している最中や、クールダウン中にクリックすると、
// 以前は何も起きずに入力が消えていた。プレイヤーからは「クリックが効かない」としか見えない。
function startGame() {
  reset();                 // ここで初めてキャンディーのタイマーが動き出す
  state.best = readBest(state.stage);
  state.started = true;
  state.dropped = false;
  Sound.bgmStart(state.musicDelay || 0);
  state.musicDelay = 0;
  Sound.showPanel(false);
}

// ボタン（はじめる・器）を押したら、キラキラを鳴らし、その画面で少し見せてから移る。
// すぐ切り替わると、押した手ごたえが無いまま画面が変わってしまう
const LEAVE_MS = 700;
function beginLeave(kind) {
  if (state.leaving) return;
  Sound.unlock();
  const kira = Sound.kira();
  state.leaving = { kind, at: performance.now() };
  // 曲はキラキラが鳴り終わってから。画面が移る時点からの残り時間
  state.musicDelay = Math.max(0, kira - LEAVE_MS);
  Sound.bgmStop();
}

// タイトル中に毎フレーム呼ぶ。待ち時間が過ぎたら移る
function updateLeave() {
  const lv = state.leaving;
  if (!lv || performance.now() - lv.at < LEAVE_MS) return;
  state.leaving = null;
  if (lv.kind === 'splash') {
    state.splash = false;
    Sound.titleMusic(state.musicDelay);
    state.musicDelay = 0;
  } else {
    startGame();
  }
}

// ゲームオーバー後はタイトルに戻る。器を選び直せるように
function goTitle() {
  Sound.titleMusic();
  Sound.showPanel(true);
  releaseLock();
  state.holding = false;
  state.bests = null;
  state.started = false;
  state.gameOver = false;
  state.titleT = 0;
}

// タイトルでのクリック。未解放の器は選べない
// 「はじめる」画面を抜けて、器の一覧へ。ここで音が出せるようになるので、タイトルの曲を鳴らす
function leaveSplash() {
  beginLeave('splash');
}

function titleClick() {
  if (state.leaving) return;           // 移る途中の連打は無視
  if (state.splash) { leaveSplash(); return; }
  const r = titleRowAt(state.pointerY);
  if (r > state.unlocked) { state.lockFlash = 40; Sound.deny(); return; }
  if (r >= 0) state.titleSel = r;
  beginLeave('start');
}

function requestDrop() {
  if (!state.started) { titleClick(); return; }
  if (state.gameOver) { goTitle(); return; }
  state.wantDropAt = performance.now();
  state.wantDropX = clamp(state.pointerX, dropLo(), dropHi());
  drop();
}

// 押し始めたら1発撃ち、以降は離すまで一定間隔で撃ち続ける
function beginHold() {
  if (!state.started || state.gameOver) return;
  state.holding = true;
  requestDrop();
  state.nextAutoAt = performance.now() + AUTO_FIRE_MS;
}

function endHold() {
  state.holding = false;
  // 連射の最後の1発が「出現位置が塞がっていて保留」になっていると、離した後に落ちてくる。
  // 離したら止まる、を守るため保留も捨てる
  state.wantDropAt = 0;
}

function updateAutoFire() {
  if (!state.holding || state.gameOver) return;
  const now = performance.now();
  if (now < state.nextAutoAt) return;
  requestDrop();
  state.nextAutoAt = now + AUTO_FIRE_MS;
}

// 保留中の発射を毎フレーム試す
function updatePendingDrop() {
  if (!state.wantDropAt) return;
  if (performance.now() - state.wantDropAt > DROP_BUFFER) {
    state.wantDropAt = 0;   // 諦める。これ以上待つと意図しない位置に落ちる
    return;
  }
  drop();
}

function drop() {
  if (state.gameOver) { reset(); return; }
  const now = performance.now();
  if (now - state.lastDrop < DROP_COOLDOWN) return;

  // 保留中ならクリック時点の x を使う。待っている間にカーソルが動いても狙い通りに落ちる
  const x = state.wantDropAt ? state.wantDropX : clamp(state.pointerX, dropLo(), dropHi());
  if (spawnBlocked(x)) return;
  if (pieces().length >= MAX_BODIES) return;

  const type = state.queue.shift();
  fillQueue();

  const b = makePieceBody(type, x, SPAWN_Y);
  Composite.add(world, b);
  state.lastDrop = now;
  state.wantDropAt = 0;
  state.dropped = true;
  Sound.fire();
}

// ---- キャンディー投入（設計書 7）----------------------------------------

function spawnCandy() {
  const [olo, ohi] = container().opening;
  const x = clamp(olo + CANDY_R + 4 + Math.random() * (ohi - olo - CANDY_R * 2 - 8),
                  olo + CANDY_R + 2, ohi - CANDY_R - 2);
  // 画面外の上から入れる。フルーツの出現帯（SPAWN_Y ± R）に居座ると、その真下の x で
  // プレイヤーが撃てなくなる
  Composite.add(world, makeCandyBody(x, -CANDY_R - 12));
}

// 中央の丸 + 左右のひねりを1つのボディにまとめる。
// 凹んだ輪郭なので単一の凸多角形では作れない
function makeCandyBody(x, y) {
  const g = candyGeom(CANDY_R);
  const parts = [Bodies.circle(x, y, g.cr, Object.assign({}, CANDY_PHYS))];

  for (const s of [1, -1]) {
    const verts = g.wedge.map(p => ({ x: p.x * s, y: p.y }));
    const c = Matter.Vertices.centre(verts);
    // fromVertices は重心を指定位置に合わせる。ずらしたい分を足しておく
    const w = Bodies.fromVertices(x + c.x, y + c.y, [verts], Object.assign({}, CANDY_PHYS));
    if (w) parts.push(w);
  }

  const body = Body.create(Object.assign({}, CANDY_PHYS, {
    parts,
    label: 'candy',
    plugin: { candy: true, reach: CANDY_REACH },
  }));
  return body;
}

function updateCandy() {
  const now = performance.now();
  if (now < state.nextCandyAt) return;

  const n = candyCount(state.wave);
  for (let i = 0; i < n; i++) {
    if (pieces().length >= MAX_BODIES) break;
    spawnCandy();
  }
  state.wave++;
  state.nextCandyAt = now + candyInterval(state.wave);
}






// ---- つながり判定（設計書 5.1）-------------------------------------------

const settled = b => b.speed < SETTLE_SPEED && b.angularSpeed < SETTLE_SPEED;

const near = (a, b) =>
  Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
    < a.plugin.reach + b.plugin.reach;

function findGroups(list) {
  const seen = new Set();
  const groups = [];

  for (const start of list) {
    if (seen.has(start.id)) continue;
    const group = [];
    const stack = [start];
    seen.add(start.id);

    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      for (const other of list) {
        if (seen.has(other.id)) continue;
        if (other.plugin.type !== cur.plugin.type) continue;
        if (!near(cur, other)) continue;
        seen.add(other.id);
        stack.push(other);
      }
    }
    if (group.length >= MATCH) groups.push(expandGroup(group));
  }
  return groups;
}

// 確定したグループを、静止判定を通っていない同種にも広げる。
//
// グループの発見は静止しているボディだけで行う（空中で消えるのを避けるため / 5.2）。
// だがその条件のまま消すと、4体つながっていても1体がまだ揺れている場合に3体しか消えず、
// 「つながっているのに消え残る」という理不尽が起きる。
// 起点が既に MATCH 体以上の静止クラスタである以上、そこから同種でつながっている分は
// 揺れていてもまとめて消す。
function expandGroup(group) {
  const all = drops();
  const inGroup = new Set(group.map(b => b.id));
  const stack = group.slice();

  while (stack.length) {
    const cur = stack.pop();
    for (const other of all) {
      if (inGroup.has(other.id)) continue;
      if (other.plugin.type !== cur.plugin.type) continue;
      if (!near(cur, other)) continue;
      inGroup.add(other.id);
      group.push(other);
      stack.push(other);
    }
  }
  return group;
}

// 消去確定したフルーツ群を起点に、隣接するおじゃまを層状に辿る。
// 辿る対象はおじゃまのみ。間にフルーツが挟まっていればそこで打ち切られる（設計書 3.2）
function collectCandy(clearedGirls, layers) {
  if (layers < 1) return [];
  const pool = candies();
  if (!pool.length) return [];

  const taken = new Set();
  const swept = [];
  let frontier = clearedGirls;

  for (let L = 0; L < layers; L++) {
    const next = [];
    for (const c of pool) {
      if (taken.has(c.id)) continue;
      if (!frontier.some(f => near(f, c))) continue;
      taken.add(c.id);
      next.push(c);
      swept.push(c);
    }
    if (!next.length) break;   // これ以上広がらない
    frontier = next;
  }
  return swept;
}

function scan() {
  const now = performance.now();
  if (now < state.recheckAt) return;

  const list = drops().filter(settled);
  if (list.length < MATCH) return;

  const groups = findGroups(list);
  if (!groups.length) return;

  // 連鎖判定
  state.chain = (now - state.lastClear < CHAIN_WINDOW) ? state.chain + 1 : 1;
  state.lastClear = now;

  // expandGroup で広げた結果、別々のグループが同じボディを拾うことがある。
  // 二重に消すとスコアが水増しされるため、ここで一意にする
  let cleared = 0;
  const clearedGirls = [];
  const taken = new Set();
  for (const g of groups) {
    for (const b of g) {
      if (taken.has(b.id)) continue;
      taken.add(b.id);
      removeQueue.push(b);
      clearedGirls.push(b);
      // 消える瞬間は全員が大の字になる。途中で閉じかけていても揃える
      state.effects.push({ x: b.position.x, y: b.position.y, angle: b.angle, type: b.plugin.type, t: 0 });
      cleared++;
    }
  }

  // 巻き込まれるキャンディー。連鎖数だけ層が広がる（設計書 3.2）
  const swept = collectCandy(clearedGirls, Math.min(state.chain, CANDY_LAYER_CAP));
  for (const c of swept) {
    removeQueue.push(c);
    state.effects.push({ x: c.position.x, y: c.position.y, candy: true, t: 0 });
  }

  Sound.pop(state.chain, cleared + swept.length);

  const gained = cleared * BASE_SCORE * state.chain
               + swept.length * CANDY_SCORE * state.chain;
  state.score += gained;
  state.gradeScore += gained;
  state.recheckAt = now + RECHECK_DELAY;

  // 目標点に届いたらグレードクリア
  if (!state.clearT && state.gradeScore >= gradeTarget(state.grade)) {
    beginGradeClear();
  }
}

// 着地の音（ぽよん / おじゃまは ぽすっ）。ぶつかった瞬間の相対速度が大きいときだけ鳴らす。
// 同じボディが細かく跳ね続けても鳴りっぱなしにならないよう、ボディごとに間隔を空ける
const LAND_SPEED = 2.2;
const LAND_GAP_MS = 180;
Events.on(engine, 'collisionStart', ev => {
  const now = performance.now();
  for (const pair of ev.pairs) {
    const a = pair.bodyA.parent, b = pair.bodyB.parent;
    const speed = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
    if (speed < LAND_SPEED) continue;
    // 速く動いていた側の音を鳴らす
    const mover = a.isStatic ? b : b.isStatic ? a : (a.speed >= b.speed ? a : b);
    if (!mover.plugin || now - (mover.plugin.sfxAt || 0) < LAND_GAP_MS) continue;
    mover.plugin.sfxAt = now;
    if (mover.plugin.candy) Sound.thud(speed);
    else Sound.land(speed, palette().findIndex(t => t.id === mover.plugin.type));
  }
});

// 消去は afterUpdate でまとめて実行（設計書 5.3）
Events.on(engine, 'afterUpdate', () => {
  if (!removeQueue.length) return;
  for (const b of removeQueue) Composite.remove(world, b);
  removeQueue.length = 0;
  // 支えが消えたので、眠っている飴を全部起こす
  for (const b of Composite.allBodies(world)) if (b.isSleeping) Sleeping.set(b, false);
});

// ---- グレード進行（シンプル版）--------------------------------------------

function beginGradeClear() {
  state.clearT = GRADE_CLEAR_HOLD;
  Sound.gradeClear();
  if (!GRADE_SWEEP) return;   // 盤面はそのまま次のグレードへ持ち越す

  // 残っていた分は掃除してボーナスにする。盤面を空にして次へ進む
  for (const b of pieces()) {
    removeQueue.push(b);
    if (b.plugin.candy) {
      state.effects.push({ x: b.position.x, y: b.position.y, candy: true, t: 0 });
    } else {
      state.effects.push({
        x: b.position.x, y: b.position.y, angle: b.angle, type: b.plugin.type, t: 0,
      });
      state.score += GRADE_SWEEP_SCORE;
    }
  }
}

function finishGradeClear() {
  state.grade++;
  state.gradeScore = 0;
  state.clearT = 0;

  // 「つぎ」に並んでいる分はそのまま使う（引き直すと、見ていた順番が急に変わってしまう）。
  // 新しい色は、ここから先に足す分（今並んでいる分を落としたあと）から混ざる

  // お邪魔のペースはグレードに応じて速くする。
  //
  // ここで wave を 0 に戻すと「1回1個・7秒間隔」から仕切り直しになり、
  // グレードが上がったのに圧力が下がって見える。グレードぶんの下駄を履かせて、
  // 進むほど確実に厳しくなるようにする
  state.wave = Math.max(0, (state.grade - 1) * WAVE_CARRY
                          - (colorAdded(state.grade) ? COLOR_RELIEF_WAVES : 0));
  state.nextCandyAt = performance.now() + CANDY_FIRST * gradeCandyScale(state.grade);
  state.recheckAt = 0;
  state.chain = 0;
  state.lastClear = -Infinity;

  // ライン超過の計測をここで切る。盤面を持ち越す場合、クリアした瞬間に山が高くても
  // 猶予を与える。クリアできたこと自体をご褒美にする
  state.overSince = 0;

  // この器で UNLOCK_GRADE をクリアしたら、次の器を解放する（器自体は変わらない）
  if (state.grade - 1 === UNLOCK_GRADE) unlockStage(state.stage + 1);
}

// ---- ゲームオーバー（設計書 7）------------------------------------------

// ピンチ（山がラインに迫っている）の判定。BGM をピンチ版に切り替える。
//
// 山の高さは「ラインより下にある飴のうち、上から PINCH_RANK 番目の上端」で測る。
// いちばん上の1個で測ると、壁に1個引っかかった・跳ねている、だけで大きくぶれ、
// ゲームオーバーの30秒前にラインを越えて見えたり、直前なのに余裕に見えたりした。
// 数個ぶん下を見ると、積もり方に沿って素直に上がる（止まっているかどうかも問わない）。
// 器の埋まり具合（面積）でも試したが、すなどけいはくびれが詰まって上だけ溜まるので使えなかった。
//
// 入る高さと戻る高さを分けて、境目で曲が行ったり来たりしないようにする。
// 高さは器ごと（器の pinch: [入る, 戻る]）。すなどけいは上の玉が小さく、くびれが詰まるとすぐ上まで溜まるので、
// 同じ高さにするとほぼずっとピンチになってしまう
const PINCH_RANK = 6;
const PINCH_DEFAULT = [210, 250];   // 山がラインまで 210 以内で入り、250 より離れたら戻る
const PINCH_ENTER_MS = 500;
const PINCH_EXIT_MS = 600;       // 戻りが遅いと、消して助かったのに焦った曲が続いてしまう
function pileLevel() {
  const ys = [];
  for (const b of pieces()) if (b.position.y > lineY()) ys.push(b.bounds.min.y - lineY());
  if (ys.length < PINCH_RANK) return Infinity;
  ys.sort((a, b) => a - b);
  return ys[PINCH_RANK - 1];
}

function updatePinch() {
  const now = performance.now();
  const level = pileLevel();
  const [enter, exit] = container().pinch || PINCH_DEFAULT;
  const want = state.pinch ? level < exit : level < enter;
  if (want === state.pinch) { state.pinchSince = 0; return; }
  if (!state.pinchSince) { state.pinchSince = now; return; }
  if (now - state.pinchSince > (want ? PINCH_ENTER_MS : PINCH_EXIT_MS)) {
    state.pinch = want;
    state.pinchSince = 0;
    Sound.setPinch(want);
  }
}

function checkGameOver() {
  const now = performance.now();
  // 判定対象は静止しているボディのみ。落下中を含めると自分の弾で誤爆する
  const over = pieces().some(b => settled(b) && b.position.y < lineY());

  if (!over) { state.overSince = 0; return; }
  if (!state.overSince) { state.overSince = now; return; }
  if (now - state.overSince > OVER_HOLD) {
    state.gameOver = true;
    state.overAt = now;
    state.holding = false;
    Sound.gameOver();
    Sound.bgmFade(0.4);     // がっかりの音を目立たせるため、BGM はすっと消す
    Sound.showPanel(true);
    releaseLock();          // 音量のパネルなどを触れるように、カーソルを返す
    if (state.score > state.best) {
      state.best = state.score;
      writeBest(state.stage, state.best);
    }
  }
}

// ---- 描画 ----------------------------------------------------------------

const ALL_TYPES = DROPS.concat([CANDY_TYPE]);
const colorOf = id => ALL_TYPES.find(t => t.id === id);

// ドロップを描く。
// 盤面の実体は body.vertices をそのままなぞるので、見た目と当たり判定が必ず一致する。
// 待機中の1個や NEXT のように実体が無いものは、同じ shapeVerts から形を起こす。
function traceVerts(verts, cx, cy) {
  ctx.beginPath();
  ctx.moveTo(verts[0].x - cx, verts[0].y - cy);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x - cx, verts[i].y - cy);
  ctx.closePath();
}

// 光源は画面の左上に固定。飴が回っても光は動かない。
// 艶は「光源に一番近い輪郭上の点」に置くので、形が回ると艶が表面を滑る
const LIGHT = (() => {
  const v = { x: -0.45, y: -1 };
  const n = Math.hypot(v.x, v.y);
  return { x: v.x / n, y: v.y / n };
})();
const LIGHT_ANGLE = Math.atan2(LIGHT.y, LIGHT.x);

// ---- 飴の絵をとっておく（スマホで重くなる対策） ---------------------------------
//
// 飴は形・柄・つや・グラデーションを毎コマ一から描いていて、盤面の飴が増えるほど重くなった
// （パソコンでも 90 個で描画に 1 コマ 18ms。スマホは数倍遅い）。
//
// 見た目は「種類」と「角度」だけで決まる。そこで種類ごとに、15° きざみ（24 枚）の角度の絵をとっておき、
// 毎コマは近い角度の絵を、残りの角度ぶんだけ回して貼る。形と柄はぴったり回り、ずれるのは
// 光源に合わせたつやの位置だけ（最大 7.5° ぶん。ほぼ見えない）。
//
// 最初はボディごとに今の角度の絵をとっておき、回ったら描き直していたが、大きく消えて山が崩れる瞬間は
// ほぼ全部が回るので、結局毎コマ描き直しになって重かった。共通の絵なら何個回っても描き直しは起きない。
// 消える演出（大きくなって薄れる）も同じ絵を拡大して貼る
const SPRITE_STEPS = 24;
const SPRITE_STEP = Math.PI * 2 / SPRITE_STEPS;
const spriteCache = new Map();

// 絵の中心はボディの重心（Matter はボディを重心で回す）。形の頂点の原点とはずれることがある
const shapeCentre = new Map();
function dropCentre(id) {
  if (!shapeCentre.has(id)) {
    const v = shapeVerts(colorOf(id).shape, R);
    shapeCentre.set(id, v ? Matter.Vertices.centre(v) : { x: 0, y: 0 });
  }
  return shapeCentre.get(id);
}

// kind：飴の id、またはおじゃまの 'candy'
function spriteFor(kind, step) {
  const sc = dpr;
  const key = kind + ':' + step + ':' + sc;
  let sp = spriteCache.get(key);
  if (sp) return sp;
  const a = step * SPRITE_STEP;
  const half = kind === 'candy' ? Math.ceil(CANDY_R * 1.35 + 6) : Math.ceil(R * 1.45 + 6);
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(half * 2 * sc);
  const g = c.getContext('2d');
  g.setTransform(sc, 0, 0, sc, 0, 0);
  g.translate(half, half);
  const screen = ctx;
  ctx = g;
  try {
    if (kind === 'candy') drawCandyRaw(0, 0, a, CANDY_R, 1);
    else {
      // 重心が絵の中心に来るよう、形の原点をずらして描く
      const o = dropCentre(kind);
      const cos = Math.cos(a), sin = Math.sin(a);
      drawDropRaw(-(o.x * cos - o.y * sin), -(o.x * sin + o.y * cos), a, R, kind, 1);
    }
  } finally { ctx = screen; }
  sp = { canvas: c, half };
  spriteCache.set(key, sp);
  return sp;
}

// (x, y) を重心として、angle の向きで貼る。scale で大きさ、alpha で濃さ
function blitSprite(kind, x, y, angle, scale, alpha) {
  const t = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const step = Math.round(t / SPRITE_STEP) % SPRITE_STEPS;
  const sp = spriteFor(kind, step);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(t - step * SPRITE_STEP);
  ctx.scale(scale, scale);
  ctx.drawImage(sp.canvas, -sp.half, -sp.half, sp.half * 2, sp.half * 2);
  ctx.restore();
}

// 盤面の飴（body あり）と消える演出（盤面の大きさ R の倍数）は絵を貼る。
// 待機中の1個・つぎ・タイトルなど、大きさの違うものはそのまま描く
function drawDrop(x, y, angle, r, id, alpha, body) {
  if (body) blitSprite(id, body.position.x, body.position.y, body.angle, 1, alpha);
  else if (r >= R) blitSprite(id, x, y, angle, r / R, alpha);
  else drawDropRaw(x, y, angle, r, id, alpha, body);
}

function drawDropRaw(x, y, angle, r, id, alpha, body) {
  const c = colorOf(id);
  ctx.save();
  ctx.globalAlpha = alpha;

  // 原点中心の頂点列を作る。これを輪郭にも光の計算にも使う
  let local = null;
  if (body && body.vertices) {
    // 実体があるときは頂点をそのまま使う（回転も位置も織り込み済み）
    ctx.translate(body.position.x, body.position.y);
    local = body.vertices.map(v => ({
      x: v.x - body.position.x, y: v.y - body.position.y,
    }));
  } else {
    ctx.translate(x, y);
    const v = shapeVerts(c.shape, r);
    if (v) {
      // 回転は頂点側に入れる。光の計算を回転後の形で行うため
      const cos = Math.cos(angle), sin = Math.sin(angle);
      local = v.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
    }
  }

  if (local) traceLocal(local);
  else { ctx.beginPath(); ctx.arc(0, 0, circleR(r), 0, Math.PI * 2); }

  // 光源方向・その逆方向に、輪郭がどこまで伸びているか
  let lit = circleR(r), dark = circleR(r);
  if (local) {
    let mx = -Infinity, mn = Infinity;
    for (const p of local) {
      const d = p.x * LIGHT.x + p.y * LIGHT.y;
      if (d > mx) mx = d;
      if (d < mn) mn = d;
    }
    lit = mx; dark = -mn;
  }

  // 明暗も光源の向きに沿わせる。真上からの決め打ちだと回転に付いてこない
  const g = ctx.createLinearGradient(
    LIGHT.x * lit, LIGHT.y * lit, -LIGHT.x * dark, -LIGHT.y * dark);
  g.addColorStop(0, c.shine);
  g.addColorStop(0.42, c.color);
  g.addColorStop(1, shade(c.color, 0.72));
  ctx.fillStyle = g;
  ctx.fill();

  // 縁は黒ではなく自分の色を濃くしたもので締める。黒で囲むと濁って見える
  ctx.lineWidth = Math.max(1, r * 0.09);
  ctx.strokeStyle = shade(c.color, 0.55);
  ctx.stroke();

  ctx.clip();

  // 柄。飴と一緒に回る（表面に描いてあるもの）。艶は光源なので回さない
  if (c.pattern) {
    ctx.save();
    ctx.rotate(body ? body.angle : angle);
    drawPattern(c.pattern, circleR(r), alpha);
    ctx.restore();
  }

  // 艶。光源側の輪郭のすぐ内側に置き、長軸を surface に沿わせる
  ctx.globalAlpha = alpha * 0.9;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(LIGHT.x * lit * 0.56, LIGHT.y * lit * 0.56,
              r * 0.30, r * 0.16, LIGHT_ANGLE + Math.PI / 2, 0, Math.PI * 2);
  ctx.fill();

  // 反対側の照り返し。これがあると「なめると甘そう」な質感になる
  ctx.globalAlpha = alpha * 0.28;
  ctx.fillStyle = c.shine;
  ctx.beginPath();
  ctx.ellipse(-LIGHT.x * dark * 0.6, -LIGHT.y * dark * 0.6,
              r * 0.40, r * 0.15, LIGHT_ANGLE + Math.PI / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---- 飴の柄 ----------------------------------------------------------------
//
// 原点中心・上向きの座標で描く（回転は呼び出し側で済ませてある）。r は飴の見た目の半径。
// 形の内側でクリップされているので、はみ出しは気にしなくてよい。
// どれも色を邪魔しないよう半透明にし、柄だけで種類が分かるほど強くはしない

// 毎回同じ位置に点を打つための疑似乱数。フレームごとに柄が揺れないようにする
function speckles(n, seed, rMax) {
  const pts = [];
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * rMax;
    pts.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, k: rnd() });
  }
  return pts;
}
const PEAR_DOTS = speckles(10, 17, 0.7);
const BLUEBERRY_BLOOM = speckles(14, 211, 0.78);

function leaf(x, y, len, rot, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.5, -len * 0.42, len, 0);
  ctx.quadraticCurveTo(len * 0.5, len * 0.42, 0, 0);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawPattern(kind, r, alpha) {
  ctx.lineCap = 'round';
  switch (kind) {
    case 'melon': {
      // メロンの網目。斜めの2方向に、少しうねった線を引く
      ctx.globalAlpha = alpha * 0.45;
      ctx.strokeStyle = '#f4ffcf';
      ctx.lineWidth = r * 0.06;
      for (const dir of [1, -1]) {
        for (let i = -3; i <= 3; i++) {
          const o = i * r * 0.44;
          ctx.beginPath();
          ctx.moveTo(-r * 1.2, o - dir * r * 1.2);
          ctx.quadraticCurveTo(0, o + r * 0.08, r * 1.2, o + dir * r * 1.2);
          ctx.stroke();
        }
      }
      // ツル。メロンらしいT字の軸と、くるっと巻いたひげ
      ctx.globalAlpha = alpha * 0.95;
      ctx.strokeStyle = '#6f8f34';
      ctx.lineWidth = r * 0.1;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.62);
      ctx.lineTo(0, -r * 0.94);
      ctx.moveTo(-r * 0.2, -r * 0.9);
      ctx.lineTo(r * 0.2, -r * 0.9);
      ctx.stroke();
      ctx.lineWidth = r * 0.045;
      ctx.beginPath();
      ctx.moveTo(r * 0.2, -r * 0.9);
      ctx.quadraticCurveTo(r * 0.42, -r * 0.98, r * 0.4, -r * 0.78);
      ctx.arc(r * 0.33, -r * 0.78, r * 0.07, 0, Math.PI * 1.4);
      ctx.stroke();
      break;
    }
    case 'pear': {
      // 洋なし。そばかすの点と、先端の軸と葉っぱ
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = '#b89a6e';
      for (const p of PEAR_DOTS) {
        ctx.beginPath();
        ctx.arc(p.x * r, p.y * r + r * 0.12, r * (0.03 + p.k * 0.025), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha * 0.95;
      ctx.strokeStyle = '#8a6a44';
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.62);
      ctx.lineTo(r * 0.04, -r * 0.92);
      ctx.stroke();
      leaf(r * 0.04, -r * 0.8, r * 0.36, -0.5, '#7fc24a');
      break;
    }
    case 'strawberry': {
      // いちご。互い違いに並んだつぶつぶと、上のヘタ
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = '#ffe9a8';
      const step = r * 0.36;
      for (let row = -2; row <= 2; row++) {
        for (let col = -2; col <= 2; col++) {
          const x = col * step + (row % 2 ? step / 2 : 0);
          const y = row * step * 0.9 + r * 0.14;
          if (x * x + y * y > r * r * 0.8) continue;
          ctx.beginPath();
          ctx.ellipse(x, y, r * 0.045, r * 0.07, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // ヘタは上の中央から下向きに垂れる5枚。放射状に開くと小さく見えてツヤに隠れる
      ctx.globalAlpha = alpha;
      for (let i = 0; i < 5; i++) {
        leaf(0, -r * 0.74, r * 0.4, Math.PI * (0.1 + i * 0.2), '#5fb04a');
      }
      ctx.strokeStyle = '#4f9a3a';
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.74);
      ctx.lineTo(0, -r * 0.98);
      ctx.stroke();
      break;
    }
    case 'blueberry': {
      // ブルーベリー。表面の白い粉（ブルーム）を細かい点で、真ん中に星形のがく（5 つに割れた先）。
      // がくの先は五角形の角にそろえる
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = '#ffffff';
      for (const b of BLUEBERRY_BLOOM) {
        ctx.beginPath();
        ctx.arc(b.x * r, b.y * r, r * (0.025 + b.k * 0.035), 0, Math.PI * 2);
        ctx.fill();
      }
      const star = (ro, ri) => {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 5;
          const d = (i % 2 ? ri : ro) * r;
          i ? ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d) : ctx.moveTo(Math.cos(a) * d, Math.sin(a) * d);
        }
        ctx.closePath();
      };
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = '#2b4f9a';
      ctx.lineJoin = 'round';
      ctx.lineWidth = r * 0.06;
      ctx.strokeStyle = '#2b4f9a';
      star(0.3, 0.13);
      ctx.fill();
      ctx.stroke();
      // がくの内側は少し明るく、くぼみに見せる
      ctx.fillStyle = '#5d86d6';
      star(0.16, 0.07);
      ctx.fill();
      break;
    }
    case 'grape': {
      // ぶどう。逆三角の房。粒を塗りつぶし、一粒ずつに小さなツヤを入れる。
      // 輪郭だけの丸だと泡に見えてしまう
      const br = r * 0.24;
      // 形が縦長なので、横は詰めて段の間を広げる
      const berries = [
        [-0.4, -0.38], [0, -0.38], [0.4, -0.38],
        [-0.2, 0.0], [0.2, 0.0],
        [0, 0.38],
      ];
      for (const [bx, by] of berries) {
        const x = bx * r, y = by * r;
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = '#8a3cb3';
        ctx.beginPath();
        ctx.arc(x, y, br, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = '#dca8f2';
        ctx.beginPath();
        ctx.arc(x - br * 0.1, y - br * 0.1, br * 0.72, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = alpha * 0.75;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x - br * 0.35, y - br * 0.38, br * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha * 0.95;
      ctx.strokeStyle = '#6b8f3a';
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.6);
      ctx.lineTo(r * 0.05, -r * 0.94);
      ctx.stroke();
      leaf(r * 0.05, -r * 0.8, r * 0.42, -0.35, '#7fc24a');
      break;
    }
    case 'orange': {
      // オレンジの輪切り。外側の皮（飴そのものの色）→ 白い輪 → 実。実は白い線で 6 つの房に分ける。
      // 房は六角の角に合わせる。角と房の筋がそろうと輪切りらしく見える
      const pith = r * 0.66;
      ctx.globalAlpha = alpha;
      // 白い輪（実の外側まで白く塗り、その内側に実を重ねる）
      ctx.fillStyle = '#fffbea';
      ctx.beginPath();
      ctx.arc(0, 0, pith, 0, Math.PI * 2);
      ctx.fill();
      // 実
      ctx.fillStyle = '#ffb04a';
      ctx.beginPath();
      ctx.arc(0, 0, pith - r * 0.09, 0, Math.PI * 2);
      ctx.fill();
      // 房の間の白い線と、真ん中の白い芯
      ctx.strokeStyle = '#fffbea';
      ctx.lineCap = 'round';
      ctx.lineWidth = r * 0.06;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * (pith - r * 0.09), Math.sin(a) * (pith - r * 0.09));
        ctx.stroke();
      }
      ctx.fillStyle = '#fffbea';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.globalAlpha = alpha;
}

// 色を暗くする。#rrggbb 前提
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}


function drawPiece(x, y, angle, r, id, alpha, body) {
  drawDrop(x, y, angle, r, id, alpha, body);
}


// お邪魔は飴ではなく「包み紙」。**つやを飴と揃えない。**
// 紙はマットなので、鋭いハイライトを入れると中身の見えるキャンディに見えてしまい、
// 美味しそうな飴と区別がつかなくなる
function drawCandy(x, y, angle, r, alpha, body) {
  if (body) blitSprite('candy', body.position.x, body.position.y, body.angle, 1, alpha);
  else if (r >= CANDY_R) blitSprite('candy', x, y, angle, r / CANDY_R, alpha);
  else drawCandyRaw(x, y, angle, r, alpha, body);
}

function drawCandyRaw(x, y, angle, r, alpha, body) {
  const g = candyGeom(r);
  const base = CANDY_TYPE.color;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(body ? body.position.x : x, body ? body.position.y : y);
  ctx.rotate(body ? body.angle : angle);

  // ひねり。中央より暗くして、奥に折り込まれている感じを出す
  for (const s of [1, -1]) {
    ctx.beginPath();
    g.wedge.forEach((p, i) => {
      const px = p.x * s, py = p.y;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = shade(base, 0.78);
    ctx.fill();

    // ひねりの筋。先端に向かって収束させる
    ctx.strokeStyle = shade(base, 0.58);
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.lineCap = 'round';
    for (const k of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(s * r * 0.56, k * r * 0.13);
      ctx.lineTo(s * r * 0.96, k * r * 0.34);
      ctx.stroke();
    }
  }

  // 中央。紙なので明暗の差は弱く、境目もぼかさない
  ctx.beginPath();
  ctx.arc(0, 0, g.cr, 0, Math.PI * 2);
  const fill = ctx.createLinearGradient(0, -g.cr, 0, g.cr);
  fill.addColorStop(0, shade(base, 1.08));
  fill.addColorStop(1, shade(base, 0.86));
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.save();
  ctx.clip();

  // 縞。包み紙の柄
  ctx.globalAlpha = alpha * 0.5;
  ctx.fillStyle = '#2b2b34';
  ctx.rotate(-0.5);
  const pitch = r * 0.42, band = r * 0.17;
  for (let i = -4; i <= 4; i++) ctx.fillRect(i * pitch, -r * 2, band, r * 4);
  ctx.restore();

  // ハイライト。飴は鋭い白、包み紙は広くて弱い光にする。
  // 紙にも照りはあるが、飴と同じ強さで入れると中身が見えるキャンディに見える
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, g.cr, 0, Math.PI * 2);
  ctx.clip();
  ctx.rotate(-(body ? body.angle : angle));   // 光源は回転しない
  ctx.globalAlpha = alpha * 0.30;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(LIGHT.x * g.cr * 0.5, LIGHT.y * g.cr * 0.5,
              g.cr * 0.62, g.cr * 0.30, LIGHT_ANGLE + Math.PI / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 輪郭を締める。紙の縁
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(0, 0, g.cr, 0, Math.PI * 2);
  ctx.strokeStyle = shade(base, 0.6);
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.stroke();

  ctx.restore();
}

// 原点中心の頂点列をそのままなぞる
function traceLocal(verts) {
  if (!verts || !verts.length) return;
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
}

// 器の外を暗くする。遊べる範囲が形としてはっきり見えるように
function drawContainerBack() {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  const pts = container().outline;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = UI.outside;
  ctx.fill('evenodd');
  ctx.restore();
}

// 器の縁をガラス風に描く。飴より手前に描いて、中に入っている感じを出す
function drawContainerFront() {
  const c = container();
  if (c.id === 'box') return;   // 箱は画面の縁そのものなので描かない

  const pts = c.outline;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const stroke = (w, style) => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineWidth = w;
    ctx.strokeStyle = style;
    ctx.stroke();
  };
  stroke(9, UI.glassWide);   // ガラスの厚み
  stroke(2.2, UI.glassEdge); // 内側の縁の照り
  ctx.restore();
}

// 器が変わった直後の表示
function drawStageBanner() {
  if (!state.stageBanner) return;
  const t = state.stageBanner / STAGE_BANNER_FRAMES;
  const alpha = clamp(t > 0.8 ? (1 - t) / 0.2 : t < 0.2 ? t / 0.2 : 1, 0, 1);
  const age = (STAGE_BANNER_FRAMES - state.stageBanner) * (1000 / 60);
  const y = H / 2 + 96;   // グレードクリアの表示と重ならないよう下に出す
  cuteText('あたらしい うつわ が ひらいた', W / 2, y, 16,
    { colors: ['#43c4f0'], age, stagger: 16, alpha, weight: 700 });
  cuteText(CONTAINERS[state.bannerStage].name, W / 2, y + 42, 32,
    { colors: CANDY_INKS, age: age - 300, stagger: 60, bounce: true, alpha, stripes: true });
  return;
}

// 背景の柄は毎フレーム描かず、一度だけ別の canvas に描いておいて貼る
let bgCache = null;

function buildBackground() {
  const c = document.createElement('canvas');
  c.width = W * 2; c.height = H * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, UI.bgTop);
  grad.addColorStop(1, UI.bgBottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  if (UI.pattern === 'dots') {
    // 互い違いの水玉
    g.fillStyle = 'rgba(255,255,255,0.55)';
    const step = 44;
    for (let row = 0, y = 12; y < H + step; row++, y += step * 0.86) {
      for (let x = (row % 2) * step / 2; x < W + step; x += step) {
        g.beginPath();
        g.arc(x, y, 6.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else if (UI.pattern === 'stars') {
    // ピンクの水玉と、ところどころに小さな星
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    g.fillStyle = UI.patternDot;
    const step = 52;
    for (let row = 0, y = 14; y < H + step; row++, y += step * 0.86) {
      for (let x = (row % 2) * step / 2; x < W + step; x += step) {
        g.beginPath();
        g.arc(x, y, 5, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = UI.patternStar;
    for (let i = 0; i < 28; i++) {
      const x = rnd() * W, y = rnd() * H, s = 2 + rnd() * 3;
      g.beginPath();
      g.moveTo(x, y - s * 2);
      g.quadraticCurveTo(x, y, x + s * 2, y);
      g.quadraticCurveTo(x, y, x, y + s * 2);
      g.quadraticCurveTo(x, y, x - s * 2, y);
      g.quadraticCurveTo(x, y, x, y - s * 2);
      g.fill();
    }
  }
  return c;
}

function drawBackground() {
  if (!bgCache) bgCache = buildBackground();
  ctx.drawImage(bgCache, 0, 0, W, H);
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();

  if (!state.started) { drawTitle(); drawTrail(); return; }

  drawContainerBack();
  drawHudCards();

  // ゲームオーバーライン。器の内側の幅だけ引く
  const [llo, lhi] = container().line;
  ctx.strokeStyle = state.overSince ? '#e05c92' : UI.line;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(llo, lineY());
  ctx.lineTo(lhi, lineY());
  ctx.stroke();
  ctx.setLineDash([]);

  // 盤面の外へカーソルがはみ出している間、その端を光らせる。
  // カーソルを消しているので、これが無いと「動かしているのに反応しない」ようにしか見えない
  if (!state.gameOver && state.pushEdge) {
    const x0 = state.pushEdge < 0 ? 0 : W;
    const g2 = ctx.createLinearGradient(x0, 0, x0 + state.pushEdge * 46, 0);
    g2.addColorStop(0, 'rgba(246,200,106,0.30)');
    g2.addColorStop(1, 'rgba(246,200,106,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(state.pushEdge < 0 ? 0 : W - 46, 0, 46, H);
  }

  // 落下ガイド + 構えているフルーツ
  if (!state.gameOver) {
    const x = clamp(state.pointerX, dropLo(), dropHi());
    ctx.strokeStyle = UI.guide;
    ctx.lineWidth = R * 2;
    ctx.beginPath();
    ctx.moveTo(x, SPAWN_Y);
    ctx.lineTo(x, H);
    ctx.stroke();
    drawPiece(x, SPAWN_Y, 0, R, state.queue[0].id, 1);
  }

  for (const b of candies()) {
    drawCandy(b.position.x, b.position.y, b.angle, CANDY_R, 1, b);
  }

  for (const b of drops()) {
    drawPiece(b.position.x, b.position.y, b.angle, R, b.plugin.type, 1, b);
  }

  // 消滅エフェクト。
  // 線形に薄くすると出た瞬間から半透明に見えるため、前半は濃いまま保って
  // 後半で一気に抜く
  for (const e of state.effects) {
    const t = e.t / EFFECT_LIFE;
    const a = t < EFFECT_HOLD ? 1 : 1 - (t - EFFECT_HOLD) / (1 - EFFECT_HOLD);
    if (e.candy) drawCandy(e.x, e.y, 0, CANDY_R * (1 + t * 0.9), a);
    else drawPiece(e.x, e.y, e.angle || 0, R * (1 + t * 0.9), e.type, a);
  }

  drawContainerFront();

  drawHud();
  drawTrail();
}

// 連鎖表示。数が伸びるほど派手になる。
// 段階を「大きさ」「色」「縁取り」「発光」「揺れ」の順で足していき、
// 上に行くほど要素が増えるようにしている
const CHAIN_TIERS = [
  { at: 2, size: 30, fill: '#f6c86a', suffix: '' },
  { at: 3, size: 38, fill: '#ffd24a', suffix: '!' },
  { at: 4, size: 46, fill: '#ffb03a', suffix: '!' },
  { at: 5, size: 54, fill: '#ff8f4d', suffix: '!!' },
  { at: 6, size: 62, fill: '#ff6fa5', suffix: '!!' },
  { at: 7, size: 70, fill: '#e879f9', suffix: '!!!' },
];

function chainTier(n) {
  let t = CHAIN_TIERS[0];
  for (const c of CHAIN_TIERS) if (n >= c.at) t = c;
  return t;
}

// ---- かわいい文字 ----------------------------------------------------------
//
// ゲーム中に出る文字（連鎖・グレードクリアなど）は、白フチのシール風にして、
// 1文字ずつ飴の色で塗り、ぽよんと出して弾ませる

const CANDY_INKS = ['#ff6fa5', '#ff9f43', '#ffcf3a', '#6fd35a', '#43c4f0', '#a787fa'];

function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const m = c => Math.round(c + (255 - c) * k);
  return 'rgb(' + m((n >> 16) & 255) + ',' + m((n >> 8) & 255) + ',' + m(n & 255) + ')';
}

// 行き過ぎてから戻る動き。文字がぽよんと出てくる
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// o: { colors, age(ms), stagger(ms), bounce, tilt, alpha, weight }
function cuteText(str, x, y, size, o) {
  const chars = [...str];
  ctx.font = (o.weight || 800) + ' ' + size + 'px ' + FONT_FAMILY;
  const ws = chars.map(c => ctx.measureText(c).width);
  const gap = size * 0.02;
  const total = ws.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
  let cx = x - total / 2;

  chars.forEach((ch, i) => {
    const w = ws[i];
    const local = (o.age == null ? 1e9 : o.age) - i * (o.stagger || 0);
    const pop = clamp(local / 240, 0, 1);
    if (pop > 0 && ch !== ' ') {
      const sc = easeOutBack(pop);
      const bob = o.bounce ? Math.sin((o.age || 0) / 150 + i * 0.7) * size * 0.06 : 0;
      ctx.save();
      ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
      ctx.translate(cx + w / 2, y + bob);
      ctx.rotate(o.tilt ? Math.sin(i * 2.1) * 0.08 : 0);
      ctx.scale(sc, sc);
      ctx.textAlign = 'center';

      // 落ち影 → 白フチ → 色の順に重ねる
      ctx.fillStyle = 'rgba(40,40,100,0.18)';
      ctx.fillText(ch, size * 0.04, size * 0.09);
      ctx.lineJoin = 'round';
      if (o.rim) {
        ctx.lineWidth = size * 0.36;
        ctx.strokeStyle = o.rim;
        ctx.strokeText(ch, 0, 0);
      }
      ctx.lineWidth = size * 0.24;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(ch, 0, 0);
      const col = o.colors[i % o.colors.length];
      if (o.stripes) {
        // 点数と同じキャンディ：1 色にしま、上につや（しまは動かさない。動くと目がちらちらする）
        ctx.fillStyle = col;
        ctx.fillText(ch, 0, 0);
        ctx.fillStyle = candyStripes();
        ctx.fillText(ch, 0, 0);
        const gl = ctx.createLinearGradient(0, -size * 0.85, 0, -size * 0.3);
        gl.addColorStop(0, 'rgba(255,255,255,0.45)');
        gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl;
        ctx.fillText(ch, 0, 0);
      } else {
        const g = ctx.createLinearGradient(0, -size * 0.8, 0, size * 0.1);
        g.addColorStop(0, lighten(col, 0.4));
        g.addColorStop(1, col);
        ctx.fillStyle = g;
        ctx.fillText(ch, 0, 0);
      }
      ctx.restore();
    }
    cx += w + gap;
  });
}

// 4本の光のきらきら
function sparkle(x, y, s, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - s * 2);
  ctx.quadraticCurveTo(x, y, x + s * 2, y);
  ctx.quadraticCurveTo(x, y, x, y + s * 2);
  ctx.quadraticCurveTo(x, y, x - s * 2, y);
  ctx.quadraticCurveTo(x, y, x, y - s * 2);
  ctx.fill();
}

function drawChainCute() {
  if (state.chain < 2) return;
  const age = performance.now() - state.lastClear;
  if (age > CHAIN_WINDOW) return;

  const n = state.chain;
  const t = age / CHAIN_WINDOW;
  const alpha = t < 0.72 ? 1 : (1 - t) / 0.28;
  const bang = n >= 7 ? '！！！' : n >= 5 ? '！！' : '！';
  const size = 36 + Math.min(n, 8) * 4;

  // 連鎖が伸びるほど色が増える。7連鎖からは虹色が流れる
  let colors;
  if (n <= 2) colors = ['#ff6fa5'];
  else if (n === 3) colors = ['#ff9f43', '#ff6fa5'];
  else if (n < 7) colors = CANDY_INKS;
  else {
    const k = Math.floor(age / 90);
    colors = CANDY_INKS.map((_, i) => CANDY_INKS[(i + k) % CANDY_INKS.length]);
  }

  cuteText(n + 'れんさ' + bang, W / 2, H / 2 - 40, size,
    { colors, age, stagger: 40, bounce: true, tilt: true, alpha, stripes: true });

  // 5連鎖からはきらきらを散らす
  if (n >= 5) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const count = 4 + (n - 5) * 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + age / 400;
      const rx = size * 2.6, ry = size * 0.95;
      const s = 3 + Math.sin(age / 80 + i) * 1.6;
      sparkle(W / 2 + Math.cos(a) * rx, H / 2 - 52 + Math.sin(a) * ry,
              Math.max(1, s), i % 2 ? '#ffffff' : '#fff3a0');
    }
    ctx.restore();
  }
}


// タイトル画面。3人が並んで開閉し続ける
// フルーツドロップスのロゴ。
// 上に小さく「フルーツ」、下に大きく「ドロップス」。1文字ずつ果物の色で、白フチの外にピンクのフチを
// 重ねてシールのように見せる。文字はそれぞれ少しずつずれて弾み、まわりで星がまたたく
const LOGO_FRUIT_INKS = ['#6fbf3a', '#ff5f8f', '#ffb52e', '#9d6fd8'];     // メロン・いちご・レモン・ぶどう
function drawLogo(t) {
  const age = 600 + t * 16.7;          // 最初の 0.6 秒は飛ばす（毎回ポンと出ると落ち着かない）
  const rim = 'rgba(255,150,190,0.9)';
  cuteText('フルーツ', W / 2, 100, 30, { colors: LOGO_FRUIT_INKS, age, bounce: true, tilt: true, rim });
  cuteText('ドロップス', W / 2, 164, 58, { colors: CANDY_INKS, age, bounce: true, tilt: true, rim, stripes: true });

  // 星のまたたき。位置は固定で、明るさだけ順番に変える
  const stars = [[W / 2 - 150, 78, '#ffcf3a'], [W / 2 + 148, 96, '#ff8fc0'],
                 [W / 2 + 170, 150, '#ffffff'], [W / 2 - 172, 160, '#9fe0ff']];
  stars.forEach(([x, y, c], i) => {
    const k = 0.5 + 0.5 * Math.sin(t / 22 + i * 1.7);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * k;
    sparkle(x, y, 3 + 3 * k, c);
    ctx.restore();
  });
}

// 「タップして はじめる」。ぽよんと弾む文字を大きく
function drawSplash(t) {
  const age = 600 + t * 16.7;
  const k = leaveProgress();
  const pulse = k == null ? 1 + Math.sin(t / 14) * 0.04 : 1 + 0.22 * easeOutBack(Math.min(1, k * 3));
  ctx.save();
  ctx.translate(W / 2, 420);
  ctx.scale(pulse, pulse);
  cuteText('タップして はじめる', 0, 0, 30, { colors: CANDY_INKS, age, bounce: true, rim: 'rgba(255,150,190,0.9)', stripes: true });
  ctx.restore();
  if (k != null) burst(W / 2, 410, k, 150);

  ctx.textAlign = 'center';
  ctx.fillStyle = UI.mid;
  ctx.font = 'bold 13px ' + FONT_FAMILY;
  ctx.fillText('おとが でるよ', W / 2, 470);
  ctx.fillStyle = UI.sub;
  ctx.font = '12px ' + FONT_FAMILY;
  ctx.fillText('おんりょうは バーで ちょうせつ（M キーで オン・オフ）', W / 2, 492);
}

// 押してから移るまでの進み具合 0〜1（押していなければ null）
function leaveProgress() {
  return state.leaving ? clamp((performance.now() - state.leaving.at) / LEAVE_MS, 0, 1) : null;
}

// キラキラが飛び散る。k は 0〜1 の進み具合、spread は広がる距離
function burst(x, y, k, spread) {
  const colors = ['#ffffff', '#ffe27a', '#ff9fc8', '#9fe0ff'];
  ctx.save();
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + i * 0.37;
    const d = spread * (0.35 + 0.65 * Math.sin(k * Math.PI / 2)) * (0.6 + (i % 3) * 0.2);
    ctx.globalAlpha = 1 - k * k;
    sparkle(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, 2.5 + (1 - k) * 3, colors[i % colors.length]);
  }
  ctx.restore();
}

// 選んだ器の段：押したら白く光って、キラキラが飛び散る
function drawLeaveRow() {
  const k = leaveProgress();
  if (k == null || state.leaving.kind !== 'start') return;
  const top = titleRowTop(state.titleSel);
  ctx.save();
  ctx.globalAlpha = 0.55 * Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k * 0.5);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(TITLE_ROW_X, top, TITLE_ROW_W, TITLE_ROW_H, 14);
  ctx.fill();
  ctx.restore();
  burst(W / 2, top + TITLE_ROW_H / 2, k, 190);
}

// ---- マウスの星のキラキラ（パソコンだけ） ---------------------------------------
//
// マウスの通ったあとに星をこぼす（本物のカーソルはそのまま出す）。
//   タイトル・ゲームオーバー：マウスを動かすと星のかけらがこぼれる
//   遊んでいる間：構えている飴からキラキラがこぼれる（飴そのものが目印なので、カーソルは出さない）
// タッチでは出さない（指の下なので見えないし、要らない）
const TRAIL_LIFE = 46;
const TRAIL_MAX = 160;     // 「もうちょっとほしい」ので多め
const TRAIL_COLORS = ['#ffffff', '#ffe27a', '#ff9fc8', '#9fe0ff'];
function trailSource() {
  if (state.started && !state.gameOver) return { x: state.pointerX, y: SPAWN_Y - R * 0.6, playing: true };
  return { x: state.cursorX, y: state.pointerY, playing: false };
}
function updateTrail() {
  const tr = state.trail;
  for (let i = tr.length - 1; i >= 0; i--) {
    const p = tr[i];
    p.t++;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.03;
    if (p.t > TRAIL_LIFE) tr.splice(i, 1);
  }
  if (!state.mouse) { state.trailFrom = null; return; }
  const src = trailSource();
  const last = state.trailFrom;
  const moved = last ? Math.hypot(src.x - last.x, src.y - last.y) : 0;
  // 動いた距離に応じてこぼす。止まっていても時々またたく
  let n = Math.min(6, Math.floor(moved / 3.5));
  if (!n && state.frame % 6 === 0) n = 1 + (Math.random() < 0.4 ? 1 : 0);
  if (!last) n = 0;
  for (let i = 0; i < n && tr.length < TRAIL_MAX; i++) {
    const k = (i + 1) / n;
    tr.push({
      x: last.x + (src.x - last.x) * k + (Math.random() - 0.5) * 8,
      y: last.y + (src.y - last.y) * k + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * 0.7,
      vy: -0.3 + Math.random() * 0.5,
      // たまに大きめの ✨ を混ぜる
      s: Math.random() < 0.15 ? 5 + Math.random() * 2.5 : 2.2 + Math.random() * 2.6,
      c: TRAIL_COLORS[Math.floor(Math.random() * TRAIL_COLORS.length)],
      t: 0,
    });
  }
  state.trailFrom = { x: src.x, y: src.y };
  if (!state.started) state.frame++;       // タイトル中のまたたきの間隔に使う
}
function drawTrail() {
  if (!state.trail.length && !state.mouse) return;
  ctx.save();
  for (const p of state.trail) {
    const k = p.t / TRAIL_LIFE;
    ctx.globalAlpha = 1 - k * k;
    sparkle(p.x, p.y, p.s * (1 - k * 0.6), p.c);
  }
  ctx.restore();
}

function drawTitle() {
  const t = state.titleT;

  ctx.save();
  ctx.textAlign = 'center';

  drawLogo(t);

  // フルーツを1列に並べてゆっくり回す。形の違いがひと目で分かるように全色出す
  DROPS.forEach((ty, i) => {
    const x = W / 2 + (i - (DROPS.length - 1) / 2) * 58;
    const y = 222 + Math.sin(t / 28 + i * 0.9) * 5;
    drawDrop(x, y, t / 120 + i, 19, ty.id, 1);
  });
  if (state.splash) {
    drawSplash(t);
    ctx.restore();
    return;
  }
  drawStageList();
  drawLeaveRow();

  // 点滅する案内
  ctx.globalAlpha = 0.55 + Math.sin(t / 16) * 0.45;
  ctx.fillStyle = UI.ink;
  ctx.font = 'bold 18px ' + FONT_FAMILY;
  ctx.fillText('えらんで クリック', W / 2, 596);
  ctx.globalAlpha = 1;

  // 操作を最初に言う。ルールや進行はゲーム中に画面へ出るが、
  // 「どう遊ぶか」は最初に伝えないと何も始まらない
  const base = 632;
  ctx.fillStyle = UI.mid;
  ctx.font = 'bold 13px ' + FONT_FAMILY;
  ctx.fillText('おしている あいだ フルーツが おちてくるよ', W / 2, base);

  ctx.fillStyle = UI.sub;
  ctx.font = '12px ' + FONT_FAMILY;
  ctx.fillText('おなじ フルーツが 3つ つながると きえるよ', W / 2, base + 22);

  ctx.restore();
}

// グレードクリアの表示（ドロップス）
function drawGradeClearCute() {
  const age = (GRADE_CLEAR_HOLD - state.clearT) * (1000 / 60);
  const alpha = state.clearT < 24 ? state.clearT / 24 : 1;

  cuteText('グレード' + state.grade, W / 2, H / 2 - 64, 30,
    { colors: ['#43c4f0', '#a787fa'], age, stagger: 35, alpha, weight: 800 });
  cuteText('クリア！', W / 2, H / 2 - 6, 56,
    { colors: CANDY_INKS, age: age - 200, stagger: 70, bounce: true, tilt: true, alpha });

  // きらきら
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + age / 500;
    const s = 3 + Math.sin(age / 90 + i * 1.3) * 1.8;
    sparkle(W / 2 + Math.cos(a) * 150, H / 2 - 30 + Math.sin(a) * 70,
            Math.max(1, s), i % 2 ? '#ffffff' : '#fff3a0');
  }
  ctx.restore();

  // 伝えるのは次のグレードで変わることだけ。仕様の説明は出さない
  if (gradeKinds(state.grade + 1) > gradeKinds(state.grade)) {
    cuteText('あたらしい フルーツ が でてくる！', W / 2, H / 2 + 40, 17,
      { colors: ['#ff6fa5'], age: age - 500, stagger: 18, alpha, weight: 700 });
  }
}


// ---- タイトルの器の一覧 -------------------------------------------------

const TITLE_ROW_Y0 = 272;
const TITLE_ROW_H = 62;
const TITLE_ROW_GAP = 12;
const TITLE_ROW_X = 76;
const TITLE_ROW_W = W - TITLE_ROW_X * 2;

const titleRowTop = i => TITLE_ROW_Y0 + i * (TITLE_ROW_H + TITLE_ROW_GAP);

// 高さだけで判定する。横はどこを指していても、その段を選んだことにする
function titleRowAt(y) {
  for (let i = 0; i < CONTAINERS.length; i++) {
    const top = titleRowTop(i);
    if (y >= top && y <= top + TITLE_ROW_H) return i;
  }
  return -1;
}

// 器の形を小さく描く。一覧で形の違いが分かるように
function drawStageIcon(c, x, y, size, color) {
  const yMin = 90;   // 輪郭の上端は画面外まで伸びているので、見える範囲に切る
  ctx.beginPath();
  c.outline.forEach((p, i) => {
    const px = x + (p.x / W) * size;
    const py = y + ((Math.max(yMin, p.y) - yMin) / (H - yMin)) * size;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawLockIcon(x, y, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y - 4, 5, Math.PI, 0);
  ctx.stroke();
  ctx.fillRect(x - 7, y - 4, 14, 11);
}

function drawStageList() {
  if (!state.bests) state.bests = CONTAINERS.map((_, i) => readBest(i));

  CONTAINERS.forEach((c, i) => {
    const top = titleRowTop(i);
    const locked = i > state.unlocked;
    const sel = i === state.titleSel;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(TITLE_ROW_X, top, TITLE_ROW_W, TITLE_ROW_H, 14);
    ctx.fillStyle = sel ? UI.rowSel : UI.rowBg;
    ctx.fill();
    if (sel) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = UI.rowBorder;
      ctx.stroke();
    }

    const ink = locked ? UI.dim : sel ? UI.accent : UI.soft;
    drawStageIcon(c, TITLE_ROW_X + 16, top + 11, 40, ink);

    ctx.textAlign = 'left';
    ctx.fillStyle = locked ? UI.dim : UI.ink;
    ctx.font = 'bold 18px ' + FONT_FAMILY;
    ctx.fillText(c.name, TITLE_ROW_X + 72, top + (locked ? 28 : 38));

    if (locked) {
      // 解放の条件を出す。選ぼうとしたときは色を変えて気づかせる
      ctx.font = '11px ' + FONT_FAMILY;
      ctx.fillStyle = state.lockFlash > 0 ? '#e05c92' : UI.sub;
      ctx.fillText(CONTAINERS[i - 1].name + ' で グレード' + UNLOCK_GRADE + ' クリア',
                   TITLE_ROW_X + 72, top + 47);
      drawLockIcon(TITLE_ROW_X + TITLE_ROW_W - 26, top + TITLE_ROW_H / 2 + 2, UI.dim);
    } else {
      ctx.textAlign = 'right';
      ctx.font = '12px ' + FONT_FAMILY;
      ctx.fillStyle = UI.mid;
      ctx.fillText('ベスト ' + state.bests[i], TITLE_ROW_X + TITLE_ROW_W - 16, top + 38);
    }
    ctx.restore();
  });
}


// ---- ドロップスの上の表示 ------------------------------------------------
//
// 一番上に細い帯を1段だけ。落とす飴の出る帯（SPAWN_Y ± R）より上に収める。
// 最初は2段の大きなカードにしたが、落とす飴のアイコンと重なって「かぶるのよくない」と言われた。
//   左：点数・グレード・しま模様のメーター
//   右：つぎの飴（シャボン玉の中）・おじゃま（包み紙のキャンディ・×数・残り時間の輪）
// カードはふだん左右 232 ずつ。音量パネルがゲーム画面の外に置けないとき（Sound.compact）は、
// 帯のいちばん右に 🔊 ボタンの場所（38）を空けて、カードを 211 ずつに詰める（sound.js がそこにボタンを置く）
const HUD_TOP = 4, HUD_H = 38, HUD_LX = 6;
let HUD_W = 232, HUD_RX = W - 6 - HUD_W, hudCompact = false;
function updateHudLayout() {
  const compact = !!Sound.compact;
  if (compact === hudCompact) return;
  hudCompact = compact;
  HUD_W = compact ? 211 : 232;
  HUD_RX = HUD_LX + HUD_W + 4;
  hudCardsCache = null;        // カードの下地を描き直す
}
const HUD_MID = HUD_TOP + HUD_H / 2;
const HUD_PINK = '#ff7eb0', HUD_PURPLE = '#a38be0';

let hudCardsCache = null;
function drawHudCards() {
  updateHudLayout();
  const sc = dpr;
  if (!hudCardsCache || hudCardsCache.sc !== sc) {
    const c = document.createElement('canvas');
    c.width = W * sc;
    c.height = (HUD_TOP + HUD_H + 16) * sc;
    const g = c.getContext('2d');
    g.setTransform(sc, 0, 0, sc, 0, 0);
    const screen = ctx;
    ctx = g;
    try { drawHudCardsRaw(); } finally { ctx = screen; }
    hudCardsCache = { canvas: c, sc };
  }
  ctx.drawImage(hudCardsCache.canvas, 0, 0, W, HUD_TOP + HUD_H + 16);
}

function drawHudCardsRaw() {
  for (const x of [HUD_LX, HUD_RX]) {
    ctx.save();
    ctx.shadowColor = 'rgba(80,60,130,0.16)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.roundRect(x, HUD_TOP, HUD_W, HUD_H, HUD_H / 2);
    ctx.fillStyle = UI.cardBg || 'rgba(255,255,255,0.1)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2;
    ctx.strokeStyle = UI.cardEdge || UI.line;
    ctx.stroke();
    ctx.restore();
  }
}

// 小さな札（「つぎ」など）。幅を返す
function hudTag(text, x, y, color) {
  ctx.save();
  ctx.font = '800 11px ' + FONT_FAMILY;
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y - 9, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 7, y + 1);
  ctx.restore();
  return w;
}

// 白フチのシール文字（数字用）
function hudSticker(str, x, y, size, color, align) {
  ctx.save();
  ctx.font = '800 ' + size + 'px ' + FONT_FAMILY;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.26;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(str, x, y);
  const g = ctx.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.4);
  g.addColorStop(0, lighten(color, 0.35));
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

// メーターと点数に流す白いしま（小さな絵を敷き詰める模様）
let stripeTile = null;
function candyStripes() {
  if (!stripeTile) {
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 3.5;
    for (const o of [-12, 0, 12]) {
      g.beginPath();
      g.moveTo(o, 12);
      g.lineTo(o + 12, 0);
      g.stroke();
    }
    stripeTile = ctx.createPattern(c, 'repeat');
  }
  return stripeTile;
}

let lastScore = 0, scorePopAt = -1e9;
// 点数：ピンク1色にメーターと同じ白いしま（動かさない）。ゼリーのようにプルンと揺れる。
// 増えた瞬間は1文字ずつ少しずれて、縦に伸び・横に広がりを繰り返しながら収まる。ふだんもごくわずかに揺れる
function drawCandyScore(str, x, y, size, now) {
  if (state.score !== lastScore) {
    if (state.score > lastScore) scorePopAt = now;
    lastScore = state.score;
  }
  ctx.save();
  ctx.font = '800 ' + size + 'px ' + FONT_FAMILY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const pat = candyStripes();

  let cx = x;
  [...str].forEach((ch, i) => {
    const w = ctx.measureText(ch).width;
    // 増えた瞬間のプルン：減衰する振動（文字ごとに 40ms ずつ遅らせる）
    const t = (now - scorePopAt - i * 40) / 1000;
    const hit = t > 0 ? Math.exp(-t * 7) * Math.sin(t * 34) * 0.28 : 0;
    // ふだんのぷるぷる
    const idle = Math.sin(now / 260 + i * 0.9) * 0.025;
    const k = hit + idle;
    // 縦に伸びると横は縮む（体積を保つゼリーの動き）。足もと（ベースライン）を支点にする
    const sy = 1 + k, sx = 1 - k * 0.8;
    const base = y + size * 0.36;

    ctx.save();
    ctx.translate(cx + w / 2, base);
    ctx.scale(sx, sy);
    ctx.lineWidth = size * 0.3;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(ch, 0, 0);
    ctx.fillStyle = '#ff6fa5';
    ctx.fillText(ch, 0, 0);
    ctx.fillStyle = pat;
    ctx.fillText(ch, 0, 0);
    // つや
    const gl = ctx.createLinearGradient(0, -size * 0.85, 0, -size * 0.35);
    gl.addColorStop(0, 'rgba(255,255,255,0.5)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    cx += w;
  });
  ctx.restore();
}

// キャンディのしま模様のメーター（しまは動かさない。動くと目がちらちらする）
function hudMeter(x, y, w, h, p, now) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = UI.track;
  ctx.fill();
  if (p > 0) {
    const fw = Math.max(h, w * p);
    ctx.beginPath();
    ctx.roundRect(x, y, fw, h, h / 2);
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#ff8fbf');
    g.addColorStop(1, '#ffd35c');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 3.5;
    for (let sx = x - 20; sx < x + fw + 20; sx += 12) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + h, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x, y + 2, fw, 2.5);
  }
  ctx.restore();
}

function drawHudCute() {
  const now = performance.now();
  const y = HUD_MID;

  // ---- 左：点数・グレード・メーター ----
  drawCandyScore(String(state.score), HUD_LX + 16, y + 1, 23, now);
  // グレードの文字とメーターを縦に積む（横に並べるとメーターが短くなりすぎる）
  const gx = HUD_LX + 104, gw = HUD_LX + HUD_W - 14 - gx;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = HUD_PINK;
  ctx.font = '800 11px ' + FONT_FAMILY;
  ctx.fillText('グレード ' + state.grade, gx, y - 7);
  ctx.textBaseline = 'alphabetic';
  hudMeter(gx, y + 2, gw, 9, clamp(state.gradeScore / gradeTarget(state.grade), 0, 1), now);

  // ---- 右：つぎ ----
  let x = HUD_RX + 10;
  x += hudTag('つぎ', x, y, HUD_PINK) + 6;
  [12, 10, 8].forEach((br, k) => {
    const bx = x + br;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, y, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = UI.cardEdge || UI.line;
    ctx.stroke();
    ctx.restore();
    drawPiece(bx, y, 0, br * 0.72, state.queue[k + 1].id, 1 - k * 0.12);
    // シャボン玉のつや
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(bx, y, br - 2.5, Math.PI * 1.1, Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
    x = bx + br + 4;
  });

  // ---- 右：おじゃまの予告 ----
  if (!state.gameOver) {
    const left = Math.max(0, state.nextCandyAt - now);
    const span = candyInterval(state.wave);
    const n = candyCount(state.wave);
    const imminent = left < 3000;
    const col = imminent ? HUD_PURPLE : HUD_PINK;

    // 仕切り
    ctx.save();
    ctx.strokeStyle = UI.cardEdge || UI.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 3, y - 10);
    ctx.lineTo(x + 3, y + 10);
    ctx.stroke();
    ctx.restore();

    const wob = imminent ? Math.sin(now / 45) * 0.35 : Math.sin(now / 400) * 0.1;
    drawCandy(x + 18, y, wob, 8, 1);
    hudSticker('×' + n, x + 28, y + 1, 14, imminent ? '#8a6fd6' : '#7f7a96', 'left');

    // 残り時間の輪。一周したら落ちてくる
    const cx = HUD_RX + HUD_W - 18, cr = 10;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = UI.track;
    ctx.beginPath();
    ctx.arc(cx, y, cr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, y, cr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(1 - left / span, 0, 1));
    ctx.stroke();
    ctx.fillStyle = imminent ? '#8a6fd6' : UI.ink;
    ctx.font = '800 10px ' + FONT_FAMILY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.ceil(left / 1000)), cx, y + 1);
    ctx.restore();
  }
}

function drawHud() {
  ctx.globalAlpha = 1;
  drawHudCute();

  // 案内はゲームオーバーラインより上に出す。
  // ここが埋まったらゲームオーバーなので、定義上フルーツと重なることがない。
  // 画面下に置くと積み上がった山に文字が被って読めなくなる
  if (!state.gameOver) {
    ctx.textAlign = 'center';
    ctx.fillStyle = UI.dim;

    if (!state.dropped) {
      ctx.font = '13px ' + FONT_FAMILY;
      ctx.fillText('うごかす: マウス / ゆび　　おとす: おしっぱなし', W / 2, 132);
    }

    // ポインタが固定されていないと、カーソルがブラウザの枠外へ出てしまい、
    // そこでのクリックが他のウィンドウに入って集中が切れる。
    // ただし出しっぱなしは説明書きが居座って邪魔なので、序盤だけにする
    if (!state.locked && state.frame < 600) {
      ctx.globalAlpha = clamp((600 - state.frame) / 90, 0, 1);
      ctx.font = '12px ' + FONT_FAMILY;
      ctx.fillText('Esc で マウスが そとに だせる', W / 2, 172);
      ctx.globalAlpha = 1;
    }
  }

  drawChainCute();
  drawStageBanner();
  if (state.clearT > 0) drawGradeClearCute();

  if (state.gameOver) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = UI.overlay;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    // ゲームオーバーも他の文字と同じ描き方。色は少し落ち着かせる
    const age = performance.now() - state.overAt;
    cuteText('ゲームオーバー', W / 2, H / 2 - 30, 38,
      { colors: ['#a787fa', '#ff6fa5'], age, stagger: 50, tilt: true, stripes: true });
    cuteText('スコア ' + state.score, W / 2, H / 2 + 18, 22,
      { colors: ['#43c4f0'], age: age - 400, stagger: 30, weight: 700, stripes: true });
    ctx.fillStyle = UI.sub;
    ctx.font = '700 14px ' + FONT_FAMILY;
    ctx.fillText('おして はなすと もどる', W / 2, H / 2 + 64);
  }
}

// ---- ループ --------------------------------------------------------------

// 1/60 秒ぶん進める（描かない）
function step() {
  updateTrail();
  if (!state.started) {
    // タイトル中は物理を止める。ここで進めるとキャンディーのタイマーも走ってしまう
    state.titleT++;
    if (state.lockFlash > 0) state.lockFlash--;
    updateLeave();
    return;
  }

  if (!state.gameOver) {
    Engine.update(engine, 1000 / 60);
    state.frame++;

    // クリア演出中は入力もお邪魔も止める
    if (state.clearT > 0) {
      if (--state.clearT === 0) finishGradeClear();
      for (let i = state.effects.length - 1; i >= 0; i--) {
        if (++state.effects[i].t > EFFECT_LIFE) state.effects.splice(i, 1);
      }
      return;
    }

    updateAutoFire();
    updatePendingDrop();
    updateCandy();

    if (state.frame % SCAN_INTERVAL === 0) {
      scan();
      checkGameOver();
      updatePinch();
    }
  }

  for (let i = state.effects.length - 1; i >= 0; i--) {
    if (++state.effects[i].t > EFFECT_LIFE) state.effects.splice(i, 1);
  }
  if (state.stageBanner > 0) state.stageBanner--;
}

// 画面の書き換えごとに呼ばれる。ゲームは 1 秒 60 回で進め、進んだときだけ描く。
// 以前は書き換え 1 回につき 1 歩進めていたので、1 秒 120 回書き換えるスマホでは
// ゲームが倍の速さで進み、計算も倍になっていた
const STEP_MS = 1000 / 60;
const MAX_STEPS = 4;           // 裏から戻ったときなどに、たまった分を一気に進めすぎない
let lastFrameAt = null, stepAcc = 0;
function tick(now = performance.now()) {
  if (lastFrameAt === null) lastFrameAt = now - STEP_MS;
  stepAcc = Math.min(stepAcc + (now - lastFrameAt), STEP_MS * MAX_STEPS);
  lastFrameAt = now;
  let stepped = false;
  // 60Hz の画面では間隔が 16.6〜16.8ms とぶれるので、少しだけ手前で 1 歩と数える
  while (stepAcc >= STEP_MS - 1) {
    step();
    stepAcc -= STEP_MS;
    stepped = true;
  }
  if (stepped) draw();
  requestAnimationFrame(tick);
}

// ---- 入力 ----------------------------------------------------------------

// 盤面座標へ変換したうえで、ドロップ可能な範囲にクランプする。
// canvas は縦画面比を保つため左右に余白（レターボックス）ができる。そこを死に領域に
// すると、端に置きたいときほどクリックが効かなくなって操作感が最悪になる。
// 入力はページ全体で受け、はみ出した分は端に丸める。
const OVERRUN = 40;   // 端を越えて動かせる余地。押し当てている感触のために少しだけ残す

// 盤面外へどれだけはみ出しているかを保持し、描画側で端を光らせる（カーソルは非表示のため）
function applyRawX(raw) {
  const lo = dropLo(), hi = dropHi();
  state.rawX = clamp(raw, lo - OVERRUN, hi + OVERRUN);
  state.pushEdge = state.rawX < lo ? -1 : state.rawX > hi ? 1 : 0;
  state.pointerX = clamp(state.rawX, lo, hi);
}

// 絶対座標（ポインタロックしていない時 / タッチ）
function toBoardX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return (clientX - rect.left) / rect.width * W;
}

function toBoardY(clientY) {
  const rect = canvas.getBoundingClientRect();
  return (clientY - rect.top) / rect.height * H;
}

// ---- ポインタロック ------------------------------------------------------
//
// マウスがブラウザの枠から出てしまうと、そこでのクリックは他のウィンドウに入る。
// 誤クリックでフォーカスを失い、ゲームが止まる。端に置きたいときほど枠外へ出るので、
// 一番集中している場面で操作が破綻する。
//
// ポインタロックでカーソルを画面内に固定し、絶対座標ではなく移動量で動かす。
// カーソルは物理的に外へ出られなくなる。

function wantLock() {
  if (state.locked) return;
  if (!canvas.requestPointerLock) return;
  const p = canvas.requestPointerLock();
  if (p && p.catch) p.catch(() => {});   // 拒否されても従来通り動く
}

function releaseLock() {
  if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
}

document.addEventListener('pointerlockchange', () => {
  state.locked = document.pointerLockElement === canvas;
});
document.addEventListener('pointerlockerror', () => {
  state.locked = false;
});

window.addEventListener('pointermove', e => {
  state.mouse = e.pointerType === 'mouse';
  if (state.locked) {
    // 移動量を盤面スケールに変換して積む
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width ? W / rect.width : 1;
    applyRawX(state.rawX + e.movementX * scale);
    state.pointerY = clamp(state.pointerY + e.movementY * scale, 0, H);
    state.cursorX = clamp(state.cursorX + e.movementX * scale, 0, W);
  } else {
    applyRawX(toBoardX(e.clientX));
    state.pointerY = toBoardY(e.clientY);
    state.cursorX = toBoardX(e.clientX);
  }
  titleHover();
});

// タイトルで、指している器を選ぶ（未解放の器は選ばない）
function titleHover() {
  if (state.started || state.splash || state.leaving) return;
  const r = titleRowAt(state.pointerY);
  if (r >= 0 && r <= state.unlocked && r !== state.titleSel) { state.titleSel = r; Sound.hover(); }
}

window.addEventListener('pointerdown', e => {
  state.mouse = e.pointerType === 'mouse';
  Sound.unlock();          // ブラウザは操作の中でしか音を出させない
  if (!state.locked) {
    applyRawX(toBoardX(e.clientX));
    state.pointerY = toBoardY(e.clientY);
  }
  // タイトルとゲームオーバーでは「押して離す」で進む。遊んでいる間は押した瞬間から連射
  if (!state.started || state.gameOver) state.pressArmed = true;
  else beginHold();
  e.preventDefault();
});

window.addEventListener('pointerup', e => {
  if (!state.locked) {
    applyRawX(toBoardX(e.clientX));
    state.pointerY = toBoardY(e.clientY);
  }
  // 押しっぱなしのままゲームオーバーになった場合、その指を離しただけでタイトルへ
  // 飛ばないよう、ゲームオーバー後に改めて押したときだけ進める
  if (!state.started || state.gameOver) {
    if (state.pressArmed) requestDrop();
  } else {
    endHold();
  }
  // マウスのときだけ固定する（タッチには不要で、むしろ邪魔になる）。
  // 遊んでいる間だけ。タイトルとゲームオーバーではカーソルを返して、音量のパネルを触れるようにする
  if (e.pointerType === 'mouse' && state.started && !state.gameOver) wantLock();
  state.pressArmed = false;
  e.preventDefault();
});

// 指が画面外へ出た、別アプリに切り替わった、などで離したことが届かない場合も止める
window.addEventListener('pointercancel', endHold);
window.addEventListener('blur', endHold);

window.addEventListener('keydown', e => {
  Sound.unlock();
  if (e.code === 'KeyM') { Sound.toggleMute(); return; }
  // タイトルでは上下キーで器を選び、スペース / Enter で始める
  if (!state.started && state.leaving) { e.preventDefault(); return; }
  if (!state.started && state.splash) {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); leaveSplash(); }
    return;
  }
  if (!state.started) {
    const before = state.titleSel;
    if (e.code === 'ArrowUp') state.titleSel = Math.max(0, state.titleSel - 1);
    if (e.code === 'ArrowDown') state.titleSel = Math.min(state.unlocked, state.titleSel + 1);
    if (state.titleSel !== before) Sound.hover();
    Sound.titleMusic();     // キーを押した＝音を出してよい操作。タイトルの曲を鳴らし始める
    if (e.code === 'Space' || e.code === 'Enter') beginLeave('start');
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return;              // キーの押しっぱなしで来る繰り返しは無視する
    if (!state.started || state.gameOver) requestDrop();
    else beginHold();
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') endHold();
});

// ---- キャンバス解像度 ----------------------------------------------------

let dpr = 1;
// 描く細かさの上限。スマホは画面の 2〜3 倍の細かさがあるが、2 倍で描くと点の数が多く重い。
// 1.5 倍にすると描く点は 2 倍のときの 56%。見た目はほんの少し柔らかくなる程度
const MAX_DPR = 1.5;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.aspectRatio = W + ' / ' + H;
  Sound.placePanel();      // 音量パネルの位置を、決まったゲーム画面の大きさで置き直す
}
window.addEventListener('resize', resize);

resize();
reset();
// タイトルの曲。ブラウザは操作があるまで音を出させないので、実際に鳴るのは
// 音量パネルやキーを触ったとき（またはゲームからタイトルに戻ったとき）
Sound.titleMusic();
tick();
