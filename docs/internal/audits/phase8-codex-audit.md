# AXtory Phase 8 Codex 구현 감사

감사일: 2026-08-09

대상 범위: Codex Contract Spike, Snapshot Connector, 공통 Connector 계약 후보

## 완료 판정

Phase 8 완료 조건을 충족했다. 공식 App Server의 안정 thread read 경로를 실제 설치에서
검증했고, 동일 데이터를 Raw/Revision/Normalization/Projection/Fact/Output 및 opt-in Rule
Semantic Analysis에 연결했다. Claude/Codex 공통 최소 계약을 후보로 문서화하되 Public SPI는
게시하지 않았다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| 설치·data root·login discovery | 완료 | PATH/version/state DB/status의 Availability 분리 |
| App Server lifecycle | 완료 | initialize/initialized, NDJSON bounds, timeout, close 구현 |
| 읽기 전용 메서드 경계 | 완료 | client request allowlist는 `thread/list`, `thread/read`; 역방향 request 거부 |
| 원본 상태 불변성 | 완료 | original DB read-only online backup, private temporary home, 자동 dispose |
| metadata repair 방지 | 완료 | 모든 list 호출에 `useStateDbOnly: true` 강제 |
| sourceKind 범위 | 완료 | 0.147.0 generated schema의 현재 10개 kind 명시 |
| pagination | 완료 | cursor, active/archive, max page, repeat, duplicate coverage 테스트 |
| stable API만 사용 | 완료 | experimental turn pagination 미사용 |
| thread 수집 | 완료 | `thread/read(includeTurns: true)` 반환 view를 local raw blob으로 보존 |
| 증분·Revision | 완료 | updatedAt marker, content hash, active 재조회, 동일 view 중복 방지 |
| 정규화·Fact | 완료 | message/tool occurrence, compaction, explicit lineage, count 분석 |
| partial semantics | 완료 | active/change/compaction/non-full/pagination 상태를 explicit coverage로 보존 |
| 민감정보 출력 제외 | 완료 | prompt/path/ID/tool payload가 JSON·Spike report에 없는 합성 테스트 |
| Semantic parity | 완료 | Codex assistant message를 opt-in Rule Analyzer evidence에 연결 |
| Public SPI 후보 | 완료 | 공통 최소 흐름과 Vendor별 비공통 항목을 별도 문서화 |

## 검증

- `npm test`: TypeScript build 포함 52개 테스트 통과
- 설치된 Codex CLI 0.147.0 App Server 구조 Spike 성공
- bounded 실제 Spike: thread 5개 열거, 첫 3개에서 full turn 55개 구조 검사
- bounded 실제 collection: thread 2개가 Raw/Revision/Normalized/Fact/JSON 경로 통과
- `npm audit --omit=optional`: 별도 최종 검증 결과 참조
- 실제 Spike report는 680 bytes의 allowlisted 구조 metadata이며 식별자·경로·content 없음

## 발견된 중요한 차이

`thread/list`와 `thread/read`가 비변경 요청이어도 App Server process 시작은 원본 home의 SQLite
runtime을 초기화하려 했다. 따라서 “read method만 호출”은 source 불변성을 충분히 보장하지
않는다. AXtory는 App Server 전체 process를 snapshot home에 격리했다. 이 lifecycle 차이는
Claude SDK adapter와 공통 SPI에 넣지 않는다.

## 명시적 제한

- 실제 표본에 active, fork, parent link는 없었다. 해당 처리는 합성 테스트와 공식 응답 필드에
  근거하며 통제된 실제 사례가 남아 있다.
- compaction event가 반환됨은 확인했지만 compact 전 history를 복원하거나 완전성을 주장하지 않는다.
- current source kind 목록은 Codex 0.147.0 계약이다. 새 kind는 compatibility 검토가 필요하다.
- App Server가 original rollout을 읽는 것은 허용하지만 AXtory는 JSONL을 직접 해석하지 않는다.
- thread history는 token/cost 권위 Source가 아니므로 해당 값은 `NOT_COLLECTED`다.
- Public Connector SPI, plugin loader, marketplace는 구현하지 않았다.
