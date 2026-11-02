import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { LanguageProvider } from './context/LanguageContext';
import { Navigation } from './components/Navigation';
import { Hero } from './components/Hero';
import { About } from './components/About';
import { Footer } from './components/Footer';
import { SpaceBackground } from './components/SpaceBackground';

const Dashboard = lazy(() =>
  import('./components/Dashboard').then((module) => ({ default: module.Dashboard })),
);
const WeatherPage = lazy(() =>
  import('./components/WeatherPage').then((module) => ({ default: module.WeatherPage })),
);
const AboutDetailPage = lazy(() =>
  import('./components/AboutDetailPage').then((module) => ({ default: module.AboutDetailPage })),
);

type View = 'home' | 'dashboard' | 'weather' | 'about';

function PageLoader() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-black text-white/70"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="size-10 animate-spin rounded-full border-2 border-white/20 border-t-blue-400" />
        <span className="text-sm tracking-wide">Loading...</span>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('home');

  const goHome = useCallback(() => setView('home'), []);
  const openDashboard = useCallback(() => setView('dashboard'), []);
  const openWeather = useCallback(() => setView('weather'), []);
  const openAboutDetail = useCallback(() => setView('about'), []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [view]);

  useEffect(() => {
    if (view === 'home') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setView('home');
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view]);

  return (
    <LanguageProvider>
      <div className="relative min-h-screen overflow-x-hidden bg-black">
        {view === 'home' ? (
          <>
            <SpaceBackground />
            <div className="relative z-10">
              <Navigation onOpenWeather={openWeather} onOpenAboutDetail={openAboutDetail} />
              <Hero onLaunchMission={openDashboard} />
              <About />
              <Footer />
            </div>
          </>
        ) : (
          <Suspense fallback={<PageLoader />}>
            {view === 'dashboard' && <Dashboard onClose={goHome} />}
            {view === 'weather' && <WeatherPage onClose={goHome} />}
            {view === 'about' && <AboutDetailPage onClose={goHome} />}
          </Suspense>
        )}
      </div>
    </LanguageProvider>
  );
}
