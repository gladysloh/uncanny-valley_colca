import { useEffect, useState } from "react";
import { GoogleGenAI } from "@google/genai";
import { uploadImagesToDriveAndSheet } from "../lib/driveUpload.js";
// import { getFunctions, httpsCallable } from "firebase/functions";
const endpoint = import.meta.env.VITE_UPLOAD_ENDPOINT

import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogAction
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
/** ---------------- component ---------------- **/

export default function GenerateCar() {
    const GALLERY = [
        { name: "Blue", thumbnail: "Blue-07.png", source: "Blue.png" },
        { name: "Red", thumbnail: "Red-07.jpeg", source: "Red.jpeg" },
        { name: "White", thumbnail: "White-07.jpg", source: "White.png" }
    ];

    const [carFile, setCarFile] = useState(null);
    const [selectedUrl, setSelectedUrl] = useState(null);
    const [selectedCar, setSelectedCar] = useState(null);
    const [prompt, setPrompt] = useState("The car is parked neatly for a composed pose, framed by luxury condominiums with landscaped gardens and palm trees, warm golden-hour light with long gentle shadows, the scene feels calm and aspirational as the paint catches a soft glow. Cinematic, photorealistic automotive advertisement.");
    const [results, setResults] = useState([]); // <-- multiple images
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [activeImage, setActiveImage] = useState(null);

    // upload state
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState([]); // per-image status
    const [uploadedLinks, setUploadedLinks] = useState([]);   // {viewUrl, directUrl} per image


    const MODEL = "gemini-2.5-flash-image-preview"; // aka Nano Banana

    const angleVariants = [
        "A wide shot from the right front corner, showing the full car with strong perspective on the grille, headlights, and road context.",
        "A direct right-side profile shot, capturing the entire car cleanly with emphasis on proportions and reflections.",
        "An ultra-wide establishing shot from a distance, showing the full car in context with the broad environment and horizon.",
        "A dramatic low-angle shot from near the ground, making the car appear dominant with sky and surroundings rising behind it."
    ];

    // const functions = getFunctions();
    // const processImage = httpsCallable(functions, 'processImageAndUpload');

    async function handlePickFromGallery(item) {
        try {
            const url = `/car/source/${item.source}`; // served from /public
            const file = await fetchUrlAsFile(url, item.source);
            setSelectedUrl(url);
            setSelectedCar(item.name)
            setCarFile(file);
            setErrorMsg("");
        } catch (e) {
            console.error(e);
            setErrorMsg("Could not load the selected car image.");
        }
    }

    // Helper: one generation call -> normalized image src (URL or data:)
    async function generateOne(genAI, base64, mimeType, promptText) {
        const contents = [
            {
                role: "user",
                parts: [
                    { text: promptText },
                    { inlineData: { mimeType: mimeType || "image/png", data: base64 } },
                ],
            },
        ];

        const response = await genAI.models.generateContent({
            model: MODEL,
            contents,
        });

        const urlCandidate = response?.generatedImages?.[0]?.url;
        if (urlCandidate) return urlCandidate;

        const parts = response?.candidates?.[0]?.content?.parts || [];
        const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
        if (inline?.data) return `data:${inline.mimeType || "image/png"};base64,${inline.data}`;

        console.log("Full response (no image found):", response);
        throw new Error("No image returned from the API.");
    }

    async function handleGenerateFour() {
        setErrorMsg("");
        setResults([]);

        setUploadedLinks([]);
        setUploadProgress([]);

        if (!carFile) {
            setErrorMsg("Please select a car image.");
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

            const base64 = await fileToBase64(carFile);

            // Create 4 slightly varied prompts to encourage diversity
            const variants = [
                `${prompt}${angleVariants[3]}`,
                `${prompt}${angleVariants[0]}`,
                `${prompt}${angleVariants[1]}`,
                `${prompt}${angleVariants[2]}`
            ];
            // 1. generate images
            const tasks = variants.map((p) => generateOne(genAI, base64, carFile.type, p));
            const imgs = await Promise.all(tasks);

            // 2. generate headlines
            const headlineTasks = variants.map((p) => generateHeadline(genAI, p));
            const headlines = await Promise.all(headlineTasks);
            console.log("Generated headlines:", headlines);

            // 3. pair them
            const results = imgs.map((url, i) => ({
                image: url,
                headline: headlines[i],
            }));

            setResults(results);
            await handleUploadAll(results)

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
            contents: [{
                role: "user",
                parts: [{
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
                - Output format: a single line of text, no line breaks.`
                }]
            }]
        });

        // Extract text
        let t = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        t = t.trim();

        // Defensive cleanup: take first line, strip quotes, enforce max 8 words
        t = t.split(/\r?\n/)[0].replace(/^["“”']|["“”']$/g, "").trim();
        const words = t.split(/\s+/).slice(0, 8);
        return words.join(" ");
    }


    // === UPLOAD HANDLER ===
    async function handleUploadAll(items) {
        try {
            if (!endpoint) throw new Error("Missing VITE_UPLOAD_ENDPOINT in .env");
            if (!items?.length) throw new Error("No images to upload.");

            setUploading(true);
            setUploadProgress(Array(items.length).fill("pending"));
            const newLinks = [];

            for (let i = 0; i < items.length; i++) {
                setUploadProgress(prev => { const c = [...prev]; c[i] = "uploading"; return c; });

                const { image: src, headline = "" } = items[i];

                // fetch to Blob
                const r = await fetch(src, { cache: "no-cache" });
                if (!r.ok) throw new Error(`Failed to fetch generated image ${i + 1}`);
                const blob = await r.blob();

                const base64Body = await blobToBase64NoPrefix(blob);
                const filename = `car-gen-${Date.now()}-${i + 1}.${guessExtFromSrc(src)}`;

                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        base64Body,
                        filename,
                        prompt,                   // keep logging the scene prompt
                        headline,                // 👈 NEW: send headline to function
                        mimeType: blob.type || undefined
                    })
                });

                const json = await res.json().catch(() => ({}));
                if (!res.ok || !json?.success) {
                    setUploadProgress(prev => { const c = [...prev]; c[i] = "error"; return c; });
                    throw new Error(json?.error || `Upload failed (${res.status})`);
                }

                newLinks[i] = { viewUrl: json.viewUrl, directUrl: json.directUrl };

                setUploadProgress(prev => { const c = [...prev]; c[i] = "done"; return c; });
            }

            setUploadedLinks(newLinks);
        } catch (e) {
            console.error(e);
            setErrorMsg(e?.message || String(e));
        } finally {
            setUploading(false);
        }
    }

    return (
        <div className="max-w-6xl mx-auto p-6 space-y-8">

            <h1 className="text-2xl font-bold tracking-tight text-center">COLCA</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* --- gallery --- */}
                <section className="space-y-4">
                    <h3 className="text-lg font-semibold">Choose a car</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        {GALLERY.map((item) => {
                            const url = `/car/thumbnail/${item.thumbnail}`;
                            const isSelected = selectedCar === item.name;
                            return (
                                <button
                                    key={item.file}
                                    onClick={() => handlePickFromGallery(item)}
                                    title={`Select ${item.name}`}
                                    className={`flex flex-col items-center rounded-lg border p-2 transition hover:shadow
                  ${isSelected ? "border-blue-500 ring-2 ring-blue-400 border-2" : "border-gray-200"}`}
                                >
                                    <img
                                        src={url}
                                        alt={item.name}
                                        className="w-full h-20 object-contain mb-2"
                                    />
                                    <div className="text-sm font-medium">{item.name}</div>
                                </button>
                            );
                        })}
                    </div>

                    <div className="text-xs text-gray-600">
                        Or upload your own:
                        <input
                            type="file"
                            accept="image/*"
                            className="ml-2 text-sm"
                            onChange={(e) => {
                                setSelectedUrl(null);
                                setSelectedCar(null)
                                setCarFile(e.target.files?.[0] || null);
                            }}
                        />
                    </div>
                </section>

                {/* --- controls --- */}
                <section className="flex flex-col gap-4">
                    <label className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Prompt</span>
                        <textarea
                            rows={5}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            className="w-full rounded-md border border-gray-300 p-3 text-sm shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-300"
                            placeholder="[car action or pose], [setting with key landmarks or environment], 
[lighting condition + mood], [fine detail or atmospheric note]. 
Cinematic, photorealistic automotive advertisement."
                        />
                    </label>

                    <button
                        onClick={handleGenerateFour}
                        disabled={loading || uploading}
                        className="rounded-md bg-black px-4 py-2 text-white font-medium shadow hover:opacity-80 disabled:bg-gray-300 disabled:opacity-50"
                    >
                        {loading ? "Generating…" : "Generate Images"}
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
                                <AlertDialogAction onClick={() => setErrorMsg("")}>
                                    OK
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </section>
            </div>

            {/* --- results --- */}
            <section className="space-y-4">
                <h3 className="text-lg font-semibold">Results</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[0, 1, 2, 3].map((i) => {
                        const src = results[i];
                        const status = uploadProgress[i]; // pending | uploading | done | error
                        const links = uploadedLinks[i];

                        return (
                            <div className="flex flex-col" key={i}>
                                <div
                                    key={i}
                                    className="aspect-square rounded-lg border border-gray-200 bg-gray-50 flex flex-col items-stretch justify-between overflow-hidden cursor-pointer"
                                    onClick={() => src && setActiveImage(src.image)}
                                >
                                    <div className="flex-1 flex items-center justify-center overflow-hidden">
                                        {src ? (
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
                                    {results[i]?.headline && (
                                        <div className="font-medium text-gray-800 truncate" title={results[i].headline}>
                                            “{results[i].headline}”
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
                        <img
                            src={activeImage}
                            alt="Fullscreen"
                            className="max-h-[90%] max-w-[90%] object-contain rounded-lg shadow-lg"
                        />
                    </div>
                )}
            </section>
        </div>
    );

}
