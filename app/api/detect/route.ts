import { NextRequest, NextResponse } from "next/server";

// Force Node.js runtime (we need Buffer + full fetch control, not the Edge runtime).
export const runtime = "nodejs";
// Never cache detection results.
export const dynamic = "force-dynamic";

const HF_MODEL_URL =
  "https://api-inference.huggingface.co/models/umm-maybe/AI-image-detector";

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
          message:
            "HUGGINGFACE_API_KEY is not configured on the server. Add it in your Vercel project's Environment Variables.",
        },
        { status: 500 }
      );
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "bad_request", message: "Could not parse multipart form data." },
        { status: 400 }
      );
    }

    const file = formData.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "no_file", message: "No image file was provided under the 'image' field." },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          error: "invalid_type",
          message: `Unsupported file type "${file.type}". Please upload PNG, JPG, or WEBP.`,
        },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "file_too_large", message: "File exceeds the 10MB limit." },
        { status: 400 }
      );
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      return NextResponse.json(
        { error: "unreadable_file", message: "The uploaded file could not be read." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(arrayBuffer);

    let hfResponse: Response;
    try {
      hfResponse = await fetch(HF_MODEL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": file.type,
        },
        body: buffer,
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

    // Cold start: model is still loading on Hugging Face's side.
    if (hfResponse.status === 503) {
      let estimatedTime = 20;
      try {
        const body = await hfResponse.json();
        if (typeof body?.estimated_time === "number") {
          estimatedTime = Math.ceil(body.estimated_time);
        }
      } catch {
        // ignore, fall back to default estimate
      }
      return NextResponse.json(
        {
          error: "model_loading",
          message: "The model is warming up on Hugging Face's free tier. Please retry shortly.",
          estimated_time: estimatedTime,
        },
        { status: 503 }
      );
    }

    if (hfResponse.status === 401 || hfResponse.status === 403) {
      return NextResponse.json(
        {
          error: "unauthorized",
          message: "Hugging Face rejected the API key. Verify HUGGINGFACE_API_KEY is valid.",
        },
        { status: 502 }
      );
    }

    if (!hfResponse.ok) {
      const detail = await hfResponse.text().catch(() => "");
      return NextResponse.json(
        {
          error: "inference_failed",
          message: `Hugging Face Inference API returned status ${hfResponse.status}.`,
          detail: detail.slice(0, 500),
        },
        { status: 502 }
      );
    }

    const result = await hfResponse.json();

    if (!Array.isArray(result)) {
      // The API sometimes wraps errors as an object instead of an array.
      const message =
        typeof result?.error === "string" ? result.error : "Unexpected response shape from model.";
      return NextResponse.json({ error: "unexpected_response", message }, { status: 502 });
    }

    const breakdown: HFLabelScore[] = result
      .filter((r: any) => r && typeof r.label === "string" && typeof r.score === "number")
      .map((r: any) => ({ label: r.label, score: r.score }));

    if (breakdown.length === 0) {
      return NextResponse.json(
        { error: "empty_response", message: "The model returned no classification labels." },
        { status: 502 }
      );
    }

    const artificialEntry = breakdown.find((r) =>
      /artificial|fake|ai[\s_-]?generated|synthetic/i.test(r.label)
    );
    const humanEntry = breakdown.find((r) => /human|real|authentic/i.test(r.label));

    let aiScoreRaw: number;
    if (artificialEntry) {
      aiScoreRaw = artificialEntry.score;
    } else if (humanEntry) {
      aiScoreRaw = 1 - humanEntry.score;
    } else {
      // Fallback: assume the highest-confidence label at index 0 represents "artificial".
      aiScoreRaw = breakdown[0].score;
    }

    const aiScore = Math.round(aiScoreRaw * 1000) / 10; // one decimal place, 0-100
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
    console.error("[/api/detect] unhandled error:", err);
    return NextResponse.json(
      {
        error: "server_error",
        message: "An unexpected error occurred while analyzing the image.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
