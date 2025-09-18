import type { VercelRequest, VercelResponse } from "@vercel/node";

const BFL_API_KEY = process.env.BFL_API_KEY!;

/**
 * Client calls: /api/flux-status?polling_url=...
 * We proxy one poll step (no long-running work). If status === "Ready",
 * we also fetch the signed image and return a browser-safe data URL.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const polling_url = String(req.query.polling_url || "");
    if (!polling_url) return res.status(400).json({ error: "missing_polling_url" });

    // 1) Poll BFL for the current status
    const poll = await fetch(polling_url, {
      headers: { accept: "application/json", "x-key": BFL_API_KEY }
    });
    if (!poll.ok) {
      const detail = await poll.text();
      return res.status(poll.status).json({ error: "poll_failed", detail });
    }
    const info = await poll.json();

    // Expected statuses are documented by BFL (e.g., Ready / Failed, etc.)
    // When ready, result.sample is a signed URL, valid ~10 minutes and with no CORS.
    // We fetch it server-side and return a base64 data URL for the browser. :contentReference[oaicite:1]{index=1}
    if (info?.status === "Ready") {
      const sampleUrl =
        info?.result?.sample ||
        info?.result?.images?.[0]?.url;
      if (!sampleUrl) return res.status(500).json({ error: "no_sample_url", info });

      const img = await fetch(sampleUrl);
      if (!img.ok) {
        const detail = await img.text();
        return res.status(502).json({ error: "fetch_image_failed", detail });
      }
      const ab = await img.arrayBuffer();
      const base64 = Buffer.from(ab).toString("base64");
      const mime = "image/jpeg"; // output_format defaulted to jpeg above
      return res.status(200).json({
        status: "Ready",
        width: info?.result?.width,
        height: info?.result?.height,
        dataUrl: `data:${mime};base64,${base64}`
      });
    }

    // Not ready yet (or failed) — just forward status payload
    return res.status(200).json(info);
  } catch (err: any) {
    return res.status(500).json({ error: "unexpected", detail: err?.message || String(err) });
  }
}
