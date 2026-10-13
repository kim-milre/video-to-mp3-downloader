// 세그먼트 단위 MP3 인코딩 워커 (풀에서 재사용됨)
importScripts("lame.min.js");

function toInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

onmessage = (e) => {
  try {
    const { chans, sampleRate, kbps, quality } = e.data;
    globalThis.MP3_Q = quality || 3; // 패치된 lame.min.js가 읽는 값 (2=고품질/느림 … 7=빠름)
    const ch = chans.length;
    const enc = new lamejs.Mp3Encoder(ch, sampleRate, kbps);
    const L = toInt16(chans[0]);
    const R = ch === 2 ? toInt16(chans[1]) : null;
    const parts = [];
    const BLOCK = 1152 * 50;
    for (let i = 0; i < L.length; i += BLOCK) {
      const out = ch === 2
        ? enc.encodeBuffer(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK))
        : enc.encodeBuffer(L.subarray(i, i + BLOCK));
      if (out.length) parts.push(out);
    }
    const end = enc.flush();
    if (end.length) parts.push(end);
    postMessage({ blob: new Blob(parts, { type: "audio/mpeg" }) });
  } catch (err) {
    postMessage({ error: String((err && err.message) || err) });
  }
};
