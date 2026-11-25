// Split stable transcripts promptly, including short phrases and unpunctuated speech.
export function splitTranslationChunks(text, limit = 120) {
  const chars = Array.from(text.trim());
  const chunks = [];
  while (chars.length) {
    let end = Math.min(limit, chars.length);
    if (chars.length > limit) {
      const window = chars.slice(0, limit).join("");
      const boundaries = [...window.matchAll(/[.!?。！？,，;；:：\s]/gu)];
      const preferred = boundaries.filter((match) =>
        Array.from(window.slice(0, match.index + 1)).length >= limit / 2);
      if (preferred.length) {
        const last = preferred.at(-1);
        end = Array.from(window.slice(0, last.index + 1)).length;
      }
    }
    const chunk = chars.splice(0, end).join("").trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}
