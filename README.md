# tampermonkey-github-last-comment

GitHub 이슈/PR 목록에서 각 글의 **마지막 댓글 작성자 + 상대시간**을 바로 보여주는 Tampermonkey userscript.

## 설치

1. Tampermonkey 설치 (Chrome / Edge / Firefox)
2. 아래 Raw 링크 클릭 → Tampermonkey가 설치 화면을 띄움 → `설치` 클릭
   - https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
3. 이후 `// @version` 이 올라가면 Tampermonkey가 자동 업데이트로 감지함 (`@updateURL` / `@downloadURL` 설정됨)

## 적용 페이지 (v1.4)

- `https://github.com/*` (스크립트 내부에서 이슈/PR 목록 화면만 처리, `@noframes`)

## 변경 내역

- v1.5.0: 증분 DOM 처리·가시 영역 우선 조회, 이전 결과 유지(점선 테두리 + `이전 결과`), 이슈별 ↻ 재조회, 목록 도구모음(갱신/일시정지/표시 설정 2·5·10분), 작성자 중심 배지 UI
- v1.4.0: 생략 구간 최대 50개씩 반복 조회·검증, 일반 댓글만 판별(updatedAt 대체 금지), 실패를 '댓글 없음'으로 표시하지 않음, 동시 요청 2개·15초 제한, 캐시 2분·계정별 분리, 진단 로그 메뉴 추가
- v1.3.0: 최초 버전관리본

## 버전 관리 규칙

- 기능 수정 시 `github-last-comment.user.js` 상단의 `// @version` 을 올릴 것 (예: `1.3.0` → `1.3.1`)
- 커밋 후 main에 push하면 Raw URL이 갱신되고, Tampermonkey 자동 업데이트 대상이 됨

## 로컬 개발

```powershell
# 클론 위치
# D:\WorkSpaces\js_workspace\tampermonkey-github-last-comment
```

파일을 고친 뒤 Tampermonkey → 유틸리티 → `URL로 설치`에 위 Raw URL을 넣어 테스트하거나,
Tampermonkey 대시보드에서 해당 스크립트를 열고 붙여넣기로 동작 확인.
