# opencode-agy-plugin

`agy` CLI를 OpenCode의 provider로 연결하는 플러그인이다. OpenCode에서 `agy`가 제공하는 모델을 선택해 사용할 수 있다.

이 프로젝트는 전적으로 vibe coding으로 개발된다.

## 빠른 시작

### 사전 조건

- `agy` CLI 설치
- `agy` 로그인 완료
- OpenCode 설치

먼저 터미널에서 `agy`를 한 번 실행해 인증을 완료한다.

### npm 설치

`~/.config/opencode/opencode.json` 또는 `opencode.jsonc`에 추가한다.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agy-plugin"],
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "name": "Google Antigravity (via agy CLI)",
      "options": {
        "binary": "agy",
        "timeoutMs": 300000
      }
    }
  }
}
```

OpenCode를 재시작한 뒤 `/model`에서 `agy/...` 모델을 선택한다. 모델 목록은 시작할 때 `agy models`에서 자동으로 가져온다.

### 로컬 소스 사용

개발 중인 코드를 테스트하려면 다음과 같이 빌드한다.

```bash
git clone https://github.com/river-gold/opencode-agy-plugin.git
cd opencode-agy-plugin
bun install
bun run build
bun test
```

설정에서 npm 값을 저장소 경로로, plugin 값을 빌드된 파일 경로로 지정한다.

```jsonc
{
  "plugin": ["/home/USER/workspace/opencode-agy-plugin/dist/plugin.js"],
  "provider": {
    "agy": {
      "npm": "/home/USER/workspace/opencode-agy-plugin",
      "name": "Google Antigravity (via agy CLI)"
    }
  }
}
```

## 권한과 보안

모든 `agy` 호출에는 `--dangerously-skip-permissions`가 사용된다. `agy`가 변경한 파일과 실행하는 명령은 OpenCode의 권한 확인 프롬프트를 거치지 않는다. OpenCode의 시스템 지침, 도구 기록, 파일 파트는 `agy`로 전달되지 않는다. 신뢰할 수 있는 작업 공간과 신뢰할 수 있는 요청에서만 이 플러그인을 사용한다. 이는 현재 플러그인의 의도된 동작이다.

## 모델과 variant

### 자동 모델 목록

모델을 직접 적지 않으면 플러그인이 `agy models`를 실행해 목록을 만든다.

- 동일한 prefix를 가진 ID가 2개 이상이면 마지막 `-` 뒤 문자열을 variant로 묶음
- 예: `gemini-3.7-flash-high`, `gemini-3.7-flash-low` → `gemini-3.7-flash`의 `high`, `low`
- 하나만 존재하는 모델 ID는 원래 ID 그대로 표시
- 자동 목록은 `~/.cache/opencode-agy-plugin/models.json`에 24시간 캐시
- 수동 `models` 항목이 하나라도 있으면 자동 검색과 캐시 사용을 건너뜀

자동 목록은 계정, 지역, `agy` 버전에 따라 달라질 수 있다.

### 수동 모델 설정

모델 목록을 고정하거나 variant 이름을 직접 정하려면 `models`를 설정한다.

```jsonc
{
  "provider": {
    "agy": {
      "npm": "opencode-agy-plugin",
      "models": {
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash",
          "variants": {
            "high": { "model": "gemini-3.7-flash-high" },
            "low": { "model": "gemini-3.7-flash-low" }
          }
        }
      }
    }
  }
}
```

variant에 `model`을 지정하면 해당 원본 ID를 `agy --model`로 전달한다. `--effort`는 추가하지 않는다.

`model` 없이 variant만 지정하면 선택한 variant가 `agy --effort`로 전달된다.

```jsonc
"variants": {
  "high": {},
  "low": {}
}
```

## 모델 선택 문제

모델이 보이지 않으면 다음을 확인한다.

1. `agy models`가 모델을 반환하는지 확인한다.
2. 수동 `models` 설정이 있다면 실제 `agy` 모델 ID인지 확인한다.
3. 자동 목록 캐시를 삭제하고 OpenCode를 재시작한다.

```bash
rm ~/.cache/opencode-agy-plugin/models.json
```

`agy` 인증이 만료됐거나 모델 목록을 가져오지 못하면 자동 목록이 갱신되지 않을 수 있다.
