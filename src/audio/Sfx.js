/**
 * 《咕咕奇遇记》音效模块 Sfx.js
 * —— 纯 WebAudio 合成，零外部音频文件，严格按 docs/CONTRACT.md §2.5。
 *
 * 设计约束（契约 + 移动端现实）：
 *  - 构造时 **不** 创建 AudioContext（iOS 会在没有用户手势时警告并把 ctx 置为 suspended）。
 *  - unlock() 在首个用户手势里调用，创建/恢复 AudioContext；幂等。
 *  - 所有发声方法 **同步** 且 **绝不抛错**：整体 try/catch，未解锁或已静音时直接 return。
 *  - step() 需要节流 ≥120ms（内部时间戳），walk/run 音量与音色不同。
 */

/** 泥咕咕主色系之外的音色常量（都写成具名常量便于统一调音） */
const MASTER_VOLUME = 0.9;

/** 五声音阶/大三和弦音高（Hz），cheer 用 */
const CHEER_NOTES = [523.25, 659.25, 783.99]; // C5 E5 G5

/** step 节流阈值（秒）：契约要求 ≥120ms */
const STEP_THROTTLE = 0.12;

/** step 音量：walk 轻、run 重 */
const STEP_GAIN = { walk: 0.05, run: 0.11 };
/** step 低频撞击的基频：walk / run */
const STEP_FREQ = { walk: 168, run: 118 };
/** step 时长（秒）：契约要求 60~90ms */
const STEP_DUR = { walk: 0.06, run: 0.09 };

class Sfx {
  constructor() {
    /** @type {AudioContext|null} 延迟到 unlock() 才创建 */
    this.ctx = null;
    /** 总线音量节点 */
    this.master = null;
    /** 是否允许发声（用户可关） */
    this._enabled = true;
    /** unlock 是否已在执行/已完成（幂等标记） */
    this._unlocking = false;
    this._unlocked = false;
    /** step 上次发声时间戳（performance.now 毫秒） */
    this._lastStepAt = -Infinity;
    /** 复用同一块噪声 buffer，避免每次 step 都重新填充 */
    this._noiseBuffer = null;
  }

  /** 当前是否允许发声 */
  get enabled() {
    return this._enabled;
  }

  /**
   * 首个用户手势后调用：创建 AudioContext 并处理 suspended。
   * 幂等：第二次调用直接返回；全程 try/catch，失败只 warn 不影响游戏。
   */
  async unlock() {
    if (this._unlocked) return;
    if (this._unlocking) return;
    this._unlocking = true;
    try {
      if (!this.ctx) {
        const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (typeof Ctor !== 'function') {
          console.warn('[Sfx] 当前环境不支持 WebAudio，音效已禁用');
          return;
        }
        this.ctx = new Ctor();
        // 总线：所有声音汇到 master 再出，便于统一限幅
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER_VOLUME;
        this.master.connect(this.ctx.destination);
        this._noiseBuffer = null; // 新 ctx 需要新的 buffer
      }
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        await this.ctx.resume();
      }
      this._unlocked = true;
    } catch (error) {
      console.warn('[Sfx] unlock 失败（音效将保持静音）：', error);
    } finally {
      this._unlocking = false;
    }
  }

  /** 开关音效；关闭时所有发声方法立即 return */
  setEnabled(bool) {
    try {
      this._enabled = !!bool;
      if (!this._enabled && this.master && this.ctx) {
        // 立刻静音，避免长尾音（place 400ms）拖尾
        try {
          this.master.gain.cancelScheduledValues(this.ctx.currentTime);
          this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
        } catch {
          /* 忽略：老浏览器可能没有 setTargetAtTime */
        }
      } else if (this._enabled && this.master && this.ctx) {
        try {
          this.master.gain.cancelScheduledValues(this.ctx.currentTime);
          this.master.gain.setTargetAtTime(MASTER_VOLUME, this.ctx.currentTime, 0.02);
        } catch {
          /* 忽略 */
        }
      }
    } catch (error) {
      console.warn('[Sfx] setEnabled 异常：', error);
    }
  }

  // ------------------------------------------------------------------ 内部工具

  /** 是否现在可以发声（未解锁 / 已静音 / 无 ctx 一律 false） */
  _ready() {
    if (!this._enabled) return false;
    if (!this.ctx || !this.master) return false;
    if (this.ctx.state === 'closed') return false;
    return true;
  }

  /** 若 ctx 被系统挂起（iOS 切后台回来），火忘式恢复；同步调用，不阻塞 */
  _ensureRunning() {
    try {
      const state = this.ctx && this.ctx.state;
      if (state === 'suspended' || state === 'interrupted') {
        const p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch {
      /* 忽略 */
    }
  }

  /** 数字安全化：非法 → 兜底值 */
  static _num(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  /**
   * 基础包络：在 gain 上做 ADSR 的 A/D 段（长尾用 exp 衰减更自然）。
   * @param {GainNode} gain
   * @param {number} t0 起始时刻（ctx 时间轴）
   * @param {number} attack 起音（秒）
   * @param {number} dur 持续到静音的总时长（秒）
   * @param {number} peak 峰值增益
   */
  _env(gain, t0, attack, dur, peak) {
    const a = Math.max(0.001, Math.min(attack, dur * 0.9));
    const p = Math.max(0.0001, peak);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(p, t0 + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  /**
   * 单音：可选频率滑音 + 波形 + 包络。
   * @param {{ freq0: number, freq1?: number, dur: number, type?: OscillatorType, gain?: number, attack?: number, delay?: number, detune?: number }} options
   */
  _tone({ freq0, freq1, dur, type = 'sine', gain = 0.1, attack = 0.006, delay = 0, detune = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const d = Math.max(0.02, Sfx._num(dur, 0.1));
    const f0 = Math.max(20, Sfx._num(freq0, 440));
    const f1 = Number.isFinite(freq1) ? Math.max(20, freq1) : null;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 != null && f1 !== f0) {
      // 指数滑音听感比线性更自然（音高感知是对数的）
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + d);
    }
    if (detune) osc.detune.setValueAtTime(detune, t0);

    this._env(env, t0, attack, d, gain);
    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + d + 0.02);
    // 播完自动断开，避免节点累积
    osc.onended = () => {
      try {
        osc.disconnect();
        env.disconnect();
      } catch {
        /* 忽略 */
      }
    };
    return osc;
  }

  /** 取（必要时创建）1 秒白噪声 buffer */
  _noise() {
    const ctx = this.ctx;
    if (this._noiseBuffer && this._noiseBuffer.sampleRate === ctx.sampleRate) return this._noiseBuffer;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 1.0));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
    return buffer;
  }

  /**
   * 噪声脉冲：带通/低通滤波 + 包络，用于脚步声与落地闷响。
   * @param {{ dur: number, gain: number, freq?: number, q?: number, filter?: BiquadFilterType, delay?: number, attack?: number }} options
   */
  _noiseHit({ dur, gain, freq = 900, q = 1, filter = 'bandpass', delay = 0, attack = 0.004 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, delay);
    const d = Math.max(0.02, Sfx._num(dur, 0.07));

    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    src.loop = false;

    const biquad = ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(Math.max(40, Sfx._num(freq, 900)), t0);
    biquad.Q.value = Math.max(0.0001, Sfx._num(q, 1));

    const env = ctx.createGain();
    this._env(env, t0, attack, d, gain);

    src.connect(biquad);
    biquad.connect(env);
    env.connect(this.master);
    // 起始偏移随机，避免每次听起来完全一致
    src.start(t0, Math.random() * 0.5, d + 0.02);
    src.stop(t0 + d + 0.02);
    src.onended = () => {
      try {
        src.disconnect();
        biquad.disconnect();
        env.disconnect();
      } catch {
        /* 忽略 */
      }
    };
    return src;
  }

  // ------------------------------------------------------------------ 公开音效

  /**
   * 泥咕咕鸣叫：陶土鸟哨的"啾啾"两声，正弦+三角叠一点颤音，总时长 ~180ms。
   * 基频 900→1500Hz 上扬，音量峰值 ≤0.18。
   */
  chirp() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();

      // 第一声：900 → 1180Hz（~78ms）
      this._tone({ freq0: 900, freq1: 1180, dur: 0.078, type: 'sine', gain: 0.16, attack: 0.005 });
      this._tone({ freq0: 1800, freq1: 2360, dur: 0.078, type: 'triangle', gain: 0.045, attack: 0.005 });

      // 第二声：1120 → 1500Hz（~96ms，稍后起，音更高）
      this._tone({ freq0: 1120, freq1: 1500, dur: 0.096, type: 'sine', gain: 0.17, attack: 0.005, delay: 0.084 });
      this._tone({ freq0: 2240, freq1: 3000, dur: 0.096, type: 'triangle', gain: 0.04, attack: 0.005, delay: 0.084 });

      // 极轻的颤音（Vibrato）：一个 42Hz 的 LFO 轻微推 detune，陶哨的"抖"
      try {
        const ctx = this.ctx;
        const t0 = ctx.currentTime;
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(42, t0);
        lfoGain.gain.setValueAtTime(9, t0); // ±9 cents，很轻
        lfo.connect(lfoGain);
        // 只调制第二声的主振荡器，避免整体发飘
        const target = this._tone({ freq0: 1120, freq1: 1500, dur: 0.096, type: 'sine', gain: 0.0001, attack: 0.005, delay: 0.084 });
        if (target && target.detune) lfoGain.connect(target.detune);
        lfo.start(t0);
        lfo.stop(t0 + 0.2);
        lfo.onended = () => {
          try {
            lfo.disconnect();
            lfoGain.disconnect();
          } catch {
            /* 忽略 */
          }
        };
      } catch {
        /* 颤音是锦上添花，失败就算了 */
      }
    } catch (error) {
      console.warn('[Sfx] chirp 异常：', error);
    }
  }

  /**
   * 脚步声：低频撞击 + 短噪声，时长 60~90ms；内部节流 ≥120ms。
   * @param {'walk'|'run'} [gait]
   */
  step(gait) {
    try {
      if (!this._ready()) return;
      // 节流：放在最前面，静音期间也推进时间戳没有意义，所以先判断 ready
      const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      if (now - this._lastStepAt < STEP_THROTTLE * 1000) return;
      this._lastStepAt = now;
      this._ensureRunning();

      const key = gait === 'run' ? 'run' : 'walk';
      const gain = STEP_GAIN[key];
      const dur = STEP_DUR[key];
      const freq = STEP_FREQ[key];

      // 低频"咚"：短促下滑
      this._tone({ freq0: freq, freq1: freq * 0.55, dur: dur * 0.85, type: 'sine', gain, attack: 0.003 });
      // 鞋底摩擦的噪声层：run 更亮更响
      this._noiseHit({
        dur: dur * 0.7,
        gain: key === 'run' ? gain * 0.75 : gain * 0.5,
        freq: key === 'run' ? 1650 : 1150,
        q: 0.9,
        filter: 'bandpass',
        attack: 0.002
      });
    } catch (error) {
      console.warn('[Sfx] step 异常：', error);
    }
  }

  /** 跳跃：400→900Hz 上滑音 160ms，带一点气声 */
  jump() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();
      this._tone({ freq0: 400, freq1: 900, dur: 0.16, type: 'triangle', gain: 0.12, attack: 0.008 });
      this._tone({ freq0: 800, freq1: 1800, dur: 0.13, type: 'sine', gain: 0.04, attack: 0.006, delay: 0.01 });
      this._noiseHit({ dur: 0.1, gain: 0.03, freq: 2600, q: 0.8, filter: 'highpass', attack: 0.004 });
    } catch (error) {
      console.warn('[Sfx] jump 异常：', error);
    }
  }

  /** 落地：180→90Hz 闷响 120ms + 噪声，再补一个短尾音 */
  land() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();
      this._tone({ freq0: 180, freq1: 90, dur: 0.12, type: 'sine', gain: 0.16, attack: 0.003 });
      this._noiseHit({ dur: 0.1, gain: 0.07, freq: 420, q: 0.7, filter: 'lowpass', attack: 0.002 });
      // 短尾音：轻微的"嗒"
      this._tone({ freq0: 300, freq1: 150, dur: 0.05, type: 'triangle', gain: 0.045, attack: 0.002, delay: 0.1 });
    } catch (error) {
      console.warn('[Sfx] land 异常：', error);
    }
  }

  /** 欢呼：C5-E5-G5 三音上行琶音，每音 120ms，三角波 */
  cheer() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();
      const noteDur = 0.12;
      CHEER_NOTES.forEach((freq, index) => {
        const delay = index * noteDur;
        this._tone({ freq0: freq, dur: noteDur + 0.06, type: 'triangle', gain: 0.11, attack: 0.008, delay });
        // 加一层八度正弦让音色更"陶土"更亮
        this._tone({ freq0: freq * 2, dur: noteDur * 0.8, type: 'sine', gain: 0.028, attack: 0.006, delay });
      });
      // 收尾高八度点缀
      this._tone({ freq0: CHEER_NOTES[2] * 2, dur: 0.14, type: 'triangle', gain: 0.07, attack: 0.006, delay: noteDur * 3 });
    } catch (error) {
      console.warn('[Sfx] cheer 异常：', error);
    }
  }

  /** 模型落位："叮"，1200Hz 正弦 + 慢衰减 400ms（再叠一个 1800Hz 泛音） */
  place() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();
      this._tone({ freq0: 1200, dur: 0.4, type: 'sine', gain: 0.13, attack: 0.004 });
      this._tone({ freq0: 1800, dur: 0.26, type: 'sine', gain: 0.05, attack: 0.003 });
      this._tone({ freq0: 2400, dur: 0.16, type: 'sine', gain: 0.025, attack: 0.002 });
    } catch (error) {
      console.warn('[Sfx] place 异常：', error);
    }
  }

  /** 出错：440→330 下行两音，方波，音量 0.08 */
  error() {
    try {
      if (!this._ready()) return;
      this._ensureRunning();
      this._tone({ freq0: 440, dur: 0.11, type: 'square', gain: 0.08, attack: 0.004 });
      this._tone({ freq0: 330, dur: 0.16, type: 'square', gain: 0.08, attack: 0.004, delay: 0.11 });
    } catch (error) {
      console.warn('[Sfx] error 异常：', error);
    }
  }

  /** 释放 AudioContext（页面卸载时可选调用；可重复调用） */
  dispose() {
    try {
      if (this.ctx && this.ctx.state !== 'closed') {
        const p = this.ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (error) {
      console.warn('[Sfx] dispose 异常：', error);
    }
    this.ctx = null;
    this.master = null;
    this._noiseBuffer = null;
    this._unlocked = false;
    this._unlocking = false;
    this._lastStepAt = -Infinity;
  }
}

export { Sfx };
export default Sfx;
