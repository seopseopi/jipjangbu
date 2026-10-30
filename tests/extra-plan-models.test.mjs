import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const hook=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&!s.endsWith('.ts')){try{return next(s+'.ts',c);}catch{/* Retain normal resolution for JSON and explicit extensions. */}}return next(s,c);}});
const {validatePlan}=await import('../app/structures/plan.ts');
const {bedPlacement,furnitureFits}=await import('../app/structures/furniture-layout.ts');
hook.deregister();
const read=n=>JSON.parse(readFileSync(new URL(`../app/structures/${n}.json`,import.meta.url)));
const extra=read('prepared-extra-plans'), originals=read('source-image-plans');
test('추가 34개 모델은 검토 원본 SHA·확장형 구분을 유지하고 실제 모델로 유효하다',()=>{
 assert.equal(extra.length,34);assert.equal(new Set(extra.map(p=>p.typeId)).size,34);
 for(const model of extra){
  const original=originals.find(p=>p.typeId===model.typeId);
  assert.ok(original);assert.equal(model.sha256,original.sha256);assert.equal(model.sourceImage,original.sourceImage);
  assert.equal(model.variant??'base',original.variant??'base');
  const plan=validatePlan(model.plan);assert.ok(!plan.isDemo&&!plan.referenceOnly);
  assert.ok(plan.rooms.some(r=>r.name==='거실'));assert.ok(plan.entry.route.length>=2);
 }
});
test('40개 타입의 예시 침대는 꺾인 방도 실제 방 다각형 안에 배치한다',()=>{
 for(const {plan} of [...read('prepared-plans'),...extra])
  for(const room of plan.rooms.filter(r=>/침실/.test(r.name))){
   const p=bedPlacement(room,room.name==='침실 1');
   if(p)assert.ok(furnitureFits(room,p.x,p.y,p.width+.24,p.depth+.24));
  }
 const room={polygon:[[0,0],[4,0],[4,4],[2.3,4],[2.3,2],[1.7,2],[1.7,4],[0,4]]};
 assert.equal(furnitureFits(room,2,2,3,3),false,'네 모서리 사이로 파인 부분도 감지');
});
