# tampermonkey-github-last-comment

GitHub 이슈/PR 목록에서 각 글의 **마지막 댓글 작성자 + 상대시간**을 바로 보여주는 Tampermonkey userscript.

## 설치

1. Tampermonkey 설치 (Chrome / Edge / Firefox)
2. 아래 Raw 링크 클릭 → Tampermonkey가 설치 화면을 띄움 → `설치` 클릭
   - https://raw.githubusercontent.com/eddy961206/tampermonkey-github-last-comment/main/github-last-comment.user.js
3. 이후 `// @version` 이 올라가면 Tampermonkey가 자동 업데이트로 감지함 (`@updateURL` / `@downloadURL` 설정됨)

## 적용 페이지

- `https://github.com/*/*/issues*`
- `https://github.com/issues*`
- `https://github.com/pulls*`
- `https://github.com/search*`

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
