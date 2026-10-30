import { Icon } from "./icons";

type SummaryEvent = {
  work_log_id?: string | null;
  event_date?: string;
  status?: string | null;
  notes?: string | null;
  work_updated_at?: string | null;
  work_created_at?: string | null;
  created_at?: string | null;
};

/** Hide only source entries whose content is already present in the same event. */
function remainingSourceNotes(events: SummaryEvent[], sourceNotes: string) {
  const compact = (value?: string | null) => (value ?? "").replace(/\s+/gu, "");
  const remaining: string[] = [];
  let cursor = 0;
  for (const match of sourceNotes.matchAll(/\(([^()\r\n]+)\)\s*\((\d{4}-\d{2}-\d{2})\)/g)) {
    const end = match.index + match[0].length;
    const content = compact(sourceNotes.slice(cursor, match.index));
    const covered = events.some((event) => event.event_date === match[2]
      && compact(event.status) === compact(match[1])
      && (!content || compact(event.notes).includes(content)));
    if (!covered) remaining.push(sourceNotes.slice(cursor, end));
    cursor = end;
  }
  const tail = sourceNotes.slice(cursor);
  if (compact(tail) && !events.some((event) => compact(event.notes).includes(compact(tail)))) {
    remaining.push(tail);
  }
  return remaining.join("\n\n");
}

/** Read every event as one chronological memo without changing the API order. */
export function ListingHistorySummary({ events, sourceNotes }: {
  events: SummaryEvent[];
  sourceNotes?: string;
}) {
  const hasSource = Boolean(sourceNotes?.trim());
  if (!events.length && !hasSource) return null;
  const extraSource = events.length && hasSource ? remainingSourceNotes(events, sourceNotes!) : "";
  const memo = events.length ? events.map((event) => {
    const content = event.notes?.trim() ? event.notes : "";
    const context = [event.status && `(${event.status})`, event.event_date && `(${event.event_date})`].filter(Boolean).join(" ");
    return [content, context].filter(Boolean).join("\n") || "기록된 내용 없음";
  }).join("\n\n") : sourceNotes;
  return (
    <div className="listing-saved-summary">
      <section className="listing-all-history" aria-label="전체 매물 이력">
        <div className="listing-all-history-heading">
          <h3>전체 매물 이력</h3>
          <span>{events.length ? `업무일 최신순 · ${events.length.toLocaleString("ko-KR")}건` : "엑셀 원본 메모"}</span>
        </div>
        <p className="listing-history-memo">{memo}</p>
      </section>
      {extraSource.trim() && (
        <details className="listing-source-notes">
          <summary><Icon name="next" size={16} /> 이전 보관 메모</summary>
          <p>{extraSource}</p>
        </details>
      )}
    </div>
  );
}
