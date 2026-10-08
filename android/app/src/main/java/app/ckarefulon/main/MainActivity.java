package app.ckarefulon.main;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import java.io.File;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        resetWebRuntimeIfUpgraded();
        super.onCreate(savedInstanceState);
        applySystemBarInsets();
    }

    /**
     * targetSdk 35+ 系统强制 edge-to-edge：WebView 会一直顶到屏幕最上沿，
     * 站点导航就被压在状态栏底下（底部内容也会被手势条盖住）。
     * 这里把系统栏/刘海的 insets 换成 WebView 的外边距 —— 内容从状态栏下面开始，
     * 导航完整可见可点。insets 在这里消费掉，CSS 的 env(safe-area-inset-*) 不会再叠加。
     * 键盘仍走 adjustResize（manifest 已配），这里刻意不吃 ime insets，避免双重避让。
     */
    private void applySystemBarInsets() {
        try {
            View web = findViewById(R.id.webview);
            if (web == null) return;
            ViewCompat.setOnApplyWindowInsetsListener(web, (v, windowInsets) -> {
                applyBarMargins(v, windowInsets);
                return WindowInsetsCompat.CONSUMED;
            });
        } catch (Throwable ignored) {
            // insets 处理失败绝不能影响启动
        }
    }

    /**
     * 兜底：不依赖 insets 派发，直接读根视图的 insets 补一次边距。
     * 个别机型/时序下系统栏 insets 不会派发到 WebView，监听器收不到，
     * 边距就设置不上去 —— 页面继续顶到状态栏底下。onResume 里显式补一次。
     * 两条机制设置的是同一个值，重复执行是幂等的，不会叠加。
     */
    @Override
    public void onResume() {
        super.onResume();
        try {
            View web = findViewById(R.id.webview);
            WindowInsetsCompat root = web == null ? null : ViewCompat.getRootWindowInsets(web);
            if (root != null) applyBarMargins(web, root);
        } catch (Throwable ignored) {
        }
    }

    private void applyBarMargins(View web, WindowInsetsCompat windowInsets) {
        try {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) web.getLayoutParams();
            if (lp != null && (lp.topMargin != bars.top || lp.bottomMargin != bars.bottom)) {
                lp.topMargin = bars.top;
                lp.bottomMargin = bars.bottom;
                web.setLayoutParams(lp);
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 清掉 ServiceWorker 的**注册表和脚本缓存**（任何 profile 目录）。
     * 只在**版本变化（覆盖安装）**时调用 —— 旧 APK 的 SW 可能把 https://localhost/
     * 的文档请求直接搞成 ERR_FAILED，使新代码无法运行自救；清掉后壳会立刻重新注册
     * （脚本在 APK 内，极快）。
     * 版本没变就**保留注册**：热启动时 controller 立等可取，壳能静默秒进站点。
     * 以前每次冷启动都清 → 每次都要重装一遍 SW → 启动页每次都要闪一下
     * "正在安装离线服务/正在缓存"（用户回执的"二进闪缓存界面"）。
     *
     * ⚠️ 只能删 Database / ScriptCache，**绝不能删整个 "Service Worker" 目录**：
     * Chromium 把 CacheStorage（站点离线缓存）存在它的子目录 Service Worker/CacheStorage 里。
     * 以前删的是整个目录 → 每次冷启动都把离线缓存清空 → 用户每次打开都要重新下载首屏，
     * 断网冷启动直接进不去（"每次都要缓存，还没修好"的真凶）。
     */
    private void purgeServiceWorkerRegistrations() {
        try {
            File webview = new File(getDataDir(), "app_webview");
            File[] profiles = webview.listFiles();
            if (profiles == null) return;
            for (File profile : profiles) {
                if (!profile.isDirectory()) continue;
                File sw = new File(profile, "Service Worker");
                deleteDeep(new File(sw, "Database"));
                deleteDeep(new File(sw, "ScriptCache"));
            }
        } catch (Throwable ignored) {
        }
    }

    private void resetWebRuntimeIfUpgraded() {
        try {
            SharedPreferences sp = getSharedPreferences("ck_shell", MODE_PRIVATE);
            int last = sp.getInt("versionCode", 0);
            int now = (int) getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            if (last != 0 && last != now) {
                // 只在版本变化时清理：
                // ① 旧 SW 注册 + 脚本缓存（防旧 SW 拦死文档请求，新代码无法自救）
                purgeServiceWorkerRegistrations();
                // ② HTTP / 代码缓存（旧壳的编译产物）。
                // **不清站点离线缓存（CacheStorage）和 Local Storage**：
                // 产品要求"先保证正常打开，即使不是最新版" —— 升级后照样秒进旧内容，
                // 新版由进站后的更新检查在后台下载完，再弹框让用户确认刷新。
                File def = new File(getDataDir(), "app_webview/Default");
                deleteDeep(new File(def, "Cache"));
                deleteDeep(new File(def, "Code Cache"));
            }
            if (last != now) {
                sp.edit().putInt("versionCode", now).apply();
            }
        } catch (Throwable ignored) {
            // 绝不允许清理逻辑影响启动
        }
    }

    private void deleteDeep(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteDeep(c);
        }
        f.delete();
    }
}
