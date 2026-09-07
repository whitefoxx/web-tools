/**
 * The in-page half of a region screenshot: an overlay the user drags a
 * rectangle on, then annotates (rect / ellipse / arrow / pen / text / mosaic).
 * Resolves the rectangle in CSS px + devicePixelRatio and the annotation layer
 * as a transparent PNG; WHO captures the tab and composites is the caller's
 * business — the SidePanel does it with a DOM canvas, localmd Connect's service
 * worker with an OffscreenCanvas — which is why this lives on its own.
 *
 * The injected function is serialized via toString — it must be self-contained
 * (no outer references) and must NEVER use CSS custom properties (var(--x)),
 * which would inherit the host page's values. Moved here verbatim from
 * src/sidepanel/region-capture.ts; the SidePanel imports it back.
 */

export interface CaptureResult {
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
  /** Transparent PNG of the annotation layer (w*dpr × h*dpr), or '' if none. */
  annotation: string;
  /** Download the composited PNG instead of attaching it to the composer. */
  download?: boolean;
}

/* Injected into the page. Self-contained. Resolves a CaptureResult, or null. */
export function selectAndAnnotateInPage(): Promise<CaptureResult | null> {
  return new Promise<CaptureResult | null>((resolve) => {
    const DPR = window.devicePixelRatio || 1;
    const Z = 2147483647;
    const COLORS = ['#e5484d', '#ffb224', '#30a46c', '#0091ff', '#111111'];
    const ACCENT = '#f5a623'; // literal — never var(--accent) (inherits host page)
    const SELECT = '#3b82f6'; // selection-outline blue
    // Consistent line-icons (uniform 17px / 1.9 stroke) for the annotation bar.
    const ICON = (inner: string): string =>
      `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

    // Self-heal: drop any overlay left by a previous (interrupted) run so
    // re-clicking the capture button never stacks dimming layers.
    document.getElementById('__wc_capture__')?.remove();
    const root = document.createElement('div');
    root.id = '__wc_capture__';
    root.style.cssText = `position:fixed;inset:0;z-index:${Z};`;
    const catcher = document.createElement('div');
    // Faint full-page tint from the start, so it's obvious the page is in capture
    // mode (the selection box's box-shadow adds the stronger focus dim).
    catcher.style.cssText = 'position:fixed;inset:0;cursor:crosshair;background:rgba(0,0,0,0.12);';
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;display:none;border:1.5px solid ${ACCENT};box-shadow:0 0 0 9999px rgba(0,0,0,0.6);pointer-events:none;`;
    const label = document.createElement('div');
    label.style.cssText =
      'position:fixed;display:none;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:5px;pointer-events:none;';
    root.append(catcher, box, label);
    document.documentElement.appendChild(root);

    let sx = 0;
    let sy = 0;
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    let stage: 'select' | 'annotate' = 'select';
    let typingText = false; // a text-annotation box is focused

    const setBox = (x: number, y: number, w: number, h: number): void => {
      rect = { x, y, w, h };
      box.style.display = 'block';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      label.style.display = 'block';
      label.style.left = `${x}px`;
      label.style.top = `${Math.max(2, y - 22)}px`;
      label.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    };

    const cleanup = (): void => {
      root.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    function onKey(e: KeyboardEvent): void {
      if (typingText) return; // a text box is focused; let it handle its own keys
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      } else if (
        stage === 'annotate' &&
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selected
      ) {
        e.preventDefault();
        const i = shapes.indexOf(selected);
        if (i >= 0) shapes.splice(i, 1);
        selected = null;
        redraw();
      }
    }
    window.addEventListener('keydown', onKey, true);

    // ── select stage ──
    catcher.addEventListener('mousedown', (e) => {
      if (stage !== 'select') return;
      sx = e.clientX;
      sy = e.clientY;
      setBox(sx, sy, 0, 0);
    });
    catcher.addEventListener('mousemove', (e) => {
      if (stage !== 'select' || (e.buttons & 1) === 0) return;
      setBox(
        Math.min(sx, e.clientX),
        Math.min(sy, e.clientY),
        Math.abs(e.clientX - sx),
        Math.abs(e.clientY - sy),
      );
    });
    catcher.addEventListener('mouseup', () => {
      if (stage !== 'select') return;
      if (rect.w < 4 || rect.h < 4) {
        cleanup();
        resolve(null);
        return;
      }
      enterAnnotate();
    });

    // ── annotate stage ──
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D;
    type Shape = {
      tool: string;
      color: string;
      pts: Array<{ x: number; y: number }>;
      text?: string;
      fontSize?: number;
    };
    let tool: 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic' = 'rect';
    let color = COLORS[0];
    let fontSize = 24;
    const shapes: Shape[] = [];
    let drawing: Shape | null = null;
    let selected: Shape | null = null;
    let moving: { lastX: number; lastY: number } | null = null;
    let resizing:
      | { kind: 'corner'; anchor: { x: number; y: number } }
      | { kind: 'endpoint'; idx: number }
      | null = null;

    const lineHeight = (fpx: number): number => fpx * 1.25;

    /** Axis-aligned bounding box of a shape (canvas px). */
    function bboxOf(s: Shape): { x: number; y: number; w: number; h: number } {
      if (s.tool === 'text') {
        const fpx = (s.fontSize ?? 24) * DPR;
        ctx.font = `600 ${fpx}px system-ui, -apple-system, sans-serif`;
        const lines = (s.text ?? '').split('\n');
        const w = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
        return { x: s.pts[0].x, y: s.pts[0].y, w, h: lines.length * lineHeight(fpx) };
      }
      const xs = s.pts.map((p) => p.x);
      const ys = s.pts.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    function distToSeg(
      p: { x: number; y: number },
      a: { x: number; y: number },
      b: { x: number; y: number },
    ): number {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }
    /** Topmost shape under a point, or null. Outlined shapes (arrow/pen) hit near
     * the stroke; filled/box shapes hit inside their bbox. */
    function hitTest(p: { x: number; y: number }): Shape | null {
      const tol = 8 * DPR;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        if (s.tool === 'pen') {
          if (s.pts.length === 1) {
            if (Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= tol) return s;
          } else {
            for (let j = 1; j < s.pts.length; j++)
              if (distToSeg(p, s.pts[j - 1], s.pts[j]) <= tol) return s;
          }
        } else if (s.tool === 'arrow') {
          if (s.pts.length >= 2 && distToSeg(p, s.pts[0], s.pts[1]) <= tol) return s;
        } else {
          const b = bboxOf(s);
          if (
            p.x >= b.x - tol &&
            p.x <= b.x + b.w + tol &&
            p.y >= b.y - tol &&
            p.y <= b.y + b.h + tol
          )
            return s;
        }
      }
      return null;
    }
    /** Drag handles for the selected shape: bbox corners for rect/ellipse/mosaic,
     * endpoints for arrow. Text/pen have none (move-only). */
    function handlesOf(s: Shape): Array<{ x: number; y: number; cursor: string; kind: string }> {
      if (s.tool === 'arrow' && s.pts.length >= 2) {
        return [
          { x: s.pts[0].x, y: s.pts[0].y, cursor: 'move', kind: 'pt0' },
          { x: s.pts[1].x, y: s.pts[1].y, cursor: 'move', kind: 'pt1' },
        ];
      }
      if (s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'mosaic') {
        const b = bboxOf(s);
        return [
          { x: b.x, y: b.y, cursor: 'nwse-resize', kind: 'nw' },
          { x: b.x + b.w, y: b.y, cursor: 'nesw-resize', kind: 'ne' },
          { x: b.x + b.w, y: b.y + b.h, cursor: 'nwse-resize', kind: 'se' },
          { x: b.x, y: b.y + b.h, cursor: 'nesw-resize', kind: 'sw' },
        ];
      }
      return [];
    }

    function redraw(): void {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const all = drawing ? [...shapes, drawing] : shapes;
      for (const s of all) {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = 3 * DPR;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const p = s.pts;
        if (s.tool === 'pen') {
          ctx.beginPath();
          p.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
          ctx.stroke();
        } else if (s.tool === 'text') {
          if (s.text) {
            const fpx = (s.fontSize ?? 24) * DPR;
            ctx.font = `600 ${fpx}px system-ui, -apple-system, sans-serif`;
            ctx.textBaseline = 'top';
            s.text
              .split('\n')
              .forEach((line, i) => ctx.fillText(line, p[0].x, p[0].y + i * lineHeight(fpx)));
          }
        } else if (p.length >= 2) {
          const a = p[0];
          const b = p[p.length - 1];
          if (s.tool === 'rect') {
            ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
          } else if (s.tool === 'mosaic') {
            // Opaque black redaction — fully hides the content (no transparency).
            ctx.fillStyle = '#000';
            ctx.fillRect(
              Math.min(a.x, b.x),
              Math.min(a.y, b.y),
              Math.abs(b.x - a.x),
              Math.abs(b.y - a.y),
            );
          } else if (s.tool === 'ellipse') {
            ctx.beginPath();
            ctx.ellipse(
              (a.x + b.x) / 2,
              (a.y + b.y) / 2,
              Math.abs(b.x - a.x) / 2,
              Math.abs(b.y - a.y) / 2,
              0,
              0,
              Math.PI * 2,
            );
            ctx.stroke();
          } else if (s.tool === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const hl = 12 * DPR;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x - hl * Math.cos(ang - 0.4), b.y - hl * Math.sin(ang - 0.4));
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x - hl * Math.cos(ang + 0.4), b.y - hl * Math.sin(ang + 0.4));
            ctx.stroke();
          }
        }
      }
      // Selection outline + drag handles (NOT saved — finishCapture clears first).
      if (selected && shapes.includes(selected)) {
        const b = bboxOf(selected);
        const m = 4 * DPR;
        ctx.save();
        ctx.strokeStyle = SELECT;
        ctx.lineWidth = 1.5 * DPR;
        ctx.setLineDash([6 * DPR, 4 * DPR]);
        ctx.strokeRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
        ctx.setLineDash([]);
        for (const h of handlesOf(selected)) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 5 * DPR, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = SELECT;
          ctx.lineWidth = 1.5 * DPR;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    function btn(labelHtml: string, title: string, onClick: () => void): HTMLButtonElement {
      const b = document.createElement('button');
      b.innerHTML = labelHtml;
      b.title = title;
      b.style.cssText =
        'width:30px;height:30px;border:none;background:transparent;border-radius:8px;cursor:pointer;font:15px system-ui;color:#222;display:inline-flex;align-items:center;justify-content:center;';
      b.addEventListener('mouseenter', () => (b.style.background = 'rgba(0,0,0,.07)'));
      b.addEventListener('mouseleave', () => (b.style.background = 'transparent'));
      b.addEventListener('click', (e) => {
        e.preventDefault();
        onClick();
      });
      return b;
    }

    /** Drop a contenteditable box at a canvas point — auto-grows with the text
     * (shrink-to-fit) and supports newlines (Enter). Commit on blur, drop on Esc.
     * Pre-fills `initial` (for re-editing an existing text shape). */
    function placeText(
      pt: { x: number; y: number },
      initial: string,
      fs: number,
      col: string,
    ): void {
      const clientX = pt.x / DPR + rect.x;
      const clientY = pt.y / DPR + rect.y;
      const input = document.createElement('div');
      input.contentEditable = 'true';
      input.textContent = initial;
      input.style.cssText = `position:fixed;left:${clientX}px;top:${Math.max(2, clientY - 2)}px;z-index:${Z};min-width:8px;font:600 ${fs}px system-ui,sans-serif;color:${col};background:rgba(255,255,255,.96);border:1px solid ${col};border-radius:5px;padding:1px 6px;outline:none;white-space:pre;line-height:1.25;`;
      root.appendChild(input);
      let settled = false;
      const finish = (commit: boolean): void => {
        if (settled) return;
        settled = true;
        typingText = false;
        const t = input.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '');
        input.remove();
        if (commit && t.trim()) {
          const s: Shape = { tool: 'text', color: col, pts: [pt], text: t, fontSize: fs };
          shapes.push(s);
          selected = s;
          redraw();
        }
      };
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(false);
        }
        // Enter falls through → contenteditable inserts a newline (multi-line).
      });
      // Defer focus + blur-binding past the click's own focus handling — focusing
      // synchronously gets immediately blurred (committing empty), which is why
      // typing never worked. (Clicking to place a second box blurs+commits the first.)
      requestAnimationFrame(() => {
        typingText = true;
        input.focus();
        const r = document.createRange();
        r.selectNodeContents(input);
        r.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        input.addEventListener('blur', () => finish(true));
      });
    }

    function enterAnnotate(): void {
      stage = 'annotate';
      catcher.style.cursor = 'default';
      // Drop the yellow selection ring now the region is fixed: the annotation
      // canvas sits exactly over it and the box's dark spotlight (its box-shadow,
      // kept) already shows the edge. Leaving the border on drew a second, yellow
      // outline around the canvas during annotation ("an extra yellow border").
      // transparent, not `none`, so the 1.5px border box — and thus the spotlight
      // hole — keeps its exact size.
      box.style.borderColor = 'transparent';
      const cw = Math.max(1, Math.round(rect.w * DPR));
      const ch = Math.max(1, Math.round(rect.h * DPR));
      canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;cursor:crosshair;`;
      ctx = canvas.getContext('2d')!;
      root.appendChild(canvas);

      const toPt = (e: MouseEvent): { x: number; y: number } => ({
        x: (e.clientX - rect.x) * DPR,
        y: (e.clientY - rect.y) * DPR,
      });

      canvas.addEventListener('pointerdown', (e) => {
        const p = toPt(e);
        // 1) A resize handle of the selected shape?
        if (selected && shapes.includes(selected)) {
          const h = handlesOf(selected).find((hh) => Math.hypot(p.x - hh.x, p.y - hh.y) <= 9 * DPR);
          if (h) {
            canvas.setPointerCapture(e.pointerId);
            if (h.kind === 'pt0' || h.kind === 'pt1') {
              resizing = { kind: 'endpoint', idx: h.kind === 'pt0' ? 0 : 1 };
            } else {
              const b = bboxOf(selected);
              const anchor =
                h.kind === 'nw'
                  ? { x: b.x + b.w, y: b.y + b.h }
                  : h.kind === 'ne'
                    ? { x: b.x, y: b.y + b.h }
                    : h.kind === 'se'
                      ? { x: b.x, y: b.y }
                      : { x: b.x + b.w, y: b.y }; // sw
              resizing = { kind: 'corner', anchor };
            }
            canvas.style.cursor = h.cursor;
            return;
          }
        }
        // 2) An existing annotation → select + start moving it.
        const hit = hitTest(p);
        if (hit) {
          selected = hit;
          moving = { lastX: p.x, lastY: p.y };
          canvas.setPointerCapture(e.pointerId);
          canvas.style.cursor = 'move';
          redraw();
          return;
        }
        // 3) Empty space → deselect, then draw / place text with the current tool.
        selected = null;
        if (tool === 'text') {
          placeText(p, '', fontSize, color);
          redraw();
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        drawing = { tool, color, pts: [p] };
        redraw();
      });
      canvas.addEventListener('pointermove', (e) => {
        const p = toPt(e);
        if (resizing && selected) {
          if (resizing.kind === 'corner') selected.pts = [resizing.anchor, p];
          else selected.pts[resizing.idx] = p;
          redraw();
          return;
        }
        if (moving && selected) {
          const dx = p.x - moving.lastX;
          const dy = p.y - moving.lastY;
          selected.pts = selected.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
          moving.lastX = p.x;
          moving.lastY = p.y;
          redraw();
          return;
        }
        if (drawing) {
          if (drawing.tool === 'pen') drawing.pts.push(p);
          else drawing.pts[1] = p;
          redraw();
          return;
        }
        // Idle → cursor feedback: resize over a handle, move over a shape, else draw.
        let cur = tool === 'text' ? 'text' : 'crosshair';
        if (selected && shapes.includes(selected)) {
          const h = handlesOf(selected).find((hh) => Math.hypot(p.x - hh.x, p.y - hh.y) <= 9 * DPR);
          if (h) cur = h.cursor;
          else if (hitTest(p)) cur = 'move';
        } else if (hitTest(p)) {
          cur = 'move';
        }
        canvas.style.cursor = cur;
      });
      canvas.addEventListener('pointerup', () => {
        if (resizing) {
          resizing = null;
          return;
        }
        if (moving) {
          moving = null;
          return;
        }
        if (drawing) {
          // Drop a zero-drag click for non-pen tools (no accidental empty shapes).
          if (drawing.tool !== 'pen' && drawing.pts.length < 2) {
            drawing = null;
            redraw();
            return;
          }
          shapes.push(drawing);
          selected = drawing;
          drawing = null;
          redraw();
        }
      });
      // Double-click a text annotation → re-edit it in place.
      canvas.addEventListener('dblclick', (e) => {
        const p = toPt(e);
        const hit = hitTest(p);
        if (hit && hit.tool === 'text') {
          const i = shapes.indexOf(hit);
          if (i >= 0) shapes.splice(i, 1);
          selected = null;
          redraw();
          placeText(hit.pts[0], hit.text ?? '', hit.fontSize ?? fontSize, hit.color);
        }
      });

      // Finish: Done attaches to the composer; Download saves a PNG.
      function finishCapture(download: boolean): void {
        selected = null;
        drawing = null;
        redraw();
        const annotation = shapes.length ? canvas.toDataURL('image/png') : '';
        cleanup();
        resolve({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, dpr: DPR, annotation, download });
      }

      const sep = (): HTMLElement => {
        const s = document.createElement('div');
        s.style.cssText = 'width:1px;height:18px;background:rgba(0,0,0,.12);margin:0 4px;';
        return s;
      };

      // Toolbar below the selection (above if no room): two stacked pills —
      // row 1 = tools + actions; row 2 = font size (text only) + colors.
      const barWrap = document.createElement('div');
      const barTop = rect.y + rect.h + 8;
      barWrap.style.cssText = `position:fixed;left:${rect.x}px;top:${barTop}px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;`;
      const card = (): HTMLDivElement => {
        const d = document.createElement('div');
        d.style.cssText =
          'display:flex;align-items:center;gap:2px;background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:5px 8px;';
        return d;
      };
      const bar = card();
      const bar2 = card();

      // Row 2 (built first so the tool buttons can toggle the size selector).
      const sizeWrap = document.createElement('div');
      sizeWrap.style.cssText = `display:${tool === 'text' ? 'flex' : 'none'};align-items:center;`;
      const sizeSel = document.createElement('select');
      sizeSel.style.cssText =
        'font:13px system-ui;color:#222;border:1px solid rgba(0,0,0,.15);border-radius:7px;padding:3px 6px;background:#fff;cursor:pointer;outline:none;';
      [14, 18, 24, 32, 48, 64].forEach((s) => {
        const o = document.createElement('option');
        o.value = String(s);
        o.textContent = String(s);
        if (s === fontSize) o.selected = true;
        sizeSel.appendChild(o);
      });
      sizeSel.addEventListener('change', () => {
        fontSize = parseInt(sizeSel.value, 10) || 24;
        // Editing: resize the selected text annotation too.
        if (selected && selected.tool === 'text') {
          selected.fontSize = fontSize;
          redraw();
        }
      });
      sizeWrap.append(sizeSel, sep());
      bar2.appendChild(sizeWrap);
      // Selected color is marked by an underline bar (not an outer ring).
      const swatchUnderlines: HTMLElement[] = [];
      COLORS.forEach((c) => {
        const d = document.createElement('button');
        d.title = c;
        d.style.cssText =
          'display:flex;flex-direction:column;align-items:center;gap:3px;border:none;background:transparent;cursor:pointer;padding:1px;margin:0 1px;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:16px;height:16px;border-radius:50%;background:${c};`;
        const underline = document.createElement('span');
        underline.style.cssText = `width:14px;height:2px;border-radius:1px;background:${c === color ? '#222' : 'transparent'};transition:background .12s;`;
        swatchUnderlines.push(underline);
        d.append(dot, underline);
        d.addEventListener('click', (e) => {
          e.preventDefault();
          color = c;
          swatchUnderlines.forEach((u) => (u.style.background = 'transparent'));
          underline.style.background = '#222';
          // Editing: recolor the selected annotation too.
          if (selected) {
            selected.color = c;
            redraw();
          }
        });
        bar2.appendChild(d);
      });

      // Row 1: tools + actions.
      const tools: Array<[typeof tool, string, string]> = [
        ['rect', ICON('<rect x="4.5" y="5" width="15" height="14" rx="2"/>'), 'Rectangle'],
        ['ellipse', ICON('<circle cx="12" cy="12" r="7"/>'), 'Ellipse'],
        ['arrow', ICON('<path d="M7 17L17 7M8 7h9v9"/>'), 'Arrow'],
        ['pen', ICON('<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'), 'Pen'],
        ['text', ICON('<path d="M5 7V5h14v2M12 5v14M9 19h6"/>'), 'Text'],
        [
          'mosaic',
          ICON(
            '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="currentColor"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" fill="currentColor"/>',
          ),
          'Mosaic (black-bar redaction)',
        ],
      ];
      const toolBtns: HTMLButtonElement[] = [];
      const markActive = (b: HTMLButtonElement, on: boolean): void => {
        // Inset ring (literal color) — survives the hover background and never
        // inherits the host page's --accent.
        b.style.boxShadow = on ? `inset 0 0 0 2px ${ACCENT}` : 'none';
      };
      tools.forEach(([t, glyph, title]) => {
        const b = btn(glyph, title, () => {
          tool = t;
          toolBtns.forEach((x) => markActive(x, false));
          markActive(b, true);
          sizeWrap.style.display = t === 'text' ? 'flex' : 'none';
        });
        markActive(b, t === tool);
        toolBtns.push(b);
        bar.appendChild(b);
      });
      bar.appendChild(sep());
      bar.appendChild(
        btn(ICON('<path d="M9 14L4 9l5-5M4 9h11a4 4 0 0 1 4 4v1"/>'), 'Undo', () => {
          shapes.pop();
          selected = null;
          redraw();
        }),
      );
      bar.appendChild(
        btn(
          ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
          'Download screenshot',
          () => finishCapture(true),
        ),
      );
      bar.appendChild(
        btn(ICON('<path d="M18 6L6 18M6 6l12 12"/>'), 'Cancel', () => {
          cleanup();
          resolve(null);
        }),
      );
      const done = btn(ICON('<path d="M20 6L9 17l-5-5"/>'), 'Done', () => finishCapture(false));
      done.style.color = '#34d399';
      bar.appendChild(done);

      barWrap.append(bar, bar2);
      root.appendChild(barWrap);
      // Keep the toolbar on-screen.
      requestAnimationFrame(() => {
        const r = barWrap.getBoundingClientRect();
        if (r.bottom > window.innerHeight)
          barWrap.style.top = `${Math.max(8, rect.y - r.height - 8)}px`;
        if (r.right > window.innerWidth)
          barWrap.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
      });
    }
  });
}
