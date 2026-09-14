export type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAllPages<T>(fetchPage: (from: number, to: number) => Promise<PageResult<T>>, pageSize = 500) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("分页大小无效");
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function readConsistentSnapshot<T>(readVersion: () => Promise<number>, readSnapshot: () => Promise<T>, maxAttempts = 3) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new Error("快照重试次数无效");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await readVersion();
    const snapshot = await readSnapshot();
    const after = await readVersion();
    if (before === after) return { version: after, snapshot };
  }
  throw new Error("账本正在更新，请重试");
}
