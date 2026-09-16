import { WorkflowGraph } from "../workflow-builder.js";

// `image` must already exist in ComfyUI's own input dir — upload it first
// via lib/comfy.js#uploadImage and pass back the returned filename here.
export function buildImg2Img({
  checkpoint = process.env.DEFAULT_CHECKPOINT || "dreamshaper_8.safetensors",
  image,
  positive = "a photo",
  negative = "low quality, blurry, deformed",
  denoise = 0.65,
  steps = 25,
  cfg = 7,
  seed = null,
  sampler = "euler",
  scheduler = "normal",
} = {}) {
  if (!image) throw new Error("buildImg2Img requires an uploaded image filename");
  const g = new WorkflowGraph();
  const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: checkpoint });
  const img = g.add("LoadImage", { image });
  const pos = g.add("CLIPTextEncode", { text: positive, clip: [ckpt, 1] });
  const neg = g.add("CLIPTextEncode", { text: negative, clip: [ckpt, 1] });
  const encoded = g.add("VAEEncode", { pixels: [img, 0], vae: [ckpt, 2] });
  const sample = g.add("KSampler", {
    model: [ckpt, 0],
    positive: [pos, 0],
    negative: [neg, 0],
    latent_image: [encoded, 0],
    seed: seed ?? Math.floor(Math.random() * 1e15),
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    denoise,
  });
  const decode = g.add("VAEDecode", { samples: [sample, 0], vae: [ckpt, 2] });
  g.add("SaveImage", { images: [decode, 0], filename_prefix: "orchestrator_i2i" });

  return {
    graph: g.toJSON(),
    requiredNodes: ["CheckpointLoaderSimple", "LoadImage", "CLIPTextEncode", "VAEEncode", "KSampler", "VAEDecode", "SaveImage"],
    requiredModels: [checkpoint],
  };
}
