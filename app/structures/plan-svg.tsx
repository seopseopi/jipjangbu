"use client";
import { useId } from "react";
import { layoutRoomLabels } from "./label-layout";
import { hasReferenceFinishes } from "./hillstate-reference";
import { referenceFinish } from "./reference-finishes";
import {
  ReferenceFixturesSvg,
  ReferenceFloorPatterns,
} from "./plan-fixtures-svg";
import {
  transformPoint,
  wallPoint,
  roomColor,
  type Plan,
  type Point,
  type Transform,
} from "./plan";

export function PlanSvg({
  plan,
  transform,
  selected,
  onSelect,
  zoom,
  showRoute = true,
  showLabels = true,
}: {
  plan: Plan;
  transform: Transform;
  selected: string;
  onSelect: (id: string) => void;
  zoom: number;
  showRoute?: boolean;
  showLabels?: boolean;
}) {
  const arrowId = useId().replace(/:/g, "");
  const detailed = hasReferenceFinishes(plan);
  const point = (p: Point): Point => {
    const [x, y] = transformPoint(p, plan.coordinateSystem.pivot, transform);
    return [x, -y];
  };
  const corners = [...plan.outline, ...(plan.entry?.route ?? [])].map(point),
    xs = corners.map((p) => p[0]),
    ys = corners.map((p) => p[1]);
  const width = Math.max(...xs) - Math.min(...xs) + 1.4,
    height = Math.max(...ys) - Math.min(...ys) + 1.4;
  const center = [
    (Math.max(...xs) + Math.min(...xs)) / 2,
    (Math.max(...ys) + Math.min(...ys)) / 2,
  ];
  const labelScale=80;
  const left=center[0]-width/zoom/2, top=center[1]-height/zoom/2;
  const labelPositions=layoutRoomLabels(plan.rooms.filter(()=>showLabels).map(room=>{
    const [x,y]=point(room.label);
    return {id:room.id,x:(x-left)*labelScale,y:(y-top)*labelScale,
      width:Math.max(.65,room.name.length*.3)*labelScale,height:.42*labelScale,
      priority:room.id===selected?100:room.name==="거실"?70:50};
  }),width/zoom*labelScale,height/zoom*labelScale);
  const line = (a: Point, b: Point) => ({
    x1: point(a)[0],
    y1: point(a)[1],
    x2: point(b)[0],
    y2: point(b)[1],
  });
  return (
    <svg
      className="structure-svg"
      viewBox={`${center[0] - width / zoom / 2} ${center[1] - height / zoom / 2} ${width / zoom} ${height / zoom}`}
      role="group"
      aria-label="집 구조 평면도"
    >
      <defs>
        {detailed && <ReferenceFloorPatterns id={arrowId} />}
        <marker
          id={arrowId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b75b0b" />
        </marker>
      </defs>
      {plan.rooms.map((room) => (
        <g key={room.id} opacity={selected && selected!==room.id ? .45 : 1}>
          <polygon
            role="button"
            tabIndex={0}
            aria-label={room.name}
            aria-pressed={selected === room.id}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(room.id);
              }
            }}
            points={room.polygon.map((p) => point(p).join(",")).join(" ")}
            fill={
              detailed
                ? `url(#${arrowId}-${referenceFinish(room.id)})`
                : selected === room.id
                  ? "#99bcb4"
                  : roomColor(room)
            }
            stroke={selected === room.id ? "#24564c" : "#fff"}
            strokeWidth={0.035}
            onClick={() => onSelect(room.id)}
          />
          {detailed && selected === room.id && (
            <polygon
              points={room.polygon.map((p) => point(p).join(",")).join(" ")}
              fill="#398778"
              fillOpacity={0.28}
              pointerEvents="none"
            />
          )}
        </g>
      ))}
      {detailed && (
        <ReferenceFixturesSvg
          plan={plan}
          transform={transform}
          onSelect={onSelect}
        />
      )}
      {plan.walls.map((w) => (
        <line
          key={w.id}
          {...line(w.start, w.end)}
          stroke="#465565"
          strokeWidth={w.thickness}
        />
      ))}
      {plan.windows.map((o) => {
        const w = plan.walls.find((w) => w.id === o.wallId)!;
        return (
          <g key={o.id}>
            <line
              {...line(
                wallPoint(w, o.offset),
                wallPoint(w, o.offset + o.width),
              )}
              stroke="#edf7fb"
              strokeWidth={w.thickness + 0.025}
            />
            <line
              {...line(
                wallPoint(w, o.offset),
                wallPoint(w, o.offset + o.width),
              )}
              stroke="#4b98b3"
              strokeWidth={0.055}
            />
          </g>
        );
      })}
      {plan.doors.map((o) => {
        const w = plan.walls.find((w) => w.id === o.wallId)!;
        return (
          <g key={o.id}>
            <line
              {...line(
                wallPoint(w, o.offset),
                wallPoint(w, o.offset + o.width),
              )}
              stroke="#fff"
              strokeWidth={w.thickness + 0.045}
            />
            <line
              {...line(wallPoint(w, o.offset), wallPoint(w, o.offset + o.width))}
              stroke={plan.entry?.doorId === o.id ? "#b75b0b" : "#8b6d4c"}
              strokeWidth={plan.entry?.doorId === o.id ? 0.1 : 0.05}
            />
          </g>
        );
      })}
      {plan.entry && showRoute && (
        <g>
          <polyline
            points={plan.entry.route.map((p) => point(p).join(",")).join(" ")}
            fill="none"
            stroke="#fff"
            strokeWidth={0.17}
          />
          <polyline
            points={plan.entry.route.map((p) => point(p).join(",")).join(" ")}
            fill="none"
            stroke="#b75b0b"
            strokeWidth={0.08}
            strokeDasharray=".16 .09"
            markerEnd={`url(#${arrowId})`}
          />
        </g>
      )}
      {plan.entry &&
        (() => {
          const [x, y] = point(plan.entry.route[0]);
          return (
            <g>
              <rect
                x={x - 0.75}
                y={y - 0.75}
                width={1.5}
                height={0.48}
                rx={0.12}
                fill="#a84e0a"
              />
              <text
                x={x}
                y={y - 0.5}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="white"
                fontSize={0.27}
                fontWeight={700}
              >
                출입구
              </text>
              <circle
                cx={x}
                cy={y}
                r={0.12}
                fill="#b75b0b"
                stroke="#fff"
                strokeWidth={0.04}
              />
            </g>
          );
        })()}
      {labelPositions.filter(p=>p.visible).map(label=>{
        const room=plan.rooms.find(r=>r.id===label.id)!;
        const anchor=point(room.label),x=left+label.x/labelScale,y=top+label.y/labelScale;
        return <g key={room.id} opacity={selected&&selected!==room.id ? .3 : 1} pointerEvents="none">
          {label.moved && <line x1={anchor[0]} y1={anchor[1]} x2={x} y2={y} stroke="#607b72" strokeWidth={.02} />}
          <text x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fontSize={.29} fontWeight={650} fill="#263746" stroke="#ffffffcc"
            strokeWidth={.065} paintOrder="stroke">{room.name}</text>
        </g>;
      })}
    </svg>
  );
}
