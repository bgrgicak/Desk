import { useState } from 'react'
import { cn } from '@roomy-ai/ui'

// Full-viewport blob backdrop. Ellipses sit at the bottom edge of the SVG
// viewBox so their bodies hang off the visible area; the heavily-blurred
// fringes bleed up into the page and fade to nothing well before the top.
// Each blob runs two animations in parallel: a slow drift / scale / rotate
// keyframe, and a longer colour cycle that walks through the palette. The
// colour cycle's start phase is randomised on mount so the colours aren't
// pinned to fixed positions across loads. Animation respects
// `prefers-reduced-motion: reduce`.

const COLOR_CYCLE_S = 240

export function BackgroundBlobs({ className }: { className?: string }) {
  // Each blob starts at a random point in the colour cycle. The phases stay
  // stable for the lifetime of the mount, so the cycle is smooth — only the
  // initial arrangement is randomised.
  const [colorOffsets] = useState<readonly number[]>(() =>
    Array.from({ length: 5 }, () => -Math.floor(Math.random() * COLOR_CYCLE_S)),
  )

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden -z-10',
        className,
      )}
    >
      <svg
        viewBox="0 0 1600 1000"
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 h-full w-full"
        style={{ filter: 'blur(180px)' }}
      >
        <ellipse cx="80"   cy="1000" rx="380" ry="260" opacity="0.55" className="blob blob-1" style={{ animationDelay: `0s, ${colorOffsets[0]}s` }} />
        <ellipse cx="1520" cy="1000" rx="380" ry="260" opacity="0.55" className="blob blob-2" style={{ animationDelay: `0s, ${colorOffsets[1]}s` }} />
        <ellipse cx="800"  cy="1040" rx="440" ry="240" opacity="0.40" className="blob blob-3" style={{ animationDelay: `0s, ${colorOffsets[2]}s` }} />
        <ellipse cx="1180" cy="1020" rx="300" ry="200" opacity="0.35" className="blob blob-4" style={{ animationDelay: `0s, ${colorOffsets[3]}s` }} />
        <ellipse cx="420"  cy="1020" rx="300" ry="200" opacity="0.35" className="blob blob-5" style={{ animationDelay: `0s, ${colorOffsets[4]}s` }} />
      </svg>
      <style>{`
        @keyframes blobDrift1 {
          0%   { transform: translate(0, 0)        scale(1)    rotate(0deg); }
          25%  { transform: translate(180px, -60px) scale(1.15) rotate(14deg); }
          50%  { transform: translate(80px,  40px)  scale(0.9)  rotate(-8deg); }
          75%  { transform: translate(-120px, -30px) scale(1.05) rotate(20deg); }
          100% { transform: translate(0, 0)        scale(1)    rotate(0deg); }
        }
        @keyframes blobDrift2 {
          0%   { transform: translate(0, 0)         scale(1)    rotate(0deg); }
          25%  { transform: translate(-160px, -50px) scale(0.92) rotate(-12deg); }
          50%  { transform: translate(-60px, 50px)   scale(1.18) rotate(6deg); }
          75%  { transform: translate(140px, -20px)  scale(1.04) rotate(-18deg); }
          100% { transform: translate(0, 0)         scale(1)    rotate(0deg); }
        }
        @keyframes blobDrift3 {
          0%   { transform: translate(0, 0)         scale(1)    rotate(0deg); }
          25%  { transform: translate(140px, -40px)  scale(1.1)  rotate(10deg); }
          50%  { transform: translate(-100px, 30px)  scale(1.22) rotate(-12deg); }
          75%  { transform: translate(60px, -50px)   scale(0.88) rotate(16deg); }
          100% { transform: translate(0, 0)         scale(1)    rotate(0deg); }
        }
        @keyframes blobDrift4 {
          0%   { transform: translate(0, 0)         scale(1)    rotate(0deg); }
          25%  { transform: translate(-120px, 30px)  scale(1.12) rotate(-14deg); }
          50%  { transform: translate(80px, -50px)   scale(0.85) rotate(10deg); }
          75%  { transform: translate(-50px, 40px)   scale(1.06) rotate(-20deg); }
          100% { transform: translate(0, 0)         scale(1)    rotate(0deg); }
        }
        @keyframes blobDrift5 {
          0%   { transform: translate(0, 0)         scale(1)    rotate(0deg); }
          25%  { transform: translate(140px, 20px)   scale(0.9)  rotate(18deg); }
          50%  { transform: translate(60px, -40px)   scale(1.15) rotate(-10deg); }
          75%  { transform: translate(-80px, 30px)   scale(1.08) rotate(14deg); }
          100% { transform: translate(0, 0)         scale(1)    rotate(0deg); }
        }
        @keyframes blobColor {
          0%    { fill: #86efac; }
          16.7% { fill: #f9a8d4; }
          33.3% { fill: #c4b5fd; }
          50%   { fill: #fed7aa; }
          66.7% { fill: #bfdbfe; }
          83.3% { fill: #fde68a; }
          100%  { fill: #86efac; }
        }
        .blob { transform-origin: center; transform-box: fill-box; will-change: transform, fill; }
        .blob-1 { animation: blobDrift1 56s ease-in-out infinite, blobColor 240s ease-in-out infinite; }
        .blob-2 { animation: blobDrift2 72s ease-in-out infinite, blobColor 240s ease-in-out infinite; }
        .blob-3 { animation: blobDrift3 64s ease-in-out infinite, blobColor 240s ease-in-out infinite; }
        .blob-4 { animation: blobDrift4 88s ease-in-out infinite, blobColor 240s ease-in-out infinite; }
        .blob-5 { animation: blobDrift5 80s ease-in-out infinite, blobColor 240s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .blob { animation: none !important; }
        }
      `}</style>
    </div>
  )
}
