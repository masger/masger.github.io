/* Disc golf hill for the Projects page.

   The script reads the project cards that Quarto renders (a.quarto-grid-link)
   and puts one basket per project on a low-poly hill. Pull the disc back and
   let go to throw, or pick a sign and the disc flies to that basket.
   A new project page under projects/ gets its own basket automatically.

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

// The ground is levelled around the tee so the pad lies flat.
function groundY(x, z) {
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
  const nearCatchView = (x, z, r) =>
    baskets.some((b) => Math.hypot(x - b.cam.x, z - b.cam.z) < r + 2 || distToSegment(x, z, b.cam.x, b.cam.z, b.x, b.z) < r);
  const fairwayDist = (x, z) => Math.min(...baskets.map((b) => distToSegment(x, z, 0, 0, b.x, b.z)));
  const sightDist = (x, z) => Math.min(...baskets.map((b) => distToSegment(x, z, 0, CAM_Z, b.x, b.z)));

  /* ----- terrain mesh ----- */

  {
    const W = 108;
    const D = 92;
    const SX = 66;
    const SZ = 56;
    let geo = new THREE.PlaneGeometry(W, D, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -32);
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
    const fair = new THREE.Color(COL.fairway);
    for (let f = 0; f < p.count; f += 3) {
      const cx = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
      const cz = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
      const n = 0.5 + 0.5 * Math.sin(cx * 0.21 + 0.7) * Math.cos(cz * 0.17 - 1.1);
      c.copy(a).lerp(b, n);
      const d = Math.min(fairwayDist(cx, cz), ...baskets.map((k) => Math.hypot(cx - k.x, cz - k.z) - 1.2));
      c.lerp(fair, 0.8 * smooth(2.6, 1.2, d));
      c.offsetHSL(0, 0, (rnd() - 0.5) * 0.04);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (f + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    scene.add(ground);
  }

  /* ----- tee pad ----- */

  {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.1, 3.4),
      new THREE.MeshLambertMaterial({ color: 0xc3ccd4 })
    );
    pad.position.set(0, TEE_Y + 0.02, 0.3);
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
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const puff = new THREE.Mesh(geo, mat);
        const r = 1.6 + rnd() * 1.4;
        puff.position.set((k - 1.5) * 2.3 + rnd(), rnd() * 0.8, rnd() * 1.2);
        puff.scale.set(r * 1.35, r * 0.7, r);
        g.add(puff);
      }
      g.position.set(-55 + i * 26 + rnd() * 8, 17 + rnd() * 7, -52 - rnd() * 16);
      g.userData.speed = 0.25 + rnd() * 0.3;
      clouds.push(g);
      scene.add(g);
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

    for (const b of baskets) {
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
  let discCount = 0;

  const DOTS = 44;
  const dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.1, 8, 6),
    new THREE.MeshBasicMaterial({ color: COL.navy, transparent: true, opacity: 0.85, fog: false }),
    DOTS
  );
  dots.frustumCulled = false;
  dots.visible = false;
  scene.add(dots);

  const BITS = 22;
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
      bitState.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: 0, w: 0 });
    }
  }
  let bitT = -1;

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

  const handle = el('div', 'dg-handle');
  handle.setAttribute('aria-hidden', 'true');
  const hint = el('p', 'dg-hint', 'Pull the disc back and let go. Or pick a sign.');

  const panel = el('div', 'dg-panel');
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');
  const panelEyebrow = el('p', 'dg-eyebrow');
  const panelTitle = el('p', 'dg-title');
  const panelText = el('p', 'dg-text');
  const panelLink = el('a', 'dg-link', 'Open the project page');
  const panelAgain = el('button', 'dg-again', 'Throw again');
  panelAgain.type = 'button';
  const actions = el('div', 'dg-actions');
  actions.append(panelLink, panelAgain);
  panel.append(panelEyebrow, panelTitle, panelText, actions);

  stage.append(canvas, leads, labels, handle, hint, panel);
  root.append(stage);

  /* ----- throwing ----- */

  const P0 = new THREE.Vector3(0, TEE_Y + 1.15, -0.6);
  const state = { mode: 'ready', throws: 0, disc: null, flight: null, aim: null, drag: null, target: null, slide: null, settle: null, seq: 0, clock: 0, keyboard: false };
  const litter = [];
  const UP = new THREE.Vector3(0, 1, 0);
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();

  function setMode(mode) {
    state.mode = mode;
    stage.dataset.mode = mode;
  }

  function spawnDisc() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(discGeo, discMats[discCount++ % discMats.length]);
    body.castShadow = true;
    body.add(new THREE.Mesh(stripeGeo, stripeMat));
    g.add(body);
    g.userData.body = body;
    g.userData.born = state.clock;
    g.position.copy(P0);
    scene.add(g);
    state.disc = g;
  }

  function launchVelocity(yaw, power) {
    const range = 4 + 44 * power;
    const v = Math.sqrt((range * G) / Math.sin(2 * PITCH));
    const flat = Math.cos(PITCH) * v;
    return new THREE.Vector3(Math.sin(yaw) * flat, Math.sin(PITCH) * v, -Math.cos(yaw) * flat);
  }

  // Follows the throw in small steps until it meets a basket, the ground or the edge of the hill.
  function simulate(v0, only) {
    const pts = [];
    for (let i = 1; i <= 400; i++) {
      const t = i * STEP;
      const x = P0.x + v0.x * t;
      const y = P0.y + v0.y * t - 0.5 * G * t * t;
      const z = P0.z + v0.z * t;
      pts.push(x, y, z);
      for (const b of baskets) {
        if (only && b !== only) continue;
        if ((x - b.x) ** 2 + (z - b.z) ** 2 < CATCH_R * CATCH_R && y > b.y + CATCH_LO && y < b.y + CATCH_HI) {
          return { pts, t, hit: b, out: false };
        }
      }
      if (y <= groundY(x, z) + 0.05) return { pts, t, hit: null, out: false };
      if (Math.abs(x) > 50 || z < -74 || z > 12) return { pts, t, hit: null, out: true };
    }
    return { pts, t: 400 * STEP, hit: null, out: true };
  }

  function showDots(sim) {
    const steps = sim.pts.length / 3;
    const n = Math.min(DOTS, Math.floor(steps / 3));
    for (let i = 0; i < n; i++) {
      const j = ((i + 1) * 3 - 1) * 3;
      tmpV.set(sim.pts[j], sim.pts[j + 1], sim.pts[j + 2]);
      dots.setMatrixAt(i, tmpM.compose(tmpV, tmpQ.identity(), tmpS.setScalar(1 - (0.45 * i) / DOTS)));
    }
    dots.count = n;
    dots.instanceMatrix.needsUpdate = true;
    dots.visible = n > 0;
  }

  function setAimed(b) {
    for (const k of baskets) k.label.classList.toggle('is-aimed', k === b);
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
    const v0 = launchVelocity(yaw, power);
    const sim = simulate(v0, null);
    state.aim = { yaw, power, v0, sim };
    showDots(sim);
    setAimed(sim.hit);
  }

  function throwDisc(v0, sim, assisted) {
    state.flight = { v0, sim, t: 0 };
    state.assisted = assisted;
    state.throws++;
    stage.classList.add('is-used');
    clearAim();
    setMode('flying');
  }

  // The throw a sign asks for: a clean arc that ends in the chains of that basket.
  function assistedThrow(b, keyboard) {
    if (state.mode === 'flying' || state.mode === 'aiming') return;
    if (state.mode === 'landed') finishLanding();
    if (state.mode === 'caught') closePanel();
    state.keyboard = keyboard;
    const dist = Math.hypot(b.x - P0.x, b.z - P0.z);
    const ty = b.y + (CATCH_LO + CATCH_HI) / 2;
    for (let T = 1 + dist * 0.035, tries = 0; tries < 6; T += 0.3, tries++) {
      const v0 = new THREE.Vector3((b.x - P0.x) / T, (ty - P0.y) / T + 0.5 * G * T, (b.z - P0.z) / T);
      const sim = simulate(v0, b);
      if (sim.hit) return throwDisc(v0, sim, true);
    }
  }

  function finishLanding() {
    if (state.slide?.out) scene.remove(state.disc);
    else litter.push(state.disc);
    if (litter.length > 8) scene.remove(litter.shift());
    state.slide = null;
    spawnDisc();
    setMode('ready');
  }

  function onMiss(f) {
    state.slide = { vx: f.v0.x * 0.22, vz: f.v0.z * 0.22, t: 0, out: f.sim.out };
    setMode('landed');
  }

  function onCatch(b) {
    const d = state.disc;
    state.target = b;
    // The disc ends up leaning in the chains on the side that faces the tee, where it can be seen.
    const a = Math.atan2(-b.x, -b.z) + (b.discs.length ? (rnd() - 0.5) * 1.6 : 0);
    const lean = new THREE.Vector3(Math.sin(a) * 0.75, 0.65, Math.cos(a) * 0.75).normalize();
    state.settle = {
      disc: d,
      from: d.position.clone(),
      to: new THREE.Vector3(b.x + Math.sin(a) * 0.4, b.y + TRAY_Y + 0.52, b.z + Math.cos(a) * 0.4),
      fromQ: d.quaternion.clone(),
      toQ: new THREE.Quaternion().setFromUnitVectors(UP, lean),
      t: 0,
    };
    b.discs.push(d);
    if (b.discs.length > 3) scene.remove(b.discs.shift());
    b.jig = 0;
    b.label.classList.add('is-hit');
    if (!reduceMotion) burst(b);
    setMode('caught');
    const seq = ++state.seq;
    window.setTimeout(() => {
      if (state.seq === seq && state.mode === 'caught') openPanel(b);
    }, 500);
  }

  function burst(b) {
    for (const s of bitState) {
      s.p.set(b.x, b.y + 2.4, b.z);
      const a = rnd() * Math.PI * 2;
      const sp = 1.2 + rnd() * 2.2;
      s.v.set(Math.cos(a) * sp, 2.5 + rnd() * 3, Math.sin(a) * sp);
      s.r = rnd() * 6;
      s.w = (rnd() - 0.5) * 14;
    }
    bitT = 0;
    bits.visible = true;
  }

  function openPanel(b) {
    panelEyebrow.textContent = state.assisted
      ? 'In the basket'
      : state.throws === 1
        ? 'Hole in one'
        : `In the basket on throw ${state.throws}`;
    panelTitle.textContent = b.title;
    panelText.textContent = b.text;
    panelLink.href = b.href;
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('is-open'));
    if (state.keyboard) panelLink.focus({ preventScroll: true });
  }

  function closePanel() {
    state.seq++;
    panel.classList.remove('is-open');
    panel.hidden = true;
    state.throws = 0;
    state.target = null;
    spawnDisc();
    setMode('ready');
  }

  panelAgain.addEventListener('click', () => {
    const back = state.target?.label;
    closePanel();
    if (state.keyboard && back) back.focus({ preventScroll: true });
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panelAgain.click();
  });

  /* ----- pointer input ----- */

  function dragStart(e) {
    if (state.mode !== 'ready' || (e.button != null && e.button > 0)) return;
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
    if (aim) throwDisc(aim.v0, aim.sim, false);
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
    for (const b of baskets) {
      b.lw = b.label.offsetWidth;
      b.lh = b.label.offsetHeight;
    }
  }

  function placeLabels() {
    const seen = [];
    for (const b of baskets) {
      tmpV.set(b.x, b.y + 2.75, b.z).project(camera);
      b.on = tmpV.z > -1 && tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.2;
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
    for (const b of baskets) {
      const key = b.on ? `${b.sx.toFixed(1)} ${b.bottom.toFixed(1)} ${b.ax.toFixed(1)} ${b.ay.toFixed(1)}` : 'off';
      if (key !== b.key) {
        b.key = key;
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
      d.position.set(P0.x + f.v0.x * f.t, P0.y + f.v0.y * f.t - 0.5 * G * f.t * f.t, P0.z + f.v0.z * f.t);
      d.rotation.set(-0.12, 0, -0.25 * Math.sin((f.t / f.sim.t) * Math.PI));
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
      if (s.t > 1.1) finishLanding();
    }

    if (state.settle) {
      const s = state.settle;
      s.t = Math.min(1, s.t + dt / 0.3);
      const k = s.t * s.t * (3 - 2 * s.t);
      s.disc.position.lerpVectors(s.from, s.to, k);
      s.disc.quaternion.slerpQuaternions(s.fromQ, s.toQ, k);
      if (s.t >= 1) state.settle = null;
    }

    for (const b of baskets) {
      if (b.jig < 0) continue;
      b.jig += dt;
      const a = 0.16 * Math.exp(-3.2 * b.jig);
      b.chains.rotation.set(a * Math.sin(b.jig * 19), 0, a * Math.cos(b.jig * 15));
      if (b.jig > 1.8) {
        b.jig = -1;
        b.chains.rotation.set(0, 0, 0);
      }
    }

    if (bitT >= 0) {
      bitT += dt;
      bitState.forEach((s, i) => {
        s.v.y -= 9 * dt;
        s.p.addScaledVector(s.v, dt);
        s.r += s.w * dt;
        tmpQ.setFromAxisAngle(UP, s.r);
        bits.setMatrixAt(i, tmpM.compose(s.p, tmpQ, tmpS.setScalar(Math.max(0.01, 1 - bitT / 1.3))));
      });
      bits.instanceMatrix.needsUpdate = true;
      if (bitT > 1.3) {
        bitT = -1;
        bits.visible = false;
      }
    }

    if (!reduceMotion) {
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > 70) c.position.x = -70;
      }
    }

    // Camera: at the tee, following the disc, or standing by the basket that caught it.
    goalPos.copy(TEE_CAM);
    goalLook.copy(TEE_LOOK);
    if (!reduceMotion) {
      if ((state.mode === 'flying' || state.mode === 'landed') && d) {
        goalLook.lerp(d.position, 0.5);
        goalPos.set(d.position.x * 0.12, TEE_CAM.y + 0.3, CAM_Z + d.position.z * 0.12);
      } else if (state.mode === 'caught' && state.target) {
        goalPos.copy(state.target.cam);
        goalLook.copy(state.target.look);
      }
    }
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 2.8);
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

  spawnDisc();
  setMode('ready');
  resize();
  setRunning();
}
