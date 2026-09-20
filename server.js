require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { QUESTIONS, COMPETENCIES } = require("./data/questions");

const PORT = process.env.PORT || 3000;
const AI_PROVIDER = process.env.AI_PROVIDER || "gemini"; // 'gemini' | 'groq'
const MAX_AI_MESSAGES = parseInt(process.env.MAX_AI_MESSAGES || "20", 10);
// 영역을 선택하면 그 영역의 문항 수 × 문항당 분 만큼 시험 시간이 정해지되,
// 아무리 문항이 많아도 영역당 최대 이 값(분)을 넘지 않는다.
const EXAM_MINUTES_PER_QUESTION = parseInt(process.env.EXAM_MINUTES_PER_QUESTION || "12", 10);
const EXAM_MAX_MINUTES = parseInt(process.env.EXAM_MAX_MINUTES || "30", 10);
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ANSWER_LENGTH = 6000;

const provider = require(`./providers/${AI_PROVIDER}`);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 세션별 남은 AI 호출 횟수 (메모리 저장, 서버 재시작 시 초기화됨)
const sessions = new Map();

function publicQuestions() {
  return QUESTIONS.map(({ id, domain, domainColor, type, title, scenario, task }) => ({
    id,
    domain,
    domainColor,
    type,
    title,
    scenario,
    task,
  }));
}

app.get("/api/config", (req, res) => {
  res.json({
    examMinutesPerQuestion: EXAM_MINUTES_PER_QUESTION,
    examMaxMinutes: EXAM_MAX_MINUTES,
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

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "세션이 유효하지 않습니다. 페이지를 새로고침해 주세요." });
    }
    // 서버리스 환경에서는 요청마다 다른 인스턴스가 처리할 수 있어
    // /api/session/init을 처리한 인스턴스와 메모리가 공유되지 않을 수 있다.
    // 세션이 없으면 거부하는 대신 새로 등록해 계속 진행한다.
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { remaining: MAX_AI_MESSAGES, createdAt: Date.now() });
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

function scoreToGrade(percentage) {
  if (percentage >= 95) return "A+";
  if (percentage >= 90) return "A";
  if (percentage >= 85) return "B+";
  if (percentage >= 80) return "B";
  if (percentage >= 75) return "C+";
  if (percentage >= 70) return "C";
  if (percentage >= 65) return "D+";
  if (percentage >= 60) return "D";
  return "F";
}

// 모든 문항을 동일한 5개 역량 기준(COMPETENCIES)으로 채점한다. 문항별 rubric은
// AI에게 "이 문항에서 무엇을 봐야 하는지" 참고 맥락으로만 전달된다.
async function gradeAnswer(question, rawAnswer, chatLog) {
  const answer = typeof rawAnswer === "string" ? rawAnswer.trim().slice(0, MAX_ANSWER_LENGTH) : "";

  if (!answer) {
    return {
      criteria: COMPETENCIES.map((c) => ({
        key: c.key,
        label: c.label,
        score: 0,
        max: 5,
        reason: "답안을 작성하지 않았습니다.",
      })),
      hadError: false,
    };
  }

  try {
    const { scores, reasons } = await provider.grade({
      scenario: question.scenario,
      task: question.task,
      rubricContext: question.rubric,
      competencies: COMPETENCIES,
      chatLog: Array.isArray(chatLog) ? chatLog.slice(-24) : [],
      answer,
    });
    return {
      criteria: COMPETENCIES.map((c, i) => ({
        key: c.key,
        label: c.label,
        score: scores[i],
        max: 5,
        reason: reasons[i],
      })),
      hadError: false,
    };
  } catch (err) {
    console.error("[grade]", question.id, err.message);
    return {
      criteria: COMPETENCIES.map((c) => ({
        key: c.key,
        label: c.label,
        score: 0,
        max: 5,
        reason: "채점 중 오류가 발생했습니다. 평가자의 수동 검토가 필요합니다.",
      })),
      hadError: true,
    };
  }
}

// 문항별 채점 결과를 역량(competency)별로 합산해 막대그래프용 데이터를 만든다.
function buildByCompetency(perQuestion) {
  return COMPETENCIES.map((c) => {
    let score = 0;
    let max = 0;
    perQuestion.forEach((q) => {
      const found = q.criteria.find((cc) => cc.key === c.key);
      if (found) {
        score += found.score;
        max += found.max;
      }
    });
    const percentage = max > 0 ? Math.round((score / max) * 100) : 0;
    return { key: c.key, label: c.label, score, max, percentage };
  });
}

app.post("/api/submit", async (req, res) => {
  try {
    const { sessionId, name, org, domain, answers, chatLogs, startedAt } = req.body || {};
    if (!name || !org) {
      return res.status(400).json({ error: "이름과 소속기관을 입력해 주세요." });
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: "제출할 답안이 없습니다." });
    }

    const graded = await Promise.all(
      answers.map(async (a) => {
        const question = QUESTIONS.find((q) => q.id === Number(a?.questionId));
        if (!question) return null;
        const chatLog = (chatLogs && chatLogs[question.id]) || (chatLogs && chatLogs[String(question.id)]) || [];
        const result = await gradeAnswer(question, a.answer, chatLog);
        const subtotal = result.criteria.reduce((sum, c) => sum + c.score, 0);
        const submax = result.criteria.length * 5;
        return {
          questionId: question.id,
          domain: question.domain,
          title: question.title,
          type: question.type,
          criteria: result.criteria,
          subtotal,
          submax,
          hadError: result.hadError,
        };
      })
    );

    const perQuestion = graded.filter(Boolean);
    const totalScore = perQuestion.reduce((sum, g) => sum + g.subtotal, 0);
    const maxScore = perQuestion.reduce((sum, g) => sum + g.submax, 0);
    // 총점은 언제나 100점 만점으로 환산해 보여준다 (문항 수에 따라 만점 원점수가 달라지므로).
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
    const grade = scoreToGrade(percentage);
    const byCompetency = buildByCompetency(perQuestion);
    const overall = { totalScore, maxScore, percentage, grade };

    const record = {
      sessionId,
      name,
      org,
      domain,
      startedAt,
      submittedAt: new Date().toISOString(),
      answers,
      chatLogs: chatLogs || {},
      grading: { overall, perQuestion, byCompetency },
    };

    // Vercel 등 서버리스 환경은 배포된 코드 디렉터리가 읽기 전용이라 파일 저장이 실패할 수 있다.
    // 저장에 실패해도 응시자의 제출 자체는 막지 않고 로그만 남긴다.
    try {
      const dir = path.join(__dirname, "data", "submissions");
      fs.mkdirSync(dir, { recursive: true });
      const safeNamePart = String(name).replace(/[^\w가-힣-]/g, "_");
      const filename = `${Date.now()}_${safeNamePart}.json`;
      fs.writeFileSync(path.join(dir, filename), JSON.stringify(record, null, 2), "utf-8");
    } catch (writeErr) {
      console.warn("[/api/submit] 제출 파일 저장 실패 (서버리스 환경에서는 정상일 수 있음):", writeErr.message);
    }

    res.json({ ok: true, overall, perQuestion, byCompetency });
  } catch (err) {
    console.error("[/api/submit]", err.message);
    res.status(500).json({ error: "채점 처리 중 오류가 발생했습니다." });
  }
});

// `node server.js`로 직접 실행할 때만 상시 서버를 띄운다.
// Vercel 등 서버리스 환경에서는 이 파일이 require만 되고 listen은 호출되지 않는다.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`사회복지 현장 AI 활용 역량 평가 서버가 http://localhost:${PORT} 에서 실행 중입니다. (AI provider: ${AI_PROVIDER})`);
  });
}

module.exports = app;
