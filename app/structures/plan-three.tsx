"use client";
/* eslint-disable react/no-unknown-property -- R3F JSX describes Three.js objects, not HTML. */
import { useEffect, useMemo, useRef, type RefObject } from "react";
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
  type PerspectiveCamera,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ReferenceFixtures, useFloorTextures, Fitting } from "./plan-fixtures";
import { reviewedInterior, roomFinish } from "./interior-details";
import { InteriorFurniture } from "./interior-furniture";
import { RoomContents } from "./room-contents";
import { layoutRoomLabels, type RoomLabelAnchor } from "./label-layout";
import { referenceFinish } from "./reference-finishes";
import { hasReferenceFinishes } from "./hillstate-reference";
import {
  cameraPlanKey, cameraPose, initialCameraView, perspectiveSpan, resizeCameraView,
  type PlanCameraMemory,
} from "./camera-continuity";
import {
  roomColor,
  transformPoint,
  wallSolids,
  wallPoint,
  type Plan,
  type Point,
  type Transform,
} from "./plan";

type ViewControlsProps = {
  plan: Plan;
  transform: Transform;
  reset: number;
  zoom: number;
  onFailure: () => void;
  viewMemory: RefObject<PlanCameraMemory>;
  topView?: boolean;
};
function ViewControls({
  plan, transform, reset, zoom, onFailure, viewMemory, topView = false, flat,
}: ViewControlsProps & { flat: boolean }) {
  const { camera, gl, size, invalidate } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  const ready = useRef(false);
  const defaults = useMemo(
    () => initialCameraView(plan, transform, size.width, size.height),
    [plan, transform, size.width, size.height],
  );
  const key = cameraPlanKey(plan, transform);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableRotate = !flat;
    controls.screenSpacePanning = true;
    if (flat) {
      controls.mouseButtons.LEFT = MOUSE.PAN;
      controls.touches.ONE = TOUCH.PAN;
      controls.touches.TWO = TOUCH.DOLLY_PAN;
    } else controls.maxPolarAngle = Math.PI / 3;
    controlsRef.current = controls;
    ready.current = false;
    const changed = () => {
      const saved = viewMemory.current.view;
      if (ready.current && saved) {
        const delta = camera.position.clone().sub(controls.target);
        viewMemory.current.view = {
          ...saved,
          target: controls.target.toArray(),
          span: flat
            ? ((camera as OrthographicCamera).top - (camera as OrthographicCamera).bottom) / camera.zoom
            : perspectiveSpan(delta.length()),
          yaw: flat ? saved.yaw : Math.atan2(delta.x, delta.z),
          pitch: flat || saved.topView ? saved.pitch : Math.atan2(delta.y, Math.hypot(delta.x, delta.z)),
        };
      }
      invalidate();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      onFailure();
    };
    controls.addEventListener("change", changed);
    gl.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      ready.current = false;
      controls.removeEventListener("change", changed);
      controls.dispose();
      controlsRef.current = null;
      gl.domElement.removeEventListener("webglcontextlost", lost);
    };
  }, [camera, gl, invalidate, onFailure, flat, viewMemory]);
  /* eslint-disable react-hooks/immutability -- Three.js camera and orbit state are mutable renderer objects. */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const memory = viewMemory.current;
    const fresh = memory.key !== key || memory.reset !== reset || !memory.view;
    let view = fresh ? defaults : memory.view!;
    if (!fresh && (view.width !== size.width || view.height !== size.height))
      view = resizeCameraView(view, defaults);
    view = {
      ...view,
      span: view.span * view.zoom / zoom,
      zoom,
      topView,
    };
    const pose = cameraPose(view, flat);
    ready.current = false;
    camera.up.set(...pose.up);
    camera.position.set(...pose.position);
    camera.zoom = pose.zoom;
    controls.target.set(...view.target);
    if (flat) {
      const baseZoom = size.height / defaults.defaultSpan;
      controls.minZoom = baseZoom * 0.3;
      controls.maxZoom = baseZoom * 3.5;
    } else {
      const baseDistance = defaults.defaultSpan / perspectiveSpan(1);
      controls.minDistance = baseDistance * 0.285;
      controls.maxDistance = baseDistance * 3.5;
      (camera as PerspectiveCamera).fov = 42;
    }
    camera.updateProjectionMatrix();
    controls.update();
    memory.key = key;
    memory.reset = reset;
    memory.view = view;
    ready.current = true;
    invalidate();
  }, [camera, defaults, key, reset, zoom, topView, flat, size.width, size.height, invalidate, viewMemory]);
  /* eslint-enable react-hooks/immutability */
  return null;
}
function OverheadControls(props: ViewControlsProps) {
  return <ViewControls {...props} flat />;
}
function Controls(props: ViewControlsProps & { topView: boolean }) {
  return <ViewControls {...props} flat={false} />;
}
function Scene({
  plan,
  transform,
  selected,
  onSelect,
  labels,
  leaders,
  lowWalls,
  showRoute,
  flatView = false,
}: {
  plan: Plan;
  transform: Transform;
  selected: string;
  onSelect: (id: string) => void;
  labels: React.RefObject<(HTMLElement | null)[]>;
  leaders: React.RefObject<(SVGLineElement | null)[]>;
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
    const anchors: RoomLabelAnchor[] = [];
    const indexById = new Map<string,number>();
    plan.rooms.forEach((room, i) => {
      const el = labels.current[i];
      if (!el) return;
      el.style.setProperty("visibility","hidden");
      if (leaders.current[i]) leaders.current[i]!.style.setProperty("visibility","hidden");
      if (el.hidden) return;
      const p = pos(room.label);
      vector.current.set(p[0], detailed ? 1.15 : 0.12, p[2]).project(camera);
      if(vector.current.z < -1 || vector.current.z > 1) return;
      anchors.push({id:room.id, x:((vector.current.x+1)*size.width)/2,
        y:((-vector.current.y+1)*size.height)/2,
        width:el.offsetWidth,height:el.offsetHeight,
        priority:selected===room.id?100:room.name==="거실"?70:50});
      indexById.set(room.id,i);
    });
    const entryIndex=plan.rooms.length, entryEl=labels.current[entryIndex];
    if(entryEl){
      entryEl.style.setProperty("visibility","hidden");
      if(leaders.current[entryIndex])leaders.current[entryIndex]!.style.setProperty("visibility","hidden");
    }
    if (plan.entry && entryEl) {
      const p=pos(plan.entry.route[0]);
      vector.current.set(p[0],.25,p[2]).project(camera);
      if(vector.current.z>=-1 && vector.current.z<=1){
        anchors.push({id:"entry-pin",x:((vector.current.x+1)*size.width)/2,
          y:((-vector.current.y+1)*size.height)/2-entryEl.offsetHeight*.7,
          width:entryEl.offsetWidth,height:entryEl.offsetHeight+8,priority:selected?35:90});
        indexById.set("entry-pin",entryIndex);
      }
    }
    const originalById=new Map(anchors.map(a=>[a.id,a]));
    for(const placement of layoutRoomLabels(anchors,size.width,size.height)){
      const i=indexById.get(placement.id)!, el=labels.current[i]!;
      if(!placement.visible)continue;
      el.style.setProperty("transform",`translate(-50%, -50%) translate(${placement.x}px,${placement.y}px)`);
      el.style.setProperty("visibility","visible");
      el.setAttribute("data-shifted",String(placement.moved));
      const leader=leaders.current[i], anchor=originalById.get(placement.id)!;
      if(leader && placement.moved){
        leader.setAttribute("x1",String(anchor.x));leader.setAttribute("y1",String(anchor.y));
        leader.setAttribute("x2",String(placement.x));leader.setAttribute("y2",String(placement.y));
        leader.style.setProperty("visibility","visible");
      }
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
                    ? "#9fcdb9"
                    : selected
                      ? "#d2d8d4"
                    : detailed || interior
                      ? "#ffffff"
                      : roomColor(room)
                }
              />
            </mesh>
          ))}
          {detailed && <ReferenceFixtures onSelect={onSelect} />}
          {interior && plan.rooms.map(room => (
            <RoomContents key={room.id} dimmed={!!selected && selected!==room.id}
              onSelect={()=>onSelect(room.id)}>
              {interior.fixtures.filter(f=>f.roomId===room.id).map(f=><Fitting key={f.id} fixture={f} />)}
              <InteriorFurniture plan={plan} roomId={room.id} />
            </RoomContents>
          ))}
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
              p = wallPoint(w, o.offset + o.width / 2);
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
                  Math.atan2(w.end[1] - w.start[1], w.end[0] - w.start[0]),
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
  viewMemory: RefObject<PlanCameraMemory>;
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
  const labels = useRef<(HTMLElement | null)[]>([]);
  const leaders = useRef<(SVGLineElement | null)[]>([]);
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
            viewMemory={props.viewMemory}
            plan={props.plan}
            transform={props.transform}
            reset={props.reset}
            zoom={props.zoom}
            onFailure={props.onFailure}
          />
        ) : (
          <Controls
            viewMemory={props.viewMemory}
            plan={props.plan}
            transform={props.transform}
            reset={props.reset}
            zoom={props.zoom}
            onFailure={props.onFailure}
            topView={props.topView}
          />
        )}
        <Scene {...props} labels={labels} leaders={leaders} />
      </Canvas>
      <div className="structure-labels">
        <svg className="structure-label-leaders" aria-hidden="true">
          {[...props.plan.rooms.map(r=>r.id),"entry-pin"].map((id,i)=><line key={id}
            ref={el=>{leaders.current[i]=el;}} />)}
        </svg>
        {props.plan.rooms.map((r, i) => (
          <button
            type="button"
            key={r.id}
            aria-pressed={props.selected===r.id}
            onClick={()=>props.onSelect(r.id)}
            className={`${props.selected === r.id ? "is-selected" : props.selected ? "is-muted" : ""} ${r.id === props.plan.entry?.roomId ? "is-entrance" : ""}`}
            hidden={
              !props.showLabels ||
              (!!interior && /발코니/.test(r.name) && props.selected !== r.id) ||
              (r.id===props.plan.entry?.roomId && props.selected!==r.id)
            }
            ref={(el) => {
              labels.current[i] = el;
            }}
          >
            {r.name}
          </button>
        ))}
        {props.plan.entry && (
          <span
            className={`structure-entry-pin${props.selected && props.selected!==props.plan.entry.roomId ? " is-muted" : ""}`}
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
