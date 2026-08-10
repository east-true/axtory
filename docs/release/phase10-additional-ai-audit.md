# AXtory Phase 10 추가 AI Source 구현 감사

감사일: 2026-08-10

대상 범위: Gemini CLI, OpenCode, Cursor Agent, Aider

## 완료 판정

Phase 10의 이름이 명시된 네 Source 구현 범위를 완료했다. 공통 Discovery/Revision/Projection/
Fact/Output 경로를 사용하되 Provider가 제공하지 않는 구조를 추측하지 않는다. OpenCode는
구조화 대화와 Tool occurrence를 수집하고, Gemini/Cursor는 metadata-only, Aider는 명시한
Raw Markdown과 `UNKNOWN` 구조 coverage를 보존한다.

## 요구사항별 근거

| 요구사항 | 판정 | 근거 |
| --- | --- | --- |
| Gemini CLI Source | 완료 | `--list-sessions`, ID allowlist, preview 폐기, metadata-only |
| OpenCode Source | 완료 | pure JSON list/export, source-change 감지, Message/Tool 정규화 |
| Cursor Source | 완료 | `cursor-agent ls`, full UUID allowlist, preview 폐기, metadata-only |
| Aider Source | 완료 | 명시적 history file, 64 MiB 상한, Markdown Raw 보존, schema 비추론 |
| Discovery/Capability | 완료 | PATH/version, Aider file, Availability와 reason, 경로 출력 제외 |
| 안전한 실행 경계 | 완료 | shell 미사용, cwd/timeout/output 상한, content-free 오류 |
| Revision/증분 | 완료 | content-addressed Raw, source modified marker, 재수집 reuse |
| Canonical/Metric | 완료 | SessionProjection, Session/Message/Tool count, Provider별 Availability |
| Coverage | 완료 | limit/source-change/metadata/unknown을 완전한 이력과 구분 |
| Semantic opt-in | 완료 | 구조화 OpenCode assistant text만 Evidence와 연결, 그 외 명시적 거부 |
| Privacy/출력 | 완료 | Raw은 로컬, Console/JSON은 aggregate와 상태만 export |
| CLI | 완료 | `collect-additional-ai`, 네 provider, Aider history path, limit |

## 검증

- `npm test`: 최종 TypeScript build 포함 74개 자동 테스트 통과
- 네 Provider의 공식 계약 shape 기반 adapter/discovery/normalization test 통과
- OpenCode list/export 사이 원천 변경을 `PARTIAL_SOURCE_CHANGED`로 표시
- Aider 실제 child-process CLI 경로: 실행 파일 없이 명시적 Markdown을 수집하고 JSON에서
  대화 내용·경로를 제외
- 동일 Additional AI view 재수집: 신규 Revision 없이 기존 Revision 재사용
- OpenCode opt-in semantic pipeline: assistant text만 matching normalized Evidence에 연결
- `npm audit --omit=optional`: 알려진 취약점 0
- `git diff --check`: whitespace 오류 없음

## 명시적 제한

- 감사 환경에 네 Vendor CLI가 설치되어 있지 않아 Gemini/OpenCode/Cursor의 실제 CLI smoke와
  Aider가 실제 생성한 파일 smoke는 수행하지 않았다. Aider는 AXtory child CLI 경로만 검증했다.
- Gemini/Cursor는 공식 non-mutating structured history export가 없어 Message/Tool fact가
  `NOT_COLLECTED`다. metadata count를 대화 분석으로 해석할 수 없다.
- Aider Markdown은 문서화된 저장물이지만 안정된 Message schema가 아니므로 Message/Tool
  fact는 `NOT_SUPPORTED`이고 coverage는 `UNKNOWN`이다.
- OpenCode export의 complete는 반환 view 기준이며 삭제, retention, 권한, Vendor 버전 차이까지
  포함한 사용자의 전체 이력을 보증하지 않는다.
- Session 수는 완료 업무, 품질, 인과, AI 기여도, 시간 절감 또는 효과가 아니다.
