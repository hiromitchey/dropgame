import { parseMML, settingsAt, ticksPerBar, setTicksPerBar, wholeTicks } from './mml.js';
import { CHIPS, CHANNELS, CHANNEL_LABEL, chipOf, parseChip, normalizeChips, chipCount, withChip, chipChannels, chipsFor, resolveChips } from './chips.js';

export { parseMML, settingsAt, ticksPerBar, setTicksPerBar, wholeTicks, CHIPS, CHANNELS, CHANNEL_LABEL, chipOf, parseChip, normalizeChips, chipCount, withChip, chipChannels, chipsFor, resolveChips };

export class Chiptune {
  async init(ac) {
    this.ac = ac ?? new AudioContext();
    await this.ac.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ac, 'chiptune', { numberOfInputs: 0, outputChannelCount: [1] });
    this.node.connect(this.ac.destination);
    this.onPosition = null;
    this.node.port.onmessage = e => {
      if (e.data.type === 'pos') this.onPosition?.(e.data);
    };
  }

  // from：開始位置（tick）。途中からでも、それまでの音量・音色・テンポを反映した状態で始まる
  // fromBar：開始位置を小節で（1 から）。小節の長さは曲の拍子（M3/4 など）に合わせる。from より優先
  // chips：使う音源チップ（例 ['core', 'ex6']）。省くと中身が書いてあるチャンネルから決める。使わないチップは鳴らさない
  // 戻り値の barTicks：この曲の1小節の tick（4/4 なら 192、3/4 なら 144）。meter：拍子の文字列（'3/4' など）
  play(mmlSet, { loop = true, from = 0, fromBar = null, chips = null } = {}) {
    const { events, length, loopStart, notes, errors, barTicks, meter } = parseMML(mmlSet);
    if (fromBar != null) from = (fromBar - 1) * barTicks;
    if (this.ac.state === 'suspended') this.ac.resume();
    if (!(from >= 0 && from < length)) from = 0;
    this.node.port.postMessage({ type: 'play', events, length, loopStart, loop, from, chips: resolveChips(mmlSet, chips) });
    return { events, length, loopStart, notes, errors, barTicks, meter };
  }

  // 1音だけ鳴らす。setup は鳴らす前に反映する設定イベント（settingsAt の結果）
  preview(ch, midi, { setup = [], seconds = 0.3 } = {}) {
    if (this.ac.state === 'suspended') this.ac.resume();
    this.node.port.postMessage({ type: 'preview', ch, midi, setup, seconds });
  }

  stop()        { this.node.port.postMessage({ type: 'stop' }); }
  setVolume(v)  { this.node.port.postMessage({ type: 'gain', v }); }
  setLoop(on)   { this.node.port.postMessage({ type: 'loop', on }); }
  mute(ch, on)  { this.node.port.postMessage({ type: 'mute', ch, on }); }
}
