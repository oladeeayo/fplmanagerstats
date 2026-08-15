import { useEffect, useState, useCallback } from 'react';

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

  useEffect(() => {
    if (isStandalone() || !isMobile() || wasDismissed()) return;

    setIsIOS(isIOS());

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setTimeout(() => setShow(true), 3000);
    };

    window.addEventListener('beforeinstallprompt', handler);

    if (isIOS() && !wasDismissed()) {
      setTimeout(() => setShow(true), 3000);
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {}
  }, []);

  const handleInstall = useCallback(async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        dismiss();
      }
      setDeferredPrompt(null);
    } else {
      dismiss();
    }
  }, [deferredPrompt, dismiss]);

  if (!show) return null;

  return (
    <div className="install-prompt-overlay" onClick={dismiss}>
      <div className="install-prompt-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="install-prompt-handle" />

        <div className="install-prompt-icon">
          <img src="/icon-192.png" alt="FPL Stats" width={72} height={72} />
        </div>

        <h2 className="install-prompt-title">Install FPL Manager Stats</h2>
        <p className="install-prompt-tagline">Track. Analyse. Dominate.</p>

        {isIOSDevice ? (
          <p className="install-prompt-desc">
            Tap the <strong>Share</strong> icon below, then <strong>"Add to Home Screen"</strong> — no app store needed.
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
