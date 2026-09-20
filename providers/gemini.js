// Google Gemini API 연동 (무료 티어)
// 무료 API 키 발급: https://aistudio.google.com/apikey (신용카드 등록 불필요)
// 문서: https://ai.google.dev/gemini-api/docs/rate-limits
//
// [왜 모델을 작업별로 나누는가]
// 무료 티어의 일일 요청 한도는 "모델별로" 따로 계산된다
// (quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier).
// 이 프로젝트에서 실측한 값은 모델당 하루 20회다.
// 응시자 한 명이 시험을 한 번 치르면 출제 1회 + AI 대화 최대 20회 + 채점 3회를 쓰는데,
// 셋이 같은 모델을 쓰면 대화를 많이 한 응시자는 정작 마지막 채점에서 429를 맞는다.
// (응시자 화면에는 "채점 중 오류가 발생했습니다"로 보였던 문제가 이것이다.)
// 그래서 작업마다 다른 모델을 앞에 세우고, 한도가 차거나 모델이 과부하면 다음 모델로 자동 전환한다.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// 앞의 모델이 막히면 순서대로 시도할 공통 후보군.
const FALLBACK_MODELS = [
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
];

function modelChain(envName, preferred) {
  const fromEnv = (name) =>
    (process.env[name] || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  // GEMINI_MODEL은 예전 설정과의 호환을 위해 모든 작업의 1순위로 둔다.
  // 다만 작업별로 모델을 나누는 편이 한도를 훨씬 오래 쓰므로, 되도록 비워두는 쪽을 권한다.
  const chain = [...fromEnv("GEMINI_MODEL"), ...fromEnv(envName), ...preferred, ...FALLBACK_MODELS];
  return [...new Set(chain)];
}

// 채점은 판단 품질이 가장 중요하고 호출 수는 적으므로 좋은 모델을 앞에 둔다.
const GRADE_MODELS = modelChain("GEMINI_GRADE_MODEL", ["gemini-3.5-flash"]);
// 대화는 호출 수가 가장 많으므로 가볍고 한도 소모가 덜 아까운 모델을 앞에 둔다.
const CHAT_MODELS = modelChain("GEMINI_CHAT_MODEL", ["gemini-3.1-flash-lite"]);
// 출제는 응시자당 1회뿐이라 별도 모델을 써서 다른 작업의 한도를 건드리지 않게 한다.
const GENERATE_MODELS = modelChain("GEMINI_GENERATE_MODEL", ["gemini-2.5-flash"]);

if (process.env.GEMINI_MODEL) {
  console.warn(
    "[gemini] GEMINI_MODEL이 설정되어 있어 대화·출제·채점이 모두 같은 모델부터 시도합니다.\n" +
      "          무료 티어 한도는 모델별로 따로 계산되므로, 이 값을 지우면 작업마다 다른 모델을 써서\n" +
      "          하루에 받을 수 있는 응시자 수가 늘어납니다."
  );
}

// 이 오류들은 모델을 바꾸면 풀릴 수 있다 (한도 초과 / 과부하 / 일시적 서버 오류).
function shouldTryNextModel(status, message) {
  if (status === 429 || status === 503 || status === 500) return true;
  return /overload|high demand|unavailable/i.test(message || "");
}

async function callOnce(model, body, apiKey) {
  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini API 오류 (${res.status}): ${errText.slice(0, 200)}`);
    err.status = res.status;
    err.tryNextModel = shouldTryNextModel(res.status, errText);
    // 일부 최신 모델은 thinkingConfig를 아예 받지 않아 400을 돌려준다.
    err.thinkingRejected = res.status === 400 && !!body.generationConfig?.thinkingConfig;
    throw err;
  }
  return res.json();
}

// models 목록을 순서대로 시도한다. 쓸 수 있는 모델이 하나도 없으면 마지막 오류를 던진다.
async function callGemini(models, body, label) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  let lastErr;
  for (const model of models) {
    try {
      return await callOnce(model, body, apiKey);
    } catch (err) {
      if (err.thinkingRejected) {
        // thinkingConfig만 빼고 같은 모델로 한 번 더 시도한다.
        const { thinkingConfig, ...rest } = body.generationConfig;
        try {
          return await callOnce(model, { ...body, generationConfig: rest }, apiKey);
        } catch (retryErr) {
          lastErr = retryErr;
          if (!retryErr.tryNextModel) throw retryErr;
        }
      } else {
        lastErr = err;
        if (!err.tryNextModel) throw err;
      }
      console.warn(`[gemini/${label}] ${model} 사용 불가 → 다음 모델로 전환 (${lastErr.message.slice(0, 90)})`);
    }
  }
  throw lastErr;
}

// history: [{ role: 'user' | 'ai', text: string }]
async function chat({ systemPrompt, history, message }) {
  const contents = [
    ...history.map((turn) => ({
      role: turn.role === "ai" ? "model" : "user",
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const data = await callGemini(
    CHAT_MODELS,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1024,
        // gemini-2.5 계열은 기본적으로 내부 추론(thinking)에 출력 토큰 예산을 많이 소모해
        // 실제 답변이 중간에 잘리는 문제가 있어, 시험용 채팅 응답에서는 thinking을 끈다.
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    "chat"
  );

  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `응답이 차단되었습니다: ${blockReason}` : "AI로부터 빈 응답을 받았습니다.");
  }
  return candidate?.finishReason === "MAX_TOKENS" ? `${text}\n\n(...응답 길이 제한으로 일부 생략됨)` : text;
}

function buildGradingPrompt({ scenario, task, competencies, chatLog, answer, aiLog, trap, piiFindings }) {
  const competencyList = competencies.map((c, i) => `${i + 1}. ${c.label}: ${c.guide}`).join("\n");
  const chatText =
    Array.isArray(chatLog) && chatLog.length > 0
      ? chatLog.map((t) => `${t.role === "ai" ? "[AI]" : "[응시자]"} ${t.text}`).join("\n")
      : "(응시자가 AI와 대화하지 않았음)";

  // 출제 시 함께 설계된 함정. 채점의 정답지 역할을 한다.
  const trapText = trap
    ? `이 문항에는 함정이 설계되어 있습니다. AI 어시스트는 대화 중 다음과 같이 주장하도록 지시받았습니다.

  주장: "${trap.claim}"
  이 주장의 결함: ${trap.flaw}

"검증 역량" 채점 방법:
- 위 대화 기록에 이 주장이 실제로 등장했는지 먼저 확인하십시오.
- 등장했고 응시자가 이를 지적·반박·수정했다면 4~5점.
- 등장했으나 응시자가 눈치채지 못했거나, 오히려 그 제안을 최종 답안에 반영했다면 0~1점.
  (이 경우 미흡한 점에 AI의 어떤 주장을 걸러내지 못했는지 반드시 명시할 것)
- 주장이 대화에 등장하지 않았다면 함정은 채점에서 제외하고, 응시자가 "무엇을 어디서 확인하겠다"고
  스스로 밝혔는지만 보고 채점하십시오. 이때 등장하지 않은 함정을 근거로 감점하지 마십시오.`
    : `이 문항에는 설계된 함정이 없습니다. "검증 역량"은 응시자가 AI의 제안 중 확인이 필요한 부분을
스스로 짚고 "무엇을 어디서 확인하겠다"고 밝혔는지로만 채점하십시오.`;

  // 정규식 기계 검사 결과. 채점 AI의 주관적 판단보다 우선하는 확정 증거다.
  const piiText =
    Array.isArray(piiFindings) && piiFindings.length > 0
      ? `기계 검사 결과, 응시자가 AI에게 보낸 메시지에서 아래 개인식별정보가 검출되었습니다.
${piiFindings.map((f) => `- ${f.type} ${f.count}건 (예: ${f.samples.join(", ")})`).join("\n")}

이것은 확정된 사실이므로 "정보보호 실행"은 반드시 0~1점이어야 하며, 미흡한 점에 어떤 종류의
정보를 입력했는지 명시하십시오. 최종 답안이 아무리 깔끔하게 비식별화되어 있어도 마찬가지입니다.`
      : `기계 검사 결과, 응시자가 AI에게 보낸 메시지에서 개인식별정보는 검출되지 않았습니다.
다만 이것만으로 만점은 아닙니다. 실명을 그대로 쓰지 않았는지, 소속기관·질병명 등으로 개인이
특정될 여지는 없는지, 문서 자동화 지침에 개인정보 규칙을 넣었는지까지 함께 보고 채점하십시오.`;

  return `당신은 사회복지 현장 AI 활용 역량 평가의 엄격하지만 공정한 채점위원입니다.
이 시험이 보려는 것은 "좋은 답안을 썼는가"가 아니라 "AI를 쓰면서 사고를 내지 않았는가"입니다.
좋은 최종 답안은 AI가 대신 써줄 수 있으므로, 문장이 매끄럽다는 이유로 점수를 주지 마십시오.

응시자는 채점 결과만 보고 스스로 무엇을 보완해야 하는지 알 수 있어야 하므로,
"부족합니다" 같은 막연한 말 대신 어느 대목이 왜 부족한지를 답안 내용을 짚어가며 설명해야 합니다.

[사례]
${scenario}

[과업]
${task}

[응시자가 AI와 나눈 대화 기록]
${chatText}

[응시자 최종 답안]
${answer}

[응시자가 작성한 AI 활용 기록 — AI에게 맡긴 것 / 본인이 판단한 것 / 확인이 필요한 것]
${aiLog || "(작성하지 않음)"}

[함정 정답지]
${trapText}

[개인정보 기계 검사 결과]
${piiText}

아래 ${competencies.length}개의 역량 기준 각각에 대해 0~5점(정수)으로 채점하세요.
${competencyList}

점수 기준:
- 5점: 기준을 충실하고 구체적으로 충족함
- 3~4점: 방향은 맞으나 구체성·근거가 부족함
- 1~2점: 형식적으로만 언급했거나 현저히 미흡함
- 0점: 전혀 다루지 않음 (답안이 비어 있거나 과업과 무관한 경우도 0점)

추가 채점 원칙:
- "AI 사용 경계 판단"은 AI 활용 기록이 비어 있으면 최대 2점을 넘지 마십시오.
  무엇을 AI에게 맡겼고 무엇을 본인이 판단했는지 설명할 수 없다면 현장에서 책임을 질 수 없습니다.
- "당사자 권익 보호"는 당사자 의사 확인 없이 보호·격리·시설입소를 결정하거나, 동의 없이
  제3자에게 정보를 공유하겠다고 한 경우 2점을 넘지 마십시오.
- AI와 전혀 대화하지 않았다면 "검증 역량"은 0~1점입니다.

역량마다 아래 세 가지를 모두 작성하세요. 한국어 존댓말로 쓰고, 답안이나 대화 기록에 실제로 등장한
표현을 인용해 근거를 밝히세요.
- evidence: 답안·대화에서 확인된 내용과 잘한 점. 1~2문장. (0점이면 "해당 내용을 찾을 수 없습니다."로 시작)
- missing: 점수가 깎인 이유. 어떤 항목이 빠졌는지, 어느 서술이 왜 불충분한지 구체적으로
  2~3문장으로 지적할 것. 5점이면 "감점 요인은 없습니다."로 시작해 더 강화할 부분을 덧붙일 것.
- improve: 다음에 어떻게 하면 점수가 올라가는지. 실제로 답안에 넣을 만한 문장이나 행동을
  예시로 들어 1~2문장으로 제시할 것.

summary에는 이 문항 전체에 대한 총평을 3~4문장으로 작성하세요. 함정이 대화에 등장했다면
응시자가 그것을 걸러냈는지 여부를 반드시 언급하고, 가장 점수가 낮은 역량이 무엇이며 우선 무엇부터
보완해야 하는지를 포함하세요.

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
async function grade({ scenario, task, competencies, chatLog, answer, aiLog, trap, piiFindings }) {
  const prompt = buildGradingPrompt({ scenario, task, competencies, chatLog, answer, aiLog, trap, piiFindings });

  const data = await callGemini(
    GRADE_MODELS,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        // 역량 5개 × (확인된 내용 + 미흡한 점 + 보완 방법) + 총평이라 출력이 길다.
        // 예산이 모자라면 JSON이 중간에 잘려 파싱에 실패하므로 넉넉히 잡는다.
        maxOutputTokens: 6000,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: GRADING_SCHEMA,
      },
    },
    "grade"
  );

  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(`채점 응답이 비어 있습니다.${reason ? ` (${reason})` : ""}`);
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
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

function buildGenerationPrompt({ label, brief, docHint, trapKinds }) {
  const trapList = trapKinds.map((t, i) => `${i + 1}. ${t.label}: ${t.howTo}`).join("\n");

  return `당신은 "사회복지현장 AI 역량 시험"의 출제위원입니다. 아래 현장 정보를 참고하여 이 현장에
맞는 실전 시험 문항 3개를 새로 출제하세요. 이미 출제된 적 있는 문항과 겹치지 않도록, 매번 다른
구체적인 상황(나이, 정황, 갈등의 디테일)을 만들어야 합니다.

[현장]
${label}

[현장 설명]
${brief}

[이 현장에서 실제 반복 작성하는 문서 종류 (문항 3 출제에 참고)]
${docHint}

이 시험은 응시자가 "AI를 얼마나 잘 쓰는가"가 아니라 "AI를 쓸 때 사고를 내지 않는가"를 봅니다.
그래서 문항마다 AI 어시스트가 대화 중에 흘릴 **함정**을 함께 설계해야 합니다.

[함정 설계 규칙 — 가장 중요]
함정은 반드시 정답이 "이 사례 안" 또는 "사회복지 직업윤리" 안에서 판정 가능해야 합니다.
법령의 금액·연령·소득기준처럼 해마다 바뀌는 수치는 **절대 함정으로 쓰지 마십시오**
(우리가 정답을 보증할 수 없고, 틀린 답안지로 응시자를 떨어뜨리게 됩니다).

쓸 수 있는 함정 종류:
${trapList}

문항 3개는 서로 다른 종류의 함정을 사용해야 합니다.

문항 구성 규칙:
1. 문항 1, 2: 이 현장에서 실제로 벌어질 법한 구체적인 위기·갈등·딜레마 상황을 다루는 사례형 문항.
   두 문항은 서로 다른 종류의 문제를 다뤄야 한다(예: 하나는 안전/위기개입, 다른 하나는 관계/갈등
   조정처럼 - 정확히 이 예시를 따를 필요는 없고 현장에 맞게 다양화할 것). scenario에는 응시자가
   처한 상황을 4~7문장으로 구체적으로 서술한다. 함정이 "사례 모순"이나 "없는 자원 제안"이라면,
   그 함정의 정답 근거가 되는 사실(예: "어머니는 3년 전 사망했다", "관내 쉼터는 올해 폐소했다")을
   scenario 안에 반드시 명시해 두어야 한다.
2. 문항 3: 위 "이 현장에서 실제 반복 작성하는 문서 종류" 중 하나를 골라, 실제 작성된 것처럼 보이는
   구체적인 예시 문서를 scenario 안에 "[예시 문서]" 블록으로 포함시키고(항목별 실제 값이 채워진
   형태), task에는 담당자의 비정형 메모만 입력하면 AI가 이 형식대로 문서를 자동 작성하도록 맞춤
   지침(커스텀 인스트럭션)을 설계하라는 과업을 제시한다.
3. task는 2~4문장으로 쓰되, 반드시 아래 세 가지를 모두 요구해야 한다:
   (1) 이 상황에서 수행할 구체적인 판단·개입·설계 내용
   (2) AI 어시스트와 논의하되 AI의 제안 중 그대로 따르면 안 되는 부분을 찾아낼 것
   (3) AI에게 맡길 일과 사람이 판단해야 할 일을 구분할 것
4. 모든 사례 속 인물은 실명 대신 성+OO 형태로 비식별화하라(예: 김OO, 최OO). 나이·성별 등은
   구체적으로 표기해도 된다. scenario에 실제 주민등록번호·전화번호·상세주소를 쓰지 말 것.
5. 진부하거나 뻔한 소재를 피하고, 매번 새로운 조합의 구체적 디테일(나이, 상황, 실제 대사 인용 등)을
   사용하라.

각 문항 객체의 필드:
- title: 문항 제목 (12~22자, 문항 3의 제목 앞에는 "[문서 자동화] "를 붙일 것)
- scenario: 사례 설명 (줄바꿈은 \\n으로 표기)
- task: 응시자가 수행할 구체적 과업 (위 3번 규칙을 반영)
- trapKind: 사용한 함정 종류의 키. ${trapKinds.map((t) => `"${t.key}"`).join(" 또는 ")} 중 하나
- trapClaim: AI 어시스트가 대화 중 확신에 찬 어조로 실제로 말할 문장 (1~2문장, 따옴표 없이)
- trapFlaw: 그 제안이 왜 잘못인지, 그리고 응시자가 무엇을 근거로 반박해야 하는지 (1~2문장).
  채점 기준으로 쓰이므로 사례의 어느 문장 또는 어떤 윤리 원칙과 충돌하는지 명확히 밝힐 것`;
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

function validateGeneratedQuestions(parsed, trapKinds) {
  const arr = pickQuestionArray(parsed);
  if (!arr || arr.length < 3) {
    throw new Error("출제 응답 형식이 올바르지 않습니다.");
  }
  const validKinds = new Set(trapKinds.map((t) => t.key));

  return arr.slice(0, 3).map((q, i) => {
    const title = String(q?.title || "").trim().slice(0, 80);
    const scenario = String(q?.scenario || "").trim().slice(0, 4000);
    const task = String(q?.task || "").trim().slice(0, 2000);
    if (!title || !scenario || !task) {
      throw new Error(`문항 ${i + 1}의 내용이 비어 있습니다.`);
    }

    const trapClaim = String(q?.trapClaim || "").trim().slice(0, 600);
    const trapFlaw = String(q?.trapFlaw || "").trim().slice(0, 600);
    const rawKind = String(q?.trapKind || "").trim();
    // 함정이 제대로 나오지 않아도 문항 자체는 쓸 수 있으므로 출제를 실패시키지는 않는다.
    // 이 경우 검증 역량은 "확인이 필요한 지점을 스스로 짚었는가"로만 채점된다.
    const trap =
      trapClaim && trapFlaw
        ? { kind: validKinds.has(rawKind) ? rawKind : "ethics", claim: trapClaim, flaw: trapFlaw }
        : null;

    return { type: i === 2 ? "document" : "scenario", title, scenario, task, trap };
  });
}

// label/brief/docHint/trapKinds: data/domains.js의 현장 프로필과 함정 종류 목록.
// 반환: [{type, title, scenario, task, trap:{kind, claim, flaw}|null}] (3개)
async function generateQuestions({ label, brief, docHint, trapKinds }) {
  const prompt = buildGenerationPrompt({ label, brief, docHint, trapKinds });

  const data = await callGemini(
    GENERATE_MODELS,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.0,
        maxOutputTokens: 6000,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        // 스키마를 함께 넘기면 모델이 구조를 지키도록 강제된다(작은 모델일수록 효과가 크다).
        responseSchema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  scenario: { type: "string" },
                  task: { type: "string" },
                  trapKind: { type: "string" },
                  trapClaim: { type: "string" },
                  trapFlaw: { type: "string" },
                },
                required: ["title", "scenario", "task", "trapKind", "trapClaim", "trapFlaw"],
              },
            },
          },
          required: ["questions"],
        },
      },
    },
    "generate"
  );

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    throw new Error("출제 응답이 비어 있습니다.");
  }
  return validateGeneratedQuestions(extractJsonObject(text), trapKinds);
}

module.exports = { chat, grade, generateQuestions };
