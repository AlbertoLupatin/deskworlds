// The pond: koi, floating pellets, lily pads and the ripples they make. Pure state and rules
// with no rendering, so the behaviour can be tested in node. render.js draws what is here.
//
// World units are metres. The water surface is the plane y = 0; x runs to the right of the
// frame and z toward its bottom edge. A fish's position is its centre of mass, about a third
// of the way back from the nose, and `depth` is how far below the surface that point sits.

export const FIXED_STEP = 1 / 60;
export const SPINE_JOINTS = 25;                 // nose to the tip of the tail fin
export const SPINE_SPAN = 1.3;                  // in body lengths; the body itself is 0..1
export const COM = 0.3;                         // where along the body the position is measured
export const POND_DEPTH = 1.25;
export const WAVE = 7.8;                        // swimming wave number: a wavelength of about 0.8 body lengths
export const SPLASH_LIFE = 3;                   // s a burst of bubbles lasts after a gulp

export const PELLET = {
  radius: [0.0045, 0.006],
  life: 38,                 // s from landing to gone
  fade: 6,                  // s of that over which it soaks and breaks up
  stagger: 0.5,             // s over which a pinch lands
  spread: 0.2,              // radius of a pinch on the water
  drift: 0.008,             // m/s wander across the film
  pinch: 10,
  click: [2, 4],
  capacity: 48,
};

// One entry per fish in the pond, in the order they are added. Sizes are body lengths in metres.
// `deep` is how far below its usual cruising depth a fish keeps: most stay up where they glow,
// a couple hang back in the murk.
const CAST = [
  { variety: 'kohaku', size: 0.68, deep: 0.03 },
  { variety: 'utsuri', size: 0.6, deep: 0.22 },
  { variety: 'ogon', size: 0.56, deep: 0.06 },
  { variety: 'sanke', size: 0.64, deep: 0.2 },
  { variety: 'chagoi', size: 0.74, deep: 0.32 },
  { variety: 'tancho', size: 0.5, deep: 0.17 },
  { variety: 'showa', size: 0.58, deep: 0.01 },
  { variety: 'kohaku', size: 0.44, deep: 0.42 },
  { variety: 'sanke', size: 0.4, deep: 0.05 },
  { variety: 'ogon', size: 0.36, deep: 0.34 },
];

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; };
// Moves `value` toward `target` with a time constant, independent of the step length.
const approach = (value, target, tau, dt) => target + (value - target) * Math.exp(-dt / tau);

export function fishCount(aspect) {
  return clamp(Math.round(3.2 + aspect * 2.4), 5, CAST.length);
}

// Lily pads sit in clusters toward the corners and edges, clear of the middle of the frame and
// of the right-hand band where desktop icons live. Coordinates are fractions of the half extents.
const CLUSTERS = [
  { x: -0.82, z: 0.62, spread: [0.4, 0.42], count: 13, flower: true },
  { x: -1.0, z: -0.22, spread: [0.1, 0.22], count: 4, flower: false },
  { x: 0.08, z: 1.04, spread: [0.14, 0.08], count: 3, flower: false },
  { x: 0.56, z: 0.86, spread: [0.12, 0.12], count: 3, flower: false, scale: 0.65 },
];

export function createPads(random, halfW, halfH) {
  const pads = [], flowers = [];
  for (const cluster of CLUSTERS) {
    const cx = cluster.x * halfW, cz = cluster.z * halfH;
    const own = [];
    for (let i = 0, tries = 0; i < cluster.count && tries < 400; tries++) {
      // The first pads of a cluster are the big old ones; later ones fill in smaller.
      const radius = mix(0.2, 0.04, Math.pow(i / cluster.count, 0.6)) * (0.8 + random() * 0.4) * (cluster.scale || 1);
      const angle = random() * TAU, reach = Math.sqrt(random());
      const x = cx + Math.cos(angle) * reach * cluster.spread[0] * halfH * 1.6;
      const z = cz + Math.sin(angle) * reach * cluster.spread[1] * halfH * 1.6;
      // Pads crowd and overlap a little at the rims but never stack.
      if (pads.some((p) => Math.hypot(p.x - x, p.z - z) < Math.max(p.radius, radius) * 0.95 + Math.min(p.radius, radius) * 0.2)) continue;
      const pad = {
        x, z, radius, homeX: x, homeZ: z,
        turn: random() * TAU, seed: random(),
        // Young pads are small and bronze; a few old ones have yellowed.
        age: radius < 0.06 ? random() * 0.25 : 0.3 + random() * 0.7,
        swayPhase: random() * TAU, swayRate: 0.12 + random() * 0.12,
        lift: 0,
      };
      pads.push(pad); own.push(pad); i++;
    }
    if (cluster.flower && own.length > 2) {
      // A flower stands in a gap beside the largest pads of its cluster.
      for (let tries = 0; tries < 200; tries++) {
        const host = own[Math.floor(random() * Math.min(3, own.length))];
        const angle = random() * TAU;
        const x = host.x + Math.cos(angle) * (host.radius + 0.075), z = host.z + Math.sin(angle) * (host.radius + 0.075);
        if (Math.abs(x) > halfW - 0.12 || Math.abs(z) > halfH - 0.12) continue;
        if (pads.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 0.045)) continue;
        const flower = { x, z, radius: 0.075 + random() * 0.015, turn: random() * TAU, seed: random(), pink: flowers.length % 2 === 1, bud: null };
        // A closed bud on its own stalk nearby, in open water.
        for (let b = 0; b < 40 && !flower.bud; b++) {
          const ba = random() * TAU, bx = x + Math.cos(ba) * flower.radius * 2, bz = z + Math.sin(ba) * flower.radius * 2;
          if (!pads.some((p) => Math.hypot(p.x - bx, p.z - bz) < p.radius + 0.03)) flower.bud = { x: bx, z: bz, turn: ba };
        }
        flowers.push(flower);
        break;
      }
    }
  }
  return { pads, flowers };
}

function createFish(index, random) {
  const cast = CAST[index % CAST.length];
  const len = cast.size * (0.94 + random() * 0.12);
  const fish = {
    id: index, variety: cast.variety, seed: random() * 1000, len,
    x: 0, z: 0, heading: random() * TAU, speed: 0.08, yawRate: 0,
    depth: 0.2, depthHome: 0.07 + len * 0.08 + cast.deep + random() * 0.08, pitch: 0, roll: 0,
    cruise: (0.1 + random() * 0.07) * (0.7 + len * 0.6),
    boldness: 0.35 + random() * 0.65,
    wander: [random() * TAU, random() * TAU, 0.11 + random() * 0.09, 0.043 + random() * 0.04],
    phase: random() * TAU, amp: 0.3, thrust: 0.3,
    bend: new Float32Array(SPINE_JOINTS),
    pectoral: 0.5, pectoralPhase: random() * TAU, mouth: 0, gill: random() * TAU,
    mode: 'cruise', modeTime: 0, target: null,
    interest: 0, interestFor: 0, bored: random() * 6, nerves: 0, notice: 0, gulp: 0,
    wake: random(), churn: random(), spine: new Float32Array(SPINE_JOINTS * 4),
  };
  fish.bend.fill(fish.heading);
  return fish;
}

export function createPond({ random, count = 8, halfW = 2.6, halfH = 1.1 } = {}) {
  const fish = Array.from({ length: count }, (_, i) => createFish(i, random));
  const pellets = [];
  const impulses = [];                    // ripples made this step; the renderer drains them
  const splashes = [];                    // where mouths broke the surface lately
  const bounds = { halfW, halfH };
  const cursor = { x: 0, z: 0, vx: 0, vz: 0, speed: 0, still: 0, active: false, fresh: false, lastX: 0, lastZ: 0, trail: 0 };
  const stats = { eaten: 0, startles: 0, gulps: 0 };
  let { pads, flowers } = createPads(random, halfW, halfH);
  let time = 0, nextPellet = 1;

  // Start spread across the pond, facing along it, at their own depths.
  fish.forEach((f, i) => {
    const u = (i + 0.5) / fish.length;
    f.x = mix(-halfW * 0.8, halfW * 0.8, (u * 0.618 * 5 + random() * 0.15) % 1);
    f.z = mix(-halfH * 0.6, halfH * 0.6, random());
    f.heading = (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 1.2;
    f.bend.fill(f.heading);
    f.depth = f.depthHome;
  });

  const ripple = (x, z, radius, strength) => { if (impulses.length < 48) impulses.push(x, z, radius, strength); };

  function setBounds(nextW, nextH) {
    if (Math.abs(nextW - bounds.halfW) < 1e-6 && Math.abs(nextH - bounds.halfH) < 1e-6) return false;
    // Pads keep their place relative to the frame, so a cluster stays in its corner.
    for (const p of pads) {
      p.homeX *= nextW / bounds.halfW; p.homeZ *= nextH / bounds.halfH;
      p.x = p.homeX; p.z = p.homeZ;
    }
    for (const f of flowers) {
      f.x *= nextW / bounds.halfW; f.z *= nextH / bounds.halfH;
      if (f.bud) { f.bud.x *= nextW / bounds.halfW; f.bud.z *= nextH / bounds.halfH; }
    }
    bounds.halfW = nextW; bounds.halfH = nextH;
    return true;
  }

  // The cursor is something at the surface: a fingertip trailing in the water.
  function point(x, z) {
    if (x === null || x === undefined) { cursor.active = false; cursor.fresh = false; return; }
    if (!cursor.active) { cursor.lastX = x; cursor.lastZ = z; cursor.vx = cursor.vz = 0; cursor.still = 0; }
    cursor.x = x; cursor.z = z; cursor.active = true; cursor.fresh = true;
  }

  function feed(x, z, count) {
    x = clamp(x, -bounds.halfW * 0.92, bounds.halfW * 0.92);
    z = clamp(z, -bounds.halfH * 0.88, bounds.halfH * 0.88);
    for (let i = 0; i < count && pellets.length < PELLET.capacity; i++) {
      const angle = random() * TAU, reach = PELLET.spread * Math.sqrt(random()) * (count > 4 ? 1 : 0.35);
      pellets.push({
        id: nextPellet++,
        x: x + Math.cos(angle) * reach, z: z + Math.sin(angle) * reach,
        radius: mix(PELLET.radius[0], PELLET.radius[1], random()), seed: random(),
        age: -random() * PELLET.stagger * (count > 1 ? 1 : 0),
        driftX: (random() - 0.5) * 2 * PELLET.drift, driftZ: (random() - 0.5) * 2 * PELLET.drift,
        claims: 0, landed: false,
      });
    }
  }
  // A handful scattered where the fish are not all crowded, the way a keeper would throw it.
  function pinch() {
    const x = Math.sin(time * 0.37 + 1.3) * bounds.halfW * 0.55, z = Math.sin(time * 0.23 + 0.4) * bounds.halfH * 0.4;
    feed(x, z, PELLET.pinch);
  }
  const whole = (p) => p.age < 0 ? 0 : Math.min(1, (PELLET.life - p.age) / PELLET.fade);

  function stepCursor(dt) {
    if (!cursor.active) { cursor.speed = approach(cursor.speed, 0, 0.2, dt); return; }
    const dx = cursor.x - cursor.lastX, dz = cursor.z - cursor.lastZ;
    const moved = Math.hypot(dx, dz);
    cursor.vx = approach(cursor.vx, dx / dt, 0.08, dt);
    cursor.vz = approach(cursor.vz, dz / dt, 0.08, dt);
    cursor.speed = Math.hypot(cursor.vx, cursor.vz);
    cursor.still = cursor.speed < 0.18 ? cursor.still + dt : 0;
    // A moving fingertip draws a line of small rings; a resting one leaves the water alone.
    cursor.trail += moved;
    if (cursor.trail > 0.05 && cursor.speed > 0.04) {
      ripple(cursor.x, cursor.z, 0.011, clamp(cursor.speed * 0.16, 0.08, 0.38));
      cursor.trail = 0;
    }
    cursor.lastX = cursor.x; cursor.lastZ = cursor.z;
    cursor.fresh = false;
  }

  function stepPellets(dt) {
    for (let i = pellets.length - 1; i >= 0; i--) {
      const p = pellets[i];
      p.age += dt;
      if (p.age < 0) continue;
      if (!p.landed) { p.landed = true; ripple(p.x, p.z, 0.012, 0.22); }
      if (p.age >= PELLET.life) { pellets.splice(i, 1); continue; }
      p.x += p.driftX * dt; p.z += p.driftZ * dt;
    }
  }

  function stepPads(dt) {
    // Tethered by their stems, pads wander a few centimetres and settle back.
    for (const p of pads) {
      const a = p.swayPhase + time * p.swayRate;
      p.x = p.homeX + Math.sin(a) * 0.012 + Math.sin(a * 0.37 + 2) * 0.008;
      p.z = p.homeZ + Math.cos(a * 0.81) * 0.012 + Math.sin(a * 0.29 + 1) * 0.008;
      p.spin = Math.sin(a * 0.53) * 0.05;
      p.lift = approach(p.lift, 0, 0.6, dt);
    }
    // A fish passing just under a pad nudges it.
    for (const f of fish) {
      if (f.depth > 0.16 + f.len * 0.1) continue;
      for (const p of pads) {
        if (Math.hypot(p.x - f.x, p.z - f.z) < p.radius + f.len * 0.1) p.lift = Math.min(1, p.lift + dt * 2.5 * clamp(f.speed * 4, 0.2, 1));
      }
    }
  }

  // Which pellet a hungry fish goes for: the nearest that not too many others are already after.
  function choosePellet(f) {
    let best = null, bestScore = Infinity;
    for (const p of pellets) {
      if (p.age < 0 || whole(p) < 0.3) continue;
      const score = Math.hypot(p.x - f.x, p.z - f.z) + p.claims * 0.3;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  }
  function release(f) { if (f.target) { f.target.claims = Math.max(0, f.target.claims - 1); f.target = null; } }
  function setMode(f, mode) { if (f.mode === mode) return; f.mode = mode; f.modeTime = 0; }

  const mouthPoint = (f) => ({ x: f.x + Math.cos(f.heading) * f.len * COM, z: f.z + Math.sin(f.heading) * f.len * COM });

  function stepFish(f, dt) {
    f.modeTime += dt;
    f.nerves = approach(f.nerves, 0, 45, dt);
    f.bored = Math.max(0, f.bored - dt);
    const mouth = mouthPoint(f);

    // --- What does it want to do?
    const hungry = pellets.some((p) => p.age >= 0 && whole(p) >= 0.3);
    if (f.mode !== 'startle') {
      if (hungry) {
        // Food is noticed after a moment, sooner by a fish that is close to it.
        if (f.mode !== 'feed') {
          const near = choosePellet(f);
          const d = near ? Math.hypot(near.x - f.x, near.z - f.z) : 9;
          f.notice += dt * (0.35 + 1.6 / (0.4 + d)) * (0.6 + f.boldness * 0.6);
          if (f.notice > 1) { setMode(f, 'feed'); f.notice = 0; }
        }
      } else {
        f.notice = 0;
        if (f.mode === 'feed') { release(f); setMode(f, 'cruise'); f.bored = 3 + random() * 4; }
      }
    }
    if (f.mode === 'cruise' && cursor.active && f.bored <= 0 && cursor.still > 0.7) {
      const d = Math.hypot(cursor.x - f.x, cursor.z - f.z);
      const watching = fish.reduce((n, o) => n + (o.mode === 'curious' ? 1 : 0), 0);
      if (d < 0.55 + f.boldness * 1.1 && watching < 3) {
        setMode(f, 'curious');
        f.interestFor = 5 + random() * 9 * f.boldness;
      }
    }
    if (f.mode === 'curious' && (!cursor.active || f.modeTime > f.interestFor)) {
      setMode(f, 'cruise'); f.bored = 8 + random() * 14;
    }
    // A fast pass close by is a threat. Each fright leaves a fish harder to frighten for a while.
    if (f.mode !== 'startle' && cursor.active && cursor.speed > 1.1 + f.nerves * 1.6) {
      const d = Math.hypot(cursor.x - mouth.x, cursor.z - mouth.z);
      if (d < 0.28 + f.len * 0.12 - f.nerves * 0.12) startle(f, cursor.x, cursor.z, 1);
    }

    // --- Steering: a wanted heading, speed and depth for the mode it is in.
    let wantHeading = f.heading, wantSpeed = f.cruise, wantDepth = f.depthHome, wantPitch = 0;
    let yawLimit = 0.55 + f.speed * 3.2, quickness = 0.45;
    const w = f.wander;
    w[0] += w[2] * dt; w[1] += w[3] * dt;

    if (f.mode === 'cruise') {
      wantHeading = f.heading + (Math.sin(w[0]) * 0.55 + Math.sin(w[1] * 2.3 + 1) * 0.3);
      // Koi idle along and coast: speed drifts between a slow glide and an easy cruise.
      wantSpeed = f.cruise * (0.62 + 0.5 * Math.sin(w[1] * 1.7 + f.seed));
      wantDepth = f.depthHome + Math.sin(w[0] * 0.6 + f.seed) * 0.08;
    } else if (f.mode === 'curious') {
      const dx = cursor.x - mouth.x, dz = cursor.z - mouth.z, d = Math.hypot(dx, dz);
      wantHeading = Math.atan2(dz, dx);
      // Comes up under the fingertip, slows, and holds off a little short of it.
      const hold = 0.09 + (1 - f.boldness) * 0.14;
      wantSpeed = clamp((d - hold) * 0.55, 0, f.cruise * 1.5);
      if (d < hold) wantSpeed = 0;
      wantDepth = mix(f.depthHome, 0.07 + f.len * 0.13, smooth(1.2, 0.3, d));
      wantPitch = smooth(0.5, 0.12, d) * 0.16;
      yawLimit = 0.9 + f.speed * 3;
    } else if (f.mode === 'feed') {
      if (!f.target || !pellets.includes(f.target) || whole(f.target) < 0.3) {
        release(f);
        f.target = choosePellet(f);
        if (f.target) f.target.claims++;
      }
      if (f.target) {
        const dx = f.target.x - mouth.x, dz = f.target.z - mouth.z, d = Math.hypot(dx, dz);
        // Aimed from the body, not the mouth: a fish pivots about its middle, so a pellet close
        // beside the head would otherwise stay just out of reach however it turned.
        const cx = f.target.x - f.x, cz = f.target.z - f.z, reach = f.len * COM;
        wantHeading = Math.atan2(cz, cx);
        wantSpeed = clamp(0.08 + d * 0.75, 0.08, 0.5 + f.boldness * 0.2) * (0.75 + f.len * 0.5);
        // Food off to one side is not circled: the fish checks, nearly stops, and pivots onto it.
        const off = Math.abs(wrap(wantHeading - f.heading));
        wantSpeed *= mix(1, 0.12, smooth(0.35, 1.4, off) * smooth(0.7, 0.1, d));
        // Too close to bring the mouth round onto it: back off a little with the pectorals.
        if (Math.hypot(cx, cz) < reach * 0.85) wantSpeed = -0.05;
        // Rises as it closes, so the mouth meets the pellet at the surface.
        const rise = smooth(0.9, 0.15, d);
        wantDepth = mix(f.depthHome, 0.035 + f.len * 0.085, rise);
        wantPitch = rise * 0.24 + smooth(0.12, 0.03, d) * 0.3;
        yawLimit = 1.5 + f.speed * 3 + smooth(0.4, 0.05, d) * 1.5; quickness = 0.22;
        if (d < 0.03 + f.len * 0.025 && f.depth < 0.07 + f.len * 0.1) {
          const i = pellets.indexOf(f.target);
          if (i >= 0) pellets.splice(i, 1);
          f.target = null; f.gulp = 1; stats.eaten++; stats.gulps++;
          // The lips break the film: a spray of bubbles and a wet shine where the head came up.
          if (splashes.length >= 8) splashes.shift();
          splashes.push({ x: mouth.x, z: mouth.z, age: 0, size: 0.04 + f.len * 0.06, seed: random() });
          ripple(mouth.x, mouth.z, 0.022 + f.len * 0.012, 0.75);
        }
      }
    } else if (f.mode === 'startle') {
      wantHeading = f.flee;
      wantSpeed = f.modeTime < 0.35 ? (1.1 + f.boldness * 0.5) * f.fright : f.cruise * 1.6;
      wantDepth = f.depthHome + 0.18 * f.fright;
      yawLimit = f.modeTime < 0.3 ? 9 * f.fright : 1.5; quickness = 0.07;
      if (f.modeTime > 1.1 + f.fright * 0.9) { setMode(f, 'cruise'); f.bored = 6 + random() * 10; }
    }

    // --- The pond's edge, and each other. These bend the wanted heading in every mode but flight.
    if (f.mode !== 'startle' || f.modeTime > 0.4) {
      // The right-hand band, where the desktop icons sit, is kept mostly clear.
      const left = bounds.halfW + 0.12, right = bounds.halfW * 0.9, mz = bounds.halfH + 0.05, soft = 0.7;
      const ahead = 0.35 + f.speed * 1.5;
      const px = f.x + Math.cos(f.heading) * ahead, pz = f.z + Math.sin(f.heading) * ahead;
      const ox = px > right - soft ? (px - (right - soft)) / soft : px < -left + soft ? (px + left - soft) / soft : 0;
      const oz = pz > mz - soft ? (pz - (mz - soft)) / soft : pz < -mz + soft ? (pz + mz - soft) / soft : 0;
      const out = Math.min(1.4, Math.hypot(ox, oz));
      if (out > 0 && f.mode !== 'feed') {
        // Turn along the bank toward the open water rather than bouncing straight back.
        const home = Math.atan2(-f.z * 0.6 - oz, -f.x * 0.25 - ox * 1.5);
        wantHeading = f.heading + wrap(home - f.heading) * Math.min(1, out * 1.2) + wrap(wantHeading - f.heading) * Math.max(0, 1 - out * 1.2);
        yawLimit += out * 0.6;
      }
      for (const o of fish) {
        if (o === f) continue;
        const dx = f.x - o.x, dz = f.z - o.z, d = Math.hypot(dx, dz), room = (f.len + o.len) * 0.5;
        if (d > room * 1.5 || d < 1e-4) continue;
        const press = 1 - d / (room * 1.5);
        // Cruising koi keep a little room between them, giving way sideways; two at the same
        // depth also part vertically, one slipping under the other.
        if (f.mode !== 'feed') wantHeading += wrap(Math.atan2(dz, dx) - f.heading) * press * (Math.abs(f.depth - o.depth) < 0.1 ? 0.7 : 0.35);
        if (Math.abs(f.depth - o.depth) < 0.1 && f.mode !== 'feed') wantDepth += (f.depthHome >= o.depthHome ? 0.14 : -0.06) * press;
      }
      // Loose company: a fish far from all the others drifts back toward them.
      if (f.mode === 'cruise') {
        let cx = 0, cz = 0;
        for (const o of fish) { cx += o.x; cz += o.z; }
        cx /= fish.length; cz /= fish.length;
        const d = Math.hypot(cx - f.x, cz - f.z);
        if (d > 2.2) wantHeading += wrap(Math.atan2(cz - f.z, cx - f.x) - f.heading) * smooth(2.2, 3.6, d) * 0.4;
      }
    }

    // --- Motion. Heading, speed and depth ease toward what is wanted.
    let turn = wrap(wantHeading - f.heading);
    // Wanting to go straight back the way it came, a fish commits to turning one way instead of
    // dithering between left and right.
    if (Math.abs(turn) > 2.6) turn = (Math.sign(f.yawRate) || 1) * Math.abs(turn);
    const wantYaw = clamp(turn * (f.mode === 'startle' ? 9 : 1.6), -yawLimit, yawLimit);
    f.yawRate = approach(f.yawRate, wantYaw, quickness, dt);
    f.heading = wrap(f.heading + f.yawRate * dt);
    // Speeding up takes tail strokes; slowing is a glide, unless the fins are flared to brake.
    const braking = wantSpeed < f.speed * 0.5 && f.speed > 0.06;
    f.speed = approach(f.speed, wantSpeed, wantSpeed > f.speed ? (f.mode === 'startle' ? 0.12 : 0.9) : braking ? 0.9 : 2.2, dt);
    f.x += Math.cos(f.heading) * f.speed * dt;
    f.z += Math.sin(f.heading) * f.speed * dt;
    const floor = POND_DEPTH - 0.25, ceiling = 0.03 + f.len * 0.08;
    f.depth = approach(f.depth, clamp(wantDepth, ceiling, floor), f.mode === 'feed' ? 0.7 : 1.6, dt);
    f.pitch = approach(f.pitch, wantPitch, 0.5, dt);
    f.roll = approach(f.roll, clamp(-f.yawRate * (0.12 + f.speed * 0.5), -0.4, 0.4), 0.3, dt);

    // --- The body. The tail works as hard as the fish is trying to go faster than it glides.
    const effort = clamp((wantSpeed - f.speed) * 5 + f.speed * 1.5 + Math.abs(f.yawRate) * 0.12, 0.3, 1.35);
    f.thrust = approach(f.thrust, effort, effort > f.thrust ? 0.15 : 0.7, dt);
    f.amp = f.thrust;
    const beat = clamp(0.55 + (Math.abs(f.speed) / f.len) * 1.9 + f.thrust * 0.6, 0.6, 2.2);
    f.phase = (f.phase + TAU * beat * dt) % TAU;
    // Each joint takes up the angle of the one ahead as the fish moves through its own length,
    // so the body lies along the path the head swam, and straightens out when it stops.
    const seg = (SPINE_SPAN / (SPINE_JOINTS - 1)) * f.len;
    const carry = clamp((f.speed + 0.035) * dt / seg, 0, 1), relax = dt / 1.4;
    f.bend[0] = f.heading;
    for (let i = SPINE_JOINTS - 1; i >= 1; i--) {
      f.bend[i] += wrap(f.bend[i - 1] - f.bend[i]) * carry + wrap(f.heading - f.bend[i]) * relax;
      // A spine curves; it never folds at one joint.
      const kink = wrap(f.bend[i] - f.bend[i - 1]);
      if (Math.abs(kink) > 0.14) f.bend[i] = f.bend[i - 1] + Math.sign(kink) * 0.14;
      // Nor does a koi fold past a tight C: the tail stays within about 100 degrees of the head.
      const total = wrap(f.bend[i] - f.bend[0]);
      if (Math.abs(total) > 1.75) f.bend[i] = f.bend[0] + Math.sign(total) * 1.75;
    }
    // Pectoral fins: spread wide to hover and to brake, held back along the body at speed.
    const spread = braking ? 1 : f.speed < 0.05 ? 0.85 : mix(0.55, 0.08, smooth(0.04, 0.35, f.speed));
    f.pectoral = approach(f.pectoral, spread + Math.abs(f.yawRate) * 0.1, 0.35, dt);
    f.pectoralPhase = (f.pectoralPhase + TAU * (0.45 + (1 - smooth(0.02, 0.2, f.speed)) * 0.6) * dt) % TAU;
    f.gill = (f.gill + TAU * (0.9 + f.speed * 1.5) * dt) % TAU;
    // The mouth opens for a gulp and works idly as it breathes.
    f.gulp = Math.max(0, f.gulp - dt / 0.42);
    const reaching = f.mode === 'feed' && f.target ? smooth(0.14, 0.03, Math.hypot(f.target.x - mouth.x, f.target.z - mouth.z)) : 0;
    f.mouth = approach(f.mouth, Math.max(reaching, Math.sin(f.gulp * Math.PI) * (f.gulp > 0 ? 1 : 0)), 0.06, dt);

    // --- Its mark on the surface: a fish close under the film drags a wake behind its back.
    // Feeding at the surface churns it: lips, gill covers and pectorals all break the film.
    if (f.mode === 'feed' && f.depth < 0.15) {
      f.churn += dt * (5 + random() * 4);
      if (f.churn > 1) {
        f.churn = 0;
        const along = (random() - 0.2) * f.len * 0.5;
        ripple(mouth.x - Math.cos(f.heading) * along + (random() - 0.5) * 0.04, mouth.z - Math.sin(f.heading) * along + (random() - 0.5) * 0.04, 0.01 + random() * 0.008, 0.12 + random() * 0.2);
      }
    }
    const cover = f.depth - f.len * 0.15;
    if (cover < 0.05 && f.speed > 0.05) {
      f.wake += dt * (2 + f.speed * 14);
      if (f.wake > 1) {
        f.wake = 0;
        const s = 0.55 * f.len;
        ripple(f.x - Math.cos(f.bend[12]) * s, f.z - Math.sin(f.bend[12]) * s, 0.02 + f.len * 0.02, clamp(f.speed * 0.8, 0.05, 0.6) * smooth(0.05, -0.02, cover));
      }
    }
  }

  function startle(f, fromX, fromZ, fright) {
    if (f.mode === 'startle') return;
    release(f);
    setMode(f, 'startle');
    f.fright = fright * (1 - f.nerves * 0.5);
    const away = Math.atan2(f.z - fromZ, f.x - fromX);
    // Bolts away, but not into the bank.
    const inward = Math.atan2(-f.z, -f.x);
    f.flee = away + wrap(inward - away) * 0.3 + (random() - 0.5) * 0.9;
    f.nerves = Math.min(1, f.nerves + 0.4);
    stats.startles++;
    if (f.depth < 0.25) ripple(f.x - Math.cos(f.heading) * f.len * 0.4, f.z - Math.sin(f.heading) * f.len * 0.4, 0.018 + f.len * 0.012, 0.4 * f.fright * smooth(0.25, 0.05, f.depth));
    // Fright spreads to fish close by, weaker each time.
    if (fright > 0.6) for (const o of fish) {
      if (o !== f && Math.hypot(o.x - f.x, o.z - f.z) < 0.7 && random() < 0.7) startle(o, fromX, fromZ, fright * 0.6);
    }
  }

  // The backbone as the renderer draws it: for each joint, world position and heading. The
  // swimming wave rides on the bend the path gave the body; the position stays at the centre
  // of mass, so the head yaws a little against the tail the way a real fish's does.
  function pose(f) {
    const seg = (SPINE_SPAN / (SPINE_JOINTS - 1)) * f.len, out = f.spine;
    let x = 0, z = 0, comX = 0, comZ = 0;
    const comAt = COM / SPINE_SPAN * (SPINE_JOINTS - 1);
    let base = f.bend[0];
    for (let i = 0; i < SPINE_JOINTS; i++) {
      const s = (i / (SPINE_JOINTS - 1)) * SPINE_SPAN;
      // Headings are kept continuous down the body so the shader can blend between joints.
      if (i > 0) base += wrap(f.bend[i] - f.bend[i - 1]);
      // Amplitude grows toward the tail; the fin beyond the body whips furthest.
      const envelope = 0.14 + 0.55 * s + 1.0 * s * s + (s > 1 ? (s - 1) * 1.6 : 0);
      const angle = base + Math.min(0.55, f.amp * envelope) * Math.sin(f.phase - s * WAVE);
      out[i * 4] = x; out[i * 4 + 2] = z; out[i * 4 + 3] = angle;
      out[i * 4 + 1] = -f.depth + Math.sin(f.pitch) * (COM - s) * f.len;
      if (i === Math.floor(comAt)) { const t = comAt - i; comX = x - Math.cos(angle) * seg * t; comZ = z - Math.sin(angle) * seg * t; }
      x -= Math.cos(angle) * seg; z -= Math.sin(angle) * seg;
    }
    for (let i = 0; i < SPINE_JOINTS; i++) { out[i * 4] += f.x - comX; out[i * 4 + 2] += f.z - comZ; }
    return out;
  }

  // Now and then something touches the still water: an insect, a drip from the leaves overhead.
  let nextTouch = 1 + random() * 3;
  function stepTouches(dt) {
    nextTouch -= dt;
    if (nextTouch > 0) return;
    nextTouch = 2.5 + random() * 6;
    const x = (random() * 2 - 1) * bounds.halfW * 0.95, z = (random() * 2 - 1) * bounds.halfH * 0.95;
    if (pads.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius)) return;
    ripple(x, z, 0.01 + random() * 0.008, 0.15 + random() * 0.3);
  }

  // Bodies are solid. Each is three discs down its length; where two fish at about the same
  // depth touch, they are eased apart sideways and the one that belongs deeper slips under.
  const DISCS = [[0.12, 0.105], [0.38, 0.12], [0.66, 0.085]];
  function stepContacts(dt) {
    for (let a = 0; a < fish.length; a++) for (let b = a + 1; b < fish.length; b++) {
      const f = fish[a], g = fish[b];
      const reach = (f.len + g.len) * 0.75;
      if (Math.abs(f.x - g.x) > reach || Math.abs(f.z - g.z) > reach) continue;
      const thick = (f.len + g.len) * 0.16;
      const gap = Math.abs(f.depth - g.depth);
      if (gap > thick) continue;
      let px = 0, pz = 0, worst = 0;
      for (const [sf, rf] of DISCS) for (const [sg, rg] of DISCS) {
        const fx = f.x + Math.cos(f.heading) * (COM - sf) * f.len, fz = f.z + Math.sin(f.heading) * (COM - sf) * f.len;
        const gx = g.x + Math.cos(g.heading) * (COM - sg) * g.len, gz = g.z + Math.sin(g.heading) * (COM - sg) * g.len;
        const dx = fx - gx, dz = fz - gz, d = Math.hypot(dx, dz) || 1e-4, overlap = rf * f.len + rg * g.len - d;
        if (overlap > 0) { px += dx / d * overlap; pz += dz / d * overlap; worst = Math.max(worst, overlap); }
      }
      if (worst <= 0) continue;
      const push = 1 - 0.5 * gap / thick;
      const share = g.len / (f.len + g.len);
      f.x += px * push * share * 0.5; f.z += pz * push * share * 0.5;
      g.x -= px * push * (1 - share) * 0.5; g.z -= pz * push * (1 - share) * 0.5;
      // Shouldering through a crowd is slow going.
      f.speed *= 1 - Math.min(1, dt * 1.2); g.speed *= 1 - Math.min(1, dt * 1.2);
      // The one with the deeper habit, or the smaller in a feeding crowd, ducks under.
      // Fish crowding the same food jostle sideways: nobody gives up the surface.
      if (f.mode === 'feed' && g.mode === 'feed') continue;
      const under = f.depthHome > g.depthHome ? f : g;
      under.depth = Math.min(POND_DEPTH - 0.25, under.depth + dt * 0.1 * (1 - gap / thick));
    }
  }

  function step(dt) {
    time += dt;
    stepTouches(dt);
    stepCursor(dt);
    stepPellets(dt);
    for (let i = splashes.length - 1; i >= 0; i--) if ((splashes[i].age += dt) > SPLASH_LIFE) splashes.splice(i, 1);
    for (const f of fish) stepFish(f, dt);
    stepContacts(dt);
    stepContacts(dt);
    stepPads(dt);
  }

  function diagnostics() {
    return {
      time, fish: fish.length, pellets: pellets.length, pads: pads.length, ...stats,
      modes: fish.map((f) => f.mode),
      finite: fish.every((f) => [f.x, f.z, f.heading, f.speed, f.depth, f.phase, f.yawRate].every(Number.isFinite)),
    };
  }

  return {
    fish, pellets, impulses, splashes, bounds, cursor, stats,
    get pads() { return pads; }, get flowers() { return flowers; }, get time() { return time; },
    step, pose, setBounds, point, feed, pinch, whole, startle, diagnostics,
    relayout(seedRandom) { ({ pads, flowers } = createPads(seedRandom, bounds.halfW, bounds.halfH)); },
  };
}
