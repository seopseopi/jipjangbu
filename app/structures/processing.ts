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
  if (typeof v.note !== "string" || !v.note.trim() || v.note.length > 2000)
    throw new Error("가공 근거를 기록해 주세요.");
  const plan = v.plan == null ? null : validatePlan(v.plan);
  if (plan?.isDemo || plan?.referenceOnly)
    throw new Error("가상·참고 예제는 실제 도면에 저장할 수 없습니다.");
  return {
    page: v.page,
    crop: { x: c.x, y: c.y, width: c.width, height: c.height },
    plan,
    note: v.note.trim(),
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
      return { id: `room-${i}`, name: r.name, polygon, label: polygon[0] };
    }),
    walls,
    doors: [],
    windows: [],
  });
}
