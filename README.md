<p align="center">
  <a href="https://jipjangbu.minseop0920370667.chatgpt.site">
    <img src="docs/assets/jipjangbu-mark-tile.svg" alt="집장부" width="64" />
  </a>
</p>

<h1 align="center">집장부</h1>

<p align="center">
  부동산 중개 업무를 기록하고 고객·매물·일정을 함께 관리하는 업무 장부입니다.
</p>

<p align="center">
  <a href="https://jipjangbu.minseop0920370667.chatgpt.site"><strong>서비스 열기</strong></a>
  &nbsp;|&nbsp; <a href="docs/usage.md">사용 가이드</a>
  &nbsp;|&nbsp; <a href="docs/README.md">문서</a>
  &nbsp;|&nbsp; <a href="https://github.com/seopseopi/jipjangbu/issues/new/choose">문의</a>
</p>

<p align="center">
  <a href="https://github.com/seopseopi/jipjangbu/actions/workflows/ci.yml"><img src="https://github.com/seopseopi/jipjangbu/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <img src="https://img.shields.io/badge/React-19-13254a?logo=react&amp;logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-13254a?logo=typescript&amp;logoColor=white" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/Cloudflare-D1%20%2B%20R2-13254a?logo=cloudflare&amp;logoColor=white" alt="Cloudflare D1 · R2" />
</p>

---

## 소개

집장부는 엑셀로 쓰던 부동산 업무일지를 웹으로 옮긴 서비스입니다. 업무 하나에 고객과 여러 매물을 연결해 기록하고, 고객이나 매물 주소로 지난 이력을 찾아 다음 업무를 이어서 작성합니다. PC와 휴대폰에서 모두 쓸 수 있고, 글자를 크게 키워 볼 수 있습니다.

## 주요 기능

| 화면 | 기능 |
| :--- | :--- |
| **홈** | 오늘 업무·다가오는 일정·진행 중 매물·전체 고객 요약, 최근 업무, 챙겨야 할 일 |
| **업무일지** | 고객·주소·내용 검색, 기간·업무구분 필터, 여러 매물 연결, CSV 내보내기 |
| **고객 관리** | 고객명·ID·연락처 관리, 직접 연결·물건지 연결 이력, 업무구분별 조회 |
| **매물 관리** | 전체 매물 조회, 종류·이름·동·호수 정렬, 누적 이력, 기존 매물로 새 업무 작성 |
| **업무 달력·현황** | 월별 일정, 업무량과 업무구분별 현황, 오래 갱신되지 않은 매물 |
| **휴지통·설정** | 업무·고객·할 일 삭제와 복구, 업무 분류 관리, 암호화 백업 생성·다운로드 |
| **집 구조 보기** | PDF·이미지 도면 등록, 세대별 버전 연결, 페이지·확대·회전, 원본 포함 백업 |
| **통합검색** | 업무·고객·매물을 한 번에 검색 (`/` 키) |

자세한 동작과 정렬 기준은 [사용 가이드](docs/usage.md)에 있습니다.

## 이용 안내

[서비스](https://jipjangbu.minseop0920370667.chatgpt.site)에 관리자 계정으로 로그인한 뒤 **새 업무 등록**에서 고객과 매물을 선택해 기록합니다.

- **접근 권한:** 관리자 전용 서비스이며 공개 체험 계정은 없습니다.
- **개인정보:** 이 저장소에는 코드·스키마·예시 자료만 있습니다. 실제 고객 자료, 운영 비밀키, 백업 파일은 포함하지 않습니다.
- **백업:** 변경 전 백업에 실패하면 데이터를 바꾸지 않습니다. 일일 백업은 사이트 이용 시에도 실행되며, 매일 예약 실행을 위한 설정이 포함되어 있습니다. 자동 백업은 90일간 보관합니다. CSV는 전체 백업을 대신하지 않습니다.
- **동시 사용:** 여러 기기에서 로그인할 수 있습니다. 같은 업무·고객·할 일을 동시에 수정하면 먼저 저장된 내용을 보호하고 나중 저장에 충돌을 안내합니다. 자동 병합은 지원하지 않습니다.

## 개발

React·TypeScript·Tailwind CSS 화면과 Cloudflare Workers API로 구성되어 있습니다. 업무 데이터는 **D1**, 원본 도면과 암호화 백업은 **R2**에 저장합니다. **Node.js 24와 npm**을 권장합니다.

```bash
git clone https://github.com/seopseopi/jipjangbu.git
cd jipjangbu
npm ci
npm run dev
```

실행 전에 [`.env.example`](.env.example)을 참고해 로컬 `.env`에 **개발용** 관리자 계정과 키를 넣어야 로그인할 수 있습니다. 비밀번호 해시에 들어 있는 `$`는 `\$`로 적어야 합니다. 로컬 실행은 운영 데이터와 분리된 저장소를 씁니다.

| 명령 | 역할 |
| :--- | :--- |
| `npm run lint` | 코드 규칙 검사 |
| `npm test` | 타입 검사 → 빌드 → 회귀 테스트 |

- [개발 환경·구조](docs/development.md) · [설계와 구현](docs/case-study.md) · [CI 결과](https://github.com/seopseopi/jipjangbu/actions/workflows/ci.yml)
- 로고와 브랜드 색: [docs/assets](docs/assets/README.md)

## 문의

| 내용 | 바로가기 |
| :--- | :--- |
| 기능 사용법과 백업 | [사용 가이드](docs/usage.md) |
| 개발·설계·검증 자료 | [문서 모음](docs/README.md) |
| 오류 제보 | [버그 제보](https://github.com/seopseopi/jipjangbu/issues/new?template=bug_report.yml) |
| 개선 의견 | [기능 제안](https://github.com/seopseopi/jipjangbu/issues/new?template=feature_request.yml) |

이슈는 공개됩니다. 고객명·전화번호·실제 업무 내용·계정 정보는 적지 말고 가상의 예시를 사용해 주세요.
