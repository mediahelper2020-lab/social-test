// Google Gemini API 연동 (무료 티어)
// 무료 API 키 발급: https://aistudio.google.com/apikey (신용카드 등록 불필요)
// 문서: https://ai.google.dev/gemini-api/docs/rate-limits (무료 티어 요청 한도 존재)

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// history: [{ role: 'user' | 'ai', text: string }]
async function chat({ systemPrompt, history, message }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const contents = [
    ...history.map((turn) => ({
      role: turn.role === "ai" ? "model" : "user",
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1024,
        // gemini-2.5 계열은 기본적으로 내부 추론(thinking)에 출력 토큰 예산을 많이 소모해
        // 실제 답변이 중간에 잘리는 문제가 있어, 시험용 채팅 응답에서는 thinking을 끈다.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `응답이 차단되었습니다: ${blockReason}` : "AI로부터 빈 응답을 받았습니다.");
  }
  return candidate?.finishReason === "MAX_TOKENS" ? `${text}\n\n(...응답 길이 제한으로 일부 생략됨)` : text;
}

function buildGradingPrompt({ scenario, task, rubricContext, competencies, chatLog, answer }) {
  const rubricList = (rubricContext || []).map((r) => `- ${r}`).join("\n");
  const competencyList = competencies.map((c, i) => `${i + 1}. ${c.label}: ${c.guide}`).join("\n");
  const chatText =
    Array.isArray(chatLog) && chatLog.length > 0
      ? chatLog.map((t) => `${t.role === "ai" ? "[AI]" : "[응시자]"} ${t.text}`).join("\n")
      : "(응시자가 AI와 대화하지 않았음)";

  return `당신은 사회복지 현장 AI 활용 역량 평가의 엄격하지만 공정한 채점위원입니다.

[사례]
${scenario}

[과업]
${task}

[이 문항에서 좋은 답변이 다뤄야 할 내용 (참고용, 직접 채점 기준은 아래 역량 기준을 따를 것)]
${rubricList}

[응시자가 AI와 나눈 대화 기록 — "프롬프트 활용 역량" 채점 시 참고]
${chatText}

[응시자 최종 답안]
${answer}

아래 ${competencies.length}개의 역량 기준 각각에 대해 0~5점(정수)으로 채점하세요.
${competencyList}

채점 기준 가이드:
- 5점: 기준을 충실하고 구체적으로 충족함
- 3~4점: 부분적으로 충족했으나 구체성/근거가 보완 필요함
- 1~2점: 형식적으로만 언급했거나 미흡함
- 0점: 전혀 다루지 않음 (답안이 비어 있거나 무관한 내용인 경우도 0점, "프롬프트 활용 역량"은 AI와 대화하지 않았다면 0점)

반드시 아래 JSON 형식으로만, 다른 설명 없이 응답하세요:
{"scores": [정수, 정수, ...], "reasons": ["한 문장 이유", "한 문장 이유", ...]}
scores와 reasons 배열의 길이는 반드시 ${competencies.length}이어야 하며, 순서는 위 역량 기준 순서와 동일해야 합니다.`;
}

function clampScore(n) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num)) return 0;
  return Math.min(5, Math.max(0, num));
}

function parseGradingJson(text, count) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        // fall through, handled below
      }
    }
  }
  if (!parsed || !Array.isArray(parsed.scores)) {
    throw new Error("채점 응답을 JSON으로 해석하지 못했습니다.");
  }
  const scores = Array.from({ length: count }, (_, i) => clampScore(parsed.scores[i]));
  const reasons = Array.from({ length: count }, (_, i) =>
    String(parsed.reasons?.[i] ?? "").slice(0, 300)
  );
  return { scores, reasons };
}

// competencies: [{label, guide}] (5개 고정 역량 기준) / rubricContext: string[] (문항별 참고 맥락)
// chatLog: [{role:'user'|'ai', text}] / answer: 응시자 답안 텍스트
// 반환: { scores: number[](0~5), reasons: string[] } (competencies와 같은 길이/순서)
async function grade({ scenario, task, rubricContext, competencies, chatLog, answer }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGradingPrompt({ scenario, task, rubricContext, competencies, chatLog, answer });

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini 채점 API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    throw new Error("채점 응답이 비어 있습니다.");
  }
  return parseGradingJson(text, competencies.length);
}

function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function buildGenerationPrompt({ label, brief, docHint }) {
  return `당신은 "사회복지현장 AI 역량 시험"의 출제위원입니다. 아래 현장 정보를 참고하여 이 현장에
맞는 실전 시험 문항 3개를 새로 출제하세요. 이미 출제된 적 있는 문항과 겹치지 않도록, 매번 다른
구체적인 상황(나이, 정황, 갈등의 디테일)을 만들어야 합니다.

[현장]
${label}

[현장 설명]
${brief}

[이 현장에서 실제 반복 작성하는 문서 종류 (문항 3 출제에 참고)]
${docHint}

문항 구성 규칙:
1. 문항 1, 2: 이 현장에서 실제로 벌어질 법한 구체적인 위기·갈등·딜레마 상황을 다루는 사례형 문항.
   두 문항은 서로 다른 종류의 문제를 다뤄야 한다(예: 하나는 안전/위기개입, 다른 하나는 관계/갈등
   조정처럼 - 정확히 이 예시를 따를 필요는 없고 현장에 맞게 다양화할 것). scenario에는 응시자가
   처한 상황을 3~6문장으로 구체적으로 서술하고, task에는 AI 어시스트와 논의해서 수행할 구체적
   과업을 2~4문장으로 제시한다(예: "(1)...평가, (2)...전략, (3)...계획을 도출하시오" 형식).
2. 문항 3: 위 "이 현장에서 실제 반복 작성하는 문서 종류" 중 하나를 골라, 실제 작성된 것처럼 보이는
   구체적인 예시 문서를 scenario 안에 "[예시 문서]" 블록으로 포함시키고(항목별 실제 값이 채워진
   형태), task에는 "이 예시처럼 반복 작성해야 하는 상황이다. 담당자의 비정형 메모만 입력하면 AI가
   이 형식대로 문서를 자동 작성하도록 맞춤 지침(커스텀 인스트럭션)을 설계하시오. 지침에는 (1)
   문서의 고정 항목, (2) 항목을 구분해 정리하는 기준, (3) 개인정보·민감정보 처리 주의사항이
   포함되어야 한다"는 취지의 과업을 제시한다.
3. 모든 사례 속 인물은 실명 대신 성+OO 형태로 비식별화하라(예: 김OO, 최OO). 나이·성별 등은
   구체적으로 표기해도 된다.
4. 진부하거나 뻔한 소재를 피하고, 매번 새로운 조합의 구체적 디테일(나이, 상황, 실제 대사 인용 등)을
   사용하라.

각 문항 객체는 다음 3개 필드만 가진다:
- title: 문항 제목 (12~22자, 문항 3의 제목 앞에는 "[문서 자동화] "를 붙일 것)
- scenario: 사례 설명 (문항 3은 예시 문서 블록 포함, 줄바꿈은 \\n으로 표기)
- task: 응시자가 수행할 구체적 과업

반드시 아래 JSON 형식으로만, 다른 설명 없이 응답하세요:
{"questions":[{"title":"...","scenario":"...","task":"..."},{"title":"...","scenario":"...","task":"..."},{"title":"...","scenario":"...","task":"..."}]}
questions 배열의 길이는 반드시 3이어야 하며, 순서대로 문항 1, 2, 3입니다.`;
}

function validateGeneratedQuestions(parsed) {
  if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length !== 3) {
    throw new Error("출제 응답 형식이 올바르지 않습니다.");
  }
  return parsed.questions.map((q, i) => {
    const title = String(q?.title || "").trim().slice(0, 80);
    const scenario = String(q?.scenario || "").trim().slice(0, 4000);
    const task = String(q?.task || "").trim().slice(0, 2000);
    if (!title || !scenario || !task) {
      throw new Error(`문항 ${i + 1}의 내용이 비어 있습니다.`);
    }
    return { type: i === 2 ? "document" : "scenario", title, scenario, task };
  });
}

// label/brief/docHint: data/domains.js의 현장 프로필. 반환: [{type, title, scenario, task}] (3개)
async function generateQuestions({ label, brief, docHint }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGenerationPrompt({ label, brief, docHint });

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        maxOutputTokens: 3500,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini 출제 API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    throw new Error("출제 응답이 비어 있습니다.");
  }
  return validateGeneratedQuestions(extractJsonObject(text));
}

module.exports = { chat, grade, generateQuestions };
