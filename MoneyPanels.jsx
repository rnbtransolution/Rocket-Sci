import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Two console panels that move money after a round:
 *
 *   CorrectionPanel  re-settles a round whose flight time was typed wrong.
 *                    Allowed until the first 20:00 (ICT) after it was settled,
 *                    the hour the admin starts transferring money by hand.
 *   PayoutPanel      the evening payout sheet: who holds points, where to send
 *                    them, and "โอนแล้ว" to take the points off once paid.
 *
 * Both take the console's own helpers as props so they look and behave like
 * the rest of App.jsx.
 */

/**
 * The console passes `run` and `addToast` as new functions on every render, and
 * it re-renders every few seconds while it polls. Depending on them directly
 * made each panel reload on every render, so the button flickered between
 * "กำลังโหลด" and "รีเฟรช" and the Worker was called non-stop. The ref always
 * holds the latest function without being a dependency.
 */
function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}

const fmt = (n) => Number(n || 0).toLocaleString('th-TH');
const clock = (ts) => new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
const dayLabel = (ts) => new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });

export function CorrectionPanel({ run, ask, addToast, ui, pinField, onDone, refreshKey }) {
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const runRef = useLatest(run);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await runRef.current('adminListCorrectableRounds', []);
      setRounds(Array.isArray(res?.rounds) ? res.rounds : []);
    } catch (err) {
      console.error('adminListCorrectableRounds', err);
    } finally {
      setLoading(false);
    }
  }, [runRef]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const correct = async (r) => {
    const ok = await ask({
      title: `แก้เวลาบิน “${r.name}”`,
      tone: 'danger',
      body: `ตอนนี้ใช้เวลา ${r.finalTime} วิ ตัดสินไป ${r.pairs} คู่`,
      items: [
        'ระบบดึงเงินที่จ่ายตามเวลาเดิมคืน แล้วจ่ายใหม่ตามเวลาที่ถูกต้อง',
        'ผู้เล่นที่ใช้เงินรางวัลไปแล้ว ยอดอาจติดลบ และเล่นต่อไม่ได้จนกว่าจะเติม',
        'กลุ่ม LINE ได้รับการ์ดแก้ไขผล ผู้เล่นที่ยอดเปลี่ยนได้รับแจ้งทาง DM',
        `แก้ได้ถึง ${dayLabel(r.cutoff)} ${clock(r.cutoff)} น.`,
      ],
      fields: [
        {
          name: 'time',
          label: 'เวลาบินที่ถูกต้อง (วินาที)',
          type: 'number',
          inputMode: 'decimal',
          placeholder: String(r.finalTime),
          validate: (v) => (Number(v) > 0 ? (Number(v) === r.finalTime ? 'เป็นเวลาเดิม' : null) : 'กรอกเวลาบิน'),
        },
        pinField,
      ],
      confirmLabel: 'แก้ผลและคำนวณใหม่',
    });
    if (!ok) return;
    setBusyKey(r.key);
    try {
      const res = await run('adminCorrectFlightTime', [r.key, Number(ok.values.time), ok.values.pin]);
      if (!res || res.success === false) {
        addToast(`แก้ผลไม่สำเร็จ: ${res?.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }
      const neg = res.negative || [];
      addToast(
        `แก้ผล "${r.name}" ${res.oldTime} → ${res.newTime} วิ คำนวณใหม่ ${res.correctedCount} คู่ ปรับยอด ${(res.changes || []).length} คน` +
          (neg.length ? ` · ยอดติดลบ: ${neg.map((n) => `${n.name} ${fmt(n.balance)}`).join(', ')}` : ''),
        neg.length ? 'warning' : 'success'
      );
      await onDone?.();
      await load();
    } catch (err) {
      addToast(`แก้ผลไม่สำเร็จ: ${err.message || err}`, 'danger');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section aria-labelledby="correct-title" className={ui.panel}>
      <div className={ui.panelHead}>
        <div className="flex flex-col gap-0.5">
          <h2 id="correct-title" className={ui.h2}>แก้เวลาบิน (รอบที่ตัดสินแล้ว)</h2>
          <span className={ui.sub}>ใส่เวลาผิด แก้ได้จนถึง 20:00 น. ก่อนแอดมินโอนเงิน</span>
        </div>
        <button type="button" onClick={load} className={ui.secondary} disabled={loading}>
          {loading ? 'กำลังโหลด' : 'รีเฟรช'}
        </button>
      </div>
      {rounds.length === 0 ? (
        <p className="m-0 px-4 py-6 text-sm text-[#5B636E]">ยังไม่มีรอบที่แก้ได้</p>
      ) : (
        <div className="divide-y divide-[#E6E9ED]">
          {rounds.map((r) => (
            <div key={r.key} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-[#16191D]">
                  {r.name}
                  {r.corrected && <span className={`${ui.chip} ml-2 bg-[#FDF1E1] text-[#8A4B00]`}>แก้ไขแล้ว</span>}
                </span>
                <span className="text-[12px] text-[#5B636E]">
                  เวลาบิน <span className="font-mono">{r.finalTime}</span> วิ · {r.pairs} คู่ · ตัดสิน {clock(r.settledAt)} · แก้ได้ถึง {dayLabel(r.cutoff)} {clock(r.cutoff)}
                </span>
              </div>
              <button type="button" onClick={() => correct(r)} disabled={busyKey === r.key} className={ui.secondary}>
                {busyKey === r.key ? 'กำลังคำนวณ' : 'แก้เวลาบิน'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function PayoutPanel({ run, ask, addToast, ui, onDone }) {
  const [sheet, setSheet] = useState({ players: [], paidToday: [] });
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const runRef = useLatest(run);
  const toastRef = useLatest(addToast);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await runRef.current('adminListPayouts', []);
      if (res?.success) setSheet({ players: res.players || [], paidToday: res.paidToday || [], day: res.day });
    } catch (err) {
      toastRef.current(`โหลดรายการจ่ายเงินไม่สำเร็จ: ${err.message || err}`, 'danger');
    } finally {
      setLoading(false);
    }
  }, [runRef, toastRef]);

  useEffect(() => { load(); }, [load]);

  const toPay = sheet.players.filter((p) => p.balance > 0);
  const negative = sheet.players.filter((p) => p.balance < 0);
  const totalToPay = toPay.reduce((a, p) => a + p.balance, 0);
  const totalPaid = sheet.paidToday.reduce((a, t) => a + t.amount, 0);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('คัดลอกเลขบัญชีแล้ว', 'success');
    } catch (_) {
      addToast(text, 'info');
    }
  };

  const recordPayout = async (p) => {
    // One id per dialog: a double click or a retried request records once.
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const ok = await ask({
      title: `บันทึกโอนให้ ${p.name}`,
      body: p.hasAccount ? `${p.bankName} ${p.accountNumber} · ${p.accountName}` : 'ผู้เล่นยังไม่ได้แจ้งบัญชีรับเงิน',
      items: [
        `ยอดคงเหลือ ${fmt(p.balance)} pt`,
        'กดยืนยันหลังโอนเงินจริงแล้วเท่านั้น ระบบหักคะแนนตามยอดที่โอน และแจ้งผู้เล่นทาง DM',
      ],
      fields: [{
        name: 'amount',
        label: 'ยอดที่โอน (บาท)',
        type: 'number',
        inputMode: 'numeric',
        defaultValue: String(Math.floor(p.balance)),
        validate: (v) => {
          const n = Number(v);
          if (!(n > 0) || !Number.isInteger(n)) return 'กรอกจำนวนเต็มมากกว่า 0';
          if (n > p.balance) return 'มากกว่ายอดคงเหลือ';
          return null;
        },
      }],
      confirmLabel: 'โอนแล้ว หักคะแนน',
    });
    if (!ok) return;
    setBusyId(p.playerId);
    try {
      const res = await run('adminRecordPayout', [p.playerId, Number(ok.values.amount), requestId]);
      if (!res || res.success === false) {
        addToast(`บันทึกไม่สำเร็จ: ${res?.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }
      addToast(`บันทึกโอน ${fmt(ok.values.amount)} บาท ให้ ${p.name} แล้ว คงเหลือ ${fmt(res.balance)} pt`, 'success');
      await onDone?.();
      await load();
    } catch (err) {
      addToast(`บันทึกไม่สำเร็จ: ${err.message || err}`, 'danger');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className={`${ui.panel} p-4 grid grid-cols-1 sm:grid-cols-3 gap-4`}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-[#5B636E]">ต้องโอนวันนี้</span>
          <span className="font-mono tabular-nums text-xl font-medium text-[#16191D]">{fmt(totalToPay)} บาท</span>
          <span className="text-[12px] text-[#5B636E]">{toPay.length} คน</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-[#5B636E]">โอนแล้ววันนี้</span>
          <span className="font-mono tabular-nums text-xl font-medium text-[#16191D]">{fmt(totalPaid)} บาท</span>
          <span className="text-[12px] text-[#5B636E]">{sheet.paidToday.length} รายการ</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] text-[#5B636E]">รอบโอน</span>
          <span className="text-sm text-[#16191D]">ทุกวันหลัง 20:00 น.</span>
          <span className="text-[12px] text-[#5B636E]">หลัง 20:00 แก้เวลาบินรอบก่อนหน้าไม่ได้แล้ว</span>
        </div>
      </section>

      <section aria-labelledby="payout-title" className={ui.panel}>
        <div className={ui.panelHead}>
          <h2 id="payout-title" className={ui.h2}>รายการจ่ายเงิน</h2>
          <button type="button" onClick={load} className={ui.secondary} disabled={loading}>{loading ? 'กำลังโหลด' : 'รีเฟรช'}</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[640px]">
            <thead className="border-b border-[#D9DDE2]">
              <tr>
                <th className={ui.th}>ผู้เล่น</th>
                <th className={ui.th}>บัญชีรับเงิน</th>
                <th className={`${ui.th} text-right`}>ยอดคงเหลือ</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6E9ED]">
              {toPay.length === 0 ? (
                <tr><td colSpan={4} className="py-10 text-center text-sm text-[#5B636E]">ไม่มีผู้เล่นที่มียอดค้าง</td></tr>
              ) : toPay.map((p) => (
                <tr key={p.playerId}>
                  <td className={ui.td}>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[12px] text-[#8A929D] font-mono">{p.playerId}</div>
                  </td>
                  <td className={ui.td}>
                    {p.hasAccount ? (
                      <button type="button" onClick={() => copy(p.accountNumber)} className="text-left cursor-pointer" title="คัดลอกเลขบัญชี">
                        <div>{p.bankName} <span className="font-mono">{p.accountNumber}</span></div>
                        <div className="text-[12px] text-[#5B636E]">{p.accountName}</div>
                      </button>
                    ) : (
                      <span className={`${ui.chip} bg-[#F6D7D3] text-[#B42318]`}>ยังไม่แจ้งบัญชี</span>
                    )}
                  </td>
                  <td className={`${ui.td} text-right font-mono tabular-nums font-semibold`}>{fmt(p.balance)}</td>
                  <td className={`${ui.td} text-right`}>
                    <button type="button" onClick={() => recordPayout(p)} disabled={busyId === p.playerId} className={ui.primary}>
                      {busyId === p.playerId ? 'กำลังบันทึก' : 'โอนแล้ว'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {negative.length > 0 && (
        <section aria-labelledby="neg-title" className={`${ui.panel} border-[#E7B4AE]`}>
          <div className={ui.panelHead}>
            <h2 id="neg-title" className={ui.h2}>ยอดติดลบ (จากการแก้ผล)</h2>
            <span className={ui.sub}>เล่นต่อไม่ได้จนกว่าจะเติมเครดิต</span>
          </div>
          <div className="divide-y divide-[#E6E9ED]">
            {negative.map((p) => (
              <div key={p.playerId} className="px-4 py-2.5 flex items-center justify-between text-sm">
                <span>{p.name} <span className="text-[#8A929D] font-mono text-[12px]">{p.playerId}</span></span>
                <span className="font-mono tabular-nums text-[#B42318] font-semibold">{fmt(p.balance)} pt</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {sheet.paidToday.length > 0 && (
        <section aria-labelledby="paid-title" className={ui.panel}>
          <div className={ui.panelHead}>
            <h2 id="paid-title" className={ui.h2}>โอนแล้ววันนี้</h2>
          </div>
          <div className="divide-y divide-[#E6E9ED]">
            {sheet.paidToday.map((t) => (
              <div key={t.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                <span className="text-[#8A929D] font-mono">{t.timestamp}</span>
                <span className="flex-1 px-3">{t.name}</span>
                <span className="font-mono tabular-nums">{fmt(t.amount)} บาท</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
