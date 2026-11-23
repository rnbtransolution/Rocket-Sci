import { useState, useEffect } from 'react';

/**
 * Pending deposit / withdrawal detail.
 *
 * Shows the slip image the player actually sent (fetched from LINE through
 * getDmImage), lets the admin run it through the slip scanner again, or type
 * the amount they checked against the bank statement before approving.
 * There is no drawn "sample slip" here on purpose: the admin must only ever
 * see what the player sent.
 *
 * Props: tx, run (runBackendFunction), onClose, onApprove(txId, amount|undefined),
 * onReject(txId, reason), onRescanned(result).
 */

const fmt = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function slipMessageId(tx) {
  if (tx.messageId) return String(tx.messageId);
  return /^\d{10,25}$/.test(String(tx.slipRef || '')) ? String(tx.slipRef) : '';
}

export default function SlipReviewModal({ tx, run, onClose, onApprove, onReject, onRescanned }) {
  const isWithdrawal = tx.id.startsWith('WD') || tx.type === 'withdraw';
  const messageId = isWithdrawal ? '' : slipMessageId(tx);
  const stored = Number(tx.requestedAmount) || 0;
  const verified = tx.slipVerified === true && stored > 0;
  const pending = tx.status === 'escalated';

  const [img, setImg] = useState(null);
  const [imgErr, setImgErr] = useState('');
  const [amount, setAmount] = useState(stored > 0 ? String(stored) : '');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!messageId) return;
    let live = true;
    run('getDmImage', [messageId])
      .then((res) => {
        if (!live) return;
        if (res?.success && res.dataUrl) setImg(res.dataUrl);
        else setImgErr(res?.error || 'โหลดรูปสลิปไม่สำเร็จ');
      })
      .catch((e) => live && setImgErr(e?.message || 'โหลดรูปสลิปไม่สำเร็จ'));
    return () => { live = false; };
  }, [messageId]);

  const typed = Number(amount);
  const amountOk = isWithdrawal || verified || (Number.isFinite(typed) && typed > 0);
  const approveAmount = isWithdrawal ? stored : verified ? stored : typed;

  const rescan = async () => {
    setBusy('rescan');
    setMsg(null);
    try {
      const res = await run('adminRescanSlip', [tx.id]);
      if (res?.success) {
        onRescanned?.(res);
        return;
      }
      setMsg({ tone: 'error', text: res?.error || 'ตรวจสลิปไม่สำเร็จ' });
    } catch (e) {
      setMsg({ tone: 'error', text: e?.message || 'ตรวจสลิปไม่สำเร็จ' });
    } finally {
      setBusy('');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 font-sans"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-lg w-full max-w-3xl overflow-hidden border border-[#D9DDE2] max-h-[92vh] flex flex-col">
        <div
          className="px-6 py-4 flex items-start justify-between gap-4"
          style={{ backgroundColor: isWithdrawal ? '#B4400F' : '#0B6B3F', color: '#ffffff' }}
        >
          <div className="min-w-0">
            <h3 className="font-semibold text-base flex flex-wrap items-center gap-2" style={{ color: '#ffffff' }}>
              {isWithdrawal ? 'รายละเอียดการจ่ายเงิน' : 'รายละเอียดการแจ้งสลิปเติมเงิน'}
              <span className="px-2 py-0.5 rounded font-mono text-xs" style={{ backgroundColor: 'rgba(255,255,255,0.18)', color: '#ffffff' }}>{tx.id}</span>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.9)' }}>ผู้เล่น: {tx.playerName} ({tx.playerId})</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-bold"
            style={{ backgroundColor: 'rgba(255,255,255,0.18)', color: '#ffffff' }}
          >
            ✕
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 text-xs text-[#16191D]">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="flex justify-center">
              {isWithdrawal ? (
                <div className="w-full bg-[#F7F8F9] border border-[#E7B4AE] rounded-lg p-4 text-center space-y-3">
                  <span className="text-[12px] text-[#B42318] font-semibold bg-[#F6D7D3] px-2 py-0.5 rounded-md">จ่ายเงิน</span>
                  <h4 className="text-2xl font-semibold text-[#B42318] font-mono">-{fmt(stored)} THB</h4>
                  <div className="bg-white border border-[#E7B4AE] rounded-lg p-2 text-[12px] text-[#B42318] font-bold">
                    {String(tx.reviewReason || '').replace('Withdrawal request to ', '')}
                  </div>
                </div>
              ) : img ? (
                <a href={img} target="_blank" rel="noreferrer" title="เปิดรูปเต็ม" className="block">
                  <img src={img} alt="สลิปที่ผู้เล่นส่งมา" className="max-h-[60vh] w-auto rounded-md border border-[#D9DDE2] bg-white" />
                </a>
              ) : (
                <div className="w-full min-h-[240px] rounded-lg border border-dashed border-[#C3C9D1] bg-[#F7F8F9] flex items-center justify-center p-4 text-center text-[13px] text-[#5B636E]">
                  {!messageId ? 'รายการนี้ไม่มีรูปสลิปเก็บไว้' : imgErr || 'กำลังโหลดรูปสลิป…'}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="bg-[#F7F8F9] p-3.5 rounded-lg border border-[#D9DDE2] space-y-2">
                <div className="flex justify-between items-center border-b border-[#D9DDE2] pb-2">
                  <span className="text-[#5B636E] font-bold">สถานะ</span>
                  {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg font-bold">อนุมัติแล้ว</span>}
                  {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg font-bold">รอแอดมินตรวจ</span>}
                  {tx.status === 'rejected' && <span className="badge-high px-2 py-0.5 rounded-lg font-bold">ปฏิเสธแล้ว</span>}
                </div>
                <div className="space-y-1 text-[12px]">
                  <div><span className="text-[#8A929D]">ยอดในรายการ:</span> <strong className="font-mono">{stored > 0 ? `${fmt(stored)} THB` : 'ยังไม่มียอด'}</strong>{verified && <span className="ml-1 text-[#1B6E43] font-bold">(ตรวจสลิปแล้ว)</span>}</div>
                  <div><span className="text-[#8A929D]">เลขอ้างอิง:</span> <strong className="font-mono break-all">{tx.slipRef || '-'}</strong></div>
                  <div><span className="text-[#8A929D]">เวลา:</span> <strong className="font-mono">{tx.timestamp}</strong></div>
                  <div><span className="text-[#8A929D]">หมายเหตุ:</span> <span className="text-[#B42318] break-words">{tx.reviewReason}</span></div>
                </div>
              </div>

              {pending && !isWithdrawal && messageId && (
                <div className="rounded-lg border border-[#D9DDE2] p-3.5 space-y-2">
                  <p className="text-[12px] text-[#3B424C]">
                    ส่งรูปนี้ให้ระบบตรวจสลิปอีกครั้ง ถ้าผ่านจะเติมเครดิตตามยอดในสลิปทันที และสลิปเดียวกันจะเติมซ้ำไม่ได้
                  </p>
                  <button
                    type="button"
                    onClick={rescan}
                    disabled={!!busy}
                    className="w-full min-h-[38px] rounded-lg bg-[#0B6B3F] hover:bg-[#095a35] text-white text-[13px] font-semibold disabled:opacity-50"
                  >
                    {busy === 'rescan' ? 'กำลังตรวจสลิป…' : 'ตรวจสลิปอีกครั้ง'}
                  </button>
                </div>
              )}

              {pending && !isWithdrawal && !verified && (
                <div className="rounded-lg border border-[#D9DDE2] p-3.5 space-y-2">
                  <label className="block text-[12px] font-bold text-[#3B424C]" htmlFor="slip-amount">
                    หรือกรอกยอดที่ตรวจกับบัญชีธนาคารแล้ว (บาท)
                  </label>
                  <input
                    id="slip-amount"
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="เช่น 500"
                    className="w-full min-h-[38px] px-3 rounded-lg border border-[#C3C9D1] font-mono text-[14px]"
                  />
                </div>
              )}

              {msg && (
                <div className={`rounded-lg px-3 py-2 text-[12px] font-medium ${msg.tone === 'error' ? 'bg-[#FBEAE8] text-[#B42318] border border-[#E7B4AE]' : 'bg-[#E6F2EC] text-[#1B6E43] border border-[#B7D9C6]'}`}>
                  {msg.text}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-3 bg-[#F7F8F9] border-t border-[#D9DDE2] flex flex-wrap justify-between items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-[#C3C9D1] rounded-lg text-[#3B424C] font-bold text-xs hover:bg-[#EEF0F2]"
          >
            ปิดหน้าต่าง
          </button>
          {pending && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => onReject(tx.id, isWithdrawal ? 'ปฏิเสธคำขอและส่งแต้มคืนเข้าบัญชี' : 'ปฏิเสธเนื่องจากไม่มียอดโอนจริง')}
                className="px-4 py-2 bg-[#FBEAE8] border border-[#E7B4AE] hover:bg-[#B42318] text-[#B42318] hover:text-white rounded-lg text-xs font-bold disabled:opacity-50"
              >
                ✕ ปฏิเสธรายการ
              </button>
              <button
                type="button"
                disabled={!!busy || !amountOk}
                onClick={() => onApprove(tx.id, isWithdrawal || verified ? undefined : typed)}
                className="px-5 py-2 bg-[#1B6E43] hover:bg-[#155a36] text-white rounded-lg text-xs font-semibold disabled:opacity-40"
              >
                {amountOk ? `อนุมัติ ${fmt(approveAmount)} THB` : 'กรอกยอดก่อนอนุมัติ'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
