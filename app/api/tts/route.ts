import { NextRequest, NextResponse } from "next/server";
import { MAX_CHARS } from "@/app/lib/chunk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 청크 1개 = ElevenLabs 호출 1회. 청크 분할은 클라이언트가 담당하며,
// 이 라우트는 단일 청크만 합성해 Vercel 무료 플랜의 10초 타임아웃을 피한다.
//
// ElevenLabs 기본 다국어 음성 — eleven_multilingual_v2 모델과 함께
// 한국어를 포함한 다국어를 지원한다.
const DEFAULT_VOICE_ID = "sQ3a15DhENXU8pKTHlcc";
// 한국어 지원 모델. v2는 자연스러운 한국어 합성을 지원한다.
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/** ElevenLabs HTTP 상태 코드를 사용자용 한국어 메시지로 변환 */
class ElevenLabsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = status;
  }
}

async function synthesize(
  apiKey: string,
  voiceId: string,
  modelId: string,
  text: string
): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail =
        errJson?.detail?.message ||
        (typeof errJson?.detail === "string"
          ? errJson.detail
          : JSON.stringify(errJson?.detail)) ||
        "";
    } catch {
      detail = await res.text().catch(() => "");
    }

    // Vercel 함수 로그에 원본 응답 기록 (디버깅용)
    console.error("[/api/tts] ElevenLabs 응답 오류:", {
      status: res.status,
      statusText: res.statusText,
      detail,
      voiceId,
      modelId,
    });

    // 상태 코드별 사용자 친화적 메시지
    const message =
      res.status === 401
        ? "ELEVENLABS_API_KEY가 올바르지 않거나 만료되었습니다."
        : res.status === 402
          ? "ElevenLabs 사용 한도(크레딧)를 초과했습니다. 요금제를 확인하세요."
          : res.status === 404
            ? `음성 ID(${voiceId})를 찾을 수 없습니다. ELEVENLABS_VOICE_ID 설정을 확인하세요.`
            : res.status === 422
              ? `요청이 거부되었습니다(422). 음성 ID 또는 모델 ID가 올바른지 확인하세요. ${detail}`
              : res.status === 429
                ? "요청이 너무 많습니다(429). 잠시 후 다시 시도하세요."
                : `ElevenLabs API 오류 (${res.status}): ${detail || res.statusText}`;

    throw new ElevenLabsError(res.status, message);
  }

  return res.arrayBuffer();
}

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "변환할 텍스트가 없습니다." },
        { status: 400 }
      );
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ELEVENLABS_API_KEY 환경변수가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    // 클라이언트가 이미 청크 단위로 잘라서 보내므로 단일 호출만 수행한다.
    // 혹시 너무 긴 텍스트가 들어오면 타임아웃 방지를 위해 거부한다.
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        {
          error: `청크가 너무 깁니다(${text.length}자). 최대 ${MAX_CHARS}자까지 허용됩니다.`,
        },
        { status: 413 }
      );
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

    const buf = await synthesize(apiKey, voiceId, modelId, text.trim());
    const audio = Buffer.from(buf);

    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("[/api/tts] 오류:", {
      name: err?.name,
      message: err?.message,
      status: err?.status,
      stack: err?.stack,
    });

    // ElevenLabs 오류는 원래 상태 코드를 유지, 그 외는 500
    const status =
      err instanceof ElevenLabsError && err.status >= 400 && err.status < 600
        ? err.status
        : 500;

    return NextResponse.json(
      { error: err?.message ?? "음성 변환 중 오류가 발생했습니다." },
      { status }
    );
  }
}
