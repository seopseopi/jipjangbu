import catalogs from "./interior-details.json" with { type: "json" };
import extraCatalogs from "./interior-extra-details.json" with { type: "json" };
import type { Plan, Room } from "./plan";
import type { Finish, Fixture } from "./reference-finishes";

export function interiorBasis(plan: Plan) {
  return {
    outline: plan.outline,
    rooms: plan.rooms.map((r) => [r.id, r.name, r.polygon]),
    walls: plan.walls.map((w) => [w.id, w.start, w.end, w.height, w.thickness]),
    doors: plan.doors.map((o) => [
      o.id,
      o.wallId,
      o.offset,
      o.width,
      o.height,
      o.hinge,
      o.opensTo,
    ]),
    windows: plan.windows.map((o) => [
      o.id,
      o.wallId,
      o.offset,
      o.width,
      o.height,
      o.sillHeight,
    ]),
  };
}
const reviewed = [...catalogs, ...extraCatalogs].map((c) => ({
  key: JSON.stringify(c.basis),
  fixtures: c.fixtures as Fixture[],
}));
export function reviewedInterior(plan: Plan) {
  if (plan.isDemo || plan.referenceOnly) return null;
  return (
    reviewed.find((c) => c.key === JSON.stringify(interiorBasis(plan))) ?? null
  );
}
export function roomFinish(room: Room): Finish {
  if (/욕실/.test(room.name)) return "bath";
  if (/발코니/.test(room.name)) return "balcony";
  if (/현관|전실/.test(room.name)) return "entry";
  return "wood";
}
