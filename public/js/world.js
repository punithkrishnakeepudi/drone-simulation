/**
 * The flying field and everything in it.
 *
 * This is a real outdoor field on a clear afternoon: sun, sky, mown grass,
 * a concrete apron, a hangar, tree line, perimeter fence and a windsock that
 * actually points where the wind is blowing.
 *
 * Visual rules that exist for training reasons, not decoration:
 *   - a bright orange nose and a mint tail, readable from 30 m away
 *   - a real cast shadow, so you can judge where the drone actually is
 *   - a fading trail, so drift is visible before it becomes a problem
 *   - a marked pilot position, because orientation is relative to YOU
 */

import * as THREE from 'three';
import { buildScenery } from './arenas.js';

/** Free every geometry and material under a group before dropping it. */
function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}

export const COLORS = {
  signal: 0xff7a1a,
  mint: 0x2fd39c,
  paper: 0xf2f5fb,
  dim: 0x8b96ad,
  slate: 0x59627a,
  rubber: 0x15171c,
};

export const PILOT_POS = { x: 0, y: 0, z: 10 };
export const SUN_DIR = new THREE.Vector3(-0.42, 0.72, 0.55).normalize();

/* ------------------------------------------------------------------ */
/* textures                                                            */
/* ------------------------------------------------------------------ */

function noiseCanvas(S, fn) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  fn(g, S);
  return c;
}

/** Mown grass: a 4 m tile of blades, clumps and a little dry patchiness. */
function grassTexture() {
  const c = noiseCanvas(512, (g, S) => {
    g.fillStyle = '#4a6b33';
    g.fillRect(0, 0, S, S);

    // broad tonal clumps
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const r = 12 + Math.random() * 46;
      const t = Math.random();
      const col = t < 0.4 ? '#3f5c2b' : t < 0.8 ? '#54763a' : '#6a7f3c';
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, col);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.globalAlpha = 0.5;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // individual blades
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const len = 2 + Math.random() * 5;
      const lean = (Math.random() - 0.5) * 2.4;
      const l = 0.32 + Math.random() * 0.45;
      g.strokeStyle = `hsl(${88 + Math.random() * 18}, ${34 + Math.random() * 20}%, ${l * 100}%)`;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + lean, y - len);
      g.stroke();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Large soft blotches laid over the grass to hide the tiling. */
function macroTexture() {
  const c = noiseCanvas(256, (g, S) => {
    g.fillStyle = '#808080';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const r = 18 + Math.random() * 60;
      const v = 90 + Math.random() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function concreteTexture() {
  const c = noiseCanvas(512, (g, S) => {
    g.fillStyle = '#9aa0a6';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 9000; i++) {
      const v = 130 + Math.random() * 70;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.06 + Math.random() * 0.14})`;
      g.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    // expansion joints every quarter
    g.strokeStyle = 'rgba(70,74,80,0.55)';
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo((i * S) / 4, 0);
      g.lineTo((i * S) / 4, S);
      g.moveTo(0, (i * S) / 4);
      g.lineTo(S, (i * S) / 4);
      g.stroke();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Aviation-style tyre: black rubber, tread blocks, hi-vis chevron bands. */
function tyreTexture() {
  const W = 1024;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const BANDS = 8; // alternating rubber / hi-vis around the ring
  const seg = W / BANDS;
  for (let i = 0; i < BANDS; i++) {
    const hiVis = i % 2 === 1;
    g.fillStyle = hiVis ? '#f2f5fb' : '#15171c';
    g.fillRect(i * seg, 0, seg, H);

    if (!hiVis) {
      // tread blocks
      g.fillStyle = '#22252c';
      for (let k = 0; k < 7; k++) {
        const x = i * seg + 6 + k * (seg - 12) / 7;
        g.fillRect(x, 10, (seg - 12) / 7 - 5, H - 20);
      }
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(i * seg, H * 0.42, seg, 3);
    } else {
      g.fillStyle = 'rgba(0,0,0,0.10)';
      for (let k = 0; k < 5; k++) g.fillRect(i * seg + k * (seg / 5), 0, seg / 12, H);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function numberTexture(n) {
  const c = noiseCanvas(128, (g, S) => {
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#0f1319';
    g.beginPath();
    g.roundRect(6, 22, S - 12, S - 44, 10);
    g.fill();
    g.strokeStyle = '#f2f5fb';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = '#f2f5fb';
    g.font = '700 62px ui-sans-serif, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), S / 2, S / 2);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function padTexture() {
  const c = noiseCanvas(512, (g, S) => {
    g.fillStyle = '#2b2f36';
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ff7a1a';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 16, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(242,245,251,0.92)';
    g.lineWidth = 28;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(S * 0.34, S * 0.28);
    g.lineTo(S * 0.34, S * 0.72);
    g.moveTo(S * 0.66, S * 0.28);
    g.lineTo(S * 0.66, S * 0.72);
    g.moveTo(S * 0.34, S * 0.5);
    g.lineTo(S * 0.66, S * 0.5);
    g.stroke();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cloudTexture() {
  const c = noiseCanvas(256, (g, S) => {
    g.clearRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const x = S / 2 + (Math.random() - 0.5) * S * 0.62;
      const y = S / 2 + (Math.random() - 0.5) * S * 0.34;
      const r = 18 + Math.random() * 46;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.85)');
      grad.addColorStop(0.55, 'rgba(250,252,255,0.42)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
/* props                                                               */
/* ------------------------------------------------------------------ */

function box(scene, obstacles, { x, y, z, w, h, d, color, rough = 0.85, metal = 0 }) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  obstacles.push({
    min: { x: x - w / 2, y, z: z - d / 2 },
    max: { x: x + w / 2, y: y + h, z: z + d / 2 },
  });
  return mesh;
}

function hangar(scene, obstacles, x, z, yaw = 0) {
  const g = new THREE.Group();
  const W = 14, D = 9, H = 4.2;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.7, metalness: 0.25 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6f7885, roughness: 0.55, metalness: 0.45 });

  const walls = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), wallMat);
  walls.position.y = H / 2;
  walls.castShadow = walls.receiveShadow = true;
  g.add(walls);

  // corrugated barrel roof
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(W / 2, W / 2, D, 22, 1, false, 0, Math.PI), roofMat);
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.y = H;
  roof.castShadow = roof.receiveShadow = true;
  g.add(roof);

  // door
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 0.55, H * 0.8),
    new THREE.MeshStandardMaterial({ color: 0x39404c, roughness: 0.8 })
  );
  door.position.set(0, H * 0.4, D / 2 + 0.02);
  g.add(door);

  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  scene.add(g);

  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const ex = (W * cos + D * sin) / 2;
  const ez = (W * sin + D * cos) / 2;
  obstacles.push({ min: { x: x - ex, y: 0, z: z - ez }, max: { x: x + ex, y: H + W / 2, z: z + ez } });
  return g;
}

function container(scene, obstacles, x, z, color, yaw = 0) {
  const g = new THREE.Group();
  const W = 6, H = 2.6, D = 2.4;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), mat);
  body.position.y = H / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  // ribs
  const rib = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.45 });
  for (let i = -5; i <= 5; i++) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.1, H - 0.2, D + 0.04), rib);
    r.position.set((i * W) / 12, H / 2, 0);
    g.add(r);
  }
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  scene.add(g);
  const cos = Math.abs(Math.cos(yaw)), sin = Math.abs(Math.sin(yaw));
  obstacles.push({
    min: { x: x - (W * cos + D * sin) / 2, y: 0, z: z - (W * sin + D * cos) / 2 },
    max: { x: x + (W * cos + D * sin) / 2, y: H, z: z + (W * sin + D * cos) / 2 },
  });
  return g;
}

function tree(scene, obstacles, x, z, h = 5, seed = 0) {
  const g = new THREE.Group();
  const rnd = (n) => Math.abs(Math.sin(seed * 12.9898 + n * 78.233)) % 1;

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.028, h * 0.055, h * 0.45, 7),
    new THREE.MeshStandardMaterial({ color: 0x53412e, roughness: 1 })
  );
  trunk.position.y = h * 0.225;
  trunk.castShadow = true;
  g.add(trunk);

  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5c2a, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    const r = h * (0.34 - t * 0.13) * (0.85 + rnd(i) * 0.3);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), leafMat);
    crown.position.set(
      (rnd(i + 4) - 0.5) * h * 0.1,
      h * (0.44 + t * 0.28),
      (rnd(i + 8) - 0.5) * h * 0.1
    );
    crown.scale.y = 0.85;
    crown.castShadow = true;
    g.add(crown);
  }

  g.position.set(x, 0, z);
  g.rotation.y = rnd(2) * Math.PI * 2;
  scene.add(g);
  obstacles.push({
    min: { x: x - h * 0.28, y: h * 0.3, z: z - h * 0.28 },
    max: { x: x + h * 0.28, y: h * 0.92, z: z + h * 0.28 },
  });
  return g;
}

function fenceRun(scene, radius, segments = 72) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6a7280, roughness: 0.7, metalness: 0.3 });
  const postGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.7, 6);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const p = new THREE.Mesh(postGeo, postMat);
    p.position.set(Math.cos(a) * radius, 0.85, Math.sin(a) * radius);
    p.castShadow = true;
    g.add(p);
  }
  // two wires
  for (const y of [0.85, 1.6]) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
    g.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x8f98a6, transparent: true, opacity: 0.55 })
      )
    );
  }
  scene.add(g);
  return g;
}

/** Cone windsock on a pole — it points downwind and lifts with wind strength. */
function windsock(scene, x, z) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 5, 8),
    new THREE.MeshStandardMaterial({ color: 0xbcc3cc, roughness: 0.5, metalness: 0.4 })
  );
  pole.position.y = 2.5;
  pole.castShadow = true;
  g.add(pole);

  const pivot = new THREE.Group();
  pivot.position.y = 4.85;
  g.add(pivot);

  const arm = new THREE.Group();
  pivot.add(arm);
  const sockMat = [
    new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.9, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: 0xf2f5fb, roughness: 0.9, side: THREE.DoubleSide }),
  ];
  for (let i = 0; i < 5; i++) {
    const r0 = 0.34 - i * 0.045;
    const r1 = 0.34 - (i + 1) * 0.045;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 0.42, 12, 1, true), sockMat[i % 2]);
    seg.rotation.z = Math.PI / 2;
    seg.position.x = 0.24 + i * 0.42;
    arm.add(seg);
  }

  g.position.set(x, 0, z);
  scene.add(g);
  return {
    group: g,
    /** @param {{x:number,z:number}} wind */
    update(wind) {
      const s = Math.hypot(wind.x, wind.z);
      pivot.rotation.y = Math.atan2(wind.x, wind.z) + Math.PI / 2;
      // limp at zero wind, horizontal at ~4 m/s
      arm.rotation.z = -Math.min(1, s / 4) * 1.35 + 1.35 - 1.35;
      arm.rotation.z = -(1 - Math.min(1, s / 4)) * 1.15;
    },
  };
}

function pilotFigure() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f4f7a, roughness: 0.85 });
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.9, 10), mat);
  legs.position.y = 0.45;
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.21, 0.66, 10), mat);
  torso.position.y = 1.2;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xc4a07c, roughness: 0.9 })
  );
  head.position.y = 1.68;
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.157, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.8 })
  );
  cap.position.y = 1.69;
  for (const m of [legs, torso, head, cap]) m.castShadow = true;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 0.9, 40),
    new THREE.MeshBasicMaterial({ color: 0xf2f5fb, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;

  g.add(legs, torso, head, cap, ring);
  g.position.set(PILOT_POS.x, 0, PILOT_POS.z);
  return g;
}

/* ------------------------------------------------------------------ */
/* the drone                                                           */
/* ------------------------------------------------------------------ */

/** A 250-class quad. Faces -Z at yaw 0. */
export function buildDrone() {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xe6ebf5, roughness: 0.45, metalness: 0.1 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.35, metalness: 0.4 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.22), shell);
  body.position.y = 0.01;
  body.castShadow = true;
  g.add(body);

  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.062, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.2, metalness: 0.3 })
  );
  canopy.position.set(0, 0.04, -0.015);
  canopy.scale.set(1.15, 0.8, 1.5);
  g.add(canopy);

  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.036, 0.022), carbon);
  cam.position.set(0, 0.008, -0.115);
  g.add(cam);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.013, 0.013, 0.012, 12),
    new THREE.MeshStandardMaterial({ color: 0x0a1620, roughness: 0.1, metalness: 0.8 })
  );
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0.008, -0.128);
  g.add(lens);

  const arms = [
    [0.13, -0.13],
    [-0.13, -0.13],
    [0.13, 0.13],
    [-0.13, 0.13],
  ];
  for (const sign of [1, -1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.014, 0.37), carbon);
    bar.rotation.y = (sign * Math.PI) / 4;
    bar.position.y = 0.004;
    bar.castShadow = true;
    g.add(bar);
  }

  const props = [];
  const discs = [];
  for (const [x, z] of arms) {
    const guard = new THREE.Mesh(
      new THREE.TorusGeometry(0.076, 0.005, 6, 22),
      new THREE.MeshStandardMaterial({ color: 0xaab3c4, roughness: 0.5 })
    );
    guard.rotation.x = Math.PI / 2;
    guard.position.set(x, 0.032, z);
    g.add(guard);

    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.023, 0.036, 10), carbon);
    motor.position.set(x, 0.03, z);
    motor.castShadow = true;
    g.add(motor);

    const prop = new THREE.Mesh(
      new THREE.BoxGeometry(0.138, 0.004, 0.016),
      new THREE.MeshStandardMaterial({ color: 0xd4dcec, roughness: 0.4, transparent: true, opacity: 0.9 })
    );
    prop.position.set(x, 0.052, z);
    prop.userData.dir = x * z > 0 ? 1 : -1;
    g.add(prop);
    props.push(prop);

    // Blur disc that fades in once the motors are really turning.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.07, 20),
      new THREE.MeshBasicMaterial({ color: 0xdfe6f3, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.053, z);
    g.add(disc);
    discs.push(disc);
  }

  // Orientation lights: orange nose, mint tail. This is the whole game.
  const noseMat = new THREE.MeshBasicMaterial({ color: COLORS.signal });
  const tailMat = new THREE.MeshBasicMaterial({ color: COLORS.mint });
  for (const [x, z, m] of [
    [-0.13, -0.13, noseMat],
    [0.13, -0.13, noseMat],
    [-0.13, 0.13, tailMat],
    [0.13, 0.13, tailMat],
  ]) {
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.027, 10, 8), m);
    led.position.set(x, 0.012, z);
    g.add(led);
  }
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.075, 8), noseMat);
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 0.012, -0.155);
  g.add(beak);

  const legMat = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.8 });
  for (const [x, z] of arms) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.055, 6), legMat);
    leg.position.set(x * 0.55, -0.04, z * 0.55);
    g.add(leg);
  }

  g.userData.props = props;
  g.userData.discs = discs;
  return g;
}

/* ------------------------------------------------------------------ */
/* the field                                                           */
/* ------------------------------------------------------------------ */

export function buildWorld(scene) {
  const obstacles = [];

  scene.fog = new THREE.Fog(0xb9cbe0, 90, 460);

  // --- sky -----------------------------------------------------------------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x2f6fc4) },
        mid: { value: new THREE.Color(0x9dc2e8) },
        bottom: { value: new THREE.Color(0xd8e3ee) },
        sun: { value: SUN_DIR.clone() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vec4 p = modelMatrix * vec4(position, 1.0);
          vDir = normalize(p.xyz);
          gl_Position = projectionMatrix * viewMatrix * p;
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sun;
        varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 col = h > 0.0 ? mix(mid, top, pow(h, 0.65)) : mix(mid, bottom, pow(-h, 0.4));
          float d = max(dot(normalize(vDir), normalize(sun)), 0.0);
          col += vec3(1.0, 0.92, 0.76) * pow(d, 90.0) * 0.9;   // sun disc
          col += vec3(1.0, 0.90, 0.72) * pow(d, 5.0) * 0.16;   // haze around it
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  sky.frustumCulled = false;
  scene.add(sky);

  // --- light ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xbcd6f5, 0x4c5a35, 1.05));
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));

  const sun = new THREE.DirectionalLight(0xfff3dc, 2.5);
  sun.position.copy(SUN_DIR).multiplyScalar(70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 180;
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  sun.target.position.set(0, 0, -12);
  scene.add(sun, sun.target);

  // --- ground --------------------------------------------------------------
  const grass = grassTexture();
  grass.repeat.set(140, 140);
  grass.anisotropy = 8;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(560, 560),
    new THREE.MeshStandardMaterial({ map: grass, color: 0xcfd6c8, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // large-scale tone variation so the tiling disappears
  const macro = macroTexture();
  macro.repeat.set(3, 3);
  const blotches = new THREE.Mesh(
    new THREE.PlaneGeometry(560, 560),
    new THREE.MeshBasicMaterial({ map: macro, transparent: true, opacity: 0.22, blending: THREE.MultiplyBlending, depthWrite: false })
  );
  blotches.rotation.x = -Math.PI / 2;
  blotches.position.y = 0.006;
  scene.add(blotches);

  // mowing stripes across the flying area
  const stripes = new THREE.Group();
  for (let i = -8; i <= 8; i++) {
    const s = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 110),
      new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xffffff : 0x000000,
        transparent: true,
        opacity: 0.035,
        depthWrite: false,
      })
    );
    s.rotation.x = -Math.PI / 2;
    s.position.set(i * 6, 0.008, -18);
    stripes.add(s);
  }
  scene.add(stripes);

  // --- concrete apron and pad ---------------------------------------------
  const conc = concreteTexture();
  conc.repeat.set(4, 3);
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 12),
    new THREE.MeshStandardMaterial({ map: conc, roughness: 0.92 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(0, 0.012, 4);
  apron.receiveShadow = true;
  scene.add(apron);

  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 56),
    new THREE.MeshStandardMaterial({ map: padTexture(), roughness: 0.8, transparent: true })
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.02;
  pad.receiveShadow = true;
  scene.add(pad);

  scene.add(pilotFigure());

  // --- scenery -------------------------------------------------------------
  // Every prop that changes between arenas lives in one group, so switching
  // theme between rounds is a remove-and-rebuild rather than a page reload.
  // Theme obstacles are always the tail of `obstacles`, which is what lets the
  // old ones be dropped without disturbing the array physics is holding.
  let themeGroup = null;
  let themeId = null;
  let themeObstacles = 0;

  function setTheme(id) {
    if (id === themeId) return;
    if (themeGroup) {
      scene.remove(themeGroup);
      disposeTree(themeGroup);
      obstacles.length -= themeObstacles;
    }
    themeGroup = new THREE.Group();
    const before = obstacles.length;
    buildScenery(id, { scene: themeGroup, obstacles, THREE, box, hangar, container, tree });
    themeObstacles = obstacles.length - before;
    themeId = id;
    scene.add(themeGroup);
  }

  // --- perimeter and markers ----------------------------------------------
  fenceRun(scene, 52);
  const sock = windsock(scene, 12, 8);

  // A faint cylinder so the geofence is visible before you hit it.
  const fence = new THREE.Mesh(
    new THREE.CylinderGeometry(58, 58, 40, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, side: THREE.BackSide, depthWrite: false })
  );
  fence.position.y = 20;
  scene.add(fence);

  // --- distant hills -------------------------------------------------------
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x7d94a8, roughness: 1, flatShading: true });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.3;
    const d = 250 + Math.abs(Math.sin(i * 3.7)) * 90;
    const r = 45 + Math.abs(Math.sin(i * 2.1)) * 55;
    const h = 16 + Math.abs(Math.sin(i * 5.3)) * 34;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), hillMat);
    hill.position.set(Math.cos(a) * d, h / 2 - 6, Math.sin(a) * d);
    hill.rotation.y = i;
    scene.add(hill);
  }

  // --- clouds --------------------------------------------------------------
  const cloudMap = cloudTexture();
  const clouds = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 40 + Math.random() * 240;
    const s = 55 + Math.random() * 110;
    const c = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s * 0.62),
      new THREE.MeshBasicMaterial({ map: cloudMap, transparent: true, opacity: 0.5 + Math.random() * 0.3, depthWrite: false })
    );
    c.rotation.x = Math.PI / 2;
    c.rotation.z = Math.random() * Math.PI;
    c.position.set(Math.cos(a) * d, 95 + Math.random() * 45, Math.sin(a) * d);
    clouds.add(c);
  }
  scene.add(clouds);

  setTheme('field');

  return {
    obstacles,
    rings: [], // tyres, filled in by the task layer
    pad,
    sun,
    ground,
    clouds,
    windsock: sock,
    setTheme,
    get theme() { return themeId; },
    update(dt, wind) {
      sock.update(wind || { x: 0, z: 0 });
      clouds.position.x += (wind?.x || 0) * dt * 1.6;
      clouds.position.z += (wind?.z || 0) * dt * 1.6;
    },
  };
}

/* ------------------------------------------------------------------ */
/* tyres                                                               */
/* ------------------------------------------------------------------ */

const TYRE_MAP = { tex: null };

/**
 * One tyre gate. `spec` is {pos:{x,y,z}, yaw, radius}. The ring lies in the
 * plane whose normal is (sin yaw, cos yaw), so you fly through along the normal.
 */
export function buildTyre(spec, index, state = 'next') {
  if (!TYRE_MAP.tex) TYRE_MAP.tex = tyreTexture();
  const g = new THREE.Group();
  const R = spec.radius;
  const tube = Math.max(0.13, R * 0.11);

  const tex = TYRE_MAP.tex.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1, 1);

  const tyre = new THREE.Mesh(
    new THREE.TorusGeometry(R, tube, 12, 44),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.02 })
  );
  tyre.castShadow = true;
  g.add(tyre);

  // Inner glow ring: bright for the tyre you must fly through next.
  const tone = state === 'next' ? COLORS.mint : state === 'done' ? 0x3d4757 : COLORS.dim;
  const glow = new THREE.Mesh(
    new THREE.TorusGeometry(R - tube - 0.05, 0.035, 6, 40),
    new THREE.MeshBasicMaterial({
      color: tone,
      transparent: true,
      opacity: state === 'next' ? 0.95 : 0.3,
    })
  );
  g.add(glow);

  // A soft disc in the hole so the gate reads as an opening from a distance.
  const veil = new THREE.Mesh(
    new THREE.CircleGeometry(R - tube, 32),
    new THREE.MeshBasicMaterial({
      color: tone,
      transparent: true,
      opacity: state === 'next' ? 0.10 : 0.03,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  g.add(veil);

  // Number board on top.
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ map: numberTexture(index + 1), transparent: true, side: THREE.DoubleSide })
  );
  plate.position.y = R + 0.34;
  g.add(plate);

  // Stand: two legs down to the ground plus a base bar.
  const bottom = spec.pos.y - R - tube;
  if (bottom > 0.15) {
    const legMat = new THREE.MeshStandardMaterial({ color: 0x5a6270, roughness: 0.6, metalness: 0.35 });
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, bottom + R * 0.5, 8), legMat);
      leg.position.set(s * R * 0.72, -spec.pos.y + (bottom + R * 0.5) / 2, 0);
      leg.castShadow = true;
      g.add(leg);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(R * 1.7, 0.1, 0.5), legMat);
    base.position.set(0, -spec.pos.y + 0.05, 0);
    base.castShadow = true;
    g.add(base);
  }

  g.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
  g.rotation.y = spec.yaw;
  g.userData.glow = glow;
  g.userData.veil = veil;
  return g;
}

/** Renders the tyre course and the dotted line that joins it up. */
export function courseLayer(scene) {
  const group = new THREE.Group();
  scene.add(group);
  let pathLine = null;

  function clear() {
    for (const c of [...group.children]) {
      group.remove(c);
      c.traverse?.((o) => {
        o.geometry?.dispose?.();
      });
    }
    pathLine = null;
  }

  return {
    group,
    clear,
    /**
     * @param {Array} tyres  course specs
     * @param {number} at    index of the tyre to fly through next
     */
    set(tyres, at = 0) {
      clear();
      if (!tyres || !tyres.length) return;

      tyres.forEach((t, i) => {
        const state = i < at ? 'done' : i === at ? 'next' : 'later';
        group.add(buildTyre(t, i, state));
      });

      // The ideal line: a smooth curve threaded through every tyre centre.
      const pts = tyres.map((t) => new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z));
      if (pts.length > 1) {
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(pts.length * 24)),
          new THREE.LineDashedMaterial({
            color: COLORS.mint,
            dashSize: 0.55,
            gapSize: 0.45,
            transparent: true,
            opacity: 0.45,
          })
        );
        line.computeLineDistances();
        group.add(line);
        pathLine = line;
      }
    },
    get ideal() {
      return pathLine;
    },
  };
}

/* ------------------------------------------------------------------ */
/* flight aids                                                         */
/* ------------------------------------------------------------------ */

/** Ground contact marker + vertical drop line + fading trail. */
export function buildFlightAids(scene) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.34, 28),
    new THREE.MeshBasicMaterial({ color: COLORS.signal, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  scene.add(ring);

  const drop = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: COLORS.signal, dashSize: 0.25, gapSize: 0.2, transparent: true, opacity: 0.5 })
  );
  scene.add(drop);

  const N = 400;
  const positions = new Float32Array(N * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  trailGeo.setDrawRange(0, 0);
  const trail = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({ color: COLORS.signal, transparent: true, opacity: 0.7 })
  );
  trail.frustumCulled = false;
  scene.add(trail);

  let count = 0;
  let acc = 0;

  return {
    ring,
    drop,
    trail,
    setVisible(v) {
      ring.visible = drop.visible = v;
    },
    setTrail(v) {
      trail.visible = v;
    },
    clear() {
      count = 0;
      trailGeo.setDrawRange(0, 0);
    },
    update(dt, pos) {
      ring.position.set(pos.x, 0.03, pos.z);
      const s = 1 + Math.min(3.2, pos.y * 0.32);
      ring.scale.setScalar(s);
      ring.material.opacity = Math.max(0.14, 0.75 - pos.y * 0.05);

      const dp = drop.geometry.attributes.position;
      dp.setXYZ(0, pos.x, pos.y, pos.z);
      dp.setXYZ(1, pos.x, 0.03, pos.z);
      dp.needsUpdate = true;
      drop.computeLineDistances();

      acc += dt;
      if (acc < 0.045) return;
      acc = 0;
      if (count === N) {
        positions.copyWithin(0, 3);
        count = N - 1;
      }
      positions[count * 3] = pos.x;
      positions[count * 3 + 1] = pos.y;
      positions[count * 3 + 2] = pos.z;
      count++;
      trailGeo.attributes.position.needsUpdate = true;
      trailGeo.setDrawRange(0, count);
    },
  };
}
