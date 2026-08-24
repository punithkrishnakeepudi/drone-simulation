/**
 * Canvas instruments.
 *
 * The radar is the important one. Beginners crash because they cannot tell
 * which way the drone is facing relative to themselves, so the radar always
 * puts the PILOT at the bottom and the drone's nose as a triangle. When the
 * nose swings back toward the pilot it turns orange and says so, because that
 * is the exact moment left and right swap over.
 */

const C = {
  paper: '#e8ecf7',
  dim: '#7c89ad',
  line: '#27314f',
  signal: '#ff7a1a',
  mint: '#38e1b0',
  ink: '#0b1020',
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

/** Top-down field view with the pilot fixed at the bottom. */
export function drawRadar(canvas, drone, pilot, tyres, at = 0) {
  const box = fit(canvas);
  if (!box) return { noseIn: false, rel: 0 };
  const { g, w, h } = box;
  const cx = w / 2;
  const cy = h * 0.82;
  const range = 26; // metres from the pilot to the top of the dial
  const scale = (h * 0.74) / range;

  const toScreen = (p) => ({
    x: cx + (p.x - pilot.x) * scale,
    y: cy + (p.z - pilot.z) * scale,
  });

  // range rings every 5 m
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.font = '9px ui-monospace, monospace';
  g.fillStyle = C.line;
  for (let r = 5; r <= range; r += 5) {
    g.beginPath();
    g.arc(cx, cy, r * scale, Math.PI, Math.PI * 2);
    g.stroke();
    if (r % 10 === 0) g.fillText(`${r}m`, cx + 4, cy - r * scale + 11);
  }

  // the tyre course, gates seen edge on
  (tyres || []).forEach((t, i) => {
    const p = toScreen(t.pos);
    const ux = Math.cos(t.yaw) * t.radius * scale;
    const uz = -Math.sin(t.yaw) * t.radius * scale;
    g.strokeStyle = i === at ? C.mint : i < at ? '#33506b' : C.dim;
    g.lineWidth = i === at ? 3 : 1.8;
    g.globalAlpha = i === at ? 1 : 0.65;
    g.beginPath();
    g.moveTo(p.x - ux, p.y - uz);
    g.lineTo(p.x + ux, p.y + uz);
    g.stroke();
    g.globalAlpha = 1;
  });

  // pilot
  g.fillStyle = C.paper;
  g.beginPath();
  g.arc(cx, cy, 3.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = C.dim;
  g.font = '9px ui-monospace, monospace';
  g.fillText('YOU', cx - 10, cy + 16);

  // line of sight
  const d = toScreen(drone.pos);
  g.strokeStyle = 'rgba(124,137,173,0.35)';
  g.setLineDash([3, 4]);
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(d.x, d.y);
  g.stroke();
  g.setLineDash([]);

  // nose-in test: is the nose pointing back at the pilot?
  const toPilot = Math.atan2(pilot.x - drone.pos.x, pilot.z - drone.pos.z);
  const nose = Math.atan2(-Math.sin(drone.yaw), -Math.cos(drone.yaw));
  const rel = Math.abs(Math.atan2(Math.sin(toPilot - nose), Math.cos(toPilot - nose)));
  const noseIn = rel < Math.PI / 3;

  // the drone itself
  g.save();
  g.translate(d.x, d.y);
  g.rotate(-drone.yaw);
  g.fillStyle = noseIn ? C.signal : C.mint;
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(6, 7);
  g.lineTo(0, 3.5);
  g.lineTo(-6, 7);
  g.closePath();
  g.fill();
  g.restore();

  return { noseIn, rel };
}

/** Vertical altitude tape, 12 m of scale sliding past a fixed pointer. */
export function drawAltTape(canvas, altitude, vspeed, targetAlt) {
  const box = fit(canvas);
  if (!box) return;
  const { g, w, h } = box;
  const span = 12;
  const pxPerM = h / span;
  const cy = h * 0.62;
  const yFor = (a) => cy - (a - altitude) * pxPerM;

  g.fillStyle = 'rgba(11,16,32,0.55)';
  g.fillRect(0, 0, w, h);

  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(w - 26, 0);
  g.lineTo(w - 26, h);
  g.stroke();

  const lo = Math.floor(altitude - span * 0.7);
  const hi = Math.ceil(altitude + span * 0.5);
  g.font = '10px ui-monospace, monospace';
  for (let a = Math.max(0, lo); a <= hi; a++) {
    const y = yFor(a);
    if (y < -10 || y > h + 10) continue;
    const major = a % 5 === 0;
    g.strokeStyle = major ? C.dim : C.line;
    g.beginPath();
    g.moveTo(w - 26, y);
    g.lineTo(w - (major ? 40 : 33), y);
    g.stroke();
    if (major) {
      g.fillStyle = C.dim;
      g.fillText(String(a), w - 62, y + 3.5);
    }
  }

  if (targetAlt != null) {
    const y = yFor(targetAlt);
    if (y > 0 && y < h) {
      g.strokeStyle = C.mint;
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(w - 62, y);
      g.lineTo(w - 26, y);
      g.stroke();
      g.setLineDash([]);
    }
  }

  // ground
  const gy = yFor(0);
  if (gy < h) {
    g.fillStyle = 'rgba(255,122,26,0.14)';
    g.fillRect(0, gy, w, h - gy);
    g.strokeStyle = C.signal;
    g.beginPath();
    g.moveTo(0, gy);
    g.lineTo(w, gy);
    g.stroke();
  }

  // pointer
  g.fillStyle = C.paper;
  g.beginPath();
  g.moveTo(w - 26, cy);
  g.lineTo(w - 18, cy - 7);
  g.lineTo(w - 2, cy - 7);
  g.lineTo(w - 2, cy + 7);
  g.lineTo(w - 18, cy + 7);
  g.closePath();
  g.fill();
  g.fillStyle = C.ink;
  g.font = '600 11px ui-monospace, monospace';
  g.fillText(altitude.toFixed(1), w - 22, cy + 4);

  // climb rate bug
  const vy = Math.max(-3, Math.min(3, vspeed));
  g.strokeStyle = vy >= 0 ? C.mint : C.signal;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(w - 30, cy);
  g.lineTo(w - 30, cy - vy * 14);
  g.stroke();
}

/** Mirror of a physical gimbal, so you can see what the sim thinks you sent. */
export function drawStick(canvas, x, y, labels) {
  const box = fit(canvas);
  if (!box) return;
  const { g, w, h } = box;
  const pad = 6;
  const size = Math.min(w, h) - pad * 2;
  const ox = (w - size) / 2;
  const oy = (h - size) / 2;
  const cx = ox + size / 2;
  const cy = oy + size / 2;

  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.strokeRect(ox, oy, size, size);
  g.beginPath();
  g.moveTo(cx, oy + 4);
  g.lineTo(cx, oy + size - 4);
  g.moveTo(ox + 4, cy);
  g.lineTo(ox + size - 4, cy);
  g.stroke();

  const px = cx + x * (size / 2 - 5);
  const py = cy - y * (size / 2 - 5);
  g.strokeStyle = 'rgba(255,122,26,0.5)';
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(px, py);
  g.stroke();
  g.fillStyle = C.signal;
  g.beginPath();
  g.arc(px, py, 5, 0, Math.PI * 2);
  g.fill();

  if (labels) {
    g.fillStyle = C.line;
    g.font = '8px ui-monospace, monospace';
    g.fillText(labels[0], cx - g.measureText(labels[0]).width / 2, oy - 1);
    g.fillText(labels[1], ox + size + 2 - g.measureText(labels[1]).width, cy + 3);
  }
}
