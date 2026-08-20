import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // FIX 1: Tell Vercel not to kill the request at 10 seconds

const HF_MODEL_URL = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

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
        { error: "missing_api_key", message: "HUGGINGFACE_API_KEY is not configured." },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "no_file", message: "No image file was provided." },
        { status: 400 }
      );
    }

    // FIX 2: Pass the ArrayBuffer directly. Next.js 15 crashes if you use Buffer.from()
    const arrayBuffer = await file.arrayBuffer();

    let hfResponse: Response;
    try {
      hfResponse = await fetch(HF_MODEL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": file.type,
        },
        body: arrayBuffer, 
      });
    } catch (networkErr) {
      return NextResponse.json(
        {
          error: "network_error",
          message: "Could not reach the Hugging Face Inference API.",
          detail: networkErr instanceof Error ? networkErr.message : String(networkErr),
        },
        { status: 502 }
      );
    }

    if (hfResponse.status === 503) {
      return NextResponse.json(
        {
          error: "model_loading",
          message: "The model is warming up on Hugging Face's free tier. Please retry shortly.",
        },
        { status: 503 }
      );
    }

    if (!hfResponse.ok) {
      const detail = await hfResponse.text().catch(() => "");
      return NextResponse.json(
        {
          error: "inference_failed",
          message: `API returned status ${hfResponse.status}.`,
          detail,
        },
        { status: 502 }
      );
    }

    const result = await hfResponse.json();

    if (!Array.isArray(result)) {
      return NextResponse.json(
        { error: "unexpected_response", message: "Unexpected response shape from model." },
        { status: 502 }
      );
    }

    const breakdown: HFLabelScore[] = result.map((r: any) => ({
      label: r.label,
      score: r.score,
    }));

    const artificialEntry = breakdown.find((r) => /artificial|fake|ai/i.test(r.label));
    const humanEntry = breakdown.find((r) => /human|real/i.test(r.label));

    let aiScoreRaw = artificialEntry
      ? artificialEntry.score
      : humanEntry
      ? 1 - humanEntry.score
      : breakdown[0].score;

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
  } catch (err) {
    return NextResponse.json(
      {
        error: "server_error",
        message: "An unexpected error occurred while analyzing the image.",
      },
      { status: 500 }
    );
  }
}
