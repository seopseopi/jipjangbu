# 집장부 화면 캡처·로고

[서비스 소개](../../README.md) · [문서 모음](../README.md)

## 화면 갤러리

아래 파일은 합성 자료로 수행했던 실제 앱 검증의 캡처를 **편집 없이 복사**한 것입니다. 고객·매물·내용을 임의로 덧씌운 화면 모형이 아닙니다. 2026-09-13~14 검증 시점의 화면이며, 2026-09-16 디자인 변경(초록 테마 → 무채색·네이비) 이전 모습입니다. 기능 검증 기록으로 보관하며 README에는 쓰지 않습니다.

| 공개 파일 | 검증 내용 | 출처 |
| --- | --- | --- |
| [journal-search.png](journal-search.png) | 묶음 업무의 두 번째 매물이 주소 검색에 일치하는 표시 | 2026-09-13, `workflow-review/layout-journal-two.png` |
| [work-detail.png](work-detail.png) | 여러 매물의 주소·가격·업소를 펼쳐 읽기 | 2026-09-13, `workflow-review/layout-detail-ten.png` |
| [safe-deletion.png](safe-deletion.png) | 저장된 원문·연결 매물·휴지통 복구 안내를 포함한 삭제 확인 | 2026-09-14, `deletion-geBX0y/delete-confirm-desktop.png` |
| [mobile-trash.png](mobile-trash.png) | 390px 휴대폰·큰 글씨의 휴지통 검색·기록·복구 | 2026-09-14, `deletion-geBX0y/trash-mobile-large.png` |

원본 캡처와 로컬 fixture는 개발 작업공간의 `output/playwright/` 아래에 보관되며 Git에서는 제외됩니다. 공개에는 위 이미지 4개만 선택했습니다. 출처 환경은 [실제 업무 흐름 점검](../workflow-review.md)과 [삭제·복구 E2E](../deletion-e2e-review.md)에 기록되어 있습니다.

공개 전 원본 이미지를 직접 열어 고객명·단지명·업무 내용이 `검증 고객`, `합성 업무`, `삭제 검증 고객` 등 합성 자료임을 확인했습니다. 계정·암호·운영 인증 값·실제 연락처가 포함된 화면, 로컬 인증 설정, SQLite 저장소, 백업 파일은 추가하지 않았습니다. 캡처의 수치와 가격은 운영 성과가 아닙니다.

## 앱 로고

<img src="jipjangbu-mark-tile.svg" alt="밝은 배경의 집장부 로고" width="48" />

- 기호: 둥근 집 실루엣 안에 열린 장부를 여백으로 넣었습니다. 두 그림을 겹치지 않고 하나의 단색 심볼로 읽히게 했으며, 가운데 책등이 장부의 양쪽 면을 나눕니다.
- 조합: 기호 오른쪽에 "집장부" 글자(Pretendard 가변 굵기 760, 자간 -0.055em)를 둡니다. 앱 사이드바와 로그인 화면은 같은 벡터 심볼을 사용합니다. 기본 사이드바의 심볼은 34px, 글자는 25px입니다.

- 색: 기호는 차콜 네이비 `#2c394b` 단색입니다. 앱의 SVG와 투명 PNG는 장부 안쪽도 투명하며, README·파비콘·홈 화면 아이콘에는 흰색 타일과 연한 테두리를 넣어 배경에 관계없이 읽히도록 합니다.
- 파일: [`jipjangbu-mark.svg`](jipjangbu-mark.svg)(투명 배경의 원본 기호) · [`jipjangbu-mark-tile.svg`](jipjangbu-mark-tile.svg)(흰색 타일, README·앱 아이콘)
- 호환 PNG: `public/jipjangbu-logo.png`(512px 투명 기호), `public/jipjangbu-icon-bright.png`(192px 타일, 파비콘·홈 화면 아이콘), `public/jipjangbu-icon.png`(96px 타일). 이전 이미지 경로도 같은 로고를 제공합니다.
- 수정 방법: 도형 원본은 [`app/brand-mark.tsx`](../../app/brand-mark.tsx)입니다. 이 파일의 SVG를 고친 뒤 `python3 scripts/make_logo.py`를 실행하면 원본 도형을 읽어 PNG와 SVG(`public/favicon.svg` 포함)를 함께 다시 만듭니다(Pillow 필요). 색과 타일 비율은 [`scripts/make_logo.py`](../../scripts/make_logo.py)에 있습니다. PNG 파일 이름은 로그인 전에도 열리도록 `worker/security.ts`에 등록되어 있으니 바꾸지 마세요. 파비콘을 변경할 때는 `app/layout.tsx`의 이미지 버전도 갱신해 기존 브라우저 캐시와 구분합니다.

## 글꼴

화면은 [Pretendard](https://github.com/orioncactus/pretendard)를 사용합니다. 공식 `v1.3.9` 배포본의 가변 WOFF2 유니코드 서브셋 92개를 `public/fonts/pretendard/`에 보관하고 `app/fonts.css`에서 직접 불러옵니다. 표시 중인 문자에 필요한 서브셋만 내려받으며, 외부 폰트 서버나 런타임 `next/font` 주입에 의존하지 않습니다. 폰트 로딩 중에는 운영체제 한글 글꼴을 사용합니다.

폰트의 SIL Open Font License 1.1과 저작권 고지는 [OFL.txt](../../public/fonts/pretendard/OFL.txt)에 포함합니다. 본문은 400, 날짜·고객명·업무구분은 600, 화면·구역 제목은 700으로 구분합니다. 글꼴을 교체할 때는 CSS·WOFF2·라이선스를 함께 확인하고, 일반·큰 글씨 모드의 날짜와 업무 배지 줄바꿈을 검증합니다.
