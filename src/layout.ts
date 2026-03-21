export type LayoutMode = "columns" | "stacked" | "compact";

export interface ViewportSize {
  columns: number;
  rows: number;
}

export interface AppLayout {
  mode: LayoutMode;
  viewport: ViewportSize;
  totalWidth: number;
  totalHeight: number;
  bodyHeight: number;
  leftWidth: number;
  centerWidth: number;
  contentWidth: number;
  topSectionHeight: number;
  bottomSectionHeight: number;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLUMNS = 24;
const MIN_ROWS = 8;
const CHROME_HEIGHT = 7;
const MIN_BODY_HEIGHT = 4;
const COLUMN_BREAKPOINT = 72;
const STACKED_BREAKPOINT = 48;
const LEFT_MIN = 18;
const LEFT_BASIS = 25;
const CENTER_MIN = 28;
const CENTER_BASIS = 51;

interface FlexItem {
  min: number;
  basis: number;
  grow: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeViewport(viewport?: Partial<ViewportSize> | null): ViewportSize {
  const columns = Number.isFinite(Number(viewport?.columns))
    ? Math.floor(Number(viewport?.columns))
    : DEFAULT_COLUMNS;
  const rows = Number.isFinite(Number(viewport?.rows))
    ? Math.floor(Number(viewport?.rows))
    : DEFAULT_ROWS;

  return {
    columns: Math.max(MIN_COLUMNS, columns),
    rows: Math.max(MIN_ROWS, rows)
  };
}

function resolveFlexWidths(total: number, items: FlexItem[]): number[] {
  const widths = items.map((item) => item.min);
  let remaining = total - widths.reduce((sum, value) => sum + value, 0);
  if (remaining <= 0) {
    return widths;
  }

  const desired = items.map((item, index) => Math.max(0, item.basis - widths[index]!));
  const totalDesired = desired.reduce((sum, value) => sum + value, 0);

  if (totalDesired > 0) {
    for (let index = 0; index < items.length; index += 1) {
      if (remaining <= 0) {
        break;
      }
      const share = Math.min(
        desired[index]!,
        Math.floor((remaining * desired[index]!) / totalDesired)
      );
      widths[index]! += share;
      remaining -= share;
    }

    let cursor = 0;
    while (remaining > 0) {
      if (widths[cursor]! < items[cursor]!.basis) {
        widths[cursor]! += 1;
        remaining -= 1;
      }
      cursor = (cursor + 1) % items.length;
      if (cursor === 0 && !widths.some((width, index) => width < items[index]!.basis)) {
        break;
      }
    }
  }

  const totalGrow = items.reduce((sum, item) => sum + item.grow, 0);
  if (remaining > 0 && totalGrow > 0) {
    for (let index = 0; index < items.length; index += 1) {
      if (remaining <= 0) {
        break;
      }
      const share = Math.floor((remaining * items[index]!.grow) / totalGrow);
      widths[index]! += share;
      remaining -= share;
    }
  }

  let cursor = 0;
  while (remaining > 0) {
    widths[cursor]! += 1;
    remaining -= 1;
    cursor = (cursor + 1) % items.length;
  }

  return widths;
}

export function calculateLayout(viewport?: Partial<ViewportSize> | null): AppLayout {
  const nextViewport = normalizeViewport(viewport);
  const totalWidth = nextViewport.columns;
  const totalHeight = nextViewport.rows;
  const bodyHeight = Math.max(MIN_BODY_HEIGHT, totalHeight - CHROME_HEIGHT);

  if (totalWidth < STACKED_BREAKPOINT || totalHeight < 12) {
    return {
      mode: "compact",
      viewport: nextViewport,
      totalWidth,
      totalHeight,
      bodyHeight,
      leftWidth: 0,
      centerWidth: 0,
      contentWidth: Math.max(8, totalWidth - 4),
      topSectionHeight: bodyHeight,
      bottomSectionHeight: 0
    };
  }

  if (totalWidth < COLUMN_BREAKPOINT) {
    const separatorHeight = bodyHeight >= 9 ? 1 : 0;
    const topSectionHeight = clamp(Math.floor((bodyHeight - separatorHeight) * 0.36), 3, Math.max(3, bodyHeight - separatorHeight - 3));
    const bottomSectionHeight = Math.max(3, bodyHeight - separatorHeight - topSectionHeight);

    return {
      mode: "stacked",
      viewport: nextViewport,
      totalWidth,
      totalHeight,
      bodyHeight,
      leftWidth: 0,
      centerWidth: 0,
      contentWidth: Math.max(12, totalWidth - 3),
      topSectionHeight,
      bottomSectionHeight
    };
  }

  const [leftWidth, centerWidth] = resolveFlexWidths(totalWidth - 4, [
    { min: LEFT_MIN, basis: LEFT_BASIS, grow: 1 },
    { min: CENTER_MIN, basis: CENTER_BASIS, grow: 3 }
  ]);

  return {
    mode: "columns",
    viewport: nextViewport,
    totalWidth,
    totalHeight,
    bodyHeight,
    leftWidth,
    centerWidth,
    contentWidth: 0,
    topSectionHeight: 0,
    bottomSectionHeight: 0
  };
}
