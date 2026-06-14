"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type NotionPage = {
  id: string;
  title: string;
  url: string;
  lastEdited: string;
};

type InputMode = "url" | "list";

const SPEED_OPTIONS = [1, 1.25, 1.5, 1.75, 2];

/**
 * 응답을 안전하게 JSON으로 파싱한다.
 * Vercel에서 서버리스 함수가 타임아웃(504)되거나 크래시하면 JSON이 아닌
 * HTML 에러 페이지가 돌아오는데, 그대로 res.json()을 호출하면 throw 되어
 * "Unexpected token '<'…" 같은 알 수 없는 에러가 표시된다.
 * 이를 방지하고 상태 코드별로 의미 있는 메시지를 만들어 던진다.
 */
async function parseJsonOrThrow(res: Response, fallbackMsg: string) {
  const raw = await res.text();
  let data: any = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON이 아님 (HTML 에러 페이지 등)
    }
  }

  if (!res.ok) {
    if (data?.error) throw new Error(data.error);
    if (res.status === 504) {
      throw new Error(
        "서버 응답 시간이 초과되었습니다(504). 텍스트가 너무 길거나 서버가 지연되고 있습니다. 잠시 후 다시 시도하세요."
      );
    }
    if (res.status === 413) {
      throw new Error("요청 데이터가 너무 큽니다(413). 텍스트 분량을 줄여보세요.");
    }
    throw new Error(`${fallbackMsg} (HTTP ${res.status})`);
  }

  if (data === null) {
    throw new Error("서버가 올바른 응답을 반환하지 않았습니다.");
  }
  return data;
}

/** 에러를 콘솔에 기록하고 사용자에게 보여줄 메시지를 반환한다. */
function describeError(e: unknown, context: string): string {
  // 콘솔에 상세 정보 출력 (디버깅용)
  console.error(`[${context}] 요청 실패:`, e);

  if (e instanceof TypeError) {
    // fetch 자체가 실패 (네트워크 끊김, CORS, DNS 등)
    return "서버에 연결하지 못했습니다. 네트워크 상태를 확인하세요.";
  }
  if (e instanceof Error && e.message) {
    return e.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>("url");

  // 입력
  const [notionUrl, setNotionUrl] = useState("");
  const [pages, setPages] = useState<NotionPage[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState("");

  // 단계별 결과
  const [rawText, setRawText] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [processedText, setProcessedText] = useState("");

  // 오디오 (청크별 blob URL을 순서대로 보관)
  const [audioUrls, setAudioUrls] = useState<string[]>([]);
  const [currentChunk, setCurrentChunk] = useState(0);
  // 변환 진행 상황: { done: 변환 완료 수, total: 전체 청크 수 }
  const [ttsProgress, setTtsProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // 상태
  const [busy, setBusy] = useState<null | "fetch" | "preprocess" | "tts">(null);
  const [error, setError] = useState("");

  // 오디오
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // 생성한 모든 objectURL을 추적해 정리(메모리 누수 방지)
  const createdUrlsRef = useRef<string[]>([]);

  const chunkCount = audioUrls.length;

  // 다크모드 토글
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  };

  // 목록 모드 진입 시 페이지 불러오기
  useEffect(() => {
    if (mode === "list" && pages.length === 0 && !pagesLoading) {
      loadPages();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 재생 속도 반영 (청크가 바뀌어도 유지)
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, currentChunk, audioUrls]);

  // 현재 청크가 바뀌면 src를 교체해 이어 재생.
  // 변환 진행으로 audioUrls가 늘어나도, 현재 재생 중인 청크의 src는
  // 건드리지 않도록 가드를 둬 재생이 끊기지 않게 한다.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || audioUrls.length === 0) return;
    const desired = audioUrls[currentChunk] ?? "";
    if (desired && a.src !== desired) {
      a.src = desired;
      a.playbackRate = speed;
      if (isPlaying) {
        a.play().catch(() => setIsPlaying(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChunk, audioUrls]);

  // 언마운트 시 생성한 모든 objectURL 정리
  useEffect(() => {
    return () => {
      createdUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      createdUrlsRef.current = [];
    };
  }, []);

  /** 지금까지 만든 모든 오디오 objectURL을 해제하고 재생 상태를 초기화 */
  function clearAudio() {
    createdUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    createdUrlsRef.current = [];
    setAudioUrls([]);
    setCurrentChunk(0);
    setIsPlaying(false);
    setTtsProgress(null);
  }

  async function loadPages() {
    setPagesLoading(true);
    setError("");
    try {
      const res = await fetch("/api/notion");
      const data = await parseJsonOrThrow(res, "목록을 불러오지 못했습니다.");
      setPages(data.pages || []);
    } catch (e) {
      setError(describeError(e, "notion:list"));
    } finally {
      setPagesLoading(false);
    }
  }

  function resetResults() {
    setProcessedText("");
    clearAudio();
  }

  // 1단계: 노션에서 내용 가져오기
  async function handleFetch() {
    setError("");
    resetResults();
    setRawText("");
    setPageTitle("");

    const payload =
      mode === "url"
        ? { url: notionUrl.trim() }
        : { pageId: selectedPageId };

    if (mode === "url" && !payload.url) {
      setError("노션 페이지 URL을 입력하세요.");
      return;
    }
    if (mode === "list" && !selectedPageId) {
      setError("페이지를 선택하세요.");
      return;
    }

    setBusy("fetch");
    try {
      const res = await fetch("/api/notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonOrThrow(res, "내용을 가져오지 못했습니다.");
      setRawText(data.text || "");
      setPageTitle(data.title || "");
    } catch (e) {
      setError(describeError(e, "notion:fetch"));
    } finally {
      setBusy(null);
    }
  }

  // 2단계: Claude 전처리
  async function handlePreprocess() {
    if (!rawText.trim()) {
      setError("먼저 노션 내용을 가져오세요.");
      return;
    }
    setError("");
    resetResults();
    setBusy("preprocess");
    try {
      const res = await fetch("/api/preprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText }),
      });
      const data = await parseJsonOrThrow(res, "전처리에 실패했습니다.");
      if (!data.processed) {
        throw new Error("전처리 결과가 비어 있습니다.");
      }
      setProcessedText(data.processed);
    } catch (e) {
      setError(describeError(e, "preprocess"));
    } finally {
      setBusy(null);
    }
  }

  /** 서버(/api/tts)에 전체 텍스트를 보내 청크 배열을 받아온다 */
  async function fetchChunks(text: string): Promise<string[]> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await parseJsonOrThrow(res, "텍스트 분할에 실패했습니다.");
    const chunks: string[] = Array.isArray(data.chunks) ? data.chunks : [];
    return chunks;
  }

  /** 청크 하나를 /api/tts/chunk 로 보내 MP3 Blob을 받는다 */
  async function synthesizeChunk(text: string): Promise<Blob> {
    const res = await fetch("/api/tts/chunk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as any);
      if (data.error) throw new Error(data.error);
      if (res.status === 504) {
        throw new Error(
          "음성 변환 시간이 초과되었습니다(504). 잠시 후 다시 시도하세요."
        );
      }
      throw new Error(`음성 변환에 실패했습니다. (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    if (blob.size === 0) {
      throw new Error("변환된 오디오가 비어 있습니다.");
    }
    return blob;
  }

  // 3단계: TTS 변환
  // (1) /api/tts 에 전체 텍스트를 보내 서버에서 청크로 분할한 배열을 받는다.
  // (2) 받은 청크 배열을 /api/tts/chunk 로 순차 호출(요청당 1청크)해 MP3를 모은다.
  // 요청당 단일 합성이라 Vercel 무료 플랜의 10초 타임아웃을 피한다.
  async function handleTTS() {
    const target = processedText.trim();
    if (!target) {
      setError("변환할 텍스트가 없습니다.");
      return;
    }

    setError("");
    setBusy("tts");

    let chunks: string[];
    try {
      chunks = await fetchChunks(target);
    } catch (e) {
      setError(describeError(e, "tts:split"));
      setBusy(null);
      return;
    }

    if (chunks.length === 0) {
      setError("변환할 텍스트가 없습니다.");
      setBusy(null);
      return;
    }

    clearAudio();
    setTtsProgress({ done: 0, total: chunks.length });

    const urls: string[] = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const blob = await synthesizeChunk(chunks[i]);

        // 청크별 개별 MP3 URL을 유지한다.
        // (여러 MP3를 단순 이어붙이면 파일이 손상되므로 병합하지 않는다.)
        const url = URL.createObjectURL(blob);
        createdUrlsRef.current.push(url);
        urls.push(url);

        // 변환된 청크를 즉시 재생 목록에 반영 (점진적 노출)
        setAudioUrls([...urls]);
        setTtsProgress({ done: i + 1, total: chunks.length });
      }
    } catch (e) {
      // 일부라도 변환됐으면 그 청크들은 남겨 재생/다운로드 가능하게 둔다
      setError(describeError(e, "tts"));
    } finally {
      setBusy(null);
      setTtsProgress(null);
    }
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a || audioUrls.length === 0) return;
    if (a.paused) {
      // src가 비어 있으면 현재 청크를 로드
      if (!a.src) a.src = audioUrls[currentChunk] ?? audioUrls[0];
      a.play().catch(() => setIsPlaying(false));
    } else {
      a.pause();
    }
  }

  // 현재 청크 재생이 끝나면 다음 청크로 이어 재생, 마지막이면 종료
  function handleChunkEnded() {
    if (currentChunk < audioUrls.length - 1) {
      setCurrentChunk((i) => i + 1); // effect가 src 교체 후 자동 재생
    } else {
      setIsPlaying(false);
      setCurrentChunk(0); // 처음으로 되감기
    }
  }

  // 파일명 베이스 (확장자/번호 제외)
  const downloadBase = useMemo(() => {
    const base = (pageTitle || "tts").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    return base || "tts";
  }, [pageTitle]);

  /** 청크별 다운로드 파일명. 단일 청크면 번호를 붙이지 않는다. */
  function chunkFileName(index: number) {
    if (audioUrls.length <= 1) return `${downloadBase}.mp3`;
    return `${downloadBase}_${index + 1}.mp3`;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 pb-24 pt-6 sm:pt-10">
      {/* 헤더 */}
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            📖 노션 → 음성 변환
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            수업 정리 자료를 자연스러운 한국어 음성으로 들어보세요.
          </p>
        </div>
        <button
          onClick={toggleDark}
          aria-label="다크모드 전환"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-slate-200 text-xl transition hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {dark ? "☀️" : "🌙"}
        </button>
      </header>

      {/* 에러 */}
      {error && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          ⚠️ {error}
        </div>
      )}

      {/* STEP 1: 노션 입력 */}
      <Section step={1} title="노션 자료 가져오기">
        <div className="mb-4 flex gap-2">
          <TabButton active={mode === "url"} onClick={() => setMode("url")}>
            URL 직접 입력
          </TabButton>
          <TabButton active={mode === "list"} onClick={() => setMode("list")}>
            페이지 목록에서 선택
          </TabButton>
        </div>

        {mode === "url" ? (
          <input
            type="url"
            inputMode="url"
            placeholder="https://www.notion.so/..."
            value={notionUrl}
            onChange={(e) => setNotionUrl(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:focus:ring-blue-900"
          />
        ) : (
          <div>
            {pagesLoading ? (
              <p className="py-3 text-sm text-slate-500">페이지 목록 불러오는 중…</p>
            ) : pages.length === 0 ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-slate-500">
                  접근 가능한 페이지가 없습니다.
                </p>
                <button
                  onClick={loadPages}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  새로고침
                </button>
              </div>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {pages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedPageId(p.id)}
                    className={`flex w-full flex-col items-start rounded-xl border px-4 py-3 text-left transition ${
                      selectedPageId === p.id
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                        : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span className="font-medium">{p.title}</span>
                    <span className="mt-0.5 text-xs text-slate-400">
                      {new Date(p.lastEdited).toLocaleDateString("ko-KR")} 수정
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <BigButton
          className="mt-4"
          onClick={handleFetch}
          loading={busy === "fetch"}
          disabled={busy !== null}
        >
          내용 가져오기
        </BigButton>

        {rawText && (
          <details className="mt-4 rounded-xl bg-slate-100 p-4 text-sm dark:bg-slate-900">
            <summary className="cursor-pointer font-medium">
              {pageTitle ? `“${pageTitle}” ` : ""}원문 보기 ({rawText.length}자)
            </summary>
            <pre className="mt-3 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">
              {rawText}
            </pre>
          </details>
        )}
      </Section>

      {/* STEP 2: 전처리 */}
      <Section step={2} title="TTS용으로 다듬기 (Claude)">
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          법령 기호·조문번호·표·목록을 듣기 좋은 문장으로 변환합니다.
        </p>
        <BigButton
          onClick={handlePreprocess}
          loading={busy === "preprocess"}
          disabled={busy !== null || !rawText.trim()}
        >
          텍스트 다듬기
        </BigButton>

        {processedText && (
          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-slate-500">
              변환 결과 (수정 가능, {processedText.length}자)
            </label>
            <textarea
              value={processedText}
              onChange={(e) => setProcessedText(e.target.value)}
              rows={8}
              className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base leading-relaxed outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900 dark:focus:ring-blue-900"
            />
          </div>
        )}
      </Section>

      {/* STEP 3: 음성 변환 */}
      <Section step={3} title="음성으로 변환 (ElevenLabs)">
        <BigButton
          onClick={handleTTS}
          loading={busy === "tts"}
          loadingLabel={
            ttsProgress
              ? `${ttsProgress.done}/${ttsProgress.total} 청크 변환 중…`
              : "변환 준비 중…"
          }
          disabled={busy !== null || !processedText.trim()}
        >
          🔊 음성 만들기
        </BigButton>

        {/* 변환 진행률 바 */}
        {busy === "tts" && ttsProgress && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>음성 변환 중…</span>
              <span>
                {ttsProgress.done}/{ttsProgress.total} 청크
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{
                  width: `${(ttsProgress.done / ttsProgress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {audioUrls.length > 0 && (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            {chunkCount > 1 && (
              <p className="mb-3 text-xs text-slate-400">
                긴 텍스트를 {chunkCount}개 구간으로 나눠 변환했습니다.
              </p>
            )}
            <audio
              ref={audioRef}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={handleChunkEnded}
              className="hidden"
            />

            {/* 재생 컨트롤 */}
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-blue-600 text-2xl text-white shadow-lg transition active:scale-95"
                aria-label={isPlaying ? "일시정지" : "재생"}
              >
                {isPlaying ? "⏸" : "▶"}
              </button>

              <div className="flex-1">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">재생 속도</p>
                  {chunkCount > 1 && (
                    <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                      {isPlaying ? "▶ 재생 중" : "일시정지"} ·{" "}
                      {currentChunk + 1}/{chunkCount} 구간
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSpeed(s)}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                        speed === s
                          ? "bg-blue-600 text-white"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 다운로드 — 청크별 개별 MP3 (병합 시 파일이 손상되므로 분리 제공) */}
            <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
              <p className="mb-2 text-sm font-medium text-slate-500">
                {chunkCount > 1 ? "구간별 MP3 다운로드" : "MP3 다운로드"}
              </p>
              <div className="space-y-2">
                {audioUrls.map((url, i) => (
                  <a
                    key={url}
                    href={url}
                    download={chunkFileName(i)}
                    className={`flex w-full items-center justify-center gap-2 rounded-xl border py-3 text-base font-semibold transition hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      i === currentChunk
                        ? "border-blue-400 dark:border-blue-700"
                        : "border-slate-300 dark:border-slate-700"
                    }`}
                  >
                    ⬇️ {chunkCount > 1 ? `${i + 1}번째 구간` : "MP3"} 다운로드
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}
      </Section>

      <footer className="mt-10 text-center text-xs text-slate-400">
        Notion · Claude (haiku-4-5) · ElevenLabs
      </footer>
    </main>
  );
}

/* ──────────────────────────── 하위 컴포넌트 ──────────────────────────── */

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-sm text-white">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
        active
          ? "bg-blue-600 text-white"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

function BigButton({
  onClick,
  loading,
  loadingLabel = "처리 중…",
  disabled,
  className = "",
  children,
}: {
  onClick: () => void;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={`flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-4 text-base font-semibold text-white shadow-md transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {loading ? (
        <>
          <Spinner />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin text-white"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.37 0 0 5.37 0 12h4z"
      />
    </svg>
  );
}
