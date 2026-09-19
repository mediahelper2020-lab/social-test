// Google Gemini API 연동 (무료 티어)
// 무료 API 키 발급: https://aistudio.google.com/apikey (신용카드 등록 불필요)
// 문서: https://ai.google.dev/gemini-api/docs/rate-limits (무료 티어 요청 한도 존재)

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
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
      generationConfig: { temperature: 0.6, maxOutputTokens: 800 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API 오류 (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `응답이 차단되었습니다: ${blockReason}` : "AI로부터 빈 응답을 받았습니다.");
  }
  return text;
}

module.exports = { chat };
