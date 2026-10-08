// Shaders for the koi pond. Everything under the surface is drawn as linear light into a
// half-float target, with the depth of each point below the surface in alpha. The surface pass
// then looks down through the moving water at that picture, adds what the surface reflects, and
// the pads and pellets that float on it are drawn over the top.
import { SPINE_JOINTS, SPINE_SPAN, POND_DEPTH, SPLASH_LIFE, WAVE } from './pond.js';

const NOISE = /* glsl */`
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
// Gradient noise in 0..1. Value noise would be cheaper, but its contours come out boxy.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(i) * 2.0 - 1.0, gb = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0, 1)) * 2.0 - 1.0, gd = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
  float n = mix(mix(dot(ga, f), dot(gb, f - vec2(1, 0)), u.x), mix(dot(gc, f - vec2(0, 1)), dot(gd, f - vec2(1, 1)), u.x), u.y);
  return clamp(0.5 + 1.1 * n, 0.0, 1.0);
}
// Each octave is turned against the last, so no grid shows through as squares.
const mat2 TURN = mat2(1.6, 1.2, -1.2, 1.6);
// The same noise with its derivative, in one evaluation: value in x, slope in yz.
vec3 vnoiseD(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = hash22(i) * 2.0 - 1.0, gb = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0, 1)) * 2.0 - 1.0, gd = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
  float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
    + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
  return vec3(0.5 + 1.1 * v, 1.1 * d);
}
float fbm3(vec2 p) {
  float s = 0.5 * vnoise(p);
  p = TURN * p + vec2(17.1, 9.2); s += 0.25 * vnoise(p);
  p = TURN * p + vec2(3.3, 27.7); s += 0.125 * vnoise(p);
  return s + 0.0625;
}
float fbm5(vec2 p) {
  float a = 0.5, s = 0.0;
  p = mat2(0.8, 0.6, -0.6, 0.8) * p;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = TURN * p + vec2(17.1, 9.2); a *= 0.5; }
  return s + 0.015;
}
`;

// The pond stands under trees. canopy() is 1 where leaves are overhead and 0 under open sky, at a
// point on the canopy plane; both the reflection in the surface and the sunlight that reaches the
// water read it, so a bright gap in the reflection has a pool of sun to go with it.
const SKY = /* glsl */`
${NOISE}
uniform float uTime;
const vec3 SUN_DIR = normalize(vec3(0.34, 1.0, -0.22));       // toward the sun, above the water
const vec3 SUN = vec3(1.0, 0.93, 0.8) * 2.6;
const vec3 SKY_LIGHT = vec3(0.92, 0.98, 0.96);                 // what an upturned face sees of the sky
const vec3 SKY_BRIGHT = vec3(0.55, 0.74, 1.0) * 3.0;
const vec3 LEAF_DARK = vec3(0.008, 0.016, 0.008);
const float CANOPY_HEIGHT = 3.2;
float canopy(vec2 q) {
  q += 0.05 * vec2(sin(uTime * 0.31 + q.y * 1.7), cos(uTime * 0.27 + q.x * 1.3));    // a breeze in the leaves
  float n = fbm5(q * 0.7 + vec2(3.7, 1.9));
  // Where the crowns thin out, sky shows through as many small gaps between clusters of leaves.
  float open = 1.0 - smoothstep(0.36, 0.52, n);
  float holes = fbm3(mat2(0.6, -0.8, 0.8, 0.6) * q * 4.0 + 7.0) + 0.3 * (vnoise(q * 16.0 + 2.0) - 0.5);
  return smoothstep(0.34, 0.68, holes + (1.0 - open) * 0.5);
}
// How much direct sun reaches the water at xz: soft, because the gaps are far overhead.
float sunPatch(vec2 xz) {
  vec2 q = xz + SUN_DIR.xz / SUN_DIR.y * CANOPY_HEIGHT;
  float n = fbm3(mat2(0.8, 0.6, -0.6, 0.8) * (q * 0.7) + vec2(3.7, 1.9) + 0.02 * sin(uTime * 0.3 + q.yx));
  return 1.0 - smoothstep(0.33, 0.46, n);
}
`;

const DISPLAY = /* glsl */`
uniform float uExposure;
uniform float uFrame;
uniform vec2 uRes;
vec3 filmic(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// Linear scene light to display values: exposure, a fall-off to the corners, film curve, and a
// little noise to keep the dark water from banding.
vec3 display(vec3 hdr) {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 c = (uv - 0.5) * vec2(1.0, 0.8);
  float vignette = 1.0 - 0.5 * smoothstep(0.2, 0.75, length(c));
  vec3 mapped = filmic(hdr * uExposure * vignette);
  vec3 q = fract(vec3(gl_FragCoord.xyx + uFrame * 7.31) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  float grain = fract((q.x + q.y) * q.z) - 0.5;
  return pow(mapped, vec3(1.0 / 2.2)) + grain / 255.0;
}
`;

// Light under the surface. Sun arrives through the gaps in the canopy, focused into moving
// caustic lines by the ripples and shaded by the lily pads. The water is peaty: it takes red
// first, then green, so a fish sinking away goes dim and cold well before it is lost.
const UNDERWATER = /* glsl */`
${SKY}
uniform sampler2D uPadMask;
uniform vec2 uFieldHalf;                    // half extents of the square of water the mask covers
const vec3 EXTINCT = vec3(2.35, 1.95, 2.05);  // per metre of path, down and back up together
const vec3 VEIL = vec3(0.0009, 0.0016, 0.0016);
const vec3 SUN_UNDER = normalize(vec3(0.25, 1.0, -0.16));   // the sun's direction once bent into the water
float caustic(vec2 p, float t) {
  const float TAU = 6.28318530718;
  p = mod(p * TAU, TAU) - 250.0;
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
float padShade(vec2 xz, float blur) {
  vec2 uv = xz / (2.0 * uFieldHalf) + 0.5;
  uv.y = 1.0 - uv.y;
  vec2 o = blur / (2.0 * uFieldHalf);
  float m = texture2D(uPadMask, uv).r * 0.4;
  m += 0.15 * (texture2D(uPadMask, uv + vec2(o.x, 0.0)).r + texture2D(uPadMask, uv - vec2(o.x, 0.0)).r
    + texture2D(uPadMask, uv + vec2(0.0, o.y)).r + texture2D(uPadMask, uv - vec2(0.0, o.y)).r);
  return 1.0 - m;
}
// Sunlight and skylight arriving at a point under water, on a face turned toward n.
vec3 lightAt(vec3 p, vec3 n) {
  float d = max(0.0, -p.y);
  vec2 entry = p.xz + SUN_UNDER.xz / SUN_UNDER.y * d;          // where this ray came through the surface
  float shade = padShade(entry, 0.012 + d * 0.05);
  float lines = caustic(entry * 1.55 + 0.21, uTime * 0.5) + 0.6 * caustic(entry * 0.83 + 3.1, uTime * 0.37 + 2.0);
  // Caustics need a little water to come to a focus and blur out again deeper down.
  float focus = smoothstep(0.0, 0.14, d) * exp(-d * 0.9);
  float sun = sunPatch(entry) * shade * mix(1.0, 0.4 + 1.8 * lines, focus);
  float facing = max(0.0, dot(n, SUN_UNDER));
  // Under water nearly all the light comes from the bright disc of sky overhead: faces that turn
  // away from it fall off fast, which is what rounds a fish seen from above.
  float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  float skyFacing = 0.04 + 0.96 * pow(up, 2.6);
  return SUN * sun * facing + SKY_LIGHT * skyFacing * mix(1.0, shade, 0.8);
}
// What is left of a colour by the time the light has gone down to depth d and come back up,
// with the water's own faint glow filling in what was lost.
vec3 throughWater(vec3 colour, float d) {
  vec3 t = exp(-EXTINCT * d);
  // Fine silt scatters as much as it absorbs: deeper colours wash out toward the water's own.
  float grey = dot(colour, vec3(0.3, 0.5, 0.2));
  colour = mix(colour, vec3(grey) * vec3(0.92, 1.0, 0.9), 0.1 + smoothstep(0.2, 0.9, d) * 0.3);
  return colour * t + VEIL * (1.0 - t);
}
`;

// The backbone: uSpine holds, for each joint from the nose to the tip of the tail fin, a world
// position and a heading. Vertices ride on it by their distance s down the body.
const SPINE = /* glsl */`
uniform vec4 uSpine[${SPINE_JOINTS}];
uniform float uLen;
uniform float uRoll;
struct Frame { vec3 p; vec3 t; vec3 n; vec3 b; };
Frame frameAt(float s) {
  float x = clamp(s / ${SPINE_SPAN.toFixed(4)}, 0.0, 1.0) * ${(SPINE_JOINTS - 1).toFixed(1)};
  float i = min(floor(x), ${(SPINE_JOINTS - 2).toFixed(1)});
  float f = x - i, f2 = f * f, f3 = f2 * f;
  vec4 a = uSpine[int(i)], b = uSpine[int(i) + 1];
  float seg = ${(SPINE_SPAN / (SPINE_JOINTS - 1)).toFixed(6)} * uLen;
  vec3 ta = vec3(cos(a.w), 0.0, sin(a.w)), tb = vec3(cos(b.w), 0.0, sin(b.w));
  Frame fr;
  fr.p = (2.0 * f3 - 3.0 * f2 + 1.0) * a.xyz - (f3 - 2.0 * f2 + f) * ta * seg + (-2.0 * f3 + 3.0 * f2) * b.xyz - (f3 - f2) * tb * seg;
  float heading = mix(a.w, b.w, f);
  fr.t = normalize(vec3(cos(heading), (a.y - b.y) / seg, sin(heading)));     // toward the nose
  vec3 side = vec3(-sin(heading), 0.0, cos(heading));
  vec3 up = cross(side, fr.t);
  float c = cos(uRoll), r = sin(uRoll);
  fr.n = side * c + up * r;
  fr.b = up * c - side * r;
  return fr;
}
`;

export const BODY_VERT = /* glsl */`
${SPINE}
uniform float uMouth;
varying vec2 vUv;
varying vec3 vRest;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vTangent;
varying vec3 vSide;
void main() {
  vec3 rest = position;
  // The lips push forward and open into a round mouth to take food.
  float lip = uMouth * smoothstep(0.045, 0.0, rest.x);
  rest.x -= lip * 0.02;
  rest.yz = mix(rest.yz, vec2(0.0, -0.03) + normalize(rest.yz - vec2(0.0, -0.03) + 1e-5) * 0.038, lip * smoothstep(0.03, 0.004, position.x) * 0.9);
  Frame fr = frameAt(rest.x);
  vec3 world = fr.p + (fr.n * rest.y + fr.b * rest.z) * uLen;
  vUv = uv;
  vRest = rest;
  vNormal = normalize(-fr.t * normal.x + fr.n * normal.y + fr.b * normal.z);
  vWorld = world;
  vTangent = fr.t;
  vSide = fr.n;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

// Scales, pattern and skin. A koi's pattern is laid in its scales, so the edge of a marking
// follows the scale rims rather than cutting straight across them; the head has skin and no scales.
export const BODY_FRAG = /* glsl */`
${UNDERWATER}
uniform int uPattern;
uniform float uSeed;
uniform float uCover;
uniform float uMetal;
uniform float uMouth;
uniform vec3 uGround;
uniform vec3 uHi;
uniform vec3 uSumi;
varying vec2 vUv;
varying vec3 vRest;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vTangent;
varying vec3 vSide;
const vec2 SCALES = vec2(40.0, 12.0);       // along the body, and from the back down to the belly

// The scale lying over point p, in scale units: its centre, and how far p is in from its free
// edge (0 at the rim, rising toward where the scale ahead overlaps it).
float scaleAt(vec2 p, out vec2 centre, out vec2 id) {
  float best = 1e3, edge = 0.0;
  centre = p; id = floor(p);
  vec2 base = floor(p);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cell = base + vec2(float(i), float(j));
    vec2 c = cell + vec2(0.5 + 0.5 * mod(cell.y, 2.0), 0.5) + (hash22(cell) - 0.5) * 0.3;
    float inside = 0.9 - length((p - c) * vec2(0.88, 1.12));
    // Scales overlap like tiles from the head back: of those covering p, the one nearest the head is on top.
    if (inside > 0.0 && c.x < best) { best = c.x; edge = inside / 0.9; centre = c; id = cell; }
  }
  return edge;
}

// The marking at a point of skin (u down the body, v around it from the back): how much hi and how much sumi.
vec2 marking(vec2 uv, float crisp) {
  float u = uv.x, v = uv.y;
  vec2 p = vec2(u * 3.0, v * 1.25) + uSeed * vec2(0.371, 0.113);
  float wobble = (vnoise(p * 5.0 + 4.0) - 0.5) * 0.07;
  // Hi stays on the back and sides and stops short of the nose, the eyes and the tail.
  float back = smoothstep(0.74, 0.6, abs(v) + wobble);
  float ends = smoothstep(0.045, 0.075, u + wobble * 0.3) * smoothstep(0.985, 0.94, u + wobble);
  float islands = fbm3(p * vec2(1.05, 1.0));
  float bands = fbm3(p * vec2(0.82, 0.55) + vec2(31.7, 5.3));
  float spots = vnoise(p * vec2(3.6, 3.0) + 11.3) * 0.7 + vnoise(p * 7.0 + 2.0) * 0.3;
  float hi = 0.0, sumi = 0.0;
  if (uPattern == 0) {                                            // kohaku: red islands on white
    hi = smoothstep(-crisp, crisp, islands - (1.0 - uCover) + 0.02) * back * ends;
  } else if (uPattern == 1) {                                     // sanke: kohaku with a few ink spots on the back
    hi = smoothstep(-crisp, crisp, islands - (1.0 - uCover)) * back * ends;
    float blocks = vnoise(p * vec2(1.7, 1.4) + 11.3) * 0.8 + vnoise(p * 4.0 + 2.0) * 0.2;
    sumi = smoothstep(-crisp, crisp, blocks - 0.63) * smoothstep(0.52, 0.36, abs(v)) * smoothstep(0.22, 0.28, u) * smoothstep(0.98, 0.9, u);
  } else if (uPattern == 2) {                                     // showa: black ground wrapping the body, red and white on it
    sumi = smoothstep(-crisp, crisp, bands - 0.52);
    hi = smoothstep(-crisp, crisp, islands - 0.5) * back * ends * (1.0 - sumi);
  } else if (uPattern == 3) {                                     // shiro utsuri: black and white
    sumi = smoothstep(-crisp, crisp, bands - 0.5);
  } else if (uPattern == 6) {                                     // tancho: a single red disc on the crown
    hi = smoothstep(crisp, -crisp, length(vec2((u - 0.12) / 0.062, (v - 0.04 * (fract(uSeed) - 0.5)) / 0.33)) - 1.0 + wobble * 3.5 + 0.12 * (vnoise(p * 9.0) - 0.5));
  }
  return vec2(hi, sumi);
}

void main() {
  float u = vUv.x, v = vUv.y;
  vec3 n = normalize(vNormal);
  float scaled = smoothstep(0.175, 0.215, u + 0.012 * cos(v * 3.6)) * smoothstep(0.985, 0.93, u);
  float belly = smoothstep(0.62, 0.9, abs(v));

  vec2 centre, id;
  float edge = scaleAt(vUv * SCALES, centre, id);
  // A marking's edge steps along the scale rims, but only partly: the colour sits in the skin
  // under each scale too, so the steps are soft, not a mosaic.
  vec2 sharp = marking(mix(vUv, centre / SCALES, scaled * 0.45), mix(0.022, 0.014, scaled));
  vec2 soft = marking(vUv + vec2(0.012, 0.0), 0.03);
  vec2 mark = sharp;
  mark.x = max(mark.x, soft.x * 0.3 * scaled * smoothstep(0.2, 0.6, edge));
  float tone = hash21(id + uSeed);

  vec3 ground = uGround;
  vec3 hi = uHi * (0.93 + 0.14 * tone);
  if (uPattern == 4) {                                            // ogon: one metal colour, paler on the head and belly
    ground = mix(uGround, uHi, 0.25 + 0.3 * smoothstep(0.3, 0.05, u));
  } else if (uPattern == 5) {                                     // chagoi: tea brown, each scale edged darker
    ground = mix(uGround, uHi * vec3(1.15, 0.95, 0.8), (0.25 + 0.5 * smoothstep(0.1, 0.62, edge)) * (0.6 + 0.4 * tone) * scaled + 0.3 * smoothstep(0.3, 0.05, u));
  }
  vec3 albedo = mix(ground, hi, mark.x);
  albedo = mix(albedo, uSumi, mark.y);
  // Living skin is not paint: the white warms and cools in soft patches.
  float blush = fbm3(vUv * vec2(9.0, 4.0) + uSeed);
  albedo *= mix(vec3(0.96, 0.98, 1.02), vec3(1.03, 1.0, 0.94), blush);
  // The underside is pale on every variety but the wrapped black ones.
  albedo = mix(albedo, mix(vec3(0.82, 0.8, 0.74), albedo, mark.y), belly * 0.8);

  // Each scale shows as a faint crescent: tucked a little darker under the one ahead, catching
  // light along its free rim. Only the brown and the metallic fish show a strong net.
  float tuck = smoothstep(0.1, 0.62, edge);
  float rim = smoothstep(0.14, 0.0, edge);
  float aa = clamp(1.0 - fwidth(vUv.x * SCALES.x) * 1.2, 0.0, 1.0);
  float net = (uPattern == 5 ? 0.2 : uPattern == 4 ? 0.05 : 0.05 + 0.03 * mark.x) * aa * (0.6 + 0.8 * tone);
  net *= smoothstep(0.2, 0.4, u) * smoothstep(1.0, 0.8, u) * 0.6 + 0.4;
  albedo *= mix(1.0, 1.0 - net * tuck + 0.05 * rim - net * 0.5 * smoothstep(0.05, 0.0, edge), scaled);
  n = normalize(n + vTangent * (0.5 - edge) * 0.22 * scaled * aa);

  // The dorsal fin seen edge-on from above: a pale strip down the spine with a fine shadow each side.
  float ridgeSpan = smoothstep(0.36, 0.4, u) * smoothstep(0.66, 0.6, u);
  float ridge = smoothstep(0.022, 0.008, abs(v)) * ridgeSpan;
  float ridgeEdge = smoothstep(0.012, 0.022, abs(v)) * smoothstep(0.034, 0.024, abs(v)) * ridgeSpan;
  albedo = mix(albedo, min(albedo * 1.12 + 0.05, vec3(0.9)), ridge * 0.6);
  albedo *= 1.0 - 0.25 * ridgeEdge;

  // Head: the gill cover's edge, nostrils, eyes and the mouth.
  float gill = abs(u - (0.196 - 0.05 * (1.0 - cos(v * 3.4)) * 0.5));
  albedo *= 1.0 - 0.32 * smoothstep(0.005, 0.0, gill) * smoothstep(0.15, 0.28, abs(v)) * smoothstep(0.95, 0.75, abs(v));
  albedo *= 1.0 + 0.06 * smoothstep(0.0, 0.004, gill) * smoothstep(0.02, 0.006, gill) * step(0.196, u);
  vec2 nostril = vec2(vRest.x - 0.036, abs(vRest.y) - 0.024);
  albedo *= 1.0 - 0.3 * smoothstep(0.004, 0.0015, length(nostril * vec2(0.8, 1.2))) * step(0.0, vRest.z + 0.03);
  // The eye: a dark pupil in a pale ring, on the bulge high on each side of the skull.
  vec2 eye = vec2((u - 0.1) / 0.017, (abs(v) - 0.31) / 0.075);
  float eyeD = length(eye);
  float iris = smoothstep(1.0, 0.82, eyeD);
  albedo = mix(albedo, mix(vec3(0.6, 0.56, 0.45), vec3(0.006), smoothstep(0.7, 0.55, eyeD)), iris);
  float mouth = uMouth * smoothstep(0.016, 0.006, vRest.x + 0.02 * uMouth) * smoothstep(0.036, 0.024, length(vRest.yz - vec2(0.0, -0.03)));
  albedo = mix(albedo, vec3(0.1, 0.02, 0.02), mouth);

  // Wet skin under a bright sky: soft diffuse that rolls off toward the flanks, a broad sheen
  // where the back mirrors the sky, and a hard glint where the sun gets through.
  vec3 light = lightAt(vWorld, n);
  vec3 view = vec3(0.0, 1.0, 0.0);
  float nv = max(0.0, dot(n, view));
  float sunHere = sunPatch(vWorld.xz) * padShade(vWorld.xz, 0.02);
  float fres = 0.025 + 0.2 * pow(1.0 - nv, 4.0);
  // The sky's reflection on the back: a long soft stripe along the spine.
  float patches = smoothstep(0.42, 0.7, vnoise(vec2(u * 14.0, v * 6.0) + uSeed * 3.0));
  float skyMirror = (0.6 * smoothstep(0.93, 0.99, nv) * patches + 0.32 * smoothstep(0.75, 0.97, nv)) * (0.7 + 0.3 * tone);
  vec3 sheen = SKY_BRIGHT * 0.1 * skyMirror * mix(1.0, 0.6 + 1.2 * tone * scaled, uMetal);
  vec3 h = normalize(view + SUN_UNDER);
  float nh = max(0.0, dot(n, h));
  sheen += SUN * sunHere * (pow(nh, 90.0) * 0.6 + pow(nh, 14.0) * 0.05) * (1.0 + uMetal * 2.0);
  vec3 colour = albedo * light * (1.0 - fres) * (1.0 - 0.55 * uMetal) + mix(vec3(1.0), albedo * 1.8, uMetal * 0.8) * sheen * (1.0 - iris * 0.5);
  // A metallic skin mirrors the bright water above it, and each scale, tilted a little its own
  // way, catches it differently: the sparkle that makes an ogon.
  float glitter = mix(1.0, 0.7 + 0.6 * tone, scaled) * (1.0 - 0.2 * tuck * scaled);
  colour += albedo * SKY_LIGHT * uMetal * (0.15 + 0.9 * pow(nv, 3.0)) * glitter * mix(1.0, sunHere * 2.0 + 0.6, 0.3);
  // Flanks turned away from the sky drop into the water's own dark.
  colour *= mix(0.62, 1.0, smoothstep(-0.25, 0.4, n.y));
  // A bright point on the eye.
  colour += iris * smoothstep(0.26, 0.06, length(eye - vec2(-0.25, -0.2))) * 0.6;

  float d = max(0.0, -vWorld.y);
  // Where the back or head breaks the surface it is out of the water: no murk over it, and a
  // wet film on it throws back the sky in sharp highlights.
  float above = smoothstep(-0.012, 0.003, vWorld.y);
  vec3 wet = colour * 1.05 + SKY_BRIGHT * (0.05 + 0.25 * pow(nv, 30.0)) * (0.5 + 0.5 * patches);
  gl_FragColor = vec4(mix(throughWater(colour, d), wet, above), d);
}
`;

export const FIN_VERT = /* glsl */`
${SPINE}
attribute vec4 aFin;
attribute vec3 aShape;
uniform float uPectoral;
uniform float uPecPhase;
uniform float uPhase;
uniform float uAmp;
uniform float uSplay;
uniform float uSeed;
varying vec4 vFin;
varying vec3 vWorld;
varying float vThin;
void main() {
  float kind = aFin.x, side = aFin.y, r = aFin.z, q = aFin.w;
  vec3 root = position;
  vec3 world;
  vThin = 0.0;
  if (kind < 1.5) {
    // Paired fins: rays fan from the hinge. The pectorals sweep out to brake and hover and fold
    // back along the body at speed; each ray trails the one ahead of it as the fin sculls, and the
    // soft outer part lags and curls behind the stiff leading edge.
    bool pectoral = kind < 0.5;
    float sweep = pectoral ? mix(0.32, 1.25, clamp(uPectoral, 0.0, 1.15)) : 0.5 + 0.14 * uPectoral;
    float scull = sin(uPecPhase + side * 1.57 - q * 1.3 - r * 1.6);
    sweep += (pectoral ? 0.22 : 0.08) * scull * (0.4 + uPectoral) * (0.4 + 0.6 * r);
    float ang = sweep + q * aShape.y * 0.5 - r * r * 0.12 * (1.0 - uPectoral);
    // The leading rays are long and stiff, the trailing ones shorter: a rounded paddle.
    float len = aShape.x * mix(0.7, 1.0, smoothstep(-1.0, 0.2, q)) * (1.0 - 0.18 * smoothstep(0.3, 1.0, q));
    float reach = r * len;
    vec3 off = vec3(cos(ang) * reach, side * sin(ang) * reach, -0.22 * sin(ang) * reach);
    off.z += r * r * len * (0.1 * scull * (0.3 + uPectoral * 0.7) + 0.1 * q * uPectoral);
    Frame fr = frameAt(root.x);
    world = fr.p + (-fr.t * off.x + fr.n * (root.y + off.y) + fr.b * (root.z + off.z)) * uLen;
  } else if (kind < 2.5) {
    // Dorsal fin: stands on the back, leaning with the swimming wave so a sliver shows from above.
    float s = root.x + aShape.y;
    float lean = uSplay * 0.65 + 0.6 * uAmp * sin(uPhase - s * ${WAVE.toFixed(2)} - 1.1) + uRoll * 0.6;
    Frame fr = frameAt(s);
    float h = r * aShape.x * (0.75 + 0.25 * smoothstep(0.5, 0.0, uAmp));
    world = fr.p + (fr.n * (sin(lean) * h) + fr.b * (root.z + cos(lean) * h)) * uLen;
  } else if (kind < 3.5) {
    // Tail fin: a broad soft fan. Each lobe twists and trails as it sweeps, which is why a tail
    // seen from above shows as a fan and not an edge; the outer membrane lags the stroke.
    float s = root.x + r * aShape.x;
    float b = q * mix(aShape.y, aShape.z, pow(r, 0.7));
    float lag = r * r * 0.9;
    float flutter = 0.1 * sin(uPhase * 2.0 - s * 11.0 + q * 2.1) * r;
    // Seen from above a koi's tail always reads as a fan: the lobes splay and the fish carries a
    // slight roll, so the fin is held well off the vertical, and the stroke only rocks it.
    float twist = sign(uSplay) * (1.0 + 0.15 * r) + (0.35 * uAmp + 0.08) * cos(uPhase - s * ${WAVE.toFixed(2)} - 0.3 - lag) * (0.4 + r) + flutter;
    twist *= mix(0.75, 1.0, abs(q));
    Frame fr = frameAt(s);
    world = fr.p + (fr.n * (sin(twist) * b) + fr.b * (cos(twist) * b)) * uLen;
    vThin = r;
  } else {
    // Barbels: short whiskers that trail from the corners of the mouth.
    Frame fr = frameAt(root.x);
    float sway = 0.25 * sin(uPecPhase * 0.7 + aShape.z * 2.0 + side);
    vec3 off = vec3(r * aShape.x * (0.35 + 0.5 * r), side * r * aShape.x * (0.75 + sway * r), -r * aShape.x * 0.35);
    off.y += q * aShape.y * (1.0 - 0.7 * r);
    world = fr.p + (-fr.t * off.x + fr.n * (root.y + off.y) + fr.b * (root.z + off.z)) * uLen;
  }
  vFin = aFin;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const FIN_FRAG = /* glsl */`
${UNDERWATER}
uniform vec3 uFinColour;
uniform vec3 uFinRoot;
uniform float uSeed;
varying vec4 vFin;
varying vec3 vWorld;
varying float vThin;
void main() {
  float kind = vFin.x, r = vFin.z, q = vFin.w;
  float d = max(0.0, -vWorld.y);
  if (kind > 3.5) {
#ifdef DEPTH_ONLY
    gl_FragColor = vec4(0.0, 0.0, 0.0, d);
#else
    gl_FragColor = vec4(throughWater(vec3(0.55, 0.42, 0.32) * lightAt(vWorld, vec3(0.0, 1.0, 0.0)), d), 0.9);
#endif
    return;
  }
  // Fin rays: fine bony struts that branch toward the edge, with clear membrane between. They are
  // faded out where they would be finer than a pixel, so they never shimmer.
  float count = kind < 0.5 ? 14.0 : kind < 1.5 ? 9.0 : kind < 2.5 ? 18.0 : 22.0;
  float across = ((q * 0.5 + 0.5) * count + 0.25 * sin(q * 7.0 + uSeed) ) * (1.0 + step(0.55, r));
  float ray = abs(fract(across) - 0.5) * 2.0;
  float w = fwidth(across);
  float strut = smoothstep(0.35 + w, 0.08 - w, ray) * clamp(1.4 - w * 2.5, 0.0, 1.0);
  // The edge is soft and a little ragged, the lobes of the tail rounded, and the membrane thins out.
  float fray = 0.05 * (hash21(vec2(floor(across * 2.0), uSeed)) + 0.6 * sin(across * 6.28));
  float edge = smoothstep(1.0, 0.86 - fray, r);
  float sides = kind > 1.5 && kind < 2.5 ? smoothstep(1.0, 0.95, abs(q)) : smoothstep(1.0, 0.86, abs(q));
  if (kind > 2.5) {
    float tip = length(vec2(max(0.0, r - 0.6) / 0.4, max(0.0, abs(q) - 0.55) / 0.45));
    edge *= smoothstep(1.0, 0.8, tip);
  }
  float body = kind < 0.5 ? mix(0.45, 0.08, smoothstep(0.15, 1.0, r)) : mix(0.42, 0.1, smoothstep(0.0, 0.95, r));
  float rimLine = smoothstep(0.8, 0.95, r) * edge;
  float alpha = (body + 0.2 * strut + 0.1 * rimLine) * edge * sides;
  vec3 tint = mix(uFinRoot, uFinColour, smoothstep(0.02, 0.5, r + 0.1 * (hash21(vec2(floor(across), uSeed + 3.0)) - 0.5)));
  float lead = kind < 1.5 ? smoothstep(0.7, 0.95, q) : 0.0;
  tint *= (0.8 + 0.35 * strut) * (1.0 - 0.25 * rimLine) * (1.0 + 0.35 * lead);
  alpha += lead * 0.3 * edge;
  // Thin membrane: lit from above and glowing with light that comes through it.
#ifdef DEPTH_ONLY
  if (alpha < 0.06) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, d);
#else
  vec3 light = lightAt(vWorld, vec3(0.0, 1.0, 0.0)) * 0.9;
  gl_FragColor = vec4(throughWater(tint * light, d), clamp(alpha, 0.0, 1.0));
#endif
}
`;

// The bottom: silt and a scatter of stones, lost in the dark of the deep water, coming up into a
// shelf of stones under the pads where the caustic light and the shadows of pads and fish move.
export const BOTTOM_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
export const BOTTOM_FRAG = /* glsl */`
${UNDERWATER}
uniform vec4 uShadow[30];                  // xz, radius and depth of three points down each fish
uniform int uShadowCount;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz;
  // Shelves of stones rise toward the lower left and along the bottom edge, where the pads grow;
  // the middle of the pond falls away into the dark.
  float shelf = smoothstep(1.7, 0.1, length((p - vec2(-uFieldHalf.x * 0.95, uFieldHalf.y * 0.9)) * vec2(0.6, 1.0)));
  shelf = max(shelf, 0.7 * smoothstep(0.75, 0.0, length((p - vec2(uFieldHalf.x * 0.05, uFieldHalf.y * 1.05)) * vec2(0.5, 1.3))));
  float lumps = fbm5(p * 2.3 + 5.0);
  vec2 sp = p * 6.0 + 1.3;
  vec2 cell = floor(sp), f = fract(sp) - 0.5;
  vec2 jitter = hash22(cell) - 0.5;
  float pebble = smoothstep(0.4, 0.22, length((f - jitter * 0.3) * (0.8 + 0.5 * hash22(cell + 2.0))) + 0.22 * vnoise(p * 14.0) + 0.08 * vnoise(p * 45.0));
  float stones = pebble * step(0.45, hash21(cell + 4.0)) * smoothstep(0.35, 0.6, fbm3(p * 1.7));
  float depth = ${POND_DEPTH.toFixed(2)} - shelf * (0.78 + 0.12 * lumps) - 0.06 * lumps - 0.025 * stones;
  vec3 silt = mix(vec3(0.03, 0.026, 0.018), vec3(0.075, 0.066, 0.045), lumps) * (0.35 + 0.65 * shelf);
  vec3 stone = mix(vec3(0.06, 0.058, 0.05), vec3(0.16, 0.15, 0.12), hash21(cell + 9.0)) * (0.7 + 0.5 * vnoise(p * 25.0));
  vec3 albedo = mix(silt, stone, stones * shelf);
  albedo *= 0.8 + 0.4 * vnoise(p * 40.0);
  // Fallen leaves, here and there.
  albedo = mix(albedo, vec3(0.14, 0.075, 0.025), smoothstep(0.8, 0.86, vnoise(p * 11.0 + 40.0)) * 0.6);
  // Deep down the murk swallows caustics and fish shadows alike: skip them there.
  if (depth > 0.95) {
    float sunHere = sunPatch(p) * padShade(p, 0.06);
    gl_FragColor = vec4(throughWater(albedo * (SKY_LIGHT * 0.8 + SUN * sunHere * 0.6), depth), depth);
    return;
  }
  vec3 at = vec3(p.x, -depth, p.y);
  vec3 n = normalize(vec3((0.5 - f.x) * stones * 0.6, 1.0, (0.5 - f.y) * stones * 0.6));
  vec3 light = lightAt(at, n);
  // Soft shadows of the fish above.
  float shadow = 1.0;
  for (int i = 0; i < 30; i++) {
    if (i >= uShadowCount) break;
    vec4 s = uShadow[i];
    float gap = max(0.0, depth - s.w);
    vec2 foot = s.xy - SUN_UNDER.xz / SUN_UNDER.y * gap;
    float blur = 0.02 + gap * 0.16;
    shadow *= 1.0 - 0.6 * smoothstep(s.z + blur, s.z - blur * 0.5, length(p - foot)) * exp(-gap * 0.9);
  }
  light *= mix(1.0, shadow, 0.85);
  gl_FragColor = vec4(throughWater(albedo * light, depth), depth);
}
`;

// One step of the ripple field: the wave equation on a height map, with what touched the water
// this step pressed into it. Red is the height now and green the height one step ago.
export const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const RIPPLE_FRAG = /* glsl */`
uniform sampler2D uPrev;
uniform sampler2D uPadMask;
uniform vec2 uTexel;
uniform vec2 uFieldHalf;
uniform vec4 uImpulse[12];
uniform int uCount;
varying vec2 vUv;
void main() {
  vec2 state = texture2D(uPrev, vUv).rg;
  float sum = texture2D(uPrev, vUv + vec2(uTexel.x, 0.0)).r + texture2D(uPrev, vUv - vec2(uTexel.x, 0.0)).r
    + texture2D(uPrev, vUv + vec2(0.0, uTexel.y)).r + texture2D(uPrev, vUv - vec2(0.0, uTexel.y)).r;
  float h = 2.0 * state.r - state.g + 0.24 * (sum - 4.0 * state.r);
  // Rings die away as they spread, faster under a lily pad, and are swallowed at the border.
  float pad = texture2D(uPadMask, vUv).r;
  vec2 border = min(vUv, 1.0 - vUv) / (uTexel * 24.0);
  h *= mix(0.9955, 0.93, pad) * mix(0.9, 1.0, clamp(min(border.x, border.y), 0.0, 1.0));
  vec2 xz = (vec2(vUv.x, 1.0 - vUv.y) - 0.5) * 2.0 * uFieldHalf;
  for (int i = 0; i < 12; i++) {
    if (i >= uCount) break;
    vec4 imp = uImpulse[i];
    vec2 d = (xz - imp.xy) / imp.z;
    float r2 = dot(d, d);
    h -= imp.w * 0.004 * exp(-r2) * cos(sqrt(r2) * 2.4);
  }
  gl_FragColor = vec4(h, state.r, 0.0, 1.0);
}
`;

// The surface, seen from above. Slopes come from the ripple field plus a restless small chop;
// they bend the view of what is underneath and swing the reflection of sky and leaves about.
export const SURFACE_FRAG = /* glsl */`
${SKY}
${DISPLAY}
uniform sampler2D uUnder;
uniform sampler2D uRipple;
uniform sampler2D uPadMask;
uniform vec2 uHalf;                         // half extents of the water in view
uniform vec2 uFieldHalf;
uniform vec2 uTexel;
uniform float uCalm;
uniform vec4 uSplash[8];                    // x, z, age and size of each place a mouth broke the surface
uniform int uSplashCount;
varying vec2 vUv;

// Bubbles left where a mouth broke the surface: a loose cluster that pops away over a few
// seconds, each a dark bead with a bright rim on the sun side and a pinpoint glint.
vec3 bubbles(vec2 xz, float sun) {
  vec3 add = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uSplashCount) break;
    vec4 s = uSplash[i];
    vec2 p = (xz - s.xy) / s.w;
    if (dot(p, p) > 2.2) continue;
    float age = s.z;
    float seed = hash21(floor(s.xy * 997.0));
    // A wet shine where the head came up, gone in a moment.
    float wet = exp(-age * 5.0) * smoothstep(0.9, 0.2, length(p)) * (0.5 + 0.5 * vnoise(p * 9.0 + seed * 40.0));
    add += SKY_BRIGHT * 0.06 * wet;
    vec2 g = p * 5.5 + seed * 13.0;
    for (int k = 0; k < 4; k++) {
      vec2 cell = floor(g) + vec2(float(k & 1), float(k >> 1)) - 0.5;
      vec2 c = cell + 0.5 + (hash22(cell + seed) - 0.5) * 0.8;
      float h = hash21(cell + seed * 7.0);
      float r = 0.12 + 0.3 * h * h;
      float alive = step(age / ${SPLASH_LIFE.toFixed(1)}, 1.0 - h) * step(length(c / 5.5), 1.0 + 0.3 * h);
      vec2 d = (g - c) / r;
      float dd = length(d);
      float ringLit = smoothstep(1.0, 0.75, dd) * smoothstep(0.55, 0.85, dd) * (0.4 + 0.6 * max(0.0, dot(normalize(d + 1e-4), normalize(SUN_DIR.xz))));
      float glint = smoothstep(0.32, 0.0, length(d - normalize(SUN_DIR.xz) * 0.45));
      add += alive * (SKY_BRIGHT * 0.08 * ringLit + SKY_BRIGHT * 0.06 * glint + SUN * sun * glint * 0.15);
    }
  }
  return add;
}

// The broad part of the slope comes back; the fine octaves, which only the reflection needs, go
// in fine (scattering the refraction lookups that finely would also defeat the texture cache).
vec2 chop(vec2 p, float t, out vec2 fine) {
  // A handful of small wave trains crossing each other, bent a little so they never line up.
  // Bent well off straight, so crossing trains never set up a lattice.
  p += 0.22 * vec2(vnoise(p * 1.1 + t * 0.05), vnoise(p * 1.1 + 9.0 - t * 0.04)) + 0.06 * vec2(vnoise(p * 4.0 - t * 0.1), vnoise(p * 4.0 + 5.0));
  vec2 g = vec2(0.0);
  g += vec2(0.92, 0.39) * 0.016 * cos(dot(p, vec2(0.92, 0.39)) * 19.0 - t * 2.9);
  g += vec2(-0.5, 0.87) * 0.013 * cos(dot(p, vec2(-0.5, 0.87)) * 27.0 - t * 3.6 + 1.3);
  g += vec2(0.26, -0.97) * 0.011 * cos(dot(p, vec2(0.26, -0.97)) * 41.0 - t * 4.6 + 4.1);
  g += vec2(-0.81, -0.59) * 0.008 * cos(dot(p, vec2(-0.81, -0.59)) * 63.0 - t * 5.9 + 2.2);
  g += vec2(0.71, 0.71) * 0.03 * cos(dot(p, vec2(0.71, 0.71)) * 6.5 - t * 1.5 + 0.7);
  g += vec2(-0.2, 0.98) * 0.025 * cos(dot(p, vec2(-0.2, 0.98)) * 4.3 - t * 1.1 + 2.0);
  // Most of the roughness is no wave train at all but a drifting, irregular field: the slope of a
  // few octaves of noise, each sliding its own way, so nothing in it ever lines up.
  vec2 n = vec2(0.0);
  fine = vec2(0.0);
  n = vnoiseD(p * 7.0 + vec2(t * 0.35, -t * 0.27)).yz * 0.0045;
  fine = vnoiseD(p * 16.1 + vec2(t * 1.1, -t * 0.54)).yz * 0.0028 + vnoiseD(p * 37.0 + vec2(t * 1.65, -t * 0.81)).yz * 0.0018;
  // Breaths of wind roughen the water in patches that drift across the pond.
  float gust = 0.45 + 1.6 * smoothstep(0.3, 0.75, vnoise(p * 0.45 + vec2(t * 0.06, -t * 0.03)));
  fine *= gust;
  return (g * 0.35 + n) * gust;
}

vec4 underAt(vec2 uv, vec2 shift) {
  vec4 c = texture2D(uUnder, uv + shift);
  c.r = texture2D(uUnder, uv + shift * 0.95).r;
  c.b = texture2D(uUnder, uv + shift * 1.05).b;
  return c;
}

void main() {
  vec2 xz = vec2(vUv.x * 2.0 - 1.0, 1.0 - vUv.y * 2.0) * uHalf;
  vec2 fuv = xz / (2.0 * uFieldHalf) + 0.5;
  fuv.y = 1.0 - fuv.y;
  float hx = texture2D(uRipple, fuv + vec2(uTexel.x, 0.0)).r - texture2D(uRipple, fuv - vec2(uTexel.x, 0.0)).r;
  float hz = texture2D(uRipple, fuv - vec2(0.0, uTexel.y)).r - texture2D(uRipple, fuv + vec2(0.0, uTexel.y)).r;
  vec2 cell = 2.0 * uFieldHalf * uTexel;
  vec2 rings = vec2(hx / (2.0 * cell.x), hz / (2.0 * cell.y));
  vec2 fine;
  vec2 slope = rings + chop(xz, uTime, fine) * uCalm;
  fine *= uCalm;
  vec3 n = normalize(vec3(-(slope.x + fine.x), 1.0, -(slope.y + fine.y)));

  // Refraction: the deeper a thing lies, the further a slope carries its image, and the more
  // the murk between softens it.
  float d0 = texture2D(uUnder, vUv).a;
  // Deeper things are carried further, but the murk has already softened them; past half a metre
  // more carry would only tear their outlines.
  vec2 carry = slope * (0.12 + 0.6 * min(d0, 0.45));
  vec2 shift = vec2(carry.x, -carry.y) / (2.0 * uHalf);
  vec2 px = 1.0 / uRes;
  // Never quite zero: the taps also smooth the edges of the fish, which are drawn without multisampling.
  float blur = max(0.85, clamp(d0 * 11.0 - 1.6, 0.0, 12.0) * (uRes.y / 1440.0));
  // The murk softens what lies deep, never what lies above it: a tap that lands on something
  // nearer the surface than this point is left out, so a shallow fish never haloes the water.
  vec4 centre = underAt(vUv, shift);
  vec3 under = centre.rgb * 0.36;
  float weight = 0.36;
  const float GOLDEN = 2.39996;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * GOLDEN;
    float rr = sqrt((float(i) + 0.5) / 8.0) * blur;
    vec4 tap = underAt(vUv + vec2(cos(a), sin(a)) * rr * px, shift);
    float w = 0.08 * smoothstep(-0.12, -0.04, tap.a - centre.a);
    under += tap.rgb * w;
    weight += w;
  }
  under /= weight;

  // Suspended motes, a few layers deep, drifting and caught where the sun comes through.
  float sun = sunPatch(xz);
  for (int k = 0; k < 2; k++) {
    float depth = 0.12 + 0.28 * float(k);
    vec2 m = (xz + carry * depth * 3.0) * (70.0 - 22.0 * float(k)) + vec2(uTime * 0.04, -uTime * 0.025) * (1.0 + float(k)) + float(k) * 17.0;
    vec2 mi = floor(m);
    vec2 mp = hash22(mi);
    float size = 0.03 + 0.1 * pow(hash21(mi + 8.3), 3.0);
    float mote = step(0.94, hash21(mi + 3.1)) * smoothstep(size, size * 0.3, length(fract(m) - 0.2 - 0.6 * mp));
    under += mote * (0.004 + 0.05 * sun) * exp(-depth * 3.0) * vec3(0.8, 0.85, 0.75);
  }

  // Pads shade the water just beside them, away from the sun: a soft drop shadow on what is below.

  // Reflection: what the tilted water mirrors from overhead. The leaves close in over the top of
  // the frame and down its right side, where the menu bar and the icons sit, so those stay dark.
  float cosine = clamp(n.y, 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosine, 5.0);
  vec2 q = xz + (slope + fine) * 1.7;
  float leaves = canopy(q);
  vec2 frame = xz / uHalf;
  float hush = max(smoothstep(-0.6, -0.85, frame.y), smoothstep(0.6, 0.8, frame.x));
  leaves = max(leaves, hush);
  vec3 sky = SKY_BRIGHT * (0.3 + 1.0 * smoothstep(0.2, 0.8, fbm3(q * 0.9 + 3.0)));
  // The brightest sky is toward the sun: facets tilted that way catch it, so every ring and
  // ripple is lit on one side.
  sky *= 1.0 + 3.0 * max(0.0, dot(-n.xz, normalize(SUN_DIR.xz)));
  // Leaves overhead: mostly in their own shade, a few lit through by the sun.
  vec2 lq = mat2(0.8, -0.6, 0.6, 0.8) * q;
  float lit = smoothstep(0.55, 0.75, fbm3(lq * 4.0 + 1.7) + 0.25 * (vnoise(lq * 23.0) - 0.5)) * (1.0 - hush * 0.8);
  vec3 foliage = LEAF_DARK + (vec3(0.1, 0.15, 0.06) * fbm3(lq * 11.0) + vec3(0.25, 0.32, 0.1) * lit) * (1.0 - hush * 0.85);
  // Sky seen past the leaves picks up a little of their green.
  vec3 overhead = mix(mix(sky, sky * vec3(0.85, 1.0, 0.8), 0.35) * 1.2, foliage, leaves);
  // Over something bright, a fish near the surface, the mirrored sky and leaves show as a veil
  // across it the way they do in a photograph exposed for the fish: the reflection is laid on more
  // strongly there and dims what is under the dark leaf shapes a little.
  float bright = smoothstep(0.04, 0.4, dot(under, vec3(0.3, 0.5, 0.2)));
  vec3 colour = under * (1.0 - fresnel) * (1.0 - 0.18 * bright * leaves) + overhead * fresnel * (1.0 + 1.6 * bright);

  // Rings and wakes: their crests tilt toward the open sky and show as fine bright lines with a
  // dark trough beside them, even where the water otherwise mirrors only leaves.
  float crest = dot(-rings, normalize(SUN_DIR.xz + vec2(0.0, 0.3)));
  // A steep crest is lit only along its shoulder, so a big swell shows as lines, never a band.
  colour += SKY_BRIGHT * 0.025 * smoothstep(0.006, 0.04, crest) * smoothstep(0.25, 0.08, crest) * (1.0 - hush * 0.6);
  colour *= 1.0 - 0.25 * smoothstep(0.006, 0.04, -crest) * smoothstep(0.25, 0.08, -crest);

  // Sun glitter where a facet of the water throws the sun straight up at the eye.
  vec3 r = reflect(vec3(0.0, -1.0, 0.0), n);
  float glint = pow(max(0.0, dot(r, SUN_DIR)), 500.0) * sun * (1.0 - hush);
  colour += SUN * glint * 6.0;

  // Dust and pollen riding on the film.
  vec2 g = xz * 34.0 + vec2(uTime * 0.02, uTime * 0.013);
  vec2 gi = floor(g);
  vec2 gp = hash22(gi);
  float speck = step(0.93, hash21(gi + 7.7)) * smoothstep(0.06, 0.015, length(fract(g) - 0.15 - 0.7 * gp));
  colour += speck * (0.008 + 0.1 * sun) * vec3(0.9, 0.85, 0.7);
  // Bits of leaf and seed husk floating on the film, here and there.
  vec2 b = xz * 9.0 + vec2(uTime * 0.012, uTime * 0.008) + 31.0;
  vec2 bi = floor(b), bp = hash22(bi + 1.7);
  vec2 bl = fract(b) - 0.2 - 0.6 * bp;
  float ba = hash21(bi + 2.2) * 6.28;
  bl = mat2(cos(ba), sin(ba), -sin(ba), cos(ba)) * bl;
  float bit = step(0.965, hash21(bi + 5.5)) * smoothstep(0.05, 0.03, length(bl * vec2(1.0, 2.5 + 3.0 * bp.x)));
  colour = mix(colour, vec3(0.012, 0.009, 0.005) + vec3(0.06, 0.035, 0.01) * sun, bit * (1.0 - hush));

  colour += bubbles(xz, sun);


  gl_FragColor = vec4(display(colour), 1.0);
}
`;

// Lily pads. One instance each: iPlace is x, z, radius and turn; iLook is seed, age, lift, notch.
export const PAD_VERT = /* glsl */`
attribute vec4 iPlace;
attribute vec4 iLook;
varying vec2 vPolar;
varying vec2 vWorld;
varying vec4 vLook;
varying float vRim;
void main() {
  float notch = iLook.w;
  float theta = mix(notch, 6.28318530718 - notch, position.x) + iPlace.w;
  float seed = iLook.x * 40.0;
  // Not quite a circle: the rim wanders, and the lobes either side of the notch round off.
  // Each leaf a little lopsided, then a wandering edge on top.
  float rim = 1.0 + 0.06 * sin(position.x * 6.283 + seed * 2.0) + 0.03 * sin(position.x * 12.566 * 1.5 + seed) + 0.02 * sin(position.x * 12.566 * 4.0 + seed * 1.7) + 0.01 * sin(position.x * 12.566 * 9.0 + seed * 2.3) + 0.005 * sin(position.x * 12.566 * 17.0 + seed * 3.1);
  // The lobes either side of the slit round off a little at their tips.
  // The lobes either side of the slit run out to points, and sometimes cross.
  float lobe = 1.0 + 0.03 * (smoothstep(0.04, 0.0, position.x) + smoothstep(0.96, 1.0, position.x)) * position.y;
  float rho = position.y * iPlace.z * rim * lobe;
  // Not quite round: a little longer one way than the other.
  vec2 local = rho * vec2(cos(theta - iPlace.w), sin(theta - iPlace.w)) * vec2(1.06, 0.95);
  vec2 xz = iPlace.xy + vec2(cos(iPlace.w) * local.x - sin(iPlace.w) * local.y, sin(iPlace.w) * local.x + cos(iPlace.w) * local.y);
  vPolar = vec2(position.x, position.y);
  vWorld = xz;
  vLook = iLook;
  vRim = rim;
  // The rim turns up a little, more on old pads.
  float curl = smoothstep(0.82, 1.0, position.y) * (0.004 + 0.006 * iLook.y);
  // Later pads lie over earlier ones where they overlap.
  float y = 0.004 + 0.0004 * float(gl_InstanceID) + 0.006 * iLook.z * position.y + curl + 0.0002 * position.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
}
`;
export const PAD_FRAG = /* glsl */`
${SKY}
${DISPLAY}
varying vec2 vPolar;
varying vec2 vWorld;
varying vec4 vLook;
varying float vRim;
void main() {
  float a = vPolar.x, r = vPolar.y;
  float seed = vLook.x, age = vLook.y;
  // Veins fan from the stem, forking as they go: raised a little, so they catch light on one side.
  float fan = a * 21.0 + 0.8 * sin(a * 7.0 + seed * 30.0) + 0.15 * sin(r * 9.0 + a * 40.0);
  float main = abs(fract(fan) - 0.5) * 2.0;
  float fork = abs(fract(fan * 2.0 + 0.25) - 0.5) * 2.0;
  float vein = smoothstep(0.12 + 0.06 * r, 0.02, main) * smoothstep(0.03, 0.15, r) * smoothstep(1.0, 0.75, r);
  vein = max(vein, 0.5 * smoothstep(0.14, 0.02, fork) * smoothstep(0.45, 0.6, r) * smoothstep(0.98, 0.85, r));
  float aa = clamp(1.5 - fwidth(fan) * 3.0, 0.0, 1.0);
  vein *= aa;
  float mottle = fbm3(vWorld * 18.0 + seed * 50.0);
  float fine = vnoise(vWorld * 160.0 + seed * 9.0);
  // A muted, slightly bluish green with a waxy bloom; young ones are small and bronze; old ones
  // pale and go brown in patches from the rim.
  vec3 green = mix(vec3(0.05, 0.078, 0.036), vec3(0.072, 0.1, 0.05), mottle);
  green = mix(green, vec3(0.078, 0.105, 0.056), 0.4 * smoothstep(0.25, 0.0, r));
  // Each leaf its own green, from olive through blue-green to yellowing.
  float hue = fract(seed * 7.13);
  green *= mix(vec3(0.92, 1.0, 1.08), vec3(1.12, 1.02, 0.78), hue);
  // Darker where water lies along the slit and round the heart of the leaf.
  green *= 1.0 - 0.25 * smoothstep(0.08, 0.0, min(a, 1.0 - a) * r * 6.0) - 0.15 * smoothstep(0.3, 0.05, r);
  // Water standing on the leaf darkens it in soft pools.
  green *= 1.0 - 0.18 * smoothstep(0.6, 0.72, fbm3(vWorld * 5.0 + seed * 21.0));
  vec3 young = mix(vec3(0.11, 0.05, 0.03), vec3(0.08, 0.075, 0.03), mottle);
  vec3 albedo = mix(young, green, smoothstep(0.08, 0.3, age));
  float tired = smoothstep(0.65, 1.0, age);
  // The heart where the stem joins: a darker reddish spot.
  albedo = mix(albedo, vec3(0.07, 0.04, 0.03), smoothstep(0.08, 0.02, r) * 0.7);
  float blotch = smoothstep(0.58, 0.72, fbm3(vWorld * 8.0 + seed * 77.0) + 0.3 * r * tired);
  albedo = mix(albedo, vec3(0.09, 0.08, 0.035), blotch * (0.1 + 0.4 * tired));
  // Old leaves yellow and then brown from the margin inward.
  float margin = smoothstep(0.55 - 0.3 * tired, 1.0, r + 0.15 * (fbm3(vWorld * 9.0 + seed * 13.0) - 0.5));
  margin *= smoothstep(0.35, 0.7, vnoise(vec2(a * 6.0, seed * 7.0)));
  albedo = mix(albedo, vec3(0.16, 0.13, 0.04), margin * tired * 0.8);
  float rot = smoothstep(0.66, 0.8, fbm3(vWorld * 14.0 + seed * 13.0) + 0.35 * smoothstep(0.8, 1.0, r)) * tired * smoothstep(0.6, 1.0, r);
  albedo = mix(albedo, vec3(0.1, 0.06, 0.025), rot);
  albedo *= 1.0 + 0.22 * vein;
  // Dust and bits of debris settled on the leaf.
  vec2 dp = vWorld * 260.0 + seed * 40.0;
  float dust = step(0.985, hash21(floor(dp))) * smoothstep(0.35, 0.15, length(fract(dp) - 0.5));
  albedo = mix(albedo, vec3(0.12, 0.1, 0.07), dust * 0.7);
  albedo *= 0.95 + 0.1 * fine;
  // The very rim is thin, reddish, and nibbled here and there; a few holes eaten through.
  // Mostly a smooth rim, with an occasional nick, and on old leaves a ragged hole or two.
  float bite = smoothstep(0.72, 0.8, vnoise(vec2(a * 30.0, seed * 9.0))) * (0.3 + tired);
  float rimAt = 0.993 - 0.035 * bite * (0.6 + 0.4 * vnoise(vec2(a * 40.0, seed)));
  float cover = clamp((rimAt - r) / max(fwidth(r), 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;
  float hole = smoothstep(0.8, 0.84, fbm3(vWorld * 24.0 + seed * 31.0) + 0.08 * vnoise(vWorld * 140.0)) * tired * smoothstep(0.3, 0.5, r) * smoothstep(0.95, 0.85, r);
  if (hole > 0.5) discard;
  float holeRim = smoothstep(0.74, 0.8, fbm3(vWorld * 24.0 + seed * 31.0) + 0.08 * vnoise(vWorld * 140.0)) * tired * smoothstep(0.3, 0.5, r);
  albedo = mix(albedo, vec3(0.18, 0.15, 0.05), holeRim * 0.7);
  // The turned-up rim shows a sliver of the paler, reddish underside.
  float edge = smoothstep(0.975, 0.998, r);
  albedo = mix(albedo, albedo * vec3(1.1, 1.0, 0.85), edge * 0.5);
  // Leaf normal: a gentle dish, the turned-up rim, the raised veins and the puckers between them.
  vec2 dir = vec2(cos(a * 6.28), sin(a * 6.28));
  vec3 n = vec3((vnoise(vWorld * 25.0 + seed) - 0.5) * 0.12, 1.0, (vnoise(vWorld * 25.0 + seed + 5.0) - 0.5) * 0.12);
  n.xz -= dir * (0.03 + 0.1 * smoothstep(0.9, 1.0, r));
  n.xz += dir.yx * vec2(-1.0, 1.0) * (fract(fan) - 0.5) * 0.12 * vein;
  n = normalize(n);
  float sun = sunPatch(vWorld);
  float facing = max(0.0, dot(n, SUN_DIR));
  vec3 h = normalize(SUN_DIR + vec3(0.0, 1.0, 0.0));
  float nh = max(0.0, dot(n, h));
  // Waxy: a soft sheen of the sky over the whole leaf and a sharper one from the sun.
  float leavesOver = canopy(vWorld);
  vec3 skyMirror = mix(SKY_BRIGHT, LEAF_DARK, leavesOver) * 0.016 * (0.4 + 0.6 * smoothstep(-0.8, 0.8, sin(a * 6.283 + seed * 6.0) * r));
  vec3 colour = albedo * (SUN * sun * facing + SKY_LIGHT * 0.85 * (0.5 + 0.5 * n.y)) + skyMirror
    + SUN * sun * (pow(nh, 30.0) * 0.06 + pow(nh, 6.0) * 0.02) + SKY_LIGHT * 0.025 * pow(max(0.0, n.y), 40.0);
  // Beads of water sit on some pads and catch the light.
  vec2 b = vWorld * 55.0 + seed * 17.0;
  vec2 bi = floor(b);
  float bead = step(0.95, hash21(bi + seed)) * smoothstep(0.14, 0.07, length(fract(b) - 0.3 - 0.4 * hash22(bi)));
  colour = mix(colour, colour * 0.6, bead * 0.5);
  colour += bead * smoothstep(0.06, 0.0, length(fract(b) - 0.28 - 0.4 * hash22(bi))) * (0.15 + 1.5 * sun) * vec3(1.0, 0.98, 0.9) * smoothstep(0.9, 0.6, r);
  gl_FragColor = vec4(display(colour), cover);
}
`;

// The same pads as flat white discs, seen from straight above: where the surface is covered.
export const PAD_MASK_FRAG = /* glsl */`
varying vec2 vPolar;
void main() { gl_FragColor = vec4(1.0); }
`;

// Water lily flowers: whorls of pointed petals round a boss of yellow stamens. One instance per
// petal: iPlace is the flower's x, z, the petal's turn and its length; iLook is tilt, width, whorl
// and seed. The whorl is -1 for the boss in the middle.
export const PETAL_VERT = /* glsl */`
attribute vec4 iPlace;
attribute vec4 iLook;
varying vec2 vPetal;
varying vec4 vLook;
varying vec2 vWorld;
varying float vHeight;
void main() {
  float along = position.y, across = position.x;
  float len = iPlace.w, tilt = iLook.x;
  // A boat-shaped petal: widest a third of the way out, drawn to a point, cupped along its length.
  float width = iLook.y * len * pow(sin(3.14159 * pow(along, 0.62)), 0.8) * (1.0 - 0.25 * along);
  // Petals rise from the rim of the boss of stamens, not from under it.
  float out_ = along * len * cos(tilt) + len * 0.4 * step(0.5, iLook.z) * step(iLook.z, 4.5);
  float up = along * len * sin(tilt) + 0.012 * across * across * (1.0 - along) + 0.004;
  vec2 dir = vec2(cos(iPlace.z), sin(iPlace.z));
  vec2 xz = iPlace.xy + dir * out_ + vec2(-dir.y, dir.x) * across * width;
  if (iLook.z < -1.5) { xz = iPlace.xy + vec2(across, along * 2.0 - 1.0) * len; up = -0.0055; }
  else if (iLook.z > 5.5) { vec2 dir = vec2(cos(iPlace.z), sin(iPlace.z)); xz = iPlace.xy + (dir * (along * 2.0 - 1.0) * 1.6 + vec2(-dir.y, dir.x) * across * 0.7) * len; up = 0.025; }
  else if (iLook.z < -0.5) { xz = iPlace.xy + vec2(across, along * 2.0 - 1.0) * len; up = 0.03; }
  else if (iLook.z > 4.5 && iLook.z < 5.5) up = along * len * 0.05 + 0.001;
  vPetal = position.xy;
  vLook = iLook;
  vWorld = xz;
  vHeight = up;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, 0.01 + up, xz.y, 1.0);
}
`;
export const PETAL_FRAG = /* glsl */`
${SKY}
${DISPLAY}
varying vec2 vPetal;
varying vec4 vLook;
varying vec2 vWorld;
varying float vHeight;
void main() {
  float along = vPetal.y, across = vPetal.x;
  float sun = sunPatch(vWorld);
  vec3 colour;
  float alpha = 1.0;
  if (vLook.z < -1.5) {
    // The shaded water under the flower.
    float d = length(vec2(across, along * 2.0 - 1.0));
    colour = vec3(0.0);
    alpha = 0.75 * smoothstep(1.0, 0.3, d);
  } else if (vLook.z > 5.5) {
    // A closed bud seen from above: a little green dome, its sepals meeting in seams at the tip.
    vec2 c = vec2(across, along * 2.0 - 1.0);
    float d = length(c);
    if (d > 1.0) discard;
    float dome = sqrt(max(0.0, 1.0 - d * d));
    float seam = smoothstep(0.08, 0.0, abs(sin(atan(c.y, c.x) * 2.0 + 0.6))) * smoothstep(0.1, 0.5, d);
    float streak = smoothstep(0.55, 0.85, vnoise(vec2(across * 9.0, along * 2.0) + vLook.w * 11.0));
    colour = mix(vec3(0.05, 0.075, 0.03), vec3(0.11, 0.085, 0.04), smoothstep(0.3, 1.0, d)) * (0.5 + 0.6 * dome) * (1.0 - 0.4 * seam);
    colour = mix(colour, vec3(0.09, 0.035, 0.06) * (0.5 + 0.6 * dome), streak * 0.6);
    colour *= SUN * sun * 0.6 + SKY_LIGHT * 0.75;
    colour += SKY_LIGHT * 0.04 * smoothstep(0.35, 0.0, length(c - vec2(-0.3, -0.3)));
  } else if (vLook.z > 4.5) {
    // A sepal: green above, going bronze at the tip.
    colour = mix(vec3(0.05, 0.08, 0.03), vec3(0.09, 0.07, 0.035), along) * (SUN * sun * 0.6 + SKY_LIGHT * 0.6) * (0.8 + 0.2 * smoothstep(0.0, 0.6, along));
  } else if (vLook.z < -0.5) {
    // The boss: a crowd of stamens.
    vec2 c = vec2(across, along * 2.0 - 1.0);
    float d = length(c);
    if (d > 1.0) discard;
    float stamens = 0.5 + 0.5 * sin(atan(c.y, c.x) * 26.0 + d * 5.0 + vnoise(c * 6.0) * 3.0);
    stamens = mix(stamens, 0.3, smoothstep(0.35, 0.0, d));
    colour = mix(vec3(0.6, 0.32, 0.02), vec3(0.9, 0.66, 0.1), stamens) * (0.55 + 0.45 * smoothstep(1.0, 0.2, d));
    colour *= SUN * sun * 0.5 + SKY_LIGHT * 0.5;
  } else {
    // Petals are thin: light comes through them, and each shades the one beneath at its base.
    float crease = smoothstep(0.5, 0.0, abs(across)) * 0.12;
    float pink = step(5.0, vLook.w);
    vec3 base = mix(vec3(0.6, 0.57, 0.46), vec3(0.55, 0.2, 0.3), pink), tip = mix(vec3(0.7, 0.68, 0.6), vec3(0.7, 0.45, 0.52), pink);
    vec3 albedo = mix(base, tip, smoothstep(0.25, 1.0, along + 0.2 * abs(across)));
    albedo *= 0.9 + 0.1 * vnoise(vec2(across * 9.0, along * 3.0) + vLook.w * 20.0) - crease * (1.0 - along);
    float inner = vLook.z / 3.0;
    float shade = mix(0.35, 1.0, smoothstep(0.0, 0.6, along)) * mix(1.0, 0.75, inner * (1.0 - along));
    colour = albedo * shade * (SUN * sun * (0.6 + 0.25 * inner) + SKY_LIGHT * 0.75);
  }
  gl_FragColor = vec4(display(colour), alpha);
}
`;

// Pellets: small brown grains riding on the film, each in its dimple. iPlace is x, z, radius and how whole it is.
export const PELLET_VERT = /* glsl */`
attribute vec4 iPlace;
varying vec2 vDisc;
varying vec2 vWorld;
varying float vWhole;
void main() {
  vec2 xz = iPlace.xy + position.xy * iPlace.z * 2.2;
  vDisc = position.xy * 2.2;
  vWorld = xz;
  vWhole = iPlace.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, 0.003, xz.y, 1.0);
}
`;
export const PELLET_FRAG = /* glsl */`
${SKY}
${DISPLAY}
varying vec2 vDisc;
varying vec2 vWorld;
varying float vWhole;
void main() {
  float d = length(vDisc);
  if (d > 2.2) discard;
  float sun = sunPatch(vWorld);
  // The grain itself, lit as a little ball, and the bright and dark ring of the meniscus round it.
  float ball = smoothstep(1.0, 0.86, d);
  vec3 n = normalize(vec3(vDisc.x, sqrt(max(0.0, 1.0 - d * d)), vDisc.y));
  vec3 grain = mix(vec3(0.2, 0.11, 0.045), vec3(0.3, 0.19, 0.08), vnoise(vWorld * 900.0)) * (SUN * sun * max(0.0, dot(n, SUN_DIR)) + SKY_LIGHT * 0.8);
  grain += SUN * sun * pow(max(0.0, dot(n, normalize(SUN_DIR + vec3(0.0, 1.0, 0.0)))), 30.0) * 0.25;
  float ring = smoothstep(2.2, 1.5, d) * smoothstep(1.0, 1.3, d);
  float lit = max(0.0, dot(normalize(vDisc), normalize(SUN_DIR.xz)));
  vec3 colour = mix(vec3(0.0), display(grain), ball);
  float alpha = max(ball, ring * 0.35) * vWhole;
  vec3 meniscus = display(vec3(0.02) + SKY_BRIGHT * 0.1 * lit * (0.3 + 0.7 * sun));
  gl_FragColor = vec4(mix(meniscus, colour, ball), alpha);
}
`;
