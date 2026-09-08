// drop delta - Phase 1
// 単純な円が落ちて、同種3つ以上つながると消える。連鎖まで。
// 設計書 doc/bp.md 参照。複合ボディ・キャラ画像・キャンディーは Phase 2 以降。

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

const R = 23;               // 半径
const REACH = 25;           // つながり判定の到達距離（重心間）
const MATCH = 3;            // 消去に必要な数
const MAX_BODIES = 100;     // 盤面上限

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
  removeQueue.length = 0;
}

// ---- ドロップ ------------------------------------------------------------

function girls() {
  return Composite.allBodies(world).filter(b => b.plugin && b.plugin.type);
}

function spawnBlocked(x) {
  // 出現位置に前のキャラがまだ居るなら撃たせない（重なりによる吹き飛び防止）
  const region = { min: { x: x - R, y: SPAWN_Y - R }, max: { x: x + R, y: SPAWN_Y + R } };
  return Query.region(girls(), region).length > 0;
}

function drop() {
  if (state.gameOver) { reset(); return; }
  const now = performance.now();
  if (now - state.lastDrop < DROP_COOLDOWN) return;

  const x = clamp(state.pointerX, R + 2, W - R - 2);
  if (spawnBlocked(x)) return;
  if (girls().length >= MAX_BODIES) return;

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
    if (group.length >= MATCH) groups.push(group);
  }
  return groups;
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

  let cleared = 0;
  for (const g of groups) {
    for (const b of g) {
      removeQueue.push(b);
      state.effects.push({ x: b.position.x, y: b.position.y, type: b.plugin.type, t: 0 });
      cleared++;
    }
  }

  state.score += cleared * BASE_SCORE * state.chain;
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
  const over = girls().some(b => settled(b) && b.position.y < LINE_Y);

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

  for (const b of girls()) {
    drawGirl(b.position.x, b.position.y, b.angle, R, b.plugin.type, 1);
  }

  // 消滅エフェクト
  for (const e of state.effects) {
    const t = e.t / 14;
    drawGirl(e.x, e.y, 0, R * (1 + t * 0.9), e.type, 1 - t);
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

function toBoardX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return (clientX - rect.left) / rect.width * W;
}

canvas.addEventListener('pointermove', e => {
  state.pointerX = toBoardX(e.clientX);
});
canvas.addEventListener('pointerdown', e => {
  state.pointerX = toBoardX(e.clientX);
  e.preventDefault();
});
canvas.addEventListener('pointerup', e => {
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
