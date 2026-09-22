// Controls how many variants a chat image request produces, and how each
// variant is nudged to actually look different.
//
// ROOT CAUSE of the old "variants differ by a tiny bit humans can't see"
// problem: the n8n "Generate Image Variants" node jittered `denoise` on
// node 5 (KSampler) between ~0.85 and 1.0 for every variant, but node 4 is
// EmptyLatentImage — a blank/zero latent, not a real image. denoise < 1.0
// only makes sense when the latent already holds real image content (i.e.
// img2img); on an empty latent it just tells the sampler to run as if part
// of the denoising had already happened, which under-generates the image
// (less structure actually gets formed) instead of producing a genuinely
// different composition. Every variant ended up as a slightly-less-finished
// version of nearly the same noise pattern — hence "tiny, imperceptible"
// differences. Fix: denoise stays pinned at 1.0 for txt2img variants
// (VARIANT_DENOISE_JITTER_ENABLED=false by default); real diversity comes
// from independent random seeds, prompt micro-variation, and cfg/steps/
// sampler jitter instead. The denoise knobs are kept, disabled by default,
// for when variants are built from a real source image (img2img).

const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};
const envFloat = envInt;
const envBool = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const PROMPT_SUFFIXES = (
  process.env.VARIANT_PROMPT_SUFFIXES ||
  "|, dramatic lighting, alternate composition|, different camera angle, richer color grading|, moodier atmosphere, altered framing|, distinct focal point, reimagined staging"
).split("|");

const SAMPLER_POOL = (process.env.VARIANT_SAMPLER_POOL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function resolveVariantCount(requested) {
  const def = envInt("VARIANT_COUNT_DEFAULT", 1);
  const max = envInt("VARIANT_COUNT_MAX", 4);
  const n = requested && Number(requested) > 0 ? Number(requested) : def;
  return clamp(Math.floor(n), 1, Math.max(1, max));
}

// base: { positive_prompt, steps, cfg }
// index: 0-based variant index. index 0 is always the "clean" render —
// base seed/steps/cfg/prompt, no jitter — so there's always one
// undistorted result even if jitter ranges are set aggressively.
export function buildVariantParams(base, index) {
  const seedMode = process.env.VARIANT_SEED_MODE || "random"; // "random" | "stride"
  const seedStride = envInt("VARIANT_SEED_STRIDE", 104729); // large prime
  let seed;
  if (index === 0) {
    seed = base.seed ?? Math.floor(Math.random() * 1_000_000_000);
  } else if (seedMode === "stride") {
    const baseSeed = base.seed ?? Math.floor(Math.random() * 1_000_000_000);
    seed = (baseSeed + index * seedStride) % 1_000_000_000;
  } else {
    seed = Math.floor(Math.random() * 1_000_000_000);
  }

  const stepsJitter = envInt("VARIANT_STEPS_JITTER", 4);
  const steps =
    index === 0
      ? base.steps
      : clamp(base.steps + (Math.floor(Math.random() * (2 * stepsJitter + 1)) - stepsJitter), 10, 60);

  const cfgJitter = envFloat("VARIANT_CFG_JITTER", 1.5);
  const cfg = index === 0 ? base.cfg : Number((base.cfg + (Math.random() * 2 - 1) * cfgJitter).toFixed(2));

  const denoiseJitterEnabled = envBool("VARIANT_DENOISE_JITTER_ENABLED", false);
  let denoise = 1.0;
  if (denoiseJitterEnabled && index !== 0) {
    const denoiseMin = envFloat("VARIANT_DENOISE_MIN", 0.75);
    const denoiseMax = envFloat("VARIANT_DENOISE_MAX", 1.0);
    denoise = Number((denoiseMin + Math.random() * (denoiseMax - denoiseMin)).toFixed(2));
  }

  const suffix = PROMPT_SUFFIXES[index % PROMPT_SUFFIXES.length] || "";
  const positive_prompt = index === 0 ? base.positive_prompt : `${base.positive_prompt}${suffix}`;

  const sampler = index > 0 && SAMPLER_POOL.length ? SAMPLER_POOL[index % SAMPLER_POOL.length] : undefined;

  return { seed, steps, cfg, denoise, positive_prompt, sampler };
}
