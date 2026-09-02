<p align="right">
  <a href="README.md">English</a> | <strong>한국어</strong> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>


<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>Claude, OpenAI Codex, 자체 호스팅 vLLM / SGLang 엔드포인트에서 동작하는 터미널 코딩 에이전트.</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

> 이 문서는 영어 [README.md](README.md)의 번역본입니다. 내용이 다르면 영어 버전이 기준입니다.

## 설치

**Bun으로 설치** (PATH에 Bun 1.4 이상 필요):

```sh
bun install -g vibrato-cli
vib --version
```

**독립 실행 바이너리** (Bun 불필요), Linux(x64/arm64), macOS(arm64/x64), Windows(x64) 지원:

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.16.0/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
```

Windows (PowerShell):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.16.0/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

다른 설치 방법:

```sh
# 항상 최신 설치기 (main 브랜치의 변경 가능한 스크립트를 실행)
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh

# 기존 설치를 제자리에서 업데이트
vib update
```

지원 플랫폼 전체, 나이틀리 채널, 셸 자동완성, 소스 빌드: [docs/install.md](docs/install.md).

## 첫 실행

아무 git 체크아웃 안에서 `vib`를 실행하세요. 설정된 프로바이더가 없는 첫 실행에서는 프로바이더 메뉴가 자동으로 열립니다. 같은 메뉴는 언제든 `/provider`로 열 수 있습니다.

- **vLLM / SGLang** (자체 호스팅, OpenAI 호환): *Connect a vLLM endpoint* 또는 *Connect an SGLang endpoint*를 고르고 서버 URL과 API 키(선택)를 입력하면 서버에서 모델 목록을 가져옵니다. 인증 없는 로컬 서버라면 키를 비워 두세요.
- **Claude** 또는 **OpenAI Codex** (구독 플랜): `/login`에서 `anthropic`, `openai-codex`(브라우저), `openai-codex-device`(헤드리스) 중 하나를 고릅니다.

셸에서 같은 설정을 하려면:

```sh
vib setup provider --preset vllm --base-url http://HOST:8000/v1      # 키는 VLLM_API_KEY에서 읽음(있을 때)
vib setup provider --preset sglang --base-url http://HOST:30000/v1   # 키는 SGLANG_API_KEY에서 읽음(있을 때)
```

localhost, 사설망 호스트, `.local` / `.internal` / `.lan` 이름에는 평문 `http://`를 허용하고, 공개 호스트에는 `https://`가 필요합니다.

## 사용법

```sh
vib                                        # 현재 체크아웃에서 대화형 세션
vib "src/의 .ts 파일을 모두 나열해줘"        # 첫 프롬프트와 함께 대화형 세션
vib @prompt.md @screenshot.png "설명해줘"   # @로 파일이나 이미지를 첨부
vib -p "이 저장소를 요약해줘"                # 비대화형: 답만 출력하고 종료
vib --continue                             # 직전 세션 이어가기
vib --resume                               # 이전 세션 선택
vib --worktree my-task                     # 격리된 git 워크트리에서 작업
vib --tmux                                 # tmux 기반 세션으로 실행
vib --model opus "이 모듈을 리팩터링해줘"     # 모델을 퍼지 이름으로 선택
vib --list-models                          # 사용 가능한 모델 표시
```

세션 안에서:

| 명령 | 역할 |
| :--- | :--- |
| `/provider` | vLLM 또는 SGLang 엔드포인트 연결 |
| `/login` | Claude 또는 OpenAI Codex 로그인 |
| `/model` | 활성 모델 전환 |
| `/theme` | TUI 테마 전환 |
| `/skill:deep-interview` | 계획 전에 모호한 요구사항 명확화 |
| `/skill:ralplan` | 파일을 바꾸기 전에 계획 수립과 비평 |
| `/help` | 모든 슬래시 명령 목록 |

자주 쓰는 CLI 명령:

```sh
vib --help                  # 모든 플래그
vib setup --help            # 프로바이더와 자격증명 설정
vib customize doctor        # 도구·스킬·훅·MCP 서버가 로드되지 않는 이유 진단
vib config set <key> <val>  # 셸에서 설정 변경
vib update                  # 최신 릴리즈로 업데이트
```

어두운 터미널의 기본 TUI 테마는 LIG System CI를 적용한 `lig-blue`이고, 밝은 터미널은 번들된 `lig-white`가 기본입니다. 명시적으로 지정한 테마 설정이 항상 우선합니다.

## 문서

- [설치, 업데이트 채널, 플랫폼별 안내](docs/install.md)
- [모델, 프로바이더, 인증](docs/models.md)
- [커스텀 프로바이더와 다중 계정 라우팅](docs/custom-providers-and-multi-account.md)
- [스킬](docs/skills.md)
- [디자인 시스템](docs/design-system.md)
- [외부 컨트롤러 / 봇 연동](docs/bot-integration.md): Telegram, Discord, Slack 또는 자체 봇으로 Vibrato 제어
- [외부 제어 준비도](docs/external-control-readiness.md)
- [Aside 검색/컨텍스트 사이드카](docs/aside-integration.md)
- [코드베이스 개요](docs/codebase-overview.md) 및 [docs/](docs/)의 나머지 문서

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요. 과거 기여 출처는 [NOTICE.md](NOTICE.md)에 있습니다.
