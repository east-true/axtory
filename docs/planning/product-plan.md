# AXtory 제품 기획

상태: `ACCEPTED`

기준일: 2026-08-09

대상: 기획자, 기여자, Connector·분석·출력 기능 개발자

## 1. 제품 정의

AXtory는 사용자가 기존 AI Agent를 사용하는 방식을 바꾸지 않고, 그 작업의 과정과
결과를 근거 및 불확실성과 함께 보여주는 local-first AI/AX Work Analytics 제품이다.

AXtory는 Agent 실행기나 Prompt Proxy가 아니다. 사용자는 평소처럼 Claude Code, Codex
등을 실행하고 AXtory는 별도의 외부 관찰자로서 공식 읽기 인터페이스가 제공하는
데이터만 수집한다.

## 2. 해결하려는 문제

AI Agent 사용 기록은 Vendor별로 흩어져 있으며 다음 질문을 하나의 신뢰 가능한
관점에서 답하기 어렵다.

- 사용자는 무엇을 원했는가?
- 어떤 Agent, 모델, 도구를 사용했는가?
- 어떤 과정을 거쳐 무엇을 얻었는가?
- Agent의 주장이 실제로 검증되거나 사용자에게 수용됐는가?
- 토큰·비용·시간·품질·일정에 어떤 영향이 있었는가?
- 값이 없을 때 정말 0인가, 수집하지 못한 것인가?

AXtory는 이 질문에 무조건 답을 생성하지 않는다. 알 수 없는 값은 이유가 있는
`UNKNOWN` 또는 명시적인 Availability 상태로 남긴다.

## 3. 제품 가치

1. **근거 중심:** 모든 분석을 원천 Revision과 Evidence로 추적한다.
2. **불확실성 보존:** 관찰·계산·추론·추정을 출력에서 구분한다.
3. **사용 방식 유지:** Agent 실행 흐름에 AXtory를 강제로 끼워 넣지 않는다.
4. **로컬 소유:** 계정이나 중앙 서버 없이 수집·조회·내보내기·삭제가 가능해야 한다.
5. **Vendor 독립성:** Vendor 원문과 Canonical 모델을 분리한다.
6. **점진적 신뢰:** 여러 Source 구현에서 공통 계약을 검증하되 격리·호환성·공급망 조건이
   갖춰진 경우에만 공개 SPI를 검토한다.

## 4. 주요 사용자

### 개인 개발자

자신의 AI 작업 기록과 사용량을 로컬에서 확인하고, 실제 산출물·검증 상태와 연결하고
싶은 사용자다. 설치 후 계정 생성 없이 즉시 사용할 수 있어야 한다.

### AI 활용 방식을 개선하려는 실무자

업무 유형, 도구 사용, 반복 실패, Agent 주장과 검증 결과의 차이를 확인하고 싶다.
AX 종합점수 대신 개별 지표와 근거를 본다.

### 오픈소스 기여자

새 Connector나 분석 방식을 추가하되 민감정보 처리 및 Canonical 의미를 훼손하지
않아야 한다. 초기에는 임의 Plugin 자동 실행을 허용하지 않는다.

## 5. 기본 사용자 흐름

### Snapshot 모드

```text
설치
→ Source 탐색 및 Capability 확인
→ 수집 범위·정책 확인
→ 읽기 전용 증분 수집
→ 로컬 분석
→ Console 또는 JSON 확인
```

Snapshot이 기본이다. AXtory Core가 항상 실행 중일 필요는 없다.

### Optional Live 모드

Hook 또는 OTel을 사용자가 명시적으로 활성화한 경우에만 Local Receiver가 실행된다.
Receiver는 분석하지 않고 인증·크기·속도 제한을 적용한 뒤 Spool에 빠르게 기록한다.

```text
Capability 검사
→ 변경 계획 표시
→ 사용자 동의
→ 기존 설정 백업
→ 병합 및 적용
→ 실제 수신 검증
→ 실패 시 원복
```

## 6. MVP 범위

### 기술 MVP

- 동일 실행 환경의 Claude Code 설치·버전·data root·Capability 탐색
- 공식 Claude Session 읽기 API를 통한 Session·Message·보존 Tool block 수집
- RawObservation, SourceRevision, NormalizedObservation 분리
- 증분 수집, content-hash 중복 방지, 중단 복구
- Session 단위 Fact Analytics
- Availability, Provenance, Derivation 표시
- ConsoleSink, JsonFileSink
- 합성 Fixture 기반 Contract Test

### 현재 완료된 기반

- Claude 공식 API의 민감정보 없는 구조적 Contract Spike
- 합성 `normal-session` Walking Skeleton
- SQLite schema v5, Blob Store, Revision, completed CollectionRun의 observed Revision head,
  SessionProjection, Fact Analyzer
- 반복 수집 중복 방지 및 중단 실행 reconciliation 테스트
- 공식 Claude History의 제한된 실제 수집과 동일 view 증분 재수집 검증
- 기본 로컬 CollectionPolicy와 marker-guarded `PURGE_ALL`
- VerificationRecord와 원 분석을 덮어쓰지 않는 UserAnnotation
- Blob reference, 분석 Evidence 상태, WAL, pending Spool을 포함한 선택 삭제와 Retention
- opt-in Rule Semantic Analysis와 strict Local/Remote structured-result adapter
- 별도 Local Git Artifact Source와 비인과적 temporal correlation
- opt-in Claude HTTP Hook/OTLP `http/json` Receiver, bounded Spool, 설정 backup/rollback
- OTel token/model/추정 cost/latency Fact
- 공식 Codex App Server 기반 thread 수집, 격리 state snapshot, Fact/Semantic 경로
- GitHub/GitLab PR·CI·Deployment와 Jira/Linear Work Item의 content-free 증분 수집
- 업무 시스템의 명시적 commit identity와 Local Git commit의 관측 관계
- Gemini CLI/OpenCode/Cursor/Aider의 capability별 증분 수집과 명시적 coverage
- 문서화된 저장소를 직접 읽는 Kimi Code 수집과 Rule Semantic 범주
- 최신 Revision 기반 기간·Source·Session·Tool·Evidence·Telemetry·Verification Usage
  Analytics Console/JSON 리포트
- 명시적 content 동의가 있을 때만 Usage Report에 통합되는 Rule Semantic 범주
- Claude Session과 Codex thread의 작업공간 맥락을 digest로만 수집하는 `--workspace-dir` 범위 지정

Claude의 resume·compaction·worktree·subagent와 Codex의 resume·fork·subagent·미완료 turn은
통제된 실제 사례로 확인했고, 대부분 관계가 없다는 negative 결론이었다. 다만 다음은 아직 열려
있다. Claude의 실제 active Session 중 수집(목록 읽기와 재읽기 사이의 변경 감지)은 통제된
사례가 없다. Codex는 격리 snapshot을 읽으므로 같은 질문이 구조적으로 성립하지 않지만 Claude는
live 상태를 다시 읽으므로 성립한다. Claude fork를 `FORKED_FROM`으로 발행할지, Codex
`gitInfo.originUrl`을 저장소 정체성으로 수집할지도 결정하지 않았다.

## 7. 초기 MVP 이후에도 제외하는 것

- 자동 AnalysisUnit 그룹핑과 AI 기여도 백분율
- 목표 달성 점수, AX 종합점수, ROI 및 시간 절감 추정
- Cloud Backend, 팀 계정, RBAC, Microservices, Message Broker
- Plugin Marketplace 및 임의 Repository Plugin 실행
- Grafana 연동과 Jira의 content/comment/changelog 수집
- Hook·OTel 자동 설정 또는 외부 bind
- bundled Local/Remote 의미 분석 모델 Provider
- Claude 내부 JSONL 직접 파싱
- 모든 Agent 동시 지원

## 8. 결과 표현 규칙

### Derivation

| 값 | 의미 |
| --- | --- |
| `OBSERVED` | Source에서 직접 읽은 값 또는 주장 자체 |
| `CALCULATED` | 관찰값에 명시적 공식을 적용한 값 |
| `INFERRED` | 관찰 근거에서 의미적으로 추론한 값 |
| `ESTIMATED` | 기준선·반사실을 이용한 추정값 |

`ASSERTION`은 Derivation이 아니라 명제 종류다. Agent가 “테스트가 통과했다”고 말한
경우 관찰된 사실은 Agent의 주장이고, 실제 테스트 성공 여부는 별도 기술 검증이다.

### Availability

`AVAILABLE`, `PARTIAL`, `NOT_COLLECTED`, `NOT_CONFIGURED`, `NOT_SUPPORTED`,
`NOT_RETAINED`, `REDACTED`, `PERMISSION_DENIED`, `COLLECTION_ERROR`,
`SOURCE_UNAVAILABLE`, `UNKNOWN`을 구분한다. 미수집 Token을 0으로 표시하지 않는다.

### Coverage

분모를 알 수 없으면 백분율을 만들지 않는다. `COMPLETE_FOR_RETURNED_VIEW`,
`PARTIAL_PAGINATION`, `PARTIAL_COMPACTION`, `PARTIAL_RETENTION`, `PARTIAL_SOURCE_CHANGED`,
`PARTIAL_UNSETTLED_TURN`, `UNKNOWN` 같은 상태를 쓴다. 끝나지 않은 Turn을 담은 view는 완전하다고
표시하지 않는다.

## 9. 데이터 소유와 기본 정책

- 외부 Telemetry, Prompt·Code 업로드, 오류 리포팅, 원격 분석은 기본 OFF다.
- 사용자의 세션·코드·분석 데이터에 AXtory가 소유권을 주장하지 않는다.
- 사용자는 조회, Export, 삭제, Retention 설정을 할 수 있어야 한다.
- Raw 불변성은 분석 파이프라인이 원본을 임의 수정하지 않는다는 뜻이며 사용자 삭제를 막지 않는다.
- 전체 `PURGE_ALL`과 `DELETE_RAW_ONLY`, `DELETE_RAW_AND_DERIVED`,
  `DELETE_SOURCE_SESSION`, 분류별 Retention을 지원한다. 삭제는 Evidence 상태, Blob 참조,
  SQLite WAL과 pending Spool을 함께 처리한다.

## 10. 제품 성공 기준

초기 성공을 사용자 수나 임의의 효율 점수로 정의하지 않는다. 다음 검증 가능한 조건을
기술 MVP 완료 기준으로 사용한다.

- 동일 Source를 반복 수집해 Revision과 Observation 중복이 생기지 않는다.
- 중간 실패 후 다음 실행에서 중단 상태를 식별하고 이어갈 수 있다.
- 수집 불가 값이 상태와 이유를 가진다.
- 분석 결과가 입력 Revision과 Evidence를 가리킨다.
- 기본 설치에서 네트워크 전송과 Vendor 설정 변경이 발생하지 않는다.
- 공개 Fixture에는 실제 사용자·회사·경로·코드·Prompt·Secret이 없다.
- Claude History가 Fixture부터 Console/JSON까지 전체 파이프라인을 통과한다.

## 11. 제품 결정 원칙

현재는 Node.js 24 + TypeScript 한 언어를 사용한다. Go의 시작 속도·메모리·단일 바이너리
장점은 인정하지만 상시 Receiver가 Core 필수가 아니며 첫 Connector의 공식 TypeScript
SDK를 직접 사용하는 단순성이 더 중요하다. 측정된 병목 없이 언어를 분리하지 않는다.

Claude, Codex, 업무 시스템, 추가 AI Source 구현에서 공통 최소 계약을 검토했지만 Public
SPI로 공개하지 않았다. 세 번째 이상의 Source는 Core 경계의 재사용 가능성을 보여줬지만,
프로세스 격리·권한·호환성·공급망 정책 없이 외부 안정성 약속을 만들지 않는다.
