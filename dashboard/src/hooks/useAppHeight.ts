'use client';

import { useEffect } from 'react';

/** Below this the difference is the URL bar collapsing, not a keyboard. */
const KEYBOARD_THRESHOLD_PX = 120;

/**
 * Keeps `--app-height` equal to the height a fixed app shell can actually
 * occupy, and stops the document itself from scrolling while that shell is
 * mounted.
 *
 * The problem it solves is specific to iOS: opening the software keyboard
 * shrinks the *visual* viewport but leaves the layout viewport — and therefore
 * every `dvh` unit — at its full height. A chat composer pinned to the bottom
 * of a `100dvh` shell is then rendered behind the keyboard, exactly when
 * someone is trying to type. Android is already handled declaratively by
 * `interactiveWidget: 'resizes-content'` in the root viewport export.
 *
 * Pinch-zoom shrinks the visual viewport too, so zoom is explicitly ignored —
 * reacting to it would collapse the shell around a reader who is only trying
 * to magnify a receipt.
 */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;

    document.body.classList.add('app-shell-locked');

    if (!viewport) {
      return () => document.body.classList.remove('app-shell-locked');
    }

    const sync = () => {
      const zoomed = viewport.scale > 1.01;
      const keyboardOpen = window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX;

      // Only override while the keyboard is actually up. Everywhere else the
      // native `100dvh` tracks browser chrome better than any JS mirror can.
      if (zoomed || !keyboardOpen) {
        root.style.removeProperty('--app-height');
        return;
      }
      root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    };

    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);

    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      root.style.removeProperty('--app-height');
      document.body.classList.remove('app-shell-locked');
    };
  }, []);
}
