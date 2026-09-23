// 効果音と BGM。
//
// 効果音は Web Audio でその場で合成する（音声ファイルを持たない）。
// BGM は chiptune-studio の音源（js/apu/）で bgm/*.json の MML を鳴らす。
//
// ブラウザは「ユーザーが操作するまで音を出さない」ので、最初のクリック / キーで
// Sound.unlock() を呼んで AudioContext を作る。それより前の再生要求は黙って捨てる。
'use strict';

const Sound = (() => {
  const MUTE_KEY = 'dropdelta.muted';
  const VOLUME_KEY = 'dropdelta.volume';
  const SE_VOLUME = 0.55;
  const BGM_VOLUME = 0.32;
  // タイトルのオルゴール版、ふだんの曲、山がラインに迫ったときのピンチ版。
  // ふだんとピンチは同じ構成（小節数・ループ位置）なので、途中で入れ替えられる
  const BGM_URLS = {
    title: 'bgm/title.json',
    normal: 'bgm/merry-go-round.json',
    pinch: 'bgm/merry-go-round-pinch.json',
  };

  let ac = null, master = null, noiseBuf = null;
  let muted = false;
  let volume = 0.8;          // 全体の音量 0〜1（効果音と BGM の両方に掛かる）
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (v >= 0 && v <= 1) volume = v;
  } catch (e) { /* 既定で鳴らす */ }
  const seGain = () => (muted ? 0 : SE_VOLUME * volume);
  const bgmGain = () => (muted ? 0 : BGM_VOLUME * volume);

  // BGM：読み込みは最初の操作のあとに裏で始める。鳴らす要求が先に来たら、読み終わってから鳴らす
  let bgm = null, song = null, bgmWanted = false, fadeTimer = 0;
  let songs = {}, mode = 'normal', wantMode = 'normal', barTicks = 144, switchBar = null, sounding = false;

  function unlock() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = seGain();
      master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      loadBgm();
    }
    if (ac.state === 'suspended') ac.resume();
  }

  async function loadBgm() {
    try {
      const mod = await import(new URL('js/apu/index.js', document.baseURI).href);
      // 曲のデータは毎回サーバーに確かめる（変わっていなければ 304 で軽い）。キャッシュの古い曲を鳴らさないように
      const load = url => fetch(url, { cache: 'no-cache' }).then(r => r.json());
      const get = url => load(url).catch(() => null);
      // 音源は準備（init）が終わってから bgm に入れる。準備中に stop() などを呼ぶと中の部品がまだ無くて例外になり、
      // それが描画ループの中だとゲームごと止まる（初回だけ：ファイルがキャッシュに無く準備に時間がかかるとき）
      const chip = new mod.Chiptune();
      const [normal, pinch, title] = await Promise.all([
        load(BGM_URLS.normal),
        get(BGM_URLS.pinch),
        get(BGM_URLS.title),
        chip.init(ac),
      ]);
      songs = { normal, pinch: pinch || normal, title: title || normal };
      song = normal;
      bgm = chip;
      bgm.onPosition = onPosition;
      bgm.setVolume(bgmGain());
      if (bgmWanted) startBgm();
    } catch (e) {
      // file:// で開いた、など。BGM が無くても遊べる
      console.warn('BGM を読み込めませんでした', e);
      bgm = null;
    }
  }

  function startBgm(fromBar = 1) {
    clearInterval(fadeTimer);
    if (!bgm || !song) return;
    mode = wantMode;
    switchBar = null;
    const s = songs[mode] || song;
    bgm.setVolume(bgmGain());
    barTicks = bgm.play(s.channels, { chips: s.chips, loop: true, fromBar }).barTicks || barTicks;
    sounding = true;
  }

  // 曲の入れ替えは次の小節の頭で、同じ小節番号から続ける（テンポは変わっても、曲の流れは途切れない）
  // タイトルの曲との出入りは待たずにすぐ（曲の構成が違うので、小節をそろえる意味がない）
  function onPosition({ tick, playing }) {
    if (!playing || !bgmWanted || wantMode === mode || mode === 'title') { switchBar = null; return; }
    const bar = Math.floor(tick / barTicks);
    if (switchBar === null) switchBar = bar;
    else if (bar !== switchBar) startBgm(bar + 1);
  }

  // ピンチ（山がラインに迫っている）かどうか。変わったら次の小節で曲を入れ替える
  function setPinch(on) {
    if (wantMode === 'title') return;
    wantMode = on ? 'pinch' : 'normal';
  }

  // タイトルの曲。もう鳴っていれば頭に戻さない（音量パネルを触るたびに最初からにならないように）
  // delay（ミリ秒）：キラキラの効果音を聞かせてから始める。そのあいだ前の曲は止めておく
  let startTimer = 0;
  function later(delay, fn) {
    clearTimeout(startTimer);
    if (!delay) { fn(); return; }
    bgmWanted = false;          // 待っている間に読み込みが終わっても、先に鳴らさない
    bgm?.stop();
    sounding = false;
    startTimer = setTimeout(fn, delay);
  }

  function titleMusic(delay = 0) {
    later(delay, () => {
      bgmWanted = true;
      wantMode = 'title';
      if (song && !(sounding && mode === 'title')) startBgm();
    });
  }

  function bgmStart(delay = 0) {
    later(delay, () => {
      bgmWanted = true;
      wantMode = 'normal';
      if (song) startBgm();
    });
  }

  // ゲームオーバー：少しずつ下げて止める
  function bgmFade(seconds = 1.6) {
    clearTimeout(startTimer);
    bgmWanted = false;
    if (!bgm) return;
    clearInterval(fadeTimer);
    const t0 = performance.now(), v0 = bgmGain();
    fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      bgm.setVolume(v0 * (1 - k));
      if (k >= 1) { clearInterval(fadeTimer); bgm.stop(); sounding = false; }
    }, 30);
  }

  function bgmStop() {
    clearTimeout(startTimer);
    bgmWanted = false;
    clearInterval(fadeTimer);
    bgm?.stop();
    sounding = false;
  }

  // 音量・ON/OFF を今の音に反映する。フェードアウト中（ゲームオーバー）の BGM はそのまま消えていくのに任せる
  function applyGain() {
    if (master) master.gain.setTargetAtTime(seGain(), ac.currentTime, 0.02);
    if (bgm && bgmWanted) bgm.setVolume(bgmGain());
    syncPanel();
  }

  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* 次回は鳴る */ }
    applyGain();
    return muted;
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch (e) { /* 次回は既定に戻る */ }
    // バーを動かしたら鳴らす意思があるとみなし、OFF なら ON に戻す
    if (muted && volume > 0) {
      muted = false;
      try { localStorage.setItem(MUTE_KEY, '0'); } catch (e) { /* 次回は鳴る */ }
    }
    applyGain();
  }

  // ---- 画面の隅の小さなパネル（ON/OFF ボタンと音量バー）----
  // 置き場所は placePanel（ゲーム画面の外に空きがあればそこ。無ければ上の帯の右はしに 🔊 だけの小さい形）。
  // ゲーム画面の中は、左上が点数とグレード、右上が「つぎ」と「おじゃま」で埋まっている。
  // キャンバスの外の HTML に置く。ここを押してもゲームの入力（window の pointerdown など）に届かないよう止める
  let panel = null, btn = null, bar = null;
  function buildPanel() {
    const css = document.createElement('style');
    css.textContent = `
      #snd { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
             z-index: 10; display: flex; align-items: center; gap: 6px; padding: 4px 10px 4px 4px;
             border-radius: 999px; background: rgba(255,255,255,0.72); box-shadow: 0 1px 6px rgba(0,0,0,0.18);
             cursor: auto; touch-action: auto; }
      #snd button { width: 30px; height: 30px; border: 0; border-radius: 50%; background: #e8649a; color: #fff;
                    font-size: 15px; line-height: 30px; cursor: pointer; padding: 0; }
      #snd button.off { background: #a9b6c4; }
      #snd input { width: 80px; accent-color: #e8649a; cursor: pointer; }
      /* 小さい形：ゲーム画面の外に置けないとき。上の帯の右はしに 🔊 だけ。押すとバーが左へ開く（ボタンは右はしから動かない） */
      #snd.compact { padding: 0; background: transparent; box-shadow: none; flex-direction: row-reverse; }
      #snd.compact input { display: none; }
      #snd.compact.open { padding: 4px 0 4px 10px; background: rgba(255,255,255,0.9); box-shadow: 0 1px 6px rgba(0,0,0,0.18); }
      #snd.compact.open input { display: block; }
    `;
    document.head.appendChild(css);
    panel = document.createElement('div');
    panel.id = 'snd';
    btn = document.createElement('button');
    btn.type = 'button';
    bar = document.createElement('input');
    bar.type = 'range';
    bar.min = '0';
    bar.max = '100';
    bar.setAttribute('aria-label', 'おんりょう');
    panel.append(btn, bar);
    for (const ev of ['pointerdown', 'pointerup', 'keydown', 'keyup']) panel.addEventListener(ev, e => e.stopPropagation());
    btn.addEventListener('click', () => {
      unlock();
      // 小さい形で閉じているときは、まずバーを開く（開いているときは ON/OFF）
      if (panel.classList.contains('compact') && !panel.classList.contains('open')) openCompact();
      else { toggleMute(); keepOpen(); }
      btn.blur();
    });
    bar.addEventListener('input', () => { unlock(); setVolume(bar.value / 100); keepOpen(); });
    // 動かし終えたら効果音を1つ鳴らして、効果音の大きさも確かめられるようにする。
    // フォーカスを残すとスペースキーがゲームに届かないので外す
    bar.addEventListener('change', () => { if (live()) poyoVoice(660, 0.18); bar.blur(); });
    document.body.appendChild(panel);
    syncPanel();
    placePanel();
    window.addEventListener('resize', placePanel);
    const cv = document.getElementById('cv');
    if (cv && window.ResizeObserver) new ResizeObserver(placePanel).observe(cv);
  }
  // 置き場所。遊んでいる間も音量を変えられるように、いつも出しておく。
  //   横に空き（パソコンの横長の画面）→ ゲーム画面の右横の上
  //   それ以外（スマホ・狭いブラウザ）→ 小さい形：上の帯のいちばん右（game.js が空ける所）に 🔊 だけ。押すとバーが左へ開き、
  //                                     4 秒さわらなければ閉じる。遊んでいる間も出したまま（ブラウザの幅を狭めたときなど）
  const PANEL_W = 140, PANEL_H = 38;       // 開いたときの大きさ（外に置けるかの判定用）
  const HUD_MID_Y = 23, HUD_RIGHT = 472, BOARD_W = 480, BOARD_H = 760;   // 上の帯の真ん中の高さ・右はし・盤面の幅（game.js の HUD_TOP + HUD_H / 2 など）
  let panelWanted = true, panelOutside = false, closeTimer = 0;
  function placePanel() {
    const cv = document.getElementById('cv');
    if (!panel || !cv) return;
    const r = cv.getBoundingClientRect();
    // 画面が細いと、枠の中で絵が上下に余白を空けて描かれる（object-fit: contain）。絵の四隅を求める
    // 縦横比は盤面（480×760）で決まっているので、キャンバスの画素数ではなくそれで計算する。
    // このファイルは game.js より先に読まれ、そのときキャンバスはまだ仮の 300×150。スマホでは枠の大きさが変わらず
    // ResizeObserver も来ないので、仮の横長の形で計算した位置（右側のまん中あたり）に残っていた
    const k = Math.min(r.width / BOARD_W, r.height / BOARD_H);
    const dw = BOARD_W * k, dh = BOARD_H * k;
    const left = r.left + (r.width - dw) / 2, top = r.top + (r.height - dh) / 2;
    const vw = window.innerWidth;
    const set = (x, y, center) => {
      panel.classList.remove('compact', 'open');
      btn.style.width = btn.style.height = btn.style.lineHeight = btn.style.fontSize = '';
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.transform = center ? 'translateX(-50%)' : 'none';
    };
    panelOutside = true;
    if (vw - (left + dw) >= PANEL_W + 24) set(left + dw + 12, top + 8, false);
    // ゲーム画面の下（や上）の空きには置かない。スマホではちょうど親指で操作するあたりで、
    // 遊んでいる最中に指が当たって音量が変わったり、フルーツが落ちなかったりして邪魔だった
    else {
      // 小さい形。ボタンは盤面の縮み具合に合わせる（右はしの 38 に収まるように）。右はしをそろえ、バーは左へ開く
      const scale = dw / BOARD_W;
      const size = Math.max(20, Math.min(30, 32 * scale));
      const wasOpen = panel.classList.contains('open');
      panel.classList.add('compact');
      if (wasOpen) panel.classList.add('open');
      panel.style.transform = 'translate(-100%, -50%)';
      panel.style.left = (left + HUD_RIGHT * scale) + 'px';
      panel.style.top = (top + HUD_MID_Y * scale) + 'px';
      btn.style.width = btn.style.height = btn.style.lineHeight = size + 'px';
      btn.style.fontSize = Math.round(size * 0.5) + 'px';
    }
    applyPanelVisible();
  }
  function openCompact() {
    panel.classList.add('open');
    keepOpen();
  }
  // 小さい形で開いているときは、さわるたびに閉じるまでの時間を延ばす
  function keepOpen() {
    clearTimeout(closeTimer);
    if (!panel.classList.contains('compact')) return;
    closeTimer = setTimeout(() => panel.classList.remove('open'), 4000);
  }
  // on：タイトル・ゲームオーバーでは true、遊んでいる間は false。外や小さい形で置けているときは遊んでいる間も出す
  function showPanel(on) {
    panelWanted = on;
    applyPanelVisible();
  }
  function applyPanelVisible() {
    if (panel) panel.style.display = panelWanted || panelOutside ? '' : 'none';
  }
  function syncPanel() {
    if (!panel) return;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('off', muted);
    btn.title = muted ? 'おとを だす（M）' : 'おとを けす（M）';
    btn.setAttribute('aria-label', btn.title);
    bar.value = String(Math.round(volume * 100));
  }
  if (document.body) buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);

  // ---- 合成の部品 ----

  const live = () => ac && !muted && ac.state === 'running';

  // 音量の山：a 秒で peak まで上がり、d 秒かけて消える
  function env(g, t, peak, a, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  // 音程の動きを [秒, Hz] の並びで与える1音
  function tone(type, bends, peak, a, d, t = ac.currentTime, out = master) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(bends[0][1], t);
    for (let i = 1; i < bends.length; i++) o.frequency.exponentialRampToValueAtTime(bends[i][1], t + bends[i][0]);
    env(g, t, peak, a, d);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + a + d + 0.05);
    return o;
  }

  function noise(t, peak, d, filterType, freq, q = 1) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf;
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    env(g, t, peak, 0.003, d);
    s.connect(f).connect(g).connect(master);
    s.start(t, Math.random() * 0.3);
    s.stop(t + d + 0.05);
  }

  // ぽよん：いったん上がってから下がる音程に、ゆらぎを足す。ゴムまりやグミのはずむ感じ
  function poyoVoice(f, peak, t = ac.currentTime) {
    const o = tone('sine', [[0, f * 0.8], [0.035, f * 1.35], [0.2, f * 0.92]], peak, 0.008, 0.2, t);
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = 22;
    lg.gain.value = f * 0.06;
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + 0.26);
    tone('triangle', [[0, f * 1.6], [0.035, f * 2.7], [0.12, f * 1.9]], peak * 0.25, 0.005, 0.1, t);
  }

  // 同じ瞬間にたくさんぶつかっても鳴らしすぎない
  let lastLand = 0, landsThisBurst = 0;

  // 音階（ド長調の5音）。色ごと・連鎖ごとに高さを変える
  const PENTA = [0, 2, 4, 7, 9];
  const scaleHz = (step, base = 392) =>
    base * Math.pow(2, (PENTA[((step % 5) + 5) % 5] + 12 * Math.floor(step / 5)) / 12);

  const api = {
    unlock, toggleMute, setVolume, showPanel, setPinch, titleMusic, bgmStart, bgmFade, bgmStop,
    get volume() { return volume; },
    get muted() { return muted; },
    placePanel,         // ゲーム画面の大きさが決まったとき・変わったときに game.js から呼ぶ
    // 音量パネルが小さい形（上の帯の右はしの 🔊）か。game.js が帯の右はしを空けるのに使う
    get compact() { return !!panel && panel.classList.contains('compact'); },
    // 確認用：音の状態（AudioContext・BGM の読み込み・鳴らしているか）
    status: () => ({ context: ac?.state ?? null, bgmLoaded: !!song, bgmOn: bgmWanted, mode, wantMode }),

    // 飴を落とした：小さく「ぷ」
    fire() {
      if (!live()) return;
      tone('sine', [[0, 520], [0.05, 780]], 0.12, 0.004, 0.06);
    },

    // 飴が着地した：ぽよん。speed で大きさ、kind（色の番号）で高さ
    land(speed, kind = 0) {
      if (!live()) return;
      const now = ac.currentTime;
      if (now - lastLand > 0.12) landsThisBurst = 0;
      if (now - lastLand < 0.035 || landsThisBurst >= 4) return;
      lastLand = now;
      landsThisBurst++;
      const k = Math.min(1, (speed - 1.5) / 7);
      poyoVoice(scaleHz(kind, 330) * (0.97 + Math.random() * 0.06), 0.1 + 0.3 * k);
    },

    // おじゃまキャンディーが着地した：包み紙ごと「ぽすっ」と低く
    thud(speed) {
      if (!live()) return;
      const now = ac.currentTime;
      if (now - lastLand < 0.035) return;
      lastLand = now;
      const k = Math.min(1, (speed - 1.5) / 7);
      tone('sine', [[0, 190], [0.12, 95]], 0.18 + 0.3 * k, 0.005, 0.14);
      noise(now, 0.05 + 0.12 * k, 0.07, 'lowpass', 900);
    },

    // 消えた：はじける「ぱちん」。連鎖ほど高く、たくさん消えるほど粒が増える
    pop(chain = 1, count = 3) {
      if (!live()) return;
      const t0 = ac.currentTime;
      const n = Math.min(6, Math.max(2, Math.ceil(count / 2)));
      for (let i = 0; i < n; i++) {
        const t = t0 + i * 0.045 + Math.random() * 0.01;
        const f = scaleHz(chain * 2 + i, 523);
        noise(t, 0.16, 0.035, 'highpass', 2500);
        tone('sine', [[0, f * 0.7], [0.03, f * 1.6]], 0.2, 0.003, 0.08, t);
      }
      // 連鎖のときは上にきらっと1音
      if (chain >= 2) tone('triangle', [[0, scaleHz(chain * 2 + n, 1046)]], 0.12, 0.01, 0.35, t0 + n * 0.045);
    },

    // グレードクリア：上る分散和音
    gradeClear() {
      if (!live()) return;
      const t0 = ac.currentTime;
      [0, 4, 7, 12, 16].forEach((s, i) => {
        const f = 523 * Math.pow(2, s / 12);
        tone('triangle', [[0, f]], 0.2, 0.01, 0.5, t0 + i * 0.08);
        tone('sine', [[0, f * 2]], 0.06, 0.01, 0.35, t0 + i * 0.08);
      });
      poyoVoice(523, 0.2, t0 + 0.45);
    },

    // 器の解放：高いきらきら
    stageOpen() {
      if (!live()) return;
      const t0 = ac.currentTime + 0.5;
      for (let i = 0; i < 7; i++) {
        tone('sine', [[0, 1568 * Math.pow(2, (i % 4) * 3 / 12)]], 0.08, 0.005, 0.3, t0 + i * 0.06);
      }
    },

    // ゲームオーバー：しょんぼりしたトロンボーン「ワッ・ワッ・ワッ・ワ〜〜ン」。
    // 半音ずつ下がる 4 つの音。のこぎり波をフィルターに通し、開け閉めで口を開くような「ワッ」にする。
    // 最後の音は長く伸ばし、揺れを大きくしながら音程も少し下げて消える
    gameOver() {
      if (!live()) return;
      const t0 = ac.currentTime + 0.15;
      const notes = [[392, 0.34], [370, 0.34], [349, 0.34], [330, 1.5]];   // ソ・ファ#・ファ・ミ
      let t = t0;
      notes.forEach(([f, d], k) => {
        const last = k === notes.length - 1;
        const o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, t);
        if (last) o.frequency.linearRampToValueAtTime(f * 0.94, t + d);   // 最後はしょんぼり下がる
        fl.type = 'lowpass';
        fl.Q.value = 6;
        // ワッ：こもった音から開いて、また少し閉じる
        fl.frequency.setValueAtTime(300, t);
        fl.frequency.exponentialRampToValueAtTime(1300, t + 0.08);
        fl.frequency.exponentialRampToValueAtTime(last ? 500 : 700, t + d * 0.9);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
        g.gain.setValueAtTime(0.16, t + d * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(fl).connect(g).connect(master);
        if (last) {
          // 揺れ：だんだん大きく
          const lfo = ac.createOscillator(), lg = ac.createGain();
          lfo.frequency.value = 5.5;
          lg.gain.setValueAtTime(0, t);
          lg.gain.linearRampToValueAtTime(f * 0.035, t + d * 0.8);
          lfo.connect(lg).connect(o.frequency);
          lfo.start(t);
          lfo.stop(t + d + 0.05);
        }
        o.start(t);
        o.stop(t + d + 0.05);
        t += d + 0.04;
      });
    },

    // 始めるときのキラキラ（たくさん連鎖したときの音を、もっと華やかに）。鳴っている長さ（ミリ秒）を返す
    kira() {
      if (!live()) return 0;
      const t0 = ac.currentTime;
      for (let i = 0; i < 8; i++) {
        const t = t0 + i * 0.05;
        const f = scaleHz(10 + i, 523);
        noise(t, 0.1, 0.03, 'highpass', 3000);
        tone('sine', [[0, f * 0.7], [0.03, f * 1.5]], 0.16, 0.003, 0.09, t);
      }
      // 上でまたたく高い音
      for (let i = 0; i < 6; i++) {
        tone('triangle', [[0, scaleHz(18 + (i % 3) * 2, 523)]], 0.08, 0.005, 0.35, t0 + 0.25 + i * 0.06);
      }
      return 750;
    },

    // タイトルで指している器が変わった：軽く「ぽっ」
    hover() {
      if (!live()) return;
      tone('sine', [[0, 880], [0.04, 1175]], 0.1, 0.004, 0.07);
    },

    // まだ遊べない器を押した：「ぶぶっ」
    deny() {
      if (!live()) return;
      const t = ac.currentTime;
      tone('square', [[0, 196]], 0.06, 0.005, 0.07, t);
      tone('square', [[0, 185]], 0.06, 0.005, 0.09, t + 0.11);
    },

    // タイトルで選んだ・始めた
    select() {
      if (!live()) return;
      poyoVoice(660, 0.18);
    },
  };

  // 音の処理でどんな例外が起きても、呼んだ側（ゲームの描画ループ）まで止めない。音が鳴らないだけで済ませる
  for (const k of Object.keys(api)) {
    const d = Object.getOwnPropertyDescriptor(api, k);
    if (typeof d.value !== 'function') continue;
    const f = d.value;
    api[k] = (...args) => {
      try { return f(...args); } catch (e) { console.warn('Sound.' + k, e); return 0; }
    };
  }
  return api;
})();

