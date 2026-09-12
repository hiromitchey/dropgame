// drop delta - Phase 1 + 5
// 落下・堆積・同種3体消去・連鎖・キャンディー（お邪魔）まで。
// 設計書 doc/bp.md 参照。複合ボディ・キャラ画像・ポーズ切り替えは Phase 2〜4。

'use strict';

const { Engine, Composite, Bodies, Body, Events, Query } = Matter;

// ---- 盤面 ----------------------------------------------------------------

const W = 480;              // 論理解像度。実解像度は DPR で拡大
const H = 760;
const WALL = 60;            // 壁の厚み（画面外に置く）
const LINE_Y = 150;         // ゲームオーバーライン
const SPAWN_Y = 70;         // 待機キャラの出現高さ

// ---- キャラ --------------------------------------------------------------

// 切り出し座標は設計書 8 の通り。body/hair は画像が読めるまでの代替色。
//
// 素材は SD 体型（頭が大きく体が小さい）に差し替え済み。
// 等身が高いと 60px 程度では顔が潰れて種類を見分けられなかった。
// 縦横比も改善し（棒立ち 1:2.9 → 1:1.3〜2.2）、円の当たり判定に載せても
// 極端にはみ出さなくなったため、棒立ちも使えるようになった。
const TYPES = [
  { id: 'a', body: '#7ecb8f', hair: '#4da362', line: 'ですわ～',
    stand: [163, 23, 221, 494], x: [75, 531, 398, 456] },
  { id: 'b', body: '#7fd6d0', hair: '#4aa8b8', line: '任せてくれ',
    stand: [599, 27, 324, 492], x: [577, 542, 367, 446] },
  { id: 'c', body: '#f492b8', hair: '#e05c92', line: 'デス！',
    stand: [1051, 36, 363, 484], x: [1042, 546, 402, 443] },
];

// ---- ドロップ（シンプル版）------------------------------------------------
//
// 色ごとに形が違う。**形は見た目だけでなく当たり判定でもある。**
// 頂点リストを1つ作り、それを物理ボディと描画の両方に使うことでズレを防いでいる。
//
// 設計書 4.1 は fromVertices を「凸分解の精度・速度」を理由に不採用としているが、
// それはキャラのシルエットのような凹形状の話。ここで使うのは全て凸多角形で、
// 分解が発生しないため該当しない。
//
// なお、形が当たり判定と一致する以上、描画の回転は実角度でなければならない。
// キャラ版の「回転を 0.3 倍に抑えて顔の向きを保つ」処理はここでは使えない。
const DROPS = [
  { id: 'd1', color: '#a3d13f', shine: '#dcf08a', shape: 'circle'  },  // メロン
  { id: 'd2', color: '#f0ece0', shine: '#ffffff', shape: 'drop'    },  // ハッカ（乳白）
  { id: 'd3', color: '#ef5b7d', shine: '#ffb3c4', shape: 'square'  },  // いちご
  { id: 'd4', color: '#4fbce8', shine: '#b3e6fa', shape: 'hexagon' },  // ソーダ
  { id: 'd5', color: '#9d6fd8', shine: '#d8bdf7', shape: 'ellipse' },  // ぶどう
  { id: 'd6', color: '#f7d13f', shine: '#fff2a8', shape: 'pentagon'},  // レモン
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
    case 'hexagon':  return poly(6, Math.PI / 6);
    case 'pentagon': return poly(5, -Math.PI / 2);
    case 'ellipse':  return poly(14, 0, 1.0, 0.84);
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

// セリフのぽわぽわ
const BUBBLE_LIFE = 70;         // セリフの表示フレーム数
const BUBBLE_ON_CLEAR = 0.5;    // 消えた1体がセリフを出す確率
const BUBBLE_IDLE = 0.0009;     // 静止中の1体が1フレームに喋る確率
const BUBBLE_MAX = 14;          // 同時表示の上限。出しすぎると盤面が読めない

const SPRITE_FIT = 1.12;        // 直径に対する描画高さの倍率

// 開いたり閉じたり。
//
// 両ポーズを同じ高さで描くと、大の字は横に広く、棒立ちは細くなる。
// 高さが変わらないまま幅だけが変わるので、そのまま「腕を開く / 閉じる」に見える。
// 高さ基準にしているのは、円の当たり判定から縦にはみ出させないためでもある。
//
// 当たり判定はまだ変えていない（円のまま）。形も一緒に変えて周囲を押しのけるのは
// 設計書 6 の内容で、Phase 2 で当たり判定を複合ボディにしてからでないと成立しない。
const POSE_MORPH_FRAMES = 11;   // 切り替えにかけるフレーム数
const POSE_CHANCE = 0.006;      // 静止中の1体が1回の走査で切り替わる確率
const POSE_COOLDOWN = 1400;     // 同じ子が連続で動かないための間隔 (ms)
const POSE_FLAP_FRAMES = 60;    // 落下中の開閉間隔。60フレーム = 約1秒ごとに切り替わる

// 見た目のモード。plain.html が window.DROP_DELTA_PLAIN を立ててから読み込むと、
// スプライトを使わず色の丸で描く。物理・判定・難易度は完全に同一。
const USE_SPRITES = !window.DROP_DELTA_PLAIN;
const MODE_KEY = USE_SPRITES ? 'girls' : 'plain';

// タイトル画面は両方に出す。名前が付いた以上、名乗る場所が要る
const TITLE = USE_SPRITES ? 'ドロップデルタもん' : 'ドロップス';

// ---- グレード（シンプル版）------------------------------------------------
//
// 目標点に達するとクリア。盤面を一掃して次のグレードへ進む。
// グレードが上がると目標点が伸び、キャンディーが速くなり、途中から色の種類が増える。
const GRADE_MODE = !USE_SPRITES;
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

// グレードが上がるほどキャンディーが早く来る
const gradeCandyScale = g => Math.max(0.72, 1 - (g - 1) * 0.05);

// 色が増えたグレードだけ、お邪魔を緩める。
//
// 色が1つ増えると揃う確率が一段下がり、そこへ目標点の上昇と投入ペースの加速が
// 重なると、そのグレードだけ急にきつくなる。新しい色に慣れる時間を渡す
// 緩和は一段で戻さず、次のグレードにかけて徐々に戻す。
// 一気に戻すと、緩和した次のグレードで圧力が跳ね上がり、そこが新しい難所になる
const COLOR_RELIEF = [1.35, 1.18, 1.07];   // 色が増えたグレードから順に掛ける倍率
const COLOR_RELIEF_WAVES = 3;              // 波をいくつ巻き戻すか

const colorAdded = g => g > 1 && gradeKinds(g) > gradeKinds(g - 1);

function gradeRelief(g) {
  for (let i = 0; i < COLOR_RELIEF.length; i++) {
    if (colorAdded(g - i)) return COLOR_RELIEF[i];
  }
  return 1;
}

const sheet = new Image();
let sheetReady = false;
if (USE_SPRITES) {
  sheet.onload = () => { sheetReady = true; };
  sheet.src = './img/girls.png';
}

// Phase 1 の円は仮。当たり判定を絵の形（縦長／横広）に合わせるのは Phase 2。
// Phase 2 で複合ボディに差し替える際、この R は「キャラの幅」の基準として引き継ぐ。
const R = 31;               // 半径
const REACH = 33;           // つながり判定の到達距離（重心間）
const MATCH = 3;            // 消去に必要な数
const NEXT_SHOWN = 3;       // NEXT で見せる手数
const MAX_BODIES = 200;     // 盤面上限。負荷の安全弁であり難易度装置ではない。
                            // ゲームオーバーラインより先に効くと負けなくなる

// ---- 物理パラメータ（設計書 4.2）----------------------------------------

// ふわっと落とす。重力を弱め、空気抵抗を上げて終端速度を下げている。
// 落下が速いと「物を投げ落としている」感触になり、キャラが物として扱われて見える
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
  return GRADE_MODE ? base * gradeCandyScale(state.grade) * gradeRelief(state.grade) : base;
};
// 1回の投入数には上限を置く。目標点が上がるほど1グレードが長くなり、
// 波が進んで投入数だけが際限なく増える。終盤だけ理不尽に重くなるのを防ぐ
const CANDY_COUNT_MAX = 2;
const candyCount = wave =>
  Math.min(CANDY_COUNT_MAX, 1 + Math.floor(wave / CANDY_COUNT_EVERY));

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

const engine = Engine.create();
engine.gravity.y = GRAVITY;
const world = engine.world;

const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');

const state = {
  queue: [],          // NEXT。先頭が今持っているキャラ
  pointerX: W / 2,
  lastDrop: 0,
  frame: 0,
  recheckAt: 0,
  lastClear: -Infinity,
  chain: 0,
  score: 0,
  best: Number(localStorage.getItem('dropdelta.best.' + MODE_KEY) || 0),   // 自己ベストはモード別
  overSince: 0,
  gameOver: false,
  dropped: false,
  effects: [],
  wave: 0,            // キャンディーを何回投入したか
  nextCandyAt: 0,     // 次の投入時刻
  wantDropAt: 0,      // 保留中のクリック（0 なら無し）
  wantDropX: 0,
  bubbles: [],        // 飛び散るセリフ
  pushEdge: 0,        // 盤面外へはみ出している向き（-1 左 / 0 内側 / 1 右）
  rawX: W / 2,        // クランプ前のポインタ位置
  locked: false,      // ポインタロック中か
  grade: 1,           // シンプル版のグレード
  gradeScore: 0,      // 今のグレードで稼いだ点
  clearT: 0,          // クリア演出の残りフレーム
  started: false,     // タイトル画面を抜けたか
  titleT: 0,          // タイトルの経過フレーム
};

const removeQueue = [];

// ---- 初期化 --------------------------------------------------------------

function buildWalls() {
  const opts = { isStatic: true, friction: 0.6, restitution: 0 };
  Composite.add(world, [
    Bodies.rectangle(W / 2, H + WALL / 2, W + WALL * 2, WALL, opts),   // 床
    Bodies.rectangle(-WALL / 2, H / 2, WALL, H * 3, opts),             // 左壁
    Bodies.rectangle(W + WALL / 2, H / 2, WALL, H * 3, opts),          // 右壁
  ]);
}

// 今そのモード・グレードで使う色の一覧
function palette() {
  if (!GRADE_MODE) return TYPES;
  return DROPS.slice(0, gradeKinds(state.grade));
}

function randomType() {
  const p = palette();
  return p[(Math.random() * p.length) | 0];
}

// ボディを作る。シンプル版は形が当たり判定そのもの
function makePieceBody(type, x, y) {
  const opts = Object.assign({}, PHYS, {
    label: 'girl',
    plugin: {
      type: type.id, reach: REACH,
      pose: 'x', from: 'x', morph: 1, poseAt: 0, flap: 0,
    },
  });

  if (!GRADE_MODE) return Bodies.circle(x, y, R, opts);

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
  // 先頭が今持っているキャラ。残りが NEXT として見える分
  while (state.queue.length < 1 + NEXT_SHOWN) state.queue.push(randomType());
}

function reset() {
  Composite.clear(world, false);
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
  state.gameOver = false;
  state.effects.length = 0;
  state.bubbles.length = 0;
  state.wave = 0;
  state.wantDropAt = 0;
  state.nextCandyAt = performance.now() + CANDY_FIRST;
  removeQueue.length = 0;
}

// ---- ドロップ ------------------------------------------------------------

function girls() {
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
  // 出現位置に前のキャラがまだ居るなら撃たせない（重なりによる吹き飛び防止）
  const region = { min: { x: x - R, y: SPAWN_Y - R }, max: { x: x + R, y: SPAWN_Y + R } };
  return Query.region(pieces(), region).length > 0;
}

// クリックを受け付ける入口。撃てない瞬間でも取りこぼさず、少しの間だけ発射を保留する。
//
// 落下中のキャンディーが出現帯を通過している最中や、クールダウン中にクリックすると、
// 以前は何も起きずに入力が消えていた。プレイヤーからは「クリックが効かない」としか見えない。
function startGame() {
  reset();                 // ここで初めてキャンディーのタイマーが動き出す
  state.started = true;
  state.dropped = false;
}

function requestDrop() {
  if (!state.started) { startGame(); return; }
  if (state.gameOver) { reset(); return; }
  state.wantDropAt = performance.now();
  state.wantDropX = clamp(state.pointerX, R + 2, W - R - 2);
  drop();
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
  const x = state.wantDropAt ? state.wantDropX : clamp(state.pointerX, R + 2, W - R - 2);
  if (spawnBlocked(x)) return;
  if (pieces().length >= MAX_BODIES) return;

  const type = state.queue.shift();
  fillQueue();

  const b = makePieceBody(type, x, SPAWN_Y);
  Composite.add(world, b);
  state.lastDrop = now;
  state.wantDropAt = 0;
  state.dropped = true;
}

// ---- キャンディー投入（設計書 7）----------------------------------------

function spawnCandy() {
  const x = clamp(40 + Math.random() * (W - 80), CANDY_R + 2, W - CANDY_R - 2);
  // 画面外の上から入れる。キャラの出現帯（SPAWN_Y ± R）に居座ると、その真下の x で
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

// ---- セリフ --------------------------------------------------------------

function spawnBubble(x, y, id, big) {
  if (!USE_SPRITES) return;   // 丸だけ版では喋らない。誰が喋っているのか分からない
  if (state.bubbles.length >= BUBBLE_MAX) return;
  const c = colorOf(id);
  state.bubbles.push({
    x, y,
    text: c.line,
    color: c.hair,
    vx: (Math.random() - 0.5) * 0.9,
    vy: -1.5 - Math.random() * 0.7,
    rot: (Math.random() - 0.5) * 0.35,
    size: big ? 19 : 14,
    t: 0,
  });
}

function updateBubbles() {
  for (let i = state.bubbles.length - 1; i >= 0; i--) {
    const b = state.bubbles[i];
    b.x += b.vx;
    b.y += b.vy;
    b.vy *= 0.94;          // 浮き上がって減速する。ぽわぽわ
    b.vx *= 0.97;
    if (++b.t > BUBBLE_LIFE) state.bubbles.splice(i, 1);
  }
}

function drawBubbles() {
  for (const b of state.bubbles) {
    const t = b.t / BUBBLE_LIFE;
    // 出た瞬間だけ少し大きく、あとは徐々に消える
    const pop = b.t < 6 ? 0.7 + (b.t / 6) * 0.45 : 1.15 - (b.t - 6) / BUBBLE_LIFE * 0.15;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot * (0.4 + t));
    ctx.scale(pop, pop);
    ctx.globalAlpha = t < 0.65 ? 1 : (1 - t) / 0.35;
    ctx.font = 'bold ' + b.size + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(16,18,28,0.85)';
    ctx.strokeText(b.text, 0, 0);
    ctx.fillStyle = b.color;
    ctx.fillText(b.text, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// ---- ポーズ（開いたり閉じたり）------------------------------------------

function updatePoses() {
  const now = performance.now();
  for (const b of girls()) {
    const p = b.plugin;

    // 切り替え中なら進める
    if (p.morph < 1) {
      p.morph = Math.min(1, p.morph + 1 / POSE_MORPH_FRAMES);
      continue;
    }

    if (settled(b)) {
      // たまにひとりごとを言う
      if (Math.random() < BUBBLE_IDLE) {
        spawnBubble(b.position.x, b.position.y - R * 0.6, p.type, false);
      }
      // 積まれて落ち着いた子は、たまに気まぐれに動く
      if (now - p.poseAt < POSE_COOLDOWN) continue;
      if (Math.random() >= POSE_CHANCE) continue;
      togglePose(p, now);
    } else {
      // 落下中は等間隔でパタパタさせる。ランダムだと落ちている間に
      // 一度も動かない子が出て、動く子と動かない子がまだらになる
      if (++p.flap < POSE_FLAP_FRAMES) continue;
      togglePose(p, now);
    }
  }
}

function togglePose(p, now) {
  p.from = p.pose;
  p.pose = p.pose === 'x' ? 'stand' : 'x';
  p.morph = 0;
  p.poseAt = now;
  p.flap = 0;
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
  const all = girls();
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

// 消去確定したキャラ群を起点に、隣接するキャンディーを層状に辿る。
// 辿る対象はキャンディーのみ。間にキャラが挟まっていればそこで打ち切られる（設計書 3.2）
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

  const list = girls().filter(settled);
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
      if (Math.random() < BUBBLE_ON_CLEAR) {
        spawnBubble(b.position.x, b.position.y - R * 0.6, b.plugin.type, true);
      }
      cleared++;
    }
  }

  // 巻き込まれるキャンディー。連鎖数だけ層が広がる（設計書 3.2）
  const swept = collectCandy(clearedGirls, Math.min(state.chain, CANDY_LAYER_CAP));
  for (const c of swept) {
    removeQueue.push(c);
    state.effects.push({ x: c.position.x, y: c.position.y, candy: true, t: 0 });
  }

  const gained = cleared * BASE_SCORE * state.chain
               + swept.length * CANDY_SCORE * state.chain;
  state.score += gained;
  state.gradeScore += gained;
  state.recheckAt = now + RECHECK_DELAY;

  // 目標点に届いたらグレードクリア
  if (GRADE_MODE && !state.clearT && state.gradeScore >= gradeTarget(state.grade)) {
    beginGradeClear();
  }
}

// 消去は afterUpdate でまとめて実行（設計書 5.3）
Events.on(engine, 'afterUpdate', () => {
  if (!removeQueue.length) return;
  for (const b of removeQueue) Composite.remove(world, b);
  removeQueue.length = 0;
});

// ---- グレード進行（シンプル版）--------------------------------------------

function beginGradeClear() {
  state.clearT = GRADE_CLEAR_HOLD;
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

  // 次のグレードの色数で引き直す。前の色が残っていると新しい色が出てこない
  state.queue.length = 0;
  fillQueue();

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
}

// ---- ゲームオーバー（設計書 7）------------------------------------------

function checkGameOver() {
  const now = performance.now();
  // 判定対象は静止しているボディのみ。落下中を含めると自分の弾で誤爆する
  const over = pieces().some(b => settled(b) && b.position.y < LINE_Y);

  if (!over) { state.overSince = 0; return; }
  if (!state.overSince) { state.overSince = now; return; }
  if (now - state.overSince > OVER_HOLD) {
    state.gameOver = true;
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem('dropdelta.best.' + MODE_KEY, String(state.best));
    }
  }
}

// ---- 描画 ----------------------------------------------------------------

const ALL_TYPES = TYPES.concat(DROPS).concat([CANDY_TYPE]);
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

function drawDrop(x, y, angle, r, id, alpha, body) {
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

// 色を暗くする。#rrggbb 前提
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// 1枚分の描画。高さ基準で合わせる。
// 幅基準にすると縦にはみ出して隣とめり込んで見える
function blitPose(c, pose, r, alpha) {
  if (alpha <= 0.01) return;
  const [sx, sy, sw, sh] = c[pose];
  const dh = r * 2 * SPRITE_FIT;
  const dw = dh * (sw / sh);
  ctx.globalAlpha = alpha;
  ctx.drawImage(sheet, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
}

// morph: { from, pose, morph } を渡すと開閉の途中を描く。省略時は大の字
// キャラ版とシンプル版の入口を1本にする。呼び出し側はどちらか意識しない
function drawPiece(x, y, angle, r, id, alpha, p, body) {
  if (GRADE_MODE) drawDrop(x, y, angle, r, id, alpha, body);
  else drawGirl(x, y, angle, r, id, alpha, p);
}

function drawGirl(x, y, angle, r, id, alpha, p) {
  const c = colorOf(id);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle * 0.3);   // 実角度の 0.3 倍に抑制（設計書 4.2）
  ctx.globalAlpha = alpha;

  if (sheetReady) {
    const pose = p ? p.pose : 'x';
    const t = p ? p.morph : 1;
    if (t >= 1) {
      blitPose(c, pose, r, alpha);
    } else {
      // 切り替え中はクロスフェード。絵が別物なので幅の補間ではつながらない
      blitPose(c, p.from, r, alpha * (1 - t));
      blitPose(c, pose, r, alpha * t);
    }
    ctx.restore();
    return;
  }

  // 画像が読めるまでの代替表示
  ctx.fillStyle = c.body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // 髪
  ctx.fillStyle = c.hair;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI * 1.08, Math.PI * 1.92);
  ctx.fill();

  // 目
  ctx.fillStyle = '#2b2f3c';
  ctx.beginPath();
  ctx.arc(-r * 0.3, r * 0.05, r * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r * 0.3, r * 0.05, r * 0.11, 0, Math.PI * 2);
  ctx.fill();

  // 口
  ctx.strokeStyle = '#2b2f3c';
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, r * 0.18, r * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  ctx.restore();
}

// お邪魔は飴ではなく「包み紙」。**つやを飴と揃えない。**
// 紙はマットなので、鋭いハイライトを入れると中身の見えるキャンディに見えてしまい、
// 美味しそうな飴と区別がつかなくなる
function drawCandy(x, y, angle, r, alpha, body) {
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

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1b1f2e');
  g.addColorStop(1, '#101320');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  if (!state.started) { drawTitle(); return; }

  // ゲームオーバーライン
  ctx.strokeStyle = state.overSince ? '#e05c92' : '#2e3448';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(0, LINE_Y);
  ctx.lineTo(W, LINE_Y);
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

  // 落下ガイド + 待機キャラ
  if (!state.gameOver) {
    const x = clamp(state.pointerX, R + 2, W - R - 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
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

  for (const b of girls()) {
    drawPiece(b.position.x, b.position.y, b.angle, R, b.plugin.type, 1, b.plugin, b);
  }

  // 消滅エフェクト。キャラは大の字（drawGirl の既定ポーズ）で消える。
  // 線形に薄くすると出た瞬間から半透明に見えるため、前半は濃いまま保って
  // 後半で一気に抜く
  for (const e of state.effects) {
    const t = e.t / EFFECT_LIFE;
    const a = t < EFFECT_HOLD ? 1 : 1 - (t - EFFECT_HOLD) / (1 - EFFECT_HOLD);
    if (e.candy) drawCandy(e.x, e.y, 0, CANDY_R * (1 + t * 0.9), a);
    else drawPiece(e.x, e.y, e.angle || 0, R * (1 + t * 0.9), e.type, a);
  }

  drawBubbles();

  drawHud();
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

function drawChain() {
  if (state.chain < 2) return;
  const age = performance.now() - state.lastClear;
  if (age > CHAIN_WINDOW) return;

  const n = state.chain;
  const tier = chainTier(n);
  const t = age / CHAIN_WINDOW;

  // 出た瞬間に弾んで、最後に消える
  const pop = age < 130 ? 0.55 + (age / 130) * 0.55 : 1.1 - (age - 130) / CHAIN_WINDOW * 0.1;
  const alpha = t < 0.7 ? 1 : (1 - t) / 0.3;

  // 高連鎖ほど揺れる
  const shake = n >= 6 ? (Math.random() - 0.5) * (n - 5) * 1.6 : 0;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(W / 2 + shake, H / 2 - 40 + shake * 0.5);
  ctx.scale(pop, pop);
  ctx.textAlign = 'center';
  ctx.font = 'bold ' + tier.size + 'px system-ui, sans-serif';

  const text = n + ' CHAIN' + tier.suffix;

  // 5連鎖以上は発光
  if (n >= 5) {
    ctx.shadowColor = tier.fill;
    ctx.shadowBlur = 18 + (n - 4) * 6;
  }
  // 4連鎖以上は縁取りを厚くして重量感を出す
  ctx.lineWidth = n >= 4 ? 7 : 4;
  ctx.strokeStyle = 'rgba(14,16,26,0.9)';
  ctx.strokeText(text, 0, 0);

  ctx.shadowBlur = 0;
  ctx.fillStyle = tier.fill;
  ctx.fillText(text, 0, 0);

  // 7連鎖以上はきらめきを散らす
  if (n >= 7) {
    ctx.fillStyle = '#fff6c2';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + age / 200;
      const rr = tier.size * (1.1 + 0.25 * Math.sin(age / 90 + i));
      const s = 2.2 + Math.sin(age / 60 + i) * 1.2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr * 1.7, Math.sin(a) * rr * 0.55, Math.max(0.5, s), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// タイトル画面。3人が並んで開閉し続ける
function drawTitle() {
  const t = state.titleT;

  ctx.save();
  ctx.textAlign = 'center';

  // タイトル。ゆっくり上下に揺れる
  const bob = Math.sin(t / 34) * 4;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(14,16,26,0.9)';
  ctx.strokeText(TITLE, W / 2, 210 + bob);
  const g = ctx.createLinearGradient(0, 180, 0, 225);
  g.addColorStop(0, '#ffe6a3');
  g.addColorStop(1, '#f492b8');
  ctx.fillStyle = g;
  ctx.fillText(TITLE, W / 2, 210 + bob);

  if (GRADE_MODE) {
    // 飴を2段に並べてゆっくり回す。形の違いがひと目で分かるように全色出す
    DROPS.forEach((ty, i) => {
      const col = i % 3, row = (i / 3) | 0;
      const x = W / 2 + (col - 1) * 104;
      const y = 330 + row * 96 + Math.sin(t / 28 + i * 0.9) * 6;
      drawDrop(x, y, t / 120 + i, 34, ty.id, 1);
    });
  } else {
    // 3人を並べる。落下中と同じ間隔で開閉させる
    const pose = Math.floor(t / POSE_FLAP_FRAMES) % 2 ? 'stand' : 'x';
    const prev = pose === 'x' ? 'stand' : 'x';
    const m = clamp((t % POSE_FLAP_FRAMES) / POSE_MORPH_FRAMES, 0, 1);
    TYPES.forEach((ty, i) => {
      const x = W / 2 + (i - 1) * 116;
      const y = 380 + Math.sin(t / 30 + i * 1.1) * 7;
      drawGirl(x, y, 0, 44, ty.id, 1, { pose, from: prev, morph: m });
    });

    // セリフを順番に見せる
    TYPES.forEach((ty, i) => {
      const phase = (t / 90) % 3;
      if (Math.floor(phase) !== i) return;
      ctx.globalAlpha = 0.9;
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(16,18,28,0.85)';
      ctx.strokeText(ty.line, W / 2 + (i - 1) * 116, 316);
      ctx.fillStyle = ty.hair;
      ctx.fillText(ty.line, W / 2 + (i - 1) * 116, 316);
      ctx.globalAlpha = 1;
    });
  }

  // 点滅する案内
  ctx.globalAlpha = 0.55 + Math.sin(t / 16) * 0.45;
  ctx.fillStyle = '#e8ecf8';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText('クリックでスタート', W / 2, GRADE_MODE ? 560 : 530);
  ctx.globalAlpha = 1;

  // 操作を最初に言う。ルールや進行はゲーム中に画面へ出るが、
  // 「どう遊ぶか」は最初に伝えないと何も始まらない
  const base = GRADE_MODE ? 598 : 572;
  ctx.fillStyle = '#8a93b0';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.fillText(GRADE_MODE ? 'クリックすると飴が落ちてくる'
                          : 'クリックすると女の子が落ちてくる', W / 2, base);

  ctx.fillStyle = '#5a6280';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(GRADE_MODE ? '同じ飴が3つつながると消える'
                          : '同じ子が3人つながると消える', W / 2, base + 22);

  if (state.best > 0) {
    ctx.fillText('BEST ' + state.best, W / 2, base + 46);
  }

  ctx.restore();
}

// グレードと目標点の進捗。今どこまで来ているかが常に見えていないと、
// 目標点があること自体に気づかれない
function drawGradeMeter() {
  const target = gradeTarget(state.grade);
  const p = clamp(state.gradeScore / target, 0, 1);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8ecf8';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.fillText('GRADE ' + state.grade, 16, 84);

  ctx.fillStyle = '#5a6280';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(state.gradeScore + ' / ' + target, 16, 116);

  const bw = 150, bh = 7;
  ctx.fillStyle = '#252a3c';
  ctx.fillRect(16, 94, bw, bh);
  const g = ctx.createLinearGradient(16, 0, 16 + bw, 0);
  g.addColorStop(0, '#5ec46b');
  g.addColorStop(1, '#f0e05a');
  ctx.fillStyle = g;
  ctx.fillRect(16, 94, bw * p, bh);

  // 使っている色数も出す。増えたことが分かるように
  ctx.fillStyle = '#5a6280';
  ctx.textAlign = 'right';
  ctx.fillText(gradeKinds(state.grade) + ' COLORS', 16 + bw, 116);
}

// グレードクリアの表示
function drawGradeClear() {
  const t = 1 - state.clearT / GRADE_CLEAR_HOLD;
  const pop = t < 0.18 ? t / 0.18 : 1;

  ctx.save();
  ctx.globalAlpha = state.clearT < 24 ? state.clearT / 24 : 1;
  ctx.translate(W / 2, H / 2 - 30);
  ctx.scale(0.6 + pop * 0.4, 0.6 + pop * 0.4);
  ctx.textAlign = 'center';

  ctx.font = 'bold 46px system-ui, sans-serif';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(14,16,26,0.9)';
  ctx.strokeText('GRADE ' + state.grade, 0, 0);
  ctx.fillStyle = '#ffe6a3';
  ctx.fillText('GRADE ' + state.grade, 0, 0);

  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.strokeText('CLEAR!', 0, 44);
  ctx.fillStyle = '#5ec46b';
  ctx.fillText('CLEAR!', 0, 44);

  // 伝えるのは次のグレードで変わることだけ。仕様の説明は出さない
  const nextKinds = gradeKinds(state.grade + 1);
  if (nextKinds > gradeKinds(state.grade)) {
    const line = 'あたらしい あめ が でてくる';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillStyle = '#e8ecf8';
    ctx.strokeText(line, 0, 88);
    ctx.fillText(line, 0, 88);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawHud() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8ecf8';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(String(state.score), 16, 38);

  ctx.fillStyle = '#5a6280';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('BEST ' + state.best, 16, 56);

  if (GRADE_MODE) drawGradeMeter();

  // NEXT。近い手ほど大きく・濃く描き、順番が一目で分かるようにする。
  // 待機キャラの帯（SPAWN_Y ± R = 39〜101）より上に置く。重なると手前のキャラが読めない
  // 直近の手をラベル寄り（左）に置く。左から右へ読む順序と手番の順序を一致させる
  for (let i = 1; i <= NEXT_SHOWN; i++) {
    const k = i - 1;
    const x = W - 28 - (NEXT_SHOWN - 1 - k) * 36;
    drawPiece(x, 22, 0, 14 - k * 2.2, state.queue[i].id, 0.95 - k * 0.22);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#5a6280';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('NEXT', W - 28 - NEXT_SHOWN * 36 + 4, 26);

  // キャンディー予告。残り時間と来る数（設計書 7「予告なしは理不尽」）
  if (!state.gameOver) {
    const left = Math.max(0, state.nextCandyAt - performance.now());
    const span = candyInterval(state.wave);
    const n = candyCount(state.wave);
    const imminent = left < 3000;

    // グレード版は左にグレードメーターが入るので、キャンディー予告は右へ逃がす
    const bw = 96, bh = 4;
    const bx = GRADE_MODE ? W - 16 - bw : 16;

    ctx.textAlign = GRADE_MODE ? 'right' : 'left';
    ctx.fillStyle = imminent ? '#c9a3f0' : '#5a6280';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('CANDY x' + n + '  ' + (left / 1000).toFixed(1) + 's',
                 GRADE_MODE ? W - 16 : 16, 82);

    // 残り時間バー
    ctx.fillStyle = '#252a3c';
    ctx.fillRect(bx, 90, bw, bh);
    ctx.fillStyle = imminent ? '#b6a7e0' : '#454d6b';
    ctx.fillRect(bx, 90, bw * clamp(1 - left / span, 0, 1), bh);
  }

  // 案内はゲームオーバーラインより上に出す。
  // ここが埋まったらゲームオーバーなので、定義上キャラと重なることがない。
  // 画面下に置くと積み上がった山に文字が被って読めなくなる
  if (!state.gameOver) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#4a5068';

    if (!state.dropped) {
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('動かす: マウス / 指　　落とす: クリック / タップ', W / 2, LINE_Y - 34);
    }

    // ポインタが固定されていないと、カーソルがブラウザの枠外へ出てしまい、
    // そこでのクリックが他のウィンドウに入って集中が切れる。
    // ただし出しっぱなしは説明書きが居座って邪魔なので、序盤だけにする
    if (!state.locked && state.frame < 600) {
      ctx.globalAlpha = clamp((600 - state.frame) / 90, 0, 1);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Esc でマウスが外に出せる', W / 2, LINE_Y - 14);
      ctx.globalAlpha = 1;
    }
  }

  drawChain();
  if (GRADE_MODE && state.clearT > 0) drawGradeClear();

  if (state.gameOver) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(10,12,20,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8ecf8';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillText('GAME OVER', W / 2, H / 2 - 20);
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText('SCORE ' + state.score, W / 2, H / 2 + 20);
    ctx.fillStyle = '#5a6280';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('クリック / タップでもう一度', W / 2, H / 2 + 60);
  }
}

// ---- ループ --------------------------------------------------------------

function tick() {
  if (!state.started) {
    // タイトル中は物理を止める。ここで進めるとキャンディーのタイマーも走ってしまう
    state.titleT++;
    draw();
    requestAnimationFrame(tick);
    return;
  }

  if (!state.gameOver) {
    Engine.update(engine, 1000 / 60);
    state.frame++;

    // クリア演出中は入力もお邪魔も止める
    if (state.clearT > 0) {
      if (--state.clearT === 0) finishGradeClear();
      updatePoses();
      updateBubbles();
      for (let i = state.effects.length - 1; i >= 0; i--) {
        if (++state.effects[i].t > EFFECT_LIFE) state.effects.splice(i, 1);
      }
      draw();
      requestAnimationFrame(tick);
      return;
    }

    updatePendingDrop();
    updateCandy();
    updatePoses();
    updateBubbles();

    if (state.frame % SCAN_INTERVAL === 0) {
      scan();
      checkGameOver();
    }
  }

  for (let i = state.effects.length - 1; i >= 0; i--) {
    if (++state.effects[i].t > EFFECT_LIFE) state.effects.splice(i, 1);
  }

  draw();
  requestAnimationFrame(tick);
}

// ---- 入力 ----------------------------------------------------------------

// 盤面座標へ変換したうえで、ドロップ可能な範囲にクランプする。
// canvas は縦画面比を保つため左右に余白（レターボックス）ができる。そこを死に領域に
// すると、端に置きたいときほどクリックが効かなくなって操作感が最悪になる。
// 入力はページ全体で受け、はみ出した分は端に丸める。
const DROP_LO = R + 2;
const DROP_HI = W - R - 2;
const OVERRUN = 40;   // 端を越えて動かせる余地。押し当てている感触のために少しだけ残す

// 盤面外へどれだけはみ出しているかを保持し、描画側で端を光らせる（カーソルは非表示のため）
function applyRawX(raw) {
  state.rawX = clamp(raw, DROP_LO - OVERRUN, DROP_HI + OVERRUN);
  state.pushEdge = state.rawX < DROP_LO ? -1 : state.rawX > DROP_HI ? 1 : 0;
  state.pointerX = clamp(state.rawX, DROP_LO, DROP_HI);
}

// 絶対座標（ポインタロックしていない時 / タッチ）
function toBoardX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return (clientX - rect.left) / rect.width * W;
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

document.addEventListener('pointerlockchange', () => {
  state.locked = document.pointerLockElement === canvas;
});
document.addEventListener('pointerlockerror', () => {
  state.locked = false;
});

window.addEventListener('pointermove', e => {
  if (state.locked) {
    // 移動量を盤面スケールに変換して積む
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width ? W / rect.width : 1;
    applyRawX(state.rawX + e.movementX * scale);
  } else {
    applyRawX(toBoardX(e.clientX));
  }
});

window.addEventListener('pointerdown', e => {
  if (!state.locked) applyRawX(toBoardX(e.clientX));
  e.preventDefault();
});

window.addEventListener('pointerup', e => {
  if (!state.locked) {
    applyRawX(toBoardX(e.clientX));
    // マウスのときだけ固定する。タッチには不要で、むしろ邪魔になる
    if (e.pointerType === 'mouse') wantLock();
  }
  requestDrop();
  e.preventDefault();
});

window.addEventListener('keydown', e => {
  if (e.code === 'Space') { requestDrop(); e.preventDefault(); }
});

// ---- キャンバス解像度 ----------------------------------------------------

let dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.aspectRatio = W + ' / ' + H;
}
window.addEventListener('resize', resize);

resize();
reset();
tick();
