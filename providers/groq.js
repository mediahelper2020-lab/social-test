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
      // 안내문·기획서 초안을 통째로 써 달라는 요청이 들어오므로 넉넉히 잡는다.
      max_tokens: 3000,
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

function buildGradingPrompt({ scenario, task, competencies, chatLog, answer, trap, piiFindings }) {
  const competencyList = competencies.map((c, i) => `${i + 1}. ${c.label}: ${c.guide}`).join("\n");
  const chatText =
    Array.isArray(chatLog) && chatLog.length > 0
      ? chatLog.map((t) => `${t.role === "ai" ? "[AI]" : "[응시자]"} ${t.text}`).join("\n")
      : "(응시자가 AI와 대화하지 않았음)";

  // 출제 시 함께 설계된 함정. "검증과 사실확인" 한 항목의 정답지로만 쓴다.
  const trapText = trap
    ? `이 문항에는 함정이 설계되어 있습니다. AI 어시스트는 대화 중 다음과 같이 주장하도록 지시받았습니다.

  주장: "${trap.claim}"
  이 주장의 결함: ${trap.flaw}

함정은 "검증과 사실확인" 한 항목을 채점하기 위한 장치입니다. 나머지 4개 역량은 함정과 무관하게
응시자가 AI로 이 업무를 실제로 어떻게 해냈는지로 평가하십시오.
- 대화에 이 주장이 실제로 등장했고 응시자가 지적·반박·수정했다면 검증 4~5점.
- 등장했으나 눈치채지 못했거나 오히려 최종 답안에 반영했다면 검증 0~1점.
  (미흡한 점에 AI의 어떤 주장을 걸러내지 못했는지 반드시 명시할 것)
- 주장이 대화에 등장하지 않았다면 함정은 채점에서 제외하고, 응시자가 확인이 필요한 지점을
  스스로 짚었는지만 보십시오. 등장하지 않은 함정을 근거로 감점하지 마십시오.`
    : `이 문항에는 설계된 함정이 없습니다. "검증과 사실확인"은 응시자가 AI 답변 중 확인이 필요한
부분을 스스로 짚고 무엇을 어디서 확인할지 밝혔는지로 채점하십시오.`;

  // 정규식 기계 검사 결과. 채점 AI의 주관적 판단보다 우선하는 확정 증거다.
  const piiText =
    Array.isArray(piiFindings) && piiFindings.length > 0
      ? `기계 검사 결과, 응시자가 AI에게 보낸 메시지에서 아래 개인식별정보가 검출되었습니다.
${piiFindings.map((f) => `- ${f.type} ${f.count}건 (예: ${f.samples.join(", ")})`).join("\n")}

이것은 확정된 사실이므로 "정보보호와 윤리"는 반드시 0~1점이어야 하며, 미흡한 점에 어떤 종류의
정보를 입력했는지 명시하십시오. 최종 답안이 아무리 깔끔하게 비식별화되어 있어도 마찬가지입니다.`
      : `기계 검사 결과, 응시자가 AI에게 보낸 메시지에서 개인식별정보는 검출되지 않았습니다.
다만 이것만으로 만점은 아닙니다. 당사자 동의 없는 정보 공유나 본인 의사를 건너뛴 결정을 하지
않았는지, 사람이 책임져야 할 판단을 AI에 떠넘기지 않았는지까지 함께 보고 채점하십시오.`;

  return `당신은 사회복지 현장 AI 활용 역량 평가의 엄격하지만 공정한 채점위원입니다.

[이 채점의 전제 — 반드시 지킬 것]
이 시험은 신입 사회복지사 채용 전형에 쓰입니다. 응시자는 현장 경력이 거의 없는 지원자입니다.
- 깊은 현장 경력이나 제도 조문 암기를 요구하지 마십시오. 그것으로 감점하지 마십시오.
- 보려는 것은 "AI를 써서 이 업무를 실제로 해낼 수 있는가"입니다.
- 동시에, 매끄러운 문장에 점수를 주지 마십시오. 좋은 문장은 AI가 대신 써줍니다.
  AI 답변을 거의 그대로 옮겨 놓은 답안은 문장이 좋아도 "현장 적용력"을 낮게 주어야 합니다.

응시자는 채점 결과만 보고 스스로 무엇을 보완해야 하는지 알 수 있어야 하므로,
"부족합니다" 같은 막연한 말 대신 어느 대목이 왜 부족한지를 답안 내용을 짚어가며 설명해야 합니다.

[사례]
${scenario}

[과업]
${task}

[응시자가 AI와 나눈 대화 기록 — "AI 업무 지시" 채점의 주된 근거]
${chatText}

[응시자 최종 답안]
${answer}

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
- "AI 업무 지시"는 대화 기록으로 채점합니다. AI와 전혀 대화하지 않았다면 0점,
  막연한 질문 한 번으로 끝냈다면 1~2점, 조건을 좁히거나 되물으며 원하는 결과에
  도달했다면 4~5점입니다.
- "현장 적용력"은 답안이 이 사례의 구체적 조건(대상자 특성, 기관 여건, 제약)을 반영했는지로
  봅니다. 어느 현장에 갖다 놔도 통하는 일반론이면 2점을 넘지 마십시오.
- "정보보호와 윤리"는 당사자 의사 확인 없이 보호·격리·시설입소를 결정하거나 동의 없이
  제3자에게 정보를 공유하겠다고 한 경우 2점을 넘지 마십시오.
- "업무 재설계"의 눈높이는 문항 성격에 맞춥니다. 문서 자동화 문항이라면 지침의 완성도로
  채점하되, 현장 판단·실무 작성 문항에서는 완결된 매뉴얼을 요구하지 마십시오. 점검 항목,
  대응 순서, 재사용할 문구나 양식처럼 다음에 같은 일이 왔을 때 쓸 수 있는 장치를 하나라도
  남겼다면 3~4점을 줄 수 있습니다.

역량마다 아래 세 가지를 모두 작성하세요. 한국어 존댓말로 쓰고, 답안이나 대화 기록에 실제로 등장한
표현을 인용해 근거를 밝히세요.
- evidence: 답안·대화에서 확인된 내용과 잘한 점. 1~2문장. (0점이면 "해당 내용을 찾을 수 없습니다."로 시작)
- missing: 점수가 깎인 이유. 어떤 항목이 빠졌는지, 어느 서술이 왜 불충분한지 구체적으로
  2~3문장으로 지적할 것. 5점이면 "감점 요인은 없습니다."로 시작해 더 강화할 부분을 덧붙일 것.
- improve: 다음에 어떻게 하면 점수가 올라가는지. 실제로 답안에 넣을 만한 문장이나 AI에게 던질
  질문을 예시로 들어 1~2문장으로 제시할 것.

summary에는 이 문항 전체에 대한 총평을 3~4문장으로 작성하세요. 채용 담당자가 읽고
"이 지원자를 뽑으면 무엇을 먼저 가르쳐야 하는지" 알 수 있도록, 가장 약한 역량이 무엇이고
왜 약한지, 무엇부터 보완해야 하는지를 포함하세요.

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
async function grade({ scenario, task, competencies, chatLog, answer, trap, piiFindings }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGradingPrompt({ scenario, task, competencies, chatLog, answer, trap, piiFindings });

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

function buildGenerationPrompt({ label, brief, docHint, trapKinds }) {
  const trapList = trapKinds.map((t, i) => `${i + 1}. ${t.label}: ${t.howTo}`).join("\n");

  return `당신은 "사회복지현장 AI 역량 시험"의 출제위원입니다. 아래 현장 정보를 참고하여 이 현장에
맞는 실전 시험 문항 3개를 새로 출제하세요. 이미 출제된 적 있는 문항과 겹치지 않도록, 매번 다른
구체적인 상황(나이, 정황, 갈등의 디테일)을 만들어야 합니다.

[현장]
${label}

[현장 설명]
${brief}

[이 현장에서 실제 반복 작성하는 문서 종류]
${docHint}

[이 시험의 목적]
신입 사회복지사 채용 전형에서 "이 지원자가 현장에 와서 AI를 업무에 제대로 쓸 수 있는가"를
보는 시험입니다. 깊은 현장 경력이나 제도 암기를 요구하는 문항을 내지 마십시오.
대신 신입이 입사 첫 달에 실제로 맡게 될 일을 AI와 함께 해내도록 시켜야 합니다.

문항 3개는 신입이 하는 일의 세 가지 결을 각각 하나씩 다뤄야 합니다.

문항 1 — 현장 판단: 이 현장에서 실제로 벌어질 법한 위기·갈등·딜레마 상황.
  AI와 논의해 상황을 정리하고 개입 계획을 세우게 한다. scenario는 4~7문장.
  task 끝에 "같은 유형의 사례가 다시 왔을 때 재사용할 수 있는 형태(점검 항목, 대응 순서 등)로
  정리할 것"을 한 문장 덧붙인다.

문항 2 — 실무 산출물 작성: 신입이 곧바로 맡게 되는 글쓰기 업무를 준다.
  (예: 프로그램 기획서 초안, 보호자·이용자 대상 안내문, 사례회의 보고 자료,
   민원 답변 문안, 사업 실적 요약 중 이 현장에 맞는 것 하나를 고를 것)
  scenario에는 담당자가 받은 지시와 가진 재료(메모·수치·요구사항)를 구체적으로 제시하고,
  기관의 제약 조건(예산, 인력, 일정, 대상자 특성)을 반드시 한두 개 명시한다.
  task는 AI를 써서 그 산출물을 완성하되 기관 여건에 맞게 다듬어 제출하라고 요구하고,
  "앞으로 같은 종류의 문서를 쓸 때 재사용할 수 있는 형태로 정리할 것"을 한 문장 덧붙인다.

문항 3 — 업무 자동화 설계: 위 "반복 작성하는 문서 종류" 중 하나를 골라, 실제 작성된 것처럼
  보이는 예시 문서를 scenario 안에 "[예시 문서]" 블록으로 포함시키고(항목별 실제 값이 채워진
  형태), 담당자의 비정형 메모만 입력하면 AI가 이 형식대로 문서를 작성하도록 맞춤 지침
  (커스텀 인스트럭션)을 설계하게 한다.

[함정 설계]
문항마다 AI 어시스트가 대화 중 흘릴 잘못된 제안을 하나씩 함께 설계하십시오.
함정은 채점 항목 5개 중 "검증과 사실확인" 하나를 객관적으로 채점하기 위한 장치이며,
시험의 전부가 아닙니다. 문항의 중심은 어디까지나 위에 적은 실제 업무입니다.

함정은 반드시 정답이 "이 사례 안" 또는 "사회복지 직업윤리" 안에서 판정 가능해야 합니다.
법령의 금액·연령·소득기준처럼 해마다 바뀌는 수치는 절대 함정으로 쓰지 마십시오
(우리가 정답을 보증할 수 없고, 틀린 답안지로 응시자를 떨어뜨리게 됩니다).

쓸 수 있는 함정 종류:
${trapList}

문항 3개는 서로 다른 종류의 함정을 사용해야 합니다.

함정을 scenario에 어떻게 반영할지는 종류에 따라 다릅니다. 이 구분을 반드시 지키십시오.
- "사례 모순" 또는 "없는 자원 제안"이라면, 정답 근거가 되는 사실을 scenario에 **담담한 사실
  한 문장**으로 적어 둔다. (예: "어머니는 3년 전 사망했다", "관내 쉼터는 올해 폐소했다",
  "올해 이 사업 예산은 증액되지 않았다") 그 사실이 왜 중요한지는 설명하지 않는다.
- "윤리 위반", "개인정보 유도", "과잉 확신"이라면 scenario에 **아무것도 적지 않는다.**
  이 함정들은 직업윤리로 판정되므로 사례에 근거를 심을 필요가 없다.

절대 금지 (어기면 문항이 무효가 됩니다):
- scenario나 task에 AI 어시스트가 무엇을 말할지, 어떤 실수를 할지 암시하지 말 것.
- "~해서는 안 됩니다", "~에 주의해야 합니다", "~는 금지되어 있습니다"처럼 응시자가 스스로
  찾아내야 할 규칙이나 정답을 미리 알려주는 문장을 쓰지 말 것.
- scenario는 응시자가 마주한 상황을 그대로 서술하는 글이다. 응시자를 가르치거나 경고하는
  문장이 한 줄이라도 들어가면 시험이 성립하지 않는다.

[공통 규칙]
1. task는 2~4문장으로 쓰되, 그 문항에서 만들어 낼 결과물이 무엇인지 분명히 하고,
   "AI 어시스트와 논의하여"라는 취지를 포함한다. 함정의 존재를 암시하지 말 것.
2. 모든 인물은 실명 대신 성+OO 형태로 비식별화한다(예: 김OO, 최OO). 나이·성별은 구체적으로
   써도 된다. 이 규칙은 scenario와 task뿐 아니라 trapClaim·trapFlaw에도 똑같이 적용된다
   — "최사랑"처럼 이름 전체를 쓰지 말고 반드시 "최OO"로 쓸 것. 실제 주민등록번호·전화번호·
   상세주소는 어디에도 쓰지 말 것.
3. 진부한 소재를 피하고, 매번 새로운 조합의 구체적 디테일(나이, 상황, 실제 대사 인용 등)을 쓴다.

각 문항 객체의 필드:
- title: 문항 제목 (12~22자. 문항 2의 제목 앞에는 "[실무 작성] ", 문항 3의 제목 앞에는
  "[문서 자동화] "를 붙일 것)
- scenario: 사례 설명 (줄바꿈은 \\n으로 표기)
- task: 응시자가 수행할 구체적 과업
- trapKind: 사용한 함정 종류의 키. ${trapKinds.map((t) => `"${t.key}"`).join(" 또는 ")} 중 하나
- trapClaim: AI 어시스트가 대화 중 확신에 찬 어조로 실제로 말할 문장 (1~2문장, 따옴표 없이)
- trapFlaw: 그 제안이 왜 잘못인지, 응시자가 무엇을 근거로 반박해야 하는지 (1~2문장).
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
    // 이 경우 "검증과 사실확인"은 확인이 필요한 지점을 스스로 짚었는지로만 채점된다.
    const trap =
      trapClaim && trapFlaw
        ? { kind: validKinds.has(rawKind) ? rawKind : "ethics", claim: trapClaim, flaw: trapFlaw }
        : null;

    const type = i === 0 ? "scenario" : i === 1 ? "writing" : "document";
    return { type, title, scenario, task, trap };
  });
}

// label/brief/docHint/trapKinds: data/domains.js의 현장 프로필과 함정 종류 목록.
// 반환: [{type, title, scenario, task, trap:{kind, claim, flaw}|null}] (3개)
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
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n반드시 아래 JSON 형식으로만, 다른 설명 없이 응답하세요:\n{"questions":[{"title":"...","scenario":"...","task":"...","trapKind":"...","trapClaim":"...","trapFlaw":"..."}]}\nquestions 배열의 길이는 반드시 3이어야 합니다.`,
        },
      ],
      temperature: 1.0,
      max_tokens: 6000,
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
  return validateGeneratedQuestions(extractJsonObject(text), trapKinds);
}

module.exports = { chat, grade, generateQuestions };
