// 재생 중 감지된 미디어 요청을 storage.local('library')에 계속 쌓아 둡니다.
// 또한 변환 처리기(offscreen)가 직접 못 쓰는 크롬 API(다운로드, 헤더 규칙, 저장소)를 대신 호출합니다.
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|mp3|m4a|aac|ogg|oga|wav|flac|mkv)(\?|#|$)/i;
const MAX_ITEMS = 300;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 읽기-수정-쓰기가 겹치지 않도록 순서대로 처리
let chain = Promise.resolve();
function mutateKey(key, def, fn) {
  chain = chain
    .then(async () => {
      const o = await chrome.storage.local.get(key);
      const next = await fn(o[key] ?? def);
      if (next) {
        await chrome.storage.local.set({ [key]: next });
        if (key === "library") updateBadge(next.length);
      }
    })
    .catch(console.error);
  return chain;
}
const mutate = (fn) => mutateKey("library", [], fn);

function updateBadge(n) {
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
}
chrome.storage.local.get("library").then(({ library = [] }) => updateBadge(library.length));

chrome.webRequest.onResponseStarted.addListener(
  async (d) => {
    if (d.tabId < 0) return;
    const h = (n) => (d.responseHeaders || []).find((x) => x.name.toLowerCase() === n)?.value || "";
    const type = h("content-type").toLowerCase();
    const isMedia = type.startsWith("video/") || type.startsWith("audio/") || MEDIA_EXT.test(d.url);
    if (!isMedia || type.includes("mpegurl") || /\.m3u8/i.test(d.url)) return;

    const range = h("content-range");
    const size = range ? parseInt(range.split("/")[1]) || 0 : parseInt(h("content-length")) || 0;
    if (size && size < 100 * 1024) return; // 효과음 등 너무 작은 파일 제외

    let title = "", pageUrl = "";
    try {
      const t = await chrome.tabs.get(d.tabId);
      title = t.title || "";
      pageUrl = t.url || "";
    } catch {}

    mutate((lib) => {
      const ex = lib.find((m) => m.url === d.url);
      if (ex) {
        if (!ex.size && size) { ex.size = size; return lib; }
        return null;
      }
      lib.push({ url: d.url, type, size, referer: d.documentUrl || d.initiator || pageUrl, title, pageUrl, tabId: d.tabId, time: Date.now() });
      return lib.slice(-MAX_ITEMS);
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// 페이지 제목이 나중에 바뀌는 경우 반영
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.title) return;
  mutate((lib) => {
    let changed = false;
    for (const m of lib) {
      if (m.tabId === tabId && m.pageUrl === tab.url && m.title !== info.title) { m.title = info.title; changed = true; }
    }
    return changed ? lib : null;
  });
});

async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctxs.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "수집함을 닫아도 영상 다운로드/MP3 변환이 계속되도록 백그라운드에서 처리",
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e.message))) throw e;
  }
}

// 요청마다 Referer/Origin 헤더를 붙이는 규칙 (브라우저가 재생할 때 보내는 값과 동일)
async function addReferer({ id, url, referer }) {
  if (!/^https?:/.test(referer || "")) return false;
  const regex = "^" + esc(url) + "$";
  const condition = { resourceTypes: ["xmlhttprequest"], initiatorDomains: [chrome.runtime.id] };
  if (regex.length < 1500) condition.regexFilter = regex;
  else condition.requestDomains = [new URL(url).hostname];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "Referer", operation: "set", value: referer },
        { header: "Origin", operation: "set", value: new URL(referer).origin },
      ] },
      condition,
    }],
  });
  return true;
}

const dropDone = (urls) => mutateKey("done", {}, (d) => { urls.forEach((u) => delete d[u]); return d; });

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  switch (msg.type) {
    case "add":
      mutate((lib) => {
        if (lib.some((m) => m.url === msg.url)) return null;
        lib.push({ url: msg.url, type: "", size: 0, referer: msg.referer || "", title: msg.title || "", pageUrl: msg.referer || "", tabId: -1, time: Date.now() });
        return lib;
      });
      return;
    case "remove":
      mutate((lib) => lib.filter((m) => !msg.urls.includes(m.url)));
      dropDone(msg.urls);
      return;
    case "clear":
      mutate(() => []);
      mutateKey("done", {}, () => ({}));
      return;
    case "markDone":
      mutateKey("done", {}, (d) => { msg.urls.forEach((u) => (d[u] = true)); return d; });
      return;
    case "undone":
      dropDone([msg.url]);
      return;
    case "jobDone":
      mutateKey("done", {}, (d) => { d[msg.url] = true; return d; }).then(() => send(true));
      return true;
    case "ensureOffscreen":
      ensureOffscreen().then(() => send({ ok: true }), (e) => send({ ok: false, error: String(e.message || e) }));
      return true;
    case "addReferer":
      addReferer(msg).then(send, () => send(false));
      return true;
    case "removeReferer":
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [msg.id] }).then(() => send(true), () => send(false));
      return true;
    case "download":
      chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: "uniquify" })
        .then((id) => send({ id }), (e) => send({ error: String(e.message || e) }));
      return true;
  }
});
