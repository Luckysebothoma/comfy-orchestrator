import {
  getJob, markSubmitted, markRunning, markCompleted,
  markFailed, requeue, findStuckOrOrphaned,
} from "./lib/db.js";
import { dequeueBlocking, enqueue } from "./lib/queue.js";
import { submitPrompt, fetchHistory } from "./lib/comfy.js";
import { alert } from "./lib/precheck.js";

const POLL_MS        = Number(process.env.COMFY_POLL_INTERVAL_MS || 4000);
const JOB_TIMEOUT_MS  = Number(process.env.COMFY_JOB_TIMEOUT_MS || 600000);
const RECONCILE_MS   = Number(process.env.RECONCILE_INTERVAL_MS || 15000);
const STUCK_AFTER_MS = Number(process.env.STUCK_AFTER_MS || 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntilDone(promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await fetchHistory(promptId);
    if (history) return history;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ComfyUI job ${promptId}`);
}

// Fires the caller's webhook (e.g. an n8n Webhook node) so hybrid flows
// don't have to poll GET /jobs/:id. Failure here never affects job state —
// the row in Postgres is still the source of truth.
async function fireCallback(job, status, extra = {}) {
  if (!job.callback_url) return;
  try {
    await fetch(job.callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: job.id, mode: job.mode, status, ...extra }),
    });
  } catch (e) {
    console.error(`callback delivery failed for job ${job.id}: ${e.message}`);
  }
}

async function processJob(jobId) {
  const job = await getJob(jobId);
  if (!job) return;
  // Idempotency: a job already completed/failed shouldn't be reprocessed.
  if (!["queued", "submitted", "running"].includes(job.status)) return;

  if (job.attempts >= job.max_attempts) {
    await markFailed(jobId, "max attempts exceeded");
    await alert(`job ${jobId} (mode=${job.mode}) failed permanently: max attempts exceeded`);
    await fireCallback(job, "failed", { error: "max attempts exceeded" });
    return;
  }

  try {
    const promptId = await submitPrompt(job.payload);
    await markSubmitted(jobId, promptId);
    await markRunning(jobId);

    const history = await pollUntilDone(promptId, JOB_TIMEOUT_MS);
    await markCompleted(jobId, history);
    await fireCallback(job, "completed", { result: history });
    console.log(`✔ job ${jobId} completed (prompt ${promptId})`);
  } catch (err) {
    console.error(`✘ job ${jobId} failed: ${err.message}`);
    const fresh = await getJob(jobId);
    if (fresh && fresh.attempts < fresh.max_attempts) {
      await requeue(jobId, err.message);
      await enqueue(jobId);
    } else {
      await markFailed(jobId, err.message);
      await alert(`job ${jobId} (mode=${job.mode}) failed permanently: ${err.message}`);
      await fireCallback(job, "failed", { error: err.message });
    }
  }
}

// Worker loop: consumes the Redis queue.
async function workerLoop() {
  console.log("worker: consuming queue…");
  for (;;) {
    try {
      const jobId = await dequeueBlocking(5);
      if (jobId) await processJob(jobId);
    } catch (err) {
      console.error("worker loop error:", err.message);
      await sleep(1000);
    }
  }
}

// Reconciler: safety net for jobs that never made it into Redis, or that
// stalled mid-flight (worker crash, Comfy restart, etc). Nothing gets lost
// as long as its row exists in Postgres.
async function reconcilerLoop() {
  console.log("reconciler: watching for orphaned/stuck jobs…");
  for (;;) {
    try {
      const ids = await findStuckOrOrphaned(STUCK_AFTER_MS);
      for (const id of ids) {
        console.log(`reconciler: requeueing ${id}`);
        await requeue(id, "reconciled: requeued after stall/orphan detection");
        await enqueue(id);
      }
    } catch (err) {
      console.error("reconciler error:", err.message);
    }
    await sleep(RECONCILE_MS);
  }
}

workerLoop();
reconcilerLoop();
