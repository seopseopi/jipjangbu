import { useEffect, useRef, useState } from "react";

export function resultPageBounds(page: number, pageSize: number, loaded: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(0, Math.min(page, pages - 1, Math.max(0, Math.ceil(loaded / pageSize) - 1)));
  return { page: current, pages, start: current * pageSize, end: Math.min((current + 1) * pageSize, loaded, total) };
}

/** Keep local pages small while retaining the server's guarded, incremental reads. */
export function useResultPage(loaded: number, total: number, queryKey: string, pageSize: number) {
  const [selection, setSelection] = useState({ queryKey, page: 0 });
  const activeKey = useRef(queryKey);
  const listRef = useRef<HTMLDivElement>(null);
  activeKey.current = queryKey;
  const bounds = resultPageBounds(selection.queryKey === queryKey ? selection.page : 0, pageSize, loaded, total);
  if (selection.queryKey !== queryKey || selection.page !== bounds.page) setSelection({ queryKey, page: bounds.page });
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [bounds.page, queryKey]);
  function previous() { setSelection({ queryKey, page: Math.max(0, bounds.page - 1) }); }
  async function next(loadMore?: () => Promise<number | undefined>) {
    const nextPage = bounds.page + 1;
    if (nextPage >= bounds.pages) return;
    const count = nextPage * pageSize < loaded ? loaded : await loadMore?.();
    // A failed or stale read must leave the visible page and its records intact.
    if (activeKey.current === queryKey && count !== undefined && nextPage * pageSize < count) {
      setSelection({ queryKey, page: nextPage });
    }
  }
  return { ...bounds, listRef, previous, next };
}
