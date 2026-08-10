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
| Semantic 상한 | 완료 | 한 번에 100 eligible Revision, 초과 시 실제 선택 filter를 이분탐색해 각 창이 상한을 넘지 않는 `--since`/`--until` 조합을 제시 |
| Evidence/삭제 | 완료 | Raw 삭제를 `EVIDENCE_REMOVED`/`PARTIAL`로 표시하고 파생 record에도 전파 |
| OTel Usage Fact | 완료 | 같은 DB의 token/model/추정 cost/latency, event·metric channel 별도 집계 |
| Verification | 완료 | 선택 Evidence에 연결된 유형·상태 집계, 원 분석 근거 상태 별도 표시 |
| UserAnnotation | 완료 | 선택 범위의 개수와 선언 기준선 분(minutes)만 표시하고 사용자 assertion 원문은 출력하지 않음 |
| 저장 경계 | 완료 | 한 data directory/SQLite 범위를 명시하고 cross-directory federation은 미지원 |
| Evidence/저장 | 완료 | `usage-report/2` AnalysisRun, Metric Catalog, Evidence ID, ExportRun |
| 출력 | 완료 | 길이 제한 Console과 원자적 사용자 전용 JSON |

## 검증

- `npm test`: 최종 TypeScript build를 포함한 94개 자동 테스트 통과
- 이전/최신 Revision을 함께 둔 합성 DB에서 최신 Revision만 집계
- 과거 content로 revert한 완료 수집은 과거 Revision을 current head로 선택하고 실패 수집은 제외
- bounded 기간의 undated observation 제외와 `PARTIAL` 유지
- Source가 없을 때 count를 0이 아닌 null/`SOURCE_UNAVAILABLE`로 출력
- custom extension label과 Source/Vendor identity가 JSON에 없는지 검사
- opt-in Rule Semantic run 생성 및 `CHANGE_COMPLETED` 범주 통합
- Raw-only 삭제 전후 count·Evidence·Verification 상태 보존
- 동일 token의 OTel event·metric channel 비합산과 누락 범주의 `NOT_COLLECTED`
- Verification note와 UserAnnotation assertion이 JSON에 없는지 검사
- 실제 child-process `report-usage` Console/JSON 실행
- 비어 있지 않은 로컬 Codex data directory에서 실제 report 생성 및 output 민감 문자열 scan

## 명시적 제한

- partial·compacted Vendor view의 count는 반환 view 하한일 수 있다.
- UTC 일별 timeline은 source timestamp가 없는 observation을 포함하지 않는다.
- Vendor별 Message와 Tool 경계가 다르므로 비율을 Provider 간 성능 비교로 사용할 수 없다.
- Rule Semantic 범주는 좁은 문자열 규칙의 `INFERRED` 주장이고 성공·품질 검증이 아니다.
- Usage Report는 업무 완료, AI 기여도, 인과, 생산성, ROI, 시간 절감, Impact를 추정하지 않는다.

## 후속 (같은 날 추가)

감사 이후 같은 범위 안에서 다음을 추가했다. 표의 판정은 그대로이며 아래 항목이 근거를 확장한다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| Semantic 상한 안내 | 완료 | 상한 초과 시 각 창이 상한 이하가 되는 창 조합을 계산해 실행 가능한 명령으로 출력 |
| 사용자 텍스트 되읽기 | 완료 | `list-annotations`가 Annotation과 Verification Note를 stdout으로만 출력하고 파일·ExportRun을 남기지 않음 |
| 사용자 텍스트 분류 | 완료 | schema v6·v8이 `user_annotations`와 `verification_records.note`에 DataClassification 부여, 기본 `PERSONAL_DATA` |
| 사용자 텍스트 보존 | 완료 | Retention이 만료된 Annotation을 삭제하고 만료된 Note는 텍스트만 지운 뒤 Verification 상태를 보존 |
| 기간 비교 | 완료 | `compare-usage`가 두 창을 각각 측정해 나란히 출력하고, 양쪽이 모두 측정한 값에만 차이를 제시 |
| 선언 기준선 | 완료 | schema v7 `baseline_minutes`, Export 정책이 허용하는 분류만 합산하고 보류분은 `REDACTED`로 표시 |

### 후속 검증

- 265 Session 실 데이터에서 상한 초과 시 제시한 세 창이 각각 100/100/65로 상한을 지키는지 확인
- Annotation 기록 후 되읽기, 잘못된 `--target-type`·`--classification` 거부
- 분류별 선택 만료: `PERSONAL_DATA` Annotation 삭제, `LOCAL_METADATA` Annotation 잔존
- Note 만료 후 `VERIFIED` 상태 유지와 텍스트 `null` 전환
- 창 비교에서 측정되지 않은 쪽이 0이 아닌 `UNKNOWN`으로 남고, `PARTIAL` 창의 차이가 완전한 값으로 승격되지 않음
- `--json-out` 없는 비교가 ExportRun을 남기지 않음
- 기준선 기본 분류(`PERSONAL_DATA`)는 `REDACTED`, `LOCAL_METADATA`만 합산
- schema v5→v6→v7→v8 migration이 기존 Annotation 텍스트를 보존

### 후속 제한

- 창 경계는 창마다 독립이므로 이벤트가 경계에 걸친 Session은 겹치는 두 창 모두에 집계된다.
- 선언 기준선은 사용자의 주장이며 AXtory는 뺄셈할 실제 소요 시간을 기록하지 않는다.
- Verification Note에는 자체 분류가 있지만 Annotation과 달리 레코드가 아닌 텍스트만 만료된다.
