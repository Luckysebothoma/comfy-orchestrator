// Turns a free-text chat message into {selected_model, positive_prompt,
// negative_prompt, generation_params}.
//
// The old n8n flow made the LLM author raw ComfyUI graph JSON by hand in a
// *second* gateway call ("Build LLM Instruction - Sampler Nodes"), then
// validated/coerced it, with continueRegularOutput swallowing failures.
// That's the least reliable way to get a ComfyUI graph — LLMs are good at
// picking a model + writing a prompt, not at hand-authoring node graphs.
// We now only ask the gateway for the model + prompt + generation params
// (one call, not two) and build the actual graph deterministically with
// the existing WorkflowGraph builder (lib/workflows/txt2img.js) — the same
// path every other /generate/* endpoint already uses. Half the gateway
// round-trips, and the graph can never come back malformed.

import { callGateway, parseJsonFromLLM } from "./ai-gateway.js";

function csvEnv(name, fallback) {
  return (process.env[name] || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_CHECKPOINTS = csvEnv(
  "ALLOWED_CHECKPOINTS",
  "realisticVisionV60B1_v51HyperVAE.safetensors,dreamshaper_8.safetensors,juggernaut_reborn.safetensors,v1-5-pruned-emaonly.safetensors"
);
const BLOCKED_CHECKPOINTS = csvEnv("BLOCKED_CHECKPOINTS", "juggernautXL_ragnarokBy.safetensors");
const FALLBACK_CHECKPOINT = process.env.DEFAULT_CHECKPOINT || "v1-5-pruned-emaonly.safetensors";
const DEFAULT_NEGATIVE =
  process.env.DEFAULT_NEGATIVE_PROMPT || "low quality, blurry, distorted, watermark";

function routingGuide() {
  if (process.env.MODEL_ROUTING_GUIDE) return process.env.MODEL_ROUTING_GUIDE;
  const [a, b, c, d] = ALLOWED_CHECKPOINTS;
  return [
    a && `- "${a}" -> cinematic, photorealistic, high-contrast realism`,
    b && `- "${b}" -> artistic, stylized, or cosmic scenes`,
    c && `- "${c}" -> extreme high-detail and complex environments`,
    d && `- "${d}" -> fallback for simple or uncategorized prompts`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildInstruction(userMessage) {
  return `You are an expert ComfyUI prompt & model routing assistant. Analyze the USER REQUEST and select the most appropriate checkpoint using these exact rules (do not invent filenames outside this list):
${routingGuide()}
${BLOCKED_CHECKPOINTS.length ? `NEVER select: ${BLOCKED_CHECKPOINTS.join(", ")}` : ""}

Return ONLY a valid JSON object, no markdown fences, no commentary, matching this shape exactly:
{
  "selected_model": "filename.safetensors",
  "positive_prompt": "enhanced descriptive prompt for image generation",
  "negative_prompt": "standard negative prompt for quality control",
  "generation_params": {
    "width": 512,
    "height": 512,
    "steps": 25,
    "cfg": 7.0
  }
}

USER REQUEST:
${userMessage}`;
}

export async function craftPromptAndModel(userMessage, { sessionId } = {}) {
  const raw = await callGateway(buildInstruction(userMessage), { sessionId });
  const parsed = parseJsonFromLLM(raw);

  let model = parsed.selected_model;
  if (!model || !ALLOWED_CHECKPOINTS.includes(model) || BLOCKED_CHECKPOINTS.includes(model)) {
    model = FALLBACK_CHECKPOINT;
  }

  const gp = parsed.generation_params || {};
  return {
    selected_model: model,
    positive_prompt: (parsed.positive_prompt && String(parsed.positive_prompt).trim()) || userMessage,
    negative_prompt: (parsed.negative_prompt && String(parsed.negative_prompt).trim()) || DEFAULT_NEGATIVE,
    generation_params: {
      width: Number(gp.width) || Number(process.env.CHAT_DEFAULT_WIDTH || 512),
      height: Number(gp.height) || Number(process.env.CHAT_DEFAULT_HEIGHT || 512),
      steps: Number(gp.steps) || Number(process.env.CHAT_DEFAULT_STEPS || 25),
      cfg: Number(gp.cfg) || Number(process.env.CHAT_DEFAULT_CFG || 7.0),
      sampler: gp.sampler_name || gp.sampler || process.env.CHAT_DEFAULT_SAMPLER || "euler",
      scheduler: gp.scheduler || process.env.CHAT_DEFAULT_SCHEDULER || "normal",
    },
  };
}

export const _internal = { ALLOWED_CHECKPOINTS, BLOCKED_CHECKPOINTS, FALLBACK_CHECKPOINT };
