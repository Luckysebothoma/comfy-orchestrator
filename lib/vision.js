import { submitPrompt, fetchHistory } from "./comfy.js";
import { buildCaption } from "./workflows/caption.js";
import { refineWithGroq, refineWithGemini } from "./llm.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function describeImageLocally(imageFilename, { timeoutMs = 60000, pollMs = 2000 } = {}) {
  const { graph } = buildCaption({ image: imageFilename });
  const promptId = await submitPrompt(graph);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await fetchHistory(promptId);
    if (history) return extractText(history);
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for local caption workflow");
}

function extractText(history) {
  const outputs = history.outputs || {};
  for (const nodeId of Object.keys(outputs)) {
    const out = outputs[nodeId];
    const val = out.tags ?? out.text ?? out.caption ?? null;
    if (val) return Array.isArray(val) ? val.join(", ") : String(val);
  }
  return "";
}

// provider: 'none' | 'groq' | 'gemini'. Only `description` (derived text)
// is ever transmitted externally — never the source image.
export async function refinePrompt(description, { provider = "none", extra = "" } = {}) {
  const combined = [description, extra].filter(Boolean).join(". ");
  if (provider === "groq") return refineWithGroq(combined);
  if (provider === "gemini") return refineWithGemini(combined);
  return combined;
}
