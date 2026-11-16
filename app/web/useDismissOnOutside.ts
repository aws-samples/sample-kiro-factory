import { useEffect, useRef } from 'react';

/**
 * Shut a menu when the pointer goes down outside it, or on Escape.
 *
 * Returns the ref to put on the menu's root. The picks in FactoryView and the remote options menu use it, which is why
 * it is a hook rather than the same effect written twice: they are the same control
 * with different contents, and a dismissal rule that drifted between them would be
 * the kind of difference nobody notices until one of them feels broken.
 *
 * `pointerdown` rather than `click`, so the menu is gone before whatever was clicked
 * behind it reacts. It fires ahead of the native `<summary>` toggle too, which is
 * what makes clicking the *other* menu's summary work: this one shuts on the press,
 * that one opens on the click, and the exclusivity guard in `openPick` sorts out the
 * two toggle events that arrive from it.
 *
 * A press inside the menu is left alone - ticking a checkbox is not leaving, and the
 * whole point of this dropdown is ticking several things before you go.
 *
 * Escape comes along because it is the same gesture by another means, and the folder
 * picker already answers it. Listening only while open keeps both handlers off the
 * document the rest of the time.
 */
export function useDismissOnOutside<T extends HTMLElement = HTMLDetailsElement>(
  open: boolean,
  onClose: () => void,
) {
  const root = useRef<T>(null);
  // The latest callback, read at event time. In the dependency list it would
  // re-register both listeners on every render, since every caller passes a fresh
  // arrow - this keeps the effect keyed on the one thing that matters.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return root;
}
