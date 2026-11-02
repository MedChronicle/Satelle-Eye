import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type Variants,
} from 'motion/react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { useCallback, type MouseEvent } from 'react';
import { useLanguage } from '../context/LanguageContext';

interface HeroProps {
  onLaunchMission: () => void;
  /** Optional secondary action. Rendered only when both label and handler are given. */
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
  /** Element id to scroll to when the scroll cue is clicked. Cue hidden if omitted. */
  scrollTargetId?: string;
}

export function Hero({
  onLaunchMission,
  secondaryLabel,
  onSecondaryAction,
  scrollTargetId,
}: HeroProps) {
  const { t } = useLanguage();
  const reduceMotion = useReducedMotion();

  // ---- Cursor-driven parallax glow (springs keep it smooth, no re-renders) ----
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 20, mass: 0.6 });
  const sy = useSpring(my, { stiffness: 60, damping: 20, mass: 0.6 });
  const glowX = useTransform(sx, (v) => v * 40);
  const glowY = useTransform(sy, (v) => v * 30);
  const glow2X = useTransform(glowX, (v) => -v * 1.4);
  const glow2Y = useTransform(glowY, (v) => -v * 1.4);
  const contentX = useTransform(sx, (v) => v * -8);
  const contentY = useTransform(sy, (v) => v * -6);

  const onMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (reduceMotion) return;
      const r = e.currentTarget.getBoundingClientRect();
      mx.set(((e.clientX - r.left) / r.width - 0.5) * 2); // -1..1
      my.set(((e.clientY - r.top) / r.height - 0.5) * 2);
    },
    [mx, my, reduceMotion]
  );

  const onMouseLeave = useCallback(() => {
    mx.set(0);
    my.set(0);
  }, [mx, my]);

  // ---- Orchestrated entrance: one parent, children inherit via variants ----
  const container: Variants = {
    hidden: {},
    show: {
      transition: { staggerChildren: reduceMotion ? 0 : 0.14, delayChildren: 0.1 },
    },
  };
  const item: Variants = {
    hidden: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24, filter: 'blur(6px)' },
    show: {
      opacity: 1,
      y: 0,
      filter: 'blur(0px)',
      transition: { duration: reduceMotion ? 0.2 : 0.9, ease: [0.22, 1, 0.36, 1] },
    },
  };
  const badge: Variants = {
    hidden: reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 },
    show: { opacity: 1, scale: 1, transition: { duration: 0.7, ease: 'easeOut' } },
  };

  const scrollDown = () => {
    if (!scrollTargetId) return;
    document
      .getElementById(scrollTargetId)
      ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const hasSecondary = Boolean(secondaryLabel && onSecondaryAction);

  return (
    <section
      aria-labelledby="hero-title"
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 md:px-8"
    >
      {/* Ambient glows (decorative, follow the cursor subtly) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <motion.div
          style={{ x: glowX, y: glowY }}
          className="absolute left-1/2 top-1/3 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500/20 blur-[120px]"
        />
        <motion.div
          style={{ x: glow2X, y: glow2Y }}
          className="absolute right-1/4 top-1/2 h-[380px] w-[380px] rounded-full bg-purple-600/15 blur-[110px]"
        />
        <motion.div
          style={{ x: glowX }}
          className="absolute bottom-1/4 left-1/4 h-[300px] w-[300px] rounded-full bg-cyan-400/10 blur-[100px]"
        />
      </div>

      {/* Content */}
      <motion.div
        style={reduceMotion ? undefined : { x: contentX, y: contentY }}
        className="relative z-10 mx-auto w-full max-w-[1400px] pt-32"
      >
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="text-center"
        >
          {/* Badge */}
          <motion.div variants={badge} className="mb-8 inline-block">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-6 py-2 backdrop-blur-md">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                {!reduceMotion && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
                )}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
              </span>
              <span className="text-sm tracking-wider text-cyan-400">{t('hero.badge')}</span>
            </div>
          </motion.div>

          {/* Heading */}
          <motion.h1
            id="hero-title"
            variants={item}
            style={{ fontSize: 'clamp(2.25rem, 6vw, 5rem)', lineHeight: 1.08 }}
            className="mb-6 tracking-tight text-white"
          >
            {t('hero.title1')}
            <br />
            <span
              className="bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent"
              style={{
                backgroundSize: '200% auto',
                animation: reduceMotion ? undefined : 'hero-gradient-shift 8s ease-in-out infinite',
              }}
            >
              {t('hero.title2')}
            </span>
          </motion.h1>

          {/* Subheading */}
          <motion.p
            variants={item}
            className="mx-auto mb-8 max-w-2xl text-base text-white/70 md:text-lg"
          >
            {t('hero.subtitle')}
          </motion.p>

          {/* Buttons */}
          <motion.div
            variants={item}
            className="flex flex-col items-center justify-center gap-4 pt-8 sm:flex-row sm:gap-6"
          >
            <motion.button
              onClick={onLaunchMission}
              whileHover={reduceMotion ? undefined : { scale: 1.05 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20 }}
              className="group relative overflow-hidden rounded-full bg-blue-500 px-8 py-4 text-white transition-shadow duration-300 hover:shadow-[0_0_40px_rgba(59,130,246,0.6)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            >
              <span className="relative z-10 flex items-center gap-2">
                {t('hero.button')}
                <ArrowRight
                  className="h-5 w-5 transition-transform group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </span>
              <span
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-r from-blue-600 to-cyan-500 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              />
              {/* light sweep */}
              {!reduceMotion && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 -left-full z-10 w-1/2 -skew-x-12 bg-white/20 transition-all duration-700 group-hover:left-[150%]"
                />
              )}
            </motion.button>

            {hasSecondary && (
              <motion.button
                onClick={onSecondaryAction}
                whileHover={reduceMotion ? undefined : { scale: 1.03 }}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                className="rounded-full border border-white/20 bg-white/5 px-8 py-4 text-white/90 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                {secondaryLabel}
              </motion.button>
            )}
          </motion.div>
        </motion.div>
      </motion.div>

      {/* Scroll cue */}
      {scrollTargetId && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6, duration: 0.8 }}
          onClick={scrollDown}
          aria-label="Scroll down"
          className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2 text-white/50 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-full"
        >
          <motion.span
            animate={reduceMotion ? undefined : { y: [0, 8, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            className="block"
          >
            <ChevronDown className="h-7 w-7" aria-hidden="true" />
          </motion.span>
        </motion.button>
      )}

      {/* Keyframes for the animated gradient text */}
      <style>{`
        @keyframes hero-gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
      `}</style>
    </section>
  );
}
