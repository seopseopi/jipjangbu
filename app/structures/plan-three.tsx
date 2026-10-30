"use client";
/* eslint-disable react/no-unknown-property -- R3F JSX describes Three.js objects, not HTML. */
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import {
  Shape,
  Vector3,
  DoubleSide,
  ACESFilmicToneMapping,
  MOUSE,
  TOUCH,
  type Mesh,
  type MeshStandardMaterial,
  type OrthographicCamera,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ReferenceFixtures, useFloorTextures, Fitting } from "./plan-fixtures";
import { reviewedInterior, roomFinish } from "./interior-details";
import { InteriorFurniture } from "./interior-furniture";
import { referenceFinish } from "./reference-finishes";
import { hasReferenceFinishes } from "./hillstate-reference";
import { overheadFrame, recommendedView } from "./overhead-frame";
import {
  roomColor,
  transformPoint,
  wallSolids,
  wallPoint,
  type Plan,
  type Point,
  type Transform,
} from "./plan";

function OverheadControls({
  plan,
  transform,
  reset,
  zoom,
  onFailure,
}: {
  plan: Plan;
  transform: Transform;
  reset: number;
  zoom: number;
  onFailure: () => void;
}) {
  const { camera, gl, size, invalidate } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  const frame = useMemo(
    () => overheadFrame(plan, transform, size.width, size.height),
    [plan, transform, size.width, size.height],
  );
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableRotate = false;
    controls.screenSpacePanning = true;
    controls.mouseButtons.LEFT = MOUSE.PAN;
    controls.touches.ONE = TOUCH.PAN;
    controls.touches.TWO = TOUCH.DOLLY_PAN;
    controlsRef.current = controls;
    const changed = () => invalidate();
    const lost = (event: Event) => {
      event.preventDefault();
      onFailure();
    };
    controls.addEventListener("change", changed);
    gl.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      controls.removeEventListener("change", changed);
      controls.dispose();
      controlsRef.current = null;
      gl.domElement.removeEventListener("webglcontextlost", lost);
    };
  }, [camera, gl, invalidate, onFailure]);
  /* eslint-disable react-hooks/immutability -- Three.js camera is mutable renderer state, updated in effects. */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    camera.position.set(frame.x, 25, frame.z + 0.001);
    (camera as OrthographicCamera).zoom = frame.zoom * zoom;
    camera.updateProjectionMatrix();
    controls.target.set(frame.x, 0, frame.z);
    controls.minZoom = frame.zoom * 0.65;
    controls.maxZoom = frame.zoom * 3;
    controls.update();
    invalidate();
  }, [camera, frame, reset, zoom, invalidate]);
  /* eslint-enable react-hooks/immutability */
  return null;
}

function Controls({
  plan,
  transform,
  reset,
  zoom,
  onFailure,
  topView,
}: {
  plan: Plan;
  transform: Transform;
  reset: number;
  zoom: number;
  onFailure: () => void;
  topView: boolean;
}) {
  const { camera, gl, invalidate, size } = useThree();
  const view = useMemo(
    () => recommendedView(plan, transform, size.width, size.height),
    [plan, transform, size.width, size.height],
  );
  const fit = JSON.stringify(view);
  const controlsRef = useRef<OrbitControls | null>(null);
  const previousView = useRef<{
    zoom: number;
    reset: number;
    topView: boolean;
    fit: string;
  } | null>(null);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controlsRef.current = controls;
    controls.target.set(0, 0, 0);
    controls.maxPolarAngle = Math.PI / 3;
    controls.minDistance = 4;
    controls.maxDistance = 45;
    controls.update();
    const changed = () => invalidate();
    controls.addEventListener("change", changed);
    const lost = (event: Event) => {
      event.preventDefault();
      onFailure();
    };
    gl.domElement.addEventListener("webglcontextlost", lost);
    invalidate();
    return () => {
      controls.removeEventListener("change", changed);
      controls.dispose();
      controlsRef.current = null;
      previousView.current = null;
      gl.domElement.removeEventListener("webglcontextlost", lost);
    };
  }, [camera, gl, invalidate, onFailure]);
  useEffect(() => {
    const controls = controlsRef.current,
      previous = previousView.current;
    if (!controls) return;
    if (
      !previous ||
      previous.reset !== reset ||
      previous.topView !== topView ||
      previous.fit !== fit
    ) {
      controls.maxDistance = Math.max(45, view.distance * 2);
      controls.minDistance = view.distance * 0.3;
      controls.target.set(...view.target);
      const direction = topView ? [0, 1, 0.0001] : view.direction;
      camera.position
        .set(...view.target)
        .addScaledVector(
          new Vector3(direction[0], direction[1], direction[2]),
          view.distance / zoom,
        );
    } else if (previous.zoom !== zoom) {
      // Dolly along the current line of sight; do not discard the user's orbit or pan.
      camera.position
        .sub(controls.target)
        .multiplyScalar(previous.zoom / zoom)
        .add(controls.target);
    }
    previousView.current = { zoom, reset, topView, fit };
    controls.update();
    invalidate();
  }, [camera, fit, view, zoom, reset, topView, invalidate]);
  return null;
}
function Scene({
  plan,
  transform,
  selected,
  onSelect,
  labels,
  lowWalls,
  showRoute,
  flatView = false,
}: {
  plan: Plan;
  transform: Transform;
  selected: string;
  onSelect: (id: string) => void;
  labels: React.RefObject<(HTMLSpanElement | null)[]>;
  lowWalls: boolean;
  showRoute: boolean;
  flatView?: boolean;
}) {
  const { camera, size } = useThree();
  const detailed = hasReferenceFinishes(plan);
  const interior = useMemo(() => reviewedInterior(plan), [plan]);
  const textures = useFloorTextures(!!interior);
  const cutaway = useRef(new Map<string, Mesh>());
  const wallPosition = useRef(new Vector3());
  const pos = (p: Point): [number, number, number] => {
    const t = transformPoint(p, plan.coordinateSystem.pivot, transform);
    return [
      t[0] - plan.coordinateSystem.pivot[0],
      0,
      -t[1] + plan.coordinateSystem.pivot[1],
    ];
  };
  const shapes = useMemo(
    () =>
      plan.rooms.map((room) => {
        const s = new Shape();
        room.polygon.forEach(([x, y], i) =>
          i ? s.lineTo(x, y) : s.moveTo(x, y),
        );
        s.closePath();
        return s;
      }),
    [plan],
  );
  const vector = useRef(new Vector3());
  const footprint = useMemo(() => {
    const shape = new Shape();
    plan.outline.forEach(([x, y], i) =>
      i ? shape.lineTo(x, y) : shape.moveTo(x, y),
    );
    shape.closePath();
    return shape;
  }, [plan]);
  useFrame(() => {
    // Demand rendering may stop after this frame; project labels with the current camera.
    camera.updateMatrixWorld();
    if (interior)
      cutaway.current.forEach((mesh) => {
        mesh.getWorldPosition(wallPosition.current);
        const front =
          !flatView &&
          wallPosition.current.x * camera.position.x +
            wallPosition.current.z * camera.position.z >
            1.5;
        const material = mesh.material as MeshStandardMaterial;
        material.opacity = front ? 0.18 : 1;
        material.depthWrite = !front;
        mesh.castShadow = !front;
      });
    plan.rooms.forEach((room, i) => {
      const el = labels.current[i];
      if (!el) return;
      const p = pos(room.label);
      vector.current.set(p[0], detailed ? 1.15 : 0.12, p[2]).project(camera);
      el.style.transform = `translate(-50%, -50%) translate(${((vector.current.x + 1) * size.width) / 2}px,${((-vector.current.y + 1) * size.height) / 2}px)`;
      el.style.visibility = vector.current.z > 1 ? "hidden" : "visible";
    });
    const entryEl = labels.current[plan.rooms.length];
    if (plan.entry && entryEl) {
      const p = pos(plan.entry.route[0]);
      vector.current.set(p[0], 0.25, p[2]).project(camera);
      entryEl.style.setProperty(
        "transform",
        `translate(-50%, -120%) translate(${((vector.current.x + 1) * size.width) / 2}px,${((-vector.current.y + 1) * size.height) / 2}px)`,
      );
    }
  });
  return (
    <>
      <ambientLight intensity={interior ? 0.65 : 1.4} />
      <hemisphereLight args={["#fff8ed", "#b2bbc0", 1.1]} />
      <directionalLight
        position={[4, 15, 7]}
        intensity={interior ? 2.4 : 2}
        castShadow={!!interior}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={15}
        shadow-camera-bottom={-15}
        shadow-normalBias={0.035}
      />
      {interior && (
        <directionalLight
          position={[-8, 7, -9]}
          intensity={0.7}
          color="#dceaff"
        />
      )}
      <group
        rotation={[0, (transform.rotation * Math.PI) / 180, 0]}
        scale={[transform.mirror ? -1 : 1, 1, 1]}
      >
        <group
          position={[
            -plan.coordinateSystem.pivot[0],
            0,
            plan.coordinateSystem.pivot[1],
          ]}
        >
          {interior && (
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, -0.14, 0]}
              receiveShadow
            >
              <extrudeGeometry
                args={[footprint, { depth: 0.12, bevelEnabled: false }]}
              />
              <meshStandardMaterial color="#dfd9cd" roughness={0.9} />
            </mesh>
          )}
          {interior && (
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.004, 0]} receiveShadow>
              <shapeGeometry args={[footprint]} />
              <meshStandardMaterial map={textures.wood} color="#ffffff" roughness={0.78} side={DoubleSide} />
            </mesh>
          )}
          {plan.rooms.map((room, i) => (
            <mesh
              key={room.id}
              rotation={[-Math.PI / 2, 0, 0]}
              receiveShadow
              onClick={(e) => {
                e.stopPropagation();
                onSelect(room.id);
              }}
            >
              <shapeGeometry args={[shapes[i]]} />
              <meshStandardMaterial
                side={DoubleSide}
                map={
                  interior
                    ? textures[roomFinish(room)]
                    : detailed
                      ? textures[referenceFinish(room.id)]
                      : null
                }
                roughness={interior && /욕실|현관/.test(room.name) ? 0.4 : 0.78}
                color={
                  selected === room.id
                    ? "#8ab6aa"
                    : detailed || interior
                      ? "#ffffff"
                      : roomColor(room)
                }
              />
            </mesh>
          ))}
          {detailed && <ReferenceFixtures onSelect={onSelect} />}
          {interior && (
            <>
              {interior.fixtures.map((f) => (
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
              <InteriorFurniture plan={plan} />
            </>
          )}
          {plan.walls.flatMap((w) =>
            wallSolids(w, [...plan.doors, ...plan.windows]).map((s, i) => {
              const top = flatView
                ? Math.min(s.top, 0.18)
                : lowWalls
                  ? Math.min(s.top, 0.6)
                  : s.top;
              if (s.bottom >= top) return null;
              const p = wallPoint(w, (s.from + s.to) / 2);
              return (
                <mesh
                  key={`${w.id}-${i}`}
                  ref={(mesh) => {
                    const key = `${w.id}-${i}`;
                    if (mesh) cutaway.current.set(key, mesh);
                    else cutaway.current.delete(key);
                  }}
                  castShadow
                  receiveShadow
                  position={[p[0], (s.bottom + top) / 2, -p[1]]}
                  rotation={[
                    0,
                    Math.atan2(w.end[1] - w.start[1], w.end[0] - w.start[0]),
                    0,
                  ]}
                >
                  <boxGeometry
                    args={[s.to - s.from, top - s.bottom, w.thickness]}
                  />
                  <meshStandardMaterial
                    color={interior ? "#eee9df" : "#a5b0ba"}
                    roughness={0.82}
                    transparent={!!interior}
                  />
                </mesh>
              );
            }),
          )}
          {plan.windows.map((o) => {
            const w = plan.walls.find((w) => w.id === o.wallId)!,
              p = wallPoint(w, o.offset + o.width / 2);
            return (
              <group
                key={o.id}
                position={[
                  p[0],
                  flatView
                    ? 0.12
                    : lowWalls
                      ? 0.62
                      : (o.sillHeight ?? 0) + o.height / 2,
                  -p[1],
                ]}
                rotation={[
                  0,
                  Math.atan2(w.end[1] - w.start[1], w.end[0] - w.start[0]),
                  0,
                ]}
              >
                <mesh>
                  <boxGeometry
                    args={[
                      o.width,
                      flatView ? 0.08 : lowWalls ? 0.045 : o.height,
                      lowWalls ? 0.12 : 0.025,
                    ]}
                  />
                  <meshPhysicalMaterial
                    color={interior ? "#d5e7e8" : "#88c7dd"}
                    transparent
                    opacity={lowWalls ? 1 : interior ? 0.18 : 0.3}
                    roughness={0.12}
                    metalness={0.05}
                    depthWrite={false}
                  />
                </mesh>
                {interior && (
                  <>
                    {[-0.5, 0, 0.5].map((n) => (
                      <mesh key={n} position={[n * o.width, 0, 0]} castShadow>
                        <boxGeometry
                          args={[
                            0.045,
                            flatView ? 0.08 : lowWalls ? 0.045 : o.height,
                            0.06,
                          ]}
                        />
                        <meshStandardMaterial
                          color="#dddcd4"
                          metalness={0.35}
                          roughness={0.35}
                        />
                      </mesh>
                    ))}
                    {[-0.5, 0.5].map((n) => (
                      <mesh
                        key={n}
                        position={[
                          0,
                          n * (flatView ? 0.08 : lowWalls ? 0.045 : o.height),
                          0,
                        ]}
                        castShadow
                      >
                        <boxGeometry args={[o.width, 0.045, 0.065]} />
                        <meshStandardMaterial
                          color="#deddd5"
                          metalness={0.35}
                          roughness={0.35}
                        />
                      </mesh>
                    ))}
                  </>
                )}
              </group>
            );
          })}
          {plan.doors.map((o) => {
            const w = plan.walls.find((w) => w.id === o.wallId)!,
              p = wallPoint(
                w,
                o.offset + (o.hinge === "end" ? o.width : 0),
                ((o.opensTo === "left" ? 1 : -1) * o.width) / 2,
              );
            return (
              <group
                key={o.id}
                position={[
                  p[0],
                  (flatView ? 0.22 : lowWalls ? 0.45 : o.height) / 2,
                  -p[1],
                ]}
                rotation={[
                  0,
                  Math.atan2(w.end[1] - w.start[1], w.end[0] - w.start[0]) +
                    Math.PI / 2,
                  0,
                ]}
              >
                <mesh castShadow receiveShadow>
                  <boxGeometry
                    args={[
                      o.width,
                      flatView ? 0.22 : lowWalls ? 0.45 : o.height,
                      0.035,
                    ]}
                  />
                  <meshStandardMaterial
                    color={
                      interior
                        ? plan.entry?.doorId === o.id
                          ? "#857967"
                          : "#d4c5ac"
                        : plan.entry?.doorId === o.id
                          ? "#b75b0b"
                          : "#aa987a"
                    }
                    roughness={0.6}
                  />
                </mesh>
                {interior && (
                  <>
                    <mesh position={[0, 0, 0.022]}>
                      <boxGeometry
                        args={[
                          o.width - 0.12,
                          (flatView ? 0.22 : lowWalls ? 0.45 : o.height) - 0.16,
                          0.014,
                        ]}
                      />
                      <meshStandardMaterial color="#ded2bd" roughness={0.6} />
                    </mesh>
                    <mesh position={[o.width * 0.34, -0.05, 0.06]}>
                      <boxGeometry args={[0.11, 0.025, 0.075]} />
                      <meshStandardMaterial
                        color="#7c8585"
                        metalness={0.85}
                        roughness={0.2}
                      />
                    </mesh>
                  </>
                )}
              </group>
            );
          })}
          {showRoute &&
            plan.entry?.route.slice(1).map((p, i) => {
              const a = plan.entry!.route[i],
                dx = p[0] - a[0],
                dy = p[1] - a[1];
              return (
                <mesh
                  key={`route-${i}`}
                  position={[(a[0] + p[0]) / 2, 0.045, -(a[1] + p[1]) / 2]}
                  rotation={[0, Math.atan2(dy, dx), 0]}
                >
                  <boxGeometry args={[Math.hypot(dx, dy), 0.025, 0.09]} />
                  <meshBasicMaterial color="#b75b0b" />
                </mesh>
              );
            })}
          {plan.entry && (
            <mesh
              position={[
                plan.entry.route[0][0],
                0.065,
                -plan.entry.route[0][1],
              ]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <ringGeometry args={[0.14, 0.23, 32]} />
              <meshBasicMaterial color="#b75b0b" side={DoubleSide} />
            </mesh>
          )}
        </group>
      </group>
    </>
  );
}
export default function PlanThree(props: {
  plan: Plan;
  transform: Transform;
  selected: string;
  onSelect: (id: string) => void;
  reset: number;
  zoom: number;
  onFailure: () => void;
  lowWalls: boolean;
  topView: boolean;
  showRoute: boolean;
  showLabels: boolean;
  flatView?: boolean;
}) {
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const interior = useMemo(() => reviewedInterior(props.plan), [props.plan]);
  return (
    <div
      className={`structure-three${interior ? " is-furnished" : ""}${props.flatView ? " is-overhead" : ""}`}
    >
      <Canvas
        role="img"
        aria-label={
          props.flatView
            ? "가구와 설비가 있는 수직 평면도"
            : "집 내부 입체 보기"
        }
        key={props.flatView ? "overhead" : "orbit"}
        orthographic={props.flatView}
        frameloop="demand"
        dpr={[1, 1.5]}
        shadows
        gl={{
          antialias: true,
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        camera={{
          position: props.flatView ? [0, 25, 0.001] : [12, 14, 12],
          fov: 42,
        }}
        fallback={<p aria-hidden="true">실내 보기를 사용할 수 없습니다.</p>}
      >
        {props.flatView ? (
          <OverheadControls
            plan={props.plan}
            transform={props.transform}
            reset={props.reset}
            zoom={props.zoom}
            onFailure={props.onFailure}
          />
        ) : (
          <Controls
            plan={props.plan}
            transform={props.transform}
            reset={props.reset}
            zoom={props.zoom}
            onFailure={props.onFailure}
            topView={props.topView}
          />
        )}
        <Scene {...props} labels={labels} />
      </Canvas>
      <div className="structure-labels" aria-hidden="true">
        {props.plan.rooms.map((r, i) => (
          <span
            key={r.id}
            className={`${props.selected === r.id ? "is-selected" : ""} ${r.id === props.plan.entry?.roomId ? "is-entrance" : ""}`}
            hidden={
              !props.showLabels ||
              (!!interior && /발코니/.test(r.name) && props.selected !== r.id)
            }
            ref={(el) => {
              labels.current[i] = el;
            }}
          >
            {r.name}
          </span>
        ))}
        {props.plan.entry && (
          <span
            className="structure-entry-pin"
            ref={(el) => {
              labels.current[props.plan.rooms.length] = el;
            }}
          >
            ① 출입구
          </span>
        )}
      </div>
    </div>
  );
}
