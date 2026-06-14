// 클라이언트와 서버가 공유하는 텍스트 청킹 유틸리티.
// ElevenLabs 한 번의 요청이 Vercel 무료 플랜의 10초 타임아웃을 넘지 않도록
// 텍스트를 작은 청크로 나눈다.

export const MAX_CHARS = 2000;

/**
 * 텍스트를 maxChars 이하 청크로 분할한다.
 * 가능한 한 문장(마침표/물음표/느낌표/줄바꿈) 경계에서 자른다.
 */
export function chunkText(text: string, maxChars = MAX_CHARS): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  const chunks: string[] = [];
  // 문장 단위로 분리 (구분자 유지)
  const sentences = clean
    .split(/(?<=[.!?。！？\n])/)
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
