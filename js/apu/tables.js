export const CPU_HZ = 1789773;            // NTSC
export const FRAME_PERIOD = CPU_HZ / 240;  // フレームカウンタ（4ステップモード）
export const TPQ = 48;                     // 4分音符あたりの tick（3連符も割り切れる）

export const DUTY = [
  [0, 1, 0, 0, 0, 0, 0, 0],   // 12.5%
  [0, 1, 1, 0, 0, 0, 0, 0],   // 25%
  [0, 1, 1, 1, 1, 0, 0, 0],   // 50%
  [1, 0, 0, 1, 1, 1, 1, 1],   // 75%
];

export const TRI_SEQ = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

export const NOISE_PERIOD = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];

export const noteToHz = n => 440 * Math.pow(2, (n - 69) / 12);
