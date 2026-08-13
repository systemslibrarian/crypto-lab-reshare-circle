import type { Page } from '@playwright/test';

/**
 * Composite-aware WCAG 1.4.3 contrast measurement.
 *
 * This exists because axe is not a complete contrast oracle. Three classes of
 * text on THIS page never reach the `violations` array a gate asserts on:
 *
 *  - text over a surface axe declines to resolve. This lab paints three of
 *    them: `.cl-hero-why`, the hero aside, is
 *    `color-mix(in oklab, var(--accent) 6%, transparent)`; `.chip-ok` and
 *    `.chip-alarm` — the verdict chips that are the whole output of exhibits 3,
 *    4, 5 and 6 — are `color-mix(in srgb, #22c55e 14%, transparent)` and
 *    `color-mix(in srgb, #ef4444 14%, transparent)`; and `.row-alarm td`, the
 *    tint on the cheating dealer's row, is a 10% mix of the same red. axe files
 *    every one of those under `incomplete`, so a violations-only gate measured
 *    the contrast of almost none of the verdicts this lab exists to render.
 *  - text faded by an ancestor's `opacity` — axe reads the declared `color`,
 *    which is not the colour that lands on screen. Here that is `.cl-hero-sub`
 *    at `.85`.
 *  - SVG text, which axe's `color-contrast` rule does not evaluate at all. The
 *    mechanism plot in exhibit 2 is nothing BUT SVG text: every share value,
 *    every `+Δ` jump label, the secret's seat caption and the mixed-epoch
 *    verdict are `<text>` elements taking their ink from `fill`, painted on
 *    `.mech-plot`'s `--surface-2` panel. That is the single densest run of
 *    numbers on the page and no rule in axe looks at it.
 *
 * So: walk every element that owns text, composite the real painted result
 * (translucent colours, gradient stops and opacity groups included), and
 * compute the ratio against the surface the text is genuinely sitting on
 * rather than against white. A gradient is judged at its worst stop.
 *
 * Opacity is modelled the way the compositor actually does it: an element with
 * `opacity < 1` renders its subtree into a group, then composites the group
 * over the backdrop. That means the *text* and the *background beside it* fade
 * onto the same backdrop independently — which is why both are carried through
 * the walk as a pair rather than fading the foreground alone.
 *
 * The ancestor walk is geometry-aware, because DOM ancestry is not the same
 * thing as "painted underneath". An absolutely positioned child can render
 * entirely outside its parent's box, and then the parent's background is simply
 * not behind it. So an ancestor's own paint is applied only when its border box
 * actually intersects the text's box; a partial intersection still counts, so
 * the judgement stays worst-case. Opacity is unconditional either way — an
 * opacity group fades its whole subtree wherever that subtree happens to paint.
 *
 * Four things this page forced on top of that, each of which otherwise makes
 * the helper report a ratio nothing on screen has:
 *
 *  - AN ANCESTOR AT `opacity: 0` PAINTS NOTHING AT ALL. This lab drives the
 *    mechanism plot by setting `g[data-step].style.opacity` to `'0'` or `'1'`,
 *    so at step 1 of 4 three whole SVG groups — roughly thirty `<text>` nodes —
 *    are in the DOM and lay down zero ink. The pair-carrying walk below fades
 *    foreground AND background to alpha 0 for those, both then resolve to the
 *    canvas colour, and every one of them reports a flat 1:1 for ink that was
 *    never drawn. Skipping them is the same rule as `color: transparent` below,
 *    applied to an ancestor. The *defect* that an opacity-0 element can hide
 *    real text is not thereby waved away — `expectNotBlank` in `gate.ts` checks
 *    exactly that, in every driven state, and knows about this lab's plot.
 *
 *  - TEXT SCROLLED OUT OF A CLIPPING ANCESTOR PAINTS NOTHING. Here the clipping
 *    boxes are the five `.tablewrap` regions (`overflow-x: auto`), which hold
 *    the dealing matrix, the theft planner, the break-it grid, the small-field
 *    arithmetic table and the dealing-verification table — every wide table on
 *    the page, and at 380px all of them are scrolled. Content scrolled past
 *    those is not dimmed or partly drawn; it is absent from the frame, and
 *    asking what colour it sits on has no answer.
 *
 *  - TRANSPARENT TEXT PAINTS NOTHING. Anything drawn `color: transparent` lays
 *    no ink down; compositing a zero-alpha foreground just returns the backdrop
 *    and reports a fixed 1:1. There is no contrast requirement on ink that is
 *    never laid down.
 *
 *  - SVG PAINTS IN DOCUMENT ORDER, SO SIBLINGS CAN BE THE BACKGROUND. That is
 *    load-bearing here rather than inherited: the mechanism plot's `<text>`
 *    labels sit among `<line>`, `<polyline>`, `<circle>`, `<rect>` and
 *    `<polygon>` siblings inside one `<svg>` with no background of its own. An
 *    ancestor-only walk would composite them onto the transparent `<svg>` box
 *    and report a ratio nothing on screen has. The stroke-only guard below
 *    matters just as much: this plot draws its axes, its guide lines and the
 *    mixed-epoch chord as `<line>`/`<polyline>` with `fill: none` unset in the
 *    presentation attributes, and SVG's initial `fill` is BLACK — compositing
 *    those as opaque black rectangles would invent failures for every label
 *    they cross.
 *
 * TWO THINGS THIS WALK CANNOT SEE, stated so neither is mistaken for coverage.
 *
 * FIRST, generated content. The walk iterates ELEMENTS, and a
 * `::before`/`::after` is not one — nor is it one to axe's `color-contrast`
 * rule. `nontext.ts` covers that class separately and is called from `scan()`
 * at every driven state; this page's only generated content is the UA's own
 * `<details>` disclosure triangle, which the stylesheet does not restyle.
 *
 * SECOND, `aria-hidden` text. It is skipped here for the same reason axe skips
 * it, and what this lab hides was enumerated rather than assumed — see the
 * `ariaHidden` note below.
 */

export interface ContrastFailure {
  selector: string;
  text: string;
  foreground: string;
  background: string;
  fontSize: number;
  fontWeight: number;
  required: number;
  ratio: number;
}

/**
 * Walk every element on the page that owns a text node and report the ones
 * whose painted ink misses its WCAG 1.4.3 floor.
 *
 * There is no `within` narrowing parameter, deliberately. Every state this
 * gate measures is a settled one: this lab's only transient styling is the
 * 0.4s `opacity` transition on the mechanism plot's step groups, and `settle()`
 * waits for that to drain before any scan begins. A subtree-narrowing form
 * would be dead code here, and a dead parameter documents a capability the
 * gate does not have.
 */
export async function auditContrast(page: Page): Promise<ContrastFailure[]> {
  return page.evaluate(() => {
    interface RGBA {
      r: number;
      g: number;
      b: number;
      a: number;
    }

    const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

    /**
     * Resolve ANY CSS colour to straight-alpha sRGB via a 1×1 canvas.
     *
     * A hand-rolled `rgba()` regex is not enough here: nearly every tinted
     * hero aside is authored with `color-mix()`, and Chromium reports that to
     * `getComputedStyle` unchanged rather than converting it to sRGB. A
     * regex that only understands `rgb()/rgba()` sees `null` for every one of
     * them and the walk then falls through to the wrong backdrop — which
     * fabricates failures (dark-on-light read as dark-on-dark) and, far worse,
     * could hide a real one. The 2D canvas is the browser's own colour
     * pipeline: assigning `fillStyle` converts any valid CSS colour — oklab,
     * color-mix, hwb, named, hex — to sRGB, and a painted pixel carries the
     * straight alpha back. Invalid input (a gradient direction keyword fed in by
     * mistake) is rejected by the two-sentinel check so it cannot masquerade as
     * black.
     */
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const colorCache = new Map<string, RGBA | null>();
    const resolve = (c: string): RGBA | null => {
      if (!c) return null;
      const cached = colorCache.get(c);
      if (cached !== undefined) return cached;
      let rgba: RGBA | null = null;
      // A valid colour normalises to the same value from either sentinel; an
      // invalid string leaves each sentinel in place and the two disagree.
      ctx.fillStyle = '#000';
      ctx.fillStyle = c;
      const fromBlack = ctx.fillStyle;
      ctx.fillStyle = '#fff';
      ctx.fillStyle = c;
      const fromWhite = ctx.fillStyle;
      if (fromBlack === fromWhite) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        rgba = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
      colorCache.set(c, rgba);
      return rgba;
    };

    /** Split on a separator char that sits at paren-nesting depth 0. */
    const splitTopLevel = (str: string, sep: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of str) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === sep && depth === 0) {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) out.push(cur);
      return out;
    };

    /** Standard source-over compositing of a (possibly translucent) src on dst. */
    const over = (src: RGBA, dst: RGBA): RGBA => {
      const a = src.a + dst.a * (1 - src.a);
      if (a === 0) return TRANSPARENT;
      return {
        r: (src.r * src.a + dst.r * dst.a * (1 - src.a)) / a,
        g: (src.g * src.a + dst.g * dst.a * (1 - src.a)) / a,
        b: (src.b * src.a + dst.b * dst.a * (1 - src.a)) / a,
        a,
      };
    };

    const fade = (c: RGBA, o: number): RGBA => (o >= 1 ? c : { ...c, a: c.a * o });

    const luminance = (c: RGBA): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };

    const ratio = (a: RGBA, b: RGBA): number => {
      const l1 = luminance(a);
      const l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    interface Point {
      x: number;
      y: number;
    }
    interface Stop {
      color: RGBA;
      pos: number;
    }

    const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

    /**
     * Interpolate a gradient's stop list at fraction `t`, in premultiplied
     * straight-alpha, the way the compositor blends a fade-to-`transparent`.
     */
    const colorAt = (stops: Stop[], t: number): RGBA => {
      if (!stops.length) return TRANSPARENT;
      if (t <= stops[0].pos) return stops[0].color;
      const last = stops[stops.length - 1];
      if (t >= last.pos) return last.color;
      let i = 0;
      while (i < stops.length - 1 && stops[i + 1].pos < t) i++;
      const a = stops[i];
      const b = stops[i + 1];
      const span = b.pos - a.pos;
      const f = span <= 0 ? 0 : (t - a.pos) / span;
      const al = a.color.a + (b.color.a - a.color.a) * f;
      const pr = a.color.r * a.color.a + (b.color.r * b.color.a - a.color.r * a.color.a) * f;
      const pg = a.color.g * a.color.a + (b.color.g * b.color.a - a.color.g * a.color.a) * f;
      const pb = a.color.b * a.color.a + (b.color.b * b.color.a - a.color.b * a.color.a) * f;
      return al === 0 ? TRANSPARENT : { r: pr / al, g: pg / al, b: pb / al, a: al };
    };

    /** Parse the colour-stop list of a gradient, normalising positions to 0..1. */
    const parseStops = (parts: string[]): Stop[] => {
      const raw: { color: RGBA; pos: number | null }[] = [];
      for (const part of parts) {
        const tokens = splitTopLevel(part.trim(), ' ').filter(Boolean);
        let color: RGBA | null = null;
        const positions: number[] = [];
        for (const tok of tokens) {
          const c = resolve(tok);
          if (c && !color) color = c;
          else if (tok.endsWith('%')) positions.push(parseFloat(tok) / 100);
        }
        if (!color) continue;
        // A stop may carry two positions (a hard band); emit one per position.
        if (positions.length === 0) raw.push({ color, pos: null });
        else for (const p of positions) raw.push({ color, pos: p });
      }
      if (!raw.length) return [];
      if (raw[0].pos === null) raw[0].pos = 0;
      if (raw[raw.length - 1].pos === null) raw[raw.length - 1].pos = 1;
      for (let i = 1; i < raw.length - 1; i++) {
        if (raw[i].pos !== null) continue;
        let j = i;
        while (j < raw.length && raw[j].pos === null) j++;
        const lo = raw[i - 1].pos as number;
        const hi = (raw[j]?.pos as number) ?? 1;
        for (let k = i; k < j; k++) raw[k].pos = lo + ((hi - lo) * (k - i + 1)) / (j - i + 1);
      }
      // CSS clamps positions to be non-decreasing.
      let run = 0;
      return raw.map((s) => {
        run = Math.max(run, s.pos as number);
        return { color: s.color, pos: run };
      });
    };

    const axisValue = (tok: string, origin: number, extent: number): number => {
      if (tok === 'left' || tok === 'top') return origin;
      if (tok === 'right' || tok === 'bottom') return origin + extent;
      if (tok === 'center') return origin + extent / 2;
      if (tok.endsWith('%')) return origin + (parseFloat(tok) / 100) * extent;
      if (tok.endsWith('px')) return origin + parseFloat(tok);
      return origin + extent / 2;
    };

    const VERT = new Set(['top', 'bottom']);
    const HORZ = new Set(['left', 'right']);

    /**
     * Evaluate one background-image layer at a document point.
     *
     * A gradient is *sampled* at the text's real location rather than judged at
     * its worst stop: linear by projecting onto the gradient line, radial by
     * distance from the centre over the farthest-corner radius. Judging at the
     * worst stop is right only for a gradient whose worst stop spans its
     * element, which stops being true the moment a page background runs the
     * full height of a document several screens tall. A non-gradient layer
     * (`url()`, `none`) is unmeasurable and paints nothing.
     *
     * NOTHING ON THIS PAGE EXERCISES THIS TODAY, and saying so is the point of
     * writing it down: `styles.css` contains no `gradient` of any kind — every
     * surface is a flat `background-color` or a `color-mix()`, which `resolve()`
     * handles through the canvas without ever reaching here. The sampler is
     * kept because the alternative is a walk that silently mismeasures the first
     * gradient anyone adds, and because `paintAt` has to composite background
     * LAYERS regardless of whether any of them turn out to be gradients.
     */
    const sampleLayer = (layer: string, rect: DOMRect, p: Point): RGBA => {
      if (!/gradient/.test(layer)) return TRANSPARENT;
      const inner = layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')'));
      const parts = splitTopLevel(inner, ',').map((s) => s.trim());
      const radial = /radial-gradient/.test(layer);
      // The first part is configuration (angle / shape / position) exactly when
      // it holds no resolvable colour.
      const firstColour = parts[0]
        ? splitTopLevel(parts[0], ' ').some((t) => resolve(t.trim()))
        : false;
      const config = firstColour ? '' : parts[0] ?? '';
      const stops = parseStops(firstColour ? parts : parts.slice(1));
      if (!stops.length) return TRANSPARENT;

      if (radial) {
        // Centre: `... at X Y`. Default centre of the box.
        let cx = rect.left + rect.width / 2;
        let cy = rect.top + rect.height / 2;
        const at = config.split(/\s+at\s+/)[1];
        if (at) {
          const toks = at.split(/\s+/).filter(Boolean);
          const kw = toks.filter((t) => VERT.has(t) || HORZ.has(t) || t === 'center');
          const vals = toks.filter((t) => !kw.includes(t));
          for (const t of toks) {
            if (HORZ.has(t)) cx = axisValue(t, rect.left, rect.width);
            else if (VERT.has(t)) cy = axisValue(t, rect.top, rect.height);
          }
          if (vals[0]) cx = axisValue(vals[0], rect.left, rect.width);
          if (vals[1]) cy = axisValue(vals[1], rect.top, rect.height);
        }
        // Default ending shape is farthest-corner.
        const corners = [
          [rect.left, rect.top],
          [rect.right, rect.top],
          [rect.left, rect.bottom],
          [rect.right, rect.bottom],
        ];
        const radius = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)));
        const t = radius <= 0 ? 0 : Math.hypot(p.x - cx, p.y - cy) / radius;
        return colorAt(stops, clamp01(t));
      }

      // Linear. Default direction is `to bottom` (180deg).
      let angle = 180;
      if (/deg/.test(config)) angle = parseFloat(config);
      else if (/to\s+top/.test(config)) angle = 0;
      else if (/to\s+right/.test(config)) angle = 90;
      else if (/to\s+left/.test(config)) angle = 270;
      const rad = (angle * Math.PI) / 180;
      const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
      const len = Math.abs(rect.width * Math.sin(rad)) + Math.abs(rect.height * Math.cos(rad));
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const d = (p.x - cx) * dir.x + (p.y - cy) * dir.y;
      const t = len <= 0 ? 0.5 : 0.5 + d / len;
      return colorAt(stops, clamp01(t));
    };

    /**
     * The colour this element's own box paints at the text point: its
     * background-color with every background-image layer sampled and composited
     * in paint order (first-listed layer on top).
     */
    const paintAt = (cs: CSSStyleDeclaration, rect: DOMRect, p: Point): RGBA => {
      let result = resolve(cs.backgroundColor) ?? TRANSPARENT;
      const bi = cs.backgroundImage;
      if (!bi || bi === 'none') return result;
      const layers = splitTopLevel(bi, ',').map((s) => s.trim());
      // Composite bottom (last-listed) up to top (first-listed).
      for (let i = layers.length - 1; i >= 0; i--) {
        result = over(sampleLayer(layers[i], rect, p), result);
      }
      return result;
    };

    /** Do two border boxes share any painted area at all? */
    const intersects = (a: DOMRect, b: DOMRect): boolean =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) > 0 &&
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 0;

    /** Does `a` sit entirely inside `b`? */
    const contains = (outer: DOMRect, inner: DOMRect): boolean =>
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5;

    /**
     * Style and geometry are memoised per element for one pass.
     *
     * A driven pass here walks six exhibits, and the expensive parts are the
     * two 5x5 checkbox grids (the theft planner and the break-it grid, each a
     * `<td>`, a `<span>`, a `<label>` and a `<code>` per cell) and the dealing
     * matrix, which is 5 dealers x 7 columns of truncated 2048-bit values. All
     * of them are siblings re-walking the same ancestors up to `<body>`.
     * Without the caches the pass re-reads the same computed styles and rects
     * tens of thousands of times. Nothing mutates the DOM during the pass, so
     * the cached values cannot go stale.
     */
    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (el: Element): CSSStyleDeclaration => {
      let cs = styleCache.get(el);
      if (!cs) {
        cs = getComputedStyle(el);
        styleCache.set(el, cs);
      }
      return cs;
    };
    const rectCache = new Map<Element, DOMRect>();
    const rectOf = (el: Element): DOMRect => {
      let r = rectCache.get(el);
      if (!r) {
        r = el.getBoundingClientRect();
        rectCache.set(el, r);
      }
      return r;
    };

    /**
     * Every container that clips its overflow, with the box it clips to.
     *
     * An `overflow: auto` container paints only what falls inside that box.
     * Content scrolled beyond it is not dimmed or partly drawn — it is absent
     * from the frame, and asking what colour it sits on has no answer. Here
     * that is the five `.tablewrap` regions (`overflow-x: auto`) holding the
     * dealing matrix, the theft planner, the break-it grid, the small-field
     * arithmetic table and the dealing-verification table — at 380px every one
     * of them is scrolled, and the columns past the right edge paint nothing.
     * `.sr-only` is handled separately below.
     */
    const clippers = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const cs = styleOf(el);
      return /auto|scroll|hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY);
    });

    const clippedAway = (el: Element, box: DOMRect): boolean =>
      clippers.some((c) => c !== el && c.contains(el) && !intersects(box, rectOf(c)));

    /**
     * SVG has no `background-color`: shapes paint in document order, so the
     * surface under a `<text>` is whichever earlier sibling shape lies beneath
     * it. Composite those, innermost-last, before the ancestor walk starts.
     */
    const svgUnderlay = (el: Element, box: DOMRect): RGBA => {
      let bg = TRANSPARENT;
      let sib = el.previousElementSibling;
      const stack: Element[] = [];
      while (sib) {
        stack.push(sib);
        sib = sib.previousElementSibling;
      }
      // Earliest sibling first — that is the order the compositor paints in.
      // Only shapes that actually PAINT A FILL can be a backdrop. SVG's initial
      // `fill` is black, and `getComputedStyle` reports that for stroke-only
      // geometry too — so a <line> used as a grid rule or axis reads as an
      // opaque black rectangle covering whatever it crosses. Compositing that
      // invented a 3.82:1 failure elsewhere in this fleet for labels whose real
      // ratio was 6.15:1. This lab exercises that guard for real: the mechanism
      // plot draws two axes, four dashed guide `<polyline>`s, the mixed-epoch
      // chord and the two strokes of its X-mark as stroke-only geometry with no
      // `fill` set, so every one of them computes to opaque black and several
      // of them cross the value labels they sit beside.
      const FILLED = ['rect', 'circle', 'ellipse', 'polygon', 'path'];
      for (const s of stack.reverse()) {
        if (!FILLED.includes(s.tagName.toLowerCase())) continue;
        if (!contains(rectOf(s), box)) continue;
        const scs = styleOf(s);
        const fill = resolve(scs.fill);
        if (!fill) continue;
        const op = parseFloat(scs.fillOpacity || '1') * parseFloat(scs.opacity || '1');
        bg = over(fade(fill, Number.isFinite(op) ? op : 1), bg);
      }
      return bg;
    };

    /**
     * Does this element's own `clip` / `clip-path` reduce it to zero area?
     *
     * `clip: rect(t, r, b, l)` applies only to absolutely positioned boxes and
     * is what the classic `.sr-only` recipe uses; `clip-path: inset(50%)` is
     * the modern spelling of the same trick. Either one at zero area means the
     * compositor draws nothing, so there is no painted ink to measure.
     */
    const clippedToNothing = (cs: CSSStyleDeclaration): boolean => {
      const clip = cs.clip;
      if (clip && clip !== 'auto') {
        const nums = clip.match(/-?[\d.]+/g)?.map(Number);
        if (nums && nums.length === 4) {
          // Tuple-typed: under `noUncheckedIndexedAccess` a plain destructure of
          // `number[]` yields `number | undefined` for each name, which fails
          // `tsc --noEmit` in the repos whose build typechecks the e2e tree.
          const [top, right, bottom, left] = nums as [number, number, number, number];
          if (bottom - top <= 0 || right - left <= 0) return true;
        }
      }
      // `inset(50%)` (and anything >= 50% on both axes) collapses to nothing.
      const path = cs.clipPath;
      if (path && path.startsWith('inset(')) {
        const pct = path.match(/([\d.]+)%/g)?.map((v) => parseFloat(v)) ?? [];
        if (pct.length && pct.every((v) => v >= 50)) return true;
      }
      return false;
    };

    /**
     * Effective opacity: the product of this element's own `opacity` and every
     * ancestor's. Zero anywhere on that chain means the compositor lays down no
     * ink at all, and there is nothing to measure.
     *
     * This is not inherited boilerplate. `mechanism.ts` reveals the plot one
     * step at a time by writing `g.style.opacity = '0' | '1'` on three
     * `g[data-step]` groups, and at step 1 of 4 all three are at zero — about
     * thirty `<text>` nodes whose fg and bg both fade to alpha 0, both resolve
     * to the canvas colour, and every one of which would be reported as a flat
     * 1:1 failure for ink that was never drawn.
     */
    const effectiveOpacity = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const v = parseFloat(styleOf(n).opacity);
        o *= Number.isFinite(v) ? v : 1;
        if (o === 0) return 0;
      }
      return o;
    };

    const isVisible = (el: Element): boolean => {
      const cs = styleOf(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (effectiveOpacity(el) === 0) return false;
      // A closed <details> hides its body with `content-visibility: hidden`,
      // not `display: none`, and Chromium keeps the last laid-out geometry for
      // that subtree — so the `display`/rect tests above all pass for text that
      // paints nothing. `checkVisibility()` catches it. Here that is the four
      // `<details class="expert">` disclosures: the fine print in exhibit 0,
      // the full dealing matrix in exhibit 1, and the two counterfactual blocks
      // in exhibit 5. The gate opens each by clicking its `<summary>`, which is
      // the route a reader has, rather than setting `.open` from script — which
      // is what the gate this replaces did to every one of them at once, in a
      // single `page.evaluate`, immediately before its only scan.
      if ((el as HTMLElement).checkVisibility?.() === false) return false;
      const r = rectOf(el);
      if (r.width <= 0 || r.height <= 0) return false;
      // Text parked off the left/top edge of the page paints no pixels. This is
      // the WCAG-sanctioned "visually hidden until focused" idiom: the shared
      // header's `.cl-skip-link` — the page's only one — parks at `top:-3rem`
      // and slides in only on focus. Measuring the parked copy invents a failure
      // for text that is not on screen; the focused rendering is a real state
      // and the gate scans it explicitly instead.
      // Document space, NOT viewport space. `getBoundingClientRect()` is
      // relative to the viewport, so after Playwright scrolls a control into
      // view every element ABOVE the viewport has `bottom <= 0` and this guard
      // silently dropped it from the walk. On a page taller than the viewport
      // that is most of the document, and it is why a green contrast run on a
      // long page could not be trusted. Adding the scroll offset restores the
      // original intent — text parked off the top/left of the DOCUMENT, the
      // "visually hidden until focused" idiom — without hiding the page.
      if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
      // Scrolled out of an `overflow: auto` container — clipped, not painted.
      if (clippedAway(el, r)) return false;
      // Clipped to nothing by the element's own `clip` / `clip-path`. This is
      // the OTHER WCAG-sanctioned visually-hidden idiom: `position: absolute;
      // width: 1px; height: 1px; clip: rect(0 0 0 0)` paints nothing at all —
      // the box has a rect and passes `checkVisibility()`, but the compositor
      // draws zero pixels of it — and its modern spelling `clip-path:
      // inset(50%)` does the same. Measuring either reports a ratio for ink
      // that was never laid down.
      //
      // This lab uses the idiom for real, which is why the guard is here and
      // not merely inherited. `styles.css` defines `.sr-only` as
      // `position:absolute; width:1px; height:1px; clip:rect(0 0 0 0)`, and
      // six `<caption class="sr-only">` elements name the six data tables,
      // while every checkbox in the break-it grid carries a
      // `<span class="sr-only">` prefix inside its `<label>` so the label reads
      // "A, epoch 1: 0x1f3c…" to a screen reader and shows only the hex on
      // screen. Every one of those has a rect and passes `checkVisibility()`
      // while painting exactly zero pixels. It is deliberately narrow: only a
      // ZERO-AREA clip qualifies, so a partially clipped element is still
      // measured, worst case.
      if (clippedToNothing(cs)) return false;
      return true;
    };

    const ownText = (el: Element): string => {
      let t = '';
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE) t += n.textContent ?? '';
      }
      return t.trim();
    };

    const describe = (el: Element): string => {
      let s = el.tagName.toLowerCase();
      if (el.id) s += `#${el.id}`;
      const cls = el.getAttribute('class');
      if (cls) s += `.${cls.trim().split(/\s+/).join('.')}`;
      return s;
    };

    /**
     * WCAG 1.4.3 exempts text that is part of an *inactive* user-interface
     * component, and axe skips disabled controls for the same reason. Honour
     * that here so a deliberately dimmed disabled control is not reported as a
     * failure the spec does not actually require fixing.
     */
    const inactive = (el: Element): boolean => {
      let n: Element | null = el;
      while (n) {
        if ((n as HTMLInputElement).disabled === true) return true;
        if (n.getAttribute('aria-disabled') === 'true') return true;
        n = n.parentElement;
      }
      return false;
    };

    /**
     * `aria-hidden` text is removed from the accessibility tree, so axe's own
     * `color-contrast` rule skips it — and this arithmetic oracle exists to
     * catch what axe *misses* among exposed text (gradients, opacity), not to be
     * stricter than axe on decorative content. Honour the same boundary.
     *
     * The boundary cuts both ways and is a known gap: text that is
     * `aria-hidden` but still painted is skipped by BOTH oracles, so what this
     * lab hides was enumerated and measured by hand rather than assumed.
     *
     * What this lab hides is a closed set of exactly two things, and both are
     * decorative: the `✓`/`✗` glyph that opens every `.chip` (`dom.ts`'s
     * `chip()` marks it `aria-hidden` because the chip's own text already says
     * HELD, BREACH, MATCH or REJECT in words), and the ` *` footnote marker on
     * the x = 0 cell of the small-field table, whose footnote is printed in
     * full below the table. In both cases the words that carry the meaning sit
     * in the same ink on the same surface as the glyph, so measuring the text
     * measures the glyph too.
     *
     * Nothing on this page hides a VALUE. No share, no reconstruction, no
     * public key, no verdict and no verification count is inside an
     * `aria-hidden` subtree — which was checked rather than assumed, because
     * that is the shared blind spot where both oracles stop looking and it is
     * the one place a live readout can hide from a whole accessibility gate.
     */
    const ariaHidden = (el: Element): boolean => {
      let n: Element | null = el;
      while (n) {
        if (n.getAttribute('aria-hidden') === 'true') return true;
        n = n.parentElement;
      }
      return false;
    };

    /**
     * SVG renders character data only inside `<text>` / `<tspan>`. Text sitting
     * directly in a `<g>`, `<svg>` or shape element is in the DOM but paints
     * nothing, so it has no colour and no contrast requirement.
     *
     * This lab's mechanism plot is built with `createElementNS`, and its `sv()`
     * helper appends string children to whatever element it is given — `<g>`
     * and `<svg>` included. A character run appended to one of those is in the
     * DOM and paints nothing, and a walk that measured it would report a 1:1
     * failure describing ink that was never laid down.
     */
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const nonRenderingSvgText = (el: Element): boolean =>
      el.namespaceURI === SVG_NS && !['text', 'tspan'].includes(el.tagName.toLowerCase());

    /**
     * The CANVAS background — what is painted behind everything.
     *
     * The ancestor walk is geometry-aware, which is right for ordinary boxes: a
     * parent whose border box does not overlap the text paints nothing behind
     * it. Applied to the ROOT it is wrong, and wrong in the direction that
     * FABRICATES failures. CSS propagates the root element's background to the
     * canvas and paints it over the whole canvas regardless of the root's own
     * box (CSS Backgrounds 3, "The Canvas Background"); if the root's own
     * background is transparent the value is taken from `<body>` instead.
     *
     * The failure this prevents is not hypothetical — it cost a run elsewhere in
     * this fleet. A lab that sets `html, body { height: 100% }` has both boxes
     * exactly one viewport tall while the document runs several viewports long,
     * so every element below the fold intersects neither, the walk ends with a
     * transparent backdrop, and it falls through to WHITE. In a dark theme that
     * reports muted footer text against a white page that does not exist — 34 of
     * 38 findings in one run elsewhere in this fleet — and it can mask a real
     * failure in the other direction just as easily.
     *
     * Whether it is a no-op here depends on declarations that are easy to
     * change and easy to miss, which is the argument for keeping it: this page
     * runs six exhibits and many screens deep, so the day a `height: 100%`
     * appears on `html` or `body`, everything below the first screen would
     * report against a white page that does not exist — in a lab whose entire
     * palette is near-black.
     */
    const canvasBackground = ((): RGBA => {
      const rootCs = styleOf(document.documentElement);
      const rootRect = rectOf(document.documentElement);
      const rootPaint = paintAt(rootCs, rootRect, {
        x: rootRect.left + rootRect.width / 2,
        y: rootRect.top + rootRect.height / 2,
      });
      if (rootPaint.a > 0) return rootPaint;
      const body = document.body;
      if (!body) return TRANSPARENT;
      const bodyRect = rectOf(body);
      return paintAt(styleOf(body), bodyRect, {
        x: bodyRect.left + bodyRect.width / 2,
        y: bodyRect.top + bodyRect.height / 2,
      });
    })();

    const failures: unknown[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const text = ownText(el);
      if (!text) continue;
      if (!isVisible(el)) continue;
      if (inactive(el)) continue;
      if (ariaHidden(el)) continue;
      if (nonRenderingSvgText(el)) continue;

      const cs = styleOf(el);
      // SVG text takes its ink from `fill`, not `color`. Reading `color` on an
      // SVG <text>
      // measures an inherited value the glyphs are not painted in.
      const svgText = el.namespaceURI === 'http://www.w3.org/2000/svg';
      const fgRaw = resolve(svgText ? cs.fill : cs.color);
      if (!fgRaw) continue;
      // `color: transparent` lays no ink down at all; compositing a zero-alpha
      // foreground just returns the backdrop and reports a fixed 1:1.
      if (fgRaw.a === 0) continue;

      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;

      // Carry (text, adjacent background) as a pair up the ancestor chain,
      // sampling each ancestor's own background at the text point beneath both
      // and applying that ancestor's opacity to both, exactly as the compositor
      // would. The point is the text box centre.
      const textBox = rectOf(el);
      const point: Point = {
        x: (textBox.left + textBox.right) / 2,
        y: (textBox.top + textBox.bottom) / 2,
      };
      // For SVG text the first thing beneath the glyphs is a sibling shape, not
      // an ancestor's background — see the header note on the SVG figures.
      let fg = fgRaw;
      let bg = svgText ? svgUnderlay(el, textBox) : TRANSPARENT;
      let node: Element | null = el;
      while (node) {
        const ncs = styleOf(node);
        const opacity = parseFloat(ncs.opacity);
        // An ancestor that does not overlap the text paints nothing behind it.
        const paint =
          node === el || intersects(textBox, rectOf(node))
            ? paintAt(ncs, rectOf(node), point)
            : TRANSPARENT;
        fg = fade(over(fg, paint), opacity);
        bg = fade(over(bg, paint), opacity);
        // Stop once the accumulated backdrop is fully opaque: nothing further
        // out can change the painted result.
        if (bg.a >= 1) break;
        node = node.parentElement;
      }

      const fgFinal = over(over(fg, canvasBackground), WHITE);
      const bgFinal = over(over(bg, canvasBackground), WHITE);
      const worst = { r: ratio(fgFinal, bgFinal), fg: fgFinal, bg: bgFinal };

      // Round to 2dp before comparing so a value that is exactly on the floor
      // (e.g. 4.50) is not failed by float noise, and one just under it is not
      // rounded up into a pass.
      const rounded = Math.round(worst.r * 100) / 100;
      if (rounded >= required) continue;

      const show = (c: RGBA): string =>
        `rgb(${[c.r, c.g, c.b].map((v) => Math.round(v)).join(', ')})`;

      failures.push({
        selector: describe(el),
        text: text.slice(0, 60),
        foreground: show(worst.fg),
        background: show(worst.bg),
        fontSize: size,
        fontWeight: weight,
        required,
        ratio: rounded,
      });
    }
    return failures as never;
  });
}

/** Render failures as short strings so an assertion diff is readable. */
export function formatContrastFailures(failures: ContrastFailure[]): string[] {
  return failures.map(
    (f) =>
      `${f.ratio}:1 (needs ${f.required}:1) ${f.selector} — fg ${f.foreground} on ${f.background} — "${f.text}"`
  );
}
