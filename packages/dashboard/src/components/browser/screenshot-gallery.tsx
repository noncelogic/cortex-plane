"use client"

import { useCallback, useEffect, useState } from "react"

import type { Screenshot } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

interface ScreenshotGalleryProps {
  screenshots: Screenshot[]
}

export function ScreenshotGallery({ screenshots }: ScreenshotGalleryProps): React.JSX.Element {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  // Close lightbox on Escape
  useEffect(() => {
    if (lightboxIndex === null) return

    function handler(e: KeyboardEvent): void {
      if (e.key === "Escape") setLightboxIndex(null)
      if (e.key === "ArrowRight" && lightboxIndex !== null && lightboxIndex < screenshots.length - 1)
        setLightboxIndex(lightboxIndex + 1)
      if (e.key === "ArrowLeft" && lightboxIndex !== null && lightboxIndex > 0)
        setLightboxIndex(lightboxIndex - 1)
    }

    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [lightboxIndex, screenshots.length])

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index)
  }, [])

  if (screenshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-[#2d2d3b] bg-[#1c1c27] p-8">
        <span className="material-symbols-outlined mb-2 text-3xl text-slate-600">
          photo_library
        </span>
        <p className="text-sm font-bold text-slate-400">No Screenshots</p>
        <p className="mt-1 text-xs text-slate-500">
          Screenshots will appear here as the agent browses
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {screenshots.map((screenshot, index) => (
          <button
            key={screenshot.id}
            type="button"
            onClick={() => openLightbox(index)}
            className="group relative overflow-hidden rounded-lg border border-[#2d2d3b] bg-[#1c1c27] transition-colors hover:border-primary/30"
          >
            <div className="aspect-video w-full bg-[#0a0a12]">
              <img
                src={screenshot.thumbnailUrl}
                alt={`Screenshot at ${new Date(screenshot.timestamp).toLocaleTimeString()}`}
                className="size-full object-cover"
                loading="lazy"
              />
            </div>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[10px] text-slate-500">
                {relativeTime(screenshot.timestamp)}
              </span>
              <span className="font-mono text-[10px] text-slate-600">
                {screenshot.dimensions.width}x{screenshot.dimensions.height}
              </span>
            </div>
            {/* Hover overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
              <span className="material-symbols-outlined text-2xl text-white">zoom_in</span>
            </div>
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && screenshots[lightboxIndex] && (
        <Lightbox
          screenshot={screenshots[lightboxIndex]}
          onClose={() => setLightboxIndex(null)}
          onPrev={lightboxIndex > 0 ? () => setLightboxIndex(lightboxIndex - 1) : undefined}
          onNext={
            lightboxIndex < screenshots.length - 1
              ? () => setLightboxIndex(lightboxIndex + 1)
              : undefined
          }
          current={lightboxIndex + 1}
          total={screenshots.length}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function Lightbox({
  screenshot,
  onClose,
  onPrev,
  onNext,
  current,
  total,
}: {
  screenshot: Screenshot
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  current: number
  total: number
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-lg bg-slate-800/80 p-2 text-slate-300 transition-colors hover:bg-slate-700"
      >
        <span className="material-symbols-outlined">close</span>
      </button>

      {/* Navigation */}
      {onPrev && (
        <button
          type="button"
          onClick={onPrev}
          className="absolute left-4 rounded-lg bg-slate-800/80 p-2 text-slate-300 transition-colors hover:bg-slate-700"
        >
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={onNext}
          className="absolute right-4 rounded-lg bg-slate-800/80 p-2 text-slate-300 transition-colors hover:bg-slate-700"
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      )}

      {/* Image */}
      <div className="max-h-[85vh] max-w-[90vw]">
        <img
          src={screenshot.fullUrl}
          alt={`Screenshot at ${new Date(screenshot.timestamp).toLocaleTimeString()}`}
          className="max-h-[85vh] w-auto rounded-lg object-contain"
        />
      </div>

      {/* Footer */}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-lg bg-slate-800/80 px-4 py-2 backdrop-blur">
        <span className="text-xs text-slate-400">
          {new Date(screenshot.timestamp).toLocaleString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            month: "short",
            day: "numeric",
          })}
        </span>
        <span className="font-mono text-xs text-slate-500">
          {screenshot.dimensions.width}x{screenshot.dimensions.height}
        </span>
        <span className="text-xs text-slate-500">
          {current} / {total}
        </span>
      </div>
    </div>
  )
}
