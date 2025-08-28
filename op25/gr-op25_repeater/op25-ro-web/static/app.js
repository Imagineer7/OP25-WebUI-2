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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.time||""}</td>
      <td>${row.freq||""}</td>
      <td><span class="tg-chip" style="color:${tgColorFromId(row.tgid)}"></span>${row.tgid||""}</td>
      <td>${row.name||""}</td>
      <td>${row.source||""}</td>
      <td>${row.enc||""}</td>`;
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
function snapToLiveIfLagging(){
  if (!audio || audio.paused) return;
  const edge = liveEdge();
  if (!Number.isFinite(edge)) return;
  const lag = edge - audio.currentTime;
  if (lag > 1.0) audio.currentTime = Math.max(0, edge - 0.25);
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

// ---- AUDIO GRAPH + VU (Firefox + Chrome) ----
(function setupAudioGraph(){
  const el = document.getElementById('audio');
  if (!el || window.__audioGraphSetup) return;
  window.__audioGraphSetup = true;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { console.warn('[AUDIO] WebAudio not supported'); return; }

  const ac = new AudioCtx();

  // Ensure context stays alive after click or play
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
    // fallback (Firefox-friendly if MediaElementSource already created)
    if (typeof el.captureStream === 'function') {
      const ms = el.captureStream();
      srcNode = ac.createMediaStreamSource(ms);
    } else {
      console.error('[AUDIO] cannot create source:', e);
      return;
    }
  }

  // ELEMENT PATH: mute + full volume (we'll control volume via WebAudio)
  el.muted  = true;
  el.volume = 1;

  // DESTINATION PATH: our own gain node driven by the UI slider
  const gain = ac.createGain();
  const getUiVol = () => {
    const v = Number(document.getElementById('vol')?.value || 1);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  };
  gain.gain.value = getUiVol();

  // Wire graph: source -> (analyser) & source -> (gain -> speakers)
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;

  srcNode.connect(analyser);
  srcNode.connect(gain);
  gain.connect(ac.destination);

  // Keep gain synced to the UI slider ONLY
  document.getElementById('vol')?.addEventListener('input', () => {
    gain.gain.value = getUiVol();
    console.log('[AUDIO] gain', gain.gain.value);
  });

  // Tiny VU (reuse your bar if present)
  const bar = document.getElementById('vuMeter')?.querySelector('.fill');
  const buf = new Uint8Array(analyser.frequencyBinCount);
  (function tick(){
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i=0;i<buf.length;i++){
      const v = Math.abs(buf[i]-128);
      if (v>peak) peak = v;
    }
    if (bar) bar.style.width = `${Math.min(100, (peak/128)*100)}%`;
    requestAnimationFrame(tick);
  })();

  // Helpful logs
  el.addEventListener('playing', () => {
    console.log('[AUDIO] playing; ac.state=', ac.state, 'gain=', gain.gain.value);
  });
})();

// ===== DIAG HUD (shows if app sees the <audio>, and its state) =====
(function(){
  const hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', right: '10px', bottom: '10px', width: '320px',
    font: '12px/1.3 system-ui, sans-serif', color: '#eee', background: 'rgba(0,0,0,.6)',
    padding: '8px 10px', borderRadius: '8px', zIndex: 2147483647, pointerEvents: 'none',
  });
  document.body.appendChild(hud);

  function prettyRS(n){ return ['HAVE_NOTHING','HAVE_METADATA','HAVE_CURRENT_DATA','HAVE_FUTURE_DATA','HAVE_ENOUGH_DATA'][n] || n; }
  function prettyNS(n){ return ['EMPTY','IDLE','LOADING','NO_SOURCE'][n] || n; }

  function upd(){
    const el = document.getElementById('audio');
    if (!el){
      hud.textContent = 'HUD: <audio id="audio"> not found';
      return;
    }
    const err = el.error ? `E${el.error.code}` : 'none';
    const seek = (el.seekable && el.seekable.length) ? `${el.seekable.start(0).toFixed(2)}→${el.seekable.end(0).toFixed(2)}` : '—';
    hud.innerHTML = [
      `<b>HUD</b> app.js alive @ ${new Date().toLocaleTimeString()}`,
      `currentSrc: ${el.currentSrc || '—'}`,
      `readyState: ${prettyRS(el.readyState)}  network: ${prettyNS(el.networkState)}`,
      `paused: ${el.paused}  muted: ${el.muted}  vol: ${el.volume.toFixed(2)}`,
      `time: ${el.currentTime.toFixed(2)}  seekable: ${seek}`,
      `error: ${err}`,
    ].join('<br>');
  }
  setInterval(upd, 500);

  // Loud log that the script actually loaded:
  console.log('[DIAG] app.js loaded and HUD running');
})();

// ===== Minimal force tests =====
(function(){
  const el = document.getElementById('audio');
  if (!el) { console.warn('No <audio id="audio">'); return; }

  // same-origin local test file you place at /static/test.mp3
  document.getElementById('testLocalMp3')?.addEventListener('click', async () => {
    el.crossOrigin = '';     // not needed for same-origin file
    el.muted = false;
    el.volume = 1;
    el.src = '/static/test.mp3'; // <- put a tiny mp3 here
    el.load();
    try { await el.play(); } catch(e){ console.error('local play failed', e); }
  });

  // force the live stream
  document.getElementById('forceStream')?.addEventListener('click', async () => {
    el.crossOrigin = 'anonymous'; // harmless on same-origin; useful if you proxy later
    el.muted = false;
    el.volume = 1;
    el.src = `/stream?nocache=${Date.now()}`;
    el.load();
    try { await el.play(); } catch(e){ console.error('stream play failed', e); }
  });

  // verbose audio event logger
  const prettyRS = (n)=>['HAVE_NOTHING','HAVE_METADATA','HAVE_CURRENT_DATA','HAVE_FUTURE_DATA','HAVE_ENOUGH_DATA'][n]||n;
  const info = ()=>({src: el.currentSrc, paused: el.paused, muted: el.muted, vol: el.volume,
    rs: prettyRS(el.readyState), ns: el.networkState, err: el.error?.code || null});
  ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','play','playing','pause','waiting','stalled','suspend','progress','timeupdate','ended','emptied','error']
    .forEach(t => el.addEventListener(t, ev => console.log(`[AUDIO ${ev.type}]`, info())));
})();

// boot
renderHist(loadHist());
ensureAudio();           // single, authoritative init
pollLive();
setInterval(pollLive, POLL_MS);
setInterval(updateLastHeard, 1000);
