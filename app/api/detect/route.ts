import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HF_MODEL_URL = "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.HUGGINGFACE_API_KEY || "";
    // Strips out any accidental spaces or hidden newline characters from your token
    const cleanKey = apiKey.replace(/\s+/g, "");

    if (!cleanKey) {
      return NextResponse.json(
        { error: "missing_key", message: "Hugging Face API key is missing in Vercel settings." },
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

    // Force strict Node Buffer to prevent Next.js 15 serialization crashes
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let hfResponse: Response;
    try {
      hfResponse = await fetch(HF_MODEL_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cleanKey}`,
          "Content-Type": file.type || "image/jpeg",
        },
        body: buffer,
      });
    } catch (networkErr: any) {
      // If it crashes now, the exact reason will show up on your webpage
      return NextResponse.json(
        {
          error: "network_error",
          message: `Network Crash: ${networkErr.message || String(networkErr)}`,
        },
        { status: 502 }
      );
    }

    // Handle Cold Starts (Hugging Face takes time to boot up free models)
    if (hfResponse.status === 503) {
      return NextResponse.json(
        {
          error: "model_loading",
          message: "The AI model is currently warming up on Hugging Face. Please wait 15 seconds and click Analyze again.",
          estimated_time: 15,
        },
        { status: 503 }
      );
    }

    // Handle API Rejections (e.g., bad token, rate limits)
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

    // Map the results
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
