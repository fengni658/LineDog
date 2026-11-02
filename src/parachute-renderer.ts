export type ParachutePhase = "NONE" | "OPENING" | "GLIDING" | "CLOSING";

/** An original vector accessory; the accepted dog PNGs remain untouched. */
export function createParachuteMarkup(): string {
  return `<div class="pet-parachute" data-phase="NONE" aria-hidden="true">
    <svg viewBox="0 0 160 240" xmlns="http://www.w3.org/2000/svg" fill="none">
      <g class="pet-parachute-ropes" stroke="#24201b" stroke-width="2.5" stroke-linecap="round">
        <path d="M22 64 Q43 122 75 165 M52 64 Q59 126 77 165 M108 64 Q101 126 85 165 M138 64 Q117 122 87 165"/>
      </g>
      <g class="pet-parachute-canopy" stroke="#24201b" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">
        <path d="M16 66 C21 29 47 10 80 10 C113 10 139 29 144 66 Q127 54 112 66 Q96 54 80 66 Q64 54 48 66 Q32 54 16 66Z" fill="#fff9ea"/>
        <path d="M80 11 C63 19 52 37 48 65 Q64 54 80 66 Q96 54 112 65 C108 37 97 19 80 11Z" fill="#f6d5a6"/>
        <path d="M80 12V64" stroke-width="2.2"/>
        <path d="M34 43 Q43 27 56 23" stroke="#fffef8" stroke-width="4"/>
      </g>
    </svg>
  </div>`;
}

export function applyParachuteVisual(
  element: HTMLElement,
  phase: ParachutePhase,
  progress: number,
): void {
  const amount = phase === "NONE" ? 0 : Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  element.dataset.phase = phase;
  element.style.setProperty("--parachute-open", String(amount));
  element.style.setProperty("--parachute-width", String(0.3 + amount * 0.7));
}
