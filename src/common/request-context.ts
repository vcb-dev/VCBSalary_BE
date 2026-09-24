import { AsyncLocalStorage } from 'async_hooks';

type RequestContext = {
  memo: Map<string, Promise<unknown>>;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Chạy `callback` trong ngữ cảnh của một HTTP request; mọi await bên trong đều thấy cùng memo. */
export function runInRequestContext<T>(callback: () => T): T {
  return storage.run({ memo: new Map() }, callback);
}

/**
 * Dùng chung kết quả `load` trong phạm vi một request — JWT strategy, guard và service cùng đọc
 * một hồ sơ quyền mà chỉ tốn một round-trip. Ngoài request (job nền, unit test) thì luôn gọi
 * `load`, nên dữ liệu không bao giờ bị giữ lại giữa các request.
 */
export function memoizeForRequest<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const memo = storage.getStore()?.memo;
  if (!memo) return load();

  const cached = memo.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const pending = load();
  memo.set(key, pending);
  // Lỗi tạm thời không được "dính" vào các lần đọc sau trong cùng request.
  pending.catch(() => memo.delete(key));
  return pending;
}
