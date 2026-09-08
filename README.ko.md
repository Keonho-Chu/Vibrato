<p align="right">
  <a href="README.md">English</a> | <strong>한국어</strong> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>


<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>로컬 LLM 엔드포인트, Claude, OpenAI Codex에서 동작하는 터미널 코딩 에이전트.</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

> 이 문서는 영어 [README.md](README.md)의 번역본입니다. 내용이 다르면 영어 버전이 기준입니다.

## 설치

**독립 실행 바이너리** (권장, Bun 불필요), Linux(x64/arm64), macOS(arm64/x64), Windows(x64) 지원:

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
```

Windows (PowerShell, "관리자 권한으로 실행"이 아닌 일반 터미널에서):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

Vibrato는 세션을 `%USERPROFILE%\.vib` 아래에 저장하는데, 관리자 권한 터미널에서 만들어진 폴더는 본인이 아니라 Administrators 그룹 소유가 됩니다. Vibrato가 시작할 때 소유권을 되찾아 오지만, 처음부터 일반 터미널에서 실행하면 그 과정 자체가 필요 없습니다. 자세한 내용과 Git Bash 요구사항은 [Windows notes](docs/install.md#windows-notes)를 보십시오.

**Bun으로 설치** (PATH에 Bun 1.4 이상이 이미 있어야 합니다. `bun install -g`가 Bun을 대신 설치해 주지는 않습니다):

```sh
bun install -g vibrato-cli
vib --version
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

아무 git 체크아웃 안에서 `vib`를 실행하세요. 사용 가능한 모델이 없는 첫 실행에서는 하나의 연결 화면이 바로 열립니다. Esc를 누르면 전체 프로바이더 메뉴로 넘어갑니다. 같은 화면은 언제든 `/provider`로 열 수 있습니다.

- **로컬 LLM 엔드포인트** (vLLM, SGLang, Ollama, LM Studio, llama.cpp 등 OpenAI 호환 서버라면 무엇이든): LLM 서버는 보통 네트워크상의 다른 머신, 예를 들어 LAN의 GPU 박스입니다. 그 주소를 입력하고 연결하기만 하면 됩니다. `192.168.0.10:8000`이나 `gpu-server.lan:8000`처럼 축약해서 입력해도 되며, 스킴과 `/v1` 경로는 Vibrato가 채워 줍니다. 사설망 주소와 `.local` / `.internal` / `.lan` 주소는 평문 `http://`, 그 외에는 `https://`로 추론합니다. 이것은 기본값일 뿐이라 스킴을 직접 적으면 그대로 사용하므로, 사내망이 다른 대역에서 GPU 서버를 평문 http로 서비스한다면 `http://172.170.0.52:8000`처럼 적으면 됩니다. 별도의 API 키 입력 단계는 없습니다. Vibrato가 먼저 엔드포인트를 탐색하고, 서버가 401이나 403을 응답할 때만 키 입력란을 보여줍니다. 부가적인 편의로, 내 컴퓨터에서 잘 알려진 루프백 포트(Ollama, llama.cpp, LM Studio, oMLX, vLLM, SGLang)로 이미 실행 중인 호환 서버가 있다면 같은 화면에 선택 가능한 항목으로도 표시됩니다. 연결되면 서버가 보고한 모델 중에서 고르면 되고, 발견된 모델이 하나뿐이면 자동으로 선택됩니다.
- **Claude** 또는 **OpenAI Codex** (구독 플랜, 로컬 엔드포인트의 대안): `/login`에서 `anthropic`, `openai-codex`(브라우저), `openai-codex-device`(헤드리스) 중 하나를 고릅니다.

셸에서 같은 설정을 하려면:

```sh
vib setup provider --preset local --base-url http://192.168.0.10:8000/v1   # 예: LAN의 GPU 박스; 키는 LOCAL_LLM_API_KEY에서 읽음(있을 때)
```

`vllm`과 `sglang` 프리셋은 이미 이를 사용하는 스크립트나 CI를 위해 계속 제공됩니다:

```sh
vib setup provider --preset vllm --base-url http://192.168.0.10:8000/v1    # 키는 VLLM_API_KEY에서 읽음(있을 때)
vib setup provider --preset sglang --base-url http://192.168.0.10:30000/v1 # 키는 SGLANG_API_KEY에서 읽음(있을 때)
```

`http://`나 `https://`를 직접 적으면 어떤 호스트든 그대로 사용합니다. 스킴 없이 `host:port`만 적었을 때만 추론하며, localhost, 사설망 호스트, 단순 호스트 이름, `.local` / `.internal` / `.lan` 이름은 평문 `http://`, 그 외에는 `https://`입니다.

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
| `/provider` | 연결 화면 열기(로컬 LLM 엔드포인트, 대안으로 OpenAI Codex/Claude) |
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
