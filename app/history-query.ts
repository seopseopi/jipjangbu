export type RelatedHistoryTarget =
  | { kind: "customer"; id: string; name: string }
  | { kind: "listing"; key: string; name: string };

export const HISTORY_PAGE_SIZE = 10;

/** Keep the browser's identity rule aligned with db/listing-sync.ts. */
export function createPropertyHistoryTarget(detail: {
  propertyType: string;
  buildingName: string;
  buildingDong: string;
  unitNumber: string;
}): RelatedHistoryTarget | null {
  const parts = [
    detail.propertyType,
    detail.buildingName,
    detail.buildingDong,
    detail.unitNumber,
  ].map((value) => value.trim());
  if (!parts[0] || !parts[1] || (parts[0] !== "토지" && !parts[3])) return null;
  return {
    kind: "listing",
    key: parts.map((value) => value.toLocaleLowerCase("ko-KR")).join("|"),
    name: [parts[0], parts[1], parts[2] && `${parts[2]}동`, parts[3] && `${parts[3]}호`]
      .filter(Boolean)
      .join(" "),
  };
}

export function historyTargetKey(target: RelatedHistoryTarget): string {
  return JSON.stringify([
    target.kind,
    target.kind === "customer" ? target.id : target.key,
  ]);
}

export function historyQueryUrl(
  target: RelatedHistoryTarget,
  offset = 0,
  workType = "",
): string {
  if (target.kind === "listing") {
    return `/api/listings/${encodeURIComponent(target.key)}`;
  }
  const params = new URLSearchParams({
    customerId: target.id,
    includeSource: "1",
    limit: String(HISTORY_PAGE_SIZE),
    offset: String(Math.max(0, Math.floor(offset))),
  });
  if (workType) params.set("workType", workType);
  return `/api/work-logs?${params}`;
}

export function mergeHistoryRecords<T extends { id: string }>(
  previous: T[],
  next: T[],
): T[] {
  const seen = new Set(previous.map((item) => item.id));
  return [
    ...previous,
    ...next.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

/** The shared client invalidates in-flight GETs when another view saves. */
export async function retryInterruptedHistoryRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await read(signal);
  } catch (error) {
    if (
      !signal.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      return read(signal);
    }
    throw error;
  }
}

type HistoryRequestResult<T> =
  | { status: "success"; value: T }
  | { status: "error"; error: unknown }
  | { status: "ignored" };

/** One active read per panel; disposed panels can never commit late results. */
export function createHistoryRequestScope() {
  let disposed = false;
  let active: AbortController | null = null;
  return {
    get busy() {
      return active !== null;
    },
    async run<T>(
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<HistoryRequestResult<T>> {
      if (disposed || active) return { status: "ignored" };
      const controller = new AbortController();
      active = controller;
      try {
        const value = await task(controller.signal);
        return disposed || controller.signal.aborted
          ? { status: "ignored" }
          : { status: "success", value };
      } catch (error) {
        return disposed || controller.signal.aborted
          ? { status: "ignored" }
          : { status: "error", error };
      } finally {
        if (active === controller) active = null;
      }
    },
    dispose() {
      disposed = true;
      active?.abort();
      active = null;
    },
  };
}
