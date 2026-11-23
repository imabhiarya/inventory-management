const $ = (id) => document.getElementById(id);
const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const LABEL = 'Create administrator and continue';
// Backstop only: the main process stops the setup script after 60 s and always answers.
const UI_TIMEOUT_MS = 90_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Setup is taking too long. Please try again.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  if ($('password').value !== $('confirm').value) {
    $('error').textContent = 'The passwords do not match.';
    return;
  }
  $('submit').disabled = true;
  $('submit').textContent = 'Creating…';
  try {
    const res = await withTimeout(
      window.setup.createAdmin({
        username: $('username').value,
        name: $('name').value,
        password: $('password').value,
      }),
      UI_TIMEOUT_MS,
    );
    if (!res?.ok) throw new Error(res?.error || 'Could not create the administrator.');
    // Success: the main process closes this window and opens the sign-in screen.
  } catch (err) {
    // Electron prefixes errors thrown in the main process; show only the useful part.
    $('error').textContent = cleanError(err);
    $('submit').disabled = false;
    $('submit').textContent = LABEL;
  }
});

// ---------- Restore from the old computer's backup file ----------

const RESTORE_LABEL = 'Restore this backup and continue';
// Large backups (many attachments) can take a while; the main process stops the restore after 15 min.
const RESTORE_UI_TIMEOUT_MS = 16 * 60_000;

function setBusy(busy) {
  for (const id of ['restore-pick', 'restore-go', 'submit']) $(id).disabled = busy;
}

$('restore-pick').addEventListener('click', async () => {
  $('restore-error').textContent = '';
  try {
    const res = await window.setup.chooseBackup();
    if (res?.canceled) return;
    if (!res?.ok) {
      $('restore-picked').hidden = true;
      $('restore-go').hidden = true;
      throw new Error(res?.error || 'This file cannot be restored.');
    }
    const when = res.createdAt ? new Date(res.createdAt).toLocaleString('en-GB') : 'unknown date';
    const s = res.summary;
    $('restore-picked').textContent =
      `${res.name} — made ${when}${res.createdBy ? ` by ${res.createdBy}` : ''}: ` +
      `${s.items} items, ${s.receipts} receipts, ${s.issues} issues, ${s.users} users, ${s.files} attachments.`;
    $('restore-picked').hidden = false;
    $('restore-go').hidden = false;
  } catch (err) {
    $('restore-error').textContent = cleanError(err);
  }
});

$('restore-go').addEventListener('click', async () => {
  $('restore-error').textContent = '';
  setBusy(true);
  $('restore-go').textContent = 'Restoring… please wait';
  try {
    const res = await withTimeout(window.setup.restoreBackup(), RESTORE_UI_TIMEOUT_MS);
    if (!res?.ok) throw new Error(res?.error || 'Could not restore the backup.');
    // Success: the main process closes this window and opens the sign-in screen.
  } catch (err) {
    $('restore-error').textContent = cleanError(err);
    setBusy(false);
    $('restore-go').textContent = RESTORE_LABEL;
  }
});
