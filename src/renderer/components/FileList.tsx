import type { ReactNode } from 'react';
import type { ChangeKind, FileChange } from '../../shared/types';

const KIND_LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!',
};

const KIND_TITLE: Record<ChangeKind, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  untracked: 'Untracked (new file)',
  conflicted: 'Conflicted',
};

export function KindIcon({ kind }: { kind: ChangeKind }) {
  return (
    <span className={`kind ${kind}`} title={KIND_TITLE[kind]}>
      {KIND_LETTER[kind]}
    </span>
  );
}

interface Props {
  title: string;
  files: FileChange[];
  selectedKey: string | null;
  onSelect: (f: FileChange) => void;
  headerActions?: ReactNode;
  rowActions?: (f: FileChange) => ReactNode;
  checked?: Set<string>;
  onToggle?: (path: string) => void;
}

export function fileKey(f: FileChange): string {
  return `${f.area}:${f.path}`;
}

export function FileList({ title, files, selectedKey, onSelect, headerActions, rowActions, checked, onToggle }: Props) {
  return (
    <div className="file-section">
      <div className="file-section-header">
        <span>{title}</span>
        <span className="badge">{files.length}</span>
        <span className="spacer" />
        {headerActions}
      </div>
      {files.length === 0 && <div className="small muted" style={{ padding: '4px 12px 10px' }}>None</div>}
      {files.map((f) => (
        <div key={fileKey(f)} className={`file-row ${selectedKey === fileKey(f) ? 'selected' : ''}`} onClick={() => onSelect(f)} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
          {checked && onToggle && <input type="checkbox" checked={checked.has(f.path)} onChange={() => onToggle(f.path)} onClick={(e) => e.stopPropagation()} />}
          <KindIcon kind={f.kind} />
          <span className="path mono">
            <bdi>{f.path}</bdi>
          </span>
          {rowActions && (
            <span className="actions" onClick={(e) => e.stopPropagation()}>
              {rowActions(f)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
