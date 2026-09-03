import { useEffect, useRef, useState, useCallback } from 'react';

const DISMISSED_KEY = 'fpl-install-dismissed';
const DISMISSED_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as any).standalone === true;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function wasDismissed(): boolean {
  try {
    const val = localStorage.getItem(DISMISSED_KEY);
    if (!val) return false;
    const ts = Number(val);
    if (Date.now() - ts > DISMISSED_EXPIRY) {
      localStorage.removeItem(DISMISSED_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function InstallPrompt() {
  const [show, setShow] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOSDevice, setIsIOS] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  const scheduleShow = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setShow(true), 3000);
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {}
  }, []);

  useEffect(() => {
    if (isStandalone() || !isMobile() || wasDismissed()) return;

    setIsIOS(isIOS());

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      scheduleShow();
    };

    window.addEventListener('beforeinstallprompt', handler);

    if (isIOS() && !wasDismissed()) {
      scheduleShow();
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      if (showTimer.current) clearTimeout(showTimer.current);
    };
  }, [scheduleShow]);

  const handleInstall = useCallback(async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        dismiss();
      }
      setDeferredPrompt(null);
    } else if (navigator.share) {
      try {
        await navigator.share({
          title: 'FPL Manager Analytics',
          text: 'Track. Analyse. Dominate.',
          url: window.location.href,
        });
      } catch {}
      dismiss();
    } else {
      dismiss();
    }
  }, [deferredPrompt, dismiss]);

  useEffect(() => {
    if (!show) return;
    lastTriggerRef.current = document.activeElement as HTMLElement | null;
    const primary = overlayRef.current?.querySelector<HTMLButtonElement>('.install-prompt-btn-primary');
    primary?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = [...overlayRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      lastTriggerRef.current?.focus?.();
      lastTriggerRef.current = null;
    };
  }, [show, dismiss]);

  if (!show) return null;

  return (
    <div
      ref={overlayRef}
      className="install-prompt-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-prompt-title"
      onClick={dismiss}
    >
      <div className="install-prompt-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="install-prompt-handle" />

        <div className="install-prompt-icon">
          <img src="/favicon.svg?v=8" alt="FPL Manager Analytics" width={72} height={72} />
        </div>

        <h2 id="install-prompt-title" className="install-prompt-title">Install FPL Manager Analytics</h2>
        <p className="install-prompt-tagline">Track. Analyse. Dominate.</p>

        {isIOSDevice ? (
          <p className="install-prompt-desc">
            Tap <strong>Got it</strong> to open the share sheet, then select <strong>"Add to Home Screen"</strong>.
          </p>
        ) : (
          <p className="install-prompt-desc">
            Add to your home screen for instant access — no app store needed.
          </p>
        )}

        <div className="install-prompt-actions">
          <button className="install-prompt-btn install-prompt-btn-secondary" onClick={dismiss}>
            Not now
          </button>
          <button className="install-prompt-btn install-prompt-btn-primary" onClick={handleInstall}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}