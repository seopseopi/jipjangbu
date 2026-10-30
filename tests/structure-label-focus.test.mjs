import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Mesh, MeshStandardMaterial, BoxGeometry } from 'three';
import { layoutRoomLabels } from '../app/structures/label-layout.ts';
import { muteRoomMaterials } from '../app/structures/room-focus.ts';
const overlap=(a,b)=>Math.abs(a.x-b.x)<(a.width+b.width)/2+4.99 && Math.abs(a.y-b.y)<(a.height+b.height)/2+4.99;
test('밀집한 방 이름은 가로·세로 화면에서 서로 겹치거나 화면 밖에 놓이지 않는다',()=>{
 for(const [width,height] of [[390,240],[900,320],[320,650],[1600,900]]){
  const items=Array.from({length:25},(_,i)=>({id:String(i),x:width/2+i%3,y:height/2+i%2,width:i%2?72:96,height:32,priority:i===0?100:50}));
  const result=layoutRoomLabels(items,width,height), visible=result.filter(p=>p.visible);
  assert.ok(result.find(p=>p.id==='0').visible);
  for(const p of visible){assert.ok(p.x-p.width/2>=8&&p.x+p.width/2<=width-8);assert.ok(p.y-p.height/2>=8&&p.y+p.height/2<=height-8);}
  visible.forEach((p,i)=>visible.slice(i+1).forEach(q=>assert.ok(!overlap(p,q))));
  assert.deepEqual(result,layoutRoomLabels([...items].reverse(),width,height));
 }
});
test('화면에 들어갈 수 없는 라벨은 숨기며 이동 여부를 표시한다',()=>{
 const result=layoutRoomLabels([{id:'selected',x:2,y:2,width:50,height:20,priority:100},{id:'oversize',x:20,y:20,width:400,height:20,priority:0}],200,200);
 assert.equal(result[0].visible,true);assert.equal(result[0].moved,true);assert.equal(result[1].visible,false);
});
test('방 강조는 공유 원본 재질을 훼손하지 않고 선택 해제 시 복구한다',()=>{
 const material=new MeshStandardMaterial({color:'#bbaacc'}), geometry=new BoxGeometry();
 const group=new Group(),a=new Mesh(geometry,material),outside=new Mesh(geometry,material);
 group.add(a);const before=material.color.getHex();
 const restore=muteRoomMaterials(group);
 assert.notEqual(a.material,material);assert.equal(outside.material,material);assert.equal(material.opacity,1);assert.equal(material.color.getHex(),before);assert.ok(a.material.opacity<.3);
 restore();assert.equal(a.material,material);geometry.dispose();material.dispose();
});
