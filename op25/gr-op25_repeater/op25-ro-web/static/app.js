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
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

const MAX_ROWS = 200;                    // max rows kept in localStorage
const LS_KEY = "scanner_history_v1";     // per-browser history key
const ALERT_SETTINGS_KEY = "scanner_alert_settings_v1";
const ALERT_PROFILES_KEY = "scanner_alert_profiles_v1";
const ALERT_ACTIVE_PROFILE_KEY = "scanner_alert_active_profile_v1";

const defaultAlertSettings = {
  notifyEnabled: false,
  notifySeparateRules: false,
  notifyTgMode: "whitelist",
  notifySelectedTgids: [],
  notifyBurstLimit: 2,
  notifyBurstResetSec: 45,
  notifyCategoriesEnabled: false,
  notifyCategories: [],
  autoUnmuteEnabled: false,
  autoRemuteDelaySec: 5,
  tgMode: "whitelist",
  selectedTgids: []
};

let alertSettings = {...defaultAlertSettings};
let alertProfiles = {"Default": {...defaultAlertSettings}};
let activeAlertProfile = "Default";
let activeNotifyCategoryName = "";
let talkgroupCatalog = [];
let lastNotifiedCallKey = "";
let autoUnmutedForActiveCall = false;
let autoRemuteTimer = null;
const notifyBurstStateByTgid = new Map();

try {
  if (!localStorage.getItem(LS_KEY) && localStorage.getItem("scanner_hist")) {
    localStorage.setItem(LS_KEY, localStorage.getItem("scanner_hist"));
    localStorage.removeItem("scanner_hist");
  }
} catch {}


// ===== Helpers =====
function setNet(ok){ netDot?.classList.toggle("ok", !!ok); }
function tgColorFromId(id){ const n=parseInt(id||"0",10); const h=(n*137)%360; return `hsl(${h} 85% 60%)`; }

function loadHist() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    // Remove any lingering audioUrl fields
    return arr.map(row => {
      if (row.audioUrl) delete row.audioUrl;
      return row;
    });
  } catch {
    return [];
  }
}
function saveHist(rows) {
  // Remove audioUrl before saving to localStorage
  const toSave = rows.map(row => {
    const { audioUrl, ...rest } = row;
    return rest;
  });
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(toSave.slice(0, MAX_ROWS)));
  } catch {}
}

function normalizeAlertSettings(raw) {
  const src = raw || {};
  const mode = src.tgMode === "blacklist" ? "blacklist" : "whitelist";
  const notifyMode = src.notifyTgMode === "blacklist" ? "blacklist" : "whitelist";
  const selected = Array.isArray(src.selectedTgids)
    ? src.selectedTgids.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const notifySelected = Array.isArray(src.notifySelectedTgids)
    ? src.notifySelectedTgids.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const delay = Number.isFinite(Number(src.autoRemuteDelaySec))
    ? Math.max(0, Math.min(300, Number(src.autoRemuteDelaySec)))
    : defaultAlertSettings.autoRemuteDelaySec;
  const burstLimit = Number.isFinite(Number(src.notifyBurstLimit))
    ? Math.max(1, Math.min(20, Number(src.notifyBurstLimit)))
    : defaultAlertSettings.notifyBurstLimit;
  const burstResetSec = Number.isFinite(Number(src.notifyBurstResetSec))
    ? Math.max(5, Math.min(3600, Number(src.notifyBurstResetSec)))
    : defaultAlertSettings.notifyBurstResetSec;
  const normalizeCategory = (cat, idx) => {
    const c = cat || {};
    const name = String(c.name || `Category ${idx + 1}`).trim() || `Category ${idx + 1}`;
    const behavior = c.behavior === "priority" || c.behavior === "quiet" ? c.behavior : "standard";
    const catMode = c.mode === "blacklist" ? "blacklist" : "whitelist";
    const catSelected = Array.isArray(c.selectedTgids)
      ? c.selectedTgids.map(v => String(v || "").trim()).filter(Boolean)
      : [];
    return {
      name,
      behavior,
      mode: catMode,
      selectedTgids: Array.from(new Set(catSelected))
    };
  };
  const rawCategories = Array.isArray(src.notifyCategories) ? src.notifyCategories : [];
  const categories = rawCategories.map((c, i) => normalizeCategory(c, i));
  return {
    notifyEnabled: !!src.notifyEnabled,
    notifySeparateRules: !!src.notifySeparateRules,
    notifyTgMode: notifyMode,
    notifySelectedTgids: Array.from(new Set(notifySelected)),
    notifyBurstLimit: burstLimit,
    notifyBurstResetSec: burstResetSec,
    notifyCategoriesEnabled: !!src.notifyCategoriesEnabled,
    notifyCategories: categories,
    autoUnmuteEnabled: !!src.autoUnmuteEnabled,
    autoRemuteDelaySec: delay,
    tgMode: mode,
    selectedTgids: Array.from(new Set(selected))
  };
}

function persistAlertProfiles() {
  try {
    localStorage.setItem(ALERT_PROFILES_KEY, JSON.stringify(alertProfiles));
    localStorage.setItem(ALERT_ACTIVE_PROFILE_KEY, activeAlertProfile);
    // Keep legacy key updated for backwards compatibility.
    localStorage.setItem(ALERT_SETTINGS_KEY, JSON.stringify(alertSettings));
  } catch {}
}

function loadAlertSettings() {
  try {
    const rawProfiles = JSON.parse(localStorage.getItem(ALERT_PROFILES_KEY) || "{}");
    if (rawProfiles && typeof rawProfiles === "object" && Object.keys(rawProfiles).length) {
      const normalized = {};
      for (const [name, value] of Object.entries(rawProfiles)) {
        if (!name) continue;
        normalized[String(name)] = normalizeAlertSettings(value);
      }
      alertProfiles = Object.keys(normalized).length ? normalized : {"Default": {...defaultAlertSettings}};
    } else {
      // Migrate from old single-profile settings key if present.
      const legacyRaw = JSON.parse(localStorage.getItem(ALERT_SETTINGS_KEY) || "{}");
      alertProfiles = {"Default": normalizeAlertSettings(legacyRaw)};
    }

    const preferred = String(localStorage.getItem(ALERT_ACTIVE_PROFILE_KEY) || "").trim();
    if (preferred && alertProfiles[preferred]) {
      activeAlertProfile = preferred;
    } else {
      activeAlertProfile = Object.keys(alertProfiles)[0] || "Default";
    }

    if (!alertProfiles[activeAlertProfile]) {
      alertProfiles[activeAlertProfile] = {...defaultAlertSettings};
    }
    alertSettings = {...alertProfiles[activeAlertProfile]};
    persistAlertProfiles();
  } catch {
    alertProfiles = {"Default": {...defaultAlertSettings}};
    activeAlertProfile = "Default";
    alertSettings = {...defaultAlertSettings};
  }
}

function saveAlertSettings() {
  alertProfiles[activeAlertProfile] = normalizeAlertSettings(alertSettings);
  alertSettings = {...alertProfiles[activeAlertProfile]};
  persistAlertProfiles();
}

function normalizeTgid(tgid) {
  return String(tgid || "").trim();
}

function ensureActiveNotifyCategory() {
  const categories = Array.isArray(alertSettings.notifyCategories) ? alertSettings.notifyCategories : [];
  if (!categories.length) {
    activeNotifyCategoryName = "";
    return;
  }
  const found = categories.find(c => c.name === activeNotifyCategoryName);
  if (!found) {
    activeNotifyCategoryName = categories[0].name;
  }
}

function getActiveNotifyCategory() {
  ensureActiveNotifyCategory();
  return (alertSettings.notifyCategories || []).find(c => c.name === activeNotifyCategoryName) || null;
}

function clearNotifyBurstState() {
  notifyBurstStateByTgid.clear();
  lastNotifiedCallKey = "";
}

function shouldNotifyByBurstLimit(tgid) {
  const key = normalizeTgid(tgid);
  if (!key) return true;

  const limit = Math.max(1, Math.min(20, Number(alertSettings.notifyBurstLimit) || 2));
  const resetMs = Math.max(5, Math.min(3600, Number(alertSettings.notifyBurstResetSec) || 45)) * 1000;
  const now = Date.now();

  const existing = notifyBurstStateByTgid.get(key);
  const isNewBurst = !existing || !Number.isFinite(existing.lastSeenTs) || ((now - existing.lastSeenTs) >= resetMs);
  const state = isNewBurst ? {count: 0, lastSeenTs: now} : existing;

  state.count += 1;
  state.lastSeenTs = now;
  notifyBurstStateByTgid.set(key, state);

  return state.count <= limit;
}

function isTalkgroupMatchByRules(tgid, mode, selectedList) {
  const tg = normalizeTgid(tgid);
  if (!tg || !selectedList.length) return false;
  const selected = new Set(selectedList);
  const listed = selected.has(tg);
  return mode === "blacklist" ? !listed : listed;
}

function matchesUnmuteRules(tgid) {
  return isTalkgroupMatchByRules(tgid, alertSettings.tgMode, alertSettings.selectedTgids);
}

function matchesNotifyRules(tgid) {
  if (alertSettings.notifySeparateRules) {
    return isTalkgroupMatchByRules(tgid, alertSettings.notifyTgMode, alertSettings.notifySelectedTgids);
  }
  return matchesUnmuteRules(tgid);
}

function matchNotifyCategory(tgid) {
  if (!alertSettings.notifyCategoriesEnabled) return null;
  const categories = Array.isArray(alertSettings.notifyCategories) ? alertSettings.notifyCategories : [];
  for (const category of categories) {
    if (isTalkgroupMatchByRules(tgid, category.mode, category.selectedTgids || [])) {
      return category;
    }
  }
  return null;
}

function maybeNotifyTalkgroup(details, callKey, category = null) {
  if (!alertSettings.notifyEnabled) return;
  if (lastNotifiedCallKey === callKey) return;

  const tgid = normalizeTgid(details.tgid) || "Unknown";
  if (!shouldNotifyByBurstLimit(tgid)) {
    lastNotifiedCallKey = callKey;
    return;
  }

  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const name = details.name || "Unknown Talkgroup";
  const freq = details.freq || "";
  const body = `${name} (TG ${tgid})${freq ? ` @ ${freq}` : ""}`;
  const behavior = category && (category.behavior === "priority" || category.behavior === "quiet")
    ? category.behavior
    : "standard";
  const notifyTitle = category ? `${category.name} Active` : "Talkgroup Active";

  function playCategoryCue(kind) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      const now = ctx.currentTime;
      const plan = kind === "priority"
        ? [{f: 1046, d: 0.1}, {f: 1568, d: 0.1}, {f: 1046, d: 0.1}]
        : kind === "quiet"
          ? [{f: 880, d: 0.08}]
          : [{f: 988, d: 0.09}, {f: 1318, d: 0.09}];
      let t = now;
      for (const p of plan) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = p.f;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + p.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + p.d + 0.01);
        t += p.d + 0.03;
      }
      setTimeout(() => {
        try { ctx.close(); } catch (_) {}
      }, 900);
    } catch (_) {
      // no-op if browser blocks autoplay audio context
    }
  }

  function showLocalToast(text) {
    let toast = document.getElementById("localNotifyToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "localNotifyToast";
      Object.assign(toast.style, {
        position: "fixed",
        right: "12px",
        top: "12px",
        zIndex: "2147483647",
        maxWidth: "90vw",
        background: "#1b2a1d",
        color: "#d9ffe0",
        border: "1px solid #2f8f46",
        borderRadius: "8px",
        padding: "10px 12px",
        boxShadow: "0 4px 18px rgba(0,0,0,.35)",
        fontSize: "13px",
        lineHeight: "1.3",
      });
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.display = "block";
    clearTimeout(showLocalToast._timer);
    showLocalToast._timer = setTimeout(() => {
      toast.style.display = "none";
    }, 3500);
  }

  async function dispatchNotification(title, opts) {
    try {
      // Desktop/most browsers path
      new Notification(title, opts);
      return true;
    } catch (_) {
      // iOS/PWA-friendly fallback path via service worker registration
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.showNotification) {
            await reg.showNotification(title, opts);
            return true;
          }
        }
      } catch (_) {
        // swallow and fallback to toast
      }
    }
    return false;
  }

  const notificationOptions = {
    body,
    tag: category ? `cat-${String(category.name).toLowerCase().replace(/\s+/g, "-")}-${tgid}` : `tg-${tgid}`,
    renotify: behavior === "priority",
    requireInteraction: behavior === "priority",
    silent: behavior === "quiet",
    vibrate: behavior === "priority" ? [260, 100, 260, 100, 260] : behavior === "quiet" ? [60] : [120, 70, 120]
  };

  dispatchNotification(notifyTitle, notificationOptions).then((shown) => {
    if (!shown) {
      showLocalToast(`${notifyTitle}: ${body}`);
    }
    playCategoryCue(behavior);
    if (navigator.vibrate && behavior !== "quiet") {
      try { navigator.vibrate(notificationOptions.vibrate); } catch (_) {}
    }
  });

  lastNotifiedCallKey = callKey;
}

function maybeAutoUnmute(details) {
  if (!alertSettings.autoUnmuteEnabled) return;
  if (!audio) return;
  if (autoRemuteTimer) {
    clearTimeout(autoRemuteTimer);
    autoRemuteTimer = null;
  }
  if (audio.muted) {
    audio.muted = false;
    autoUnmutedForActiveCall = true;
    updateMuteButton();
  }
}

function scheduleAutoRemute() {
  if (!autoUnmutedForActiveCall || !audio) return;
  if (autoRemuteTimer) {
    clearTimeout(autoRemuteTimer);
    autoRemuteTimer = null;
  }

  const delayMs = Math.max(0, Math.min(300, Number(alertSettings.autoRemuteDelaySec) || 0)) * 1000;
  autoRemuteTimer = setTimeout(() => {
    autoRemuteTimer = null;
    if (!lastIdle) return; // a new call started while waiting
    if (audio && !audio.muted) {
      audio.muted = true;
      updateMuteButton();
    }
    autoUnmutedForActiveCall = false;
  }, delayMs);
}

function handleMatchedTalkgroup(details, callKey) {
  const categoryMatch = matchNotifyCategory(details.tgid);
  const notifyMatch = !!categoryMatch || matchesNotifyRules(details.tgid);
  const unmuteMatch = matchesUnmuteRules(details.tgid);
  if (notifyMatch) maybeNotifyTalkgroup(details, callKey, categoryMatch);
  if (unmuteMatch) maybeAutoUnmute(details);
}

function collectLocalTalkgroups() {
  const map = new Map();
  const rows = loadHist();
  for (const row of rows) {
    const tgid = normalizeTgid(row.tgid);
    if (!tgid) continue;
    const prev = map.get(tgid) || {tgid, name: "", count: 0, airtime: 0};
    prev.count += 1;
    if (!prev.name && row.name) prev.name = row.name;
    map.set(tgid, prev);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function updateSelectedSummary() {
  const main = document.getElementById("tgSelectedSummary");
  if (main) main.textContent = `Selected: ${alertSettings.selectedTgids.length}`;
  const notify = document.getElementById("notifyTgSelectedSummary");
  if (notify) notify.textContent = `Notification selected: ${alertSettings.notifySelectedTgids.length}`;
  const cat = document.getElementById("notifyCategorySelectedSummary");
  if (cat) {
    const active = getActiveNotifyCategory();
    cat.textContent = active
      ? `Category selected: ${(active.selectedTgids || []).length}`
      : "Category selected: 0";
  }
}

function renderTalkgroupCatalogToHost(hostId, selectedList, onToggle, filterText = "") {
  const host = document.getElementById(hostId);
  if (!host) return;
  const q = String(filterText || "").toLowerCase().trim();
  const selected = new Set(selectedList);

  const items = talkgroupCatalog.filter(tg => {
    if (!q) return true;
    return String(tg.tgid || "").toLowerCase().includes(q) ||
      String(tg.name || "").toLowerCase().includes(q);
  });

  if (!items.length) {
    host.innerHTML = '<div class="muted">No talkgroups found.</div>';
    updateSelectedSummary();
    return;
  }

  host.innerHTML = items.map(tg => {
    const tgid = String(tg.tgid || "").replace(/"/g, "&quot;");
    const name = String(tg.name || "");
    const count = Number(tg.count || 0);
    const checked = selected.has(String(tg.tgid || "")) ? "checked" : "";
    return `
      <div class="tg-item">
        <label>
          <input type="checkbox" class="tg-check" data-tgid="${tgid}" ${checked}/>
          <span class="tg-id">${tgid}</span>
          <span class="tg-name">${name || "(unnamed)"}</span>
          <span class="tg-count">calls: ${count}</span>
        </label>
      </div>`;
  }).join("");

  host.querySelectorAll(".tg-check").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const tgid = normalizeTgid(e.target.getAttribute("data-tgid"));
      onToggle(tgid, !!e.target.checked);
      saveAlertSettings();
      updateSelectedSummary();
    });
  });

  updateSelectedSummary();
}

function renderTalkgroupCatalog(filterText = "") {
  renderTalkgroupCatalogToHost(
    "tgCatalog",
    alertSettings.selectedTgids,
    (tgid, checked) => {
      const set = new Set(alertSettings.selectedTgids);
      if (checked) set.add(tgid); else set.delete(tgid);
      alertSettings.selectedTgids = Array.from(set);
    },
    filterText
  );
}

function renderNotifyTalkgroupCatalog(filterText = "") {
  renderTalkgroupCatalogToHost(
    "notifyTgCatalog",
    alertSettings.notifySelectedTgids,
    (tgid, checked) => {
      const set = new Set(alertSettings.notifySelectedTgids);
      if (checked) set.add(tgid); else set.delete(tgid);
      alertSettings.notifySelectedTgids = Array.from(set);
    },
    filterText
  );
}

function renderNotifyCategoryTalkgroupCatalog(filterText = "") {
  const active = getActiveNotifyCategory();
  const host = document.getElementById("notifyCategoryCatalog");
  if (!host) return;
  if (!active) {
    host.innerHTML = '<div class="muted">Create a category to map talkgroups.</div>';
    updateSelectedSummary();
    return;
  }

  renderTalkgroupCatalogToHost(
    "notifyCategoryCatalog",
    active.selectedTgids,
    (tgid, checked) => {
      const cat = getActiveNotifyCategory();
      if (!cat) return;
      const set = new Set(cat.selectedTgids || []);
      if (checked) set.add(tgid); else set.delete(tgid);
      cat.selectedTgids = Array.from(set);
    },
    filterText
  );
}

async function loadTalkgroupCatalog() {
  try {
    const r = await fetch("/api/talkgroups", {cache: "no-store"});
    if (!r.ok) throw new Error("catalog fetch failed");
    const js = await r.json();
    if (!js.ok || !Array.isArray(js.talkgroups)) throw new Error("bad catalog");
    talkgroupCatalog = js.talkgroups;
  } catch (e) {
    console.warn("Talkgroup catalog fallback to local history:", e);
    talkgroupCatalog = collectLocalTalkgroups();
  }
}
function renderHist(rows){
  if (!histTbd) return;
  histTbd.innerHTML = "";
  rows.forEach((row, idx) => {
    // Badge color logic
    const name = row.name || "";
    let badgeClass = "badge-name";
    if (/EMS/i.test(name))      badgeClass += " badge-ems";
    else if (/PD/i.test(name))  badgeClass += " badge-pd";
    else if (/FD/i.test(name))  badgeClass += " badge-fd";
    else if (/DOT/i.test(name)) badgeClass += " badge-dot";
    else if (/DNR/i.test(name)) badgeClass += " badge-dnr";
    else if (/AST/i.test(name)) badgeClass += " badge-ast";

    let audioBtn = "";
    if (row.audioUrl && row.audioBlob) {
      audioBtn = `
        <button class="audio-play-btn" data-idx="${idx}" aria-label="Play recording">
          <span class="icon-play" style="display:inline;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
              <path fill-rule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clip-rule="evenodd" />
            </svg>
          </span>
          <span class="icon-pause" style="display:none;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
              <path fill-rule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clip-rule="evenodd" />
            </svg>
          </span>
        </button>
        <audio src="${row.audioUrl}" preload="none" style="display:none;"></audio>
      `;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.time ? new Date(row.time).toLocaleTimeString() : ""}</td>
      <td>${formatFreq(row.freq)||""}</td>
      <td><span class="tg-chip" style="color:${tgColorFromId(row.tgid)}"></span>${row.tgid||""}</td>
      <td><span class="${badgeClass}">${name}</span></td>
      <td>${row.duration||""} ${audioBtn}</td>`;
    histTbd.appendChild(tr);
  });

  // Add play/pause logic for all audio buttons
  histTbd.querySelectorAll(".audio-play-btn").forEach(btn => {
    btn.onclick = function() {
      const idx = Number(this.dataset.idx);
      const rows = window._histRows || loadHist();
      const row = rows[idx];
      const tr = this.closest("tr");
      const audio = tr.querySelector("audio");
      if (!audio) return;

      // Save original row HTML to restore later
      const originalHTML = tr.innerHTML;

      // Hide all other playing audios and restore their rows
      histTbd.querySelectorAll("audio").forEach(a => {
        if (a !== audio) {
          a.pause();
          const rowEl = a.closest("tr");
          if (rowEl && rowEl.dataset.originalHtml) {
            rowEl.innerHTML = rowEl.dataset.originalHtml;
            delete rowEl.dataset.originalHtml;
          }
        }
      });

      // Replace row content with waveform/seekbar UI
      tr.dataset.originalHtml = originalHTML;
      tr.innerHTML = `
        <td colspan="5">
          <div style="display:flex;align-items:center;gap:12px;">
            <button class="seek-pause-btn" aria-label="Pause">⏸ Pause</button>
            <input type="range" min="0" max="1" value="0" step="0.01" class="seek-bar" style="flex:1;" disabled>
            <span class="seek-time">Loading…</span>
            <canvas class="waveform-canvas" width="120" height="32" style="margin-left:12px;background:#222;border-radius:4px;"></canvas>
          </div>
        </td>
      `;
      // Re-attach audio element (hidden)
      audio.setAttribute("preload", "auto"); // <-- ensure metadata loads ASAP
      tr.appendChild(audio);
      audio.style.display = "none";

      // Play audio from start
      audio.currentTime = 0;
      audio.play();

      // Elements
      const seekBar = tr.querySelector(".seek-bar");
      const seekTime = tr.querySelector(".seek-time");
      const pauseBtn = tr.querySelector(".seek-pause-btn");
      const canvas = tr.querySelector(".waveform-canvas");
      let waveformDrawn = false;

      // Wait for metadata before enabling seek bar and drawing waveform
      audio.onloadedmetadata = () => {
        seekBar.disabled = false;
        updateSeek();
        if (!waveformDrawn) drawWaveform();
      };

      // Update seek bar as audio plays
      function updateSeek() {
        if (!isFinite(audio.duration) || isNaN(audio.duration)) {
          seekBar.value = 0;
          seekBar.max = 1;
          seekTime.textContent = "Loading…";
          return;
        }
        seekBar.max = audio.duration;
        seekBar.value = audio.currentTime;
        seekTime.textContent =
          `${Math.floor(audio.currentTime/60)}:${String(Math.floor(audio.currentTime%60)).padStart(2,"0")} / ` +
          `${Math.floor(audio.duration/60)}:${String(Math.floor(audio.duration%60)).padStart(2,"0")}`;
      }
      audio.ontimeupdate = updateSeek;

      // Seek when user drags
      seekBar.oninput = () => { audio.currentTime = seekBar.value; };

      // Pause button
      pauseBtn.onclick = () => { audio.pause(); };

      // Restore row on pause/end
      function restoreRow() {
        if (tr.dataset.originalHtml) {
          tr.innerHTML = tr.dataset.originalHtml;
          delete tr.dataset.originalHtml;
          // Re-attach play handler for this row
          const playBtn = tr.querySelector(".audio-play-btn");
          if (playBtn) playBtn.onclick = btn.onclick;
        }
      }
      audio.onpause = restoreRow;
      audio.onended = restoreRow;

      // Draw waveform (simple, once per play)
      function drawWaveform() {
        if (waveformDrawn || !canvas) return;
        waveformDrawn = true;
        try {
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const blob = row.audioBlob;
          if (!blob) {
            // Optionally, show a message or just leave blank
            ctx.fillStyle = "#888";
            ctx.font = "10px sans-serif";
            ctx.fillText("No waveform", 10, 20);
            return;
          }
          // Use Web Audio API to decode and draw waveform
          const reader = new FileReader();
          reader.onload = function() {
            const arrayBuffer = reader.result;
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ac = new AudioCtx();
            ac.decodeAudioData(arrayBuffer, audioBuffer => {
              const data = audioBuffer.getChannelData(0);
              const step = Math.floor(data.length / canvas.width);
              ctx.strokeStyle = "#3dd6ff";
              ctx.beginPath();
              for (let x = 0; x < canvas.width; x++) {
                let min = 1, max = -1;
                for (let i = 0; i < step; i++) {
                  const v = data[x * step + i];
                  if (v < min) min = v;
                  if (v > max) max = v;
                }
                const y1 = (1 - min) * canvas.height / 2;
                const y2 = (1 - max) * canvas.height / 2;
                ctx.moveTo(x, y1);
                ctx.lineTo(x, y2);
              }
              ctx.stroke();
              ac.close();
            }, err => {
              console.error("decodeAudioData failed:", err);
            });
          };
          reader.readAsArrayBuffer(blob);
        } catch (e) {
          console.error("Waveform error:", e);
        }
      }
    };
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


// ========================AUDIO ========================//
// ====================================================================//
// ===== Audio (live stream with single Play/Pause & Mute/Unmute) =====//
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
  if (!audio || audio.paused || IS_FIREFOX || IS_MOBILE) return; // mobile/FF: avoid aggressive seeks
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
  if (document.hidden) return;
  if (!audio || userPaused) return;

  // Try to resume without reconnecting first (better for mobile background use).
  if (audio.paused) {
    audio.play().catch(() => restartStream());
  }
});

function ensureAudio(){
  if (!audio) return;
  audio.crossOrigin = 'anonymous';       // lets VU sample on any origin
  audio.muted = false;                   // element is muted by graph anyway
  audio.volume = 1;                      // keep element at 1; we use gain node
  audio.controls = false;
  audio.preload  = 'auto';
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

//-------------------------------------------//
//------------END OF AUDIO CODE--------------//
//-------------------------------------------//

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
let lastCallKey = "";
let lastIdle = true;

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

  /* De-dupe key for history (same call shouldn't add endless rows)
  const key = [n.tgid||"", n.source||"", n.freq||"", n.enc||"", n.name||"", n.ts||""].join("|");
  if (!key || key === (applyNow._lastKey || "")) {
    document.title = n.tgid ? `${n.tgid} • ALMR Scanner` : "ALMR Scanner";
    return;
  }
  applyNow._lastKey = key;

  // Build row
  const row = {
    time: new Date().toISOString(),
    freq: n.freq || "",
    tgid: n.tgid || "",
    name: n.name || "",
    source: n.source || "",
    enc: n.enc || ""
  };

  // Update storage (single source of truth)
  const rows = loadHist();
  rows.unshift(row);

  // Revoke audio blobs for entries that are being dropped
  while (rows.length > MAX_ROWS) {
    const dropped = rows.pop();
    if (dropped && dropped.audioUrl) {
      URL.revokeObjectURL(dropped.audioUrl);
    }
  }
  saveHist(rows);

  // Re-render table from storage
  renderHist(rows);*/

  // Title
  document.title = n.tgid ? `${n.tgid} • ALMR Scanner` : "ALMR Scanner";
}

// main poller
const FRESH_MS = 10_000; // consider a record live if ts is within 10s

function isFresh(tsSec) {
  const tsMs = Number(tsSec || 0) * 1000;
  return tsMs && (Date.now() - tsMs) <= FRESH_MS;
}

// --- Call duration tracking ---
let callStartTs = null;
let callStartDetails = null;

// Optionally, add a place in your HTML to show the duration, e.g.:
// <div id="callDuration" class="muted" style="margin-top:4px;"></div>
const callDurationEl = document.getElementById("callDuration");

function updateCallDurationDisplay(duration) {
  if (callDurationEl) {
    if (duration != null) {
      callDurationEl.textContent = `Last call duration: ${duration.toFixed(1)}s`;
      callDurationEl.style.display = "block";
    } else {
      callDurationEl.textContent = "";
      callDurationEl.style.display = "none";
    }
  }
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

    // --- Call duration tracking logic ---
    const idle = !!js.idle;
    const callKey = [n.tgid||"", n.source||"", n.freq||"", n.enc||"", n.name||""].join("|");

    // When a call starts, record its details and start time
    if (lastIdle && !idle && callKey) {
      if (autoRemuteTimer) {
        clearTimeout(autoRemuteTimer);
        autoRemuteTimer = null;
      }
      callStartTs = tsSec;
      callStartDetails = {
        freq: n.freq || "",
        tgid: n.tgid || "",
        name: n.name || "",
        source: n.source || "",
        enc: n.enc || ""
      };
      handleMatchedTalkgroup(callStartDetails, callKey);

      // --- Start recording only when audio is playing ---
      if (audio && audio.captureStream) {
        const startRecorder = () => {
          try {
            const stream = audio.captureStream();
            callRecorder = new MediaRecorder(stream);
            callAudioChunks = [];
            callRecorder.ondataavailable = e => { if (e.data.size > 0) callAudioChunks.push(e.data); };
            callRecorder.start();
            callAudioUrl = null;
          } catch (e) {
            console.warn("MediaRecorder error:", e);
            callRecorder = null;
            callAudioChunks = [];
            callAudioUrl = null;
          }
        };
        if (!audio.paused) {
          startRecorder();
        } else {
          // Wait for audio to start playing
          const onPlay = () => {
            startRecorder();
            audio.removeEventListener('playing', onPlay);
          };
          audio.addEventListener('playing', onPlay);
        }
      }
    }

    // When a call ends, append to history
    if (!lastIdle && idle && callStartTs != null && callStartDetails) {
      const callEndTs = lastActiveTs ? lastActiveTs / 1000 : callStartTs;
      const duration = Math.max(0, callEndTs - callStartTs);
      // Allow new notifications for a later call even if it has the same talkgroup/call key.
      lastNotifiedCallKey = "";

      // If we auto-unmuted for this matched call, re-mute after configured delay.
      scheduleAutoRemute();

      const row = {
        time: new Date().toISOString(),
        freq: callStartDetails.freq,
        tgid: callStartDetails.tgid,
        name: callStartDetails.name,
        source: callStartDetails.source,
        enc: callStartDetails.enc,
        duration: duration.toFixed(1) + "s"
      };

      // Only attach audio if duration >= 1s
      if (callRecorder) {
        callRecorder.onstop = () => {
          if (callAudioChunks.length && duration >= 1.0) {
            callAudioUrl = URL.createObjectURL(new Blob(callAudioChunks, {type: "audio/webm"}));
            row.audioUrl = callAudioUrl;
            row.audioBlob = new Blob(callAudioChunks, {type: "audio/webm"});
          }
          let rows = window._histRows || loadHist();
          rows.unshift(row);

          // Revoke blobs for dropped entries
          while (rows.length > MAX_ROWS) {
            const dropped = rows.pop();
            if (dropped && dropped.audioUrl) {
              URL.revokeObjectURL(dropped.audioUrl);
            }
          }
          window._histRows = rows;

          saveHist(rows);
          renderHist(rows);
        };
        callRecorder.stop();
        
      } else {
        let rows = window._histRows || loadHist();
        rows.unshift(row);

        while (rows.length > MAX_ROWS) {
          const dropped = rows.pop();
          if (dropped && dropped.audioUrl) {
            URL.revokeObjectURL(dropped.audioUrl);
          }
        }
        window._histRows = rows;

        saveHist(rows);
        renderHist(rows);
      }
      callStartTs = null;
      callStartDetails = null;
      callRecorder = null;
      callAudioChunks = [];
      callAudioUrl = null;
      return;
    }

    // While a call is active, update the live duration display
    if (!idle && callStartTs != null) {
      updateCallDurationDisplay(tsSec - callStartTs);
    } else if (idle) {
      updateCallDurationDisplay(null);
    }

    // Update lastIdle for next poll
    lastIdle = idle;
  } catch (e) {
    setNet(false);
    setBadgeIdle();
    // don’t immediately wipe fields — lets brief hiccups slide
  }
}

// Merge server short history into local history
async function mergeServerHistory() {
  try {
    const r = await fetch("/api/short_history", {cache: "no-store"});
    if (!r.ok) throw new Error("Failed to fetch server history");
    const js = await r.json();
    if (!js.ok || !Array.isArray(js.history)) return;

    const serverHist = js.history;
    let userHist = loadHist();

    // Find latest timestamp in user history
    const userLatestTs = userHist.length
      ? Date.parse(userHist[0].time) || 0
      : 0;

    // Find latest timestamp in server history
    const serverLatestTs = serverHist.length
      ? Date.parse(serverHist[0].time) || 0
      : 0;

    // Only merge if server has newer calls
    if (serverLatestTs > userLatestTs) {
      // Build a set of unique keys for user history (e.g., time+tgid+name)
      const userKeys = new Set(userHist.map(row =>
        [row.time, row.tgid, row.name, row.freq, row.source, row.enc].join("|")
      ));

      // Only add server calls that are not already in user history and are newer
      const newRows = serverHist.filter(row => {
        const key = [row.time, row.tgid, row.name, row.freq, row.source, row.enc].join("|");
        // Optionally, you can also check duration if you want
        return !userKeys.has(key) &&
               (Date.parse(row.time) || 0) > userLatestTs;
      });

      if (newRows.length) {
        // Prepend new rows to user history
        userHist = [...newRows, ...userHist];
        if (userHist.length > MAX_ROWS) userHist.length = MAX_ROWS;
        saveHist(userHist);
        renderHist(userHist);
      }
    }
  } catch (e) {
    // Ignore errors, fallback to local history only
    console.warn("History merge failed:", e);
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

  if (isFirefox || IS_MOBILE) {
    // Firefox: play through the element; VU via captureStream if possible
    el.muted = false; // element outputs directly (you already control volume via #vol)
    console.log('[AUDIO] direct element playback mode');

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

    // Mobile browsers frequently throttle/suspend background processing.
    // Skip VU analyzer on mobile for better background playback reliability.
    if (!IS_MOBILE) {
      // Start the VU after playback begins (captureStream works best then)
      if (!el.paused) initVuFF(); else el.addEventListener('playing', initVuFF, { once:true });
    }
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
loadAlertSettings();
renderHist(loadHist());
mergeServerHistory();
ensureAudio();           // single, authoritative init
pollLive();
setInterval(pollLive, POLL_MS);
setInterval(updateLastHeard, 1000);
loadTalkgroupCatalog().then(() => {
  const search = document.getElementById("tgSearch");
  const notifySearch = document.getElementById("notifyTgSearch");
  const catSearch = document.getElementById("notifyCategorySearch");
  renderTalkgroupCatalog(search ? search.value : "");
  renderNotifyTalkgroupCatalog(notifySearch ? notifySearch.value : "");
  renderNotifyCategoryTalkgroupCatalog(catSearch ? catSearch.value : "");
});

// ===== Icecast listener count =====
const listenerCountEl = document.getElementById('listenerCount');
const listenerCountNum = document.getElementById("listenerCountNum");
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
    listenerCountNum.textContent = count;
  } catch (e) {
    listenerCountNum.textContent = "—";
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
  document.getElementById("openAlerts")?.addEventListener("click", () => {
    const search = document.getElementById("tgSearch");
    const notifySearch = document.getElementById("notifyTgSearch");
    renderTalkgroupCatalog(search ? search.value : "");
    renderNotifyTalkgroupCatalog(notifySearch ? notifySearch.value : "");
    showPopup("alertsPopup");
  });
  document.getElementById("closeAlerts")?.addEventListener("click", () => hidePopup("alertsPopup"));

  const notifyEnabled = document.getElementById("notifyEnabled");
  const alertProfileSelect = document.getElementById("alertProfileSelect");
  const alertProfileNew = document.getElementById("alertProfileNew");
  const alertProfileSave = document.getElementById("alertProfileSave");
  const alertProfileDelete = document.getElementById("alertProfileDelete");
  const notifySeparateRules = document.getElementById("notifySeparateRules");
  const notifyRulesSection = document.getElementById("notifyRulesSection");
  const notifyTgMode = document.getElementById("notifyTgMode");
  const notifyBurstLimit = document.getElementById("notifyBurstLimit");
  const notifyBurstResetSec = document.getElementById("notifyBurstResetSec");
  const notifyTgSearch = document.getElementById("notifyTgSearch");
  const notifyTgSelectAllVisible = document.getElementById("notifyTgSelectAllVisible");
  const notifyTgClearAll = document.getElementById("notifyTgClearAll");
  const notifyCategoriesEnabled = document.getElementById("notifyCategoriesEnabled");
  const notifyCategoriesSection = document.getElementById("notifyCategoriesSection");
  const notifyCategorySelect = document.getElementById("notifyCategorySelect");
  const notifyCategoryNew = document.getElementById("notifyCategoryNew");
  const notifyCategoryDelete = document.getElementById("notifyCategoryDelete");
  const notifyCategoryBehavior = document.getElementById("notifyCategoryBehavior");
  const notifyCategoryMode = document.getElementById("notifyCategoryMode");
  const notifyCategorySearch = document.getElementById("notifyCategorySearch");
  const notifyCategorySelectAllVisible = document.getElementById("notifyCategorySelectAllVisible");
  const notifyCategoryClearAll = document.getElementById("notifyCategoryClearAll");
  const autoUnmuteEnabled = document.getElementById("autoUnmuteEnabled");
  const autoRemuteDelaySec = document.getElementById("autoRemuteDelaySec");
  const tgMode = document.getElementById("tgMode");
  const tgSearch = document.getElementById("tgSearch");
  const requestNotifyPermission = document.getElementById("requestNotifyPermission");
  const tgSelectAllVisible = document.getElementById("tgSelectAllVisible");
  const tgClearAll = document.getElementById("tgClearAll");

  function refreshProfileSelect() {
    if (!alertProfileSelect) return;
    const names = Object.keys(alertProfiles).sort((a, b) => a.localeCompare(b));
    alertProfileSelect.innerHTML = names
      .map(name => `<option value="${name.replace(/"/g, "&quot;")}">${name}</option>`)
      .join("");
    alertProfileSelect.value = activeAlertProfile;
  }

  function applyAlertSettingsToControls() {
    ensureActiveNotifyCategory();
    if (notifyEnabled) notifyEnabled.checked = !!alertSettings.notifyEnabled;
    if (notifySeparateRules) notifySeparateRules.checked = !!alertSettings.notifySeparateRules;
    if (notifyTgMode) notifyTgMode.value = alertSettings.notifyTgMode;
    if (notifyBurstLimit) notifyBurstLimit.value = String(alertSettings.notifyBurstLimit);
    if (notifyBurstResetSec) notifyBurstResetSec.value = String(alertSettings.notifyBurstResetSec);
    if (notifyCategoriesEnabled) notifyCategoriesEnabled.checked = !!alertSettings.notifyCategoriesEnabled;
    if (autoUnmuteEnabled) autoUnmuteEnabled.checked = !!alertSettings.autoUnmuteEnabled;
    if (autoRemuteDelaySec) autoRemuteDelaySec.value = String(alertSettings.autoRemuteDelaySec);
    if (tgMode) tgMode.value = alertSettings.tgMode;
    if (notifyRulesSection) notifyRulesSection.style.display = alertSettings.notifySeparateRules ? "block" : "none";
    if (notifyCategoriesSection) notifyCategoriesSection.style.display = alertSettings.notifyCategoriesEnabled ? "block" : "none";
    if (notifyCategorySelect) {
      const categories = Array.isArray(alertSettings.notifyCategories) ? alertSettings.notifyCategories : [];
      notifyCategorySelect.innerHTML = categories
        .map(c => `<option value="${String(c.name).replace(/"/g, "&quot;")}">${c.name}</option>`)
        .join("");
      notifyCategorySelect.value = activeNotifyCategoryName;
    }
    const activeCategory = getActiveNotifyCategory();
    if (notifyCategoryBehavior) notifyCategoryBehavior.value = activeCategory ? activeCategory.behavior : "standard";
    if (notifyCategoryMode) notifyCategoryMode.value = activeCategory ? activeCategory.mode : "whitelist";
    renderTalkgroupCatalog(tgSearch ? tgSearch.value : "");
    renderNotifyTalkgroupCatalog(notifyTgSearch ? notifyTgSearch.value : "");
    renderNotifyCategoryTalkgroupCatalog(notifyCategorySearch ? notifyCategorySearch.value : "");
    updateSelectedSummary();
    refreshProfileSelect();
  }

  function switchAlertProfile(name) {
    if (!name || !alertProfiles[name]) return;
    activeAlertProfile = name;
    alertSettings = {...alertProfiles[name]};
    clearNotifyBurstState();
    persistAlertProfiles();
    applyAlertSettingsToControls();
  }

  alertProfileSelect?.addEventListener("change", () => {
    switchAlertProfile(alertProfileSelect.value);
  });

  alertProfileNew?.addEventListener("click", () => {
    const proposed = window.prompt("New profile name:", "New Profile");
    const name = String(proposed || "").trim();
    if (!name) return;
    if (alertProfiles[name]) {
      window.alert("A profile with that name already exists.");
      return;
    }
    alertProfiles[name] = normalizeAlertSettings(alertSettings);
    switchAlertProfile(name);
  });

  alertProfileSave?.addEventListener("click", () => {
    saveAlertSettings();
    refreshProfileSelect();
  });

  alertProfileDelete?.addEventListener("click", () => {
    const names = Object.keys(alertProfiles);
    if (names.length <= 1) {
      window.alert("At least one profile must remain.");
      return;
    }
    if (!window.confirm(`Delete profile '${activeAlertProfile}'?`)) return;
    delete alertProfiles[activeAlertProfile];
    const next = Object.keys(alertProfiles).sort((a, b) => a.localeCompare(b))[0];
    switchAlertProfile(next);
  });

  applyAlertSettingsToControls();

  notifyEnabled?.addEventListener("change", () => {
    alertSettings.notifyEnabled = !!notifyEnabled.checked;
    saveAlertSettings();
  });

  notifySeparateRules?.addEventListener("change", () => {
    alertSettings.notifySeparateRules = !!notifySeparateRules.checked;
    if (notifyRulesSection) notifyRulesSection.style.display = alertSettings.notifySeparateRules ? "block" : "none";
    saveAlertSettings();
    updateSelectedSummary();
  });

  notifyCategoriesEnabled?.addEventListener("change", () => {
    alertSettings.notifyCategoriesEnabled = !!notifyCategoriesEnabled.checked;
    if (notifyCategoriesSection) notifyCategoriesSection.style.display = alertSettings.notifyCategoriesEnabled ? "block" : "none";
    saveAlertSettings();
  });

  notifyCategorySelect?.addEventListener("change", () => {
    activeNotifyCategoryName = notifyCategorySelect.value;
    applyAlertSettingsToControls();
  });

  notifyCategoryNew?.addEventListener("click", () => {
    const proposed = window.prompt("New category name:", "Category");
    const name = String(proposed || "").trim();
    if (!name) return;
    const categories = Array.isArray(alertSettings.notifyCategories) ? alertSettings.notifyCategories : [];
    if (categories.some(c => c.name === name)) {
      window.alert("A category with that name already exists.");
      return;
    }
    categories.push({name, behavior: "standard", mode: "whitelist", selectedTgids: []});
    alertSettings.notifyCategories = categories;
    activeNotifyCategoryName = name;
    alertSettings.notifyCategoriesEnabled = true;
    saveAlertSettings();
    applyAlertSettingsToControls();
  });

  notifyCategoryDelete?.addEventListener("click", () => {
    const categories = Array.isArray(alertSettings.notifyCategories) ? alertSettings.notifyCategories : [];
    const active = getActiveNotifyCategory();
    if (!active) return;
    if (!window.confirm(`Delete category '${active.name}'?`)) return;
    alertSettings.notifyCategories = categories.filter(c => c.name !== active.name);
    ensureActiveNotifyCategory();
    saveAlertSettings();
    applyAlertSettingsToControls();
  });

  notifyCategoryBehavior?.addEventListener("change", () => {
    const active = getActiveNotifyCategory();
    if (!active) return;
    active.behavior = notifyCategoryBehavior.value === "priority" || notifyCategoryBehavior.value === "quiet"
      ? notifyCategoryBehavior.value
      : "standard";
    saveAlertSettings();
  });

  notifyCategoryMode?.addEventListener("change", () => {
    const active = getActiveNotifyCategory();
    if (!active) return;
    active.mode = notifyCategoryMode.value === "blacklist" ? "blacklist" : "whitelist";
    saveAlertSettings();
  });

  notifyCategorySearch?.addEventListener("input", () => {
    renderNotifyCategoryTalkgroupCatalog(notifyCategorySearch.value);
  });

  notifyTgMode?.addEventListener("change", () => {
    alertSettings.notifyTgMode = notifyTgMode.value === "blacklist" ? "blacklist" : "whitelist";
    saveAlertSettings();
  });

  notifyBurstLimit?.addEventListener("input", () => {
    const val = Math.max(1, Math.min(20, Number(notifyBurstLimit.value) || 2));
    alertSettings.notifyBurstLimit = val;
    notifyBurstLimit.value = String(val);
    clearNotifyBurstState();
    saveAlertSettings();
  });

  notifyBurstResetSec?.addEventListener("input", () => {
    const val = Math.max(5, Math.min(3600, Number(notifyBurstResetSec.value) || 45));
    alertSettings.notifyBurstResetSec = val;
    notifyBurstResetSec.value = String(val);
    clearNotifyBurstState();
    saveAlertSettings();
  });

  autoUnmuteEnabled?.addEventListener("change", () => {
    alertSettings.autoUnmuteEnabled = !!autoUnmuteEnabled.checked;
    if (!alertSettings.autoUnmuteEnabled && autoRemuteTimer) {
      clearTimeout(autoRemuteTimer);
      autoRemuteTimer = null;
      autoUnmutedForActiveCall = false;
    }
    saveAlertSettings();
  });

  autoRemuteDelaySec?.addEventListener("input", () => {
    const val = Math.max(0, Math.min(300, Number(autoRemuteDelaySec.value) || 0));
    alertSettings.autoRemuteDelaySec = val;
    autoRemuteDelaySec.value = String(val);
    saveAlertSettings();
  });

  tgMode?.addEventListener("change", () => {
    alertSettings.tgMode = tgMode.value === "blacklist" ? "blacklist" : "whitelist";
    saveAlertSettings();
  });

  tgSearch?.addEventListener("input", () => {
    renderTalkgroupCatalog(tgSearch.value);
  });

  notifyTgSearch?.addEventListener("input", () => {
    renderNotifyTalkgroupCatalog(notifyTgSearch.value);
  });

  tgSelectAllVisible?.addEventListener("click", () => {
    const checks = document.querySelectorAll("#tgCatalog .tg-check");
    const set = new Set(alertSettings.selectedTgids);
    checks.forEach(cb => {
      const tgid = normalizeTgid(cb.getAttribute("data-tgid"));
      set.add(tgid);
      cb.checked = true;
    });
    alertSettings.selectedTgids = Array.from(set);
    saveAlertSettings();
    updateSelectedSummary();
  });

  tgClearAll?.addEventListener("click", () => {
    alertSettings.selectedTgids = [];
    saveAlertSettings();
    renderTalkgroupCatalog(tgSearch ? tgSearch.value : "");
  });

  notifyTgSelectAllVisible?.addEventListener("click", () => {
    const checks = document.querySelectorAll("#notifyTgCatalog .tg-check");
    const set = new Set(alertSettings.notifySelectedTgids);
    checks.forEach(cb => {
      const tgid = normalizeTgid(cb.getAttribute("data-tgid"));
      set.add(tgid);
      cb.checked = true;
    });
    alertSettings.notifySelectedTgids = Array.from(set);
    saveAlertSettings();
    updateSelectedSummary();
  });

  notifyTgClearAll?.addEventListener("click", () => {
    alertSettings.notifySelectedTgids = [];
    saveAlertSettings();
    renderNotifyTalkgroupCatalog(notifyTgSearch ? notifyTgSearch.value : "");
  });

  notifyCategorySelectAllVisible?.addEventListener("click", () => {
    const active = getActiveNotifyCategory();
    if (!active) return;
    const checks = document.querySelectorAll("#notifyCategoryCatalog .tg-check");
    const set = new Set(active.selectedTgids || []);
    checks.forEach(cb => {
      const tgid = normalizeTgid(cb.getAttribute("data-tgid"));
      set.add(tgid);
      cb.checked = true;
    });
    active.selectedTgids = Array.from(set);
    saveAlertSettings();
    updateSelectedSummary();
  });

  notifyCategoryClearAll?.addEventListener("click", () => {
    const active = getActiveNotifyCategory();
    if (!active) return;
    active.selectedTgids = [];
    saveAlertSettings();
    renderNotifyCategoryTalkgroupCatalog(notifyCategorySearch ? notifyCategorySearch.value : "");
  });

  requestNotifyPermission?.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("This browser does not support notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      alertSettings.notifyEnabled = true;
      if (notifyEnabled) notifyEnabled.checked = true;
      saveAlertSettings();
    }
  });

  updateSelectedSummary();

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

  // ===== Update Notification =====
  function checkForUpdate() {
    const VERSION_KEY = "op25_last_seen_version";
    fetch("/static/version.json", {cache: "no-store"})
      .then(r => r.json())
      .then(ver => {
        let userVersion = localStorage.getItem(VERSION_KEY);
        let latestVersion = ver.version;

        // If the user is on the latest version, update localStorage
        if (userVersion !== latestVersion) {
          if (!userVersion || window.__op25_latest_version === undefined) {
            localStorage.setItem(VERSION_KEY, latestVersion);
            userVersion = latestVersion;
          }
        }

        window.__op25_current_version = userVersion;
        window.__op25_latest_version = latestVersion;

        const outdatedWarning = document.getElementById("outdatedWarning");
        if (!outdatedWarning) return;

        if (latestVersion !== userVersion) {
          // Outdated: always show prominent warning
          outdatedWarning.style.display = "block";
          outdatedWarning.textContent = "You are viewing an outdated version. Please refresh the page to update.";
          outdatedWarning.classList.remove("muted");

          // Show update banner if not already visible
          const notice = document.getElementById("updateNotice");
          if (notice && notice.style.display !== "block") {
            notice.querySelectorAll("span").forEach(span => span.remove());
            const msg = document.createElement("span");
            msg.textContent = ver.message || "A new version is available!";
            notice.insertBefore(msg, notice.firstChild);

            notice.style.display = "block";
            setTimeout(()=>{ notice.style.display = "none"; }, 10000);
          }
        } else {
          // Up to date: show subtle version info
          outdatedWarning.style.display = "block";
          outdatedWarning.textContent = `Version: ${latestVersion}`;
          outdatedWarning.classList.add("muted");
          localStorage.setItem(VERSION_KEY, latestVersion);
        }
      })
      .catch(()=>{
        const outdatedWarning = document.getElementById("outdatedWarning");
        if (outdatedWarning) outdatedWarning.style.display = "none";
      });
  }

  // Initial check
  checkForUpdate();
  // Check every 30 seconds
  setInterval(checkForUpdate, 30000);

  document.getElementById("updateNoticeClose")?.addEventListener("click", function() {
    document.getElementById("updateNotice").style.display = "none";
    // No need to manually set the warning here; checkForUpdate will handle it every 30s
  });
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

// Tab switching
const histTableWrap = document.getElementById("historyTableWrap");
const statsPanel = document.getElementById("statsPanel");
const showHistoryTab = document.getElementById("showHistoryTab");
const showStatsTab = document.getElementById("showStatsTab");

showHistoryTab?.addEventListener("click", () => {
  showHistoryTab.classList.add("active");
  showStatsTab.classList.remove("active");
  statsPanel.style.display = "none";
  histTableWrap.style.display = "";
});
showStatsTab?.addEventListener("click", () => {
  showStatsTab.classList.add("active");
  showHistoryTab.classList.remove("active");
  statsPanel.style.display = "";
  histTableWrap.style.display = "none";
  pollStats("today");
});

// Today/Yesterday toggle
const showTodayStats = document.getElementById("showTodayStats");
const showYesterdayStats = document.getElementById("showYesterdayStats");
showTodayStats?.addEventListener("click", () => {
  showTodayStats.classList.add("active");
  showYesterdayStats.classList.remove("active");
  pollStats("today");
});
showYesterdayStats?.addEventListener("click", () => {
  showYesterdayStats.classList.add("active");
  showTodayStats.classList.remove("active");
  pollStats("yesterday");
});

// Poll stats and update graphs
let statsPollInterval = null;
function pollStats(which) {
  clearInterval(statsPollInterval);
  const url = which === "yesterday" ? "/api/stats_yesterday" : "/api/stats_today";
  async function fetchAndDraw() {
    const r = await fetch(url, {cache:"no-store"});
    const js = await r.json();
    if (!js.ok || !js.stats) return;
    drawStatsGraphs(js.stats);
  }
  fetchAndDraw();
  statsPollInterval = setInterval(fetchAndDraw, 5000);
}

// Chart.js integration
let statsCallsChart = null;
let statsAirtimeChart = null;

function getTgBarColor(name, theme) {
  // Use the same logic as your badge classes
  if (/EMS/i.test(name))      return theme === "light" ? "#ffb84d" : "#ffab3de6";
  if (/PD/i.test(name))       return theme === "light" ? "#009dff" : "#2e8dccd2";
  if (/FD/i.test(name))       return theme === "light" ? "#ff3d3d" : "#ff3d3dd0";
  if (/DOT/i.test(name))      return theme === "light" ? "#b86bff" : "#b86bffcb";
  if (/DNR/i.test(name))      return theme === "light" ? "#4dff5c" : "#4dff65be";
  if (/AST/i.test(name))      return theme === "light" ? "#4d71ff" : "#4d68ffbd";
  return theme === "light" ? "#0078d7" : "#3dd6ff";
}

function drawStatsGraphs(stats) {
  const callsCanvas = document.getElementById("statsCalls");
  const airtimeCanvas = document.getElementById("statsAirtime");
  if (!callsCanvas || !airtimeCanvas) return;
  const tgids = Object.entries(stats.tgids || {});
  // Sort by call count descending
  const sorted = tgids.sort((a, b) => b[1].count - a[1].count);
  const labels = sorted.map(([_, d]) => d.name || "");
  const counts = sorted.map(([tgid, d]) => d.count);
  const airtimes = sorted.map(([tgid, d]) => d.airtime);

  // Get theme
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  const barColors = sorted.map(([_, d]) => getTgBarColor(d.name || "", theme));

  if (window.Chart) {
    // Calls chart
    if (statsCallsChart) statsCallsChart.destroy();
    statsCallsChart = new Chart(callsCanvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Calls Today',
          data: counts,
          backgroundColor: barColors,
          borderColor: barColors,
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        animation: { duration: 700 },
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Calls Today', color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' }
        },
        scales: {
          x: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' } },
          y: { beginAtZero: true, ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' } }
        }
      }
    });

    // Airtime chart
    if (statsAirtimeChart) statsAirtimeChart.destroy();
    statsAirtimeChart = new Chart(airtimeCanvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Airtime (s) Today',
          data: airtimes,
          backgroundColor: barColors,
          borderColor: barColors,
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        animation: { duration: 700 },
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Airtime (s) Today', color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' }
        },
        scales: {
          x: { ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' } },
          y: { beginAtZero: true, ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e6e6e6' } }
        }
      }
    });
  } else {
    // Fallback: static bar graph
    drawBarGraph(callsCanvas, labels, counts, "Calls Today");
    drawBarGraph(airtimeCanvas, labels, airtimes, "Airtime (s) Today");
  }
}

// Draw bar graphs (simple, no external libs)
function drawBarGraph(canvas, labels, values, title) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height;

  // Use CSS variables for theme colors
  const style = getComputedStyle(document.documentElement);
  const fg = style.getPropertyValue('--fg') || '#e6e6e6';
  const accent = style.getPropertyValue('--accent') || '#3dd6ff';
  const band = style.getPropertyValue('--band') || '#1a1d23';

  ctx.font = "14px sans-serif";
  ctx.fillStyle = fg;
  ctx.fillText(title, 8, 18);
  if (!values.length) {
    ctx.fillText("No data", 8, 40);
    return;
  }
  const maxVal = Math.max(...values, 1);
  const barH = 22, gap = 8, leftPad = 140, topPad = 32;
  for (let i = 0; i < values.length; ++i) {
    const y = topPad + i * (barH + gap);
    const barW = Math.round((w - leftPad - 16) * (values[i] / maxVal));
    ctx.fillStyle = accent;
    ctx.fillRect(leftPad, y, barW, barH);
    ctx.fillStyle = fg;
    ctx.fillText(labels[i], 8, y + barH * 0.7);
    ctx.fillText(values[i].toFixed(1), leftPad + barW + 8, y + barH * 0.7);
  }
}

// ===== Live recording =====
// (Experimental: not yet wired to UI)

// Audio recorder setup
let callRecorder = null;
let callAudioChunks = [];
let callAudioUrl = null;

// Toggle recording
async function toggleRecording() {
  if (callRecorder) {
    // Stop recording
    callRecorder.stop();
    callRecorder = null;
    return;
  }

  // Start recording
  const stream = audio.captureStream();
  const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  callRecorder = mediaRecorder;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) callAudioChunks.push(e.data);
    };
  }
