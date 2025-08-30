// ===== DOM =====
const audio  = document.getElementById("audio");
const netDot = document.getElementById("netDot");
const histTbd = document.getElementById("histBody");
const dlCsv = document.getElementById("dlCsv");

const nowTg  = document.getElementById("nowTg");
const nowNm  = document.getElementById("nowName");
const nowFq  = document.getElementById("nowFreq");
const nowSrc = document.getElementById("nowSrc");
const nowEnc = document.getElementById("nowEnc");

// ===== Config =====
const IS_FIREFOX = /\bfirefox\/\d+/i.test(navigator.userAgent);

const MAX_ROWS = 200;                    // max rows kept in localStorage
const LS_KEY = "scanner_history_v1";     // per-browser history key

try {
  if (!localStorage.getItem(LS_KEY) && localStorage.getItem("scanner_hist")) {
    localStorage.setItem(LS_KEY, localStorage.getItem("scanner_hist"));
    localStorage.removeItem("scanner_hist");
  }
} catch {}


// ===== Helpers =====
function setNet(ok){ netDot?.classList.toggle("ok", !!ok); }
function tgColorFromId(id){ const n=parseInt(id||"0",10); const h=(n*137)%360; return `hsl(${h} 85% 60%)`; }

function loadHist(){ try{ return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }catch{ return []; } }
function saveHist(rows){ try{ localStorage.setItem(LS_KEY, JSON.stringify(rows.slice(0,MAX_ROWS))); }catch{} }
function renderHist(rows){
  if (!histTbd) return;
  histTbd.innerHTML = "";
  rows.forEach(row=>{
    // Badge color logic
    const name = row.name || "";
    let badgeClass = "badge-name";
    if (/EMS/i.test(name))      badgeClass += " badge-ems";
    else if (/PD/i.test(name))  badgeClass += " badge-pd";
    else if (/FD/i.test(name))  badgeClass += " badge-fd";
    else if (/DOT/i.test(name)) badgeClass += " badge-dot";
    else if (/DNS/i.test(name)) badgeClass += " badge-dns";
    else if (/AST/i.test(name)) badgeClass += " badge-ast";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.time||""}</td>
      <td>${formatFreq(row.freq)||""}</td>
      <td><span class="tg-chip" style="color:${tgColorFromId(row.tgid)}"></span>${row.tgid||""}</td>
      <td><span class="${badgeClass}">${name}</span></td>`;
    histTbd.appendChild(tr);
  });
}

function updateNowUI(n){
  if (nowTg)  nowTg.textContent  = n.tgid   || "—";
  if (nowNm)  nowNm.textContent  = n.name   || "—";
  if (nowFq)  nowFq.textContent  = n.freq   || "—";
  if (nowSrc) nowSrc.textContent = n.source || "—";
  if (nowEnc) nowEnc.textContent = n.enc    || "—";
}

// Add this helper near your other helpers
function formatFreq(freq) {
  if (!freq) return "";
  // Remove trailing zeros and decimal if not needed
  return String(freq).replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.0+$/,'');
}

// ===== Audio (live stream with single Play/Pause & Mute/Unmute) =====
const playToggle = document.getElementById('playToggle');
const muteToggle = document.getElementById('muteToggle');
const vol        = document.getElementById('vol');
const statusEl   = document.getElementById('streamStatus');

audio.crossOrigin = 'anonymous';
audio.muted = false;
audio.volume = Math.max(0.1, Number(vol?.value || 1));

let userPaused = false;   // set true only when the user clicks Pause
let recovering = false;   // prevents concurrent restarts

function freshStreamUrl(){ return `/stream?nocache=${Date.now()}`; }

function setStatus(txt, cls){
  if (!statusEl) return;
  statusEl.textContent = txt;
  statusEl.classList.remove('ok','err','idle','live');
  if (cls) statusEl.classList.add(cls);
}

function hardResetStream(){
  if (!audio) return;
  try { audio.pause(); } catch {}
  const wasMuted = audio.muted;
  audio.crossOrigin = 'anonymous';                 // lets VU read samples across origins
  audio.muted = audio.muted || false;              // we mute later when routing; harmless here
  audio.volume = Number(vol?.value || 1) || 1;
  audio.removeAttribute('src');
  audio.load();
  audio.src = freshStreamUrl();
  audio.muted = wasMuted;
}

async function restartStream(){
  if (!audio || userPaused || recovering) return;
  recovering = true;
  setStatus('Connecting…', 'idle');
  try { audio.pause(); } catch {}
  const wasMuted = audio.muted;
  audio.crossOrigin = 'anonymous';                 // lets VU read samples across origins
  audio.muted = audio.muted || false;              // we mute later when routing; harmless here
  audio.volume = Number(vol?.value || 1) || 1;
  audio.src = freshStreamUrl();
  audio.load();
  audio.muted = wasMuted;
  try { await audio.play(); } catch {}
  recovering = false;
}

function updatePlayButton(){
  if (!playToggle || !audio) return;
  playToggle.textContent = audio.paused ? '▶︎ Play' : '⏸ Pause';
  playToggle.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
}

function updateMuteButton(){
  if (!muteToggle || !audio) return;
  muteToggle.textContent = audio.muted ? '🔊 Unmute' : '🔇 Mute';
  muteToggle.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
}

// Keep playhead near live edge without forcing play
function liveEdge(){
  const r = audio.seekable;
  return (r && r.length) ? r.end(r.length - 1) : NaN;
}

// Throttled “snap” (Chrome/Edge only). Firefox: do NOTHING.
let _lastSnap = 0;
function snapToLiveIfLagging(){
  if (!audio || audio.paused || IS_FIREFOX) return; // ← bail on Firefox
  const now = performance.now();
  if (now - _lastSnap < 1000) return;              // throttle to 1x/sec
  const edge = liveEdge();
  if (!Number.isFinite(edge) || audio.seeking) return;
  const lag = edge - audio.currentTime;
  if (lag > 1.5) { // be less aggressive
    try { audio.currentTime = Math.max(0, edge - 0.25); } catch {}
    _lastSnap = now;
  }
}

if (!IS_FIREFOX) {
  ['playing','timeupdate'].forEach(ev => {
    audio.addEventListener(ev, snapToLiveIfLagging);
  });
}

// Controls
if (playToggle) playToggle.addEventListener('click', () => {
  if (!audio) return;
  if (audio.paused) {
    userPaused = false;
    restartStream();        // always start with a fresh connection
  } else {
    userPaused = true;
    audio.pause();          // DO NOT auto-recover while userPaused
    setStatus('Paused', 'idle');
  }
  updatePlayButton();
});

if (muteToggle) muteToggle.addEventListener('click', () => {
  if (!audio) return;
  audio.muted = !audio.muted;
  updateMuteButton();
});

if (vol) vol.addEventListener('input', () => {
  if (audio) audio.volume = Number(vol.value);
});

// Events
if (audio){
  audio.addEventListener('play',    () => { userPaused = false; updatePlayButton(); });
  audio.addEventListener('playing', () => { setStatus('Live', 'ok'); updatePlayButton(); });
  audio.addEventListener('pause',   () => { updatePlayButton(); if (userPaused) setStatus('Paused','idle'); });
  audio.addEventListener('canplay', () => { if (!audio.paused) setStatus('Live','ok'); });

  // Show Buffering… only when not paused and actually low readyState
  let bufferTimer = null;
  function maybeBuffering(){
    if (audio.paused) return;
    if (audio.readyState > 2) {  // enough data to play
      if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
      return;
    }
    if (!bufferTimer) {
      bufferTimer = setTimeout(() => {
        if (!audio.paused && audio.readyState <= 2) setStatus('Buffering…','idle');
        bufferTimer = null;
      }, 200); // small grace period
    }
  }

  audio.addEventListener('waiting', maybeBuffering);
  audio.addEventListener('stalled', maybeBuffering);

  // Auto-recover ONLY if user did not pause
  audio.addEventListener('error',  () => { if (!userPaused) restartStream(); });
  audio.addEventListener('ended',  () => { if (!userPaused) restartStream(); });

  // Stay near live edge
  ['playing','timeupdate'].forEach(ev => {
    audio.addEventListener(ev, snapToLiveIfLagging);
  });

  // BFCache restore
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !userPaused) restartStream();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Don’t auto-recover while hidden
    userPaused = userPaused || audio?.paused || false;
  } else {
    if (!userPaused) restartStream();
  }
});

function ensureAudio(){
  if (!audio) return;
  audio.crossOrigin = 'anonymous';       // lets VU sample on any origin
  audio.muted = false;                   // element is muted by graph anyway
  audio.volume = 1;                      // keep element at 1; we use gain node
  audio.controls = false;
  audio.preload  = 'none';
  audio.autoplay = false;
  if (vol) audio.volume = Number(vol.value || 1);
  hardResetStream();          // primes without autoplay
  updatePlayButton();
  updateMuteButton();
  setStatus('Idle','idle');
}

document.getElementById('beepTest')?.addEventListener('click', async () => {
  try {
    const AudioCtx = window.AudioContext || (window.hasOwnProperty('webkitAudioContext') ? window['webkitAudioContext'] : undefined);
    if (!AudioCtx) throw new Error('Web Audio API not supported');
    const ac = new AudioCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.1; // comfortable
    osc.connect(gain).connect(ac.destination);
    osc.frequency.value = 440;
    osc.start();
    setTimeout(() => { osc.stop(); ac.close(); }, 1000);
  } catch (e) { console.error('WebAudio test failed:', e); }
});

// === DEBUG: audio event + error logger ===
(function(){
  const el = audio; if (!el) return;

  const prettyRS = () => ['HAVE_NOTHING','HAVE_METADATA','HAVE_CURRENT_DATA','HAVE_FUTURE_DATA','HAVE_ENOUGH_DATA'][el.readyState] || el.readyState;
  const info = () => ({
    src: el.currentSrc,
    paused: el.paused,
    muted: el.muted,
    volume: el.volume,
    readyState: prettyRS(),
    networkState: ['EMPTY','IDLE','LOADING','NO_SOURCE'][el.networkState] || el.networkState,
    error: el.error ? {code: el.error.code, msg: el.error.message} : null,
    seekable: el.seekable && el.seekable.length ? {start: el.seekable.start(0), end: el.seekable.end(0)} : null,
    buffered: el.buffered && el.buffered.length ? {start: el.buffered.start(0), end: el.buffered.end(0)} : null,
  });

  const log = (ev) => console.log(`[AUDIO ${ev.type}]`, info());
  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing',
   'pause','waiting','stalled','suspend','progress','timeupdate','ended','emptied'].forEach(t=>{
    el.addEventListener(t, log);
  });

  el.addEventListener('error', () => {
    console.error('[AUDIO error]', info());
    const e = el.error;
    // Optional on-page indicator
    try {
      statusEl && (statusEl.textContent = `Error ${e?.code || '?'}: ${e?.message || 'Unknown'}`);
      statusEl && statusEl.classList.add('err');
    } catch {}
  });

  // sanity checks
  if (el.volume === 0) el.volume = 1;
  if (el.muted) el.muted = false;
})();

// ===== Live polling of /api/live (proxied from OP25 /ro-now) =====
// Single source of truth; no /ro-now anywhere in the frontend.

const EL = {
  tg:  document.getElementById("nowTg"),
  nm:  document.getElementById("nowName"),
  fq:  document.getElementById("nowFreq"),
  src: document.getElementById("nowSrc"),
  enc: document.getElementById("nowEnc"),
  badge: document.getElementById("nowStatus"),
  nowCard: document.querySelector(".card.now"),
  lastHeard: document.getElementById("lastHeard"),
  audio: document.getElementById("audio"),
  histTbd: document.getElementById("histBody"),
};

const POLL_MS  = 1000;  // how often we poll /api/live
const STALE_MS = 5000;  // if no new call in 5s, consider idle & clear

let lastActiveTs = 0;   // unix ms of last activity we applied
let lastKey = "";       // de-dup key for history rows

function setBadgeLive() {
  EL.badge?.classList.remove("idle");
  EL.badge?.classList.add("live");
  if (EL.badge) EL.badge.innerHTML = `<span class="dot"></span> Live`;
  EL.nowCard?.classList.remove("idle");
}
function setBadgeIdle() {
  EL.badge?.classList.remove("live");
  EL.badge?.classList.add("idle");
  if (EL.badge) EL.badge.textContent = "Idle";
  EL.nowCard?.classList.add("idle");
}
function clearNowFields() {
  if (EL.tg)  EL.tg.textContent  = "—";
  if (EL.nm)  EL.nm.textContent  = "—";
  if (EL.fq)  EL.fq.textContent  = "—";
  if (EL.src) EL.src.textContent = "—";
  if (EL.enc) EL.enc.textContent = "—";
}

function humanAgo(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s/60);
  if (m < 60) return `${m}m ${s%60}s ago`;
  const h = Math.floor(m/60);
  return `${h}h ${m%60}m ago`;
}
function updateLastHeard() {
  if (!EL.lastHeard) return;
  if (!lastActiveTs) { EL.lastHeard.textContent = "Last heard: —"; return; }
  const ms = Date.now() - lastActiveTs;
  EL.lastHeard.textContent = `Last heard: ${humanAgo(ms)}`;
}

function applyNow(n) {
  // Update "Now" UI
  if (EL.tg)  EL.tg.textContent  = n.tgid  || "—";
  if (EL.nm)  EL.nm.textContent  = n.name  || "—";
  if (EL.fq)  EL.fq.textContent  = n.freq  || "—";
  if (EL.src) EL.src.textContent = n.source|| "—";
  if (EL.enc) EL.enc.textContent = n.enc   || "—";

  // De-dupe key for history (same call shouldn't add endless rows)
  const key = [n.tgid||"", n.source||"", n.freq||"", n.enc||"", n.name||""].join("|");
  if (!key || key === (applyNow._lastKey || "")) {
    document.title = n.tgid ? `${n.tgid} • ALMR Scanner` : "ALMR Scanner";
    return;
  }
  applyNow._lastKey = key;

  // Build row
  const row = {
    time: new Date().toLocaleTimeString(),
    freq: n.freq || "",
    tgid: n.tgid || "",
    name: n.name || "",
    source: n.source || "",
    enc: n.enc || ""
  };

  // Update storage (single source of truth)
  const rows = loadHist();
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  saveHist(rows);

  // Re-render table from storage
  renderHist(rows);

  // Title
  document.title = n.tgid ? `${n.tgid} • ALMR Scanner` : "ALMR Scanner";
}

// main poller
const FRESH_MS = 10_000; // consider a record live if ts is within 10s

function isFresh(tsSec) {
  const tsMs = Number(tsSec || 0) * 1000;
  return tsMs && (Date.now() - tsMs) <= FRESH_MS;
}

async function pollLive(){
  try{
    const r = await fetch("/api/live", { cache: "no-store" });
    if (!r.ok) throw new Error("live fetch failed");
    const js = await r.json();

    setNet(true);

    const n = js.now || {};
    const tsSec = Number(n.ts || 0);
    const fresh = isFresh(tsSec);

    // Update badge based on freshness (ignore js.idle for logic)
    if (fresh) {
      lastActiveTs = Math.floor(tsSec * 1000);
      setBadgeLive();
      applyNow({
        tgid: String(n.tgid||""),
        name: String(n.name||""),
        freq: String(n.freq||""),
        source: String(n.source||""),
        enc: String(n.enc||""),
        ts: tsSec
      });
    } else {
      setBadgeIdle();
      // only clear if we’ve been stale for a bit
      if (!lastActiveTs || (Date.now() - lastActiveTs) > STALE_MS) {
        clearNowFields();
        document.title = "ALMR Scanner";
      }
    }
  } catch (e) {
    setNet(false);
    setBadgeIdle();
    // don’t immediately wipe fields — lets brief hiccups slide
  }
}

// Ensure we only ever use the HTML #vuMeter and remove any legacy bars
(function normalizeVu(){
  // remove any old JS-created bars (from earlier makeVu tests)
  document.querySelectorAll('[data-vu-legacy]').forEach(n => n.remove());

  const meter = document.getElementById('vuMeter');
  const fill  = meter?.querySelector('.fill');

  if (!meter || !fill) return;

  // yank meter to <body> so nothing clips it
  if (meter.parentElement !== document.body) document.body.appendChild(meter);

  // enforce top/stacking and layout so width animations are visible
  Object.assign(meter.style, {
    position: 'fixed',
    left: '10px',
    bottom: '10px',
    width: '180px',
    height: '12px',
    zIndex: '2147483647',
    overflow: 'hidden',
    isolation: 'isolate',
    pointerEvents: 'none'
  });
  Object.assign(fill.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    bottom: '0',
    // IMPORTANT: don't set 'right' so width is respected
    width: '0%',
    zIndex: '1'
  });
})();

// One VU loop at a time; reuse this from both FF/Chromium paths
const VU = { raf: 0, analyser: null };

function startVu(analyser) {
  VU.analyser = analyser;
  if (VU.raf) cancelAnimationFrame(VU.raf);

  const bar = document.querySelector('#vuMeter .fill');
  if (!bar || !VU.analyser) return;

  const buf = new Uint8Array(VU.analyser.frequencyBinCount);
  const tick = () => {
    VU.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128);
      if (v > peak) peak = v;
    }
    bar.style.width = `${Math.min(100, (peak / 128) * 100)}%`;
    VU.raf = requestAnimationFrame(tick);
  };
  VU.raf = requestAnimationFrame(tick);
}

// ---- Cross-browser audio routing with Firefox captureStream VU fallback ----
(function setupAudioGraph(){
  const el = document.getElementById('audio');
  if (!el || window.__audioGraphSetup) return;
  window.__audioGraphSetup = true;

  const isFirefox = /\bfirefox\/\d+/i.test(navigator.userAgent);

  if (isFirefox) {
    // Firefox: play through the element; VU via captureStream if possible
    el.muted = false; // element outputs directly (you already control volume via #vol)
    console.log('[AUDIO] Firefox: direct element playback');

    let vuInit = false;
    const initVuFF = () => {
      if (vuInit) return; vuInit = true;
      try {
        if (typeof el.captureStream !== 'function') { console.warn('[VU] FF: no captureStream'); return; }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) { console.warn('[VU] FF: no AudioContext'); return; }

        const ac = new AudioCtx();
        const resume = () => { if (ac.state === 'suspended') ac.resume().catch(()=>{}); };
        window.addEventListener('click', resume, { once:true });
        el.addEventListener('play', resume, { once:true });

        const ms  = el.captureStream();            // mirror element’s output
        const src = ac.createMediaStreamSource(ms);
        const analyser = ac.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);                     // analyser only, no destination

        const bar = document.querySelector('#vuMeter .fill');
        if (bar) {
          const buf = new Uint8Array(analyser.frequencyBinCount);
          (function tick(){
            analyser.getByteTimeDomainData(buf);
            let peak = 0;
            for (let i=0;i<buf.length;i++){
              const v = Math.abs(buf[i]-128);
              if (v>peak) peak = v;
            }
            bar.style.width = `${Math.min(100, (peak/128)*100)}%`;
            requestAnimationFrame(tick);
          })();
        }
        console.log('[VU] Firefox: captureStream analyser active');
      } catch (e) {
        console.warn('[VU] Firefox captureStream failed:', e);
        document.getElementById('vuMeter')?.classList.add('error');
      }
    };

    // Start the VU after playback begins (captureStream works best then)
    if (!el.paused) initVuFF(); else el.addEventListener('playing', initVuFF, { once:true });
    return;
  }

  // Chromium/Edge: WebAudio graph (element muted), VU via analyser, volume via gain
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { console.warn('[AUDIO] WebAudio not supported'); return; }
  const ac = new AudioCtx();

  const resume = () => { if (ac.state === 'suspended') ac.resume().catch(()=>{}); };
  window.addEventListener('click', resume, { once:true });
  el.addEventListener('play', resume, { once:true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ac.state === 'suspended') ac.resume().catch(()=>{});
  });

  let srcNode;
  try {
    srcNode = ac.createMediaElementSource(el);
  } catch (e) {
    // Fallback: mirror element via captureStream if MediaElementSource was already used
    if (typeof el.captureStream === 'function') {
      const ms = el.captureStream();
      srcNode = ac.createMediaStreamSource(ms);
    } else {
      console.error('[AUDIO] cannot create source:', e);
      return;
    }
  }

  // Avoid double-audio: element muted; use gain for loudness
  el.muted = true;
  el.volume = 1;

  const gain = ac.createGain();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  startVu(analyser);

  srcNode.connect(analyser);
  srcNode.connect(gain);
  gain.connect(ac.destination);

  // Hook UI volume to gain (not el.volume)
  const uiVol = document.getElementById('vol');
  const getUiVol = () => {
    const v = Number(uiVol?.value || 1);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    };
  gain.gain.value = getUiVol();
  uiVol?.addEventListener('input', () => { gain.gain.value = getUiVol(); });

  // Simple VU
  const bar = document.querySelector('#vuMeter .fill');
  if (bar) {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    (function tick(){
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i=0;i<buf.length;i++){
        const v = Math.abs(buf[i]-128);
        if (v>peak) peak = v;
      }
      bar.style.width = `${Math.min(100, (peak/128)*100)}%`;
      requestAnimationFrame(tick);
    })();
  }

  console.log('[AUDIO] Chromium path: source→(analyser & gain→dest), element muted');
})();

(function ensureVuOnTop(){
  const meter = document.getElementById('vuMeter');
  if (!meter) return;
  if (meter.parentElement !== document.body) {
    document.body.appendChild(meter); // pull it out of any clipping container
  }
  // force topmost stacking context
  meter.style.position = 'fixed';
  meter.style.left = '10px';
  meter.style.bottom = '10px';
  meter.style.zIndex = '2147483647';
  meter.style.pointerEvents = 'none';   // never block clicks
  meter.style.transform = 'translateZ(0)'; // isolate stacking in some engines
})();

// boot
renderHist(loadHist());
ensureAudio();           // single, authoritative init
pollLive();
setInterval(pollLive, POLL_MS);
setInterval(updateLastHeard, 1000);

// ===== Icecast listener count =====
const listenerCountEl = document.getElementById('listenerCount');
const ICECAST_MOUNT = (window.ROCFG && window.ROCFG.mountHint) || "/op25.mp3";

async function updateListenerCount() {
  if (!listenerCountEl) return;
  try {
    const r = await fetch("/api/icecast", {cache:"no-store"});
    if (!r.ok) throw new Error("icecast fetch failed");
    const js = await r.json();
    if (!js.ok) throw new Error(js.error || "icecast error");
    // Find the mount matching our stream
    const mounts = js.data.icestats && js.data.icestats.source
      ? Array.isArray(js.data.icestats.source)
        ? js.data.icestats.source
        : [js.data.icestats.source]
      : [];
    const mount = mounts.find(m => m.listenurl && m.listenurl.endsWith(ICECAST_MOUNT));
    const count = mount && typeof mount.listeners === "number" ? mount.listeners : 0;
    listenerCountEl.textContent = `Listeners: ${count}`;
  } catch (e) {
    listenerCountEl.textContent = "Listeners: —";
  }
}

// Update every 10 seconds
setInterval(updateListenerCount, 2000);
updateListenerCount(); // initial call

document.addEventListener("DOMContentLoaded", function() {
  // Popup logic
  function showPopup(id) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "flex";
      document.body.style.overflow = "hidden";
    }
  }
  function hidePopup(id) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "none";
      document.body.style.overflow = "";
    }
  }

  // Welcome popup tab switching
  document.getElementById("openWelcome")?.addEventListener("click", () => showPopup("welcomePopup"));
  document.getElementById("closePopup")?.addEventListener("click", () => hidePopup("welcomePopup"));
  document.getElementById("openAbout")?.addEventListener("click", () => showPopup("aboutPopup"));
  document.getElementById("closeAbout")?.addEventListener("click", () => hidePopup("aboutPopup"));

  // Tab switching for welcome popup
  document.querySelectorAll(".popup-tabs .tab-btn").forEach(btn => {
    btn.addEventListener("click", function() {
      document.querySelectorAll(".popup-tabs .tab-btn").forEach(b => b.classList.remove("active"));
      this.classList.add("active");
      document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
      document.getElementById("tab-" + this.dataset.tab).classList.add("active");
    });
  });

  // Show welcome popup on first visit
  (function(){
    const KEY = "op25_welcome_seen";
    if (!localStorage.getItem(KEY)) {
      showPopup("welcomePopup");
      localStorage.setItem(KEY, "1");
    }
  })();
});

(function themeToggleInit() {
  const btn = document.getElementById('themeToggle');
  const root = document.documentElement;
  const THEME_KEY = "op25_theme";
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    btn.textContent = theme === "dark" ? "🌙 Dark" : "☀️ Light";
  }

  // Load saved or system theme
  let theme = localStorage.getItem(THEME_KEY) || (prefersDark ? "dark" : "light");
  setTheme(theme);

  btn?.addEventListener('click', () => {
    theme = (root.getAttribute('data-theme') === "dark") ? "light" : "dark";
    setTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  });
})();
