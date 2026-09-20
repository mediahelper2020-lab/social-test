// Groq API 연동 (무료 티어, OpenAI 호환 방식)
// 무료 API 키 발급: https://console.groq.com/keys (신용카드 등록 불필요)
// 문서: https://console.groq.com/docs/rate-limits

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// history: [{ role: 'user' | 'ai', text: string }]
async function chat({ systemPrompt, history, message }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((turn) => ({
      role: turn.role === "ai" ? "assistant" : "user",
      content: turn.text,
    })),
    { role: "user", content: message },
  ];

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("AI로부터 빈 응답을 받았습니다.");
  return text;
}

function buildGradingPrompt({ scenario, task, competencies, chatLog, answer }) {
  const competencyList = competencies.map((c, i) => `${i + 1}. ${c.label}: ${c.guide}`).join("\n");
  const chatText =
    Array.isArray(chatLog) && chatLog.length > 0
      ? chatLog.map((t) => `${t.role === "ai" ? "[AI]" : "[응시자]"} ${t.text}`).join("\n")
      : "(응시자가 AI와 대화하지 않았음)";

  return `당신은 사회복지 현장 AI 활용 역량 평가의 엄격하지만 공정한 채점위원입니다.
응시자는 채점 결과만 보고 스스로 무엇을 보완해야 하는지 알 수 있어야 하므로,
"부족합니다" 같은 막연한 말 대신 어느 대목이 왜 부족한지를 답안 내용을 짚어가며 설명해야 합니다.

[사례]
${scenario}

[과업]
${task}

[응시자가 AI와 나눈 대화 기록 — "프롬프트 활용 역량" 채점 시 근거로 삼을 것]
${chatText}

[응시자 최종 답안]
${answer}

아래 ${competencies.length}개의 역량 기준 각각에 대해 0~5점(정수)으로 채점하세요.
${competencyList}

점수 기준:
- 5점: 기준을 충실하고 구체적으로 충족함
- 3~4점: 방향은 맞으나 구체성·근거가 부족함
- 1~2점: 형식적으로만 언급했거나 현저히 미흡함
- 0점: 전혀 다루지 않음 (답안이 비어 있거나 과업과 무관한 경우도 0점.
  "프롬프트 활용 역량"은 위 대화 기록이 "(응시자가 AI와 대화하지 않았음)"이면 0점)

역량마다 아래 세 가지를 모두 작성하세요. 한국어 존댓말로 쓰고, 답안에 실제로 등장한
표현이나 항목을 인용해 근거를 밝히세요.
- evidence: 답안에서 확인된 내용과 잘한 점. 1~2문장. (0점이면 "해당 내용을 찾을 수 없습니다." 로 시작)
- missing: 점수가 깎인 이유. 어떤 항목이 빠졌는지, 어느 서술이 왜 불충분한지 구체적으로
  2~3문장으로 지적할 것. 5점이면 "감점 요인은 없습니다."로 시작해 더 강화할 부분을 덧붙일 것.
- improve: 다음에 어떻게 쓰면 점수가 올라가는지. 실제로 답안에 넣을 만한 문장이나 항목을
  예시로 들어 1~2문장으로 제시할 것.

summary에는 이 문항 전체에 대한 총평을 3~4문장으로 작성하세요. 가장 점수가 낮은 역량이
무엇이고 그것이 왜 낮은지, 우선 무엇부터 보완해야 하는지를 포함하세요.

items 배열의 길이는 반드시 ${competencies.length}이어야 하며, 순서는 위 역량 기준 순서와 같아야 합니다.`;
}

const GRADING_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          score: { type: "integer" },
          evidence: { type: "string" },
          missing: { type: "string" },
          improve: { type: "string" },
        },
        required: ["score", "evidence", "missing", "improve"],
      },
    },
  },
  required: ["summary", "items"],
};

function clampScore(n) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num)) return 0;
  return Math.min(5, Math.max(0, num));
}

// 모델이 items 대신 다른 키를 쓰거나 배열을 그대로 주는 경우까지 받아준다.
function pickGradingArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  for (const key of ["items", "criteria", "results", "scores", "역량"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return Object.values(parsed).find((v) => Array.isArray(v)) || null;
}

function parseGradingJson(text, count) {
  const parsed = extractJsonObject(text);
  const arr = pickGradingArray(parsed);
  if (!arr || arr.length === 0) {
    throw new Error("채점 응답을 JSON으로 해석하지 못했습니다.");
  }
  const items = Array.from({ length: count }, (_, i) => {
    const it = arr[i] || {};
    return {
      score: clampScore(typeof it === "number" ? it : it.score),
      evidence: String(it.evidence || "").trim().slice(0, 500),
      missing: String(it.missing || it.reason || "").trim().slice(0, 700),
      improve: String(it.improve || "").trim().slice(0, 500),
    };
  });
  return { summary: String(parsed?.summary || "").trim().slice(0, 900), items };
}

// competencies: [{label, guide}] (5개 고정 역량 기준)
// chatLog: [{role:'user'|'ai', text}] / answer: 응시자 답안 텍스트
// 반환: { summary, items: [{score(0~5), evidence, missing, improve}] }
//        items는 competencies와 같은 길이·순서.
async function grade({ scenario, task, competencies, chatLog, answer }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGradingPrompt({ scenario, task, competencies, chatLog, answer });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n반드시 아래 JSON 형식으로만 응답하세요:\n${JSON.stringify(GRADING_SCHEMA)}`,
        },
      ],
      temperature: 0.2,
      // 역량 5개 × (확인된 내용 + 미흡한 점 + 보완 방법) + 총평이라 출력이 길다.
      max_tokens: 6000,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq 채점 API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const text = choice?.message?.content || "";
  if (!text) throw new Error("채점 응답이 비어 있습니다.");
  if (choice?.finish_reason === "length") {
    throw new Error("채점 응답이 길이 제한으로 잘렸습니다.");
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

// 모델이 배열을 바로 주거나 키 이름을 다르게 쓰는 경우까지 받아준다.
function pickQuestionArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  for (const key of ["questions", "items", "data", "문항"]) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  const firstArray = Object.values(parsed).find((v) => Array.isArray(v));
  return firstArray || null;
}

function validateGeneratedQuestions(parsed) {
  const arr = pickQuestionArray(parsed);
  if (!arr || arr.length < 3) {
    throw new Error("출제 응답 형식이 올바르지 않습니다.");
  }
  return arr.slice(0, 3).map((q, i) => {
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
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGenerationPrompt({ label, brief, docHint });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 1.0,
      max_tokens: 3500,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq 출제 API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("출제 응답이 비어 있습니다.");
  return validateGeneratedQuestions(extractJsonObject(text));
}

module.exports = { chat, grade, generateQuestions };
