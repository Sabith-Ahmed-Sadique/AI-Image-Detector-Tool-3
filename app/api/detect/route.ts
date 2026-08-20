import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; 

const HF_MODEL_URL = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.HUGGINGFACE_API_KEY || "";
    const cleanKey = apiKey.replace(/\s+/g, "");

    if (!cleanKey) {
      return NextResponse.json(
        { error: "missing_key", message: "API key is missing in Vercel." },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("image") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "no_file", message: "No image file was provided." },
        { status: 400 }
      );
    }

    let hfResponse: Response;
    try {
      // FIX: Pass the native Web 'File' object directly to the body.
      // Do not convert to Buffer or ArrayBuffer, which crashes Next.js 15.
      hfResponse = await fetch(HF_MODEL_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": file.type || "image/jpeg",
        },
        body: file,
        cache: "no-store" // Prevent Next.js from aggressively caching the request
      });
    } catch (networkErr: any) {
      return NextResponse.json(
        {
          error: "network_error",
          message: `Network Crash: ${networkErr.message || String(networkErr)}`,
        },
        { status: 502 }
      );
    }

    if (hfResponse.status === 503) {
      return NextResponse.json(
        {
          error: "model_loading",
          message: "The AI model is warming up on Hugging Face. Please wait 15 seconds and click Analyze again.",
          estimated_time: 15,
        },
        { status: 503 }
      );
    }

    if (!hfResponse.ok) {
      const detail = await hfResponse.text().catch(() => "");
      return NextResponse.json(
        {
          error: "inference_failed",
          message: `Hugging Face Error (${hfResponse.status}): ${detail.substring(0, 150)}`,
        },
        { status: 502 }
      );
    }

    const result = await hfResponse.json();

    if (!Array.isArray(result)) {
      return NextResponse.json(
        { error: "unexpected_response", message: `Unexpected API output: ${JSON.stringify(result).substring(0,100)}` },
        { status: 502 }
      );
    }

    const artificialEntry = result.find((r: any) => /artificial|fake|ai/i.test(r.label));
    const humanEntry = result.find((r: any) => /human|real/i.test(r.label));

    let aiScoreRaw = artificialEntry
      ? artificialEntry.score
      : humanEntry
      ? 1 - humanEntry.score
      : result[0].score;

    const aiScore = Math.round(aiScoreRaw * 1000) / 10;
    
    let verdict = "uncertain";
    if (aiScore >= 70) verdict = "ai";
    else if (aiScore <= 30) verdict = "authentic";

    return NextResponse.json({
      score: aiScore,
      verdict,
      breakdown: result.map((b: any) => ({
        label: b.label,
        score: Math.round(b.score * 1000) / 10,
      })).sort((a, b) => b.score - a.score),
      model: "umm-maybe/AI-image-detector",
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "server_error", message: `Internal Crash: ${err.message}` },
      { status: 500 }
    );
  }
}
