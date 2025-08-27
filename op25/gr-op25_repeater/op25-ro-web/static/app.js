const audio = document.getElementById("audio");
const netDot = document.getElementById("netDot");
const histTbd = document.getElementById("histBody");
const dlCsv = document.getElementById("dlCsv");

const nowTg  = document.getElementById("nowTg");
const nowNm  = document.getElementById("nowName");
const nowFq  = document.getElementById("nowFreq");
const nowSrc = document.getElementById("nowSrc");
const nowEnc = document.getElementById("nowEnc");

const POLL_MS_ICE = 2000;
const POLL_MS_OP  = 2000;

function setNet(ok){ netDot.classList.toggle("ok", !!ok); }

function tgColorFromId(id){
  const n = parseInt(id||"0",10);
  const h = (n * 137) % 360;
  return `hsl(${h} 85% 60%)`;
}

function pushHistory(row){
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${row.time}</td>
    <td>${row.freq||""}</td>
    <td><span class="tg-chip" style="color:${tgColorFromId(row.tgid)}"></span>${row.tgid||""}</td>
    <td>${row.name||""}</td>
    <td>${row.source||""}</td>
    <td>${row.enc||""}</td>`;
  histTbd.prepend(tr);
  while(histTbd.children.length>500) histTbd.lastChild.remove();
}

function setNowFromTitle(title){
  const t = { tgid:"", name:"", freq:"", source:"", enc:"" };
  const s = title || "";
  const tg = s.match(/TG[:\s]+(\d+)/i); if(tg) t.tgid = tg[1];
  const fq = s.match(/(\d{3}\.\d{3,6})/); if(fq) t.freq = fq[1];
  const nm = s.match(/\(([^)]+)\)|Name[:\s]+([^|\[]+)/i);
  if(nm) t.name = (nm[1] || nm[2] || "").trim();
  const sr = s.match(/ID[:\s]+(\d+)/i); if(sr) t.source = sr[1];
  const en = s.match(/\bENC[:\s]*([YN01])\b/i);
  if(en) t.enc = (en[1].toUpperCase()==="Y" || en[1]=="1")?"Y":"N";

  nowTg.textContent  = t.tgid || "—";
  nowNm.textContent  = t.name || "—";
  nowFq.textContent  = t.freq || "—";
  nowSrc.textContent = t.source || "—";
  nowEnc.textContent = t.enc || "—";

  const key = `${t.tgid}|${t.source}|${t.freq}|${t.enc}`;
  if(key && key !== setNowFromTitle._last){
    setNowFromTitle._last = key;
    pushHistory({ time:new Date().toLocaleTimeString(), freq:t.freq, tgid:t.tgid, name:t.name, source:t.source, enc:t.enc });
  }
}

async function pollIcecast(){
  try{
    const r = await fetch("/api/icecast", {cache:"no-store"});
    const js = await r.json();
    if(!js.ok) throw new Error(js.error||"icecast");
    setNet(true);
    // Set audio source once when we discover the listenurl for the configured mount
    const srcs = js.data?.icestats?.source;
    const arr = Array.isArray(srcs) ? srcs : [srcs];
    const mount = arr.find(s => (s?.listenurl||"").includes(js.mount));
    if(mount && !audio.src) audio.src = mount.listenurl;
    // Also derive "now" from Icecast title (works when OP25 injects metadata)
    setNowFromTitle((mount||{}).title||"");
  }catch(e){
    setNet(false);
  }
}

async function pollOp25(){
  // Mirror the OP25 UI’s read-only update feed (messages like "channel_update")
  try{
    const r = await fetch("/api/op25", {cache:"no-store"});
    const js = await r.json();
    if(!js.ok) return; // Still fine; Icecast polling covers now-playing
    const msgs = js.data || [];
    // If you want, you could extract details from channel_update here to augment history.
    // We keep this simple and rely on Icecast title for consistency.
  }catch(e){}
}

function toCsv(){
  const rows = [["Time","Freq","TGID","Name","Source","Enc"]];
  [...histTbd.children].forEach(tr => {
    const cols = [...tr.children].map(td=>td.innerText.replace(/\n/g," ").trim());
    rows.push(cols);
  });
  const blob = new Blob([rows.map(r=>r.map(x=>`"${x.replace(/"/g,'""')}"`).join(",")).join("\n")], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="scanner_history.csv"; a.click();
  URL.revokeObjectURL(url);
}
dlCsv.addEventListener("click", toCsv);

setInterval(pollIcecast, POLL_MS_ICE);
setInterval(pollOp25,  POLL_MS_OP);
pollIcecast(); pollOp25();
