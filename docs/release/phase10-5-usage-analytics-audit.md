# AXtory Phase 10.5 Usage Analytics 구현 감사

감사일: 2026-08-10

대상 범위: 수집된 AI Session Evidence의 사용자용 Console/JSON Usage Report

## 완료 판정

Connector 수집과 Impact Analysis 사이에 빠져 있던 Usage Analytics 계층을 완료했다. 사용자는
`report-usage`로 로컬에 수집된 최신 Session view의 사용 패턴을 바로 볼 수 있다. 과거 Revision,
Raw content, Vendor identifier, path, custom extension 이름을 리포트에 복제하지 않는다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| Revision 중복 방지 | 완료 | 완료 CollectionRun이 SourceObject별 마지막으로 관찰한 Revision 하나만 선택 |
| Legacy head | 완료 | v5 migration 시 기존 Source head를 고정하고 개수를 표시하며 `PARTIAL` 처리 |
| 전체/Source 범위 | 완료 | 전체 기본값, 반복 가능한 `--source` filter |
| 기간 범위 | 완료 | ISO-8601 `--since`/`--until`, source-time 반개구간 |
| 기본 사용량 | 완료 | Session, user/assistant Message, Tool occurrence |
| Session 패턴 | 완료 | Message/Tool min·median·p90·max·mean |
| 사용 패턴 | 완료 | 활성 UTC 일수, Tool 사용 Session 비율, Message·Tool 비율 |
| Source/Timeline | 완료 | Source별 집계와 JSON UTC 일별 timeline |
| Tool Privacy | 완료 | allowlist 범주, custom MCP/dynamic 이름 비공개 |
| Coverage | 완료 | complete/partial/unknown과 undated 제외 수·이유 |
| Availability | 완료 | Source 없음은 null+`SOURCE_UNAVAILABLE`, 누락을 0으로 대체하지 않음 |
| Semantic opt-in | 완료 | 명시적 content 동의, 현재 Revision 완료 run만 `INFERRED`로 통합 |
| Semantic 상한 | 완료 | 한 번에 100 eligible Revision, 초과 시 범위 축소 요구 |
| Evidence/저장 | 완료 | versioned AnalysisRun, Metric Catalog, Evidence ID, ExportRun |
| 출력 | 완료 | 길이 제한 Console과 원자적 사용자 전용 JSON |

## 검증

- `npm test`: 최종 TypeScript build를 포함한 81개 자동 테스트 통과
- 이전/최신 Revision을 함께 둔 합성 DB에서 최신 Revision만 집계
- 과거 content로 revert한 완료 수집은 과거 Revision을 current head로 선택하고 실패 수집은 제외
- bounded 기간의 undated observation 제외와 `PARTIAL` 유지
- Source가 없을 때 count를 0이 아닌 null/`SOURCE_UNAVAILABLE`로 출력
- custom extension label과 Source/Vendor identity가 JSON에 없는지 검사
- opt-in Rule Semantic run 생성 및 `CHANGE_COMPLETED` 범주 통합
- 실제 child-process `report-usage` Console/JSON 실행
- 비어 있지 않은 로컬 Codex data directory에서 실제 report 생성 및 output 민감 문자열 scan

## 명시적 제한

- partial·compacted Vendor view의 count는 반환 view 하한일 수 있다.
- UTC 일별 timeline은 source timestamp가 없는 observation을 포함하지 않는다.
- Vendor별 Message와 Tool 경계가 다르므로 비율을 Provider 간 성능 비교로 사용할 수 없다.
- Rule Semantic 범주는 좁은 문자열 규칙의 `INFERRED` 주장이고 성공·품질 검증이 아니다.
- Usage Report는 업무 완료, AI 기여도, 인과, 생산성, ROI, 시간 절감, Impact를 추정하지 않는다.
