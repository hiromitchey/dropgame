// drop delta - Phase 1 + 5
// 落下・堆積・同種3体消去・連鎖・キャンディー（お邪魔）まで。
// 設計書 doc/bp.md 参照。複合ボディ・キャラ画像・ポーズ切り替えは Phase 2〜4。

'use strict';

const { Engine, Composite, Bodies, Events, Query } = Matter;

// ---- 盤面 ----------------------------------------------------------------

const W = 480;              // 論理解像度。実解像度は DPR で拡大
const H = 760;
const WALL = 60;            // 壁の厚み（画面外に置く）
const LINE_Y = 150;         // ゲームオーバーライン
const SPAWN_Y = 70;         // 待機キャラの出現高さ

// ---- キャラ --------------------------------------------------------------

// Phase 3 でスプライトに差し替える。色は img/girls.png の髪色に対応させてある。
const TYPES = [
  { id: 'a', body: '#7ecb8f', hair: '#4da362' },
  { id: 'b', body: '#7fd6d0', hair: '#4aa8b8' },
  { id: 'c', body: '#f492b8', hair: '#e05c92' },
];

// Phase 1 の円は仮。棒立ちの絵は縦横比が約 1:2.9 と細長く、円1個では表現できない。
// Phase 2 で複合ボディに差し替える際、この R は「キャラの幅」の基準として引き継ぐ。
const R = 31;               // 半径
const REACH = 33;           // つながり判定の到達距離（重心間）
const MATCH = 3;            // 消去に必要な数
const MAX_BODIES = 200;     // 盤面上限。負荷の安全弁であり難易度装置ではない。
                            // ゲームオーバーラインより先に効くと負けなくなる

// ---- 物理パラメータ（設計書 4.2）----------------------------------------

const PHYS = {
  restitution: 0.15,
  friction: 0.55,
  frictionStatic: 0.6,
  frictionAir: 0.015,
  density: 0.001,
};

// ---- 判定 ----------------------------------------------------------------

const SETTLE_SPEED = 0.35;      // 静止とみなす速度
const SCAN_INTERVAL = 10;       // 何フレームに1回走査するか
const RECHECK_DELAY = 380;      // 消去後、再判定までの待機 (ms)
const CHAIN_WINDOW = 1000;      // 連鎖とみなす間隔 (ms)
const DROP_COOLDOWN = 100;      // 出現位置の重なり事故を防ぐ最小限
const OVER_HOLD = 1500;         // ライン超過がこの時間続いたらゲームオーバー

const BASE_SCORE = 40;
const CANDY_SCORE = 15;

// ---- キャンディー（設計書 3.2 / 7）--------------------------------------

const CANDY_R = 27;             // キャラとほぼ同大。盤面を強く圧迫する
const CANDY_REACH = 29;
const CANDY_LAYER_CAP = 4;      // 連鎖で広がる巻き込み層の上限

// 投入契機は経過時間。ドロップ回数ではない（連続発射を許可しているため）
const CANDY_FIRST = 6000;       // 初回までの猶予 (ms)
const CANDY_INTERVAL_MAX = 7000;
const CANDY_INTERVAL_MIN = 2200;
const CANDY_INTERVAL_STEP = 400;   // 1波ごとに間隔を詰める量
const CANDY_COUNT_EVERY = 3;      // 何波ごとに1回の投入数を増やすか

const candyInterval = wave =>
  Math.max(CANDY_INTERVAL_MIN, CANDY_INTERVAL_MAX - wave * CANDY_INTERVAL_STEP);
const candyCount = wave => 1 + Math.floor(wave / CANDY_COUNT_EVERY);

// キャンディーは転がらず「詰まる」（設計書 3.2）
const CANDY_PHYS = {
  restitution: 0.02,
  friction: 0.9,
  frictionStatic: 1.0,
  frictionAir: 0.02,
  density: 0.0014,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- 状態 ----------------------------------------------------------------

const engine = Engine.create();
engine.gravity.y = 1.0;
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
  best: Number(localStorage.getItem('dropdelta.best') || 0),
  overSince: 0,
  gameOver: false,
  dropped: false,
  effects: [],
  wave: 0,            // キャンディーを何回投入したか
  nextCandyAt: 0,     // 次の投入時刻
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

function randomType() {
  return TYPES[(Math.random() * TYPES.length) | 0];
}

function fillQueue() {
  while (state.queue.length < 3) state.queue.push(randomType());
}

function reset() {
  Composite.clear(world, false);
  buildWalls();
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
  state.wave = 0;
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

function drop() {
  if (state.gameOver) { reset(); return; }
  const now = performance.now();
  if (now - state.lastDrop < DROP_COOLDOWN) return;

  const x = clamp(state.pointerX, R + 2, W - R - 2);
  if (spawnBlocked(x)) return;
  if (pieces().length >= MAX_BODIES) return;

  const type = state.queue.shift();
  fillQueue();

  const b = Bodies.circle(x, SPAWN_Y, R, Object.assign({}, PHYS, {
    label: 'girl',
    plugin: { type: type.id, reach: REACH },
  }));
  Composite.add(world, b);
  state.lastDrop = now;
  state.dropped = true;
}

// ---- キャンディー投入（設計書 7）----------------------------------------

function spawnCandy() {
  const x = clamp(40 + Math.random() * (W - 80), CANDY_R + 2, W - CANDY_R - 2);
  const b = Bodies.circle(x, 34, CANDY_R, Object.assign({}, CANDY_PHYS, {
    label: 'candy',
    plugin: { candy: true, reach: CANDY_REACH },
  }));
  Composite.add(world, b);
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
      state.effects.push({ x: b.position.x, y: b.position.y, type: b.plugin.type, t: 0 });
      cleared++;
    }
  }

  // 巻き込まれるキャンディー。連鎖数だけ層が広がる（設計書 3.2）
  const swept = collectCandy(clearedGirls, Math.min(state.chain, CANDY_LAYER_CAP));
  for (const c of swept) {
    removeQueue.push(c);
    state.effects.push({ x: c.position.x, y: c.position.y, candy: true, t: 0 });
  }

  state.score += cleared * BASE_SCORE * state.chain
               + swept.length * CANDY_SCORE * state.chain;
  state.recheckAt = now + RECHECK_DELAY;
}

// 消去は afterUpdate でまとめて実行（設計書 5.3）
Events.on(engine, 'afterUpdate', () => {
  if (!removeQueue.length) return;
  for (const b of removeQueue) Composite.remove(world, b);
  removeQueue.length = 0;
});

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
      localStorage.setItem('dropdelta.best', String(state.best));
    }
  }
}

// ---- 描画 ----------------------------------------------------------------

const colorOf = id => TYPES.find(t => t.id === id);

function drawGirl(x, y, angle, r, id, alpha) {
  const c = colorOf(id);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle * 0.3);   // 実角度の 0.3 倍に抑制（設計書 4.2）
  ctx.globalAlpha = alpha;

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

function drawCandy(x, y, angle, r, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;

  // 包み（左右のひねり）。物理半径 r をはみ出さない範囲に収める。
  // 大きく描くと見た目と当たり判定がズレて、置ける場所が読めなくなる
  ctx.fillStyle = '#8d7fb5';
  ctx.beginPath();
  ctx.moveTo(-r * 1.0, -r * 0.62);
  ctx.lineTo(-r * 0.45, 0);
  ctx.lineTo(-r * 1.0, r * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(r * 1.0, -r * 0.62);
  ctx.lineTo(r * 0.45, 0);
  ctx.lineTo(r * 1.0, r * 0.62);
  ctx.closePath();
  ctx.fill();

  // 本体
  ctx.fillStyle = '#b6a7e0';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.95, 0, Math.PI * 2);
  ctx.fill();

  // ハイライト
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.32, r * 0.28, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1b1f2e');
  g.addColorStop(1, '#101320');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // ゲームオーバーライン
  ctx.strokeStyle = state.overSince ? '#e05c92' : '#2e3448';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(0, LINE_Y);
  ctx.lineTo(W, LINE_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 落下ガイド + 待機キャラ
  if (!state.gameOver) {
    const x = clamp(state.pointerX, R + 2, W - R - 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = R * 2;
    ctx.beginPath();
    ctx.moveTo(x, SPAWN_Y);
    ctx.lineTo(x, H);
    ctx.stroke();
    drawGirl(x, SPAWN_Y, 0, R, state.queue[0].id, 1);
  }

  for (const b of candies()) {
    drawCandy(b.position.x, b.position.y, b.angle, CANDY_R, 1);
  }

  for (const b of girls()) {
    drawGirl(b.position.x, b.position.y, b.angle, R, b.plugin.type, 1);
  }

  // 消滅エフェクト
  for (const e of state.effects) {
    const t = e.t / 14;
    if (e.candy) drawCandy(e.x, e.y, 0, CANDY_R * (1 + t * 0.9), 1 - t);
    else drawGirl(e.x, e.y, 0, R * (1 + t * 0.9), e.type, 1 - t);
  }

  drawHud();
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

  // NEXT
  ctx.textAlign = 'right';
  ctx.fillText('NEXT', W - 16, 24);
  for (let i = 1; i < 3; i++) {
    drawGirl(W - 30 - (i - 1) * 44, 46, 0, 15, state.queue[i].id, 0.9 - (i - 1) * 0.35);
  }

  // キャンディー予告。残り時間と来る数（設計書 7「予告なしは理不尽」）
  if (!state.gameOver) {
    const left = Math.max(0, state.nextCandyAt - performance.now());
    const span = candyInterval(state.wave);
    const n = candyCount(state.wave);
    const imminent = left < 3000;

    ctx.textAlign = 'left';
    ctx.fillStyle = imminent ? '#c9a3f0' : '#5a6280';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('CANDY x' + n + '  ' + (left / 1000).toFixed(1) + 's', 16, 82);

    // 残り時間バー
    const bw = 96, bh = 4;
    ctx.fillStyle = '#252a3c';
    ctx.fillRect(16, 90, bw, bh);
    ctx.fillStyle = imminent ? '#b6a7e0' : '#454d6b';
    ctx.fillRect(16, 90, bw * clamp(1 - left / span, 0, 1), bh);
  }

  // 操作ヒント。最初のドロップまで
  if (!state.dropped) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#4a5068';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('動かす: マウス / 指　　落とす: クリック / タップ', W / 2, H - 40);
  }

  if (state.chain > 1 && performance.now() - state.lastClear < CHAIN_WINDOW) {
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f6c86a';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText(state.chain + ' CHAIN', W / 2, H / 2 - 40);
  }

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
  if (!state.gameOver) {
    Engine.update(engine, 1000 / 60);
    state.frame++;

    updateCandy();

    if (state.frame % SCAN_INTERVAL === 0) {
      scan();
      checkGameOver();
    }
  }

  for (let i = state.effects.length - 1; i >= 0; i--) {
    if (++state.effects[i].t > 14) state.effects.splice(i, 1);
  }

  draw();
  requestAnimationFrame(tick);
}

// ---- 入力 ----------------------------------------------------------------

// 盤面座標へ変換したうえで、ドロップ可能な範囲にクランプする。
// canvas は縦画面比を保つため左右に余白（レターボックス）ができる。そこを死に領域に
// すると、端に置きたいときほどクリックが効かなくなって操作感が最悪になる。
// 入力はページ全体で受け、はみ出した分は端に丸める。
function toBoardX(clientX) {
  const rect = canvas.getBoundingClientRect();
  const raw = (clientX - rect.left) / rect.width * W;
  return clamp(raw, R + 2, W - R - 2);
}

window.addEventListener('pointermove', e => {
  state.pointerX = toBoardX(e.clientX);
});
window.addEventListener('pointerdown', e => {
  state.pointerX = toBoardX(e.clientX);
  e.preventDefault();
});
window.addEventListener('pointerup', e => {
  state.pointerX = toBoardX(e.clientX);
  drop();
  e.preventDefault();
});
window.addEventListener('keydown', e => {
  if (e.code === 'Space') { drop(); e.preventDefault(); }
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
