// Direct client for L's AI gateway (the multi-stack provider-routing gateway).
// This replaces the old path: n8n webhook -> n8n's own "ai-gateway-chat" relay
// -> gateway. n8n is no longer in the loop for image-chat requests.
//
// Required:
//   AI_GATEWAY_URL          e.g. http://192.168.0.140:4400   (no trailing slash)
// Optional:
//   AI_GATEWAY_CHAT_PATH    default "/chat"
//   AI_GATEWAY_API_KEY      sent as `Authorization: Bearer <key>` if set
//   AI_GATEWAY_TIMEOUT_MS   default 20000

const GATEWAY_URL = process.env.AI_GATEWAY_URL || "";
const GATEWAY_CHAT_PATH = process.env.AI_GATEWAY_CHAT_PATH || "/chat";
const GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY || "";
const GATEWAY_TIMEOUT_MS = Number(process.env.AI_GATEWAY_TIMEOUT_MS || 20000);

export function gatewayConfigured() {
  return Boolean(GATEWAY_URL);
}

// Sends a single chat-style message to the gateway and returns the raw text
// content of the reply (mirrors the {message, session_id} shape the old
// n8n "Call AI Gateway" HTTP Request nodes used, so the gateway side needs
// no changes).
export async function callGateway(message, { sessionId } = {}) {
  if (!GATEWAY_URL) {
    throw new Error(
      "AI_GATEWAY_URL is not set — point it at the AI gateway (see .env.example)"
    );
  }
  const url = `${GATEWAY_URL.replace(/\/$/, "")}${GATEWAY_CHAT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATEWAY_API_KEY ? { Authorization: `Bearer ${GATEWAY_API_KEY}` } : {}),
      },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`AI gateway ${res.status}: ${bodyText.slice(0, 500)}`);
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText; // gateway replied with plain text
    }
    if (typeof data === "string") return data;
    const raw = data.response ?? data.message ?? data.text ?? data.output ?? data;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`AI gateway timed out after ${GATEWAY_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// The gateway is instructed to return raw JSON, but LLMs sometimes wrap it
// in ```json fences anyway — strip those defensively before parsing.
export function parseJsonFromLLM(raw) {
  if (raw && typeof raw === "object") return raw;
  let s = String(raw ?? "").trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`AI gateway did not return valid JSON: ${e.message} — raw: ${s.slice(0, 300)}`);
  }
}
