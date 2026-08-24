/**
 * The path box.
 *
 * A small black plan-view panel in the corner of the screen. It answers one
 * question the 3D view cannot: "is the line I flew the line I meant to fly?"
 *
 *   dotted green  the course, threaded through every tyre
 *   solid orange  where the drone has actually been
 *   white ticks   the tyre gates, seen edge on; the next one is filled
 *   right strip   height, so you can see the course profile too
 */

const C = {
  bg: '#05070c',
  edge: '#1c2433',
  grid: '#141b28',
  ideal: '#2fd39c',
  flown: '#ff7a1a',
  paper: '#e8ecf7',
  dim: '#6b7690',
};

function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object}  drone
 * @param {Array}   trace   flown points [{x,y,z}]
 * @param {Array}   ideal   course points [{x,y,z}] (may be empty)
 * @param {Array}   tyres   course tyres
 * @param {number}  at      index of the tyre to fly through next
 * @param {object}  pilot
 */
export function drawPathBox(canvas, drone, trace, ideal, tyres, at, pilot) {
  const box = fit(canvas);
  if (!box) return;
  const { g, w, h } = box;

  const STRIP = 26; // altitude strip on the right
  const PAD = 10;
  const plotW = w - STRIP - PAD * 2;
  const plotH = h - PAD * 2;

  g.fillStyle = C.bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = C.edge;
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, w - 1, h - 1);

  /* ---- work out what has to fit in the box ---- */
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = 4;
  const swallow = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y != null && p.y > maxY) maxY = p.y;
  };
  for (const t of tyres || []) swallow(t.pos);
  swallow(drone.pos);
  swallow(pilot);
  if (!(tyres || []).length) {
    // Free flight: follow the drone with a rolling window over the trace.
    const tail = trace.slice(-500);
    for (const p of tail) swallow(p);
  }
  if (minX === Infinity) { minX = -10; maxX = 10; minZ = -10; maxZ = 10; }

  const margin = 4;
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  const spanX = Math.max(8, maxX - minX);
  const spanZ = Math.max(8, maxZ - minZ);
  const scale = Math.min(plotW / spanX, plotH / spanZ);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const ox = PAD + plotW / 2;
  const oy = PAD + plotH / 2;
  const X = (x) => ox + (x - cx) * scale;
  const Y = (z) => oy + (z - cz) * scale;

  /* ---- grid, 10 m ---- */
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  const step = spanX > 60 ? 20 : 10;
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    g.beginPath();
    g.moveTo(X(x), PAD);
    g.lineTo(X(x), PAD + plotH);
    g.stroke();
  }
  for (let z = Math.ceil(minZ / step) * step; z <= maxZ; z += step) {
    g.beginPath();
    g.moveTo(PAD, Y(z));
    g.lineTo(PAD + plotW, Y(z));
    g.stroke();
  }

  g.save();
  g.beginPath();
  g.rect(PAD - 2, PAD - 2, plotW + 4, plotH + 4);
  g.clip();

  /* ---- the course ---- */
  if (ideal && ideal.length > 1) {
    g.strokeStyle = C.ideal;
    g.globalAlpha = 0.75;
    g.lineWidth = 1.4;
    g.setLineDash([4, 4]);
    g.beginPath();
    ideal.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.z)) : g.moveTo(X(p.x), Y(p.z))));
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  /* ---- tyre gates, seen edge on ---- */
  (tyres || []).forEach((t, i) => {
    const done = i < at;
    const next = i === at;
    const ux = Math.cos(t.yaw) * t.radius * scale;
    const uz = -Math.sin(t.yaw) * t.radius * scale;
    const px = X(t.pos.x);
    const py = Y(t.pos.z);
    g.strokeStyle = next ? C.ideal : done ? '#33506b' : C.dim;
    g.lineWidth = next ? 3 : 2;
    g.beginPath();
    g.moveTo(px - ux, py - uz);
    g.lineTo(px + ux, py + uz);
    g.stroke();
    if (next) {
      g.fillStyle = C.ideal;
      g.beginPath();
      g.arc(px, py, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = next ? C.ideal : C.dim;
    g.font = '8px ui-monospace, monospace';
    g.fillText(String(i + 1), px + 4, py - 4);
  });

  /* ---- pilot ---- */
  g.fillStyle = C.paper;
  g.beginPath();
  g.arc(X(pilot.x), Y(pilot.z), 2.4, 0, Math.PI * 2);
  g.fill();

  /* ---- the flown line, fading into the past ---- */
  if (trace.length > 1) {
    g.lineWidth = 1.6;
    g.lineJoin = 'round';
    const n = trace.length;
    const CHUNK = 24;
    for (let i = 0; i < n - 1; i += CHUNK) {
      const end = Math.min(n - 1, i + CHUNK);
      g.globalAlpha = 0.18 + 0.82 * (end / n);
      g.strokeStyle = C.flown;
      g.beginPath();
      g.moveTo(X(trace[i].x), Y(trace[i].z));
      for (let k = i + 1; k <= end; k++) g.lineTo(X(trace[k].x), Y(trace[k].z));
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /* ---- the drone ---- */
  const dx = X(drone.pos.x);
  const dy = Y(drone.pos.z);
  g.save();
  g.translate(dx, dy);
  g.rotate(-drone.yaw);
  g.fillStyle = C.paper;
  g.beginPath();
  g.moveTo(0, -6.5);
  g.lineTo(4.4, 5);
  g.lineTo(0, 2.5);
  g.lineTo(-4.4, 5);
  g.closePath();
  g.fill();
  g.restore();

  g.restore(); // clip

  /* ---- altitude strip ---- */
  const sx = w - STRIP + 2;
  const sTop = PAD;
  const sH = plotH;
  g.strokeStyle = C.edge;
  g.strokeRect(sx + 0.5, sTop + 0.5, STRIP - 6, sH);
  const top = Math.max(6, Math.ceil(maxY + 2));
  const yFor = (a) => sTop + sH - (clamp01(a / top) * sH);

  // the course height profile, as ticks
  (tyres || []).forEach((t, i) => {
    g.strokeStyle = i === at ? C.ideal : C.dim;
    g.globalAlpha = i === at ? 1 : 0.5;
    g.beginPath();
    g.moveTo(sx + 2, yFor(t.pos.y));
    g.lineTo(sx + STRIP - 8, yFor(t.pos.y));
    g.stroke();
    g.globalAlpha = 1;
  });

  const ay = yFor(drone.altitude);
  g.fillStyle = C.flown;
  g.fillRect(sx + 1, ay - 1.5, STRIP - 8, 3);
  g.fillStyle = C.dim;
  g.font = '7px ui-monospace, monospace';
  g.fillText(`${top}`, sx + 1, sTop + 8);
  g.fillText('0', sx + 1, sTop + sH - 2);

  /* ---- labels ---- */
  g.fillStyle = C.dim;
  g.font = '8px ui-monospace, monospace';
  g.fillText('PATH', 6, 11);
  g.fillText(`${step} m`, 6, h - 5);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
