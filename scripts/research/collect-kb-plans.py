"""Refresh public KB page metadata only; never infers units or downloads originals.
Run manually: python3 scripts/research/collect-kb-plans.py
"""
import concurrent.futures, json, re, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SOURCES={
 '우방2차':32856,
 '힐스테이트2차':22161,'힐스테이트4차':23229,'미래지향':36225,
 '아이파크1차':14728,'힐스테이트1차':14727,'아이파크2차':21980,
 '모아미래도엘리트파크':47273,'대림e편한':14890,'현대':7607,'우방1차':31187,
 '검단피오레':14729,'동아':7611,'당하풍림3차':12996,'마전풍림3차':13579,
 '검암풍림3차':12755,'영남탑스빌':7614,'마전하나':7612,'삼라마이다스':14979,
 '마전동남':7613,'영진':7606,'양우내안에':383097,'검단풍림2차':13184,
 '오류힐스테이트2차':22292,'당하KCC':13341,
 '금호어울림':12659,'우림필유':14730,'유호':7605,
 '드림파크어울림1단지':22059,'우방3차(검단오류)':43424}

def collect(item):
 alias,kb=item; url=f'https://kbland.kr/se/c/{kb}'
 raw=subprocess.run(['curl','--fail','-L','-sS','--max-time','30',url],check=True,capture_output=True,text=True).stdout
 chunks=[]
 for m in re.finditer(r'self\.__next_f\.push\((\[.*?\])\)</script>',raw):
  try:
   x=json.loads(m[1])
   if len(x)>1 and isinstance(x[1],str): chunks.append(x[1])
  except (ValueError,IndexError): pass
 text=''.join(chunks);decoder=json.JSONDecoder();types={};base={}
 # Read only data explicitly serialized on the public page.
 for m in re.finditer(r'\{',text):
  if text[m.start()+1:m.start()+30].find('단지기본일련번호')<0:continue
  try:obj,_=decoder.raw_decode(text[m.start():])
  except ValueError:continue
  if not isinstance(obj,dict):continue
  if obj.get('단지기본일련번호') != kb: continue
  if '도로기본주소' in obj:base=obj
  if '기본평면도이미지파일명' not in obj:continue
  basic=obj.get('기본평면도이미지파일명','');extended=obj.get('확장형평면도이미지파일명','')
  def image(path,file):
   full=(obj.get('이미지도메인URL') or '')+(obj.get(path) or '')+file
   return full if file and full.startswith('https://file.kbland.kr/') else None
  record={'id':str(obj['면적일련번호']),'label':obj['공급면적']+obj.get('주택형타입내용','')+'㎡',
   'supplyArea':obj['공급면적'],'exclusiveArea':obj.get('전용면적'),
   'rooms':obj.get('방수'),'bathrooms':obj.get('욕실수'),'households':obj.get('세대수'),
   'basicImage':image('기본컨텐츠경로',basic),'expandedImage':image('확장컨텐츠경로',extended),
   'sourceUrl':url}
  types[record['id']]=record
 if not base:
  # Base object does not always start with the ID field.
  for m in re.finditer(r'\{[^{}]*"도로기본주소"[^{}]*\}',text):
   try:
    candidate=json.loads(m[0])
    if candidate.get('단지기본일련번호')==kb:base=candidate;break
   except ValueError:pass
 if not base or not types: raise ValueError(f'{alias}: public page metadata missing')
 related=[]
 for m in re.finditer(r'\{[^{}]*"도로기본주소"[^{}]*\}',text):
  try:
   candidate=json.loads(m[0]);related.append({k:candidate.get(k) for k in ['단지기본일련번호','단지명','도로기본주소','도로명건물본번']})
  except ValueError:pass
 cache=ROOT/'output/research';cache.mkdir(parents=True,exist_ok=True);(cache/f'kb-{kb}-related.json').write_text(json.dumps(related,ensure_ascii=False))
 address=base.get('신주소') or ((base['도로기본주소']+' '+str(base.get('도로명건물본번',''))+('-'+str(base.get('도로명건물부번')) if base.get('도로명건물부번') not in ['0',0,None] else '')) if base.get('도로기본주소') else base.get('구주소',''))
 if not address.startswith('인천광역시'):raise ValueError(f'{alias}: unexpected location {address}')
 return {'alias':alias,'name':base.get('단지명',alias),'address':address,'sourceUrl':url,'checkedAt':'2026-10-30','types':list(types.values()),'status':'candidate','note':'공개 단지·타입 자료. 세대별 타입·확장 여부는 미확인.'}
if __name__=='__main__':
 records=[]
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  for r in pool.map(collect,SOURCES.items()):
   records.append(r);print(r['alias'],r['name'],r['address'],len(r['types']),sum(bool(t['basicImage']) for t in r['types']),flush=True)
 path=ROOT/'app/structures/apartment-sources.json'
 if path.exists():
  old=json.loads(path.read_text());records += [r for r in old if r['alias'] not in SOURCES]
 output=ROOT/'output/research/apartment-source-candidates.json';output.parent.mkdir(parents=True,exist_ok=True)
 output.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
 print('Candidates only; compare addresses, image GET availability and journal dongs before updating app/structures/apartment-sources.json.')
