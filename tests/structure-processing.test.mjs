import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const hook=registerHooks({resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.includes('/app/structures/')){const u=new URL(s,c.parentURL);if(existsSync(u.pathname+'.ts'))return {url:u.href+'.ts',shortCircuit:true};}return next(s,c);}});
const {tracePlan,validateProcessing,FULL_CROP}=await import('../app/structures/processing.ts');
test.after(()=>hook.deregister());
test('원본 영역과 페이지는 정규화 범위를 벗어나지 않는다',()=>{
 assert.deepEqual(validateProcessing({page:7,crop:FULL_CROP,plan:null,note:'원본 7쪽 평면도'}).crop,FULL_CROP);
 for(const crop of [{x:-.1,y:0,width:1,height:1},{x:.5,y:0,width:.6,height:1},{x:0,y:0,width:NaN,height:1}])assert.throws(()=>validateProcessing({page:1,crop,plan:null,note:'test'}));
 assert.throws(()=>validateProcessing({page:501,crop:FULL_CROP,plan:null,note:'test'}));
});
test('추적한 외곽·방을 같은 좌표계의 2D·3D 구조로 생성하며 문창을 추측하지 않는다',()=>{
 const outline=[[0,0],[1,0],[1,1],[0,1]], rooms=[{name:'거실',polygon:outline}];
 const p=tracePlan(outline,rooms,12,.7,2.4);
 assert.deepEqual(p.outline,[[0,0],[12,0],[12,8.4],[0,8.4]]);assert.equal(p.walls.length,4);
 assert.equal(p.scaleStatus,'proportional');assert.equal(p.isDemo,false);assert.deepEqual(p.doors,[]);assert.deepEqual(p.windows,[]);
 assert.equal(p.walls[0].height,2.4);
 assert.throws(()=>tracePlan(outline,[{name:'잘못된방',polygon:[[0,0],[2,0],[2,2],[0,2]]}],12,.7,2.4));
 assert.throws(()=>tracePlan(outline,rooms,-1,.7,2.4));
});
const {APARTMENT_SOURCES,sourceTypeCandidates,sourceImageUrl}=await import('../app/structures/source-contract.ts');
test('관리 30곳의 출처를 포함하며 타지역·동명이인 도면을 연결하지 않는다',()=>{
 assert.equal(new Set(APARTMENT_SOURCES.map(s=>s.alias)).size,30);
 assert.ok(APARTMENT_SOURCES.every(s=>s.address.startsWith('인천광역시')));
 assert.equal(APARTMENT_SOURCES.find(s=>s.alias==='금호어울림').name,'검단금호어울림');
 const hill=APARTMENT_SOURCES.find(s=>s.alias==='힐스테이트1차');
 assert.equal(sourceTypeCandidates(hill,'33','107').length,1);
 assert.equal(sourceTypeCandidates(hill,'51A','101').length,0);
 const future=APARTMENT_SOURCES.find(s=>s.alias==='미래지향');assert.equal(sourceTypeCandidates(future,'34','201').length,0);
 assert.equal(sourceImageUrl('https://evil.invalid','x','base'),null);
 assert.equal(sourceImageUrl('힐스테이트1차','x','base'),null);
 assert.ok(sourceImageUrl('힐스테이트1차',hill.types[0].id,'base').startsWith('https://file.kbland.kr/image/'));
});
test('영역 편집은 메모 없이 저장 가능하고 방 이름은 벽에서 떨어진 곳에 둔다',async()=>{
 const {roomLabelPoint}=await import('../app/structures/processing.ts');
 assert.equal(validateProcessing({page:1,crop:FULL_CROP,plan:null}).note,'');
 assert.deepEqual(roomLabelPoint([[0,0],[4,0],[4,3],[0,3]]),[2,1.5]);
});
