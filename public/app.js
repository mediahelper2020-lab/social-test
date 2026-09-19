(() => {
  const state = {
    sessionId: null,
    config: null,
    allQuestions: [], // 서버에서 받은 전체 문항 (모든 영역)
    domains: [], // [{domain, domainColor, count}]
    selectedDomain: null,
    questions: [], // 선택한 영역으로 필터링된 문항
    currentIndex: 0,
    name: "",
    org: "",
    startedAt: null,
    answers: {}, // questionId -> string
    chatLogs: {}, // questionId -> [{role:'user'|'ai', text}]
    remaining: 0,
    endTime: null,
    timerHandle: null,
    reportText: "",
  };

  const $ = (sel) => document.querySelector(sel);
  const screens = {
    start: $("#screen-start"),
    exam: $("#screen-exam"),
    result: $("#screen-result"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  async function init() {
    try {
      const [configRes, questionsRes] = await Promise.all([
        fetch("/api/config").then((r) => r.json()),
        fetch("/api/questions").then((r) => r.json()),
      ]);
      state.config = configRes;
      state.allQuestions = questionsRes.questions;
      state.domains = buildDomainList(state.allQuestions);
      renderDomainPicker();

      const statusEl = $("#ai-status");
      if (state.config.aiConfigured) {
        statusEl.textContent = `AI 연동 준비 완료 (${state.config.provider})`;
        statusEl.classList.add("ok");
      } else {
        statusEl.textContent = "관리자가 아직 AI API 키를 설정하지 않았습니다. .env 파일의 API 키를 확인해 주세요.";
        statusEl.classList.add("bad");
      }
    } catch (err) {
      $("#ai-status").textContent = "서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";
      $("#ai-status").classList.add("bad");
    }
  }

  function buildDomainList(questions) {
    const map = new Map();
    questions.forEach((q) => {
      if (!map.has(q.domain)) {
        map.set(q.domain, { domain: q.domain, domainColor: q.domainColor, count: 0 });
      }
      map.get(q.domain).count += 1;
    });
    return [...map.values()];
  }

  function renderDomainPicker() {
    const picker = $("#domain-picker");
    picker.innerHTML = "";
    state.domains.forEach((d) => {
      const card = document.createElement("div");
      card.className = "domain-card";
      card.textContent = d.domain;
      card.dataset.domain = d.domain;
      card.addEventListener("click", () => selectDomain(d.domain));
      picker.appendChild(card);
    });
  }

  function selectDomain(domain) {
    state.selectedDomain = domain;
    const info = state.domains.find((d) => d.domain === domain);

    document.querySelectorAll(".domain-card").forEach((card) => {
      const isSelected = card.dataset.domain === domain;
      card.classList.toggle("selected", isSelected);
      card.style.background = isSelected ? info.domainColor : "";
      card.style.borderColor = isSelected ? info.domainColor : "";
    });

    const minutesPerQ = state.config?.examMinutesPerQuestion || 12;
    const totalMinutes = info.count * minutesPerQ;
    $("#domain-hint").textContent = `${domain} · 총 ${info.count}문항 · 제한시간 약 ${totalMinutes}분`;

    $("#btn-start").disabled = false;
  }

  $("#start-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.name = $("#input-name").value.trim();
    state.org = $("#input-org").value.trim();
    if (!state.name || !state.org || !state.selectedDomain) return;

    state.questions = state.allQuestions.filter((q) => q.domain === state.selectedDomain);

    const btn = $("#btn-start");
    btn.disabled = true;
    btn.textContent = "준비 중...";

    try {
      const res = await fetch("/api/session/init", { method: "POST" });
      const data = await res.json();
      state.sessionId = data.sessionId;
      state.remaining = data.remaining;
      state.startedAt = new Date().toISOString();

      state.questions.forEach((q) => {
        state.chatLogs[q.id] = [];
      });

      renderNav();
      loadQuestion(0);
      const minutesPerQ = state.config?.examMinutesPerQuestion || 12;
      startTimer(state.questions.length * minutesPerQ);
      $("#candidate-info").textContent = `${state.name} · ${state.org} · ${state.selectedDomain}`;
      showScreen("exam");
    } catch (err) {
      alert("세션을 시작하지 못했습니다. 다시 시도해 주세요.");
      btn.disabled = false;
      btn.textContent = "시험 시작하기";
    }
  });

  function startTimer(minutes) {
    state.endTime = Date.now() + minutes * 60 * 1000;
    updateTimer();
    state.timerHandle = setInterval(updateTimer, 1000);
  }

  function updateTimer() {
    const msLeft = state.endTime - Date.now();
    const timerEl = $("#timer");
    if (msLeft <= 0) {
      timerEl.textContent = "00:00:00";
      clearInterval(state.timerHandle);
      submitExam(true);
      return;
    }
    const totalSec = Math.floor(msLeft / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    timerEl.textContent = `${h}:${m}:${s}`;
    timerEl.classList.toggle("warn", totalSec <= 300);
  }

  function renderNav() {
    const nav = $("#q-nav-list");
    nav.innerHTML = "";
    state.questions.forEach((q, idx) => {
      const item = document.createElement("div");
      item.className = "q-nav-item";
      item.textContent = idx + 1;
      item.title = `${q.domain} - ${q.title}`;
      item.addEventListener("click", () => loadQuestion(idx));
      nav.appendChild(item);
    });
    refreshNavState();
  }

  function refreshNavState() {
    const items = document.querySelectorAll(".q-nav-item");
    items.forEach((item, idx) => {
      const q = state.questions[idx];
      item.classList.toggle("active", idx === state.currentIndex);
      const answered = (state.answers[q.id] || "").trim().length > 0;
      item.classList.toggle("answered", answered);
    });
  }

  function loadQuestion(idx) {
    // 현재 답안 저장
    saveCurrentAnswer();

    state.currentIndex = idx;
    const q = state.questions[idx];

    $("#q-domain-badge").textContent = q.domain;
    $("#q-domain-badge").style.background = q.domainColor;
    const typeBadge = $("#q-type-badge");
    typeBadge.hidden = q.type !== "document";
    $("#q-title").textContent = q.title;
    $("#q-scenario").textContent = q.scenario;
    $("#q-task").textContent = q.task;
    $("#q-answer").value = state.answers[q.id] || "";

    $("#btn-prev").disabled = idx === 0;
    $("#btn-next").disabled = idx === state.questions.length - 1;

    renderChatMessages(q.id);
    refreshNavState();
    updateRemainingBadge();
  }

  function saveCurrentAnswer() {
    if (!state.questions.length) return;
    const q = state.questions[state.currentIndex];
    if (!q) return;
    state.answers[q.id] = $("#q-answer").value;
  }

  $("#q-answer").addEventListener("input", () => {
    saveCurrentAnswer();
    refreshNavState();
  });

  $("#btn-prev").addEventListener("click", () => {
    if (state.currentIndex > 0) loadQuestion(state.currentIndex - 1);
  });
  $("#btn-next").addEventListener("click", () => {
    if (state.currentIndex < state.questions.length - 1) loadQuestion(state.currentIndex + 1);
  });

  function renderChatMessages(questionId) {
    const box = $("#ai-messages");
    box.innerHTML = "";
    const log = state.chatLogs[questionId] || [];
    if (log.length === 0) {
      appendMessageEl("system", "이 사례에 대해 AI와 자유롭게 논의해 보세요. AI는 답을 대신 정해주지 않고, 함께 생각을 정리해 줍니다.");
    } else {
      log.forEach((turn) => appendMessageEl(turn.role, turn.text));
    }
    box.scrollTop = box.scrollHeight;
  }

  function appendMessageEl(role, text) {
    const box = $("#ai-messages");
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function updateRemainingBadge() {
    $("#ai-remaining").textContent = `${state.remaining}회 남음`;
  }

  $("#ai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#ai-input");
    const message = input.value.trim();
    if (!message) return;
    if (state.remaining <= 0) {
      appendMessageEl("error", "AI 대화 가능 횟수를 모두 사용했습니다.");
      return;
    }

    const q = state.questions[state.currentIndex];
    const historyBefore = [...(state.chatLogs[q.id] || [])];

    state.chatLogs[q.id].push({ role: "user", text: message });
    appendMessageEl("user", message);
    input.value = "";

    const sendBtn = e.target.querySelector("button");
    sendBtn.disabled = true;
    const thinkingEl = appendMessageEl("system", "AI가 답변을 작성 중입니다...");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          questionId: q.id,
          history: historyBefore,
          message,
        }),
      });
      const data = await res.json();
      thinkingEl.remove();

      if (!res.ok) {
        appendMessageEl("error", data.error || "AI 응답 중 오류가 발생했습니다.");
        if (typeof data.remaining === "number") {
          state.remaining = data.remaining;
          updateRemainingBadge();
        }
        return;
      }

      state.chatLogs[q.id].push({ role: "ai", text: data.reply });
      appendMessageEl("ai", data.reply);
      state.remaining = data.remaining;
      updateRemainingBadge();
    } catch (err) {
      thinkingEl.remove();
      appendMessageEl("error", "네트워크 오류로 AI 응답을 받지 못했습니다.");
    } finally {
      sendBtn.disabled = false;
    }
  });

  $("#btn-submit-exam").addEventListener("click", () => {
    if (confirm("답안을 제출하시겠습니까? 제출 후에는 수정할 수 없습니다.")) {
      submitExam(false);
    }
  });

  async function submitExam(auto) {
    clearInterval(state.timerHandle);
    saveCurrentAnswer();

    const answers = state.questions.map((q) => ({
      questionId: q.id,
      domain: q.domain,
      title: q.title,
      scenario: q.scenario,
      task: q.task,
      answer: state.answers[q.id] || "",
    }));

    let rubricByQuestion = {};
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          name: state.name,
          org: state.org,
          startedAt: state.startedAt,
          answers,
          chatLogs: state.chatLogs,
        }),
      });
      const data = await res.json();
      if (res.ok) rubricByQuestion = data.rubricByQuestion || {};
    } catch (err) {
      // 제출 실패해도 결과 화면은 보여주고 로컬 다운로드는 가능하게 함
    }

    renderResult(answers, rubricByQuestion, auto);
    showScreen("result");
  }

  function renderResult(answers, rubricByQuestion, auto) {
    const box = $("#result-rubric");
    box.innerHTML = "";
    if (auto) {
      const notice = document.createElement("p");
      notice.className = "lead";
      notice.textContent = "제한 시간이 종료되어 자동 제출되었습니다.";
      box.appendChild(notice);
    }

    answers.forEach((a, idx) => {
      const rubric = rubricByQuestion[a.questionId];
      const div = document.createElement("div");
      div.className = "rubric-item";
      const rubricHtml = rubric
        ? `<ul>${rubric.rubric.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
        : "";
      div.innerHTML = `<h4>${idx + 1}. [${escapeHtml(a.domain)}] ${escapeHtml(a.title)}</h4>${rubricHtml}`;
      box.appendChild(div);
    });

    state.reportText = buildReportText(answers);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function buildReportText(answers) {
    const lines = [];
    lines.push("사회복지 현장 AI 활용 역량 평가 결과");
    lines.push(`이름: ${state.name}`);
    lines.push(`소속기관/지원분야: ${state.org}`);
    lines.push(`응시 영역: ${state.selectedDomain}`);
    lines.push(`제출 시각: ${new Date().toLocaleString("ko-KR")}`);
    lines.push("");

    answers.forEach((a, idx) => {
      lines.push("=".repeat(60));
      lines.push(`문항 ${idx + 1}. [${a.domain}] ${a.title}`);
      lines.push("-".repeat(60));
      lines.push("[사례]");
      lines.push(a.scenario);
      lines.push("");
      lines.push("[과업]");
      lines.push(a.task);
      lines.push("");
      lines.push("[최종 답안]");
      lines.push(a.answer || "(작성하지 않음)");
      lines.push("");
      lines.push("[AI 대화 기록]");
      const log = state.chatLogs[a.questionId] || [];
      if (log.length === 0) {
        lines.push("(AI와 대화하지 않음)");
      } else {
        log.forEach((turn) => {
          lines.push(`${turn.role === "user" ? "[응시자]" : "[AI]"} ${turn.text}`);
        });
      }
      lines.push("");
    });

    return lines.join("\n");
  }

  $("#btn-download").addEventListener("click", () => {
    const blob = new Blob([state.reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `AI역량평가_${state.name}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  init();
})();
