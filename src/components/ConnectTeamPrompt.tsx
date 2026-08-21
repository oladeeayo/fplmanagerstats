import { useEffect, useRef, useState } from 'react';

const DISMISSED_KEY = 'fpl-connect-team-prompt-dismissed';
const DISMISSED_EXPIRY = 7 * 24 * 60 * 60 * 1000;
const MIN_DELAY = 5 * 60 * 1000;
const RANDOM_WINDOW = 2 * 60 * 1000;

function wasRecentlyDismissed() {
  try {
    const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY));
    if (!dismissedAt) return false;
    if (Date.now() - dismissedAt > DISMISSED_EXPIRY) {
      localStorage.removeItem(DISMISSED_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function ConnectTeamPrompt() {
  const [show, setShow] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (window.FPL?.state.managerId || wasRecentlyDismissed()) return;
    const delay = MIN_DELAY + Math.floor(Math.random() * RANDOM_WINDOW);
    let cancelled = false;
    let timer: number;
    const tryShow = () => {
      if (cancelled || window.FPL?.state.managerId) return;
      if (document.querySelector('.dialog-overlay.active, .install-prompt-overlay')) {
        timer = window.setTimeout(tryShow, 30000);
        return;
      }
      setShow(true);
    };
    timer = window.setTimeout(tryShow, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!show) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    overlayRef.current?.querySelector<HTMLButtonElement>('.connect-team-prompt-primary')?.focus();
    const connectionCheck = window.setInterval(() => {
      if (window.FPL?.state.managerId) setShow(false);
    }, 1000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = [...overlayRef.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearInterval(connectionCheck);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [show]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, String(Date.now())); } catch {}
    setShow(false);
  };

  const connect = () => {
    setShow(false);
    window.setTimeout(() => window.FPL?.showDialog('connect-dialog'), 0);
  };

  if (!show) return null;

  return (
    <div ref={overlayRef} className="install-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="connect-team-prompt-title" onClick={dismiss}>
      <div className="install-prompt-sheet connect-team-prompt-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="install-prompt-handle" />
        <div className="connect-team-prompt-icon" aria-hidden="true"><span className="material-symbols-outlined">link</span></div>
        <h2 id="connect-team-prompt-title" className="install-prompt-title">Make the analysis yours</h2>
        <p className="install-prompt-tagline">Connect your FPL team</p>
        <p className="install-prompt-desc">See recommendations, captain picks and transfer analysis based on your current squad.</p>
        <div className="install-prompt-actions">
          <button className="install-prompt-btn install-prompt-btn-secondary" type="button" onClick={dismiss}>Not now</button>
          <button className="install-prompt-btn install-prompt-btn-primary connect-team-prompt-primary" type="button" onClick={connect}>Connect team</button>
        </div>
      </div>
    </div>
  );
}
