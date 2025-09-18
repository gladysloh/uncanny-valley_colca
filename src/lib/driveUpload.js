// src/lib/driveUpload.js

// Upload all images (array of src strings) to your Cloud Function
export async function uploadImagesToDriveAndSheet(images, prompt = "") {
  const endpoint = import.meta.env.VITE_UPLOAD_ENDPOINT;
  if (!endpoint) throw new Error("Missing VITE_UPLOAD_ENDPOINT in .env");

  // Sequential upload to keep it simple; switch to Promise.all if you prefer parallel
  for (let i = 0; i < images.length; i++) {
    const src = images[i];
    const filename = `car-gen-${Date.now()}-${i + 1}.${guessExtFromSrc(src)}`;
    await uploadOneImage({ endpoint, src, filename, prompt });
  }
}

// Upload a single image URL/data-URL to the endpoint
export async function uploadOneImage({ endpoint, src, filename, prompt = "" }) {
  // 1) Get a Blob for the image (works for http(s) and data: URLs)
  const blob = await fetchAsBlob(src);

  // 2) Convert Blob -> base64 (no data: prefix)
  const base64Body = await blobToBase64NoPrefix(blob);

  // 3) POST to your function
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" }, // CORS handled by function with cors()
    body: JSON.stringify({
      base64Body,
      filename,
      prompt,
      mimeType: blob.type || undefined
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    const err = json?.error || `Upload failed (${res.status})`;
    throw new Error(err);
  }
  return json; // { success, fileId, viewUrl, directUrl }
}

// ---------- helpers ----------

async function fetchAsBlob(src) {
  // fetch works for http(s) and data: URLs in modern browsers
  const r = await fetch(src, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
  return await r.blob();
}

function blobToBase64NoPrefix(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => {
      const dataUrl = fr.result; // e.g. "data:image/png;base64,AAAA..."
      const base64 = String(dataUrl).split("base64,")[1] || "";
      resolve(base64);
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function guessExtFromSrc(src) {
  // try to infer extension for nicer filenames
  if (/\.jpe?g(\?|$)/i.test(src)) return "jpg";
  if (/\.png(\?|$)/i.test(src)) return "png";
  if (/\.webp(\?|$)/i.test(src)) return "webp";
  // fallback by MIME from data URL
  if (/^data:image\/jpeg/i.test(src)) return "jpg";
  if (/^data:image\/png/i.test(src)) return "png";
  if (/^data:image\/webp/i.test(src)) return "webp";
  return "png";
}
