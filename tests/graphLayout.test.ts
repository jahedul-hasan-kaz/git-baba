import { describe, expect, it } from 'vitest';
import { layoutGraph } from '../src/shared/graphLayout';

describe('layoutGraph', () => {
  it('keeps a linear history on one lane', () => {
    const { rows, maxLanes } = layoutGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(maxLanes).toBe(1);
    expect(rows[2].after).toEqual([]);
  });

  it('opens a lane for a merged branch and closes it where the branches meet', () => {
    // m merges feature (f2 -> f1) into main (b), both from a
    const { rows } = layoutGraph([
      { hash: 'm', parents: ['b', 'f2'] },
      { hash: 'f2', parents: ['f1'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'f1', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows[0]).toMatchObject({ lane: 0, isMerge: true, parentLanes: [0, 1], after: ['b', 'f2'] });
    expect(rows[1]).toMatchObject({ hash: 'f2', lane: 1 });
    expect(rows[2]).toMatchObject({ hash: 'b', lane: 0 });
    expect(rows[3]).toMatchObject({ hash: 'f1', lane: 1, after: ['a', 'a'] });
    // "a" is expected on both lanes; lane 1 converges into lane 0 at the root.
    expect(rows[4]).toMatchObject({ hash: 'a', lane: 0, after: [] });
  });

  it('reuses free lanes for new branch tips', () => {
    const { rows } = layoutGraph([
      { hash: 'x', parents: ['a'] },
      { hash: 'y', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
  });
});
