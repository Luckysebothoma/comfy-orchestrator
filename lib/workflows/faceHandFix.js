import { WorkflowGraph } from "../workflow-builder.js";

// Chains a base generation into a face-detail pass and a hand-detail pass
// using ComfyUI-Impact-Pack (UltralyticsDetectorProvider + FaceDetailer).
// NOTE: FaceDetailer's exact input schema drifts between Impact Pack
// versions — verify field names against `GET /comfy/object-info` on your
// instance (or `POST /precheck`) before relying on this in production.
// Detector filenames are configurable via env because they depend on what
// you actually downloaded into models/ultralytics/bbox.
export function buildFaceHandFix({
  checkpoint = process.env.DEFAULT_CHECKPOINT || "dreamshaper_8.safetensors",
  image,
  positive = "detailed, sharp focus",
  negative = "low quality, blurry, deformed",
  faceDetector = process.env.FACE_DETECTOR_MODEL || "bbox/face_yolov8m.pt",
  handDetector = process.env.HAND_DETECTOR_MODEL || "bbox/hand_yolov8s.pt",
  denoise = 0.5,
  steps = 20,
  cfg = 7,
} = {}) {
  if (!image) throw new Error("buildFaceHandFix requires an uploaded image filename");
  const g = new WorkflowGraph();
  const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: checkpoint });
  const img = g.add("LoadImage", { image });
  const pos = g.add("CLIPTextEncode", { text: positive, clip: [ckpt, 1] });
  const neg = g.add("CLIPTextEncode", { text: negative, clip: [ckpt, 1] });

  const detailPass = (sourceNode, detectorModel) => {
    const detector = g.add("UltralyticsDetectorProvider", { model_name: detectorModel });
    return g.add("FaceDetailer", {
      image: [sourceNode, 0],
      model: [ckpt, 0],
      clip: [ckpt, 1],
      vae: [ckpt, 2],
      positive: [pos, 0],
      negative: [neg, 0],
      bbox_detector: [detector, 0],
      guide_size: 384,
      guide_size_for: true,
      max_size: 1024,
      seed: Math.floor(Math.random() * 1e15),
      steps,
      cfg,
      sampler_name: "euler",
      scheduler: "normal",
      denoise,
      feather: 5,
      noise_mask: true,
      force_inpaint: true,
      bbox_threshold: 0.5,
      bbox_dilation: 10,
      bbox_crop_factor: 3,
      sam_detection_hint: "center-1",
    });
  };

  const faceFixed = detailPass(img, faceDetector);
  const handFixed = detailPass(faceFixed, handDetector);
  g.add("SaveImage", { images: [handFixed, 0], filename_prefix: "orchestrator_facehand" });

  return {
    graph: g.toJSON(),
    requiredNodes: [
      "CheckpointLoaderSimple", "LoadImage", "CLIPTextEncode",
      "UltralyticsDetectorProvider", "FaceDetailer", "SaveImage",
    ],
    requiredModels: [checkpoint],
  };
}
