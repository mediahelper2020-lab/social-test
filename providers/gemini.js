// Google Gemini API 연동 (무료 티어)
// 무료 API 키 발급: https://aistudio.google.com/apikey (신용카드 등록 불필요)
// 문서: https://ai.google.dev/gemini-api/docs/rate-limits (무료 티어 요청 한도 존재)

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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

function buildGradingPrompt({ scenario, task, criteria, answer }) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `당신은 사회복지 현장 AI 활용 역량 평가의 엄격하지만 공정한 채점위원입니다.

[사례]
${scenario}

[과업]
${task}

[응시자 최종 답안]
${answer}

아래 ${criteria.length}개의 평가기준 각각에 대해 0~5점(정수)으로 채점하세요.
${criteriaList}

채점 기준 가이드:
- 5점: 기준을 충실하고 구체적으로 충족함
- 3~4점: 부분적으로 충족했으나 구체성/근거가 보완 필요함
- 1~2점: 형식적으로만 언급했거나 미흡함
- 0점: 전혀 다루지 않음 (답안이 비어 있거나 무관한 내용인 경우도 0점)

반드시 아래 JSON 형식으로만, 다른 설명 없이 응답하세요:
{"scores": [정수, 정수, ...], "reasons": ["한 문장 이유", "한 문장 이유", ...]}
scores와 reasons 배열의 길이는 반드시 ${criteria.length}이어야 하며, 순서는 위 평가기준 순서와 동일해야 합니다.`;
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

// criteria: string[] (평가기준 문구 배열) / answer: 응시자 답안 텍스트
// 반환: { scores: number[](0~5), reasons: string[] } (criteria와 같은 길이/순서)
async function grade({ scenario, task, criteria, answer }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일을 확인하세요.");
  }

  const prompt = buildGradingPrompt({ scenario, task, criteria, answer });

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
  return parseGradingJson(text, criteria.length);
}

module.exports = { chat, grade };
