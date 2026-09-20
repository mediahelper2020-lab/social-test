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
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGradingPrompt({ scenario, task, rubricContext, competencies, chatLog, answer });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq 채점 API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("채점 응답이 비어 있습니다.");
  return parseGradingJson(text, competencies.length);
}

module.exports = { chat, grade };
