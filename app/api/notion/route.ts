import { Client } from "@notionhq/client";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClient() {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error("NOTION_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  return new Client({ auth: apiKey });
}

/**
 * 노션 페이지 URL 또는 ID 문자열에서 32자리 페이지 ID를 추출한다.
 * 지원 형태:
 *   - https://www.notion.so/Title-1234567890abcdef1234567890abcdef
 *   - https://www.notion.so/workspace/1234567890abcdef1234567890abcdef?v=...
 *   - 1234567890abcdef1234567890abcdef
 *   - 12345678-90ab-cdef-1234-567890abcdef
 */
function extractPageId(input: string): string | null {
  const cleaned = input.trim();
  // 하이픈 포함 UUID 우선 매칭
  const uuidMatch = cleaned.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuidMatch) {
    return uuidMatch[0].replace(/-/g, "");
  }
  // 32자리 hex (마지막 항목 우선 — URL 슬러그 뒤에 위치)
  const matches = cleaned.match(/[0-9a-f]{32}/gi);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1];
  }
  return null;
}

function toDashedId(id: string): string {
  if (id.includes("-")) return id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(
    16,
    20
  )}-${id.slice(20)}`;
}

/** 리치 텍스트 배열을 평문으로 변환 */
function richTextToPlain(richText: any[]): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t?.plain_text ?? "").join("");
}

/**
 * 단일 블록을 텍스트 라인으로 변환한다.
 * 표/목록 등 구조 정보를 보존하기 위해 마커를 유지한다.
 * (실제 자연어 변환은 전처리(Claude) 단계에서 수행)
 */
function blockToText(block: any): string {
  const type = block.type;
  const data = block[type];

  switch (type) {
    case "paragraph":
      return richTextToPlain(data.rich_text);
    case "heading_1":
      return `# ${richTextToPlain(data.rich_text)}`;
    case "heading_2":
      return `## ${richTextToPlain(data.rich_text)}`;
    case "heading_3":
      return `### ${richTextToPlain(data.rich_text)}`;
    case "bulleted_list_item":
      return `• ${richTextToPlain(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToPlain(data.rich_text)}`;
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${richTextToPlain(data.rich_text)}`;
    case "toggle":
      return richTextToPlain(data.rich_text);
    case "quote":
      return `> ${richTextToPlain(data.rich_text)}`;
    case "callout":
      return richTextToPlain(data.rich_text);
    case "code":
      return richTextToPlain(data.rich_text);
    case "table_row": {
      const cells = (data.cells ?? []).map((cell: any[]) =>
        richTextToPlain(cell)
      );
      return `| ${cells.join(" | ")} |`;
    }
    case "divider":
      return "---";
    default:
      // rich_text 속성이 있으면 추출 시도
      if (data?.rich_text) return richTextToPlain(data.rich_text);
      return "";
  }
}

/** 페이지/블록의 모든 하위 블록을 재귀적으로 수집하여 텍스트로 변환 */
async function fetchBlocksText(
  notion: Client,
  blockId: string,
  depth = 0
): Promise<string> {
  if (depth > 6) return ""; // 과도한 중첩 방지

  const lines: string[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res: any = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of res.results) {
      const text = blockToText(block);
      if (text) lines.push(text);

      // 표는 하위 table_row 들을 가짐 → 재귀
      if (block.has_children) {
        const childText = await fetchBlocksText(notion, block.id, depth + 1);
        if (childText) lines.push(childText);
      }
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return lines.join("\n");
}

/** 페이지 제목 추출 */
function getPageTitle(page: any): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title") {
      return richTextToPlain(prop.title) || "(제목 없음)";
    }
  }
  // 데이터베이스가 아닌 일반 페이지인 경우
  if (page.title) return richTextToPlain(page.title) || "(제목 없음)";
  return "(제목 없음)";
}

/**
 * GET: Integration이 접근 가능한 페이지 목록 반환
 */
export async function GET() {
  try {
    const notion = getClient();
    const res = await notion.search({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 50,
    });

    const pages = res.results
      .filter((r: any) => r.object === "page")
      .map((p: any) => ({
        id: p.id,
        title: getPageTitle(p),
        url: p.url,
        lastEdited: p.last_edited_time,
      }));

    return NextResponse.json({ pages });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "노션 페이지 목록을 가져오지 못했습니다." },
      { status: 500 }
    );
  }
}

/**
 * POST: { url? , pageId? } → 페이지 본문 텍스트 반환
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const raw: string = body.pageId || body.url || "";
    if (!raw) {
      return NextResponse.json(
        { error: "url 또는 pageId가 필요합니다." },
        { status: 400 }
      );
    }

    const id = extractPageId(raw);
    if (!id) {
      return NextResponse.json(
        { error: "유효한 노션 페이지 ID를 찾을 수 없습니다." },
        { status: 400 }
      );
    }

    const notion = getClient();
    const dashedId = toDashedId(id);

    // 제목 조회 (실패해도 본문은 진행)
    let title = "";
    try {
      const page: any = await notion.pages.retrieve({ page_id: dashedId });
      title = getPageTitle(page);
    } catch {
      title = "";
    }

    const text = await fetchBlocksText(notion, dashedId);

    if (!text.trim()) {
      return NextResponse.json(
        {
          error:
            "페이지 내용을 가져오지 못했습니다. 해당 페이지에 Integration이 연결(공유)되어 있는지 확인하세요.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ title, text });
  } catch (err: any) {
    const message = err?.message ?? "노션 페이지를 가져오지 못했습니다.";
    // 권한 관련 안내 보강
    const hint =
      err?.code === "object_not_found"
        ? " 페이지에 Integration이 연결되어 있는지 확인하세요. (페이지 우측 상단 ⋯ → 연결 → Integration 선택)"
        : "";
    return NextResponse.json({ error: message + hint }, { status: 500 });
  }
}
