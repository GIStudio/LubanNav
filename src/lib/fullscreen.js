import { useEffect, useState } from 'preact/hooks';

/**
 * Best-effort fullscreen support across browsers (standard + webkit prefix).
 * Shared by the landing topbar and the system-menu button.
 * Returns { supported, isFullscreen, toggle } where toggle flips the state
 * and reports whether it is entering fullscreen.
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const supported = typeof document !== 'undefined'
    && Boolean(
      document.documentElement.requestFullscreen
      || document.documentElement.webkitRequestFullscreen,
    );

  useEffect(() => {
    if (!supported) return undefined;
    const sync = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || document.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [supported]);

  function toggle() {
    const doc = document;
    const root = doc.documentElement;
    const active = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (active) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      return false;
    }
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    return true;
  }

  return { supported, isFullscreen, toggle };
}
