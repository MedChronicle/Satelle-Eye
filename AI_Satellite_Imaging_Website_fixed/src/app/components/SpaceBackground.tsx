import { useEffect, useRef, useState } from 'react';
import spacevideo from '../../imports/space-background.mp4';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function useSaveData() {
  const connection = (navigator as any).connection;
  return Boolean(connection?.saveData);
}

export function SpaceBackground() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const saveData = useSaveData();
  const showVideo = !reducedMotion && !saveData && !failed;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showVideo) return;

    const onVisibility = () => {
      if (document.hidden) {
        video.pause();
      } else {
        video.play().catch(() => undefined);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    video.play().catch(() => undefined);

    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [showVideo]);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-black pointer-events-none" aria-hidden="true">
      {showVideo && (
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          onCanPlay={() => setReady(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 ${
            ready ? 'opacity-100' : 'opacity-0'
          }`}
          src={spacevideo}
        />
      )}

      <div className="absolute inset-0 bg-black/55" />

      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.65) 100%)',
        }}
      />
    </div>
  );
}
