const MANAGER = chrome.runtime.getURL("manager.html");
let tab;

async function refresh() {
  const { library = [] } = await chrome.storage.local.get("library");
  const here = library.filter((m) => m.tabId === tab.id).length;
  document.getElementById("cnt").textContent = `수집된 영상 ${library.length}개 (이 탭 ${here}개)`;
}

document.getElementById("open").onclick = async () => {
  const [existing] = await chrome.tabs.query({ url: MANAGER });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER });
  }
  window.close();
};

document.getElementById("add").onclick = async () => {
  const v = document.getElementById("manual").value.trim();
  if (!/^https?:\/\//i.test(v)) return;
  await chrome.runtime.sendMessage({ type: "add", url: v, referer: tab.url, title: tab.title });
  document.getElementById("manual").value = "";
  document.getElementById("msg").textContent = "추가했습니다.";
  setTimeout(refresh, 200);
};

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  refresh();
})();
