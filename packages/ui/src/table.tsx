import type { ReactNode } from "react";

export type TableColumn<Row> = {
  /** The column header above tablet width, and the label on the card cell below it. */
  header: string;
  cell: (row: Row) => ReactNode;
};

/**
 * One table that becomes labelled cards below tablet width.
 *
 * Below 768px the CSS switches the table elements to `display: block`, which is what produces the cards.
 * Browsers derive table semantics from the computed display, so that switch would otherwise strip the
 * table, row and cell roles out of the accessibility tree and leave a pile of unlabelled text. The
 * explicit roles below put them back. They read as redundant in the markup, and they are redundant at
 * desktop width, but CSS cannot add a role at a breakpoint, so they have to be written unconditionally.
 */
export function ResponsiveTable<Row>({
  columns,
  rows,
  rowKey,
  rowSelected,
  showHeader = true,
}: {
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  rowSelected?: (row: Row) => boolean;
  showHeader?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit table role.
    <table className="responsive-table" role="table">
      {showHeader ? (
        // biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit rowgroup role.
        <thead role="rowgroup">
          {/* biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit row role. */}
          <tr role="row">
            {columns.map((column) => (
              // biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit columnheader role.
              <th key={column.header} role="columnheader" scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      {/* biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit rowgroup role. */}
      <tbody role="rowgroup">
        {rows.map((row) => (
          // biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit row role.
          <tr key={rowKey(row)} role="row" aria-selected={rowSelected === undefined ? undefined : rowSelected(row)}>
            {columns.map((column) => (
              // biome-ignore lint/a11y/noRedundantRoles: the mobile card reflow strips the implicit cell role.
              <td key={column.header} role="cell" data-label={column.header}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
