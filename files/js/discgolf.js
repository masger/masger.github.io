/* Disc golf hill for the Projects page.

   The script reads the project cards that Quarto renders (a.quarto-grid-link)
   and puts one basket per project on a low-poly hill. Pull the disc back and
   let go to throw, or pick a sign and the disc flies to that basket.
   A new project page under projects/ gets its own basket automatically.

   Discs stay in the baskets between visits (localStorage). A visitor who hits
   every basket by hand wins the golden disc and is invited to write to Michael.
   Throws by sign open the project but do not count towards the prize.

   The cards stay in the page as the data for the scene, but css/theme.scss hides
   them. If the scene cannot start (no WebGL, script blocked, no JavaScript), the
   class dg-fallback on <html> shows the card grid instead, so the project links
   never disappear. Styles live in css/theme.scss (section "Disc golf scene"). */

import * as THREE from './vendor/three.module.min.js';

const COL = {
  sky: 0xdbe9f4,
  grassA: 0x74b06e,
  grassB: 0x8cc27e,
  fairway: 0xc4e3a8,
  flowers: [0xffffff, 0xf7d95c, 0xf2a7c3],
  spruce: 0x3d7a5c,
  leaf: [0x66ad5f, 0x7bbd6a, 0x58a05a, 0x9bc45c],
  trunk: 0x7a5a44,
  rock: 0xa9b3bd,
  metal: 0x7d8a97,
  tray: 0x56636f,
  band: 0xf2c230,
  navy: 0x2c3f51,
  discs: [0xef6f4a, 0x5480a7, 0xf2c230, 0xe57ba5],
  confetti: [0x5480a7, 0x56a754, 0xf2c230, 0xef6f4a, 0xffffff],
};

// One slot per basket: angle from the tee in degrees (right is positive) and distance in metres.
const SLOTS = [[-30, 11], [16, 13.5], [-13, 20.5], [34, 21], [3, 27], [-34, 26], [20, 31], [-18, 33]];

const G = 7;                         // gravity, lower than on Earth so the disc floats
const PITCH = (24 * Math.PI) / 180;  // launch angle of a hand throw
const STEP = 0.02;                   // seconds between collision checks
const BASKET_SCALE = 1.3;
const CATCH_R = 1.2;                 // metres from the pole, a little wider than the basket itself
const CATCH_LO = 0.95;               // metres above the ground
const CATCH_HI = 2.7;
const TRAY_Y = 1.1;
const CAM_Z = 5.4;

// The round is kept in the browser (localStorage), so the discs still lie in the baskets
// when a visitor comes back from a project page. Nothing is sent anywhere.
const STORE_KEY = 'discgolf-round';
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
// Put together here so the address does not stand in clear text for address harvesters,
// like the mail links Quarto writes on the other pages.
const MAIL = ['michael.asger.andersen', 'regionh.dk'].join('@');

// The discs in the bag on the practice range, with the flight numbers Discmania prints on
// them (speed, glide, turn, fade). Checked against discmania.net on 25 November 2026.
const DISCS = [
  { name: 'P2', kind: 'Putter', speed: 2, glide: 3, turn: 0, fade: 1, color: 0x5480a7 },
  { name: 'MD3', kind: 'Midrange', speed: 5, glide: 5, turn: 0, fade: 1, color: 0xf2c230 },
  { name: 'FD', kind: 'Fairway driver', speed: 7, glide: 6, turn: 0, fade: 1, color: 0xe57ba5 },
  { name: 'TD', kind: 'Turning driver', speed: 10, glide: 5, turn: -2, fade: 1, color: 0x8e6bd1 },
  { name: 'DD3', kind: 'Distance driver', speed: 12, glide: 5, turn: -1, fade: 3, color: 0xef6f4a },
];
// Baskets on the range: metres to the right of the tee line, metres down the range.
// 18 m, 35 m and 55 m from the tee, spread out so no basket stands in the way of another.
const RANGE_TARGETS = [[7, 16.6], [-8, 34], [1, 55]];

// How the flight numbers bend a throw on the range. A disc has a speed it is made for.
// Thrown faster than that it turns, thrown slower it fades. Tuned so the putter flies
// about 32 m and the distance driver about 80 m at full power.
const FLIGHT = { arm: 29, pitch: (5 * Math.PI) / 180, fade: 1.6, turn: 2.8 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- terrain ---------- */

function rawGround(x, z) {
  const hill = (cx, cz, s, a) => a * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * s * s));
  return (
    hill(-8, -36, 15, 5) +
    hill(14, -23, 8, 2.4) +
    hill(-17, -12, 6, 1.2) +
    0.3 * Math.sin(x * 0.31 + 1.3) * Math.cos(z * 0.27) +
    0.12 * Math.sin(x * 0.83) * Math.sin(z * 0.71 + 2)
  );
}

const TEE_Y = rawGround(0, 0);

// The practice range lies far to the side of the hill, out of sight in the haze.
// It is a long flat field with a low bank along the sides and at the far end.
const RANGE_X = 400;

function rawRange(x, z) {
  return (
    0.45 * Math.sin(x * 0.07 + 0.5) * Math.cos(z * 0.045) +
    0.18 * Math.sin(x * 0.19) * Math.sin(z * 0.16 + 1) +
    3.5 * smooth(30, 62, Math.abs(x)) +
    4.5 * smooth(-92, -135, z)
  );
}

const RANGE_Y = rawRange(0, 0);

// The ground is levelled around each tee so the pad lies flat.
function groundY(x, z) {
  if (x > RANGE_X / 2) {
    const k = smooth(5, 2.2, Math.hypot(x - RANGE_X, z - 0.3));
    return rawRange(x - RANGE_X, z) * (1 - k) + RANGE_Y * k;
  }
  const k = smooth(5, 2.2, Math.hypot(x, z - 0.3));
  return rawGround(x, z) * (1 - k) + TEE_Y * k;
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ---------- start ---------- */

const root = document.getElementById('discgolf');
const projects = [...document.querySelectorAll('a.quarto-grid-link')]
  .map((a) => ({
    href: a.getAttribute('href'),
    key: new URL(a.href).pathname, // name of the basket in the saved round, the same however the link is written
    title: a.querySelector('.listing-title')?.textContent.trim() ?? '',
    text: a.querySelector('.listing-description')?.textContent.trim() ?? '',
  }))
  .filter((p) => p.href && p.title)
  .slice(0, SLOTS.length);

const showCards = () => document.documentElement.classList.add('dg-fallback');

if (root && projects.length) {
  try {
    init(root, projects);
  } catch (err) {
    root.replaceChildren();
    showCards();
    console.warn('Disc golf scene not started:', err);
  }
} else {
  showCards();
}

function init(root, projects) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = mulberry32(20261125);

  /* ----- renderer, camera, light ----- */

  const stage = el('div', 'dg-stage');
  const canvas = el('canvas', 'dg-canvas');
  canvas.setAttribute('aria-hidden', 'true');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); // throws without WebGL
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.sky);
  scene.fog = new THREE.Fog(COL.sky, 30, 68);

  const camera = new THREE.PerspectiveCamera(46, 2, 0.1, 220);
  const TEE_CAM = new THREE.Vector3(0, TEE_Y + 2.5, CAM_Z);
  const TEE_LOOK = new THREE.Vector3(0, TEE_Y + 1.5, -14);
  const camPos = TEE_CAM.clone();
  const camLook = TEE_LOOK.clone();
  const goalPos = new THREE.Vector3();
  const goalLook = new THREE.Vector3();

  scene.add(new THREE.HemisphereLight(0xf4f9ff, 0x86a878, 1.9));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
  sun.position.set(-24, 34, 14);
  sun.target.position.set(0, 0, -18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 36, bottom: -30, near: 1, far: 120 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  /* ----- baskets (data) ----- */

  const baskets = projects.map((p, i) => {
    const [deg, dist] = SLOTS[i];
    const a = (deg * Math.PI) / 180;
    const x = Math.sin(a) * dist;
    const z = -Math.cos(a) * dist;
    const y = groundY(x, z);
    // Where the camera stands after a catch: a few steps short of the basket and a little
    // to the side, so the panel has room.
    const ux = -x / dist;
    const uz = -z / dist;
    const cam = new THREE.Vector3(x + ux * 5.8 + uz * 1.4, 0, z + uz * 5.8 - ux * 1.4);
    cam.y = Math.max(y + 2.6, groundY(cam.x, cam.z) + 1.9);
    const look = new THREE.Vector3(x + uz * 0.9, y + 1.1, z - ux * 0.9);
    return { ...p, i, x, z, y, cam, look, discs: [], jig: -1 };
  });
  // The baskets on the practice range carry a distance on the sign and no project.
  const rangeTargets = RANGE_TARGETS.map(([right, down], i) => {
    const x = RANGE_X + right;
    const z = -down;
    const far = Math.hypot(right, down);
    // A basket far away catches a little wider, or it could hardly be hit.
    return { i, x, z, y: groundY(x, z), metres: Math.round(far), reach: CATCH_R + far * 0.011, discs: [], jig: -1 };
  });
  const allTargets = [...baskets, ...rangeTargets];
  const nearCatchView = (x, z, r) =>
    baskets.some((b) => Math.hypot(x - b.cam.x, z - b.cam.z) < r + 2 || distToSegment(x, z, b.cam.x, b.cam.z, b.x, b.z) < r);
  const fairwayDist = (x, z) => Math.min(...baskets.map((b) => distToSegment(x, z, 0, 0, b.x, b.z)));
  const sightDist = (x, z) => Math.min(...baskets.map((b) => distToSegment(x, z, 0, CAM_Z, b.x, b.z)));

  /* ----- terrain mesh ----- */

  // The range draws its random numbers from its own row, so building it leaves the hill as it was.
  const rndRange = mulberry32(20261126);

  // A patch of low-poly ground around (cx, cz). tint(colour, x, z) lightens the mown parts.
  function addGround(cx, cz, W, D, SX, SZ, tint, rnd) {
    let geo = new THREE.PlaneGeometry(W, D, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);
    const pos = geo.attributes.position;
    const cell = W / SX;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (rnd() - 0.5) * cell * 0.6;
      const z = pos.getZ(i) + (rnd() - 0.5) * cell * 0.6;
      pos.setXYZ(i, x, groundY(x, z), z);
    }
    geo = geo.toNonIndexed(); // one normal and one colour per triangle
    geo.computeVertexNormals();

    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    const a = new THREE.Color(COL.grassA);
    const b = new THREE.Color(COL.grassB);
    for (let f = 0; f < p.count; f += 3) {
      const mx = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
      const mz = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
      const n = 0.5 + 0.5 * Math.sin(mx * 0.21 + 0.7) * Math.cos(mz * 0.17 - 1.1);
      c.copy(a).lerp(b, n);
      tint(c, mx, mz);
      c.offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (f + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    scene.add(ground);
  }

  {
    const fair = new THREE.Color(COL.fairway);
    // The hill: a mown path from the tee to every basket.
    addGround(0, -32, 108, 92, 66, 56, (c, x, z) => {
      const d = Math.min(fairwayDist(x, z), ...baskets.map((k) => Math.hypot(x - k.x, z - k.z) - 1.2));
      c.lerp(fair, 0.8 * smooth(2.6, 1.2, d));
    }, rnd);
    // The range: mown in stripes of ten metres down the middle, rough along the sides.
    addGround(RANGE_X, -58, 150, 176, 60, 70, (c, x, z) => {
      const inField = smooth(25, 20, Math.abs(x - RANGE_X)) * smooth(-108, -100, z) * smooth(8, 4, z);
      c.lerp(fair, inField * (Math.floor(-z / 10) % 2 === 0 ? 0.8 : 0.4));
    }, rndRange);
  }

  /* ----- tee pads ----- */

  for (const [x, y] of [[0, TEE_Y], [RANGE_X, RANGE_Y]]) {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.1, 3.4),
      new THREE.MeshLambertMaterial({ color: 0xc3ccd4 })
    );
    pad.position.set(x, y + 0.02, 0.3);
    pad.receiveShadow = true;
    scene.add(pad);
  }

  /* ----- trees, bushes, rocks ----- */

  {
    const trees = [];
    for (let n = 0; n < 2400 && trees.length < 190; n++) {
      const x = -48 + rnd() * 96;
      const z = -70 + rnd() * 78;
      if (z > -5 && Math.abs(x) < 10) continue; // keep the view from the tee open
      if (fairwayDist(x, z) < 2.7 || sightDist(x, z) < 2.7 || nearCatchView(x, z, 2.6)) continue;
      const inPlay = z < 0 && Math.hypot(x, z) < 31 && Math.abs(Math.atan2(x, -z)) < 0.78;
      if (inPlay && rnd() > 0.35) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.1)) continue;
      trees.push({ x, z, spruce: rnd() < 0.58, s: 0.8 + rnd() * 0.6, rot: rnd() * 6.283 });
    }
    const bushes = [];
    for (let n = 0; n < 400 && bushes.length < 26; n++) {
      const x = -30 + rnd() * 60;
      const z = -44 + rnd() * 46;
      if (z > -4 && Math.abs(x) < 6) continue;
      if (fairwayDist(x, z) < 2 || sightDist(x, z) < 1.6 || nearCatchView(x, z, 1.2)) continue;
      bushes.push({ x, z, s: 0.45 + rnd() * 0.5, rot: rnd() * 6.283 });
    }
    const rocks = [];
    for (let n = 0; n < 300 && rocks.length < 18; n++) {
      const x = -26 + rnd() * 52;
      const z = -40 + rnd() * 42;
      if (fairwayDist(x, z) < 1.6 || Math.hypot(x, z) < 4) continue;
      rocks.push({ x, z, s: 0.25 + rnd() * 0.5, rot: rnd() * 6.283 });
    }

    const flowers = [];
    for (let n = 0; n < 900 && flowers.length < 150; n++) {
      const x = -20 + rnd() * 40;
      const z = -32 + rnd() * 28;
      if (fairwayDist(x, z) < 1.9) continue;
      flowers.push({ x, z, s: 0.05 + rnd() * 0.04 });
    }

    // Around the practice range: woods on the bank along the sides and behind the far end,
    // a few bushes and rocks in the rough. The field itself stays open.
    const far = rndRange;
    for (let n = 0, count = 0; n < 2600 && count < 170; n++) {
      const lx = -72 + far() * 144;
      const z = -140 + far() * 156;
      const inField = Math.abs(lx) < 27 && z > -106;
      if (inField || (z > -2 && Math.abs(lx) < 34)) continue;
      const x = RANGE_X + lx;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 2.6)) continue;
      trees.push({ x, z, spruce: far() < 0.6, s: 0.9 + far() * 0.7, rot: far() * 6.283 });
      count++;
    }
    for (let n = 0; n < 60; n++) {
      const side = far() < 0.5 ? -1 : 1;
      const x = RANGE_X + side * (21 + far() * 6);
      const z = -100 * far();
      if (n % 3) bushes.push({ x, z, s: 0.5 + far() * 0.5, rot: far() * 6.283 });
      else rocks.push({ x, z, s: 0.25 + far() * 0.45, rot: far() * 6.283 });
    }
    for (let n = 0; n < 140; n++) {
      const side = far() < 0.5 ? -1 : 1;
      flowers.push({ x: RANGE_X + side * (20.5 + far() * 9), z: 4 - far() * 100, s: 0.05 + far() * 0.04 });
    }

    const spruces = trees.filter((t) => t.spruce);
    const leafy = trees.filter((t) => !t.spruce);

    const spruceGeo = new THREE.LatheGeometry(
      [[0.001, 0.5], [1, 0.5], [0.42, 1.45], [0.76, 1.45], [0.28, 2.3], [0.5, 2.3], [0, 3.3]].map(
        ([r, y]) => new THREE.Vector2(r, y)
      ),
      7
    );
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.16, 1, 6).translate(0, 0.5, 0);
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);

    const spruceMesh = new THREE.InstancedMesh(
      spruceGeo,
      new THREE.MeshLambertMaterial({ flatShading: true }),
      spruces.length
    );
    const crownMesh = new THREE.InstancedMesh(
      crownGeo,
      new THREE.MeshLambertMaterial({ flatShading: true }),
      leafy.length + bushes.length
    );
    const trunkMesh = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshLambertMaterial({ color: COL.trunk, flatShading: true }),
      trees.length
    );
    const rockMesh = new THREE.InstancedMesh(
      rockGeo,
      new THREE.MeshLambertMaterial({ color: COL.rock, flatShading: true }),
      rocks.length
    );

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    let trunkI = 0;

    spruces.forEach((t, i) => {
      const k = 1.5 * t.s;
      const y = groundY(t.x, t.z) - 0.15;
      q.setFromAxisAngle(up, t.rot);
      spruceMesh.setMatrixAt(i, m.compose(p.set(t.x, y, t.z), q, s.set(k, k, k)));
      spruceMesh.setColorAt(i, c.set(COL.spruce).offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.07));
      trunkMesh.setMatrixAt(trunkI++, m.compose(p, q, s.set(k, k * 0.8, k)));
    });
    leafy.forEach((t, i) => {
      const r = 1.45 * t.s;
      const trunkH = 0.7 + 1.5 * t.s;
      const y = groundY(t.x, t.z) - 0.15;
      q.setFromAxisAngle(up, t.rot);
      crownMesh.setMatrixAt(i, m.compose(p.set(t.x, y + trunkH + r * 0.75, t.z), q, s.set(r, r * 1.12, r)));
      crownMesh.setColorAt(i, c.set(COL.leaf[Math.floor(rnd() * COL.leaf.length)]).offsetHSL(0, 0, (rnd() - 0.5) * 0.05));
      trunkMesh.setMatrixAt(trunkI++, m.compose(p.set(t.x, y, t.z), q, s.set(1.2 * t.s, trunkH + 0.3, 1.2 * t.s)));
    });
    bushes.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      p.set(t.x, groundY(t.x, t.z) + t.s * 0.35, t.z);
      crownMesh.setMatrixAt(leafy.length + i, m.compose(p, q, s.set(t.s * 1.3, t.s * 0.8, t.s * 1.1)));
      crownMesh.setColorAt(leafy.length + i, c.set(COL.leaf[2]).offsetHSL(0, 0, (rnd() - 0.5) * 0.06));
    });
    rocks.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      p.set(t.x, groundY(t.x, t.z) + t.s * 0.2, t.z);
      rockMesh.setMatrixAt(i, m.compose(p, q, s.set(t.s * 1.3, t.s * 0.7, t.s)));
    });
    for (const mesh of [spruceMesh, crownMesh, trunkMesh, rockMesh]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    const flowerMesh = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial(), flowers.length);
    flowers.forEach((t, i) => {
      p.set(t.x, groundY(t.x, t.z) + 0.12, t.z);
      flowerMesh.setMatrixAt(i, m.compose(p, q.identity(), s.setScalar(t.s)));
      flowerMesh.setColorAt(i, c.set(COL.flowers[i % COL.flowers.length]));
    });
    scene.add(flowerMesh);
  }

  /* ----- clouds ----- */

  const clouds = [];
  {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9aa7b4, flatShading: true, fog: false });
    // Five clouds over the hill and five larger ones far out over the range.
    for (const [home, far, size] of [[0, -52, 1], [RANGE_X, -150, 2.4]]) {
      for (let i = 0; i < 5; i++) {
        const g = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          const puff = new THREE.Mesh(geo, mat);
          const r = 1.6 + rnd() * 1.4;
          puff.position.set((k - 1.5) * 2.3 + rnd(), rnd() * 0.8, rnd() * 1.2);
          puff.scale.set(r * 1.35, r * 0.7, r);
          g.add(puff);
        }
        g.scale.setScalar(size);
        g.position.set(home + (-55 + i * 26 + rnd() * 8) * size, (17 + rnd() * 7) * size, far - rnd() * 16 * size);
        g.userData.speed = (0.25 + rnd() * 0.3) * size;
        g.userData.home = home;
        g.userData.reach = 70 * size;
        clouds.push(g);
        scene.add(g);
      }
    }
  }

  /* ----- basket meshes ----- */

  {
    const metal = new THREE.MeshLambertMaterial({ color: COL.metal });
    const trayMat = new THREE.MeshLambertMaterial({ color: COL.tray, side: THREE.DoubleSide });
    const bandMat = new THREE.MeshLambertMaterial({ color: COL.band, side: THREE.DoubleSide });
    const veilMat = new THREE.MeshLambertMaterial({
      color: 0xb8c2cc, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    });
    const chainMat = new THREE.LineBasicMaterial({ color: 0x5f6c79 });
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.06, 2.1, 8).translate(0, 1.05, 0);
    const trayGeo = new THREE.CylinderGeometry(0.58, 0.46, 0.3, 16, 1, true).translate(0, 0.95, 0);
    const floorGeo = new THREE.CircleGeometry(0.46, 16).rotateX(-Math.PI / 2).translate(0, 0.8, 0);
    const bandGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.22, 18, 1, true).translate(0, 1.92, 0);
    const veilGeo = new THREE.CylinderGeometry(0.44, 0.07, 0.8, 14, 1, true).translate(0, 1.41, 0);
    const pts = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      pts.push(Math.cos(a) * 0.44, 1.81, Math.sin(a) * 0.44, Math.cos(a) * 0.07, 1.01, Math.sin(a) * 0.07);
    }
    const chainGeo = new THREE.BufferGeometry();
    chainGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));

    for (const b of allTargets) {
      const g = new THREE.Group();
      g.position.set(b.x, b.y - 0.05, b.z);
      g.scale.setScalar(BASKET_SCALE);
      const chains = new THREE.Group();
      chains.add(new THREE.Mesh(veilGeo, veilMat), new THREE.LineSegments(chainGeo, chainMat));
      const solid = [new THREE.Mesh(poleGeo, metal), new THREE.Mesh(trayGeo, trayMat), new THREE.Mesh(floorGeo, trayMat), new THREE.Mesh(bandGeo, bandMat)];
      for (const mesh of solid) mesh.castShadow = true;
      g.add(...solid, chains);
      b.chains = chains;
      scene.add(g);
    }
  }

  /* ----- disc, aim dots, confetti ----- */

  const discGeo = new THREE.LatheGeometry(
    [[0, 0.04], [0.19, 0.04], [0.26, 0.014], [0.285, -0.02], [0.26, -0.04], [0.23, -0.022], [0, -0.016]].map(
      ([r, y]) => new THREE.Vector2(r, y)
    ),
    22
  );
  const discMats = COL.discs.map((color) => new THREE.MeshLambertMaterial({ color }));
  // A white stripe across the top makes the spin visible.
  const stripeGeo = new THREE.BoxGeometry(0.34, 0.012, 0.07).translate(0, 0.04, 0);
  const stripeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const goldMat = new THREE.MeshLambertMaterial({ color: 0xffcc33, emissive: 0x5c4300 });
  let discCount = 0;

  // The prize for hitting every basket by hand: a cup with a golden disc on top.
  const trophy = new THREE.Group();
  {
    const gold = new THREE.MeshLambertMaterial({ color: 0xffcc33, emissive: 0x5c4300, flatShading: true });
    const cup = new THREE.Mesh(
      new THREE.LatheGeometry(
        [[0, 0], [0.34, 0], [0.34, 0.07], [0.1, 0.13], [0.07, 0.45], [0.2, 0.56], [0.36, 0.8], [0.42, 1.1], [0.37, 1.1], [0.3, 0.82], [0, 0.64]].map(
          ([r, y]) => new THREE.Vector2(r, y)
        ),
        12
      ),
      gold
    );
    const earGeo = new THREE.TorusGeometry(0.15, 0.035, 6, 10, Math.PI);
    const left = new THREE.Mesh(earGeo, gold);
    left.position.set(-0.37, 0.88, 0);
    left.rotation.z = Math.PI / 2;
    const right = new THREE.Mesh(earGeo, gold);
    right.position.set(0.37, 0.88, 0);
    right.rotation.z = -Math.PI / 2;
    const top = new THREE.Mesh(discGeo, goldMat);
    top.position.y = 1.42;
    top.rotation.x = 0.45;
    for (const mesh of [cup, left, right, top]) mesh.castShadow = true;
    trophy.add(cup, left, right, top);
    trophy.visible = false;
    scene.add(trophy);
  }
  const TROPHY_UP = new THREE.Vector3(0, groundY(0, -6.5) + 2.1, -6.5); // floating over the fairway
  const TROPHY_HOME = new THREE.Vector3(1.8, TEE_Y - 0.02, -0.9);       // standing beside the tee
  function placeTrophy(home) {
    trophy.visible = true;
    trophy.position.copy(home ? TROPHY_HOME : TROPHY_UP);
    trophy.scale.setScalar(home ? 0.85 : 2.3);
    trophy.rotation.set(0, home ? -0.5 : 0, 0);
  }

  /* ----- practice range: distance lines, signs and the instructor ----- */

  const rangeMats = DISCS.map((d) => new THREE.MeshLambertMaterial({ color: d.color }));
  const coach = new THREE.Group(); // Michael, standing beside the tee
  const COACH_AT = new THREE.Vector3(RANGE_X - 2.7, groundY(RANGE_X - 2.7, -1.1), -1.1);
  {
    // A white line across the field every twenty metres, with the distance on a sign.
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const postMat = new THREE.MeshLambertMaterial({ color: COL.trunk });
    const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6).translate(0, 0.8, 0);
    const signGeo = new THREE.PlaneGeometry(2.4, 1.2);
    for (let metres = 20; metres <= 100; metres += 20) {
      const geo = new THREE.PlaneGeometry(40, 0.3, 20, 1).rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = RANGE_X + pos.getX(i);
        const z = pos.getZ(i) - metres;
        pos.setXYZ(i, x, groundY(x, z) + 0.06, z);
      }
      scene.add(new THREE.Mesh(geo, lineMat));

      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 128;
      const pen = cv.getContext('2d');
      pen.fillStyle = '#ffffff';
      pen.fillRect(0, 0, 256, 128);
      pen.fillStyle = '#2c3f51';
      pen.font = '700 76px Roboto, Arial, sans-serif';
      pen.textAlign = 'center';
      pen.textBaseline = 'middle';
      pen.fillText(`${metres} m`, 128, 68);
      const face = new THREE.CanvasTexture(cv);
      face.colorSpace = THREE.SRGBColorSpace;
      const x = RANGE_X - 15;
      const y = groundY(x, -metres);
      const sign = new THREE.Mesh(signGeo, new THREE.MeshBasicMaterial({ map: face }));
      sign.position.set(x, y + 2, -metres);
      sign.rotation.y = 0.3;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, y, -metres - 0.05);
      post.castShadow = true;
      scene.add(sign, post);
    }

    // The instructor: a low-poly figure in a blue shirt who holds a disc out towards the thrower.
    const flat = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
    const skin = flat(0xf1c9a5);
    const shirt = flat(0x5480a7);
    const trousers = flat(COL.navy);
    const box = (w, h, d, mat, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      return mesh;
    };
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), skin);
    head.position.set(0, 1.73, 0);
    const hair = new THREE.Mesh(new THREE.IcosahedronGeometry(0.185, 1), flat(0x9a7446));
    hair.position.set(0, 1.81, -0.03);
    hair.scale.set(1, 0.6, 1.02);
    const arm = new THREE.Group(); // the right arm, lifted forward from the shoulder
    arm.position.set(0.31, 1.46, 0);
    arm.rotation.x = -1.25;
    const shown = new THREE.Mesh(discGeo, rangeMats[1]);
    shown.position.set(0, -0.66, 0.02);
    shown.rotation.x = 1.25;
    arm.add(box(0.13, 0.34, 0.15, shirt, 0, -0.17, 0), box(0.11, 0.28, 0.12, skin, 0, -0.47, 0), shown);
    coach.add(
      box(0.17, 0.86, 0.2, trousers, -0.11, 0.47, 0),
      box(0.17, 0.86, 0.2, trousers, 0.11, 0.47, 0),
      box(0.19, 0.08, 0.3, flat(0xffffff), -0.11, 0.04, 0.04),
      box(0.19, 0.08, 0.3, flat(0xffffff), 0.11, 0.04, 0.04),
      box(0.48, 0.62, 0.27, shirt, 0, 1.2, 0),
      box(0.13, 0.34, 0.15, shirt, -0.32, 1.33, 0),
      box(0.11, 0.3, 0.12, skin, -0.32, 1.02, 0),
      head,
      hair,
      arm
    );
    for (const part of [head, hair, shown]) part.castShadow = true;
    coach.position.copy(COACH_AT);
    coach.rotation.y = 0.55;
    scene.add(coach);
  }

  const DOTS = 44;
  const dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.1, 8, 6),
    new THREE.MeshBasicMaterial({ color: COL.navy, transparent: true, opacity: 0.85, fog: false }),
    DOTS
  );
  dots.frustumCulled = false;
  dots.visible = false;
  scene.add(dots);

  const BITS = 150;
  const bits = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false }),
    BITS
  );
  bits.frustumCulled = false;
  bits.visible = false;
  scene.add(bits);
  const bitState = [];
  {
    const c = new THREE.Color();
    for (let i = 0; i < BITS; i++) {
      bits.setColorAt(i, c.set(COL.confetti[i % COL.confetti.length]));
      bitState.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: 0, w: 0, age: 1, life: 1 });
    }
  }
  let bitNext = 0;

  // Throws n pieces of confetti up from a point. The pieces come from a fixed pool.
  function confetti(x, y, z, n, speed) {
    for (let k = 0; k < n; k++) {
      const s = bitState[bitNext++ % BITS];
      const a = rnd() * Math.PI * 2;
      const sp = (0.5 + rnd()) * speed;
      s.p.set(x, y, z);
      s.v.set(Math.cos(a) * sp, 2.5 + rnd() * 3, Math.sin(a) * sp);
      s.r = rnd() * 6;
      s.w = (rnd() - 0.5) * 14;
      s.age = 0;
      s.life = 1.1 + rnd() * 0.6;
    }
    bits.visible = true;
  }

  /* ----- HTML on top of the canvas ----- */

  const labels = el('div', 'dg-labels');
  const SVG = 'http://www.w3.org/2000/svg';
  const leads = document.createElementNS(SVG, 'svg'); // one line from each sign down to its basket
  leads.setAttribute('class', 'dg-leads');
  leads.setAttribute('aria-hidden', 'true');
  for (const b of baskets) {
    const btn = el('button', 'dg-label', b.title);
    btn.type = 'button';
    btn.setAttribute('aria-label', `Throw the disc to ${b.title}`);
    btn.addEventListener('click', (e) => assistedThrow(b, e.detail === 0));
    b.label = btn;
    b.lead = document.createElementNS(SVG, 'line');
    labels.append(btn);
    leads.append(b.lead);
  }
  for (const b of rangeTargets) {
    b.label = el('span', 'dg-label dg-label-plain', `${b.metres} m`);
    b.lead = document.createElementNS(SVG, 'line');
    labels.append(b.label);
    leads.append(b.lead);
  }

  const handle = el('div', 'dg-handle');
  handle.setAttribute('aria-hidden', 'true');
  const hint = el('p', 'dg-hint', 'Pull the disc back and let go. Or pick a sign.');

  /* ----- practice range controls ----- */

  // Top left: the way to the range and back.
  const switchBtn = el('button', 'dg-switch', 'Practice range');
  switchBtn.type = 'button';

  // Michael's speech bubble: portrait, name and one line of advice.
  const bubble = el('div', 'dg-coach');
  bubble.setAttribute('aria-live', 'polite');
  const bubbleFace = el('img', 'dg-coach-face');
  bubbleFace.src = new URL('../images/cph_foto_michael.jpg', import.meta.url).href;
  bubbleFace.alt = '';
  const bubbleLine = el('span');
  const bubbleText = el('p', 'dg-coach-text');
  bubbleText.append(el('b', null, 'Michael'), bubbleLine);
  bubble.append(bubbleFace, bubbleText);

  // Bottom: backhand or forehand, and the bag of discs with their flight numbers.
  const rangeUi = el('div', 'dg-range');
  const hands = el('div', 'dg-hands');
  hands.setAttribute('role', 'group');
  hands.setAttribute('aria-label', 'Throw style');
  const handBtns = ['Backhand', 'Forehand'].map((name) => {
    const btn = el('button', 'dg-hand', name);
    btn.type = 'button';
    hands.append(btn);
    return btn;
  });
  const bag = el('div', 'dg-bag');
  bag.setAttribute('role', 'group');
  bag.setAttribute('aria-label', 'Discs');
  const discBtns = DISCS.map((d) => {
    const btn = el('button', 'dg-disc');
    btn.type = 'button';
    const dot = el('span', 'dg-disc-dot');
    dot.style.backgroundColor = `#${d.color.toString(16).padStart(6, '0')}`;
    btn.append(dot, el('span', 'dg-disc-name', d.name), el('span', 'dg-disc-nums', `${d.speed} ${d.glide} ${d.turn} ${d.fade}`));
    btn.title = `${d.kind}: speed ${d.speed}, glide ${d.glide}, turn ${d.turn}, fade ${d.fade}`;
    btn.setAttribute('aria-label', `${d.name}. ${btn.title}`);
    bag.append(btn);
    return btn;
  });
  const smallPrint = el('p', 'dg-smallprint', 'Flight numbers as printed on the discs: speed, glide, turn, fade. Not affiliated with Discmania.');
  rangeUi.append(hands, bag, smallPrint);
  const tally = el('p', 'dg-tally');

  // Covers the scene for a moment while it moves between the hill and the range.
  const curtain = el('div', 'dg-curtain');

  const panel = el('div', 'dg-panel');
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');
  const panelEyebrow = el('p', 'dg-eyebrow');
  const panelTitle = el('p', 'dg-title');
  const panelText = el('p', 'dg-text');
  const panelProgress = el('p', 'dg-progress');
  const panelLink = el('a', 'dg-link', 'Open the project page');
  const panelGo = el('button', 'dg-link', 'Go to the practice range'); // takes the place of the link in the offer
  panelGo.type = 'button';
  panelGo.hidden = true;
  const panelAgain = el('button', 'dg-again', 'Throw again');
  panelAgain.type = 'button';
  const actions = el('div', 'dg-actions');
  actions.append(panelLink, panelGo, panelAgain);
  panel.append(panelEyebrow, panelTitle, panelText, panelProgress, actions);

  stage.append(canvas, leads, labels, handle, hint, bubble, rangeUi, tally, switchBtn, panel, curtain);
  root.append(stage);

  /* ----- throwing ----- */

  // P0 is where the disc leaves the hand. P0, TEE_CAM and TEE_LOOK belong to the place the
  // visitor is at and are moved when the scene goes to the range and back.
  const P0 = new THREE.Vector3(0, TEE_Y + 1.15, -0.6);
  const COURSE = {
    name: 'course',
    p0: P0.clone(),
    cam: TEE_CAM.clone(),
    look: TEE_LOOK.clone(),
    targets: baskets,
    fog: [30, 68],
    sun: [0, -18, 1],
    out: (x, z) => Math.abs(x) > 50 || z < -74 || z > 12,
  };
  const RANGE = {
    name: 'range',
    p0: new THREE.Vector3(RANGE_X, RANGE_Y + 1.15, -0.6),
    cam: new THREE.Vector3(RANGE_X, RANGE_Y + 2.5, CAM_Z),
    look: new THREE.Vector3(RANGE_X, RANGE_Y + 1.5, -14),
    targets: rangeTargets,
    fog: [75, 190],
    sun: [RANGE_X, -50, 2.1],
    out: (x, z) => Math.abs(x - RANGE_X) > 68 || z < -138 || z > 14,
  };
  let level = COURSE;
  const range = { disc: 1, hand: 'backhand', hits: 0, longest: 0, offered: false };
  const state = { mode: 'ready', throws: 0, disc: null, flight: null, aim: null, drag: null, target: null, slide: null, settle: null, seq: 0, clock: 0, keyboard: false };
  const litter = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const heading = new THREE.Vector3(0, 0, -1); // the way the disc in the air is flying
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();

  function setMode(mode) {
    state.mode = mode;
    stage.dataset.mode = mode;
  }

  /* ----- the round: what the browser remembers between visits ----- */

  // discs: colours of the discs lying in each basket (by the path of the project page).
  // hit: baskets hit by hand in this round. throws: hand throws in this round.
  // won: the prize has been won.
  const saved = { discs: {}, hit: [], throws: 0, won: false };
  try {
    const s = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
    const known = new Set(baskets.map((b) => b.key));
    for (const [key, list] of Object.entries(s.discs || {})) {
      if (known.has(key) && Array.isArray(list)) saved.discs[key] = list.slice(-3).map((n) => Math.max(-1, n | 0));
    }
    saved.hit = (Array.isArray(s.hit) ? s.hit : []).filter((key) => known.has(key));
    saved.throws = Math.max(0, s.throws | 0);
    saved.won = s.won === true;
  } catch (err) {
    // No storage in this browser: the round lasts until the page is closed.
  }
  function save() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (err) {
      // ignore
    }
  }

  // colour: a number picks from the disc colours, -1 is the golden disc.
  // On the range the disc gets the material of the disc chosen in the bag.
  function makeDisc(color, mat) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(discGeo, mat || (color < 0 ? goldMat : discMats[color % discMats.length]));
    body.castShadow = true;
    body.add(new THREE.Mesh(stripeGeo, stripeMat));
    g.add(body);
    g.userData.body = body;
    g.userData.color = color;
    scene.add(g);
    return g;
  }

  function spawnDisc() {
    const g = level === RANGE ? makeDisc(0, rangeMats[range.disc]) : makeDisc(saved.won ? -1 : discCount++);
    g.userData.born = state.clock;
    g.position.copy(P0);
    state.disc = g;
  }

  // Where a disc rests in a basket: leaning in the chains on the side that faces the tee,
  // where it can be seen. A basket holds up to three discs, one per slot.
  function restPose(b, slot) {
    const teeX = b.metres ? RANGE_X : 0;
    const a = Math.atan2(teeX - b.x, -b.z) + [0, 0.75, -0.75][slot];
    const lean = new THREE.Vector3(Math.sin(a) * 0.75, 0.65, Math.cos(a) * 0.75).normalize();
    return {
      pos: new THREE.Vector3(b.x + Math.sin(a) * 0.4, b.y + TRAY_Y + 0.52, b.z + Math.cos(a) * 0.4),
      quat: new THREE.Quaternion().setFromUnitVectors(UP, lean),
    };
  }

  // A new round after the prize: empty baskets, no marks, the cup stays beside the tee.
  function newRound() {
    saved.discs = {};
    saved.hit = [];
    saved.throws = 0;
    for (const b of baskets) {
      for (const d of b.discs) scene.remove(d);
      b.discs = [];
      b.label.classList.remove('is-hit');
    }
    if (saved.won) placeTrophy(true);
    save();
  }

  // Put back what the visitor left behind last time.
  function restoreRound() {
    if (saved.hit.length >= baskets.length) return newRound();
    for (const b of baskets) {
      for (const color of saved.discs[b.key] || []) {
        const d = makeDisc(color);
        const pose = restPose(b, b.discs.length);
        d.position.copy(pose.pos);
        d.quaternion.copy(pose.quat);
        d.userData.slot = b.discs.length;
        b.discs.push(d);
      }
      b.label.classList.toggle('is-hit', saved.hit.includes(b.key));
    }
    if (saved.won) placeTrophy(true);
  }

  function launchVelocity(yaw, power) {
    const reach = 4 + 44 * power;
    const v = Math.sqrt((reach * G) / Math.sin(2 * PITCH));
    const flat = Math.cos(PITCH) * v;
    return new THREE.Vector3(Math.sin(yaw) * flat, Math.sin(PITCH) * v, -Math.cos(yaw) * flat);
  }

  // What a point on the way of the disc meets: a basket, the ground, the edge, or nothing yet.
  function meets(x, y, z, only) {
    for (const b of level.targets) {
      if (only && b !== only) continue;
      const r = b.reach || CATCH_R;
      if ((x - b.x) ** 2 + (z - b.z) ** 2 < r * r && y > b.y + CATCH_LO && y < b.y + CATCH_HI) return b;
    }
    if (y <= groundY(x, z) + 0.05) return 'ground';
    if (level.out(x, z)) return 'out';
    return null;
  }

  // Follows a throw on the hill in small steps until it meets a basket, the ground or the edge.
  // The disc on the hill flies like a ball in light gravity: easy to aim.
  function simulate(v0, only) {
    const pts = [];
    const from = P0.clone();
    for (let i = 1; i <= 400; i++) {
      const t = i * STEP;
      const x = P0.x + v0.x * t;
      const y = P0.y + v0.y * t - 0.5 * G * t * t;
      const z = P0.z + v0.z * t;
      pts.push(x, y, z);
      const met = meets(x, y, z, only);
      if (met) return { pts, from, t, hit: typeof met === 'object' ? met : null, out: met === 'out' };
    }
    return { pts, from, t: 400 * STEP, hit: null, out: true };
  }

  // Follows a throw on the range, where the flight numbers of the disc bend the line.
  // A disc is made for a speed. Faster than that it turns, slower it fades. A backhand
  // fades to the left and turns to the right, a forehand the other way round.
  function simulateDisc(disc, hand, yaw, power) {
    const pts = [];
    const from = P0.clone();
    const side = hand === 'forehand' ? 1 : -1;
    const made = 8 + 1.6 * disc.speed;      // the speed the disc is made for
    const drag = 0.8 - 0.047 * disc.speed;  // a putter slows down fast, a driver keeps its speed
    const v0 = (0.3 + 0.7 * power) * FLIGHT.arm;
    let x = P0.x;
    let y = P0.y;
    let z = P0.z;
    let vx = Math.sin(yaw) * Math.cos(FLIGHT.pitch) * v0;
    let vy = Math.sin(FLIGHT.pitch) * v0;
    let vz = -Math.cos(yaw) * Math.cos(FLIGHT.pitch) * v0;
    for (let i = 1; i <= 700; i++) {
      const flat = Math.hypot(vx, vz) || 1e-6;
      const ratio = flat / made;
      const bend = side * (disc.fade * smooth(0.9, 0.4, ratio) * FLIGHT.fade + disc.turn * smooth(0.85, 1.15, ratio) * FLIGHT.turn);
      const lift = G * Math.min(0.97, (disc.glide / 5) * (flat / 16) ** 2);
      const rx = -vz / flat; // the right-hand side of the flight line
      const rz = vx / flat;
      vx += (-drag * vx + rx * bend) * STEP;
      vz += (-drag * vz + rz * bend) * STEP;
      vy += (-G + lift - 1.2 * vy) * STEP;
      x += vx * STEP;
      y += vy * STEP;
      z += vz * STEP;
      pts.push(x, y, z);
      const met = meets(x, y, z, null);
      if (met) return { pts, from, t: i * STEP, hit: typeof met === 'object' ? met : null, out: met === 'out' };
    }
    return { pts, from, t: 700 * STEP, hit: null, out: true };
  }

  // Where the disc is at time t of a simulated throw.
  function pathAt(sim, t, out) {
    const f = clamp(t / STEP, 0, sim.pts.length / 3);
    const i = Math.min(Math.floor(f), sim.pts.length / 3 - 1); // between point i-1 (the hand for i = 0) and point i
    const k = f - i;
    const b = i * 3;
    const ax = i ? sim.pts[b - 3] : sim.from.x;
    const ay = i ? sim.pts[b - 2] : sim.from.y;
    const az = i ? sim.pts[b - 1] : sim.from.z;
    return out.set(ax + (sim.pts[b] - ax) * k, ay + (sim.pts[b + 1] - ay) * k, az + (sim.pts[b + 2] - az) * k);
  }

  function showDots(sim) {
    const steps = sim.pts.length / 3;
    const stride = Math.max(3, Math.ceil(steps / DOTS)); // long throws on the range get wider gaps
    const n = Math.min(DOTS, Math.floor(steps / stride));
    for (let i = 0; i < n; i++) {
      const j = ((i + 1) * stride - 1) * 3;
      tmpV.set(sim.pts[j], sim.pts[j + 1], sim.pts[j + 2]);
      dots.setMatrixAt(i, tmpM.compose(tmpV, tmpQ.identity(), tmpS.setScalar((1 - (0.45 * i) / DOTS) * (stride > 3 ? 1.6 : 1))));
    }
    dots.count = n;
    dots.instanceMatrix.needsUpdate = true;
    dots.visible = n > 0;
  }

  function setAimed(b) {
    for (const k of allTargets) k.label.classList.toggle('is-aimed', k === b);
  }

  function clearAim() {
    state.aim = null;
    dots.visible = false;
    setAimed(null);
  }

  function aimFrom(dx, dy) {
    const len = Math.hypot(dx, dy);
    const full = Math.min(stageH * 0.42, 230);
    if (dy < 6 || len < 16) return clearAim();
    const yaw = clamp(Math.atan2(-dx, dy), -0.95, 0.95);
    const power = clamp((len - 16) / (full - 16), 0, 1);
    const sim = level === RANGE ? simulateDisc(DISCS[range.disc], range.hand, yaw, power) : simulate(launchVelocity(yaw, power), null);
    state.aim = { yaw, power, sim };
    showDots(sim);
    setAimed(sim.hit);
  }

  function throwDisc(sim, assisted) {
    state.flight = { sim, t: 0 };
    state.assisted = assisted;
    state.throws++;
    if (!assisted && level === COURSE) {
      saved.throws++;
      save();
    }
    stage.classList.add('is-used');
    clearAim();
    setMode('flying');
  }

  // The throw a sign asks for: a clean arc that ends in the chains of that basket.
  function assistedThrow(b, keyboard) {
    if (level !== COURSE || state.moving || state.mode === 'flying' || state.mode === 'aiming') return;
    state.farOff = false;
    if (state.mode === 'landed') finishLanding();
    if (state.mode === 'caught' || state.mode === 'won' || state.mode === 'offer') closePanel();
    state.keyboard = keyboard;
    const dist = Math.hypot(b.x - P0.x, b.z - P0.z);
    const ty = b.y + (CATCH_LO + CATCH_HI) / 2;
    for (let T = 1 + dist * 0.035, tries = 0; tries < 6; T += 0.3, tries++) {
      const v0 = new THREE.Vector3((b.x - P0.x) / T, (ty - P0.y) / T + 0.5 * G * T, (b.z - P0.z) / T);
      const sim = simulate(v0, b);
      if (sim.hit) return throwDisc(sim, true);
    }
  }

  function finishLanding() {
    if (state.slide?.out) scene.remove(state.disc);
    else litter.push(state.disc);
    if (litter.length > 8) scene.remove(litter.shift());
    state.slide = null;
    state.disc = null;
    if (state.farOff) {
      state.farOff = false;
      range.offered = true;
      return openOffer();
    }
    spawnDisc();
    setMode('ready');
  }

  const metres = (n) => `${n} ${n === 1 ? 'metre' : 'metres'}`;

  function onMiss(f) {
    const pts = f.sim.pts;
    const n = pts.length;
    const x = pts[n - 3];
    const z = pts[n - 1];
    // The last step of the flight gives the way the disc slides.
    const vx = n >= 6 ? (x - pts[n - 6]) / STEP : 0;
    const vz = n >= 6 ? (z - pts[n - 4]) / STEP : 0;
    state.slide = { vx: vx * 0.22, vz: vz * 0.22, t: 0, out: f.sim.out };
    const nearest = level.targets.reduce((a, b) => (Math.hypot(x - b.x, z - b.z) < Math.hypot(x - a.x, z - a.z) ? b : a));
    const gap = Math.round(Math.hypot(x - nearest.x, z - nearest.z));
    if (level === RANGE) {
      const far = Math.round(Math.hypot(x - P0.x, z - P0.z));
      range.longest = Math.max(range.longest, far);
      say(f.sim.out ? `${metres(far)}, and out of the range.` : `${metres(far)}. ${metres(gap)} from the ${nearest.metres} metre basket.`);
      showTally();
    } else if (!range.offered) {
      // A hand throw that leaves the hill, lands behind the tee or far from every basket.
      state.farOff = f.sim.out || z > 1 || gap > 12;
    }
    setMode('landed');
  }

  // A throw far off the hill: Michael offers a turn on the practice range. Once per visit.
  function openOffer() {
    setMode('offer');
    panel.classList.add('is-long');
    panelEyebrow.textContent = 'Far off';
    panelTitle.textContent = 'Michael has a practice range';
    panelText.textContent = 'Pick a disc, try backhand and forehand, and throw at baskets at three distances.';
    panelProgress.hidden = true;
    panelLink.hidden = true;
    panelGo.hidden = false;
    panelAgain.textContent = 'Stay here';
    showPanel();
  }

  function onCatch(b) {
    const d = state.disc;
    state.target = b;
    if (b.discs.length >= 3) scene.remove(b.discs.shift());
    const taken = b.discs.map((x) => x.userData.slot);
    d.userData.slot = [0, 1, 2].find((slot) => !taken.includes(slot));
    const pose = restPose(b, d.userData.slot);
    state.settle = { disc: d, from: d.position.clone(), to: pose.pos, fromQ: d.quaternion.clone(), toQ: pose.quat, t: 0 };
    b.discs.push(d);
    b.jig = 0;

    if (level === RANGE) {
      // On the range a hit is its own reward: Michael cheers and the next disc is ready.
      if (!reduceMotion) confetti(b.x, b.y + 2.4, b.z, 22, 2.2);
      range.hits++;
      range.cheer = state.clock;
      range.longest = Math.max(range.longest, b.metres);
      say(`In the chains from ${metres(b.metres)} with the ${DISCS[range.disc].name}.`);
      showTally();
      setMode('caught');
      const seq = ++state.seq;
      window.setTimeout(() => {
        if (state.seq !== seq || state.mode !== 'caught') return;
        state.target = null;
        spawnDisc();
        setMode('ready');
      }, 1700);
      return;
    }

    // Only hand throws count towards the prize. A throw by sign still leaves its disc in the basket.
    const byHand = !state.assisted;
    if (byHand) {
      if (!saved.hit.includes(b.key)) saved.hit.push(b.key);
      b.label.classList.add('is-hit');
    }
    const prize = byHand && saved.hit.length === baskets.length;
    if (prize) saved.won = true;
    saved.discs[b.key] = b.discs.map((x) => x.userData.color);
    save();

    if (!reduceMotion) confetti(b.x, b.y + 2.4, b.z, 22, 2.2);
    setMode('caught');
    const seq = ++state.seq;
    window.setTimeout(() => {
      if (state.seq !== seq || state.mode !== 'caught') return;
      if (prize) celebrate();
      else openPanel(b);
    }, prize ? 900 : 500);
  }

  function showPanel() {
    if (state.mode !== 'offer') {
      panelLink.hidden = false;
      panelGo.hidden = true;
    }
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('is-open'));
  }

  function openPanel(b) {
    const n = baskets.length;
    panel.classList.remove('is-long');
    panelEyebrow.textContent = state.assisted
      ? 'In the basket'
      : state.throws === 1
        ? 'Hole in one'
        : `In the basket on throw ${state.throws}`;
    panelTitle.textContent = b.title;
    panelText.textContent = b.text;
    panelProgress.hidden = state.assisted;
    panelProgress.textContent = saved.won
      ? `${saved.hit.length} of ${n} baskets in this round.`
      : `${saved.hit.length} of ${n} baskets by hand. Hit them all and there is a prize.`;
    panelLink.textContent = 'Open the project page';
    panelLink.href = b.href;
    panelAgain.textContent = 'Throw again';
    showPanel();
    if (state.keyboard) panelLink.focus({ preventScroll: true });
  }

  // Every basket is hit by hand: the cup rises over the fairway and the panel offers a mail to Michael.
  function celebrate() {
    state.wonAt = state.clock;
    state.party = 0;
    placeTrophy(false);
    setMode('won');
    const seq = ++state.seq;
    window.setTimeout(() => {
      if (state.seq === seq && state.mode === 'won') openPrize();
    }, reduceMotion ? 0 : 1200);
  }

  function openPrize() {
    const n = baskets.length;
    const all = `All ${WORDS[n] || n} baskets`;
    const throws = `${saved.throws} ${saved.throws === 1 ? 'throw' : 'throws'}`;
    panel.classList.add('is-long');
    panelEyebrow.textContent = all;
    panelTitle.textContent = 'The golden disc is yours';
    panelText.textContent = `You hit every basket by hand in ${throws}. You are welcome to write to me and tell me how it went.`;
    panelProgress.hidden = true;
    panelLink.textContent = 'Write to me';
    panelLink.href = `mailto:${MAIL}?subject=${encodeURIComponent(`${all} in ${throws}`)}`;
    panelAgain.textContent = 'Keep playing';
    showPanel();
  }

  function closePanel() {
    const afterPrize = state.mode === 'won';
    state.seq++;
    panel.classList.remove('is-open');
    panel.hidden = true;
    state.throws = 0;
    state.target = null;
    if (afterPrize) newRound();
    spawnDisc();
    setMode('ready');
  }

  panelAgain.addEventListener('click', () => {
    const back = state.target?.label;
    closePanel();
    if (state.keyboard && back) back.focus({ preventScroll: true });
  });
  panelGo.addEventListener('click', () => {
    if (state.mode !== 'offer') return;
    closePanel();
    goTo(RANGE);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panelAgain.click();
  });

  /* ----- the practice range ----- */

  function say(text) {
    bubbleLine.textContent = text;
  }

  function showTally() {
    tally.replaceChildren(el('span', null, `Hits ${range.hits}`), el('span', null, `Longest ${range.longest} m`));
  }

  // What Michael says about a disc. Left and right swap with the throw style.
  function describe(i) {
    const fade = range.hand === 'backhand' ? 'left' : 'right';
    const turn = range.hand === 'backhand' ? 'right' : 'left';
    return [
      'P2, a putter. Slow and straight. Try the nearest basket.',
      `MD3, a midrange. Straight, with a small fade to the ${fade} at the end.`,
      `FD, a fairway driver. Long and easy to steer. It fades a little to the ${fade}.`,
      `TD, a turning driver. Thrown hard it drifts to the ${turn}. Thrown softly it fades to the ${fade}.`,
      `DD3, a distance driver. It wants speed and finishes hard to the ${fade}.`,
    ][i];
  }

  function pickDisc(i, quiet) {
    range.disc = i;
    discBtns.forEach((btn, k) => {
      btn.classList.toggle('is-on', k === i);
      btn.setAttribute('aria-pressed', String(k === i));
    });
    if (level === RANGE && state.mode === 'ready' && state.disc) state.disc.userData.body.material = rangeMats[i];
    if (!quiet) say(describe(i));
  }

  function pickHand(hand, quiet) {
    range.hand = hand;
    handBtns.forEach((btn, k) => {
      const on = (k === 0) === (hand === 'backhand');
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    if (!quiet) say(hand === 'backhand' ? 'Backhand. The fade goes to the left.' : 'Forehand. Now the fade goes to the right.');
  }

  // The sun and its shadows follow the visitor to the place they are at.
  function aimSun() {
    const [x, z, size] = level.sun;
    sun.target.position.set(x, 0, z);
    sun.position.set(x - 24 * size, 34 * size, z + 32 * size);
    Object.assign(sun.shadow.camera, { left: -38 * size, right: 38 * size, top: 36 * size, bottom: -30 * size, near: 1, far: 120 * size });
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  // Moves the scene to the range or back to the hill, behind a short curtain.
  function goTo(next) {
    if (next === level || state.moving || state.mode === 'flying' || state.mode === 'aiming') return;
    const swap = () => {
      state.farOff = false;
      if (state.mode === 'landed') finishLanding();
      else if (state.mode !== 'ready') closePanel();
      scene.remove(state.disc); // the disc that waits on the tee stays behind
      level = next;
      P0.copy(level.p0);
      TEE_CAM.copy(level.cam);
      TEE_LOOK.copy(level.look);
      camPos.copy(TEE_CAM);
      camLook.copy(TEE_LOOK);
      scene.fog.near = level.fog[0];
      scene.fog.far = level.fog[1];
      aimSun();
      stage.dataset.level = level.name;
      switchBtn.textContent = level === RANGE ? 'Back to the projects' : 'Practice range';
      spawnDisc();
      setMode('ready');
      resize();
      if (level === RANGE) {
        say('Welcome to the range. Pick a disc, choose backhand or forehand, and throw at the baskets.');
        showTally();
      }
      state.moving = false;
      curtain.classList.remove('is-down');
    };
    state.moving = true;
    if (reduceMotion) return swap();
    curtain.classList.add('is-down');
    window.setTimeout(swap, 320);
  }

  switchBtn.addEventListener('click', () => goTo(level === RANGE ? COURSE : RANGE));
  discBtns.forEach((btn, i) => btn.addEventListener('click', () => pickDisc(i)));
  handBtns.forEach((btn, k) => btn.addEventListener('click', () => pickHand(k === 0 ? 'backhand' : 'forehand')));

  /* ----- pointer input ----- */

  function dragStart(e) {
    if (state.mode !== 'ready' || state.moving || (e.button != null && e.button > 0)) return;
    state.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setMode('aiming');
  }
  function dragMove(e) {
    if (state.mode !== 'aiming' || e.pointerId !== state.drag.id) return;
    aimFrom(e.clientX - state.drag.x, e.clientY - state.drag.y);
  }
  function dragEnd(e) {
    if (state.mode !== 'aiming' || e.pointerId !== state.drag.id) return;
    const aim = e.type === 'pointerup' ? state.aim : null;
    state.drag = null;
    state.keyboard = false;
    if (aim) throwDisc(aim.sim, false);
    else {
      clearAim();
      setMode('ready');
    }
  }
  // Touch starts on the disc only, so a finger elsewhere on the scene still scrolls the page.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') dragStart(e);
  });
  handle.addEventListener('pointerdown', dragStart);
  for (const target of [canvas, handle]) {
    target.addEventListener('pointermove', dragMove);
    target.addEventListener('pointerup', dragEnd);
    target.addEventListener('pointercancel', dragEnd);
  }

  /* ----- layout ----- */

  let stageW = 1;
  let stageH = 1;

  function resize() {
    stageW = stage.clientWidth || 1;
    stageH = stage.clientHeight || 1;
    renderer.setSize(stageW, stageH, false);
    camera.aspect = stageW / stageH;
    // Keep all baskets in view on narrow screens by widening the vertical angle.
    const v = 2 * Math.atan(Math.tan((34 * Math.PI) / 180) / camera.aspect);
    camera.fov = clamp((v * 180) / Math.PI, 44, 74);
    camera.updateProjectionMatrix();
    for (const b of allTargets) {
      if (!b.label.offsetWidth) continue; // the signs are hidden while the prize is shown
      b.lw = b.label.offsetWidth;
      b.lh = b.label.offsetHeight;
    }
  }

  function placeLabels() {
    const seen = [];
    for (const b of allTargets) {
      tmpV.set(b.x, b.y + 2.75, b.z).project(camera);
      // Only the signs of the place the visitor is at are shown.
      b.on = level.targets.includes(b) && tmpV.z > -1 && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.2;
      b.ax = (tmpV.x * 0.5 + 0.5) * stageW; // the point above the basket that the sign points at
      b.ay = (-tmpV.y * 0.5 + 0.5) * stageH;
      b.sx = clamp(b.ax, b.lw / 2 + 6, stageW - b.lw / 2 - 6);
      b.sy = b.ay - 10;
      b.depth = tmpV.z;
      if (b.on) seen.push(b);
    }
    // Nearest sign keeps its place. A sign further away moves up until it is free of the others.
    seen.sort((a, b) => a.depth - b.depth);
    const placed = [];
    for (const b of seen) {
      let bottom = b.sy;
      for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        for (const p of placed) {
          const overlapX = Math.abs(b.sx - p.sx) < (b.lw + p.lw) / 2 + 6;
          if (overlapX && bottom - b.lh < p.bottom + 4 && bottom > p.top - 4) {
            bottom = p.top - 4;
            moved = true;
          }
        }
        if (!moved) break;
      }
      bottom = Math.max(bottom, b.lh + 6);
      b.top = bottom - b.lh;
      b.bottom = bottom;
      placed.push(b);
    }
    for (const b of allTargets) {
      const spot = b.on ? `${b.sx.toFixed(1)} ${b.bottom.toFixed(1)} ${b.ax.toFixed(1)} ${b.ay.toFixed(1)}` : 'off';
      if (spot !== b.spot) {
        b.spot = spot;
        b.label.style.transform = b.on
          ? `translate(${b.sx.toFixed(1)}px, ${b.bottom.toFixed(1)}px) translate(-50%, -100%)`
          : 'translate(-999px, -999px)';
        b.label.style.visibility = b.on ? 'visible' : 'hidden';
        b.lead.style.display = b.on ? '' : 'none';
        if (b.on) {
          const x1 = clamp(b.ax, b.sx - b.lw / 2 + 8, b.sx + b.lw / 2 - 8);
          b.lead.setAttribute('x1', x1.toFixed(1));
          b.lead.setAttribute('y1', (b.bottom - 1).toFixed(1));
          b.lead.setAttribute('x2', b.ax.toFixed(1));
          b.lead.setAttribute('y2', b.ay.toFixed(1));
        }
      }
    }
    tmpV.copy(P0).project(camera);
    const hx = ((tmpV.x * 0.5 + 0.5) * stageW).toFixed(0);
    const hy = ((-tmpV.y * 0.5 + 0.5) * stageH).toFixed(0);
    const hcss = `translate(${hx}px, ${hy}px) translate(-50%, -50%)`;
    if (hcss !== handle.dataset.css) {
      handle.dataset.css = hcss;
      handle.style.transform = hcss;
    }
  }

  /* ----- frame ----- */

  function update(dt) {
    state.clock += dt;
    const d = state.disc;

    if (state.mode === 'ready' && d) {
      const age = state.clock - d.userData.born;
      d.scale.setScalar(smooth(0, 0.25, age));
      d.position.copy(P0);
      if (!reduceMotion) {
        d.position.y += Math.sin(state.clock * 2.2) * 0.05;
        d.userData.body.rotation.y += dt * 1.4;
      }
      d.rotation.set(-0.18, 0, 0);
    }

    if (state.mode === 'aiming' && d) {
      const a = state.aim;
      const pull = a ? 0.25 + a.power * 0.75 : 0;
      const yaw = a ? a.yaw : 0;
      d.position.set(P0.x - Math.sin(yaw) * pull, P0.y - 0.12 * pull, P0.z + Math.cos(yaw) * pull);
      d.rotation.set(-0.18 - 0.3 * pull, 0, 0);
    }

    if (state.mode === 'flying') {
      const f = state.flight;
      f.t = Math.min(f.t + dt, f.sim.t);
      pathAt(f.sim, f.t, d.position);
      // The heading now and a moment later tell which way the disc flies and how it curves.
      pathAt(f.sim, f.t + 0.1, tmpV);
      const hx = tmpV.x - d.position.x;
      const hz = tmpV.z - d.position.z;
      const len = Math.hypot(hx, hz);
      let bank = -0.25 * Math.sin((f.t / f.sim.t) * Math.PI);
      if (len > 1e-4) {
        const oldX = heading.x;
        const oldZ = heading.z;
        heading.set(hx / len, 0, hz / len);
        // On the range the disc leans into its curve: right edge down in a turn to the right.
        if (level === RANGE && f.t > 0.15) bank = clamp(((oldZ * heading.x - oldX * heading.z) / Math.max(dt, 0.008)) * 0.8, -0.6, 0.6);
      }
      f.bank = f.bank === undefined ? bank : f.bank + (bank - f.bank) * Math.min(1, dt * 8);
      d.rotation.set(-0.12, 0, f.bank);
      d.userData.body.rotation.y += dt * 24;
      if (f.t >= f.sim.t) {
        if (f.sim.hit) onCatch(f.sim.hit);
        else onMiss(f);
      }
    }

    if (state.mode === 'landed') {
      const s = state.slide;
      s.t += dt;
      if (s.out) {
        d.position.y -= dt * 6;
      } else if (s.t < 0.8) {
        d.position.x += s.vx * dt;
        d.position.z += s.vz * dt;
        const k = Math.exp(-5 * dt);
        s.vx *= k;
        s.vz *= k;
        const x = d.position.x;
        const z = d.position.z;
        d.position.y = groundY(x, z) + 0.06;
        tmpN.set(groundY(x - 0.3, z) - groundY(x + 0.3, z), 0.6, groundY(x, z - 0.3) - groundY(x, z + 0.3)).normalize();
        d.quaternion.setFromUnitVectors(UP, tmpN);
        d.userData.body.rotation.y += dt * 24 * Math.exp(-5 * s.t);
      }
      if (s.t > (level === RANGE ? 2 : 1.1)) finishLanding(); // on the range there is a distance to read
    }

    if (state.settle) {
      const s = state.settle;
      s.t = Math.min(1, s.t + dt / 0.3);
      const k = s.t * s.t * (3 - 2 * s.t);
      s.disc.position.lerpVectors(s.from, s.to, k);
      s.disc.quaternion.slerpQuaternions(s.fromQ, s.toQ, k);
      if (s.t >= 1) state.settle = null;
    }

    if (level === RANGE && !reduceMotion) {
      // Michael sways a little and jumps when a disc goes in.
      const cheer = state.clock - (range.cheer ?? -9);
      coach.position.y = COACH_AT.y + (cheer < 0.9 ? Math.abs(Math.sin(cheer * Math.PI * 3.3)) * 0.22 * (1 - cheer / 0.9) : 0);
      coach.rotation.z = Math.sin(state.clock * 1.3) * 0.015;
    }

    for (const b of allTargets) {
      if (b.jig < 0) continue;
      b.jig += dt;
      const a = 0.16 * Math.exp(-3.2 * b.jig);
      b.chains.rotation.set(a * Math.sin(b.jig * 19), 0, a * Math.cos(b.jig * 15));
      if (b.jig > 1.8) {
        b.jig = -1;
        b.chains.rotation.set(0, 0, 0);
      }
    }

    if (state.mode === 'won' && !reduceMotion) {
      const t = state.clock - state.wonAt;
      trophy.scale.setScalar(2.3 * smooth(0, 0.5, t));
      trophy.position.y = TROPHY_UP.y + Math.sin(t * 2) * 0.12;
      trophy.rotation.y += dt * 1.3;
      if (t < 4 && t >= state.party) {
        state.party += 0.7;
        confetti(TROPHY_UP.x, TROPHY_UP.y + 3, TROPHY_UP.z, 24, 3);
        for (const b of baskets) confetti(b.x, b.y + 2.4, b.z, 5, 2);
      }
    }

    if (bits.visible) {
      let alive = 0;
      bitState.forEach((s, i) => {
        const on = s.age < s.life;
        if (on) {
          alive++;
          s.age += dt;
          s.v.y -= 9 * dt;
          s.p.addScaledVector(s.v, dt);
          s.r += s.w * dt;
        }
        tmpQ.setFromAxisAngle(UP, s.r);
        bits.setMatrixAt(i, tmpM.compose(s.p, tmpQ, tmpS.setScalar(on ? Math.max(0.01, 1 - s.age / s.life) : 0)));
      });
      bits.instanceMatrix.needsUpdate = true;
      if (!alive) bits.visible = false;
    }

    if (!reduceMotion) {
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > c.userData.home + c.userData.reach) c.position.x = c.userData.home - c.userData.reach;
      }
    }

    // Camera: at the tee, following the disc, or standing by the basket that caught it.
    goalPos.copy(TEE_CAM);
    goalLook.copy(TEE_LOOK);
    let quick = 2.8;
    if (!reduceMotion) {
      if ((state.mode === 'flying' || state.mode === 'landed') && d) {
        if (level === RANGE) {
          // Throws on the range are long: the camera flies behind the disc.
          goalPos.set(d.position.x - heading.x * 8, 0, d.position.z - heading.z * 8);
          goalPos.y = Math.max(d.position.y + 2.4, groundY(goalPos.x, goalPos.z) + 1.8);
          goalLook.set(d.position.x + heading.x * 4, d.position.y + 0.2, d.position.z + heading.z * 4);
          quick = 4.5;
        } else {
          goalLook.lerp(d.position, 0.5);
          goalPos.set(d.position.x * 0.12, TEE_CAM.y + 0.3, CAM_Z + d.position.z * 0.12);
        }
      } else if (state.mode === 'caught' && state.target) {
        if (state.target.cam) {
          goalPos.copy(state.target.cam);
          goalLook.copy(state.target.look);
        } else {
          // A basket on the range: stay where the camera is and look at the basket.
          goalPos.copy(camPos);
          goalLook.set(state.target.x, state.target.y + 1.4, state.target.z);
        }
      }
    }
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * quick);
    camPos.lerp(goalPos, k);
    camLook.lerp(goalLook, k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.updateMatrixWorld();

    placeLabels();
  }

  let running = false;
  let inView = true;
  let last = 0;

  // While the disc waits on the tee, only the clouds and the disc move: draw every other
  // frame and leave the shadows as they are. Everything is redrawn in full during a throw.
  renderer.shadowMap.autoUpdate = false;
  let tick = 0;

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const idle = state.mode === 'ready' && state.clock - state.disc.userData.born > 0.5 && camPos.distanceToSquared(TEE_CAM) < 1e-4;
    if (idle && tick++ % 2) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    if (!idle) renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function setRunning() {
    const on = inView && !document.hidden;
    if (on && !running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    } else if (!on) {
      running = false;
    }
  }

  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1].isIntersecting;
    setRunning();
  }).observe(stage);
  document.addEventListener('visibilitychange', setRunning);
  document.fonts?.ready.then(resize);

  stage.dataset.level = level.name;
  pickDisc(range.disc, true);
  pickHand(range.hand, true);
  showTally();
  restoreRound();
  spawnDisc();
  setMode('ready');
  resize();
  setRunning();
}
