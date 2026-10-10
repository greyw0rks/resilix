// The Resilix mark — the same artwork as app/icon.svg, so the browser tab and
// the header cannot drift apart.
//
// Why a component and not an <img src="/icon.svg">: the mark is small, used in
// two places, and inlining it keeps it crisp at any size and free of an extra
// request. Keep this in step with app/icon.svg if either changes.

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Resilix"
      className="shrink-0"
    >
      <rect width="48" height="48" rx="11" fill="#2f6fe0" />

      {/* The shield, drawn as two halves that stop at the open apex node. */}
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 13.5 H34 V22.5 C34 28.6 30.5 32.6 26.9 34.4" />
        <path d="M14 13.5 V22.5 C14 28.6 17.5 32.6 21.1 34.4" />
      </g>

      {/* Two operators reporting online. */}
      <circle cx="14" cy="13.5" r="2.9" fill="#ffffff" />
      <circle cx="34" cy="13.5" r="2.9" fill="#ffffff" />

      {/* The node the structure can afford to lose. */}
      <circle cx="24" cy="35" r="3" fill="none" stroke="#ffffff" strokeWidth="2.6" />
    </svg>
  );
}

// The wordmark: "Resi" in the text colour, "lix" in brand blue.
export function Wordmark() {
  return (
    <span className="text-[17px] font-semibold tracking-tight text-white">
      Resi<span className="text-brand-400">lix</span>
    </span>
  );
}
