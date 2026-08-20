import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Primary and fallback Hugging Face inference endpoints
const PRIMARY_HF_URL = "https://router.huggingface.co/hf-inference/models/umm-maybe/AI-image-detector";
const FALLBACK_HF_URL = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

interface HFLabelScore {
  label: string;
  score: number;
}

function classifyVerdict(aiScore: number): "ai" | "authentic" | "uncertain" {
  if (aiScore >= 70) return "ai";
  if (aiScore <= 30) return "authentic";
  return "uncertain";
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.HUGGINGFACE_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          error: "missing_api_key",
          message: "HUGGINGFACE_API_KEY is missing. Please add it to your Vercel Environment Variables.",
        },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "no_file", message: "No image file provided." },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "invalid_type", message: `Unsupported file type: ${file.type}` },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "file_too_large", message: "File exceeds 10MB limit." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();

    // Attempt inference with primary and fallback endpoints
    let hfResponse: Response | null = null;
    const urls = [PRIMARY_HF_URL, FALLBACK_HF_URL];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            "Content-Type": file.type || "application/octet-stream",
          },
          body: arrayBuffer,
        });
        if (res.ok || res.status === 503 || res.status === 401 || res.status === 403) {
          hfResponse = res;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!hfResponse) {
      return NextResponse.json(
        { error: "network_error", message: "Unable to connect to Hugging Face Inference servers." },
        { status: 502 }
      );
    }

    if (hfResponse.status === 503) {
      let estimatedTime = 20;
      try {
        const body = await hfResponse.json();
        if (typeof body?.estimated_time === "number") estimatedTime = Math.ceil(body.estimated_time);
      } catch {}
      return NextResponse.json(
        {
          error: "model_loading",
          message: "Model is warming up on Hugging Face. Retrying shortly...",
          estimated_time: estimatedTime,
        },
        { status: 503 }
      );
    }

    if (hfResponse.status === 401 || hfResponse.status === 403) {
      return NextResponse.json(
        {
          error: "unauthorized",
          message: "Invalid Hugging Face API key. Check the key in Vercel Settings.",
        },
        { status: 401 }
      );
    }

    if (!hfResponse.ok) {
      const errorText = await hfResponse.text().catch(() => "");
      return NextResponse.json(
        { error: "inference_failed", message: `Hugging Face error (${hfResponse.status}): ${errorText.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const result = await hfResponse.json();

    if (!Array.isArray(result)) {
      return NextResponse.json(
        { error: "unexpected_response", message: result?.error || "Unexpected response shape." },
        { status: 502 }
      );
    }

    const breakdown: HFLabelScore[] = result
      .filter((r: any) => r && typeof r.label === "string" && typeof r.score === "number")
      .map((r: any) => ({ label: r.label, score: r.score }));

    if (breakdown.length === 0) {
      return NextResponse.json(
        { error: "empty_response", message: "No classification returned." },
        { status: 502 }
      );
    }

    const artificialEntry = breakdown.find((r) =>
      /artificial|fake|ai[\s_-]?generated|synthetic/i.test(r.label)
    );
    const humanEntry = breakdown.find((r) => /human|real|authentic/i.test(r.label));

    let aiScoreRaw = 0;
    if (artificialEntry) {
      aiScoreRaw = artificialEntry.score;
    } else if (humanEntry) {
      aiScoreRaw = 1 - humanEntry.score;
    } else {
      aiScoreRaw = breakdown[0].score;
    }

    const aiScore = Math.round(aiScoreRaw * 1000) / 10;
    const verdict = classifyVerdict(aiScore);

    return NextResponse.json({
      score: aiScore,
      verdict,
      breakdown: breakdown
        .map((b) => ({ label: b.label, score: Math.round(b.score * 1000) / 10 }))
        .sort((a, b) => b.score - a.score),
      model: "umm-maybe/AI-image-detector",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "server_error", message: err.message || "Internal server error." },
      { status: 500 }
    );
  }
}
