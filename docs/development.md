# 개발 안내

[서비스 소개](../README.md) · [문서 모음](README.md)

## 로컬 실행

**Node.js 24와 npm**을 권장합니다. 테스트는 `node:sqlite`와 `module.registerHooks`를 사용합니다.

```bash
git clone https://github.com/seopseopi/Jipjangbu.git
cd Jipjangbu
npm ci
```

[`.env.example`](../.env.example)을 참고해 Git에서 제외되는 로컬 `.env`를 만듭니다. 로컬 실행 도구가 `.env` 값의 `$이름`을 변수로 바꾸기 때문에, 비밀번호 해시에 들어 있는 `$`는 모두 `\$`로 적어야 합니다.

| 설정 | 용도 |
| :--- | :--- |
| `APP_ADMIN_USERNAME` | 개발 환경의 관리자 아이디 |
| `APP_ADMIN_PASSWORD_HASH` | 관리자 비밀번호의 PBKDF2 해시 |
| `APP_SESSION_SECRET` | 로그인 세션 서명 키 |
| `BACKUP_ENCRYPTION_KEY` | 백업 암호화 키 |

예시의 자리표시자는 실제 설정이 아니며, 설정하지 않으면 로그인할 수 없습니다. 비밀번호 해시 형식은 [`worker/security.ts`](../worker/security.ts)의 `verifyPassword`를 참고하세요. **개발용 키와 운영용 키는 분리**하고 실제 비밀번호·키를 코드나 이슈에 넣지 마세요.

```bash
npm run dev
```

서버가 출력하는 로컬 주소로 접속합니다. 로컬 실행은 별도의 D1·R2 에뮬레이터 저장소를 사용하며 운영 자료는 포함하지 않습니다. 개발과 검사에는 운영 비밀키나 실제 고객 자료가 필요하지 않습니다.

## 검사와 명령어

| 명령 | 역할 |
| :--- | :--- |
| `npm run dev` | 로컬 개발 서버 |
| `npm run lint` | 코드 규칙 검사 |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm test` | 타입 검사 → 빌드 → 회귀 테스트 |
| `npm run build` | 배포용 빌드 |
| `npm run db:generate` | 스키마 변경 후 마이그레이션 생성 |

[GitHub Actions](../.github/workflows/ci.yml)는 `main` 푸시와 PR에서 설치·코드 검사·타입 검사·빌드·테스트를 실행합니다. **운영 사이트를 자동 배포하거나 운영 DB를 변경하지 않습니다.** 최신 결과는 [CI 실행 목록](https://github.com/seopseopi/Jipjangbu/actions/workflows/ci.yml)에서 확인할 수 있습니다.

기능을 바꿀 때는 관련 회귀 테스트를 추가하고 `npm run lint`와 `npm test`를 실행하세요. 화면 동작을 확인할 때는 합성 자료를 사용하고, 재현 절차와 검증 범위를 변경 설명에 남겨 주세요.

## 시스템 구성

```mermaid
flowchart LR
    browser["브라우저 · React"] --> worker["Cloudflare Worker · 인증 / API"]
    worker --> db[("D1 · 업무 데이터")]
    worker --> backup["R2 · 암호화 백업"]
    excel["Excel / VBA"] -. "비공개 이관" .-> db
```

| 영역 | 구성 |
| :--- | :--- |
| 화면 | React 19 · TypeScript · Tailwind CSS 4 · Lucide |
| 실행·빌드 | vinext · Vite · Cloudflare Workers |
| 데이터 | Cloudflare D1 / SQLite · Drizzle 스키마·마이그레이션 · prepared SQL / batch |
| 인증 | 비밀번호 해시 검증 · 서명된 HttpOnly 세션 쿠키 · 로그인 시도 제한 |
| 백업 | Cloudflare R2 · AES-GCM 암호화 · 변경 전후 / 이용 시 일일 / 수동 백업 |
| 검증 | GitHub Actions · ESLint · TypeScript · Node.js 테스트 러너 |

## 코드 탐색

| 관심사 | 시작할 파일 |
| :--- | :--- |
| 화면 전환·초안·모달 | [`app/work-manager.tsx`](../app/work-manager.tsx) |
| 화면 디자인·업무 폼 | [`app/renewal.css`](../app/renewal.css) · [`app/work-form-renewal.css`](../app/work-form-renewal.css) |
| 목록 페이지·브랜드 심볼 | [`app/result-pagination.ts`](../app/result-pagination.ts) · [`app/brand-mark.tsx`](../app/brand-mark.tsx) |
| 주소 검색·정렬 | [`app/api/_search.js`](../app/api/_search.js) · [`app/api/_ordering.ts`](../app/api/_ordering.ts) |
| 관계형 모델·매물 상태 | [`db/schema.ts`](../db/schema.ts) · [`db/listing-sync.ts`](../db/listing-sync.ts) |
| 읽기 캐시·요청 수명 | [`app/client-api.ts`](../app/client-api.ts) · [`db/bootstrap.ts`](../db/bootstrap.ts) |
| 삭제·복구 | [`app/api/trash`](../app/api/trash) · [`tests/deletion-safety.test.mjs`](../tests/deletion-safety.test.mjs) |
| 인증·암호화 백업 | [`worker/security.ts`](../worker/security.ts) · [`tests/runtime-performance.test.mjs`](../tests/runtime-performance.test.mjs) |

## 현재 화면 규칙

2026-10-31 리뉴얼은 기존 데이터 처리와 고객·업무·매물·동호수 연결을 유지한 채 화면을 변경합니다. 아이보리 배경·흰 섹션·둥근 모서리·큰 기본 글씨를 사용하며, 집과 장부를 합친 단색 로고 옆에 사무소명을 표시합니다. 사이드바의 검색은 왼쪽, 새 업무 등록은 오른쪽입니다.

- 업무일지는 검색·업무구분 조회를 유지하고 기간 선택과 CSV 내보내기를 제거합니다.
- 업무일지 5건·매물 10건의 로컬 페이지를 사용합니다. 서버의 100건 단위 증분 조회와 오류·오래된 응답 보호는 유지하며, 고객 목록은 100건 더보기를 사용합니다.
- 달력은 하루의 모든 업무를 직접 표시합니다. 업무구분 색상은 유지하고 오늘은 숫자만 진한 원으로 표시합니다.
- 홈 할 일은 5건 표시 제한을 없애고 목록 스크롤을 사용합니다. 새 할 일 추가 버튼으로 입력을 열며 할 일·예정일은 필수, 메모는 선택입니다. 기존 날짜 미정 기록은 보존합니다.
- 필수 입력은 빨간 `*`로 표시하며 선택에 따라 바뀌는 원래 업무 검증 규칙을 유지합니다.

## 기존 엑셀 자료 이관

Excel에서 개발필요 파일을 `.xlsx`로 복사 저장한 뒤 [`scripts/build_private_import.py`](../scripts/build_private_import.py)로 비공개 마이그레이션을 만듭니다. 생성되는 `*_private_*.sql` 파일은 Git에서 제외됩니다. **원본 파일과 생성 결과를 공개 저장소에 넣지 마세요.**

시트별 역할, 중복 처리, 원문 보존 기준은 [엑셀 분석·이관 규칙](excel-analysis.md)을 먼저 확인하세요. 운영 자료를 다시 넣기 전에는 반드시 백업과 대상 환경을 확인해야 합니다.

## 운영 범위와 주의사항

- 변경 전 백업에 실패하면 데이터 변경을 중단합니다. 일일 백업은 사이트 이용 시 실행하며 한국 시각 자정 예약 트리거도 설정했습니다. 배포 환경에서 실제 트리거 등록과 실행 여부를 확인해야 합니다. 자동 백업 보관 기간은 90일입니다.
- 목록 CSV 내보내기는 제거했습니다. 내려받은 암호화 백업은 별도 안전한 장소에 보관하세요.
- 업무·고객·할 일은 편집 기준을 조건부 저장에서 비교해 동시 수정을 차단합니다. 자동 병합은 지원하지 않습니다. 할 일 충돌 후에는 초안을 유지하며 최신 내용 확인 경로를 제공합니다.
- 초안은 새로고침 후 자동 복구되지 않습니다. 할 일은 자동 문자·전화·푸시 알림을 보내지 않습니다.
- 운영 DB 전체 복원·재해 복구 훈련은 수행하지 않았습니다. 수정 전 버전 복원과 외부 백업은 현재 완료된 기능이 아닙니다. 예약 트리거의 운영 적용 여부는 별도 확인해야 합니다.

기능별 동작은 [사용 가이드](usage.md), 설계 판단과 검증의 한계는 [기술 사례](case-study.md)에 정리되어 있습니다.

### 백업 복구 검증

Node.js 24에서 `node scripts/check-backup.mjs <백업파일>`을 실행하면 백업을 메모리의 별도 SQLite DB에 복구해 테이블별 건수, 참조 관계와 DB 무결성을 검사합니다. 암호화 파일은 환경 변수 `BACKUP_ENCRYPTION_KEY`가 필요하며 설정에서 내려받은 JSON도 검사할 수 있습니다. 검사 결과는 건수만 출력하며 운영 DB를 변경하지 않습니다. 실제 운영 백업의 복구·운영 DB로의 이전은 별도 환경과 절차로 확인해야 합니다.

## 데이터 보존과 릴리스 검증

`listing_source_notes`는 현재 매물 상태와 독립적인 원문·최소 업무 연결 정보를 보관합니다. 신규 마이그레이션 `0007`과 runtime bootstrap 4는 기존 원문을 이행하고 고객 이력의 source 검색 인덱스를 준비합니다. 변경 전후 백업에도 이 테이블을 포함합니다. 이전 v1 백업의 복원 검사는 기존 매물 원문과 이벤트로 초기 보관 자료를 재구성합니다.

변경 내역과 단계별 검증은 [안정성 개선 기록](reliability-improvements.md), 실제 운영 확인 절차와 키 보관은 [운영 안내](operations.md)를 참고하세요. GitHub 푸시와 운영 배포·DB 복원은 별도 작업입니다.


2026-10-30: 마이그레이션 `0008`과 bootstrap 5는 `structure_plan_files`를 추가합니다. 이미지·PDF 도면은 기존 revision의 `geometry_json`에 JSON `null`을 기록하고 별도 파일 행과 연결합니다. 실제 구조 JSON 버전은 기존 형식을 유지합니다. `npm run dev`와 `npm run build`는 고정된 `pdfjs-dist` 의존성의 worker와 라이선스를 `public/pdfjs/`에 생성합니다. 생성 파일은 Git과 린트 대상에서 제외합니다. 인증된 원본 API는 별도로 유지하며 공개 worker 경로에 고객 파일을 저장하지 않습니다.
