import { useEffect, useState } from 'react';
import type { AccountProfile, PublicProfilePatch } from '../../../../shared/github';
import { ErrorPanel } from '../../../components/ErrorPanel';
import { Avatar, Skeleton, useGh, useMutation } from '../../../components/github/common';
import { openExternal } from '../../../components/github/SecureActionDialog';
import { call } from '../../../services/api';

type Form = Required<Omit<PublicProfilePatch, 'hireable'>> & { hireable: boolean };

const fromProfile = (p: AccountProfile): Form => ({
  name: p.name ?? '',
  bio: p.bio ?? '',
  company: p.company ?? '',
  location: p.location ?? '',
  blog: p.blog ?? '',
  twitter_username: p.twitter ?? '',
  hireable: p.hireable,
});

/** Public profile editor with a live preview card. Only changed fields are sent. */
export function PublicProfile() {
  const profile = useGh(() => call('gh:acctProfile', {}), []);
  const [form, setForm] = useState<Form | null>(null);
  const { busy, run } = useMutation();

  useEffect(() => {
    if (profile.data) setForm(fromProfile(profile.data));
  }, [profile.data]);

  if (profile.error) return <ErrorPanel error={profile.error} />;
  if (!profile.data || !form) return <Skeleton rows={6} />;
  const orig = fromProfile(profile.data);
  const changed = (Object.keys(form) as (keyof Form)[]).filter((k) => form[k] !== orig[k]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const bioLeft = 160 - form.bio.length;
  const urlOk = !form.blog || /^https?:\/\/\S+$/.test(form.blog) || /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(form.blog);

  const save = async () => {
    const patch: PublicProfilePatch = {};
    for (const k of changed) (patch as Record<string, unknown>)[k] = form[k];
    const ok = await run(() => call('gh:acctUpdateProfile', { patch }).then(() => true), 'Public profile updated');
    if (ok) void profile.reload();
  };

  return (
    <div className="profile-editor">
      <div>
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={255} placeholder="Your name" />
        </div>
        <div className={`field ${bioLeft < 0 ? 'invalid' : ''}`}>
          <label>
            Bio <span className={`small ${bioLeft < 20 ? 'text-warn' : 'muted'}`}>{bioLeft} left</span>
          </label>
          <textarea rows={3} value={form.bio} onChange={(e) => set('bio', e.target.value)} placeholder="Tell people a little about yourself" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Company</label>
            <input value={form.company} onChange={(e) => set('company', e.target.value)} placeholder="@your-org" />
          </div>
          <div className="field">
            <label>Location</label>
            <input value={form.location} onChange={(e) => set('location', e.target.value)} />
          </div>
          <div className={`field ${urlOk ? '' : 'invalid'}`}>
            <label>Website</label>
            <input value={form.blog} onChange={(e) => set('blog', e.target.value)} placeholder="https://example.com" />
            {!urlOk && <div className="field-hint">Enter a website address.</div>}
          </div>
          <div className="field">
            <label>X / Twitter username</label>
            <input value={form.twitter_username} onChange={(e) => set('twitter_username', e.target.value.replace(/^@/, ''))} maxLength={15} placeholder="handle" />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.hireable} onChange={(e) => set('hireable', e.target.checked)} /> Available for hire
        </label>
        <div className="row mt">
          <span className="small muted grow">{changed.length ? `${changed.length} unsaved change(s): ${changed.join(', ')}` : 'No changes'}</span>
          <button className="btn" disabled={!changed.length || busy} onClick={() => setForm(orig)}>
            Reset
          </button>
          <button className="btn primary" disabled={!changed.length || busy || bioLeft < 0 || !urlOk} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
        <div className="small muted mt">
          Saved with the signed-in session. If GitHub refuses, the token needs the “user” scope (classic) or “Profile: write” (fine-grained). Profile picture and pronouns are edited on{' '}
          <a onClick={() => openExternal('https://github.com/settings/profile')}>github.com</a>.
        </div>
      </div>

      <div className="profile-preview">
        <div className="small muted mb">Live preview</div>
        <div className="preview-card">
          <Avatar login={profile.data.login} size={64} />
          <div className="preview-name">{form.name || profile.data.login}</div>
          <div className="muted">{profile.data.login}</div>
          {form.bio && <p className="preview-bio">{form.bio}</p>}
          <div className="preview-meta">
            {form.company && <div>🏢 {form.company}</div>}
            {form.location && <div>📍 {form.location}</div>}
            {form.blog && <div>🔗 {form.blog}</div>}
            {form.twitter_username && <div>𝕏 @{form.twitter_username}</div>}
            {form.hireable && <div className="text-ok">✓ Available for hire</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
