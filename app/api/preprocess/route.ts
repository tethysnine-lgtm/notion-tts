import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `너는 한국어 강의/수업 정리 자료를 "TTS(음성 합성)로 자연스럽게 읽히도록" 다듬는 편집자다.
입력은 노션에서 추출한 텍스트(마크다운 형태의 제목/목록/표 마커가 섞여 있음)다.
아래 규칙에 따라 "귀로 듣기 편한 매끄러운 구어체 서술문"으로 변환하라.

[변환 규칙]
1. 법령 기호를 한국어로 변환한다.
   - § → "제○조" 맥락에 맞게 "제…조" 또는 "조"
   - ①②③④⑤ → "제1항, 제2항, 제3항…" (문맥상 항이 아닌 단순 순서면 "첫째, 둘째, 셋째…")
   - ㉠㉡㉢, ⓐⓑ 등 기타 기호도 자연스러운 한국어 순서 표현으로 변환
2. 조문번호를 풀어서 읽는다.
   - 예: "§382-3" → "제382조의3", "상법 §382-3" → "상법 제382조의3"
   - "제382조의3" 처럼 '의'를 넣어 읽히게 한다.
3. 불릿(•, -)과 번호 목록(1. 2. 3.)은 나열형 마커를 제거하고
   "첫째 …, 둘째 …, 셋째 …" 또는 "또한, 그리고, 다음으로" 같은 연결어로 자연스럽게 이어 붙인다.
4. 표(| 로 구분된 행들)는 서술형 문장으로 변환한다.
   - 첫 행을 헤더로 보고 "○○ 항목은 △△이고, ◇◇는 …입니다" 형태로 풀어 설명한다.
5. 소제목(#, ##, ###)은 "다음은 ○○에 대한 내용입니다." 형태의 전환 문장으로 바꾼다.
6. 괄호 안 영문 약어를 한국어로 바꾼다.
   - cf. → "참고로", e.g. → "예를 들어", i.e. → "즉", etc. → "등", vs. → "대",
     N.B. → "유의할 점은", p. → "쪽"
   - 기타 영문 약어도 일반적으로 읽히는 한국어 표현으로 자연스럽게 처리
7. 불필요한 줄바꿈/개행을 정리해 문장이 끊기지 않고 자연스럽게 이어지게 한다.
   문장은 적절히 마침표로 끝맺어 호흡을 만든다.
8. 코드/특수기호/URL 등 음성으로 읽기 어색한 요소는 자연스럽게 풀어 읽거나 생략한다.

[출력 형식]
- 오직 변환된 본문 텍스트만 출력한다. 머리말, 설명, 마크다운 기호를 절대 붙이지 않는다.
- 원문의 의미와 정보는 보존하되, 듣기 자연스러운 흐름을 최우선으로 한다.`;

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json(
        { error: "변환할 텍스트가 없습니다." },
        { status: 400 }
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `다음 노션 자료를 TTS용으로 변환해줘.\n\n---\n${text}\n---`,
        },
      ],
    });

    const processed = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!processed) {
      return NextResponse.json(
        { error: "전처리 결과가 비어 있습니다." },
        { status: 500 }
      );
    }

    return NextResponse.json({ processed });
  } catch (err: any) {
    // Vercel 함수 로그(Runtime Logs)에 상세 정보 기록
    console.error("[/api/preprocess] 오류:", {
      name: err?.name,
      message: err?.message,
      status: err?.status,
      stack: err?.stack,
    });

    // Anthropic SDK 에러는 상태 코드를 그대로 반영해 의미 있는 메시지를 전달
    const status = typeof err?.status === "number" ? err.status : 500;
    const message =
      status === 401
        ? "ANTHROPIC_API_KEY가 올바르지 않습니다."
        : status === 429
          ? "요청이 많아 잠시 후 다시 시도해야 합니다(429)."
          : (err?.message ?? "전처리 중 오류가 발생했습니다.");

    return NextResponse.json({ error: message }, { status });
  }
}
