import { LISTING_WORK_TYPES } from "./listing-work-types.js";
export { LISTING_WORK_TYPES } from "./listing-work-types.js";

type PropertyDraft = {
  propertyType?: string;
  buildingName?: string;
  buildingDong?: string;
  unitNumber?: string;
  sizeType?: string;
  salePrice?: string;
  jeonsePrice?: string;
  monthlyRent?: string;
  source?: string;
};

type WorkDraft = {
  workDate: string;
  customerId: string;
  workType: string;
  details: PropertyDraft[];
};

export type WorkDraftIssue = { message: string; field: string };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Report the first missing field in the same order as the visible work form. */
export function findWorkDraftIssue(
  draft: WorkDraft,
  customers: ReadonlyArray<{ id: string }>,
  workTypes: readonly string[],
): WorkDraftIssue | null {
  if (!validDate(draft.workDate.trim())) return { field: "workDate", message: "업무 일자를 확인해 주세요." };
  if (!customers.some((customer) => customer.id === draft.customerId.trim())) {
    return { field: "customerId", message: "검색 결과에서 고객을 선택해 주세요. 없는 고객은 ‘새 고객’으로 먼저 등록할 수 있습니다." };
  }
  const workType = draft.workType.trim();
  if (!workType || !workTypes.includes(workType)) return { field: "workType", message: "업무구분을 선택해 주세요." };
  if (!LISTING_WORK_TYPES.has(workType)) return null;
  // The API ignores completely empty extra rows, so the form must do the same.
  const entered = draft.details.map((detail, index) => ({ detail, index }))
    .filter(({ detail }) => Object.values(detail).some((value) => value?.trim()));
  if (!entered.length) {
    return { field: "property-0-propertyType", message: `${workType} 업무는 매물 정보가 필요합니다. 기존 매물을 불러오거나 물건구분·건물명·호수를 입력해 주세요.` };
  }
  for (const { detail, index } of entered) {
    const fields = detail.propertyType?.trim() === "토지"
      ? [["propertyType", "물건구분"], ["buildingName", "주소"]] as const
      : [["propertyType", "물건구분"], ["buildingName", "건물명"], ["unitNumber", "호수"]] as const;
    for (const [key, label] of fields) {
      if (!detail[key]?.trim()) return { field: `property-${index}-${key}`, message: `물건 ${index + 1}의 ${label}을 입력해 주세요. ${workType} 업무는 매물 정보가 필요합니다.` };
    }
  }
  return null;
}
