import * as THREE from "three";

/** A slice of a tile's index, in index slots. */
export interface IndexRange {
  start: number;
  count: number;
}

/**
 * How Fragments packs a compacted SHELL tile index, published in
 * `geometry.userData`: packed run `i` holds the full-index slots
 * `[start[i], start[i] + count[i])` at the packed slots from `offset[i]`.
 * Runs follow the full index in order and do not overlap.
 */
interface CompactIndexRuns {
  start: ArrayLike<number>;
  count: ArrayLike<number>;
  offset: ArrayLike<number>;
}

/**
 * The packing a Fragments tile draws its index in, undefined while it draws
 * the full index. Fragments publishes a new object for every new packing, so
 * ranges mapped through one stay valid while this returns it.
 */
export function getTileIndexLayout(
  geometry: THREE.BufferGeometry,
): CompactIndexRuns | undefined {
  const { compactIndex, compactRuns } = geometry.userData as {
    compactIndex?: boolean;
    compactRuns?: CompactIndexRuns;
  };
  return compactIndex ? compactRuns : undefined;
}

/**
 * Where full-index ranges of a Fragments tile, such as item draw chunks, are
 * drawn in the tile's current index. A compacted index holds only the visible
 * runs, so the hidden parts of the ranges map to nothing; parts that meet in
 * the packing form one range.
 */
export function toDrawnIndexRanges(
  geometry: THREE.BufferGeometry,
  ranges: readonly IndexRange[],
): readonly IndexRange[] {
  const layout = getTileIndexLayout(geometry);
  if (!layout) return ranges;
  const { start: runStarts, count: runCounts, offset: runOffsets } = layout;
  const drawn: IndexRange[] = [];
  for (const range of ranges) {
    const end = range.start + range.count;
    // The first run that ends after the range starts.
    let first = 0;
    let last = runStarts.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (runStarts[middle] + runCounts[middle] <= range.start) {
        first = middle + 1;
      } else {
        last = middle;
      }
    }
    for (let i = first; i < runStarts.length && runStarts[i] < end; i++) {
      const from = Math.max(range.start, runStarts[i]);
      const to = Math.min(end, runStarts[i] + runCounts[i]);
      const at = runOffsets[i] + from - runStarts[i];
      const previous = drawn[drawn.length - 1];
      if (previous && previous.start + previous.count === at) {
        previous.count += to - from;
      } else {
        drawn.push({ start: at, count: to - from });
      }
    }
  }
  return drawn;
}
