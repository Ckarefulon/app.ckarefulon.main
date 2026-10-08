# 蓝牙 BLE：Web Bluetooth 原生桥

## 1. 为什么需要桥

Android 的 WebView **不支持 Web Bluetooth**，而站点里所有魔方硬件代码都基于它：

- `Cube/*/assets/hardware/bluetooth.js`（设备选择 / 广播等待）
- `gancube.js / giikercube.js / moyucube.js / gocube.js / qiyicube.js`（协议实现）
- `Cube/Analyzer/Beta/smartcube-bridge.js`

壳运行时在页面脚本执行**之前**同步安装 polyfill（注入点是 `<head>` 里的第一个 `<script>`），
把 `navigator.bluetooth` 替换为基于 `@capacitor-community/bluetooth-le`（原生 BLE）的实现。
**站点代码零修改**；在桌面 Chrome/Edge 里 polyfill 不生效，继续用浏览器原生 Web Bluetooth。

## 2. 已实现的 API 对照

| Web Bluetooth | 原生实现 |
| --- | --- |
| `navigator.bluetooth.requestDevice({filters, optionalServices, optionalManufacturerData})` | 原生扫描（低延迟 + 重复广播）+ 自绘设备选择器；并合并“已配对设备”兜底 |
| `navigator.bluetooth.getAvailability()` / `getDevices()` | 适配器存在即 true（**开关暂时关闭也报 true**，未开启由 ensureReady 的「打开蓝牙」弹框引导——否则站点 chkAvail 会误报「浏览器不可用 Web Bluetooth」） / 本次会话已授权设备 |
| `device.gatt.connect()/disconnect()/connected` | `BleClient.connect(id, onDisconnect)` |
| `gatt.getPrimaryService(s)()` | `BleClient.getServices(id)` |
| `service.getCharacteristic(s)()` | 服务内特征值列表（UUID 统一展开为 128 位） |
| `characteristic.readValue()/writeValue()/writeValueWithResponse()/writeValueWithoutResponse()` | `BleClient.read/write/writeWithoutResponse`（ArrayBuffer/TypedArray/DataView 全部兼容） |
| `startNotifications()/stopNotifications()` + `characteristicvaluechanged` | `BleClient.startNotifications` 回调 → 事件（`event.target.value` 为 DataView） |
| `device.watchAdvertisements({signal})` + `advertisementreceived` | 持续扫描并按 deviceId 过滤；`event.manufacturerData` 为 `Map<公司ID, DataView>`（GAN 取 MAC 的关键） |
| `device.addEventListener('gattserverdisconnected')` | 原生断连回调 |
| `descriptor.readValue()/writeValue()` | `BleClient.readDescriptor/writeDescriptor` |

UUID 兼容：4 位/8 位短 UUID 自动展开（`ffd5` → `0000ffd5-0000-1000-8000-00805f9b34fb`）。

### ⚠️ `isEnabled()` 的返回形态（127 踩坑，勿踩）

`@capacitor-community/bluetooth-le` 有两层，返回形态**不一样**：

| 层 | 调用 | 返回 |
| --- | --- | --- |
| 原生插件层 | `BluetoothLe.isEnabled()` / `isLocationEnabled()` | `{ value: boolean }` |
| 公开包装层（8.x） | `BleClient.isEnabled()` / `isLocationEnabled()` | **裸 `boolean`**（JS 侧已把 `.value` 拆掉） |

polyfill 用的是 `BleClient.*`，所以**只能读返回值本身，不能再读 `.value`**。
126 就是读了 `.value` → 恒 `undefined` → 恒 falsy → `waitEnabled()` 必然超时：
蓝牙一直开着，用户也先看到「蓝牙未开启」、点「打开蓝牙」后再等 8 秒被抛
「蓝牙未就绪」。取值统一走 `readFlag()`（两种形态都认），别再退回去直接读 `.value`。

同一个陷阱还咬过第二次（129 修）：`getBondedDevices()` 同样是「原生层给
`{ devices }`、包装层给**裸数组**」。选择器里写的 `const { devices } = await …`
恒 `undefined`，导致「已配对设备兜底」从上线起就没生效过，而它外面套着
`catch {}`，所以不报错、只表现为**搜不到设备**。现在按
`Array.isArray(r) ? r : r?.devices || []` 取。

> **通用规则：这里的两层 API 形状不一样。**
> `definitions.d.ts` 是**原生层**（`BluetoothLe`，返回 `{ value }` / `{ devices }` 这类包壳），
> `bleClient.d.ts` 是 polyfill 实际用的**包装层**（已把壳拆掉）。
> 接新方法时先去 `dist/esm/bleClient.d.ts` 核对签名与返回类型，别照抄 definitions。

## 3. 权限（AndroidManifest，已在 patch-android.mjs 中维护）

- Android 12+：`BLUETOOTH_SCAN`（带 `neverForLocation` 标记）、`BLUETOOTH_CONNECT`
- Android ≤11：`BLUETOOTH`、`BLUETOOTH_ADMIN`、`ACCESS_FINE_LOCATION`、`ACCESS_COARSE_LOCATION`（maxSdk 30）
- `uses-feature bluetooth_le required=false`（无蓝牙硬件也能安装）

⚠️ `neverForLocation` 必须三处一致：manifest 的 `usesPermissionFlags`、`app.config.json` 的
`android.bluetooth.neverForLocation`、polyfill 里 `BleClient.initialize({ androidNeverForLocation: true })`。
任何一处是 false，Android 12+ 都会额外索要定位权限——而 manifest 把定位限制在 maxSdk 30，
12+ 上这项授权必然失败，表现为「用户已给『附近的设备』权限，App 仍提示没有权限」（123 版实测踩坑，124 修复）。

运行时体验：
1. 首次连接弹出系统“附近的设备”授权（≤11 还有位置权限）；
2. 蓝牙未开 → 弹“打开蓝牙”；
3. ≤11 且定位服务关闭 → 提示去开启（系统限制，App 不收集位置）；
4. 拒绝授权 → 引导去系统设置。

## 4. 设备选择器

因为原生没有 Web Bluetooth 的 chooser，壳自绘了一个与站点设计语言一致的选择面板：
按 `namePrefix / name / services / manufacturerData` 过滤（与站点 filters 完全一致），
实时显示信号强度条 + dBm，含“已配对”设备兜底与“重新搜索”。

## 5. 调试

```js
CkApp.bluetooth            // { BleClient, ScanHub, ensureReady, expandUuid, toDataView, dataViewToHex }
CkApp.bluetooth.BleClient.isEnabled()
CkApp.bluetooth.ScanHub    // 单例扫描调度（同一时刻只有一个原生扫描）
navigator.bluetooth.__ckPolyfill   // true 表示当前走的是原生桥
```

日志前缀：`[ck-ble]`、`[ck-update]`（Chrome 远程调试：`chrome://inspect`）。

## 6. 已知限制

- `watchAdvertisements` 依赖持续扫描；Android 对扫描频率有限流（30 秒内最多 5 次启停），壳用单例 ScanHub 复用同一次扫描来规避。
- 未实现：`BluetoothUUID` 常量表、`device.forget()` 的系统级解绑（仅本地清理）、周期性广播（Periodic Advertising）。
- 经典蓝牙（SPP 串口）未启用；如以后需要，加装 `@capacitor-community/bluetooth-classic` 之类的插件并在权限块里补充。
