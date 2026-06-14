import { NextRequest, NextResponse } from "next/server";
import { chunkText, MAX_CHARS } from "@/app/lib/chunk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 전체 텍스트를 받아 서버에서 2000자 이하 청크로 분할해 배열로 반환한다.
// 실제 음성 합성(ElevenLabs 호출)은 청크별로 /api/tts/chunk 에서 수행한다.
// 이 엔드포인트는 분할만 하므로 가볍고 타임아웃 위험이 없다.
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "변환할 텍스트가 없습니다." },
        { status: 400 }
      );
    }

    const chunks = chunkText(text, MAX_CHARS);
    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "변환할 텍스트가 없습니다." },
        { status: 400 }
      );
    }

    return NextResponse.json({ chunks, count: chunks.length });
  } catch (err: any) {
    console.error("[/api/tts] 분할 오류:", {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return NextResponse.json(
      { error: err?.message ?? "텍스트 분할 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
