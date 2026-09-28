import * as THREE from 'three';
import {
  RIBBON_VERT, RIBBON_FRAG, FOOT_VERT, FOOT_FRAG, ELECTRODE_VERT, ELECTRODE_FRAG, SOLID_VERT, BASE_FRAG, TABLE_FRAG, SEAT_FRAG, STEM_FRAG,
  GLASS_VERT, GLASS_FRAG, POST_VERT, DOWN_FRAG, UP_FRAG, OUTPUT_FRAG,
} from './shaders.js';
import { GLOBE, ELECTRODE, SEGMENT_FLOATS } from './plasma.js';

const V3 = THREE.Vector3;

// The home camera: a 30 degree lens about six globe radii away, a little above the table.
export const HOME = { fov: 30, height: 0.2, target: new V3(0, -0.28, 0), halfHeight: 1.7, halfWidth: 1.45 };
export const TABLE_Y = -1.75;
const LEVELS = 6;                                  // bloom pyramid depth
const BLOOM = { weights: [0.6, 0.4, 0.2, 0.08, 0.04], gain: 0.28, halo: new V3(1.0, 0.5, 0.8), exposure: 1.0 };
const LENS = { blur: 0.022, core: 0.0016 };                      // circle of confusion at unit relative defocus, as a share of the frame height
const EXPOSURE = 1.0;

export function homeDistance(aspect) {
  const tan = Math.tan(THREE.MathUtils.degToRad(HOME.fov / 2));
  return Math.max(HOME.halfHeight / tan, HOME.halfWidth / (tan * aspect));
}

function instancedQuad(array, stride, layout, corners) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corners.flatMap(([x, y]) => [x, y, 0])), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const buffer = new THREE.InstancedInterleavedBuffer(array, stride);
  buffer.setUsage(THREE.DynamicDrawUsage);
  for (const [name, offset] of layout) geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, 4, offset));
  geometry.instanceCount = 0;
  return { geometry, buffer };
}

export function createRenderer(canvas, plasma) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the output pass writes display values itself
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(HOME.fov, 1, 0.5, 60);
  const mirrorCamera = new THREE.PerspectiveCamera();
  mirrorCamera.matrixAutoUpdate = false;
  mirrorCamera.matrixWorldAutoUpdate = false;
  const mirror = new THREE.Matrix4().set(1, 0, 0, 0, 0, -1, 0, 2 * TABLE_Y, 0, 0, 1, 0, 0, 0, 0, 1);

  const shared = {
    uEnergy: { value: 0 }, uTint: { value: new V3(0.95, 0.32, 1.0) }, uContact: { value: new V3(0, 0, 1) }, uHaze: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) }, uFocus: { value: 6 }, uBlur: { value: 4 }, uCoreMax: { value: 2 },
  };
  const roots = Array.from({ length: plasma.roots.length / 4 }, () => new THREE.Vector4());

  const add = (geometry, material, order = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    scene.add(mesh);
    return mesh;
  };
  const both = { side: THREE.DoubleSide };

  // Table and base: dark solids that show only the plasma's light.
  const table = add(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2).translate(0, TABLE_Y, 0), new THREE.ShaderMaterial({
    uniforms: { ...shared, uMirror: { value: null }, uHeight: { value: -TABLE_Y } }, vertexShader: SOLID_VERT, fragmentShader: TABLE_FRAG, ...both,
  }), -2);
  const profile = [[0.40, -0.90], [0.43, -0.93], [0.47, -1.0], [0.53, -1.12], [0.61, -1.3], [0.68, -1.52], [0.715, -1.70], [0.715, TABLE_Y]];
  add(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 96), new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: SOLID_VERT, fragmentShader: BASE_FRAG, ...both,
  }), -1);
  add(new THREE.CylinderGeometry(0.045, 0.055, 0.8, 24, 1, true).translate(0, -0.55, 0), new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: SOLID_VERT, fragmentShader: STEM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...both,
  }), 4);
  // The seat of the globe: a ring the discharge lights blue where the glass meets the base.
  add(new THREE.TorusGeometry(0.42, 0.03, 16, 128).rotateX(Math.PI / 2).translate(0, -0.925, 0), new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: SOLID_VERT, fragmentShader: SEAT_FRAG, ...both,
  }), -1);
  const electrode = add(new THREE.SphereGeometry(ELECTRODE.radius, 64, 48), new THREE.ShaderMaterial({
    uniforms: { ...shared, uRoots: { value: roots } }, vertexShader: ELECTRODE_VERT, fragmentShader: ELECTRODE_FRAG, ...both,
  }), -1);

  // Channels and glass brushes.
  const back = { point: new V3(), normal: new V3() };
  const ribbonMaterial = ghost => new THREE.ShaderMaterial({
    uniforms: { ...shared, uGhost: { value: ghost }, uBackPoint: { value: back.point }, uBackNormal: { value: back.normal } },
    vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, ...both,
  });
  const ribbons = instancedQuad(plasma.segments, SEGMENT_FLOATS, [['aP0', 0], ['aP1', 4], ['aI', 8]], [[0, -1], [1, -1], [1, 1], [0, 1]]);
  add(ribbons.geometry, ribbonMaterial(0), 1);
  // The same channels, reflected in the inside of the back wall at a few percent.
  add(ribbons.geometry, ribbonMaterial(1), 1);
  const brushes = instancedQuad(plasma.feet, 8, [['aFoot', 0], ['aTangent', 4]], [[-1, -1], [1, -1], [1, 1], [-1, 1]]);
  add(brushes.geometry, new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: FOOT_VERT, fragmentShader: FOOT_FRAG, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, ...both,
  }), 2);
  add(new THREE.SphereGeometry(GLOBE.outer, 96, 64), new THREE.ShaderMaterial({
    uniforms: shared, vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, ...both,
  }), 3);

  // Render targets: linear HDR beauty, a half-size mirrored copy for the table, and the bloom pyramid.
  const hdr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples: 4 });
  const mirrorRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const chain = () => Array.from({ length: LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false }));
  const downs = chain(), ups = chain();
  table.material.uniforms.uMirror.value = mirrorRT.texture;

  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function postPass(fragmentShader, uniforms) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms, vertexShader: POST_VERT, fragmentShader, depthTest: false, depthWrite: false }));
    mesh.frustumCulled = false;
    const passScene = new THREE.Scene();
    passScene.add(mesh);
    return { scene: passScene, u: mesh.material.uniforms };
  }
  const down = postPass(DOWN_FRAG, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const up = postPass(UP_FRAG, { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } });
  const output = postPass(OUTPUT_FRAG, {
    uBeauty: { value: hdr.texture }, uBloom: { value: ups[1].texture }, uHalo: { value: BLOOM.halo }, uExposure: { value: EXPOSURE }, uBloomGain: { value: BLOOM.gain }, uFrame: { value: 0 },
  });
  const size = new THREE.Vector2(1, 1);
  const forward = new V3();
  let frame = 0;

  function frameCamera(aspect) {
    camera.aspect = aspect;
    camera.position.set(0, HOME.height, homeDistance(aspect));
    camera.lookAt(HOME.target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }

  function syncUniforms() {
    const s = plasma.state;
    shared.uEnergy.value = s.energy;
    shared.uContact.value.set(s.contact.x, s.contact.y, s.contact.z);
    shared.uHaze.value = Math.pow(s.finger.near, 2) * 0.05;
    for (let i = 0; i < roots.length; i++) roots[i].fromArray(plasma.roots, i * 4);
    ribbons.geometry.instanceCount = s.segmentCount;
    ribbons.buffer.needsUpdate = true;
    brushes.geometry.instanceCount = s.footCount;
    brushes.buffer.needsUpdate = true;
    back.normal.copy(camera.position).normalize();
    back.point.copy(back.normal).multiplyScalar(-GLOBE.inner);
    camera.getWorldDirection(forward);
    shared.uFocus.value = -forward.dot(camera.position);   // the electrode is in focus
  }

  function render() {
    renderer.info.reset();
    syncUniforms();
    // Mirror image for the glossy table: the same scene about the table plane, half size.
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);
    mirrorCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    mirrorCamera.matrixWorld.multiplyMatrices(mirror, camera.matrixWorld);
    mirrorCamera.matrixWorldInverse.multiplyMatrices(camera.matrixWorldInverse, mirror);
    table.visible = false;
    shared.uRes.value.set(mirrorRT.width, mirrorRT.height);
    renderer.setRenderTarget(mirrorRT);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    table.visible = true;
    shared.uRes.value.copy(size);
    renderer.setRenderTarget(hdr);
    renderer.clear();
    renderer.render(scene, camera);
    // Bloom pyramid.
    let src = hdr.texture, w = size.x, h = size.y;
    for (let k = 1; k < LEVELS; k++) {
      down.u.uSrc.value = src;
      down.u.uTexel.value.set(1 / w, 1 / h);
      renderer.setRenderTarget(downs[k]);
      renderer.render(down.scene, screenCamera);
      src = downs[k].texture; w = downs[k].width; h = downs[k].height;
    }
    for (let k = LEVELS - 2; k >= 1; k--) {
      const coarse = k === LEVELS - 2 ? downs[k + 1] : ups[k + 1];
      up.u.uSrc.value = coarse.texture;
      up.u.uBase.value = downs[k].texture;
      up.u.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      up.u.uWeight.value = BLOOM.weights[k - 1];
      renderer.setRenderTarget(ups[k]);
      renderer.render(up.scene, screenCamera);
    }
    output.u.uFrame.value = frame++ % 4096;
    renderer.setRenderTarget(null);
    renderer.render(output.scene, screenCamera);
  }

  // Sizes every target from the framebuffer (w x h device pixels for a css-pixel canvas).
  function resize(cssWidth, cssHeight, w, h) {
    renderer.setSize(w, h, false);
    size.set(w, h);
    hdr.setSize(w, h);
    mirrorRT.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    for (let k = 1; k < LEVELS; k++) {
      const lw = Math.max(1, Math.ceil(w / 2 ** k)), lh = Math.max(1, Math.ceil(h / 2 ** k));
      downs[k].setSize(lw, lh);
      ups[k].setSize(lw, lh);
    }
    shared.uBlur.value = LENS.blur * h;
    shared.uCoreMax.value = LENS.core * h;
    frameCamera(cssWidth / cssHeight);
  }

  function dispose() {
    const geometries = new Set(), materials = new Set();
    for (const root of [scene, down.scene, up.scene, output.scene]) {
      root.traverse((o) => { if (o.geometry) geometries.add(o.geometry); if (o.material) materials.add(o.material); });
    }
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    for (const rt of [hdr, mirrorRT, ...downs, ...ups]) rt.dispose();
    renderer.dispose();
  }

  return { renderer, camera, render, resize, dispose };
}
