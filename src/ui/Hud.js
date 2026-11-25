/**
 * HUD（抬头显示层）
 * ------------------------------------------------------------------
 * 契约：docs/CONTRACT.md §2.6 / §4
 *
 *   export class Hud {
 *     constructor({ onStart, onJump, onRecenter, onToggleSound })
 *     setStatus(kind, text)
 *     showOverlay({ title, desc, actionText, kind })
 *     hideOverlay()
 *     setProgress(ratio)
 *     toast(text, ms = 2200)
 *     setSoundOn(bool)
 *     setControlsEnabled({ jump, recenter })
 *     update(dt, { force, gait })
 *     destroy()
 *   }
 *
 * 设计约束：
 *   · HTML 由别人写（§4 的 id 清单），本类**只读节点、只改文本/class/属性**，
 *     不重建、不插入结构；任何节点缺失都静默跳过，绝不 throw。
 *   · 所有按钮 touchstart + click 双绑定并 preventDefault；触摸后 600ms 内的
 *     click 是浏览器补发的事件，用时间戳去重，保证"一次触摸只触发一次"。
 *   · 用事件委托（绑在 #hud 上）+ 直接绑定双保险？不：统一走直接绑定，
 *     逐个元素在 destroy() 里精确解绑，避免重复监听泄漏。
 */

const TOUCH_DEDUPE_MS = 600;

/**
 * 安全取节点：容器缺失或选择器非法时返回 null，绝不 throw。
 * @param {Document|Element|null} root
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function el(root, id) {
  if (!root || typeof root.getElementById !== 'function') return null;
  try {
    return root.getElementById(id);
  } catch (err) {
    return null;
  }
}

function setText(node, text) {
  if (!node) return;
  const s = text == null ? '' : String(text);
  if (node.textContent !== s) node.textContent = s;
}

function toggleClass(node, name, on) {
  if (!node || !node.classList) return;
  if (on) node.classList.add(name);
  else node.classList.remove(name);
}

/** 首屏标志：Blender 渲染的透明底 PNG（public/logo-mark.png，277×320） */
const LOGO_MARK_FILE = 'logo-mark.png';

/**
 * 取标志图片的绝对地址。
 * 用 document.baseURI 而不是写死 '/'，部署到 GitHub Pages 子路径时也能正确解析
 * （与 MockAR 里取 targets/nigugu.jpg 的方式一致）。
 */
function logoMarkUrl() {
  if (typeof document === 'undefined' || !document.baseURI) return LOGO_MARK_FILE;
  return new URL(LOGO_MARK_FILE, document.baseURI).href;
}

/** 图标标记，按 kind 取不同图形 */
function overlayIconMarkup(kind) {
  const k = kind || 'info';
  if (k === 'error') {
    return (
      '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<circle cx="32" cy="32" r="26" fill="none" stroke="#D8382F" stroke-width="4"/>' +
      '<path d="M22 22 L42 42 M42 22 L22 42" stroke="#D8382F" stroke-width="5" stroke-linecap="round"/>' +
      '</svg>'
    );
  }
  if (k === 'warn') {
    return (
      '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<path d="M32 8 L60 54 H4 Z" fill="none" stroke="#F2C230" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M32 24 V40" stroke="#F2C230" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="32" cy="47" r="3.4" fill="#F2C230"/>' +
      '</svg>'
    );
  }
  if (k === 'scan') {
    return (
      '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true" focusable="false">' +
      '<rect x="8" y="8" width="48" height="48" rx="8" fill="none" stroke="#F2C230" stroke-width="3" stroke-dasharray="8 6"/>' +
      '<circle cx="32" cy="32" r="12" fill="none" stroke="#F5EBDC" stroke-width="3"/>' +
      '<circle cx="32" cy="32" r="3.6" fill="#D8382F"/>' +
      '</svg>'
    );
  }
  // 默认 / track / start：泥咕咕标志（Blender 渲染的透明底位图，alpha 通道已抠净，
  // 卡片米白底上直接透出卡片背景，不再有白底方块）
  return (
    '<img src="' +
    logoMarkUrl() +
    '" alt="" aria-hidden="true" focusable="false" decoding="async" draggable="false" />'
  );
}

export class Hud {
  /**
   * @param {{ onStart?: Function, onJump?: Function, onRecenter?: Function, onToggleSound?: Function }} [callbacks]
   */
  constructor(callbacks) {
    const cb = callbacks || {};
    this.onStart = typeof cb.onStart === 'function' ? cb.onStart : null;
    this.onJump = typeof cb.onJump === 'function' ? cb.onJump : null;
    this.onRecenter = typeof cb.onRecenter === 'function' ? cb.onRecenter : null;
    this.onToggleSound = typeof cb.onToggleSound === 'function' ? cb.onToggleSound : null;

    const doc = typeof document !== 'undefined' ? document : null;
    this._doc = doc;

    // ---- 节点（§4 清单；全部可能为 null，后续每个方法都做判空） ----
    this.hud = el(doc, 'hud');
    this.statusPill = el(doc, 'status-pill');
    this.statusDot = el(doc, 'status-dot');
    this.statusText = el(doc, 'status-text');
    this.hintBar = el(doc, 'hint-bar');
    this.joystickZone = el(doc, 'joystick-zone');
    this.btnJump = el(doc, 'btn-jump');
    this.btnRecenter = el(doc, 'btn-recenter');
    this.btnSound = el(doc, 'btn-sound');
    this.overlay = el(doc, 'overlay');
    this.overlayCard = el(doc, 'overlay-card');
    this.overlayTitle = el(doc, 'overlay-title');
    this.overlayDesc = el(doc, 'overlay-desc');
    this.overlayIcon = el(doc, 'overlay-icon');
    this.btnStart = el(doc, 'btn-start');
    this.progress = el(doc, 'progress');
    this.progressBar = el(doc, 'progress-bar');
    this.progressText = el(doc, 'progress-text');
    this.flashEl = el(doc, 'flash');

    // ---- 内部状态 ----
    this._toastTimer = 0;
    this._flashTimer = 0;
    this._lastTouch = 0;
    this._bound = []; // [{ el, type, handler, opts }] —— destroy() 用
    this._soundOn = true;
    this._statusKind = '';
    this._overlayVisible = false;

    // 初始状态：状态药丸默认"扫描中"，overlay 由外部 showOverlay 打开
    this.setStatus('scan', '正在扫描海报');
    this.setProgress(null);
    this._applySoundClass();
    this._bindButtons();
  }

  /* ---------------------------------------------------------------- *
   * 事件绑定
   * ---------------------------------------------------------------- */

  /**
   * 双绑定 touchstart + click，并做 600ms 去重：
   * 手指抬起后浏览器补发的 click 不应再触发一次。
   */
  _bindTap(node, handler) {
    if (!node || typeof node.addEventListener !== 'function' || typeof handler !== 'function') return;

    const run = (ev) => {
      // 触碰时先记录时间戳，click 阶段据此判断是否为补发事件
      const isTouch = !!ev && (ev.type === 'touchstart' || ev.type === 'pointerdown');
      if (isTouch) {
        this._lastTouch = Date.now();
      } else if (Date.now() - this._lastTouch < TOUCH_DEDUPE_MS) {
        return; // 触摸后的合成 click：忽略，避免双触发
      }
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      // 禁用态直接吞掉（CSS 的 pointer-events 不足以覆盖所有分支）
      if (node.disabled === true || node.getAttribute && node.getAttribute('aria-disabled') === 'true') return;
      try {
        handler(ev);
      } catch (err) {
        // 回调里的异常不能把 HUD 打挂
        if (typeof console !== 'undefined' && console.error) console.error('[Hud] handler error', err);
      }
    };

    const touchOpts = { passive: false };
    const clickOpts = false;
    node.addEventListener('touchstart', run, touchOpts);
    node.addEventListener('click', run, clickOpts);
    this._bound.push({ el: node, type: 'touchstart', handler: run, opts: touchOpts });
    this._bound.push({ el: node, type: 'click', handler: run, opts: clickOpts });
  }

  _bindButtons() {
    this._bindTap(this.btnStart, () => {
      if (this.onStart) this.onStart();
    });
    this._bindTap(this.btnJump, () => {
      if (this.onJump) this.onJump();
    });
    this._bindTap(this.btnRecenter, () => {
      if (this.onRecenter) this.onRecenter();
    });
    this._bindTap(this.btnSound, () => {
      if (this.onToggleSound) this.onToggleSound();
    });
  }

  /* ---------------------------------------------------------------- *
   * 状态药丸
   * ---------------------------------------------------------------- */

  /**
   * @param {'scan'|'track'|'lost'|'error'|'warn'} kind
   * @param {string} [text]
   */
  setStatus(kind, text) {
    const k = kind || 'scan';
    const prev = this._statusKind;
    this._statusKind = k;

    if (this.statusPill) {
      if (this.statusPill.dataset) this.statusPill.dataset.kind = k;
      this.statusPill.setAttribute('data-kind', k);
      // 重新触发脉冲动画：先摘掉 class，强制回流后再加
      if (prev !== k && this.statusPill.classList) {
        this.statusPill.classList.remove('is-changed');
        void this.statusPill.offsetWidth;
        this.statusPill.classList.add('is-changed');
      }
    }

    if (this.statusDot) {
      // 点样式走 data-kind 与 class 双通道，CSS 任一路径都能命中
      if (this.statusDot.dataset) this.statusDot.dataset.kind = k;
      this.statusDot.setAttribute('data-kind', k);
      if (this.statusDot.classList) {
        const kinds = ['scan', 'track', 'lost', 'error', 'warn'];
        for (let i = 0; i < kinds.length; i += 1) this.statusDot.classList.remove('is-' + kinds[i]);
        this.statusDot.classList.add('is-' + k);
      }
    }

    if (text != null) setText(this.statusText, text);
  }

  /* ---------------------------------------------------------------- *
   * 遮罩层
   * ---------------------------------------------------------------- */

  /**
   * @param {{ title?: string, desc?: string, actionText?: string, kind?: string }} [opts]
   */
  showOverlay(opts) {
    const o = opts || {};
    if (this.overlayTitle && o.title != null) setText(this.overlayTitle, o.title);
    if (this.overlayDesc && o.desc != null) setText(this.overlayDesc, o.desc);
    if (this.btnStart && o.actionText != null) setText(this.btnStart, o.actionText);

    const kind = o.kind || 'info';
    if (this.overlay) {
      if (this.overlay.dataset) this.overlay.dataset.kind = kind;
      this.overlay.setAttribute('data-kind', kind);
      if (this.overlay.hasAttribute && this.overlay.hasAttribute('hidden')) {
        this.overlay.removeAttribute('hidden');
      }
      this.overlay.hidden = false;
      if (this.overlay.classList) {
        this.overlay.classList.remove('is-leaving');
        this.overlay.classList.add('is-open');
      }
    }

    if (this.overlayIcon) {
      const markup = overlayIconMarkup(kind);
      if (this.overlayIcon.innerHTML !== markup) this.overlayIcon.innerHTML = markup;
      if (this.overlayIcon.classList) this.overlayIcon.classList.add('is-show');
    }

    // 打开遮罩时把进度条收起来（重开时由外部 setProgress 重新驱动）
    this.setProgress(null);
    this._overlayVisible = true;
  }

  hideOverlay() {
    if (this.overlay) {
      if (this.overlay.classList) this.overlay.classList.remove('is-open');
      this.overlay.hidden = true;
      if (this.overlay.setAttribute) this.overlay.setAttribute('hidden', '');
    }
    this._overlayVisible = false;
  }

  /* ---------------------------------------------------------------- *
   * 进度条
   * ---------------------------------------------------------------- */

  /**
   * @param {number|null} ratio 0..1；传 null / 非数字则隐藏
   */
  setProgress(ratio) {
    const has = ratio != null && Number.isFinite(Number(ratio));
    if (!has) {
      toggleClass(this.progress, 'is-hidden', true);
      if (this.progress && this.progress.dataset) this.progress.dataset.value = '';
      if (this.progressBar) this.progressBar.style.width = '0%';
      if (this.progressText) setText(this.progressText, '');
      return;
    }
    const r = Math.min(1, Math.max(0, Number(ratio)));
    toggleClass(this.progress, 'is-hidden', false);
    if (this.progressBar) this.progressBar.style.width = (r * 100).toFixed(1) + '%';
    if (this.progress && this.progress.dataset) this.progress.dataset.value = String(Math.round(r * 100));
    if (this.progressText) setText(this.progressText, Math.round(r * 100) + '%');
  }

  /* ---------------------------------------------------------------- *
   * 提示条
   * ---------------------------------------------------------------- */

  /**
   * @param {string} text
   * @param {number} [ms]
   */
  toast(text, ms = 2200) {
    if (!this.hintBar) return;
    setText(this.hintBar, text);

    // 取消上一个 timer，避免旧 timer 提前把新提示收掉
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = 0;
    }

    // 重新触发过渡：先摘 class 再强刷，保证连续 toast 也有动画
    if (this.hintBar.classList) {
      this.hintBar.classList.remove('is-show');
      void this.hintBar.offsetWidth;
      this.hintBar.classList.add('is-show');
    }

    const dur = Number.isFinite(Number(ms)) ? Math.max(300, Number(ms)) : 2200;
    this._toastTimer = setTimeout(() => {
      this._toastTimer = 0;
      if (this.hintBar && this.hintBar.classList) this.hintBar.classList.remove('is-show');
    }, dur);
  }

  /* ---------------------------------------------------------------- *
   * 声音 / 按钮可用性
   * ---------------------------------------------------------------- */

  _applySoundClass() {
    if (!this.btnSound) return;
    toggleClass(this.btnSound, 'is-off', !this._soundOn);
    toggleClass(this.btnSound, 'is-on', this._soundOn);
    this.btnSound.setAttribute('aria-pressed', this._soundOn ? 'true' : 'false');
    if (this.btnSound.dataset) this.btnSound.dataset.on = this._soundOn ? 'true' : 'false';
  }

  /** @param {boolean} on */
  setSoundOn(on) {
    this._soundOn = on !== false;
    this._applySoundClass();
  }

  /** 当前声音状态（供外部同步图标） */
  isSoundOn() {
    return this._soundOn;
  }

  /**
   * @param {{ jump?: boolean, recenter?: boolean }} [state]
   */
  setControlsEnabled(state) {
    const s = state || {};
    if (this.btnJump) {
      const on = s.jump !== false;
      this.btnJump.disabled = !on;
      this.btnJump.setAttribute('aria-disabled', on ? 'false' : 'true');
      toggleClass(this.btnJump, 'is-disabled', !on);
    }
    if (this.btnRecenter) {
      const on = s.recenter !== false;
      this.btnRecenter.disabled = !on;
      this.btnRecenter.setAttribute('aria-disabled', on ? 'false' : 'true');
      toggleClass(this.btnRecenter, 'is-disabled', !on);
    }
  }

  /* ---------------------------------------------------------------- *
   * 每帧
   * ---------------------------------------------------------------- */

  /**
   * 可选视觉反馈：摇杆外圈亮度随推力变化（写 CSS 自定义属性 --force）。
   * @param {number} dt
   * @param {{ force?: number, gait?: string }} [ctx]
   */
  update(dt, ctx) {
    const c = ctx || {};
    const forceRaw = Number(c.force);
    const force = Number.isFinite(forceRaw) ? Math.min(1, Math.max(0, forceRaw)) : 0;
    const gait = c.gait === 'run' ? 'run' : c.gait === 'walk' ? 'walk' : 'idle';

    if (this.joystickZone && this.joystickZone.style) {
      // 保留两位小数，避免每帧写不同字符串造成无谓的样式重算
      const v = force.toFixed(2);
      if (this.joystickZone.dataset && this.joystickZone.dataset.force !== v) {
        this.joystickZone.dataset.force = v;
        this.joystickZone.style.setProperty('--force', v);
      }
    }

    if (this.hud && this.hud.dataset && this.hud.dataset.gait !== gait) {
      this.hud.dataset.gait = gait;
    }
  }

  /* ---------------------------------------------------------------- *
   * 其它
   * ---------------------------------------------------------------- */

  /** 屏幕闪白（落地/欢呼反馈），不存在 #flash 时静默跳过 */
  flash(ms = 220) {
    if (!this.flashEl || !this.flashEl.classList) return;
    if (this._flashTimer) {
      clearTimeout(this._flashTimer);
      this._flashTimer = 0;
    }
    this.flashEl.classList.remove('is-flash');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('is-flash');
    const dur = Number.isFinite(Number(ms)) ? Math.max(60, Number(ms)) : 220;
    this._flashTimer = setTimeout(() => {
      this._flashTimer = 0;
      if (this.flashEl && this.flashEl.classList) this.flashEl.classList.remove('is-flash');
    }, dur);
  }

  destroy() {
    // 解绑全部事件
    for (let i = 0; i < this._bound.length; i += 1) {
      const b = this._bound[i];
      if (b.el && typeof b.el.removeEventListener === 'function') {
        try {
          b.el.removeEventListener(b.type, b.handler, b.opts);
        } catch (err) {
          /* 忽略 */
        }
      }
    }
    this._bound.length = 0;

    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = 0;
    }
    if (this._flashTimer) {
      clearTimeout(this._flashTimer);
      this._flashTimer = 0;
    }
    this.onStart = null;
    this.onJump = null;
    this.onRecenter = null;
    this.onToggleSound = null;
  }
}

export default Hud;
