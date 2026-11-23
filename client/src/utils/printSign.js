// "Signature" tick box for printing: when it is off, every signature block (.doc-sign) is left off the
// printed page — Print buttons, Save & Print and Ctrl+P alike. Remembered on this computer; on by default.
import { useEffect, useState } from 'react';

const KEY = 'mes-print-signatures';
const EVENT = 'mes-print-signatures';

function read() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

function apply(on) {
  document.documentElement.classList.toggle('print-no-sign', !on);
}

apply(read());

export function setPrintSignatures(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered; still applies until the page is reloaded */
  }
  apply(on);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** [on, setOn] — every tick box on screen stays in step. */
export function usePrintSignatures() {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = (e) => setOn(e.detail);
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [on, setPrintSignatures];
}
