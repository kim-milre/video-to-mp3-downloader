# Third-party notices

## lamejs (`lame.min.js`)

- 프로젝트: [zhuker/lamejs](https://github.com/zhuker/lamejs) — LAME MP3 인코더의 JavaScript 포팅
- 라이선스: **LGPL-3.0** (전문/안내: [`third_party/lamejs-LICENSE.txt`](third_party/lamejs-LICENSE.txt))
- 변경 사항: 인코딩 품질 값을 외부에서 조절할 수 있도록 한 군데를 수정했습니다.
  - 원본: `q.quality=3;q.bWriteVbrTag=!1`
  - 수정: `q.quality=(globalThis.MP3_Q||3);q.bWriteVbrTag=!1`
  - `encoder-worker.js`가 `globalThis.MP3_Q`에 값(2=고품질/느림 … 7=빠름)을 넣고 인코더를 만듭니다.
- 이 파일을 재배포할 때는 LGPL-3.0 조건을 따라야 합니다.
