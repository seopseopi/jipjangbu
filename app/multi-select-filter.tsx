"use client";

import { useEffect, useRef } from "react";

type FilterOption = { value: string; label: string };

export function MultiSelectFilter({ label, allLabel, options, value, onChange }: {
  label: string; allLabel: string; options: FilterOption[];
  value: string[]; onChange: (value: string[]) => void;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        root.current.open = false;
        root.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, []);
  const available = [...options, ...value.filter(item => !options.some(option => option.value === item)).map(item => ({ value: item, label: item }))];
  const selected = available.filter(option => value.includes(option.value));
  const summary = !value.length ? allLabel : value.length === 1 ? selected[0]?.label : `${selected[0]?.label} 외 ${value.length - 1}개`;
  return <details ref={root} className="multi-select-filter">
    <summary aria-label={label} title={selected.map(option => option.label).join(", ") || allLabel}><span>{summary}</span><span aria-hidden="true">⌄</span></summary>
    <div className="multi-select-options" role="group" aria-label={`${label} 복수 선택`}>
      <button type="button" className="multi-select-all" aria-pressed={!value.length} onClick={() => onChange([])}>{allLabel}</button>
      {available.map(option => <label key={option.value}><input type="checkbox" checked={value.includes(option.value)} onChange={event => onChange(event.target.checked ? [...value, option.value] : value.filter(item => item !== option.value))} /><span>{option.label}</span></label>)}
    </div>
  </details>;
}
