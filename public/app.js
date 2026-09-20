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
    // 시험 중 이탈 감시. 브라우저는 탭 닫기나 다른 탭 열기를 웹페이지가 막을 수 없으므로,
    // 막는 대신 "경고 + 기록"으로 다룬다(기록은 제출 시 평가자에게 함께 전달됨).
    examInProgress: false,
    leaveCount: 0,
    fullscreenExitCount: 0,
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

  function renderDomainPicker(filter = "") {
    const picker = $("#domain-picker");
    const needle = filter.trim();
    const list = needle ? state.domains.filter((d) => d.label.includes(needle)) : state.domains;

    picker.innerHTML = "";
    if (list.length === 0) {
      const empty = document.createElement("p");
      empty.className = "domain-hint";
      empty.textContent = "검색 결과가 없습니다.";
      picker.appendChild(empty);
      return;
    }

    list.forEach((d, i) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "domain-card";
      card.dataset.key = d.key;
      card.style.setProperty("--dot", d.color);
      card.style.animationDelay = `${Math.min(i, 12) * 22}ms`;
      card.innerHTML = `<i></i><span></span>`;
      card.querySelector("span").textContent = d.label;
      card.addEventListener("click", () => selectDomain(d));
      picker.appendChild(card);
    });
    refreshDomainSelection();
  }

  function refreshDomainSelection() {
    document.querySelectorAll(".domain-card").forEach((card) => {
      card.classList.toggle("selected", !!state.selectedDomain && card.dataset.key === state.selectedDomain.key);
    });
  }

  $("#domain-search").addEventListener("input", (e) => {
    renderDomainPicker(e.target.value);
  });

  function computeExamMinutes(questionCount) {
    const minutesPerQ = state.config?.examMinutesPerQuestion || 12;
    const maxMinutes = state.config?.examMaxMinutes || 30;
    return Math.min(questionCount * minutesPerQ, maxMinutes);
  }

  function selectDomain(domain) {
    state.selectedDomain = domain;
    refreshDomainSelection();

    const totalMinutes = computeExamMinutes(3);
    const hint = $("#domain-hint");
    hint.textContent = `${domain.label} · 총 3문항(AI 실시간 출제) · 제한시간 ${totalMinutes}분`;
    hint.classList.add("on");

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
      startProctoring();
    } catch (err) {
      showLoadingError(err.message || "문제를 출제하지 못했습니다. 다시 시도해 주세요.", generateAndStart);
    }
  }

  /* ---------- 시험 중 이탈 감시 ----------
   * 브라우저 보안상 웹페이지가 탭을 못 닫게 하거나 다른 탭 열기를 막는 것은 불가능하다.
   * 그래서 (1) 나가려 하면 브라우저 기본 확인창이 뜨게 하고, (2) 다른 화면으로 이동한
   * 횟수를 세어 경고를 띄우고, (3) 그 기록을 제출 시 평가자에게 함께 넘기는 방식으로 다룬다.
   */
  function startProctoring() {
    state.examInProgress = true;
    state.leaveCount = 0;
    state.fullscreenExitCount = 0;
    updateLeaveBadge();
    requestFullscreen();
  }

  function stopProctoring() {
    state.examInProgress = false;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function requestFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {
        // 브라우저가 거부해도 시험 자체는 계속 진행한다.
      });
    }
  }

  function updateLeaveBadge() {
    const badge = $("#leave-badge");
    badge.hidden = state.leaveCount === 0;
    $("#leave-count").textContent = state.leaveCount;
  }

  function flagLeave() {
    if (!state.examInProgress) return;
    state.leaveCount += 1;
    updateLeaveBadge();
    $("#leave-warning").hidden = false;
  }

  // 탭 전환, 창 최소화, 다른 앱으로 전환 시 발생
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flagLeave();
  });

  // 전체화면에서 빠져나가는 것도 이탈 신호로 기록한다.
  document.addEventListener("fullscreenchange", () => {
    if (state.examInProgress && !document.fullscreenElement) {
      state.fullscreenExitCount += 1;
    }
  });

  // 시험 중 탭 닫기/새로고침/뒤로가기를 시도하면 브라우저 확인창이 뜬다.
  window.addEventListener("beforeunload", (e) => {
    if (!state.examInProgress) return;
    e.preventDefault();
    e.returnValue = "";
  });

  $("#btn-dismiss-warning").addEventListener("click", () => {
    $("#leave-warning").hidden = true;
    requestFullscreen();
  });

  $("#btn-quit-exam").addEventListener("click", () => {
    if (!confirm("채점하지 않고 시험을 종료하시겠습니까?\n지금까지 작성한 답안은 저장되지 않습니다.")) return;
    clearInterval(state.timerHandle);
    stopProctoring();
    location.reload();
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
    let answeredCount = 0;
    items.forEach((item, idx) => {
      const q = state.questions[idx];
      item.classList.toggle("active", idx === state.currentIndex);
      const answered = (state.answers[q.id] || "").trim().length > 0;
      if (answered) answeredCount += 1;
      item.classList.toggle("answered", answered);
    });

    const total = state.questions.length || 1;
    $("#progress-fill").style.width = `${Math.round((answeredCount / total) * 100)}%`;
  }

  function updateCharCount() {
    const len = $("#q-answer").value.trim().length;
    $("#char-count").textContent = `${len.toLocaleString("ko-KR")}자`;
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
    $("#q-counter").textContent = `문항 ${idx + 1} / ${state.questions.length}`;

    $("#btn-prev").disabled = idx === 0;
    $("#btn-next").disabled = idx === state.questions.length - 1;

    renderChatMessages(q.id);
    refreshNavState();
    updateRemainingBadge();
    updateCharCount();
    // 문항을 바꾸면 본문 맨 위부터 읽도록 스크롤을 되돌린다.
    document.querySelector(".q-main")?.scrollTo({ top: 0, behavior: "smooth" });
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
    updateCharCount();
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
      const empty = document.createElement("div");
      empty.className = "ai-empty";
      empty.innerHTML = `
        <div class="ai-empty-mark">AI</div>
        <h4>이 사례를 함께 풀어볼 수 있습니다</h4>
        <p>AI는 답을 대신 정해주지 않고, 현장 전문가처럼 질문을 던지며 생각을 정리해 줍니다.
        어떻게 질문하는지도 평가에 반영됩니다.</p>
      `;
      box.appendChild(empty);
    } else {
      log.forEach((turn) => appendMessageEl(turn.role, turn.text));
    }
    box.scrollTop = box.scrollHeight;
  }

  function appendMessageEl(role, text) {
    const box = $("#ai-messages");
    box.querySelector(".ai-empty")?.remove();
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

  // Enter로 바로 전송, Shift+Enter는 줄바꿈 (일반적인 채팅 UI와 동일하게)
  $("#ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#ai-form").requestSubmit();
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
    stopProctoring();
    $("#leave-warning").hidden = true;

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
          proctor: {
            leaveCount: state.leaveCount,
            fullscreenExitCount: state.fullscreenExitCount,
            autoSubmitted: !!auto,
          },
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

  // 0~5점을 "왜 이 점수인지"가 바로 읽히도록 구간 라벨로 바꾼다.
  function scoreLevelLabel(score) {
    if (score >= 5) return "우수";
    if (score >= 4) return "양호";
    if (score >= 3) return "보통";
    if (score >= 1) return "미흡";
    return "해당 없음";
  }

  function scoreLevelClass(score) {
    if (score >= 4) return "lv-good";
    if (score >= 3) return "lv-mid";
    return "lv-low";
  }

  function renderResult(answers, overall, perQuestion, byCompetency, auto) {
    const notice = $("#result-notice");
    const notes = [];
    if (auto) notes.push("제한 시간이 종료되어 자동 제출되었습니다.");
    if (state.leaveCount > 0) {
      notes.push(`시험 중 다른 화면으로 이동한 기록이 ${state.leaveCount}회 있습니다 (평가자에게 함께 전달됩니다).`);
    }
    if (overall?.ungradedCount > 0) {
      notes.push(
        `${overall.ungradedCount}개 문항은 AI 채점 서버 오류로 채점되지 않아 총점 계산에서 제외되었습니다. ` +
          "해당 문항은 답안을 내려받아 평가자에게 전달해 주세요."
      );
    }
    notice.hidden = notes.length === 0;
    notice.textContent = notes.join(" ");

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
        const head = `<div class="breakdown-item-head">
            <h4>${idx + 1}. [${escapeHtml(q.domain)}] ${escapeHtml(q.title)}</h4>
            <span class="breakdown-subscore${q.hadError ? " is-ungraded" : ""}">${
              q.hadError ? "채점 보류" : `${q.subtotal} / ${q.submax}점`
            }</span>
          </div>`;

        if (q.hadError) {
          // 채점 실패는 응시자 잘못이 아니므로 0점이 아니라 "보류"로 안내하고 총점에서도 제외한다.
          div.innerHTML = `${head}
            <div class="criterion-error">
              <strong>이 문항은 자동 채점이 완료되지 않았습니다.</strong>
              AI 채점 서버가 일시적으로 응답하지 않아 세 번의 재시도 뒤에도 결과를 받지 못했습니다.
              이 문항은 총점 계산에서 제외되었으며, 아래 버튼으로 답안을 내려받아 평가자에게 전달하면
              수동으로 채점할 수 있습니다.
            </div>`;
          box.appendChild(div);
          return;
        }

        const rowsHtml = q.criteria
          .map((c) => {
            const isPrivacy = c.key === "deidentification";
            const lines = [];
            if (c.evidence) {
              lines.push(`<p class="criterion-line ev"><b>확인된 내용</b>${escapeHtml(c.evidence)}</p>`);
            }
            if (c.missing) {
              lines.push(`<p class="criterion-line miss"><b>미흡한 점</b>${escapeHtml(c.missing)}</p>`);
            }
            if (c.improve) {
              lines.push(`<p class="criterion-line tip"><b>이렇게 보완하세요</b>${escapeHtml(c.improve)}</p>`);
            }
            return `<div class="criterion-row${isPrivacy ? " criterion-privacy" : ""}">
              <div class="criterion-score ${scoreLevelClass(c.score)}">
                <span class="criterion-score-num">${c.score}<small>/${c.max}</small></span>
                <span class="criterion-score-tag">${scoreLevelLabel(c.score)}</span>
              </div>
              <div class="criterion-body">
                <span class="criterion-label">${escapeHtml(isPrivacy ? "🔒 " + c.label : c.label)}</span>
                ${lines.join("")}
              </div>
            </div>`;
          })
          .join("");

        const summaryHtml = q.summary
          ? `<div class="breakdown-summary"><b>총평</b>${escapeHtml(q.summary)}</div>`
          : "";

        div.innerHTML = `${head}${summaryHtml}${rowsHtml}`;
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
    lines.push(`시험 중 이탈 감지: ${state.leaveCount}회 (전체화면 해제 ${state.fullscreenExitCount}회)`);
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
      const scoreLabel = !g ? "" : g.hadError ? " — 채점 보류" : ` — ${g.subtotal}/${g.submax}점`;
      lines.push(`문항 ${idx + 1}. [${a.domain}] ${a.title}${scoreLabel}`);
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
      if (g && g.hadError) {
        lines.push("[채점 세부내역]");
        lines.push("AI 채점 서버 오류로 이 문항은 자동 채점되지 않았습니다. 총점에서도 제외되었으니 수동 채점이 필요합니다.");
        lines.push("");
      } else if (g) {
        lines.push("[채점 세부내역]");
        if (g.summary) {
          lines.push(`총평: ${g.summary}`);
          lines.push("");
        }
        g.criteria.forEach((c) => {
          const isPrivacy = c.key === "deidentification";
          const name = isPrivacy ? "개인정보 비식별 처리" : c.label;
          lines.push(`- [${name}] ${c.score}/${c.max}점 (${scoreLevelLabel(c.score)})`);
          if (c.evidence) lines.push(`  · 확인된 내용: ${c.evidence}`);
          if (c.missing) lines.push(`  · 미흡한 점: ${c.missing}`);
          if (c.improve) lines.push(`  · 보완 방법: ${c.improve}`);
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
