import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initialCameraView, cameraPlanKey, cameraPose, resizeCameraView, CAMERA_FOV } from '../app/structures/camera-continuity.ts';
import { transformPoint } from '../app/structures/plan.ts';
const models=['prepared-plans','prepared-extra-plans'].flatMap(name=>JSON.parse(readFileSync(new URL(`../app/structures/${name}.json`,import.meta.url))));
function projectedCamera(view,flat){
 const pose=cameraPose(view,flat),w=view.width,h=view.height;
 const camera=flat?new OrthographicCamera(-w/2,w/2,h/2,-h/2,.1,200):new PerspectiveCamera(CAMERA_FOV,w/h,.1,200);
 camera.position.set(12,14,12);
 const controls=new OrbitControls(camera,null);controls.enableRotate=!flat;if(!flat)controls.maxPolarAngle=Math.PI/3;
 camera.up.set(...pose.up);camera.position.set(...pose.position);camera.zoom=pose.zoom;
 controls.target.set(...view.target);camera.updateProjectionMatrix();controls.update();camera.updateMatrixWorld();return camera;
}
test('같은 추천 방향과 축척으로 40개 타입의 2D·3D 전체 외곽을 가로·세로 화면에 맞춘다',()=>{
 for(const {plan} of models)for(const [width,height] of [[1600,900],[390,700],[900,320]])
  for(const rotation of [0,90,180,270])for(const mirror of [false,true]){
   const transform={rotation,mirror},view=initialCameraView(plan,transform,width,height);
   const [px,py]=plan.coordinateSystem.pivot;
   for(const flat of [true,false]){
    const camera=projectedCamera(view,flat);
    for(const p of plan.outline)for(const y of flat?[0]:[0,Math.max(...plan.walls.map(w=>w.height))]){
     const [x,z]=transformPoint(p,[px,py],transform),screen=new Vector3(x-px,y,py-z).project(camera);
     assert.ok(Math.abs(screen.x)<1&&Math.abs(screen.y)<1&&screen.z<1,`${plan.rooms.length} rooms ${width}x${height} ${flat}: ${screen.toArray()}`);
    }
   }
  }
});
test('사용자가 회전·확대·이동한 중심과 화면상 가로 축척은 2D↔3D 전환에도 이어진다',()=>{
 const base=initialCameraView(models[0].plan,{rotation:0,mirror:false},1200,760);
 for(const yaw of [0,.7,2.8,-1.2])for(const magnification of [.7,1,2.4]){
  const view={...base,yaw,pitch:.8,target:[3,.45,-2],span:base.span/magnification};
  const flat=projectedCamera(view,true),orbit=projectedCamera(view,false),right=new Vector3(Math.cos(yaw),0,-Math.sin(yaw));
  const center=new Vector3(...view.target),point=center.clone().add(right);
  const a=point.clone().project(flat),b=point.clone().project(orbit);
  assert.ok(Math.abs(a.x-b.x)<1e-8);assert.ok(Math.abs(a.y-b.y)<1e-8);
  for(const camera of [flat,orbit])assert.ok(center.clone().project(camera).length()<1.01,'target remains centered and in front');
 }
});
test('화면 크기를 바꿀 때 상대 확대를 유지하고 다른 도면·반전은 오래된 시점을 구분한다',()=>{
 const plan=models[0].plan,transform={rotation:0,mirror:false};
 const base=initialCameraView(plan,transform,1200,760),narrow=initialCameraView(plan,transform,390,700);
 const user={...base,target:[4,.45,-3],yaw:1.7,span:base.span/2.2};
 const resized=resizeCameraView(user,narrow);
 assert.ok(Math.abs(resized.span/resized.defaultSpan-1/2.2)<1e-12);
 assert.deepEqual(resized.target,user.target);assert.equal(resized.yaw,user.yaw);
 assert.notEqual(cameraPlanKey(plan,transform),cameraPlanKey(plan,{rotation:0,mirror:true}));
 const other=models.find(m=>cameraPlanKey(m.plan,transform)!==cameraPlanKey(plan,transform));
 assert.ok(other);assert.notEqual(cameraPlanKey(plan,transform),cameraPlanKey(other.plan,transform));
});
