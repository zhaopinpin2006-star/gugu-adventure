/**
 * MindARLite —— 直接复用 MindAR 1.2.5 官方 Controller（图像识别/跟踪），
 * 自己只实现 three.js 的适配层（不引入 MindAR 自带的 UI 遮罩）。
 *
 * 依赖：public/vendor/mindar-1.2.5/ 下的官方打包产物（运行时动态 import）。
 * 坐标系见 docs/CONTRACT.md §1：
 *   anchor.group（M 坐标系）：原点=海报中心，1 单位=海报宽度，
 *     +X=海报向右，+Y=海报向上，+Z=海报法线(朝向观察者)。
 *   posterSpace（P 坐标系）：rotation.x = +PI/2 后
 *     P.x = M.x(海报向右), P.y = M.z(海报法线=向上), P.z = -M.y(海报下方)，
 *     于是 P 就是标准 three 地面坐标系，地面 y=0 就是海报表面。
 *
 * 推导（R_x(+π/2) = [[1,0,0],[0,0,-1],[0,1,0]]）：
 *   M = R · P  ⇒  M.x = P.x, M.y = -P.z, M.z = P.y
 *   ⇒ P.y = M.z（海报法线，朝观察者 = 世界"上"）
 *     P.z = -M.y（海报向下）
 *   海报表面 M.z = 0 ⇒ P.y = 0，正好是地面。
 */

import * as THREE from 'three';

export const MINDAR_VENDOR_PATH = 'vendor/mindar-1.2.5/mindar-image.prod.js';

/** 海报 H/W 的兜底值（真实值从 .mind 里读，读到后覆盖） */
export const FALLBACK_POSTER_ASPECT = 1000 / 800;

const DEG = Math.PI / 180;

export class MindARLite {
  constructor({
    container,
    imageTargetSrc = 'targets/nigugu.mind',
    onTargetFound = null,
    onTargetLost = null,
    onStatus = null,
    onFrame = null,
    missTolerance = 6,
    warmupTolerance = 3,
    filterMinCF = 0.001,
    filterBeta = 1000,
    maxTrack = 1,
    controllerUrl = null
  }) {
    this.container = container;
    this.imageTargetSrc = imageTargetSrc;
    this.onTargetFound = onTargetFound;
    this.onTargetLost = onTargetLost;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.missTolerance = missTolerance;
    this.warmupTolerance = warmupTolerance;
    this.filterMinCF = filterMinCF;
    this.filterBeta = filterBeta;
    this.maxTrack = maxTrack;
    this.controllerUrl = controllerUrl;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.renderer = null;
    this.video = null;
    this.controller = null;
    this.anchor = null;
    this.posterSpace = null;

    this._tracking = false;
    this._running = false;
    this._starting = false;
    this._postMatrix = new THREE.Matrix4();
    this._posterAspect = FALLBACK_POSTER_ASPECT;
    this._markerSize = null; // [w, h] 像素
    this._resizeRaf = 0;
    this._tmpMatrix = new THREE.Matrix4();

    // 复用临时向量，避免每帧 GC
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._v5 = new THREE.Vector3();

    this._onWindowResize = () => this.scheduleResize();
    this._onOrient = () => {
      // 屏幕旋转后 video 尺寸可能还没更新，多补几次
      this.scheduleResize();
      setTimeout(() => this.scheduleResize(), 120);
      setTimeout(() => this.scheduleResize(), 420);
    };
  }

  get isTracking() {
    return this._tracking;
  }

  /** 海报高/宽（竖版 >1） */
  get targetAspect() {
    return this._posterAspect;
  }

  /** 海报在 P 坐标系里的半宽/半高 */
  get posterHalf() {
    return { halfX: 0.5, halfZ: this._posterAspect / 2 };
  }

  _status(kind, text) {
    if (typeof this.onStatus === 'function') {
      try {
        this.onStatus(kind, text);
      } catch (e) {
        console.warn('[MindARLite] onStatus 抛错', e);
      }
    }
  }

  async start() {
    if (this._running || this._starting) return;
    this._starting = true;
    try {
      this._status('loading', '正在启动摄像头…');
      this._setupRenderer();
      await this._startVideo();
      this._status('loading', '正在加载图像目标…');
      await this._startAR();
      this._running = true;
      this._status('scan', '对准泥咕咕海报');
      window.addEventListener('resize', this._onWindowResize, { passive: true });
      window.addEventListener('orientationchange', this._onOrient, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this._onWindowResize, { passive: true });
      }
    } finally {
      this._starting = false;
    }
  }

  _setupRenderer() {
    if (this.renderer) return;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearAlpha(0);
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.left = '0px';
    renderer.domElement.style.top = '0px';
    renderer.domElement.style.zIndex = '2';
    renderer.domElement.style.display = 'block';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const ambient = new THREE.HemisphereLight(0xfff4e0, 0x2b2320, 1.55);
    ambient.position.set(0, 1, 0);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff1d0, 1.5);
    key.position.set(0.6, 1.4, 1.0);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fd8e6, 0.6);
    rim.position.set(-0.8, 0.6, -0.9);
    this.scene.add(rim);
  }

  _startVideo() {
    return new Promise((resolve, reject) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const err = new Error(
          '这个浏览器不支持摄像头访问（navigator.mediaDevices 不可用）。请用 HTTPS 打开，或改用 Safari / Chrome。'
        );
        err.code = 'NO_MEDIADEVICES';
        reject(err);
        return;
      }

      const video = document.createElement('video');
      video.setAttribute('autoplay', '');
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;
      video.playsInline = true;
      video.style.position = 'absolute';
      video.style.left = '0px';
      video.style.top = '0px';
      video.style.zIndex = '1';
      video.style.display = 'block';
      video.style.objectFit = 'cover';
      video.style.background = '#14100e';
      this.container.appendChild(video);
      this.video = video;

      const constraints = { audio: false, video: { facingMode: { ideal: 'environment' } } };
      if (navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints().width) {
        constraints.video.width = { ideal: 1280 };
        constraints.video.height = { ideal: 720 };
      }

      const done = () => resolve();
      const fail = (err) => {
        const wrapped = new Error(this._cameraErrorMessage(err));
        wrapped.code = (err && err.name) || 'CAMERA_ERROR';
        wrapped.cause = err;
        reject(wrapped);
      };

      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((stream) => {
          video.srcObject = stream;
          this._stream = stream;
          const onMeta = () => {
            video.removeEventListener('loadedmetadata', onMeta);
            video.setAttribute('width', String(video.videoWidth));
            video.setAttribute('height', String(video.videoHeight));
            // 某些安卓机型 metadata 时尺寸为 0，等一下再取
            if (!video.videoWidth || !video.videoHeight) {
              setTimeout(done, 150);
            } else {
              done();
            }
          };
          video.addEventListener('loadedmetadata', onMeta);
          if (video.readyState >= 1 && video.videoWidth) onMeta();
          const p = video.play();
          if (p && typeof p.catch === 'function') {
            p.catch(() => {
              /* 静音视频一般可自动播放；失败时 metadata 仍会到 */
            });
          }
          // 兜底：万一 metadata 事件没来
          setTimeout(() => {
            if (video.videoWidth) done();
          }, 2600);
        })
        .catch((err) => {
          // 环境机没有后置摄像头时退化：不要直接死掉，尝试任意摄像头
          if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError' || err.name === 'ConstraintsNotSatisfiableError')) {
            navigator.mediaDevices
              .getUserMedia({ audio: false, video: true })
              .then((stream) => {
                video.srcObject = stream;
                this._stream = stream;
                video.addEventListener('loadedmetadata', () => {
                  video.setAttribute('width', String(video.videoWidth));
                  video.setAttribute('height', String(video.videoHeight));
                  video.play().catch(() => {});
                  done();
                });
              })
              .catch(fail);
          } else {
            fail(err);
          }
        });
    });
  }

  _cameraErrorMessage(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return '摄像头权限被拒绝了。请在浏览器设置里允许本站使用摄像头，然后刷新页面。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有找到可用的摄像头。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '摄像头被其它应用占用了，关掉相机/视频应用后重试。';
    }
    if (name === 'SecurityError') {
      return '浏览器安全策略禁止了摄像头。请用 HTTPS（或 localhost）打开本页面。';
    }
    return '摄像头启动失败：' + (err && err.message ? err.message : String(err));
  }

  async _startAR() {
    const url = this.controllerUrl
      ? this.controllerUrl
      : new URL(MINDAR_VENDOR_PATH, document.baseURI).href;

    let Controller;
    try {
      const mod = await import(/* @vite-ignore */ url);
      Controller = mod.Controller || (window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Controller);
    } catch (e) {
      throw new Error('MindAR 引擎加载失败（' + url + '）：' + (e && e.message));
    }
    if (typeof Controller !== 'function') {
      throw new Error('MindAR 引擎里没有找到 Controller，vendor 文件可能损坏。');
    }

    const video = this.video;
    const inputWidth = video.videoWidth || 1280;
    const inputHeight = video.videoHeight || 720;

    this.controller = new Controller({
      inputWidth,
      inputHeight,
      maxTrack: this.maxTrack,
      warmupTolerance: this.warmupTolerance,
      missTolerance: this.missTolerance,
      filterMinCF: this.filterMinCF,
      filterBeta: this.filterBeta,
      onUpdate: (data) => this._onControllerUpdate(data)
    });

    // 锚点（矩阵由 MindAR 每帧写入，matrixAutoUpdate 必须关掉）
    const group = new THREE.Group();
    group.visible = false;
    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.anchor = group;

    // 海报地面坐标系（见文件头注释）
    const posterSpace = new THREE.Group();
    posterSpace.rotation.x = Math.PI / 2;
    group.add(posterSpace);
    this.posterSpace = posterSpace;

    // 相机投影（必须有 controller 才能算）
    this.resize();

    const targetSrc = this.imageTargetSrc;
    let result;
    try {
      result = await this.controller.addImageTargets(targetSrc);
    } catch (e) {
      throw new Error('图像目标加载失败（' + targetSrc + '）：' + (e && e.message));
    }

    const dims = (result && result.dimensions) || [];
    if (!dims.length || !dims[0][0] || !dims[0][1]) {
      throw new Error('图像目标文件里没有有效的目标尺寸（' + targetSrc + '）。');
    }
    const [mw, mh] = dims[0];
    this._markerSize = [mw, mh];
    this._posterAspect = mh / mw;

    // 与 MindAR 官方 three 适配层一致的 postMatrix：
    // 把"图像像素坐标（左上原点、y向下、像素单位）"换算成
    // "海报中心为原点、宽度归一化为 1、+Y 向上"的锚点局部坐标系。
    const position = new THREE.Vector3(mw / 2, mw / 2 + (mh - mw) / 2, 0);
    const scale = new THREE.Vector3(mw, mw, mw);
    this._postMatrix.compose(position, new THREE.Quaternion(), scale);

    // 预热 GPU kernel（首次推理很慢，必须先跑一次）
    try {
      await this.controller.dummyRun(video);
    } catch (e) {
      console.warn('[MindARLite] dummyRun 失败（可继续）', e);
    }

    this.resize();
    this.controller.processVideo(video);
  }

  _onControllerUpdate(data) {
    if (!this.controller || !this.anchor) return;

    if (data.type === 'updateMatrix') {
      const { targetIndex, worldMatrix } = data;
      if (targetIndex !== 0) return;

      const group = this.anchor;

      if (worldMatrix === null) {
        if (group.visible) {
          group.visible = false;
          this._tracking = false;
          if (typeof this.onTargetLost === 'function') this.onTargetLost();
        }
        return;
      }

      const m = this._tmpMatrix.fromArray(worldMatrix);
      m.multiply(this._postMatrix);
      group.matrix.copy(m);
      group.matrixWorldNeedsUpdate = true; // 关键：matrixAutoUpdate=false 时必须手动置位
      group.visible = true;

      if (!this._tracking) {
        this._tracking = true;
        // 首帧就同步一次世界矩阵与相机，避免 screenBasis 用到过期数据
        this.scene.updateMatrixWorld(true);
        this.camera.updateMatrixWorld(true);
        if (typeof this.onTargetFound === 'function') this.onTargetFound();
      }
    } else if (data.type === 'processDone') {
      if (typeof this.onFrame === 'function') this.onFrame();
    }
  }

  /**
   * 屏幕对齐基（P 坐标系内的单位向量）：
   *   right = 屏幕"右"在画面中的方向；up = 屏幕"上"（远离自己）的方向。
   * 识别丢失或退化时返回 null / 兜底值。
   */
  screenBasis() {
    const poster = this.posterSpace;
    if (!poster) return null;

    // 海报在 P 坐标系下的三个轴（转到世界）
    poster.updateWorldMatrix(true, false);
    const pw = poster.matrixWorld;
    const ax = this._v1.setFromMatrixColumn(pw, 0).normalize(); // P.x = 海报向右
    const ay = this._v2.setFromMatrixColumn(pw, 1).normalize(); // P.y = 海报法线/向上
    const az = this._v3.setFromMatrixColumn(pw, 2).normalize(); // P.z = 海报下方

    const cam = this.camera;
    cam.updateMatrixWorld();
    const camRight = this._v4.setFromMatrixColumn(cam.matrixWorld, 0);
    const camUp = this._v5.setFromMatrixColumn(cam.matrixWorld, 1);

    const rx = camRight.dot(ax);
    const rz = camRight.dot(az);
    const ux = camUp.dot(ax);
    const uz = camUp.dot(az);

    const rLen = Math.hypot(rx, rz);
    const uLen = Math.hypot(ux, uz);

    const DEGENERATE = 0.12;
    if (rLen < DEGENERATE || uLen < DEGENERATE) {
      // 视线近乎贴着海报平面：方向不可信，退化为海报自身坐标
      return { right: { x: 1, z: 0 }, up: { x: 0, z: -1 } };
    }

    // 施密特正交化：把两个正交向量分别投影到同一平面后，结果不一定仍正交
    // （a'·b' = -(a·n)(b·n)）。这里以 right 为基准，把 up 的法向分量再减一次，
    // 保证 basis 是平面内的规范正交基，斜推摇杆时方向不偏。
    let rightX = rx / rLen;
    let rightZ = rz / rLen;
    let upX = ux / uLen;
    let upZ = uz / uLen;

    const dot = rightX * upX + rightZ * upZ;
    upX -= dot * rightX;
    upZ -= dot * rightZ;
    const upLen2 = Math.hypot(upX, upZ);
    if (upLen2 < DEGENERATE) {
      return { right: { x: rightX, z: rightZ }, up: { x: -rightZ, z: rightX } };
    }
    upX /= upLen2;
    upZ /= upLen2;

    return {
      right: { x: rightX, z: rightZ },
      up: { x: upX, z: upZ }
    };
  }

  /** 开发用：立方体 + 三色坐标轴 + 海报边框，验证锚点与轴向（阶段一验收） */
  addAnchorDebug({ size = 0.22 } = {}) {
    if (!this.posterSpace) return null;
    const g = new THREE.Group();
    const halfZ = this._posterAspect / 2;

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color: 0x33ddff, metalness: 0.1, roughness: 0.55 })
    );
    box.position.set(0, size / 2 + 0.02, 0);
    g.add(box);

    const axis = (color, dir) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.004, 0),
        new THREE.Vector3(dir[0], 0.004, dir[1])
      ]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    };
    g.add(axis(0xff4d3d, [0.34, 0])); // +X 红
    g.add(axis(0xffd93d, [0, 0.34])); // +Z 黄
    g.add(axis(0x33ccff, [0, -0.34])); // -Z 青

    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.5, 0.002, -halfZ),
        new THREE.Vector3(0.5, 0.002, -halfZ),
        new THREE.Vector3(0.5, 0.002, halfZ),
        new THREE.Vector3(-0.5, 0.002, halfZ)
      ]),
      new THREE.LineBasicMaterial({ color: 0xf5ebdc })
    );
    g.add(border);

    this.posterSpace.add(g);
    this._debugGroup = g;
    return g;
  }

  removeAnchorDebug() {
    if (this._debugGroup && this._debugGroup.parent) {
      this._debugGroup.parent.remove(this._debugGroup);
      this._debugGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this._debugGroup = null;
    }
  }

  scheduleResize() {
    if (this._resizeRaf) return;
    const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    this._resizeRaf = raf(() => {
      this._resizeRaf = 0;
      this.resize();
    });
  }

  /** 与 MindAR 官方 three 适配层等价的尺寸/FOV 计算 */
  resize() {
    const { renderer, camera, container, video, controller } = this;
    if (!renderer || !container) return;
    const cw = container.clientWidth || window.innerWidth;
    const ch = container.clientHeight || window.innerHeight;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = cw + 'px';
    renderer.domElement.style.height = ch + 'px';

    if (!video || !controller) {
      camera.aspect = cw / Math.max(1, ch);
      camera.updateProjectionMatrix();
      return;
    }

    const videoW = video.videoWidth || controller.inputWidth;
    const videoH = video.videoHeight || controller.inputHeight;
    if (!videoW || !videoH || !cw || !ch) return;

    // 视频用 cover 方式铺满容器
    const videoRatio = videoW / videoH;
    const containerRatio = cw / ch;
    let vw, vh;
    if (videoRatio > containerRatio) {
      vh = ch;
      vw = vh * videoRatio;
    } else {
      vw = cw;
      vh = vw / videoRatio;
    }
    video.style.width = vw + 'px';
    video.style.height = vh + 'px';
    video.style.left = -(vw - cw) / 2 + 'px';
    video.style.top = -(vh - ch) / 2 + 'px';

    const proj = controller.getProjectionMatrix();
    const inputWidth = controller.inputWidth;
    const inputHeight = controller.inputHeight;
    const inputRatio = inputWidth / inputHeight;

    let inputAdjust;
    let videoDisplayHeight;
    if (inputRatio > containerRatio) {
      inputAdjust = videoW / inputWidth || 1;
      videoDisplayHeight = ch * inputAdjust;
    } else {
      inputAdjust = videoH / inputHeight || 1;
      const videoDisplayWidth = cw;
      videoDisplayHeight = (videoDisplayWidth / inputWidth) * inputHeight * inputAdjust;
    }
    const fovAdjust = ch / videoDisplayHeight;

    const fov = 2 * Math.atan((1 / proj[5]) * fovAdjust) / DEG;
    const near = proj[14] / (proj[10] - 1.0);
    const far = proj[14] / (proj[10] + 1.0);

    camera.fov = fov;
    camera.near = Math.max(0.001, near);
    camera.far = far;
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  }

  /** 重新定位：重置跟踪状态（重新走一遍 detect→match），角色归位由上层负责 */
  recenter() {
    if (!this.controller || !this.video) return false;
    try {
      this.controller.stopProcessVideo();
    } catch (e) {
      console.warn('[MindARLite] stopProcessVideo 失败', e);
    }
    this._tracking = false;
    if (this.anchor) this.anchor.visible = false;
    try {
      this.controller.processVideo(this.video);
    } catch (e) {
      console.warn('[MindARLite] 重启跟踪失败', e);
      return false;
    }
    return true;
  }

  render() {
    if (!this.renderer) return;
    this.renderer.render(this.scene, this.camera);
  }

  async stop() {
    this._running = false;
    window.removeEventListener('resize', this._onWindowResize);
    window.removeEventListener('orientationchange', this._onOrient);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onWindowResize);
    }
    try {
      if (this.controller) this.controller.stopProcessVideo();
    } catch (e) {
      /* ignore */
    }
    try {
      if (this._stream) this._stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      /* ignore */
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      if (this.renderer.domElement.parentNode) this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}

export default MindARLite;
