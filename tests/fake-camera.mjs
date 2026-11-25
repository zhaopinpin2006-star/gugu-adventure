/**
 * tests/fake-camera.mjs —— 假摄像头工具（供 ar-live / shots-ar 复用）。
 *
 * 为什么需要「倾斜」：
 *   这段游戏把海报当作**地面**（角色双脚站在海报表面、垂直于海报立起来）。
 *   如果假摄像头正对海报拍摄，角色就是"朝着镜头立"，屏幕上只剩一颗黑色头顶，
 *   既不像真机，也看不出轴向对不对。真机用法是「海报平铺在桌面上，手机从斜上方俯看」，
 *   所以这里把海报按**透视梯形**绘制进视频流，MindAR 估出的位姿才会带俯角，
 *   角色才会在画面里正常立着。见 docs/CONTRACT.md §1.2。
 */

/**
 * 生成注入页面的 init script 源码。
 * @param {{tilted?: boolean}} [opts] tilted=false 时退回"正对海报"（用于几何对照）
 */
export function fakeCameraScript(opts = {}) {
  return `(${fakeCamera.toString()})(${JSON.stringify({ tilted: opts.tilted !== false })})`;
}

function fakeCamera(opts) {
  const tilted = !!(opts && opts.tilted);

  // tfjs 用 failIfMajorPerformanceCaveat:true 取 WebGL 上下文；无头 SwiftShader 会被拒，
  // 导致 Controller 构造直接抛错。真机有 GPU 不受影响，这里只在测试里关掉该判据。
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patched(type, attrs) {
    if (attrs && attrs.failIfMajorPerformanceCaveat) {
      attrs = Object.assign({}, attrs, { failIfMajorPerformanceCaveat: false });
    }
    return origGetContext.call(this, type, attrs);
  };

  // 竖屏视频（手机上后置摄像头常见方向）
  const W = 720;
  const H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const state = { showPoster: true, t: 0, ready: false, quad: null };
  window.__FAKE_CAM__ = state;

  const img = new Image();
  img.src = 'targets/nigugu.jpg';

  /** 把海报按透视梯形预渲染成一张离屏画布（只算一次，之后每帧只做 drawImage） */
  function warpPoster() {
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;

    // 目标梯形。tilted 时用**真正的针孔相机**把"平铺在桌面上、尺寸 1×1.25 的海报"
    // 投影到画面里（fovy 60°、机位在斜上方俯看），这样 MindAR 估出来的位姿与画面对齐、
    // 不会像手写梯形那样每帧抖动或估出极端掠射角 —— 手写四角只保证"看上去像梯形"，
    // 并不对应任何真实相机，估出的位姿与画面因此自相矛盾。
    const quad = tilted ? projectPosterQuad(W * 0.86, H * 0.58) : centerRectQuad(sw / sh);
    state.quad = quad;

    const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[0]))));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(...quad.map((p) => p[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[1]))));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(...quad.map((p) => p[1]))));
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;

    // 源图（单位正方形 → 像素）
    const src = document.createElement('canvas');
    src.width = sw;
    src.height = sh;
    const sctx = src.getContext('2d');
    sctx.drawImage(img, 0, 0);
    const sdata = sctx.getImageData(0, 0, sw, sh).data;

    // 单位正方形 → quad 的单应矩阵 H，再求逆做反向映射（每个目标像素一次采样）
    // H = [[a,b,c],[d,e,f],[g,h,1]]，把 (u,v,1) 投到 (x/w, y/w)
    const [p0, p1, p2, p3] = quad; // 左上、右上、右下、左下
    const x0 = p0[0], y0 = p0[1];
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1];
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / den;
    const h = (dx1 * dy3 - dx3 * dy1) / den;
    // H: unit -> quad
    const Hm = [
      x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
      y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
      g, h, 1
    ];
    const Hi = invert3(Hm);

    const out = document.createElement('canvas');
    out.width = bw;
    out.height = bh;
    const octx = out.getContext('2d');
    const odata = octx.createImageData(bw, bh);

    for (let y = 0; y < bh; y++) {
      const Y = y + minY;
      for (let x = 0; x < bw; x++) {
        const X = x + minX;
        const uu = Hi[0] * X + Hi[1] * Y + Hi[2];
        const vv = Hi[3] * X + Hi[4] * Y + Hi[5];
        const ww = Hi[6] * X + Hi[7] * Y + Hi[8];
        const o = (y * bw + x) * 4;
        if (Math.abs(ww) < 1e-9) continue;
        const u = uu / ww;
        const v = vv / ww;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const sx = Math.min(sw - 1, Math.max(0, Math.round(u * (sw - 1))));
        const sy = Math.min(sh - 1, Math.max(0, Math.round(v * (sh - 1))));
        const so = (sy * sw + sx) * 4;
        odata.data[o] = sdata[so];
        odata.data[o + 1] = sdata[so + 1];
        odata.data[o + 2] = sdata[so + 2];
        odata.data[o + 3] = 255;
      }
    }
    octx.putImageData(odata, 0, 0);
    return { canvas: out, offset: [minX, minY] };
  }

  function invert3(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[3], e = m[4], f = m[5];
    const g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const invDet = 1 / det;
    return [
      A * invDet, -(b * i - c * h) * invDet, (b * f - c * e) * invDet,
      B * invDet, (a * i - c * g) * invDet, -(a * f - c * d) * invDet,
      C * invDet, -(a * h - b * g) * invDet, (a * e - b * d) * invDet
    ];
  }

  /**
   * 用真正的针孔相机，把「平铺在桌面上」的海报投影成屏幕四角。
   *
   * 世界坐标：海报中心在原点，平面 y=0，宽 1、长 1.25（与 CONTRACT 的 P 系一致：
   * x∈[-0.5,0.5] 横向、z∈[-0.625,0.625] 纵深）。
   * 相机在 +z 一侧斜上方俯看（z 越大越靠近观众，对应海报下沿）。
   *
   * 返回顺序必须是「左上、右上、右下、左下」——即源图的四角顺序。
   */
  function projectPosterQuad(fitW, fitH) {
    // 相机机位（海报单位，与 CONTRACT 的 P 系一致：海报 x∈[-0.5,0.5]、z∈[-0.625,0.625]，y=0 为纸面）。
    // 抬高 1.6、后退 1.1，俯角约 55° —— 与"海报平放桌面、手机斜上方俯看"的真实用法接近。
    const eye0 = [0, 1.6, 1.1];
    const target = [0, 0, -0.05];
    const fwd = norm(sub(target, eye0));          // 视线方向（世界）
    const right = norm(cross(fwd, [0, 1, 0]));    // 屏幕右矢 = fwd × up_world
    const up = cross(right, fwd);                 // 屏幕上矢

    // fovy 取 45°：与 MindAR Controller 内部 getProjectionMatrix() 的假定一致
    // （fovy=45°、f=(inputHeight/2)/tan(fovy/2)）。两边一致时，估出的位姿才与画面自洽。
    const fovy = (45 * Math.PI) / 180;
    const fy = 1 / Math.tan(fovy / 2);
    const fx = fy / (W / H);

    // 针孔投影：depth = 沿视线的正向距离（点在前方时 > 0）
    const toPx = (pw, e) => {
      const v = sub(pw, e);
      const depth = dot(v, fwd);
      if (depth <= 1e-6) return null;
      const cx = dot(v, right);
      const cy = dot(v, up);
      return [
        W / 2 + ((fx * cx) / depth) * (W / 2),
        H / 2 - ((fy * cy) / depth) * (H / 2)
      ];
    };

    // 四角顺序必须是「左上、右上、右下、左下」——即源图的四角顺序
    const WORLD_CORNERS = [
      [-0.5, 0, -0.625], [0.5, 0, -0.625], [0.5, 0, 0.625], [-0.5, 0, 0.625]
    ];

    const dirFromTarget = norm(sub(eye0, target));
    const dist0 = Math.hypot(eye0[0] - target[0], eye0[1] - target[1], eye0[2] - target[2]);

    const bbox = (qq) => {
      const xs = qq.map((p) => p[0]);
      const ys = qq.map((p) => p[1]);
      return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };

    let dist = dist0;
    let q = null;
    // 沿"目标→眼睛"方向调整距离，直到海报的屏幕包围盒装进 fitW×fitH 框内。
    // 屏幕尺寸 ∝ 1/距离，所以直接用比例迭代即可收敛。
    for (let iter = 0; iter < 12; iter++) {
      const e = [
        target[0] + dirFromTarget[0] * dist,
        target[1] + dirFromTarget[1] * dist,
        target[2] + dirFromTarget[2] * dist
      ];
      const nq = WORLD_CORNERS.map((c) => toPx(c, e));
      if (!nq.every(Boolean)) return centerRectQuad(1);
      q = nq;
      const b = bbox(q);
      const ratio = Math.max(b.w / fitW, b.h / fitH);
      if (Math.abs(ratio - 1) < 0.01) break;
      dist *= ratio;
    }
    return q;
  }

  function centerRectQuad(aspect) {
    const h = H * 0.62;
    const w = h * aspect;
    return [
      [(W - w) / 2, (H - h) / 2],
      [(W + w) / 2, (H - h) / 2],
      [(W + w) / 2, (H + h) / 2],
      [(W - w) / 2, (H + h) / 2]
    ];
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  let warped = null;
  const onReady = () => {
    warped = warpPoster();
    state.ready = true;
  };
  if (img.complete && img.naturalWidth) {
    onReady();
  } else {
    img.onload = onReady;
  }

  function draw() {
    ctx.fillStyle = '#efe9df';
    ctx.fillRect(0, 0, W, H);
    if (state.showPoster && warped) {
      // 轻微手持晃动，模拟真人举着手机
      const dx = Math.sin(state.t * 0.9) * 5;
      const dy = Math.cos(state.t * 0.7) * 4;
      ctx.drawImage(warped.canvas, warped.offset[0] + dx, warped.offset[1] + dy);
    }
    state.t += 1 / 30;
  }

  draw();
  setInterval(draw, 1000 / 30);

  const stream = canvas.captureStream(30);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) return stream;
    throw new Error('fake camera: unsupported constraints');
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'fake', label: 'fake rear camera' }
  ];
}
