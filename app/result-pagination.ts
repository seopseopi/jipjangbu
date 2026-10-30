import { useEffect, useRef, useState } from "react";

export function resultPageBounds(page: number, pageSize: number, loaded: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(0, Math.min(page, pages - 1, Math.max(0, Math.ceil(loaded / pageSize) - 1)));
  return { page: current, pages, start: current * pageSize, end: Math.min((current + 1) * pageSize, loaded, total) };
}

/** Keep local pages small while retaining the server's guarded, incremental reads. */
export function useResultPage(loaded: number, total: number, queryKey: string, pageSize: number) {
  const [selection, setSelection] = useState({ queryKey, page: 0, scope: 0 });
  const scope = selection.queryKey === queryKey ? selection.scope : selection.scope + 1;
  const bounds = resultPageBounds(selection.queryKey === queryKey ? selection.page : 0, pageSize, loaded, total);
  if (selection.queryKey !== queryKey || selection.page !== bounds.page) setSelection({ queryKey, page: bounds.page, scope });
  function previous() { setSelection({ queryKey, page: Math.max(0, bounds.page - 1), scope }); }
  async function next(loadMore?: () => Promise<number | undefined>) {
    const nextPage = bounds.page + 1;
    if (nextPage >= bounds.pages) return;
    const count = nextPage * pageSize < loaded ? loaded : await loadMore?.();
    // A failed or stale read must leave the visible page and its records intact.
    if (count !== undefined && nextPage * pageSize < count) {
      setSelection(current => current.queryKey === queryKey && current.scope === scope ? { queryKey, page: nextPage, scope } : current);
    }
  }
  return { ...bounds, previous, next };
}

export function useResultListRef(page: number, queryKey: string) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [page, queryKey]);
  return listRef;
}
