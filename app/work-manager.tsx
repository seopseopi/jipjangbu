"use client";

import {
  createContext,
  FormEvent,
  lazy,
  Suspense,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  GlobalSearchCustomer as SearchCustomer,
  GlobalSearchListing as SearchListing,
} from "./global-search";
import { FollowUpsView } from "./follow-ups";
import { DeletionDialog } from "./deletion-dialog";
import type { DeletionEntityType } from "./deletion-types";
import "./calendar.css";
import "./journal-search-feedback.css";
import "./workflow-feedback.css";
import "./workflow-history-backup.css";
import "./work-form-feedback.css";
import "./work-reading-list.css";
import "./renewal.css";
import "./work-form-renewal.css";
import { LISTING_WORK_TYPES, findWorkDraftIssue } from "./work-form-rules";
import { CustomerPicker } from "./customer-picker";
import { fetchCustomerDirectory } from "./customer-directory";
import { calendarWorkPresentation } from "./calendar-presentation";
import { CalendarSubjects } from "./calendar-subjects";
import { getWorkProperties, workPropertyLabel } from "./work-property-summary";
import { getPropertyDisplayGroups } from "./property-display";
import { WorkSummaryProperties } from "./work-summary-properties";
import { ListingHistorySummary } from "./listing-history-summary";
import { HistoryWorkTypeFilter } from "./history-work-type-filter";
import { formatHistoryTimestamp } from "./history-timestamps";
import type { RelatedHistoryTarget } from "./history-query";
import { canCloseCustomerDraft, customerDraftChanged } from "./customer-draft";
import { Icon } from "./icons";
import { canAppendPage } from "./client-paging";
import { useResultListRef, useResultPage } from "./result-pagination";
import { BrandMark } from "./brand-mark";
import { SettingsView, type Lookups } from "./settings-view";
import { createPropertyHistoryTarget } from "./history-query";
import { fetchWorkWindow } from "./work-window";
import { hasPropertyDraft, propertyFromListing, type ListingDraftSource } from "./listing-draft";
import {
  clientJsonFetch as jsonFetch,
  clearClientReadCache,
  invalidateCompletedClientReads,
} from "./client-api";

const GlobalSearch = lazy(() =>
  import("./global-search").then((module) => ({
    default: module.GlobalSearch,
  })),
);
const InsightsView = lazy(() =>
  import("./insights-view").then((module) => ({
    default: module.InsightsView,
  })),
);
const RelatedHistory = lazy(() =>
  import("./related-history").then((module) => ({ default: module.RelatedHistory })),
);
const ListingPicker = lazy(() =>
  import("./listing-picker").then((module) => ({ default: module.ListingPicker })),
);
const WorkDetailView = lazy(() =>
  import("./work-detail-view").then((module) => ({ default: module.WorkDetailView })),
);
const TrashView = lazy(() =>
  import("./trash-view").then((module) => ({ default: module.TrashView })),
);

function isAborted(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
const StructureView = lazy(() => import("./structures/structure-view").then(module => ({ default: module.StructureView })));

function useSearchDelay(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), value ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [value]);
  return settled;
}

type View =
  | "today"
  | "tasks"
  | "insights"
  | "journal"
  | "listings"
  | "customers"
  | "calendar"
  | "trash"
  | "structures"
  | "settings";
type WorkSummary = {
  id: string;
  work_date: string;
  updated_at?: string;
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
  source?: string;
  properties_json?: string;
  property_count: number;
  search_property_match?: number;
  is_demo: number;
};
type PropertyDetail = {
  id?: string;
  propertyType: string;
  buildingName: string;
  buildingDong: string;
  unitNumber: string;
  sizeType: string;
  salePrice: string;
  jeonsePrice: string;
  monthlyRent: string;
  source: string;
};
type WorkDetail = WorkSummary & {
  details: Array<Record<string, string | number>>;
  revision: string;
};
type Customer = {
  id: string;
  name: string;
  notes: string;
  created_at: string;
  updated_at: string;
  history_count: number;
  last_work_date?: string;
  is_demo: number;
};
type Listing = {
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
  is_demo: number;
  source_notes?: string;
};
type ListingEvent = {
  id: string;
  work_log_id: string;
  event_date: string;
  status: string;
  notes: string;
  customer_id: string;
  customer_name: string;
  work_updated_at?: string;
  work_created_at?: string;
  created_at?: string;
};
type Dashboard = {
  metrics: {
    today_count: number;
    upcoming_count: number;
    active_listing_count: number;
    customer_count: number;
  };
  today: WorkSummary[];
  upcoming?: WorkSummary[];
  recent: WorkSummary[];
  demoMode: boolean;
};
type SearchView = "journal" | "listings" | "customers";
type ManagedView = "listings" | "customers";
type ManagedPage<T> = { rows: T[]; total: number; hasMore: boolean };
const MANAGEMENT_PAGE_SIZE = 100;

function appendManagedRows<T extends { id: string }>(previous: T[], next: T[]) {
  const seen = new Set(previous.map((row) => row.id));
  for (const row of next) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) {
      throw new Error("조회 중 목록이 변경되었습니다. 최신 목록을 다시 불러와 주세요.");
    }
    seen.add(row.id);
  }
  return [...previous, ...next];
}

/** Refresh only the rows the user has chosen to expand, 100 at a time. */
async function readManagedWindow<T extends { id: string }>(
  read: (offset: number, limit: number) => Promise<ManagedPage<T>>,
  visibleCount = MANAGEMENT_PAGE_SIZE,
): Promise<ManagedPage<T>> {
  const count = Number.isFinite(visibleCount) ? Math.max(MANAGEMENT_PAGE_SIZE, Math.floor(visibleCount)) : MANAGEMENT_PAGE_SIZE;
  let rows: T[] = [], total = 0, hasMore = true;
  while (rows.length < count && hasMore) {
    const limit = Math.min(MANAGEMENT_PAGE_SIZE, count - rows.length);
    const page = await read(rows.length, limit);
    if (!Array.isArray(page.rows) || page.rows.length > limit || !Number.isSafeInteger(page.total) || page.total < 0) {
      throw new Error("목록 조회 결과를 확인할 수 없습니다. 다시 불러와 주세요.");
    }
    rows = appendManagedRows(rows, page.rows);
    total = page.total;
    hasMore = page.hasMore && rows.length < total;
    if (!page.rows.length && hasMore) throw new Error("조회 중 목록이 변경되었습니다. 최신 목록을 다시 불러와 주세요.");
  }
  rows = rows.slice(0, total);
  return { rows, total, hasMore: rows.length < total };
}
type JournalSearchError = { queryKey: string; message: string } | null;
type JournalSearchStatus = "loading" | "refreshing" | "error" | "ready";
type WorkModalState = {
  mode: "new" | "edit" | "copy";
  item?: WorkDetail;
  initialCustomerId?: string;
  initialWorkType?: string;
  initialListing?: Listing;
};
type WorkOpeningState = {
  id?: string;
  copySource?: WorkDetail;
  initialCustomerId?: string;
  initialWorkType?: string;
  initialListing?: Listing;
  error?: string;
};
type FollowUpDraft = {
  title?: string;
  customerId?: string;
  listingKey?: string;
  customerName?: string;
  listingLabel?: string;
  replaceConfirmed?: boolean;
};
type HistoryData = {
  title: string;
  subtitle: string;
  items: WorkSummary[] | ListingEvent[];
  workItems?: WorkSummary[];
  historyWorkType?: string;
  customer?: Pick<Customer, "id" | "name"> & Partial<Pick<Customer, "notes">>;
  customerNotesError?: string;
  listing?: Listing;
  listingKey?: string;
  date?: string;
  sort?: "updated";
  workType?: string;
  scheduleDays?: number;
  from?: string;
  to?: string;
  loading?: boolean;
  error?: string;
  emptyMessage?: string;
};
type WorkHistoryActions = {
  onCustomerHistory: (customer: Pick<Customer, "id" | "name">) => void;
  onListingHistory: (work: WorkSummary) => void;
};

const navItems: Array<[View, string]> = [
  ["today", "홈"],
  ["calendar", "업무 달력"],
  ["journal", "업무일지"],
  ["listings", "매물 관리"],
  ["customers", "고객 관리"],
  ["insights", "업무 현황"],
  ["trash", "휴지통"],
  ["settings", "설정"],
  ["structures", "집 구조 보기"],
];
// The sidebar reads as three working areas; the experimental screen stays apart.
const navGroups: Array<[string, View[]]> = [
  ["업무", ["today", "calendar", "journal"]],
  ["장부", ["listings", "customers"]],
  ["관리", ["insights", "trash", "settings", "structures"]],
];
// Customer and listing histories open as their own page; date and schedule lists stay dialogs.
const isRecordHistory = (data: HistoryData) => Boolean(data.customer || data.listing || data.listingKey);
// Each list screen's search and filters render into the title bar when it is mounted.
const PageToolsSlot = createContext<HTMLElement | null>(null);
const SIDE_PANEL_QUERY = "(min-width: 1081px)";
// List screens make room for the reading panel; the calendar and other wide screens are overlaid.
const SIDE_PANEL_LIST_VIEWS: View[] = ["today", "journal", "listings", "customers"];
function useWideScreen() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(SIDE_PANEL_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(SIDE_PANEL_QUERY);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}
let nextModalId = 0;
const openModalIds: number[] = [];
let modalBodyOverflow = "";
const blankProperty = (): PropertyDetail => ({
  propertyType: "",
  buildingName: "",
  buildingDong: "",
  unitNumber: "",
  sizeType: "",
  salePrice: "",
  jeonsePrice: "",
  monthlyRent: "",
  source: "",
});
const seoulDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

function journalSearchStatus(
  loadedQuery: string | null,
  currentQuery: string,
  firstPageLoading: boolean,
  searchPending: boolean,
  error: JournalSearchError,
): JournalSearchStatus {
  if (searchPending) return "loading";
  if (firstPageLoading) return loadedQuery === currentQuery ? "refreshing" : "loading";
  if (error?.queryKey === currentQuery) return "error";
  return loadedQuery === currentQuery ? "ready" : "loading";
}

async function fetchAllWorkLogs(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<WorkSummary[]> {
  const rows: WorkSummary[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (rows.length < total) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "1000");
    pageParams.set("offset", String(offset));
    const page = await jsonFetch<{ workLogs: WorkSummary[]; total: number }>(
      `/api/work-logs?${pageParams}`,
      { signal },
    );
    rows.push(...page.workLogs);
    total = Number(page.total || 0);
    if (!page.workLogs.length) break;
    offset += page.workLogs.length;
  }
  return rows;
}
function displayDate(value?: string) {
  if (!value) return "-";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${y}.${m}.${d}`;
}
function targetText(row: Partial<WorkSummary | Listing>) {
  const building = "building_name" in row ? row.building_name : "";
  const dong = "building_dong" in row ? row.building_dong : "";
  const unit = "unit_number" in row ? row.unit_number : "";
  if (!building) return "물건 없음";
  const address = [dong ? `${dong}동` : "", unit ? `${unit}호` : ""]
    .filter(Boolean)
    .join(" ");
  return `${building}${address ? ` ${address}` : ""}`;
}
function statusTone(status: string) {
  if (/취소|파기|타계약/.test(status)) return "red";
  if (/등록|수정/.test(status)) return "green";
  if (/예정|예약/.test(status)) return "orange";
  if (/잔금|계약|중도금/.test(status)) return "violet";
  return "blue";
}
function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function WorkManager() {
  const [view, setView] = useState<View>("today");
  const [structureKey, setStructureKey] = useState("");
  const currentView = useRef<View>("today");
  const followUpDirty = useRef(false);
  const followUpBusy = useRef(false);
  const setFollowUpBusy = useCallback((busy: boolean) => { followUpBusy.current = busy; }, []);
  const workBusy = useRef(false);
  const customerBusy = useRef(false);
  const setWorkBusy = useCallback((busy: boolean) => { workBusy.current = busy; }, []);
  const setCustomerBusy = useCallback((busy: boolean) => { customerBusy.current = busy; }, []);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardError, setDashboardError] = useState("");
  const [lookups, setLookups] = useState<Lookups>({
    workTypes: [],
    propertyTypes: [],
    buildings: [],
  });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const customerDirectoryRequested = useRef(false);
  const appliedReferenceVersion = useRef(0);
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [workLogs, setWorkLogs] = useState<WorkSummary[]>([]);
  const [workTotal, setWorkTotal] = useState(0);
  const [calendarLogs, setCalendarLogs] = useState<WorkSummary[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [workFirstPageLoading, setWorkFirstPageLoading] = useState(false);
  const [workSearchError, setWorkSearchError] = useState<JournalSearchError>(null);
  const [managedReads, setManagedReads] = useState<Record<"listings" | "customers" | "calendar", { loadedQuery: string | null; loading: boolean; error: JournalSearchError }>>({
    listings: { loadedQuery: null, loading: false, error: null },
    customers: { loadedQuery: null, loading: false, error: null },
    calendar: { loadedQuery: null, loading: false, error: null },
  });
  const [managedPages, setManagedPages] = useState<Record<ManagedView, { total: number; hasMore: boolean; loadingMore: boolean; moreError: string }>>({
    listings: { total: 0, hasMore: false, loadingMore: false, moreError: "" },
    customers: { total: 0, hasMore: false, loadingMore: false, moreError: "" },
  });
  const managedFirstPending = useRef<Record<ManagedView, number | null>>({ listings: null, customers: null });
  const managedMorePending = useRef<Record<ManagedView, boolean>>({ listings: false, customers: false });
  const managedMoreControllers = useRef<Partial<Record<ManagedView, AbortController>>>({});
  const [loadedWorkQuery, setLoadedWorkQuery] = useState<string | null>(null);
  const loadedWorkQueryRef = useRef<string | null>(null);
  const workFirstRequest = useRef<number | null>(null);
  const workMorePending = useRef(false);
  const [notice, setNotice] = useState("");
  const [deletionTarget, setDeletionTarget] = useState<{ type: DeletionEntityType; id: string; unsavedDraft?: boolean } | null>(null);
  const [queries, setQueries] = useState<Record<SearchView, string>>({
    journal: "",
    listings: "",
    customers: "",
  });
  const [workTypeFilter, setWorkTypeFilter] = useState("");
  const [calendarWorkType, setCalendarWorkType] = useState("");
  const [listingStatuses, setListingStatuses] = useState<string[]>([]);
  const [listingPrices, setListingPrices] = useState<string[]>([]);
  const [propertyTypeFilter, setPropertyTypeFilter] = useState("");
  const [listingSort, setListingSort] = useState("type");
  const [customerSort, setCustomerSort] = useState("recent");
  const [calendarMonth, setCalendarMonth] = useState(seoulDate().slice(0, 7));
  const [workModal, setWorkModal] = useState<WorkModalState | null>(null);
  const [workOpening, setWorkOpening] = useState<WorkOpeningState | null>(null);
  const [workReader, setWorkReader] = useState<{ id: string; item?: WorkDetail; loading: boolean; error?: string } | null>(null);
  const workReadVersion = useRef(0);
  const [readerReference, setReaderReference] = useState<RelatedHistoryTarget | null>(null);
  const readerReferenceTrigger = useRef<HTMLElement | null>(null);
  const workOpenVersion = useRef(0);
  const historyOpenVersion = useRef(0);
  const [customerModal, setCustomerModal] = useState<{
    mode: "new" | "edit";
    item?: Customer;
    initialId?: string;
  } | null>(null);
  const [historyModal, setHistoryModal] = useState<HistoryData | null>(null);
  const currentRecordKey = useRef<string | null>(null);
  const restoreRecord = useRef<(record: string) => void>(() => {});
  const [followUpDraft, setFollowUpDraft] = useState<FollowUpDraft>();
  const [followUpRefreshKey, setFollowUpRefreshKey] = useState(0);
  const [readable, setReadable] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchLoaded, setGlobalSearchLoaded] = useState(false);
  const wideScreen = useWideScreen();
  const [insightsRefreshKey, setInsightsRefreshKey] = useState(0);
  const lastFocusRefresh = useRef(0);
  const focusRefreshInFlight = useRef(false);
  const requestVersion = useRef({
    dashboard: 0,
    references: 0,
    work: 0,
    calendar: 0,
    listings: 0,
    customers: 0,
  });
  const journalSearch = useSearchDelay(queries.journal);
  const listingsSearch = useSearchDelay(queries.listings);
  const customersSearch = useSearchDelay(queries.customers);
  const workQueryKey = JSON.stringify([
    queries.journal,
    workTypeFilter,
  ]);
  const journalStatus = journalSearchStatus(
    loadedWorkQuery,
    workQueryKey,
    workFirstPageLoading,
    queries.journal !== journalSearch,
    workSearchError,
  );
  const listingQueryKey = JSON.stringify([queries.listings, listingStatuses, propertyTypeFilter, listingSort, listingPrices]);
  const customerQueryKey = JSON.stringify([queries.customers, customerSort]);
  const calendarQueryKey = JSON.stringify([calendarMonth, calendarWorkType]);
  const listingStatus = journalSearchStatus(managedReads.listings.loadedQuery, listingQueryKey, managedReads.listings.loading, queries.listings !== listingsSearch, managedReads.listings.error);
  const customerStatus = journalSearchStatus(managedReads.customers.loadedQuery, customerQueryKey, managedReads.customers.loading, queries.customers !== customersSearch, managedReads.customers.error);
  const calendarStatus = journalSearchStatus(managedReads.calendar.loadedQuery, calendarQueryKey, managedReads.calendar.loading, false, managedReads.calendar.error);
  const showGlobalSearch = useCallback(() => {
    setGlobalSearchLoaded(true);
    setGlobalSearchOpen(true);
  }, []);
  const showLoadError = useCallback((error: unknown) => {
    if (!isAborted(error)) setNotice((error as Error).message);
  }, []);

  const loadReferenceData = useCallback(async (includeCustomers = true) => {
    // The full customer directory belongs to the work form, not the home page.
    // Once a form has needed it, keep the existing focus/write refresh behavior.
    if (includeCustomers) customerDirectoryRequested.current = true;
    const version = ++requestVersion.current.references;
    const [lookupData, customerData] = await Promise.all([
      jsonFetch<Lookups>("/api/lookups"),
      customerDirectoryRequested.current
        ? fetchCustomerDirectory<Customer>((url) => jsonFetch(url))
        : null,
    ]);
    // A newer *pending* focus refresh must not discard the valid data an opening
    // form is waiting for. Only an already-applied newer success wins the race.
    if (version < appliedReferenceVersion.current) return;
    appliedReferenceVersion.current = version;
    setLookups(lookupData);
    if (customerData) setCustomers(customerData);
  }, []);
  const refreshDashboard = useCallback(async () => {
    const version = ++requestVersion.current.dashboard;
    try {
      const dash = await jsonFetch<Dashboard>("/api/bootstrap");
      if (version === requestVersion.current.dashboard) { setDashboard(dash); setDashboardError(""); }
    } catch (error) {
      if (version === requestVersion.current.dashboard) setDashboardError(isAborted(error) ? "홈 정보 조회를 완료하지 못했습니다. 다시 불러와 주세요." : (error as Error).message);
      throw error;
    } finally {
      if (version === requestVersion.current.dashboard) setLoading(false);
    }
  }, []);
  const refreshBase = useCallback(async () => {
    await Promise.all([refreshDashboard(), loadReferenceData(false)]);
  }, [refreshDashboard, loadReferenceData]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setReadable(localStorage.getItem("jipjangbu-readable") === "true");
      } catch {
        /* UI preference is optional. */
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  function toggleReadable() {
    const next = !readable;
    setReadable(next);
    try {
      localStorage.setItem("jipjangbu-readable", String(next));
    } catch {
      /* Keep the setting for this session. */
    }
  }
  function addFollowUp(draft: FollowUpDraft = {}) {
    if (followUpBusy.current) { setNotice("할 일을 처리 중입니다. 잠시 기다려 주세요."); return; }
    if (
      view === "tasks" &&
      followUpDirty.current &&
      !window.confirm("작성 중인 할 일을 버리고 새 할 일을 작성할까요?")
    )
      return;
    if (!navigate("tasks")) return;
    setFollowUpDraft({ ...draft, replaceConfirmed: view === "tasks" });
    historyOpenVersion.current += 1;
    setHistoryModal(null);
  }
  const loadWorkLogs = useCallback(
    async (signal?: AbortSignal, visibleCount = 100) => {
      const version = ++requestVersion.current.work;
      workFirstRequest.current = version;
      setWorkFirstPageLoading(true);
      setWorkSearchError(null);
      const params = new URLSearchParams({ limit: "100" });
      if (journalSearch) params.set("q", journalSearch);
      if (workTypeFilter) params.set("workType", workTypeFilter);
      const queryKey = JSON.stringify([
        journalSearch,
        workTypeFilter,
      ]);
      try {
        const data = await fetchWorkWindow<WorkSummary>(
          (pageParams, pageSignal) => jsonFetch(`/api/work-logs?${pageParams}`, { signal: pageSignal }),
          params,
          visibleCount,
          signal,
        );
        if (version !== requestVersion.current.work) return;
        loadedWorkQueryRef.current = queryKey;
        setLoadedWorkQuery(queryKey);
        setWorkLogs(data.workLogs);
        setWorkTotal(data.total);
      } catch (error) {
        if (version !== requestVersion.current.work) return;
        if (!signal?.aborted) {
          setWorkSearchError({
            queryKey,
            message: isAborted(error) ? "다른 작업으로 조회가 중단되었습니다. 다시 시도해 주세요." : error instanceof Error ? error.message : "업무 기록을 불러오지 못했습니다.",
          });
        }
        throw error;
      } finally {
        if (workFirstRequest.current === version) {
          workFirstRequest.current = null;
          setWorkFirstPageLoading(false);
        }
      }
    },
    [journalSearch, workTypeFilter],
  );
  const loadCalendar = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++requestVersion.current.calendar;
      const queryKey = JSON.stringify([calendarMonth, calendarWorkType]);
      setManagedReads((current) => ({ ...current, calendar: { ...current.calendar, loading: true, error: null } }));
      const params = new URLSearchParams({ month: calendarMonth });
      if (calendarWorkType) params.set("workType", calendarWorkType);
      try {
        const rows = await fetchAllWorkLogs(params, signal);
        if (version !== requestVersion.current.calendar) return;
        setCalendarLogs(
          rows.filter((item) => item.work_date.startsWith(calendarMonth)),
        );
        setManagedReads((current) => ({ ...current, calendar: { loadedQuery: queryKey, loading: false, error: null } }));
      } catch (error) {
        if (version === requestVersion.current.calendar && !signal?.aborted) setManagedReads((current) => ({ ...current, calendar: { ...current.calendar, loading: false, error: { queryKey, message: isAborted(error) ? "다른 작업으로 조회가 중단되었습니다. 다시 불러와 주세요." : (error as Error).message } } }));
        throw error;
      }
    },
    [calendarMonth, calendarWorkType],
  );
  const loadListings = useCallback(
    async (signal?: AbortSignal, visibleCount = MANAGEMENT_PAGE_SIZE) => {
      const version = ++requestVersion.current.listings;
      managedMoreControllers.current.listings?.abort();
      managedFirstPending.current.listings = version;
      const queryKey = JSON.stringify([listingsSearch, listingStatuses, propertyTypeFilter, listingSort, listingPrices]);
      setManagedReads((current) => ({ ...current, listings: { ...current.listings, loading: true, error: null } }));
      setManagedPages((current) => ({ ...current, listings: { ...current.listings, moreError: "" } }));
      const params = new URLSearchParams({
        state: "all",
        sort: listingSort,
      });
      listingStatuses.forEach(status => params.append("status", status));
      listingPrices.forEach(price => params.append("price", price));
      if (listingsSearch) params.set("q", listingsSearch);
      if (propertyTypeFilter) params.set("type", propertyTypeFilter);
      try {
        const page = await readManagedWindow(async (offset, limit) => {
          const pageParams = new URLSearchParams(params);
          pageParams.set("offset", String(offset));
          pageParams.set("limit", String(limit));
          const data = await jsonFetch<{ listings: Listing[]; total: number; hasMore: boolean }>(`/api/listings?${pageParams}`, { signal });
          return { rows: data.listings, total: data.total, hasMore: data.hasMore };
        }, visibleCount);
        if (version !== requestVersion.current.listings) return;
        setListings(page.rows);
        setManagedPages((current) => ({ ...current, listings: { ...current.listings, total: page.total, hasMore: page.hasMore, moreError: "" } }));
        setManagedReads((current) => ({ ...current, listings: { loadedQuery: queryKey, loading: false, error: null } }));
      } catch (error) {
        if (version === requestVersion.current.listings && !signal?.aborted) setManagedReads((current) => ({ ...current, listings: { ...current.listings, loading: false, error: { queryKey, message: isAborted(error) ? "다른 작업으로 조회가 중단되었습니다. 다시 불러와 주세요." : (error as Error).message } } }));
        throw error;
      } finally {
        if (managedFirstPending.current.listings === version) managedFirstPending.current.listings = null;
      }
    },
    [listingStatuses, propertyTypeFilter, listingSort, listingsSearch, listingPrices],
  );
  const loadCustomers = useCallback(
    async (signal?: AbortSignal, visibleCount = MANAGEMENT_PAGE_SIZE) => {
      const version = ++requestVersion.current.customers;
      managedMoreControllers.current.customers?.abort();
      managedFirstPending.current.customers = version;
      const queryKey = JSON.stringify([customersSearch, customerSort]);
      setManagedReads((current) => ({ ...current, customers: { ...current.customers, loading: true, error: null } }));
      setManagedPages((current) => ({ ...current, customers: { ...current.customers, moreError: "" } }));
      const params = new URLSearchParams({ sort: customerSort });
      if (customersSearch) params.set("q", customersSearch);
      try {
        const page = await readManagedWindow(async (offset, limit) => {
          const pageParams = new URLSearchParams(params);
          pageParams.set("offset", String(offset));
          pageParams.set("limit", String(limit));
          const data = await jsonFetch<{ customers: Customer[]; total: number; hasMore: boolean }>(`/api/customers?${pageParams}`, { signal });
          return { rows: data.customers, total: data.total, hasMore: data.hasMore };
        }, visibleCount);
        if (version !== requestVersion.current.customers) return;
        setCustomerResults(page.rows);
        setManagedPages((current) => ({ ...current, customers: { ...current.customers, total: page.total, hasMore: page.hasMore, moreError: "" } }));
        setManagedReads((current) => ({ ...current, customers: { loadedQuery: queryKey, loading: false, error: null } }));
      } catch (error) {
        if (version === requestVersion.current.customers && !signal?.aborted) setManagedReads((current) => ({ ...current, customers: { ...current.customers, loading: false, error: { queryKey, message: isAborted(error) ? "다른 작업으로 조회가 중단되었습니다. 다시 불러와 주세요." : (error as Error).message } } }));
        throw error;
      } finally {
        if (managedFirstPending.current.customers === version) managedFirstPending.current.customers = null;
      }
    },
    [customerSort, customersSearch],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshBase().catch(showLoadError);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshBase, showLoadError]);
  useEffect(() => {
    const refreshVisibleData = () => {
      if (
        document.visibilityState !== "visible" ||
        focusRefreshInFlight.current ||
        Date.now() - lastFocusRefresh.current < 1000
      )
        return;
      lastFocusRefresh.current = Date.now();
      focusRefreshInFlight.current = true;
      const sharedPendingRead = invalidateCompletedClientReads();
      // These child views abort their own previous request on refreshKey changes,
      // so their first refresh is already fresh. Do not restart it a second time.
      setInsightsRefreshKey((value) => value + 1);
      setFollowUpRefreshKey((value) => value + 1);
      const active = currentView.current;
      const refresh = () => Promise.all([
        refreshBase(),
        active === "journal" ? loadWorkLogs(undefined, workLogs.length) : undefined,
        active === "calendar" ? loadCalendar() : undefined,
        active === "listings" ? loadListings(undefined, listings.length) : undefined,
        active === "customers" ? loadCustomers(undefined, customerResults.length) : undefined,
      ]);
      void refresh().then(async () => {
        // Preserve a slow first response so the screen/form can finish opening,
        // then revalidate once: another device may have changed data in flight.
        if (sharedPendingRead && document.visibilityState === "visible") {
          invalidateCompletedClientReads();
          if (currentView.current === active) await refresh();
          else await refreshBase();
        }
      }).catch(showLoadError).finally(() => { focusRefreshInFlight.current = false; });
    };
    window.addEventListener("focus", refreshVisibleData);
    document.addEventListener("visibilitychange", refreshVisibleData);
    return () => {
      window.removeEventListener("focus", refreshVisibleData);
      document.removeEventListener("visibilitychange", refreshVisibleData);
    };
  }, [
    refreshBase,
    loadWorkLogs,
    loadCalendar,
    loadListings,
    loadCustomers,
    showLoadError,
    workLogs.length,
    listings.length,
    customerResults.length,
  ]);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        target?.matches("input, textarea, select") ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      showGlobalSearch();
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [showGlobalSearch]);
  useEffect(() => {
    // The popstate listener stays mounted, but uses the current read handlers.
    restoreRecord.current = (record) => {
      if (record.startsWith("customer:") && record.slice(9)) {
        const id = record.slice(9);
        void showCustomerHistory({ id, name: id });
      } else if (record.startsWith("listing:") && record.slice(8)) {
        void showListingByKey(record.slice(8));
      }
    };
  });
  useEffect(() => {
    const syncView = () => {
      const key = window.location.hash.slice(1) as View;
      const next = key === "tasks" || navItems.some(([viewKey]) => viewKey === key)
        ? key
        : "today";
      const record = typeof window.history.state?.record === "string" ? window.history.state.record : null;
      const recordChanged = record !== currentRecordKey.current;
      if ((next !== currentView.current || recordChanged) && (followUpBusy.current || workBusy.current || customerBusy.current)) {
        setNotice("저장 중입니다. 완료될 때까지 잠시 기다려 주세요.");
        window.history.pushState({ ...window.history.state, record: currentRecordKey.current }, "", currentView.current === "today" ? window.location.pathname : `#${currentView.current}`);
        return;
      }
      if (
        next !== currentView.current &&
        followUpDirty.current &&
        !window.confirm("작성 중인 할 일이 있습니다. 저장하지 않고 이동할까요?")
      ) {
        window.history.pushState(
          null,
          "",
          currentView.current === "today"
            ? window.location.pathname
            : `#${currentView.current}`,
        );
        return;
      }
      if (next !== currentView.current || recordChanged) {
        workOpenVersion.current += 1;
        setWorkOpening(null);
        workReadVersion.current += 1;
        setWorkReader(null);
        setReaderReference(null);
      }
      if (record && recordChanged) {
        restoreRecord.current(record);
      } else if (!record) {
        historyOpenVersion.current += 1;
        setHistoryModal((current) => current && isRecordHistory(current) ? null : current);
      }
      currentView.current = next;
      setView(next);
    };
    syncView();
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);
  // A record page is its own browser history entry, so the back button returns to the list.
  const recordKey = historyModal && isRecordHistory(historyModal)
    ? historyModal.customer ? `customer:${historyModal.customer.id}` : `listing:${historyModal.listing?.identity_key ?? historyModal.listingKey}`
    : null;
  useEffect(() => {
    currentRecordKey.current = recordKey;
    if (!recordKey) return;
    workReadVersion.current += 1;
    setWorkReader(null);
    setReaderReference(null);
    if (window.history.state?.record !== recordKey) window.history.pushState({ ...window.history.state, record: recordKey }, "", window.location.href);
    window.scrollTo({ top: 0 });
  }, [recordKey]);
  useEffect(() => {
    const controller = new AbortController();
    const versions = requestVersion.current;
    const moreControllers = managedMoreControllers.current;
    // Only typing waits for a pause. Navigating, dates, filters and sorting are immediate.
    const timer = window.setTimeout(() => {
      if (view === "journal" && queries.journal === journalSearch)
        void loadWorkLogs(controller.signal).catch(showLoadError);
      if (view === "calendar")
        void loadCalendar(controller.signal).catch(showLoadError);
      if (view === "listings" && queries.listings === listingsSearch)
        void loadListings(controller.signal).catch(showLoadError);
      if (view === "customers" && queries.customers === customersSearch)
        void loadCustomers(controller.signal).catch(showLoadError);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      moreControllers.listings?.abort();
      moreControllers.customers?.abort();
      versions.work += 1;
      versions.calendar += 1;
      versions.listings += 1;
      versions.customers += 1;
    };
  }, [
    view,
    loadWorkLogs,
    loadCalendar,
    loadListings,
    loadCustomers,
    queries,
    journalSearch,
    listingsSearch,
    customersSearch,
    showLoadError,
  ]);

  function navigate(next: View) {
    if (next !== view && (followUpBusy.current || workBusy.current || customerBusy.current)) { setNotice("저장 중입니다. 완료될 때까지 잠시 기다려 주세요."); return false; }
    if (next === view) {
      if (historyModal) { historyOpenVersion.current += 1; setHistoryModal(null); }
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (next === "today") void refreshBase().catch(showLoadError);
      return true;
    }
    if (
      followUpDirty.current &&
      !window.confirm("작성 중인 할 일이 있습니다. 저장하지 않고 이동할까요?")
    )
      return false;
    const hash = next === "today" ? "" : `#${next}`;
    workOpenVersion.current += 1;
    setWorkOpening(null);
    workReadVersion.current += 1;
    setWorkReader(null);
    setReaderReference(null);
    historyOpenVersion.current += 1;
    setHistoryModal(null);
    window.history.pushState(
      { view: next },
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
    setView(next);
    currentView.current = next;
    if (next === "today") void refreshBase().catch(showLoadError);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }
  async function openWork(
    id?: string,
    initialCustomerId?: string,
    initialWorkType?: string,
    initialListing?: Listing,
    copySource?: WorkDetail,
  ) {
    const version = ++workOpenVersion.current;
    const request = { id, initialCustomerId, initialWorkType, initialListing, ...(copySource ? { copySource } : {}) };
    // A slow directory/detail request must not make the button look unresponsive.
    // Keep the existing reader and any draft mounted until the new form is ready.
    setWorkOpening(request);
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Home can render before reference data; never open a form with an empty name picker.
      const [, data] = await Promise.all([
        loadReferenceData(),
        id && !copySource
          ? jsonFetch<{ workLog: WorkDetail }>(`/api/work-logs/${encodeURIComponent(id)}`)
          : undefined,
      ]);
      if (version !== workOpenVersion.current) return;
      setWorkOpening(null);
      setWorkModal(
        copySource
          ? { mode: "copy", item: copySource }
          : data
          ? { mode: "edit", item: data.workLog }
          : { mode: "new", initialCustomerId, initialWorkType, initialListing },
      );
      return;
    } catch (error) {
      if (version !== workOpenVersion.current) return;
      if (isAborted(error) && attempt === 0) continue;
      setWorkOpening({ ...request, error: isAborted(error) ? "업무 열기가 중단되었습니다. 다시 불러와 주세요." : error instanceof Error ? error.message : "업무 입력에 필요한 정보를 불러오지 못했습니다." });
      return;
    }
    }
  }
  function closeWorkOpening() {
    workOpenVersion.current += 1;
    setWorkOpening(null);
  }
  async function readWork(id?: string) {
    if (!id) { await openWork(); return; }
    workOpenVersion.current += 1;
    setWorkOpening(null);
    const version = ++workReadVersion.current;
    setGlobalSearchOpen(false);
    setReaderReference(null);
    setWorkReader({ id, loading: true });
    try {
      const data = await jsonFetch<{ workLog: WorkDetail }>(`/api/work-logs/${encodeURIComponent(id)}`);
      if (version === workReadVersion.current) setWorkReader({ id, item: data.workLog, loading: false });
    } catch (error) {
      if (version === workReadVersion.current) setWorkReader({ id, loading: false, error: isAborted(error) ? "업무 내용 조회가 중단되었습니다. 다시 불러와 주세요." : (error as Error).message });
    }
  }
  function closeWorkReader() {
    workReadVersion.current += 1;
    workOpenVersion.current += 1;
    setWorkOpening(null);
    setWorkReader(null);
    setReaderReference(null);
  }
  function openReaderReference(target: RelatedHistoryTarget) {
    readerReferenceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReaderReference(target);
  }
  function closeReaderReference() {
    setReaderReference(null);
    const trigger = readerReferenceTrigger.current;
    window.requestAnimationFrame(() => { if (trigger?.isConnected) { trigger.focus(); trigger.scrollIntoView({ block: "nearest" }); } });
  }
  async function editCustomer(id: string) {
    try {
      const data = await jsonFetch<{ customer: Customer }>(`/api/customers/${encodeURIComponent(id)}`, { cache: "no-store" });
      setCustomerModal({ mode: "edit", item: data.customer });
    } catch (error) {
      setNotice(`고객 정보를 불러오지 못했습니다. 다시 시도해 주세요. (${(error as Error).message})`);
    }
  }
  async function afterMutation(message: string) {
    setNotice(message);
    setInsightsRefreshKey((value) => value + 1);
    setFollowUpRefreshKey((value) => value + 1);
    try {
      await Promise.all([
        refreshBase(),
        view === "journal" ? loadWorkLogs(undefined, workLogs.length) : undefined,
        view === "calendar" ? loadCalendar() : undefined,
        view === "listings" ? loadListings(undefined, listings.length) : undefined,
        view === "customers" ? loadCustomers(undefined, customerResults.length) : undefined,
      ]);
    } catch (error) {
      if (isAborted(error)) return;
      setNotice(
        `${message} 화면 갱신이 늦어지고 있습니다. 새로고침해 주세요. (${(error as Error).message})`,
      );
    }
  }
  async function afterDeletion() {
    const target = deletionTarget;
    if (!target) return;
    setDeletionTarget(null);
    if (target.type === "work") {
      workOpenVersion.current += 1;
      setWorkModal(null);
      closeWorkReader();
    } else if (target.type === "customer") {
      setCustomerModal(null);
      if (historyModal?.customer?.id === target.id) {
        historyOpenVersion.current += 1;
        setHistoryModal(null);
      }
    }
    await Promise.all([
      afterMutation(`${target.type === "work" ? "업무" : "고객"} 기록을 휴지통으로 옮겼습니다. 휴지통에서 복구할 수 있습니다.`),
      target.type === "work" ? refreshHistory(historyModal) : undefined,
    ]);
  }
  async function loadMoreWorkLogs() {
    if (
      !canAppendPage(
        loadedWorkQueryRef.current,
        workQueryKey,
        workFirstRequest.current !== null,
        workMorePending.current,
      ) ||
      workLogs.length >= workTotal ||
      journalStatus !== "ready" ||
      queries.journal !== journalSearch
    )
      return;
    const version = ++requestVersion.current.work;
    workMorePending.current = true;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: "100",
        offset: String(workLogs.length),
      });
      if (queries.journal) params.set("q", queries.journal);
      if (workTypeFilter) params.set("workType", workTypeFilter);
      const data = await jsonFetch<{ workLogs: WorkSummary[]; total: number }>(
        `/api/work-logs?${params}`,
      );
      if (version === requestVersion.current.work) {
        setWorkLogs((current) => [...current, ...data.workLogs]);
        setWorkTotal(data.total);
        return workLogs.length + data.workLogs.length;
      }
    } catch (error) {
      showLoadError(error);
    } finally {
      workMorePending.current = false;
      setLoadingMore(false);
    }
  }
  function managedQueryParams(target: ManagedView) {
    if (target === "customers") {
      const params = new URLSearchParams({ sort: customerSort });
      if (queries.customers) params.set("q", queries.customers);
      return params;
    }
    const params = new URLSearchParams({ state: "all", sort: listingSort });
    listingStatuses.forEach((status) => params.append("status", status));
    listingPrices.forEach((price) => params.append("price", price));
    if (queries.listings) params.set("q", queries.listings);
    if (propertyTypeFilter) params.set("type", propertyTypeFilter);
    return params;
  }
  async function loadMoreManaged(target: ManagedView) {
    const queryKey = target === "listings" ? listingQueryKey : customerQueryKey;
    const status = target === "listings" ? listingStatus : customerStatus;
    if (status !== "ready" || !managedPages[target].hasMore || !canAppendPage(
      managedReads[target].loadedQuery, queryKey, managedFirstPending.current[target] !== null, managedMorePending.current[target],
    )) return;
    const rows = target === "listings" ? listings : customerResults;
    const params = managedQueryParams(target);
    params.set("limit", String(MANAGEMENT_PAGE_SIZE));
    params.set("offset", String(rows.length));
    const version = ++requestVersion.current[target];
    const controller = new AbortController();
    managedMoreControllers.current[target] = controller;
    managedMorePending.current[target] = true;
    setManagedPages((current) => ({ ...current, [target]: { ...current[target], loadingMore: true, moreError: "" } }));
    try {
      const data = await jsonFetch<{ listings: Listing[]; customers: Customer[]; total: number; hasMore: boolean }>(`/api/${target}?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || version !== requestVersion.current[target]) return;
      const nextRows = data[target];
      if (!Array.isArray(nextRows) || nextRows.length > MANAGEMENT_PAGE_SIZE || !Number.isSafeInteger(data.total) || data.total < rows.length || (!nextRows.length && data.hasMore)) {
        throw new Error("조회 중 목록이 변경되었습니다. 최신 목록을 다시 불러와 주세요.");
      }
      // A shifted offset must never silently duplicate rows after another device saves.
      if (target === "listings") setListings(appendManagedRows(listings, data.listings));
      else setCustomerResults(appendManagedRows(customerResults, data.customers));
      setManagedPages((current) => ({ ...current, [target]: { ...current[target], total: data.total, hasMore: data.hasMore, moreError: "" } }));
      return rows.length + nextRows.length;
    } catch (error) {
      if (!controller.signal.aborted && version === requestVersion.current[target]) {
        setManagedPages((current) => ({ ...current, [target]: { ...current[target], moreError: isAborted(error) ? "추가 조회가 중단되었습니다. 다시 불러와 주세요." : (error as Error).message } }));
      }
    } finally {
      if (managedMoreControllers.current[target] === controller) {
        managedMorePending.current[target] = false;
        setManagedPages((current) => ({ ...current, [target]: { ...current[target], loadingMore: false } }));
      }
    }
  }
  async function copyCustomerId(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("고객 ID를 복사했습니다.");
    } catch {
      setNotice("복사하지 못했습니다. 고객 ID를 길게 눌러 복사해 주세요.");
    }
  }
  async function showCustomerHistory(
    customer: Pick<Customer, "id" | "name"> | SearchCustomer,
    preserve = false,
  ) {
    const version = ++historyOpenVersion.current;
    setGlobalSearchOpen(false);
    setHistoryModal((current) => ({
      title: `${customer.name} 업무 이력`, subtitle: customer.id, customer,
      items: preserve && current?.customer?.id === customer.id ? current.items : [],
      historyWorkType: preserve && current?.customer?.id === customer.id ? current.historyWorkType : "",
      loading: true,
    }));
    try {
      const [items, profile] = await Promise.all([
        fetchAllWorkLogs(new URLSearchParams({ customerId: customer.id, includeSource: "1" })),
        jsonFetch<{ customer: Customer }>(`/api/customers/${encodeURIComponent(customer.id)}`, { cache: "no-store" }).catch(() => null),
      ]);
      if (version !== historyOpenVersion.current) return;
      setHistoryModal((current) => ({
        title: `${profile?.customer.name ?? customer.name} 업무 이력`,
        subtitle: customer.id,
        items,
        customer: profile?.customer ?? customer,
        customerNotesError: profile ? undefined : "비고를 불러오지 못했습니다.",
        historyWorkType: current?.historyWorkType ?? "",
      }));
    } catch (error) {
      if (version === historyOpenVersion.current) setHistoryModal((current) => current ? { ...current, loading: false, error: (error as Error).message } : null);
    }
  }
  async function showListingHistory(
    listing:
      | Pick<
          Listing,
          | "identity_key"
          | "property_type"
          | "building_name"
          | "building_dong"
          | "unit_number"
        >
      | SearchListing,
  ) {
    await showListingByKey(listing.identity_key);
  }
  async function showListingByKey(key: string, preserve = false) {
    const version = ++historyOpenVersion.current;
    const [property_type, building_name, building_dong, unit_number] = key.split("|");
    const fallbackTarget = { property_type, building_name, building_dong, unit_number };
    setGlobalSearchOpen(false);
    setHistoryModal((current) => {
      const sameTarget = preserve && (current?.listing?.identity_key === key || current?.listingKey === key);
      return {
        title: sameTarget ? current!.title : `${targetText(fallbackTarget)} 이력`,
        subtitle: "이 매물이 포함된 업무와 매물 변경 이력을 확인합니다",
        items: sameTarget ? current!.items : [],
        listing: sameTarget ? current!.listing : undefined,
        workItems: sameTarget ? current!.workItems : undefined,
        historyWorkType: sameTarget ? current!.historyWorkType : "",
        listingKey: key,
        loading: true,
      };
    });
    try {
      const data = await jsonFetch<{
        listing: Listing | null;
        events: ListingEvent[];
        workLogs: WorkSummary[];
      }>(`/api/listings/${encodeURIComponent(key)}`);
      if (version !== historyOpenVersion.current) return;
      setHistoryModal((current) => ({
        title: `${targetText(data.listing ?? fallbackTarget)} 이력`,
        subtitle: data.listing?.property_type ?? property_type,
        items: data.events,
        workItems: data.workLogs,
        listing: data.listing ?? undefined,
        listingKey: key,
        historyWorkType: current?.historyWorkType ?? "",
      }));
    } catch (error) {
      if (version !== historyOpenVersion.current) return;
      const missing = (error as Error).message === "매물을 찾을 수 없습니다.";
      setHistoryModal((current) => current ? {
        ...current,
        ...(missing ? { items: [], workItems: [], listing: undefined } : {}),
        loading: false,
        emptyMessage: missing && preserve ? "이 주소에 남아 있는 업무·매물 이력이 없습니다. 삭제한 업무는 휴지통에서 복구할 수 있습니다." : undefined,
        error: missing && preserve ? undefined : missing
          ? "이 주소로 저장된 업무·매물 이력이 없습니다. 업무에 적힌 물건구분·건물명·동·호수를 확인해 주세요."
          : (error as Error).message,
      } : null);
    }
  }
  async function refreshHistory(history: HistoryData | null) {
    if (!history) return;
    if (history.customer) return showCustomerHistory(history.customer, true);
    if (history.listing) return showListingByKey(history.listing.identity_key, true);
    if (history.listingKey) return showListingByKey(history.listingKey, true);
    if (history.scheduleDays) return showScheduleHistory(history, true);
    if (!history.date) return;
    const version = ++historyOpenVersion.current;
    setHistoryModal({ ...history, loading: true, error: undefined });
    try {
      const params = new URLSearchParams({ from: history.date, to: history.date });
      if (history.workType) params.set("workType", history.workType);
      if (history.sort) params.set("sort", history.sort);
      const items = await fetchAllWorkLogs(params);
      if (version === historyOpenVersion.current) setHistoryModal({ ...history, items, subtitle: `${items.length}건${history.sort === "updated" ? " · 최근 수정순" : ""}`, loading: false, error: undefined });
    } catch (error) {
      if (version === historyOpenVersion.current) setHistoryModal({ ...history, loading: false, error: (error as Error).message });
    }
  }
  async function showScheduleHistory(history: HistoryData, preserve = false) {
    const version = ++historyOpenVersion.current;
    setHistoryModal({ ...history, items: preserve ? history.items : [], loading: true, error: undefined });
    try {
      const items = await fetchAllWorkLogs(new URLSearchParams({ from: history.from!, to: history.to!, schedule: "1" }));
      if (version === historyOpenVersion.current) setHistoryModal({ ...history, items, subtitle: `${displayDate(history.from)} ~ ${displayDate(history.to)} · ${items.length}건 · 잔금·집방문 예정 우선 · 같은 우선순위는 날짜순`, loading: false, error: undefined });
    } catch (error) {
      if (version === historyOpenVersion.current) setHistoryModal({ ...history, loading: false, error: (error as Error).message });
    }
  }
  function openSchedule(days: number) {
    const from = shiftDate(seoulDate(), 1), to = shiftDate(seoulDate(), days);
    void showScheduleHistory({ title: `앞으로 ${days}일 전체 일정`, subtitle: `${displayDate(from)} ~ ${displayDate(to)} · 예약·예정 업무`, items: [], scheduleDays: days, from, to });
  }
  function openTodayHistory() {
    void refreshHistory({ title: "오늘 업무", subtitle: "최근 수정순", date: seoulDate(), sort: "updated", items: [] });
  }
  function navigateFromDashboard(next: View) {
    if (!navigate(next)) return;
    if (next === "listings") {
      setQueries((current) => ({ ...current, listings: "" }));
      setListingStatuses([]); setListingPrices([]); setPropertyTypeFilter(""); setListingSort("type");
    } else if (next === "customers") {
      setQueries((current) => ({ ...current, customers: "" })); setCustomerSort("recent");
    } else if (next === "journal") {
      setQueries((current) => ({ ...current, journal: "" })); setWorkTypeFilter("");
    } else if (next === "calendar") {
      setCalendarMonth(seoulDate().slice(0, 7)); setCalendarWorkType("");
    }
  }
  function showAllSearchResults(next: SearchView, search: string) {
    if (!navigate(next)) return false;
    setQueries((current) => ({ ...current, [next]: search }));
    if (next === "journal") { setWorkTypeFilter(""); }
    if (next === "customers") setCustomerSort("recent");
    if (next === "listings") {
      setListingStatuses([]); setListingPrices([]); setPropertyTypeFilter(""); setListingSort("type");
    }
    return true;
  }
  function showWorkListingHistory(work: WorkSummary) {
    const target = createPropertyHistoryTarget({
      propertyType: work.property_type ?? "",
      buildingName: work.building_name ?? "",
      buildingDong: work.building_dong ?? "",
      unitNumber: work.unit_number ?? "",
    });
    if (target?.kind === "listing") void showListingByKey(target.key);
  }
  async function signOut() {
    if (followUpBusy.current || workBusy.current || customerBusy.current) { setNotice("저장 중입니다. 완료될 때까지 잠시 기다려 주세요."); return; }
    if (
      followUpDirty.current &&
      !window.confirm(
        "작성 중인 할 일이 있습니다. 저장하지 않고 로그아웃할까요?",
      )
    )
      return;
    clearClientReadCache();
    try {
      await jsonFetch("/api/auth/logout", { method: "POST" });
      window.location.assign("/login");
    } catch (error) {
      showLoadError(error);
    }
  }

  const recordPage = historyModal && isRecordHistory(historyModal) ? historyModal : null;
  const recordTitle = recordPage ? recordPage.customer?.name ?? recordPage.title.replace(/ 이력$/, "") : "";
  const sidePanelOpen = wideScreen && Boolean((workReader && !workModal) || (historyModal && !workReader && !recordPage));
  const sidePanel = sidePanelOpen ? recordPage || SIDE_PANEL_LIST_VIEWS.includes(view) ? "beside" : "over" : undefined;
  function closeRecordPage() {
    if (window.history.state?.record) { window.history.back(); return; }
    historyOpenVersion.current += 1;
    workOpenVersion.current += 1;
    setHistoryModal(null);
  }
  function renderHistory(page: boolean) {
    return (
      <HistoryModal
        data={historyModal!}
        page={page}
        workTypes={lookups.workTypes}
        onWorkTypeChange={(historyWorkType) => setHistoryModal((current) => current ? { ...current, historyWorkType } : null)}
        onClose={page ? closeRecordPage : () => { historyOpenVersion.current += 1; workOpenVersion.current += 1; setHistoryModal(null); }}
        onRefresh={() => void refreshHistory(historyModal)}
        onOpenWork={(id) => {
          void readWork(id);
        }}
        onNewWork={(id) => void openWork(undefined, id)}
        onEditCustomer={(id) => void editCustomer(id)}
        onNewListingWork={(listing) => void openWork(undefined, undefined, undefined, listing)}
        onModifyListing={(listing, customerId) => void openWork(undefined, customerId, "매물수정", listing)}
        onFollowUp={addFollowUp}
        onCopy={copyCustomerId}
        onStructure={(key) => { setStructureKey(key); setHistoryModal(null); navigate("structures"); }}
      />
    );
  }
  const dateLabel = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  const titles: Record<View, string> = {
    structures: "집 구조 보기",
    today: "오늘의 업무",
    tasks: "챙겨야 할 일",
    insights: "업무 현황",
    journal: "업무일지",
    listings: "매물 관리",
    customers: "고객 관리",
    calendar: "업무 달력",
    trash: "휴지통",
    settings: "설정",
  };
  const searchView = (["journal", "listings", "customers"] as View[]).includes(
    view,
  )
    ? (view as SearchView)
    : null;
  const query = searchView ? queries[searchView] : "";
  function setQuery(value: string) {
    if (!searchView) return;
    setQueries((current) => ({ ...current, [searchView]: value }));
  }

  return (
    <main className="app-shell" data-view={view} data-readable={readable} data-side-panel={sidePanel}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <button
            className="brand brand-button"
            onClick={() => navigate("today")}
            type="button"
            aria-label="집장부 홈으로 이동"
          >
            <BrandMark />
            <span>
              <strong>집장부</strong>
            </span>
          </button>
          <p className="brand-office">마전현대공인중개사무소</p>
          <div className="sidebar-actions">
            <button className="global-search-trigger" onClick={showGlobalSearch} type="button" aria-keyshortcuts="/" aria-label="통합검색">검색</button>
            <button className="primary-button sidebar-new-work" aria-label="새 업무 등록" onClick={() => openWork()} type="button"><Icon name="plus" size={18} /> <span>새 업무 등록</span></button>
          </div>
        </div>
        <nav aria-label="주요 메뉴">
          {navGroups.map(([group, keys]) => (
            <div className="nav-group" key={group} role="group" aria-label={group}>
              <p className="nav-group-label" aria-hidden="true">{group}</p>
              {navItems.filter(([key]) => keys.includes(key)).map(([key, label]) => (
                <button
                  className={`nav-item ${view === key && !recordPage ? "active" : ""}${view === key && recordPage ? " is-parent" : ""}`}
                  key={key}
                  onClick={() => navigate(key)}
                  type="button"
                  aria-current={view === key ? "page" : undefined}
                >
                  <Icon
                    name={key === "today" ? "home" : key}
                    className="nav-icon"
                    size={21}
                  />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            className="font-size-toggle"
            type="button"
            aria-pressed={readable}
            onClick={toggleReadable}
          >
            <Icon name="text" size={18} />
            <span>{readable ? "기본 글씨" : "큰 글씨"}</span>
          </button>
          <button className="logout-link" onClick={signOut} type="button">
            <Icon name="logout" size={18} />
            로그아웃
          </button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="title-stack">
            {recordPage && (
              <button type="button" className="back-link" onClick={closeRecordPage}>
                <Icon name="back" size={18} /> {titles[view]}
              </button>
            )}
            <h1>{recordPage ? recordTitle : titles[view]}</h1>
            {view === "today" && !recordPage && <p className="view-purpose"><span className="record-date">{dateLabel}</span></p>}
          </div>
          <time className="topbar-date" dateTime={seoulDate()}>{dateLabel}</time>
        </header>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            {notice.includes("휴지통") && view !== "trash" && <button type="button" className="notice-action" onClick={() => navigate("trash")}>휴지통 보기</button>}
            <button onClick={() => setNotice("")} aria-label="알림 닫기">
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        {dashboard?.demoMode && (
          <div className="demo-banner">
            <strong>예시 데이터로 보는 화면입니다.</strong>
            <span>실제 엑셀 자료는 배포 DB 이관 단계에서 채웁니다.</span>
          </div>
        )}
        {recordPage && renderHistory(true)}
        <PageToolsSlot.Provider value={null}>
        <div className="view-content" key={view} hidden={Boolean(recordPage)}>
          {loading ? (
            <Loading />
          ) : (
            <>
              {view === "today" && dashboardError && (
                <ListReadFeedback status="error" error={`${dashboard ? "이전 홈 정보를 표시 중입니다. " : ""}${dashboardError}`} onRetry={() => void refreshDashboard().catch(showLoadError)} label="홈 정보" />
              )}
              {view === "today" && dashboard && (
                <DashboardView
                  dashboard={dashboard}
                  onOpen={readWork}
                  onCustomerHistory={showCustomerHistory}
                  onListingHistory={showWorkListingHistory}
                  onNavigate={navigateFromDashboard}
                  onOpenSchedule={() => openSchedule(7)}
                  onOpenToday={openTodayHistory}
                  followUps={
                    <FollowUpsView
                      compact
                      onBusyChange={setFollowUpBusy}
                      onDirtyChange={(dirty) => {
                        followUpDirty.current = dirty;
                      }}
                      refreshKey={followUpRefreshKey}
                      onChange={() =>
                        setInsightsRefreshKey((value) => value + 1)
                      }
                      onOpenCustomer={(id, name) =>
                        void showCustomerHistory({ id, name })
                      }
                      onOpenListing={(key) => void showListingByKey(key)}
                      onShowAll={() => navigate("tasks")}
                      onOpenTrash={() => navigate("trash")}
                    />
                  }
                />
              )}
              {view === "tasks" && (
                <FollowUpsView
                  onOpenTrash={() => navigate("trash")}
                  onBusyChange={setFollowUpBusy}
                  onDirtyChange={(dirty) => {
                    followUpDirty.current = dirty;
                  }}
                  refreshKey={followUpRefreshKey}
                  onChange={() => setInsightsRefreshKey((value) => value + 1)}
                  initialDraft={followUpDraft}
                  onDraftConsumed={() => setFollowUpDraft(undefined)}
                  onOpenCustomer={(id, name) =>
                    void showCustomerHistory({ id, name })
                  }
                  onOpenListing={(key) => void showListingByKey(key)}
                />
              )}
              {view === "insights" && (
                <Suspense fallback={<Loading />}>
                  <InsightsView
                    refreshKey={insightsRefreshKey}
                    onOpenSchedule={() => openSchedule(30)}
                    onOpenWork={(id) => {
                      void readWork(id);
                    }}
                    onOpenListing={(item) => {
                      void showListingHistory(item);
                    }}
                  />
                </Suspense>
              )}
              {view === "journal" && (
                <JournalView
                  items={workLogs}
                  total={workTotal}
                  lookups={lookups}
                  query={query}
                  setQuery={setQuery}
                  workType={workTypeFilter}
                  setWorkType={setWorkTypeFilter}
                  onReset={() => {
                    setQuery("");
                    setWorkTypeFilter("");
                  }}
                  onLoadMore={loadMoreWorkLogs}
                  loadingMore={loadingMore}
                  status={journalStatus}
                  error={workSearchError?.queryKey === workQueryKey ? workSearchError.message : ""}
                  onRetry={() => loadWorkLogs().catch(showLoadError)}
                  canLoadMore={
                    canAppendPage(
                      loadedWorkQuery,
                      workQueryKey,
                      workFirstPageLoading,
                      loadingMore,
                    ) && queries.journal === journalSearch && journalStatus === "ready"
                  }
                  onOpen={readWork}
                  onCustomerHistory={showCustomerHistory}
                  onListingHistory={showWorkListingHistory}
                />
              )}
              {view === "listings" && (
                <ListingsView
                  items={listings}
                  total={managedPages.listings.total}
                  hasMore={managedPages.listings.hasMore}
                  loadingMore={managedPages.listings.loadingMore}
                  moreError={managedPages.listings.moreError}
                  onLoadMore={() => loadMoreManaged("listings")}
                  canLoadMore={listingStatus === "ready" && !managedPages.listings.loadingMore && managedReads.listings.loadedQuery === listingQueryKey}
                  status={listingStatus}
                  error={managedReads.listings.error?.queryKey === listingQueryKey ? managedReads.listings.error.message : ""}
                  onRetry={() => void loadListings(undefined, managedReads.listings.loadedQuery === listingQueryKey ? listings.length : MANAGEMENT_PAGE_SIZE).catch(showLoadError)}
                  lookups={lookups}
                  query={query}
                  setQuery={setQuery}
                  statuses={listingStatuses}
                  setStatuses={setListingStatuses}
                  prices={listingPrices}
                  setPrices={setListingPrices}
                  propertyType={propertyTypeFilter}
                  setPropertyType={setPropertyTypeFilter}
                  sort={listingSort}
                  setSort={setListingSort}
                  onReset={() => {
                    setQuery("");
                    setListingStatuses([]);
                    setListingPrices([]);
                    setPropertyTypeFilter("");
                    setListingSort("type");
                  }}
                  onHistory={showListingHistory}
                />
              )}
              {view === "customers" && (
                <CustomersView
                  items={customerResults}
                  total={managedPages.customers.total}
                  hasMore={managedPages.customers.hasMore}
                  loadingMore={managedPages.customers.loadingMore}
                  moreError={managedPages.customers.moreError}
                  onLoadMore={() => void loadMoreManaged("customers")}
                  canLoadMore={customerStatus === "ready" && !managedPages.customers.loadingMore && managedReads.customers.loadedQuery === customerQueryKey}
                  status={customerStatus}
                  error={managedReads.customers.error?.queryKey === customerQueryKey ? managedReads.customers.error.message : ""}
                  onRetry={() => void loadCustomers(undefined, managedReads.customers.loadedQuery === customerQueryKey ? customerResults.length : MANAGEMENT_PAGE_SIZE).catch(showLoadError)}
                  query={query}
                  setQuery={setQuery}
                  sort={customerSort}
                  setSort={setCustomerSort}
                  onReset={() => {
                    setQuery("");
                    setCustomerSort("recent");
                  }}
                  onEdit={(item) => setCustomerModal({ mode: "edit", item })}
                  onNew={() => setCustomerModal({ mode: "new" })}
                  onNewWork={(item) => {
                    void openWork(undefined, item.id);
                  }}
                  onCopy={copyCustomerId}
                  onHistory={(customer) => void showCustomerHistory(customer)}
                />
              )}
              {view === "calendar" && (
                <CalendarView
                  status={calendarStatus}
                  error={managedReads.calendar.error?.queryKey === calendarQueryKey ? managedReads.calendar.error.message : ""}
                  onRetry={() => void loadCalendar().catch(showLoadError)}
                  month={calendarMonth}
                  setMonth={setCalendarMonth}
                  workType={calendarWorkType}
                  setWorkType={setCalendarWorkType}
                  items={calendarLogs}
                  lookups={lookups}
                  onOpen={readWork}
                  onShowDay={(date, items) => {
                    historyOpenVersion.current += 1;
                    setHistoryModal({
                      title: `${displayDate(date)} 업무`,
                      subtitle: `${items.length}건`,
                      items,
                      date,
                      workType: calendarWorkType,
                    });
                  }}
                />
              )}
              {view === "structures" && <Suspense fallback={<p role="status">집 구조 화면을 준비하고 있습니다…</p>}><StructureView key={structureKey} initialKey={structureKey} refreshKey={insightsRefreshKey} onOpenWork={(id) => void readWork(id)} /></Suspense>}
              {view === "settings" && (
                <SettingsView
                  lookups={lookups}
                  onLogout={signOut}
                  onSaved={async () => {
                    setInsightsRefreshKey((value) => value + 1);
                    const data = await jsonFetch<Lookups>("/api/lookups");
                    setLookups(data);
                    setNotice("분류가 추가되었습니다.");
                  }}
                />
              )}
              {view === "trash" && <Suspense fallback={<p role="status">휴지통을 준비하고 있습니다…</p>}><TrashView refreshKey={insightsRefreshKey} onBusyChange={setWorkBusy} onRestored={() => { void afterMutation("기록을 복구했습니다. 원래 목록과 이력에 다시 반영했습니다."); }} /></Suspense>}
            </>
          )}
        </div>
        </PageToolsSlot.Provider>
      </section>
      {globalSearchLoaded && (
        <Suspense
          fallback={
            globalSearchOpen ? (
              <Modal
                title="통합검색"
                subtitle="고객·매물·업무를 한 번에 검색"
                onClose={() => setGlobalSearchOpen(false)}
              >
                <p role="status">검색을 준비하고 있습니다.</p>
              </Modal>
            ) : null
          }
        >
          <GlobalSearch
            open={globalSearchOpen}
            refreshKey={insightsRefreshKey}
            onClose={() => setGlobalSearchOpen(false)}
            onShowAll={showAllSearchResults}
            onOpenWork={(id) => {
              void readWork(id);
            }}
            onOpenCustomer={(item) => {
              void showCustomerHistory(item);
            }}
            onOpenListing={(item) => {
              void showListingHistory(item);
            }}
          />
        </Suspense>
      )}
      {historyModal && !workReader && !recordPage && renderHistory(false)}
      {workReader && !workModal && (
        <Modal title="업무 내용" onClose={closeWorkReader} reading>
          {workReader.loading && <p className="form-help" role="status">업무 내용과 연결된 물건을 불러오고 있습니다…</p>}
          {workReader.error && <div className="form-error" role="alert"><p>{workReader.error}</p><button type="button" className="secondary-button" onClick={() => void readWork(workReader.id)}><Icon name="refresh" size={16} /> 다시 불러오기</button></div>}
          {workReader.item && <Suspense fallback={<p role="status">읽기 화면을 준비하고 있습니다…</p>}>
            <WorkDetailView item={workReader.item} onEdit={() => void openWork(workReader.id)}
              onCopy={() => void openWork(undefined, undefined, undefined, undefined, workReader.item!)}
              onDelete={() => setDeletionTarget({ type: "work", id: workReader.id })}
              onCustomerHistory={() => openReaderReference({ kind: "customer", id: workReader.item!.customer_id, name: workReader.item!.customer_name })}
              onEditCustomer={() => void editCustomer(workReader.item!.customer_id)}
              onListingHistory={(key) => { const [, building_name, building_dong, unit_number] = key.split("|"); openReaderReference({ kind: "listing", key, name: workPropertyLabel({ building_name, building_dong, unit_number }) }); }} />
          </Suspense>}
          {readerReference && <ReaderReferencePanel target={readerReference} workTypes={lookups.workTypes} onClose={closeReaderReference} />}
        </Modal>
      )}
      {workModal && (
        <WorkModal
          onBusyChange={setWorkBusy}
          key={`${workModal.mode}-${workModal.item?.id || "new"}`}
          modal={workModal}
          customers={customers}
          lookups={lookups}
          onNewCustomer={(initialId) => setCustomerModal({ mode: "new", initialId })}
          onEditCustomer={(id) => void editCustomer(id)}
          onClose={() => { workOpenVersion.current += 1; setWorkModal(null); }}
          onCopy={(item) => { workOpenVersion.current += 1; setWorkModal({ mode: "copy", item }); }}
          onDelete={(id, unsavedDraft) => setDeletionTarget({ type: "work", id, unsavedDraft })}
          onSaved={async (message, copiedWork) => {
            workOpenVersion.current += 1;
            setWorkModal(null);
            if (copiedWork) {
              workReadVersion.current += 1;
              setReaderReference(null);
              setWorkReader({ id: copiedWork.id, item: copiedWork, loading: false });
            }
            await Promise.all([afterMutation(message), refreshHistory(historyModal), !copiedWork && workReader ? readWork(workReader.id) : undefined]);
          }}
        />
      )}
      {customerModal && (
        <CustomerModal
          onBusyChange={setCustomerBusy}
          modal={customerModal}
          onClose={() => setCustomerModal(null)}
          onDelete={(id, unsavedDraft) => setDeletionTarget({ type: "customer", id, unsavedDraft })}
          onSaved={async (message, customerId, savedCustomer) => {
            setCustomerModal(null);
            if (savedCustomer) setCustomers((current) => [savedCustomer, ...current.filter((item) => item.id !== savedCustomer.id)]);
            if (savedCustomer) {
              setHistoryModal((current) => current?.customer?.id === savedCustomer.id ? { ...current, customer: savedCustomer, title: `${savedCustomer.name} 업무 이력` } : current);
              setWorkReader((current) => current?.item?.customer_id === savedCustomer.id ? { ...current, item: { ...current.item, customer_name: savedCustomer.name } } : current);
            }
            if (customerId)
              setWorkModal((current) =>
                current
                  ? { ...current, initialCustomerId: customerId }
                  : current,
              );
            await afterMutation(message);
          }}
        />
      )}
      {workOpening && (
        <Modal title={workOpening.copySource ? "업무 복사 · 새 업무 등록" : workOpening.id ? "업무 수정" : "새 업무 등록"} onClose={closeWorkOpening}>
          {workOpening.error ? (
            <div className="form-error" role="alert">
              <p>{workOpening.error}</p>
              <button type="button" className="secondary-button" onClick={() => void openWork(workOpening.id, workOpening.initialCustomerId, workOpening.initialWorkType, workOpening.initialListing, workOpening.copySource)}>
                <Icon name="refresh" size={16} /> 다시 불러오기
              </button>
            </div>
          ) : (
            <p className="form-help" role="status">고객 명부와 업무 입력 정보를 불러오고 있습니다…</p>
          )}
          <button type="button" className="secondary-button" onClick={closeWorkOpening}>취소하고 돌아가기</button>
        </Modal>
      )}
      {deletionTarget && <DeletionDialog key={`${deletionTarget.type}-${deletionTarget.id}`} {...deletionTarget} onBusyChange={setWorkBusy} onClose={() => setDeletionTarget(null)} onDeleted={() => { void afterDeletion(); }} />}
    </main>
  );
}


function Loading() {
  return (
    <div className="loading-grid">
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}
function DashboardView({
  dashboard,
  onOpen,
  onCustomerHistory,
  onListingHistory,
  onNavigate,
  onOpenSchedule,
  onOpenToday,
  followUps,
}: {
  dashboard: Dashboard;
  onOpen: (id?: string) => void;
  onNavigate: (view: View) => void;
  onOpenSchedule: () => void;
  onOpenToday: () => void;
  followUps: ReactNode;
} & WorkHistoryActions) {
  const metrics = dashboard.metrics;
  const upcoming = dashboard.upcoming ?? [];
  const days: Array<[string, WorkSummary[]]> = [];
  for (const item of upcoming) {
    const day = days.find(([date]) => date === item.work_date);
    if (day) day[1].push(item);
    else days.push([item.work_date, [item]]);
  }
  const weekday = (date: string) => new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const scheduleItem = (item: WorkSummary) => (
    <li key={item.id}>
      <button type="button" className="home-schedule-item" onClick={() => onOpen(item.id)}>
        <span className="home-schedule-line">
          <i className={`tag ${statusTone(item.work_type)}`}>{item.work_type}</i>
          <strong>{item.customer_name}</strong>
        </span>
        {item.content && <span className="home-schedule-note">{item.content}</span>}
      </button>
    </li>
  );
  return (
    <div className="home-body-grid home-today">
      <section className="panel home-schedule" aria-label="오늘과 다가오는 일정">
        <div className="panel-head">
          <div>
            <h2>오늘·다가오는 일정</h2>
            <p className="sort-summary">오늘 {metrics.today_count}건 · 앞으로 7일 {metrics.upcoming_count}건</p>
          </div>
          <button className="text-button" onClick={() => onNavigate("calendar")}>달력</button>
        </div>
        <div className="home-schedule-day is-today">
          <h3>오늘 <span>{weekday(seoulDate())}</span></h3>
          {dashboard.today.length ? <ol>{dashboard.today.map(scheduleItem)}</ol> : <p className="home-schedule-empty">오늘 기록한 업무가 없습니다.</p>}
        </div>
        {days.map(([date, items]) => (
          <div className="home-schedule-day" key={date}>
            <h3>{displayDate(date)} <span>{weekday(date)}</span></h3>
            <ol>{items.map(scheduleItem)}</ol>
          </div>
        ))}
        {!days.length && <p className="home-schedule-empty home-schedule-day">앞으로 7일 동안 잡힌 예정·예약 업무가 없습니다.</p>}
        <div className="home-schedule-foot">
          <button type="button" className="secondary-button" onClick={onOpenToday}>오늘 업무 보기</button>
          <button type="button" className="secondary-button" onClick={onOpenSchedule}>7일 일정 확인</button>
        </div>
      </section>
      <section className="panel recent-panel">
        <div className="panel-head">
          <div>
            <h2>최근 업무</h2>
            <p className="sort-summary">업무일 최신순</p>
          </div>
          <button className="text-button" onClick={() => onNavigate("journal")}>
            전체 보기
          </button>
        </div>
        <WorkTable items={dashboard.recent} onOpen={onOpen} onCustomerHistory={onCustomerHistory} onListingHistory={onListingHistory} />
      </section>
      {followUps}
    </div>
  );
}
function Toolbar({
  query,
  setQuery,
  placeholder,
  children,
}: {
  query: string;
  setQuery: (value: string) => void;
  placeholder: string;
  children?: React.ReactNode;
}) {
  const slot = useContext(PageToolsSlot);
  const bar = (
    <div className="toolbar">
      <div className="search-box">
        <Icon name="search" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {query && (
          <button
            className="search-clear"
            onClick={() => setQuery("")}
            type="button"
            aria-label="검색어 지우기"
          >
            <Icon name="close" size={17} />
          </button>
        )}
        <span className="search-live">바로 검색</span>
      </div>
      {children}
    </div>
  );
  return slot ? createPortal(bar, slot) : bar;
}
function ResultPagination({ paging, total, busy, onPrevious, onNext }: {
  paging: { page: number; pages: number; start: number; end: number };
  total: number;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return <footer className="renewal-pagination" aria-label="목록 페이지">
    <span role="status">{total ? `${paging.start + 1}–${paging.end} / ${total.toLocaleString("ko-KR")}건` : "0건"}</span>
    <div className="renewal-pagination-controls">
      <button type="button" className="secondary-button" aria-label="이전 페이지" onClick={onPrevious} disabled={busy || paging.page === 0}><Icon name="back" size={18} /></button>
      <span aria-live="polite">{paging.page + 1} / {paging.pages}</span>
      <button type="button" className="secondary-button" aria-label="다음 페이지" onClick={onNext} disabled={busy || paging.page + 1 >= paging.pages}><Icon name="next" size={18} /></button>
    </div>
  </footer>;
}
function JournalView({
  items, total, lookups, query, setQuery, workType, setWorkType, onReset,
  onLoadMore, loadingMore, status, error, onRetry, canLoadMore,
  onOpen, onCustomerHistory, onListingHistory,
}: {
  items: WorkSummary[]; total: number; lookups: Lookups;
  query: string; setQuery: (v: string) => void;
  workType: string; setWorkType: (v: string) => void;
  onReset: () => void; onLoadMore: () => Promise<number | undefined>;
  loadingMore: boolean; status: JournalSearchStatus; error: string;
  onRetry: () => void | Promise<void>; canLoadMore: boolean;
  onOpen: (id?: string) => void;
} & WorkHistoryActions) {
  const filtered = Boolean(query || workType);
  const resultsVisible = status === "ready" || status === "refreshing";
  const paging = useResultPage(items.length, total, JSON.stringify([query, workType]), 5);
  const listRef = useResultListRef(paging.page, JSON.stringify([query, workType]));
  return <>
    <div className="renewal-paginated-list" ref={listRef}>
      <Toolbar query={query} setQuery={setQuery} placeholder="고객명, 연락처, 건물명, 동·호수, 내용 검색">
        <select aria-label="업무구분 필터" value={workType} onChange={(event) => setWorkType(event.target.value)}>
          <option value="">모든 업무구분</option>
          {lookups.workTypes.map((type) => <option key={type}>{type}</option>)}
        </select>
        {filtered && <button className="filter-reset" onClick={onReset} type="button">초기화</button>}
      </Toolbar>
      {filtered && <div className="active-filter-row"><strong>{status === "loading" ? "검색 중" : status === "refreshing" ? "갱신 중" : status === "error" ? "다시 확인 필요" : "적용 중"}</strong>{query && <span>검색: {query}</span>}{workType && <span>{workType}</span>}</div>}
      <section className="panel data-panel" aria-busy={status === "loading" || status === "refreshing"}>
        <div className="panel-head"><h2>업무 기록 <span className="count-badge">{resultsVisible ? `${total.toLocaleString("ko-KR")}건` : status === "loading" ? "검색 중…" : "조회 실패"}</span></h2><p className="sort-summary">업무일 최신순</p></div>
        <ListReadFeedback status={status} error={error} onRetry={() => { void onRetry(); }} label="업무 기록" />
        {resultsVisible && <WorkTable items={items.slice(paging.start, paging.end)} onOpen={onOpen} onCustomerHistory={onCustomerHistory} onListingHistory={onListingHistory} />}
      </section>
    </div>
    <ResultPagination paging={paging} total={resultsVisible ? total : 0} busy={status !== "ready" || loadingMore} onPrevious={paging.previous} onNext={() => { void paging.next(canLoadMore ? onLoadMore : undefined); }} />
  </>;
}
function WorkTable({
  items,
  onOpen,
  onCustomerHistory,
  onListingHistory,
  empty = "조건에 맞는 업무가 없습니다.",
}: {
  items: WorkSummary[];
  onOpen: (id?: string) => void;
  empty?: string;
} & WorkHistoryActions) {
  if (!items.length) return <EmptyState title={empty} />;
  return (
    <div className="responsive-table work-table work-reading-list">
      <div className="work-record-head" aria-hidden="true"><span>일자</span><span>업무구분</span><span>고객</span><span>내용</span><span>물건</span></div>
      {items.map((item) => {
        const properties = getWorkProperties(item);
        const groups = getPropertyDisplayGroups(properties);
        return <article className="table-row work-record-row" key={item.id}>
          <div className="work-record-meta">
            <span data-label="고객" className="work-record-customer"><button type="button" className="work-record-customer-link" onClick={() => onCustomerHistory({ id: item.customer_id, name: item.customer_name })} aria-label={`${item.customer_name} 고객 이력 보기`}><b>{item.customer_name}</b></button></span>
            <button type="button" className={`work-record-open tag ${statusTone(item.work_type)}`} onClick={() => onOpen(item.id)} aria-label={`${item.work_type} 업무 내용 보기`}>{item.work_type}</button>
            <span data-label="일자"><button type="button" className="work-record-date" onClick={() => onOpen(item.id)} aria-label={`${displayDate(item.work_date)} ${item.customer_name} 업무 내용 보기`}><time dateTime={item.work_date}>{displayDate(item.work_date)}</time></button></span>
          </div>
          <div className={`work-record-body${properties.length ? " has-properties" : ""}`}>
            <span data-label="내용" className="work-record-content"><button type="button" className="work-cell-button work-record-note" onClick={() => onOpen(item.id)} aria-label={`${item.customer_name} 업무 내용 보기`}><span className="work-record-note-text">{item.content || "기록된 내용이 없습니다."}</span></button></span>
            <span data-label="물건" className="work-record-properties">
              {properties.length > 0 ? <>
                <span className="work-record-property-heading"><strong className="work-property-group-label" aria-label={`함께 기록한 물건 ${item.property_count}개`}>연결 매물 <span>{item.property_count}</span></strong></span>
                <span className="work-property-groups">
                  {groups.map((group) => <span className="work-property-building-group" key={group.key}>
                    {group.items[0].property.property_type.trim() !== "토지" && <strong className="work-property-building">{group.building || group.items[0].property.property_type || "물건 정보 미입력"}</strong>}
                    <ol className="work-property-list">
                      {group.items.map(({ property, index, shortLabel, sourceLabel }) => {
                        const matched = Number(item.search_property_match) === 1 && property.property_type === item.property_type && property.building_name === item.building_name && property.building_dong === item.building_dong && property.unit_number === item.unit_number;
                        const label = workPropertyLabel(property, true);
                        const prices = [["매매", property.sale_price], ["전세", property.jeonse_price], ["월세", property.monthly_rent]]
                          .filter(([, value]) => value.trim()).map(([kind, value]) => `${kind} ${value}`).join(" · ");
                        return <li key={property.id || index} className={matched ? "is-search-match" : undefined}>
                          {property.property_type.trim() && property.building_name.trim() && (property.property_type.trim() === "토지" || property.unit_number.trim()) ? <button type="button" className="work-cell-button history-link" onClick={() => onListingHistory({ ...item, ...property, id: item.id })} aria-label={`${label} 매물 이력 보기`}>
                            <span className="work-property-address">{`${shortLabel}${sourceLabel}`}</span>{matched && <span className="work-property-match" aria-label="검색 일치 물건" title="검색 일치 물건">일치</span>}
                          </button> : <span className="work-property-incomplete" aria-label={label}>{`${shortLabel}${sourceLabel}`}{matched && <span className="work-property-match" aria-label="검색 일치 물건">일치</span>}</span>}
                          {prices && <span className="work-property-price">{prices}</span>}
                        </li>;
                      })}
                    </ol>
                  </span>)}
                </span>
                {Number(item.property_count) > properties.length && <span className="work-record-legacy-note">전체 물건 정보는 내용 보기에서 확인하세요.</span>}
              </> : <span className="work-record-no-property">물건 없음</span>}
            </span>
          </div>
        </article>;
      })}
    </div>
  );
}
function ListReadFeedback({ status, error = "", onRetry, label = "목록" }: {
  status: JournalSearchStatus; error?: string; onRetry?: () => void; label?: string;
}) {
  if (status === "ready") return null;
  if (status === "refreshing") return <p className="workflow-refresh" role="status">{label}을 갱신하고 있습니다. 같은 조건의 이전 결과입니다.</p>;
  return <div className={`workflow-feedback${status === "error" ? " is-error" : ""}`} role={status === "error" ? "alert" : "status"}>
    <Icon name={status === "error" ? "warning" : "search"} size={24} />
    <strong>{status === "error" ? `${label}을 불러오지 못했습니다.` : `${label}을 불러오고 있습니다.`}</strong>
    <p>{status === "error" ? error || "연결 상태를 확인하고 다시 시도해 주세요." : "조회가 끝나면 현재 조건에 맞는 결과와 건수를 표시합니다."}</p>
    {status === "error" && <><small>조회 실패이며, 기록이 없다는 뜻은 아닙니다.</small><button className="secondary-button" type="button" onClick={onRetry}><Icon name="refresh" size={17} /> 다시 불러오기</button></>}
  </div>;
}
function ListingsView({
  items,
  total = items.length, loadingMore = false, moreError = "", onLoadMore, canLoadMore = false,
  lookups,
  query,
  setQuery,
  statuses,
  setStatuses,
  prices,
  setPrices,
  propertyType,
  setPropertyType,
  sort,
  setSort,
  onReset,
  onHistory,
  status = "ready", error = "", onRetry,
}: {
  items: Listing[];
  total?: number; hasMore?: boolean; loadingMore?: boolean; moreError?: string; onLoadMore?: () => Promise<number | undefined>; canLoadMore?: boolean;
  lookups: Lookups;
  query: string;
  setQuery: (v: string) => void;
  statuses: string[];
  setStatuses: (v: string[]) => void;
  prices: string[];
  setPrices: (v: string[]) => void;
  propertyType: string;
  setPropertyType: (v: string) => void;
  sort: string;
  setSort: (v: string) => void;
  onReset: () => void;
  onHistory: (item: Listing) => void;
  status?: JournalSearchStatus; error?: string; onRetry?: () => void;
}) {
  const resultsVisible = status === "ready" || status === "refreshing";
  const paging = useResultPage(items.length, total, JSON.stringify([query, statuses, prices, propertyType, sort]), 10);
  const listRef = useResultListRef(paging.page, JSON.stringify([query, statuses, prices, propertyType, sort]));
  const filtered = Boolean(
    query || statuses.length || propertyType || sort !== "type" || prices.length,
  );
  const dateSorted = ["recent", "updated", "oldest"].includes(sort);
  const sortDescription = ({
    type: "매물종류 가나다순 → 이름 → 동·호수",
    "type-desc": "매물종류 역순 → 이름 → 동·호수",
    building: "이름 가나다순 → 동·호수",
    "building-desc": "이름 역순 → 동·호수",
    recent: "최근 등록순",
    updated: "최근 변경순",
    oldest: "마지막 갱신이 오래된 순",
  } as Record<string, string>)[sort] ?? "매물종류 가나다순 → 이름 → 동·호수";
  const sortButton = (column: "type" | "building", label: string) => {
    const selected = sort === column || sort === `${column}-desc`;
    const descending = sort === `${column}-desc`;
    return <button
      type="button"
      className={`listing-sort-button${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${label} ${selected && !descending ? "역순" : "가나다순"}으로 정렬`}
      title={selected ? `현재 ${descending ? "역순" : "가나다순"} · 다시 누르면 반대 순서` : `${label}을 첫 번째 정렬 기준으로 변경`}
      onClick={() => setSort(sort === column ? `${column}-desc` : column)}
    >
      <span>{label}</span>
      {selected ? <span className="listing-sort-direction" aria-hidden="true">{descending ? "↓" : "↑"}</span> : <Icon name="sort" size={16} />}
    </button>;
  };
  return (
    <>
      <div className="renewal-paginated-list" ref={listRef}>
      <div className="listing-controls">
      <Toolbar
        query={query}
        setQuery={setQuery}
        placeholder="건물명, 동·호수, 메모 검색"
      >
        <details className="listing-status-filter" name="listing-filters">
          <summary>매물 상태: {statuses.length ? `${statuses.length}개 선택` : "전체"}</summary>
          <div className="listing-status-options" role="group" aria-label="매물 상태 필터">
            <button type="button" className="listing-status-all" aria-pressed={!statuses.length} onClick={() => setStatuses([])}>전체 상태</button>
            {[...new Set([...LISTING_WORK_TYPES, ...items.map(item => item.status)])].filter(Boolean).map(value => <label key={value}><input type="checkbox" checked={statuses.includes(value)} onChange={event => setStatuses(event.target.checked ? [...statuses, value] : statuses.filter(item => item !== value))} />{value}</label>)}
          </div>
        </details>
        <select
          aria-label="매물종류 필터"
          value={propertyType}
          onChange={(event) => setPropertyType(event.target.value)}
        >
          <option value="">모든 매물종류</option>
          {lookups.propertyTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <details className="listing-price-menu" name="listing-filters">
          <summary>가격: {prices.length ? `${prices.length}개 선택` : "전체"}</summary>
          <div className="listing-price-filters" role="group" aria-label="가격 입력 여부 필터">
            <button type="button" className="secondary-button" aria-pressed={!prices.length} onClick={() => setPrices([])}>전체 가격</button>
            {[["sale", "매매가 있음"], ["jeonse", "전세가 있음"], ["monthly", "월세가 있음"]].map(([value, label]) => <button key={value} type="button" className="secondary-button" aria-pressed={prices.includes(value)} onClick={() => setPrices(prices.includes(value) ? prices.filter(item => item !== value) : [...prices, value].sort())}>{label}</button>)}
            <span>선택한 가격 중 하나라도 있는 매물</span>
          </div>
        </details>
        <details className="listing-more-menu" name="listing-filters">
          <summary>정렬</summary>
          <div className="listing-more-options">
            <label htmlFor="listing-sort">정렬 기준</label>
            <select
              id="listing-sort"
              aria-label="매물 정렬"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="type">매물종류 → 이름순 (기본)</option>
              <option value="type-desc">매물종류 역순 → 이름순</option>
              <option value="building">이름 가나다순</option>
              <option value="building-desc">이름 역순</option>
              <option value="recent">최근 등록순</option>
              <option value="updated">최근 변경순</option>
              <option value="oldest">오래 미갱신순</option>
            </select>
          </div>
        </details>
      </Toolbar>
      </div>
      {filtered && <div className="active-filter-row listing-applied-filters" aria-label="현재 매물 조회 조건"><strong>적용 중</strong>{statuses.map(value => <span key={value}>{value}</span>)}{prices.map(price => <span key={price}>{({sale:"매매가 있음",jeonse:"전세가 있음",monthly:"월세가 있음"} as Record<string,string>)[price]}</span>)}{propertyType && <span>{propertyType}</span>}{query && <span>검색: {query}</span>}{sort !== "type" && <span>{sortDescription}</span>}<button className="filter-reset" onClick={onReset} type="button">초기화</button></div>}
      <section className="panel data-panel" aria-busy={status === "loading" || status === "refreshing"}>
        <div className="panel-head listing-panel-head">
          <h2>
            매물 목록 <span className="count-badge">{resultsVisible ? `${items.length < total ? `${items.length} / ` : ""}${total}건` : status === "error" ? "조회 실패" : "조회 중…"}</span>
          </h2>
          <p className="sort-summary">
              {sortDescription}
              {!statuses.length && dateSorted ? " · 진행 중 우선" : ""}
              {!dateSorted ? " · 동·호수는 숫자순" : ""}
          </p>
        </div>
        <div className="listing-mobile-sort" role="group" aria-label="매물 정렬 기준">
          {sortButton("type", "매물종류")}
          {sortButton("building", "이름")}
        </div>
        <ListReadFeedback status={status} error={error} onRetry={onRetry} label="매물 목록" />
        {resultsVisible && (!items.length ? (
          <EmptyState title="조건에 맞는 매물이 없습니다." />
        ) : (
          <div className="responsive-table listing-table">
            <div className="table-head">
              {sortButton("type", "매물종류")}
              {sortButton("building", "이름")}
              <span>상태</span>
              <span>가격</span>
              <span>등록·말소</span>
            </div>
            {items.slice(paging.start, paging.end).map((item) => (
              <button
                className={`table-row${item.status !== "매물등록" && item.status !== "매물수정" ? " is-other-status" : ""}`}
                key={item.id}
                onClick={() => onHistory(item)}
              >
                <span data-label="매물종류">
                  {item.property_type || "미지정"}
                  {item.size_type && <small>타입 {item.size_type}</small>}
                </span>
                <span data-label="이름">
                  <b>{targetText(item)}</b>
                </span>
                <span data-label="상태">
                  <i className={`tag ${statusTone(item.status)}`}>
                    {item.status}
                  </i>
                </span>
                <span data-label="가격">
                  <Price item={item} />
                </span>
                <span data-label="등록·말소">
                  <time className="record-date" dateTime={item.registered_at || undefined}>{displayDate(item.registered_at)}</time>
                  <small>
                    {item.closed_at
                      ? <time className="record-date" dateTime={item.closed_at}>말소 {displayDate(item.closed_at)}</time>
                      : "진행 중"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ))}
        {resultsVisible && moreError && <div className="workflow-feedback is-error" role="alert"><p>{moreError}</p><button type="button" className="secondary-button" onClick={onRetry}>최신 목록 다시 불러오기</button></div>}
      </section>
      </div>
      <ResultPagination paging={paging} total={resultsVisible ? total : 0} busy={status !== "ready" || loadingMore} onPrevious={paging.previous} onNext={() => { void paging.next(canLoadMore ? onLoadMore : undefined); }} />
    </>
  );
}
function Price({
  item,
}: {
  item: Pick<Listing, "sale_price" | "jeonse_price" | "monthly_rent">;
}) {
  const parts = [
    item.sale_price && `매매 ${item.sale_price}`,
    item.jeonse_price && `전세 ${item.jeonse_price}`,
    item.monthly_rent && `월세 ${item.monthly_rent}`,
  ].filter(Boolean);
  return (
    <>
      {parts.length
        ? parts.map((part) => (
            <small className="price-line" key={part as string}>
              {part}
            </small>
          ))
        : "-"}
    </>
  );
}
function CustomersView({
  items,
  total = items.length, hasMore = false, loadingMore = false, moreError = "", onLoadMore, canLoadMore = false,
  query,
  setQuery,
  sort,
  setSort,
  onReset,
  onEdit,
  onNew,
  onNewWork,
  onCopy,
  onHistory,
  status = "ready", error = "", onRetry,
}: {
  items: Customer[];
  total?: number; hasMore?: boolean; loadingMore?: boolean; moreError?: string; onLoadMore?: () => void; canLoadMore?: boolean;
  query: string;
  setQuery: (v: string) => void;
  sort: string;
  setSort: (v: string) => void;
  onReset: () => void;
  onEdit: (item: Customer) => void;
  onNew: () => void;
  onNewWork: (item: Customer) => void;
  onCopy: (value: string) => void;
  onHistory: (item: Customer) => void;
  status?: JournalSearchStatus; error?: string; onRetry?: () => void;
}) {
  const resultsVisible = status === "ready" || status === "refreshing";
  const filtered = Boolean(query || sort !== "recent");
  return (
    <>
      <Toolbar
        query={query}
        setQuery={setQuery}
        placeholder="고객명, 전화번호, 상담 메모 검색"
      >
        <select
          aria-label="고객 정렬"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="recent">최근 업무·등록순</option>
          <option value="name">이름순</option>
          <option value="history">이력 많은 순</option>
        </select>
        {filtered && (
          <button className="filter-reset" onClick={onReset} type="button">
            초기화
          </button>
        )}
        <button className="secondary-button" onClick={onNew} type="button">
          <Icon name="plus" size={18} /> 고객 등록
        </button>
      </Toolbar>
      {query && <div className="active-filter-row"><strong>{status === "loading" ? "조회 중" : "조회 조건"}</strong><span>검색: {query}</span></div>}
      <section className="panel data-panel" aria-busy={status === "loading" || status === "refreshing"}>
        <div className="panel-head">
          <div>
            <h2>
              고객 목록 <span className="count-badge">{resultsVisible ? `${items.length < total ? `${items.length} / ` : ""}${total}명` : status === "error" ? "조회 실패" : "조회 중…"}</span>
            </h2>
            <p className="sort-summary">
              {sort === "name"
                ? "이름 가나다순 · 같은 이름은 고객 ID순"
                : sort === "history"
                  ? "업무 이력 많은 순"
                  : "최근 업무·등록순 · 미래 예약은 제외"}
            </p>
          </div>
        </div>
        <ListReadFeedback status={status} error={error} onRetry={onRetry} label="고객 목록" />
        {resultsVisible && (!items.length ? (
          <EmptyState title="조건에 맞는 고객이 없습니다." />
        ) : (
          <div className="responsive-table customer-table">
            <div className="table-head">
              <span>고객명</span>
              <span>연락처 · 고객 ID</span>
              <span>비고</span>
              <span>최근 업무</span>
              <span>빠른 관리</span>
            </div>
            {items.map((item) => (
              <div className="table-row" key={item.id}>
                <button
                  className="customer-link"
                  data-label="고객명"
                  onClick={() => onHistory(item)}
                >
                  <b>{item.name}</b>
                  <small>전체 이력 보기</small>
                </button>
                <button
                  className="customer-id-copy"
                  data-label="고객 ID"
                  onClick={() => onCopy(item.id)}
                  title="고객 ID 복사"
                >
                  {item.id}
                  <small>
                    <Icon name="copy" size={13} /> 눌러서 복사
                  </small>
                </button>
                <span className="customer-notes" data-label="비고">{item.notes || "-"}</span>
                <span data-label="최근 업무">
                  <time className="record-date" dateTime={item.last_work_date || undefined}>{displayDate(item.last_work_date)}</time>
                  <small>이력 {item.history_count}건</small>
                </span>
                <span className="row-actions" data-label="빠른 관리">
                  <button
                    className="tiny-button accent"
                    onClick={() => onNewWork(item)}
                  >
                    <Icon name="plus" size={16} /> 업무 등록
                  </button>
                  <button className="tiny-button" onClick={() => onEdit(item)}>
                    <Icon name="edit" size={16} /> 수정
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
        {resultsVisible && moreError && <div className="workflow-feedback is-error" role="alert"><p>{moreError}</p><button type="button" className="secondary-button" onClick={onRetry}>최신 목록 다시 불러오기</button></div>}
        {resultsVisible && hasMore && <div className="load-more"><button type="button" disabled={!canLoadMore} onClick={onLoadMore}><Icon name={loadingMore ? "refresh" : "plus"} size={18} />{loadingMore ? "불러오는 중…" : "100건 더 보기"} <small>남은 {Math.max(0, total - items.length).toLocaleString("ko-KR")}명</small></button></div>}
      </section>
    </>
  );
}
function CalendarView({
  month,
  setMonth,
  workType,
  setWorkType,
  items,
  lookups,
  onOpen,
  status = "ready", error = "", onRetry,
}: {
  month: string;
  setMonth: (v: string) => void;
  workType: string;
  setWorkType: (v: string) => void;
  items: WorkSummary[];
  lookups: Lookups;
  onOpen: (id?: string) => void;
  onShowDay: (date: string, items: WorkSummary[]) => void;
  status?: JournalSearchStatus; error?: string; onRetry?: () => void;
}) {
  const resultsVisible = status === "ready" || status === "refreshing";
  const today = seoulDate();
  const { displayedMonth, cells, grouped, firstWeekday } = useMemo(() => {
    const displayedMonth = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : today.slice(0, 7);
    // ISO parsing avoids Date's special handling of numeric years below 100.
    const first = new Date(`${displayedMonth}-01T12:00:00Z`);
    const last = new Date(first);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    const count = last.getUTCDate();
    const grouped = items.reduce<Record<number, WorkSummary[]>>((acc, item) => {
      const day = Number(item.work_date.slice(8, 10));
      // A changed month must not briefly show the previous month's rows.
      if (!item.work_date.startsWith(`${displayedMonth}-`) || !Number.isInteger(day) || day < 1 || day > count) return acc;
      // Keep the selected work type honest while its replacement request is pending.
      if (workType && item.work_type !== workType) return acc;
      (acc[day] ||= []).push(item);
      return acc;
    }, {});
    return {
      displayedMonth,
      cells: [
        ...Array(first.getUTCDay()).fill(null),
        ...Array.from({ length: count }, (_, index) => index + 1),
      ],
      grouped,
      firstWeekday: first.getUTCDay(),
    };
  }, [month, items, today, workType]);
  const agendaDays = Object.keys(grouped).map(Number).sort((a, b) => a - b);
  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  function changeMonth(amount: number) {
    const date = new Date(`${displayedMonth}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + amount);
    const next = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(next)) setMonth(next);
  }
  return (
    <>
      <div className="calendar-controls">
        <button
          type="button"
          aria-label="이전 달"
          disabled={displayedMonth === "0001-01"}
          onClick={() => changeMonth(-1)}
        >
          <Icon name="back" size={18} />
        </button>
        <input
          aria-label="달력 월"
          type="month"
          min="0001-01"
          max="9999-12"
          value={displayedMonth}
          onChange={(event) => {
            if (/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonth(event.target.value);
          }}
        />
        <button
          type="button"
          aria-label="다음 달"
          disabled={displayedMonth === "9999-12"}
          onClick={() => changeMonth(1)}
        >
          <Icon name="next" size={18} />
        </button>
        <select
          aria-label="달력 업무구분 필터"
          value={workType}
          onChange={(event) => setWorkType(event.target.value)}
        >
          <option value="">모든 업무구분</option>
          {lookups.workTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <button className="calendar-today" type="button" onClick={() => setMonth(today.slice(0, 7))}>이번 달</button>
      </div>
      <ListReadFeedback status={status} error={error} onRetry={onRetry} label="달력 기록" />
      {resultsVisible && <>
      <p className="calendar-result-summary">{displayedMonth.replace("-", "년 ")}월 · {workType || "모든 업무구분"} · {Object.values(grouped).reduce((count, rows) => count + rows.length, 0)}건</p>
      <section className="panel calendar-panel calendar-desktop-panel" aria-label="월간 업무 달력">
        <div className="calendar-week">
          <span>일</span>
          <span>월</span>
          <span>화</span>
          <span>수</span>
          <span>목</span>
          <span>금</span>
          <span>토</span>
        </div>
        <div className="calendar-grid">
          {cells.map((day, index) => (
            <div
              className={`calendar-cell ${day === Number(today.slice(8, 10)) && displayedMonth === today.slice(0, 7) ? "today-cell" : ""}`}
              key={`${day}-${index}`}
            >
              {day && (
                <>
                  <b>{day}</b>
                  <div>
                    {(grouped[day] || []).map((item) => {
                      const presentation = calendarWorkPresentation(item);
                      return (
                      <button
                        type="button"
                        className={statusTone(item.work_type)}
                        onClick={() => onOpen(item.id)}
                        key={item.id}
                        aria-label={`${item.work_type} · ${presentation.entries.join(" · ")} 내용 보기`}
                      >
                        <span className="calendar-card-heading"><span>{item.work_type}</span>{presentation.properties.length > 1 && <span className="calendar-property-count">물건 {presentation.properties.length}개</span>}</span>
                        <CalendarSubjects item={item} />
                      </button>
                    );
                    })}

                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="panel calendar-agenda" aria-label="날짜별 업무 목록">
        {agendaDays.length === 0 ? (
          <p className="calendar-agenda-empty">
            {workType ? "선택한 달에 해당 업무구분의 기록이 없습니다." : "선택한 달에 등록된 업무가 없습니다."}
          </p>
        ) : agendaDays.map((day) => {
          const date = `${displayedMonth}-${String(day).padStart(2, "0")}`;
          const dayItems = grouped[day];
          return (
            <article className={`calendar-agenda-day${date === today ? " is-today" : ""}`} key={date}>
              <header className="calendar-agenda-day-head">
                <h2><time dateTime={date}>{Number(displayedMonth.slice(5))}월 {day}일 ({weekdays[(firstWeekday + day - 1) % 7]})</time>{date === today && <span>오늘</span>}</h2>
                <span>{dayItems.length}건</span>
              </header>
              <div className="calendar-agenda-events">
                {dayItems.map((item) => {
                  const presentation = calendarWorkPresentation(item);
                  return (
                    <button className="calendar-agenda-event" type="button" key={item.id} onClick={() => onOpen(item.id)}>
                      <span className="calendar-agenda-event-head"><span className={`tag ${statusTone(item.work_type)}`}>{item.work_type}</span><span className="calendar-agenda-open">내용 보기 <Icon name="next" size={16} /></span></span>
                      {presentation.properties.length > 1 && <span className="calendar-property-count">관련 물건 {presentation.properties.length}개</span>}
                      <CalendarSubjects item={item} />
                      {presentation.propertyFocused && item.customer_name && <small>고객 · {presentation.customerLabel}</small>}
                      {item.content && <span className="calendar-agenda-notes">{item.content}</span>}
                    </button>
                  );
                })}
              </div>

            </article>
          );
        })}
      </section>
      </>}
    </>
  );
}
function WorkModal({
  modal,
  customers,
  lookups,
  onNewCustomer,
  onEditCustomer,
  onClose,
  onSaved,
  onCopy,
  onDelete,
  onBusyChange,
}: {
  modal: WorkModalState;
  customers: Customer[];
  lookups: Lookups;
  onNewCustomer: (initialId: string) => void;
  onEditCustomer: (id: string) => void;
  onClose: () => void;
  onSaved: (message: string, copiedWork?: WorkDetail) => Promise<void>;
  onCopy: (item: WorkDetail) => void;
  onDelete: (id: string, unsavedDraft: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const source = modal.item;
  const item = modal.mode === "edit" ? source : undefined;
  const [workDate, setWorkDate] = useState(item?.work_date || seoulDate());
  const [customerId, setCustomerId] = useState(
    source?.customer_id || modal.initialCustomerId || "",
  );
  const [customerQuery, setCustomerQuery] = useState("");
  const [workType, setWorkType] = useState(
    source?.work_type || modal.initialWorkType || "",
  );
  const [content, setContent] = useState(source?.content || "");
  const [details, setDetails] = useState<PropertyDetail[]>(
    source?.details?.length
      ? source.details.map((detail) => ({
          propertyType: String(detail.property_type ?? ""),
          buildingName: String(detail.building_name ?? ""),
          buildingDong: String(detail.building_dong ?? ""),
          unitNumber: String(detail.unit_number ?? ""),
          sizeType: String(detail.size_type ?? ""),
          salePrice: String(detail.sale_price ?? ""),
          jeonsePrice: String(detail.jeonse_price ?? ""),
          monthlyRent: String(detail.monthly_rent ?? ""),
          source: String(detail.source ?? ""),
        }))
      : modal.initialListing ? [propertyFromListing(modal.initialListing)] : [blankProperty()],
  );
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);
  const savingMountedRef = useRef(true);
  const busyCallbackRef = useRef(onBusyChange);
  useEffect(() => { busyCallbackRef.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => {
    savingMountedRef.current = true;
    return () => { savingMountedRef.current = false; busyCallbackRef.current?.(false); };
  }, []);
  const [error, setError] = useState("");
  const [referenceHistory, setReferenceHistory] = useState<
    { kind: "customer"; id: string } | { kind: "listing"; index: number; key: string } | null
  >(null);
  const historyTrigger = useRef<HTMLButtonElement | null>(null);
  const [listingPickerIndex, setListingPickerIndex] = useState<number | null>(null);
  const [listingLoadedMessage, setListingLoadedMessage] = useState("");
  const listingPickerTrigger = useRef<HTMLButtonElement | null>(null);
  const workFormRef = useRef<HTMLFormElement | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const changesListing = LISTING_WORK_TYPES.has(workType);
  const enteredPropertyCount = details.filter(hasPropertyDraft).length;
  useEffect(() => {
    if (!error) return;
    if (errorField) {
      const field = workFormRef.current?.querySelector<HTMLElement>(`[data-work-field="${errorField}"]`);
      const input = field?.matches("input, select") ? field : field?.querySelector<HTMLElement>("input, select");
      input?.focus();
      input?.scrollIntoView({ block: "center" });
    } else {
      errorSummaryRef.current?.focus();
      errorSummaryRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [error, errorField]);
  function closeReferenceHistory() {
    setReferenceHistory(null);
    historyTrigger.current?.focus();
  }
  function closeListingPicker() {
    setListingPickerIndex(null);
    listingPickerTrigger.current?.focus();
  }
  function applyExistingListing(listing: ListingDraftSource) {
    if (listingPickerIndex === null || saving || !details[listingPickerIndex]) return;
    if (
      hasPropertyDraft(details[listingPickerIndex]) &&
      !window.confirm("이 물건에 입력한 내용이 있습니다. 선택한 기존 매물 정보로 바꿀까요? 고객·상담 내용은 유지됩니다.")
    ) return;
    const next = propertyFromListing(listing);
    setDetails((current) => current.map((detail, index) => index === listingPickerIndex ? next : detail));
    setReferenceHistory(null);
    setListingLoadedMessage(`물건 ${listingPickerIndex + 1}에 기존 매물 정보를 불러왔습니다. 주소와 가격을 확인한 뒤 업무를 저장해 주세요.`);
    closeListingPicker();
  }
  const [initialValues] = useState(() =>
    JSON.stringify({ workDate, customerId, workType, content, details }),
  );
  const dirty =
    JSON.stringify({ workDate, customerId, workType, content, details }) !==
    initialValues;
  useEffect(() => {
    if (!modal.initialCustomerId) return;
    const timer = window.setTimeout(
      () => setCustomerId(modal.initialCustomerId!),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [modal.initialCustomerId]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);
  function requestClose() {
    if (saving) return;
    if (
      dirty &&
      !window.confirm("작성 중인 내용이 있습니다. 저장하지 않고 닫을까요?")
    )
      return;
    onClose();
  }
  function updateDetail(
    index: number,
    key: keyof PropertyDetail,
    value: string,
  ) {
    if (errorField === `property-${index}-${key}`) {
      setErrorField(null);
      setError("");
    }
    if (["propertyType", "buildingName", "buildingDong", "unitNumber"].includes(key)) {
      setReferenceHistory((current) => current?.kind === "listing" && current.index === index ? null : current);
    }
    setDetails((current) =>
      current.map((detail, detailIndex) =>
        detailIndex === index ? { ...detail, [key]: value } : detail,
      ),
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || savePendingRef.current) return;
    const issue = findWorkDraftIssue({ workDate, customerId, workType, details }, customers, lookups.workTypes);
    if (issue) {
      setErrorField(issue.field);
      setError(issue.message);
      return;
    }
    savePendingRef.current = true;
    setSaving(true);
    setError("");
    setErrorField(null);
    onBusyChange?.(true);
    try {
      const url = item ? `/api/work-logs/${item.id}` : "/api/work-logs";
      const result = await jsonFetch<{ workLog?: WorkDetail }>(url, {
        method: item ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workDate,
          customerId,
          workType,
          content,
          details,
          ...(item ? { revision: item.revision } : {}),
        }),
      });
      await onSaved(item ? "업무를 수정했습니다." : modal.mode === "copy" ? "업무를 복사해 새 업무로 저장했습니다." : "업무를 저장했습니다.", modal.mode === "copy" ? result.workLog : undefined);
    } catch (e) {
      setError(item && (e as Error & { status?: number }).status === 409
        ? "다른 기기에서 이 업무가 변경되어 저장하지 않았습니다. 작성한 내용을 복사해 둔 뒤 창을 닫고 최신 업무를 다시 열어 확인해 주세요."
        : (e as Error).message);
    } finally {
      savePendingRef.current = false;
      setSaving(false);
      if (savingMountedRef.current) onBusyChange?.(false);
    }
  }
  function remove() {
    if (!saving && item) onDelete(item.id, dirty);
  }
  return (
    <Modal
      title={
        item
          ? "업무 수정"
          : modal.mode === "copy"
            ? "업무 복사 · 새 업무 등록"
            : modal.initialListing && modal.initialWorkType === "매물수정" ? "매물 수정 이력 추가" : "새 업무 등록"
      }
      onClose={requestClose}
      locked={saving}
      wide
    >
      <form ref={workFormRef} className="work-form" onSubmit={submit} noValidate>
        {error && <div ref={errorSummaryRef} className="form-error work-form-error" role="alert" tabIndex={-1}><p>{error}</p></div>}
        {modal.mode === "copy" && (
          <div className="work-copy-context" role="note">
            <strong>복사한 내용으로 새 업무를 등록합니다.</strong>
            {source && <span>원본 · {displayDate(source.work_date)} · {source.work_type} · {source.customer_name}{source.customer_id && ` · ${source.customer_id}`}</span>}
            <p>원본은 바뀌지 않습니다. 업무일은 오늘로 설정했으며, 고객·업무구분·내용·매물과 가격은 복사한 기록 기준입니다. 필요한 항목을 수정한 뒤 새 업무로 저장해 주세요.</p>
          </div>
        )}
        {modal.initialListing && modal.initialWorkType === "매물수정" && <p className="editor-context">기존 기록을 덮어쓰지 않고 새 매물 수정 업무를 추가합니다. 날짜는 오늘, 고객은 최근 이력 기준이므로 실제 업무에 맞는지 확인해 주세요. 현재 매물 정보는 업무일이 가장 최근인 이력으로 표시됩니다.</p>}
        <div className="form-grid three">
          <label>
            일자 <b className="required-mark" aria-hidden="true">*</b>
            <input
              type="date"
              data-work-field="workDate"
              aria-invalid={errorField === "workDate" || undefined}
              value={workDate}
              disabled={saving}
              onChange={(event) => { setWorkDate(event.target.value); if (errorField === "workDate") { setErrorField(null); setError(""); } }}
              required
            />
          </label>
          <div className="field-with-action" data-work-field="customerId">
            <div className="field-label">
              <span>
                고객 <b className="required-mark" aria-hidden="true">*</b>
              </span>
              <button type="button" onClick={() => onNewCustomer(customerQuery.trim())} disabled={saving}>
                <Icon name="plus" size={16} /> 새 고객
              </button>
            </div>
            <CustomerPicker
              customers={customers}
              value={customerId}
              onQueryChange={setCustomerQuery}
              onChange={(id) => { setCustomerId(id); setReferenceHistory(null); if (errorField === "customerId") { setErrorField(null); setError(""); } }}
              disabled={saving}
            />
            <button
              type="button"
              className="editor-history-button"
              disabled={saving || !selectedCustomer}
              aria-expanded={referenceHistory?.kind === "customer" && referenceHistory.id === customerId}
              aria-controls="editor-customer-history"
              onClick={(event) => {
                setListingPickerIndex(null);
                historyTrigger.current = event.currentTarget;
                setReferenceHistory((current) => current?.kind === "customer" && current.id === customerId ? null : { kind: "customer", id: customerId });
              }}
            >
              <Icon name="clock" size={17} /> 고객 이력 보기
            </button>
            {selectedCustomer && <button type="button" className="editor-history-button" disabled={saving} onClick={() => onEditCustomer(selectedCustomer.id)}><Icon name="edit" size={17} /> 고객 정보 수정</button>}
          </div>
          <label>
            업무구분 <b className="required-mark" aria-hidden="true">*</b>
            <select
              data-work-field="workType"
              aria-invalid={errorField === "workType" || undefined}
              value={workType}
              disabled={saving}
              onChange={(event) => { setWorkType(event.target.value); setErrorField(null); setError(""); }}
              required
            >
              <option value="">선택</option>
              {lookups.workTypes.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
        </div>
        {selectedCustomer && referenceHistory?.kind === "customer" && referenceHistory.id === customerId && (
          <div id="editor-customer-history">
            <Suspense fallback={<p className="form-help" role="status">고객 이력을 준비하고 있습니다…</p>}>
              <RelatedHistory target={{ kind: "customer", id: selectedCustomer.id, name: selectedCustomer.name }} workTypes={lookups.workTypes} currentWorkId={item?.id} onClose={closeReferenceHistory} />
            </Suspense>
          </div>
        )}
        <label className="full-label">
          내용 <span className="form-help">선택</span>
          <textarea
            value={content}
            disabled={saving}
            onChange={(event) => setContent(event.target.value)}
            rows={Math.min(10, Math.max(3, content.split("\n").length))}
            placeholder="상담 내용, 일정, 특이사항을 입력하세요"
          />
        </label>
        <div className="detail-head">
          <div>
            <h3>관련 물건 <small>{changesListing ? "필수" : "선택"} · {details.length}/10</small></h3>
            <p>{changesListing ? "기존 매물을 불러오거나 주소를 입력하세요. 토지 외 물건은 건물명과 호수가 필요합니다." : "기존 매물을 불러오거나 직접 입력하세요. 물건이 없는 업무는 비워 두어도 됩니다."}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={saving || details.length >= 10}
            onClick={() =>
              setDetails((current) => [...current, blankProperty()])
            }
          >
            <Icon name="housePlus" size={18} /> 물건 추가
          </button>
        </div>
        {changesListing && <p className="listing-rule-notice"><strong>{workType}</strong> 저장 시 매물 상태와 이력도 함께 반영됩니다.</p>}
        <div className="detail-list">
          {listingLoadedMessage && <p className="listing-loaded-message" role="status"><Icon name="check" size={18} />{listingLoadedMessage}</p>}
          {details.map((detail, index) => (
            <fieldset key={index} disabled={saving}>
              <legend>물건 {index + 1}</legend>
              <div className="detail-history-tools">
                <button
                  type="button"
                  className="editor-history-button"
                  aria-expanded={listingPickerIndex === index}
                  aria-controls={`editor-listing-picker-${index}`}
                  onClick={(event) => {
                    listingPickerTrigger.current = event.currentTarget;
                    setListingLoadedMessage("");
                    setReferenceHistory(null);
                    setListingPickerIndex((current) => current === index ? null : index);
                  }}
                >
                  <Icon name="search" size={17} /> 기존 매물 불러오기
                </button>
                <button
                  type="button"
                  className="editor-history-button"
                  disabled={!createPropertyHistoryTarget(detail)}
                  aria-expanded={referenceHistory?.kind === "listing" && referenceHistory.index === index}
                  aria-controls={`editor-listing-history-${index}`}
                  onClick={(event) => {
                    const target = createPropertyHistoryTarget(detail);
                    if (target?.kind !== "listing") return;
                    setListingPickerIndex(null);
                    historyTrigger.current = event.currentTarget;
                    setReferenceHistory((current) => current?.kind === "listing" && current.index === index ? null : { kind: "listing", index, key: target.key });
                  }}
                >
                  <Icon name="clock" size={17} /> 매물 이력 보기
                </button>
              </div>
              {listingPickerIndex === index && (
                <div id={`editor-listing-picker-${index}`}>
                  <Suspense fallback={<p className="form-help" role="status">기존 매물 검색을 준비하고 있습니다…</p>}>
                    <ListingPicker onSelect={applyExistingListing} onClose={closeListingPicker} />
                  </Suspense>
                </div>
              )}
              {referenceHistory?.kind === "listing" && referenceHistory.index === index && (() => {
                const target = createPropertyHistoryTarget(detail);
                return target?.kind === "listing" && target.key === referenceHistory.key ? (
                  <div id={`editor-listing-history-${index}`}>
                    <Suspense fallback={<p className="form-help" role="status">매물 이력을 준비하고 있습니다…</p>}>
                      <RelatedHistory target={target} workTypes={lookups.workTypes} currentWorkId={item?.id} onClose={closeReferenceHistory} />
                    </Suspense>
                  </div>
                ) : null;
              })()}
              <div className={`detail-fields${detail.propertyType === "토지" ? " is-land" : ""}`}>
                <label>
                  물건구분 {changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0)) && <b className="required-mark" aria-hidden="true">*</b>}
                  <select
                    data-work-field={`property-${index}-propertyType`}
                    aria-invalid={errorField === `property-${index}-propertyType` || undefined}
                    aria-required={changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0))}
                    value={detail.propertyType}
                    onChange={(event) =>
                      updateDetail(index, "propertyType", event.target.value)
                    }
                  >
                    <option value="">선택</option>
                    {lookups.propertyTypes.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label className="building-field">
                  {detail.propertyType === "토지" ? "주소 전체" : "건물명"} {changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0)) && <b className="required-mark" aria-hidden="true">*</b>}
                  <input
                    data-work-field={`property-${index}-buildingName`}
                    aria-invalid={errorField === `property-${index}-buildingName` || undefined}
                    aria-required={changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0))}
                    list={detail.propertyType === "토지" ? undefined : `buildings-${index}`}
                    value={detail.propertyType === "토지" && (detail.buildingDong || detail.unitNumber)
                      ? workPropertyLabel({ building_name: detail.buildingName, building_dong: detail.buildingDong, unit_number: detail.unitNumber })
                      : detail.buildingName}
                    placeholder={detail.propertyType === "토지" ? "주소를 전체 입력하세요" : undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (detail.propertyType === "토지" && (detail.buildingDong || detail.unitNumber)) {
                        setReferenceHistory(null);
                        setDetails((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, buildingName: value, buildingDong: "", unitNumber: "" } : row));
                        if (errorField === `property-${index}-buildingName`) { setErrorField(null); setError(""); }
                      } else updateDetail(index, "buildingName", value);
                    }}
                  />
                  <datalist id={`buildings-${index}`}>
                    {lookups.buildings
                      .filter(
                        (building) =>
                          !detail.propertyType ||
                          building.property_type === detail.propertyType,
                      )
                      .map((building) => (
                        <option
                          value={building.building_name}
                          key={building.id}
                        />
                      ))}
                  </datalist>
                </label>
                {detail.propertyType !== "토지" && <label>
                  동
                  <input
                    value={detail.buildingDong}
                    placeholder="예: 106"
                    onChange={(event) =>
                      updateDetail(index, "buildingDong", event.target.value)
                    }
                  />
                </label>}
                {detail.propertyType !== "토지" && <label>
                  호수 {changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0)) && <b className="required-mark" aria-hidden="true">*</b>}
                  <input
                    data-work-field={`property-${index}-unitNumber`}
                    aria-invalid={errorField === `property-${index}-unitNumber` || undefined}
                    aria-required={changesListing && (hasPropertyDraft(detail) || (!enteredPropertyCount && index === 0))}
                    value={detail.unitNumber}
                    placeholder="예: 1503"
                    onChange={(event) =>
                      updateDetail(index, "unitNumber", event.target.value)
                    }
                  />
                </label>}
                <label>
                  타입
                  <input
                    value={detail.sizeType}
                    onChange={(event) =>
                      updateDetail(index, "sizeType", event.target.value)
                    }
                    placeholder="33 / 51A"
                  />
                </label>
              </div>
              <div className="detail-price-fields">
                <label>
                  매매가
                  <input
                    value={detail.salePrice}
                    onChange={(event) =>
                      updateDetail(index, "salePrice", event.target.value)
                    }
                  />
                </label>
                <label>
                  전세가
                  <input
                    value={detail.jeonsePrice}
                    onChange={(event) =>
                      updateDetail(index, "jeonsePrice", event.target.value)
                    }
                  />
                </label>
                <label>
                  월세가
                  <input
                    value={detail.monthlyRent}
                    onChange={(event) =>
                      updateDetail(index, "monthlyRent", event.target.value)
                    }
                  />
                </label>
              </div>
              <div className="detail-source-fields">
                <label className="source-field">
                  물건지·업소
                  <input
                    value={detail.source}
                    onChange={(event) =>
                      updateDetail(index, "source", event.target.value)
                    }
                  />
                </label>
              </div>
              {details.length > 1 && (
                <button
                  type="button"
                  className="remove-detail"
                  onClick={() => {
                    if (hasPropertyDraft(detail) && !window.confirm(`물건 ${index + 1}에 입력한 내용을 빼시겠습니까? 다른 물건과 상담 내용은 유지됩니다.`)) return;
                    setReferenceHistory(null);
                    setListingPickerIndex(null);
                    setListingLoadedMessage("");
                    setError("");
                    setErrorField(null);
                    setDetails((current) =>
                      current.filter((_, detailIndex) => detailIndex !== index),
                    );
                  }}
                >
                  이 물건 빼기
                </button>
              )}
            </fieldset>
          ))}
        </div>
        {item && <div className="work-record-actions">
          {item && (
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => {
                if (
                  dirty &&
                  !window.confirm(
                    "저장하지 않은 수정 내용은 복사에 포함되지 않습니다. 기존 기록으로 새 업무를 만들까요?",
                  )
                )
                  return;
                onCopy(item);
              }}
            >
              <Icon name="copy" size={18} /> 업무 복사
            </button>
          )}
          {item && (
            <button
              type="button"
              className="danger-button"
              onClick={remove}
              disabled={saving}
            >
              <Icon name="delete" size={18} /> 업무 삭제
            </button>
          )}
        </div>}
        <div className="modal-actions">
          <span className="work-save-state">{saving ? "저장하고 있습니다…" : dirty ? "아직 저장하지 않은 내용이 있습니다." : item ? "저장된 업무를 확인하고 있습니다." : "입력한 내용은 저장 버튼을 눌러야 반영됩니다."}</span>
          <button
            type="button"
            className="secondary-button"
            onClick={requestClose}
            disabled={saving}
          >
            취소
          </button>
          <button className="primary-button" disabled={saving}>
            <Icon name="save" size={18} />
            {saving ? "저장 중…" : item ? "수정 저장" : modal.mode === "copy" ? "새 업무로 저장" : "업무 저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CustomerModal({
  modal,
  onClose,
  onSaved,
  onDelete,
  onBusyChange,
}: {
  modal: { mode: "new" | "edit"; item?: Customer; initialId?: string };
  onClose: () => void;
  onSaved: (message: string, customerId?: string, savedCustomer?: Customer) => Promise<void>;
  onDelete: (id: string, unsavedDraft: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [id, setId] = useState(modal.item?.id || modal.initialId || "");
  const [name, setName] = useState(modal.item?.name || "");
  const [notes, setNotes] = useState(modal.item?.notes || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingMountedRef = useRef(true);
  const busyCallbackRef = useRef(onBusyChange);
  useEffect(() => { busyCallbackRef.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => {
    savingMountedRef.current = true;
    return () => { savingMountedRef.current = false; busyCallbackRef.current?.(false); };
  }, []);
  const [initialDraft] = useState(() => ({ id, name, notes }));
  const currentDraft = { id, name, notes };
  const dirty = customerDraftChanged(initialDraft, currentDraft);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);
  function requestClose() {
    if (
      !canCloseCustomerDraft(initialDraft, currentDraft, saving, () =>
        window.confirm("작성 중인 고객 정보가 있습니다. 저장하지 않고 닫을까요?"),
      )
    )
      return;
    onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      onBusyChange?.(true);
      const response = await jsonFetch<{ customer?: Customer }>(
        modal.item
          ? `/api/customers/${encodeURIComponent(modal.item.id)}`
          : "/api/customers",
        {
          method: modal.item ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name, notes, ...(modal.item ? { expected: {
            name: modal.item.name, notes: modal.item.notes, created_at: modal.item.created_at,
            updated_at: modal.item.updated_at, is_demo: modal.item.is_demo,
          } } : {}) }),
        },
      );
      await onSaved(
        modal.item ? "고객 정보를 수정했습니다." : "고객을 등록했습니다.",
        modal.item ? undefined : response.customer?.id ?? id.trim(),
        response.customer ? {
          ...modal.item,
          ...response.customer,
          created_at: response.customer.created_at || "",
          updated_at: response.customer.updated_at || "",
          history_count: modal.item?.history_count || 0,
          is_demo: response.customer.is_demo ?? 0,
        } : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      if (savingMountedRef.current) onBusyChange?.(false);
    }
  }
  function remove() {
    if (!saving && modal.item) onDelete(modal.item.id, dirty);
  }
  return (
    <Modal
      title={modal.item ? "고객 정보 수정" : "새 고객 등록"}
      onClose={requestClose}
      locked={saving}
    >
      <form className="customer-form" onSubmit={submit}>
        <label>
          고객 ID <b className="required-mark" aria-hidden="true">*</b>
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            disabled={Boolean(modal.item) || saving}
            placeholder="전화번호 또는 구분할 수 있는 ID"
            required
          />
        </label>
        <label>
          고객명 <b className="required-mark" aria-hidden="true">*</b>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
            required
          />
        </label>
        <label>
          비고
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            disabled={saving}
            rows={5}
            placeholder="찾는 물건, 입주일, 상담 메모"
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          {modal.item && (
            <button
              type="button"
              className="danger-button"
              onClick={remove}
              disabled={saving}
            >
              <Icon name="delete" size={18} /> 고객 삭제
            </button>
          )}
          <span />
          <button
            type="button"
            className="secondary-button"
            onClick={requestClose}
            disabled={saving}
          >
            취소
          </button>
          <button className="primary-button" disabled={saving}>
            <Icon name="save" size={18} />
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function HistoryModal({
  data,
  workTypes = [],
  onWorkTypeChange,
  onClose,
  onRefresh,
  onOpenWork,
  onNewWork,
  onEditCustomer,
  onNewListingWork,
  onModifyListing,
  onFollowUp,
  onCopy,
  onStructure,
  page = false,
}: {
  page?: boolean;
  data: HistoryData;
  workTypes?: string[];
  onWorkTypeChange: (value: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onOpenWork: (id: string) => void;
  onNewWork: (id: string) => void;
  onEditCustomer?: (id: string) => void;
  onNewListingWork?: (listing: Listing) => void;
  onModifyListing?: (listing: Listing, customerId?: string) => void;
  onFollowUp: (draft: FollowUpDraft) => void;
  onCopy: (id: string) => void;
  onStructure?: (key: string) => void;
}) {
  const RecordContainer = data.listing ? "details" : "div";
  const isListingHistory = Boolean(data.listing || data.listingKey);
  const allRecords = isListingHistory ? data.workItems ?? data.items : data.items;
  const filterable = Boolean(data.customer || data.listing || data.listingKey);
  const selectedType = filterable ? data.historyWorkType ?? "" : "";
  const records = selectedType ? allRecords.filter((record) => ("event_date" in record ? record.status : record.work_type) === selectedType) : allRecords;
  const availableTypes = [...workTypes, ...allRecords.map((record) => "event_date" in record ? record.status : record.work_type)];
  const structureAction = (isListingHistory && onStructure && <div className="history-actions"><button type="button" className="secondary-button" onClick={() => onStructure(data.listing?.identity_key || data.listingKey || "")}><Icon name="structures" size={18}/> 집 구조 보기</button></div>);
  const loadingNote = (data.loading && <p className="form-help" role="status">이력을 불러오고 있습니다…</p>);
  const errorNote = (data.error && <div className="form-error" role="alert"><p>{data.error}</p>{(data.customer || data.listing || data.listingKey || data.date || data.scheduleDays) && <button type="button" className="secondary-button" onClick={onRefresh}><Icon name="refresh" size={16} /> 다시 불러오기</button>}</div>);
  const typeFilter = (filterable && <HistoryWorkTypeFilter value={selectedType} workTypes={availableTypes} count={data.error || (!selectedType && !allRecords.length && data.listing?.source_notes?.trim()) ? undefined : records.length} loading={data.loading} onChange={onWorkTypeChange} />);
  const customerActions = (data.customer && (
        <div className="history-actions">
          {onEditCustomer && <button type="button" className="secondary-button" onClick={() => onEditCustomer(data.customer!.id)}><Icon name="edit" size={18} /> 고객 정보 수정</button>}
          <button
            type="button"
            className="primary-button"
            onClick={() => onNewWork(data.customer!.id)}
          >
            <Icon name="plus" size={18} /> 이 고객 업무 등록
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onCopy(data.customer!.id)}
          >
            <Icon name="copy" size={18} /> 연락처·ID 복사
          </button>
        </div>
      ));
  const listingSummary = (data.listing && (
        <>
        <div className="listing-history-context">
          <p className="listing-history-summary">
            현재 매물 · <strong>{data.listing.status}</strong> ·{" "}
            {[
              data.listing.sale_price && `매매 ${data.listing.sale_price}`,
              data.listing.jeonse_price && `전세 ${data.listing.jeonse_price}`,
              data.listing.monthly_rent && `월세 ${data.listing.monthly_rent}`,
            ]
              .filter(Boolean)
              .join(" / ") || "가격 미기재"}
          </p>
          {!selectedType && <ListingHistorySummary
            events={data.items.filter((item): item is ListingEvent => "event_date" in item)}
            sourceNotes={data.listing.source_notes}
          />}
          {selectedType && <p className="history-list-guide">선택한 업무구분만 표시합니다. 현재 매물 상태·가격은 전체 이력 기준이며, 업무구분을 확인할 수 없는 원본 메모는 전체 보기에서 확인할 수 있습니다.</p>}
        </div>
        <div className="listing-history-actions">
          {onModifyListing && !data.listing.closed_at && (
            <button type="button" className="primary-button" disabled={Boolean(data.loading || data.error)}
              onClick={() => onModifyListing(data.listing!, data.items.find((item) => "event_date" in item && item.customer_id)?.customer_id)}>
              <Icon name="edit" size={18} /> 매물 수정 이력 추가
            </button>
          )}
          {onNewListingWork && (
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(data.loading || data.error)}
              onClick={() => onNewListingWork(data.listing!)}
            >
              <Icon name="plus" size={18} /> 이 매물로 업무 등록
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              onFollowUp({
                title: `${targetText(data.listing!)} 매물 확인`,
                listingKey: data.listing!.identity_key,
                listingLabel: targetText(data.listing!),
              })
            }
          >
            <Icon name="tasks" size={18} /> 이 매물 확인할 일 추가
          </button>
        </div>
        </>
      ));
  const customerGuide = (data.customer && <p className="history-list-guide">고객ID 또는 물건지·업소가 고객ID와 일치하는 업무입니다.</p>);
  const listingGuide = (isListingHistory && !data.listing && allRecords.length > 0 && !data.loading && !data.error && <p className="history-list-guide">매물 변경 이력은 없으며, 이 매물이 포함된 업무 기록을 보여드립니다.</p>);
  const recordList = ((!data.listing || records.length > 0 || selectedType) && <RecordContainer className={data.listing ? "listing-work-details" : undefined} open={data.listing && (page || selectedType) ? true : undefined}>
      {data.listing && <summary><Icon name="next" size={16} /> 개별 업무 보기 <span>{records.length.toLocaleString("ko-KR")}건</span></summary>}
      {records.length > 0 && <p className="history-list-guide">{records.length.toLocaleString("ko-KR")}건의 기록 · {selectedType ? `${selectedType} · ` : isListingHistory ? "이 매물이 포함된 전체 업무 · " : ""}기록을 누르면 업무 내용을 먼저 읽을 수 있습니다.</p>}
      <div className="history-list" data-schedule-days={data.scheduleDays} aria-busy={Boolean(data.loading)}>
        {!records.length ? (
          !data.loading && !data.error ? <EmptyState title={data.emptyMessage || (selectedType ? `${selectedType} 업무 이력이 없습니다. 다른 업무구분을 선택하거나 전체 보기를 눌러 주세요.` : "기록이 없습니다.")} /> : null
        ) : (
          records.map((raw) => {
            const isEvent = "event_date" in raw;
            const date = isEvent ? raw.event_date : raw.work_date;
            const status = isEvent ? raw.status : raw.work_type;
            const content = isEvent ? raw.notes : raw.content;
            const savedLabel = isEvent
              ? formatHistoryTimestamp(raw.work_updated_at) || formatHistoryTimestamp(raw.created_at)
              : formatHistoryTimestamp(raw.updated_at);
            const id = isEvent ? raw.work_log_id : raw.id;
            const property = !isEvent && getWorkProperties(raw).length > 0;
            return (
              <button
                type="button"
                key={raw.id}
                onClick={() => id && onOpenWork(id)}
                disabled={!id}
              >
                <div className="history-entry-meta">
                  <span className={`history-mark ${statusTone(status)}`} />
                  <time dateTime={date}>업무일 {displayDate(date)}</time>
                  <strong>{status}</strong>
                  {isEvent && <small>{raw.customer_name}{raw.customer_id && ` · ${raw.customer_id}`}</small>}
                  <span className="history-entry-open">{id ? <>내용 보기 <Icon name="next" size={15} /></> : "원본 이력"}</span>
                </div>
                {savedLabel && <p className="history-entry-saved">최근 저장 · <time>{savedLabel}</time></p>}
                {!isEvent && (raw.customer_name || property) && (
                  <div className="history-entry-context">
                    {(raw.customer_name || raw.customer_id) && <span><Icon name="customers" size={16} /><span>고객 · {raw.customer_name}{raw.customer_id && ` · ${raw.customer_id}`}</span></span>}
                    {property && <WorkSummaryProperties work={raw} showSingle />}
                  </div>
                )}
                <p className="history-entry-content">{content || "기록된 내용 없음"}</p>
              </button>
            );
          })
        )}
      </div>
      </RecordContainer>);
  if (page) {
    const latest = allRecords.reduce((value, record) => { const date = "event_date" in record ? record.event_date : record.work_date; return date > value ? date : value; }, "");
    return (
      <div className="record-page">
        <section className="record-page-summary" aria-label="기본 정보">
          <dl className="record-page-facts">
            {data.customer && <div><dt>고객 ID</dt><dd>{data.customer.id}</dd></div>}
            {data.customer && <div className="customer-history-notes-row"><dt>비고</dt><dd className="customer-history-notes">{data.customerNotesError || (data.customer.notes === undefined ? "확인 중…" : data.customer.notes || "미기재")}</dd></div>}
            {isListingHistory && <div><dt>물건 구분</dt><dd>{data.listing?.property_type || data.subtitle}</dd></div>}
            <div><dt>업무 기록</dt><dd>{data.loading && !allRecords.length ? "…" : `${allRecords.length.toLocaleString("ko-KR")}건`}</dd></div>
            {latest && <div><dt>최근 업무</dt><dd>{displayDate(latest)}</dd></div>}
          </dl>
          {customerActions}
          {listingSummary}
          {structureAction}
        </section>
        <section className="panel record-page-history">
          <div className="panel-head"><h2>업무 이력</h2>{typeFilter}</div>
          {loadingNote}
          {errorNote}
          <div className="record-page-history-body">
            {customerGuide}
            {listingGuide}
            {recordList}
          </div>
        </section>
      </div>
    );
  }
  return (
    <Modal title={data.title} subtitle={data.subtitle} onClose={onClose} reading>
      {structureAction}
      {loadingNote}
      {errorNote}
      {typeFilter}
      {customerActions}
      {listingSummary}
      {customerGuide}
      {listingGuide}
      {recordList}
    </Modal>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  wide,
  reading,
  locked = false,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  reading?: boolean;
  locked?: boolean;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [modalId] = useState(() => ++nextModalId);
  // On wide screens, reading opens beside the list instead of over it, so the list stays usable.
  const wideScreen = useWideScreen();
  const side = Boolean(reading) && wideScreen;
  const sideRef = useRef(side);
  useEffect(() => {
    sideRef.current = side;
  }, [side]);
  const closeRef = useRef(onClose);
  const lockedRef = useRef(locked);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  useEffect(() => {
    if (openModalIds.length === 0)
      modalBodyOverflow = document.body.style.overflow;
    openModalIds.push(modalId);
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!sideRef.current) document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const preferred = cardRef.current?.querySelector<HTMLElement>(
        "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
      );
      (preferred || cardRef.current)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (openModalIds.at(-1) !== modalId) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (!lockedRef.current) {
          event.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (event.key !== "Tab" || !cardRef.current || sideRef.current) return;
      const focusable = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        cardRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!sideRef.current || lockedRef.current || openModalIds.at(-1) !== modalId) return;
      const target = event.target;
      if (!(target instanceof Node) || cardRef.current?.contains(target)) return;
      // A nested dialog owns its interaction; the reading panel only closes on the page.
      if (target instanceof Element && target.closest('dialog, [role="dialog"], [role="alertdialog"], .modal-backdrop')) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => {
      const index = openModalIds.lastIndexOf(modalId);
      if (index >= 0) openModalIds.splice(index, 1);
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handleOutsidePointer);
      if (openModalIds.length === 0)
        document.body.style.overflow = modalBodyOverflow;
      previousFocus?.focus();
    };
  }, [modalId]);
  const card = (
    <section
      ref={cardRef}
      className={side ? "modal-card reading side-panel" : `modal-card ${wide ? "wide" : ""} ${reading ? "reading" : ""}`}
      role="dialog"
      aria-modal={!side}
      aria-label={title}
      aria-busy={locked}
      tabIndex={-1}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          disabled={locked}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </section>
  );
  if (side) return card;
  return (
    <div
      className={`modal-backdrop ${locked ? "locked" : ""}`}
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !locked && onClose()
      }
    >
      {card}
    </div>
  );
}
function ReaderReferencePanel({ target, workTypes, onClose }: { target: RelatedHistoryTarget; workTypes: string[]; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "start" });
    panel.current?.focus({ preventScroll: true });
  }, [target]);
  return <div ref={panel} tabIndex={-1} aria-label="선택한 관련 이력"><Suspense fallback={<p role="status">관련 이력을 준비하고 있습니다…</p>}><RelatedHistory target={target} workTypes={workTypes} onClose={onClose} /></Suspense></div>;
}
function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">
        <Icon name="empty" />
      </span>
      <p>{title}</p>
    </div>
  );
}
