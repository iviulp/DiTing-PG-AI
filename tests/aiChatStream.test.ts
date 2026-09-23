/// WP9: aiChatStream serde 契约防御测试
/// 根因: 后端 StreamEvent::Done{full_text} 因缺 rename_all_fields 序列化为 snake_case,
/// 前端 msg.fullText=undefined → resolve(undefined) → AiSidebar reply.match() 崩溃
/// (用户现象: "AI 输出到半截报错 undefined is not an object (evaluating 'Gt.match')")
/// 本测试守护前端防御层: Done 缺 fullText 时回退到 delta 累积的真实内容, 绝不 resolve undefined
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 捕获传给 invoke 的 channel, 以便手动驱动 onmessage
let capturedChannel: any = null;
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
  Channel: class {
    onmessage: any = null;
    constructor() {
      capturedChannel = this;
    }
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { aiChatStream } from '../src/services/ipc';

describe('WP9: aiChatStream 流式契约防御 (AI 输出半截崩溃修复)', () => {
  beforeEach(() => {
    capturedChannel = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation((_cmd: string, args: any) => {
      capturedChannel = args.channel;
      return Promise.resolve(); // 命令本身成功; 事件由 channel.onmessage 驱动
    });
  });

  it('正常契约: delta 累积 + done.fullText → resolve fullText', async () => {
    const deltas: string[] = [];
    const p = aiChatStream('q', undefined, undefined, (t) => deltas.push(t));
    // 驱动真实事件序列 (与后端 prompt_stream 一致)
    capturedChannel.onmessage({ type: 'delta', text: 'SELECT ' });
    capturedChannel.onmessage({ type: 'delta', text: '* FROM t' });
    capturedChannel.onmessage({ type: 'done', fullText: 'SELECT * FROM t' });
    await expect(p).resolves.toBe('SELECT * FROM t');
    expect(deltas).toEqual(['SELECT ', '* FROM t']);
  });

  it('契约异常: done 缺 fullText (snake_case full_text) → 回退 delta 累积真实内容, 不 resolve undefined', async () => {
    const p = aiChatStream('q', undefined, undefined, () => {});
    capturedChannel.onmessage({ type: 'delta', text: '飞书审批通过' });
    capturedChannel.onmessage({ type: 'delta', text: '但 ITSM 未提交' });
    // 模拟修复前后端发出的错误形状: 字段是 full_text 而非 fullText
    capturedChannel.onmessage({ type: 'done', full_text: '飞书审批通过但 ITSM 未提交' } as any);
    const result = await p;
    // 关键断言: 不是 undefined (否则 reply.match() 崩溃), 而是已收到的真实流式内容
    expect(result).not.toBeUndefined();
    expect(typeof result).toBe('string');
    expect(result).toBe('飞书审批通过但 ITSM 未提交');
  });

  it('done.fullText 非字符串 (null) → 回退累积, 不崩溃', async () => {
    const p = aiChatStream('q', undefined, undefined, () => {});
    capturedChannel.onmessage({ type: 'delta', text: 'abc' });
    capturedChannel.onmessage({ type: 'done', fullText: null } as any);
    await expect(p).resolves.toBe('abc');
  });

  it('error 事件 → reject 真实错误消息', async () => {
    const p = aiChatStream('q', undefined, undefined, () => {});
    capturedChannel.onmessage({ type: 'error', message: 'AI_ERROR: upstream 500' });
    await expect(p).rejects.toThrow('AI_ERROR: upstream 500');
  });

  it('delta.text 非字符串时不污染累积 (防御畸形帧)', async () => {
    const p = aiChatStream('q', undefined, undefined, () => {});
    capturedChannel.onmessage({ type: 'delta', text: 'real ' });
    capturedChannel.onmessage({ type: 'delta', text: null } as any); // 畸形帧
    capturedChannel.onmessage({ type: 'delta', text: 'content' });
    capturedChannel.onmessage({ type: 'done', fullText: undefined } as any); // 触发回退
    await expect(p).resolves.toBe('real content');
  });
});
