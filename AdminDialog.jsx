import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * One in-app dialog for every admin confirmation and text input, replacing
 * window.confirm / window.prompt so the portal has a single look and the
 * consequences of an action are spelled out before it runs.
 *
 *   const { ask, dialog } = useAdminDialog();
 *   const ok = await ask({ title, items, confirmLabel, tone: 'danger' });
 *   if (!ok) return;            // null = cancelled
 *   ok.values.pin               // values of any `fields`
 *
 * Options:
 *   title          heading (required)
 *   body           a paragraph under the title
 *   items          bullet list of what will happen
 *   confirmLabel   says what happens ("ปิดรอบและคืน 400 pt"), never just "ตกลง"
 *   tone           'primary' (default) | 'danger' — danger is for irreversible actions
 *   typeToConfirm  text the admin must type before confirming (irreversible actions)
 *   fields         [{ name, label, type, defaultValue, placeholder, validate(v) → error|null }]
 *
 * Esc, the backdrop and "ยกเลิก" all cancel.
 */
export function useAdminDialog() {
  const [request, setRequest] = useState(null);

  const ask = useCallback((options) => new Promise((resolve) => {
    setRequest({ ...options, resolve });
  }), []);

  const close = useCallback((result) => {
    setRequest((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  const dialog = request ? <AdminDialog key={request.title} request={request} onClose={close} /> : null;
  return { ask, dialog };
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook and its dialog belong together
function AdminDialog({ request, onClose }) {
  const { title, body, items, confirmLabel = 'ยืนยัน', tone = 'primary', typeToConfirm, fields = [] } = request;
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? '']))
  );
  const [typed, setTyped] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const firstInputRef = useRef(null);
  const cancelRef = useRef(null);

  // Focus the first input; with none, start on "ยกเลิก" so a stray Enter does nothing.
  useEffect(() => {
    (firstInputRef.current || cancelRef.current)?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const errors = Object.fromEntries(
    fields.map((f) => [f.name, f.validate ? f.validate(String(values[f.name] ?? '')) : null])
  );
  const typedOk = !typeToConfirm || typed.trim() === String(typeToConfirm).trim();
  const fieldsOk = Object.values(errors).every((e) => !e);
  const canConfirm = typedOk && fieldsOk;

  const submit = (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (!canConfirm) return;
    onClose({ values: Object.fromEntries(fields.map((f) => [f.name, String(values[f.name] ?? '').trim()])) });
  };

  const danger = tone === 'danger';
  const inputClass = 'w-full min-h-[44px] px-3 rounded-md border bg-white text-[15px] text-[#16191D] outline-none focus:border-[#1E4DB7] focus:ring-2 focus:ring-[#1E4DB7]/20';

  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-[#16191D]/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(null); }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-dialog-title"
        onSubmit={submit}
        className="w-full max-w-[440px] bg-white rounded-[10px] border border-[#D9DDE2] shadow-[0_12px_32px_rgba(22,25,29,0.16)] text-[#16191D]"
      >
        <div className="px-5 pt-5 flex flex-col gap-3">
          <h2 id="admin-dialog-title" className={`m-0 text-[17px] font-semibold ${danger ? 'text-[#B42318]' : ''}`}>{title}</h2>
          {body && <p className="m-0 text-sm leading-relaxed text-[#3B424C] whitespace-pre-line">{body}</p>}
          {items?.length > 0 && (
            <ul className="m-0 pl-[18px] list-disc text-sm leading-[1.7] text-[#3B424C]">
              {items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          )}

          {typeToConfirm && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="admin-dialog-typed" className="text-[13px] font-medium">
                พิมพ์ <span className="font-mono font-semibold">{typeToConfirm}</span> เพื่อยืนยัน
              </label>
              <input
                id="admin-dialog-typed"
                ref={firstInputRef}
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={submitted && !typedOk ? 'true' : undefined}
                className={`${inputClass} ${submitted && !typedOk ? 'border-[#B42318]' : 'border-[#C3C9D1]'}`}
              />
              {submitted && !typedOk && <span className="text-[13px] text-[#B42318]">ข้อความไม่ตรง</span>}
            </div>
          )}

          {fields.map((f, i) => {
            const showError = submitted && errors[f.name];
            return (
              <div key={f.name} className="flex flex-col gap-1.5">
                <label htmlFor={`admin-dialog-${f.name}`} className="text-[13px] font-medium">{f.label}</label>
                <input
                  id={`admin-dialog-${f.name}`}
                  ref={i === 0 && !typeToConfirm ? firstInputRef : undefined}
                  type={f.type || 'text'}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  aria-invalid={showError ? 'true' : undefined}
                  className={`${inputClass} ${showError ? 'border-[#B42318]' : 'border-[#C3C9D1]'}`}
                />
                {showError && <span className="text-[13px] text-[#B42318]">{errors[f.name]}</span>}
              </div>
            );
          })}

        </div>

        <div className="px-5 py-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onClose(null)}
            className="min-h-[44px] px-4 rounded-md border border-[#C3C9D1] bg-white text-sm font-medium text-[#16191D] hover:bg-[#F3F4F6] cursor-pointer"
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className={`min-h-[44px] px-4 rounded-md border text-sm font-semibold text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              danger ? 'bg-[#B42318] border-[#B42318] hover:bg-[#931B12]' : 'bg-[#1E4DB7] border-[#1E4DB7] hover:bg-[#163A8A]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
