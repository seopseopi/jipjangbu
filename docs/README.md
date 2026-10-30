# 집장부 문서

[서비스 소개](../README.md) · [서비스 열기 ↗](https://jipjangbu.minseop0920370667.chatgpt.site)

사용 방법, 개발 환경, 설계와 검증 기록을 목적에 따라 찾아볼 수 있습니다.

## 시작하기

| 문서 | 내용 |
| :--- | :--- |
| [사용 가이드](usage.md) | 업무 등록·조회, 고객·매물 이력, 검색·정렬, 삭제·복구, 할 일과 백업 |
| [운영 안내](operations.md) | 예약 백업 확인·격리 복구 훈련·키 보관과 교체 |
| [개발 안내](development.md) | 로컬 실행, 환경 설정, 검사 명령, 시스템 구성과 코드 위치 |
| [서비스 화면·브랜드 이미지](assets/README.md) | 합성 데이터 화면, 캡처 시점, 이미지 출처와 공개 검수 기준 |

## 설계와 데이터

| 문서 | 내용 |
| :--- | :--- |
| [기술 설계 사례](case-study.md) | 검색·읽기·이력·로딩·삭제의 문제와 설계 판단, 검증 범위와 한계 |
| [엑셀 분석·이관 규칙](excel-analysis.md) | 원본 시트와 VBA의 역할, 웹 모델과 달력 표시 기준 |
| [삭제·복구 요구사항](deletion-prd.md) | 삭제 범위, 연결 자료 영향, 확인·충돌 처리, 복구 규칙 |
| [업무 복사 설계](work-copy.md) | 원본 보존, 복사 항목, 날짜·새 ID, 취소·저장·복귀 흐름 |
| [성능 개선 기록](performance.md) | 요청·쿼리 최적화, 측정 조건과 합성 데이터 벤치마크 |

## 검증과 개선 기록

| 문서 | 확인할 내용 |
| :--- | :--- |
| [집 구조 원본 등록](apartment-structure-local-preview.md) | 이미지·PDF 등록, 세대 연결, 모바일 조작과 파일 포함 백업 검증 |
| [안정성 개선 기록](reliability-improvements.md) | 원문 보존·충돌·라우팅·관리 페이징의 단계별 검증 |
| [업무 흐름 점검](workflow-review.md) | 고객·매물 이력, 업무 읽기·수정·복귀, 검증 결과와 남은 과제 |
| [검색 점검](search-review.md) | 동·호수 검색, 실제 일치 매물 표시, 조회 상태 구분 |
| [가독성 개선](readability-review.md) | 여러 매물 표시와 긴 본문, 누적 이력, 모바일 표시 |
| [삭제·복구 E2E](deletion-e2e-review.md) | 삭제 확인, 관계와 상태 재계산, 복구·모바일 흐름 |
| [로딩 E2E](loading-e2e-review.md) | 느린 초기 조회, 창 열기, 요청 취소·재시작과 최신성 |

검증 보고서는 **각 문서에 기재된 시점과 환경**의 기록입니다. 현재 코드의 자동 검사 상태는 [GitHub Actions](https://github.com/seopseopi/Jipjangbu/actions/workflows/ci.yml)에서 확인하세요. CI 통과는 운영 가동률이나 전체 장애 복구를 보증하지 않습니다.

## 피드백 보내기

[버그 제보](https://github.com/seopseopi/Jipjangbu/issues/new?template=bug_report.yml) · [기능 제안](https://github.com/seopseopi/Jipjangbu/issues/new?template=feature_request.yml)

이슈는 공개됩니다. 실제 고객·매물·상담 내용을 가상의 예시로 바꾸고, 계정 정보·비밀키·원본 엑셀·백업 파일은 첨부하지 마세요.
