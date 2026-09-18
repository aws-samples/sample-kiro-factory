/**
 * The confirm dialog, replacing `window.confirm`.
 *
 * A native `<dialog>` opened with `showModal()`, because the platform's modal is
 * most of the work: it traps focus, closes on Escape, layers above everything
 * without z-index bookkeeping, and returns focus to the control that opened it.
 * What the browser's own `confirm()` could not do is look like the app - this
 * one is styled like the panel it interrupts, and its buttons say what they do
 * ("Delete wire", "Close tab") instead of OK.
 *
 * Cancel takes the initial focus. Everything that asks a question here is
 * destructive - that is why it asks - so Enter on a dialog someone did not read
 * must be the safe answer.
 *
 * One component, driven by the `ask`: whoever needs a question answered holds
 * a `ConfirmAsk | null` in state and renders this with it. The dialog is only
 * mounted while a question is open, so there is exactly one in the DOM at a
 * time and it cannot leak stale callbacks.
 */
import { useEffect, useRef, useState } from 'react';

export interface ConfirmAsk {
  title: string;
  /** Explanation under the title. `\n\n` reads as a paragraph break. */
  body?: string;
  /**
   * The one thing in the question that should not be skimmed past, highlighted
   * under the body. For a caveat that makes confirming probably wrong, not for
   * restating what the body already says.
   */
  warning?: string;
  /** What the confirming button says, which is what confirming does. */
  action: string;
  onConfirm: () => void;
  /**
   * A second, harder answer the same question can have, behind a typed keyword.
   *
   * For the case where the ordinary action has a destructive sibling - closing a
   * factory versus deleting it - that belongs in the same dialog because it is
   * the same decision, but must not be reachable by a misaimed click: the button
   * stays disabled until the keyword is typed out. Typing is the confirmation;
   * there is no second dialog after it.
   */
  danger?: {
    /** What the button says, which is what it does. */
    label: string;
    /** The word to type, compared case-insensitively. */
    keyword: string;
    /** What this harder answer actually removes, above the input. */
    description: string;
    onConfirm: () => void;
  };
}

export function Confirm({ ask, onClose }: { ask: ConfirmAsk | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  /**
   * What has been typed towards the danger keyword. Lives here rather than on
   * the ask because it is the dialog's scratch, not the question.
   *
   * It is reset below every time the question changes, and that reset is load-
   * bearing. The `<dialog>` unmounts when the question closes, but this component
   * does not - its owner renders it unconditionally and it returns null - so the
   * state survived from one question to the next. Type `delete`, cancel, open the
   * next factory's close dialog, and its `Delete factory` button was already
   * enabled: the typed word is the whole protection on permanent deletion, and it
   * was being carried over to a question nobody had typed it for.
   */
  const [typed, setTyped] = useState('');
  const armed = ask?.danger !== undefined && typed.trim().toLowerCase() === ask.danger.keyword.toLowerCase();

  // `showModal` is imperative and only exists after the dialog is in the DOM,
  // so it is called from an effect rather than during render. The same effect
  // clears the typed keyword: a new question starts unarmed, whatever the last
  // one was answered with.
  useEffect(() => {
    setTyped('');
    const dialog = ref.current;
    if (ask && dialog && !dialog.open) dialog.showModal();
  }, [ask]);

  if (!ask) return null;

  return (
    <dialog
      ref={ref}
      className="confirm"
      // Escape and `close()` both end here; the owner clears its ask and this
      // unmounts. Confirmation runs its callback first, then closes the same way.
      onClose={onClose}
      // A click on the dialog element itself is a click on the backdrop - the
      // panel's content is all inside children - and means "never mind".
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <h2>{ask.title}</h2>
      {ask.body !== undefined && <p>{ask.body}</p>}
      {ask.warning !== undefined && <p className="confirm-warning">{ask.warning}</p>}
      {ask.danger !== undefined && (
        <div className="confirm-danger">
          <p>{ask.danger.description}</p>
          <div className="confirm-danger-row">
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // The browser must not fill this in either: a remembered `delete`
              // offered as a suggestion is the same misaimed click the typing is
              // there to prevent. `name` is what autofill keys on, so it gets one
              // no form has ever used.
              autoComplete="off"
              name="confirm-keyword-no-autofill"
              placeholder={`Type ${ask.danger.keyword} to enable`}
              // Enter in this input must not trigger the focused Cancel button's
              // form-like submit behaviour; when armed it means the typed word.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (armed) {
                  ask.danger!.onConfirm();
                  ref.current?.close();
                }
              }}
              aria-label={`Type ${ask.danger.keyword} to enable ${ask.danger.label}`}
            />
            <button
              className="danger"
              disabled={!armed}
              onClick={() => {
                ask.danger!.onConfirm();
                ref.current?.close();
              }}
            >
              {ask.danger.label}
            </button>
          </div>
        </div>
      )}
      <div className="confirm-actions">
        <button autoFocus onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          className="danger"
          onClick={() => {
            ask.onConfirm();
            ref.current?.close();
          }}
        >
          {ask.action}
        </button>
      </div>
    </dialog>
  );
}
