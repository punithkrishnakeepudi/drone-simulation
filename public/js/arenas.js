/**
 * Arena scenery.
 *
 * Ground, sky, sun, pad, fence and hills are the same everywhere — they live in
 * world.js. This file only places the props that make one arena look and fly
 * differently from another.
 *
 * It deliberately imports nothing. The helpers it needs (`box`, `tree`,
 * `container`, `hangar`) and THREE itself arrive in the `ctx` argument, which
 * keeps world.js → arenas.js a one-way dependency instead of a cycle.
 *
 * Everything here is authored against the ring positions in tracks.js. Move a
 * wall without moving the rings and a course becomes unflyable, so the two
 * files change together.
 */

/* ------------------------------------------------------------------ */
/* local primitives                                                    */
/* ------------------------------------------------------------------ */

/** A stack of scrap: two or three crushed shells on top of each other. */
function wreckStack(ctx, x, z, n = 2, yaw = 0) {
  const COLORS = [0x8a4a3c, 0x4a5b6b, 0x7d7a5e, 0x5d4a52, 0x6b7360];
  // Deterministic but unrelated to the stack index, so no two shells in a pile
  // come out the same colour and no pile matches its neighbour.
  const pick = Math.abs(Math.round(x * 3 + z));
  for (let i = 0; i < n; i++) {
    const h = 1.05;
    ctx.box(ctx.scene, ctx.obstacles, {
      x: x + Math.sin(yaw) * i * 0.2,
      y: i * h,
      z: z + Math.cos(yaw) * i * 0.2,
      w: 3.6 - i * 0.35,
      h,
      d: 1.9 - i * 0.15,
      color: COLORS[(pick + i) % COLORS.length],
      rough: 0.95,
      metal: 0.15,
    });
  }
}

/** A heap of tyres — a squat cylinder, dark and matte. */
function tyrePile(ctx, x, z, r = 2.2, h = 1.6) {
  const { THREE, scene, obstacles } = ctx;
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.1, h, 18),
    new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.98 })
  );
  m.position.set(x, h / 2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  obstacles.push({ min: { x: x - r, y: 0, z: z - r }, max: { x: x + r, y: h, z: z + r } });
}

/** A loose heap of scrap — a flattened cone. */
function heap(ctx, x, z, r = 4, h = 3, color = 0x6a6558) {
  const { THREE, scene, obstacles } = ctx;
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(r, h, 9),
    new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true })
  );
  m.position.set(x, h / 2, z);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  obstacles.push({ min: { x: x - r * 0.7, y: 0, z: z - r * 0.7 }, max: { x: x + r * 0.7, y: h * 0.8, z: z + r * 0.7 } });
}

/** Two uprights and a beam. Used for the crane and the gantry. */
function portal(ctx, { x, z, span, height, legW = 1.4, beamH = 1.4, color = 0xc4762a }) {
  for (const side of [-1, 1]) {
    ctx.box(ctx.scene, ctx.obstacles, {
      x: x + (side * span) / 2, y: 0, z,
      w: legW, h: height, d: legW,
      color, rough: 0.7, metal: 0.4,
    });
  }
  ctx.box(ctx.scene, ctx.obstacles, {
    x, y: height, z,
    w: span + legW, h: beamH, d: legW + 0.2,
    color, rough: 0.7, metal: 0.4,
  });
}

/** Container stacked two high. */
function containerStack(ctx, x, z, colors, yaw = 0) {
  ctx.container(ctx.scene, ctx.obstacles, x, z, colors[0], yaw);
  const H = 2.6;
  ctx.box(ctx.scene, ctx.obstacles, {
    x, y: H, z,
    w: Math.abs(Math.cos(yaw)) * 6 + Math.abs(Math.sin(yaw)) * 2.4,
    h: H,
    d: Math.abs(Math.sin(yaw)) * 6 + Math.abs(Math.cos(yaw)) * 2.4,
    color: colors[1], rough: 0.62, metal: 0.35,
  });
}

/* ------------------------------------------------------------------ */
/* the themes                                                          */
/* ------------------------------------------------------------------ */

const SCENERY = {
  /**
   * The open field the trainer has always used. Free flight and the tyre
   * courses still fly here.
   */
  field(ctx) {
    ctx.hangar(ctx.scene, ctx.obstacles, -26, 6, 0.18);
    ctx.container(ctx.scene, ctx.obstacles, 22, -4, 0x9d4a34, -0.35);
    ctx.container(ctx.scene, ctx.obstacles, 24, 3, 0x2f6b6f, 0.12);
    ctx.box(ctx.scene, ctx.obstacles, { x: 15, y: 0, z: 12, w: 3.4, h: 2.6, d: 3, color: 0xa8a094, rough: 0.9 });
    ctx.box(ctx.scene, ctx.obstacles, { x: -25, y: 0, z: -22, w: 4.2, h: 3.4, d: 4.2, color: 0x8f9aa6, rough: 0.85 });
    ctx.box(ctx.scene, ctx.obstacles, { x: 18, y: 0, z: -30, w: 5, h: 6.4, d: 5, color: 0x7d8794, rough: 0.8 });

    const spots = [
      [-38, -20, 7.5], [-32, -30, 8.4], [-24, -38, 6.8], [-14, -42, 9.2],
      [-2, -45, 7.6], [10, -43, 8.8], [21, -40, 7.2], [31, -33, 9.4],
      [38, -23, 6.6], [42, -10, 8.2], [40, 8, 7.4], [34, 20, 8.6],
      [-40, 4, 7.8], [-36, 18, 6.9], [-22, 26, 8.1], [-8, 30, 7.3],
      [8, 31, 8.5], [22, 27, 7.0], [-30, -8, 5.4], [30, -18, 5.8],
    ];
    spots.forEach(([x, z, h], i) => ctx.tree(ctx.scene, ctx.obstacles, x, z, h, i + 1));
  },

  /**
   * Junkyard — the corridor down the middle is 8 m wide and everything else is
   * in the way. The crane jib sits at 16 m so the climb course goes under it.
   */
  junkyard(ctx) {
    wreckStack(ctx, -10, -14, 3);
    wreckStack(ctx, 10, -22, 2, 0.4);
    wreckStack(ctx, -12, -34, 3, -0.3);
    wreckStack(ctx, 11, -40, 2);
    wreckStack(ctx, -14, -8, 2, 0.2);
    wreckStack(ctx, 13, -10, 3, -0.5);
    wreckStack(ctx, -11, -47, 2, 0.6);
    wreckStack(ctx, 12, -52, 2);

    tyrePile(ctx, 6.5, -10);
    tyrePile(ctx, -7.5, -26, 2.4, 1.8);
    tyrePile(ctx, 8, -32);
    tyrePile(ctx, -10, -47, 2.0, 1.4);

    heap(ctx, 17, -16, 5, 4.2);
    heap(ctx, -19, -20, 4.5, 3.4);
    heap(ctx, 0, -24, 3.0, 4.5, 0x5f5a4d);   // the one junk-climb goes over
    heap(ctx, -20, -44, 5.5, 4.6);

    // crane: mast at the west edge, jib reaching across the yard at 16 m
    ctx.box(ctx.scene, ctx.obstacles, { x: -24, y: 0, z: -30, w: 1.8, h: 18, d: 1.8, color: 0xc4762a, rough: 0.7, metal: 0.4 });
    ctx.box(ctx.scene, ctx.obstacles, { x: -13, y: 16, z: -30, w: 24, h: 1.2, d: 1.2, color: 0xc4762a, rough: 0.7, metal: 0.4 });

    for (const [x, z, h] of [[-34, -12, 6.5], [34, -34, 7.2], [-30, 12, 6.0], [30, 10, 6.8], [0, -58, 8.0]]) {
      ctx.tree(ctx.scene, ctx.obstacles, x, z, h, x + z);
    }
  },

  /**
   * City — six towers in two rows. The alleys are 6 m wide and centred on
   * x = ±8; the gap between the rows runs across at z ≈ −25.
   */
  city(ctx) {
    const BLOCK = { w: 10, d: 10, h: 14 };
    const tints = [0x8d939c, 0x7a828d, 0x99958a, 0x6f7681, 0x8a8478, 0x82898f];
    let i = 0;
    for (const z of [-16, -34]) {
      for (const x of [-16, 0, 16]) {
        const h = BLOCK.h + ((i % 3) - 1) * 3;
        ctx.box(ctx.scene, ctx.obstacles, {
          x, y: 0, z, w: BLOCK.w, h, d: BLOCK.d,
          color: tints[i % tints.length], rough: 0.88,
        });
        // parapet, so the rooftop course has something to judge height against
        ctx.box(ctx.scene, ctx.obstacles, {
          x, y: h, z, w: BLOCK.w, h: 0.7, d: BLOCK.d,
          color: 0x5c626b, rough: 0.9,
        });
        i++;
      }
    }

    // low street furniture, well clear of the alley centres
    ctx.box(ctx.scene, ctx.obstacles, { x: 13, y: 0, z: 4, w: 6, h: 1.2, d: 2, color: 0x6b7280, rough: 0.9 });
    ctx.box(ctx.scene, ctx.obstacles, { x: 16, y: 0, z: -3, w: 3, h: 2.4, d: 3, color: 0x7d8794, rough: 0.85 });
    ctx.box(ctx.scene, ctx.obstacles, { x: -16, y: 0, z: -3, w: 3, h: 2.4, d: 3, color: 0x7d8794, rough: 0.85 });
    ctx.box(ctx.scene, ctx.obstacles, { x: 0, y: 0, z: -53, w: 22, h: 3.2, d: 4, color: 0x767d88, rough: 0.9 });

    for (const [x, z, h] of [[-26, -6, 6.4], [26, -8, 6.0], [-26, -44, 7.0], [26, -44, 6.6], [-26, -25, 5.8], [26, -25, 5.8]]) {
      ctx.tree(ctx.scene, ctx.obstacles, x, z, h, x - z);
    }
  },

  /**
   * Warehouse — walls, an open front and two racking rows. Roof is trusses
   * rather than a slab so the interior does not go pitch dark.
   */
  warehouse(ctx) {
    const X = 17, FRONT = -6, BACK = -46, H = 8;
    const depth = FRONT - BACK;            // 40
    const midZ = (FRONT + BACK) / 2;       // -26

    for (const side of [-1, 1]) {
      ctx.box(ctx.scene, ctx.obstacles, {
        x: side * X, y: 0, z: midZ, w: 0.6, h: H, d: depth,
        color: 0xb2b8c0, rough: 0.8,
      });
    }
    ctx.box(ctx.scene, ctx.obstacles, { x: 0, y: 0, z: BACK, w: X * 2, h: H, d: 0.6, color: 0xb2b8c0, rough: 0.8 });
    // front wall with the doorway cut out of it: two piers and a lintel
    for (const side of [-1, 1]) {
      ctx.box(ctx.scene, ctx.obstacles, { x: side * 13, y: 0, z: FRONT, w: 8.6, h: H, d: 0.6, color: 0xb2b8c0, rough: 0.8 });
    }
    ctx.box(ctx.scene, ctx.obstacles, { x: 0, y: 5.5, z: FRONT, w: 18, h: 2.5, d: 0.6, color: 0xb2b8c0, rough: 0.8 });

    // roof trusses
    for (let z = FRONT - 3; z > BACK; z -= 5) {
      ctx.box(ctx.scene, ctx.obstacles, { x: 0, y: H, z, w: X * 2, h: 0.45, d: 0.45, color: 0x6f7885, rough: 0.6, metal: 0.5 });
    }

    // racking: two rows, aisle down the middle and one down each outside
    for (const side of [-1, 1]) {
      ctx.box(ctx.scene, ctx.obstacles, {
        x: side * 9, y: 0, z: midZ, w: 3, h: 5, d: 28,
        color: 0x4d5a6b, rough: 0.75, metal: 0.2,
      });
      // pallets on top, for something to judge height against
      for (let k = -2; k <= 2; k++) {
        ctx.box(ctx.scene, ctx.obstacles, {
          x: side * 9, y: 5, z: midZ + k * 6, w: 2.6, h: 1.1, d: 2.4,
          color: k % 2 ? 0xa9895e : 0x9c9c94, rough: 0.95,
        });
      }
    }
  },

  /**
   * Forest — trunks close to the line without ever standing in a ring. The
   * canopy tops out around 8 m, which is why the high course sits at 12.
   */
  forest(ctx) {
    // the slalom trunks: alternating, just off the corridor centre
    const inner = [
      [3.8, -11.5, 6.2], [-3.8, -17.5, 6.4], [3.8, -23.5, 6.0], [-3.8, -29.5, 6.4],
      [3.8, -35.5, 6.2], [-3.8, -42.5, 6.0], [3.8, -48.5, 6.4],
      [-10.5, -12, 6.6], [10.5, -18, 7.4], [-10.5, -24, 6.9], [10.5, -30, 7.7],
      [-10.5, -36, 7.1], [10.5, -43, 6.5],
    ];
    inner.forEach(([x, z, h], i) => ctx.tree(ctx.scene, ctx.obstacles, x, z, h, i + 40));

    // the wall of trees that makes it a forest rather than an avenue
    let seed = 100;
    for (let ring = 0; ring < 3; ring++) {
      const rad = 16 + ring * 9;
      const n = 12 + ring * 5;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.4;
        const x = Math.cos(a) * rad;
        const z = Math.sin(a) * rad - 22;
        // The courses all run inside x ±12, z 0…−52. The backdrop rings must
        // stay out of that box or they stand in a gate.
        if (Math.abs(x) < 12.5 && z < 2 && z > -52) continue;
        if (Math.hypot(x, z) < 9) continue;              // keep the pad clear
        ctx.tree(ctx.scene, ctx.obstacles, x, z, 6 + ((seed * 7) % 30) / 10, seed++);
      }
    }

    ctx.box(ctx.scene, ctx.obstacles, { x: -15, y: 0, z: -54, w: 5, h: 2.4, d: 4, color: 0x6d5a44, rough: 0.98 });
  },

  /**
   * Harbour — a spine of container stacks down the middle with a lane either
   * side, and a gantry crane at z = −30 with 12 m of clearance under the beam.
   */
  harbour(ctx) {
    const boxColors = [
      [0x9d4a34, 0xb2603f], [0x2f6b6f, 0x3d8189], [0xa8873a, 0xbf9d4a],
      [0x4a5b8a, 0x5d6f9e], [0x7a4470, 0x8f5484], [0x3f7a4d, 0x4d9160],
    ];
    // middle spine — the thing the lane course weaves around
    [[0, -20], [0, -26], [0, -38], [0, -46]].forEach(([x, z], i) =>
      containerStack(ctx, x, z, boxColors[i % boxColors.length])
    );
    // outer walls of steel
    [[-17, -14], [-17, -26], [-17, -38], [17, -14], [17, -26], [17, -38]].forEach(([x, z], i) =>
      containerStack(ctx, x, z, boxColors[(i + 2) % boxColors.length], Math.PI / 2)
    );
    [[-17, -50], [17, -50], [0, -56]].forEach(([x, z], i) =>
      ctx.container(ctx.scene, ctx.obstacles, x, z, boxColors[i % boxColors.length][0], i === 2 ? 0 : Math.PI / 2)
    );

    portal(ctx, { x: 0, z: -30, span: 24, height: 12, legW: 1.4, beamH: 1.4 });
    // a second, lower portal near the quay for scale
    portal(ctx, { x: 0, z: -8, span: 30, height: 9, legW: 1.1, beamH: 1.0, color: 0x8b939c });

    // quayside: a strip of water off to the east
    const { THREE, scene } = ctx;
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 200),
      new THREE.MeshStandardMaterial({ color: 0x24506b, roughness: 0.25, metalness: 0.5 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(88, 0.03, -20);
    scene.add(water);
    ctx.box(ctx.scene, ctx.obstacles, { x: 28, y: 0, z: -20, w: 1.2, h: 1.0, d: 70, color: 0x8f8a7e, rough: 0.95 });

    for (const [x, z, h] of [[-30, -6, 6.2], [-32, -40, 6.8], [-28, 10, 6.0]]) {
      ctx.tree(ctx.scene, ctx.obstacles, x, z, h, x * z);
    }
  },
};

export const ARENA_IDS = Object.keys(SCENERY);

/**
 * Place the props for one theme.
 *
 * @param {string} id     theme id; anything unknown falls back to the field
 * @param {object} ctx    {scene, obstacles, THREE, box, hangar, container, tree}
 */
export function buildScenery(id, ctx) {
  (SCENERY[id] || SCENERY.field)(ctx);
}
