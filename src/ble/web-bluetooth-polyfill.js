/**
 * Web Bluetooth → Capacitor BLE 原生桥（Polyfill）
 * ---------------------------------------------------------------------------
 * Android WebView 不支持 Web Bluetooth API，而站点里的智能魔方代码
 * （Cube/*​/assets/hardware/bluetooth.js、gancube.js、moyucube.js、giikercube.js、
 *   gocube.js、qiyicube.js、Cube/Analyzer/Beta/smartcube-bridge.js）
 * 全部基于 navigator.bluetooth 实现。
 *
 * 本模块用 @capacitor-community/bluetooth-le（原生 BLE）在运行时补齐同一套 API：
 *   navigator.bluetooth.requestDevice({filters, optionalServices, optionalManufacturerData})
 *   navigator.bluetooth.getAvailability() / getDevices()
 *   device.gatt.connect()/disconnect()/getPrimaryService(s)()
 *   service.getCharacteristic(s)()  ·  characteristic.readValue()/writeValue()/
 *   startNotifications()/stopNotifications() + 'characteristicvaluechanged'
 *   device.watchAdvertisements({signal}) + 'advertisementreceived'（含 manufacturerData Map）
 *   device.addEventListener('gattserverdisconnected')
 *
 * 因此站点代码一行都不用改。浏览器里（非原生环境）本模块不生效，继续用原生 Web Bluetooth。
 */

import { BleClient, ScanMode } from '@capacitor-community/bluetooth-le';
import { CkUI } from '../ui/ck-ui.js';

/* ============================ 工具函数 ============================ */

const BT_BASE = '-0000-1000-8000-00805f9b34fb';

/** 把 4/8 位短 UUID、数字统一展开成 128 位小写字符串 */
export function expandUuid(uuid) {
  if (typeof uuid === 'number') uuid = uuid.toString(16);
  let u = String(uuid ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(u)) u = `0000${u}${BT_BASE}`;
  else if (/^[0-9a-f]{8}$/.test(u)) u = `${u}${BT_BASE}`;
  return u;
}

/** 任意输入 → DataView（ArrayBuffer / TypedArray / DataView / hex string / number[]） */
export function toDataView(value) {
  if (value == null) return new DataView(new ArrayBuffer(0));
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') {
    const hex = value.replace(/[^0-9a-fA-F]/g, '');
    const buf = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
    return new DataView(buf.buffer);
  }
  if (Array.isArray(value)) {
    const buf = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) buf[i] = value[i] & 0xff;
    return new DataView(buf.buffer);
  }
  throw bleError('Invalid data.', 'TypeError');
}

export function dataViewToHex(dv) {
  const view = toDataView(dv);
  let out = '';
  for (let i = 0; i < view.byteLength; i++) out += view.getUint8(i).toString(16).padStart(2, '0');
  return out;
}

/** 造一个带 name 的错误（模拟 DOMException 行为） */
export function bleError(message, name = 'UnknownError') {
  const err = new Error(message);
  err.name = name;
  return err;
}

/* ============================ 事件基类 ============================ */

class Emitter {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  /** 兼容旧代码里的 onclick / onxxx 赋值 */
  _dispatch(type, props = {}) {
    const event = Object.assign({ type, target: this, currentTarget: this, timeStamp: Date.now() }, props);
    const inline = this[`on${type}`];
    if (typeof inline === 'function') {
      try { inline.call(this, event); } catch (e) { console.error('[ck-ble] inline handler error', e); }
    }
    const set = this._listeners.get(type);
    if (set) {
      for (const fn of [...set]) {
        try { fn.call(this, event); } catch (e) { console.error(`[ck-ble] "${type}" listener error`, e); }
      }
    }
    return event;
  }
  get _hasListeners() { return this._listeners.size > 0; }
}

/* ============================ 蓝牙就绪 / 权限 ============================ */

const RUNTIME = { initialized: false, initializing: null, lastError: null };

/**
 * 读 `BleClient.isEnabled()` / `isLocationEnabled()` 的结果。
 * ⚠️ 历史事故点（127）：这两者的返回形态在各版本间不一致 —— 原生插件层
 * （`BluetoothLe.isEnabled()`）返回 `{ value: boolean }`，但**公开的 `BleClient`
 * 包装层在 8.x 里已经把 `.value` 拆掉了、直接返回裸布尔**。旧代码一律读 `r.value`，
 * 拿到的是 `undefined`（永远 falsy）→ `waitEnabled()` 轮询到超时 → 蓝牙明明开着，
 * 用户却先看到「蓝牙未开启」、点了「打开蓝牙」再等 8 秒后抛「蓝牙未就绪」
 * （126 真机回执）。两种形态都认，别再退回去直接读 `.value`。
 */
function readFlag(result) {
  if (result && typeof result === 'object') return result.value === true;
  return result === true;
}

async function ensureReady() {
  if (RUNTIME.initialized) return;
  if (RUNTIME.initializing) return RUNTIME.initializing;

  RUNTIME.initializing = (async () => {
    try {
      // initialize() 会在 Android 上触发系统权限弹窗（附近设备；≤11 还有位置）。
      // androidNeverForLocation 必须为 true：Android 12+ 我们只声明「附近的设备」权限
      // （定位权限 maxSdk 30，12+ 根本没声明），若传 false 原生层还会去要定位权限，
      // 在 12+ 上必然被拒 → 用户明明授权了「附近的设备」仍报「没有权限」。
      await BleClient.initialize({ androidNeverForLocation: true });
    } catch (err) {
      RUNTIME.lastError = err;
      // 清掉缓存的失败 Promise：用户去系统设置授权回来后，下一次调用要能真正重试，
      // 否则本次页面生命周期里永远返回同一个「没有权限」错误。
      RUNTIME.initializing = null;
      const msg = String(err?.message || err);
      if (/permission|denied|PERMISSION/i.test(msg)) {
        const go = await CkUI.confirm({
          title: '需要蓝牙权限',
          message: '连接智能魔方需要「附近的设备」权限（Android 11 及以下还需要「位置信息」权限，这是系统对 BLE 扫描的限制，App 不会记录你的位置）。',
          okLabel: '去授权',
          cancelLabel: '取消',
        });
        if (go) await BleClient.openAppSettings().catch(() => {});
        throw bleError('蓝牙权限被拒绝，请在系统设置中开启后重试。', 'SecurityError');
      }
      if (/not supported|not available/i.test(msg)) {
        // runInitialization：BLE 特性缺失 / 适配器读到 null。蓝牙开关翻转前后
        // 系统服务短暂读不到适配器也会走到这里 —— 缓一下重试一次再判死。
        console.warn('[ck-ble] initialize 被拒：', msg, '，800ms 后重试一次');
        await new Promise((r) => setTimeout(r, 800));
        try {
          await BleClient.initialize({ androidNeverForLocation: true });
        } catch (err2) {
          const msg2 = String(err2?.message || err2);
          CkUI.toast(`蓝牙初始化失败：${msg2}`);
          throw bleError(`蓝牙初始化失败（${msg2}）。请确认手机蓝牙已打开后重试；若仍失败，把括号里的英文反馈给开发者。`, 'NotSupportedError');
        }
        // 重试成功 → 继续往下走正常流程
      } else {
        throw err;
      }
    }

    // 蓝牙开关：读到 false 不一定是"没开"——开关刚拨开时有 1~3 秒"正在打开"
    // 过渡期（requestEnable 的 resolve 也不代表已就绪）。单次读取会把已开
    // 误判成不可用（124/125 真机回执："Bluetooth is not available."），
    // 所以一律轮询等待就绪。
    const waitEnabled = async (timeoutMs) => {
      const t0 = Date.now();
      for (;;) {
        const st = await BleClient.isEnabled().catch((e) => {
          console.warn('[ck-ble] isEnabled 读取失败，按可用处理：', e?.message || e);
          return { value: true };
        });
        if (readFlag(st)) return true;
        if (Date.now() - t0 >= timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    if (!(await waitEnabled(1500))) {
      const go = await CkUI.confirm({
        title: '蓝牙未开启',
        message: '请先打开手机蓝牙，然后再连接魔方。',
        okLabel: '打开蓝牙',
        cancelLabel: '取消',
      });
      if (!go) throw bleError('蓝牙未开启：打开手机蓝牙后重新点连接即可。', 'NotAllowedError');
      await BleClient.requestEnable().catch(() => {});
      if (!(await waitEnabled(8000))) {
        throw bleError('蓝牙未就绪：请确认手机蓝牙已打开（开关拨开后等 1~2 秒），再重新点连接。', 'NotSupportedError');
      }
    }

    // Android 11 及以下：BLE 扫描要求系统定位服务开启
    const loc = await BleClient.isLocationEnabled().catch(() => ({ value: true }));
    if (!readFlag(loc)) {
      const go = await CkUI.confirm({
        title: '需要开启位置服务',
        message: 'Android 11 及以下系统扫描 BLE 设备必须开启「位置信息」开关（系统限制，App 不会收集你的位置）。',
        okLabel: '去开启',
        cancelLabel: '以后再说',
      });
      if (go) await BleClient.openLocationSettings().catch(() => {});
    }

    RUNTIME.initialized = true;
  })();

  try {
    await RUNTIME.initializing;
  } catch (err) {
    RUNTIME.initializing = null;
    throw err;
  }
  RUNTIME.initializing = null;
}

/* ============================ 扫描调度（单实例复用） ============================ */

const ScanHub = {
  consumers: new Set(),
  scanning: false,
  starting: null,

  subscribe(fn) {
    this.consumers.add(fn);
    return () => {
      this.consumers.delete(fn);
      if (this.consumers.size === 0) this.stop();
    };
  },

  async start() {
    if (this.scanning) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await BleClient.requestLEScan(
        {
          allowDuplicates: true,          // 需要重复广播包（watchAdvertisements 依赖）
          scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
          allowExtendedAdvertising: true,  // Android 8+ 蓝牙 5 扩展广播
        },
        (result) => {
          for (const fn of [...this.consumers]) {
            try { fn(result); } catch (e) { console.error('[ck-ble] scan consumer error', e); }
          }
        },
      );
      this.scanning = true;
    })();
    try {
      await this.starting;
    } catch (err) {
      this.starting = null;
      this.scanning = false;
      throw err;
    }
    this.starting = null;
  },

  async stop() {
    if (!this.scanning) return;
    this.scanning = false;
    try { await BleClient.stopLEScan(); } catch (e) { /* 忽略 */ }
  },
};

/** 把插件的 ScanResult.manufacturerData（{cic:string→DataView}）转成 Web Bluetooth 的 Map<number, DataView> */
function toManufacturerDataMap(raw) {
  const map = new Map();
  for (const [key, value] of Object.entries(raw || {})) {
    const cic = Number(key);
    if (Number.isNaN(cic)) continue;
    map.set(cic, toDataView(value));
  }
  return map;
}

function toServiceDataMap(raw) {
  const map = new Map();
  for (const [key, value] of Object.entries(raw || {})) map.set(expandUuid(key), toDataView(value));
  return map;
}

/* ============================ 过滤器 ============================ */

function buildMatcher(options = {}) {
  const filters = Array.isArray(options.filters) ? options.filters : [];
  const acceptAll = options.acceptAllDevices === true || filters.length === 0;

  const names = [];
  const prefixes = [];
  const serviceSets = [];
  const mfrIds = [];

  for (const f of filters) {
    if (!f) continue;
    if (f.name) names.push(String(f.name));
    if (f.namePrefix != null) prefixes.push(String(f.namePrefix));
    if (Array.isArray(f.services) && f.services.length) serviceSets.push(f.services.map(expandUuid));
    if (Array.isArray(f.manufacturerData)) {
      for (const m of f.manufacturerData) mfrIds.push(typeof m === 'number' ? m : Number(m?.companyIdentifier));
    }
  }
  for (const m of options.optionalManufacturerData || []) {
    mfrIds.push(typeof m === 'number' ? m : Number(m?.companyIdentifier));
  }

  const matches = (res) => {
    if (acceptAll) return true;
    const name = res?.localName || res?.device?.name || '';
    const uuids = (res?.uuids || []).map(expandUuid);
    const mfr = res?.manufacturerData ? toManufacturerDataMap(res.manufacturerData) : null;

    for (const f of filters) {
      if (!f) continue;
      let ok = true;
      if (f.name && name !== f.name) ok = false;
      if (ok && f.namePrefix != null && !name.startsWith(String(f.namePrefix))) ok = false;
      if (ok && Array.isArray(f.services) && f.services.length) {
        const want = f.services.map(expandUuid);
        ok = want.every((u) => uuids.includes(u));
      }
      if (ok && Array.isArray(f.manufacturerData)) {
        ok = f.manufacturerData.every((m) => {
          const cic = typeof m === 'number' ? m : Number(m?.companyIdentifier);
          return mfr ? mfr.has(cic) : false;
        });
      }
      if (ok) return true;
    }
    // 广播里没带名字时，用「可选厂商 ID」兜底匹配（部分魔方只在广播里带 CIC）
    if (!name && mfr && mfrIds.length) {
      for (const cic of mfrIds) if (mfr.has(cic)) return true;
    }
    return false;
  };

  return { acceptAll, names, prefixes, serviceSets, mfrIds, matches };
}

/* ============================ GATT 对象 ============================ */

class CkBluetoothRemoteGATTCharacteristic extends Emitter {
  constructor(service, raw) {
    super();
    this.service = service;
    this.device = service.device;
    this.uuid = expandUuid(raw.uuid);
    this._raw = raw;
    const p = raw.properties || {};
    this.properties = {
      broadcast: !!p.broadcast,
      read: !!p.read,
      writeWithoutResponse: !!p.writeWithoutResponse,
      write: !!p.write,
      notify: !!p.notify,
      indicate: !!p.indicate,
      authenticatedSignedWrites: !!p.authenticatedSignedWrites,
      reliableWrite: !!p.reliableWrite,
      writableAuxiliaries: !!p.writableAuxiliaries,
    };
    this.value = null;
    this._notifying = false;
  }

  get _id() { return this.device.deviceId; }

  async readValue() {
    this._assertConnected();
    try {
      const value = await BleClient.read(this._id, this.service.uuid, this.uuid);
      this.value = toDataView(value);
      return this.value;
    } catch (err) {
      throw wrapNativeError(err, `readValue ${this.uuid}`);
    }
  }

  async writeValue(buffer) {
    this._assertConnected();
    const value = toDataView(buffer);
    try {
      await BleClient.write(this._id, this.service.uuid, this.uuid, value);
      this.value = value;
    } catch (err) {
      throw wrapNativeError(err, `writeValue ${this.uuid}`);
    }
  }

  writeValueWithResponse(buffer) { return this.writeValue(buffer); }

  async writeValueWithoutResponse(buffer) {
    this._assertConnected();
    const value = toDataView(buffer);
    try {
      await BleClient.writeWithoutResponse(this._id, this.service.uuid, this.uuid, value);
      this.value = value;
    } catch (err) {
      throw wrapNativeError(err, `writeValueWithoutResponse ${this.uuid}`);
    }
  }

  async startNotifications() {
    this._assertConnected();
    if (this._notifying) return this;
    try {
      await BleClient.startNotifications(this._id, this.service.uuid, this.uuid, (value) => {
        const dv = toDataView(value);
        this.value = dv;
        this._dispatch('characteristicvaluechanged', { value: dv, target: this });
      });
      this._notifying = true;
    } catch (err) {
      throw wrapNativeError(err, `startNotifications ${this.uuid}`);
    }
    return this;
  }

  async stopNotifications() {
    if (!this._notifying) return this;
    try {
      await BleClient.stopNotifications(this._id, this.service.uuid, this.uuid);
    } catch (err) {
      console.warn('[ck-ble] stopNotifications failed', err);
    }
    this._notifying = false;
    return this;
  }

  async getDescriptors() {
    return (this._raw.descriptors || []).map((d) => new CkBluetoothRemoteGATTDescriptor(this, d));
  }

  async getDescriptor(uuid) {
    const u = expandUuid(uuid);
    const found = (this._raw.descriptors || []).find((d) => expandUuid(d.uuid) === u);
    if (!found) throw bleError(`No descriptor with UUID ${uuid}`, 'NotFoundError');
    return new CkBluetoothRemoteGATTDescriptor(this, found);
  }

  _assertConnected() {
    if (!this.device.gatt.connected) throw bleError('GATT server is not connected.', 'NetworkError');
  }
}

class CkBluetoothRemoteGATTDescriptor {
  constructor(characteristic, raw) {
    this.characteristic = characteristic;
    this.uuid = expandUuid(raw.uuid);
    this.value = null;
  }
  async readValue() {
    const v = await BleClient.readDescriptor(
      this.characteristic.device.deviceId,
      this.characteristic.service.uuid,
      this.characteristic.uuid,
      this.uuid,
    );
    this.value = toDataView(v);
    return this.value;
  }
  async writeValue(buffer) {
    const value = toDataView(buffer);
    await BleClient.writeDescriptor(
      this.characteristic.device.deviceId,
      this.characteristic.service.uuid,
      this.characteristic.uuid,
      this.uuid,
      value,
    );
    this.value = value;
  }
}

class CkBluetoothRemoteGATTService {
  constructor(gatt, raw) {
    this.device = gatt.device;
    this.server = gatt;
    this.uuid = expandUuid(raw.uuid);
    this.isPrimary = true;
    this._raw = raw;
  }
  async getCharacteristics() {
    return (this._raw.characteristics || []).map((c) => new CkBluetoothRemoteGATTCharacteristic(this, c));
  }
  async getCharacteristic(uuid) {
    const u = expandUuid(uuid);
    const found = (this._raw.characteristics || []).find((c) => expandUuid(c.uuid) === u);
    if (!found) throw bleError(`No characteristic with UUID ${uuid}`, 'NotFoundError');
    return new CkBluetoothRemoteGATTCharacteristic(this, found);
  }
  async getServices() { return []; }
  async getIncludedServices() { return []; }
}

class CkBluetoothRemoteGATTServer {
  constructor(device) {
    this.device = device;
    this.connected = false;
    this._services = null;
    this._connecting = null;
  }

  async connect() {
    if (this.connected) return this;
    if (this._connecting) return this._connecting;
    await ensureReady();
    this._connecting = (async () => {
      try {
        await BleClient.connect(
          this.device.deviceId,
          () => this._onDisconnected(),
          { timeout: 20000, skipDescriptorDiscovery: false },
        );
        this.connected = true;
        this._services = null;
        return this;
      } catch (err) {
        this.connected = false;
        throw wrapNativeError(err, `connect ${this.device.name || this.device.deviceId}`);
      } finally {
        this._connecting = null;
      }
    })();
    return this._connecting;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this._services = null;
    BleClient.disconnect(this.device.deviceId).catch(() => {});
  }

  _onDisconnected() {
    if (!this.connected) return;
    this.connected = false;
    this._services = null;
    this.device._dispatch('gattserverdisconnected', { device: this.device });
  }

  async _fetchServices() {
    if (!this.connected) throw bleError('GATT server is not connected.', 'NetworkError');
    if (!this._services) {
      try {
        this._services = await BleClient.getServices(this.device.deviceId);
      } catch (err) {
        throw wrapNativeError(err, 'getServices');
      }
    }
    return this._services;
  }

  async getPrimaryServices() {
    const services = await this._fetchServices();
    return services.map((s) => new CkBluetoothRemoteGATTService(this, s));
  }

  async getPrimaryService(uuid) {
    const u = expandUuid(uuid);
    const services = await this._fetchServices();
    const found = services.find((s) => expandUuid(s.uuid) === u);
    if (!found) throw bleError(`No service with UUID ${uuid}`, 'NotFoundError');
    return new CkBluetoothRemoteGATTService(this, found);
  }
}

function wrapNativeError(err, context) {
  const message = String(err?.message || err || 'unknown error');
  const e = bleError(`[BLE] ${context} 失败：${message}`, /not found/i.test(message) ? 'NotFoundError' : 'NetworkError');
  e.cause = err;
  return e;
}

/* ============================ 设备对象 ============================ */

const KNOWN_DEVICES = new Map(); // deviceId → CkBluetoothDevice（用于 navigator.bluetooth.getDevices）

class CkBluetoothDevice extends Emitter {
  constructor({ deviceId, name = '', localName, rssi, uuids, bonded }) {
    super();
    this.id = deviceId;
    this.deviceId = deviceId; // 原生扩展字段，方便调试
    this.name = name || localName || '';
    this.localName = localName || name || '';
    this.gatt = new CkBluetoothRemoteGATTServer(this);
    this.uuids = (uuids || []).map(expandUuid);
    this.bonded = !!bonded;
    this.rssi = rssi;
    this.watchingAdvertisements = false;
    this._unsubScan = null;
    this._lastAdv = null;
    KNOWN_DEVICES.set(deviceId, this);
  }

  /** Web Bluetooth: Bluetooth Advertisements API（GAN 魔方靠它拿 MAC 地址） */
  async watchAdvertisements(options = {}) {
    await ensureReady();
    if (this.watchingAdvertisements) return;
    this.watchingAdvertisements = true;

    const signal = options.signal;
    const onAbort = () => { this.stopWatchingAdvertisements(); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    this._unsubScan = ScanHub.subscribe((res) => {
      const id = res?.device?.deviceId;
      if (!id || id !== this.deviceId) return;
      if (res.localName && !this.name) this.name = res.localName;
      if (typeof res.rssi === 'number') this.rssi = res.rssi;
      const manufacturerData = toManufacturerDataMap(res.manufacturerData);
      const adv = {
        type: 'advertisementreceived',
        device: this,
        name: res.localName || this.name,
        rssi: typeof res.rssi === 'number' ? res.rssi : undefined,
        txPower: typeof res.txPower === 'number' ? res.txPower : undefined,
        manufacturerData,
        serviceData: toServiceDataMap(res.serviceData),
        uuids: (res.uuids || []).map(expandUuid),
        rawAdvertisement: res.rawAdvertisement ? toDataView(res.rawAdvertisement) : undefined,
      };
      this._lastAdv = adv;
      this._dispatch('advertisementreceived', adv);
    });

    try {
      await ScanHub.start();
    } catch (err) {
      this.watchingAdvertisements = false;
      this._unsubScan?.();
      this._unsubScan = null;
      throw wrapNativeError(err, 'watchAdvertisements');
    }
  }

  async stopWatchingAdvertisements() {
    if (!this.watchingAdvertisements) return;
    this.watchingAdvertisements = false;
    this._unsubScan?.();
    this._unsubScan = null;
  }

  /** 原生扩展：直接读一次最近的广播包（不等事件） */
  getLastAdvertisement() { return this._lastAdv; }

  async forget() {
    this.stopWatchingAdvertisements();
    this.gatt.disconnect();
    KNOWN_DEVICES.delete(this.deviceId);
  }

  toJSON() { return { id: this.id, name: this.name, uuids: this.uuids }; }
}

/* ============================ navigator.bluetooth ============================ */

let activePicker = null;

async function requestDevice(options = {}) {
  await ensureReady();
  if (activePicker) {
    activePicker.cancel();
    activePicker = null;
  }

  const matcher = buildMatcher(options);
  const wanted = describeWanted(options);

  const picker = CkUI.devicePicker({
    title: '选择蓝牙设备',
    subtitle: wanted,
    hint: '没看到设备？确认魔方已开机、电量充足，并靠近手机后点「重新搜索」。',
    onRescan: () => rescan(),
  });
  activePicker = picker;

  picker.setScanning(true, '正在搜索…');

  // 1) 已配对设备兜底（广播没出现时也能选）
  const seedBonded = async () => {
    try {
      // ⚠️ 与 isEnabled() 同一个坑：原生插件层 `BluetoothLe.getBondedDevices()` 返回
      // `{ devices }`，公开的 `BleClient` 包装层已经把 `.devices` 拆掉、直接给**裸数组**。
      // 旧代码解构 `const { devices } = ...` → 恒 `undefined` → 这段兜底从上线起就没
      // 生效过（又正好被下面的 catch 吞掉，静默失败，只表现为「搜不到设备」）。
      const res = await BleClient.getBondedDevices();
      const devices = Array.isArray(res) ? res : res?.devices || [];
      for (const d of devices) {
        if (matcher.matches({ device: d, localName: d.name, uuids: d.uuids })) {
          picker.push({ deviceId: d.deviceId, name: d.name || '', bonded: true });
        }
      }
    } catch (e) { /* 部分机型不支持，忽略 */ }
  };

  // 2) 实时扫描
  const unsub = ScanHub.subscribe((res) => {
    if (!res?.device?.deviceId) return;
    if (!matcher.matches(res)) return;
    picker.push({
      deviceId: res.device.deviceId,
      name: res.localName || res.device.name || '',
      rssi: res.rssi,
      uuids: res.uuids,
    });
  });

  let scanError = null;
  const rescan = async () => {
    picker.setScanning(true, '正在搜索…');
    try {
      await ScanHub.start();
    } catch (err) {
      scanError = err;
      picker.setScanning(false, '搜索失败');
      picker.setNotice('扫描失败：' + String(err?.message || err));
    }
  };

  await seedBonded();
  await rescan();

  try {
    const chosen = await picker.result;
    const device = KNOWN_DEVICES.get(chosen.deviceId) ||
      new CkBluetoothDevice({
        deviceId: chosen.deviceId,
        name: chosen.name || '',
        rssi: chosen.rssi,
        uuids: chosen.uuids,
        bonded: chosen.bonded,
      });
    if (chosen.name) device.name = chosen.name;
    device._requestedServices = (options.optionalServices || [])
      .concat(...(options.filters || []).map((f) => f?.services || []))
      .map(expandUuid);
    return device;
  } catch (err) {
    if (scanError && err?.name === 'NotFoundError') throw wrapNativeError(scanError, 'requestDevice');
    throw err;
  } finally {
    unsub();
    // 只有还是自己这轮的选择器才能清：并发调用 requestDevice 时，
    // 上一轮的 finally 会在新一轮已经建好选择器之后才跑到，直接置 null
    // 会把新一轮的选择器引用弄丢（第三个请求就取消不掉它了）
    if (activePicker === picker) activePicker = null;
    if (ScanHub.consumers.size === 0) ScanHub.stop();
  }
}

function describeWanted(options = {}) {
  const prefixes = (options.filters || []).map((f) => f?.namePrefix).filter(Boolean);
  if (prefixes.length) return `匹配前缀：${[...new Set(prefixes)].join(' / ')}`;
  const services = (options.filters || []).flatMap((f) => f?.services || []);
  if (services.length) return `匹配服务：${services.map((s) => expandUuid(s).slice(4, 8)).join(' / ')}`;
  if (options.acceptAllDevices) return '显示附近所有蓝牙低功耗设备';
  return '显示匹配的设备';
}

async function getAvailability() {
  // 按 Web Bluetooth 规范，getAvailability() 只是能力查询、不该要权限。
  // 以前这里先走 ensureReady() → BleClient.initialize()，在 Android 上等于
  // 应用一启动就弹"附近的设备"授权框 —— 体验是灾难。isEnabled() 在原生侧
  // 只读蓝牙适配器，不需要 initialize()，直接用它。
  //
  // ⚠️ 语义修正（125）：只要适配器存在就返回 true——「蓝牙开关暂时没开」不等于
  // 「这个环境用不了蓝牙」。站点的 giikerutil.chkAvail() 拿到 false 会直接报
  // 「当前浏览器不可用 Web Bluetooth」（124 真机回执），并把 ensureReady 里
  // 「蓝牙未开启 → 打开蓝牙」的友好引导整个挡掉。开关未开时统一由
  // requestDevice 流程负责引导开启。
  try {
    await BleClient.isEnabled();
    return true;
  } catch (e) {
    // 还没 initialize 等 → 不能就此判死（真正的可用性检查由 requestDevice 里的
    // ensureReady 做）；只有明确没有蓝牙适配器时才如实报"不支持"
    return !/adapter|unavailable/i.test(String(e?.message || ''));
  }
}

async function getDevices() {
  return [...KNOWN_DEVICES.values()];
}

/* ============================ 安装 ============================ */

/**
 * 安装 polyfill。
 * @param {object} opts
 * @param {boolean} opts.force 即使已有 navigator.bluetooth 也覆盖（默认 false）
 */
export function installWebBluetoothPolyfill(opts = {}) {
  if (typeof navigator === 'undefined') return false;
  const existing = navigator.bluetooth;
  if (existing && !opts.force && !existing.__ckPolyfill) return false;

  const api = {
    __ckPolyfill: true,
    requestDevice,
    getAvailability,
    getDevices,
    // 让站点里的能力检测顺利通过
    requestLEScan: undefined,
    _native: BleClient,
    _scanHub: ScanHub,
    _ensureReady: ensureReady,
  };

  try {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      enumerable: true,
      get: () => api,
    });
  } catch (e) {
    navigator.bluetooth = api;
  }

  // 站点里常见「不支持 Web Bluetooth」的降级提示，在原生环境下不应出现
  try {
    window.__CK_WEB_BLUETOOTH_POLYFILL__ = true;
  } catch (e) { /* noop */ }

  return true;
}

export const CkBle = {
  installWebBluetoothPolyfill,
  ensureReady,
  expandUuid,
  toDataView,
  dataViewToHex,
  ScanHub,
  BleClient,
};

export default CkBle;
