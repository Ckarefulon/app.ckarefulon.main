/**
 * Ckarefulon 壳运行时 —— 轻量 UI 层（无第三方依赖）
 * 提供：Toast / 底部抽屉 / BLE 设备选择器 / 确认框 / 更新浮标 / 启动页驱动
 * 所有节点都挂在独立的 .ck-root 容器里，z-index 拉满，不污染站点 DOM。
 */

const ROOT_CLASS = 'ck-root';
let root = null;
let toastBox = null;
let badgeEl = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function mount() {
  if (root && root.isConnected) return root;
  root = el('div', ROOT_CLASS);
  root.setAttribute('aria-live', 'polite');
  toastBox = el('div', 'ck-toasts');
  root.appendChild(toastBox);
  const host = document.body || document.documentElement;
  host.appendChild(root);
  return root;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
  } else {
    mount();
  }
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */
function toast(message, opts = {}) {
  const { type = 'info', timeout = 3600, actionLabel, onAction } = opts;
  mount();
  const node = el('div', 'ck-toast');
  node.dataset.type = type;
  node.appendChild(el('span', 'ck-dot'));
  node.appendChild(el('span', 'ck-msg', message));
  const api = {
    el: node,
    /** 原地改文案（下载进度这类要持续刷新的提示用它，不要反复弹新 toast） */
    update(text) {
      const m = node.querySelector('.ck-msg');
      if (m) m.textContent = String(text);
      return api;
    },
    close() {
      node.classList.remove('ck-in');
      setTimeout(() => node.remove(), 240);
    },
  };
  if (actionLabel) {
    const btn = el('button', 'ck-primary', actionLabel);
    btn.addEventListener('click', () => {
      api.close();
      if (typeof onAction === 'function') onAction();
    });
    node.appendChild(btn);
  }
  toastBox.appendChild(node);
  requestAnimationFrame(() => node.classList.add('ck-in'));
  if (timeout > 0) setTimeout(api.close, timeout);
  return api;
}

/* ------------------------------------------------------------------ *
 * 底部抽屉（sheet）
 * ------------------------------------------------------------------ */
function sheet({ title = '', subtitle = '', closable = true, onClose } = {}) {
  mount();
  const overlay = el('div', 'ck-overlay');
  const panel = el('div', 'ck-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const head = el('div', 'ck-sheet-head');
  const headText = el('div');
  headText.style.flex = '1';
  headText.style.minWidth = '0';
  headText.appendChild(el('h3', 'ck-sheet-title', title));
  if (subtitle) headText.appendChild(el('p', 'ck-sheet-sub', subtitle));
  head.appendChild(headText);

  const close = (reason) => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('ck-in');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 220);
    if (typeof onClose === 'function') onClose(reason);
  };
  let closed = false;

  if (closable) {
    const x = el('button', 'ck-x', '✕');
    x.setAttribute('aria-label', '关闭');
    x.addEventListener('click', () => close('cancel'));
    head.appendChild(x);
  }

  const body = el('div', 'ck-sheet-body');
  const foot = el('div', 'ck-sheet-foot');

  panel.append(head, body, foot);
  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && closable) close('cancel');
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && closable) close('cancel');
  };
  document.addEventListener('keydown', onKey, true);

  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('ck-in'));

  return { overlay, panel, head, body, foot, close, isOpen: () => !closed };
}

/* ------------------------------------------------------------------ *
 * 确认框
 * ------------------------------------------------------------------ */
function confirm({ title = '提示', message = '', okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    // sheet.close() 会先触发 onClose 再返回，所以这里必须先抢答：
    // 直接在 onClose 里 resolve(false) 会把"确定"那次 resolve(true) 顶掉 ——
    // 结果确认框永远返回 false（"重置资源"点确定没反应就是它）。
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const s = sheet({ title, closable: true, onClose: () => finish(false) });
    const p = el('div');
    p.style.padding = '18px';
    p.style.fontSize = '13.5px';
    p.style.lineHeight = '1.75';
    p.style.color = 'var(--ck-muted)';
    if (typeof message === 'string') p.textContent = message;
    else p.appendChild(message);
    s.body.appendChild(p);
    s.foot.appendChild(el('div', 'ck-spacer'));
    const cancel = el('button', '', cancelLabel);
    cancel.addEventListener('click', () => { finish(false); s.close('cancel'); });
    const ok = el('button', danger ? '' : 'ck-primary', okLabel);
    ok.addEventListener('click', () => { finish(true); s.close('ok'); });
    s.foot.append(cancel, ok);
  });
}

/* ------------------------------------------------------------------ *
 * BLE 设备选择器
 * 返回 controller：
 *   .result          → Promise<{deviceId,name,...}>；取消时 reject({name:'NotFoundError'})
 *   .setScanning(b)  → 切换“搜索中/已停止”
 *   .push(dev)       → 增量添加/更新一个设备（按 deviceId 去重，按信号强度排序）
 *   .setNotice(text) → 顶部提示（如“请打开蓝牙”）
 *   .close(reason)
 * ------------------------------------------------------------------ */
function devicePicker({
  title = '选择蓝牙设备',
  subtitle = '把魔方靠近手机，并保持屏幕常亮',
  hint = '仅显示匹配当前功能的设备；点击即可连接。',
  cancelLabel = '取消',
  emptyTitle = '还没有发现设备',
  emptyText = '请确认设备已开机并靠近手机，然后点“重新搜索”。',
  onRescan,
} = {}) {
  // 结果收口：sheet 的 ✕ / 点遮罩 / Esc / cancel() 都会走 onClose，requestDevice()
  // 必须在这里被 reject，否则站点侧的连接流程永远挂在 await 上（用户点 ✕ 关掉
  // 选择器后，页面就卡死在"连接中"）。以前靠 patch s.close + 一个没人派发的
  // ck-close 事件，这两个通道都收不到 sheet 内部的关闭。
  let settled = false;
  let resolveFn;
  let rejectFn;
  const result = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  result.catch(() => {}); // 避免未处理的 rejection
  const cancelled = () => {
    if (settled) return;
    settled = true;
    const err = new Error('User cancelled the requestDevice() chooser.');
    err.name = 'NotFoundError';
    err.code = 0;
    rejectFn(err);
  };
  const picked = (dev) => {
    if (settled) return;
    settled = true;
    resolveFn({ ...dev });
  };

  const s = sheet({ title, subtitle, closable: true, onClose: () => cancelled() });

  const scanbar = el('div', 'ck-scanbar');
  const spinner = el('span', 'ck-spin');
  const scanText = el('span', '', '正在搜索…');
  scanbar.append(spinner, scanText);
  s.panel.insertBefore(scanbar, s.body);

  const empty = el('div', 'ck-empty');
  empty.appendChild(el('b', '', emptyTitle));
  empty.appendChild(el('div', '', emptyText));
  s.body.appendChild(empty);

  const list = el('div', 'ck-devlist');
  s.body.appendChild(list);

  s.foot.appendChild(el('div', 'ck-hint', hint));
  s.foot.appendChild(el('div', 'ck-spacer'));
  const rescan = el('button', '', '重新搜索');
  s.foot.appendChild(rescan);

  const rows = new Map();

  function bars(rssi) {
    const wrap = el('span', 'ck-bars');
    const level = rssi == null ? 0 : rssi >= -55 ? 4 : rssi >= -70 ? 3 : rssi >= -85 ? 2 : 1;
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement('i');
      if (i < level) bar.className = 'on';
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function render(dev) {
    let row = rows.get(dev.deviceId);
    if (!row) {
      row = el('button', 'ck-dev');
      row.type = 'button';
      const ico = el('span', 'ck-dev-ico');
      ico.innerHTML =
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>';
      const main = el('span', 'ck-dev-main');
      const name = el('span', 'ck-dev-name');
      const id = el('span', 'ck-dev-id');
      main.append(name, id);
      const rssi = el('span', 'ck-dev-rssi');
      row.append(ico, main, rssi);
      row._name = name;
      row._id = id;
      row._rssi = rssi;
      row.addEventListener('click', () => {
        picked(dev);
        s.close('ok');
      });
      rows.set(dev.deviceId, row);
      list.appendChild(row);
    }
    row._name.textContent = dev.name || dev.localName || '未知设备';
    row._id.textContent = dev.deviceId;
    row._rssi.textContent = '';
    if (dev.rssi != null) {
      row._rssi.appendChild(bars(dev.rssi));
      row._rssi.appendChild(document.createTextNode(` ${dev.rssi} dBm`));
    } else if (dev.bonded) {
      row._rssi.textContent = '已配对';
    }
    // 按信号强度倒序排列（先把本次的强度写进行，再排：以前写在其后，
    // 排序用的还是上一轮的旧值，新设备会一直沉底）
    row._rssiNum = dev.rssi ?? -999;
    const sorted = [...rows.values()].sort((a, b) => (b._rssiNum ?? -999) - (a._rssiNum ?? -999));
    sorted.forEach((r, i) => { if (list.children[i] !== r) list.appendChild(r); });
    empty.style.display = rows.size ? 'none' : '';
  }

  rescan.addEventListener('click', () => {
    if (typeof onRescan === 'function') onRescan();
  });

  return {
    result,
    push: render,
    setScanning(on, text) {
      scanbar.style.display = on === false ? 'none' : '';
      spinner.style.display = on ? '' : 'none';
      scanText.textContent = text || (on ? '正在搜索…' : '搜索已停止');
    },
    setNotice(text) {
      scanText.textContent = text;
    },
    count: () => rows.size,
    close: (reason) => s.close(reason || 'ok'),
    cancel: () => s.close('cancel'),
  };
}

/* ------------------------------------------------------------------ *
 * 更新浮标
 * ------------------------------------------------------------------ */
function badge({ text, busy = false, onClick } = {}) {
  mount();
  // 整个文档可能被 document.write 重建过（壳 → 站点），旧浮标节点已不在 DOM 里，
  // 引用还留着的话浮标永远不再出现
  if (badgeEl && !badgeEl.isConnected) badgeEl = null;
  if (!badgeEl) {
    badgeEl = el('button', 'ck-badge');
    badgeEl.type = 'button';
    const dot = el('span', 'ck-dot');
    const label = el('span', 'ck-badge-text');
    badgeEl.append(dot, label);
    badgeEl._label = label;
    root.appendChild(badgeEl);
  }
  badgeEl._label.textContent = text || '';
  badgeEl.classList.toggle('ck-busy', !!busy);
  badgeEl.onclick = typeof onClick === 'function' ? onClick : null;
  requestAnimationFrame(() => badgeEl.classList.add('ck-in'));
  return badgeEl;
}

function hideBadge() {
  if (!badgeEl) return;
  badgeEl.classList.remove('ck-in');
  setTimeout(() => { badgeEl?.remove(); badgeEl = null; }, 260);
}

/* ------------------------------------------------------------------ *
 * 启动页（壳 index.html）驱动
 * 页面上存在 .ck-boot 时直接操作它，否则退化为 Toast
 * ------------------------------------------------------------------ */
const boot = {
  node: null,
  find() {
    if (this.node && this.node.isConnected) return this.node;
    this.node = document.querySelector('.ck-boot');
    return this.node;
  },
  stage(text) {
    const n = this.find();
    if (!n) return;
    const s = n.querySelector('.ck-boot-stage');
    if (s) { s.style.display = ''; s.textContent = text || ''; }
  },
  progress(value, indeterminate = false) {
    const n = this.find();
    if (!n) return;
    const bar = n.querySelector('.ck-boot-prog');
    if (!bar) return;
    bar.style.display = '';
    bar.classList.toggle('ck-indet', !!indeterminate);
    const fill = bar.querySelector('i');
    if (fill && !indeterminate) fill.style.width = `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
  },
  /**
   * 静默模式：收起阶段文案和进度条，启动页只剩 logo。
   * 二进秒进（缓存齐全直接落地站点文档）时用 —— 用户退出重进不该再
   * 闪一下"正在安装离线服务 / 正在缓存"这种界面。
   */
  quiet() {
    const n = this.find();
    if (!n) return;
    const s = n.querySelector('.ck-boot-stage');
    if (s) { s.textContent = ''; s.style.display = 'none'; }
    const bar = n.querySelector('.ck-boot-prog');
    if (bar) bar.style.display = 'none';
  },
  error(message, detail) {
    const n = this.find();
    if (!n) { toast(String(message), { type: 'error', timeout: 0 }); return; }
    let box = n.querySelector('.ck-boot-err');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('div', '', String(message)));
    if (detail) box.appendChild(el('code', '', String(detail)));
    box.classList.add('ck-in');
  },
  clearError() {
    const n = this.find();
    n?.querySelector('.ck-boot-err')?.classList.remove('ck-in');
  },
  actions(list) {
    const n = this.find();
    if (!n) return;
    const box = n.querySelector('.ck-boot-acts');
    if (!box) return;
    box.innerHTML = '';
    for (const act of list || []) {
      if (!act) continue;
      const b = el('button', act.primary ? 'ck-primary' : '', act.label);
      b.addEventListener('click', () => act.onClick && act.onClick());
      box.appendChild(b);
    }
    box.style.display = list && list.length ? '' : 'none';
  },
  hide() {
    const n = this.find();
    if (!n) return;
    n.dataset.hidden = '1';
    setTimeout(() => n.remove(), 320);
  },
};

export const CkUI = {
  mount,
  toast,
  sheet,
  confirm,
  devicePicker,
  badge,
  hideBadge,
  boot,
  el,
};

export default CkUI;
