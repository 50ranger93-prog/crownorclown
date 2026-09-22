/**
 * Art treatments for the card lab.
 *
 * Everything here is arithmetic on pixels — no model, no service, no upload. The
 * image is decoded into a canvas, pushed through a filter, and handed back as a
 * data URI. It runs in a few hundred milliseconds on a phone and the picture
 * never leaves the browser.
 *
 * These are photo filters, not illustration. "Cartoon" means flattened colour
 * with drawn edges, which is what every toon shader has ever meant; it does not
 * mean somebody redrew the photo by hand.
 */
window.TREAT = (() => {
  const MAX = 1100;                       // plenty for a card, cheap to process
  const L = (r, g, b) => 0.299*r + 0.587*g + 0.114*b;
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;

  /* A separable box blur, run a few times — three passes of a box is close
     enough to a gaussian that nobody can tell, and it is O(n) per pass. */
  function blur(px, w, h, r, passes = 2) {
    if (r < 1) return px;
    const tmp = new Uint8ClampedArray(px.length);
    for (let p = 0; p < passes; p++) {
      for (const [src, dst, horiz] of [[px, tmp, true], [tmp, px, false]]) {
        const outer = horiz ? h : w, inner = horiz ? w : h;
        for (let o = 0; o < outer; o++) {
          for (let c = 0; c < 4; c++) {
            if (c === 3) continue;
            let sum = 0, n = 0;
            for (let i = -r; i <= r; i++) { const k = Math.min(inner-1, Math.max(0, i)); sum += src[idx(horiz,o,k,w)*4+c]; n++; }
            for (let i = 0; i < inner; i++) {
              dst[idx(horiz,o,i,w)*4+c] = sum / n;
              const add = Math.min(inner-1, i+r+1), sub = Math.max(0, i-r);
              sum += src[idx(horiz,o,add,w)*4+c] - src[idx(horiz,o,sub,w)*4+c];
            }
          }
          for (let i = 0; i < inner; i++) dst[idx(horiz,o,i,w)*4+3] = src[idx(horiz,o,i,w)*4+3];
        }
      }
    }
    return px;
  }
  const idx = (horiz, o, i, w) => horiz ? o*w + i : i*w + o;

  /* Sobel magnitude over luminance — the edges a cartoon draws in. */
  function edges(px, w, h) {
    const g = new Float32Array(w*h);
    for (let i = 0, p = 0; i < w*h; i++, p += 4) g[i] = L(px[p], px[p+1], px[p+2]);
    const out = new Float32Array(w*h);
    for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) {
      const i = y*w + x;
      const gx = -g[i-w-1] - 2*g[i-1] - g[i+w-1] + g[i-w+1] + 2*g[i+1] + g[i+w+1];
      const gy = -g[i-w-1] - 2*g[i-w] - g[i-w+1] + g[i+w-1] + 2*g[i+w] + g[i+w+1];
      out[i] = Math.sqrt(gx*gx + gy*gy);
    }
    return out;
  }

  function posterize(px, levels, sat) {
    const step = 255 / (levels - 1);
    for (let p = 0; p < px.length; p += 4) {
      let r = px[p], g = px[p+1], b = px[p+2];
      if (sat !== 1) { const l = L(r,g,b); r = l + (r-l)*sat; g = l + (g-l)*sat; b = l + (b-l)*sat; }
      px[p]   = clamp(Math.round(r/step) * step);
      px[p+1] = clamp(Math.round(g/step) * step);
      px[p+2] = clamp(Math.round(b/step) * step);
    }
  }

  const ramp = (stops, t) => {
    const s = Math.max(0, Math.min(.9999, t)) * (stops.length - 1);
    const i = Math.floor(s), f = s - i, a = stops[i], b = stops[i+1] || a;
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f];
  };
  const hex2rgb = h => { const n = parseInt((h||"#888888").slice(1), 16); return [n>>16, (n>>8)&255, n&255]; };

  /* ── the treatments ─────────────────────────────────────────────────────── */
  const KINDS = {
    "Original": null,

    "Cartoon": (px, w, h) => {
      blur(px, w, h, 3, 2);                 // flatten the detail first
      const e = edges(px, w, h);            // find lines on the flattened image,
                                            // or every leaf becomes a stroke
      posterize(px, 6, 1.25);               // then bands of colour
      for (let i = 0, p = 0; i < w*h; i++, p += 4) {
        if (e[i] > 42) {                    // and ink the lines back on
          const k = Math.min(1, (e[i]-42)/70) * 0.92;
          px[p] *= 1-k; px[p+1] *= 1-k; px[p+2] *= 1-k;
        }
      }
    },

    "Comic": (px, w, h, ctx) => {
      blur(px, w, h, 3, 2);
      const e = edges(px, w, h);
      posterize(px, 4, 1.45);
      // lift the midtones first — the dot screen below darkens everything again,
      // and without this the whole card comes out muddy
      for (let p = 0; p < px.length; p += 4)
        for (let c = 0; c < 3; c++) px[p+c] = clamp(28 + px[p+c] * 0.88);
      for (let i = 0, p = 0; i < w*h; i++, p += 4)
        if (e[i] > 44) { px[p] = px[p+1] = px[p+2] = 20; }
      ctx.putImageData(new ImageData(px, w, h), 0, 0);
      // Halftone on top, drawn rather than computed — a real dot screen, rotated
      // 45° the way a press would.
      const cell = Math.max(4, Math.round(w/150));
      const d = ctx.getImageData(0, 0, w, h).data;
      ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = "#000";
      for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
        const i = (y*w + x) * 4;
        const t = 1 - L(d[i], d[i+1], d[i+2]) / 255;
        if (t < .18) continue;
        ctx.beginPath();
        ctx.arc(x + cell/2, y + cell/2, (cell/2) * Math.min(1, t) * .92, 0, 6.2832);
        ctx.globalAlpha = .32; ctx.fill();
      }
      ctx.restore();
      return true;                          // already written to the context
    },

    "Pixel": (px, w, h, ctx, cv) => {
      posterize(px, 5, 1.3);
      ctx.putImageData(new ImageData(px, w, h), 0, 0);
      const small = Math.max(48, Math.round(w / 12));
      const t = document.createElement("canvas");
      t.width = small; t.height = Math.round(small * h / w);
      const tc = t.getContext("2d");
      tc.imageSmoothingEnabled = true;
      tc.drawImage(cv, 0, 0, t.width, t.height);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(t, 0, 0, w, h);
      return true;
    },

    "Duotone": (px, w, h, ctx, cv, o) => {
      const a = hex2rgb(o.dark || "#0b1020"), b = hex2rgb(o.light || "#f5c451");
      for (let p = 0; p < px.length; p += 4) {
        const t = L(px[p], px[p+1], px[p+2]) / 255;
        px[p] = a[0] + (b[0]-a[0])*t; px[p+1] = a[1] + (b[1]-a[1])*t; px[p+2] = a[2] + (b[2]-a[2])*t;
      }
    },

    "Chrome": (px) => {
      // A metal ramp: dark, a hot band, back down, then a specular top. Mapping
      // luminance through it is what makes anything look chromed.
      const stops = [[8,10,16],[58,66,82],[176,186,200],[248,250,255],[120,130,148],[196,206,220],[255,255,255]];
      for (let p = 0; p < px.length; p += 4) {
        const c = ramp(stops, L(px[p], px[p+1], px[p+2]) / 255);
        px[p] = c[0]; px[p+1] = c[1]; px[p+2] = c[2];
      }
    },

    "Neon": (px, w, h) => {
      const e = edges(px, w, h);
      const src = px.slice();
      let mx = 1; for (let i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i];
      for (let i = 0, p = 0; i < w*h; i++, p += 4) {
        const t = Math.min(1, (e[i]/mx) * 2.6);
        // keep the picture's own hue in the glow, so it is not the same neon twice
        const l = L(src[p], src[p+1], src[p+2]) || 1;
        px[p]   = clamp(6  + src[p]   / l * 255 * t);
        px[p+1] = clamp(8  + src[p+1] / l * 255 * t * .92);
        px[p+2] = clamp(16 + src[p+2] / l * 255 * t);
      }
      blur(px, w, h, 1, 1);
    },

    "Ink": (px, w, h) => {
      const gray = new Uint8ClampedArray(px.length);
      for (let p = 0; p < px.length; p += 4) {
        const l = L(px[p], px[p+1], px[p+2]);
        gray[p] = gray[p+1] = gray[p+2] = 255 - l; gray[p+3] = 255;
      }
      blur(gray, w, h, 5, 2);
      for (let p = 0; p < px.length; p += 4) {      // colour dodge = pencil
        for (let c = 0; c < 3; c++) {
          const b = px[p+c], t = gray[p+c];
          px[p+c] = t >= 255 ? 255 : clamp((b * 255) / (255 - t));
        }
      }
      posterize(px, 9, 0);
    },
  };

  async function apply(src, kind, opts = {}) {
    if (!KINDS[kind]) return src;
    const im = await new Promise((res, rej) => {
      const i = new Image(); i.crossOrigin = "anonymous";
      i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const scale = Math.min(1, MAX / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * scale));
    const h = Math.max(1, Math.round(im.naturalHeight * scale));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    let data;
    try { data = ctx.getImageData(0, 0, w, h); } catch (e) { return src; }  // tainted
    const wroteItself = KINDS[kind](data.data, w, h, ctx, cv, opts);
    if (!wroteItself) ctx.putImageData(data, 0, 0);
    return cv.toDataURL("image/png");
  }

  return { KINDS: Object.keys(KINDS), apply };
})();
