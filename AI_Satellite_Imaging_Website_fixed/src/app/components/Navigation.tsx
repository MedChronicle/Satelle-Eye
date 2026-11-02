import { Rocket, Globe, Menu, X, Check, ChevronDown } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

interface NavigationProps {
  onOpenWeather?: () => void;
  onOpenAboutDetail?: () => void;
}

const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
  { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
] as const;

type LangCode = (typeof LANGUAGES)[number]['code'];

export function Navigation({ onOpenWeather, onOpenAboutDetail }: NavigationProps) {
  const { language, setLanguage, t } = useLanguage();

  const [langOpen, setLangOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0); // keyboard focus within language list

  const langRef = useRef<HTMLDivElement>(null);
  const langButtonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const mobileId = useId();

  const currentLanguage = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  // Data-driven nav: add an item here and it appears in both desktop + mobile menus.
  const navItems = useMemo(
    () => [
      { key: 'about', onClick: onOpenAboutDetail },
      { key: 'weather', onClick: onOpenWeather },
    ],
    [onOpenAboutDetail, onOpenWeather]
  );

  // Stronger glass effect once the page scrolls
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close dropdown on outside click / Escape
  useEffect(() => {
    if (!langOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLangOpen(false);
        langButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [langOpen]);

  // Close mobile menu on Escape and when resizing to desktop
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => mq.matches && setMobileOpen(false);
    document.addEventListener('keydown', onKey);
    mq.addEventListener('change', onChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onChange);
    };
  }, [mobileOpen]);

  // Move focus to the active option when the list opens / arrow keys move
  useEffect(() => {
    if (langOpen) optionRefs.current[activeIndex]?.focus();
  }, [langOpen, activeIndex]);

  const openLangMenu = useCallback(() => {
    setActiveIndex(Math.max(0, LANGUAGES.findIndex((l) => l.code === language)));
    setLangOpen(true);
  }, [language]);

  const selectLanguage = useCallback(
    (code: LangCode) => {
      setLanguage(code as Parameters<typeof setLanguage>[0]);
      setLangOpen(false);
      langButtonRef.current?.focus();
    },
    [setLanguage]
  );

  const onLangButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openLangMenu();
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = LANGUAGES.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(last);
        break;
      case 'Tab':
        setLangOpen(false);
        break;
    }
  };

  const underline =
    'absolute -bottom-1 left-0 h-0.5 w-0 bg-blue-400 transition-all duration-300 group-hover:w-full group-focus-visible:w-full';
  const focusRing =
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 rounded-md';

  const LanguageList = (
    <div
      id={menuId}
      role="listbox"
      aria-label="Language"
      onKeyDown={onListKey}
      className="absolute top-full right-0 mt-3 min-w-[190px] origin-top-right animate-in fade-in zoom-in-95 duration-150 overflow-hidden rounded-xl border border-white/20 bg-slate-900/80 shadow-2xl backdrop-blur-xl"
    >
      {LANGUAGES.map((lang, i) => {
        const selected = language === lang.code;
        return (
          <button
            key={lang.code}
            ref={(el) => {
              optionRefs.current[i] = el;
            }}
            role="option"
            aria-selected={selected}
            tabIndex={i === activeIndex ? 0 : -1}
            onClick={() => selectLanguage(lang.code)}
            className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200 focus:outline-none focus-visible:bg-white/15 ${
              selected ? 'bg-blue-500/20 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
            }`}
          >
            <span className="text-xl" aria-hidden="true">
              {lang.flag}
            </span>
            <span className="flex-1">{lang.name}</span>
            {selected && <Check className="h-4 w-4 text-blue-400" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );

  return (
    <nav
      aria-label="Main"
      className="fixed left-0 right-0 top-0 z-50 px-4 py-4 transition-all duration-300 md:px-8 md:py-6"
    >
      <div className="mx-auto max-w-[1400px]">
        <div
          className={`flex items-center justify-between rounded-2xl border px-5 py-3 shadow-2xl backdrop-blur-md transition-all duration-300 md:px-8 md:py-4 ${
            scrolled ? 'border-white/20 bg-slate-950/60' : 'border-white/10 bg-white/5'
          }`}
        >
          {/* Logo */}
          <a
            href="/"
            className={`flex items-center gap-3 ${focusRing}`}
            aria-label="SATELL-EYE home"
          >
            <Rocket className="h-6 w-6 text-blue-400" aria-hidden="true" />
            <span className="tracking-wider text-white">SATELL-EYE</span>
          </a>

          {/* Desktop items */}
          <div className="hidden items-center gap-8 md:flex">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={item.onClick}
                className={`group relative text-white/80 transition-colors duration-300 hover:text-white ${focusRing}`}
              >
                {t(`nav.${item.key}`)}
                <span className={underline} />
              </button>
            ))}

            <div className="relative" ref={langRef}>
              <button
                ref={langButtonRef}
                onClick={() => (langOpen ? setLangOpen(false) : openLangMenu())}
                onKeyDown={onLangButtonKey}
                aria-haspopup="listbox"
                aria-expanded={langOpen}
                aria-controls={langOpen ? menuId : undefined}
                className={`group relative flex items-center gap-2 text-white/80 transition-colors duration-300 hover:text-white ${focusRing}`}
              >
                <Globe className="h-4 w-4" aria-hidden="true" />
                <span aria-hidden="true">{currentLanguage.flag}</span>
                {currentLanguage.name}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${langOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
                <span className={underline} />
              </button>
              {langOpen && LanguageList}
            </div>
          </div>

          {/* Mobile toggle */}
          <button
            className={`p-1 text-white/80 hover:text-white md:hidden ${focusRing}`}
            onClick={() => setMobileOpen((o) => !o)}
            aria-expanded={mobileOpen}
            aria-controls={mobileId}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>

        {/* Mobile panel */}
        {mobileOpen && (
          <div
            id={mobileId}
            className="mt-2 animate-in fade-in slide-in-from-top-2 rounded-2xl border border-white/15 bg-slate-950/80 p-3 shadow-2xl backdrop-blur-xl duration-200 md:hidden"
          >
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={() => {
                  item.onClick?.();
                  setMobileOpen(false);
                }}
                className="w-full rounded-lg px-4 py-3 text-left text-white/85 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:bg-white/15"
              >
                {t(`nav.${item.key}`)}
              </button>
            ))}

            <div className="my-2 border-t border-white/10" />

            <div className="grid grid-cols-2 gap-1">
              {LANGUAGES.map((lang) => {
                const selected = language === lang.code;
                return (
                  <button
                    key={lang.code}
                    onClick={() => {
                      setLanguage(lang.code as Parameters<typeof setLanguage>[0]);
                      setMobileOpen(false);
                    }}
                    aria-pressed={selected}
                    className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus:outline-none focus-visible:bg-white/15 ${
                      selected ? 'bg-blue-500/20 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <span aria-hidden="true">{lang.flag}</span>
                    {lang.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
