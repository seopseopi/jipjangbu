"use client";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import { roomLabelPoint } from "./processing";
import { PlanSvg } from "./plan-svg";
import { type Plan, type Transform } from "./plan";
import { hasReferenceFinishes } from "./hillstate-reference";
const PlanThree = lazy(() => import("./plan-three"));
class ThreeBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function PlanViewer({
  plan: originalPlan,
  minimal = false,
  transform = { mirror: false, rotation: 0 },
}: {
  plan: Plan;
  minimal?: boolean;
  transform?: Transform;
}) {
  const plan = useMemo(
    () =>
      hasReferenceFinishes(originalPlan)
        ? originalPlan
        : {
            ...originalPlan,
            rooms: originalPlan.rooms.map((r) =>
              r.label[0] === r.polygon[0][0] && r.label[1] === r.polygon[0][1]
                ? { ...r, label: roomLabelPoint(r.polygon) }
                : r,
            ),
          },
    [originalPlan],
  );
  const [mode, setMode] = useState("2d"),
    [selected, setSelected] = useState(""),
    [zoom, setZoom] = useState(1),
    [reset, setReset] = useState(0),
    [topView, setTopView] = useState(false),
    [showRoute, setShowRoute] = useState(true),
    [show2dLabels, setShow2dLabels] = useState(true),
    [show3dLabels, setShow3dLabels] = useState(!hasReferenceFinishes(plan)),
    [failed, setFailed] = useState(false);
  const showLabels = mode === "2d" ? show2dLabels : show3dLabels;
  const failure = useCallback(() => {
    setFailed(true);
    setMode("2d");
  }, []);
  const selectRoom = useCallback(
    (id: string) => setSelected((current) => (current === id ? "" : id)),
    [],
  );
  const svg = (
    <PlanSvg
      plan={plan}
      transform={transform}
      selected={selected}
      onSelect={selectRoom}
      zoom={zoom}
      showRoute={showRoute}
      showLabels={showLabels}
    />
  );
  return (
    <section className="structure-viewer" aria-label="집 구조 뷰어">
      <div className="structure-viewer-bar">
        <div className="structure-segment">
          <button
            type="button"
            aria-pressed={mode === "2d"}
            onClick={() => setMode("2d")}
          >
            {minimal ? "2D" : "2D 평면도"}
          </button>
          <button
            type="button"
            aria-pressed={mode === "3d"}
            disabled={failed}
            onClick={() => setMode("3d")}
          >
            {minimal ? "3D" : "3D 구조"}
          </button>
        </div>
        {!minimal && (
          <div className="structure-tools">
            <button
              type="button"
              disabled={zoom >= 2}
              onClick={() => setZoom((z) => Math.min(2, z + 0.2))}
            >
              확대 +
            </button>
            <button
              type="button"
              disabled={zoom <= 0.6}
              onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}
            >
              축소 −
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setTopView(false);
                setShow2dLabels(true);
                setShow3dLabels(!hasReferenceFinishes(plan));
                setShowRoute(true);
                setSelected("");
                setReset((r) => r + 1);
              }}
            >
              보기 초기화
            </button>
          </div>
        )}
      </div>
      {!minimal && (
        <div className="structure-reading-tools">
          <button
            type="button"
            aria-pressed={showLabels}
            onClick={() =>
              mode === "2d"
                ? setShow2dLabels((v) => !v)
                : setShow3dLabels((v) => !v)
            }
          >
            방 이름 {showLabels ? "켜짐" : "꺼짐"}
          </button>
          {mode === "3d" && (
            <button
              type="button"
              aria-pressed={topView}
              onClick={() => setTopView((v) => !v)}
            >
              {topView ? "위에서 보기 ✓" : "위에서 보기"}
            </button>
          )}
          {plan.entry && (
            <button
              type="button"
              aria-pressed={showRoute}
              onClick={() => setShowRoute((v) => !v)}
            >
              입구 안내선 {showRoute ? "켜짐" : "꺼짐"}
            </button>
          )}
          {!hasReferenceFinishes(plan) && (
            <span>침실은 파랑 · 욕실은 청록 · 현관은 주황</span>
          )}
        </div>
      )}
      <div className="structure-canvas">
        {mode === "2d" ? (
          svg
        ) : (
          <ThreeBoundary
            fallback={
              <>
                <p role="status">3D 실행이 어려워 평면도로 표시합니다.</p>
                {svg}
              </>
            }
          >
            <Suspense
              fallback={
                <p className="structure-empty" role="status">
                  3D 구조를 준비하고 있습니다…
                </p>
              }
            >
              <PlanThree
                plan={plan}
                transform={transform}
                selected={selected}
                onSelect={selectRoom}
                reset={reset}
                zoom={zoom}
                onFailure={failure}
                lowWalls={false}
                topView={topView}
                showRoute={showRoute}
                showLabels={showLabels}
              />
            </Suspense>
          </ThreeBoundary>
        )}
      </div>
      <p className="structure-help">
        {mode === "3d"
          ? "드래그로 회전 · 휠 또는 두 손가락으로 확대 · "
          : "방을 선택해 배치를 확인하세요 · "}
        {plan.scaleStatus === "verified"
          ? "자료 기준 치수 확인"
          : "배치 참고용 · 실측 아님"}
        {failed ? " · 3D 사용 불가, 2D로 표시 중" : ""}
      </p>
    </section>
  );
}
