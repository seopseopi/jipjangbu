/** Search fragments accept only application-owned column names; values are bound. */
/** @typedef {{ sql: string, bindings: string[] }} SearchPredicate */

export function escapedLike(value, prefixOnly = false) {
  const literal = value.replace(/[\\%_]/g, "\\$&");
  return prefixOnly ? `${literal}%` : `%${literal}%`;
}

function compactSql(expression) {
  return `replace(replace(replace(replace(replace(COALESCE(${expression}, ''), ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(160), '')`;
}

function phoneSql(column) {
  return `replace(replace(replace(${compactSql(column)}, '-', ''), '(', ''), ')', '')`;
}

/** @param {string[]} columns @param {string} query @param {string[]} phoneColumns @returns {SearchPredicate} */
export function textSearch(columns, query, phoneColumns = []) {
  const sql = columns.map((column) => `${column} LIKE ? ESCAPE '\\'`);
  const bindings = columns.map(() => escapedLike(query.trim()));
  // Keep IDs as stored. Only telephone-shaped queries also ignore separators.
  const phone = query.replace(/[\s()-]/g, "");
  if (/^\+?\d{4,}$/.test(phone)) {
    for (const column of phoneColumns) {
      sql.push(`${phoneSql(column)} LIKE ? ESCAPE '\\'`);
      bindings.push(escapedLike(phone));
    }
  }
  return { sql: `(${sql.join(" OR ") || "0"})`, bindings };
}

/** @param {string} query @returns {{building: string, dong?: string, unit?: string, buildingUnitAlternative?: string} | null} */
export function parsePropertySearch(query) {
  const text = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  // A complete telephone number is text, even when it occurs in listing notes.
  if (/^\(?0\d{1,3}\)?[- ]\d{3,4}[- ]\d{4}$/.test(text)) return null;
  // Anchoring the whole address prevents a partial 106 match inside 1106.
  let match = /^(.*?)(\d+|[a-zA-Z])\s*동\s*(\d+[a-zA-Z]?|[bB]\d+)\s*호?$/u.exec(text);
  if (match) return { building: match[1].trim(), dong: match[2], unit: match[3] };
  // Korean-letter blocks need a word boundary: 역삼동 101호 is a building
  // and unit, not building "역" / block "삼" / unit "101".
  match = /^(.*\s)?([가-힣])\s*동\s*(\d+[a-zA-Z]?|[bB]\d+)\s*호?$/u.exec(text);
  if (match) return {
    building: (match[1] ?? "").trim(), dong: match[2], unit: match[3],
    // 명동 101호 can also be a building called 명동 without a block.
    buildingUnitAlternative: `${match[1] ?? ""}${match[2]}동`.trim(),
  };
  match = /^(.*?)(\d+)\s*([-–—]\s*|\s+)(\d+)\s*호?$/u.exec(text);
  // Telephone prefixes must not be reinterpreted as a building number.
  // A digit-ending building (제일3 1503) is not block 3. Preserve the
  // boundary between its name and unit instead of joining all their digits.
  if (match && (!match[1] || /\s$/.test(match[1]) || /[-–—]/.test(match[3]))
    && !(match[1] === "" && /^0\d{1,3}$/.test(match[2]))) {
    return { building: match[1].trim(), dong: match[2], unit: match[4] };
  }
  if (match && match[1] && !/[-–—]/.test(match[3])) {
    return { building: `${match[1]}${match[2]}`.trim(), unit: match[4] };
  }
  match = /^(.*?)(\d+|[a-zA-Z])\s*동$/u.exec(text);
  if (match) return { building: match[1].trim(), dong: match[2] };
  match = /^(.*?)(\d+[a-zA-Z]?|[bB]\d+)\s*호$/u.exec(text);
  return match ? { building: match[1].trim(), unit: match[2] } : null;
}

function addressNumberSql(column, suffix) {
  const value = `trim(COALESCE(${column}, ''))`;
  return `trim(CASE WHEN substr(${value}, -1) = '${suffix}' THEN substr(${value}, 1, length(${value}) - 1) ELSE ${value} END)`;
}

/**
 * All address pieces are evaluated on ONE property row. Do not split this
 * predicate into separate EXISTS queries, which could combine different homes.
 * @param {string} query
 * @param {"" | "p" | "sp" | "l"} alias
 * @param {"work" | "listing"} kind
 * @returns {SearchPredicate}
 */
export function propertySearch(query, alias = "", kind = "listing") {
  if (!["", "p", "sp", "l"].includes(alias)) throw new Error("Invalid property search alias");
  const prefix = alias ? `${alias}.` : "";
  const building = `${prefix}building_name`;
  const dong = addressNumberSql(`${prefix}building_dong`, "동");
  const unit = addressNumberSql(`${prefix}unit_number`, "호");
  const address = parsePropertySearch(query);
  if (address) {
    const sql = [], bindings = [];
    const landSql = `${prefix}property_type = '토지' AND ${compactSql(building)} LIKE ? ESCAPE '\\'`;
    const landQuery = escapedLike(query.normalize("NFKC").replace(/\s/g, ""));
    if (address.building) {
      sql.push(`${compactSql(`${prefix}property_type || ${building}`)} LIKE ? ESCAPE '\\'`);
      bindings.push(escapedLike(address.building.replace(/\s/g, "")));
    }
    if (address.dong !== undefined) { sql.push(`${dong} = ? COLLATE NOCASE`); bindings.push(address.dong); }
    if (address.unit !== undefined) { sql.push(`${unit} = ? COLLATE NOCASE`); bindings.push(address.unit); }
    if (address.buildingUnitAlternative) {
      bindings.push(escapedLike(address.buildingUnitAlternative.replace(/\s/g, "")), address.unit);
      return {
        sql: `((${sql.join(" AND ")}) OR (${dong} = '' AND ${compactSql(building)} LIKE ? ESCAPE '\\' AND ${unit} = ? COLLATE NOCASE) OR (${landSql}))`,
        bindings: [...bindings, landQuery],
      };
    }
    return { sql: `((${sql.join(" AND ")}) OR (${landSql}))`, bindings: [...bindings, landQuery] };
  }
  const columns = ["property_type", "building_name", "building_dong", "unit_number",
    ...(kind === "work" ? ["source"] : ["status", "notes", "source_notes"])].map((column) => prefix + column);
  const literal = textSearch(columns, query);
  // A bare number remains a partial field search, not a cross-field digit join.
  if (/^\d+$/.test(query.trim())) return literal;
  const forms = [
    `${building} || ' ' || ${dong} || ' ' || ${unit}`,
    `${building} || ' ' || ${unit}`,
    `${building} || CASE WHEN ${dong} <> '' THEN ' ' || ${dong} || '동' ELSE '' END || CASE WHEN ${unit} <> '' THEN ' ' || ${unit} || '호' ELSE '' END`,
  ];
  const combined = forms.map((form) => `${compactSql(form)} LIKE ? ESCAPE '\\'`);
  const like = escapedLike(query.normalize("NFKC").replace(/\s/g, ""));
  return { sql: `(${literal.sql} OR ${combined.join(" OR ")})`, bindings: [...literal.bindings, ...forms.map(() => like)] };
}

/** @param {string} query @returns {SearchPredicate} */
export function workSearch(query) {
  const text = textSearch(["w.content", "w.work_type", "c.id", "c.name"], query, ["c.id"]);
  const property = propertySearch(query, "sp", "work");
  return {
    sql: `(${text.sql} OR EXISTS (SELECT 1 FROM work_log_properties sp WHERE sp.work_log_id = w.id AND ${property.sql}))`,
    bindings: [...text.bindings, ...property.bindings],
  };
}
