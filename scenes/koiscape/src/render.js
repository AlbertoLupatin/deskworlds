import * as THREE from 'three';
import {
  BODY_VERT, BODY_FRAG, FIN_VERT, FIN_FRAG, BOTTOM_VERT, BOTTOM_FRAG, QUAD_VERT, RIPPLE_FRAG, SURFACE_FRAG,
  PAD_VERT, PAD_FRAG, PAD_MASK_FRAG, PETAL_VERT, PETAL_FRAG, PELLET_VERT, PELLET_FRAG,
} from './shaders.js';
import { bodyGeometry, finGeometry, padGeometry, petalGeometry, halfWidth, VARIETIES } from './koi.js';
import { POND_DEPTH, PELLET, SPINE_JOINTS, SPINE_SPAN, STROKE, RIPPLE_SPEED, FIXED_STEP } from './pond.js';

// The camera hangs straight above the middle of the pond, far enough up that the view is
// nearly flat. HALF_HEIGHT is how much water shows from the centre of the frame to its top edge.
export const VIEW = { fov: 22, halfHeight: 1.1 };
const FIELD_MARGIN = 0.35;                 // the ripple field runs this far past the frame
const FIELD_WIDTH = 1024;
const EXPOSURE = 1.0;
const MAX_PADS = 64, MAX_PETALS = 160;

export const homeBounds = (aspect) => ({ halfW: VIEW.halfHeight * aspect, halfH: VIEW.halfHeight });

const FIN_LOOK = {
  kohaku: { colour: [0.74, 0.74, 0.7], root: [0.8, 0.76, 0.7] },
  sanke: { colour: [0.74, 0.74, 0.7], root: [0.8, 0.76, 0.7] },
  tancho: { colour: [0.76, 0.76, 0.72], root: [0.82, 0.78, 0.72] },
  // Showa and utsuri carry black at the root of each pectoral fin.
  showa: { colour: [0.66, 0.66, 0.63], root: [0.012, 0.012, 0.015] },
  utsuri: { colour: [0.68, 0.68, 0.66], root: [0.012, 0.012, 0.015] },
  ogon: { colour: [0.8, 0.6, 0.22], root: [0.86, 0.52, 0.1] },
  chagoi: { colour: [0.2, 0.13, 0.06], root: [0.13, 0.075, 0.03] },
};

export function createRenderer(canvas, pond) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the shaders write display values themselves
  renderer.info.autoReset = false;
  renderer.autoClear = false;

  const camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 1, 30);
  camera.up.set(0, 0, -1);
  const splashes = Array.from({ length: 8 }, () => new THREE.Vector4());
  const fieldHalf = new THREE.Vector2(3, 1.5), viewHalf = new THREE.Vector2(2.6, 1.1);
  const time = { value: 0 };
  const padMask = new THREE.WebGLRenderTarget(FIELD_WIDTH, 440, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const light = { uTime: time, uPadMask: { value: padMask.texture }, uFieldHalf: { value: fieldHalf } };
  const look = { uExposure: { value: EXPOSURE }, uFrame: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uHalf: { value: viewHalf } };
  // The ripple field, for the surface and for everything that floats on it.
  const rippleTexel = new THREE.Vector2(1 / FIELD_WIDTH, 1 / 440);
  const field = { uRipple: { value: null }, uFieldHalf: light.uFieldHalf, uTexel: { value: rippleTexel } };
  const meshOf = (scene, geometry, material, order = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    scene.add(mesh);
    return mesh;
  };

  // --- Under the surface: the bottom, then every fish.
  const under = new THREE.Scene();
  const shadows = Array.from({ length: 30 }, () => new THREE.Vector4());
  const bottom = meshOf(under, new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2).translate(0, -POND_DEPTH, 0), new THREE.ShaderMaterial({
    uniforms: { ...light, uShadow: { value: shadows }, uShadowCount: { value: 0 } }, vertexShader: BOTTOM_VERT, fragmentShader: BOTTOM_FRAG,
  }), -10);
  const bodyShape = bodyGeometry(), finShape = finGeometry();
  const koi = pond.fish.map((fish) => {
    const variety = VARIETIES[fish.variety], fins = FIN_LOOK[fish.variety];
    const shared = {
      ...light, uSpine: { value: fish.spine }, uLen: { value: fish.len }, uGirth: { value: fish.girth }, uRoll: { value: 0 }, uMouth: { value: 0 }, uSeed: { value: fish.seed },
      uGill: { value: 0 }, uMetal: { value: variety.metal },
    };
    const body = meshOf(under, bodyShape, new THREE.ShaderMaterial({
      uniforms: {
        ...shared, uPattern: { value: variety.pattern }, uCover: { value: variety.cover + (fish.seed % 1 - 0.5) * 0.12 },
        uGround: { value: new THREE.Vector3(...variety.ground) }, uHi: { value: new THREE.Vector3(...variety.hi) }, uSumi: { value: new THREE.Vector3(...variety.sumi) },
      },
      vertexShader: BODY_VERT, fragmentShader: BODY_FRAG,
    }));
    const fin = meshOf(under, finShape, new THREE.ShaderMaterial({
      uniforms: {
        ...shared, uPectoral: { value: 0.5 }, uPecPhase: { value: 0 }, uPhase: { value: 0 }, uStroke: { value: 0 },
        uSplay: { value: (fish.seed % 2 < 1 ? 1 : -1) * (0.55 + (fish.seed * 7.3) % 0.45) },
        uFinColour: { value: new THREE.Vector3(...fins.colour) }, uFinRoot: { value: new THREE.Vector3(...fins.root) },
      },
      vertexShader: FIN_VERT, fragmentShader: FIN_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      // Blended over what is behind, but leaving the depth-below-surface in alpha alone.
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    // A second pass over the same fins writes only their depth, where they are solid enough to
    // count, so the murk blur treats a fin as lying at the fish and not at the bottom far below.
    const finDepth = meshOf(under, finShape, new THREE.ShaderMaterial({
      uniforms: fin.material.uniforms, defines: { DEPTH_ONLY: 1 },
      vertexShader: FIN_VERT, fragmentShader: FIN_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MinEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    }));
    return { fish, body, fin, finDepth, shared };
  });

  // --- On the surface: the water itself, then pads, flowers and pellets.
  const over = new THREE.Scene();
  const underTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples: 0 });
  const rippleOptions = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  let ripples = [new THREE.WebGLRenderTarget(FIELD_WIDTH, 440, rippleOptions), new THREE.WebGLRenderTarget(FIELD_WIDTH, 440, rippleOptions)];
  field.uRipple.value = ripples[0].texture;
  const quad = new THREE.PlaneGeometry(2, 2);
  const surface = meshOf(over, quad, new THREE.ShaderMaterial({
    uniforms: {
      ...light, ...look, ...field, uUnder: { value: underTarget.texture }, uCalm: { value: 1 }, uSplash: { value: splashes }, uSplashCount: { value: 0 },
    },
    vertexShader: QUAD_VERT, fragmentShader: SURFACE_FRAG, depthTest: false, depthWrite: false,
  }), -10);

  const padShape = padGeometry();
  const padPlace = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PADS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const padLook = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PADS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  padShape.setAttribute('iPlace', padPlace);
  padShape.setAttribute('iLook', padLook);
  // Alpha to coverage softens the leaf's own outline, nicks and holes, which the canvas multisampling
  // alone would leave stepped.
  meshOf(over, padShape, new THREE.ShaderMaterial({ uniforms: { ...light, ...look, ...field }, vertexShader: PAD_VERT, fragmentShader: PAD_FRAG, side: THREE.DoubleSide, alphaToCoverage: true }), 1);
  const maskScene = new THREE.Scene();
  meshOf(maskScene, padShape, new THREE.ShaderMaterial({ uniforms: { ...field }, vertexShader: PAD_VERT, fragmentShader: PAD_MASK_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
  const maskCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  maskCamera.up.set(0, 0, -1);

  const petalShape = petalGeometry();
  const petalPlace = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETALS * 4), 4);
  const petalLook = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PETALS * 4), 4);
  petalShape.setAttribute('iPlace', petalPlace);
  petalShape.setAttribute('iLook', petalLook);
  meshOf(over, petalShape, new THREE.ShaderMaterial({ uniforms: { ...light, ...look }, vertexShader: PETAL_VERT, fragmentShader: PETAL_FRAG, side: THREE.DoubleSide, transparent: true }), 2);

  const pelletShape = new THREE.InstancedBufferGeometry();
  pelletShape.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  pelletShape.setIndex([0, 1, 2, 0, 2, 3]);
  const pelletPlace = new THREE.InstancedBufferAttribute(new Float32Array(PELLET.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  pelletShape.setAttribute('iPlace', pelletPlace);
  meshOf(over, pelletShape, new THREE.ShaderMaterial({
    uniforms: { ...light, ...look }, vertexShader: PELLET_VERT, fragmentShader: PELLET_FRAG, side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false,
  }), 3);

  // --- The ripple field.
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const rippleScene = new THREE.Scene();
  const impulses = Array.from({ length: 12 }, () => new THREE.Vector4());
  const rippleStep = meshOf(rippleScene, quad, new THREE.ShaderMaterial({
    uniforms: { uPrev: { value: null }, uPadMask: { value: padMask.texture }, uTexel: { value: rippleTexel }, uFieldHalf: { value: fieldHalf }, uImpulse: { value: impulses }, uCount: { value: 0 }, uWave: { value: 0.24 } },
    vertexShader: QUAD_VERT, fragmentShader: RIPPLE_FRAG, depthTest: false, depthWrite: false,
  }));
  function clearRipples() {
    const was = renderer.getRenderTarget();
    for (const target of ripples) { renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1); renderer.clear(); }
    renderer.setRenderTarget(was);
  }
  // One step of the wave equation, pressing in whatever touched the water since the last one.
  function step() {
    const queue = pond.impulses, count = Math.min(12, queue.length / 4);
    for (let i = 0; i < count; i++) impulses[i].set(queue[i * 4], queue[i * 4 + 1], queue[i * 4 + 2], queue[i * 4 + 3]);
    queue.splice(0, count * 4);
    rippleStep.material.uniforms.uCount.value = count;
    rippleStep.material.uniforms.uPrev.value = ripples[0].texture;
    renderer.setRenderTarget(ripples[1]);
    renderer.render(rippleScene, screenCamera);
    renderer.setRenderTarget(null);
    ripples = [ripples[1], ripples[0]];
    field.uRipple.value = ripples[0].texture;
  }

  function layFlowers() {
    let n = 0;
    const put = (flower, turn, length, tilt, width, whorl) => {
      if (n >= MAX_PETALS) return;
      petalPlace.setXYZW(n, flower.x, flower.z, turn, length);
      petalLook.setXYZW(n, tilt, width, whorl, flower.seed + (flower.pink ? 10 : 0));
      n++;
    };
    for (const flower of pond.flowers) {
      // First the dark of the water shaded under it, then four green sepals lying flat.
      put(flower, 0, flower.radius * 1.15, 0, 0, -2);
      for (let i = 0; i < 4; i++) put(flower, flower.turn + Math.PI / 8 + (i / 4) * Math.PI * 2, flower.radius * 1.12, 0.05, 0.34, 5);
      // Outer petals open out; each whorl inside stands more upright and is shorter, into a cup.
      const whorls = [[8, 1, 0.25, 0.3], [8, 0.9, 0.7, 0.28], [7, 0.76, 1.15, 0.26], [6, 0.62, 1.45, 0.24]];
      whorls.forEach(([count, length, tilt, width], w) => {
        for (let i = 0; i < count; i++) {
          const jitter = Math.sin(flower.seed * 91 + i * 7.1 + w * 3.3), other = Math.sin(flower.seed * 53 + i * 3.7 + w * 1.9);
          put(flower, flower.turn + ((i + w * 0.5) / count) * Math.PI * 2 + jitter * 0.12, flower.radius * length * (1 + other * 0.12), tilt + jitter * 0.12, width * (1 + other * 0.1), w);
        }
      });
      put(flower, 0, flower.radius * 0.3, 0, 0, -1);
      // A closed bud on its own stalk nearby.
      if (flower.bud) {
        const bud = { ...flower, ...flower.bud };
        put(bud, 0, flower.radius * 0.32, 0, 0, -2);
        put(bud, flower.bud.turn, flower.radius * 0.2, 0, 0, 6);
      }
    }
    petalShape.instanceCount = n;
    petalPlace.needsUpdate = true; petalLook.needsUpdate = true;
  }

  let laidFor = '';
  function sync() {
    time.value = pond.time;
    // Pads and flowers keep their place in the frame when it changes shape; follow them.
    const bounds = `${pond.bounds.halfW},${pond.bounds.halfH}`;
    if (bounds !== laidFor) { laidFor = bounds; layFlowers(); }
    // Deeper fish first, so a fin above shows through to the fish below it.
    const order = [...koi].sort((a, b) => b.fish.depth - a.fish.depth);
    order.forEach(({ fish, body, fin, finDepth, shared }, i) => {
      pond.pose(fish);
      shared.uRoll.value = fish.roll;
      shared.uMouth.value = fish.mouth;
      shared.uGill.value = fish.gill;
      const u = fin.material.uniforms;
      u.uPectoral.value = fish.pectoral; u.uPecPhase.value = fish.pectoralPhase; u.uPhase.value = fish.phase; u.uStroke.value = fish.amp / STROKE;
      body.renderOrder = 0; fin.renderOrder = 10 + i * 2; finDepth.renderOrder = 11 + i * 2;
    });
    let s = 0;
    for (const { fish } of koi) {
      for (const at of [0.14, 0.42, 0.74]) {
        const j = Math.round((at / SPINE_SPAN) * (SPINE_JOINTS - 1)) * 4;
        shadows[s++].set(fish.spine[j], fish.spine[j + 2], halfWidth(at) * fish.len * fish.girth * 1.15, -fish.spine[j + 1]);
      }
    }
    bottom.material.uniforms.uShadowCount.value = s;

    const pads = pond.pads;
    for (let i = 0; i < Math.min(MAX_PADS, pads.length); i++) {
      const p = pads[i];
      padPlace.setXYZW(i, p.x, p.z, p.radius, p.turn + (p.spin || 0));
      padLook.setXYZW(i, p.seed, p.age, p.lift, 0.05 + ((p.seed * 13.7) % 1) * 0.16);
    }
    padShape.instanceCount = Math.min(MAX_PADS, pads.length);
    padPlace.needsUpdate = true; padLook.needsUpdate = true;

    pond.splashes.forEach((s, i) => splashes[i].set(s.x, s.z, s.age, s.size));
    surface.material.uniforms.uSplashCount.value = pond.splashes.length;

    let n = 0;
    for (const p of pond.pellets) {
      if (p.age < 0 || n >= PELLET.capacity) continue;
      pelletPlace.setXYZW(n++, p.x, p.z, p.radius, pond.whole(p));
    }
    pelletShape.instanceCount = n;
    pelletPlace.needsUpdate = true;
  }

  function render({ cheap = false } = {}) {
    renderer.info.reset();
    sync();
    look.uFrame.value = (look.uFrame.value + 1) % 4096;
    surface.material.uniforms.uCalm.value = 1;
    renderer.setRenderTarget(padMask);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(maskScene, maskCamera);
    renderer.setRenderTarget(underTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(under, camera);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(over, camera);
  }

  let framed = false;
  // Sizes every target from the framebuffer (w x h device pixels for a css-pixel canvas) and
  // frames the pond; returns how much water is now in view.
  function resize(cssWidth, cssHeight, w, h) {
    renderer.setSize(w, h, false);
    look.uRes.value.set(w, h);
    underTarget.setSize(w, h);
    const aspect = cssWidth / cssHeight, { halfW, halfH } = homeBounds(aspect);
    camera.aspect = aspect;
    camera.position.set(0, halfH / Math.tan(THREE.MathUtils.degToRad(VIEW.fov / 2)), 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const changed = !framed || Math.abs(viewHalf.x - halfW) > 1e-6 || Math.abs(viewHalf.y - halfH) > 1e-6;
    framed = true;
    viewHalf.set(halfW, halfH);
    if (changed) {
      fieldHalf.set(halfW + FIELD_MARGIN, halfH + FIELD_MARGIN);
      const rows = Math.max(64, Math.round(FIELD_WIDTH * fieldHalf.y / fieldHalf.x));
      for (const target of [...ripples, padMask]) target.setSize(FIELD_WIDTH, rows);
      rippleTexel.set(1 / FIELD_WIDTH, 1 / rows);
      // Rings spread at the same speed in metres whatever the frame, as fast as the grid allows.
      const cell = (2 * fieldHalf.x) / FIELD_WIDTH;
      rippleStep.material.uniforms.uWave.value = Math.min(0.45, (RIPPLE_SPEED * FIXED_STEP / cell) ** 2);
      maskCamera.left = -fieldHalf.x; maskCamera.right = fieldHalf.x; maskCamera.top = fieldHalf.y; maskCamera.bottom = -fieldHalf.y;
      maskCamera.position.set(0, 5, 0);
      maskCamera.lookAt(0, 0, 0);
      maskCamera.updateMatrixWorld();
      maskCamera.updateProjectionMatrix();
      clearRipples();
    }
    return { halfW, halfH };
  }

  // Where a point of the canvas (in NDC) meets the water.
  const project = (nx, ny) => ({ x: nx * viewHalf.x, z: -ny * viewHalf.y });
  // Where a point of the water shows on the canvas, as fractions of its width and height.
  const locate = (x, z) => ({ x: x / viewHalf.x * 0.5 + 0.5, y: z / viewHalf.y * 0.5 + 0.5 });

  function dispose() {
    const geometries = new Set(), materials = new Set();
    for (const root of [under, over, maskScene, rippleScene]) {
      root.traverse((o) => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
    }
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    for (const target of [underTarget, padMask, ...ripples]) target.dispose();
    renderer.dispose();
  }

  return { renderer, camera, render, resize, step, project, locate, layFlowers, dispose };
}
