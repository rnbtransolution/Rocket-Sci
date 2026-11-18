import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * แชตผู้เล่น: the admin talks to a player's LINE DM from the console instead of
 * switching to LINE OA Manager.
 *
 * The Worker files every DM in a per-player thread: what the player typed or
 * sent (text, slip image, sticker), the bot's replies and cards, and what an
 * admin sent from here. The admin's message goes out as a push, so it counts
 * toward the LINE OA monthly quota like any other push.
 *
 * Props come from App.jsx so the panel looks and behaves like the rest of the
 * console: `run` is runBackendFunction, `inbox` is polled by App for the nav
 * badge, `players` lets the admin start a chat with someone who has not
 * written yet, `openUserId` jumps straight to one player (from the player list).
 */

function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; });
  return ref;
}

const TZ = 'Asia/Bangkok';
const clock = (ts) => new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const dayKey = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const dayLabel = (ts) => {
  const k = dayKey(ts);
  if (k === dayKey(Date.now())) return 'วันนี้';
  if (k === dayKey(Date.now() - 86400000)) return 'เมื่อวาน';
  return new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: TZ });
};
const listTime = (ts) => (!ts ? '' : dayKey(ts) === dayKey(Date.now()) ? clock(ts) : dayLabel(ts));
const fmt = (n) => Number(n || 0).toLocaleString('th-TH');
const isLineId = (id) => /^U[0-9a-f]{32}$/i.test(String(id || ''));

function ImageMessage({ messageId, run }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await run('getDmImage', [messageId]);
      if (res?.success && res.dataUrl) setSrc(res.dataUrl);
      else setErr(res?.error || 'โหลดรูปไม่สำเร็จ');
    } catch (e) {
      setErr(e.message || 'โหลดรูปไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };
  if (src) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block">
        <img src={src} alt="รูปที่ผู้เล่นส่งมา" className="max-w-[220px] max-h-[320px] rounded-md border border-[#D9DDE2] bg-white" />
      </a>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={load} disabled={busy} className="min-h-[36px] px-3 rounded-md border border-[#C3C9D1] bg-white hover:bg-[#F3F4F6] text-[13px] font-medium text-[#16191D] cursor-pointer disabled:opacity-50">
        {busy ? 'กำลังโหลดรูป…' : 'ดูรูป'}
      </button>
      {err && <span className="text-[12px] text-[#B42318]">{err}</span>}
    </div>
  );
}

export default function ChatPanel({ run, addToast, ui, inbox, players, refreshInbox, openUserId, onOpened }) {
  // Opened from the player list: start on that player's thread.
  const [activeId, setActiveId] = useState(() => (isLineId(openUserId) ? openUserId : null));
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(() => isLineId(openUserId));
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [query, setQuery] = useState('');
  const runRef = useLatest(run);
  const refreshRef = useLatest(refreshInbox);
  const bottomRef = useRef(null);
  const lastCountRef = useRef(0);

  const threads = inbox?.threads || [];
  const byLine = new Map((players || []).filter((p) => isLineId(p.lineUserId)).map((p) => [p.lineUserId, p]));

  useEffect(() => {
    if (openUserId) onOpened?.();
  }, [openUserId, onOpened]);

  const openThread = (userId) => {
    if (userId === activeId) return;
    setMessages([]);
    lastCountRef.current = 0;
    setLoadingThread(Boolean(userId));
    setActiveId(userId);
  };

  const loadThread = useCallback(async (userId, markRead = true) => {
    if (!userId) return;
    try {
      const res = await runRef.current('getDmThread', [userId, markRead]);
      if (res?.success) {
        setMessages(res.messages || []);
        if (markRead) refreshRef.current?.();
      }
    } catch {
      // A missed poll is retried on the next tick.
    }
  }, [runRef, refreshRef]);

  // Load the thread on open, then refresh it every 3 s while it is on screen.
  useEffect(() => {
    if (!activeId) return undefined;
    let stop = false;
    loadThread(activeId).finally(() => { if (!stop) setLoadingThread(false); });
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') loadThread(activeId, true);
    }, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [activeId, loadThread]);

  // Keep the newest message in view when something new arrives.
  useEffect(() => {
    if (messages.length !== lastCountRef.current) {
      lastCountRef.current = messages.length;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const res = await run('adminSendDirectMessage', [activeId, text]);
      if (res?.success) {
        setDraft('');
        await loadThread(activeId);
      } else {
        addToast(res?.error || 'ส่งข้อความไม่สำเร็จ', 'error');
      }
    } catch (e) {
      addToast(e.message || 'ส่งข้อความไม่สำเร็จ', 'error');
    } finally {
      setSending(false);
    }
  };

  // Thread list plus, while searching, players who have no thread yet.
  const q = query.trim().toLowerCase();
  const match = (name, shortId) => !q || String(name || '').toLowerCase().includes(q) || String(shortId || '').toLowerCase().includes(q);
  const listed = threads.filter((t) => match(t.displayName, t.shortId));
  const threadIds = new Set(threads.map((t) => t.userId));
  const others = q
    ? (players || []).filter((p) => isLineId(p.lineUserId) && !threadIds.has(p.lineUserId) && match(p.name, p.shortId || p.id)).slice(0, 20)
    : [];

  const activeThread = threads.find((t) => t.userId === activeId);
  const activePlayer = activeId ? byLine.get(activeId) : null;
  const activeName = activePlayer?.name || activeThread?.displayName || 'ผู้เล่น';
  const activeShort = activePlayer?.shortId || activePlayer?.id || activeThread?.shortId || '';
  const activeBalance = typeof activePlayer?.balance === 'number' ? activePlayer.balance : activeThread?.balance;

  const rowBase = 'w-full text-left px-3 py-2.5 flex items-start gap-3 border-b border-[#E6E9ED] cursor-pointer';

  return (
    <div className={`${ui.panel} overflow-hidden`}>
      <div className={ui.panelHead}>
        <div>
          <h2 className={ui.h2}>แชตผู้เล่น</h2>
          <p className={ui.sub}>ตอบแชตส่วนตัวของผู้เล่นจากหน้านี้ ข้อความที่ส่งนับเป็นข้อความ push ของ LINE OA</p>
        </div>
      </div>

      <div className="grid md:grid-cols-[300px_1fr] min-h-[560px]">
        {/* Thread list */}
        <div className={`${activeId ? 'hidden md:flex' : 'flex'} flex-col border-r border-[#D9DDE2] min-w-0`}>
          <div className="p-3 border-b border-[#D9DDE2]">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อหรือรหัสผู้เล่น"
              className={ui.input}
            />
          </div>
          <div className="flex-1 overflow-y-auto max-h-[620px]">
            {listed.map((t) => {
              const active = t.userId === activeId;
              return (
                <button key={t.userId} type="button" onClick={() => openThread(t.userId)} className={`${rowBase} ${active ? 'bg-[#EEF2FB]' : 'hover:bg-[#F7F8F9]'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm ${t.unread ? 'font-semibold text-[#16191D]' : 'font-medium text-[#16191D]'}`}>{t.displayName}</span>
                      <span className="shrink-0 text-[11px] text-[#8A929D] tabular-nums">{listTime(t.lastAt)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className={`truncate text-[12px] ${t.unread ? 'text-[#16191D]' : 'text-[#5B636E]'}`}>
                        {t.lastFrom === 'admin' ? 'คุณ: ' : t.lastFrom === 'bot' ? 'บอท: ' : ''}{t.lastText}
                      </span>
                      {t.unread > 0 && (
                        <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-[#B42318] text-white text-[11px] font-semibold flex items-center justify-center tabular-nums">{t.unread}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {others.length > 0 && (
              <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-[#8A929D]">ผู้เล่นที่ยังไม่มีแชต</div>
            )}
            {others.map((p) => (
              <button key={p.lineUserId} type="button" onClick={() => { openThread(p.lineUserId); setQuery(''); }} className={`${rowBase} hover:bg-[#F7F8F9]`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[#16191D]">{p.name}</div>
                  <div className="text-[12px] text-[#5B636E] font-mono">{p.shortId || p.id}</div>
                </div>
              </button>
            ))}
            {listed.length === 0 && others.length === 0 && (
              <div className="px-4 py-10 text-center text-[13px] text-[#8A929D]">
                {q ? 'ไม่พบผู้เล่นที่ค้นหา' : 'ยังไม่มีผู้เล่นทักแชตส่วนตัวเข้ามา'}
              </div>
            )}
          </div>
        </div>

        {/* Conversation */}
        <div className={`${activeId ? 'flex' : 'hidden md:flex'} flex-col min-w-0 bg-[#F3F5F7]`}>
          {!activeId ? (
            <div className="flex-1 flex items-center justify-center p-8 text-[13px] text-[#8A929D]">เลือกผู้เล่นทางซ้ายเพื่อเปิดแชต</div>
          ) : (
            <>
              <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-[#D9DDE2]">
                <button type="button" onClick={() => openThread(null)} className="md:hidden min-h-[36px] px-2.5 rounded-md border border-[#C3C9D1] text-[13px] cursor-pointer">กลับ</button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-[#16191D]">{activeName}</div>
                  <div className="text-[12px] text-[#5B636E]">
                    {activeShort && <span className="font-mono">{activeShort}</span>}
                    {typeof activeBalance === 'number' && <span> · เครดิต {fmt(activeBalance)} pt</span>}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto max-h-[520px] px-4 py-4 flex flex-col gap-2">
                {loadingThread && messages.length === 0 && (
                  <div className="text-center text-[13px] text-[#8A929D] py-6">กำลังโหลด…</div>
                )}
                {!loadingThread && messages.length === 0 && (
                  <div className="text-center text-[13px] text-[#8A929D] py-6">ยังไม่มีข้อความ พิมพ์ด้านล่างเพื่อเริ่มแชต</div>
                )}
                {messages.map((m, i) => {
                  const showDay = i === 0 || dayKey(messages[i - 1].at) !== dayKey(m.at);
                  const mine = m.from !== 'user';
                  const bubble =
                    m.from === 'admin'
                      ? 'bg-[#1E4DB7] text-white'
                      : m.from === 'bot'
                        ? 'bg-[#E4E7EB] text-[#3B424C]'
                        : 'bg-white text-[#16191D] border border-[#D9DDE2]';
                  return (
                    <div key={m.id || i} className="flex flex-col">
                      {showDay && (
                        <div className="self-center my-2 px-2.5 py-0.5 rounded-full bg-[#E4E7EB] text-[11px] text-[#5B636E]">{dayLabel(m.at)}</div>
                      )}
                      <div className={`flex items-end gap-1.5 ${mine ? 'justify-end' : 'justify-start'}`}>
                        {mine && <span className="text-[11px] text-[#8A929D] tabular-nums shrink-0">{clock(m.at)}</span>}
                        <div className={`max-w-[78%] rounded-xl px-3 py-2 ${bubble}`}>
                          {m.from === 'bot' && (
                            <div className="text-[11px] font-semibold text-[#5B636E] mb-0.5">บอท{m.type === 'card' ? ' · การ์ด' : ''}</div>
                          )}
                          {m.from === 'admin' && m.by && (
                            <div className="text-[11px] font-semibold text-white/75 mb-0.5">{m.by}</div>
                          )}
                          {m.type === 'image' && m.messageId ? (
                            <ImageMessage messageId={m.messageId} run={run} />
                          ) : (
                            <div className="text-sm whitespace-pre-wrap break-words leading-snug">{m.text}</div>
                          )}
                        </div>
                        {!mine && <span className="text-[11px] text-[#8A929D] tabular-nums shrink-0">{clock(m.at)}</span>}
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <div className="bg-white border-t border-[#D9DDE2] p-3 flex flex-col gap-2">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={2}
                    maxLength={2000}
                    placeholder="พิมพ์ข้อความถึงผู้เล่น (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"
                    className={`${ui.input} py-2 resize-none min-h-[56px]`}
                  />
                  <button type="button" onClick={send} disabled={sending || !draft.trim()} className={`${ui.primary} shrink-0`}>
                    {sending ? 'กำลังส่ง…' : 'ส่ง'}
                  </button>
                </div>
                <p className="text-[12px] text-[#8A929D]">ผู้เล่นเห็นข้อความนี้ในแชตส่วนตัวกับบัญชี LINE OA ข้อความไม่ถูกอ่านเป็นคำสั่งของบอท</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
