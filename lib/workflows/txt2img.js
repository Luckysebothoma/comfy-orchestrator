import { WorkflowGraph } from "../workflow-builder.js";

export function buildTxt2Img({
  checkpoint = process.env.DEFAULT_CHECKPOINT || "dreamshaper_8.safetensors",
  positive = "a photo",
  negative = "low quality, blurry, deformed",
  width = 1024,
  height = 1024,
  steps = 25,
  cfg = 7,
  seed = null,
  sampler = "euler",
  scheduler = "normal",
} = {}) {
  const g = new WorkflowGraph();
  const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: checkpoint });
  const pos = g.add("CLIPTextEncode", { text: positive, clip: [ckpt, 1] });
  const neg = g.add("CLIPTextEncode", { text: negative, clip: [ckpt, 1] });
  const latent = g.add("EmptyLatentImage", { width, height, batch_size: 1 });
  const sample = g.add("KSampler", {
    model: [ckpt, 0],
    positive: [pos, 0],
    negative: [neg, 0],
    latent_image: [latent, 0],
    seed: seed ?? Math.floor(Math.random() * 1e15),
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    denoise: 1.0,
  });
  const decode = g.add("VAEDecode", { samples: [sample, 0], vae: [ckpt, 2] });
  g.add("SaveImage", { images: [decode, 0], filename_prefix: "orchestrator" });

  return {
    graph: g.toJSON(),
    requiredNodes: ["CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"],
    requiredModels: [checkpoint],
  };
}
