/** The Desk avatar logo from Figma — the stylised handwritten 𝒹
 *  glyph on a pink-to-mint gradient circle. Used in the chat empty
 *  state's avatar stack as the "agent" half of the pair, the same way
 *  the room avatar appears in a room chat's greeting. */
export function DeskLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Desk"
    >
      <defs>
        {/* Stable id includes a suffix so multiple copies on the
            page don't collide. */}
        <linearGradient
          id="desk-logo-bg"
          x1="16"
          y1="0"
          x2="16"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFE7EE" />
          <stop offset="1" stopColor="#C3FFEE" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="url(#desk-logo-bg)" />
      <path
        d="M22.7038 12.7493C22.7038 9.3505 19.1275 7.42899 16.2015 7.42899C11.7388 7.42901 10.882 10.7695 10.882 15.114C10.8821 17.2123 10.9997 19.2811 11.2066 20.3155C11.2953 20.7292 11.6502 21.0244 12.064 21.0244C12.5957 21.0244 12.9506 20.5816 12.9508 20.1385C12.9508 20.0793 12.9213 20.0197 12.9213 19.9606C12.7736 19.2216 12.6549 17.1531 12.6549 15.114C12.6549 13.1044 12.9805 11.272 13.4238 10.533C13.9262 9.70549 14.3987 9.20274 16.2015 9.20272C18.5955 9.20272 20.93 10.8283 20.93 12.7493C20.93 15.4979 18.7727 17.4188 16.231 19.4581C14.7534 20.6403 13.2757 21.8225 12.0345 23.0638C11.8571 23.241 11.768 23.4486 11.768 23.6851C11.7683 24.1577 12.1822 24.571 12.6549 24.571C12.8913 24.571 13.0981 24.4827 13.2754 24.3055C14.3984 23.1825 15.8763 22 17.3539 20.8179C19.8365 18.8377 22.7038 16.5028 22.7038 12.7493Z"
        fill="currentColor"
      />
    </svg>
  )
}
