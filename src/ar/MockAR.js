/**
 * MockAR —— 没有真实摄像头时（桌面端调试 / 自动化 E2E）用的 AR 替身。
 * 提供与 MindARLite 完全一致的对外接口，posterSpace 的几何约定也完全一致
 * （见 docs/CONTRACT.md §1.2：1 单位 = 海报宽度，地面 y=0 = 海报表面）。
 *
 * 用途：
 *  - `?mock=1`        桌面/无摄像头环境预览角色与操作
 *  - Playwright E2E   稳定验证摇杆、位移、动画、特效、UI
 */

import * as THREE from 'three';

const POSTER_ASPECT = 1000 / 800;

export class MockAR {
  constructor({ container, onTargetFound, onTargetLost, onStatus, onFrame }) {
    this.container = container;
    this.onTargetFound = onTargetFound;
    this.onTargetLost = onTargetLost;
    this.onStatus = onStatus;
    this.onFrame = onFrame;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.01, 100);
    this.renderer = null;
    this.anchor = null;
    this.posterSpace = null;
    this.video = null;

    this._posterAspect = POSTER_ASPECT;
    this._tracking = false;
    this._running = false;

    // 相机放在海报斜上方，模拟"举着手机看海报"
    this._camDistance = 1.45;
    this._camHeight = 1.05;
    this._camForward = new THREE.Vector3(0, 0, -1);

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._v5 = new THREE.Vector3();

    this._onWindowResize = () => this.resize();
  }

  get isTracking() {
    return this._tracking;
  }

  get targetAspect() {
    return this._posterAspect;
  }

  get posterHalf() {
    return { halfX: 0.5, halfZ: this._posterAspect / 2 };
  }

  async start() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2b2320, 1.55));
    const key = new THREE.DirectionalLight(0xfff1d0, 1.55);
    key.position.set(0.6, 1.4, 1.0);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fd8e6, 0.6);
    rim.position.set(-0.8, 0.6, -0.9);
    this.scene.add(rim);

    // 一张"海报"贴图铺在地面上，便于肉眼确认识别平面与比例
    const tex = await this._loadPosterTexture();
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, this._posterAspect),
        new THREE.MeshBasicMaterial({ map: tex, transparent: false })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = -0.001;
      this.scene.add(plane);
    }

    const group = new THREE.Group();
    group.visible = false;
    group.matrixAutoUpdate = false;
    group.matrix.identity();
    this.scene.add(group);
    this.anchor = group;

    const posterSpace = new THREE.Group();
    posterSpace.rotation.x = Math.PI / 2;
    group.add(posterSpace);
    this.posterSpace = posterSpace;

    this.resize();
    this._running = true;
    window.addEventListener('resize', this._onWindowResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onWindowResize, { passive: true });
    }

    // 模拟"识别成功"前的 400ms 扫描
    setTimeout(() => {
      if (!this._running) return;
      group.visible = true;
      this._tracking = true;
      if (typeof this.onTargetFound === 'function') this.onTargetFound();
      if (typeof this.onStatus === 'function') this.onStatus('track', '已锁定海报（模拟）');
    }, 420);
  }

  _loadPosterTexture() {
    return new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        new URL('targets/nigugu.jpg', document.baseURI).href,
        (t) => resolve(t),
        undefined,
        () => resolve(null)
      );
    });
  }

  /** 与 MindARLite 相同的语义：屏幕右 / 屏幕上（海报平面内，P 坐标系） */
  screenBasis() {
    const poster = this.posterSpace;
    if (!poster) return null;
    poster.updateWorldMatrix(true, false);
    const pw = poster.matrixWorld;
    const ax = this._v1.setFromMatrixColumn(pw, 0).normalize();
    const az = this._v3.setFromMatrixColumn(pw, 2).normalize();

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
    if (rLen < 0.12 || uLen < 0.12) {
      return { right: { x: 1, z: 0 }, up: { x: 0, z: -1 } };
    }

    // 与 MindARLite 保持一致：施密特正交化，保证平面内规范正交基
    let rightX = rx / rLen;
    let rightZ = rz / rLen;
    let upX = ux / uLen;
    let upZ = uz / uLen;
    const dot = rightX * upX + rightZ * upZ;
    upX -= dot * rightX;
    upZ -= dot * rightZ;
    const upLen2 = Math.hypot(upX, upZ);
    if (upLen2 < 0.12) {
      return { right: { x: rightX, z: rightZ }, up: { x: -rightZ, z: rightX } };
    }
    return { right: { x: rightX, z: rightZ }, up: { x: upX / upLen2, z: upZ / upLen2 } };
  }

  addAnchorDebug() {
    if (!this.posterSpace) return null;
    const g = new THREE.Group();
    const halfZ = this._posterAspect / 2;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x33ddff, roughness: 0.55 })
    );
    box.position.set(0, 0.13, 0);
    g.add(box);
    const pts = [
      new THREE.Vector3(-0.5, 0.002, -halfZ),
      new THREE.Vector3(0.5, 0.002, -halfZ),
      new THREE.Vector3(0.5, 0.002, halfZ),
      new THREE.Vector3(-0.5, 0.002, halfZ)
    ];
    g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf5ebdc })));
    this.posterSpace.add(g);
    this._debugGroup = g;
    return g;
  }

  removeAnchorDebug() {
    if (this._debugGroup && this._debugGroup.parent) {
      this._debugGroup.parent.remove(this._debugGroup);
      this._debugGroup = null;
    }
  }

  resize() {
    const { renderer, camera, container } = this;
    if (!renderer || !container) return;
    const cw = container.clientWidth || window.innerWidth;
    const ch = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(cw, ch, false);
    renderer.domElement.style.width = cw + 'px';
    renderer.domElement.style.height = ch + 'px';
    camera.aspect = cw / Math.max(1, ch);
    camera.fov = camera.aspect < 0.75 ? 72 : 58;
    camera.updateProjectionMatrix();
  }

  updateCamera() {
    const cam = this.camera;
    // 沿海报 +z（屏幕下沿）方向后撤、抬高，俯视 34°
    cam.position.set(0, this._camHeight, this._camDistance);
    cam.lookAt(0, 0.1, 0);
    cam.updateMatrixWorld();
  }

  recenter() {
    this._tracking = true;
    if (this.anchor) this.anchor.visible = true;
    return true;
  }

  render() {
    if (!this.renderer) return;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    if (typeof this.onFrame === 'function') this.onFrame();
  }

  async stop() {
    this._running = false;
    window.removeEventListener('resize', this._onWindowResize);
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      if (this.renderer.domElement.parentNode) this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}

export default MockAR;
