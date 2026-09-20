(() => {
  const state = {
    sessionId: null,
    config: null,
    domains: [], // [{key, label, color}]
    selectedDomain: null, // {key, label, color}
    questions: [], // 이번 시험에서 AI가 출제한 문항 3개
    systemPrompt: "", // 이번 시험(현장)의 AI 채팅 코치 페르소나
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
    loading: $("#screen-loading"),
    result: $("#screen-result"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  function showLoading(title, desc) {
    $("#loading-title").textContent = title;
    $("#loading-desc").textContent = desc;
    $("#loading-desc").hidden = false;
    $("#loading-error").hidden = true;
    showScreen("loading");
  }

  function showLoadingError(message, onRetry) {
    $("#loading-desc").hidden = true;
    const errBox = $("#loading-error");
    errBox.hidden = false;
    errBox.querySelector(".lead").textContent = message;
    const retryBtn = $("#btn-loading-retry");
    retryBtn.onclick = onRetry;
  }

  async function init() {
    try {
      const [configRes, domainsRes] = await Promise.all([
        fetch("/api/config").then((r) => r.json()),
        fetch("/api/domains").then((r) => r.json()),
      ]);
      state.config = configRes;
      state.domains = domainsRes.domains;
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

  function renderDomainPicker() {
    const picker = $("#domain-picker");
    picker.innerHTML = "";
    state.domains.forEach((d) => {
      const card = document.createElement("div");
      card.className = "domain-card";
      card.textContent = d.label;
      card.dataset.key = d.key;
      card.addEventListener("click", () => selectDomain(d));
      picker.appendChild(card);
    });
  }

  function computeExamMinutes(questionCount) {
    const minutesPerQ = state.config?.examMinutesPerQuestion || 12;
    const maxMinutes = state.config?.examMaxMinutes || 30;
    return Math.min(questionCount * minutesPerQ, maxMinutes);
  }

  function selectDomain(domain) {
    state.selectedDomain = domain;

    document.querySelectorAll(".domain-card").forEach((card) => {
      const isSelected = card.dataset.key === domain.key;
      card.classList.toggle("selected", isSelected);
      card.style.background = isSelected ? domain.color : "";
      card.style.borderColor = isSelected ? domain.color : "";
    });

    const totalMinutes = computeExamMinutes(3);
    $("#domain-hint").textContent = `${domain.label} · 총 3문항(AI 실시간 출제) · 제한시간 ${totalMinutes}분`;

    $("#btn-start").disabled = false;
  }

  $("#start-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.name = $("#input-name").value.trim();
    state.org = $("#input-org").value.trim();
    if (!state.name || !state.org || !state.selectedDomain) return;

    try {
      const res = await fetch("/api/session/init", { method: "POST" });
      const data = await res.json();
      state.sessionId = data.sessionId;
      state.remaining = data.remaining;
      state.startedAt = new Date().toISOString();
    } catch (err) {
      alert("세션을 시작하지 못했습니다. 다시 시도해 주세요.");
      return;
    }

    await generateAndStart();
  });

  async function generateAndStart() {
    const domain = state.selectedDomain;
    showLoading(
      "AI가 맞춤 문제를 출제하고 있습니다...",
      `${domain.label} 현장에 맞는 시험 문항 3개를 새로 준비하는 중입니다. 10~30초 정도 걸릴 수 있습니다.`
    );

    try {
      const res = await fetch("/api/generate-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "문제를 출제하지 못했습니다.");

      state.questions = data.questions;
      state.systemPrompt = data.systemPrompt;
      state.answers = {};
      state.chatLogs = {};
      state.questions.forEach((q) => {
        state.chatLogs[q.id] = [];
      });

      renderNav();
      loadQuestion(0);
      startTimer(computeExamMinutes(state.questions.length));
      $("#candidate-info").textContent = `${state.name} · ${state.org} · ${domain.label}`;
      showScreen("exam");
    } catch (err) {
      showLoadingError(err.message || "문제를 출제하지 못했습니다. 다시 시도해 주세요.", generateAndStart);
    }
  }

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
          systemPrompt: state.systemPrompt,
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
      type: q.type,
      scenario: q.scenario,
      task: q.task,
      answer: state.answers[q.id] || "",
    }));

    showLoading("AI가 답안을 채점하고 있습니다...", "문항별 평가기준에 따라 세부 점수를 산정하는 중입니다. 잠시만 기다려 주세요.");

    let overall = null;
    let perQuestion = null;
    let byCompetency = null;
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          name: state.name,
          org: state.org,
          domain: state.selectedDomain?.label,
          startedAt: state.startedAt,
          answers,
          chatLogs: state.chatLogs,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        overall = data.overall;
        perQuestion = data.perQuestion;
        byCompetency = data.byCompetency;
      }
    } catch (err) {
      // 채점 서버 호출이 실패해도 결과 화면은 보여주고 로컬 다운로드는 가능하게 함
    }

    renderResult(answers, overall, perQuestion, byCompetency, auto);
    showScreen("result");
  }

  function gradeClass(grade) {
    if (grade.startsWith("A")) return "grade-a";
    if (grade.startsWith("B")) return "grade-b";
    if (grade.startsWith("C")) return "grade-c";
    if (grade.startsWith("D")) return "grade-d";
    return "grade-f";
  }

  function renderResult(answers, overall, perQuestion, byCompetency, auto) {
    const notice = $("#result-notice");
    if (auto) {
      notice.hidden = false;
      notice.textContent = "제한 시간이 종료되어 자동 제출되었습니다.";
    } else {
      notice.hidden = true;
    }

    const badge = $("#grade-badge");
    if (overall) {
      badge.textContent = overall.grade;
      badge.className = `grade-badge ${gradeClass(overall.grade)}`;
      $("#score-percentage").textContent = overall.percentage;
      $("#score-total-num").textContent = overall.totalScore;
      $("#score-total-max").textContent = overall.maxScore;
    } else {
      badge.textContent = "-";
      badge.className = "grade-badge";
      $("#score-percentage").textContent = "-";
      $("#score-total-num").textContent = "-";
      $("#score-total-max").textContent = "-";
    }

    renderCompetencyChart(byCompetency);

    const box = $("#result-breakdown");
    box.innerHTML = "";

    if (!perQuestion) {
      const div = document.createElement("div");
      div.className = "breakdown-item";
      div.textContent = "채점 서버 응답을 받지 못했습니다. 네트워크 상태를 확인한 뒤 아래에서 답안을 다운로드해 평가자에게 직접 전달해 주세요.";
      box.appendChild(div);
    } else {
      perQuestion.forEach((q, idx) => {
        const div = document.createElement("div");
        div.className = "breakdown-item";
        const rowsHtml = q.criteria
          .map((c) => {
            const isPrivacy = c.key === "deidentification";
            return `<div class="criterion-row${isPrivacy ? " criterion-privacy" : ""}">
              <div class="criterion-score">${c.score}/${c.max}</div>
              <div class="criterion-body"><span class="criterion-label">${escapeHtml(isPrivacy ? "🔒 " + c.label : c.label)}</span>${escapeHtml(c.reason || "")}</div>
            </div>`;
          })
          .join("");
        div.innerHTML = `<div class="breakdown-item-head">
            <h4>${idx + 1}. [${escapeHtml(q.domain)}] ${escapeHtml(q.title)}</h4>
            <span class="breakdown-subscore">${q.subtotal} / ${q.submax}점</span>
          </div>${rowsHtml}`;
        box.appendChild(div);
      });
    }

    state.reportText = buildReportText(answers, overall, perQuestion, byCompetency);
  }

  function renderCompetencyChart(byCompetency) {
    const chart = $("#competency-chart");
    const tableBody = $("#competency-table-body");
    chart.innerHTML = "";
    tableBody.innerHTML = "";

    if (!byCompetency || byCompetency.length === 0) {
      chart.innerHTML = '<p class="lead">채점 데이터를 받지 못해 역량별 그래프를 표시할 수 없습니다.</p>';
      return;
    }

    const fills = [];
    byCompetency.forEach((c) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML = `
        <div class="bar-row-label">${escapeHtml(c.label)}</div>
        <div class="bar-row-track"><div class="bar-row-fill" style="width:0%"></div></div>
        <div class="bar-row-value">${c.percentage}</div>
      `;
      chart.appendChild(row);
      fills.push({ el: row.querySelector(".bar-row-fill"), percentage: c.percentage });

      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(c.label)}</td><td>${c.percentage} / 100</td>`;
      tableBody.appendChild(tr);
    });

    // 바가 0%에서 목표치까지 자라나는 애니메이션이 실행되도록, 삽입 직후가 아니라
    // 한 프레임 뒤에 목표 너비를 지정한다(같은 프레임에 지정하면 트랜지션 없이 바로 채워짐).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fills.forEach(({ el, percentage }) => {
          el.style.width = `${percentage}%`;
        });
      });
    });
  }

  $("#btn-toggle-table").addEventListener("click", () => {
    const chart = $("#competency-chart");
    const table = $("#competency-table");
    const toBar = !table.hidden;
    table.hidden = toBar;
    chart.hidden = !toBar;
    $("#btn-toggle-table").textContent = toBar ? "표로 보기" : "그래프로 보기";
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function buildReportText(answers, overall, perQuestion, byCompetency) {
    const lines = [];
    lines.push("사회복지현장 AI 역량 시험 결과");
    lines.push(`이름: ${state.name}`);
    lines.push(`소속기관/지원분야: ${state.org}`);
    lines.push(`응시 영역: ${state.selectedDomain?.label || ""}`);
    lines.push(`제출 시각: ${new Date().toLocaleString("ko-KR")}`);
    if (overall) {
      lines.push(`총점: ${overall.percentage} / 100점 (등급 ${overall.grade}, 원점수 ${overall.totalScore}/${overall.maxScore})`);
    }
    if (byCompetency && byCompetency.length > 0) {
      lines.push("");
      lines.push("[역량별 점수 (100점 환산)]");
      byCompetency.forEach((c) => {
        lines.push(`- ${c.label}: ${c.percentage}/100 (원점수 ${c.score}/${c.max})`);
      });
    }
    lines.push("");

    answers.forEach((a, idx) => {
      const g = perQuestion?.find((p) => p.questionId === a.questionId);
      lines.push("=".repeat(60));
      lines.push(`문항 ${idx + 1}. [${a.domain}] ${a.title}${g ? ` — ${g.subtotal}/${g.submax}점` : ""}`);
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
      if (g) {
        lines.push("[채점 세부내역]");
        g.criteria.forEach((c) => {
          const isPrivacy = c.key === "deidentification";
          lines.push(`- ${isPrivacy ? "[개인정보 비식별 처리] " : `[${c.label}] `}${c.score}/${c.max}점 — ${c.reason || ""}`);
        });
        lines.push("");
      }
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
