// TIER 3 — dynamic surface inventory. OWNED by Lane SURFACES.
// Enumerates canvas/video/audio/iframe/animated-svg/webgl surfaces a flat PNG would
// reduce to a blank box, with a rendered thumbnail (canvas toDataURL / video poster),
// a charting-library sniff, and a web-component (custom element) inventory — so the
// rebuild knows "this box is an echarts chart" instead of an empty element.
import { promises as fs } from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import type { Surface, SurfacesReport } from '../types';

/** Bounds so a pathological page can't blow up time/memory. */
const MAX_SURFACES = 60;
/** Cap on how many canvas snapshots we actually decode + write to disk. */
const MAX_THUMBS = 24;
/** Skip absurd data URLs (very large canvases) so the sidecar stays small. */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

/**
 * Raw surface record produced in-page. `dataUrl` (canvas snapshot) is decoded and
 * written to disk by the Node side; everything else is plain JSON.
 */
interface RawSurface {
  kind: Surface['kind'];
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src?: string;
  poster?: string;
  contextType?: string;
  chartLib?: string;
  crossOrigin?: boolean;
  /** Canvas-only: PNG data URL captured via toDataURL(); decoded Node-side. */
  dataUrl?: string;
}

interface RawScan {
  surfaces: RawSurface[];
  webComponents: string[];
}

/**
 * Inventory dynamic surfaces on the page, writing any thumbnails under `absDir`
 * (returned paths are relative to the bundle mode dir via `relBase`).
 */
export async function captureSurfaces(
  page: Page,
  pageLabel: string,
  pageUrl: string,
  opts: { absDir: string; relBase: string },
): Promise<SurfacesReport> {
  let scan: RawScan | null = null;
  try {
    scan = await page.evaluate(
      ({ maxSurfaces, maxThumbs }) => {
        const out: RawSurface[] = [];
        const webComponents: string[] = [];

        // ── helpers (inlined — must not import another lane's file) ──────────
        const cssEsc = (s: string): string => {
          try {
            return (window as unknown as { CSS?: { escape(v: string): string } }).CSS
              ? CSS.escape(s)
              : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
          } catch {
            return s;
          }
        };
        const tag = (el: Element): string => el.tagName.toLowerCase();
        const round = (n: number): number => Math.round(n * 10) / 10;

        // A reasonably-stable selector: #id, or tag.firstClass when unique-ish,
        // else an nth-of-type fallback. Bounded — never throws.
        const selectorFor = (el: Element): string => {
          const id = el.getAttribute('id');
          if (id && /^[A-Za-z][\w-]*$/.test(id)) {
            try {
              if (document.querySelectorAll('#' + cssEsc(id)).length === 1) return '#' + cssEsc(id);
            } catch {
              /* ignore */
            }
          }
          const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
          if (cls) {
            const sel = `${tag(el)}.${cssEsc(cls)}`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch {
              /* ignore */
            }
          }
          // nth-of-type within parent
          const parent = el.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
            const idx = same.indexOf(el);
            if (idx >= 0) {
              const parentSel = parent.id && /^[A-Za-z][\w-]*$/.test(parent.id)
                ? '#' + cssEsc(parent.id)
                : tag(parent);
              return `${parentSel} > ${tag(el)}:nth-of-type(${idx + 1})`;
            }
          }
          return tag(el);
        };

        const rectOf = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return {
            x: round(r.left + window.scrollX),
            y: round(r.top + window.scrollY),
            width: round(r.width),
            height: round(r.height),
          };
        };

        const absUrl = (raw: string | null): string | undefined => {
          if (!raw) return undefined;
          try {
            return new URL(raw, location.href).href;
          } catch {
            return raw;
          }
        };

        const isCrossOrigin = (urlStr: string | undefined): boolean => {
          if (!urlStr) return false;
          try {
            return new URL(urlStr, location.href).origin !== location.origin;
          } catch {
            return false;
          }
        };

        // ── charting-library sniff (set once per page) ───────────────────────
        const w = window as unknown as Record<string, unknown>;
        let chartLib: string | undefined;
        if (w.Chart) chartLib = 'chart.js';
        else if (w.echarts) chartLib = 'echarts';
        else if (w.Highcharts) chartLib = 'highcharts';
        else if (w.Plotly) chartLib = 'plotly';
        else if (w.d3) chartLib = 'd3';

        let thumbBudget = maxThumbs;

        // ── 1. <canvas> ──────────────────────────────────────────────────────
        const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, maxSurfaces);
        for (const el of canvases) {
          if (out.length >= maxSurfaces) break;
          const c = el as HTMLCanvasElement;
          const rect = rectOf(c);
          if (rect.width <= 0 || rect.height <= 0) continue;

          // Probe the context type WITHOUT clobbering an existing one: getContext
          // returns the already-bound context if the canvas has one, and null if
          // it would conflict — so this is a read-only probe in practice.
          let contextType: string | undefined;
          let isWebgl = false;
          try {
            if (c.getContext('webgl2') || c.getContext('webgl') ||
                (c.getContext('experimental-webgl' as '2d') as unknown)) {
              contextType = 'webgl';
              isWebgl = true;
            } else if (c.getContext('2d')) {
              contextType = '2d';
            }
          } catch {
            /* probing can throw in locked-down canvases */
          }

          const surface: RawSurface = {
            kind: isWebgl ? 'webgl' : 'canvas',
            selector: selectorFor(c),
            ...rect,
            contextType,
          };
          if (chartLib) surface.chartLib = chartLib;

          // Snapshot via toDataURL — tainted (cross-origin) canvases throw; skip.
          if (thumbBudget > 0) {
            try {
              const url = c.toDataURL('image/png');
              if (url && url.startsWith('data:image/png') && url.length < 3_000_000) {
                surface.dataUrl = url;
                thumbBudget--;
              }
            } catch {
              /* tainted canvas — no thumbnail */
            }
          }
          out.push(surface);
        }

        // ── 2. <video> / <audio> ─────────────────────────────────────────────
        const media = Array.from(document.querySelectorAll('video, audio')).slice(0, maxSurfaces);
        for (const el of media) {
          if (out.length >= maxSurfaces) break;
          const m = el as HTMLMediaElement;
          const rect = rectOf(m);
          // <source> child fallback for src
          let src = absUrl(m.getAttribute('src'));
          if (!src) {
            const source = m.querySelector('source[src]');
            if (source) src = absUrl(source.getAttribute('src'));
          }
          const isVideo = tag(m) === 'video';
          const poster = isVideo ? absUrl(m.getAttribute('poster')) : undefined;
          const s: RawSurface = {
            kind: isVideo ? 'video' : 'audio',
            selector: selectorFor(m),
            ...rect,
          };
          if (src) {
            s.src = src;
            s.crossOrigin = isCrossOrigin(src);
          }
          if (poster) s.poster = poster;
          out.push(s);
        }

        // ── 3. animated <svg> ────────────────────────────────────────────────
        const svgs = Array.from(document.querySelectorAll('svg')).slice(0, maxSurfaces);
        for (const el of svgs) {
          if (out.length >= maxSurfaces) break;
          let animated = false;
          try {
            // SMIL animation elements.
            if (el.querySelector('animate, animateTransform, animateMotion, set')) {
              animated = true;
            } else {
              // CSS-animated descendants (or the svg itself).
              const candidates = [el, ...Array.from(el.querySelectorAll('*'))].slice(0, 80);
              for (const node of candidates) {
                const st = window.getComputedStyle(node as Element);
                const name = st.animationName;
                if (name && name !== 'none') {
                  animated = true;
                  break;
                }
              }
            }
          } catch {
            /* ignore */
          }
          if (!animated) continue;
          const rect = rectOf(el);
          if (rect.width <= 0 || rect.height <= 0) continue;
          out.push({ kind: 'svg-animated', selector: selectorFor(el), ...rect });
        }

        // ── 4. <iframe> ──────────────────────────────────────────────────────
        const frames = Array.from(document.querySelectorAll('iframe')).slice(0, maxSurfaces);
        for (const el of frames) {
          if (out.length >= maxSurfaces) break;
          const f = el as HTMLIFrameElement;
          const rect = rectOf(f);
          if (rect.width <= 0 || rect.height <= 0) continue;
          const src = absUrl(f.getAttribute('src'));
          const cross = isCrossOrigin(src);
          const s: RawSurface = {
            kind: 'iframe',
            selector: selectorFor(f),
            ...rect,
            crossOrigin: cross,
          };
          if (src) s.src = src;
          out.push(s);
        }

        // ── 5. custom-element (web component) inventory ──────────────────────
        try {
          const ce = (window as unknown as { customElements?: CustomElementRegistry }).customElements;
          if (ce && typeof ce.get === 'function') {
            const seen = new Set<string>();
            const all = document.querySelectorAll('*');
            const lim = Math.min(all.length, 8000);
            for (let i = 0; i < lim; i++) {
              const t = all[i].tagName.toLowerCase();
              if (t.indexOf('-') === -1 || seen.has(t)) continue;
              try {
                if (ce.get(t)) {
                  seen.add(t);
                  if (webComponents.length < 100) webComponents.push(t);
                }
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }

        return { surfaces: out, webComponents };
      },
      { maxSurfaces: MAX_SURFACES, maxThumbs: MAX_THUMBS },
    );
  } catch {
    scan = null;
  }

  if (!scan) {
    return { page: pageLabel, pageUrl, surfaces: [], webComponents: [] };
  }

  // Decode canvas data URLs to PNG files; strip the data URL from the report.
  const surfaces: Surface[] = [];
  let dirReady = false;
  let thumbIdx = 0;
  for (const raw of scan.surfaces) {
    const { dataUrl, ...rest } = raw;
    const surface: Surface = { ...rest };
    if (dataUrl) {
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      let buf: Buffer | null = null;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        buf = null;
      }
      if (buf && buf.length > 0 && buf.length <= MAX_THUMB_BYTES) {
        try {
          if (!dirReady) {
            await fs.mkdir(opts.absDir, { recursive: true });
            dirReady = true;
          }
          const fname = `canvas-${thumbIdx++}.png`;
          await fs.writeFile(path.join(opts.absDir, fname), buf);
          surface.thumbnail = `${opts.relBase}/${fname}`;
        } catch {
          /* best-effort: a write failure just means no thumbnail */
        }
      }
    }
    surfaces.push(surface);
  }

  return {
    page: pageLabel,
    pageUrl,
    surfaces,
    webComponents: scan.webComponents,
  };
}
