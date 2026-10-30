import type { Plan, Transform } from "./plan.ts";
import { transformPoint } from "./plan.ts";
import { recommendedView } from "./overhead-frame.ts";

type Triple = [number, number, number];
export type PlanCameraView = {
  target: Triple;
  yaw: number;
  pitch: number;
  /** Vertical world span at the orbit target, shared by both projections. */
  span: number;
  defaultSpan: number;
  width: number;
  height: number;
  zoom: number;
  topView: boolean;
};
export type PlanCameraMemory = {
  key: string;
  reset: number;
  view: PlanCameraView | null;
};
export const CAMERA_FOV = 42;
const tanHalfFov = Math.tan((CAMERA_FOV * Math.PI) / 360);
export function cameraPlanKey(plan: Plan, transform: Transform) {
  return JSON.stringify([
    plan.coordinateSystem.pivot,
    plan.outline,
    plan.rooms.map((r) => [r.id, r.name, r.label]),
    plan.walls.map((w) => w.height),
    transform.rotation,
    transform.mirror,
  ]);
}
export function initialCameraView(
  plan: Plan,
  transform: Transform,
  width: number,
  height: number,
): PlanCameraView {
  const recommended = recommendedView(plan, transform, width, height),
    yaw = Math.atan2(recommended.direction[0], recommended.direction[2]),
    [px, py] = plan.coordinateSystem.pivot,
    right = [Math.cos(yaw), -Math.sin(yaw)],
    up = [-Math.sin(yaw), -Math.cos(yaw)];
  // Keep one scale in both modes, while fitting the rotated top-down footprint
  // as well as the recommended perspective's wall tops.
  let maxX = 0, maxY = 0;
  for (const p of plan.outline) {
    const t = transformPoint(p, [px, py], transform),
      x = t[0] - px - recommended.target[0],
      z = py - t[1] - recommended.target[2];
    maxX = Math.max(maxX, Math.abs(x * right[0] + z * right[1]));
    maxY = Math.max(maxY, Math.abs(x * up[0] + z * up[1]));
  }
  const span = Math.max(
    2 * recommended.distance * tanHalfFov,
    2 * (maxY + 0.6),
    2 * (maxX + 0.6) * Math.max(1, height) / Math.max(1, width),
  );
  return {
    target: [...recommended.target], yaw, pitch: Math.PI / 3,
    span, defaultSpan: span, width, height, zoom: 1, topView: false,
  };
}
export function resizeCameraView(saved: PlanCameraView, defaults: PlanCameraView) {
  return {
    ...saved,
    span: saved.span * defaults.defaultSpan / saved.defaultSpan,
    defaultSpan: defaults.defaultSpan,
    width: defaults.width,
    height: defaults.height,
  };
}
export function cameraPose(view: PlanCameraView, flat: boolean) {
  if (flat) return {
    position: [view.target[0], view.target[1] + 25, view.target[2]] as Triple,
    up: [-Math.sin(view.yaw), 0, -Math.cos(view.yaw)] as Triple,
    zoom: Math.max(1, view.height) / view.span,
  };
  const distance = view.span / (2 * tanHalfFov),
    pitch = view.topView ? Math.PI / 2 - 0.0001 : view.pitch,
    direction = [
      Math.sin(view.yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(view.yaw) * Math.cos(pitch),
    ];
  return {
    position: view.target.map((n, i) => n + direction[i] * distance) as Triple,
    up: [0, 1, 0] as Triple,
    zoom: 1,
  };
}
export function perspectiveSpan(distance: number) {
  return 2 * distance * tanHalfFov;
}
