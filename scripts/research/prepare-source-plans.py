"""Pin original plan images needed by the entire journal (including closed listings).
No geometry is invented: types without reviewed geometry remain original 2D only.
Public bitmaps stay in ignored output/research; only SHA and crop metadata is shipped.
Run with Pillow installed. Review the generated contact sheets before trimming.
"""
import concurrent.futures
import hashlib
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/research'
sources = json.loads((ROOT / 'app/structures/apartment-sources.json').read_text())
rows = json.loads((OUT / 'all-connection-candidates.json').read_text())
needed = {r['candidates'][0]['id'] for r in rows if len(r['candidates']) == 1}
types = [t for s in sources for t in s['types'] if t['id'] in needed and (t['basicImage'] or t['expandedImage'])]
(OUT / 'models').mkdir(parents=True, exist_ok=True)

def prepare(t):
    url = t['basicImage'] or t['expandedImage']
    variant = 'base' if t['basicImage'] else 'expanded'
    path = OUT / 'models' / (t['id'] + '.jpg')
    if not path.exists():
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '30', url, '-o', str(path)], check=True)
    im = Image.open(path).convert('RGB')
    # Conservative whitespace trim. Internal labels/dimensions are never removed
    # automatically; reviewed crops may be supplied separately after inspection.
    mask = ImageChops.difference(im, Image.new('RGB', im.size, 'white')).convert('L').point(lambda n: 255 if n > 28 else 0)
    x, y, r, b = mask.getbbox()
    x, y, r, b = max(0, x-5), max(0, y-5), min(im.width, r+5), min(im.height, b+5)
    return {'typeId': t['id'], 'sourceImage': url, 'variant': variant, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'crop': {'x': x/im.width, 'y': y/im.height, 'width': (r-x)/im.width, 'height': (b-y)/im.height}, 'plan': None}

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    models = sorted(pool.map(prepare, types), key=lambda m: m['typeId'])
(ROOT / 'app/structures/source-image-plans.json').write_text(json.dumps(models, ensure_ascii=False, separators=(',', ':')) + '\n')
for start in range(0, len(models), 12):
    sheet = Image.new('RGB', (1600, 1320), 'white'); draw = ImageDraw.Draw(sheet)
    for i, model in enumerate(models[start:start+12]):
        im = Image.open(OUT / 'models' / (model['typeId']+'.jpg')).convert('RGB'); im.thumbnail((390, 400))
        x, y = (i%4)*400, (i//4)*440
        sheet.paste(im, (x+(400-im.width)//2, y+30))
        draw.text((x+8, y+6), model['typeId'], fill='black')
    sheet.save(OUT / f'plan-review-{start//12}.jpg')
print(len(models), 'pinned original plan types')
