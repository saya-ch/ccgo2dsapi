// vendor/stream-pipeline.mjs —— 三套协议共用的流式骨架
//
// 为什么抽出来：OpenAI / Anthropic / Responses 三套流式实现各写了一遍
// 相同的「安全逻辑」——abort 检测、背压保护、截断判定、错误收尾。
// 上一轮复审发现的「流截断当成功」bug 就是三条路径各漏了一次。
//
// 抽成骨架后，这些容易漏的逻辑只写一遍，协议层只负责「如何把事件
// 翻译成 SSE 帧」。

import { readNdjsonEvents } from "./wire.mjs";

/**
 * 消费上游流并驱动协议层的回调。
 *
 * 安全职责（本函数负责）：
 *   - 客户端断开 → 立即停止消费、取消上游
 *   - 写背压积压过多 → 断开，避免内存无界增长
 *   - 上游既无 finish 也无 abort → 判定截断，调 onTruncated
 *   - 上游 error 事件 → 调 onError，且不再继续
 *   - 任何异常 → 调 onError 后正常收尾
 *
 * 协议职责（调用方负责）：
 *   - onReasoning / onText / onTool / onFinish 里把事件翻译成 SSE 帧
 *   - onError / onTruncated 里发本协议的错误帧
 *
 * @param {object} o
 * @param {ReadableStream} o.body        上游响应体
 * @param {http.ServerResponse} o.res    客户端响应
 * @param {AbortController} [o.abort]    中止通道
 * @param {Function} [o.onReasoning]     (text) => void
 * @param {Function} [o.onText]          (text) => void
 * @param {Function} [o.onTool]          (ev) => void
 * @param {Function} [o.onFinish]        (ev) => void
 * @param {Function} [o.onError]         (message, err) => void
 * @param {Function} [o.onTruncated]     (message) => void
 * @returns {Promise<{sawFinish:boolean, sawAbort:boolean, failed:boolean}>}
 */
export async function runStream({
  body,
  res,
  abort,
  onReasoning,
  onText,
  onTool,
  onFinish,
  onError,
  onTruncated,
  maxBacklog = 5,
}) {
  let sawFinish = false;
  let sawAbort = false;
  let failed = false;

  const isGone = () => res.writableEnded || res.destroyed;
  const tooSlow = () => (res.__ccgoBacklog || 0) > maxBacklog;

  try {
    for await (const ev of readNdjsonEvents(body)) {
      if (isGone()) { abort?.abort(); break; }
      if (tooSlow()) { abort?.abort(); break; }

      const t = ev.type;

      if (t === "abort") { sawAbort = true; continue; }

      if (t === "reasoning-delta") {
        if (ev.text) onReasoning?.(ev.text);
        continue;
      }

      if (t === "text-delta") {
        if (ev.text) onText?.(ev.text);
        continue;
      }

      if (t === "tool-call") {
        onTool?.(ev);
        continue;
      }

      if (t === "finish") {
        sawFinish = true;
        onFinish?.(ev);
        continue;
      }

      if (t === "error") {
        failed = true;
        const msg = typeof ev.error === "string" ? ev.error : ev.error?.message;
        onError?.(msg || "upstream error", ev);
        break;
      }
    }
  } catch (e) {
    failed = true;
    // 已经收到 finish/abort 说明是收尾阶段出错，否则就是截断
    if (sawFinish || sawAbort) onError?.(e.message, e);
    else onTruncated?.(e.message || "upstream stream failed");
  }

  // 既没有 finish 也没有 abort = 流被截断，不能当成功
  if (!failed && !sawFinish && !sawAbort) {
    onTruncated?.("upstream stream truncated before completion");
    return { sawFinish, sawAbort, failed: true };
  }

  return { sawFinish, sawAbort, failed };
}
