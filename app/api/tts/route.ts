import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_CHARS = 2000;
// ElevenLabs 기본 다국어 음성 (Rachel) — 한국어는 multilingual 모델이 처리
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/**
 * 텍스트를 MAX_CHARS 이하 청크로 분할한다.
 * 가능한 한 문장(마침표/물음표/느낌표/줄바꿈) 경계에서 자른다.
 */
function chunkText(text: string, maxChars = MAX_CHARS): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  // 문장 단위로 분리 (구분자 유지)
  const sentences = clean
    .split(/(?<=[.!?。！？\n])/)
    .map((s) => s)
    .filter((s) => s.length > 0);

  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      // 한 문장 자체가 너무 길면 글자 단위로 강제 분할
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) {
          chunks.push(sentence.slice(i, i + maxChars).trim());
        }
        current = "";
      } else {
        current = sentence;
      }
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length > 0);
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
      detail = errJson?.detail?.message || JSON.stringify(errJson?.detail) || "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(
      `ElevenLabs API 오류 (${res.status}): ${detail || res.statusText}`
    );
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

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

    const chunks = chunkText(text);

    // 청크를 순차적으로 변환 (API rate limit 및 순서 보장)
    const audioBuffers: Buffer[] = [];
    for (const chunk of chunks) {
      const buf = await synthesize(apiKey, voiceId, modelId, chunk);
      audioBuffers.push(Buffer.from(buf));
    }

    // MP3 청크들을 이어붙임 (프레임 단위로 연속 재생 가능)
    const merged = Buffer.concat(audioBuffers);

    return new NextResponse(merged, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(merged.length),
        "X-Chunk-Count": String(chunks.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "음성 변환 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
