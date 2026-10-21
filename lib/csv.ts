import Papa from "papaparse";
import * as XLSX from "xlsx";

export type Row = Record<string, string>;

export interface EncodingReport {
  /** Codificación original detectada: "UTF-8", "UTF-8 con BOM", "Windows-1252 / ANSI", "UTF-16", "Excel (.xls/.xlsx)" */
  detectedEncoding: string;
  /** Si fue necesario convertir desde otra codificación (ej. ANSI/Windows-1252 o Excel) a UTF-8 */
  convertedToUtf8: boolean;
  /** Cantidad de secuencias corruptas tipo "JosÃ©" / "PeÃ±a" reparadas automáticamente */
  repairedMojibake: number;
  /** Cantidad de caracteres irrecuperables () que ya venían dañados en el archivo */
  replacementChars: number;
  /** Mensaje amigable para mostrar al usuario o en los logs */
  summary: string;
}

export interface ParsedSpreadsheet {
  rows: Row[];
  columns: string[];
  errors: string[];
  encoding: EncodingReport;
  isExcel: boolean;
  sheetName?: string;
}

// Mapa de bytes del rango 0x80-0x9F en Windows-1252 para revertir mojibake UTF-8 -> Windows-1252
const WIN1252_UNICODE_TO_BYTE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Patrón típico de mojibake en español/portugués: Ã¡ Ã© Ã­ Ã³ Ãº Ã± Ã‘ Ã¼ Â¿ Â¡ etc.
const MOJIBAKE_REGEX = /Ã[\u0080-\u00bf\u20ac-\u2122]|Â[\u00a1-\u00bf]/g;

/**
 * Repara texto que sufrió doble codificación (UTF-8 leído como Windows-1252),
 * por ejemplo "JosÃ© MarÃ­a PeÃ±a" -> "José María Peña".
 */
export function repairMojibakeText(input: string): { text: string; repairedCount: number } {
  const matches = input.match(MOJIBAKE_REGEX);
  if (!matches || matches.length === 0) {
    return { text: input, repairedCount: 0 };
  }

  // Intentamos reconstruir los bytes Windows-1252 segmento por segmento o en bloques con caracteres > 127
  let repairedCount = 0;
  const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

  const fixed = input.replace(/[^\x00-\x7f]+/g, (chunk) => {
    if (!MOJIBAKE_REGEX.test(chunk)) return chunk;
    MOJIBAKE_REGEX.lastIndex = 0;
    const bytes = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      if (code <= 0xff) {
        bytes[i] = code;
      } else if (WIN1252_UNICODE_TO_BYTE[code] !== undefined) {
        bytes[i] = WIN1252_UNICODE_TO_BYTE[code];
      } else {
        return chunk; // contiene un carácter Unicode que no proviene de Windows-1252
      }
    }
    try {
      const decoded = utf8Fatal.decode(bytes);
      if (decoded !== chunk) repairedCount++;
      return decoded;
    } catch {
      return chunk;
    }
  });

  return { text: fixed, repairedCount };
}

/**
 * Decodifica un ArrayBuffer o Uint8Array detectando automáticamente:
 * - UTF-8 (con o sin BOM)
 * - UTF-16 LE / BE
 * - Windows-1252 / ISO-8859-1 (ANSI clásico de Excel en Windows para español con tildes y ñ)
 * Y además repara mojibake si el archivo ya venía con tildes mal guardadas.
 */
export function decodeCsvBytes(input: ArrayBuffer | Uint8Array): { text: string; report: EncodingReport } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let rawText = "";
  let detectedEncoding = "UTF-8";
  let convertedToUtf8 = false;

  // 1. Detectar BOM UTF-8 (EF BB BF)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    detectedEncoding = "UTF-8 con BOM";
    rawText = new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // 2. Detectar BOM UTF-16 LE (FF FE)
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    detectedEncoding = "UTF-16 LE";
    convertedToUtf8 = true;
    rawText = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  // 3. Detectar BOM UTF-16 BE (FE FF)
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    detectedEncoding = "UTF-16 BE";
    convertedToUtf8 = true;
    rawText = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // 4. Probar UTF-8 estricto; si falla, es Windows-1252 / ISO-8859-1 (ANSI de Excel con tildes/ñ)
  else {
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      detectedEncoding = "UTF-8";
    } catch {
      rawText = new TextDecoder("windows-1252").decode(bytes);
      detectedEncoding = "Windows-1252 (ANSI / Excel)";
      convertedToUtf8 = true;
    }
  }

  // 5. Verificar y reparar si el texto traía mojibake ("MÃ©xico" -> "México")
  const { text: cleanText, repairedCount } = repairMojibakeText(rawText);
  const replacementChars = (cleanText.match(/\uFFFD/g) ?? []).length;

  const parts: string[] = [`Codificación: ${detectedEncoding}`];
  if (convertedToUtf8) parts.push("convertido automáticamente a UTF-8 conservando tildes y ñ");
  if (repairedCount > 0) parts.push(`${repairedCount} texto(s) con tildes mal codificadas reparados`);
  if (replacementChars > 0) parts.push(`aviso: ${replacementChars} carácter(es) '' ya venían dañados de origen`);
  if (!convertedToUtf8 && repairedCount === 0 && replacementChars === 0) {
    parts.push("UTF-8 verificado correctamente (tildes y ñ intactas)");
  }

  return {
    text: cleanText,
    report: {
      detectedEncoding,
      convertedToUtf8,
      repairedMojibake: repairedCount,
      replacementChars,
      summary: parts.join(" · "),
    },
  };
}

/** Normaliza cabeceras vacías o repetidas para que la tabla tenga IDs únicos. */
function buildUniqueHeaders(rawHeaders: string[]): string[] {
  const usedHeaders = new Set<string>();
  return rawHeaders.map((h, index) => {
    const cleanH = repairMojibakeText(String(h ?? "")).text.trim();
    const base = cleanH || `columna_${index + 1}`;
    let name = base;
    for (let n = 2; usedHeaders.has(name); n++) name = `${base}_${n}`;
    usedHeaders.add(name);
    return name;
  });
}

/** Parsea texto CSV con cabecera. Detecta el delimitador automáticamente y repara mojibake. */
export function parseCsvText(text: string): {
  rows: Row[];
  columns: string[];
  errors: string[];
} {
  const clean = repairMojibakeText(text.replace(/^\uFEFF/, "")).text;
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

/** Detecta si un archivo o buffer es Excel (.xls / .xlsx) por extensión o firma binaria. */
export function isExcelFileName(name: string): boolean {
  return /\.(xlsx?|xlsb|ods)$/i.test(name.trim());
}

export function isSupportedSpreadsheetName(name: string): boolean {
  return /\.(csv|txt|xlsx?|xlsb|ods)$/i.test(name.trim());
}

/**
 * Lee cualquier archivo soportado (.csv, .xls, .xlsx) desde un ArrayBuffer,
 * validando y convirtiendo la codificación a UTF-8 para mantener todas las tildes y eñes.
 */
export function parseSpreadsheetBuffer(
  buffer: ArrayBuffer,
  fileName = "archivo.csv"
): ParsedSpreadsheet {
  const bytes = new Uint8Array(buffer);
  const hasZipMagic =
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const hasOleMagic =
    bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  const excelByExt = isExcelFileName(fileName);

  // Si es binario Excel (.xlsx ZIP o .xls OLE2) o tiene extensión .xls/.xlsx
  if (hasZipMagic || hasOleMagic || excelByExt) {
    try {
      // Si es un falso .xls (texto CSV/TSV guardado con extensión .xls), verificamos si no es binario
      const isBinary = hasZipMagic || hasOleMagic;
      let wb: XLSX.WorkBook;
      if (isBinary) {
        wb = XLSX.read(bytes, {
          type: "array",
          codepage: 1252, // garantiza tildes en archivos .xls BIFF8 en español
          cellDates: true,
        });
      } else {
        // Texto con extensión .xls (ej. HTML, XML o CSV exportado como .xls)
        const { text: decodedText } = decodeCsvBytes(bytes);
        wb = XLSX.read(decodedText, { type: "string", cellDates: true });
      }

      const sheetName = wb.SheetNames.find((n) => {
        const s = wb.Sheets[n];
        return s && s["!ref"];
      }) ?? wb.SheetNames[0];

      if (!sheetName) {
        return {
          rows: [],
          columns: [],
          errors: ["El archivo Excel no contiene hojas con datos"],
          isExcel: true,
          encoding: {
            detectedEncoding: "Excel (.xls/.xlsx)",
            convertedToUtf8: true,
            repairedMojibake: 0,
            replacementChars: 0,
            summary: "Archivo Excel vacío",
          },
        };
      }

      const sheet = wb.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
        header: 1,
        defval: "",
        raw: false,
      });

      // Buscar la primera fila no vacía como cabecera
      const nonEmptyRows = matrix.filter((row) =>
        Array.isArray(row) && row.some((cell) => String(cell ?? "").trim() !== "")
      );

      if (nonEmptyRows.length === 0) {
        return {
          rows: [],
          columns: [],
          errors: ["La hoja de Excel está vacía"],
          isExcel: true,
          sheetName,
          encoding: {
            detectedEncoding: "Excel (.xls/.xlsx)",
            convertedToUtf8: true,
            repairedMojibake: 0,
            replacementChars: 0,
            summary: "Hoja de Excel vacía",
          },
        };
      }

      const columns = buildUniqueHeaders(nonEmptyRows[0].map((c) => String(c ?? "")));
      let repairedMojibake = 0;
      const rows: Row[] = [];

      for (let rIdx = 1; rIdx < nonEmptyRows.length; rIdx++) {
        const rawRow = nonEmptyRows[rIdx];
        const rowObj: Row = {};
        let hasValue = false;
        for (let cIdx = 0; cIdx < columns.length; cIdx++) {
          const val = String(rawRow[cIdx] ?? "").trim();
          const { text: fixedVal, repairedCount } = repairMojibakeText(val);
          repairedMojibake += repairedCount;
          if (fixedVal !== "") hasValue = true;
          rowObj[columns[cIdx]] = fixedVal;
        }
        if (hasValue) rows.push(rowObj);
      }

      return {
        rows,
        columns,
        errors: [],
        isExcel: true,
        sheetName,
        encoding: {
          detectedEncoding: hasZipMagic ? "Excel (.xlsx)" : hasOleMagic ? "Excel 97-2004 (.xls)" : "Excel (.xls)",
          convertedToUtf8: true,
          repairedMojibake,
          replacementChars: 0,
          summary: `Archivo Excel (hoja «${sheetName}») convertido a UTF-8 conservando tildes y ñ` +
            (repairedMojibake > 0 ? ` · ${repairedMojibake} celdas reparadas` : ""),
        },
      };
    } catch {
      // Si falló como Excel, intentamos leerlo como CSV con decodificación inteligente
    }
  }

  const { text, report } = decodeCsvBytes(bytes);
  const parsed = parseCsvText(text);
  return {
    ...parsed,
    encoding: report,
    isExcel: false,
  };
}

/** Parsea un File (.csv, .xls, .xlsx) en el navegador o servidor manteniendo UTF-8 y tildes. */
export async function parseCsvFile(file: File): Promise<ParsedSpreadsheet> {
  const buf = await file.arrayBuffer();
  return parseSpreadsheetBuffer(buf, file.name);
}

/** Convierte filas a texto CSV (con BOM UTF-8 para que Excel y Brevo respeten las tildes y eñes). */
export function toCsv(rows: Row[], columns: string[], delimiter = ","): string {
  const csv = Papa.unparse(
    {
      fields: columns,
      data: rows.map((r) => columns.map((c) => sanitizeCell(r[c] ?? ""))),
    },
    { delimiter }
  );
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

/** Dispara la descarga de un CSV en UTF-8 con BOM en el navegador. */
export function downloadCsv(filename: string, content: string) {
  const withBom = content.startsWith("\uFEFF") ? content : "\uFEFF" + content;
  const blob = new Blob([withBom], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
