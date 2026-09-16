import fs from "node:fs";
import path from "node:path";
import { getObjectInfo } from "./comfy.js";

const MODELS_DIR = process.env.COMFY_MODELS_DIR || "/models";

export async function checkRequirements({ requiredNodes = [], requiredModels = [] }) {
  const missing = { nodes: [], models: [] };

  try {
    const objectInfo = await getObjectInfo();
    for (const node of requiredNodes) {
      if (!objectInfo[node]) missing.nodes.push(node);
    }
  } catch (e) {
    missing.nodes.push(...requiredNodes.map((n) => `${n} (couldn't reach ComfyUI: ${e.message})`));
  }

  const found = listModelFiles();
  for (const model of requiredModels) {
    if (!found.has(model)) missing.models.push(model);
  }

  return { ok: missing.nodes.length === 0 && missing.models.length === 0, missing };
}

function listModelFiles() {
  const found = new Set();
  if (!fs.existsSync(MODELS_DIR)) return found;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.add(entry.name);
    }
  };
  walk(MODELS_DIR);
  return found;
}

export async function alert(message) {
  console.error(`[ALERT] ${message}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `comfy-orchestrator alert: ${message}` }),
    });
  } catch (e) {
    console.error(`[ALERT] webhook delivery failed: ${e.message}`);
  }
}
