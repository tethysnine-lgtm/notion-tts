# 📖 노션 → TTS 변환기

노션에 정리한 수업 자료를 가져와서, **Claude로 TTS에 최적화된 문장으로 다듬은 뒤**, **ElevenLabs로 자연스러운 한국어 음성**으로 변환해주는 웹앱입니다. 운전 중 복습 등 "귀로 듣는 공부"에 맞춰 설계했습니다.

## ✨ 주요 기능

- **노션 연동** — 페이지 URL 직접 입력 / Integration으로 접근 가능한 페이지 목록에서 선택 (둘 다 지원)
- **Claude 전처리** (`claude-haiku-4-5`) — 법령 기호(§, ①②③), 조문번호(§382-3 → 상법 제382조의3), 표·목록, 소제목, 영문 약어(cf., e.g.)를 듣기 좋은 문장으로 변환
- **ElevenLabs TTS** — 한국어 지원 `eleven_multilingual_v2` 모델, 2000자 초과 시 자동 청크 분할 후 순차 변환
- **재생 & 다운로드** — 브라우저 인라인 재생, 속도 조절(1x ~ 2x), MP3 다운로드
- **다크모드 · 모바일 친화 UI** — 운전 중 사용을 고려한 큰 버튼

## 🧱 기술 스택

Next.js 14 (App Router) · TypeScript · Tailwind CSS · Vercel

---

## 🚀 설치 및 실행

### 1. 사전 준비

- [Node.js](https://nodejs.org/) 18.17 이상
- Anthropic / ElevenLabs / Notion API 키

### 2. 의존성 설치

```bash
npm install
```

### 3. 환경변수 설정

`.env.local.example`을 복사해서 `.env.local`을 만들고 값을 채웁니다.

```bash
cp .env.local.example .env.local   # Windows PowerShell: copy .env.local.example .env.local
```

```env
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_API_KEY=...
NOTION_API_KEY=secret_...
# (선택) ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID
```

| 변수 | 발급처 |
| --- | --- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → API Keys |
| `ELEVENLABS_API_KEY` | https://elevenlabs.io/app/settings/api-keys |
| `NOTION_API_KEY` | https://www.notion.so/my-integrations |
| `ELEVENLABS_VOICE_ID` | (선택) https://elevenlabs.io/app/voice-library 에서 원하는 음성의 Voice ID |

### 4. 개발 서버 실행

```bash
npm run dev
```

브라우저에서 http://localhost:3000 접속.

---

## 🔗 노션 Integration 연결 방법

API로 노션 페이지를 읽으려면 **Integration을 만들고, 읽으려는 페이지에 연결**해야 합니다.

### 1단계 — Integration 생성

1. https://www.notion.so/my-integrations 접속
2. **New integration** 클릭
3. 이름 입력(예: `TTS Reader`), 워크스페이스 선택
4. **Capabilities**에서 `Read content` 권한 활성화 (충분합니다)
5. 생성 후 표시되는 **Internal Integration Secret**(`secret_...`)을 복사 → `.env.local`의 `NOTION_API_KEY`에 입력

### 2단계 — 페이지에 Integration 연결 (가장 중요!)

> Integration은 **명시적으로 연결한 페이지만** 읽을 수 있습니다. 연결하지 않으면 "내용을 가져오지 못했습니다" 오류가 납니다.

1. 노션에서 읽으려는 **페이지를 엽니다**
2. 우측 상단 **⋯ (더보기)** 클릭
3. 아래로 스크롤해 **연결(Connections)** → **연결 추가**
4. 방금 만든 Integration(예: `TTS Reader`)을 선택
5. 하위 페이지가 있다면 상위 페이지에 한 번만 연결하면 하위 페이지까지 함께 접근됩니다

연결 후 앱의 **"페이지 목록에서 선택"** 탭에서 해당 페이지가 보이면 정상입니다.

---

## ☁️ Vercel 배포

1. 코드를 GitHub 저장소에 푸시합니다.

   ```bash
   git init
   git add .
   git commit -m "init: notion tts app"
   git branch -M main
   git remote add origin https://github.com/<your-id>/<repo>.git
   git push -u origin main
   ```

2. https://vercel.com 에서 **Add New → Project** → 해당 저장소 Import
3. **Environment Variables**에 아래 3개(+선택값)를 추가합니다.
   - `ANTHROPIC_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `NOTION_API_KEY`
   - (선택) `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`
4. **Deploy** 클릭 → 빌드 완료 후 발급된 URL로 접속

> **참고:** TTS 변환은 분량이 많으면 시간이 걸립니다. API 라우트에 `maxDuration`을 지정해 두었으나, 매우 긴 자료의 경우 Vercel 플랜의 함수 실행 시간 제한(Hobby: 최대 60초)을 초과할 수 있습니다. 이 경우 자료를 나눠서 변환하거나 Pro 플랜 사용을 권장합니다.

---

## 📁 프로젝트 구조

```
app/
├── api/
│   ├── notion/route.ts      # 노션 페이지 목록(GET) / 내용 가져오기(POST)
│   ├── preprocess/route.ts  # Claude(haiku-4-5) TTS 전처리
│   └── tts/route.ts         # ElevenLabs 음성 변환 (청크 분할 포함)
├── globals.css
├── layout.tsx
└── page.tsx                 # 메인 UI (3단계 플로우)
```

## 🔧 사용 흐름

1. **내용 가져오기** — URL 입력 또는 목록에서 페이지 선택 → 노션 본문 추출
2. **텍스트 다듬기** — Claude가 TTS용 문장으로 변환 (결과는 직접 수정 가능)
3. **음성 만들기** — ElevenLabs로 변환 → 재생 / 속도 조절 / MP3 다운로드

## ⚠️ 비용 주의

Claude·ElevenLabs API는 사용량 기반 과금입니다. ElevenLabs는 글자 수, Claude는 토큰 단위로 비용이 발생하니 분량이 큰 자료는 주의하세요.
