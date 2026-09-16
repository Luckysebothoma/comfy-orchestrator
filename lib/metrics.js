import client from "prom-client";
import { metrics as jobMetrics } from "./db.js"; // adjust path to your db file

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const gateway = new client.Pushgateway(
  process.env.PUSHGATEWAY_URL || "http://localhost:9091",
  {},
  register
);

// Counters for lifecycle transitions (monotonic, per-event)
export const jobsEnqueued = new client.Counter({
  name: "comfy_jobs_enqueued_total",
  help: "Total jobs inserted",
  labelNames: ["mode"],
  registers: [register],
});

export const jobsSubmitted = new client.Counter({
  name: "comfy_jobs_submitted_total",
  help: "Total jobs submitted to ComfyUI",
  registers: [register],
});

export const jobsCompleted = new client.Counter({
  name: "comfy_jobs_completed_total",
  help: "Total jobs completed",
  registers: [register],
});

export const jobsFailed = new client.Counter({
  name: "comfy_jobs_failed_total",
  help: "Total jobs failed",
  registers: [register],
});

export const jobsRequeued = new client.Counter({
  name: "comfy_jobs_requeued_total",
  help: "Total jobs requeued after failure/timeout",
  registers: [register],
});

export const redisEnqueueFailures = new client.Counter({
  name: "comfy_redis_enqueue_failures_total",
  help: "Times Redis enqueue failed and fell back to reconciler",
  registers: [register],
});

// Gauge for current queue state snapshot, refreshed right before each push
const jobStateGauge = new client.Gauge({
  name: "comfy_jobs_by_status",
  help: "Current job count by status and mode",
  labelNames: ["status", "mode"],
  registers: [register],
});

async function refreshGaugeFromDb() {
  const rows = await jobMetrics(); // [{status, mode, count}]
  jobStateGauge.reset();
  for (const row of rows) {
    jobStateGauge.set({ status: row.status, mode: row.mode }, row.count);
  }
}

export async function pushMetrics() {
  try {
    await refreshGaugeFromDb();
    await gateway.pushAdd({ jobName: "comfy_api" });
  } catch (e) {
    console.error("Pushgateway push failed:", e.message);
  }
}

let interval;
export function startMetricsLoop(intervalMs = Number(process.env.METRICS_PUSH_INTERVAL_MS || 15000)) {
  if (interval) return;
  interval = setInterval(pushMetrics, intervalMs);
  interval.unref?.(); // don't keep process alive just for this
}

export function stopMetricsLoop() {
  clearInterval(interval);
  interval = undefined;
}
export const jobsRunning = new client.Counter({
  name: "comfy_jobs_running_total",
  help: "Total jobs transitioned to running",
  registers: [register],
});

export const jobsStuckDetected = new client.Counter({
  name: "comfy_jobs_stuck_detected_total",
  help: "Total jobs found stuck/orphaned by the reconciler",
  registers: [register],
});

export const dbErrors = new client.Counter({
  name: "comfy_db_errors_total",
  help: "Total DB query failures, labeled by function",
  labelNames: ["fn"],
  registers: [register],
});

export { register };
