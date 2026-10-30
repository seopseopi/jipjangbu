"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  indexCustomers,
  matchCustomers,
  type CustomerOption,
} from "./customer-matches";

function revealActiveCustomer(results: HTMLDivElement | null) {
  const option = results?.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!results || !option) return;
  const resultsBounds = results.getBoundingClientRect();
  const optionBounds = option.getBoundingClientRect();
  const visibleTop = resultsBounds.top + results.clientTop;
  const visibleBottom = visibleTop + results.clientHeight;

  // Scroll only the results, not the surrounding work editor or page.
  if (optionBounds.top < visibleTop || optionBounds.height > results.clientHeight) {
    results.scrollTop += optionBounds.top - visibleTop;
  } else if (optionBounds.bottom > visibleBottom) {
    results.scrollTop += optionBounds.bottom - visibleBottom;
  }
}

export function CustomerPicker({
  customers,
  value,
  onChange,
  onQueryChange,
  disabled = false,
}: {
  customers: CustomerOption[];
  value: string;
  onChange: (id: string) => void;
  onQueryChange?: (query: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = customers.find((customer) => customer.id === value);
  const searchIndex = useMemo(() => indexCustomers(customers), [customers]);
  const matches = useMemo(
    () => matchCustomers(searchIndex, query),
    [searchIndex, query],
  );
  useEffect(() => {
    if (open) revealActiveCustomer(resultsRef.current);
  }, [active, open, matches]);
  function choose(customer: CustomerOption) {
    onChange(customer.id);
    setQuery("");
    onQueryChange?.("");
    setOpen(false);
  }
  return (
    <div
      className="customer-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <input
        className="customer-picker-input"
        aria-label="고객 이름 또는 전화번호 검색"
        aria-required="true"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[active] ? `${listId}-${active}` : undefined
        }
        autoComplete="off"
        disabled={disabled}
        value={
          open ? query : selected ? `${selected.name} · ${selected.id}` : query
        }
        placeholder="이름 또는 전화번호로 찾기"
        onFocus={(event) => {
          setOpen(!selected);
          setActive(0);
          if (selected) event.currentTarget.select();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          onQueryChange?.(event.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange("");
        }}
        onKeyDown={(event) => {
          // Enter/Escape can finish or cancel Korean IME composition; they do
          // not express a customer choice until a later non-composing key.
          if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive((index) =>
              matches.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                  matches.length
                : 0,
            );
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (matches[active]) choose(matches[active]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (
        <div
          ref={resultsRef}
          className="customer-picker-results"
          id={listId}
          role="listbox"
          aria-label="고객 검색 결과"
        >
          {!matches.length && (
            <p className="customer-picker-empty">
              일치하는 고객이 없습니다. 위의 ‘+ 새 고객’으로 등록해 주세요.
            </p>
          )}
          {matches.map((customer, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              id={`${listId}-${index}`}
              className="customer-picker-option"
              key={customer.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(customer)}
            >
              <strong className="customer-picker-name">{customer.name}</strong>
              <small className="customer-picker-contact">{customer.id}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
