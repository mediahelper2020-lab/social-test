// 문항 비밀(페르소나·함정 정답지)을 클라이언트에 감춘 채로 왕복시키는 봉인 유틸.
//
// 왜 필요한가:
// 이 시험은 문항마다 "AI가 일부러 흘릴 잘못된 제안"(함정)을 심는다. 그런데 Vercel 같은
// 서버리스 환경에서는 요청마다 다른 인스턴스가 처리할 수 있어 서버 메모리에 문항을 보관할 수 없다.
// 그렇다고 함정을 평문으로 클라이언트에 내려보내면 응시자가 개발자도구로 정답지를 그대로 읽어버려
// 시험이 무의미해진다.
// 그래서 문항의 비밀을 서버 키로 암호화한 토큰으로 만들어 내려보내고, 채팅·제출 때 그대로
// 돌려받아 서버에서만 연다. 응시자는 토큰을 읽을 수도, 조작할 수도 없다(GCM 인증 태그로 위변조 검출).

const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function secretKey() {
  // EXAM_SECRET이 가장 좋고, 없으면 배포마다 안정적인 값(API 키)에서 파생한다.
  // 둘 다 없는 로컬 개발 환경에서는 고정 문자열로 떨어진다.
  const raw =
    process.env.EXAM_SECRET ||
    process.env.GEMINI_API_KEY ||
    process.env.GROQ_API_KEY ||
    "social-test-dev-only";
  return crypto.createHash("sha256").update(raw).digest();
}

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, secretKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

function unseal(token) {
  if (typeof token !== "string" || !token) return null;
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv(ALGO, secretKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const out = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(out.toString("utf8"));
  } catch {
    // 위변조되었거나 서버 키가 바뀐 토큰
    return null;
  }
}

module.exports = { seal, unseal };
