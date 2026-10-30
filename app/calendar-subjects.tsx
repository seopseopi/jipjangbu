import { calendarWorkPresentation } from "./calendar-presentation";
import { getPropertyDisplayGroups } from "./property-display";

/** Compact addresses without changing the workbook's work-type presentation. */
export function CalendarSubjects({ item }: { item: Parameters<typeof calendarWorkPresentation>[0] }) {
  const presentation = calendarWorkPresentation(item);
  const groups = getPropertyDisplayGroups(presentation.properties);
  return (
    <span className={`calendar-subjects${presentation.propertyFocused ? " is-property-focused" : " is-customer-focused"}`}>
      {!presentation.propertyFocused && <strong className="calendar-subject-customer">{presentation.entries[0]}</strong>}
      {presentation.properties.length > 0 && <span className="calendar-subject-properties" role="list" aria-label="관련 물건">
        {groups.flatMap((group) => {
          const compactBuilding = Boolean(group.building && group.items.length > 1);
          const heading = compactBuilding ? <span className="calendar-subject-building" key={`building-${group.key}`} role="presentation">{group.building}</span> : null;
          const entries = group.items.map(({ property, index, shortLabel, sourceLabel }) => {
            const address = presentation.properties[index].label;
            const fullText = presentation.propertyFocused ? presentation.entries[index] : address;
            // The suffix belongs to this property, not its building. Keeping it
            // per row preserves different broker/source labels in one work.
            const visibleText = compactBuilding && fullText.startsWith(address)
              ? `${shortLabel}${sourceLabel}${fullText.slice(address.length)}`
              : fullText;
            return (
              <span className="calendar-subject-property" key={property.id || index} role="listitem" aria-label={`물건 ${index + 1} · ${fullText}`} title={fullText}>
                {presentation.properties.length > 1 && <span className="calendar-subject-number" aria-hidden="true">{index + 1}.</span>}
                <span className="calendar-subject-label">{visibleText}</span>
              </span>
            );
          });
          return heading ? [heading, ...entries] : entries;
        })}
      </span>}
    </span>
  );
}
