// Shaders for the plasma globe. The scene is drawn as linear HDR light into a half-float target,
// then bloomed, tone mapped and dithered once at the end.
import { STREAMERS } from './plasma.js';

// Emission colour of a channel by position s along it (0 at the electrode, 1 at the glass). The
// gas is a neon-heavy noble mix: the hot, dense stem near the electrode radiates the violet and
// blue argon and xenon lines, and the cooler outer channel the red and orange neon lines.
const SPECTRUM = /* glsl */`
vec3 spectrum(float s) {
  vec3 stem = vec3(0.10, 0.20, 1.0);
  vec3 mid = vec3(0.36, 0.12, 1.0);
  vec3 tip = vec3(1.0, 0.13, 0.30);
  return mix(mix(stem, mid, smoothstep(0.05, 0.5, s)), tip, smoothstep(0.7, 1.0, s));
}
`;

// Glowing line pieces: one instance per segment, drawn as a capsule of gaussian cross-section.
// Overlaps between pieces of one channel take the maximum, so joints do not beam brighter.
// Thin-lens defocus widens a channel in proportion to its distance from the focal plane while
// conserving its energy.
export const RIBBON_VERT = /* glsl */`
uniform vec2 uRes;
uniform float uFocus;
uniform float uBlur;
uniform float uGhost;
uniform vec3 uBackPoint;
uniform vec3 uBackNormal;
attribute vec4 aP0;
attribute vec4 aP1;
attribute vec4 aI;
flat varying vec2 vA;
flat varying vec2 vB;
flat varying vec2 vSigma;
flat varying vec4 vLight;
void main() {
  vec2 aCorner = position.xy;
  vec3 w0 = aP0.xyz;
  vec3 w1 = aP1.xyz;
  // The ghost is the channel's faint reflection in the inside of the back wall, seen through the gas.
  if (uGhost > 0.5) {
    w0 -= 2.0 * dot(w0 - uBackPoint, uBackNormal) * uBackNormal;
    w1 -= 2.0 * dot(w1 - uBackPoint, uBackNormal) * uBackNormal;
  }
  vec4 c0 = projectionMatrix * viewMatrix * vec4(w0, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(w1, 1.0);
  vec2 p0 = (c0.xy / c0.w * 0.5 + 0.5) * uRes;
  vec2 p1 = (c1.xy / c1.w * 0.5 + 0.5) * uRes;
  float focal = projectionMatrix[1][1] * 0.5 * uRes.y;
  float s0 = aP0.w * focal / c0.w;
  float s1 = aP1.w * focal / c1.w;
  float k0 = uBlur * abs(c0.w - uFocus) / c0.w;
  float k1 = uBlur * abs(c1.w - uFocus) / c1.w;
  float e0 = sqrt(s0 * s0 + k0 * k0 * 0.16 + 0.36);
  float e1 = sqrt(s1 * s1 + k1 * k1 * 0.16 + 0.36);
  vec2 d = p1 - p0;
  float len = length(d);
  d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  float ext = 3.6 * max(e0, e1) + 1.5;
  vec2 pos = mix(p0, p1, aCorner.x) + d * (aCorner.x * 2.0 - 1.0) * ext + vec2(-d.y, d.x) * aCorner.y * ext;
  vA = p0; vB = p1; vSigma = vec2(e0, e1);
  float gain = uGhost > 0.5 ? 0.12 : 1.0;
  vLight = vec4(aI.x * s0 / e0 * gain, aI.y * s1 / e1 * gain, aI.z, aI.w);
  gl_Position = vec4(pos / uRes * 2.0 - 1.0, mix(c0.z / c0.w, c1.z / c1.w, aCorner.x), 1.0);
}
`;

export const RIBBON_FRAG = /* glsl */`
flat varying vec2 vA;
flat varying vec2 vB;
flat varying vec2 vSigma;
flat varying vec4 vLight;
uniform float uCoreMax;
${SPECTRUM}
void main() {
  vec2 ab = vB - vA;
  float l2 = dot(ab, ab);
  float h = l2 > 1e-6 ? clamp(dot(gl_FragCoord.xy - vA, ab) / l2, 0.0, 1.0) : 0.0;
  vec2 q = gl_FragCoord.xy - vA - ab * h;
  float sigma = mix(vSigma.x, vSigma.y, h);
  float i = mix(vLight.x, vLight.y, h);
  float s = mix(vLight.z, vLight.w, h);
  float d2 = dot(q, q);
  // A bright thin core in a violet sheath: the sheath is the cooler gas around the hot channel.
  float sheath = exp(-0.5 * d2 / (sigma * sigma));
  float sc = clamp(0.3 * sigma, 0.7, uCoreMax);
  float core = exp(-0.5 * d2 / (sc * sc));
  vec3 hot = mix(vec3(0.30, 0.42, 1.0), vec3(1.0, 0.40, 0.60), smoothstep(0.7, 1.0, s));
  vec3 light = spectrum(s) * (0.42 * i * sheath) + hot * (0.9 * i * core);
  // A channel carrying a finger's current is hot enough to burn white.
  light += vec3(1.0, 0.9, 1.0) * smoothstep(1.0, 2.6, i) * core * 1.3;
  gl_FragColor = vec4(light, 1.0);
}
`;

// Where a channel lands the discharge spreads over the glass: a soft pink brush, longer along the
// direction the channel arrives from. Quads lie in the glass tangent plane, so brushes near the
// silhouette are seen edge-on and pile up into the bright rim.
export const FOOT_VERT = /* glsl */`
uniform float uFocus;
uniform float uBlur;
uniform vec2 uRes;
attribute vec4 aFoot;
attribute vec4 aTangent;
varying vec2 vUv;
varying float vStrength;
varying float vDepth;
void main() {
  vec2 aCorner = position.xy;
  vec3 n = normalize(aFoot.xyz);
  vec3 t = aTangent.yzw - n * dot(aTangent.yzw, n);
  t = length(t) > 1e-5 ? normalize(t) : normalize(cross(n, vec3(0.0, 1.0, 0.001)));
  vec3 b = cross(n, t);
  vec4 c = projectionMatrix * viewMatrix * vec4(aFoot.xyz, 1.0);
  float focal = projectionMatrix[1][1] * 0.5 * uRes.y;
  float coc = uBlur * abs(c.w - uFocus) / c.w * 0.4 * c.w / focal;
  float size = sqrt(aFoot.w * aFoot.w + coc * coc);
  vec3 world = aFoot.xyz * 1.004 + (t * aCorner.x * 1.7 + b * aCorner.y) * size * 3.0;
  vUv = aCorner * vec2(1.7, 1.0) * 3.0;
  vStrength = aTangent.x * (aFoot.w * aFoot.w) / (size * size);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const FOOT_FRAG = /* glsl */`
varying vec2 vUv;
varying float vStrength;
void main() {
  float r2 = dot(vUv, vUv);
  float halo = exp(-r2 * 1.4);
  float hot = exp(-r2 * 6.0);
  vec3 white = vec3(1.0, 0.75, 0.9);
  vec3 light = vec3(1.0, 0.14, 0.28) * halo * 0.3 + mix(vec3(1.0, 0.5, 0.7), white, smoothstep(1.2, 2.6, vStrength)) * hot * 0.3;
  light += white * pow(hot, 2.0) * smoothstep(1.2, 2.6, vStrength) * 1.5;
  gl_FragColor = vec4(light * vStrength, 1.0);
}
`;

export const ELECTRODE_VERT = /* glsl */`
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vView = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// The electrode is dark glass-like metal that glows where streamers attach: each root has a
// bright pit ringed by a corona, and the rest of the ball carries the faint red glow of the gas.
export const ELECTRODE_FRAG = /* glsl */`
uniform vec4 uRoots[${STREAMERS}];
uniform float uEnergy;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vLocal);
  vec3 v = normalize(vView);
  float mu = abs(dot(n, v));
  float fres = pow(1.0 - mu, 3.0);
  float pit = 0.0;
  float ring = 0.0;
  for (int i = 0; i < ${STREAMERS}; i++) {
    float a = uRoots[i].w * uRoots[i].w;
    vec3 r = uRoots[i].xyz;
    float c = dot(n, r);
    float theta = acos(clamp(c, -1.0, 1.0));
    // Each attachment is a bright pit inside a corona whose radius and swirl differ by root.
    float seed = fract(sin(float(i) * 12.9898) * 43758.5453);
    vec3 t = normalize(cross(r, vec3(0.0, 1.0, 0.03)));
    vec3 d = n - r * c;
    float phi = atan(dot(d, cross(r, t)), dot(d, t));
    float radius = 0.16 + 0.14 * seed;
    pit += a * exp(-theta * theta / 0.004);
    ring += a * exp(-pow(theta - radius, 2.0) / 0.0035) * (0.5 + 0.5 * sin(3.0 * phi + 9.0 * theta + 6.0 * seed));
  }
  // A dark glassy ball lit from outside by the discharge around it: red at the limb, black at the
  // centre, with a bright pit and a soft corona where each channel attaches.
  vec3 body = mix(vec3(0.05, 0.004, 0.02), vec3(0.75, 0.10, 0.32), pow(1.0 - mu, 2.4)) * (0.6 + 4.0 * uEnergy);
  vec3 light = body
    + vec3(1.0, 0.16, 0.30) * ring * 0.5
    + vec3(1.0, 0.55, 0.75) * pit * 0.8
    + vec3(0.55, 0.12, 0.42) * fres * (0.2 + uEnergy * 2.0);
  gl_FragColor = vec4(light, 1.0);
}
`;

// The stem, base and table are dark: they show only what the plasma lights.
export const SOLID_VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const BASE_FRAG = /* glsl */`
uniform float uEnergy;
uniform vec3 uTint;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toLamp = -vWorld;
  float d2 = dot(toLamp, toLamp);
  vec3 l = toLamp / sqrt(d2);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;   // lathe normals face either way
  float diffuse = max(dot(n, l), 0.0) / (0.4 + d2 * 0.55);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 60.0) * max(dot(n, l), 0.0);
  // The seat ring lights the shoulder of the base from above.
  float seat = exp(-max(-0.93 - vWorld.y, 0.0) * 14.0) * step(vWorld.y, -0.9);
  float height = exp(-max(-0.93 - vWorld.y, 0.0) * 1.3);
  vec3 light = uTint * uEnergy * (0.10 * diffuse + 0.9 * fres * height) + vec3(1.0, 0.5, 0.8) * uEnergy * spec * 0.2
    + vec3(0.12, 0.30, 1.0) * (0.002 + uEnergy * 0.16) * seat * (0.4 + 0.6 * max(n.y, 0.0) + 0.5 * fres);
  gl_FragColor = vec4(light, 1.0);
}
`;

export const SEAT_FRAG = /* glsl */`
uniform float uEnergy;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  // A tube lit from inside: brightest where its surface faces the viewer.
  float mu = abs(dot(normalize(vNormal), normalize(cameraPosition - vWorld)));
  gl_FragColor = vec4(vec3(0.10, 0.28, 1.0) * (0.02 + uEnergy * 1.8) * (0.25 + 0.75 * pow(mu, 2.0)), 1.0);
}
`;

// The stem is an insulating glass tube around the supply wire: mostly clear, with dark edges and a
// pink sheen where the plasma light catches it.
export const STEM_FRAG = /* glsl */`
uniform float uEnergy;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float mu = abs(dot(normalize(vNormal), normalize(cameraPosition - vWorld)));
  float edge = pow(1.0 - mu, 2.0);
  gl_FragColor = vec4(vec3(0.9, 0.2, 0.5) * uEnergy * edge * 0.8, 1.0);
}
`;

export const TABLE_FRAG = /* glsl */`
uniform float uEnergy;
uniform vec3 uTint;
uniform vec2 uRes;
uniform sampler2D uMirror;
uniform float uHeight;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 v = normalize(cameraPosition - vWorld);
  float cosine = max(v.y, 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - cosine, 5.0);
  vec2 xz = vWorld.xz;
  float d2 = dot(xz, xz);
  // Diffuse pool under a point source at the globe centre.
  float pool = uHeight / pow(uHeight * uHeight + d2, 1.5);
  vec2 uv = gl_FragCoord.xy / uRes;
  // A rough surface blurs its reflection more the farther the reflected light travels.
  vec3 mirror = vec3(0.0);
  float radius = 0.004 + 0.012 * clamp(length(xz) * 0.25, 0.0, 1.0);
  float total = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 2.399963;
    float r = sqrt((float(i) + 0.5) / 12.0);
    vec2 o = vec2(cos(a), sin(a)) * r * radius * vec2(uRes.y / uRes.x, 1.0) * vec2(1.0, 2.6);
    mirror += texture2D(uMirror, uv + o).rgb;
    total += 1.0;
  }
  mirror /= total;
  float fade = exp(-d2 * 0.09);
  vec3 light = (uTint * uEnergy * pool * 0.7 + mirror * fres * 1.5) * fade;
  gl_FragColor = vec4(light, 1.0);
}
`;

// The glass shell only adds light: reflections of the plasma and the pink wash a finger draws
// through the gas. A hollow shell of thin glass does not visibly refract, so nothing behind it
// bends.
export const GLASS_VERT = SOLID_VERT;
export const GLASS_FRAG = /* glsl */`
uniform float uEnergy;
uniform float uHaze;
uniform vec3 uContact;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float mu = abs(dot(n, v));
  float fres = 0.04 + 0.96 * pow(1.0 - mu, 5.0);
  float rim = pow(1.0 - mu, 2.5);
  float edge = pow(1.0 - mu, 9.0);
  float toward = smoothstep(0.35, 1.0, dot(normalize(vWorld), uContact));
  vec3 glow = vec3(0.9, 0.16, 0.42) * uEnergy * (0.006 + 0.03 * rim)
    + vec3(0.55, 0.30, 1.0) * uEnergy * (fres * 0.4 + edge * 1.4);
  vec3 haze = vec3(1.0, 0.34, 0.5) * uHaze * (0.15 + 0.85 * toward * toward) * (0.35 + 0.65 * rim + 0.3 * mu);
  gl_FragColor = vec4(glow + haze, 1.0);
}
`;

export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Bloom is a pyramid of 13-tap downsamples and tent upsamples: the scattering of bright plasma
// in the glass, the air and the eye.
export const DOWN_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 a = texture2D(uSrc, vUv + uTexel * vec2(-2.0, -2.0)).rgb, b = texture2D(uSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb, c = texture2D(uSrc, vUv + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 d = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb, e = texture2D(uSrc, vUv).rgb, f = texture2D(uSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 g = texture2D(uSrc, vUv + uTexel * vec2(-2.0, 2.0)).rgb, h = texture2D(uSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb, i = texture2D(uSrc, vUv + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 j = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb, k = texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 l = texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb, m = texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}
`;

export const UP_FRAG = /* glsl */`
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb
    + 2.0 * (texture2D(uSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb
      + texture2D(uSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb)
    + 4.0 * texture2D(uSrc, vUv).rgb;
  gl_FragColor = vec4(texture2D(uBase, vUv).rgb + s / 16.0 * uWeight, 1.0);
}
`;

export const OUTPUT_FRAG = /* glsl */`
uniform sampler2D uBeauty;
uniform sampler2D uBloom;
uniform vec3 uHalo;
uniform float uExposure;
uniform float uBloomGain;
uniform float uFrame;
varying vec2 vUv;
vec3 filmic(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 beauty = texture2D(uBeauty, vUv).rgb;
  vec3 bloom = texture2D(uBloom, vUv).rgb * uHalo * uBloomGain;
  vec3 hdr = (beauty + bloom) * uExposure;
  vec3 mapped = filmic(hdr);
  // The filmic curve greys saturated blues; restore some of the chroma the gas actually emits.
  mapped = mix(vec3(dot(mapped, vec3(0.2126, 0.7152, 0.0722))), mapped, 1.3);
  vec3 srgb = pow(max(mapped, 0.0), vec3(1.0 / 2.2));
  // A little dither keeps the dark gradients from banding.
  srgb += (hash(gl_FragCoord.xy + uFrame) + hash(gl_FragCoord.xy * 1.7 - uFrame) - 1.0) / 255.0;
  gl_FragColor = vec4(srgb, 1.0);
}
`;
