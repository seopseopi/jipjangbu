/** Rows may only be extended by a page fetched with their exact query. */
export function canAppendPage(
  loadedQuery: string | null,
  currentQuery: string,
  firstPagePending: boolean,
  nextPagePending: boolean,
) {
  return loadedQuery === currentQuery && !firstPagePending && !nextPagePending;
}

/** Do not silently show a partial result when a later page fails or repeats. */
export async function collectOffsetPages<T extends { id: string }>(
  read: (offset: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (;;) {
    const page = await read(rows.length);
    if (!Array.isArray(page) || page.length > pageSize) throw new Error("목록 조회 결과를 확인할 수 없습니다. 다시 불러와 주세요.");
    for (const row of page) {
      if (!row || typeof row.id !== "string" || seen.has(row.id)) {
        throw new Error("조회 중 목록이 변경되었습니다. 다시 불러와 주세요.");
      }
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < pageSize) return rows;
  }
}
