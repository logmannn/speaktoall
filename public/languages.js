// Shared by the server and the browser pages.

// Deepgram Nova-3 streaming languages. "multi" is Nova-3's code-switching mode.
export const INPUT_LANGUAGES = [
  "en-US", "en-GB", "en-AU", "en-IN", "en-NZ", "multi",
  "bg", "ca", "zh-CN", "zh-TW", "cs", "da", "nl", "nl-BE", "et", "fi",
  "fr", "fr-CA", "de", "de-CH", "el", "hi", "hu", "id", "it", "ja", "ko",
  "lv", "lt", "ms", "no", "pl", "pt", "pt-BR", "ro", "ru", "sk", "es",
  "es-419", "sv", "th", "tr", "uk", "vi",
];

// Any language the translation model handles well can go here.
export const OUTPUT_LANGUAGES = [
  "am", "ar", "bn", "bg", "ca", "zh-Hans", "zh-Hant", "cs", "da", "nl", "en",
  "et", "fa", "fi", "fr", "de", "el", "ht", "he", "hi", "hu", "id", "it",
  "ja", "km", "ko", "lv", "lt", "ms", "my", "ne", "no", "pa", "pl", "pt",
  "pt-BR", "ro", "ru", "sk", "so", "es", "sw", "sv", "tl", "ta", "te", "th",
  "tr", "uk", "ur", "vi", "yo",
];

export const TTS_VOICES = [
  { value: "alloy", label: "Alloy (neutral)" },
  { value: "echo", label: "Echo (male)" },
  { value: "fable", label: "Fable (male)" },
  { value: "onyx", label: "Onyx (male)" },
  { value: "nova", label: "Nova (female)" },
  { value: "shimmer", label: "Shimmer (female)" },
];

export const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

// Names in `locale`; pass the language itself as locale for its native name.
export function languageName(code, locale = "en") {
  if (code === "multi") return "Multilingual (auto-detect)";
  try {
    const name = new Intl.DisplayNames([locale, "en"], { type: "language" }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {}
  return code;
}

export function baseLanguage(code) {
  return code.split("-")[0].toLowerCase();
}
