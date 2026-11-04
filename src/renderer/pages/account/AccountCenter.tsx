import { useState } from "react";
import type { AccountProfile } from "../../../shared/github";
import { Avatar, SessionGate } from "../../components/github/common";
import { openExternal } from "../../components/github/SecureActionDialog";
import { accountStatus } from "../../components/AccountSwitcher";
import {
  AddAccountDialog,
  type SignInMethod,
} from "../../dialogs/AddAccountDialog";
import { useApp } from "../../state/AppState";
import { AccountRepos } from "./AccountRepos";
import { ProfileOverview } from "./ProfileOverview";
import { AccountSecurity } from "./settings/AccountSecurity";
import { CredentialsPage } from "./settings/CredentialsPage";
import { KeysPage } from "./settings/KeysPage";
import { PublicProfile } from "./settings/PublicProfile";

type Tab = "overview" | "repos" | "settings";
type Section = "profile" | "account" | "keys" | "credentials";

const SECTIONS: { id: Section; icon: string; label: string; hint: string }[] = [
  {
    id: "account",
    icon: "👤",
    label: "Accounts & sign-in",
    hint: "Add, switch, sign in",
  },
  {
    id: "profile",
    icon: "🪪",
    label: "Public profile",
    hint: "Name, bio, links",
  },
  {
    id: "keys",
    icon: "🔑",
    label: "SSH & GPG keys",
    hint: "Create, upload, remove",
  },
  {
    id: "credentials",
    icon: "🧩",
    label: "Credentials & Apps",
    hint: "Everything at a glance",
  },
];

/** Account level: who you are on GitHub, your repositories, and account-wide settings. */
export function AccountCenter() {
  const { activeAccount, session } = useApp();
  const [tab, setTab] = useState<Tab>(activeAccount ? "overview" : "settings");
  const [section, setSection] = useState<Section>("account");
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [signIn, setSignIn] = useState<{
    initial?: SignInMethod;
    upgrade: boolean;
  } | null>(null);
  const st = activeAccount
    ? accountStatus(activeAccount, !!session?.active)
    : null;

  /** Without an account the GitHub-data tabs show a friendly invitation instead of a form. */
  const noAccount = (what: string) => (
    <div className="ax-acc-empty">
      <div className="ax-acc-empty-ico">👋</div>
      <div className="grow">
        <strong>Sign in to see {what}</strong>
        <div className="small muted">
          Optional — your local repositories, commits, push and pull work
          without a GitHub account.
        </div>
      </div>
      <button
        className="btn primary sm"
        onClick={() => setSignIn({ initial: "browser", upgrade: false })}
      >
        🌐 Sign in with browser
      </button>
      <button className="btn sm" onClick={() => setSignIn({ upgrade: false })}>
        Other ways…
      </button>
    </div>
  );

  return (
    <div className="content account-center">
      <div className="acct-hero">
        <Avatar login={activeAccount?.login ?? "?"} size={56} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="acct-name">
            {profile?.name ||
              activeAccount?.name ||
              activeAccount?.login ||
              "No account selected"}
          </div>
          <div className="small muted">
            {activeAccount ? (
              <>
                {activeAccount.login}
                {st && (
                  <span
                    className={`ax-chip ${st.tone}`}
                    title={st.title}
                    style={{ marginLeft: 8 }}
                  >
                    {st.label}
                  </span>
                )}
                {profile?.bio ? ` · ${profile.bio}` : ""}
              </>
            ) : (
              "No account yet — optional. Sign in for your profile, pull requests and Actions."
            )}
          </div>
        </div>
        {profile && (
          <div className="acct-stats">
            <span>
              <strong>{profile.ownedRepos}</strong> repos
            </span>
            <span>
              <strong>{profile.followers}</strong> followers
            </span>
            <span>
              <strong>{profile.contributions.total.toLocaleString()}</strong>{" "}
              contributions
            </span>
          </div>
        )}
        {activeAccount && !session?.active && (
          <button
            className="btn sm primary"
            onClick={() => setSignIn({ upgrade: true })}
          >
            {activeAccount.method === "ssh" ? "⬆ Upgrade sign-in" : "Sign in"}
          </button>
        )}
        {!activeAccount && (
          <button
            className="btn sm primary"
            onClick={() => setSignIn({ initial: "browser", upgrade: false })}
          >
            🌐 Sign in
          </button>
        )}
        {activeAccount && (
          <button
            className="btn sm ghost"
            onClick={() =>
              openExternal(`https://github.com/${activeAccount.login}`)
            }
          >
            View on GitHub ↗
          </button>
        )}
      </div>

      <div className="tabs" style={{ margin: "12px 0 16px" }}>
        {(
          [
            ["overview", "Overview"],
            ["repos", "Repositories"],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <div
            key={id}
            className={`tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </div>
        ))}
      </div>

      {tab === "overview" &&
        (activeAccount ? (
          <SessionGate what="your profile">
            <ProfileOverview onProfile={setProfile} />
          </SessionGate>
        ) : (
          noAccount("your profile")
        ))}
      {tab === "repos" &&
        (activeAccount ? (
          <SessionGate what="your repositories">
            <AccountRepos />
          </SessionGate>
        ) : (
          noAccount("your GitHub repositories")
        ))}
      {tab === "settings" && (
        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item ${section === s.id ? "on" : ""}`}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-nav-ico">{s.icon}</span>
                <span className="grow">
                  <span className="settings-nav-label">{s.label}</span>
                  <span className="settings-nav-hint">{s.hint}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <h2 style={{ marginTop: 0 }}>
              {SECTIONS.find((s) => s.id === section)!.label}
            </h2>
            {section === "account" ? (
              <AccountSecurity />
            ) : !activeAccount ? (
              noAccount(
                SECTIONS.find((s) => s.id === section)!.label.toLowerCase(),
              )
            ) : (
              <SessionGate
                what={SECTIONS.find(
                  (s) => s.id === section,
                )!.label.toLowerCase()}
              >
                {section === "profile" && <PublicProfile />}
                {section === "keys" && <KeysPage />}
                {section === "credentials" && <CredentialsPage />}
              </SessionGate>
            )}
          </div>
        </div>
      )}
      {signIn && (
        <AddAccountDialog
          account={signIn.upgrade ? (activeAccount ?? undefined) : undefined}
          initial={signIn.initial}
          onClose={() => setSignIn(null)}
        />
      )}
    </div>
  );
}
