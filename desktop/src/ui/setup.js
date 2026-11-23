const $ = (id) => document.getElementById(id);
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
    $('error').textContent = String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('submit').disabled = false;
    $('submit').textContent = LABEL;
  }
});
