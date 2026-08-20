import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extend Vercel function timeout limit to allow HF model cold starts (up to 60s)
export const maxDuration = 60;

const HF_MODEL = "umm-maybe/AI-image-detector";
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

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
          message: "HUGGINGFACE_API_KEY is not set in Vercel Environment Variables.",
        },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "no_file", message: "No image was uploaded." },
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
        { error: "file_too_large", message: "Image exceeds the 10MB limit." },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const response = await fetch(HF_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": file.type || "application/octet-stream",
        "x-use-cache": "false",
      },
      body: buffer,
    });

    // Model is spinning up on Hugging Face (Cold start)
    if (response.status === 503) {
      const data = await response.json().catch(() => ({}));
      const waitTime = Math.ceil(data?.estimated_time || 20);
      return NextResponse.json(
        {
          error: "model_loading",
          message: `Model is warming up on Hugging Face. Retrying in ${waitTime}s...`,
          estimated_time: waitTime,
        },
        { status: 503 }
      );
    }

    if (response.status === 401 || response.status === 403) {
      return NextResponse.json(
        {
          error: "unauthorized",
          message: "Invalid Hugging Face API key. Verify your token under Vercel Settings.",
        },
        { status: 401 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return NextResponse.json(
        {
          error: "inference_failed",
          message: `Hugging Face Error (${response.status}): ${errorText.slice(0, 200)}`,
        },
        { status: 502 }
      );
    }

    const result = await response.json();

    if (!Array.isArray(result)) {
      return NextResponse.json(
        {
          error: "unexpected_response",
          message: result?.error || "Unexpected response shape from model.",
        },
        { status: 502 }
      );
    }

    const breakdown: HFLabelScore[] = result
      .filter((r: any) => r && typeof r.label === "string" && typeof r.score === "number")
      .map((r: any) => ({ label: r.label, score: r.score }));

    if (breakdown.length === 0) {
      return NextResponse.json(
        { error: "empty_response", message: "No classification returned by the model." },
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
      model: HF_MODEL,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        error: "server_error",
        message: err.message || "An unexpected server error occurred.",
      },
      { status: 500 }
    );
  }
}
