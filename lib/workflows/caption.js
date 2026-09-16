import { WorkflowGraph } from "../workflow-builder.js";

// Local, no-external-call tagging pass over an already-uploaded image.
// Requires a local tagger/captioner custom node (default assumes
// comfyui-wd14-tagger's WD14Tagger; override via LOCAL_CAPTION_NODE if
// you're running something else, e.g. a BLIP/Florence2 node).
export function buildCaption({
  image,
  taggerNode = process.env.LOCAL_CAPTION_NODE || "WD14Tagger",
  taggerModel = "wd-v1-4-moat-tagger-v2",
  threshold = 0.35,
} = {}) {
  if (!image) throw new Error("buildCaption requires an uploaded image filename");
  const g = new WorkflowGraph();
  const img = g.add("LoadImage", { image });
  g.add(taggerNode, { image: [img, 0], model: taggerModel, threshold });

  return {
    graph: g.toJSON(),
    requiredNodes: ["LoadImage", taggerNode],
    requiredModels: [],
  };
}
