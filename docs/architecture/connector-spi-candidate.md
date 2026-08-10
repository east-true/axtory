# Connector SPI 후보

상태: `PROPOSED`, Public API 아님

기준일: 2026-08-10

## 결정

Claude와 Codex에서 도출하고 업무 시스템과 Phase 10 추가 AI Source에서도 재사용된 최소
흐름만 후보로 남긴다.

```text
discover capabilities
→ enumerate source-object summaries with explicit coverage
→ read one bounded returned view
→ persist immutable raw revision
→ normalize deterministic observations
```

이 후보는 타입스크립트 export, plugin loading 규약, semantic versioning 약속이 아니다. 현재
`ClaudeHistoryApi`, `CodexThreadApi`, `WorkSystemApi`, `AdditionalAiSourceApi`는 서로 다른 내부
adapter이며 하나의 공개 DTO로 합치지 않는다.

## 공통 후보 계약

| 후보 | 최소 의미 | 확인 근거 |
| --- | --- | --- |
| Discovery | 설치, data root, active version, capability별 Availability/Reason | 다중 Connector 구현 |
| Source summary | Vendor stable key와 선택적 source-modified marker | Session/thread/work artifact/history file |
| Enumeration result | ordered returned items, coverage, page 수, duplicate 수 | offset/cursor adapter 테스트 |
| Returned view read | 하나의 SourceObject에 대한 bounded Vendor payload | SDK messages, App Server thread |
| Revision write | source key + content hash로 immutable/idempotent 저장 | 공통 collector 경로 |
| Normalization result | deterministic `NormalizedObservation[]`과 normalizer version | 공통 projection 입력 |
| Lifecycle | 명시적 close/dispose가 가능해야 함 | no-op SDK와 child process/snapshot 모두 수용 |

Phase 9~10은 SourceObject/Revision/Observation 경계의 재사용을 확인했다. 동시에 enumeration이
API page/cursor, CLI 목록, 단일 history file일 수 있고 content capability도 structured,
metadata-only, unstructured로 갈린다는 점을 드러냈다. 따라서 capability/coverage는 공통
의미지만 Message DTO나 pagination 필드는 공통 계약이 아니다.

후보가 공개될 경우 Core가 요구할 수 있는 것은 결과의 의미와 안전성뿐이다. pagination 방식,
Vendor DTO, 프로세스 전송, 인증 방식, 파일 위치를 계약에 포함하지 않는다.

## 공통화하지 않는 항목

| 항목 | Claude | Codex | 결정 |
| --- | --- | --- | --- |
| API lifecycle | 동적 SDK import | initialize된 NDJSON child process | Connector 내부 |
| pagination | numeric offset/limit | opaque cursor, archive 분리 | Connector 내부 |
| consistency | pre/post metadata read | active status와 list/detail 비교 | Connector 내부 |
| source filters | dir/worktree/programmatic | sourceKinds/stateDbOnly/archive | Connector 내부 |
| hierarchy | message parent fields, 표본 부족 | thread fork/parent fields | Canonical relation만 공통 |
| storage accommodation | custom config root | temporary SQLite home snapshot | Connector 내부 |
| live channel | Hook/OTel 지원 | 현재 snapshot만 구현 | Public 후보에서 제외 |
| telemetry | Local History 비권위 | thread view 비권위 | 별도 Channel Analyzer |

특히 `Session`, `Thread`, `Turn`, `Message`를 같은 DTO로 만들지 않는다. 공통 Core 경계는
SourceObject/Revision/Observation이며 Vendor 대화 모델은 Connector가 소유한다.

## 공개 보류 조건

다음 항목이 없으므로 Public SPI 게시를 보류한다.

- 프로세스 격리, 권한 manifest, dependency/version negotiation 규약
- plugin 공급망과 서명·업데이트·철회 정책
- backward compatibility와 conformance fixture suite

Phase 10 완료로 세 번째 이상의 Connector에서 최소 Core 흐름은 확인했다. 이는 Public plugin
SPI나 임의 Connector 자동 실행을 의미하지 않으며 나머지 보류 조건은 그대로다.
