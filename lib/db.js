import pg from "pg";
const { Pool } = pg;
import {
  jobsEnqueued,
  jobsSubmitted,
  jobsRunning,
  jobsCompleted,
  jobsFailed,
  jobsRequeued,
  jobsStuckDetected,
  dbErrors,
} from "./metrics.js";

export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
  max: 10,
});

// Shared wrapper: every query path gets the same error metric + rethrow behavior.
// No function silently swallows a failure.
async function withDbErrorMetric(fnName, fn) {
  try {
    return await fn();
  } catch (e) {
    dbErrors.inc({ fn: fnName });
    console.error(`DB error in ${fnName}:`, e.message);
    throw e; // never swallow — caller must know the operation failed
  }
}

export async function insertJob(payload, opts = {}) {
  return withDbErrorMetric("insertJob", async () => {
    const {
      externalRef = null,
      mode = "raw",
      promptText = null,
      callbackUrl = null,
      maxAttempts = Number(process.env.COMFY_MAX_ATTEMPTS || 5),
    } = opts;
    const { rows } = await pool.query(
      `INSERT INTO comfy_jobs (payload, external_ref, mode, prompt_text, callback_url, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, status, mode, external_ref, prompt_text, callback_url, max_attempts, created_at`,
      [payload, externalRef, mode, promptText, callbackUrl, maxAttempts]
    );
    const job = rows[0];
    jobsEnqueued.inc({ mode: job.mode }); // now tracked here, not just in enqueueGraph
    return job;
  });
}

export async function getJob(id) {
  return withDbErrorMetric("getJob", async () => {
    const { rows } = await pool.query(`SELECT * FROM comfy_jobs WHERE id = $1`, [id]);
    return rows[0] || null;
  });
}

export async function listJobs({ status = null, mode = null, limit = 50 } = {}) {
  return withDbErrorMetric("listJobs", async () => {
    const clauses = [];
    const params = [];
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (mode)   { params.push(mode);   clauses.push(`mode = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, external_ref, mode, status, attempts, max_attempts, error,
              created_at, updated_at, completed_at
         FROM comfy_jobs ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    return rows;
  });
}

export async function markSubmitted(id, promptId) {
  return withDbErrorMetric("markSubmitted", async () => {
    await pool.query(
      `UPDATE comfy_jobs
          SET status = 'submitted', comfy_prompt_id = $2,
              attempts = attempts + 1, submitted_at = now()
        WHERE id = $1`,
      [id, promptId]
    );
    jobsSubmitted.inc();
  });
}

export async function markRunning(id) {
  return withDbErrorMetric("markRunning", async () => {
    await pool.query(`UPDATE comfy_jobs SET status = 'running' WHERE id = $1`, [id]);
    jobsRunning.inc(); // was completely untracked before
  });
}

export async function markCompleted(id, result) {
  return withDbErrorMetric("markCompleted", async () => {
    await pool.query(
      `UPDATE comfy_jobs
          SET status = 'completed', result = $2, completed_at = now(), error = NULL
        WHERE id = $1`,
      [id, result]
    );
    jobsCompleted.inc();
  });
}

export async function markFailed(id, errMsg) {
  return withDbErrorMetric("markFailed", async () => {
    await pool.query(
      `UPDATE comfy_jobs SET status = 'failed', error = $2 WHERE id = $1`,
      [id, errMsg]
    );
    jobsFailed.inc();
  });
}

export async function requeue(id, errMsg) {
  return withDbErrorMetric("requeue", async () => {
    await pool.query(
      `UPDATE comfy_jobs SET status = 'queued', error = $2 WHERE id = $1`,
      [id, errMsg || null]
    );
    jobsRequeued.inc();
  });
}

export async function findStuckOrOrphaned(stuckAfterMs) {
  return withDbErrorMetric("findStuckOrOrphaned", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM comfy_jobs
        WHERE status = 'queued'
           OR (status IN ('submitted','running') AND updated_at < now() - ($1 || ' milliseconds')::interval)`,
      [String(stuckAfterMs)]
    );
    if (rows.length > 0) {
      jobsStuckDetected.inc(rows.length); // was never recorded before
    }
    return rows.map((r) => r.id);
  });
}

export async function metrics() {
  return withDbErrorMetric("metrics", async () => {
    const { rows } = await pool.query(
      `SELECT status, mode, COUNT(*)::int AS count FROM comfy_jobs GROUP BY status, mode`
    );
    return rows;
  });
}