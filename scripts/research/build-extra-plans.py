"""Reproducible proportional models from individually reviewed source landmarks.
Original files are SHA pinned and never shipped in Git. Physical scale is an area-
calibrated approximation, not surveyed dimensions or an as-built unit assertion.
Requires Pillow, numpy and opencv-python-headless in a research-only environment.
"""
import copy, hashlib, heapq, importlib.util, json, math
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
TRACES=module('landmarks',Path(__file__).with_name('source-layout-traces.py')).TRACES
SOURCES=json.loads((ROOT/'app/structures/apartment-sources.json').read_text())
ORIGINALS=json.loads((ROOT/'app/structures/source-image-plans.json').read_text())
OLD=json.loads((ROOT/'app/structures/prepared-plans.json').read_text())

def poly(v):
 if isinstance(v[0],(int,float)):
  x,y,r,b=v;return [[x,y],[r,y],[r,b],[x,b]]
 return [list(p) for p in v]
def area(v):return abs(cv2.contourArea(np.array(poly(v),np.float32)))
def box(v):
 p=poly(v);return min(x for x,y in p),min(y for x,y in p),max(x for x,y in p),max(y for x,y in p)
def center(v):
 p=np.array(poly(v),np.float32);m=cv2.moments(p);c=[m['m10']/m['m00'],m['m01']/m['m00']]
 if cv2.pointPolygonTest(p,tuple(c),False)>=0:return c
 mask=np.zeros((450,600),np.uint8);cv2.fillPoly(mask,[p.astype(np.int32)],255);_,_,_,where=cv2.minMaxLoc(cv2.distanceTransform(mask,cv2.DIST_L2,5));return list(where)
def basis(p):
 return {'outline':p['outline'],'rooms':[[r['id'],r['name'],r['polygon']] for r in p['rooms']],
  'walls':[[w['id'],w['start'],w['end'],w['height'],w['thickness']] for w in p['walls']],
  'doors':[[o['id'],o['wallId'],o['offset'],o['width'],o['height'],o.get('hinge'),o.get('opensTo')] for o in p['doors']],
  'windows':[[o['id'],o['wallId'],o['offset'],o['width'],o['height'],o.get('sillHeight')] for o in p['windows']]}

def route(outline,walls,slots,start,end,cost_rooms):
 # In-source-pixel routing respects traced walls and door voids. Areas inside
 # bedrooms/wet rooms cost more so an available corridor is always preferred.
 step=3;mask=np.zeros((450,600),np.uint8);cv2.fillPoly(mask,[np.array(outline,np.int32)],255)
 for a,b in walls:cv2.line(mask,tuple(map(round,a)),tuple(map(round,b)),0,3)
 for a,b,kind,*_ in slots:
  if kind=='door':cv2.line(mask,tuple(map(round,a)),tuple(map(round,b)),255,7)
 cost=np.ones(mask.shape,np.float32)
 for p in cost_rooms:cv2.fillPoly(cost,[np.array(poly(p),np.int32)],12)
 small=cv2.resize(mask,(200,150),interpolation=cv2.INTER_NEAREST);weights=cv2.resize(cost,(200,150),interpolation=cv2.INTER_NEAREST)
 def snap(p):
  x,y=round(p[0]/step),round(p[1]/step)
  for radius in range(12):
   candidates=[(xx,yy) for yy in range(max(0,y-radius),min(150,y+radius+1)) for xx in range(max(0,x-radius),min(200,x+radius+1)) if small[yy,xx]]
   if candidates:return min(candidates,key=lambda q:(q[0]-x)**2+(q[1]-y)**2)
  raise ValueError('Route endpoint is not walkable')
 a,z=snap(start),snap(end);queue=[(0,a)];distance={a:0};parent={}
 while queue:
  _,u=heapq.heappop(queue)
  if u==z:break
  for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]:
   v=(u[0]+dx,u[1]+dy)
   if not(0<=v[0]<200 and 0<=v[1]<150) or not small[v[1],v[0]]:continue
   d=distance[u]+float(weights[v[1],v[0]])
   if d<distance.get(v,math.inf):distance[v]=d;parent[v]=u;heapq.heappush(queue,(d+abs(v[0]-z[0])+abs(v[1]-z[1]),v))
 if z not in distance:raise ValueError('No corridor route between entry and living room')
 points=[z]
 while points[-1]!=a:points.append(parent[points[-1]])
 points=np.array([[x*step,y*step] for x,y in points[::-1]],np.float32)
 result=cv2.approxPolyDP(points,1.7,False).reshape(-1,2).tolist()
 # Avoid long path arrays; orthogonal runs are already reduced above.
 if len(result)>30:raise ValueError(f'Route too complex: {len(result)} points')
 return result

def build(type_id):
 raw=copy.deepcopy(TRACES[type_id]);original=next(m for m in ORIGINALS if m['typeId']==type_id)
 if 'copyOf' in raw:
  old=next(m for m in OLD if m['typeId']==raw['copyOf']);return {**original,'plan':copy.deepcopy(old['plan'])},None,None
 if 'clone' in raw:raw={**copy.deepcopy(TRACES[raw.pop('clone')]),**raw}
 t=next(t for s in SOURCES for t in s['types'] if t['id']==type_id)
 outline=poly(raw['outline']);x,y,r,b=box(outline)
 interior_area=area(outline)-sum(area(v) for v in raw.get('balconies',[]))
 scale=math.sqrt(float(t['exclusiveArea'] or t['supplyArea'])/interior_area)
 point=lambda p:[round((p[0]-x)*scale,4),round((b-p[1])*scale,4)]
 plan={'schemaVersion':1,'isDemo':False,'scaleStatus':'proportional',
  'coordinateSystem':{'unit':'m','pivot':[round((r-x)*scale/2,4),round((b-y)*scale/2,4)]},
  'dimensionEvidence':{'note':'타입 원본의 방·벽·문·설비 위치를 개별 대조한 비례 재구성. 전용면적과 원본 윤곽으로 축척을 개략 보정했으며 치수·벽 두께·층고·가구·마감은 실측 전 예시. 실제 세대 타입·방향·확장·리모델링은 별도 확인.'},
  'outline':list(map(point,outline)),'rooms':[],'walls':[],'doors':[],'windows':[]}
 rooms=[];segments=[];slots=[]
 def add_room(name,v,closed=False,door=None):
  p=poly(v);rid=f'trace-room-{len(rooms)}';rooms.append((rid,name,p));plan['rooms'].append({'id':rid,'name':name,'polygon':list(map(point,p)),'label':point(center(p))})
  if closed:
   segments.extend((p[i],p[(i+1)%len(p)]) for i in range(len(p)))
  if door:
   side,fraction=door;l,top,right,bottom=box(v);span=(right-l) if side in ['top','bottom'] else (bottom-top);width=min(25,span*.5);middle=max(width/2+2,min(span-width/2-2,span*fraction))
   if side in ['top','bottom']:
    yy=top if side=='top' else bottom;a=[l+middle-width/2,yy];z=[l+middle+width/2,yy];opens='right' if side=='top' else 'left'
   else:
    xx=l if side=='left' else right;a=[xx,top+middle-width/2];z=[xx,top+middle+width/2];opens='left' if side=='left' else 'right'
   slots.append((a,z,'door',rid,opens))
  return rid
 living_id=add_room('거실',raw['living']);kitchen_id=add_room('주방',raw['kitchen']);entry_id=add_room('현관',raw['entry'])
 for i,(v,side,fraction) in enumerate(raw['beds']):add_room(f'침실 {i+1}',v,True,(side,fraction))
 baths=[]
 for i,item in enumerate(raw['baths']):
  v,side,fraction,pattern,*fbox=item;rid=add_room(f'욕실 {i+1}',v,True,(side,fraction));baths.append((rid,fbox[0] if fbox else v,pattern))
 for v in raw.get('balconies',[]):add_room('발코니',v)
 for v in raw.get('dress',[]):add_room('드레스룸',v)
 for v in raw.get('alpha',[]):add_room('알파룸',v)
 for name,v in raw.get('extra',[]):add_room(name,v)
 segments.extend((outline[i],outline[(i+1)%len(outline)]) for i in range(len(outline)))
 for a,b_,c,d in raw['windows']:
  segments.append(([a,b_],[c,d]));slots.append(([a,b_],[c,d],'window',None,None))
 a,b_,c,d=raw['door'];slots.append(([a,b_],[c,d],'main',entry_id,'left'))
 for a,b_,c,d in raw.get('extraDoors',[]):slots.append(([a,b_],[c,d],'door',None,'left'))
 # Merge exact collinear, touching room edges before cutting voids. This prevents
 # a shared wall's duplicate span from sealing a doorway in the neighbouring room.
 lines={};diagonals=[]
 for a,z in segments:
  if a==z:continue
  if abs(a[1]-z[1])<.01:key=('h',a[1]);lo,hi=sorted([a[0],z[0]])
  elif abs(a[0]-z[0])<.01:key=('v',a[0]);lo,hi=sorted([a[1],z[1]])
  else:diagonals.append((a,z));continue
  lines.setdefault(key,[]).append((lo,hi))
 merged=[]
 for (direction,fixed),intervals in sorted(lines.items()):
  spans=[]
  for lo,hi in sorted(intervals):
   if spans and lo<=spans[-1][1]+.1:spans[-1][1]=max(spans[-1][1],hi)
   else:spans.append([lo,hi])
  for lo,hi in spans:merged.append(([lo,fixed],[hi,fixed]) if direction=='h' else ([fixed,lo],[fixed,hi]))
 merged+=diagonals
 for i,(a,z) in enumerate(merged):plan['walls'].append({'id':f'trace-wall-{i}','start':point(a),'end':point(z),'thickness':.11,'height':2.4})
 for i,(a,z,kind,rid,opens) in enumerate(slots):
  midpoint=np.array([(a[0]+z[0])/2,(a[1]+z[1])/2]);length=math.dist(a,z);matches=[]
  for j,(start,end) in enumerate(merged):
   start=np.array(start,np.float64);v=np.array(end)-start;ln=np.linalg.norm(v);along=float(np.dot(midpoint-start,v)/ln);q=midpoint-start;dist=abs(float(v[0]*q[1]-v[1]*q[0]))/ln
   if dist<2.5 and length/2-.1<=along<=ln-length/2+.1:matches.append((dist,j,along,ln))
  if not matches:raise ValueError(f'{type_id}: opening without a source wall: {kind} {a} {z}')
  _,j,along,ln=min(matches);wid=f'trace-wall-{j}';oid='main-door' if kind=='main' else f'trace-{kind}-{i}'
  opening={'id':oid,'wallId':wid,'offset':round(max(0,along-length/2)*scale,4),'width':round(length*scale,4),'height':2.05 if kind in ['door','main'] else 1.9,'sillHeight':0 if kind in ['door','main'] else .1}
  wall=plan['walls'][j];wall_length=math.dist(wall['start'],wall['end']);opening['width']=math.floor(min(opening['width'],wall_length-opening['offset'])*10000)/10000
  if kind in ['door','main']:opening.update(hinge='start',opensTo=opens);plan['doors'].append(opening)
  else:plan['windows'].append(opening)
 # Main/room doors can describe the same observed gap. Keep a single opening.
 seen=[]
 for group in ['doors','windows']:
  filtered=[]
  for o in sorted(plan[group],key=lambda o:(o['id']!='main-door',o['wallId'],o['offset'])):
   collision=next((q for q in seen if q['wallId']==o['wallId'] and max(q['offset'],o['offset'])<min(q['offset']+q['width'],o['offset']+o['width'])-.002),None)
   if collision:
    if abs(collision['offset']-o['offset'])<.05 and abs(collision['width']-o['width'])<.05:continue
    raise ValueError(f'{type_id}: overlapping observed openings {collision["id"]}, {o["id"]}')
   seen.append(o);filtered.append(o)
  plan[group]=filtered
 routing_slots=[(a,z,'door' if kind in ['main','door'] else 'window',rid,opens) for a,z,kind,rid,opens in slots]
 path=route(outline,merged,routing_slots,center(raw['entry']),center(raw['living']),[item[0] for item in raw['beds']]+[item[0] for item in raw['baths']])
 plan['entry']={'doorId':'main-door','roomId':entry_id,'route':list(map(point,path)),'note':'원본의 현관과 거실을 잇는 타입 기준 동선. 실제 세대 방향·통행 폭은 미확인.'}
 fixtures=[]
 def fitting(kind,v,room_id):
  l,top,right,bottom=v;w=(right-l)*scale;depth=(bottom-top)*scale
  fixtures.append({'id':f'trace-fitting-{type_id}-{len(fixtures)}','kind':kind,'roomId':room_id,'center':point([(l+right)/2,(top+bottom)/2]),'width':round(w,4),'depth':round(depth,4),'rotation':0})
 for v in raw['counters']:fitting('counter',v,kitchen_id)
 fitting('sink',raw['sink'],kitchen_id);fitting('cooktop',raw['cooktop'],kitchen_id)
 for rid,v,pattern in baths:
  l,top,right,bottom=box(v);w=right-l;h=bottom-top
  def relative(kind,cx,cy,ww,hh):fitting(kind,[l+(cx-ww/2)*w,top+(cy-hh/2)*h,l+(cx+ww/2)*w,top+(cy+hh/2)*h],rid)
  side=1 if pattern.endswith('R') else -1
  if pattern.startswith('t'):
   relative('tub',.5,.15,.82,.22);relative('basin',.5+side*.25,.46,.3,.2);relative('toilet',.5+side*.25,.78,.3,.29)
  elif pattern.startswith('b'):
   relative('tub',.5,.85,.82,.22);relative('basin',.5+side*.25,.45,.3,.2);relative('toilet',.5+side*.25,.2,.3,.29)
  elif pattern.startswith(('l','r')):
   tub_right=pattern.startswith('r');relative('tub',.85 if tub_right else .15,.5,.22,.82)
   if w>=h:
    relative('basin',.48 if tub_right else .62,.77,.23,.28);relative('toilet',.2 if tub_right else .84,.75,.23,.39)
   else:
    xx=.24 if tub_right else .76;relative('basin',xx,.39,.3,.2);relative('toilet',xx,.76,.3,.29)
  elif pattern=='nT':relative('basin',.74,.22,.24,.3);relative('toilet',.27,.5,.24,.48)
  elif pattern=='nB':relative('basin',.53,.73,.24,.3);relative('toilet',.83,.61,.24,.4)
  else:relative('basin',.5+side*.25,.3,.3,.22);relative('toilet',.5+side*.25,.74,.3,.32)
 model={**original,'plan':plan}
 # Crop only the traced household footprint, leaving source text/dimensions in
 # the immutable original available from the existing original-view disclosure.
 im=Image.open(ROOT/f'output/research/models/{type_id}.jpg');ih=im.height*600/im.width
 model['crop']={'x':max(0,x-5)/600,'y':max(0,y-5)/ih,'width':(min(600,r+5)-max(0,x-5))/600,'height':(min(ih,b+5)-max(0,y-5))/ih}
 if hashlib.sha256((ROOT/f'output/research/models/{type_id}.jpg').read_bytes()).hexdigest()!=original['sha256']:raise ValueError('Original digest changed')
 return model,{'basis':basis(plan),'fixtures':fixtures},(raw,merged,slots)

if __name__=='__main__':
 models=[];catalogs=[];errors=[];debug=ROOT/'output/research/model-review';debug.mkdir(exist_ok=True)
 for tid in TRACES:
  try:model,catalog,draft=build(tid)
  except Exception as error:errors.append((tid,str(error)));print("ERROR",tid,str(error),flush=True);continue
  models.append(model)
  if catalog:catalogs.append(catalog)
  if draft:
   raw,walls,slots=draft;im=Image.open(ROOT/f'output/research/models/{tid}.jpg').convert('RGB');im=im.resize((600,round(im.height*600/im.width)));draw=ImageDraw.Draw(im,'RGBA')
   for a,z in walls:draw.line([tuple(a),tuple(z)],fill=(210,30,30,190),width=2)
   for a,z,kind,*_ in slots:draw.line([tuple(a),tuple(z)],fill=(0,160,70,255) if kind in ['door','main'] else (0,90,220,255),width=4)
   im.save(debug/f'{tid}.jpg')
  print(tid,len(model['plan']['rooms']),len(model['plan']['walls']),flush=True)
 if errors:raise SystemExit(f'{len(errors)} source traces need correction: {errors}')
 (ROOT/'app/structures/prepared-extra-plans.json').write_text(json.dumps(models,ensure_ascii=False,separators=(',',':'))+'\n')
 (ROOT/'app/structures/interior-extra-details.json').write_text(json.dumps(catalogs,ensure_ascii=False,separators=(',',':'))+'\n')
 print(len(models),'models;',len(catalogs),'interior catalogs')
