/**
 * Known WCAG 1.4.11 / generated-content findings in this lab, captured through
 * the gate's own path so the baseline and the check cannot disagree.
 *
 * THIS FILE IS A TO-DO LIST, NOT A SET OF EXEMPTIONS. The gate ratchets on it:
 *   - a finding NOT listed here fails the run, so a regression cannot land;
 *   - a listed finding whose ratio gets WORSE fails, so the list cannot rot;
 *   - a listed finding that no longer appears ALSO fails, so a fixed entry must
 *     be deleted and the file can only shrink toward empty.
 * The last rule is what stops an allowlist becoming a permanent exemption.
 *
 * `unverified: true` marks an absolutely-positioned pseudo-element. It can paint
 * outside its host and the oracle measures it against the host's backdrop, so
 * that ratio is NOT trustworthy — hand-measure before acting on it.
 */
export const NONTEXT_BASELINE: Record<
  string,
  { ratio: number; required: number; unverified: boolean }
> = {
  // What the live oracle finds over {dark, light} x {1280, 380} and all 22
  // states the drive builds is exactly these two, and BOTH are in the SHARED
  // Crypto Lab top bar rather than in anything this lab wrote.
  //
  // `.cl-btn` draws its edge as
  // `1px solid color-mix(in srgb, var(--accent, #35d6bb) 38%, transparent)`
  // over the bar's fixed `#0b1512`. The measured ratio is therefore a FUNCTION
  // OF EACH LAB'S ACCENT, and this lab's is a dark burnt orange (`#C2410C`), so
  // 38% of it over near-black composites to a very dark edge: 1.45:1, the same
  // number in BOTH THEMES, because the bar is always dark and the page theme
  // does not move it. (For scale: a lab that defines no `--accent` at all falls
  // back to the teal and measures 2.45:1 — still short of 3:1. No value of the
  // token reaches the floor at 38%.)
  //
  // Not fixed here on purpose. Every repo in this fleet carries a byte-identical
  // copy of that markup and CSS, and `CLAUDE.md` is explicit that a change every
  // lab should get is a deliberate reviewed pass across the repos and never an
  // overwrite driven from one of them. So it is measured here, ratcheted here so
  // it cannot silently get worse, and reported upward.
  //
  // Everything inside `#app`, the hero and the footer is audited with no
  // exemption and comes back clean.
  'control-boundary|a.cl-btn': { ratio: 1.45, required: 3, unverified: false },
  'control-boundary|button#cl-theme-toggle.cl-btn.cl-icon': {
    ratio: 1.45,
    required: 3,
    unverified: false,
  },
};
