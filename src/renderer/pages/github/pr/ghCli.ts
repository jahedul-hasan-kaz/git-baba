import { useCallback, useState } from 'react';
import type { PrCliAction } from '../../../../shared/github';
import { call } from '../../../services/api';
import { useApp } from '../../../state/AppState';

type Extra = { body?: string; title?: string; method?: 'merge' | 'squash' | 'rebase'; deleteBranch?: boolean };

/** Runs a `gh pr …` action with the user's own GitHub CLI login. Returns true on success. */
export function useGhCli(repoId: string, number: number, onDone: () => void) {
  const { toast, showError } = useApp();
  const [busy, setBusy] = useState<PrCliAction | null>(null);
  const run = useCallback(
    async (action: PrCliAction, extra: Extra = {}, success?: string): Promise<boolean> => {
      setBusy(action);
      try {
        await call('gh:prCli', { repoId, number, action, ...extra, confirmed: true });
        toast(success ?? 'Done with GitHub CLI');
        onDone();
        return true;
      } catch (err) {
        showError(err);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [repoId, number, onDone, toast, showError],
  );
  return { busy, run };
}

/** API errors that a GitHub CLI login may get around (token permissions, not GitHub rules). */
export const isTokenProblem = (code: string | undefined) => code === 'pat-permission' || code === 'forbidden' || code === 'sso-required';
