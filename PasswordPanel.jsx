import React, { useState } from 'react';

/**
 * Password management surface for the Admin Console.
 *
 * Handles three situations:
 *   1. FORCED CHANGE — login succeeded but the password has expired (or must
 *      be rotated). The rest of the console is unreachable until this is done,
 *      matching the server, which refuses to mint a normal session.
 *   2. VOLUNTARY CHANGE — an admin rotates their password before it expires.
 *   3. FORGOT PASSWORD — reset with a single-use recovery code. No session
 *      required, because the point is to get back in when you cannot.
 *
 * Recovery codes are shown exactly once after any successful change or reset.
 * They are never retrievable again — only hashes are stored server-side.
 */

const PASSWORD_RULES = [
  { test: (v) => v.length >= 12, label: 'อย่างน้อย 12 ตัวอักษร' },
  { test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v), label: 'มีตัวพิมพ์เล็กและใหญ่' },
  { test: (v) => /[0-9]/.test(v), label: 'มีตัวเลข' },
  { test: (v) => /[^A-Za-z0-9]/.test(v), label: 'มีสัญลักษณ์พิเศษ' },
];

export default function PasswordPanel({
  mode = 'change',              // 'change' | 'reset' | 'regenerate'
  username = '',
  forced = false,
  status = null,
  runBackendFunction,
  onDone,
  onSessionUpgraded,
  onCancel,
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [resetUsername, setResetUsername] = useState(username);
  const [showCodes, setShowCodes] = useState(false);
  const [codes, setCodes] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isReset = mode === 'reset';
  // Regenerating codes does not touch the password, so only the current
  // password is needed — no new-password fields.
  const isRegenerate = mode === 'regenerate';
  const effectiveUsername = isReset ? resetUsername : username;

  const localStrengthOk = (v) => PASSWORD_RULES.every((r) => r.test(v || ''));
  const strengthPct = PASSWORD_RULES.filter((r) => r.test(newPassword)).length * 25;

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    if (isRegenerate) {
      setBusy(true);
      try {
        const res = await runBackendFunction('adminRegenerateRecoveryCodes', [currentPassword]);
        if (!res || res.success === false) {
          setError(res?.error || 'สร้าง Recovery Codes ใหม่ไม่สำเร็จ');
        } else {
          setCodes(res.recoveryCodes || []);
          setShowCodes(true);
        }
      } catch (err) {
        setError(err?.message || 'เกิดข้อผิดพลาด');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน');
      return;
    }
    if (!localStrengthOk(newPassword)) {
      setError('รหัสผ่านใหม่ยังไม่ผ่านเงื่อนไขความปลอดภัย');
      return;
    }
    setBusy(true);
    try {
      const res = isReset
        ? await runBackendFunction('adminResetPasswordWithRecoveryCode', [resetUsername, recoveryCode, newPassword])
        : await runBackendFunction('adminChangePassword', [currentPassword, newPassword]);

      if (!res || res.success === false) {
        setError(res?.error || 'ดำเนินการไม่สำเร็จ');
        setBusy(false);
        return;
      }
      // Adopt the upgraded session BEFORE anything else.
      //
      // A forced rotation starts from a scope:'reset' token, and the server
      // refuses every admin call (dashboard included) for that scope. The
      // change response therefore carries a fresh full-scope token; without
      // storing it here the console comes back to life visually but stays
      // permanently empty, because the browser keeps presenting the restricted
      // token. Storing it also covers the recovery-code path, where the panel is
      // reached without ever having logged in.
      if (res.session && typeof window !== 'undefined') {
        sessionStorage.setItem('rocket_admin_session', res.session);
        if (res.username) sessionStorage.setItem('rocket_admin_user', res.username);
        if (res.role) sessionStorage.setItem('rocket_admin_role', res.role);
        if (typeof onSessionUpgraded === 'function') onSessionUpgraded(res);
      }
      if (Array.isArray(res.recoveryCodes) && res.recoveryCodes.length) {
        setCodes(res.recoveryCodes);
        setShowCodes(true);
      } else if (typeof onDone === 'function') {
        onDone(res);
      }
    } catch (err) {
      setError(err?.message || 'เกิดข้อผิดพลาด');
    } finally {
      setBusy(false);
    }
  };

  // ── Recovery-code reveal (shown once, then gone) ──
  if (showCodes) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🔐</span>
            <h2 className="text-lg font-bold text-slate-900">บันทึก Recovery Codes ของคุณ</h2>
          </div>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <p className="text-xs text-amber-900 leading-relaxed">
              รหัสเหล่านี้จะแสดง <strong>ครั้งเดียวเท่านั้น</strong> และใช้ได้ครั้งเดียวต่อหนึ่งรหัส
              กรุณาจดลงกระดาษหรือเก็บใน Password Manager ทันที
              หากไม่บันทึกไว้ และลืมรหัสผ่าน จะไม่สามารถเข้าสู่ระบบได้อีก
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {codes.map((c) => (
              <div key={c} className="px-3 py-2 bg-slate-900 text-sky-300 font-mono text-sm rounded-lg text-center tracking-wider">
                {c}
              </div>
            ))}
          </div>
          <button
            onClick={() => { setShowCodes(false); if (typeof onDone === 'function') onDone(); }}
            className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white text-sm font-bold rounded-xl transition-all"
          >
            ✅ บันทึกไว้แล้ว — เข้าสู่ระบบ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{isReset ? '🆘' : '🔑'}</span>
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {isRegenerate
                ? 'สร้าง Recovery Codes ใหม่'
                : isReset
                  ? 'รีเซ็ตรหัสผ่าน'
                  : forced
                    ? 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน'
                    : 'เปลี่ยนรหัสผ่าน'}
            </h2>
            {isRegenerate && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                Codes เดิมทั้งหมดจะใช้ไม่ได้อีกต่อไป — กรุณาบันทึกชุดใหม่ทันที
              </p>
            )}
            {forced && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                รหัสผ่านของคุณหมดอายุ / ต้องเปลี่ยน — ทุกฟังก์ชันของระบบจะยังไม่ทำงานจนกว่าจะตั้งรหัสผ่านใหม่
              </p>
            )}
          </div>
        </div>

        {status?.daysUntilExpiry !== undefined && !forced && (
          <p className="text-[11px] text-slate-500">
            รหัสผ่านจะหมดอายุใน <strong>{status.daysUntilExpiry}</strong> วัน
            {status.recoveryCodesRemaining !== undefined && ` · Recovery Codes คงเหลือ ${status.recoveryCodesRemaining} รหัส`}
          </p>
        )}

        {isReset && (
          <>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-600 block">ชื่อผู้ใช้</label>
              <input
                type="text"
                value={resetUsername}
                onChange={(e) => setResetUsername(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-400 outline-none"
                autoComplete="username"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-600 block">Recovery Code (รหัสกู้คืน)</label>
              <input
                type="text"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="XXXXX-XXXXX"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono text-sm focus:ring-2 focus:ring-sky-400 outline-none"
                autoComplete="one-time-code"
              />
              <p className="text-[10px] text-slate-400">ใช้ได้ครั้งเดียวต่อหนึ่งรหัส และจะถูกเผาไปทันทีที่ใช้</p>
            </div>
          </>
        )}

        {!isReset && (
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-600 block">รหัสผ่านปัจจุบัน</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-400 outline-none"
              autoComplete="current-password"
            />
          </div>
        )}

        {!isRegenerate && (
          <>
        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-600 block">รหัสผ่านใหม่</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-400 outline-none"
            autoComplete="new-password"
          />
          <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${strengthPct < 50 ? 'bg-red-500' : strengthPct < 100 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${strengthPct}%` }}
            />
          </div>
          <ul className="text-[10px] space-y-0.5 mt-1">
            {PASSWORD_RULES.map((r) => (
              <li key={r.label} className={r.test(newPassword) ? 'text-emerald-600' : 'text-slate-400'}>
                {r.test(newPassword) ? '✓' : '○'} {r.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-600 block">ยืนยันรหัสผ่านใหม่</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-400 outline-none"
            autoComplete="new-password"
          />
        </div>

        </>
        )}

        {error && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !effectiveUsername || (isRegenerate ? !currentPassword : !newPassword)}
          className="w-full py-3 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all"
        >
          {busy ? '⏳ กำลังดำเนินการ...' : isRegenerate ? '🔄 สร้าง Codes ใหม่' : isReset ? '🔓 รีเซ็ตรหัสผ่าน' : '💾 บันทึกรหัสผ่านใหม่'}
        </button>

        {!forced && !isReset && typeof onCancel === 'function' && (
          <button type="button" onClick={onCancel} className="w-full py-2 text-xs text-slate-500 hover:text-slate-700">
            ยกเลิก
          </button>
        )}
        {!forced && (isReset || isRegenerate) && typeof onCancel === 'function' && (
          <button type="button" onClick={onCancel} className="w-full py-2 text-xs text-slate-500 hover:text-slate-700">
            ← กลับไปหน้าเข้าสู่ระบบ
          </button>
        )}
      </form>
    </div>
  );
}