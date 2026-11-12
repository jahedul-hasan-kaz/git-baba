import { describe, expect, it } from 'vitest';
import { parseLabelGate } from '../src/main/github/services/workflows';

describe('parseLabelGate', () => {
  it('finds a label checked with contains() and the labeled trigger', () => {
    const yaml = `name: guard
on:
  pull_request:
    types: [opened, synchronize, labeled, unlabeled]
jobs:
  guard:
    if: contains(github.event.pull_request.labels.*.name, 'ready-for-merge')
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
    const g = parseLabelGate(yaml);
    expect(g.requiredLabels).toEqual(['ready-for-merge']);
    expect(g.blockingLabels).toEqual([]);
    expect(g.onPullRequest).toBe(true);
    expect(g.reactsToLabeling).toBe(true);
  });

  it('treats negated checks as blocking labels and notes a missing labeled trigger', () => {
    const yaml = `name: Merge guard
on: pull_request
jobs:
  check:
    if: \${{ !contains(github.event.pull_request.labels.*.name, 'do-not-merge') && contains(github.event.pull_request.labels.*.name, "approved") }}
    runs-on: ubuntu-latest
    steps: []
`;
    const g = parseLabelGate(yaml);
    expect(g.requiredLabels).toEqual(['approved']);
    expect(g.blockingLabels).toEqual(['do-not-merge']);
    expect(g.reactsToLabeling).toBe(false);
    expect(g.onPullRequest).toBe(true);
  });

  it('reads the labels input of a required-labels action', () => {
    const yaml = `name: Labels
on:
  pull_request:
    types: [labeled, opened]
jobs:
  l:
    runs-on: ubuntu-latest
    steps:
      - uses: mheap/github-action-required-labels@v5
        with:
          mode: minimum
          count: 1
          labels: "bug, enhancement"
`;
    const g = parseLabelGate(yaml);
    expect(g.requiredLabels).toEqual(['bug', 'enhancement']);
    expect(g.reactsToLabeling).toBe(true);
  });

  it('ignores workflows that do not look at labels', () => {
    const g = parseLabelGate('name: build\non: [push]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps: []\n');
    expect(g.requiredLabels).toEqual([]);
    expect(g.onPullRequest).toBe(false);
  });
});
