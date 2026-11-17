import { message as localize } from './i18n.js';
import { translate } from './translator.js';

export const CONNECTION_CHECK_TIMEOUT_MS = 45_000;

export async function checkConnection({
  settings,
  signal,
  fetchImpl,
  permissionsApi,
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(localize('invalidConnectionTimeout', '连接检测超时时间无效。'));
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) throw new Error(localize('connectionCheckCancelled', '连接检测已取消。'));
  signal?.addEventListener('abort', onAbort, { once: true });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = performance.now();

  try {
    const translation = await translate({
      text: 'Hello, world.',
      settings,
      fetchImpl,
      permissionsApi,
      signal: controller.signal,
    });
    if (signal?.aborted) throw new Error(localize('connectionCheckCancelled', '连接检测已取消。'));
    if (timedOut) throw new Error(localize('connectionTimeout', `连接检测超时（${Math.ceil(timeoutMs / 1000)} 秒），请检查服务状态后重试。`, Math.ceil(timeoutMs / 1000)));
    return { translation, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } catch (error) {
    if (signal?.aborted) throw new Error(localize('connectionCheckCancelled', '连接检测已取消。'));
    if (timedOut) throw new Error(localize('connectionTimeout', `连接检测超时（${Math.ceil(timeoutMs / 1000)} 秒），请检查服务状态后重试。`, Math.ceil(timeoutMs / 1000)));
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}
