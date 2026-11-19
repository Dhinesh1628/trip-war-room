import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Interface languages. Each translation file maps the English text to the
// translated text; anything missing shows in English, so nothing is ever
// blank. A test checks that every translated string in the code exists in
// all three files. Place names, venue descriptions and server messages (for
// example Concierge answers) stay in English. A language file is loaded
// only when someone picks that language.
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'te', label: 'తెలుగు' },
];
const LOADERS = {
  hi: () => import('../i18n/hi.js'),
  ta: () => import('../i18n/ta.js'),
  te: () => import('../i18n/te.js'),
};
const loaded = { en: {} };
const STORAGE_KEY = 'twr.lang';

export async function loadLanguage(code) {
  if (!loaded[code]) loaded[code] = (await LOADERS[code]()).default;
  return loaded[code];
}
// For tests and the server-free build check: register a dictionary directly.
export function registerDictionary(code, dict) {
  loaded[code] = dict;
}

export function translate(lang, key, vars) {
  let s = loaded[lang]?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const I18nContext = createContext({ lang: 'en', setLang: () => {}, t: (k, v) => translate('en', k, v) });

function initialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (saved === 'en' || LOADERS[saved])) return saved;
  } catch {
    // storage unavailable (private mode): fall through
  }
  return 'en';
}

export function I18nProvider({ children, lang: fixed }) {
  const [lang, setLangState] = useState(fixed ?? initialLang);
  const [, setReady] = useState(0); // re-render once a language file arrives

  useEffect(() => {
    document.documentElement.lang = lang;
    if (!loaded[lang]) loadLanguage(lang).then(() => setReady((n) => n + 1)).catch(() => {});
  }, [lang]);

  const setLang = useCallback((code) => {
    if (code !== 'en' && !LOADERS[code]) return;
    setLangState(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      // not saved; still switches for this visit
    }
  }, []);
  const isLoaded = Boolean(loaded[lang]);
  const t = useCallback((key, vars) => translate(lang, key, vars), [lang, isLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

export function LanguageSelect({ className = '' }) {
  const { lang, setLang, t } = useI18n();
  return (
    <select className={`lang-select ${className}`} value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('Language')}>
      {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.label}</option>)}
    </select>
  );
}
