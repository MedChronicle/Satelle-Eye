import { Rocket } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export function Footer() {
  const { t } = useLanguage();

  return (
    <footer className="relative border-t border-white/10 py-20 px-8">
      <div className="max-w-[1400px] mx-auto flex flex-col items-center text-center">
        <a href="#top" className="flex items-center gap-3 mb-6">
          <Rocket className="w-6 h-6 text-blue-400" aria-hidden="true" />
          <span className="tracking-wider text-white">SATELL-EYE</span>
        </a>
        <p className="text-white/70 max-w-md">{t('footer.tagline')}</p>
        <p className="mt-10 text-sm text-white/40">
          © {new Date().getFullYear()} SATELL-EYE
        </p>
      </div>
    </footer>
  );
}
