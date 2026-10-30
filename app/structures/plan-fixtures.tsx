"use client";
/* eslint-disable react/no-unknown-property -- Three.js scene objects. */
import { useEffect, useMemo } from "react";
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import {
  REFERENCE_FIXTURES,
  type Fixture,
  type Finish,
} from "./reference-finishes";

export function useFloorTextures(natural = false) {
  const textures = useMemo(() => {
    const make = (kind: Finish) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext("2d")!;
      if (kind === "wood") {
        for (let row = 0; row < 8; row++) {
          ctx.fillStyle = (
            natural
              ? ["#d5c2a4", "#deccb1", "#d8c7aa", "#cdbb9d"]
              : ["#c9a878", "#d1b182", "#d6b789", "#c5a273"]
          )[row % 4];
          ctx.fillRect(0, row * 16, 128, 16);
          ctx.strokeStyle = "#b59368";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(0, row * 16);
          ctx.lineTo(128, row * 16);
          ctx.moveTo(row % 2 ? 45 : 100, row * 16);
          ctx.lineTo(row % 2 ? 45 : 100, row * 16 + 16);
          ctx.stroke();
          if (natural)
            for (let i = 0; i < 12; i++) {
              ctx.strokeStyle = i % 2 ? "#c8b69733" : "#f6ead933";
              ctx.lineWidth = 0.35;
              ctx.beginPath();
              ctx.moveTo(0, row * 16 + i * 1.3);
              ctx.bezierCurveTo(
                33,
                row * 16 + i * 1.3 + 1.8,
                86,
                row * 16 + i * 1.3 - 1,
                128,
                row * 16 + i * 1.3,
              );
              ctx.stroke();
            }
        }
      } else {
        const colors =
          kind === "bath"
            ? natural
              ? ["#d3d2cc", "#dad9d4", "#d5d4ce", "#deddd7"]
              : ["#c2abb0", "#e4d5d6", "#b79ca4", "#d4bec3"]
            : kind === "balcony"
              ? ["#c5c5b7", "#cecec1"]
              : kind === "entry"
                ? ["#e1ddd3", "#e8e4db"]
                : ["#eee3bd"];
        ctx.fillStyle = colors[0];
        ctx.fillRect(0, 0, 128, 128);
        if (kind !== "bedroom")
          for (let y = 0; y < 4; y++)
            for (let x = 0; x < 4; x++) {
              ctx.fillStyle = colors[(x + y * 3) % colors.length];
              ctx.fillRect(x * 32, y * 32, 32, 32);
              ctx.strokeStyle = natural
                ? "#ece9e2"
                : kind === "bath"
                  ? "#99888d"
                  : "#a5a69d";
              ctx.lineWidth = natural ? 0.6 : 1;
              ctx.strokeRect(x * 32, y * 32, 32, 32);
            }
      }
      const texture = new CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.repeat.set(
        kind === "wood" ? 0.65 : 0.8,
        kind === "wood" ? 0.65 : 0.8,
      );
      texture.colorSpace = SRGBColorSpace;
      return texture;
    };
    return {
      bath: make("bath"),
      balcony: make("balcony"),
      wood: make("wood"),
      bedroom: make("bedroom"),
      entry: make("entry"),
    };
  }, [natural]);
  useEffect(
    () => () => Object.values(textures).forEach((t) => t.dispose()),
    [textures],
  );
  return textures;
}
function Block({
  size,
  position = [0, 0, 0],
  color = "#f4f3ef",
}: {
  size: [number, number, number];
  position?: [number, number, number];
  color?: string;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}
function Oval({
  x = 0,
  y,
  z = 0,
  width,
  depth,
  color,
}: {
  x?: number;
  y: number;
  z?: number;
  width: number;
  depth: number;
  color: string;
}) {
  return (
    <mesh
      position={[x, y, z]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[width / 2, depth / 2, 1]}
    >
      <circleGeometry args={[1, 32]} />
      <meshStandardMaterial color={color} roughness={0.3} />
    </mesh>
  );
}
export function Fitting({ fixture: f }: { fixture: Fixture }) {
  const w = f.width,
    d = f.depth,
    cabinetCount = Math.max(1, Math.round(w / 0.55));
  return (
    <group
      position={[f.center[0], 0, -f.center[1]]}
      rotation={[0, (f.rotation * Math.PI) / 180, 0]}
    >
      {f.kind === "counter" && (
        <>
          <Block size={[w, 0.78, d]} position={[0, 0.39, 0]} color="#c5bbaa" />
          <Block
            size={[w + 0.03, 0.045, d + 0.03]}
            position={[0, 0.8, 0]}
            color="#e8e5dd"
          />
          {Array.from({ length: cabinetCount }, (_, i) => (
            <group key={i}>
              <Block
                size={[w / cabinetCount - 0.015, 0.65, 0.016]}
                position={[
                  -w / 2 + ((i + 0.5) * w) / cabinetCount,
                  0.43,
                  d / 2 + 0.008,
                ]}
                color="#e3ded3"
              />
              <Block
                size={[Math.min(0.18, (w / cabinetCount) * 0.55), 0.018, 0.035]}
                position={[
                  -w / 2 + ((i + 0.5) * w) / cabinetCount,
                  0.68,
                  d / 2 + 0.03,
                ]}
                color="#747a7a"
              />
            </group>
          ))}
          <Block
            size={[w * 0.96, 0.08, 0.08]}
            position={[0, 0.06, d / 2 - 0.04]}
            color="#77726a"
          />
        </>
      )}
      {(f.kind === "sink" || f.kind === "basin") && (
        <>
          {f.kind === "basin" && (
            <Block
              size={[w * 0.8, 0.68, d * 0.8]}
              position={[0, 0.34, 0]}
              color="#d6d3cc"
            />
          )}
          <Block size={[w, 0.07, d]} position={[0, 0.84, 0]} />
          <Oval
            y={0.879}
            width={w * 0.78}
            depth={d * 0.7}
            color={f.kind === "sink" ? "#7b9398" : "#b8cdce"}
          />
          <Oval y={0.881} width={0.055} depth={0.055} color="#657a80" />
          <Block
            size={[0.035, 0.22, 0.035]}
            position={[0, 0.98, -d * 0.38]}
            color="#9aa9ac"
          />
          <Block
            size={[0.035, 0.035, d * 0.32]}
            position={[0, 1.08, -d * 0.22]}
            color="#9aa9ac"
          />
        </>
      )}
      {f.kind === "toilet" && (
        <>
          <Block
            size={[w * 0.63, 0.3, d * 0.48]}
            position={[0, 0.15, d * 0.08]}
          />
          <Block
            size={[w * 0.88, 0.68, d * 0.24]}
            position={[0, 0.34, -d * 0.34]}
          />
          <mesh
            position={[0, 0.37, d * 0.12]}
            scale={[w * 0.5, 0.12, d * 0.42]}
          >
            <sphereGeometry args={[1, 20, 12]} />
            <meshStandardMaterial color="#f5f4ef" />
          </mesh>
          <Oval
            y={0.476}
            z={d * 0.12}
            width={w * 0.77}
            depth={d * 0.62}
            color="#f9faf7"
          />
          <Oval
            y={0.48}
            z={d * 0.12}
            width={w * 0.47}
            depth={d * 0.4}
            color="#8da5ac"
          />
        </>
      )}
      {f.kind === "tub" && (
        <>
          <Block size={[w, 0.12, d]} position={[0, 0.1, 0]} color="#bccfd0" />
          <Block size={[w, 0.47, 0.07]} position={[0, 0.29, -d / 2 + 0.035]} />
          <Block size={[w, 0.47, 0.07]} position={[0, 0.29, d / 2 - 0.035]} />
          <Block size={[0.07, 0.47, d]} position={[-w / 2 + 0.035, 0.29, 0]} />
          <Block size={[0.07, 0.47, d]} position={[w / 2 - 0.035, 0.29, 0]} />
          <Block
            size={[0.08, 0.04, 0.14]}
            position={[w / 2 - 0.12, 0.54, 0]}
            color="#96a9ac"
          />
        </>
      )}
      {f.kind === "cooktop" && (
        <>
          <Block
            size={[w, 0.025, d]}
            position={[0, 0.839, 0]}
            color="#303a3e"
          />
          {[
            [-0.22, -0.24],
            [0.22, -0.24],
            [0, 0.23],
          ].map(([x, z], i) => (
            <mesh
              key={i}
              position={[x * w, 0.856, z * d]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[w * 0.13, w * 0.16, 24]} />
              <meshBasicMaterial color="#c1c9ca" />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}
export function ReferenceFixtures({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  return (
    <group>
      {REFERENCE_FIXTURES.map((f) => (
        <group
          key={f.id}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(f.roomId);
          }}
        >
          <Fitting fixture={f} />
        </group>
      ))}
    </group>
  );
}
