// Lane layout for a commit graph (newest first, topological order), in the spirit of
// GitLens / `git log --graph`. Pure function so it can be unit-tested.

export interface GraphRow {
  hash: string;
  /** Lane of this commit's node. */
  lane: number;
  /** Lanes (expected next commit per lane) entering this row from above. */
  before: (string | null)[];
  /** Lanes leaving this row downwards. */
  after: (string | null)[];
  /** Lanes the edges to this commit's parents leave on (first parent first). */
  parentLanes: number[];
  isMerge: boolean;
}

export function layoutGraph(commits: { hash: string; parents: string[] }[]): { rows: GraphRow[]; maxLanes: number } {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let maxLanes = 1;

  for (const c of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      // A branch tip we have not seen yet: take the first free lane.
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    // Other lanes that were waiting for this commit merge into it here.
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null;

    const parentLanes: number[] = [];
    if (c.parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = c.parents[0];
      parentLanes.push(lane);
      for (const p of c.parents.slice(1)) {
        let j = lanes.indexOf(p);
        if (j === -1) {
          j = lanes.indexOf(null);
          if (j === -1) {
            j = lanes.length;
            lanes.push(p);
          } else lanes[j] = p;
        }
        parentLanes.push(j);
      }
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const after = lanes.slice();
    maxLanes = Math.max(maxLanes, before.length, after.length, lane + 1);
    rows.push({ hash: c.hash, lane, before, after, parentLanes, isMerge: c.parents.length > 1 });
  }
  return { rows, maxLanes };
}
