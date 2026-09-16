const COMFY_URL = process.env.COMFY_URL || "http://192.168.0.138:8188";

export async function submitPrompt(prompt) {
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    throw new Error(`ComfyUI submit failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.prompt_id) throw new Error("ComfyUI response missing prompt_id");
  return data.prompt_id; 
}

export async function fetchHistory(promptId) {
  const res = await fetch(`${COMFY_URL}/history/${promptId}`);
  if (!res.ok) {
    throw new Error(`ComfyUI history fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data[promptId] || null; // null => not finished yet
}

export async function comfyHealthy() {
  try {
    const res = await fetch(`${COMFY_URL}/system_stats`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getSystemStats() {
  const res = await fetch(`${COMFY_URL}/system_stats`);
  if (!res.ok) throw new Error(`ComfyUI system_stats failed: ${res.status}`);
  return res.json();
}

export async function getObjectInfo() {
  const res = await fetch(`${COMFY_URL}/object_info`);
  if (!res.ok) throw new Error(`ComfyUI object_info failed: ${res.status}`);
  return res.json();
}

export async function getQueue() {
  const res = await fetch(`${COMFY_URL}/queue`);
  if (!res.ok) throw new Error(`ComfyUI queue fetch failed: ${res.status}`);
  return res.json();
}

// Uploads raw image bytes to ComfyUI's own input directory. This is the
// ONLY place image bytes for a job leave this orchestrator, and they only
// ever go to your own local ComfyUI instance — never to an external LLM.
export async function uploadImage(buffer, filename, { subfolder = "", overwrite = true } = {}) {
  const form = new FormData();
  form.append("image", new Blob([buffer]), filename);
  if (subfolder) form.append("subfolder", subfolder);
  form.append("overwrite", String(overwrite));
  const res = await fetch(`${COMFY_URL}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status} ${await res.text()}`);
  return res.json(); // { name, subfolder, type }
}

export function viewImageUrl({ filename, subfolder = "", type = "output" }) {
  const qs = new URLSearchParams({ filename, subfolder, type });
  return `${COMFY_URL}/view?${qs.toString()}`;
}

export async function interruptCurrent() {
  const res = await fetch(`${COMFY_URL}/interrupt`, { method: "POST" });
  return res.ok;
}

export async function freeMemory({ unloadModels = true, freeMemory: freeMem = true } = {}) {
  const res = await fetch(`${COMFY_URL}/free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMem }),
  });
  return res.ok;
}

export { COMFY_URL };
