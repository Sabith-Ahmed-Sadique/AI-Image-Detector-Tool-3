"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  UploadCloud,
  X,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  RefreshCw,
  ScanEye,
} from "lucide-react";

type Verdict = "ai" | "authentic" | "uncertain";

interface Breakdown {
  label: string;
  score: number;
}

interface DetectSuccess {
  score: number;
  verdict: Verdict;
  breakdown: Breakdown[];
  model: string;
}

interface DetectError {
  error: string;
  message: string;
  estimated_time?: number;
  detail?: string;
}

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

const VERDICT_META: Record<
  Verdict,
  { label: string; color: string; bg: string; ring: string; Icon: typeof ShieldCheck }
> = {
  ai: {
    label: "Likely AI-Generated",
    color: "text-red-400",
    bg: "bg-red-500",
    ring: "ring-red-500/40",
    Icon: ShieldAlert,
  },
  authentic: {
    label: "Likely Authentic",
    color: "text-emerald-400",
    bg: "bg-emerald-500",
    ring: "ring-emerald-500/40",
    Icon: ShieldCheck,
  },
  uncertain: {
    label: "Uncertain / Inconclusive",
    color: "text-amber-400",
    bg: "bg-amber-500",
    ring: "ring-amber-500/40",
    Icon: ShieldQuestion,
  },
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [result, setResult] = useState<DetectSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    };
  }, [previewUrl]);

  const validateFile = (f: File): string | null => {
    if (!ALLOWED_TYPES.includes(f.type)) {
      return "Unsupported format. Please upload a PNG, JPG, or WEBP image.";
    }
    if (f.size > MAX_BYTES) {
      return "File exceeds the 10MB limit.";
    }
    return null;
  };

  const setNewFile = useCallback((f: File) => {
    const validationError = validateFile(f);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setResult(null);
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) setNewFile(dropped);
    },
    [setNewFile]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) setNewFile(selected);
  };

  const clearFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const runDetection = useCallback(async (targetFile: File, isRetry = false) => {
    setLoading(true);
    setError(null);
    if (!isRetry) setResult(null);
    setStatusMessage(isRetry ? "Retrying analysis..." : "Uploading image...");

    try {
      const formData = new FormData();
      formData.append("image", targetFile);

      setStatusMessage("Running inference...");
      const res = await fetch("/api/detect", { method: "POST", body: formData });
      const data = (await res.json()) as DetectSuccess | DetectError;

      if (!res.ok) {
        const errData = data as DetectError;

        if (errData.error === "model_loading") {
          const wait = errData.estimated_time ?? 20;
          setStatusMessage(
            `Model is warming up on Hugging Face's free tier. Retrying in ${wait}s...`
          );
          setRetryCountdown(wait);
          if (retryTimerRef.current) clearInterval(retryTimerRef.current);
          retryTimerRef.current = setInterval(() => {
            setRetryCountdown((prev) => {
              if (prev === null || prev <= 1) {
                if (retryTimerRef.current) clearInterval(retryTimerRef.current);
                return null;
              }
              return prev - 1;
            });
          }, 1000);

          setTimeout(() => {
            runDetection(targetFile, true);
          }, wait * 1000);
          return;
        }

        setError(errData.message || "Something went wrong analyzing the image.");
        setLoading(false);
        setStatusMessage("");
        return;
      }

      setResult(data as DetectSuccess);
      setLoading(false);
      setStatusMessage("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error while contacting the detector."
      );
      setLoading(false);
      setStatusMessage("");
    }
  }, []);

  const handleAnalyze = () => {
    if (!file) return;
    runDetection(file);
  };

  const verdictMeta = result ? VERDICT_META[result.verdict] : null;

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-16 sm:py-24">
      <div className="w-full max-w-2xl">
        <header className="mb-12 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 mb-5 rounded-full border border-gold/30 bg-gold/5 text-gold-light text-xs tracking-[0.2em] uppercase">
            <ScanEye size={14} />
            AI Detection Suite
          </div>
          <h1 className="font-serif text-4xl sm:text-5xl font-semibold text-neutral-50 mb-3">
            AI Image Detector
          </h1>
          <p className="text-neutral-400 text-sm sm:text-base max-w-md mx-auto">
            Upload an image to get a calibrated, model-backed estimate of whether it was
            AI-generated or authentic.
          </p>
        </header>

        {/* Upload zone */}
        {!previewUrl && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center gap-4 py-20 px-6 text-center
              ${
                dragActive
                  ? "border-gold bg-gold/5 shadow-gold"
                  : "border-line bg-panel/50 hover:border-gold/50 hover:bg-panel"
              }`}
          >
            <div className="p-4 rounded-full bg-charcoal border border-line">
              <UploadCloud className="text-gold" size={28} />
            </div>
            <div>
              <p className="text-neutral-200 font-medium">
                Drag &amp; drop an image, or{" "}
                <span className="text-gold-light underline underline-offset-4">browse</span>
              </p>
              <p className="text-neutral-500 text-xs mt-2">
                PNG, JPG, or WEBP &middot; up to 10MB
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={handleChange}
              className="hidden"
            />
          </div>
        )}

        {/* Preview + actions */}
        {previewUrl && (
          <div className="rounded-2xl border border-line bg-panel/50 p-5">
            <div className="relative rounded-xl overflow-hidden border border-line bg-charcoal">
              <img
                src={previewUrl}
                alt="Uploaded preview"
                className="w-full max-h-96 object-contain"
              />
              <button
                onClick={clearFile}
                aria-label="Remove image"
                className="absolute top-3 right-3 p-2 rounded-full bg-ink/80 border border-line hover:border-gold/60 hover:text-gold-light transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-5 flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleAnalyze}
                disabled={loading}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-gold hover:bg-gold-light disabled:opacity-50 disabled:cursor-not-allowed text-ink font-medium py-3 px-6 transition-colors"
              >
                {loading ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <ScanEye size={18} />
                    Analyze Image
                  </>
                )}
              </button>
              <button
                onClick={clearFile}
                disabled={loading}
                className="rounded-lg border border-line hover:border-neutral-500 disabled:opacity-50 text-neutral-300 font-medium py-3 px-6 transition-colors"
              >
                Clear
              </button>
            </div>

            {loading && (
              <div className="mt-4 flex items-center gap-2 text-neutral-400 text-sm">
                <RefreshCw size={14} className="animate-spin" />
                <span>
                  {statusMessage}
                  {retryCountdown !== null ? ` (${retryCountdown}s)` : ""}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-5 rounded-xl border border-red-500/30 bg-red-500/5 px-5 py-4 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Result */}
        {result && verdictMeta && (
          <div className={`mt-6 rounded-2xl border border-line bg-panel/50 p-6 ring-1 ${verdictMeta.ring}`}>
            <div className="flex items-center gap-3 mb-5">
              <verdictMeta.Icon className={verdictMeta.color} size={26} />
              <div>
                <p className={`font-serif text-xl font-semibold ${verdictMeta.color}`}>
                  {verdictMeta.label}
                </p>
                <p className="text-neutral-500 text-xs">Model: {result.model}</p>
              </div>
            </div>

            <div className="mb-2 flex justify-between text-xs text-neutral-400">
              <span>AI-Generated Confidence</span>
              <span className="font-medium text-neutral-200">{result.score}%</span>
            </div>
            <div className="w-full h-2.5 rounded-full bg-charcoal border border-line overflow-hidden">
              <div
                className={`h-full ${verdictMeta.bg} transition-all duration-700 ease-out`}
                style={{ width: `${result.score}%` }}
              />
            </div>

            <div className="mt-6 pt-5 border-t border-line">
              <p className="text-xs uppercase tracking-widest text-neutral-500 mb-3">
                Raw Class Breakdown
              </p>
              <ul className="space-y-2">
                {result.breakdown.map((b) => (
                  <li key={b.label} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-300 capitalize">{b.label}</span>
                    <span className="text-neutral-400 font-mono">{b.score}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <footer className="mt-16 text-center text-xs text-neutral-600">
          Inference powered by the Hugging Face free serverless API. Results are probabilistic
          estimates, not definitive proof.
        </footer>
      </div>
    </main>
  );
}
