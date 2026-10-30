import { useEffect, useRef } from "react";

export function ListingScrollLoader({
  queryKey,
  loaded,
  hasMore,
  enabled,
  busy,
  error,
  onLoadMore,
}: {
  queryKey: string;
  loaded: number;
  hasMore: boolean;
  enabled: boolean;
  busy: boolean;
  error: string;
  onLoadMore?: () => Promise<number | undefined>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<object | null>(null);
  const previousQuery = useRef(queryKey);

  useEffect(() => {
    if (previousQuery.current === queryKey) return;
    previousQuery.current = queryKey;
    pendingRef.current = null;
    window.scrollTo({ top: 0 });
  }, [queryKey]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !enabled || busy || error || !hasMore || !onLoadMore) return;
    let active = true;
    const preload = 480;
    async function requestMore() {
      if (!active || pendingRef.current || !onLoadMore) return;
      const request = {};
      pendingRef.current = request;
      try {
        await onLoadMore();
      } catch {
        // The parent preserves the rows and owns the existing retry message.
      } finally {
        if (pendingRef.current === request) pendingRef.current = null;
      }
    }

    if (typeof window.IntersectionObserver === "function") {
      const observer = new window.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.target === sentinel && entry.isIntersecting)) void requestMore();
      }, { root: null, rootMargin: `${preload}px 0px`, threshold: 0 });
      observer.observe(sentinel);
      return () => {
        active = false;
        observer.disconnect();
      };
    }

    let frame = 0;
    const checkPosition = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!active) return;
        const bounds = sentinel.getBoundingClientRect();
        if (bounds.top <= window.innerHeight + preload && bounds.bottom >= -preload) void requestMore();
      });
    };
    window.addEventListener("scroll", checkPosition, { passive: true });
    window.addEventListener("resize", checkPosition);
    checkPosition();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", checkPosition);
      window.removeEventListener("resize", checkPosition);
    };
  }, [queryKey, loaded, hasMore, enabled, busy, error, onLoadMore]);

  return <div ref={sentinelRef} className="listing-scroll-loader" style={{ minHeight: 1 }}>
    {busy && <p role="status">매물을 더 불러오는 중…</p>}
  </div>;
}
