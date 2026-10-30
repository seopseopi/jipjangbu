import { transformPoint, type Plan, type Transform } from "./plan.ts";

/** Orthographic framing shares the same transformed footprint as the 3D scene.
 * Pixels per metre fit both portrait screens and rotated/mirrored plans. */
export function overheadFrame(
  plan: Plan,
  transform: Transform,
  width: number,
  height: number,
) {
  const [px, py] = plan.coordinateSystem.pivot;
  const points = plan.outline.map((p) =>
    transformPoint(p, [px, py], transform),
  );
  const xs = points.map((p) => p[0] - px),
    zs = points.map((p) => py - p[1]);
  const left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...zs),
    bottom = Math.max(...zs);
  return {
    x: (left + right) / 2,
    z: (top + bottom) / 2,
    zoom: Math.min(
      Math.max(1, width) / (right - left + 1.2),
      Math.max(1, height) / (bottom - top + 1.2),
    ),
  };
}

/** A room-facing diagonal view, fitted against every top/bottom footprint corner
 * in camera space. No particular north-facing household orientation is implied. */
export function recommendedView(
  plan: Plan,
  transform: Transform,
  width: number,
  height: number,
) {
  const frame = overheadFrame(plan, transform, width, height),
    [px, py] = plan.coordinateSystem.pivot;
  const area = (points: Plan["outline"]) =>
    Math.abs(
      points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p[0] * q[1] - q[0] * p[1];
      }, 0),
    );
  const living = plan.rooms.find((r) => r.name === "거실");
  const balcony = plan.rooms
    .filter((r) => /발코니/.test(r.name))
    .sort((a, b) => area(b.polygon) - area(a.polygon))[0];
  const world = (p: Plan["outline"][number]) => {
    const t = transformPoint(p, [px, py], transform);
    return [t[0] - px, py - t[1]];
  };
  let yaw = Math.atan2(7, 12);
  if (living && balcony) {
    const a = world(living.label),
      b = world(balcony.label);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.1)
      yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + 0.32;
  }
  const pitch = Math.PI / 3,
    direction = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ] as const;
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)],
    up = [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      -Math.cos(yaw) * Math.sin(pitch),
    ];
  const target = [frame.x, 0.45, frame.z] as const;
  const tanV = Math.tan((42 * Math.PI) / 360),
    tanH = tanV * Math.max(0.1, width / Math.max(1, height));
  const wallHeight = Math.max(2.4, ...plan.walls.map((w) => w.height));
  let distance = 4;
  for (const p of plan.outline) {
    const [x, z] = world(p);
    for (const y of [0, wallHeight]) {
      const v = [x - target[0], y - target[1], z - target[2]];
      const dot = (a: readonly number[]) =>
        v.reduce((s, n, i) => s + n * a[i], 0);
      distance = Math.max(
        distance,
        dot(direction) +
          Math.max(
            (Math.abs(dot(right)) + 0.5) / tanH,
            (Math.abs(dot(up)) + 0.5) / tanV,
          ),
      );
    }
  }
  return { target, direction, distance: distance * 1.08 };
}
