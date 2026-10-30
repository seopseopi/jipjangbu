"""Read public KB building/type metadata; never assigns a household or uses login-only APIs.

Writes candidates under ignored output/research. Review identity and image availability
before copying metadata into the application. A building type list does not prove a
particular unit's orientation, extensions, or current internal alterations.
"""
import concurrent.futures
import json
import subprocess
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_API = 'https://api.kbland.kr/land-complex/complexComm/'


def read(path, params):
    url = PUBLIC_API + path + '?' + urllib.parse.urlencode(params)
    for attempt in range(2):
        try:
            response = subprocess.run(
                ['curl', '--fail', '--silent', '--show-error', '--max-time', '25', url],
                check=True, capture_output=True, text=True,
            )
            result = json.loads(response.stdout)
            body = result.get('dataBody', {})
            if body.get('resultCode') != 11000:
                raise ValueError(f'{path}: public metadata unavailable ({body.get("resultCode")})')
            return body['data'], url
        except (OSError, ValueError, subprocess.CalledProcessError):
            if attempt:
                raise
            time.sleep(0.5)


def collect(source):
    complex_id = int(source['sourceUrl'].rsplit('/', 1)[1])
    buildings, url = read('dongList', {'단지기본일련번호': complex_id})
    records = []
    for building in buildings:
        types, type_url = read('dongTypeList', {
            '단지기본일련번호': complex_id,
            '동일련번호': building['동일련번호'],
        })
        records.append({
            'dong': str(building['동명']),
            'sourceBuildingId': building['동일련번호'],
            'typeIds': [str(t['면적일련번호']) for t in types],
            'sourceUrl': type_url,
        })
    return {
        'alias': source['alias'], 'sourceUrl': source['sourceUrl'],
        'checkedAt': '2026-10-30', 'buildings': records,
        'scope': 'building-types-only',
    }


if __name__ == '__main__':
    sources = json.loads((ROOT / 'app/structures/apartment-sources.json').read_text())
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        jobs = {executor.submit(collect, source): source for source in sources}
        for future in concurrent.futures.as_completed(jobs):
            source = jobs[future]
            try:
                result = future.result()
                results.append(result)
                print(source['alias'], len(result['buildings']), flush=True)
            except Exception as error:
                print(source['alias'], type(error).__name__, str(error), flush=True)
    output = ROOT / 'output/research/apartment-building-type-candidates.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(sorted(results, key=lambda r: r['alias']), ensure_ascii=False, indent=2) + '\n')
    print(f'{len(results)}/{len(sources)} complexes. Candidates only: {output}')
