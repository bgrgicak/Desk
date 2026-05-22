/** The Roomy wordmark. The letters track `currentColor` (so they theme
 *  with `text-foreground` in light/dark mode); the overlapping circles keep
 *  their brand gradient. */
export function RoomyWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Roomy"
    >
      <path
        d="M0 1H9.15547C10.5374 1 11.7351 1.14587 12.7486 1.43762C13.762 1.72169 14.6027 2.13628 15.2706 2.68138C15.9386 3.22649 16.4338 3.89059 16.7562 4.6737C17.0864 5.45681 17.2514 6.34357 17.2514 7.33397C17.2514 8.00192 17.1708 8.63915 17.0096 9.24568C16.8484 9.84453 16.5988 10.3973 16.261 10.904C15.9309 11.4107 15.5125 11.8637 15.0058 12.263C14.499 12.6545 13.904 12.9808 13.2207 13.2418L17.1363 19H12.6679L9.28215 13.8868H9.1785L3.65067 13.8752V19H0V1ZM9.2476 10.7198C9.93858 10.7198 10.5413 10.6392 11.0557 10.4779C11.5777 10.3167 12.0115 10.0902 12.357 9.79846C12.7102 9.50672 12.9712 9.15355 13.1401 8.73896C13.3167 8.3167 13.405 7.84837 13.405 7.33397C13.405 6.32821 13.0595 5.55278 12.3685 5.00768C11.6775 4.45489 10.6372 4.1785 9.2476 4.1785H3.65067V10.7198H9.2476Z"
        fill="currentColor"
      />
      <path
        d="M19.75 10C19.75 4.47715 24.2272 0 29.75 0V0C35.2728 0 39.75 4.47715 39.75 10V10C39.75 15.5228 35.2728 20 29.75 20V20C24.2272 20 19.75 15.5228 19.75 10V10Z"
        fill="url(#roomy-wordmark-grad-a)"
      />
      <path
        d="M30.75 10C30.75 4.47715 35.2272 0 40.75 0V0C46.2728 0 50.75 4.47715 50.75 10V10C50.75 15.5228 46.2728 20 40.75 20V20C35.2272 20 30.75 15.5228 30.75 10V10Z"
        fill="url(#roomy-wordmark-grad-b)"
      />
      <path
        d="M53.75 1H57.4007L63.9419 7.5643L70.4832 1H74.1339V19H70.4832V6.05566L63.9419 12.3551L57.4007 6.05566V19H53.75V1Z"
        fill="currentColor"
      />
      <path
        d="M83.6391 14.5432L75.7734 1H79.9078L85.4471 11.238L90.9174 1H95.0517L87.2898 14.5202V19H83.6391V14.5432Z"
        fill="currentColor"
      />
      <defs>
        <linearGradient
          id="roomy-wordmark-grad-a"
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
          id="roomy-wordmark-grad-b"
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
