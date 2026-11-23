const $ = (id) => document.getElementById(id);
let enabled = false;

function showStatus(st) {
  $('dot').className = `dot ${enabled ? st?.state || '' : ''}`;
  $('status').textContent = enabled ? st?.text || 'Starting…' : 'Online sync is off. Entries are kept on this computer only.';
  $('now').disabled = !enabled;
  $('off').disabled = !enabled;
}

function message(text, ok) {
  $('msg').textContent = text || '';
  $('msg').className = `msg ${ok ? 'ok' : 'err'}`;
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  btn.textContent = label;
  message('');
  try {
    const res = await fn();
    message(res.ok ? res.message : res.error, res.ok);
    return res;
  } finally {
    btn.textContent = old;
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
    const s = await window.syncApi.get();
    enabled = s.enabled;
    showStatus(s.status);
  }
}

async function load() {
  const s = await window.syncApi.get();
  enabled = s.enabled;
  $('dbName').value = s.dbName;
  if (s.hasUri) {
    $('uri').placeholder = 'Saved (leave empty to keep it)';
  }
  showStatus(s.status);
}

const values = () => ({ uri: $('uri').value, dbName: $('dbName').value });

$('test').addEventListener('click', () => busy($('test'), 'Testing…', () => window.syncApi.save({ ...values(), testOnly: true })));
$('save').addEventListener('click', async () => {
  const res = await busy($('save'), 'Connecting…', () => window.syncApi.save(values()));
  if (res.ok) {
    $('uri').value = '';
    $('uri').placeholder = 'Saved (leave empty to keep it)';
  }
});
$('off').addEventListener('click', () => busy($('off'), 'Turning off…', () => window.syncApi.disable()));
$('now').addEventListener('click', async () => {
  await window.syncApi.now();
  message('Checking for changes to upload…', true);
});

window.syncApi.onStatus(showStatus);
load();
