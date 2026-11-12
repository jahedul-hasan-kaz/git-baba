import { useState } from "react";
import { Modal } from "../../../components/Modal";
import { openExternal } from "../../../components/github/SecureActionDialog";
import { useApp } from "../../../state/AppState";
import { AccountsPage } from "../../AccountsPage";

type HandOff = "rename" | "delete" | null;

/**
 * Accounts known to Git Baba (add, authenticate, remember, remove) plus the account-level actions GitHub only
 * allows on github.com (rename, delete): a guided, explained hand-off that ends on the exact settings page.
 */
export function AccountSecurity() {
  const { activeAccount } = useApp();
  const [handOff, setHandOff] = useState<HandOff>(null);
  const login = activeAccount?.login ?? "";

  return (
    <div>
      <AccountsPage />

      {login && (
        <>
          <h3 className="ax-sub-h">Actions on github.com for {login}</h3>
          <div className="handoff-grid">
            <div className="handoff-card">
              <div className="handoff-ico">✎</div>
              <div className="grow">
                <strong>Change username</strong>
                <div className="small muted">
                  Renames {login || "your account"} on GitHub. Old links
                  redirect for a while, but anyone can claim the old name later.
                </div>
              </div>
              <button
                className="btn sm"
                disabled={!login}
                onClick={() => setHandOff("rename")}
              >
                Start…
              </button>
            </div>
            <div className="handoff-card danger">
              <div className="handoff-ico">🗑</div>
              <div className="grow">
                <strong>Delete account</strong>
                <div className="small muted">
                  Permanently deletes {login || "the account"}, its repositories
                  and contributions. Organisations you solely own must be
                  transferred first.
                </div>
              </div>
              <button
                className="btn sm danger"
                disabled={!login}
                onClick={() => setHandOff("delete")}
              >
                Start…
              </button>
            </div>
          </div>
        </>
      )}

      {handOff && (
        <HandOffDialog
          kind={handOff}
          login={login}
          onClose={() => setHandOff(null)}
        />
      )}
    </div>
  );
}

const CHECKS: Record<Exclude<HandOff, null>, string[]> = {
  rename: [
    "I will update the remote URLs of my local clones (Git Baba shows them in each repository’s Settings).",
    "I understand GitHub Pages sites and container image names change with the username.",
    "I know someone else may register my old username afterwards.",
  ],
  delete: [
    "I have backed up or transferred every repository I want to keep.",
    "I have transferred ownership of organisations I solely own.",
    "I understand this cannot be undone and my username becomes available to others.",
  ],
};

/**
 * GitHub's API cannot rename or delete a personal account, so this never pretends to: it explains the
 * impact, has the user tick each consequence and type the login, then opens the exact github.com page
 * where GitHub asks for its own sudo confirmation.
 */
function HandOffDialog({
  kind,
  login,
  onClose,
}: {
  kind: Exclude<HandOff, null>;
  login: string;
  onClose: () => void;
}) {
  const [ticks, setTicks] = useState<boolean[]>(CHECKS[kind].map(() => false));
  const [typed, setTyped] = useState("");
  const ready = ticks.every(Boolean) && typed === login;
  const del = kind === "delete";

  return (
    <Modal
      title={del ? "Delete your GitHub account" : "Change your username"}
      icon={del ? "🗑" : "✎"}
      onClose={onClose}
      footer={
        <>
          <button className="btn cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${del ? "danger solid" : "primary"}`}
            disabled={!ready}
            onClick={() => {
              openExternal("https://github.com/settings/admin");
              onClose();
            }}
          >
            Continue on github.com ↗
          </button>
        </>
      }
    >
      <div className={`banner ${del ? "danger" : "warn"} small`}>
        <span className="icon">⚠</span>
        <div>
          For your security GitHub only allows this on github.com, where it
          re-asks for your password or passkey. Git Baba never handles it: it
          opens the right page after you have checked the points below.
        </div>
      </div>
      <div className="checklist">
        {CHECKS[kind].map((c, i) => (
          <label key={c} className={`check-item ${ticks[i] ? "done" : ""}`}>
            <input
              type="checkbox"
              checked={ticks[i]}
              onChange={(e) =>
                setTicks((t) =>
                  t.map((x, j) => (j === i ? e.target.checked : x)),
                )
              }
            />
            <span>{c}</span>
          </label>
        ))}
      </div>
      <div className={`field mt ${typed && typed !== login ? "invalid" : ""}`}>
        <label>
          Type your username <strong className="mono">{login}</strong> to
          continue
        </label>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </Modal>
  );
}
