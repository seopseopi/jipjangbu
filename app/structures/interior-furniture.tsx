"use client";
/* eslint-disable react/no-unknown-property -- Three.js objects. */
import { useEffect, useMemo } from "react";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Plan, Room } from "./plan";
import { bedPlacement } from "./furniture-layout";

function SoftBox({
  size,
  position = [0, 0, 0],
  color,
  roughness = 0.8,
}: {
  size: [number, number, number];
  position?: [number, number, number];
  color: string;
  roughness?: number;
}) {
  const [w, h, d] = size;
  const geometry = useMemo(
    () =>
      new RoundedBoxGeometry(w, h, d, 3, Math.min(0.055, w / 4, h / 4, d / 4)),
    [w, h, d],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh position={position} castShadow receiveShadow>
      <primitive attach="geometry" object={geometry} />
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  );
}
function bounds(room: Room) {
  const xs = room.polygon.map((p) => p[0]),
    ys = room.polygon.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    r: Math.max(...xs),
    b: Math.max(...ys),
  };
}
function Bed({ room, master }: { room: Room; master: boolean }) {
  const placement = bedPlacement(room, master);
  if (!placement) return null;
  const {x, y, width, depth} = placement;
  return (
    <group position={[x, 0, -y]}>
      <SoftBox
        size={[width + 0.08, 0.23, depth + 0.08]}
        position={[0, 0.2, 0]}
        color="#9b846a"
      />
      <SoftBox
        size={[width, 0.22, depth]}
        position={[0, 0.415, 0]}
        color="#faf7ef"
      />
      <SoftBox
        size={[width + 0.12, 0.85, 0.09]}
        position={[0, 0.52, -depth / 2 - 0.025]}
        color="#ad9c88"
      />
      <SoftBox
        size={[width + 0.015, 0.07, depth * 0.68]}
        position={[0, 0.56, depth * 0.14]}
        color={master ? "#b4bcb3" : "#b4bfcd"}
      />
      {(master ? [-0.25, 0.25] : [0]).map((p, i) => (
        <SoftBox
          key={i}
          size={[master ? width * 0.41 : width * 0.8, 0.12, 0.36]}
          position={[p * width, 0.59, -depth * 0.31]}
          color="#f2eee7"
        />
      ))}
      <SoftBox
        size={[width, 0.03, 0.15]}
        position={[0, 0.61, depth * 0.42]}
        color="#8f9b91"
      />
    </group>
  );
}
function Living({ room }: { room: Room }) {
  const y = room.label[1],
    hits: number[] = [];
  room.polygon.forEach((a, i) => {
    const b = room.polygon[(i + 1) % room.polygon.length];
    if (a[1] > y !== b[1] > y)
      hits.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  });
  hits.sort((a, b) => a - b);
  let left = hits[0],
    right = hits[hits.length - 1];
  for (let i = 0; i < hits.length; i += 2)
    if (hits[i] <= room.label[0] && hits[i + 1] >= room.label[0]) {
      left = hits[i];
      right = hits[i + 1];
      break;
    }
  if (!Number.isFinite(left) || right - left < 3.0) return null;
  const center = (left + right) / 2,
    sofa = left + 0.55;
  return (
    <group>
      <group position={[sofa, 0, -y]} rotation={[0, Math.PI / 2, 0]}>
        <SoftBox
          size={[2.15, 0.2, 0.86]}
          position={[0, 0.22, 0]}
          color="#9a9f95"
        />
        <SoftBox
          size={[2.17, 0.67, 0.18]}
          position={[0, 0.55, -0.35]}
          color="#c1c3b8"
        />
        {[-1, 1].map((n) => (
          <SoftBox
            key={n}
            size={[0.17, 0.53, 0.85]}
            position={[n * 1.04, 0.42, 0]}
            color="#b5b9ad"
          />
        ))}
        {[-0.7, 0, 0.7].map((x, i) => (
          <SoftBox
            key={i}
            size={[0.65, 0.16, 0.66]}
            position={[x, 0.4, 0.06]}
            color="#d2d4c9"
          />
        ))}
        <SoftBox
          size={[0.35, 0.35, 0.13]}
          position={[-0.68, 0.65, -0.2]}
          color="#aa967f"
        />
      </group>
      <SoftBox
        size={[1.6, 0.018, 2.15]}
        position={[center, 0.018, -y]}
        color="#ded5c5"
      />
      <SoftBox
        size={[0.65, 0.06, 1.05]}
        position={[center, 0.42, -y]}
        color="#aa8763"
        roughness={0.45}
      />
      {[-0.21, 0.21].map((x) =>
        [-0.35, 0.35].map((z) => (
          <SoftBox
            key={`${x}-${z}`}
            size={[0.045, 0.4, 0.045]}
            position={[center + x, 0.21, -y + z]}
            color="#555b59"
          />
        )),
      )}
      <SoftBox
        size={[0.32, 0.42, 1.8]}
        position={[right - 0.21, 0.23, -y]}
        color="#b6a58d"
      />
      <SoftBox
        size={[0.055, 0.8, 1.38]}
        position={[right - 0.18, 1.0, -y]}
        color="#303b40"
        roughness={0.25}
      />
      <SoftBox
        size={[0.012, 0.7, 1.28]}
        position={[right - 0.216, 1.0, -y]}
        color="#53676d"
        roughness={0.2}
      />
    </group>
  );
}
function Dressing({ room }: { room: Room }) {
  const b = bounds(room),
    w = Math.min(2.0, b.r - b.x - 0.3),
    x = (b.x + b.r) / 2,
    y = b.b - 0.28;
  return (
    <group position={[x, 0, -y]}>
      <SoftBox size={[w, 1.95, 0.45]} position={[0, 0.99, 0]} color="#c5b79f" />
      <SoftBox
        size={[w - 0.1, 1.8, 0.04]}
        position={[0, 1.03, 0.24]}
        color="#ece5d8"
      />
      <SoftBox
        size={[0.012, 1.8, 0.02]}
        position={[0, 1.03, 0.27]}
        color="#b9ad98"
      />
      {[-0.08, 0.08].map((x) => (
        <SoftBox
          key={x}
          size={[0.018, 0.16, 0.045]}
          position={[x, 1.0, 0.29]}
          color="#747b7b"
        />
      ))}
    </group>
  );
}
/** Movable furniture and wardrobe fronts are illustrative, never imported as
 * surveyed fixtures or used for fit/clearance decisions. */
export function InteriorFurniture({ plan }: { plan: Plan }) {
  return (
    <group>
      {plan.rooms.map((r) =>
        /침실/.test(r.name) ? (
          <Bed key={r.id} room={r} master={r.name === "침실 1"} />
        ) : r.name === "거실" ? (
          <Living key={r.id} room={r} />
        ) : r.name === "드레스룸" ? (
          <Dressing key={r.id} room={r} />
        ) : null,
      )}
    </group>
  );
}
