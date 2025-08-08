(async () => {
  /* ---------------- CONFIG ---------------- */
  const CONFIG = {
    COOLDOWN_DEFAULT: 31000,
    TRANSPARENCY_THRESHOLD: 100,
    WHITE_THRESHOLD: 250,
    LOG_INTERVAL: 10,
    THEME: { primary: '#000000', secondary: '#111111', accent: '#222222', text: '#ffffff', highlight: '#775ce3', success: '#00ff00', error: '#ff0000', warning: '#ffaa00' },
    // protections anti-captcha : attente minimale aléatoire entre pixels (ms)
    MIN_DELAY_BETWEEN_PIXELS: 150,    // base small random delay to look less bot-like
    MAX_DELAY_BETWEEN_PIXELS: 450,    // jitter
    // polling when captcha present (ms)
    CAPTCHA_POLL_INTERVAL: 8000,
    // exponential backoff cap
    BACKOFF_MAX: 60000
  };

  /* ---------------- TEXTS + STATE ---------------- */
  const TEXTS = {
    en: { title: "WPlace Auto-Image", initBot: "Start Auto-BOT", uploadImage: "Upload Image", resizeImage: "Resize Image",
      selectPosition: "Select Position", startPainting: "Start Painting", stopPainting: "Stop Painting",
      checkingColors: "🔍 Checking available colors...", noColorsFound: "❌ Open the color palette on the site and try again!",
      colorsFound: "✅ {count} available colors found", loadingImage: "🖼️ Loading image...", imageLoaded: "✅ Image loaded with {count} valid pixels",
      imageError: "❌ Error loading image", selectPositionAlert: "Paint the first pixel at the location where you want the art to start!",
      waitingPosition: "👆 Waiting for you to paint the reference pixel...", positionSet: "✅ Position set successfully!",
      positionTimeout: "❌ Timeout for position selection", startPaintingMsg: "🎨 Starting painting...",
      paintingProgress: "🧱 Progress: {painted}/{total} pixels...", noCharges: "⌛ No charges. Waiting {time}...",
      paintingStopped: "⏹️ Painting stopped by user", paintingComplete: "✅ Painting complete! {count} pixels painted.",
      paintingError: "❌ Error during painting", missingRequirements: "❌ Load an image and select a position first",
      progress: "Progress", pixels: "Pixels", charges: "Charges", estimatedTime: "Estimated time",
      initMessage: "Click 'Start Auto-BOT' to begin", waitingInit: "Waiting for initialization...",
      resizeSuccess: "✅ Image resized to {width}x{height}", paintingPaused: "⏸️ Painting paused at position X: {x}, Y: {y}",
      captchaRequired: "🛑 CAPTCHA required — paused. Solve the CAPTCHA in the site, or wait..."
    },
    pt: {} // keep english fallback (you can fill pt if you want)
  };
  const state = {
    running: false, imageLoaded: false, processing: false, totalPixels: 0, paintedPixels: 0,
    availableColors: [], currentCharges: 0, cooldown: CONFIG.COOLDOWN_DEFAULT,
    imageData: null, stopFlag: false, colorsChecked: false, startPosition: null,
    selectingPosition: false, region: null, minimized: false, lastPosition: { x: 0, y: 0 },
    estimatedTime: 0, language: 'en', captchaRequired: false, backoffMs: 0
  };

  /* ---------------- UTILS ---------------- */
  const Utils = {
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    randBetween: (a,b)=> Math.floor(Math.random()*(b-a+1))+a,
    colorDistance: (a,b)=> Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2),
    formatTime: ms => {
      const s = Math.floor((ms/1000)%60), m = Math.floor((ms/(1000*60))%60), h = Math.floor((ms/(1000*60*60))%24), d = Math.floor(ms/(1000*60*60*24));
      let r=''; if(d) r+=d+'d '; if(h||d) r+=h+'h '; if(m||h||d) r+=m+'m '; r+=s+'s'; return r;
    },
    isWhitePixel: (r,g,b)=> r>=CONFIG.WHITE_THRESHOLD && g>=CONFIG.WHITE_THRESHOLD && b>=CONFIG.WHITE_THRESHOLD,
    t: (k, p={}) => {
      let s = (TEXTS[state.language] && TEXTS[state.language][k]) || TEXTS.en[k] || k;
      Object.entries(p).forEach(([kk,v])=> s = s.replace(`{${kk}}`, v));
      return s;
    },
    showAlert: (msg, type='info')=>{
      const a=document.createElement('div'); a.style.position='fixed'; a.style.top='15px'; a.style.left='50%'; a.style.transform='translateX(-50%)';
      a.style.background = CONFIG.THEME[type] || CONFIG.THEME.accent; a.style.color = CONFIG.THEME.text; a.style.padding='10px 14px';
      a.style.borderRadius='6px'; a.style.zIndex='99999'; a.textContent = msg; document.body.appendChild(a);
      setTimeout(()=>{ a.style.opacity='0'; a.style.transition='opacity .4s'; setTimeout(()=>a.remove(),450); }, 4500);
    }
  };

  /* ---------------- WPlace SERVICE (captcha-aware) ----------------
     Key changes:
     - detect captcha from HTTP status (403/429) or response body containing 'captcha' or similar
     - when captcha detected, set state.captchaRequired = true and return a special result
  --------------------------------------------------------------- */
  const WPlaceService = {
    async paintPixelInRegion(regionX, regionY, pixelX, pixelY, color) {
      try {
        const res = await fetch(`https://backend.wplace.live/s0/pixel/${regionX}/${regionY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          credentials: 'include',
          body: JSON.stringify({ coords: [pixelX, pixelY], colors: [color] })
        });
        // detect captcha via status codes or text
        if (res.status === 429 || res.status === 403) {
          state.captchaRequired = true;
          return { ok: false, captcha: true };
        }
        const text = await res.text();
        // heuristic: site might return html or json containing 'captcha' or 'recaptcha'
        if (/captcha|recaptcha|verify/i.test(text)) {
          state.captchaRequired = true;
          return { ok: false, captcha: true };
        }
        // try parse JSON
        let data;
        try { data = JSON.parse(text); } catch(e){ data = null; }
        if (data && data.painted === 1) return { ok: true, painted: 1 };
        // fallback: not painted
        return { ok: false, painted: 0 };
      } catch (err) {
        // network error — treat as transient; don't mark captcha immediately
        return { ok: false, error: true };
      }
    },

    async getCharges() {
      try {
        const res = await fetch('https://backend.wplace.live/me', { credentials: 'include' });
        if (res.status === 429 || res.status === 403) {
          state.captchaRequired = true;
          return { captcha: true, charges: 0, cooldown: CONFIG.COOLDOWN_DEFAULT };
        }
        const text = await res.text();
        if (/captcha|recaptcha|verify/i.test(text)) {
          state.captchaRequired = true;
          return { captcha: true, charges: 0, cooldown: CONFIG.COOLDOWN_DEFAULT };
        }
        const data = JSON.parse(text);
        return { charges: data.charges?.count || 0, cooldown: data.charges?.cooldownMs || CONFIG.COOLDOWN_DEFAULT };
      } catch (err) {
        return { charges: 0, cooldown: CONFIG.COOLDOWN_DEFAULT };
      }
    },

    // helper to test if captcha cleared: try simple GET to /me and look for normal JSON
    async checkCaptchaCleared() {
      try {
        const res = await fetch('https://backend.wplace.live/me', { credentials: 'include' });
        const text = await res.text();
        if (res.status === 200 && !/captcha|recaptcha|verify/i.test(text)) {
          try { JSON.parse(text); state.captchaRequired = false; state.backoffMs = 0; return true; } catch(e){ return false; }
        }
        return false;
      } catch(e){ return false; }
    }
  };

  /* ---------------- Image / UI / Processing (mostly same as your code)
     Added: captcha UI messaging, random delays and backoff handling.
  --------------------------------------------------------------- */

  // small helper: copy-paste your UI creation here but we keep it short: essential UI + status updates
  // For brevity I'll inject a compact UI with same buttons and status area (keeps your original styling idea).
  function injectMinimalUI() {
    if (document.getElementById('wplace-image-bot-container')) return; // avoid dupes
    const css = document.createElement('style');
    css.textContent = `
      #wplace-image-bot-container{position:fixed;top:20px;right:20px;width:320px;background:${CONFIG.THEME.primary};color:${CONFIG.THEME.text};
        border:1px solid ${CONFIG.THEME.accent};padding:10px;border-radius:8px;z-index:99999;font-family:Arial,Helvetica,sans-serif}
      #wplace-image-bot-container button{margin:6px 4px;padding:8px;border-radius:6px;border:0;cursor:pointer}
      #wplace-img-preview{max-width:100%;border:1px solid ${CONFIG.THEME.accent};display:block;margin:6px 0}
      .small{font-size:12px;opacity:.9}
    `;
    document.head.appendChild(css);

    const c = document.createElement('div'); c.id = 'wplace-image-bot-container';
    c.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${Utils.t('title')}</strong>
        <button id="wplace-close">✕</button>
      </div>
      <div style="margin-top:8px">
        <div style="display:flex;flex-wrap:wrap">
          <button id="wplace-init">${Utils.t('initBot')}</button>
          <button id="wplace-upload" disabled>${Utils.t('uploadImage')}</button>
          <button id="wplace-select" disabled>${Utils.t('selectPosition')}</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;margin-top:6px">
          <button id="wplace-start" disabled>${Utils.t('startPainting')}</button>
          <button id="wplace-stop" disabled>${Utils.t('stopPainting')}</button>
          <button id="wplace-resize" disabled>${Utils.t('resizeImage')}</button>
        </div>
        <img id="wplace-img-preview" src="" alt="" />
        <div id="wplace-status" class="small">${Utils.t('waitingInit')}</div>
      </div>
    `;
    document.body.appendChild(c);

    document.getElementById('wplace-close').onclick = () => c.remove();
    return c;
  }

  // minimal ImageProcessor copy (works same)
  class ImageProcessor {
    constructor(src) { this.img = new Image(); this.img.src = src; this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d'); }
    async load(){ return new Promise((res,rej)=>{ this.img.onload=()=>{ this.canvas.width=this.img.width; this.canvas.height=this.img.height; this.ctx.drawImage(this.img,0,0); res(); }; this.img.onerror=rej; }); }
    getPixelData(){ return this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height).data; }
    getDimensions(){ return { width:this.canvas.width, height:this.canvas.height }; }
    resize(w,h){ const t=document.createElement('canvas'); t.width=w; t.height=h; const tc=t.getContext('2d'); tc.drawImage(this.img,0,0,w,h); this.canvas.width=w; this.canvas.height=h; this.ctx.drawImage(t,0,0); return this.getPixelData(); }
    generatePreview(w,h){ const t=document.createElement('canvas'); t.width=w; t.height=h; const tc=t.getContext('2d'); tc.imageSmoothingEnabled=false; tc.drawImage(this.img,0,0,w,h); return t.toDataURL(); }
  }

  function findClosestColor(rgb, palette){
    return palette.reduce((closest, cur)=>{
      const d = Utils.colorDistance(rgb, cur.rgb);
      return d < closest.distance ? {color:cur, distance:d} : closest;
    }, {color:palette[0], distance: Utils.colorDistance(rgb, palette[0].rgb)}).color.id;
  }

  // Create UI & hook events (similar to your code but minimal)
  const container = injectMinimalUI();
  const initBtn = document.getElementById('wplace-init');
  const uploadBtn = document.getElementById('wplace-upload');
  const selectBtn = document.getElementById('wplace-select');
  const startBtn = document.getElementById('wplace-start');
  const stopBtn = document.getElementById('wplace-stop');
  const resizeBtn = document.getElementById('wplace-resize');
  const previewImg = document.getElementById('wplace-img-preview');
  const statusEl = document.getElementById('wplace-status');

  function updateStatus(text, type='default'){ statusEl.textContent = text; statusEl.style.opacity = '1'; }

  // init: detect colors on page
  initBtn.onclick = ()=> {
    updateStatus(Utils.t('checkingColors'));
    try {
      const cols = Array.from(document.querySelectorAll('[id^="color-"]'))
        .filter(el => !el.querySelector('svg'))
        .filter(el => { const id = parseInt(el.id.replace('color-','')); return id!==0 && id!==5; })
        .map(el => {
          const id = parseInt(el.id.replace('color-',''));
          const rgb = (el.style.backgroundColor.match(/\d+/g) || [0,0,0]).map(Number);
          return { id, rgb };
        });
      if (!cols.length){ Utils.showAlert(Utils.t('noColorsFound'), 'error'); updateStatus(Utils.t('noColorsFound')); return; }
      state.availableColors = cols; state.colorsChecked = true; uploadBtn.disabled=false; selectBtn.disabled=false; resizeBtn.disabled=false;
      updateStatus(Utils.t('colorsFound', {count: cols.length}), 'success');
    } catch(e){
      updateStatus(Utils.t('imageError'), 'error');
    }
  };

  // upload image
  uploadBtn.onclick = async ()=>{
    try {
      updateStatus(Utils.t('loadingImage'));
      const input = document.createElement('input'); input.type='file'; input.accept='image/png,image/jpeg';
      input.onchange = async ()=> {
        const fr = new FileReader(); fr.onload = async ()=> {
          const src = fr.result; previewImg.src = src;
          const proc = new ImageProcessor(src); await proc.load();
          const {width,height} = proc.getDimensions(); const pixels = proc.getPixelData();
          let total=0; for(let y=0;y<height;y++){ for(let x=0;x<width;x++){ const idx=(y*width+x)*4; const a=pixels[idx+3]; if(a<CONFIG.TRANSPARENCY_THRESHOLD) continue; if(Utils.isWhitePixel(pixels[idx],pixels[idx+1],pixels[idx+2])) continue; total++; } }
          state.imageData = { width, height, pixels, totalPixels: total, processor: proc };
          state.totalPixels = total; state.paintedPixels = 0; state.imageLoaded = true;
          updateStatus(Utils.t('imageLoaded',{count:total}));
          if (state.startPosition) startBtn.disabled=false;
        }; fr.readAsDataURL(input.files[0]);
      };
      input.click();
    } catch(e){ updateStatus(Utils.t('imageError'),'error'); }
  };

  // select position: we intercept outgoing pixel POSTs and wait until user paints a pixel to capture coords/region
  selectBtn.onclick = ()=>{
    if (state.selectingPosition) return;
    state.selectingPosition = true; state.startPosition = null; state.region = null;
    updateStatus(Utils.t('waitingPosition'));
    Utils.showAlert(Utils.t('selectPositionAlert'),'info');
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('/s0/pixel/') && options?.method?.toUpperCase()==='POST') {
        try {
          const response = await originalFetch(url, options);
          const clone = response.clone();
          const text = await clone.text();
          let data = null;
          try { data = JSON.parse(text); } catch(e){}
          if (data?.painted === 1) {
            const match = url.match(/\/pixel\/(\d+)\/(\d+)/);
            if (match) state.region = { x: parseInt(match[1]), y: parseInt(match[2]) };
            try { const payload = JSON.parse(options.body); if (payload?.coords){ state.startPosition = { x: payload.coords[0], y: payload.coords[1] }; } } catch(e){}
            window.fetch = originalFetch;
            state.selectingPosition=false;
            updateStatus(Utils.t('positionSet'));
            return response;
          }
          return response;
        } catch(e){ window.fetch = originalFetch; state.selectingPosition=false; updateStatus(Utils.t('positionTimeout'),'error'); return originalFetch(url,options); }
      }
      return originalFetch(url,options);
    };
    setTimeout(()=>{ if(state.selectingPosition){ window.fetch = window.fetch; state.selectingPosition=false; updateStatus(Utils.t('positionTimeout'),'error'); Utils.showAlert(Utils.t('positionTimeout'),'error'); } }, 120000);
  };

  // start / stop handlers
  startBtn.onclick = async ()=>{
    if (!state.imageLoaded || !state.startPosition || !state.region) { updateStatus(Utils.t('missingRequirements'),'error'); return; }
    state.running = true; state.stopFlag=false; startBtn.disabled=true; stopBtn.disabled=false; uploadBtn.disabled=true; selectBtn.disabled=true; resizeBtn.disabled=true;
    updateStatus(Utils.t('startPaintingMsg'));
    try { await processImage(); } catch(e){ updateStatus(Utils.t('paintingError'),'error'); }
    finally { state.running=false; stopBtn.disabled=true; if(!state.stopFlag){ startBtn.disabled=true; uploadBtn.disabled=false; selectBtn.disabled=false; resizeBtn.disabled=false; } else startBtn.disabled=false; }
  };
  stopBtn.onclick = ()=>{ state.stopFlag=true; state.running=false; stopBtn.disabled=true; updateStatus(Utils.t('paintingStopped')); };

  // small resize button (uses processor.generatePreview + resize)
  resizeBtn.onclick = ()=>{
    if (!state.imageLoaded) return;
    const p = state.imageData.processor; const {width,height} = p.getDimensions();
    const newW = Math.max(10, Math.min(500, Math.round(prompt("New width", width)||width)));
    const newH = Math.max(10, Math.min(500, Math.round(prompt("New height", height)||height)));
    const newPixels = p.resize(newW,newH);
    let totalValid = 0; for(let y=0;y<newH;y++){ for(let x=0;x<newW;x++){ const idx=(y*newW+x)*4; const a=newPixels[idx+3]; if(a<CONFIG.TRANSPARENCY_THRESHOLD) continue; if(Utils.isWhitePixel(newPixels[idx],newPixels[idx+1],newPixels[idx+2])) continue; totalValid++; } }
    state.imageData.pixels = newPixels; state.imageData.width=newW; state.imageData.height=newH; state.imageData.totalPixels=totalValid; state.totalPixels=totalValid; state.paintedPixels=0;
    previewImg.src = p.img.src; updateStatus(Utils.t('resizeSuccess',{width:newW,height:newH}),'success'); updateStats();
  };

  // updateStats helper
  async function updateStats(){
    if(!state.colorsChecked||!state.imageLoaded) return;
    const chargesRes = await WPlaceService.getCharges();
    if (chargesRes?.captcha) { state.captchaRequired=true; updateStatus(Utils.t('captchaRequired')); Utils.showAlert(Utils.t('captchaRequired'),'warning'); return; }
    state.currentCharges = Math.floor(chargesRes.charges); state.cooldown = chargesRes.cooldown;
    const progress = state.totalPixels>0?Math.round((state.paintedPixels/state.totalPixels)*100):0;
    updateStatus(`${Utils.t('progress')}: ${progress}% — ${state.paintedPixels}/${state.totalPixels} — ${Utils.t('charges')}: ${Math.floor(state.currentCharges)} — ETA: ${Utils.formatTime(Utils.calculateEstimatedTime?.(state.totalPixels-state.paintedPixels,state.currentCharges,state.cooldown) || 0)}`);
  }

  // add a helper to calculate estimatedTime similar to yours
  Utils.calculateEstimatedTime = (remainingPixels, currentCharges, cooldown) => {
    const ppc = currentCharges>0?currentCharges:0;
    const fullCycles = Math.ceil((remainingPixels - ppc) / Math.max(currentCharges, 1));
    return (fullCycles * cooldown) + ((remainingPixels - 1) * 100);
  };

  /* ---------------- CAPTCHA WATCHDOG ----------------
     - When captcha detected: set state.captchaRequired = true, show message.
     - Poll every CAPTCHA_POLL_INTERVAL calling WPlaceService.checkCaptchaCleared()
     - Use exponential backoff on failures to avoid hammering.
  -------------------------------------------------- */
  async function waitForCaptchaSolve() {
    updateStatus(Utils.t('captchaRequired'),'warning');
    Utils.showAlert(Utils.t('captchaRequired'),'warning');
    state.backoffMs = 0;
    while (state.captchaRequired && !state.stopFlag) {
      const ok = await WPlaceService.checkCaptchaCleared();
      if (ok) {
        state.captchaRequired = false;
        updateStatus("CAPTCHA cleared — resuming...");
        Utils.showAlert("CAPTCHA cleared — resuming...", 'success');
        await Utils.sleep(1200);
        return true;
      }
      // backoff jitter
      state.backoffMs = state.backoffMs ? Math.min(CONFIG.BACKOFF_MAX, state.backoffMs * 1.5 + Utils.randBetween(500,1500)) : Utils.CAPTCHA_POLL_INTERVAL || CONFIG.CAPTCHA_POLL_INTERVAL;
      await Utils.sleep(state.backoffMs);
    }
    return false;
  }

  /* ---------------- processImage (main loop) ----------------
     - Honours charges & cooldown (like original)
     - Adds small random delay between pixel requests
     - Detects captcha responses and calls waitForCaptchaSolve() to pause/resume
     - Uses backoff on transient errors
  -------------------------------------------------- */
  async function processImage() {
    const { width, height, pixels } = state.imageData;
    const { x: startX, y: startY } = state.startPosition;
    const { x: regionX, y: regionY } = state.region;
    let startRow = state.lastPosition.y || 0;
    let startCol = state.lastPosition.x || 0;

    outer: for (let y = startRow; y < height; y++) {
      for (let x = (y === startRow ? startCol : 0); x < width; x++) {
        if (state.stopFlag) { state.lastPosition = { x, y }; updateStatus(Utils.t('paintingPaused',{x,y})); break outer; }
        const idx=(y*width+x)*4; const r=pixels[idx], g=pixels[idx+1], b=pixels[idx+2], a=pixels[idx+3];
        if (a < CONFIG.TRANSPARENCY_THRESHOLD) continue;
        if (Utils.isWhitePixel(r,g,b)) continue;
        const colorId = findClosestColor([r,g,b], state.availableColors);

        // if no charges, wait for cooldown (but also monitor captcha)
        if (state.currentCharges < 1) {
          updateStatus(Utils.t('noCharges',{time: Utils.formatTime(state.cooldown)}));
          // if captcha active, wait for user to solve
          if (state.captchaRequired) {
            const ok = await waitForCaptchaSolve();
            if (!ok) { updateStatus(Utils.t('paintingStopped'),'error'); return; }
          }
          await Utils.sleep(state.cooldown + Utils.randBetween(100, 800)); // small jitter
          const c = await WPlaceService.getCharges();
          if (c?.captcha) { state.captchaRequired=true; const ok = await waitForCaptchaSolve(); if(!ok) return; }
          state.currentCharges = c.charges || 0; state.cooldown = c.cooldown || CONFIG.COOLDOWN_DEFAULT;
        }

        // small random delay to avoid perfectly timed requests (reduces bot footprint)
        await Utils.sleep(Utils.randBetween(CONFIG.MIN_DELAY_BETWEEN_PIXELS, CONFIG.MAX_DELAY_BETWEEN_PIXELS));

        const pixelX = startX + x;
        const pixelY = startY + y;

        // paint
        const res = await WPlaceService.paintPixelInRegion(regionX, regionY, pixelX, pixelY, colorId);
        if (res.captcha) {
          // captcha triggered — set flag and wait for solve, then retry this same pixel
          state.captchaRequired = true;
          const ok = await waitForCaptchaSolve();
          if (!ok) return;
          // after captcha solved, refresh charges
          const c2 = await WPlaceService.getCharges(); if (c2?.captcha) { state.captchaRequired=true; continue; }
          state.currentCharges = c2.charges || 0; state.cooldown = c2.cooldown || CONFIG.COOLDOWN_DEFAULT;
          // then retry current pixel (decrement x so that loop retries same)
          x--;
          continue;
        }

        if (res.ok && res.painted === 1) {
          state.paintedPixels++; state.currentCharges = Math.max(0, state.currentCharges - 1);
          if (state.paintedPixels % CONFIG.LOG_INTERVAL === 0) {
            updateStatus(Utils.t('paintingProgress',{painted: state.paintedPixels, total: state.totalPixels}));
          }
        } else if (res.error) {
          // transient error: do small backoff and retry same pixel
          await Utils.sleep(Utils.randBetween(800, 2500));
          x--; continue;
        } else {
          // not painted (maybe color mismatch or server responded false): continue
        }
      }
    }

    if (state.stopFlag) updateStatus(Utils.t('paintingStopped'));
    else { updateStatus(Utils.t('paintingComplete',{count: state.paintedPixels}),'success'); state.lastPosition = { x:0, y:0 }; }
    updateStats();
  }

  /* ---------------- Finish init: wire up small helpers and auto-update stats ---------------- */
  // expose some helpers to dev console
  window.WPlaceBot = { state, Utils, WPlaceService, processImage, waitForCaptchaSolve };

  // try detect language quickly (best-effort)
  try { const r = await fetch('https://ipapi.co/json/'); const d = await r.json(); state.language = d.country==='BR'?'pt':'en'; } catch(e){ state.language='en'; }

  // enable start when we have everything
  const autoStatsInterval = setInterval(()=>{
    if (state.colorsChecked && state.imageLoaded) startBtn.disabled = !state.startPosition || !state.region;
    // periodically refresh simple stats if available
    if (state.colorsChecked && state.imageLoaded) updateStats();
  }, 5000);

  updateStatus(Utils.t('waitingInit'));

  // done
  Utils.showAlert("WPlace Auto-Bot injected — follow the UI in the panel", 'success');

})();
