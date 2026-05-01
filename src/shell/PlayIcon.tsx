/// Shared play / run icon for the run-script affordance on entity
/// cards. Filled triangle so it reads unambiguously as "run" even at
/// 14px (an outline triangle gets noisy). `currentColor` so hover
/// styling lives on the parent button.
export function PlayIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
