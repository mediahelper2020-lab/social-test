# 사회복지 현장 AI 활용 역량 평가

사회복지 현장(아동복지·노인복지·장애인복지·청소년복지·정신건강·장기요양기관) 취업 준비생을 위한
**AI 활용 역량 평가 웹앱**입니다. 응시자가 영역을 하나 선택하면 그 영역의 실전 사례 문제만으로
시험이 구성되고, 오른쪽 AI 어시스트와 실제로 대화하며 문제를 해결하는 과정을 평가합니다.

## 구성

- 시작 화면: 이름/소속 입력 + 6개 영역(아동복지·노인복지·장애인복지·청소년복지·정신건강·장기요양기관) 중 선택
- 각 영역은 문항 3개로 구성 — 실전 사례형 2개 + **문서 자동화 맞춤지침 설계 1개**
  (예시 문서를 보여주고, 그 문서를 AI가 자동으로 작성하도록 하는 커스텀 지침을 직접 설계하는 문항)
- 왼쪽/가운데: 문항 사례, 과업, 최종 답안 작성, 타이머, 문항 이동
- 오른쪽: 실제 AI와 대화할 수 있는 채팅 패널 (무료 AI API 연동)
- 제출 후: 문항별 평가 관점(자기 점검 rubric) 확인 + 답안/대화기록 다운로드(.txt)

## 1. 설치

```bash
npm install
cp .env.example .env
```

## 2. 무료 AI API 키 발급 (택 1)

카드 등록 없이 무료로 사용 가능한 두 가지 중 하나를 선택하세요.

### 옵션 A. Google Gemini (기본값, 추천)
1. https://aistudio.google.com/apikey 접속 후 구글 계정으로 로그인
2. "Create API key" 클릭 → 키 복사
3. `.env` 파일에 입력:
   ```
   AI_PROVIDER=gemini
   GEMINI_API_KEY=발급받은키
   ```
- 무료 티어: 분당/일당 요청 한도가 있으나 교육/시험용으로 충분합니다.

### 옵션 B. Groq (Gemini 대체용, 응답 속도 빠름)
1. https://console.groq.com/keys 접속 후 로그인
2. "Create API Key" → 키 복사
3. `.env` 파일에 입력:
   ```
   AI_PROVIDER=groq
   GROQ_API_KEY=발급받은키
   ```

## 3. 실행

```bash
npm start
```

브라우저에서 http://localhost:3000 접속

## 4. 주요 설정 (.env)

| 변수 | 설명 | 기본값 |
|---|---|---|
| `AI_PROVIDER` | `gemini` 또는 `groq` | `gemini` |
| `EXAM_MINUTES_PER_QUESTION` | 문항 1개당 제한 시간(분). 실제 시험 시간 = 선택 영역의 문항 수 × 이 값 | `12` |
| `MAX_AI_MESSAGES` | 응시자 1인당 전체 시험에서 AI에게 보낼 수 있는 최대 메시지 수 | `40` |
| `PORT` | 서버 포트 | `3000` |

## 5. 영역/문항 수정·추가

`data/questions.js`에 영역별로 문항이 묶여 있습니다. 각 문항은 `domain`(영역명, 선택 화면과
연동), `domainColor`(영역 색상), `type`(`"scenario"` 실전 사례형 / `"document"` 문서 자동화
지침 설계형), 사례(`scenario`), 과업(`task`), AI 페르소나 지시문(`aiSystemPrompt`), 평가
관점(`rubric`)으로 구성됩니다. 새 영역을 추가하려면 같은 형식으로 문항 객체를 배열에 추가하면
되고, 선택 화면의 영역 버튼은 문항 데이터의 `domain` 값을 기준으로 자동 생성됩니다(별도 코드
수정 불필요).

## 6. 제출 데이터

응시자가 제출하면 `data/submissions/`에 이름+타임스탬프로 JSON 파일이 저장됩니다
(답안 전문 + AI 대화 기록 포함, 평가자가 검토용으로 확인 가능). 이 폴더는 `.gitignore`에
포함되어 있어 커밋되지 않습니다.

## 7. 배포 시 참고

- API 키가 서버에서만 사용되므로(브라우저에 노출되지 않음) 안전합니다.
- Render, Railway, Fly.io 등 상시 실행형 Node.js 호스팅은 `server.js`를 그대로 배포하면 됩니다.
- 배포 시 환경변수(`GEMINI_API_KEY` 등)를 호스팅 서비스의 환경변수 설정에 등록하세요.

### Vercel 배포

Vercel은 서버리스 환경이라 `app.listen()`으로 상시 실행되는 서버를 그대로 인식하지 못합니다.
이를 위해 `api/index.js`(서버리스 함수 진입점)와 `vercel.json`(모든 요청을 그 함수로 라우팅)을
이미 포함해 두었으니 별도 설정 없이 배포하면 됩니다.

1. Vercel 프로젝트 생성 후 이 저장소를 연결
2. **Project Settings → Environment Variables**에서 아래 값을 등록 (Production/Preview 모두)
   ```
   AI_PROVIDER=gemini
   GEMINI_API_KEY=발급받은키
   ```
   `.env` 파일은 로컬 전용이며 Vercel에는 올라가지 않으므로, 반드시 대시보드에서 직접 등록해야 합니다.
3. 환경변수를 등록/수정한 뒤에는 **Redeploy**를 한 번 더 실행해야 반영됩니다.
4. 참고: 서버리스 특성상
   - `/api/submit` 제출 기록(`data/submissions/`)은 파일로 저장되지 않습니다(읽기 전용 파일시스템). 필요하면 추후 DB(Vercel KV, Supabase 등) 연동을 고려하세요.
   - 응시자별 "AI 대화 가능 횟수" 카운트는 인스턴스별 메모리에 저장되어 정확히 전역으로 합산되지 않을 수 있습니다(교육/내부용으로는 충분한 수준).
