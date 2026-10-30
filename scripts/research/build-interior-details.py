"""Source-visible fittings for the four reviewed plan geometries.
Fixtures are traced from original pixels. Heights/finishes and movable furnishings
are illustrative. Only exact reviewed geometry receives these details.
"""
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('traces',Path(__file__).with_name('build-reviewed-plans.py'))
traces=importlib.util.module_from_spec(spec);spec.loader.exec_module(traces)
MODELS=json.loads((ROOT/'app/structures/prepared-plans.json').read_text())
# kind, center x/y, footprint width/depth, rotation. All positions come from the
# corresponding source image, not generic placement by room name.
FITTINGS={
 'three':[
  ['tub',233,187,62,23,0],['basin',212,217,22,22,90],['toilet',220,256,32,23,90],
  ['tub',630,210,62,23,0],['basin',652,239,22,22,-90],['toilet',648,275,32,23,-90],
  ['counter',455,154,62,34,0],['counter',502,232,33,123,-90],
  ['sink',447,154,28,25,0],['cooktop',502,264,23,34,90]],
 'large':[
  ['tub',246,209,64,22,0],['basin',223,242,22,22,90],['toilet',223,276,23,30,90],
  ['tub',731,187,64,20,0],['basin',752,219,22,22,-90],['toilet',750,268,23,30,-90],
  ['counter',415,150,118,30,0],['counter',371,227,29,124,90],
  ['sink',413,151,46,27,0],['cooktop',371,257,23,38,90]],
 'four':[
  ['tub',101,112,49,21,0],['basin',85,140,16,17,90],['toilet',85,171,16,20,90],
  ['basin',480,163,15,17,-90],['toilet',480,184,15,20,-90],
  ['counter',367,126,18,53,-90],['counter',331,153,91,18,0],
  ['sink',367,125,13,24,90],['cooktop',331,153,29,14,0]],
 'small':[
  ['tub',310,220,63,20,0],['basin',288,251,22,22,90],['toilet',287,291,22,28,90],
  ['basin',669,296,22,22,0],['toilet',627,296,24,30,180],
  ['counter',443,221,34,154,90],['counter',468,296,82,34,0],
  ['sink',487,297,40,26,0],['cooktop',443,184,24,35,90]],
}

def basis(plan):
 return {'outline':plan['outline'],'rooms':[[r['id'],r['name'],r['polygon']] for r in plan['rooms']],
         'walls':[[w['id'],w['start'],w['end'],w['height'],w['thickness']] for w in plan['walls']],
         'doors':[[o['id'],o['wallId'],o['offset'],o['width'],o['height'],o.get('hinge'),o.get('opensTo')] for o in plan['doors']],
         'windows':[[o['id'],o['wallId'],o['offset'],o['width'],o['height'],o.get('sillHeight')] for o in plan['windows']]}

result=[];seen=set()
for model in MODELS:
 family=traces.TYPES[model['typeId']][0]
 if family in seen:continue
 seen.add(family);f=traces.FAMILIES[family];x,y,r,b=f['bounds'];sx=f['width']/(r-x);sy=f['depth']/(b-y)
 fittings=[]
 for i,(kind,px,py,w,d,rotation) in enumerate(FITTINGS[family]):
  center=[round((px-x)*sx,4),round((b-py)*sy,4)]
  # Match the source role to a containing room (counter footprints can straddle
  # room fill polygons at a wall). Never infer a bathtub in an unmarked wet area.
  role='주방' if kind in ['counter','sink','cooktop'] else '욕실'
  rooms=[r for r in model['plan']['rooms'] if role in r['name']]
  room=min(rooms,key=lambda r:(r['label'][0]-center[0])**2+(r['label'][1]-center[1])**2)
  width,depth=w*sx,d*sy
  if abs(rotation)%180==90:width,depth=depth,width
  fittings.append({'id':f'{family}-{i}','roomId':room['id'],'kind':kind,'center':center,'width':round(width,4),'depth':round(depth,4),'rotation':rotation})
 result.append({'basis':basis(model['plan']),'fixtures':fittings})
(ROOT/'app/structures/interior-details.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
print(len(result),'exact-geometry fitting catalogs')
