// 변환 작업을 수집함 페이지와 분리해서 계속 실행하는 백그라운드 문서.
// 수집함 탭을 새로고침/닫아도 이 문서는 살아 있어 작업이 이어집니다.
const MB = 1048576;
const SEG_SEC = 240; // 긴 오디오를 이 길이로 나눠 여러 코어에서 동시에 인코딩
const POOL = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

const bg = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);
const sanitize = (s) => (s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 100);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- 상태 ----------
const states = new Map();   // url -> {text,pct,cls}
const lastSent = new Map();
const canceled = new Set();
const queued = new Set();   // 대기/진행 중인 url
const queue = [];
let active = 0, conc = 2, ruleSeq = Math.floor(Math.random() * 1e8) + 1000;
let saveLock = Promise.resolve();

const isRunning = () => active > 0 || queue.length > 0;

function emit(url, text, pct, cls = "", force = false) {
  states.set(url, { text, pct, cls });
  const now = Date.now();
  if (!force && now - (lastSent.get(url) || 0) < 250) return;
  lastSent.set(url, now);
  bg({ type: "progress", url, text, pct, cls, running: isRunning() });
}

class Canceled extends Error {}
const check = (url) => { if (canceled.has(url)) throw new Canceled("취소됨"); };

// ---------- 다운로드 (가능하면 여러 연결로 병렬) ----------
async function fetchSingle(url, onProgress, url0) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("다운로드 실패 (HTTP " + res.status + ")");
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    check(url0);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  return new Blob(chunks).arrayBuffer();
}

async function fetchParallel(url, total, onProgress, url0, lanes) {
  const CH = 4 * MB;
  const n = Math.ceil(total / CH);
  const LANES = Math.max(1, Math.min(lanes, n));
  const buf = new Uint8Array(total);
  let next = 0, got = 0;
  const lane = async () => {
    while (next < n) {
      check(url0);
      const i = next++;
      const start = i * CH, end = Math.min(total - 1, start + CH - 1);
      for (let tries = 0; ; tries++) {
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: "include" });
          if (r.status !== 206) throw new Error("range");
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length !== end - start + 1) throw new Error("size");
          buf.set(b, start);
          got += b.length;
          onProgress(got, total);
          break;
        } catch (e) { if (tries >= 1) throw e; }
      }
    }
  };
  await Promise.all(Array.from({ length: LANES }, lane));
  return buf.buffer;
}

async function fetchBuffer(url, onProgress, lanes, onMode) {
  let total = 0;
  try {
    const p = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "include" });
    if (p.status === 206) total = parseInt((p.headers.get("content-range") || "").split("/")[1]) || 0;
    try { await p.body?.cancel(); } catch {}
  } catch {}
  if (lanes > 1 && total > 8 * MB) {
    try { onMode(` [병렬 ${Math.min(lanes, Math.ceil(total / (4 * MB)))}연결]`); return await fetchParallel(url, total, onProgress, url, lanes); }
    catch (e) { if (e instanceof Canceled) throw e; /* 실패하면 단일 연결로 재시도 */ }
  }
  onMode(total ? " [단일 연결]" : " [단일 연결·서버가 분할 요청 미지원]");
  return fetchSingle(url, onProgress, url);
}

// ---------- 인코더 풀 ----------
const idle = [], waiting = [];
let created = 0;
const newWorker = () => { created++; return new Worker("encoder-worker.js"); };
function getWorker() {
  return new Promise((res) => {
    if (idle.length) return res(idle.pop());
    if (created < POOL) return res(newWorker());
    waiting.push(res);
  });
}
function releaseWorker(w, broken) {
  if (broken) { w.terminate(); created--; if (waiting.length) waiting.shift()(newWorker()); return; }
  if (waiting.length) waiting.shift()(w); else idle.push(w);
}
async function encodeSegment(makeChans, sampleRate, kbps, quality) {
  const w = await getWorker();
  let broken = false;
  try {
    const chans = makeChans();
    return await new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data.blob ? resolve(e.data.blob) : reject(new Error(e.data.error || "인코더 오류")));
      w.onerror = () => reject(new Error("인코더 오류"));
      w.postMessage({ chans, sampleRate, kbps, quality }, chans.map((c) => c.buffer));
    });
  } catch (e) { broken = true; throw e; }
  finally { releaseWorker(w, broken); }
}

// 가장 조용한 지점(말 사이 쉼)에서 자르면 이음새가 거의 들리지 않음
function splitPoints(ch0, sr) {
  const n = ch0.length, seg = SEG_SEC * sr;
  if (n < seg * 1.5) return [0, n];
  const win = Math.floor(sr * 0.01), search = sr * 4;
  const pts = [0];
  for (let t = seg; t < n - seg * 0.5; t += seg) {
    const from = Math.max(pts[pts.length - 1] + sr, t - search);
    const to = Math.min(n - win, t + search);
    let best = t, bestE = Infinity;
    for (let i = from; i + win <= to; i += win) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += ch0[j] * ch0[j];
      if (e < bestE) { bestE = e; best = i + (win >> 1); }
    }
    pts.push(Math.floor(best));
  }
  pts.push(n);
  return pts;
}

async function encodeAudio(audio, preset, onFrac, url) {
  const sr = audio.sampleRate;
  const nch = audio.numberOfChannels;
  const c0 = audio.getChannelData(0);
  const c1 = nch > 1 ? audio.getChannelData(1) : null;
  const mono = preset.mono || nch === 1;
  const pts = splitPoints(c0, sr);
  const makeSeg = (a, b) => {
    if (mono) {
      const o = new Float32Array(b - a);
      if (c1 && preset.mono) for (let i = 0; i < o.length; i++) o[i] = (c0[a + i] + c1[a + i]) / 2;
      else o.set(c0.subarray(a, b));
      return [o];
    }
    return [c0.slice(a, b), c1.slice(a, b)];
  };
  const total = pts.length - 1;
  let doneCount = 0;
  const jobs = [];
  for (let i = 0; i < total; i++) {
    jobs.push(encodeSegment(() => { check(url); return makeSeg(pts[i], pts[i + 1]); }, sr, preset.kbps, preset.quality)
      .then((b) => { onFrac(++doneCount / total); return b; }));
  }
  return new Blob(await Promise.all(jobs), { type: "audio/mpeg" });
}

// ---------- 저장 ----------
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open("mp3dl", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }

async function doSave(blob, base, dirMode, subdir) {
  let note = "";
  if (dirMode) {
    try {
      const h = await idbGet("dir");
      if (h && (await h.queryPermission({ mode: "readwrite" })) === "granted") {
        let name = base + ".mp3", n = 1;
        while (await exists(h, name)) name = `${base} (${n++}).mp3`;
        const fh = await h.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        return note;
      }
    } catch {}
    note = " (폴더 권한 없음 → 기본 다운로드 폴더에 저장)";
  }
  const sub = (subdir || "").split(/[\\/]/).map(sanitize).filter(Boolean).join("/");
  const href = URL.createObjectURL(blob);
  const r = await bg({ type: "download", url: href, filename: (sub ? sub + "/" : "") + base + ".mp3" });
  if (!r || r.error) throw new Error("저장 실패: " + (r?.error || "응답 없음"));
  setTimeout(() => URL.revokeObjectURL(href), 10 * 60 * 1000);
  return note;
}
function saveBlob(...a) {
  const p = saveLock.then(() => doSave(...a));
  saveLock = p.catch(() => {});
  return p;
}

// ---------- 작업 실행 ----------
async function run(job) {
  const { url, referer, base, preset, dirMode, subdir, connections } = job;
  let ruleId = null;
  try {
    check(url);
    emit(url, "준비 중...", 0, "", true);
    const id = ++ruleSeq;
    if (await bg({ type: "addReferer", id, url, referer })) ruleId = id;

    let mode = "";
    const t0 = Date.now();
    let buf = await fetchBuffer(url, (got, total) => {
      const speed = got / MB / Math.max(0.5, (Date.now() - t0) / 1000);
      emit(url, `다운로드${mode} ${(got / MB).toFixed(1)}${total ? " / " + (total / MB).toFixed(1) : ""} MB · ${speed.toFixed(1)} MB/s`, total ? (got / total) * 40 : 10);
    }, connections || 8, (m) => { mode = m; });
    check(url);

    emit(url, "오디오 추출 중...", 45, "", true);
    const ctx = new AudioContext({ sampleRate: preset.sampleRate });
    let audio;
    try { audio = await ctx.decodeAudioData(buf); }
    catch { throw new Error("오디오 디코딩 불가 (지원하지 않는 형식/DRM)"); }
    finally { ctx.close(); buf = null; }
    check(url);

    const blob = await encodeAudio(audio, preset, (f) => emit(url, "MP3 인코딩 중...", 50 + f * 48), url);
    audio = null;
    check(url);

    emit(url, "저장 중...", 98, "", true);
    const note = await saveBlob(blob, base, dirMode, subdir);
    await bg({ type: "jobDone", url });
    emit(url, `완료 · ${(blob.size / MB).toFixed(1)} MB${note}`, 100, "done", true);
  } catch (e) {
    if (e instanceof Canceled) emit(url, "취소됨", 0, "", true);
    else emit(url, "오류: " + e.message, 0, "err", true);
  } finally {
    if (ruleId) bg({ type: "removeReferer", id: ruleId });
    queued.delete(url);
    canceled.delete(url);
  }
}

function pump() {
  while (active < conc && queue.length) {
    const job = queue.shift();
    active++;
    run(job).finally(() => {
      active--;
      pump();
      if (!isRunning()) bg({ type: "progress", url: "", text: "", pct: 0, cls: "", running: false });
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "start") {
    conc = msg.conc || conc;
    for (const j of msg.jobs) {
      if (queued.has(j.url)) continue; // 이미 처리 중/대기 중
      queued.add(j.url);
      canceled.delete(j.url);
      queue.push({ ...j, preset: msg.preset, dirMode: msg.dirMode, subdir: msg.subdir, connections: msg.connections });
      emit(j.url, "대기 중", 0, "", true);
    }
    pump();
    send({ ok: true });
  } else if (msg.type === "stop") {
    while (queue.length) { const j = queue.shift(); queued.delete(j.url); emit(j.url, "중지됨", 0, "", true); }
    send({ ok: true });
  } else if (msg.type === "cancel") {
    for (const u of msg.urls) {
      canceled.add(u);
      const i = queue.findIndex((j) => j.url === u);
      if (i >= 0) { queue.splice(i, 1); queued.delete(u); canceled.delete(u); }
      states.delete(u);
    }
    send({ ok: true });
  } else if (msg.type === "getState") {
    send({ states: Object.fromEntries(states), running: isRunning() });
  }
});
