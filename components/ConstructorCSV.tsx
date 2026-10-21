"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColumnDef, ColumnFiltersState, RowSelectionState, SortingState,
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel,
  getSortedRowModel, useReactTable,
} from "@tanstack/react-table";
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown,
  CheckCircle2, ChevronLeft, ChevronRight, Columns3, Download, FileUp,
  GripVertical, Phone, Plus, Scissors, Search, Sparkles, Tag, Trash2, Type, Wand2,
} from "lucide-react";
import Papa from "papaparse";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Row, downloadCsv, isSupportedSpreadsheetName, parseCsvFile } from "@/lib/csv";
import { consumeBuilderDraft } from "@/lib/storage";

const TEMPLATE_COLUMNS = ["EMAIL", "NOMBRE", "APELLIDOS", "SMS", "CIUDAD"];
const MAX_BYTES = 10 * 1024 * 1024;

/** Atributos estándar recomendados por Brevo para importar contactos */
const BREVO_PRESETS = [
  { label: "— Mantener nombre —", value: "" },
  { label: "EMAIL (Correo principal)", value: "EMAIL" },
  { label: "NOMBRE (Nombre en español)", value: "NOMBRE" },
  { label: "APELLIDOS (Apellidos en español)", value: "APELLIDOS" },
  { label: "FIRSTNAME (Nombre en inglés)", value: "FIRSTNAME" },
  { label: "LASTNAME (Apellido en inglés)", value: "LASTNAME" },
  { label: "SMS (Teléfono móvil con +país)", value: "SMS" },
  { label: "WHATSAPP (Número WhatsApp)", value: "WHATSAPP" },
  { label: "EMPRESA / COMPANY", value: "EMPRESA" },
  { label: "CIUDAD", value: "CIUDAD" },
  { label: "PAIS", value: "PAIS" },
];

const COUNTRY_PREFIXES = [
  { code: "+51", label: "+51 (Perú)" },
  { code: "+34", label: "+34 (España)" },
  { code: "+52", label: "+52 (México)" },
  { code: "+57", label: "+57 (Colombia)" },
  { code: "+54", label: "+54 (Argentina)" },
  { code: "+56", label: "+56 (Chile)" },
  { code: "+593", label: "+593 (Ecuador)" },
  { code: "+1", label: "+1 (EE. UU. / Canadá)" },
];

/** Detecta el atributo Brevo más probable según el nombre de la columna o su contenido */
function guessBrevoHeader(col: string, rows: Row[]): { name: string; priority: number } {
  const c = col.toLowerCase().trim();
  if (/e-?mail|correo|mail/.test(c) || rows.slice(0, 15).some((r) => r[col]?.includes("@"))) {
    return { name: "EMAIL", priority: 1 };
  }
  if (/^(apellido|apellidos|lastname|last_name|surname|paterno)$/i.test(c)) {
    return { name: "APELLIDOS", priority: 3 };
  }
  if (/^(nombre|nombres|firstname|first_name|name|cliente|contacto)$/i.test(c)) {
    return { name: "NOMBRE", priority: 2 };
  }
  if (/whatsapp|wa/.test(c)) {
    return { name: "WHATSAPP", priority: 5 };
  }
  if (/tel|cel|movil|móvil|phone|sms|fono/.test(c)) {
    return { name: "SMS", priority: 4 };
  }
  if (/empresa|company|negocio|organizacion/.test(c)) {
    return { name: "EMPRESA", priority: 6 };
  }
  if (/ciudad|city|localidad|distrito/.test(c)) {
    return { name: "CIUDAD", priority: 7 };
  }
  if (/pais|país|country/.test(c)) {
    return { name: "PAIS", priority: 8 };
  }
  return { name: col.toUpperCase().replace(/\s+/g, "_"), priority: 20 };
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (ch) => ch.toUpperCase())
    .trim();
}

export default function ConstructorCSV() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  // Mapa de nombre interno de columna -> nombre de cabecera al exportar a Brevo
  const [columnRename, setColumnRename] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dragColIdx, setDragColIdx] = useState<number | null>(null);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [exportCols, setExportCols] = useState<Set<string>>(new Set());
  const [newRow, setNewRow] = useState<Row | null>(null);

  // Herramientas para Brevo
  const [targetColForTool, setTargetColForTool] = useState<string>("");
  const [phonePrefix, setPhonePrefix] = useState<string>("+51");
  const [newColName, setNewColName] = useState("");
  const [newColDefaultVal, setNewColDefaultVal] = useState("");
  const [showAddCol, setShowAddCol] = useState(false);
  const [delimiter, setDelimiter] = useState<"," | ";">(";"); // Brevo suele recomendar ; o ,

  // Edición en línea de celdas
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; colId: string; value: string } | null>(null);

  function loadData(rows: Row[], cols: string[], name: string, selectAllByDefault = true) {
    setData(rows);
    setColumns(cols);
    setExportCols(new Set(cols));
    const renames: Record<string, string> = {};
    cols.forEach((c) => {
      renames[c] = c;
    });
    setColumnRename(renames);
    setTargetColForTool(cols[0] ?? "");
    if (selectAllByDefault && rows.length > 0) {
      const sel: RowSelectionState = {};
      rows.forEach((_, idx) => {
        sel[String(idx)] = true;
      });
      setRowSelection(sel);
    } else {
      setRowSelection({});
    }
    setSorting([]);
    setColumnFilters([]);
    setGlobalFilter("");
    setFileName(name);
    setError("");
  }

  // Cargar datos si vienen enviados desde el Validador
  useEffect(() => {
    const draft = consumeBuilderDraft();
    if (draft && draft.columns.length > 0) {
      loadData(draft.rows, draft.columns, draft.fileName, true);
      setNotice(
        `Se importaron ${draft.rows.length.toLocaleString()} contactos válidos desde el Validador. Ahora puedes ordenar las columnas, mapearlas al formato de Brevo y descargar.`
      );
    }
  }, []);

  async function handleFile(file: File) {
    setNotice("");
    if (!isSupportedSpreadsheetName(file.name)) {
      return setError("El archivo debe ser .csv, .xls, .xlsx, .ods o .txt");
    }
    if (file.size > MAX_BYTES) return setError("El archivo supera los 10 MB");
    const { rows, columns: cols, errors, encoding } = await parseCsvFile(file);
    if (cols.length === 0 || rows.length === 0) {
      return setError("El archivo está vacío o no tiene fila de cabecera");
    }
    loadData(rows, cols, file.name, true);
    setNotice(`${encoding.summary} · ${rows.length.toLocaleString()} filas cargadas listas para ordenar y exportar a CSV.`);
    if (errors.length) setError(`Archivo cargado con avisos: ${errors[0]}`);
  }

  // Mover columna de posición (izquierda/derecha o drag & drop)
  function moveColumn(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= columns.length || fromIndex === toIndex) return;
    setColumns((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  // Optimizar en 1 clic el orden y nombres de las columnas para Brevo
  function applyBrevoAutoFormat() {
    if (columns.length === 0) return;
    const guessed = columns.map((col, idx) => ({
      col,
      idx,
      ...guessBrevoHeader(col, data),
    }));
    // Ordenar poniendo EMAIL primero, luego NOMBRE, APELLIDOS, SMS, etc.
    guessed.sort((a, b) => a.priority - b.priority || a.idx - b.idx);

    const newOrder = guessed.map((g) => g.col);
    const newRenames: Record<string, string> = {};
    const usedNames = new Set<string>();
    for (const g of guessed) {
      let target = g.name;
      for (let n = 2; usedNames.has(target); n++) {
        target = `${g.name}_${n}`;
      }
      usedNames.add(target);
      newRenames[g.col] = target;
    }
    setColumns(newOrder);
    setColumnRename(newRenames);
    setNotice(
      "Columnas ordenadas y renombradas al estándar de Brevo (EMAIL en primera columna). Puedes ajustar cualquier nombre o posición manualmente."
    );
  }

  // Herramienta 1: Dividir una columna de Nombre Completo en NOMBRE y APELLIDOS
  function splitFullNameColumn(col: string) {
    if (!col || !columns.includes(col)) return;
    const colNombre = columns.includes("NOMBRE") ? "NOMBRE" : col;
    const colApellidos = columns.includes("APELLIDOS") ? "APELLIDOS" : "APELLIDOS";

    const updatedRows = data.map((r) => {
      const raw = toTitleCase((r[col] ?? "").trim());
      if (!raw) return { ...r, [colNombre]: "", [colApellidos]: r[colApellidos] ?? "" };
      const parts = raw.split(/\s+/);
      let first = raw;
      let last = "";
      if (parts.length === 2) {
        [first, last] = parts;
      } else if (parts.length === 3) {
        first = parts[0];
        last = `${parts[1]} ${parts[2]}`;
      } else if (parts.length >= 4) {
        first = parts.slice(0, -2).join(" ");
        last = parts.slice(-2).join(" ");
      }
      return {
        ...r,
        [colNombre]: first,
        [colApellidos]: last,
      };
    });

    const nextCols = [...columns];
    if (!nextCols.includes(colApellidos)) {
      const idx = nextCols.indexOf(col);
      nextCols.splice(idx + 1, 0, colApellidos);
    }
    setData(updatedRows);
    setColumns(nextCols);
    setExportCols((prev) => new Set([...prev, colNombre, colApellidos]));
    setColumnRename((prev) => ({
      ...prev,
      [colNombre]: "NOMBRE",
      [colApellidos]: "APELLIDOS",
    }));
    setNotice(`Se dividió «${col}» en NOMBRE y APELLIDOS con mayúsculas iniciales.`);
  }

  // Herramienta 2: Normalizar teléfonos para Brevo (+país y solo dígitos)
  function normalizePhoneColumn(col: string) {
    if (!col || !columns.includes(col)) return;
    const cleanPrefix = phonePrefix.trim().startsWith("+") ? phonePrefix.trim() : `+${phonePrefix.trim()}`;
    const digitsPrefix = cleanPrefix.replace(/\D/g, "");
    let formattedCount = 0;

    const updatedRows = data.map((r) => {
      const raw = (r[col] ?? "").trim();
      if (!raw) return r;
      // Si hay varios teléfonos separados por / o - largos, tomar el primero
      const firstPart = raw.split(/[\/;|,]/)[0].trim();
      const hasPlus = firstPart.startsWith("+");
      const digits = firstPart.replace(/\D/g, "");
      if (digits.length < 6) return r;
      formattedCount++;
      let finalPhone: string;
      if (hasPlus) {
        finalPhone = `+${digits}`;
      } else if (digits.startsWith("00") && digits.length > 9) {
        finalPhone = `+${digits.slice(2)}`;
      } else if (digits.startsWith(digitsPrefix) && digits.length >= digitsPrefix.length + 8) {
        finalPhone = `+${digits}`;
      } else {
        // Quitar 0 inicial local si existe
        const localDigits = digits.replace(/^0+/, "");
        finalPhone = `${cleanPrefix}${localDigits}`;
      }
      return { ...r, [col]: finalPhone };
    });

    setData(updatedRows);
    setColumnRename((prev) => ({
      ...prev,
      [col]: prev[col] === col ? "SMS" : prev[col],
    }));
    setNotice(
      `Se normalizaron ${formattedCount.toLocaleString()} números en «${col}» con formato internacional (${cleanPrefix}) listo para Brevo SMS/WhatsApp.`
    );
  }

  // Herramienta 3: Capitalizar textos (Juan Perez)
  function capitalizeColumn(col: string) {
    if (!col || !columns.includes(col)) return;
    setData((prev) =>
      prev.map((r) => ({
        ...r,
        [col]: r[col] ? toTitleCase(r[col]) : "",
      }))
    );
    setNotice(`Se aplicó formato de Nombre Propio a la columna «${col}».`);
  }

  // Herramienta 4: Añadir nueva columna (ej. etiqueta u origen para Brevo)
  function handleAddColumn() {
    const clean = newColName.trim();
    if (!clean) return;
    if (columns.includes(clean)) {
      return setError(`Ya existe una columna llamada «${clean}»`);
    }
    setColumns((prev) => [...prev, clean]);
    setExportCols((prev) => new Set([...prev, clean]));
    setColumnRename((prev) => ({ ...prev, [clean]: clean.toUpperCase().replace(/\s+/g, "_") }));
    setData((prev) => prev.map((r) => ({ ...r, [clean]: newColDefaultVal })));
    setNewColName("");
    setNewColDefaultVal("");
    setShowAddCol(false);
    setNotice(`Columna «${clean}» añadida a las ${data.length.toLocaleString()} filas.`);
  }

  const tableColumns = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c) => ({
        id: c,
        header: () => {
          const renamed = (columnRename[c] ?? c).trim() || c;
          return (
            <div className="flex flex-col">
              <span className="text-indigo-700 font-bold">{renamed}</span>
              {renamed !== c && (
                <span className="text-[10px] font-normal normal-case text-slate-400">
                  orig: {c}
                </span>
              )}
            </div>
          );
        },
        accessorFn: (r) => r[c] ?? "",
      })),
    [columns, columnRename]
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting, globalFilter, columnFilters, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    getRowId: (_, index) => String(index),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
    globalFilterFn: "includesString",
    defaultColumn: { filterFn: "includesString" },
  });

  const filteredRows = table.getFilteredRowModel().rows;
  const selectedCount = Object.keys(rowSelection).length;
  const allFilteredSelected =
    filteredRows.length > 0 && filteredRows.every((r) => rowSelection[r.id]);

  function toggleAll() {
    setRowSelection((prev) => {
      const next = { ...prev };
      filteredRows.forEach((r) => {
        if (allFilteredSelected) delete next[r.id];
        else next[r.id] = true;
      });
      return next;
    });
  }

  function toggleCol(c: string) {
    setExportCols((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }

  function saveInlineEdit() {
    if (!editingCell) return;
    const { rowIdx, colId, value } = editingCell;
    setData((prev) => {
      const next = [...prev];
      if (next[rowIdx]) {
        next[rowIdx] = { ...next[rowIdx], [colId]: value };
      }
      return next;
    });
    setEditingCell(null);
  }

  function download(mode: "selected" | "filtered") {
    // Respeta exactamente el orden actual de `columns` que el usuario ordenó
    const activeCols = columns.filter((c) => exportCols.has(c));
    if (activeCols.length === 0) return;

    const headerNames = activeCols.map((c) => (columnRename[c] ?? c).trim() || c);
    const sourceRows =
      mode === "selected"
        ? Object.keys(rowSelection)
            .map(Number)
            .sort((a, b) => a - b)
            .map((i) => data[i])
            .filter(Boolean)
        : filteredRows.map((r) => data[Number(r.id)]).filter(Boolean);

    const sanitize = (v: string) =>
      /^[=+\-@]/.test(v) && !/^[+-]?\d+([.,]\d+)?$/.test(v) ? `'${v}` : v;

    const csv = Papa.unparse(
      {
        fields: headerNames,
        data: sourceRows.map((r) => activeCols.map((c) => sanitize(r[c] ?? ""))),
      },
      { delimiter }
    );

    const baseName = fileName ? fileName.replace(/\.(csv|xlsx?|xlsb|ods|txt)$/i, "") : "contactos";
    downloadCsv(`${baseName}_brevo.csv`, "\uFEFF" + csv);
  }

  function addRow() {
    if (!newRow) return;
    const nextIdx = data.length;
    setData([...data, newRow]);
    setRowSelection((prev) => ({ ...prev, [String(nextIdx)]: true }));
    setNewRow(null);
  }

  const activeColCount = columns.filter((c) => exportCols.has(c)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Constructor de CSV para Brevo</h1>
          <p className="text-sm text-slate-500">
            Ordena las columnas, renómbralas al estándar de Brevo (<code>EMAIL</code>, <code>NOMBRE</code>,{" "}
            <code>APELLIDOS</code>, <code>SMS</code>), limpia teléfonos o nombres y descarga tu archivo listo para importar.
          </p>
        </div>
        {columns.length > 0 && (
          <Button
            onClick={applyBrevoAutoFormat}
            className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm hover:from-indigo-700 hover:to-violet-700"
          >
            <Wand2 size={16} /> Auto-ordenar y nombrar para Brevo
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {notice && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2">
            <CheckCircle2 size={16} className="shrink-0 text-emerald-600" /> {notice}
          </span>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="text-xs font-medium text-emerald-700 hover:underline"
          >
            Ocultar
          </button>
        </div>
      )}

      {columns.length === 0 ? (
        <Card className="space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => inputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center ${
              dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 hover:bg-slate-50"
            }`}
          >
            <FileUp className="text-indigo-600" size={36} />
            <p className="text-sm font-medium">
              Arrastra tu CSV o Excel (<code>.xls</code> / <code>.xlsx</code>) aquí o haz clic para seleccionarlo
            </p>
            <p className="text-xs text-slate-500">
              Máx. 10 MB · Convierte Excel (.xls/.xlsx) a CSV UTF-8 manteniendo todas las tildes y ñ
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xls,.xlsx,.ods,.txt,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <div className="text-center text-sm text-slate-500">
            ¿Sin archivo?{" "}
            <button
              className="font-medium text-indigo-600 hover:underline"
              onClick={() => {
                loadData([], TEMPLATE_COLUMNS, "contactos_brevo.csv");
                setNewRow(Object.fromEntries(TEMPLATE_COLUMNS.map((c) => [c, ""])));
              }}
            >
              Empezar con plantilla Brevo vacía (EMAIL, NOMBRE, APELLIDOS, SMS, CIUDAD)
            </button>
          </div>
        </Card>
      ) : null}

      {columns.length > 0 && (
        <>
          {/* PANEL 1: ORDENAR Y RENOMBRAR COLUMNAS PARA BREVO */}
          <Card className="space-y-4 border-indigo-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                  <Columns3 size={17} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-slate-800">
                    1. Ordena y nombra tus columnas para Brevo
                  </h2>
                  <p className="text-xs text-slate-500">
                    Arrastra las tarjetas o usa las flechas <code>←</code> <code>→</code> para cambiar el orden. Puedes
                    elegir un atributo oficial de Brevo o escribir cualquier nombre.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setShowAddCol((v) => !v)}
                  className="text-xs"
                >
                  <Tag size={14} /> Añadir columna fija (ej. Etiqueta/Origen)
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setExportCols(new Set(columns))}
                  className="text-xs"
                >
                  Marcar todas
                </Button>
              </div>
            </div>

            {showAddCol && (
              <div className="flex flex-wrap items-end gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs">
                <label className="flex-1 min-w-[12rem]">
                  Nombre de la nueva columna (ej. <code>ORIGEN</code> o <code>LISTA</code>)
                  <Input
                    className="mt-1"
                    placeholder="ORIGEN"
                    value={newColName}
                    onChange={(e) => setNewColName(e.target.value)}
                  />
                </label>
                <label className="flex-1 min-w-[12rem]">
                  Valor para todos los contactos (ej. <code>Web Octubre</code>)
                  <Input
                    className="mt-1"
                    placeholder="Campaña Octubre"
                    value={newColDefaultVal}
                    onChange={(e) => setNewColDefaultVal(e.target.value)}
                  />
                </label>
                <Button onClick={handleAddColumn}>Crear columna</Button>
                <Button variant="secondary" onClick={() => setShowAddCol(false)}>
                  Cancelar
                </Button>
              </div>
            )}

            {/* Tarjetas de columnas ordenables */}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {columns.map((col, idx) => {
                const included = exportCols.has(col);
                const outName = columnRename[col] ?? col;
                return (
                  <div
                    key={col}
                    draggable
                    onDragStart={() => setDragColIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragColIdx !== null && dragColIdx !== idx) {
                        moveColumn(dragColIdx, idx);
                      }
                      setDragColIdx(null);
                    }}
                    className={`flex flex-col gap-2 rounded-xl border p-3 transition ${
                      included
                        ? "border-indigo-200 bg-white shadow-sm"
                        : "border-slate-200 bg-slate-50 opacity-60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer min-w-0">
                        <GripVertical size={14} className="shrink-0 cursor-grab text-slate-400" />
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => toggleCol(col)}
                        />
                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                          #{idx + 1}
                        </span>
                        <span className="truncate" title={col}>
                          {col}
                        </span>
                      </label>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, idx - 1)}
                          disabled={idx === 0}
                          title="Mover a la izquierda"
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                        >
                          <ArrowLeft size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, idx + 1)}
                          disabled={idx === columns.length - 1}
                          title="Mover a la derecha"
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                        >
                          <ArrowRight size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[11px] text-slate-500">
                        Nombre al exportar a Brevo:
                      </label>
                      <input
                        type="text"
                        value={outName}
                        onChange={(e) =>
                          setColumnRename((prev) => ({ ...prev, [col]: e.target.value }))
                        }
                        className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-indigo-900 outline-none focus:border-indigo-500"
                        placeholder={col}
                      />
                      <select
                        value={BREVO_PRESETS.some((p) => p.value === outName) ? outName : ""}
                        onChange={(e) => {
                          if (e.target.value) {
                            setColumnRename((prev) => ({ ...prev, [col]: e.target.value }));
                          }
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                      >
                        {BREVO_PRESETS.map((p) => (
                          <option key={p.label} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* HERRAMIENTAS RÁPIDAS DE TRANSFORMACIÓN DE DATOS PARA BREVO */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                <Sparkles size={13} className="text-indigo-600" />
                2. Limpieza rápida de columnas para Brevo (Nombres y Teléfonos SMS/WhatsApp)
              </p>
              <div className="flex flex-wrap items-end gap-3 text-xs">
                <label className="text-slate-600">
                  Columna a transformar:
                  <select
                    value={targetColForTool}
                    onChange={(e) => setTargetColForTool(e.target.value)}
                    className="mt-1 block rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800"
                  >
                    {columns.map((c) => (
                      <option key={c} value={c}>
                        {c} → ({columnRename[c] || c})
                      </option>
                    ))}
                  </select>
                </label>

                <Button
                  variant="secondary"
                  onClick={() => splitFullNameColumn(targetColForTool)}
                  className="text-xs"
                >
                  <Scissors size={14} /> Separar en NOMBRE + APELLIDOS
                </Button>

                <Button
                  variant="secondary"
                  onClick={() => capitalizeColumn(targetColForTool)}
                  className="text-xs"
                >
                  <Type size={14} /> Capitalizar («Juan Pérez»)
                </Button>

                <div className="flex items-end gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5">
                  <label className="text-[11px] text-slate-600">
                    Prefijo país Brevo:
                    <select
                      value={phonePrefix}
                      onChange={(e) => setPhonePrefix(e.target.value)}
                      className="mt-0.5 block rounded border border-slate-300 px-1.5 py-1 text-xs"
                    >
                      {COUNTRY_PREFIXES.map((cp) => (
                        <option key={cp.code} value={cp.code}>
                          {cp.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="secondary"
                    onClick={() => normalizePhoneColumn(targetColForTool)}
                    className="text-xs"
                  >
                    <Phone size={14} /> Formatear teléfono ({phonePrefix}...)
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          {/* BARRA DE BÚSQUEDA Y ACCIONES DE FILA */}
          <Card className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[14rem] flex-1">
                <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
                <Input
                  className="pl-9"
                  placeholder="Buscar en todas las columnas..."
                  value={globalFilter}
                  onChange={(e) => setGlobalFilter(e.target.value)}
                />
              </div>
              <Button variant="secondary" onClick={() => setNewRow(Object.fromEntries(columns.map((c) => [c, ""])))}>
                <Plus size={16} /> Añadir fila
              </Button>
              <Button
                variant="secondary"
                onClick={() => { setData([]); setColumns([]); setRowSelection({}); setFileName(""); setNotice(""); }}
              >
                <Trash2 size={16} /> Descartar datos
              </Button>
            </div>

            {newRow && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                <p className="mb-2 text-sm font-medium">Nueva fila</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {columns.map((c) => (
                    <Input
                      key={c}
                      placeholder={columnRename[c] || c}
                      value={newRow[c]}
                      onChange={(e) => setNewRow({ ...newRow, [c]: e.target.value })}
                    />
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button onClick={addRow}>Guardar fila</Button>
                  <Button variant="secondary" onClick={() => setNewRow(null)}>Cancelar</Button>
                </div>
              </div>
            )}
          </Card>

          {/* TABLA INTERACTIVA CON EDICIÓN EN LÍNEA */}
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-slate-500">
              <span>
                Vista previa en el orden elegido · <strong>Haz clic en cualquier celda para editar su valor</strong>
              </span>
              <span>
                Mostrando {filteredRows.length.toLocaleString()} fila(s)
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs text-slate-600">
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      <th className="w-10 px-3 py-2 align-top">
                        <input
                          type="checkbox"
                          aria-label="Seleccionar todo"
                          checked={allFilteredSelected}
                          onChange={toggleAll}
                        />
                      </th>
                      {hg.headers.map((h) => {
                        const sorted = h.column.getIsSorted();
                        const isIncluded = exportCols.has(h.column.id);
                        return (
                          <th
                            key={h.id}
                            className={`min-w-[9rem] px-3 py-2 align-top ${
                              isIncluded ? "" : "opacity-40"
                            }`}
                          >
                            <button
                              className="flex items-center gap-1 font-semibold uppercase"
                              onClick={h.column.getToggleSortingHandler()}
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              {sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} className="opacity-40" />}
                            </button>
                            <input
                              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-normal normal-case outline-none focus:border-indigo-500"
                              placeholder="Filtrar..."
                              value={(h.column.getFilterValue() as string) ?? ""}
                              onChange={(e) => h.column.setFilterValue(e.target.value || undefined)}
                            />
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {table.getRowModel().rows.map((row) => {
                    const rowIndex = Number(row.id);
                    return (
                      <tr key={row.id} className={rowSelection[row.id] ? "bg-indigo-50/50" : "hover:bg-slate-50"}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label="Seleccionar fila"
                            checked={!!rowSelection[row.id]}
                            onChange={row.getToggleSelectedHandler()}
                          />
                        </td>
                        {row.getVisibleCells().map((cell) => {
                          const colId = cell.column.id;
                          const isEditing =
                            editingCell?.rowIdx === rowIndex && editingCell?.colId === colId;
                          return (
                            <td
                              key={cell.id}
                              className={`px-3 py-2 ${exportCols.has(colId) ? "" : "opacity-40"}`}
                              onClick={() => {
                                if (!isEditing) {
                                  setEditingCell({
                                    rowIdx: rowIndex,
                                    colId,
                                    value: data[rowIndex]?.[colId] ?? "",
                                  });
                                }
                              }}
                            >
                              {isEditing ? (
                                <input
                                  autoFocus
                                  className="w-full rounded border border-indigo-500 bg-white px-1.5 py-0.5 text-sm outline-none"
                                  value={editingCell.value}
                                  onChange={(e) =>
                                    setEditingCell({ ...editingCell, value: e.target.value })
                                  }
                                  onBlur={saveInlineEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveInlineEdit();
                                    if (e.key === "Escape") setEditingCell(null);
                                  }}
                                />
                              ) : (
                                <span className="block min-h-[1.25rem] cursor-text rounded px-1 -mx-1 hover:bg-indigo-100/50">
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {table.getRowModel().rows.length === 0 && (
                    <tr>
                      <td colSpan={columns.length + 1} className="px-3 py-8 text-center text-slate-500">
                        No hay filas que coincidan con los filtros
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Paginación */}
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-sm">
              <span className="text-slate-500">
                Página {table.getState().pagination.pageIndex + 1} de {Math.max(table.getPageCount(), 1)}
              </span>
              <div className="flex gap-1">
                <Button variant="secondary" className="px-2 py-1" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
                  <ChevronLeft size={16} />
                </Button>
                <Button variant="secondary" className="px-2 py-1" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                  <ChevronRight size={16} />
                </Button>
              </div>
            </div>
          </Card>

          {/* PIE: RESUMEN + DESCARGA PARA BREVO */}
          <Card className="flex flex-wrap items-center justify-between gap-4 border-indigo-100 bg-gradient-to-r from-white to-indigo-50/40">
            <div className="space-y-1 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>Archivo: <strong>{fileName || "—"}</strong></span>
                <span>Filas totales: <strong>{data.length.toLocaleString()}</strong></span>
                <span>Seleccionadas: <strong>{selectedCount.toLocaleString()}</strong></span>
                <span>Columnas activas: <strong>{activeColCount}</strong> / {columns.length}</span>
              </div>
              <p className="text-xs text-slate-500">
                Orden de salida:{" "}
                <strong className="text-indigo-700">
                  {columns
                    .filter((c) => exportCols.has(c))
                    .map((c) => (columnRename[c] ?? c).trim() || c)
                    .join(` ${delimiter} `)}
                </strong>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs text-slate-600">
                Separador CSV:
                <select
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value as "," | ";")}
                  className="ml-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium"
                >
                  <option value=";">Punto y coma (;) · Recomendado Brevo/Excel</option>
                  <option value=",">Coma (,) · Estándar</option>
                </select>
              </label>

              {selectedCount > 0 && selectedCount !== filteredRows.length && (
                <Button
                  variant="secondary"
                  onClick={() => download("selected")}
                  disabled={activeColCount === 0}
                >
                  <Download size={16} /> Descargar seleccionadas ({selectedCount.toLocaleString()})
                </Button>
              )}

              <Button
                onClick={() => download(selectedCount > 0 ? "selected" : "filtered")}
                disabled={activeColCount === 0 || (selectedCount === 0 && filteredRows.length === 0)}
              >
                <Download size={16} /> Descargar CSV para Brevo (
                {(selectedCount > 0 ? selectedCount : filteredRows.length).toLocaleString()})
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
