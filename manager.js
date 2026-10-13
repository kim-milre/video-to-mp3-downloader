// 수집함 화면: 목록/설정 UI만 담당합니다. 실제 변환은 offscreen.js(백그라운드)가 처리하므로
// 이 페이지를 새로고침하거나 닫아도 작업은 계속됩니다.
const $ = (id) => document.getElementById(id);
const PRESETS = {
  voice: { sampleRate: 22050, mono: true, kbps: 64, quality: 7 },
  std: { sampleRate: 44100, mono: false, kbps: 128, quality: 5 },
};

let library = [];
let done = {};                       // 완료된 url (background가 관리)
let ui = { names: {}, subdir: "" };  // 파일명/하위 폴더 설정
const rows = new Map();              // url -> { el, chk, name, bar, st, sub }
let dirHandle = null;

const sanitize = (s) => (s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 100);
const fmt = (b) => (b ? (b / 1048576).toFixed(1) + " MB" : "크기 미상");
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const saveUi = () => chrome.storage.local.set({ ui });
const isDone = (u) => !!done[u];
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: "offscreen", ...msg });

function defaultName(m) {
  if (ui.names[m.url]) return ui.names[m.url];
  const t = sanitize(m.title);
  if (t) return t;
  try { return sanitize(decodeURIComponent(new URL(m.url).pathname.split("/").pop()).replace(/\.[^.]+$/, "")) || "audio"; } catch { return "audio"; }
}

// ---- IndexedDB (폴더 핸들 보관; offscreen도 같은 저장소를 읽음) ----
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open("mp3dl", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const req = fn(db.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
const idbGet = (k) => idbOp("readonly", (s) => s.get(k));
const idbSet = (k, v) => idbOp("readwrite", (s) => s.put(v, k));
const idbDel = (k) => idbOp("readwrite", (s) => s.delete(k));

// ---- 행(row) 관리 ----
function setRow(url, text, pct, cls = "") {
  const r = rows.get(url);
  if (!r) return;
  r.st.textContent = text;
  r.st.className = "st " + cls;
  if (pct != null) r.bar.value = pct;
}

function place(url) {
  const r = rows.get(url);
  if (!r) return;
  const d = isDone(url);
  r.el.classList.toggle("done", d);
  if (d) $("doneList").prepend(r.el); else $("list").appendChild(r.el);
}

function makeRow(m) {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `<div class="lead"><input type="checkbox" class="chk"><button class="redo" title="다시 변환 대기열로">↩</button></div>
    <div><input class="name"><div class="sub"></div></div>
    <div><progress max="100" value="0"></progress><div class="st">대기</div></div>
    <button class="rm" title="목록에서 삭제">✕</button>`;
  const r = { el, chk: el.querySelector(".chk"), name: el.querySelector(".name"), bar: el.querySelector("progress"), st: el.querySelector(".st"), sub: el.querySelector(".sub") };
  r.name.value = defaultName(m);
  r.name.onchange = () => { ui.names[m.url] = r.name.value; saveUi(); };
  r.sub.textContent = `${fmt(m.size)} · ${hostOf(m.url)}`;
  el.querySelector(".rm").onclick = () => {
    toOffscreen({ type: "cancel", urls: [m.url] }).catch(() => {});
    chrome.runtime.sendMessage({ type: "remove", urls: [m.url] });
  };
  r.chk.onchange = updateSummary;
  el.querySelector(".redo").onclick = () => chrome.runtime.sendMessage({ type: "undone", url: m.url });
  r.chk.checked = !isDone(m.url);
  rows.set(m.url, r);
  if (isDone(m.url)) setRow(m.url, "완료", 100, "done");
  return r;
}

function sync() {
  const urls = new Set(library.map((m) => m.url));
  for (const [u, r] of rows) if (!urls.has(u)) { r.el.remove(); rows.delete(u); }
  for (const m of library) {
    if (!rows.has(m.url)) { makeRow(m); place(m.url); }
    else rows.get(m.url).sub.textContent = `${fmt(m.size)} · ${hostOf(m.url)}`;
  }
  updateSummary();
}

// 완료 목록(done)이 바뀌면 행을 위/아래 구역으로 이동
function applyDone() {
  for (const [u, r] of rows) {
    const d = isDone(u);
    if (r.el.classList.contains("done") !== d) {
      if (d) { r.chk.checked = false; if (!r.st.classList.contains("done")) setRow(u, "완료", 100, "done"); }
      else { r.chk.checked = true; setRow(u, "대기", 0); }
      place(u);
    }
  }
  updateSummary();
}

function updateSummary() {
  const pending = library.filter((m) => !isDone(m.url));
  const doneN = library.length - pending.length;
  const sel = pending.filter((m) => rows.get(m.url)?.chk.checked).length;
  $("sum").textContent = `총 ${library.length}개 · 대기 ${pending.length}개 (선택 ${sel}개) · 완료 ${doneN}개`;
  $("pendTitle").textContent = `대기 / 진행 중 (${pending.length})`;
  $("doneTitle").textContent = `✅ 완료 (${doneN})`;
  $("doneBox").style.display = doneN ? "" : "none";
  $("empty").style.display = pending.length ? "none" : "";
}

// ---- 저장 위치 ----
function renderDest() {
  $("destName").textContent = dirHandle ? "📁 " + dirHandle.name : "기본 다운로드 폴더";
  $("subWrap").style.display = dirHandle ? "none" : "";
  $("resetDir").style.display = dirHandle ? "" : "none";
}

async function ensureDirPermission() {
  if (!dirHandle) return true;
  let p = await dirHandle.queryPermission({ mode: "readwrite" });
  if (p !== "granted") p = await dirHandle.requestPermission({ mode: "readwrite" });
  return p === "granted";
}

// ---- 변환 시작 (실제 작업은 백그라운드에 위임) ----
async function start() {
  const todo = library.filter((m) => !isDone(m.url) && rows.get(m.url)?.chk.checked);
  if (!todo.length) return;
  if (!(await ensureDirPermission())) { alert("선택한 폴더에 쓰기 권한이 필요합니다. 폴더를 다시 선택하거나 기본 폴더로 전환하세요."); return; }

  const ready = await chrome.runtime.sendMessage({ type: "ensureOffscreen" });
  if (!ready?.ok) { alert("백그라운드 처리기를 시작하지 못했습니다: " + (ready?.error || "")); return; }

  const pad = Math.max(2, String(todo.length).length);
  const jobs = todo.map((m, i) => {
    const base = sanitize(rows.get(m.url).name.value) || "audio";
    return { url: m.url, referer: m.referer, base: $("num").checked ? String(i + 1).padStart(pad, "0") + "_" + base : base };
  });
  await toOffscreen({ type: "start", jobs, preset: PRESETS[$("preset").value], conc: +$("conc").value, connections: +$("lanes").value, dirMode: !!dirHandle, subdir: ui.subdir || "" });
  $("stop").disabled = false;
}

// ---- 이벤트 ----
$("start").onclick = start;
$("stop").onclick = async () => { await toOffscreen({ type: "stop" }).catch(() => {}); $("stop").disabled = true; };
$("clear").onclick = () => {
  if (!confirm("수집된 목록을 모두 비울까요? (진행 중인 작업도 취소됩니다)")) return;
  toOffscreen({ type: "cancel", urls: library.map((m) => m.url) }).catch(() => {});
  chrome.runtime.sendMessage({ type: "clear" });
};
$("clearDone").onclick = () => {
  const urls = library.filter((m) => isDone(m.url)).map((m) => m.url);
  if (urls.length) chrome.runtime.sendMessage({ type: "remove", urls });
};
$("all").onchange = (e) => { rows.forEach((r, u) => { if (!isDone(u)) r.chk.checked = e.target.checked; }); updateSummary(); };

$("pick").onclick = async () => {
  try {
    const h = await showDirectoryPicker({ mode: "readwrite" });
    dirHandle = h;
    await idbSet("dir", h);
    renderDest();
  } catch (e) {
    if (e.name !== "AbortError") alert("이 폴더는 선택할 수 없습니다. (다운로드/바탕화면/문서 폴더 자체는 막혀 있으니 그 안에 새 폴더를 만들어 선택하세요)");
  }
};
$("resetDir").onclick = async () => { dirHandle = null; await idbDel("dir"); renderDest(); };
$("subdir").onchange = () => { ui.subdir = $("subdir").value; saveUi(); };

// 백그라운드 진행 상황 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "progress") return;
  if (msg.url) setRow(msg.url, msg.text, msg.pct, msg.cls);
  $("stop").disabled = !msg.running;
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.library) { library = ch.library.newValue || []; sync(); }
  if (ch.done) { done = ch.done.newValue || {}; applyDone(); }
});

(async () => {
  const s = await chrome.storage.local.get(["library", "done", "ui"]);
  library = s.library || [];
  done = s.done || {};
  ui = Object.assign({ names: {}, subdir: "" }, s.ui);
  // 2.1 이하 버전의 완료 기록 이전
  if (ui.done && Object.keys(ui.done).length) {
    await chrome.runtime.sendMessage({ type: "markDone", urls: Object.keys(ui.done) });
    Object.keys(ui.done).forEach((u) => (done[u] = true));
    delete ui.done;
    saveUi();
  }
  $("subdir").value = ui.subdir || "";
  try { dirHandle = (await idbGet("dir")) || null; } catch { dirHandle = null; }
  renderDest();
  sync();

  // 새로고침 직후: 백그라운드에서 진행 중인 작업 상태를 다시 가져옴
  try {
    const st = await toOffscreen({ type: "getState" });
    if (st) {
      for (const [u, v] of Object.entries(st.states)) if (rows.has(u)) setRow(u, v.text, v.pct, v.cls);
      $("stop").disabled = !st.running;
    }
  } catch {}
})();
