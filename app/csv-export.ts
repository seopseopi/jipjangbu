export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | undefined>>,
) {
  const safe = (value: string | number | undefined) => {
    const text = String(value ?? "");
    return /^[=+@]/.test(text) || /^-\D/.test(text) ? `'${text}` : text;
  };
  const escape = (value: string | number | undefined) =>
    `"${safe(value).replaceAll('"', '""')}"`;
  const csv = [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
