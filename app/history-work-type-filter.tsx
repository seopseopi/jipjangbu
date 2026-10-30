
/** Keep the selected type available even if its last record was edited/deleted. */
export function HistoryWorkTypeFilter({ value, workTypes, count, loading = false, onChange }: {
  value: string;
  workTypes: string[];
  count?: number;
  loading?: boolean;
  onChange: (value: string) => void;
}) {
  const options = [...new Set([...workTypes, value].filter(Boolean))];
  return (
    <div className="history-work-type-filter">
      <label>
        <span>업무구분</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">전체 업무구분</option>
          {options.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      <span className="history-filter-count" role="status" aria-live="polite">
        {loading ? "불러오는 중…" : count !== undefined ? `조회 ${count.toLocaleString("ko-KR")}건` : ""}
      </span>
      {value && <button type="button" className="secondary-button" onClick={() => onChange("")}>전체 보기</button>}
    </div>
  );
}
