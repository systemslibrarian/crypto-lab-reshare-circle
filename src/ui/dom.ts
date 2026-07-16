/** Small DOM helpers shared by every panel. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/** Full fixed-width hex (default 32 bytes — the 256-bit secret). */
export function fullHex(v: bigint, bytes = 32): string {
  return v.toString(16).padStart(bytes * 2, '0');
}

/** Truncated hex for 2048-bit group elements and Z_q shares. */
export function truncHex(v: bigint): string {
  const h = v.toString(16);
  return h.length <= 18 ? `0x${h}` : `0x${h.slice(0, 10)}…${h.slice(-6)}`;
}

export type ChipKind = 'ok' | 'alarm' | 'neutral';

/**
 * A state chip: icon + text + color together (never color alone, WCAG 1.4.1).
 * `ok` tracks SYSTEM INTEGRITY, not the raw crypto return value — a
 * forged-but-accepted result must be rendered with kind 'alarm'.
 */
export function chip(kind: ChipKind, icon: string, text: string): HTMLElement {
  return el('p', { class: `chip chip-${kind}` }, [
    el('span', { class: 'chip-icon', 'aria-hidden': 'true', text: icon }),
    ` ${text}`,
  ]);
}

/** A labelled monospace hex block. */
export function hexRow(label: string, value: string): HTMLElement {
  return el('div', { class: 'hexrow' }, [
    el('span', { class: 'hexrow-label', text: label }),
    el('code', { class: 'hexblock', text: value }),
  ]);
}

/** Yield to the event loop so a just-set status message can paint. */
export function paint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
