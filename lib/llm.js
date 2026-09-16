const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const REFINE_INSTRUCTION =
  "Turn the following image tags/description into a single, vivid, well-composed " +
  "Stable Diffusion prompt. Return only the prompt text, nothing else.";

export async function refineWithGroq(description, {
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
} = {}) {
  if (!apiKey) throw new Error("GROQ_API_KEY not set");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: REFINE_INSTRUCTION },
        { role: "user", content: description },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq refine failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || description;
}

export async function refineWithGemini(description, {
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || "gemini-2.0-flash",
} = {}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const res = await fetch(`${GEMINI_URL(model)}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${REFINE_INSTRUCTION}\n\n${description}` }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini refine failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || description;
}
