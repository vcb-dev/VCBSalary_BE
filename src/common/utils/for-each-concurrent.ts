/**
 * Chạy một worker pool có giới hạn mà không tạo Promise cho toàn bộ danh sách cùng lúc.
 * `apply` lỗi sẽ reject toàn bộ; caller cần tự bắt lỗi theo item nếu muốn tiếp tục.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  apply: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency phải là số nguyên dương');
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await apply(item);
      }
    }),
  );
}
