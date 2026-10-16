import Papa from "papaparse";

export type Row = Record<string, string>;

/** Parsea texto CSV con cabecera. Detecta el delimitador automáticamente. */
export function parseCsvText(text: string): {
  rows: Row[];
  columns: string[];
  errors: string[];
} {
  // Quita BOM (Excel lo añade al exportar UTF-8)
  const clean = text.replace(/^\uFEFF/, "");
  // Cabeceras vacías o repetidas romperían la tabla (necesita ids únicos y no vacíos)
  const usedHeaders = new Set<string>();
  const result = Papa.parse<Row>(clean, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h, index) => {
      const base = h.trim() || `columna_${index + 1}`;
      let name = base;
      for (let n = 2; usedHeaders.has(name); n++) name = `${base}_${n}`;
      usedHeaders.add(name);
      return name;
    },
  });
  return {
    rows: result.data,
    columns: result.meta.fields ?? [],
    errors: result.errors.map((e) => `Fila ${e.row ?? "?"}: ${e.message}`),
  };
}

/** Parsea un File en el navegador. */
export async function parseCsvFile(file: File) {
  return parseCsvText(await file.text());
}

/** Convierte filas a texto CSV (con BOM para que Excel respete los acentos). */
export function toCsv(rows: Row[], columns: string[]): string {
  const csv = Papa.unparse({
    fields: columns,
    data: rows.map((r) => columns.map((c) => sanitizeCell(r[c] ?? ""))),
  });
  return "\uFEFF" + csv;
}

/**
 * Previene CSV injection: celdas que empiezan con = + - @ se interpretarían
 * como fórmulas en Excel. Se antepone una comilla simple.
 */
function sanitizeCell(value: string): string {
  return /^[=+\-@]/.test(value) && !/^[+-]?\d+([.,]\d+)?$/.test(value)
    ? `'${value}`
    : value;
}

/** Dispara la descarga de un CSV en el navegador. */
export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
