/**
 * ptest 入口：真网功能测试 —— 真下载全部首屏核心 + vendor，并验证"入缓存回执"链路。
 * 由 scripts/ptest.mjs 打包后在 Node 里运行（需联网；离线时由 ptest.mjs 跳过）。
 */
import { precacheCore } from '../src/net/precache.js';

const meta = JSON.parse(process.env.CK_SW_META || '{}');
if (!meta.origins?.length) {
  console.error('ptest: 缺少 CK_SW_META');
  process.exit(2);
}

async function main() {
/* ---- 阶段 1：真实下载（不等待 SW 回执） ---- */
const dl = await precacheCore(meta, { worker: null });
console.log(`[ptest] 下载阶段: ${dl.ok}/${dl.total}`, dl.errors?.slice(0, 4) || '');
if (dl.ok !== dl.total) return process.exit(1);

/* ---- 阶段 2：下载 + SW 回执链路（桩 SW 立即回执 put-done） ---- */
const listeners = new Set();
const workerStub = {
  postMessage(msg) {
    setImmediate(() => {
      const reply = { data: { type: 'ck-cache-put-done', pathname: msg.pathname || msg.key } };
      for (const l of [...listeners]) l(reply);
    });
  },
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        controller: workerStub,
        addEventListener: (t, h) => listeners.add(h),
        removeEventListener: (t, h) => listeners.delete(h),
      },
    },
  });
} catch (e) {
  console.error('ptest: 无法安装 navigator 桩', e?.message);
  return process.exit(2);
}

const full = await precacheCore(meta, { worker: workerStub });
console.log(`[ptest] 回执阶段: ${full.ok}/${full.total}`, full.errors?.slice(0, 4) || '');
return process.exit(full.ok === full.total ? 0 : 1);

}
main().catch((e) => { console.error("[ptest] 异常:", e?.message || e); process.exit(2); });
