// src/pages/UploadTest.jsx
import { useState } from "react";

export default function UploadTest() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [prompt, setPrompt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const endpoint = import.meta.env.VITE_UPLOAD_ENDPOINT; // e.g. https://<region>-<project>.cloudfunctions.net/processImageAndUpload

  function onPick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setErrorMsg("");

    // show preview
    const url = URL.createObjectURL(f);
    setPreview(url);
  }

  async function handleUpload() {
    try {
      if (!endpoint) throw new Error("Missing VITE_UPLOAD_ENDPOINT in .env");
      if (!file) throw new Error("Pick an image first.");

      setUploading(true);
      setErrorMsg("");
      setResult(null);

      // blob -> base64 (no data: prefix)
      const base64Body = await fileToBase64NoPrefix(file);
      const filename = buildFilename(file);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Body,
          filename,
          prompt,
          mimeType: file.type || undefined,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Upload failed (${res.status})`);
      }

      setResult(json); // { success, fileId, viewUrl, directUrl }
    } catch (e) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">Upload Test → Firebase Function</h1>

      <div className="space-y-3">
        <label className="block text-sm font-medium">Pick an image</label>
        <input
          type="file"
          accept="image/*"
          onChange={onPick}
          className="block w-full text-sm"
        />

        {preview && (
          <div className="mt-2">
            <img
              src={preview}
              alt="preview"
              className="rounded-md border w-full max-h-80 object-contain bg-gray-50"
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium">Optional prompt / note</label>
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Any notes to log in the sheet"
          className="w-full rounded-md border border-gray-300 p-3 text-sm shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-300"
        />
      </div>

      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className="rounded-md bg-blue-600 px-4 py-2 text-white font-medium shadow hover:bg-blue-700 disabled:bg-gray-300 disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Upload to Drive + Sheet"}
      </button>

      {errorMsg && (
        <p className="text-sm text-red-600 font-medium">⚠️ {errorMsg}</p>
      )}

      {result && (
        <div className="rounded-lg border p-4 bg-white space-y-2">
          <h2 className="font-semibold">Result</h2>
          <div className="text-sm">
            <div><span className="font-medium">File ID:</span> {result.fileId}</div>
            <div>
              <span className="font-medium">View link:</span>{" "}
              <a
                href={result.viewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline break-all"
              >
                {result.viewUrl}
              </a>
            </div>
            <div>
              <span className="font-medium">Direct link:</span>{" "}
              <a
                href={result.directUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline break-all"
              >
                {result.directUrl}
              </a>
            </div>
          </div>
        </div>
      )}

      <EnvHint endpoint={endpoint} />
    </div>
  );
}

/* ---------------- helpers ---------------- */

function buildFilename(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const cleanExt = ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "png";
  const base = file.name.replace(/\.[^/.]+$/, "") || "upload";
  return `${base}-${Date.now()}.${cleanExt}`;
}

function fileToBase64NoPrefix(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => {
      const dataUrl = fr.result || "";
      const base64 = String(dataUrl).split("base64,")[1] || "";
      resolve(base64);
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function EnvHint({ endpoint }) {
  if (endpoint) return null;
  return (
    <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm">
      <div className="font-medium">Heads up</div>
      <div>
        You haven’t set <code className="font-mono">VITE_UPLOAD_ENDPOINT</code>.
        Add it to your <code className="font-mono">.env</code>:
      </div>
      <pre className="mt-2 bg-white p-2 rounded border overflow-x-auto text-xs">{`VITE_UPLOAD_ENDPOINT=https://<region>-<project>.cloudfunctions.net/processImageAndUpload`}</pre>
    </div>
  );
}
