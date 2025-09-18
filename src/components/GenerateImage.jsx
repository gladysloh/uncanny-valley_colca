import { useEffect, useState, React } from "react";
import { GoogleGenAI } from "@google/genai";
import { uploadImagesToDriveAndSheet } from "../lib/driveUpload.js";
// import { getFunctions, httpsCallable } from "firebase/functions";
const endpoint = import.meta.env.VITE_UPLOAD_ENDPOINT;

import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogAction,
} from "@/components/ui/alert-dialog";

/** ---------------- helpers ---------------- **/
async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

async function fetchUrlAsFile(url, filenameHint = "car.png") {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    const blob = await res.blob();
    const ext = (filenameHint.split(".").pop() || "png").toLowerCase();
    const mime =
        ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
                ? "image/webp"
                : "image/png";
    return new File([blob], filenameHint, { type: mime });
}

function blobToBase64NoPrefix(blob) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onloadend = () => {
            const dataUrl = fr.result || "";
            const base64 = String(dataUrl).split("base64,")[1] || "";
            resolve(base64);
        };
        fr.onerror = reject;
        fr.readAsDataURL(blob);
    });
}

function guessExtFromSrc(src) {
    if (/\.jpe?g(\?|$)/i.test(src) || /^data:image\/jpeg/i.test(src)) return "jpg";
    if (/\.webp(\?|$)/i.test(src) || /^data:image\/webp/i.test(src)) return "webp";
    return "png"; // default
}

/** Convert files → inline images (base64 + mime) */
async function filesToInlineImages(files) {
    return Promise.all(
        files.map(async (f) => ({
            base64: await fileToBase64(f),
            mime: f.type || "image/png",
        }))
    );
}

/** ---------------- component ---------------- **/
export default function GenerateImage() {
    // CHANGED: support multiple files + previews
    const [imgFiles, setImgFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [showRemoveIdx, setShowRemoveIdx] = useState(null);

    const [prompt, setPrompt] = useState("");
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [activeImage, setActiveImage] = useState(null);

    // upload state
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState([]); // per-image status
    const [uploadedLinks, setUploadedLinks] = useState([]);

    const MODEL = "gemini-2.5-flash-image-preview"; // keep your model

    /** Build previews + cleanup */
    useEffect(() => {
        const urls = imgFiles.map((f) => URL.createObjectURL(f));
        setPreviews(urls);
        return () => urls.forEach((u) => URL.revokeObjectURL(u));
    }, [imgFiles]);

    /** Generate ONE composite output using up to 3 input images */
    async function generateComposite(genAI, images, promptText) {
        const model = genAI.getGenerativeModel?.({ model: MODEL });
        // Some SDKs use genAI.models.generateContent; keep both for compatibility
        const parts = [
            { text: promptText },
            ...images.map((img) => ({ inlineData: { data: img.base64, mimeType: img.mime } })),
        ];

        // Try getGenerativeModel path first
        if (model?.generateContent) {
            const res = await model.generateContent({ contents: [{ role: "user", parts }] });
            const p =
                res?.response?.candidates?.[0]?.content?.parts?.find((x) => x?.inlineData?.mimeType?.startsWith("image/"))
                    ?.inlineData;
            if (p?.data) return `data:${p.mimeType || "image/png"};base64,${p.data}`;
            // Some responses return generatedImages
            const u = res?.generatedImages?.[0]?.url;
            if (u) return u;
            console.log("Full response (no image found):", res);
            throw new Error("No image returned from the API.");
        }

        // Fallback to your original path
        const response = await genAI.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts }],
        });

        const urlCandidate = response?.generatedImages?.[0]?.url;
        if (urlCandidate) return urlCandidate;

        const partsOut = response?.candidates?.[0]?.content?.parts || [];
        const inline = partsOut.find((p) => p?.inlineData?.data)?.inlineData;
        if (inline?.data) return `data:${inline.mimeType || "image/png"};base64,${inline.data}`;

        console.log("Full response (no image found):", response);
        throw new Error("No image returned from the API.");
    }

    async function handleGenerateComposite() {
        setErrorMsg("");
        setResults([]);
        setUploadedLinks([]);
        setUploadProgress([]);

        if (!imgFiles.length) {
            setErrorMsg("Please upload 1–3 images.");
            return;
        }
        if (imgFiles.length > 3) {
            setErrorMsg("Maximum 3 images.");
            return;
        }
        if (!prompt.trim()) {
            setErrorMsg("Please enter a prompt.");
            return;
        }

        setLoading(true);
        try {
            const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
            if (!apiKey) throw new Error("Missing VITE_GEMINI_API_KEY in .env");
            const genAI = new GoogleGenAI({ apiKey });

            // Convert all selected files
            const inlineImages = await filesToInlineImages(imgFiles);

            // TIP: In multi-image edits, the LAST image sets the output aspect ratio.
            // If you need a specific canvas, add a blank plate as the last file.

            // Generate ONE composite image
            const imageUrl = await generateComposite(genAI, inlineImages, prompt);

            // Optional headline (kept from your original)
            const headline = await generateHeadline(genAI, prompt).catch(() => "");

            const result = [{ image: imageUrl, headline }];
            setResults(result);
            await handleUploadAll(result);

        } catch (err) {
            console.error(err);
            setErrorMsg(err?.message || "Generation failed.");
        } finally {
            setLoading(false);
        }
    }

    async function generateHeadline(genAI, promptText) {
        const response = await genAI.models.generateContent({
            model: "gemini-1.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: `Write ONE short, catchy automotive ad headline for this scene:

                            <scene>
                            ${promptText}
                            </scene>

                            Rules:
                            - Return ONLY the headline text. No quotes, no punctuation at the end, no explanations.
                            - Max 8 words.
                            - No brand names or model names.
                            - Tone: bold, modern, aspirational.
                            - English.
                            - Output format: a single line of text, no line breaks.`,
                        },
                    ],
                },
            ],
        });

        let t = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        t = t.trim();
        t = t.split(/\r?\n/)[0].replace(/^["“”']|["“”']$/g, "").trim();
        const words = t.split(/\s+/).slice(0, 8);
        return words.join(" ");
    }

    async function improveQuality() {
        //         4k HDR beautiful
        // photo of a corn stalk taken by a
        // professional photographer
        const response = await genAI.models.generateContent({
            model: "imagen-4.0-generate-001",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text: `Write ONE short, catchy automotive ad headline for this scene:

                            <scene>
                            ${promptText}
                            </scene>

                            Rules:
                            - Return ONLY the headline text. No quotes, no punctuation at the end, no explanations.
                            - Max 8 words.
                            - No brand names or model names.
                            - Tone: bold, modern, aspirational.
                            - English.
                            - Output format: a single line of text, no line breaks.`,
                        },
                    ],
                },
            ],
        });

        let t = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        t = t.trim();
        t = t.split(/\r?\n/)[0].replace(/^["“”']|["“”']$/g, "").trim();
        const words = t.split(/\s+/).slice(0, 8);
        return words.join(" ");

    }

    // === UPLOAD HANDLER (unchanged) ===
    async function handleUploadAll(items) {
        try {
            if (!endpoint) throw new Error("Missing VITE_UPLOAD_ENDPOINT in .env");
            if (!items?.length) throw new Error("No images to upload.");

            setUploading(true);
            setUploadProgress(Array(items.length).fill("pending"));
            const newLinks = [];

            for (let i = 0; i < items.length; i++) {
                setUploadProgress((prev) => {
                    const c = [...prev];
                    c[i] = "uploading";
                    return c;
                });
                const { image: src, headline = "" } = items[i];
                const r = await fetch(src, { cache: "no-cache" });
                if (!r.ok) throw new Error(`Failed to fetch generated image ${i + 1}`);
                const blob = await r.blob();

                const base64Body = await blobToBase64NoPrefix(blob);
                console.log(base64Body.slice(0, 30) + "...");
                const filename = `${Date.now()}-${i + 1}.${guessExtFromSrc(src)}`;

                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        base64Body,
                        filename,
                        prompt, // keep logging the scene prompt
                        headline, // send headline to function
                        mimeType: blob.type || undefined,
                    }),
                });

                const json = await res.json().catch(() => ({}));
                if (!res.ok || !json?.success) {
                    setUploadProgress((prev) => {
                        const c = [...prev];
                        c[i] = "error";
                        return c;
                    });
                    throw new Error(json?.error || `Upload failed (${res.status})`);
                }

                newLinks[i] = { viewUrl: json.viewUrl, directUrl: json.directUrl };

                setUploadProgress((prev) => {
                    const c = [...prev];
                    c[i] = "done";
                    return c;
                });
            }

            setUploadedLinks(newLinks);
        } catch (e) {
            console.error(e);
            setErrorMsg(e?.message || String(e));
        } finally {
            setUploading(false);
        }
    }

    // handler
    function handleSelectFiles(e) {
        const picked = Array.from(e.target.files || []).filter(
            (f) => f.type && f.type.startsWith("image/")
        );

        setImgFiles((prev) => {
            const merged = [...prev, ...picked];

            // de-dupe by (name|size|lastModified)
            const seen = new Set();
            const unique = [];
            for (const f of merged) {
                const key = `${f.name}|${f.size}|${f.lastModified}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push(f);
                }
            }

            return unique.slice(0, 3); // cap at 3
        });

        // allow picking the same file again later
        e.currentTarget.value = "";
    }

    function toggleRemove(i) {
        setShowRemoveIdx((prev) => (prev === i ? null : i));
    }

    function removeAt(i) {
        // optional: free this preview URL if you manage it here
        if (previews[i]) URL.revokeObjectURL(previews[i]);

        setImgFiles((prev) => prev.filter((_, idx) => idx !== i));
        // If previews is derived from imgFiles via useEffect, you can omit the next line:
        setPreviews((prev) => prev.filter((_, idx) => idx !== i));

        setShowRemoveIdx(null);
    }

    return (
        <div className="max-w-screen w-6xl mx-auto p-6 space-y-8">
            <h1 className="text-2xl font-bold tracking-tight text-center">COLCA</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* --- gallery --- */}
                <section className="space-y-4">
                    <h3 className="text-lg font-semibold">Upload Images</h3>
                    <label className="text-sm text-gray-600">Select up to 3 images to compose:</label>
                    <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={handleSelectFiles}
                        className="
                            block w-full text-sm text-gray-600 pt-3
                            file:mr-3 file:rounded-md file:border-0
                            file:bg-black file:px-3 file:py-2 file:text-white
                            hover:file:bg-neutral-800
                            file:cursor-pointer
                            focus:outline-none focus:ring-2 focus:ring-black/30
                        "
                    />

                    <div className="border border-gray-300 rounded-md p-4 space-y-3">

                        {/* One-row preview (scrolls horizontally if needed) */}
                        <div className="flex items-center gap-2 overflow-x-auto">
                            {previews.length ? (
                                previews.map((url, i) => (
                                    <div
                                        key={i}
                                        className="relative h-30 w-30 shrink-0 overflow-hidden rounded-md border border-gray-200"
                                    >
                                        <img
                                            src={url}
                                            alt={`Preview ${i + 1}`}
                                            className="h-full w-full object-cover cursor-pointer"
                                            onClick={() => toggleRemove(i)}
                                        />

                                        {/* X button appears after click */}
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeAt(i);
                                            }}
                                            className={`absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full
                      bg-black/70 text-white text-xs transition
                      ${showRemoveIdx === i ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                                            aria-label="Remove image"
                                            title="Remove"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))
                            ) : (
                                <div className="h-20 w-full text-xs text-gray-500 flex items-center justify-center">
                                    No images selected
                                </div>
                            )}
                        </div>

                    </div>
                </section>

                {/* --- controls --- */}
                <section className="flex flex-col gap-4">
                    <label className="flex flex-col gap-2">
                        <h3 className="text-lg font-semibold">Prompt</h3>
                        <textarea
                            rows={5}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            className="w-full rounded-md border border-gray-300 p-3 text-sm shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-300"
                            placeholder="[what to change/add/compose], [surface/background], [lighting + mood], [fine detail]."
                        />
                    </label>

                    <button
                        onClick={handleGenerateComposite}
                        disabled={loading || uploading}
                        className="rounded-md bg-black px-4 py-2 text-white font-medium shadow hover:opacity-80 disabled:bg-gray-300 disabled:opacity-50"
                    >
                        {loading ? "Generating…" : "Generate Image"}
                    </button>

                    <AlertDialog open={!!errorMsg} onOpenChange={(open) => !open && setErrorMsg("")}>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>⚠️ Something went wrong</AlertDialogTitle>
                                <AlertDialogDescription className="whitespace-pre-wrap">
                                    {errorMsg}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogAction onClick={() => setErrorMsg("")}>OK</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </section>
            </div>

            {/* --- results --- */}
            <section className="space-y-4">
                <h3 className="text-lg font-semibold">Results</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {results.map((src, i) => {
                        const status = uploadProgress[i]; // pending | uploading | done | error
                        const links = uploadedLinks[i];

                        return (
                            <div className="flex flex-col" key={src?.image || i}>
                                <div
                                    className="aspect-square rounded-lg border border-gray-200 bg-gray-50 flex flex-col items-stretch justify-between overflow-hidden cursor-pointer"
                                    onClick={() => src && setActiveImage(src.image)}
                                >
                                    <div className="flex-1 flex items-center justify-center overflow-hidden">
                                        {src && src.image ? (
                                            <img src={src.image} alt={`Generated ${i + 1}`} className="object-cover w-full h-full" />
                                        ) : (
                                            <div className="flex items-center gap-2 text-gray-500 text-xs">
                                                {loading ? (
                                                    <>
                                                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
                                                        <span>Generating image...</span>
                                                    </>
                                                ) : (
                                                    <span>Placeholder</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* upload status / links */}
                                <div className="p-2 bg-white text-xs">
                                    {!src ? null : status === "uploading" ? (
                                        <div className="flex items-center gap-2 text-gray-600">
                                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
                                            <span>Uploading…</span>
                                        </div>
                                    ) : status === "done" ? (
                                        links ? (
                                            <div className="space-y-1">
                                                <div className="text-emerald-700 font-medium">Uploaded</div>
                                                <div className="truncate">
                                                    <a
                                                        href={links.viewUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="text-blue-600 underline"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        View
                                                    </a>{" "}
                                                    ·{" "}
                                                    <a
                                                        href={links.directUrl}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="text-blue-600 underline"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        Direct
                                                    </a>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="text-emerald-700">Uploaded</div>
                                        )
                                    ) : status === "error" ? (
                                        <div className="text-red-600">Upload failed</div>
                                    ) : results.length ? (
                                        <div className="text-gray-500">Ready to upload</div>
                                    ) : null}
                                </div>

                                <div className="p-2 text-xs">
                                    {src?.headline && (
                                        <div className="font-medium text-gray-800 truncate" title={src.headline}>
                                            “{src.headline}”
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* fullscreen modal */}
                {activeImage && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80"
                        onClick={() => setActiveImage(null)}
                    >
                        <img src={activeImage} alt="Fullscreen" className="max-h-[90%] max-w-[90%] object-contain rounded-lg shadow-lg" />
                    </div>
                )}
            </section>
        </div>
    );
}
