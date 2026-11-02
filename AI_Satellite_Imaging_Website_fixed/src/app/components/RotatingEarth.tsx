import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface Satellite {
  name: string;
  lat: number; // degrees, current latitude
  lon: number; // degrees, current longitude
  alt: number; // km above surface
  color: string; // hex like #ff8800
  inclination?: number; // degrees; defaults to max(|lat|, 10)
}

interface RotatingEarthProps {
  satellites: Satellite[];
  width?: number;
  height?: number;
  onSatelliteClick?: (satellite: Satellite) => void;
  /** Simulated seconds per real second (default 120) */
  timeScale?: number;
  autoRotate?: boolean;
  showTrails?: boolean;
  showOrbits?: boolean;
  showGrid?: boolean;
}

// ---------- constants ----------
const EARTH_R_KM = 6371;
const MU = 398600.4418; // km^3 / s^2
const TRAIL_LEN = 48;
const STAR_COUNT = 160;
const DEG = Math.PI / 180;

type Vec3 = { x: number; y: number; z: number };

interface OrbitModel {
  sat: Satellite;
  radius: number; // scene units multiplier relative to Earth radius
  inc: number;
  raan: number;
  u0: number; // argument of latitude at t=0
  omega: number; // rad/s (real physics, from Kepler)
  periodMin: number;
  speedKmS: number;
}

// Build orbital elements from a lat/lon/alt snapshot so the satellite
// passes through its reported position and follows a true inclined orbit.
function buildOrbit(sat: Satellite): OrbitModel {
  const a = EARTH_R_KM + sat.alt;
  const inc = Math.max(Math.abs(sat.inclination ?? sat.lat), 10) * DEG;
  const lat = sat.lat * DEG;
  const lon = sat.lon * DEG;
  const s = Math.max(-1, Math.min(1, Math.sin(lat) / Math.sin(inc)));
  const u0 = Math.asin(s);
  const raan = lon - Math.atan2(Math.cos(inc) * Math.sin(u0), Math.cos(u0));
  const omega = Math.sqrt(MU / (a * a * a));
  return {
    sat,
    // log-compressed so LEO and GEO both fit on screen
    radius: 1.12 + Math.log10(1 + sat.alt / 400) * 0.45,
    inc,
    raan,
    u0,
    omega,
    periodMin: (2 * Math.PI) / omega / 60,
    speedKmS: Math.sqrt(MU / a),
  };
}

// Position on orbit, y is "up" (north pole axis)
function orbitPoint(o: OrbitModel, u: number, r: number): Vec3 {
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cO = Math.cos(o.raan);
  const sO = Math.sin(o.raan);
  const ci = Math.cos(o.inc);
  const si = Math.sin(o.inc);
  return {
    x: r * (cO * cu - sO * ci * su),
    z: r * (sO * cu + cO * ci * su),
    y: r * si * su,
  };
}

function withAlpha(hex: string, a: number) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function RotatingEarth({
  satellites,
  width = 400,
  height = 400,
  onSatelliteClick,
  timeScale = 120,
  autoRotate = true,
  showTrails = true,
  showOrbits = true,
  showGrid = true,
}: RotatingEarthProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // camera + interaction state lives in refs to avoid re-renders at 60fps
  const camRef = useRef({ yaw: 0.6, pitch: 0.45, zoom: 1, velYaw: 0 });
  const dragRef = useRef({ active: false, moved: false, x: 0, y: 0 });
  const simTimeRef = useRef(0);
  const hitRef = useRef<Map<string, { x: number; y: number; r: number }>>(new Map());
  const trailsRef = useRef<Map<string, Vec3[]>>(new Map());
  const hoverRef = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const orbits = useMemo(() => satellites.map(buildOrbit), [satellites]);

  // Stable star field (the original regenerated random stars every frame -> flicker)
  const stars = useMemo(
    () =>
      Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random(),
        y: Math.random(),
        s: Math.random() * 1.4 + 0.3,
        tw: Math.random() * Math.PI * 2,
      })),
    []
  );

  useEffect(() => {
    trailsRef.current.clear();
  }, [satellites]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let cssW = width;
    let cssH = height;
    let raf = 0;
    let last = performance.now();
    let visible = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = canvas.clientWidth || width;
      cssH = canvas.clientHeight || height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);

    // ---------- 3D helpers ----------
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) {
        last = now;
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const cam = camRef.current;
      if (!dragRef.current.active) {
        cam.yaw += cam.velYaw * dt;
        cam.velYaw *= 0.94; // inertia
        if (autoRotate && !reduceMotion && selectedRef.current === null) cam.yaw += 0.15 * dt;
      }
      if (!reduceMotion) simTimeRef.current += dt * timeScale;
      const t = simTimeRef.current;

      const cx = cssW / 2;
      const cy = cssH / 2;
      const R = Math.min(cssW, cssH) * 0.22 * cam.zoom;
      const persp = R * 7;

      const cyaw = Math.cos(cam.yaw);
      const syaw = Math.sin(cam.yaw);
      const cp = Math.cos(cam.pitch);
      const sp = Math.sin(cam.pitch);

      // world (unit scale) -> camera space (scaled by R). z>0 faces the viewer.
      const toCam = (p: Vec3): Vec3 => {
        const x1 = p.x * cyaw + p.z * syaw;
        const z1 = -p.x * syaw + p.z * cyaw;
        const y2 = p.y * cp - z1 * sp;
        const z2 = p.y * sp + z1 * cp;
        return { x: x1 * R, y: y2 * R, z: z2 * R };
      };
      const toScreen = (c: Vec3) => {
        const k = persp / (persp - c.z);
        return { x: cx + c.x * k, y: cy - c.y * k, k };
      };
      // is a camera-space point hidden behind the Earth's disc?
      const occluded = (c: Vec3) => c.z < 0 && Math.hypot(c.x, c.y) < R;

      // ---------- background ----------
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(cssW, cssH) * 0.75);
      bg.addColorStop(0, '#0b1325');
      bg.addColorStop(1, '#03050a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cssW, cssH);

      for (const s of stars) {
        const a = 0.45 + 0.4 * Math.sin(now / 900 + s.tw);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fillRect(s.x * cssW, s.y * cssH, s.s, s.s);
      }

      // ---------- Earth ----------
      // atmosphere glow
      const atm = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.28);
      atm.addColorStop(0, 'rgba(70,150,255,0.35)');
      atm.addColorStop(1, 'rgba(70,150,255,0)');
      ctx.fillStyle = atm;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.28, 0, Math.PI * 2);
      ctx.fill();

      // lit sphere (light from upper-left)
      const body = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.45, R * 0.1, cx, cy, R);
      body.addColorStop(0, '#2c6fb5');
      body.addColorStop(0.6, '#123e72');
      body.addColorStop(1, '#061a36');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // graticule
      if (showGrid) {
        ctx.lineWidth = 0.8;
        const strokeLine = (pts: Vec3[]) => {
          let prev: ReturnType<typeof toScreen> | null = null;
          let prevFront = false;
          for (const p of pts) {
            const c = toCam(p);
            const front = c.z >= 0;
            const s = toScreen(c);
            if (prev && front && prevFront) {
              ctx.lineTo(s.x, s.y);
            } else if (front) {
              ctx.moveTo(s.x, s.y);
            }
            prev = s;
            prevFront = front;
          }
        };
        ctx.strokeStyle = 'rgba(140, 200, 255, 0.28)';
        ctx.beginPath();
        for (let lat = -60; lat <= 60; lat += 30) {
          const pts: Vec3[] = [];
          for (let lon = 0; lon <= 360; lon += 6) {
            const la = lat * DEG;
            const lo = lon * DEG;
            pts.push({ x: Math.cos(la) * Math.cos(lo), y: Math.sin(la), z: Math.cos(la) * Math.sin(lo) });
          }
          strokeLine(pts);
        }
        for (let lon = 0; lon < 360; lon += 30) {
          const pts: Vec3[] = [];
          for (let lat = -90; lat <= 90; lat += 6) {
            const la = lat * DEG;
            const lo = lon * DEG;
            pts.push({ x: Math.cos(la) * Math.cos(lo), y: Math.sin(la), z: Math.cos(la) * Math.sin(lo) });
          }
          strokeLine(pts);
        }
        ctx.stroke();
      }

      // terminator shading for depth
      const shade = ctx.createRadialGradient(cx - R * 0.5, cy - R * 0.5, R * 0.3, cx, cy, R * 1.05);
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(0,0,10,0.6)');
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // rotation axis
      const nPole = toScreen(toCam({ x: 0, y: 1.35, z: 0 }));
      const sPole = toScreen(toCam({ x: 0, y: -1.35, z: 0 }));
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sPole.x, sPole.y);
      ctx.lineTo(nPole.x, nPole.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // ---------- satellites ----------
      hitRef.current.clear();
      type Item = { o: OrbitModel; cam: Vec3; scr: ReturnType<typeof toScreen>; hidden: boolean };
      const items: Item[] = [];

      for (const o of orbits) {
        const u = o.u0 + o.omega * t;

        // orbit ring
        if (showOrbits) {
          ctx.lineWidth = o.sat.name === selectedRef.current ? 1.8 : 1;
          let drawing = false;
          let lastHidden = false;
          const N = 120;
          for (let i = 0; i <= N; i++) {
            const c = toCam(orbitPoint(o, (i / N) * Math.PI * 2, o.radius));
            const s = toScreen(c);
            const hid = occluded(c);
            if (hid !== lastHidden || !drawing) {
              if (drawing) ctx.stroke();
              ctx.strokeStyle = withAlpha(o.sat.color, hid ? 0.07 : c.z < 0 ? 0.2 : 0.45);
              ctx.beginPath();
              ctx.moveTo(s.x, s.y);
              drawing = true;
              lastHidden = hid;
            } else {
              ctx.lineTo(s.x, s.y);
            }
          }
          if (drawing) ctx.stroke();
        }

        const world = orbitPoint(o, u, o.radius);

        // trail
        let trail = trailsRef.current.get(o.sat.name);
        if (!trail) {
          trail = [];
          trailsRef.current.set(o.sat.name, trail);
        }
        trail.push(world);
        if (trail.length > TRAIL_LEN) trail.shift();
        if (showTrails && trail.length > 2) {
          for (let i = 1; i < trail.length; i++) {
            const a = toScreen(toCam(trail[i - 1]));
            const b = toScreen(toCam(trail[i]));
            ctx.strokeStyle = withAlpha(o.sat.color, (i / trail.length) * 0.7);
            ctx.lineWidth = 0.6 + (i / trail.length) * 2;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }

        const cam3 = toCam(world);
        items.push({ o, cam: cam3, scr: toScreen(cam3), hidden: occluded(cam3) });
      }

      // painter's algorithm: far first
      items.sort((a, b) => a.cam.z - b.cam.z);

      for (const { o, cam: c, scr, hidden } of items) {
        const sat = o.sat;
        const isSel = selectedRef.current === sat.name;
        const isHover = hoverRef.current === sat.name;
        const size = (4 + 3 * scr.k) * (isSel || isHover ? 1.35 : 1) * (hidden ? 0.7 : 1);
        const alpha = hidden ? 0.25 : 1;

        // pulse ring for selected
        if (isSel) {
          const pulse = (now % 1500) / 1500;
          ctx.strokeStyle = withAlpha(sat.color, (1 - pulse) * 0.8);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(scr.x, scr.y, size + 4 + pulse * 18, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.shadowBlur = hidden ? 0 : 16;
        ctx.shadowColor = sat.color;
        ctx.fillStyle = withAlpha(sat.color, alpha);
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = withAlpha(sat.color, 0.5 * alpha);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(scr.x, scr.y, size + 4, 0, Math.PI * 2);
        ctx.stroke();

        // label (only for front-facing, hovered or selected)
        if (!hidden || isSel || isHover) {
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          const tw = ctx.measureText(sat.name).width;
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.fillRect(scr.x - tw / 2 - 5, scr.y - size - 24, tw + 10, 16);
          ctx.fillStyle = sat.color;
          ctx.fillText(sat.name, scr.x, scr.y - size - 12);
        }

        // info card for hover / selection
        if (isSel || isHover) {
          const lines = [
            `Alt  ${sat.alt.toFixed(0)} km`,
            `Vel  ${o.speedKmS.toFixed(2)} km/s`,
            `Per  ${o.periodMin.toFixed(1)} min`,
            `Inc  ${(o.inc / DEG).toFixed(1)}°`,
          ];
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'left';
          const bw = 104;
          const bh = lines.length * 14 + 10;
          let bx = scr.x + size + 12;
          if (bx + bw > cssW - 4) bx = scr.x - size - 12 - bw;
          const by = Math.min(Math.max(scr.y - bh / 2, 4), cssH - bh - 4);
          ctx.fillStyle = 'rgba(5,10,20,0.85)';
          ctx.strokeStyle = withAlpha(sat.color, 0.6);
          ctx.lineWidth = 1;
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeRect(bx, by, bw, bh);
          ctx.fillStyle = '#9fe9ff';
          lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 17 + i * 14));
        }

        hitRef.current.set(sat.name, { x: scr.x, y: scr.y, r: Math.max(size + 8, 14) });
        void c;
      }

      // compass / HUD
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(159,233,255,0.7)';
      ctx.fillText(`drag: rotate  ·  wheel: zoom  ·  ${timeScale}× sim`, 10, cssH - 10);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [orbits, stars, width, height, timeScale, autoRotate, showTrails, showOrbits, showGrid]);

  // ---------- interaction ----------
  const pick = useCallback((clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = Infinity;
    hitRef.current.forEach((p, name) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < p.r && d < bestD) {
        best = name;
        bestD = d;
      }
    });
    return best;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, moved: false, x: e.clientX, y: e.clientY };
    camRef.current.velYaw = 0;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (d.active) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      const cam = camRef.current;
      cam.yaw += dx * 0.008;
      cam.velYaw = dx * 0.008 * 60;
      cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch + dy * 0.006));
      d.x = e.clientX;
      d.y = e.clientY;
    } else {
      const hit = pick(e.clientX, e.clientY);
      hoverRef.current = hit;
      e.currentTarget.style.cursor = hit ? 'pointer' : 'grab';
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    d.active = false;
    if (d.moved) return;
    const hit = pick(e.clientX, e.clientY);
    setSelected(hit);
    if (hit && onSatelliteClick) {
      const sat = satellites.find((s) => s.name === hit);
      if (sat) onSatelliteClick(sat);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const cam = camRef.current;
    cam.zoom = Math.max(0.5, Math.min(2.5, cam.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full touch-none"
      style={{ cursor: 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => (hoverRef.current = null)}
      onWheel={onWheel}
      role="img"
      aria-label="Interactive 3D view of satellites orbiting Earth"
    />
  );
}
