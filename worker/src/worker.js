/**
 * 체험단 대시보드 — Cloudflare Worker
 * 역할:
 *   1) 네이버 로그인 OAuth code -> token 교환 (Client Secret을 안전하게 보관)
 *   2) 로그인 성공 시 자체 서명 토큰(HMAC) 발급 -> 프론트엔드가 세션처럼 사용
 *   3) Google Drive(전용 계정)에 campaigns.json 하나를 읽고/쓰는 프록시
 *
 * 필요한 Secrets (wrangler secret put 로 등록):
 *   NAVER_CLIENT_ID
 *   NAVER_CLIENT_SECRET
 *   SESSION_SECRET          (임의의 긴 랜덤 문자열, 세션 서명용)
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN    (전용 구글 계정으로 1회 발급받은 refresh token)
 *
 * 필요한 vars (wrangler.toml):
 *   ALLOWED_ORIGIN          예: https://jimmy-jib-dev.github.io
 *   DATA_FILENAME           예: rcd_campaigns.json
 */

const DRIVE_FILE_MIME = "application/json";

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

/* ---------------- HMAC session token (stateless, no KV needed) ---------------- */
function b64url(bytes) {
  let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}
async function signToken(payloadObj, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}
async function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(payload)
  );
  if (!valid) return null;
  const obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
  if (obj.exp && Date.now() > obj.exp) return null;
  return obj;
}

async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const session = await verifyToken(token, env.SESSION_SECRET);
  return session;
}

/* ---------------- Google Drive helpers ---------------- */
async function getGoogleAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google token refresh failed: " + (await res.text()));
  const data = await res.json();
  return data.access_token;
}

async function findDataFileId(accessToken, filename) {
  const q = encodeURIComponent(`name='${filename}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error("drive list failed: " + (await res.text()));
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

async function createDataFile(accessToken, filename, initialContent) {
  const boundary = "rcdboundary";
  const metadata = { name: filename, mimeType: DRIVE_FILE_MIME };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${DRIVE_FILE_MIME}\r\n\r\n${JSON.stringify(initialContent)}\r\n` +
    `--${boundary}--`;
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) throw new Error("drive create failed: " + (await res.text()));
  const data = await res.json();
  return data.id;
}

async function readDataFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("drive read failed: " + (await res.text()));
  return res.json();
}

async function writeDataFile(accessToken, fileId, content) {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": DRIVE_FILE_MIME },
      body: JSON.stringify(content),
    }
  );
  if (!res.ok) throw new Error("drive write failed: " + (await res.text()));
}

/* ---------------- Route handlers ---------------- */
async function handleConfig(request, env) {
  const url = new URL(request.url);
  return json(
    {
      naverClientId: env.NAVER_CLIENT_ID,
      redirectUri: env.REDIRECT_URI || null, // optional override; frontend falls back to its own URL
    },
    200, env
  );
}

async function handleNaverAuth(request, env) {
  const body = await request.json();
  const { code, redirectUri } = body;
  if (!code) return json({ error: "missing code" }, 400, env);

  const tokenRes = await fetch(
    `https://nid.naver.com/oauth2.0/token?grant_type=authorization_code` +
      `&client_id=${encodeURIComponent(env.NAVER_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(env.NAVER_CLIENT_SECRET)}` +
      `&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri || "")}`
  );
  if (!tokenRes.ok) return json({ error: "naver token exchange failed" }, 401, env);
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return json({ error: "no access token" }, 401, env);

  const profileRes = await fetch("https://openapi.naver.com/v1/nid/me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profileData = await profileRes.json();
  if (profileData.resultcode !== "00") return json({ error: "naver profile fetch failed" }, 401, env);

  const p = profileData.response;
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 14; // 14일 세션
  const token = await signToken({ sub: p.id, name: p.name, email: p.email, exp }, env.SESSION_SECRET);

  return json({ token, name: p.name, email: p.email, expiresAt: exp }, 200, env);
}

async function handleGetData(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, env);

  const accessToken = await getGoogleAccessToken(env);
  const filename = env.DATA_FILENAME || "rcd_campaigns.json";
  let fileId = await findDataFileId(accessToken, filename);
  if (!fileId) {
    fileId = await createDataFile(accessToken, filename, { campaigns: [] });
  }
  const content = await readDataFile(accessToken, fileId);
  return json(content, 200, env);
}

async function handlePutData(request, env) {
  const session = await requireAuth(request, env);
  if (!session) return json({ error: "unauthorized" }, 401, env);

  const body = await request.json();
  const accessToken = await getGoogleAccessToken(env);
  const filename = env.DATA_FILENAME || "rcd_campaigns.json";
  let fileId = await findDataFileId(accessToken, filename);
  if (!fileId) {
    fileId = await createDataFile(accessToken, filename, { campaigns: [] });
  }
  await writeDataFile(accessToken, fileId, body);
  return json({ ok: true }, 200, env);
}

/* ---------------- Entry ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        return await handleConfig(request, env);
      }
      if (url.pathname === "/api/auth/naver" && request.method === "POST") {
        return await handleNaverAuth(request, env);
      }
      if (url.pathname === "/api/data" && request.method === "GET") {
        return await handleGetData(request, env);
      }
      if (url.pathname === "/api/data" && request.method === "PUT") {
        return await handlePutData(request, env);
      }
      return json({ error: "not found" }, 404, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, env);
    }
  },
};
