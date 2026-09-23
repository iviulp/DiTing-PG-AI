/// vitest 全局 setup: 轻量 localStorage polyfill (node 环境无 DOM)
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true
  });
}

/// WP8 T8: window.alert/confirm 防回归 spy — Tauri WKWebView 中两者是 no-op,
/// 全仓已替换为 appDialog/InlineBanner; 任何测试触发原生 alert/confirm 即失败。
import { afterEach } from 'vitest';

const nativeDialogCalls: string[] = [];
(globalThis as any).__nativeDialogCalls = nativeDialogCalls;

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'alert', {
    value: (msg?: any) => {
      nativeDialogCalls.push(`alert: ${String(msg)}`);
    },
    writable: true,
    configurable: true
  });
  Object.defineProperty(window, 'confirm', {
    value: (msg?: any) => {
      nativeDialogCalls.push(`confirm: ${String(msg)}`);
      return false;
    },
    writable: true,
    configurable: true
  });
}

afterEach(() => {
  if (nativeDialogCalls.length > 0) {
    const calls = nativeDialogCalls.splice(0);
    throw new Error(
      `WP8 T8: 检测到原生 window.alert/confirm 调用 (Tauri WKWebView 中是 no-op, 必须走 appDialog/InlineBanner):\n${calls.join('\n')}`
    );
  }
});
