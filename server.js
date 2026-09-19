require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { QUESTIONS } = require("./data/questions");

const PORT = process.env.PORT || 3000;
const AI_PROVIDER = process.env.AI_PROVIDER || "gemini"; // 'gemini' | 'groq'
const MAX_AI_MESSAGES = parseInt(process.env.MAX_AI_MESSAGES || "40", 10);
const EXAM_MINUTES = parseInt(process.env.EXAM_MINUTES || "60", 10);
const MAX_MESSAGE_LENGTH = 2000;

const provider = require(`./providers/${AI_PROVIDER}`);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 세션별 남은 AI 호출 횟수 (메모리 저장, 서버 재시작 시 초기화됨)
const sessions = new Map();

function publicQuestions() {
  return QUESTIONS.map(({ id, domain, domainColor, title, scenario, task }) => ({
    id,
    domain,
    domainColor,
    title,
    scenario,
    task,
  }));
}

app.get("/api/config", (req, res) => {
  res.json({
    examMinutes: EXAM_MINUTES,
    maxAiMessages: MAX_AI_MESSAGES,
    provider: AI_PROVIDER,
    aiConfigured: AI_PROVIDER === "gemini" ? !!process.env.GEMINI_API_KEY : !!process.env.GROQ_API_KEY,
  });
});

app.get("/api/questions", (req, res) => {
  res.json({ questions: publicQuestions() });
});

app.post("/api/session/init", (req, res) => {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { remaining: MAX_AI_MESSAGES, createdAt: Date.now() });
  res.json({ sessionId, remaining: MAX_AI_MESSAGES });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, questionId, history, message } = req.body || {};

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: "세션이 유효하지 않습니다. 페이지를 새로고침해 주세요." });
    }
    const question = QUESTIONS.find((q) => q.id === Number(questionId));
    if (!question) {
      return res.status(400).json({ error: "존재하지 않는 문항입니다." });
    }
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "메시지를 입력해 주세요." });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: "메시지가 너무 깁니다." });
    }

    const session = sessions.get(sessionId);
    if (session.remaining <= 0) {
      return res.status(429).json({ error: "AI 대화 가능 횟수를 모두 사용했습니다.", remaining: 0 });
    }

    const safeHistory = Array.isArray(history) ? history.slice(-16) : [];

    const reply = await provider.chat({
      systemPrompt: question.aiSystemPrompt,
      history: safeHistory,
      message: message.trim(),
    });

    session.remaining -= 1;
    res.json({ reply, remaining: session.remaining });
  } catch (err) {
    console.error("[/api/chat]", err.message);
    res.status(500).json({ error: err.message || "AI 응답 중 오류가 발생했습니다." });
  }
});

app.post("/api/submit", (req, res) => {
  try {
    const { sessionId, name, org, answers, chatLogs, startedAt } = req.body || {};
    if (!name || !org) {
      return res.status(400).json({ error: "이름과 소속기관을 입력해 주세요." });
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: "제출할 답안이 없습니다." });
    }

    const record = {
      sessionId,
      name,
      org,
      startedAt,
      submittedAt: new Date().toISOString(),
      answers,
      chatLogs: chatLogs || {},
    };

    const dir = path.join(__dirname, "data", "submissions");
    fs.mkdirSync(dir, { recursive: true });
    const safeNamePart = String(name).replace(/[^\w가-힣-]/g, "_");
    const filename = `${Date.now()}_${safeNamePart}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");

    const rubricByQuestion = Object.fromEntries(QUESTIONS.map((q) => [q.id, { title: q.title, domain: q.domain, rubric: q.rubric }]));

    res.json({ ok: true, rubricByQuestion });
  } catch (err) {
    console.error("[/api/submit]", err.message);
    res.status(500).json({ error: "제출 처리 중 오류가 발생했습니다." });
  }
});

app.listen(PORT, () => {
  console.log(`사회복지 현장 AI 활용 역량 평가 서버가 http://localhost:${PORT} 에서 실행 중입니다. (AI provider: ${AI_PROVIDER})`);
});
