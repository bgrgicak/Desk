/** Just the two overlapping "oo" circles from the Roomy wordmark.
 *  Used as the compact logo on narrow viewports. */
export function RoomyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="19.75 0 31 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Roomy"
    >
      <path
        d="M19.75 10C19.75 4.47715 24.2272 0 29.75 0V0C35.2728 0 39.75 4.47715 39.75 10V10C39.75 15.5228 35.2728 20 29.75 20V20C24.2272 20 19.75 15.5228 19.75 10V10Z"
        fill="url(#roomy-icon-grad-a)"
      />
      <path
        d="M30.75 10C30.75 4.47715 35.2272 0 40.75 0V0C46.2728 0 50.75 4.47715 50.75 10V10C50.75 15.5228 46.2728 20 40.75 20V20C35.2272 20 30.75 15.5228 30.75 10V10Z"
        fill="url(#roomy-icon-grad-b)"
      />
      <defs>
        <linearGradient
          id="roomy-icon-grad-a"
          x1="29.75"
          y1="-2.1943"
          x2="29.75"
          y2="22.1943"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#AC5EDC" />
          <stop offset="1" stopColor="#AC5EDC" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id="roomy-icon-grad-b"
          x1="40.75"
          y1="-2.1943"
          x2="40.75"
          y2="22.1943"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4CE4A7" />
          <stop offset="1" stopColor="#4CE4A7" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
