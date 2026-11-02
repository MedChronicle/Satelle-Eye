import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

type Status = 'loading' | 'loaded' | 'error'

export interface ImageWithFallbackProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Secondary image to try after the main src (and any retries) fail. */
  fallbackSrc?: string
  /** Custom node rendered in the error state instead of the default placeholder. */
  fallback?: React.ReactNode
  /** Automatic retries before giving up. Retries add a cache-busting `_r` query param. */
  retries?: number
  retryDelayMs?: number
  /** Show a pulsing placeholder and fade the image in once loaded. */
  showSkeleton?: boolean
  /** Show a "Try again" button in the default error state. */
  allowManualRetry?: boolean
}

const withRetryParam = (src: string, attempt: number) =>
  attempt === 0 || src.startsWith('data:') || src.startsWith('blob:')
    ? src
    : `${src}${src.includes('?') ? '&' : '?'}_r=${attempt}`

function BrokenImageIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="16" y="16" width="56" height="56" rx="6" />
      <path d="m16 58 16-18 32 32" />
      <circle cx="53" cy="35" r="7" />
    </svg>
  )
}

export const ImageWithFallback = forwardRef<HTMLImageElement, ImageWithFallbackProps>(
  function ImageWithFallback(
    {
      src, alt, className = '', style, fallbackSrc, fallback,
      retries = 1, retryDelayMs = 800, showSkeleton = true, allowManualRetry = true,
      loading = 'lazy', decoding = 'async', onLoad, onError, ...rest
    },
    forwardedRef,
  ) {
    const [status, setStatus] = useState<Status>('loading')
    const [attempt, setAttempt] = useState(0)
    const [usingFallback, setUsingFallback] = useState(false)
    const imgRef = useRef<HTMLImageElement | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout>>()

    // Reset when the source changes (the old version stayed in the error state forever).
    useEffect(() => {
      setStatus('loading'); setAttempt(0); setUsingFallback(false)
      return () => clearTimeout(timerRef.current)
    }, [src])

    // Images served from cache can finish before React attaches onLoad.
    useEffect(() => {
      const el = imgRef.current
      if (el?.complete && el.naturalWidth > 0) setStatus('loaded')
    })

    const setRefs = useCallback((node: HTMLImageElement | null) => {
      imgRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }, [forwardedRef])

    const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
      onError?.(e) // the old version silently overwrote the caller's onError
      if (!usingFallback && attempt < retries) {
        timerRef.current = setTimeout(() => setAttempt((a) => a + 1), retryDelayMs * (attempt + 1))
      } else if (!usingFallback && fallbackSrc) {
        setUsingFallback(true); setAttempt(0); setStatus('loading')
      } else {
        setStatus('error')
      }
    }

    const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
      setStatus('loaded')
      onLoad?.(e)
    }

    const manualRetry = () => {
      setUsingFallback(false); setAttempt((a) => a + 1); setStatus('loading')
    }

    if (status === 'error') {
      return (
        <div
          role="img"
          aria-label={alt ? `${alt} (failed to load)` : 'Image failed to load'}
          className={`flex flex-col items-center justify-center gap-2 bg-white/5 border border-white/10 text-white/40 text-center ${className}`}
          style={style}
          data-original-url={src}
        >
          {fallback ?? (
            <>
              <BrokenImageIcon />
              {alt && <span className="text-xs px-3 line-clamp-2">{alt}</span>}
              {allowManualRetry && src && (
                <button type="button" onClick={manualRetry}
                  className="text-xs text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
                  Try again
                </button>
              )}
            </>
          )}
        </div>
      )
    }

    const current = usingFallback ? fallbackSrc : src && withRetryParam(src, attempt)
    const stateClass = !showSkeleton
      ? ''
      : status === 'loaded'
        ? 'opacity-100 transition-opacity duration-500'
        : 'opacity-60 animate-pulse bg-white/10'

    return (
      <img
        {...rest}
        ref={setRefs}
        // key forces a fresh request on retry, since the same src may be cached as failed
        key={`${current}`}
        src={current}
        alt={alt}
        loading={loading}
        decoding={decoding}
        className={`${className} ${stateClass}`.trim()}
        style={style}
        onLoad={handleLoad}
        onError={handleError}
        data-original-url={src}
      />
    )
  },
)
