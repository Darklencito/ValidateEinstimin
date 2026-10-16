"use client";

import { useMemo, useRef, useState } from "react";
import {
  ColumnDef, ColumnFiltersState, RowSelectionState, SortingState,
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel,
  getSortedRowModel, useReactTable,
} from "@tanstack/react-table";
import {
  AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight,
  Download, FileUp, Plus, Search, Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Row, downloadCsv, parseCsvFile, toCsv } from "@/lib/csv";

const TEMPLATE_COLUMNS = ["nombre", "email", "telefono", "ciudad"];
const MAX_BYTES = 10 * 1024 * 1024;

export default function ConstructorCSV() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  // Las claves son el índice de la fila en `data` (getRowId), así la selección
  // se conserva al ordenar, filtrar o cambiar de página.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [exportCols, setExportCols] = useState<Set<string>>(new Set());
  const [newRow, setNewRow] = useState<Row | null>(null);

  function loadData(rows: Row[], cols: string[], name: string) {
    setData(rows);
    setColumns(cols);
    setExportCols(new Set(cols));
    setRowSelection({});
    setSorting([]);
    setColumnFilters([]);
    setGlobalFilter("");
    setFileName(name);
    setError("");
  }

  async function handleFile(file: File) {
    if (!/\.csv$/i.test(file.name)) return setError("El archivo debe tener extensión .csv");
    if (file.size > MAX_BYTES) return setError("El archivo supera los 10 MB");
    const { rows, columns: cols, errors } = await parseCsvFile(file);
    if (cols.length === 0 || rows.length === 0) {
      return setError("El CSV está vacío o no tiene fila de cabecera");
    }
    loadData(rows, cols, file.name);
    if (errors.length) setError(`CSV cargado con avisos: ${errors[0]}`);
  }

  const tableColumns = useMemo<ColumnDef<Row>[]>(
    () => columns.map((c) => ({ id: c, header: c, accessorFn: (r) => r[c] ?? "" })),
    [columns]
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
    // Filtro por texto insensible a mayúsculas
    defaultColumn: { filterFn: "includesString" },
  });

  const filteredRows = table.getFilteredRowModel().rows;
  const selectedCount = Object.keys(rowSelection).length;
  const allFilteredSelected =
    filteredRows.length > 0 && filteredRows.every((r) => rowSelection[r.id]);

  // "Seleccionar todo" actúa sobre todas las filas filtradas, no solo la página visible
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

  function download() {
    const cols = columns.filter((c) => exportCols.has(c)); // conserva el orden original
    const rows = Object.keys(rowSelection)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => data[i]);
    downloadCsv("clientes_seleccion.csv", toCsv(rows, cols));
  }

  function addRow() {
    if (!newRow) return;
    const rows = [...data, newRow];
    setData(rows);
    setNewRow(null);
  }

  const canDownload = selectedCount > 0 && exportCols.size > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Constructor de CSV</h1>
        <p className="text-sm text-slate-500">
          Carga un CSV de clientes, filtra, elige filas y columnas y descarga el resultado.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} /> {error}
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
            <p className="text-sm font-medium">Arrastra tu CSV base aquí o haz clic para seleccionarlo</p>
            <p className="text-xs text-slate-500">Máx. 10 MB · la primera fila debe ser la cabecera</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
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
                loadData([], TEMPLATE_COLUMNS, "manual");
                setNewRow(Object.fromEntries(TEMPLATE_COLUMNS.map((c) => [c, ""])));
              }}
            >
              Empezar con una tabla vacía y añadir filas con un formulario
            </button>
          </div>
        </Card>
      ) : null}

      {columns.length > 0 && (
        <>
          {/* Barra de herramientas */}
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
                onClick={() => { setData([]); setColumns([]); setRowSelection({}); setFileName(""); }}
              >
                <Trash2 size={16} /> Descartar datos
              </Button>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Columnas a incluir en el CSV final</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {columns.map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={exportCols.has(c)} onChange={() => toggleCol(c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>

            {newRow && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                <p className="mb-2 text-sm font-medium">Nueva fila</p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {columns.map((c) => (
                    <Input
                      key={c}
                      placeholder={c}
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

          {/* Tabla */}
          <Card className="p-0">
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
                        return (
                          <th key={h.id} className="min-w-[9rem] px-3 py-2 align-top">
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
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id} className={rowSelection[row.id] ? "bg-indigo-50" : "hover:bg-slate-50"}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label="Seleccionar fila"
                          checked={!!rowSelection[row.id]}
                          onChange={row.getToggleSelectedHandler()}
                        />
                      </td>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
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

          {/* Pie: resumen + descarga */}
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>Archivo: <strong>{fileName || "—"}</strong></span>
              <span>Filas totales: <strong>{data.length}</strong></span>
              <span>Filas seleccionadas: <strong>{selectedCount}</strong></span>
              <span>Columnas seleccionadas: <strong>{exportCols.size}</strong> / {columns.length}</span>
            </div>
            <Button onClick={download} disabled={!canDownload}>
              <Download size={16} /> Descargar CSV resultante
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
