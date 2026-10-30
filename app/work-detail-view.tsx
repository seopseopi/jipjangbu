"use client";

import { createPropertyHistoryTarget } from "./history-query";
import { Icon, workTypeIcon } from "./icons";
import { workPropertyLabel } from "./work-property-summary";

export type WorkDetailReadItem = {
  id: string;
  work_date: string;
  work_type: string;
  customer_id: string;
  customer_name: string;
  content: string;
  details: Array<Record<string, string | number>>;
};

function detailText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Read stored work facts only; editing and related history are explicit actions. */
export function WorkDetailView({
  item,
  onCopy,
  onEdit,
  onDelete,
  onCustomerHistory,
  onEditCustomer,
  onListingHistory,
}: {
  item: WorkDetailReadItem;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCustomerHistory: () => void;
  onEditCustomer?: () => void;
  onListingHistory: (key: string) => void;
}) {
  const customerId = detailText(item.customer_id);
  const properties = item.details.map((detail, index) => {
    const property = {
      property_type: detailText(detail.property_type),
      building_name: detailText(detail.building_name),
      building_dong: detailText(detail.building_dong),
      unit_number: detailText(detail.unit_number),
      size_type: detailText(detail.size_type),
    };
    return {
      key: `${detailText(detail.id)}-${index}`,
      address: workPropertyLabel({ ...property, source: detailText(detail.source) }, true),
      type: property.property_type || "물건구분 미입력",
      size: property.size_type,
      history: createPropertyHistoryTarget({
        propertyType: property.property_type,
        buildingName: property.building_name,
        buildingDong: property.building_dong,
        unitNumber: property.unit_number,
      }),
      prices: [
        ["매매", detailText(detail.sale_price)],
        ["전세", detailText(detail.jeonse_price)],
        ["월세", detailText(detail.monthly_rent)],
      ].filter(([, value]) => value !== ""),
      source: detailText(detail.source),
    };
  });
  return (
    <div className="work-read-view">
      <header className="work-read-header">
        <div className="work-read-heading">
          <div className="work-read-meta">
            <time dateTime={item.work_date}>{item.work_date.replaceAll("-", ".") || "일자 미입력"}</time>
            <span className="work-read-type"><Icon name={workTypeIcon(item.work_type)} size={15} />{detailText(item.work_type) || "업무구분 미입력"}</span>
          </div>
          <div className="work-read-customer">
            <strong>{detailText(item.customer_name) || "고객 정보 없음"}</strong>
            {customerId && <span className="work-read-customer-id">고객 ID · {customerId}</span>}
            <button type="button" className="work-read-link" onClick={onCustomerHistory} disabled={!customerId}>
              <Icon name="clock" size={15} /> 고객 이력
            </button>
            {onEditCustomer && <button type="button" className="work-read-link" onClick={onEditCustomer} disabled={!customerId}><Icon name="edit" size={15} /> 고객 정보 수정</button>}
          </div>
        </div>
        <div className="work-read-actions">
          <button type="button" className="primary-button" onClick={onCopy}>
            <Icon name="copy" size={17} /> 업무 복사
          </button>
          <button type="button" className="secondary-button" onClick={onEdit}>
            <Icon name="edit" size={17} /> 업무 수정
          </button>
          <button type="button" className="danger-button" onClick={onDelete}>
            <Icon name="delete" size={17} /> 업무 삭제
          </button>
        </div>
      </header>

      <section className="work-read-content" aria-label="업무 내용">
        <h3>업무 내용</h3>
        {detailText(item.content)
          ? <p className="work-read-note">{item.content}</p>
          : <p className="work-read-empty">기록된 내용이 없습니다.</p>}
      </section>

      <section className="work-read-properties" aria-label="관련 물건 전체">
        <h3>관련 물건 <span className="work-read-count">{properties.length}개</span></h3>
        {item.details.length === 0 ? (
          <p className="work-read-empty">이 업무에 연결된 물건이 없습니다.</p>
        ) : (
          <div className="work-read-comparison">
            <div className="work-read-columns" aria-hidden="true">
              <span>번호</span><span>물건 · 구분/타입</span><span>가격</span><span>물건지·업소</span><span>이력</span>
            </div>
            <ol className="work-read-property-list">
              {properties.map((property, index) => (
                <li key={property.key}>
                  <article className="work-read-property" aria-label={`물건 ${index + 1} · ${property.address}`}>
                    <span className="work-read-number" aria-label={`물건 ${index + 1}`}>{index + 1}</span>
                    <div className="work-read-address">
                      <h4>{property.address}</h4>
                      <p>{property.type}{property.size && ` · 타입 ${property.size}`}</p>
                    </div>
                    {property.prices.length > 0 ? (
                      <dl className="work-read-prices">
                        {property.prices.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
                      </dl>
                    ) : <p className="work-read-price-empty" aria-label="기록된 가격이 없습니다.">가격 미기재</p>}
                    <dl className="work-read-source" aria-label="물건지·업소">
                      <dt>물건지·업소</dt><dd>{property.source || "미기재"}</dd>
                    </dl>
                    <div className="work-read-property-actions">
                      <button
                        type="button"
                        className="work-read-link"
                        disabled={!property.history}
                        aria-label={`${property.address} 매물 이력`}
                        onClick={() => { if (property.history?.kind === "listing") onListingHistory(property.history.key); }}
                      >
                        <Icon name="clock" size={15} /> 매물 이력
                      </button>
                    </div>
                  </article>
                </li>
              ))}
            </ol>
            {properties.some((property) => !property.history) && <p className="work-read-history-note">물건구분·건물명·호수가 있어야 이력을 찾을 수 있습니다.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
