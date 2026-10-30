"use client";

import { useEffect, useMemo, useState } from "react";
import { clientJsonFetch } from "./client-api";
import { Icon } from "./icons";
import { WorkSummaryProperties } from "./work-summary-properties";

export type InsightsWorkLog = {
  id: string;
  work_date: string;
  customer_id: string;
  customer_name: string;
  work_type: string;
  content: string;
  property_type?: string;
  building_name?: string;
  building_dong?: string;
  unit_number?: string;
  size_type?: string;
  sale_price?: string;
  jeonse_price?: string;
  monthly_rent?: string;
  property_count: number;
  properties_json?: string;
  source?: string;
  is_demo: number;
  updated_at?: string;
};

export type InsightsListing = {
  id: string;
  identity_key: string;
  registered_at?: string;
  closed_at?: string;
  status: string;
  property_type: string;
  building_name: string;
  building_dong: string;
  unit_number: string;
  size_type: string;
  sale_price: string;
  jeonse_price: string;
  monthly_rent: string;
  notes: string;
  source_notes?: string;
  is_demo: number;
  updated_at?: string;
};

type InsightsResponse = {
  summary: {
    monthWorkCount: number;
    monthCustomerCount: number;
    activeListingCount: number;
    staleListingCount: number;
  };
  monthly: Array<{ month: string; count: number }>;
  workTypes: Array<{ name: string; count: number }>;
  upcoming: InsightsWorkLog[];
  staleListings: InsightsListing[];
};

export type InsightsViewProps = {
  onOpenWork: (id: string) => void;
  onOpenListing: (listing: InsightsListing) => void;
  refreshKey?: string | number;
  onReviewStale?: () => void;
  onOpenSchedule?: () => void;
};

function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizeInsights(body: Partial<InsightsResponse>): InsightsResponse {
  return {
    summary: {
      monthWorkCount: asCount(body.summary?.monthWorkCount),
      monthCustomerCount: asCount(body.summary?.monthCustomerCount),
      activeListingCount: asCount(body.summary?.activeListingCount),
      staleListingCount: asCount(body.summary?.staleListingCount),
    },
    monthly: Array.isArray(body.monthly) ? body.monthly.map((item) => ({ month: String(item.month ?? ""), count: asCount(item.count) })) : [],
    workTypes: Array.isArray(body.workTypes) ? body.workTypes.map((item) => ({ name: String(item.name ?? ""), count: asCount(item.count) })) : [],
    upcoming: Array.isArray(body.upcoming) ? body.upcoming : [],
    staleListings: Array.isArray(body.staleListings) ? body.staleListings : [],
  };
}

function displayDate(value?: string): string {
  if (!value) return "-";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${year}.${month}.${day}` : value;
}

function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  if (!year || !month) return value || "기간 미상";
  return `${year}년 ${Number(month)}월`;
}

function propertyName(item: Pick<InsightsListing, "building_name" | "building_dong" | "unit_number">): string {
  const detail = [item.building_dong ? `${item.building_dong}동` : "", item.unit_number ? `${item.unit_number}호` : ""]
    .filter(Boolean)
    .join(" ");
  return item.building_name ? `${item.building_name}${detail ? ` ${detail}` : ""}` : "건물명 없음";
}

function workName(item: InsightsWorkLog): string {
  if (!item.building_name) return item.customer_name;
  return propertyName({
    building_name: item.building_name,
    building_dong: item.building_dong ?? "",
    unit_number: item.unit_number ?? "",
  });
}

function priceText(item: InsightsListing): string {
  return [
    item.sale_price && `매매 ${item.sale_price}`,
    item.jeonse_price && `전세 ${item.jeonse_price}`,
    item.monthly_rent && `월세 ${item.monthly_rent}`,
  ].filter(Boolean).join(" · ") || "가격 미입력";
}

export function InsightsView({ onOpenWork, onOpenListing, refreshKey, onReviewStale, onOpenSchedule }: InsightsViewProps) {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const body = await clientJsonFetch<Partial<InsightsResponse>>("/api/insights", { signal: controller.signal });
        if (!controller.signal.aborted) setData(normalizeInsights(body));
      } catch (loadError) {
        if (controller.signal.aborted || (loadError instanceof Error && loadError.name === "AbortError")) return;
        setData(null);
        setError(loadError instanceof Error ? loadError.message : "현황 분석을 불러오지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refreshKey, retryKey]);

  const chartMax = useMemo(() => Math.max(1, ...(data?.monthly.map((item) => item.count) ?? [])), [data]);
  const workTypeMax = useMemo(() => Math.max(1, ...(data?.workTypes.map((item) => item.count) ?? [])), [data]);

  if (loading) {
    return (
      <div className="insights-loading insights-renewal" role="status" aria-label="현황 분석을 불러오는 중">
        <div className="insights-loading-cards"><span /><span /><span /><span /></div>
        <div className="insights-loading-panel" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <section className="insights-error insights-renewal" role="alert">
        <span className="insights-error-mark" aria-hidden="true"><Icon name="warning" size={26} /></span>
        <div><h2>현황 분석을 불러오지 못했습니다.</h2><p>{error || "잠시 뒤 다시 시도해 주세요."}</p></div>
        <button className="insights-retry" type="button" onClick={() => setRetryKey((current) => current + 1)}><Icon name="refresh" size={18} /> 다시 불러오기</button>
      </section>
    );
  }

  const totalVisible = data.monthly.reduce((sum, item) => sum + item.count, 0)
    + data.workTypes.reduce((sum, item) => sum + item.count, 0)
    + data.upcoming.length
    + data.staleListings.length;
  const summaryTotal = Object.values(data.summary).reduce((sum, item) => sum + item, 0);

  if (totalVisible === 0 && summaryTotal === 0) {
    return (
      <section className="insights-empty insights-renewal">
        <span className="insights-empty-mark" aria-hidden="true"><Icon name="empty" size={26} /></span>
        <h2>분석할 업무 기록이 아직 없습니다.</h2>
        <p>업무와 고객, 매물을 등록하면 월별 흐름과 확인할 항목이 이곳에 나타납니다.</p>
      </section>
    );
  }

  const summaryCards = [
    { key: "work", label: "이번 달 업무", value: data.summary.monthWorkCount, unit: "건", note: "이번 달 기록된 전체 업무" },
    { key: "customer", label: "이번 달 상담 고객", value: data.summary.monthCustomerCount, unit: "명", note: "이번 달 업무가 있는 고유 고객" },
    { key: "listing", label: "진행 중 매물", value: data.summary.activeListingCount, unit: "건", note: "현재 관리 중인 매물" },
    { key: "stale", label: "확인 필요 매물", value: data.summary.staleListingCount, unit: "건", note: "90일 이상 갱신되지 않은 매물" },
  ];

  return (
    <div className="insights-view insights-renewal">
      <section className="insights-summary" aria-label="핵심 업무 현황">
        {summaryCards.map((card) => (
          <article className={`insights-summary-card insights-summary-${card.key}`} key={card.key}>
            <p>{card.label}</p>
            <strong>{card.value.toLocaleString("ko-KR")}<small>{card.unit}</small></strong>
            <span>{card.note}</span>
          </article>
        ))}
      </section>

      <div className="insights-grid">
        <section className="insights-panel insights-work-types" aria-labelledby="insights-work-types-title">
          <header className="insights-panel-head"><div><h2 id="insights-work-types-title">업무구분별 현황</h2></div><span>{data.workTypes.length}개 구분</span></header>
          {data.workTypes.length === 0 ? <p className="insights-panel-empty">표시할 업무구분이 없습니다.</p> : (
            <div className="insights-type-list">
              {data.workTypes.map((item) => (
                <div className="insights-type-row" key={item.name}>
                  <span className="insights-type-name">{item.name || "미분류"}</span>
                  <div className="insights-bar-track"><span className="insights-bar insights-bar-type" style={{ width: `${Math.round((item.count / workTypeMax) * 100)}%` }} /></div>
                  <strong>{item.count.toLocaleString("ko-KR")}건</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="insights-panel insights-upcoming" aria-labelledby="insights-upcoming-title">
          <header className="insights-panel-head"><div><h2 id="insights-upcoming-title">앞으로 30일 일정</h2><p>예정·예약 업무</p></div>{onOpenSchedule && <button className="text-button" type="button" onClick={onOpenSchedule}>30일 일정 전체 보기</button>}</header>
          {data.upcoming.length > 0 && <p className="insights-preview-note">잔금·집방문 예정 우선 · 같은 우선순위는 날짜순 · 최대 12건 미리보기 · 현재 {data.upcoming.length}건 표시</p>}
          {data.upcoming.length === 0 ? <p className="insights-panel-empty">다가오는 일정이 없습니다.</p> : (
            <div className="insights-item-list">
              {data.upcoming.map((item) => (
                <button className="insights-item insights-upcoming-item" type="button" key={item.id} onClick={() => onOpenWork(item.id)}>
                  <time>{displayDate(item.work_date)}</time>
                  <span className="insights-item-copy"><strong>{item.customer_name || workName(item)}</strong><WorkSummaryProperties work={item} showSingle />{item.content && <small>{item.content}</small>}</span>
                  <span className="insights-item-status">{item.work_type}</span>
                  <Icon name="next" className="insights-item-arrow" size={18} />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="insights-panel insights-stale" aria-labelledby="insights-stale-title">
          <header className="insights-panel-head"><div><h2 id="insights-stale-title">확인할 매물</h2><p>90일 이상 갱신되지 않은 매물</p></div>{onReviewStale ? <button className="text-button" type="button" onClick={onReviewStale}>전체 {data.summary.staleListingCount}건 보기</button> : <span>미리보기 {data.staleListings.length}건</span>}</header>
          {data.staleListings.length === 0 ? <p className="insights-panel-empty">지금 확인이 필요한 오래된 매물이 없습니다.</p> : (
            <div className="insights-item-list">
              {data.staleListings.map((listing) => (
                <button className="insights-item insights-stale-item" type="button" key={listing.id} onClick={() => onOpenListing(listing)}>
                  <span className="insights-item-copy"><strong>{propertyName(listing)}</strong><small>{listing.property_type} · {priceText(listing)}</small></span>
                  <span className="insights-item-date">최근 갱신 {displayDate(listing.updated_at || listing.registered_at)}</span>
                  <Icon name="next" className="insights-item-arrow" size={18} />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="insights-panel insights-monthly" aria-labelledby="insights-monthly-title">
          <header className="insights-panel-head"><div><h2 id="insights-monthly-title">월별 업무량</h2></div></header>
          {data.monthly.length === 0 ? <p className="insights-panel-empty">표시할 월별 업무가 없습니다.</p> : (
            <div className="insights-chart">
              {data.monthly.map((item) => (
                <div className="insights-chart-row" key={item.month}>
                  <span className="insights-chart-label">{monthLabel(item.month)}</span>
                  <div className="insights-bar-track"><span className="insights-bar insights-bar-monthly" style={{ width: `${Math.round((item.count / chartMax) * 100)}%` }} /></div>
                  <strong>{item.count.toLocaleString("ko-KR")}건</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
