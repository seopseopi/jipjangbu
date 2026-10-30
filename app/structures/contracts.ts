import type { PlanFile } from "./file-contract";
import type { Plan } from "./plan";
export type PropertyRow = {
  identity_key: string;
  building_name: string;
  building_dong: string;
  unit_number: string;
  size_types?: string;
  active_count: number;
  listing_count: number;
};
export type Revision = {
  id: string;
  type_id: string;
  type_name: string;
  complex_id: string;
  version: number;
  source: string;
  variant: string;
  permission_evidence: string;
  verified_at: string;
};
export type StructureUnit = {
  id: string;
  building_id: string;
  building_name: string;
  complex_id: string;
  complex_name: string;
  number: string;
  floor: number | null;
  evidence: string;
  revision_id: string | null;
  mirror: number | null;
  rotation: number | null;
  actual_condition: string | null;
  row_version: number | null;
};
export type Catalog = {
  managedBuildings?: { id: string; building_name: string }[];
  properties: PropertyRow[];
  complexes: { id: string; name: string; address: string }[];
  units: StructureUnit[];
  revisions: Revision[];
  links: { identity_key: string; unit_id: string }[];
};
export type RevisionData = {
  revision: Revision;
  plan: Plan | null;
  file: PlanFile | null;
  processing: import("./processing").Processing | null;
};
export type History = {
  listing: null | {
    id: string;
    status: string;
    sale_price: string;
    jeonse_price: string;
    monthly_rent: string;
    notes: string;
    source_notes: string;
  };
  workLogs: {
    id: string;
    work_date: string;
    work_type: string;
    customer_name: string;
    customer_id: string;
    content: string;
  }[];
};
