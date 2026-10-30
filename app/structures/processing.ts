import { validatePlan, type Plan, type Point } from "./plan";
export type Crop = { x: number; y: number; width: number; height: number };
export type Processing = {
  page: number;
  crop: Crop;
  plan: Plan | null;
  note: string;
  rowVersion: number;
};
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };
export function validateProcessing(
  input: unknown,
): Omit<Processing, "rowVersion"> {
  if (!input || typeof input !== "object")
    throw new Error("가공 정보를 확인해 주세요.");
  const v = input as Processing,
    c = v.crop;
  if (
    !Number.isInteger(v.page) ||
    v.page < 1 ||
    v.page > 500 ||
    !c ||
    ![c.x, c.y, c.width, c.height].every(Number.isFinite) ||
    c.x < 0 ||
    c.y < 0 ||
    c.width < 0.01 ||
    c.height < 0.01 ||
    c.x + c.width > 1.000001 ||
    c.y + c.height > 1.000001
  )
    throw new Error("페이지와 평면도 영역을 확인해 주세요.");
  if (v.note != null && (typeof v.note !== "string" || v.note.length > 2000))
    throw new Error("메모 길이를 확인해 주세요.");
  const plan = v.plan == null ? null : validatePlan(v.plan);
  if (plan?.isDemo || plan?.referenceOnly)
    throw new Error("가상·참고 예제는 실제 도면에 저장할 수 없습니다.");
  return {
    page: v.page,
    crop: { x: c.x, y: c.y, width: c.width, height: c.height },
    plan,
    note: v.note?.trim() ?? "",
  };
}
export function tracePlan(
  outline: Point[],
  rooms: { name: string; polygon: Point[] }[],
  width: number,
  ratio: number,
  height: number,
): Plan {
  if (
    ![width, ratio, height].every(Number.isFinite) ||
    width <= 0 ||
    width > 100 ||
    ratio <= 0 ||
    ratio > 20 ||
    height < 1 ||
    height > 5
  )
    throw new Error("기준 폭·층고를 확인해 주세요.");
  const toPoint = ([x, y]: Point): Point => [
    Number((x * width).toFixed(4)),
    Number((y * width * ratio).toFixed(4)),
  ];
  const boundary = outline.map(toPoint);
  const walls: Plan["walls"] = [],
    seen = new Set<string>();
  for (const polygon of [boundary, ...rooms.map((r) => r.polygon.map(toPoint))])
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i],
        end = polygon[(i + 1) % polygon.length];
      const key = [start.join(","), end.join(",")].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        walls.push({
          id: `wall-${walls.length}`,
          start,
          end,
          height,
          thickness: 0.12,
        });
      }
    }
  return validatePlan({
    schemaVersion: 1,
    isDemo: false,
    scaleStatus: "proportional",
    coordinateSystem: { unit: "m", pivot: [width / 2, (width * ratio) / 2] },
    dimensionEvidence: {
      note: `원본 위에서 수동 추적한 배치입니다. 기준 폭 ${width}m·층고 ${height}m는 시각화 입력값이며 실측 확인 전입니다. 문·창문은 별도 확인이 필요합니다.`,
    },
    outline: boundary,
    rooms: rooms.map((r, i) => {
      const polygon = r.polygon.map(toPoint);
      return {
        id: `room-${i}`,
        name: r.name,
        polygon,
        label: roomLabelPoint(polygon),
      };
    }),
    walls,
    doors: [],
    windows: [],
  });
}

/** Keep labels inside a room, away from walls, including concave rooms. */
export function roomLabelPoint(polygon: Point[]): Point {
  const xs = polygon.map((p) => p[0]),
    ys = polygon.map((p) => p[1]),
    minX = Math.min(...xs),
    minY = Math.min(...ys),
    width = Math.max(...xs) - minX,
    height = Math.max(...ys) - minY;
  function inside([x, y]: Point) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j];
      if (
        a[1] > y !== b[1] > y &&
        x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
      )
        result = !result;
    }
    return result;
  }
  let best = polygon[0],
    clearance = -1;
  for (let i = 1; i < 20; i++)
    for (let j = 1; j < 20; j++) {
      const p: Point = [minX + (width * i) / 20, minY + (height * j) / 20];
      if (!inside(p)) continue;
      let distance = Infinity;
      for (let k = 0; k < polygon.length; k++) {
        const a = polygon[k],
          b = polygon[(k + 1) % polygon.length],
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          t = Math.max(
            0,
            Math.min(
              1,
              ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
            ),
          );
        distance = Math.min(
          distance,
          Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy),
        );
      }
      // Prefer the center when several points have equal wall clearance.
      const score =
        distance -
        1e-5 * Math.hypot(p[0] - minX - width / 2, p[1] - minY - height / 2);
      if (score > clearance) {
        best = p;
        clearance = score;
      }
    }
  return best;
}
