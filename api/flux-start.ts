import type { VercelRequest, VercelResponse } from "@vercel/node";

const BFL_API_KEY = process.env.BFL_API_KEY!;
const CREATE_URL = "https://api.bfl.ai/v1/flux-kontext-pro";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const body = req.body || {};
    const {
      prompt,
      aspect_ratio = "1:1",
      input_image,
      input_image_2,
      input_image_3,
      input_image_4,
      output_format = "jpeg",
      seed
    } = body;

    const r = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-key": BFL_API_KEY,
        accept: "application/json"
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio,
        input_image,
        input_image_2,
        input_image_3,
        input_image_4,
        output_format,
        seed
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status).json({ error: "create_failed", detail });
    }

    const json = await r.json(); // contains { id, polling_url, ... }
    return res.status(200).json({ id: json.id, polling_url: json.polling_url });
  } catch (err: any) {
    return res.status(500).json({ error: "unexpected", detail: err?.message || String(err) });
  }
}
