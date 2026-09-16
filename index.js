import express from "express";
import { pool, insertJob, getJob, listJobs, metrics } from "./lib/db.js";
import { enqueue } from "./lib/queue.js";
import {
  comfyHealthy, getSystemStats, getObjectInfo, getQueue,
  uploadImage, viewImageUrl, interruptCurrent, freeMemory,
} from "./lib/comfy.js";
import { buildTxt2Img } from "./lib/workflows/txt2img.js";
import { buildImg2Img } from "./lib/workflows/img2img.js";
import { buildFaceHandFix } from "./lib/workflows/faceHandFix.js";
import { describeImageLocally, refinePrompt } from "./lib/vision.js";
import { checkRequirements, alert } from "./lib/precheck.js";
import { jobsEnqueued, redisEnqueueFailures } from "./lib/metrics.js";

startMetricsLoop();

import { startMetricsLoop, pushMetrics } from "./lib/metrics.js";
const app = express();
app.use(express.json({ limit: "25mb" })); // images travel as base64 in JSON

const PORT = process.env.API_PORT || 3000;

process.on("SIGTERM", async () => {
  await pushMetrics(); // final snapshot before shutdown
  process.exit(0);
});

// ------------------------------------------------------------------------
// Docs
// ------------------------------------------------------------------------
const ENDPOINTS = {
  "GET /help":              "alias for /docs",
  "GET /docs":              "this document",
  "GET /health":            "DB + Redis(implicit) + ComfyUI reachability",
  "GET /metrics":           "job counts by status x mode",
  "GET /jobs":              "list recent jobs (?status=&mode=&limit=)",
  "GET /jobs/:id":          "job status + result",
  "POST /precheck":         "check a template/graph's required nodes+models exist. body: {template, params} or {graph, requiredNodes, requiredModels}",
  "-- generation modes --": "8 ways to kick off work, all funnel through the same durable job pipeline",
  "POST /generate":                "[mode=raw] body: {prompt: <raw ComfyUI graph JSON>, external_ref?, callback_url?}",
  "POST /generate/template":       "[mode=template] body: {template: 'txt2img'|'img2img'|'face-hand-fix', params, external_ref?, callback_url?}",
  "POST /generate/txt2img":        "[mode=txt2img] body: {positive, negative?, width?, height?, steps?, cfg?, seed?, checkpoint?, callback_url?}",
  "POST /generate/img2img":        "[mode=img2img] body: {image_base64, filename, positive, negative?, denoise?, checkpoint?, callback_url?}",
  "POST /generate/image-prompt":   "[mode=image-prompt] body: {image_base64, filename, extra_prompt?, llm?: 'none'|'groq'|'gemini', checkpoint?, callback_url?} — captions image LOCALLY, optionally refines the text (text only) via Groq/Gemini, then generates locally",
  "POST /generate/face-hand-fix":  "[mode=detail-fix] body: {image_base64, filename, positive?, negative?, checkpoint?, callback_url?}",
  "POST /generate/batch":          "[mode=batch] body: {jobs: [ {mode, ...params}, ... ]} — fires each as its own durable job, returns all job ids",
  "POST /prompt/from-image":       "prompt-only, no generation: body: {image_base64, filename, extra_prompt?, llm?} -> returns crafted prompt text",
  "-- comfyui management --": "direct pass-through to the ComfyUI HTTP API",
  "GET /comfy/system-stats":  "GPU/VRAM/host stats",
  "GET /comfy/object-info":   "full node registry (what custom nodes are installed)",
  "GET /comfy/queue":         "current ComfyUI queue",
  "POST /comfy/interrupt":    "interrupt the running job",
  "POST /comfy/free":         "unload models / free VRAM",
  "GET /comfy/view":          "?filename=&subfolder=&type= -> redirects to the ComfyUI image",
};

app.get(["/help", "/docs"], (_req, res) => {
  res.json({ service: "comfy-orchestrator-api", endpoints: ENDPOINTS });
});

// ------------------------------------------------------------------------
// Health / metrics / jobs
// ------------------------------------------------------------------------
app.get("/health", async (_req, res) => {
  const checks = { db: false, comfy: false };
  try { await pool.query("SELECT 1"); checks.db = true; } catch {}
  checks.comfy = await comfyHealthy();
  const healthy = checks.db && checks.comfy;
  res.status(healthy ? 200 : 503).json({ healthy, checks });
});

app.get("/metrics", async (_req, res) => {
  res.json({ jobs_by_status_and_mode: await metrics() });
});

app.get("/jobs", async (req, res) => {
  const { status, mode, limit } = req.query;
  res.json({ success: true, jobs: await listJobs({ status, mode, limit: Number(limit) || 50 }) });
});

app.get("/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, job });
});

// ------------------------------------------------------------------------
// Precheck
// ------------------------------------------------------------------------
app.post("/precheck", async (req, res) => {
  try {
    const { template, params, graph, requiredNodes, requiredModels } = req.body || {};
    let reqNodes = requiredNodes || [];
    let reqModels = requiredModels || [];
    if (template) {
      const built = buildFromTemplate(template, params || {}, { skipImage: true });
      reqNodes = built.requiredNodes;
      reqModels = built.requiredModels;
    } else if (!graph) {
      return res.status(400).json({ success: false, error: "provide either {template, params} or {graph/requiredNodes/requiredModels}" });
    }
    const result = await checkRequirements({ requiredNodes: reqNodes, requiredModels: reqModels });
    if (!result.ok) {
      await alert(`precheck failed for template="${template || "custom"}": missing nodes=${result.missing.nodes.join(",")} models=${result.missing.models.join(",")}`);
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Durable enqueue helper: the DB row is the source of truth and is written
// BEFORE we touch Redis, so a Redis outage never drops a submitted job —
// the reconciler in worker.js will pick up any 'queued' row it finds.
// ------------------------------------------------------------------------
async function enqueueGraph(graph, { mode, externalRef, promptText, callbackUrl, maxAttempts }) {
  const job = await insertJob(graph, { mode, externalRef, promptText, callbackUrl, maxAttempts });
  try {
    await enqueue(job.id);
  } catch (e) {
    redisEnqueueFailures.inc();
    console.error("Redis enqueue failed, relying on reconciler:", e.message);
  }
  return job;
}

function buildFromTemplate(template, params, { skipImage = false } = {}) {
  switch (template) {
    case "txt2img":
      return buildTxt2Img(params);
    case "img2img":
      if (skipImage) return buildImg2Img({ ...params, image: params.image || "placeholder.png" });
      return buildImg2Img(params);
    case "face-hand-fix":
      if (skipImage) return buildFaceHandFix({ ...params, image: params.image || "placeholder.png" });
      return buildFaceHandFix(params);
    default:
      throw new Error(`Unknown template: ${template}`);
  }
}

async function uploadIncomingImage(imageBase64, filename) {
  if (!imageBase64 || !filename) throw new Error("image_base64 and filename are required");
  const buffer = Buffer.from(imageBase64, "base64");
  const uploaded = await uploadImage(buffer, filename);
  return uploaded.name; // ComfyUI may rename on collision — use its returned name
}

// ------------------------------------------------------------------------
// Mode 1: raw ComfyUI graph JSON (power-user / existing workflows)
// ------------------------------------------------------------------------
app.post("/generate", async (req, res) => {
  try {
    const { prompt, external_ref, callback_url, prompt_text = null, max_attempts } = req.body || {};
    if (!prompt || typeof prompt !== "object") {
      return res.status(400).json({ success: false, error: "prompt must be an object (raw ComfyUI graph)" });
    }
    const job = await enqueueGraph(prompt, {
      mode: "raw",
      externalRef: external_ref,
      callbackUrl: callback_url,
      promptText: prompt_text,
      maxAttempts: Number(max_attempts ?? process.env.COMFY_MAX_ATTEMPTS ?? 5),
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ------------------------------------------------------------------------
// Mode 2: named template + params (workflow-as-code, no image)
// ------------------------------------------------------------------------
app.post("/generate/template", async (req, res) => {
  try {
    const { template, params = {}, external_ref, callback_url } = req.body || {};
    const built = buildFromTemplate(template, params);
    const job = await enqueueGraph(built.graph, {
      mode: "template", externalRef: external_ref, callbackUrl: callback_url,
      promptText: params.positive || null,
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 3: convenience txt2img
// ------------------------------------------------------------------------
app.post("/generate/txt2img", async (req, res) => {
  try {
    const { callback_url, external_ref, ...params } = req.body || {};
    const built = buildTxt2Img(params);
    const job = await enqueueGraph(built.graph, {
      mode: "txt2img", externalRef: external_ref, callbackUrl: callback_url,
      promptText: params.positive || null,
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 4: img2img (client-supplied reference image)
// ------------------------------------------------------------------------
app.post("/generate/img2img", async (req, res) => {
  try {
    const { image_base64, filename, callback_url, external_ref, ...params } = req.body || {};
    const uploadedName = await uploadIncomingImage(image_base64, filename);
    const built = buildImg2Img({ ...params, image: uploadedName });
    const job = await enqueueGraph(built.graph, {
      mode: "img2img", externalRef: external_ref, callbackUrl: callback_url,
      promptText: params.positive || null,
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 5: image-driven prompting (identity-safe pipeline)
//   upload image -> LOCAL caption in ComfyUI -> optional TEXT-ONLY refine
//   via Groq/Gemini -> local txt2img generation. Raw image bytes never
//   leave this box.
// ------------------------------------------------------------------------
app.post("/generate/image-prompt", async (req, res) => {
  try {
    const {
      image_base64, filename, extra_prompt = "", llm = "none",
      callback_url, external_ref, ...params
    } = req.body || {};
    const uploadedName = await uploadIncomingImage(image_base64, filename);
    const description = await describeImageLocally(uploadedName);
    const finalPrompt = await refinePrompt(description, { provider: llm, extra: extra_prompt });
    const built = buildTxt2Img({ ...params, positive: finalPrompt });
    const job = await enqueueGraph(built.graph, {
      mode: "image-prompt", externalRef: external_ref, callbackUrl: callback_url,
      promptText: finalPrompt,
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode, prompt_used: finalPrompt });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 6: prompt-only — same pipeline as above but returns text, no
// generation job is created. Handy for n8n flows that want to review/edit
// the prompt before triggering /generate/txt2img themselves.
// ------------------------------------------------------------------------
app.post("/prompt/from-image", async (req, res) => {
  try {
    const { image_base64, filename, extra_prompt = "", llm = "none" } = req.body || {};
    const uploadedName = await uploadIncomingImage(image_base64, filename);
    const description = await describeImageLocally(uploadedName);
    const finalPrompt = await refinePrompt(description, { provider: llm, extra: extra_prompt });
    res.json({ success: true, description, prompt: finalPrompt });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 7: face/hand detail fix pass on a client-supplied image
// ------------------------------------------------------------------------
app.post("/generate/face-hand-fix", async (req, res) => {
  try {
    const { image_base64, filename, callback_url, external_ref, ...params } = req.body || {};
    const uploadedName = await uploadIncomingImage(image_base64, filename);
    const built = buildFaceHandFix({ ...params, image: uploadedName });
    const job = await enqueueGraph(built.graph, {
      mode: "detail-fix", externalRef: external_ref, callbackUrl: callback_url,
      promptText: params.positive || null,
    });
    res.status(202).json({ success: true, job_id: job.id, status: job.status, mode: job.mode });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// Mode 8: batch — an array of any of the above, each becomes its own
// durable job (recommended for n8n "split in batches" style flows).
// ------------------------------------------------------------------------
app.post("/generate/batch", async (req, res) => {
  try {
    const { jobs } = req.body || {};
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ success: false, error: "jobs must be a non-empty array" });
    }
    const results = [];
    for (const item of jobs) {
      const { mode = "txt2img", image_base64, filename, callback_url, external_ref, ...params } = item;
      let built;
      if (mode === "raw") {
        built = { graph: item.prompt };
      } else if (mode === "img2img" || mode === "detail-fix") {
        const uploadedName = await uploadIncomingImage(image_base64, filename);
        built = mode === "img2img"
          ? buildImg2Img({ ...params, image: uploadedName })
          : buildFaceHandFix({ ...params, image: uploadedName });
      } else {
        built = buildTxt2Img(params);
      }
      const job = await enqueueGraph(built.graph, {
        mode: `batch:${mode}`, externalRef: external_ref, callbackUrl: callback_url,
        promptText: params.positive || null,
      });
      results.push({ job_id: job.id, mode: job.mode });
    }
    res.status(202).json({ success: true, jobs: results });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------------
// ComfyUI management pass-through
// ------------------------------------------------------------------------
app.get("/comfy/system-stats", async (_req, res) => {
  try { res.json(await getSystemStats()); } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});
app.get("/comfy/object-info", async (_req, res) => {
  try { res.json(await getObjectInfo()); } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});
app.get("/comfy/queue", async (_req, res) => {
  try { res.json(await getQueue()); } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});
app.post("/comfy/interrupt", async (_req, res) => {
  try { res.json({ success: await interruptCurrent() }); } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});
app.post("/comfy/free", async (req, res) => {
  try { res.json({ success: await freeMemory(req.body || {}) }); } catch (err) { res.status(502).json({ success: false, error: err.message }); }
});
app.get("/comfy/view", (req, res) => {
  const { filename, subfolder = "", type = "output" } = req.query;
  if (!filename) return res.status(400).json({ success: false, error: "filename is required" });
  res.redirect(viewImageUrl({ filename, subfolder, type }));
});

app.listen(PORT, () => {
  console.log(`comfy-orchestrator API listening on :${PORT}`);
});
