import { useEffect, useRef, useState } from 'react';

const LEAGUE_ID = 1686849;
const DISMISSED_KEY = `fpl-league-${LEAGUE_ID}-prompt-complete`;
const JOIN_URL = `https://fantasy.premierleague.com/leagues/auto-join/${LEAGUE_ID}`;

export function JoinLeaguePrompt() {
  const [show, setShow] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {}
    const timer = window.setTimeout(() => setShow(true), 900);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!show) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    overlayRef.current?.querySelector<HTMLAnchorElement>('.league-prompt-primary')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = [...overlayRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [show]);

  const complete = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {}
    setShow(false);
  };

  if (!show) return null;

  return (
    <div ref={overlayRef} className="install-prompt-overlay" role="dialog" aria-modal="true" aria-labelledby="league-prompt-title">
      <div className="install-prompt-sheet league-prompt-sheet">
        <div className="install-prompt-handle" />
        <div className="league-prompt-icon" aria-hidden="true">
          <span className="material-symbols-outlined">trophy</span>
        </div>
        <h2 id="league-prompt-title" className="install-prompt-title">Join Our FPL League</h2>
        <p className="install-prompt-tagline">League {LEAGUE_ID}</p>
        <p className="install-prompt-desc">
          Put the Smart Team to the test against the FPL Manager Analytics community. FPL will open so you can confirm your entry.
        </p>
        <div className="install-prompt-actions">
          <button className="install-prompt-btn install-prompt-btn-secondary" type="button" onClick={complete}>
            Don't show again
          </button>
          <a className="install-prompt-btn install-prompt-btn-primary league-prompt-primary" href={JOIN_URL} target="_blank" rel="noopener noreferrer" onClick={complete}>
            Join league
          </a>
        </div>
      </div>
    </div>
  );
}
