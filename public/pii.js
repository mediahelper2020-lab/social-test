// 개인식별정보 기계 검사
//
// 사회복지 현장에서 AI 사고가 실제로 나는 지점은 "최종 문서"가 아니라 "AI 입력창"이다.
// 그래서 응시자가 AI에게 보낸 메시지를 정규식으로 직접 검사해, 채점 AI의 판단과 별개로
// 확정적인 증거를 남긴다. (브라우저에서는 전송 전 경고, 서버에서는 채점 근거로 쓰인다.)
//
// 검사 대상은 "응시자가 입력한 텍스트"뿐이다. 출제된 사례 지문은 검사하지 않는다.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PII = api;
})(typeof self !== "undefined" ? self : this, function () {
  // 순서가 중요하다. 주민등록번호를 먼저 잡아내야 계좌번호 패턴에 잘못 걸리지 않는다.
  const RULES = [
    {
      type: "주민등록번호",
      severity: "critical",
      // 생년월일 6자리 + 성별코드(1~4, 외국인 5~8) + 6자리
      re: /\b\d{6}\s*[-–—]\s*[1-8]\d{6}\b/g,
    },
    {
      type: "휴대전화번호",
      severity: "critical",
      re: /\b01[0136789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    },
    {
      type: "유선전화번호",
      severity: "high",
      re: /\b0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4])[-.\s]\d{3,4}[-.\s]\d{4}\b/g,
    },
    {
      type: "상세주소(동·호수)",
      severity: "high",
      // "101동 1203호", "3동 502호" 처럼 세대를 특정할 수 있는 표기
      re: /\b\d{1,4}\s*동\s*\d{1,5}\s*호/g,
    },
    {
      type: "상세주소(번지)",
      severity: "high",
      re: /[가-힣]{2,6}(?:시|군|구)\s*[가-힣]{2,10}(?:로|길)\s?\d{1,4}(?:[-–]\d{1,4})?/g,
    },
    {
      type: "이메일",
      severity: "medium",
      re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    },
    {
      type: "계좌·카드번호",
      severity: "critical",
      re: /\b\d{3,6}[-–]\d{2,6}[-–]\d{4,7}(?:[-–]\d{1,6})?\b/g,
    },
  ];

  // 긴 숫자열이 주민등록번호로 잡힌 뒤 계좌번호로 또 잡히는 것을 막는다.
  function overlaps(taken, start, end) {
    return taken.some((r) => start < r.end && end > r.start);
  }

  // text에서 검출된 항목을 반환한다. sample은 원문 그대로 남기지 않고 일부를 가린다.
  function scan(text) {
    if (typeof text !== "string" || !text) return [];
    const taken = [];
    const found = [];

    RULES.forEach((rule) => {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (overlaps(taken, start, end)) continue;
        taken.push({ start, end });
        found.push({ type: rule.type, severity: rule.severity, sample: mask(m[0]) });
      }
    });

    return found;
  }

  // 검출된 값을 로그·채점 프롬프트에 그대로 흘리지 않도록 가운데를 가린다.
  function mask(value) {
    const s = String(value);
    if (s.length <= 4) return s[0] + "*".repeat(s.length - 1);
    return s.slice(0, 3) + "*".repeat(Math.max(3, s.length - 5)) + s.slice(-2);
  }

  // 같은 종류가 여러 번 나와도 한 줄로 요약한다.
  function summarize(findings) {
    const byType = new Map();
    findings.forEach((f) => {
      const cur = byType.get(f.type) || { type: f.type, severity: f.severity, count: 0, samples: [] };
      cur.count += 1;
      if (cur.samples.length < 3) cur.samples.push(f.sample);
      byType.set(f.type, cur);
    });
    return [...byType.values()];
  }

  // 응시자가 AI에게 보낸 메시지만 모아 검사한다.
  function scanChatLog(chatLog) {
    if (!Array.isArray(chatLog)) return [];
    const findings = [];
    chatLog.forEach((turn, i) => {
      if (!turn || turn.role !== "user") return;
      scan(turn.text).forEach((f) => findings.push({ ...f, turn: i + 1 }));
    });
    return findings;
  }

  return { scan, scanChatLog, summarize, RULES };
});
