import { useState, useEffect, useRef, useCallback } from 'react';
import AdminLockScreen from './AdminLockScreen.jsx';
import PasswordPanel from './PasswordPanel.jsx';
import { useAdminDialog } from './AdminDialog.jsx';
import { 
  Send, 
  CheckCircle, 
  AlertTriangle, 
  XCircle, 
  Rocket, 
  Layers, 
  Clock, 
  Database,
  Users,
  FileText,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Zap,
  Info,
  ShieldAlert,
  Trophy,
  Search,
  Radio,
  Megaphone,
  LogOut,
  KeyRound,
  Cloud,
  Landmark
} from 'lucide-react';

const INITIAL_PLAYERS = [];

// Presets for the Slip Upload Simulator
const SLIP_PRESETS = [
  {
    id: 'preset_valid_100',
    name: 'KBANK 100 THB (Match)',
    bankLogo: '',
    bankName: 'ธนาคารกสิกรไทย (KBANK)',
    gradient: 'from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-950',
    amount: 100,
    actualAmount: 100,
    refCode: 'KBNK202606048827',
    senderName: 'คุณ (You)',
    isValidQR: true,
    isDuplicate: false,
    description: 'ยอดโอนตรงตามสั่ง 100 บาท ระบบอนุมัติออโต้ทันที 1:1'
  },
  {
    id: 'preset_valid_500',
    name: 'SCB 500 THB (Match)',
    bankLogo: '',
    bankName: 'ธนาคารไทยพาณิชย์ (SCB)',
    gradient: 'from-purple-50 to-purple-100 border-purple-200 text-purple-950',
    amount: 500,
    actualAmount: 500,
    refCode: 'SCB202606045491',
    senderName: 'คุณ (You)',
    isValidQR: true,
    isDuplicate: false,
    description: 'ยอดโอนตรงตามสั่ง 500 บาท ระบบอนุมัติออโต้ทันที 1:1'
  },
  {
    id: 'preset_mismatch',
    name: 'BBL 100 THB (Mismatch)',
    bankLogo: '',
    bankName: 'ธนาคารกรุงเทพ (BBL)',
    gradient: 'from-blue-50 to-blue-100 border-blue-200 text-blue-950',
    amount: 500,
    actualAmount: 100,
    refCode: 'BBL202606044820',
    senderName: 'คุณ (You)',
    isValidQR: true,
    isDuplicate: false,
    description: 'สั่งเติม 500 บาท แต่โอนจริง 100 บาท ระบบจะส่งแอดมินตรวจ'
  },
  {
    id: 'preset_duplicate',
    name: 'KBANK 100 THB (Duplicate)',
    bankLogo: '',
    bankName: 'ธนาคารกสิกรไทย (KBANK)',
    gradient: 'from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-950',
    amount: 100,
    actualAmount: 100,
    refCode: 'KBNK202606048827',
    senderName: 'คุณ (You)',
    isValidQR: true,
    isDuplicate: true,
    description: 'สลิปนี้เคยส่งอนุมัติไปแล้ว ระบบเช็ค Ref ซ้ำจะส่งให้แอดมินทันที'
  },
  {
    id: 'preset_no_qr',
    name: 'KTB 200 THB (No QR)',
    bankLogo: '',
    bankName: 'ธนาคารกรุงไทย (KTB)',
    gradient: 'from-sky-50 to-sky-100 border-sky-200 text-sky-950',
    amount: 200,
    actualAmount: 200,
    refCode: 'KTB202606040000',
    senderName: 'คุณ (You)',
    isValidQR: false,
    isDuplicate: false,
    description: 'รูปพัง / ไม่มี QR Code สแกนล้มเหลว ส่งเรื่องให้แอดมินมือ'
  }
];

// Admin credentials are NEVER read from the frontend environment.
//
// Vite inlines every VITE_* value into the JavaScript bundle at build time, so
// reading passwords or the admin API key here published them to every visitor
// in the page source. Usernames remain as harmless UI hints; all passwords and
// role decisions are resolved server-side during login.
const SUPER_ADMIN_USERNAME = import.meta.env.VITE_SUPER_ADMIN_USERNAME || import.meta.env.VITE_ADMIN_USERNAME || '';
const LIMITED_ADMIN_USERNAME = import.meta.env.VITE_LIMITED_ADMIN_USERNAME || import.meta.env.VITE_ADMIN1_USERNAME || '';

export default function App() {
  const isGASHost = typeof window !== 'undefined' && (
    window.location.hostname.includes('googleusercontent.com') ||
    window.location.hostname.includes('script.google.com')
  );
  const isGAS = isGASHost || (
    typeof window !== 'undefined' &&
    !!(window.google && window.google.script && window.google.script.run) &&
    !window.isNodeJS
  );
  const isGitHubPages = typeof window !== 'undefined' && window.location.hostname.includes('github.io');
  const CF_WORKER_BASE_URL = 'https://rocket-science-cf-worker.rnbtransolution.workers.dev';

  // Resilient API Base URL resolution:
  // 1. Inside GAS iframe: empty string (routes via google.script.run)
  // 2. Running on local Node (localhost:3001) or local Vite dev (localhost:5173):
  //    - If window.location.port is 3001, use '' (same-origin)
  //    - If localhost / 127.0.0.1 on port 5173, target 'http://localhost:3001'
  // 3. Explicit VITE_API_BASE_URL environment variable if configured
  // 4. Default fallback: same-origin ''
  const getApiBaseUrl = () => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('rocket_api_base_url');
      if (stored) return stored.replace(/\/+$/, '');
      const { hostname, port } = window.location;
      if (port === '3001') return '';
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:3001';
      }
    }
    // Authoritative Cloudflare Worker Edge API (sub-second response across GAS, GitHub Pages, and web portals)
    return import.meta.env.VITE_API_BASE_URL || CF_WORKER_BASE_URL;
  };
  const API_BASE_URL = getApiBaseUrl();

  // ── Admin session ──
  // The browser holds a short-lived signed session token, NOT the admin API key.
  // The key used to be read from VITE_ADMIN_API_KEY, which Vite inlines into the
  // bundle at build time — publishing the admin credential to every visitor.
  // sessionStorage (not localStorage) keeps it out of persistent disk storage and
  // clears on tab close.
  const getAdminSession = () => {
    if (typeof window === 'undefined') return '';
    return sessionStorage.getItem('rocket_admin_session') || '';
  };
  const clearAdminSession = () => {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem('rocket_admin_session');
    sessionStorage.removeItem('rocket_admin_auth');
    sessionStorage.removeItem('rocket_admin_role');
    sessionStorage.removeItem('rocket_admin_user');
  };

  const runBackendFunction = async (functionName, args = []) => {
    const targetBase = API_BASE_URL || CF_WORKER_BASE_URL;
    const targetUrl = `${targetBase}/api/run`;
    const session = getAdminSession();
    const headers = {
      'Content-Type': 'application/json',
      ...(session ? { 'x-admin-session': session } : {}),
    };

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ functionName, args, adminSession: session || undefined, adminRole }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(res.status === 404 ? 'ไม่พบ API Endpoint' : 'ระบบขัดข้อง');
      }

      const json = await res.json();
      if (res.status === 401) {
        // Session missing, expired or revoked — drop it and bounce to login.
        clearAdminSession();
        setAdminAuthenticated(false);
      }
      if (!res.ok) throw new Error(json.error || 'เกิดข้อผิดพลาด');
      return json.data;
    } catch (fetchErr) {
      // Fallback to GAS if network fetch fails and running inside Google Apps Script iframe
      if (isGAS && typeof window !== 'undefined' && window.google?.script?.run) {
        let gasRun = window.google.script.run;
        return new Promise((resolve, reject) => {
          const runner = gasRun
            .withSuccessHandler((res) => resolve(res))
            .withFailureHandler((err) => reject(new Error(err?.message || 'เกิดข้อผิดพลาด')));
          if (typeof runner[functionName] === 'function') {
            runner[functionName](...args);
          } else if (typeof runner.executeAdminAction === 'function') {
            runner.executeAdminAction(functionName, args);
          } else {
            reject(new Error(`ไม่พบฟังก์ชัน ${functionName}`));
          }
        });
      }
      throw fetchErr;
    }
  };

  // Security and Mode States
  const [playerUserId] = useState(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const uid = urlParams.get('userId');
      if (uid) {
        return uid.trim().toLowerCase() === 'user' ? 'user' : uid.trim();
      }
    }
    return null;
  });
  const [adminAuthenticated, setAdminAuthenticated] = useState(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('rocket_admin_auth') === 'true';
    }
    return false;
  });
  const [adminRole, setAdminRole] = useState(() => {
    if (typeof window !== 'undefined') {
      const storedRole = sessionStorage.getItem('rocket_admin_role');
      if (storedRole) return storedRole;
      const storedUser = sessionStorage.getItem('rocket_admin_user');
      if (storedUser && storedUser.toLowerCase() === 'admin1') return 'admin';
      if (storedUser && storedUser.toLowerCase() === 'admin') return 'superadmin';
    }
    return 'superadmin';
  });
  const [usernameInput, setUsernameInput] = useState(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('rocket_admin_user') || '';
    }
    return '';
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');

  // ── Password lifecycle ──
  // Set when login reports an expired/forced-change password. While true the
  // console is locked to the change-password screen — the server also refuses
  // to mint a normal session, so this is convenience, not the enforcement.
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState(null);
  const [resetMode, setResetMode] = useState(false);
  // Voluntary password change opened from the header. Without this the
  // change-password screen was only reachable when a password had already
  // expired, so a normal admin had no way to rotate on their own schedule.
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showRecoveryCodes, setShowRecoveryCodes] = useState(false);

  // Fetch expiry/counts so the header can warn before the 30-day hard block.
  const refreshPasswordStatus = useCallback(async () => {
    if (!getAdminSession()) return;
    try {
      const res = await runBackendFunction('adminGetPasswordStatus', []);
      if (res && res.status) setPasswordStatus(res.status);
    } catch {
      // Non-fatal — the header simply omits the expiry hint.
    }
  }, [runBackendFunction]);

  // Logging out is reversible, so it no longer asks first.
  const handleAdminLogout = () => {
    // Drops the session token too, so a shared machine keeps nothing usable.
    clearAdminSession();
    setAdminAuthenticated(false);
    setAdminRole('admin');
    setPasswordInput('');
    addToast('ออกจากระบบแล้ว', 'info');
  };

  const getInitialCache = () => {
    try {
      if (typeof window !== 'undefined') {
        const cached = localStorage.getItem('rocket_sci_dashboard_cache');
        if (cached) return JSON.parse(cached);
      }
    } catch {
      // ignore invalid cache
    }
    return null;
  };

  const deduplicatePlayersList = (list) => {
    if (!Array.isArray(list)) return [];
    const map = new Map();
    for (const p of list) {
      if (!p) continue;
      const lineId = (p.lineUserId && String(p.lineUserId).trim().startsWith('U')) ? String(p.lineUserId).trim() : '';
      const shortId = (p.shortId && String(p.shortId).trim().startsWith('PL')) ? String(p.shortId).trim() :
                      (p.id && String(p.id).trim().startsWith('PL')) ? String(p.id).trim() : '';

      let existingKey = null;
      for (const [k, item] of map.entries()) {
        const matchLine = lineId && item.lineUserId && item.lineUserId === lineId;
        const matchShort = shortId && (item.shortId === shortId || item.id === shortId);
        const matchId = (p.id && (item.id === p.id || item.shortId === p.id));
        if (matchLine || matchShort || matchId) {
          existingKey = k;
          break;
        }
      }

      const primaryKey = lineId || shortId || p.id || (p.displayName || p.name);
      if (!primaryKey) continue;

      if (existingKey) {
        const existing = map.get(existingKey);
        map.set(existingKey, {
          ...existing,
          ...p,
          id: shortId || existing.shortId || existing.id || primaryKey,
          shortId: shortId || existing.shortId || existing.id || primaryKey,
          lineUserId: lineId || existing.lineUserId || '',
          name: p.name || p.displayName || existing.name || existing.displayName || 'ผู้เล่น',
          displayName: p.displayName || p.name || existing.displayName || existing.name || 'ผู้เล่น',
          balance: (p.balance !== undefined && !isNaN(Number(p.balance))) ? Number(p.balance) : (Number(existing.balance) || 0),
          bankName: p.bankName || existing.bankName || '',
          bankAccount: p.bankAccount || p.accountNumber || existing.bankAccount || existing.accountNumber || '',
          accountName: p.accountName || existing.accountName || p.displayName || p.name || '',
          avatar: existing.avatar || p.avatar || '🐉',
        });
      } else {
        map.set(primaryKey, {
          ...p,
          id: shortId || p.id || primaryKey,
          shortId: shortId || p.id || primaryKey,
          lineUserId: lineId || p.lineUserId || '',
          name: p.name || p.displayName || 'ผู้เล่น',
          displayName: p.displayName || p.name || 'ผู้เล่น',
          balance: Number(p.balance) || 0,
          bankName: p.bankName || '',
          bankAccount: p.bankAccount || p.accountNumber || '',
          accountName: p.accountName || p.displayName || p.name || '',
          avatar: p.avatar || '🐉',
        });
      }
    }
    return Array.from(map.values());
  };

  const initialCache = getInitialCache();
  const lastDashboardCacheRef = useRef('');

  const [players, setPlayers] = useState(() => deduplicatePlayersList(initialCache?.players || INITIAL_PLAYERS));
  const [transactions, setTransactions] = useState(initialCache?.transactions || []);
  const [bets, setBets] = useState(initialCache?.bets || []);
  
  const [flights, setFlights] = useState([]);
  
  // Dashboard & Navigation controls (default to quote setup first)
  const [adminTab, setAdminTab] = useState('quote'); // 'quote' | 'settle' | 'bets' | 'review' | 'players' | 'logs' | 'broadcast' | 'bank'
  const [customBroadcastText, setCustomBroadcastText] = useState('');
  // Daily duel summary: the Thai calendar day to summarise, and its preview.
  const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const [summaryDay, setSummaryDay] = useState(bangkokToday);
  const [summaryPreview, setSummaryPreview] = useState(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);
  const [betStatusFilter, setBetStatusFilter] = useState('all'); // 'all' | 'matched' | 'pending_match' | 'cancelled' | 'resolved'
  const [betSearchQuery, setBetSearchQuery] = useState('');
  const [toasts, setToasts] = useState([]);
  const { ask, dialog } = useAdminDialog();

  // Transaction filtering & search & detail modal states
  const [txSearchQuery, setTxSearchQuery] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState('all'); // 'all' | 'escalated' | 'success' | 'rejected'
  const [txTypeFilter, setTxTypeFilter] = useState('all'); // 'all' | 'deposit' | 'withdrawal'
  const [txDetailModal, setTxDetailModal] = useState(null);

  // Player bank edit modal state
  const [bankEditModal, setBankEditModal] = useState(null);
  const [bankEditForm, setBankEditForm] = useState({ bankName: '', bankAccount: '', accountName: '' });
  const [bankEditSaving, setBankEditSaving] = useState(false);

  // The account players are told to transfer deposits to, shown by the LINE OA
  // deposit screen. Editable here so an account change is a form submission
  // rather than a code change plus redeploy — and so the operator can see what
  // players are actually being told without reading the source.
  const [paymentBank, setPaymentBank] = useState({ bankName: '', accountNumber: '', accountName: '', note: '' });
  const [paymentBankSaving, setPaymentBankSaving] = useState(false);
  // Second factor for the irreversible Factory Reset. Held only long enough to
  // save — the PIN itself is never fetched back or cached, only its existence.
  const [dangerPin, setDangerPin] = useState('');
  const [dangerPinSaving, setDangerPinSaving] = useState(false);

  // Load the deposit account once authenticated, and save changes back.
  useEffect(() => {
    if (!adminAuthenticated) return;
    let cancelled = false;
    runBackendFunction('adminGetBankDetails', [])
      .then((res) => {
        if (cancelled || !res || !res.bank) return;
        setPaymentBank({
          bankName: res.bank.bankName || '',
          accountNumber: res.bank.accountNumber || '',
          accountName: res.bank.accountName || '',
          note: res.bank.note || '',
        });
      })
      .catch(() => { /* the panel simply shows empty fields */ });
    return () => { cancelled = true; };
  }, [adminAuthenticated]);

  const handleSavePaymentBank = async () => {
    setPaymentBankSaving(true);
    try {
      const res = await runBackendFunction('adminSetBankDetails', [
        paymentBank.bankName,
        paymentBank.accountNumber,
        paymentBank.accountName,
        paymentBank.note,
      ]);
      if (res && res.success === false) {
        addToast(`บันทึกไม่สำเร็จ: ${res.error || 'ข้อมูลไม่ครบถ้วน'}`, 'danger');
        return;
      }
      if (res && res.bank) {
        setPaymentBank({
          bankName: res.bank.bankName || '',
          accountNumber: res.bank.accountNumber || '',
          accountName: res.bank.accountName || '',
          note: res.bank.note || '',
        });
      }
      addToast('บันทึกบัญชีรับเงินเรียบร้อย (ใช้กับข้อความฝากใน LINE ทันที)', 'success');
    } catch (err) {
      addToast(`บันทึกไม่สำเร็จ: ${err?.message || err}`, 'danger');
    } finally {
      setPaymentBankSaving(false);
    }
  };

  const handleSaveDangerPin = async () => {
    setDangerPinSaving(true);
    try {
      await runBackendFunction('adminSetDangerPin', [dangerPin]);
      setDangerPin('');
      addToast('ตั้งค่า PIN สำหรับการล้างข้อมูลระบบเรียบร้อย', 'success');
    } catch (err) {
      addToast(`บันทึกไม่สำเร็จ: ${err?.message || err}`, 'danger');
    } finally {
      setDangerPinSaving(false);
    }
  };

  // Player full-edit modal (rename + balance + delete)
  const [playerEditModal, setPlayerEditModal] = useState(null); // { player }
  const [playerEditForm, setPlayerEditForm] = useState({ name: '', balance: 0 });
  const [playerEditSaving, setPlayerEditSaving] = useState(false);

  // Create player modal
  const [createPlayerModal, setCreatePlayerModal] = useState(false);
  const [createPlayerForm, setCreatePlayerForm] = useState({ lineId: '', name: '', balance: 0 });
  const [createPlayerSaving, setCreatePlayerSaving] = useState(false);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(null); // { player }
  const [deleteSaving, setDeleteSaving] = useState(false);
  
  
  // Rocket telemetry states
  const [rocketName, setRocketName] = useState(''); // Technician / Rocket Team Name (entered manually by admin)
  const [targetMin, setTargetMin] = useState(''); // Range Min (entered manually by admin)
  const [targetMax, setTargetMax] = useState(''); // Range Max (entered manually by admin)
  /**
   * Fields the admin has typed into. A ref, not state: the poll reads it on
   * every tick and a state update would re-run the effect that owns the poll.
   * Set once on first edit, so live server data stops overwriting the input
   * while it is being edited. Cleared when a quote is published, because that
   * legitimately changes what the admin should be working from.
   */
  const touchedFieldsRef = useRef({ rocketName: false, targetMin: false, targetMax: false });
  const markTouched = (field) => { touchedFieldsRef.current[field] = true; };
  const clearTouched = () => { touchedFieldsRef.current = { rocketName: false, targetMin: false, targetMax: false }; };
  const [quoteBetAmount, setQuoteBetAmount] = useState(''); // Bet Amount (entered manually by admin)
  const [quoteIsChotoy, setQuoteIsChotoy] = useState(false);

  const handleBroadcastFastQuote = async (overrideMin = null, overrideMax = null, overrideChotoy = null) => {
    const min = overrideMin !== null ? overrideMin : targetMin;
    const max = overrideMax !== null ? overrideMax : targetMax;
    const isChotoy = overrideChotoy !== null ? overrideChotoy : quoteIsChotoy;
    const name = rocketName.trim() || 'ช่างบั้งไฟสด';

    if (!min || !max || Number(min) >= Number(max)) {
      addToast('กรุณากรอกช่วงราคาช่างให้ถูกต้อง (Min ต้องน้อยกว่า Max) ก่อนประกาศออกราคาครับ', 'warning');
      return;
    }

    try {
      const res = await runBackendFunction('adminBroadcastQuote', [broadcastTargetGroup || 'ALL', name, min, max, isChotoy]);
      if (res && res.success === false) {
        addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
      } else {
        // Quote published: the round's authoritative values now match what is
        // on screen, so the inputs are released and the poll may manage them
        // again for the next round.
        clearTouched();
        addToast(`ประกาศราคาสำเร็จ (${min}-${max}s)`, 'success');
      }
    } catch {
      addToast('ส่งไม่สำเร็จ', 'danger');
    }
  };
  const [customRocketTime, setCustomRocketTime] = useState(''); // Manual entry by admin (blank default)
  const [flightLogs, setFlightLogs] = useState([]);
  const [settlementResult, setSettlementResult] = useState(null); // Settle results popup summary
  const [activeGroupId, setActiveGroupId] = useState(null); // Active connected LINE Group ID
  const [lineGroups, setLineGroups] = useState([]); // List of active connected LINE Groups
  const [broadcastTargetGroup, setBroadcastTargetGroup] = useState('ALL'); // Multi-group broadcast target

  // Concurrent / In-Flight Rocket Rounds State (Rocket A in air while Rocket B opens)
  const [inFlightRounds, setInFlightRounds] = useState([]);
  const [roundStatus, setRoundStatus] = useState('IDLE');
  const [activeRoundObj, setActiveRoundObj] = useState(null);
  const [nextRocketName, setNextRocketName] = useState('');
  const [nextRocketMode, setNextRocketMode] = useState('pre_quote'); // 'pre_quote' | 'quote'
  const [nextRocketMin, setNextRocketMin] = useState('');
  const [nextRocketMax, setNextRocketMax] = useState('');
  const [nextRocketChotoy, setNextRocketChotoy] = useState(false);
  const [nextRocketBroadcast, setNextRocketBroadcast] = useState(true);
  const [isOpeningNextRocket, setIsOpeningNextRocket] = useState(false);
  const [inFlightTimes, setInFlightTimes] = useState({}); // { [roundId]: '' }
  const [settlingInFlightId, setSettlingInFlightId] = useState(null);

  // Detect live Node.js Express backend (localhost, Render, Vercel, Railway, or custom host)
  const isLiveBackend = typeof window !== 'undefined' && !isGAS;

  // Unified live-data: GAS uses polling RPC; GitHub Pages polls GAS directly; Node.js uses SSE
  useEffect(() => {
    // Only poll when authenticated as admin or viewing as specific player
    if (!adminAuthenticated && !playerUserId) {
      return;
    }

    const applyData = (data) => {
      if (!data) return;
      if (Array.isArray(data.players)) setPlayers(deduplicatePlayersList(data.players));
      if (Array.isArray(data.transactions)) setTransactions(data.transactions);
      if (Array.isArray(data.bets)) setBets(data.bets);
      if (Array.isArray(data.flights)) setFlights(data.flights);
      if (Array.isArray(data.inFlightRounds)) setInFlightRounds(data.inFlightRounds);
      if (data.roundStatus) setRoundStatus(data.roundStatus);
      if (data.activeGroupId !== undefined) setActiveGroupId(data.activeGroupId);
      if (data.lineGroups && data.lineGroups.length > 0) {
        setLineGroups(data.lineGroups);
      } else if (data.activeGroupId) {
        setLineGroups([{ id: data.activeGroupId, name: `กลุ่มดวลสด LINE (#${data.activeGroupId.slice(-4)})`, lastMessage: 'เชื่อมต่อสำเร็จ', timestamp: 'Live' }]);
      } else if (Array.isArray(data.lineGroups)) {
        setLineGroups([]);
      }
      if (data.activeRound) {
        setActiveRoundObj(data.activeRound);
        if (data.activeRound.status) setRoundStatus(data.activeRound.status);
        // Do NOT write into a field the admin is currently editing.
        //
        // The poll runs every <600ms. Previously the round was copied into the
        // inputs whenever the local value was empty — and for the name, also
        // whenever it equalled the default string. So backspacing to empty (or
        // to the default) made the server value snap straight back within one
        // poll, and deleting a character looked impossible: the old text kept
        // reappearing. Once an admin touches a field it is theirs until the
        // round is explicitly reloaded below.
        const touched = touchedFieldsRef.current;
        if (data.activeRound.name && !touched.rocketName) {
          setRocketName(prev => (!prev || prev === 'ช่างบั้งไฟสด') ? data.activeRound.name : prev);
        }
        if (data.activeRound.targetMin && !touched.targetMin) {
          setTargetMin(prev => (!prev ? String(data.activeRound.targetMin) : prev));
        }
        if (data.activeRound.targetMax && !touched.targetMax) {
          setTargetMax(prev => (!prev ? String(data.activeRound.targetMax) : prev));
        }
        if (data.activeRound.isChotoy !== undefined) setQuoteIsChotoy(Boolean(data.activeRound.isChotoy));
      }
      try {
        if (typeof window !== 'undefined') {
          const serialized = JSON.stringify(data);
          if (serialized !== lastDashboardCacheRef.current) {
            lastDashboardCacheRef.current = serialized;
            localStorage.setItem('rocket_sci_dashboard_cache', serialized);
          }
        }
      } catch {
        // ignore cache write errors
      }
    };

    // ── Live Cloudflare Worker: sub-second adaptive polling (< 600ms) with zero-stacking ──
    // Cloudflare Worker holds the authoritative live KV state (bets, players, active round).
    // Direct edge polling delivers < 600ms updates on all hosts (GAS Web App, GitHub Pages, Local).
    let cancelled = false;
    const targetUrl = API_BASE_URL || CF_WORKER_BASE_URL;

    let lastEtagRef = null;

    const fetchFromBackend = async () => {
      try {
        const session = getAdminSession();
        const res = await fetch(`${targetUrl}/api/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(session ? { 'x-admin-session': session } : {}),
            // Ask the edge to skip the response body entirely when nothing changed.
            ...(lastEtagRef ? { 'If-None-Match': lastEtagRef } : {}),
          },
          body: JSON.stringify({ functionName: 'getDashboardData', adminSession: session || undefined }),
        });

        if (res.status === 401) {
          clearAdminSession();
          setAdminAuthenticated(false);
          return 'unchanged';
        }

        // 403 = the session is valid but not permitted to do this — in practice
        // a password-change (scope:'reset') token. Treating it as "unchanged"
        // is what let the console sit there permanently blank with no clue why
        // LINE OA deposits were not appearing; bounce the operator to the
        // password screen instead of showing a stale, empty dashboard.
        if (res.status === 403) {
          let requiresPasswordChange = true;
          try {
            const body403 = await res.clone().json();
            requiresPasswordChange = body403?.requiresPasswordChange !== false;
          } catch { /* default to the password-change path */ }
          if (requiresPasswordChange) {
            setPasswordStatus(null);
            setMustChangePassword(true);
          } else {
            clearAdminSession();
            setAdminAuthenticated(false);
          }
          return 'unchanged';
        }

        // 304 = state unchanged. Keep the previous data, skip the parse entirely.
        if (res.status === 304) return 'unchanged';

        if (res.ok) {
          const etag = res.headers.get('ETag');
          if (etag) lastEtagRef = etag;
          const json = await res.json();
          const payload = json?.data || json?.result || json;
          if (payload && (payload.players || payload.activeRound || payload.bets)) {
            applyData(payload);
            return 'changed';
          }
        }
        return 'unchanged';
      } catch {
        // Network failure invalidates the cached ETag — the state may have moved on.
        lastEtagRef = null;
        // Fallback to GAS RPC only if network fetch to Worker fails and in GAS
        if (isGAS && typeof window !== 'undefined' && window.google?.script?.run) {
          const gas = window.google.script.run;
          if (typeof gas.getDashboardData === 'function') {
            gas.withSuccessHandler(applyData).getDashboardData();
          }
        }
        return 'unchanged';
      }
    };

    // ── Adaptive Polling Loop ──
    // Fast while state is actually moving (a LINE OA deposit or an admin action
    // lands within ~500ms, which is what makes the two platforms feel instant),
    // then backs off to 3s once things have been quiet for a while.
    //
    // A flat 500ms loop costs ~173k requests/day — past the Workers Free cap of
    // 100k on its own — so backing off when idle is what keeps a console left
    // open all day from exhausting the quota. Any real change resets to fast,
    // so responsiveness during active play is unchanged.
    let quietPolls = 0;
    const FAST_DELAY = 500;
    const MAX_DELAY = 3000;

    const pollLoop = async () => {
      while (!cancelled) {
        const outcome = await fetchFromBackend();
        quietPolls = outcome === 'changed' ? 0 : quietPolls + 1;
        const hidden = typeof document !== 'undefined' && document.hidden;
        // Ramp 500ms -> 1s -> 2s -> 3s across three idle polls.
        const delay = hidden
          ? 3000
          : Math.min(MAX_DELAY, FAST_DELAY * Math.pow(2, Math.min(quietPolls, 3)));
        await new Promise((r) => setTimeout(r, delay));
      }
    };

    pollLoop();

    // Return to full speed the moment the admin looks at the console again, so
    // backing off never costs perceived responsiveness.
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !cancelled) {
        quietPolls = 0;
        fetchFromBackend();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [isGAS, isLiveBackend, isGitHubPages, API_BASE_URL, adminAuthenticated, playerUserId]);

  // Toast notifications. Success/info hide after 4s and warnings after 6s;
  // errors stay until clicked so they can be read. At most 3 are shown.
  const TOAST_DURATION = { success: 4000, info: 4000, warning: 6000 };
  const addToast = (msg, type = 'info', duration = TOAST_DURATION[type] ?? 0) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }].slice(-3));
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
    return id;
  };

  const removeToast = (id) => {
    if (!id) return;
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Safe portal close & round-reset function (preserves player data & transaction history)
  const handleClosePortal = async () => {
    const activeMatched = bets.filter(b => b.status === 'matched');
    const pending = bets.filter(b => b.status === 'pending_match');
    const pendingPt = pending.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const ok = await ask({
      title: `ปิดรอบ “${activeRoundObj?.name || rocketName || 'รอบปัจจุบัน'}”?`,
      tone: activeMatched.length > 0 ? 'danger' : 'primary',
      items: [
        ...(activeMatched.length > 0
          ? [`แผลที่ต่อติดแล้ว ${activeMatched.length} แผลยังไม่ได้ตัดสินผล จะถูกยกเลิกและคืนเงินทั้งสองฝ่าย 100%`]
          : []),
        `คืนเงินแผลที่รอคู่ ${pending.length} แผล · ${pendingPt.toLocaleString()} pt`,
        'ล้างกระดานและเปิดรอบใหม่ทันที',
        'ข้อมูลผู้เล่น ยอดเครดิต และประวัติธุรกรรมไม่ถูกลบ',
      ],
      confirmLabel: activeMatched.length > 0 ? 'ปิดรอบและคืนเงินทุกแผล' : 'ปิดรอบ',
    });
    if (!ok) return;

    const loadingToastId = addToast('กำลังปิดรอบและรีเซ็ตระบบ...', 'info');
    try {
      const data = await runBackendFunction('adminCloseRound', []);
      removeToast(loadingToastId);
      if (data && data.success === false) {
        addToast(`ปิดรอบไม่สำเร็จ: ${data.message || data.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }

      // Clear local UI state
      setSettlementResult(null);
      setRocketName('');
      setTargetMin('');
      setTargetMax('');
      setQuoteBetAmount('');
      setQuoteIsChotoy(false);
      clearTouched();
      setCustomRocketTime('');
      setBets([]);
      setInFlightRounds([]);

      // Pull fresh data so balances & players reflect refunds immediately
      await forceSyncFreshData();

      const refunded = data?.clearedOrders ?? data?.clearedPending ?? 0;
      addToast(
        refunded > 0
          ? `ปิดรอบเรียบร้อย — คืนแต้ม ${refunded} แผลค้างอยู่ เปิดรอบใหม่แล้ว `
          : 'ปิดรอบและเปิดรอบใหม่เรียบร้อยแล้ว',
        'success'
      );
    } catch (err) {
      console.error('handleClosePortal error:', err);
      addToast('ปิดรอบไม่สำเร็จ:' + (err.message || err), 'danger');
    }
  };

  // Expose reset state for debug button (preventing reference error)
  const resetConsoleState = async () => {
    if (adminRole !== 'superadmin') {
      addToast('สิทธิ์ไม่เพียงพอ: บัญชีผู้ดูแลนี้ไม่มีสิทธิ์ล้างระเบียนข้อมูลระบบ (เฉพาะ Super Admin เท่านั้น)', 'danger');
      return;
    }

    // The reset is irreversible with no backup (the GAS mirror is unreachable),
    // so it requires typing the phrase AND the PIN. The PIN is re-checked
    // server-side: the dialog is a speed bump rather than the actual lock.
    const ok = await ask({
      title: 'ล้างข้อมูลทั้งระบบ (Factory Reset)',
      tone: 'danger',
      body: 'ลบถาวรข้อมูลผู้เล่น ยอดเครดิต ธุรกรรม ประวัติการเดิมพัน และบันทึกแชททั้งหมด ไม่มีการสำรองข้อมูลและย้อนกลับไม่ได้',
      typeToConfirm: 'DELETE',
      fields: [{
        name: 'pin',
        label: 'PIN ล้างข้อมูล (ตั้งไว้ในหัวข้อ “ความปลอดภัย” ไม่ใช่รหัสผ่าน)',
        type: 'password',
        validate: (v) => (v.trim() ? null : 'กรุณากรอก PIN'),
      }],
      confirmLabel: 'ลบข้อมูลทั้งหมด',
    });
    if (!ok) return;
    const pin = ok.values.pin;

    setSettlementResult(null);

    let resetLoadingToastId = null;
    try {
      resetLoadingToastId = addToast('กำลังล้างระเบียนข้อมูลระบบ (Factory Reset)...', 'info');
      const data = await runBackendFunction('resetGoogleSheetsDatabase', [pin]);
      removeToast(resetLoadingToastId);
      if (data) {
        if (data.players) setPlayers(deduplicatePlayersList(data.players));
        if (data.transactions) setTransactions(data.transactions);
        if (data.bets) setBets(data.bets);
      } else {
        setPlayers(INITIAL_PLAYERS);
        setTransactions([]);
        setBets([]);
      }
      setInFlightRounds([]);
      try {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('rocket_sci_dashboard_cache');
        }
      } catch {
        // ignore cache removal error
      }
      addToast('ล้างระเบียนข้อมูลระบบ (Factory Reset) สำเร็จแล้ว', 'success');
    } catch (err) {
      console.error("Failed to reset database:", err);
      addToast('เกิดข้อผิดพลาดในการล้างระเบียนระบบ: ' + (err.message || err), 'error');
    }
  };

  const forceSyncFreshData = async () => {
    const loadingToastId = addToast('กำลังดึงข้อมูลล่าสุดจากฐานข้อมูล...', 'info');
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('rocket_sci_dashboard_cache');
      }
      const d = await runBackendFunction('getDashboardData', []);
      removeToast(loadingToastId);
      if (d) {
        if (Array.isArray(d.players)) setPlayers(deduplicatePlayersList(d.players));
        if (Array.isArray(d.transactions)) setTransactions(d.transactions);
        if (Array.isArray(d.bets)) setBets(d.bets);
        if (Array.isArray(d.inFlightRounds)) setInFlightRounds(d.inFlightRounds);
        if (d.roundStatus) setRoundStatus(d.roundStatus);
        if (d.activeRound) setActiveRoundObj(d.activeRound);
        if (d.activeGroupId !== undefined) setActiveGroupId(d.activeGroupId);
        if (d.lineGroups) setLineGroups(d.lineGroups);
        if (typeof window !== 'undefined') {
          localStorage.setItem('rocket_sci_dashboard_cache', JSON.stringify(d));
        }
        addToast('ดึงข้อมูลสดสำเร็จ', 'success');
      }
    } catch (e) {
      removeToast(loadingToastId);
      console.error('[Force Sync Error]:', e);
      addToast('ไม่สามารถดึงข้อมูลสดได้', 'error');
    }
  };

  // ── Concurrent Round Handlers: Open Rocket B while Rocket A is in the air ──
  const handleOpenNextRocket = async () => {
    const cleanName = (nextRocketName || '').trim() || 'บั้งไฟชุดต่อไป';
    if (nextRocketMode === 'quote') {
      const minNum = Number(nextRocketMin);
      const maxNum = Number(nextRocketMax);
      if (!minNum || !maxNum || minNum <= 0 || maxNum <= 0) {
        addToast('กรุณาระบุช่วงราคาเปิด (Min - Max) ให้ถูกต้องสำหรับโหมดออกราคาช่างทันที', 'warning');
        return;
      }
    }

    setIsOpeningNextRocket(true);
    try {
      const res = await runBackendFunction('adminOpenNextRocket', [
        broadcastTargetGroup || 'ALL',
        cleanName,
        nextRocketMode,
        nextRocketMode === 'quote' ? Number(nextRocketMin) : 0,
        nextRocketMode === 'quote' ? Number(nextRocketMax) : 0,
        Boolean(nextRocketChotoy),
        Boolean(nextRocketBroadcast),
      ]);
      if (res && res.success === false) {
        addToast(`เปิดรอบถัดไปไม่สำเร็จ: ${res.message || res.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }

      // Sync active rocket form fields to the newly opened Rocket B
      clearTouched();
      setRocketName(cleanName);
      if (nextRocketMode === 'quote') {
        setTargetMin(String(nextRocketMin));
        setTargetMax(String(nextRocketMax));
        setQuoteIsChotoy(Boolean(nextRocketChotoy));
      } else {
        setTargetMin('');
        setTargetMax('');
        setQuoteIsChotoy(false);
      }

      setNextRocketName('');
      setNextRocketMin('');
      setNextRocketMax('');
      setNextRocketChotoy(false);

      await forceSyncFreshData();

      if (res?.parkedRound) {
        addToast(`พักบั้งไฟ "${res.parkedRound.name}" (${res.parkedRound.matchedCount} คู่ดวล) ไว้รอผลเวลา และเปิดรับดวล "${cleanName}" สำเร็จ!`, 'success');
      } else {
        addToast(`เปิดรอบบั้งไฟใหม่ "${cleanName}" พร้อมรับออเดอร์แล้ว!`, 'success');
      }
    } catch (err) {
      console.error('handleOpenNextRocket error:', err);
      addToast('เปิดรอบบั้งไฟถัดไปไม่สำเร็จ:' + (err.message || err), 'danger');
    } finally {
      setIsOpeningNextRocket(false);
    }
  };

  const handleSettleInFlightRound = async (flt) => {
    const rawTime = inFlightTimes[flt.roundId];
    const finalSec = Number(rawTime);
    if (!rawTime || isNaN(finalSec) || finalSec <= 0) {
      addToast(`กรุณากรอกเวลาบินจริง (วินาที) ของบั้งไฟ "${flt.name}" ให้ถูกต้อง`, 'warning');
      return;
    }

    setSettlingInFlightId(flt.roundId);
    try {
      const res = await runBackendFunction('adminResolveInFlightRound', [flt.roundId, finalSec]);
      if (res && res.success === false) {
        addToast(`ตัดสินผลไม่สำเร็จ: ${res.message || res.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }
      setInFlightTimes(prev => {
        const next = { ...prev };
        delete next[flt.roundId];
        return next;
      });
      if (res?.summary) {
        setSettlementResult(res.summary);
      }
      setFlightLogs(prev => [
        `[${new Date().toLocaleTimeString('th-TH')}] ตัดสินบั้งไฟกลางอากาศ "${flt.name}" เวลา ${finalSec}s เคลียร์ ${res?.resolvedCount ?? 0} คู่ดวล`,
        ...prev,
      ]);
      await forceSyncFreshData();
      addToast(`ตัดสินผลบั้งไฟ "${flt.name}" (${finalSec} วินาที) และโอนแต้มเรียบร้อย! (ไม่กระทบแผลรอบปัจจุบัน)`, 'success');
    } catch (err) {
      console.error('handleSettleInFlightRound error:', err);
      addToast('ตัดสินผลไม่สำเร็จ:' + (err.message || err), 'danger');
    } finally {
      setSettlingInFlightId(null);
    }
  };

  const handleVoidInFlightRound = async (flt) => {
    const ok = await ask({
      title: `โมฆะบั้งไฟ “${flt.name}”`,
      tone: 'danger',
      items: [
        `คืนเงิน ${flt.matchedCount || (flt.matchedOrders || []).length} คู่ดวลของบั้งไฟนี้ 100% และย้อนกลับไม่ได้`,
        'ออเดอร์ของบั้งไฟรอบใหม่ที่กำลังเปิดรับอยู่ไม่ได้รับผลกระทบ',
      ],
      typeToConfirm: flt.name,
      confirmLabel: 'โมฆะและคืนเงิน',
    });
    if (!ok) return;
    setSettlingInFlightId(flt.roundId);
    try {
      const res = await runBackendFunction('adminVoidInFlightRound', [flt.roundId, broadcastTargetGroup || 'ALL']);
      if (res && res.success === false) {
        addToast(`โมฆะรอบไม่สำเร็จ: ${res.message || res.error || 'เกิดข้อผิดพลาด'}`, 'danger');
        return;
      }
      await forceSyncFreshData();
      addToast(`โมฆะบั้งไฟ "${flt.name}" และคืนแต้ม ${res?.voidedCount ?? 0} คู่ดวลเรียบร้อยแล้ว`, 'warning');
    } catch (err) {
      console.error('handleVoidInFlightRound error:', err);
      addToast('โมฆะรอบไม่สำเร็จ:' + (err.message || err), 'danger');
    } finally {
      setSettlingInFlightId(null);
    }
  };
  
  // Attach resetConsoleState and forceSyncFreshData to window context for global call safety
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.resetConsoleState = resetConsoleState;
      window.handleClosePortal = handleClosePortal;
      window.forceSyncFreshData = forceSyncFreshData;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cancel Bet Request
  const handleRequestCancelBet = async (betId) => {
    const bet = bets.find(b => b.id === betId);
    const ok = await ask({
      title: `ยกเลิกออเดอร์ #${bet?.orderNumber ?? betId}?`,
      items: [
        `คืนเงิน ${(bet?.amount || 0).toLocaleString()} pt ให้ ${bet?.creatorName || 'เจ้าของแผล'}`,
        'ผู้เล่นจะได้รับแจ้งทาง LINE',
      ],
      confirmLabel: `ยกเลิกและคืน ${(bet?.amount || 0).toLocaleString()} pt`,
    });
    if (!ok) return;
    try {
      const res = await runBackendFunction('adminRequestCancelBet', [betId]);
      if (res && res.success === false) {
        addToast(`ยกเลิกไม่สำเร็จ: ${res.message || res.error || 'ไม่ทราบสาเหตุ'}`, 'error');
        return;
      }
      addToast(`ยกเลิกออเดอร์ #${bet?.orderNumber ?? betId} แล้ว`, 'success');
      if (typeof window !== 'undefined' && typeof window.forceSyncFreshData === 'function') {
        window.forceSyncFreshData();
      }
    } catch (err) {
      console.error('[Cancel Bet Error]:', err);
      addToast('ยกเลิกไม่สำเร็จ: ' + (err.message || err), 'error');
    }
  };

  // Admin Manual Slip Reviews
  const handleAdminApproveReview = (txId) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }
    const approvedAmount = (targetTx.actualAmount && targetTx.actualAmount > 0) ? targetTx.actualAmount : (targetTx.requestedAmount || 0);

    // OPTIMISTIC UPDATE: Update React State Instantly (0ms response time for admin!)
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'success', actualAmount: approvedAmount, reviewReason: 'Manually approved by admin' } : t));
    if (!txId.startsWith('WD')) {
      setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + approvedAmount } : p));
    }
    addToast(txId.startsWith('WD') ? `แอดมินอนุมัติคำขอถอนเงินยอด ${targetTx.requestedAmount} THB โอนเงินแล้วเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)` : `แอดมินอนุมัติเครดิตเติมเงินยอด ${approvedAmount} THB แมนนวลเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'success');

    // Run backend via Cloudflare Worker Edge API
    runBackendFunction('adminApproveTransaction', [txId])
      .then(() => {
        if (typeof window !== 'undefined' && typeof window.forceSyncFreshData === 'function') {
          window.forceSyncFreshData();
        }
      })
      .catch((err) => {
        console.error('[Background Approve Error]:', err);
        // Rollback on failure
        setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
        if (!txId.startsWith('WD')) {
          setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - approvedAmount } : p));
        }
        addToast('เกิดข้อผิดพลาดในการบันทึกหลังบ้าน:' + (err.message || err), 'error');
      });
  };

  const handleAdminRejectReview = (txId, reason) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }

    // OPTIMISTIC UPDATE: Update React State Instantly (0ms response time for admin!)
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'rejected', reviewReason: reason } : t));
    if (txId.startsWith('WD')) {
      setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + targetTx.requestedAmount } : p));
      addToast(`ปฏิเสธคำขอถอนเงินยอด ${targetTx.requestedAmount} THB และคืนเครดิตให้ผู้เล่นเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'info');
    } else {
      addToast('ปฏิเสธการโอนสลิปเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)', 'info');
    }

    // Run backend via Cloudflare Worker Edge API
    runBackendFunction('adminRejectTransaction', [txId, reason])
      .then(() => {
        if (typeof window !== 'undefined' && typeof window.forceSyncFreshData === 'function') {
          window.forceSyncFreshData();
        }
      })
      .catch((err) => {
        console.error('[Background Reject Error]:', err);
        // Rollback on failure
        setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
        if (txId.startsWith('WD')) {
          setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - targetTx.requestedAmount } : p));
        }
        addToast('เกิดข้อผิดพลาดในการบันทึกหลังบ้าน:' + (err.message || err), 'error');
      });
  };

  // Submit manual telemetry flight result (No flight animation, resolve immediately)
  const handleSubmitOnsiteResult = (finalTime) => {
    if (!finalTime || finalTime <= 0) {
      addToast('กรุณาระบุเวลาผลการบินของบั้งไฟให้ถูกต้อง', 'warning');
      return;
    }

    if (!targetMin || !targetMax || Number(targetMin) >= Number(targetMax)) {
      addToast('กรุณาระบุช่วงราคาช่าง (Min ต้องน้อยกว่า Max) ก่อนชำระแต้มครับ', 'warning');
      return;
    }

    const activeMatched = bets.filter(b => b.status === 'matched');
    if (activeMatched.length === 0) {
      addToast('ไม่พบแผลดวลที่จับคู่สำเร็จ (Matched Bets = 0) ในรอบนี้! ระบบไม่สามารถชำระแต้มได้', 'warning');
      return;
    }

    setFlightLogs(prev => [`[LAUNCHPAD] [${new Date().toLocaleTimeString()}] Manual telemetry result submitted: ${finalTime}s.`, ...prev]);

    resolveMatchedBets(finalTime);
  };

  // Settle bets and calculate payouts (instant, no animations)
  const resolveMatchedBets = async (finalTime) => {
    const timeSec = Number(finalTime);
    const tMin = targetMin ? Number(targetMin) : 330;
    const tMax = targetMax ? Number(targetMax) : 380;
    const name = rocketName || 'ช่างบั้งไฟสด';

    setFlightLogs(prev => [`Telemetry link settled. Final Air Time: ${finalTime}s.`, ...prev]);

    // Calculate payouts details from currently matched bets for the popup modal
    const previouslyMatched = bets.filter(b => b.status === 'matched');
    const payouts = previouslyMatched.map(b => {
      const minSec = Number.isFinite(Number(b.rangeMin)) && Number(b.rangeMin) > 0 ? Number(b.rangeMin) : tMin;
      const maxSec = Number.isFinite(Number(b.rangeMax)) && Number(b.rangeMax) > 0 ? Number(b.rangeMax) : tMax;

      const isLowOrder = b.side === 'low';
      const lowWinnerName = b.playerLowName || (isLowOrder ? b.creatorName : b.matcherName) || 'ฝั่งต่ำ';
      const highWinnerName = b.playerHighName || (!isLowOrder ? b.creatorName : b.matcherName) || 'ฝั่งสูง';

      let winnerSide = 'draw';
      if (timeSec < minSec) {
        winnerSide = 'low';
      } else if (timeSec > maxSec) {
        winnerSide = 'high';
      }

      const amt = Number(b.amount) || 0;
      const commission = winnerSide !== 'draw' ? Math.round(amt * 0.10) : 0;
      const payout = winnerSide !== 'draw' ? amt + (amt - commission) : amt;
      const winnerName = winnerSide === 'low'
        ? lowWinnerName
        : winnerSide === 'high'
          ? highWinnerName
          : `เสมอ (${lowWinnerName} & ${highWinnerName} คืนทุน)`;

      return {
        orderNumber: b.orderNumber,
        winnerName: winnerName,
        winnerSide: winnerSide,
        rangeMin: minSec,
        rangeMax: maxSec,
        amount: amt,
        commission: commission,
        payout: payout
      };
    });

    setSettlementResult({
      rocketName: name,
      finalTime: finalTime,
      targetMin: tMin,
      targetMax: tMax,
      outcome: timeSec < tMin ? 'LOW' : timeSec > tMax ? 'HIGH' : 'RANGE',
      payouts: payouts
    });

    try {
      const data = await runBackendFunction('adminResolveBets', [finalTime, tMin, tMax]);
      // The round is over and a new one will be opened: release the fields so
      // the live poll may populate them again from the next round's quote.
      clearTouched();
      if (data) {
        if (data.bets) setBets(data.bets);
        if (data.players) setPlayers(deduplicatePlayersList(data.players));
        if (data.transactions) setTransactions(data.transactions);
      }
      addToast(`เคลียร์ผลรางวัลรอบ [${name}] เวลา ${finalTime}s (ช่วง ${tMin}-${tMax}s) และบรอดแคสต์ลงกลุ่มเรียบร้อย!`, 'success');
    } catch (e) {
      console.error('Settlement backend error:', e);
      addToast(`เกิดข้อผิดพลาดในการบันทึกผลการตัดสิน: ${e?.message || 'ระบบหลังบ้านไม่ตอบสนอง'}`, 'error');
    }
  };

  // Render dynamic visual bank slip card in Light Mode
  const renderSlipCard = (presetId, isCustom, custAmt) => {
    let p;
    const effectiveAmt = custAmt || 100;
    if (isCustom || !presetId) {
      p = {
        bankName: 'ธนาคารไทยพาณิชย์ (SCB)',
        amount: effectiveAmt,
        actualAmount: effectiveAmt,
        refCode: 'CUSTX' + effectiveAmt + '9982',
        senderName: 'คุณ (You)',
        bankLogo: '',
        gradient: 'from-purple-50 to-purple-100 border-purple-200 text-purple-950',
        isValidQR: true
      };
    } else {
      p = SLIP_PRESETS.find(pr => pr.id === presetId) || {
        bankName: 'ธนาคารกสิกรไทย (KBANK)',
        amount: effectiveAmt,
        actualAmount: effectiveAmt,
        refCode: 'KBNK' + effectiveAmt + '8827',
        senderName: 'คุณ (You)',
        bankLogo: '',
        gradient: 'from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-950',
        isValidQR: true
      };
    }

    return (
      <div className={`w-full max-w-sm rounded-2xl bg-gradient-to-br ${p.gradient} p-4 border border-slate-200 text-slate-800 font-sans flex flex-col justify-between shadow-sm relative overflow-hidden shrink-0`}>
        <div className="absolute -top-12 -right-12 w-32 h-32 rounded-full bg-slate-900/5 pointer-events-none"></div>
        
        <div className="flex items-center justify-between border-b border-slate-200/80 pb-2 mb-3">
          <div className="flex items-center gap-1.5">
            <span className="text-lg">{p.bankLogo}</span>
            <div className="flex flex-col">
              <span className="text-[11px] font-extrabold tracking-wide uppercase text-slate-800">e-Slip Verified</span>
              <span className="text-[9px] text-slate-500">{p.bankName.split(' ')[0]} Transfer</span>
            </div>
          </div>
          <span className="text-[9.5px] font-mono text-slate-500">{new Date().toLocaleDateString('th-TH')}</span>
        </div>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center bg-white px-2 py-1.5 rounded-lg border border-slate-200/50">
            <span className="text-slate-500 text-[10px]">จาก (Sender):</span>
            <span className="font-bold text-[11px] text-slate-800">{p.senderName}</span>
          </div>

          <div className="flex justify-between items-center bg-white px-2 py-1.5 rounded-lg border border-slate-200/50">
            <span className="text-slate-500 text-[10px]">ไปยัง (Receiver):</span>
            <span className="font-bold text-[11px] text-sky-700">บจก. ร็อคเก็ต ไซเอนซ์</span>
          </div>

          <div className="text-center py-2 bg-slate-200/40 rounded-xl my-2 border border-slate-200">
            <span className="text-[9px] text-slate-500 block">จำนวนเงินโอนจริง (Amount)</span>
            <span className="text-2xl font-black tracking-tight text-slate-800 font-mono">
              {p.actualAmount || p.amount}.00 <span className="text-xs font-bold text-slate-500">THB</span>
            </span>
          </div>

          <div className="flex flex-col gap-0.5 text-[9.5px] text-slate-500 font-mono">
            <div>รหัสอ้างอิง: {p.refCode}</div>
            <div className="flex items-center justify-between mt-1">
              <span>สถานะ QR: {p.isValidQR ? 'มีรหัสตรวจพบ' : 'ไม่มี/เสียหาย'}</span>
              <span className="text-[8px] px-1.5 py-0.5 bg-slate-200/60 rounded text-slate-600 font-bold">API LINKED</span>
            </div>
          </div>
        </div>

        <div className="mt-3 flex justify-between items-center border-t border-slate-200 pt-2 text-[9px] text-slate-500">
          <span className="flex items-center gap-0.5 font-bold">
            <ShieldCheck size={11} className="text-emerald-600" />
            ตรวจสอบอัตโนมัติ 1:1
          </span>
          <div className="w-8 h-8 bg-white p-0.5 rounded flex items-center justify-center shrink-0 border border-slate-200">
            {p.isValidQR ? (
              <svg viewBox="0 0 100 100" className="w-full h-full text-slate-800" fill="currentColor">
                <rect width="100" height="100" fill="white"/>
                <rect x="10" y="10" width="30" height="30" fill="currentColor"/>
                <rect x="60" y="10" width="30" height="30" fill="currentColor"/>
                <rect x="10" y="60" width="30" height="30" fill="currentColor"/>
                <rect x="65" y="65" width="20" height="20" fill="currentColor"/>
                <rect x="45" y="45" width="10" height="10" fill="currentColor"/>
                <rect x="20" y="20" width="10" height="10" fill="white"/>
                <rect x="70" y="20" width="10" height="10" fill="white"/>
                <rect x="20" y="70" width="10" height="10" fill="white"/>
              </svg>
            ) : (
              <div className="text-[7.5px] text-rose-500 font-black font-sans text-center leading-none">BLURRY</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Security Checks
  if (playerUserId) {
    const matchedPlayer = players.find(p => p.id === playerUserId) || {
      name: playerUserId,
      balance: 0,
      bankName: '-',
      bankAccount: '-',
      accountName: '-'
    };
    const playerTransactions = transactions.filter(t => t.playerId === playerUserId);
    const playerBets = bets.filter(b => {
      const isLow = b.side === 'low';
      const lowId = b.playerLowId || (isLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
      const highId = b.playerHighId || (!isLow && b.side === 'high' ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
      return lowId === playerUserId || highId === playerUserId || b.creatorId === playerUserId || b.creatorLineUserId === playerUserId || b.matcherId === playerUserId || b.matcherLineUserId === playerUserId;
    });

    return (
      <PlayerDashboard 
        player={matchedPlayer} 
        transactions={playerTransactions} 
        bets={playerBets} 
        playerUserId={playerUserId}
        players={players}
      />
    );
  }

  // Voluntary rotation from the header. Back navigates to the console.
  if (showPasswordChange && !mustChangePassword) {
    return (
      <PasswordPanel
        mode="change"
        username={sessionStorage.getItem('rocket_admin_user') || ''}
        status={passwordStatus}
        runBackendFunction={runBackendFunction}
        onSessionUpgraded={(res) => {
          if (res?.role) setAdminRole(res.role);
          if (res?.username) setUsernameInput(res.username);
        }}
        onCancel={() => setShowPasswordChange(false)}
        onDone={() => {
          setShowPasswordChange(false);
          refreshPasswordStatus();
          addToast('เปลี่ยนรหัสผ่านเรียบร้อย', 'success');
        }}
      />
    );
  }

  // Regenerate recovery codes without touching the password.
  if (showRecoveryCodes && !mustChangePassword) {
    return (
      <PasswordPanel
        mode="regenerate"
        username={sessionStorage.getItem('rocket_admin_user') || ''}
        status={passwordStatus}
        runBackendFunction={runBackendFunction}
        onCancel={() => setShowRecoveryCodes(false)}
        onDone={() => {
          setShowRecoveryCodes(false);
          refreshPasswordStatus();
          addToast('สร้าง Recovery Codes ใหม่เรียบร้อย', 'success');
        }}
      />
    );
  }

  // Password expired / forced rotation — the console is unreachable until the
  // admin sets a new one. The server enforces this too; this is the UI half.
  if (mustChangePassword) {
    return (
      <PasswordPanel
        mode="change"
        username={usernameInput || sessionStorage.getItem('rocket_admin_user') || ''}
        forced
        status={passwordStatus}
        runBackendFunction={runBackendFunction}
        onSessionUpgraded={(res) => {
          // The password-change session was scope:'reset'; the upgraded token
          // is full-scope. Mirror the new identity so the header badge and the
          // role-gated actions agree with what the server now accepts.
          if (res?.username) setUsernameInput(res.username);
          if (res?.role) setAdminRole(res.role);
        }}
        onDone={() => {
          setMustChangePassword(false);
          setPasswordStatus(null);
          addToast('เปลี่ยนรหัสผ่านเรียบร้อย', 'success');
        }}
      />
    );
  }

  if (!adminAuthenticated) {
    return (
      <>
        {resetMode ? (
          <PasswordPanel
            mode="reset"
            runBackendFunction={runBackendFunction}
            onSessionUpgraded={(res) => {
              // A recovery-code reset authenticates the operator outright —
              // drop them straight into the console instead of the login form.
              if (res?.username) setUsernameInput(res.username);
              if (res?.role) setAdminRole(res.role);
              setAdminAuthenticated(true);
            }}
            onCancel={() => setResetMode(false)}
            onDone={() => {
              setResetMode(false);
              addToast('รีเซ็ตรหัสผ่านเรียบร้อย กรุณาเข้าสู่ระบบใหม่', 'success');
            }}
          />
        ) : (
          <AdminLockScreen 
            usernameInput={usernameInput}
            setUsernameInput={setUsernameInput}
            passwordInput={passwordInput}
            setPasswordInput={setPasswordInput}
            loginError={loginError}
            setLoginError={setLoginError}
            setAdminAuthenticated={setAdminAuthenticated}
            setAdminRole={setAdminRole}
            adminUsername={SUPER_ADMIN_USERNAME}
            admin1Username={LIMITED_ADMIN_USERNAME}
            runBackendFunction={runBackendFunction}
            onForgotPassword={() => { setResetMode(true); setLoginError(''); }}
            onLoginResult={(res) => {
              // Surface expiry/forced-change and first-run recovery codes.
              if (res && res.status) setPasswordStatus(res.status);
              if (res && res.requiresPasswordChange) setMustChangePassword(true);
            }}
          />
        )}
      </>
    );
  }

  // Worker/GAS report an open round as 'ACTIVE'; legacy builds used 'OPEN'.
  const isRoundOpen = roundStatus === 'ACTIVE' || roundStatus === 'OPEN';

  const NAV_GROUPS = ['รอบแข่ง', 'เงิน', 'กลุ่ม LINE และตั้งค่า'];
  const navItems = [
    {
      id: 'quote',
      activeMatch: (t) => t === 'quote' || t === 'rocket',
      label: 'ออกราคาช่าง',
      icon: Layers,
      section: 'รอบแข่ง',
    },
    {
      id: 'bets',
      activeMatch: (t) => t === 'bets',
      label: 'กระดานดวล',
      icon: Trophy,
      section: 'รอบแข่ง',
      badge: bets.filter(b => b.status === 'matched' || b.status === 'pending_match').length || null,
    },
    {
      id: 'settle',
      activeMatch: (t) => t === 'settle',
      label: 'ป้อนผลเวลา',
      icon: Zap,
      section: 'รอบแข่ง',
      badge: inFlightRounds.length > 0 ? inFlightRounds.length : null,
      attention: inFlightRounds.length > 0,
    },
    {
      id: 'next_rocket',
      activeMatch: (t) => t === 'next_rocket',
      label: 'บั้งไฟลำถัดไป',
      icon: Rocket,
      section: 'รอบแข่ง',
      badge: inFlightRounds.length > 0 ? `${inFlightRounds.length} บินอยู่` : null,
      attention: inFlightRounds.length > 0,
    },
    {
      id: 'review',
      activeMatch: (t) => t === 'review',
      onClick: () => { setAdminTab('review'); setTxStatusFilter('escalated'); },
      label: 'สลิปรอตรวจ',
      icon: FileText,
      section: 'เงิน',
      badge: transactions.filter(t => t.status === 'escalated').length || null,
      attention: transactions.some(t => t.status === 'escalated'),
    },
    {
      id: 'players',
      activeMatch: (t) => t === 'players',
      label: 'ผู้เล่นและเครดิต',
      icon: Users,
      section: 'เงิน',
      badge: players.length || null,
    },
    {
      id: 'logs',
      activeMatch: (t) => t === 'logs',
      onClick: () => { setAdminTab('logs'); setTxStatusFilter('all'); },
      label: 'ธุรกรรมทั้งหมด',
      icon: Database,
      section: 'เงิน',
    },
    {
      id: 'broadcast',
      activeMatch: (t) => t === 'broadcast',
      label: 'ประกาศและสรุปรายวัน',
      icon: Radio,
      section: 'กลุ่ม LINE และตั้งค่า',
    },
    {
      id: 'bank',
      activeMatch: (t) => t === 'bank',
      label: 'บัญชีรับเงิน',
      icon: Landmark,
      section: 'กลุ่ม LINE และตั้งค่า',
    },
  ];
  const activeNav = navItems.find((item) => item.activeMatch(adminTab));
  const isConnected = Boolean(window.isNodeJS || isGAS);
  const roundStateLabel = isRoundOpen
    ? (activeRoundObj?.quoteReleased ? 'เปิดราคาแล้ว' : 'รอราคาช่าง')
    : roundStatus === 'CLOSED' ? 'ปิดรับแทง' : roundStatus === 'IDLE' || !roundStatus ? 'ยังไม่เปิดรอบ' : roundStatus;
  const headerBtn = 'min-h-[40px] px-3 rounded-md border border-[#C3C9D1] bg-white text-[13px] font-medium text-[#16191D] hover:bg-[#F3F4F6] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0';
  // Shared console styles for redesigned pages.
  const ui = {
    panel: 'bg-white border border-[#D9DDE2] rounded-lg',
    panelHead: 'flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 border-b border-[#D9DDE2]',
    h2: 'm-0 text-base font-semibold text-[#16191D]',
    sub: 'text-[13px] text-[#5B636E]',
    label: 'text-[13px] font-medium text-[#16191D]',
    input: 'w-full min-h-[44px] px-3 rounded-md border border-[#C3C9D1] bg-white text-[15px] text-[#16191D] outline-none focus:border-[#1E4DB7] focus:ring-2 focus:ring-[#1E4DB7]/20',
    primary: 'min-h-[44px] px-4 rounded-md border border-[#1E4DB7] bg-[#1E4DB7] hover:bg-[#163A8A] text-white text-sm font-semibold inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50',
    secondary: 'min-h-[36px] px-3 rounded-md border border-[#C3C9D1] bg-white hover:bg-[#F3F4F6] text-[13px] font-medium text-[#16191D] inline-flex items-center gap-1.5 cursor-pointer',
    th: 'py-2.5 px-3 text-[12px] font-medium text-[#5B636E] whitespace-nowrap',
    td: 'py-3 px-3 text-sm text-[#16191D] whitespace-nowrap',
    chip: 'inline-flex items-center px-2 py-0.5 rounded text-[12px] font-semibold',
  };
  const STATUS_CHIP = {
    pending_match: { label: 'รอคู่', cls: 'bg-[#EEF0F2] text-[#3B424C]' },
    matched: { label: 'ต่อติด รอผล', cls: 'bg-[#E3EAFB] text-[#1E4DB7]' },
    pending_cancel: { label: 'รอยกเลิก', cls: 'bg-[#FDF1E1] text-[#8A4B00]' },
    cancelled: { label: 'ยกเลิกแล้ว', cls: 'bg-[#F3F4F6] text-[#8A929D]' },
    resolved: { label: 'ตัดสินแล้ว', cls: 'bg-[#E2F2E9] text-[#1B6E43]' },
  };

  return (
    <div className="min-h-screen bg-[#EEF0F2] lg:pl-[240px] flex flex-col">
      {dialog}
      {/* Toast Manager */}
      <div className="fixed top-4 right-4 z-[999999] flex flex-col gap-2 max-w-sm w-80 pointer-events-none">
        {toasts.map(t => (
          <div 
            key={t.id} 
            onClick={() => removeToast(t.id)}
            role="alert"
            title="คลิกเพื่อปิด"
            className={`pointer-events-auto cursor-pointer select-none px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2.5 shadow-lg border transition-all duration-200 hover:opacity-80 active:scale-95 ${
              t.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
              t.type === 'danger' || t.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800' :
              t.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' :
              'bg-sky-50 border-sky-200 text-sky-800'
            }`}
          >
            <span className="shrink-0">
              {t.type === 'success' && <CheckCircle size={15} />}
              {(t.type === 'danger' || t.type === 'error') && <XCircle size={15} />}
              {t.type === 'warning' && <AlertTriangle size={15} />}
              {t.type === 'info' && <Info size={15} />}
            </span>
            <span className="leading-snug flex-1">{t.msg}</span>
          </div>
        ))}
      </div>

      {/* ═══ LEFT SIDEBAR NAVIGATION (fixed on desktop) ═══ */}
      <aside className="hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:w-[240px] lg:z-40 flex-col justify-between select-none bg-[#16191D] text-[#C9CED6]">
        <div className="min-h-0 flex flex-col">
          <div className="px-5 pt-5 pb-4 flex flex-col gap-0.5">
            <span className="text-[15px] font-bold text-white">Rocket Science</span>
            <span className="text-xs text-[#9AA2AD]">คอนโซลแอดมิน</span>
          </div>

          {/* Current round */}
          <div className="mx-3 mb-2 px-3 py-2.5 rounded-md bg-[#22272E] flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#9AA2AD]">รอบปัจจุบัน</span>
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold ${
                isRoundOpen ? (activeRoundObj?.quoteReleased ? 'text-[#7FD3A6]' : 'text-[#F0C46A]') : 'text-[#F2A39B]'
              }`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {roundStateLabel}
              </span>
            </div>
            <div className="text-[13px] font-semibold text-white truncate">
              {activeRoundObj?.name || rocketName || 'ยังไม่ได้ตั้งชื่อบั้งไฟ'}
            </div>
            {inFlightRounds.length > 0 && (
              <button
                onClick={() => setAdminTab('next_rocket')}
                className="mt-1 text-left text-[12px] text-[#F0C46A] hover:underline cursor-pointer"
              >
                บั้งไฟบนฟ้า {inFlightRounds.length} ลำ · ดูคิว
              </button>
            )}
          </div>

          <nav aria-label="เมนูแอดมิน" className="px-3 py-2 flex flex-col gap-5 overflow-y-auto max-h-[calc(100vh-260px)]">
            {NAV_GROUPS.map(group => (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-wide text-[#8A929D]">{group}</div>
                {navItems
                  .filter(item => item.section === group)
                  .map(item => {
                    const IconComp = item.icon;
                    const isActive = item.activeMatch(adminTab);
                    return (
                      <button
                        key={item.id}
                        onClick={() => (item.onClick ? item.onClick() : setAdminTab(item.id))}
                        aria-current={isActive ? 'page' : undefined}
                        className={`w-full min-h-[40px] flex items-center justify-between gap-2 px-2.5 rounded-md text-left text-sm cursor-pointer ${
                          isActive ? 'bg-[#2A2F36] text-white font-medium' : 'text-[#C9CED6] hover:bg-[#1F242A] hover:text-white'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <IconComp size={16} className={`shrink-0 ${isActive ? 'text-white' : 'text-[#8A929D]'}`} />
                          <span className="truncate">{item.label}</span>
                        </span>
                        {item.badge !== null && item.badge !== undefined && (
                          <span className={`text-[11px] font-mono tabular-nums shrink-0 ${
                            item.attention ? 'px-1.5 py-0.5 rounded bg-[#F0C46A] text-[#16191D] font-semibold' : 'text-[#8A929D]'
                          }`}>
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            ))}
          </nav>
        </div>

        <div className="px-5 py-4 border-t border-[#2A2F36] flex flex-col gap-1 text-[12px]">
          <span className="text-[#C9CED6]">
            {adminRole === 'superadmin' ? 'Super Admin' : `Admin${usernameInput ? ` (${usernameInput})` : ''}`}
          </span>
          <span className="text-[#8A929D] truncate">
            กลุ่ม LINE {activeGroupId ? `#${activeGroupId.slice(-6)}` : 'ยังไม่ได้เชื่อม'}
          </span>
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="w-full min-w-0 max-w-6xl mx-auto p-3.5 sm:p-6 space-y-5 flex-1">
        {/* Page header */}
        <header className="w-full flex flex-col xl:flex-row xl:items-end justify-between gap-3">
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap text-[13px] text-[#5B636E]">
              <span>{activeNav?.section || 'คอนโซลแอดมิน'}</span>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[12px] font-semibold ${
                isConnected ? 'bg-[#E2F2E9] text-[#1B6E43]' : 'bg-[#E6E9ED] text-[#3B424C]'
              }`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {isConnected ? 'เชื่อมต่อระบบจริง' : 'โหมดทดลอง'}
              </span>
              <span className="lg:hidden">{adminRole === 'superadmin' ? 'Super Admin' : 'Admin'}</span>
            </div>
            <h1 className="m-0 text-2xl font-bold leading-tight text-[#16191D]">{activeNav?.label || 'คอนโซลแอดมิน'}</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={forceSyncFreshData} className={headerBtn} title="ดึงข้อมูลล่าสุดจากฐานข้อมูลและล้างแคชในเบราว์เซอร์">
              <RefreshCw size={14} className="text-[#5B636E]" />
              <span>ซิงค์ข้อมูล</span>
            </button>
            <button onClick={handleClosePortal} className={headerBtn} title="ปิดรอบปัจจุบันและเปิดรอบใหม่ โดยไม่ลบข้อมูลผู้เล่นหรือประวัติธุรกรรม">
              <RotateCcw size={14} className="text-[#5B636E]" />
              <span>ปิดรอบ</span>
            </button>
            <button
              onClick={() => { refreshPasswordStatus(); setShowPasswordChange(true); }}
              className={`${headerBtn} ${
                passwordStatus && passwordStatus.daysUntilExpiry !== undefined && passwordStatus.daysUntilExpiry <= 7 ? 'border-[#E8C48F] text-[#8A4B00]' : ''
              }`}
              title={
                passwordStatus?.daysUntilExpiry !== undefined
                  ? `เปลี่ยนรหัสผ่าน (หมดอายุใน ${passwordStatus.daysUntilExpiry} วัน · Recovery Codes คงเหลือ ${passwordStatus.recoveryCodesRemaining ?? '-'})`
                  : 'เปลี่ยนรหัสผ่าน'
              }
            >
              <KeyRound size={14} className="text-[#5B636E]" />
              <span>เปลี่ยนรหัสผ่าน</span>
              {passwordStatus?.daysUntilExpiry !== undefined && passwordStatus.daysUntilExpiry <= 7 && (
                <span className="px-1.5 py-0.5 rounded bg-[#FDF1E1] text-[#8A4B00] text-[11px] font-semibold">
                  {passwordStatus.daysUntilExpiry} วัน
                </span>
              )}
            </button>
            <button
              onClick={() => { refreshPasswordStatus(); setShowRecoveryCodes(true); }}
              className={headerBtn}
              title={`สร้าง Recovery Codes ใหม่ (คงเหลือ ${passwordStatus?.recoveryCodesRemaining ?? '-'})`}
            >
              <ShieldCheck size={14} className="text-[#5B636E]" />
              <span>Recovery Codes</span>
            </button>
            {adminRole === 'superadmin' && (
              <button onClick={resetConsoleState} className={`${headerBtn} text-[#B42318]`} title="ล้างข้อมูลระบบทั้งหมด (เฉพาะ Super Admin)">
                <RotateCcw size={14} />
                <span>ล้างข้อมูลระบบ</span>
              </button>
            )}
            <button onClick={handleAdminLogout} className={headerBtn} title="ออกจากระบบแอดมิน">
              <LogOut size={14} className="text-[#5B636E]" />
              <span>ออกจากระบบ</span>
            </button>
          </div>
        </header>

        {/* Mobile / tablet navigation (< lg) */}
        <nav aria-label="เมนูแอดมิน" className="lg:hidden p-1 flex text-[13px] overflow-x-auto gap-1 rounded-md bg-white border border-[#D9DDE2]">
          {navItems.map(item => {
            const IconComp = item.icon;
            const isActive = item.activeMatch(adminTab);
            return (
              <button
                key={item.id}
                onClick={() => (item.onClick ? item.onClick() : setAdminTab(item.id))}
                aria-current={isActive ? 'page' : undefined}
                className={`min-h-[40px] px-3 rounded flex items-center gap-1.5 whitespace-nowrap cursor-pointer shrink-0 ${
                  isActive ? 'bg-[#16191D] text-white font-medium' : 'text-[#3B424C] hover:bg-[#F3F4F6]'
                }`}
              >
                <IconComp size={14} />
                <span>{item.label}</span>
                {item.badge !== null && item.badge !== undefined && (
                  <span className={`text-[11px] font-mono ${item.attention ? 'px-1 rounded bg-[#F0C46A] text-[#16191D]' : 'opacity-70'}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Main Sandbox Grid (Standardized to corporate light 100% width column) */}
        <main className="w-full space-y-5">
          {/* Summary numbers */}
          <section aria-label="ตัวเลขสรุป" className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[#D9DDE2] border border-[#D9DDE2] rounded-lg overflow-hidden">
            {[
              { label: 'ยอดฝากเครดิตรวม', value: transactions.filter(t => t.status === 'success').reduce((acc, t) => acc + t.actualAmount, 0).toLocaleString(), unit: 'บาท' },
              { label: 'สลิปรอตรวจ', value: transactions.filter(t => t.status === 'escalated').length, unit: 'รายการ', attention: transactions.some(t => t.status === 'escalated') },
              { label: 'ต่อติด รอผล', value: bets.filter(b => b.status === 'matched').length, unit: 'คู่', note: inFlightRounds.length > 0 ? `บั้งไฟบนฟ้า ${inFlightRounds.length} ลำ` : null },
              { label: 'ผู้เล่น', value: players.length, unit: 'บัญชี' },
            ].map((m) => (
              <div key={m.label} className="bg-white px-4 py-3.5 flex flex-col gap-1 min-w-0">
                <span className="text-[12px] text-[#5B636E]">{m.label}</span>
                <span className="flex items-baseline gap-1.5 flex-wrap">
                  <span className={`text-2xl font-medium font-mono tabular-nums ${m.attention ? 'text-[#8A4B00]' : 'text-[#16191D]'}`}>{m.value}</span>
                  <span className="text-[12px] text-[#5B636E]">{m.unit}</span>
                </span>
                {m.note && <span className="text-[12px] text-[#8A4B00]">{m.note}</span>}
              </div>
            ))}
          </section>

          {/* Tab panels contents container */}
          <div className="w-full space-y-6">

          {/* ═══ NEW TAB: CONCURRENT ROCKET B LAUNCHER & IN-FLIGHT ROCKET A QUEUE ═══ */}
          {adminTab === 'next_rocket' && (
            <div className="glass-panel p-5 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Rocket size={18} className="text-orange-600" />
                    เปิดบั้งไฟถัดไป (Rocket B) ขณะรอผลบั้งไฟกลางอากาศ (Rocket A)
                  </h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">
                    แยกสัญญาคู่ดวลของบั้งไฟที่ปล่อยขึ้นฟ้าแล้วเข้าคิวรอผลเวลา (In-Flight Queue) และเปิดรับออเดอร์บั้งไฟลูกถัดไปได้ทันทีโดยที่เลขแผลและราคาไม่ชนกัน
                  </p>
                </div>
                <span className="self-start sm:self-auto text-[10px] text-orange-800 font-extrabold bg-orange-50 px-2.5 py-1 rounded-full border border-orange-200">
                  Concurrent Multi-Rocket Engine
                </span>
              </div>

              {/* Current Active Rocket Status vs In-Flight Overview */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                      บั้งไฟรอบปัจจุบันที่รับออเดอร์อยู่ (Active Slot)
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                        isRoundOpen
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-rose-100 text-rose-800 border border-rose-300'
                      }`}
                    >
                      {isRoundOpen
                        ? activeRoundObj?.quoteReleased
                          ? 'เปิดรับดวล (มีราคาช่างแล้ว)'
                          : 'เปิดรับแผลล่วงหน้า (รอราคาช่าง)'
                        : 'ปิดรับดวล (บั้งไฟออกแล้ว)'}
                    </span>
                  </div>
                  <div className="text-base font-black text-slate-900 font-heading">
                    {activeRoundObj?.name || rocketName || 'ยังไม่ได้กำหนดชื่อบั้งไฟ'}
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-600 font-sans pt-1">
                    <span>
                      ช่วงราคาช่าง:{' '}
                      <strong className="font-mono text-slate-900">
                        {activeRoundObj?.quoteReleased
                          ? `${activeRoundObj.targetMin}-${activeRoundObj.targetMax}s`
                          : 'ยังไม่ปล่อยราคา'}
                      </strong>
                    </span>
                    <span>•</span>
                    <span>
                      คู่ดวลติดแล้ว:{' '}
                      <strong className="font-mono text-indigo-700">
                        {bets.filter(b => b.status === 'matched').length} คู่
                      </strong>
                    </span>
                    <span>•</span>
                    <span>
                      รอคู่ดวล:{' '}
                      <strong className="font-mono text-amber-700">
                        {bets.filter(b => b.status === 'pending_match' || b.status === 'pending_hold').length} แผล
                      </strong>
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-orange-50/70 border border-orange-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-black uppercase tracking-wider text-orange-900">
                      บั้งไฟที่กำลังบินอยู่บนฟ้า (In-Flight Queue)
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-orange-200 text-orange-950">
                      {inFlightRounds.length} ลำรอตัดสินผล
                    </span>
                  </div>
                  <p className="text-xs text-orange-900/90 leading-relaxed">
                    เมื่อกดเปิดบั้งไฟลูกใหม่ (Rocket B) ด้านล่าง ระบบจะล็อกและย้ายคู่ดวลของบั้งไฟลูกเดิม (Rocket A) มาเก็บในคิวรอผลเวลาบินโดยอัตโนมัติ และรันเลข Order # ไม่ให้ซ้ำกัน 100%
                  </p>
                </div>
              </div>

              {/* STEP 1: OPEN ROCKET B FORM */}
              <div className="p-4 sm:p-5 rounded-xl bg-gradient-to-br from-sky-50/80 via-white to-indigo-50/50 border border-sky-200 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-2 border-b border-sky-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-sky-600 text-white font-black text-xs flex items-center justify-center">
                      1
                    </span>
                    <h4 className="text-sm font-black text-slate-900 font-heading">
                      เปิดรับออเดอร์บั้งไฟลูกถัดไป (Rocket B) ทันที
                    </h4>
                  </div>
                  <span className="text-[10.5px] font-bold text-sky-700">
                    บั้งไฟลูกปัจจุบันจะถูกพักไว้ในคิวรอผลเวลาอัตโนมัติ (ถ้ามีคู่ดวลค้างอยู่)
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">
                      ชื่อบั้งไฟลูกถัดไป (Rocket B Name):
                    </label>
                    <input
                      type="text"
                      value={nextRocketName}
                      onChange={e => setNextRocketName(e.target.value)}
                      placeholder="เช่น เทพพนม 2 / สิงห์อีสาน (ลูกที่ 2)"
                      className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-xl text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">
                      โหมดการเปิดรับออเดอร์บั้งไฟลูกถัดไป:
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setNextRocketMode('pre_quote')}
                        className={`py-2.5 px-3 rounded-xl text-xs font-bold border text-left transition-all cursor-pointer ${
                          nextRocketMode === 'pre_quote'
                            ? 'bg-sky-600 text-white border-sky-700 shadow-xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="font-black">เปิดรับแผลล่วงหน้า</div>
                        <div className={`text-[10px] mt-0.5 ${nextRocketMode === 'pre_quote' ? 'text-sky-100' : 'text-slate-400'}`}>
                          เชิญเปิดแผลก่อน (ออกราคาช่างทีหลัง)
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setNextRocketMode('quote')}
                        className={`py-2.5 px-3 rounded-xl text-xs font-bold border text-left transition-all cursor-pointer ${
                          nextRocketMode === 'quote'
                            ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="font-black">ออกราคาช่างทันที</div>
                        <div className={`text-[10px] mt-0.5 ${nextRocketMode === 'quote' ? 'text-emerald-100' : 'text-slate-400'}`}>
                          กำหนดช่วงเวลา Min-Max พร้อมเปิดดวล
                        </div>
                      </button>
                    </div>
                  </div>
                </div>

                {nextRocketMode === 'quote' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-xl">
                    <div>
                      <label className="text-[11px] font-bold text-emerald-900 block mb-1">
                        เวลาต่ำสุด (Min วินาที):
                      </label>
                      <input
                        type="number"
                        value={nextRocketMin}
                        onChange={e => setNextRocketMin(e.target.value)}
                        placeholder="เช่น 330"
                        className="w-full px-3 py-2 bg-white border border-emerald-300 rounded-lg text-sm font-mono font-black text-slate-900"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold text-emerald-900 block mb-1">
                        เวลาสูงสุด (Max วินาที):
                      </label>
                      <input
                        type="number"
                        value={nextRocketMax}
                        onChange={e => setNextRocketMax(e.target.value)}
                        placeholder="เช่น 360"
                        className="w-full px-3 py-2 bg-white border border-emerald-300 rounded-lg text-sm font-mono font-black text-slate-900"
                      />
                    </div>
                    <div className="flex items-end">
                      <label className="flex items-center gap-2 cursor-pointer p-2.5 bg-white border border-emerald-200 rounded-lg w-full">
                        <input
                          type="checkbox"
                          checked={nextRocketChotoy}
                          onChange={e => setNextRocketChotoy(e.target.checked)}
                          className="w-4 h-4 accent-emerald-600 rounded"
                        />
                        <span className="text-xs font-bold text-emerald-950">
                          โหมดช่อทอย (10 : 8)
                        </span>
                      </label>
                    </div>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={nextRocketBroadcast}
                      onChange={e => setNextRocketBroadcast(e.target.checked)}
                      className="w-4 h-4 accent-sky-600 rounded"
                    />
                    <span>
                      ส่งประกาศแจ้งเปิดบั้งไฟลูกใหม่ ({nextRocketName || 'บั้งไฟชุดต่อไป'}) เข้ากลุ่ม LINE ทันที
                    </span>
                  </label>

                  <button
                    onClick={handleOpenNextRocket}
                    disabled={isOpeningNextRocket}
                    className="py-3 px-6 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white font-black text-xs sm:text-sm rounded-xl shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Rocket size={16} />
                    <span>
                      {isOpeningNextRocket
                        ? 'กำลังสลับรอบและเปิดบั้งไฟถัดไป...'
                        : `พักรอบเดิมไว้บนฟ้า & เปิดรับดวล "${nextRocketName || 'บั้งไฟชุดต่อไป'}" ทันที`}
                    </span>
                  </button>
                </div>
              </div>

              {/* STEP 2: IN-FLIGHT ROCKETS QUEUE (AWAITING FLIGHT RESULT SETTLEMENT) */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-orange-600 text-white font-black text-xs flex items-center justify-center">
                      2
                    </span>
                    <h4 className="text-sm font-black text-slate-900 font-heading">
                      คิวบั้งไฟที่กำลังบินอยู่บนฟ้า รอป้อนผลเวลา (In-Flight Rockets Queue)
                    </h4>
                  </div>
                  <span className="text-[11px] font-bold text-slate-500">
                    ตัดสินผลแยกเฉพาะลำ โดยไม่รบกวนออเดอร์ของบั้งไฟลูกใหม่
                  </span>
                </div>

                {inFlightRounds.length === 0 ? (
                  <div className="p-8 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-center space-y-1.5">
                    <div className="text-2xl"></div>
                    <div className="text-xs font-bold text-slate-700">
                      ขณะนี้ไม่มีบั้งไฟค้างอยู่บนฟ้าในคิว In-Flight
                    </div>
                    <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                      เมื่อบั้งไฟ A ปล่อยขึ้นฟ้าแล้ว และคุณกดเปิดบั้งไฟ B ด้านบน คู่ดวลของบั้งไฟ A จะย้ายมาแสดงที่นี่เพื่อให้คุณกรอกผลเวลาบินเมื่อบั้งไฟ A ตกถึงพื้น
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {inFlightRounds.map((flt, idx) => {
                      const inputTime = inFlightTimes[flt.roundId] || '';
                      const isSettlingThis = settlingInFlightId === flt.roundId;
                      return (
                        <div
                          key={flt.roundId}
                          className="p-4 rounded-xl bg-amber-50/70 border-2 border-amber-300 space-y-3 shadow-xs"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-200 pb-2.5">
                            <div className="flex items-center gap-2.5">
                              <span className="px-2.5 py-1 rounded-lg bg-orange-600 text-white font-black text-xs font-mono">
                                ลำที่ #{idx + 1} บนฟ้า
                              </span>
                              <div>
                                <div className="text-sm font-black text-slate-900 font-heading flex items-center gap-2">
                                  <span>{flt.name}</span>
                                  {flt.isChotoy && (
                                    <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-300 text-[10px] font-black">
                                      ช่อทอย 10:8
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-slate-600 font-mono">
                                  ราคาช่าง: <strong>{flt.quoteReleased ? `${flt.targetMin} - ${flt.targetMax} วินาที` : 'P2P / ไม่มีราคาช่าง'}</strong> • คู่ดวลที่ติดแล้ว: <strong className="text-indigo-700">{flt.matchedCount || (flt.matchedOrders || []).length} คู่</strong>
                                </div>
                              </div>
                            </div>

                            <button
                              onClick={() => handleVoidInFlightRound(flt)}
                              disabled={isSettlingThis}
                              className="self-start sm:self-auto px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-300 text-xs font-bold transition-all cursor-pointer"
                            >
                              โมฆะเฉพาะลำนี้ & คืนแต้ม
                            </button>
                          </div>

                          {/* Matched Orders Preview inside this In-Flight Rocket */}
                          {Array.isArray(flt.matchedOrders) && flt.matchedOrders.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {flt.matchedOrders.map(m => (
                                <span
                                  key={m.id || m.orderNumber}
                                  className="px-2 py-1 rounded-md bg-white border border-amber-200 text-[10.5px] font-mono text-slate-700"
                                >
                                  <strong>#{m.orderNumber}</strong>:{' '}
                                  <span className="text-sky-700 font-bold">{m.playerLowName || 'ฝั่งต่ำ'}</span> vs{' '}
                                  <span className="text-rose-700 font-bold">{m.playerHighName || 'ฝั่งสูง'}</span> ({m.amount} pt)
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Settle Input Row */}
                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
                            <div className="flex items-center gap-2 flex-1 bg-white px-3 py-2 rounded-xl border border-amber-300">
                              <Clock size={15} className="text-orange-600 shrink-0" />
                              <span className="text-xs font-bold text-slate-700 whitespace-nowrap">
                                เวลาบินจริง ({flt.name}):
                              </span>
                              <input
                                type="number"
                                step="0.1"
                                value={inputTime}
                                onChange={e =>
                                  setInFlightTimes(prev => ({
                                    ...prev,
                                    [flt.roundId]: e.target.value,
                                  }))
                                }
                                placeholder="กรอกวินาที เช่น 348"
                                className="w-full font-mono font-black text-sm text-slate-900 focus:outline-none"
                              />
                              <span className="text-xs font-mono font-bold text-slate-400">วินาที (s)</span>
                            </div>

                            <button
                              onClick={() => handleSettleInFlightRound(flt)}
                              disabled={isSettlingThis}
                              className="py-2.5 px-5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black text-xs rounded-xl shadow-sm transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                            >
                              <CheckCircle size={15} />
                              <span>
                                {isSettlingThis
                                  ? 'กำลังตัดสินผล...'
                                  : `ตัดสินผลเวลาบิน "${flt.name}" (${inputTime || 0}s)`}
                              </span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 1: ONSITE TELEMETRY RECEIVER & MECHANIC QUOTE SETUP */}
          {(adminTab === 'quote' || adminTab === 'rocket') && (
            <section aria-labelledby="quote-title" className={ui.panel}>
              <div className={ui.panelHead}>
                <div className="flex flex-col gap-0.5">
                  <h2 id="quote-title" className={ui.h2}>ประกาศราคาช่าง</h2>
                  <span className={ui.sub}>ตั้งชื่อบั้งไฟและช่วงราคา แล้วประกาศลงกลุ่มดวล ราคาที่แอดมินเปิดไม่ใช้แต้ม</span>
                </div>
                <span className={ui.sub}>
                  กลุ่มปัจจุบัน:{' '}
                  {activeGroupId ? (
                    <span className="font-medium text-[#16191D]">
                      {(() => {
                        const activeObj = lineGroups.find(g => g.id === activeGroupId);
                        const isRaw = !activeObj || !activeObj.name || activeObj.name.startsWith('C') || activeObj.name.includes(activeGroupId) || !isNaN(activeObj.name);
                        return !isRaw ? activeObj.name : `กลุ่มดวลสด (#${activeGroupId.slice(-4)})`;
                      })()}
                    </span>
                  ) : (
                    <span className="font-medium text-[#8A4B00]">ยังไม่มีกลุ่มที่เชื่อมต่อ</span>
                  )}
                </span>
              </div>

              <div className="p-4 flex flex-col gap-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="quote-name" className={ui.label}>ชื่อบั้งไฟ / ชื่อช่าง</label>
                    <input
                      id="quote-name"
                      type="text"
                      value={rocketName}
                      onChange={(e) => { markTouched('rocketName'); setRocketName(e.target.value); }}
                      className={ui.input}
                      placeholder="เช่น โชคน้องกวาง"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="quote-min" className={ui.label}>ราคาต่ำสุด (วินาที)</label>
                    <input
                      id="quote-min"
                      type="number"
                      inputMode="numeric"
                      step="1"
                      value={targetMin}
                      onChange={(e) => { markTouched('targetMin'); setTargetMin(e.target.value); }}
                      className={`${ui.input} font-mono tabular-nums`}
                      placeholder="330"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="quote-max" className={ui.label}>ราคาสูงสุด (วินาที)</label>
                    <input
                      id="quote-max"
                      type="number"
                      inputMode="numeric"
                      step="1"
                      value={targetMax}
                      onChange={(e) => { markTouched('targetMax'); setTargetMax(e.target.value); }}
                      className={`${ui.input} font-mono tabular-nums`}
                      placeholder="380"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="quote-amount" className={ui.label}>แต้มดวลเริ่มต้น (pt)</label>
                    <input
                      id="quote-amount"
                      type="number"
                      inputMode="numeric"
                      step="50"
                      value={quoteBetAmount}
                      onChange={(e) => setQuoteBetAmount(e.target.value)}
                      className={`${ui.input} font-mono tabular-nums`}
                      placeholder="500"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="quote-target" className={ui.label}>ประกาศลงกลุ่ม</label>
                    <select
                      id="quote-target"
                      value={broadcastTargetGroup}
                      onChange={(e) => setBroadcastTargetGroup(e.target.value)}
                      className={ui.input}
                    >
                      <option value="ALL">ทุกกลุ่มดวล</option>
                      {lineGroups.map((g, idx) => {
                        const isRawId = !g.name || g.name.startsWith('C') || g.name.includes(g.id) || !isNaN(g.name);
                        const displayName = !isRawId ? g.name : `กลุ่มดวลสด #${idx + 1} (${g.id.slice(-4)})`;
                        return <option key={g.id} value={g.id}>เฉพาะ {displayName}</option>;
                      })}
                    </select>
                  </div>
                  <label htmlFor="quote-chotoy" className="min-h-[44px] flex items-center gap-2.5 px-3 rounded-md border border-[#C3C9D1] bg-white cursor-pointer">
                    <input
                      id="quote-chotoy"
                      type="checkbox"
                      checked={quoteIsChotoy}
                      onChange={(e) => setQuoteIsChotoy(e.target.checked)}
                      className="w-4 h-4 accent-[#1E4DB7]"
                    />
                    <span className="text-sm text-[#16191D]">ชตย (ช่างต่อยยกเลิก)</span>
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setAdminTab('broadcast')}
                    className="text-[13px] font-medium text-[#1E4DB7] hover:underline cursor-pointer"
                  >
                    ประกาศอื่นและสรุปรายวัน
                  </button>
                  <button type="button" onClick={() => handleBroadcastFastQuote()} className={ui.primary}>
                    <Send size={15} />
                    <span>
                      ประกาศราคา{targetMin && targetMax ? ` ${targetMin}–${targetMax} วิ` : ''} ลง{broadcastTargetGroup === 'ALL' ? 'ทุกกลุ่ม' : 'กลุ่มที่เลือก'}
                    </span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* TAB 2: FINAL RESULT TELEMETRY & ROUND SETTLEMENT */}
          {adminTab === 'settle' && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Zap size={18} className="text-sky-600" />
                    ป้อนผลเวลาบินจริง & สรุปผลรอบ
                  </h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">
                    ป้อนเวลาวินาทีที่บั้งไฟทะยานขึ้นจริง เพื่อคำนวณผู้ชนะและโอนจ่ายแต้มผลการดวลทั้งหมดในรอบนี้
                  </p>
                </div>
                <span className="self-start sm:self-auto text-[10px] text-sky-700 font-extrabold bg-sky-50 px-2.5 py-1 rounded-full border border-sky-200">
                  Telemetry Engine
                </span>
              </div>

              {/* In-Flight Rockets Queue (Rocket A in the air while Rocket B is open) */}
              {inFlightRounds.length > 0 && (
                <div className="p-4 rounded-xl bg-amber-50/80 border-2 border-amber-300 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-xs font-black text-amber-950 font-heading flex items-center gap-1.5">
                      <Rocket size={15} className="text-orange-600" />
                      <span>คิวบั้งไฟบนฟ้าที่รอตัดสินผล ({inFlightRounds.length} ลำ) — ตัดสินแยกโดยไม่กระทบแผลรอบใหม่</span>
                    </span>
                    <button
                      onClick={() => setAdminTab('next_rocket')}
                      className="text-[11px] font-bold text-orange-700 hover:text-orange-900 underline cursor-pointer"
                    >
                      จัดการคิวบั้งไฟถัดไป 
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    {inFlightRounds.map((flt, idx) => {
                      const inputTime = inFlightTimes[flt.roundId] || '';
                      const isSettlingThis = settlingInFlightId === flt.roundId;
                      return (
                        <div key={flt.roundId} className="p-3 rounded-xl bg-white border border-amber-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-black text-slate-900 flex items-center gap-2">
                              <span className="px-2 py-0.5 rounded bg-orange-600 text-white font-mono text-[10px]">ลำ #{idx + 1}</span>
                              <span>{flt.name}</span>
                              <span className="text-[11px] font-mono text-slate-500">
                                ({flt.quoteReleased ? `${flt.targetMin}-${flt.targetMax}s` : 'P2P'} · {flt.matchedCount || (flt.matchedOrders || []).length} คู่ดวล)
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              step="0.1"
                              value={inputTime}
                              onChange={e => setInFlightTimes(prev => ({ ...prev, [flt.roundId]: e.target.value }))}
                              placeholder="เวลาบิน (วินาที)"
                              className="w-36 px-2.5 py-1.5 bg-amber-50/50 border border-amber-300 rounded-lg text-xs font-mono font-black text-slate-900"
                            />
                            <button
                              onClick={() => handleSettleInFlightRound(flt)}
                              disabled={isSettlingThis}
                              className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold cursor-pointer whitespace-nowrap"
                            >
                              {isSettlingThis ? '...' : `ตัดสิน "${flt.name}"`}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Settlement Form Card */}
              <div className="p-4 bg-slate-50/50 rounded-xl border border-slate-200 space-y-3.5">

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                  {/* Actual Air Time Input */}
                  <div className="space-y-1 bg-white p-3.5 rounded-xl border border-slate-200">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <Clock size={14} className="text-sky-600" />
                      ผลยิงจริงในสนาม (Actual Air Time in Seconds):
                    </label>
                    <div className="flex items-center gap-2">
                      <input 
                        type="number"
                        step="0.1"
                        value={customRocketTime}
                        onChange={(e) => setCustomRocketTime(e.target.value)}
                        className="w-full bg-sky-50/50 border border-sky-200 text-sky-950 font-black px-3 py-2 rounded-lg text-base font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        placeholder="เช่น 355.0"
                      />
                      <span className="text-sm text-sky-700 font-mono font-black">s</span>
                    </div>
                  </div>

                  {/* Live Outcome Preview */}
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 flex flex-col justify-center space-y-1.5">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                      <span>ราคาช่างเปรียบเทียบ:</span>
                      <div className="flex items-center gap-1 font-mono">
                        <input
                          type="number"
                          step="1"
                          value={targetMin}
                          onChange={(e) => { markTouched('targetMin'); setTargetMin(e.target.value); }}
                          className="w-14 bg-slate-50 border border-slate-300 text-slate-900 font-bold px-1.5 py-0.5 rounded text-xs text-center focus:ring-1 focus:ring-sky-500 focus:outline-none"
                          placeholder="330"
                        />
                        <span className="text-slate-400">-</span>
                        <input
                          type="number"
                          step="1"
                          value={targetMax}
                          onChange={(e) => { markTouched('targetMax'); setTargetMax(e.target.value); }}
                          className="w-14 bg-slate-50 border border-slate-300 text-slate-900 font-bold px-1.5 py-0.5 rounded text-xs text-center focus:ring-1 focus:ring-sky-500 focus:outline-none"
                          placeholder="380"
                        />
                        <span className="text-slate-500 font-bold">s</span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center text-xs font-bold">
                      <span>คาดการณ์ผลชนะ:</span>
                      {Number(customRocketTime || 0) < Number(targetMin || 330) ? (
                        <span className="px-2.5 py-1 bg-blue-100 text-blue-800 font-black rounded-lg text-xs flex items-center gap-1">ฝั่งต่ำ (LOW / ชถ) ชนะ</span>
                      ) : Number(customRocketTime || 0) > Number(targetMax || 380) ? (
                        <span className="px-2.5 py-1 bg-rose-100 text-rose-800 font-black rounded-lg text-xs flex items-center gap-1">ฝั่งสูง (HIGH / ชล) ชนะ</span>
                      ) : (
                        <span className="px-2.5 py-1 bg-emerald-100 text-emerald-800 font-black rounded-lg text-xs flex items-center gap-1">ในราคาช่าง (RANGE)</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Settle Round Primary Button */}
                <button
                  onClick={() => handleSubmitOnsiteResult(Number(customRocketTime) || 355)}
                  className="w-full py-3.5 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs uppercase tracking-wider rounded-lg flex items-center justify-center gap-2 active:scale-95 transition-all font-heading cursor-pointer"
                >
                  <CheckCircle size={16} />
                  <span>สรุปผลและชำระแต้มดีลทั้งหมด / SETTLE ONSITE ROUND (ผลลัพธ์ยิงจริง: {customRocketTime || 0}s)</span>
                </button>
              </div>

              {/* Logs and Flight Histories in Light Mode */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-[11px]">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col" style={{ minHeight: '160px', maxHeight: '220px' }}>
                  <span className="text-[11px] font-bold text-slate-800 border-b border-slate-200 pb-1.5 mb-2 flex items-center justify-between font-sans shrink-0">
                    <span>LAUNCH ENGINE LOGS</span>
                    <Clock size={12} className="text-slate-400" />
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-1 pr-1" style={{ wordBreak: 'break-all' }}>
                    {flightLogs.length === 0 ? (
                      <span className="text-slate-400 italic text-[11px]">-- ไม่มีข้อมูลบันทึกในเซสชันนี้ --</span>
                    ) : (
                      flightLogs.map((l, i) => (
                        <div key={i} className={`text-[11px] ${l.includes('') || l.includes('SUCCESS') ? 'text-emerald-600 font-bold' : l.includes('') || l.includes('terminated') ? 'text-rose-600 font-bold' : 'text-slate-600'}`}>
                          {l}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col" style={{ minHeight: '160px', maxHeight: '220px' }}>
                  <span className="text-[11px] font-bold text-slate-800 border-b border-slate-200 pb-1.5 mb-2 flex justify-between font-sans shrink-0">
                    <span>ประวัติออกผล</span>
                    <span className="text-[11px] text-slate-400">รวม {flights.length} รอบ</span>
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-1 pr-1" style={{ wordBreak: 'break-all' }}>
                    {flights.length === 0 ? (
                      <span className="text-slate-400 italic block text-[11px]">-- ไม่มีประวัติผล --</span>
                    ) : (
                      flights.map(f => (
                        <div key={f.id} className="flex justify-between items-center p-1.5 rounded bg-white border border-slate-100 text-[11px] font-mono">
                          <span className="text-slate-400">{f.timestamp}</span>
                          <span className="font-bold text-slate-800">เวลา: {f.duration}s</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            f.duration < (Number(targetMin) || 330) ? 'bg-sky-50 text-sky-700 border border-sky-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
                          }`}>
                            {f.duration < (Number(targetMin) || 330) ? 'LOW' : 'HIGH'}
                          </span>
                          <span className="text-slate-500">เคลียร์ {f.betsResolved} บิล</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: DEDICATED LIVE BETS & GAME CONTRACTS BOARD */}
          {adminTab === 'bets' && (() => {
            const filteredBets = bets.filter(b => {
              if (betStatusFilter === 'matched' && b.status !== 'matched') return false;
              if (betStatusFilter === 'pending_match' && b.status !== 'pending_match') return false;
              if (betStatusFilter === 'pending_cancel' && b.status !== 'pending_cancel') return false;
              if (betStatusFilter === 'cancelled' && b.status !== 'cancelled') return false;
              if (betStatusFilter === 'resolved' && b.status !== 'resolved') return false;
              if (betSearchQuery && betSearchQuery.trim()) {
                const q = betSearchQuery.trim().toLowerCase();
                const matchOrder = b.orderNumber && b.orderNumber.toString().toLowerCase().includes(q);
                const isLow = b.side === 'low';
                const lowName = b.playerLowName || (isLow ? b.creatorName : b.matcherName);
                const lowId = b.playerLowId || (isLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
                const highName = b.playerHighName || (!isLow && b.side === 'high' ? b.creatorName : b.matcherName);
                const highId = b.playerHighId || (!isLow && b.side === 'high' ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));

                const matchLow = (lowName && String(lowName).toLowerCase().includes(q)) || (lowId && String(lowId).toLowerCase().includes(q));
                const matchHigh = (highName && String(highName).toLowerCase().includes(q)) || (highId && String(highId).toLowerCase().includes(q));
                if (!matchOrder && !matchLow && !matchHigh) return false;
              }
              return true;
            });

            const matchedCount = bets.filter(b => b.status === 'matched').length;
            const pendingCount = bets.filter(b => b.status === 'pending_match').length;
            const cancelCount = bets.filter(b => b.status === 'pending_cancel' || b.status === 'cancelled').length;
            const resolvedCount = bets.filter(b => b.status === 'resolved').length;
            const totalBetVolume = bets.reduce((sum, b) => sum + (b.amount || 0), 0);

            const filters = [
              { id: 'all', label: 'ทั้งหมด', count: bets.length },
              { id: 'pending_match', label: 'รอคู่', count: pendingCount },
              { id: 'matched', label: 'ต่อติด รอผล', count: matchedCount },
              { id: 'resolved', label: 'ตัดสินแล้ว', count: resolvedCount },
              { id: 'cancelled', label: 'ยกเลิก', count: cancelCount },
            ];
            const heldPt = bets.filter(b => b.status === 'pending_match' || b.status === 'matched').reduce((sum, b) => sum + (b.amount || 0), 0);

            return (
              <section aria-labelledby="board-title" className={ui.panel}>
                <div className={ui.panelHead}>
                  <div className="flex flex-col gap-0.5">
                    <h2 id="board-title" className={ui.h2}>กระดานดวล</h2>
                    <span className={ui.sub}>
                      รอคู่ {pendingCount} · ต่อติด {matchedCount} · เครดิตที่ถูกกันไว้ <span className="font-mono tabular-nums">{heldPt.toLocaleString()}</span> pt · ยอดดวลทั้งหมด <span className="font-mono tabular-nums">{totalBetVolume.toLocaleString()}</span> pt
                    </span>
                  </div>
                  <div className="relative w-full sm:w-64">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8A929D]" />
                    <label htmlFor="board-search" className="sr-only">ค้นหา</label>
                    <input
                      id="board-search"
                      type="text"
                      placeholder="ค้นหาเลขออเดอร์หรือชื่อผู้เล่น"
                      value={betSearchQuery}
                      onChange={(e) => setBetSearchQuery(e.target.value)}
                      className={`${ui.input} min-h-[36px] pl-9 text-sm`}
                    />
                  </div>
                </div>

                <div className="px-4 pt-3">
                  <div role="group" aria-label="กรองสถานะ" className="inline-flex flex-wrap gap-1 p-1 rounded-md bg-[#EEF0F2]">
                    {filters.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={betStatusFilter === f.id}
                        onClick={() => setBetStatusFilter(f.id)}
                        className={`min-h-[32px] px-3 rounded text-[13px] cursor-pointer ${
                          betStatusFilter === f.id ? 'bg-white text-[#16191D] font-medium' : 'text-[#3B424C] hover:text-[#16191D]'
                        }`}
                      >
                        {f.label} <span className="font-mono tabular-nums">{f.count}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-left border-collapse min-w-[760px]">
                    <thead className="border-b border-[#D9DDE2]">
                      <tr>
                        <th className={ui.th}>ออเดอร์</th>
                        <th className={ui.th}>ฝั่งต่ำ (ชถ)</th>
                        <th className={ui.th}>ฝั่งสูง (ชล)</th>
                        <th className={`${ui.th} text-right`}>ยอด</th>
                        <th className={ui.th}>ช่าง</th>
                        <th className={ui.th}>สถานะ</th>
                        <th className={ui.th}><span className="sr-only">จัดการ</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E6E9ED]">
                      {filteredBets.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-10 text-center text-sm text-[#5B636E]">ไม่มีออเดอร์ที่ตรงกับตัวกรอง</td>
                        </tr>
                      ) : (
                        filteredBets.slice().reverse().map(b => {
                          const isLow = b.side === 'low';
                          const pLowName = b.playerLowName || (isLow ? b.creatorName : b.matcherName);
                          const pLowId = b.playerLowId || (isLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
                          const pHighName = b.playerHighName || (!isLow && b.side === 'high' ? b.creatorName : b.matcherName);
                          const pHighId = b.playerHighId || (!isLow && b.side === 'high' ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
                          const chip = STATUS_CHIP[b.status] || { label: b.status, cls: 'bg-[#EEF0F2] text-[#3B424C]' };
                          const player = (name, id) => name ? (
                            <span className="flex flex-col">
                              <span>{name}</span>
                              {id && <span className="text-[12px] text-[#8A929D] font-mono">{id}</span>}
                            </span>
                          ) : <span className="text-[#8A929D]">—</span>;
                          return (
                            <tr key={b.id || `bet_${b.orderNumber}`} className="hover:bg-[#F7F8F9]">
                              <td className={ui.td}>
                                <span className="font-mono font-medium">#{b.orderNumber}</span>
                                {b.timestamp && <span className="block text-[12px] text-[#8A929D]">{b.timestamp}</span>}
                              </td>
                              <td className={ui.td}>{player(pLowName, pLowId)}</td>
                              <td className={ui.td}>{player(pHighName, pHighId)}</td>
                              <td className={`${ui.td} text-right font-mono tabular-nums`}>{b.amount?.toLocaleString()}</td>
                              <td className={`${ui.td} font-mono tabular-nums text-[#3B424C]`}>
                                {b.type === 'range'
                                  ? `${b.rangeMin > 1000 ? (b.rangeMin / 100) : b.rangeMin}–${b.rangeMax > 1000 ? (b.rangeMax / 100) : b.rangeMax}`
                                  : <span className="font-sans">ราคาช่าง {targetMin && targetMax ? `${targetMin}–${targetMax}` : ''}</span>}
                              </td>
                              <td className={ui.td}>
                                <span className={`${ui.chip} ${chip.cls}`}>{chip.label}</span>
                                {b.status === 'resolved' && b.winnerName && (
                                  <span className="block text-[12px] text-[#5B636E] mt-0.5">ชนะ: {b.winnerName}</span>
                                )}
                              </td>
                              <td className={`${ui.td} text-right`}>
                                {/* A matched duel can't be cancelled on its own: voiding the round is the only refund. */}
                                {b.status === 'pending_match' || b.status === 'pending_cancel' ? (
                                  <button type="button" onClick={() => handleRequestCancelBet(b.id)} className={ui.secondary}>
                                    ยกเลิกและคืนเงิน
                                  </button>
                                ) : b.status === 'matched' ? (
                                  <span className="text-[12px] text-[#8A929D]">ล็อกจนตัดสินผล</span>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="m-0 px-4 py-3 text-[13px] text-[#5B636E] border-t border-[#E6E9ED]">
                  แผลที่ต่อติดแล้วยกเลิกทีละแผลไม่ได้ ใช้ “โมฆะรอบ” ในหน้าประกาศเพื่อคืนเงินทั้งรอบ
                </p>
              </section>
            );
          })()}

          {/* TAB 4 & TAB 6: HIGH-DENSITY ENTERPRISE TRANSACTION CONTROL SUITE */}
          {(adminTab === 'review' || adminTab === 'logs') && (() => {
            const isReviewOnly = adminTab === 'review';
            const effectiveStatusFilter = isReviewOnly && txStatusFilter === 'all' ? 'escalated' : txStatusFilter;

            const filteredTxList = transactions.filter(tx => {
              const isWithdrawal = tx.id.startsWith('WD') || 
                (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || 
                (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));
              
              if (txTypeFilter === 'deposit' && isWithdrawal) return false;
              if (txTypeFilter === 'withdrawal' && !isWithdrawal) return false;

              if (effectiveStatusFilter === 'escalated' && tx.status !== 'escalated') return false;
              if (effectiveStatusFilter === 'success' && tx.status !== 'success') return false;
              if (effectiveStatusFilter === 'rejected' && tx.status !== 'rejected') return false;

              if (txSearchQuery.trim()) {
                const q = txSearchQuery.trim().toLowerCase();
                const matchId = tx.id && tx.id.toLowerCase().includes(q);
                const matchName = tx.playerName && tx.playerName.toLowerCase().includes(q);
                const matchPlayerId = tx.playerId && tx.playerId.toLowerCase().includes(q);
                const matchRef = tx.slipRef && tx.slipRef.toString().toLowerCase().includes(q);
                const matchReason = tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes(q);
                if (!matchId && !matchName && !matchPlayerId && !matchRef && !matchReason) return false;
              }

              return true;
            });

            const escalatedCount = transactions.filter(t => t.status === 'escalated').length;
            const successCount = transactions.filter(t => t.status === 'success').length;
            const rejectedCount = transactions.filter(t => t.status === 'rejected').length;

            return (
              <div className="glass-panel p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                      <FileText size={18} className={isReviewOnly ? 'text-amber-600' : 'text-slate-600'} />
                      {isReviewOnly ? 'ธุรกรรมรอตรวจสอบสลิป & คำขอถอน' : 'ประวัติการทำรายการฝาก-ถอนทั้งหมด'}
                    </h3>
                    <p className="text-xs text-slate-500 font-sans mt-0.5">
                      {isReviewOnly 
                        ? 'สลิปโอนที่ยอดไม่ตรง หรือคำขอถอนเงินที่รอแอดมินตรวจสอบและยืนยัน'
                        : 'บันทึกประวัติการเติมเงิน สแกนสลิป และถอนเครดิตทั้งหมดในระบบ'}
                    </p>
                  </div>
                </div>

                  {/* Filter & Search Bar */}
                  <div className="flex items-center justify-between gap-3 flex-wrap bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <div className="flex items-center gap-2 flex-wrap text-xs font-bold font-sans">
                      <span className="text-slate-400 text-[11px] uppercase tracking-wider">สถานะ:</span>
                      <button 
                        onClick={() => setTxStatusFilter('all')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${txStatusFilter === 'all' ? 'bg-slate-800 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'}`}
                      >
                        ทั้งหมด ({transactions.length})
                      </button>
                      <button 
                        onClick={() => setTxStatusFilter('escalated')}
                        className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${txStatusFilter === 'escalated' ? 'bg-amber-600 text-white shadow-xs' : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'}`}
                      >
                        <span>รออนุมัติ</span>
                        {escalatedCount > 0 && <span className="bg-amber-200 text-amber-900 text-[10px] px-1.5 py-0.2 rounded-full font-black">{escalatedCount}</span>}
                      </button>
                      <button 
                        onClick={() => setTxStatusFilter('success')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${txStatusFilter === 'success' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100'}`}
                      >
                        อนุมัติแล้ว ({successCount})
                      </button>
                      <button 
                        onClick={() => setTxStatusFilter('rejected')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${txStatusFilter === 'rejected' ? 'bg-rose-600 text-white shadow-xs' : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100'}`}
                      >
                        ปฏิเสธ ({rejectedCount})
                      </button>

                      <div className="h-4 w-px bg-slate-200 mx-1 hidden md:block"></div>

                      <span className="text-slate-400 text-[11px] uppercase tracking-wider hidden md:inline">ประเภท:</span>
                      <button 
                        onClick={() => setTxTypeFilter('all')}
                        className={`px-2 py-1 rounded-lg text-[11px] transition-all ${txTypeFilter === 'all' ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 border border-slate-200'}`}
                      >
                        ทั้งหมด
                      </button>
                      <button 
                        onClick={() => setTxTypeFilter('deposit')}
                        className={`px-2 py-1 rounded-lg text-[11px] transition-all ${txTypeFilter === 'deposit' ? 'bg-emerald-700 text-white' : 'bg-white text-emerald-700 border border-emerald-200'}`}
                      >
                        ฝากเงิน
                      </button>
                      <button 
                        onClick={() => setTxTypeFilter('withdrawal')}
                        className={`px-2 py-1 rounded-lg text-[11px] transition-all ${txTypeFilter === 'withdrawal' ? 'bg-rose-700 text-white' : 'bg-white text-rose-700 border border-rose-200'}`}
                      >
                        ถอนเงิน
                      </button>
                    </div>

                    <div className="relative min-w-[240px] flex-1 md:flex-initial">
                      <input 
                        type="text" 
                        placeholder="ค้นหา TX ID / ชื่อผู้เล่น / LINE ID / Ref..." 
                        value={txSearchQuery}
                        onChange={e => setTxSearchQuery(e.target.value)}
                        className="w-full pl-3 pr-8 py-1.5 bg-white border border-slate-300 rounded-xl text-xs font-sans text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500 shadow-2xs"
                      />
                      {txSearchQuery && (
                        <button 
                          onClick={() => setTxSearchQuery('')}
                          className="absolute right-2.5 top-1.5 text-slate-400 hover:text-slate-600 font-bold text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                {/* High-Density Compact Transaction Table */}
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="w-full text-left font-sans text-xs border-collapse min-w-[850px]">
                    <thead className="bg-slate-100 text-slate-600 font-bold uppercase tracking-wider text-[10.5px]">
                      <tr className="border-b border-slate-200">
                        <th className="py-2.5 px-3">TX ID / เวลา</th>
                        <th className="py-2.5 px-3">ผู้เล่น / LINE ID</th>
                        <th className="py-2.5 px-3 text-center">ประเภท</th>
                        <th className="py-2.5 px-3 text-right">ยอดสั่ง (THB)</th>
                        <th className="py-2.5 px-3 text-right">ยอดสแกนจริง</th>
                        <th className="py-2.5 px-3 text-center">สถานะ</th>
                        <th className="py-2.5 px-3">เลขอ้างอิง / หมายเหตุ</th>
                        <th className="py-2.5 px-3 text-center">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {filteredTxList.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-10 text-center text-slate-400 font-sans">
                            <p className="font-bold text-xs">-- ไม่พบรายการธุรกรรมตามเงื่อนไขที่เลือก --</p>
                          </td>
                        </tr>
                      ) : (
                        filteredTxList.map(tx => {
                          const isWithdrawal = tx.id.startsWith('WD') || 
                            (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || 
                            (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));
                          
                          return (
                            <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                              <td className="py-2.5 px-3">
                                <div className="font-bold font-mono text-slate-900 text-[11px]">{tx.id}</div>
                                <div className="text-[9.5px] text-slate-400 font-mono">{tx.timestamp}</div>
                              </td>

                              <td className="py-2.5 px-3">
                                <div className="font-bold text-slate-800">{tx.playerName}</div>
                                <div className="text-[9.5px] text-slate-400 font-mono">{tx.playerId}</div>
                              </td>

                              <td className="py-2.5 px-3 text-center">
                                {isWithdrawal ? (
                                  <span className="px-2 py-0.5 bg-rose-100 text-rose-800 font-black rounded-md text-[10px]">ถอนเงิน</span>
                                ) : (
                                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-black rounded-md text-[10px]">ฝากเงิน</span>
                                )}
                              </td>

                              <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                                {isWithdrawal ? `-${tx.requestedAmount}` : tx.requestedAmount}.00
                              </td>

                              <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">
                                {tx.actualAmount > 0 ? `${tx.actualAmount}.00` : <span className="text-slate-400 italic">0.00</span>}
                              </td>

                              <td className="py-2.5 px-3 text-center">
                                {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg text-[10px] font-bold">อนุมัติแล้ว</span>}
                                {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg text-[10px] font-bold animate-pulse">รออนุมัติ</span>}
                                {tx.status === 'rejected' && <span className="badge-high px-2 py-0.5 rounded-lg text-[10px] font-bold">✕ ปฏิเสธ</span>}
                              </td>

                              <td className="py-2.5 px-3 max-w-[220px]">
                                <div className="font-mono text-[10px] text-slate-700 font-bold truncate" title={tx.slipRef}>{tx.slipRef}</div>
                                <div className="text-[9.5px] text-slate-500 truncate" title={tx.reviewReason}>{tx.reviewReason}</div>
                              </td>

                              <td className="py-2.5 px-3 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  {tx.status === 'escalated' && (
                                    <>
                                      <button 
                                        onClick={() => handleAdminApproveReview(tx.id)}
                                        className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[10px] rounded-lg transition-all shadow-2xs"
                                        title="อนุมัติรายการ"
                                      >
                                        อนุมัติ
                                      </button>
                                      <button 
                                        onClick={() => handleAdminRejectReview(tx.id, isWithdrawal ? 'ปฏิเสธคำขอและส่งแต้มคืนเข้าบัญชี' : 'ปฏิเสธเนื่องจากไม่มียอดโอนจริง')}
                                        className="px-2 py-1 bg-rose-50 hover:bg-rose-600 text-rose-700 hover:text-white border border-rose-200 text-[10px] font-bold rounded-lg transition-all"
                                        title="ปฏิเสธรายการ"
                                      >
                                        ✕ ปฏิเสธ
                                      </button>
                                    </>
                                  )}
                                  <button 
                                    onClick={() => setTxDetailModal(tx)}
                                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold rounded-lg transition-all border border-slate-300"
                                    title="ดูสลิปและรายละเอียดเต็ม"
                                  >
                                    สลิป
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* TAB 5: PLAYERS CREDIT */}
          {adminTab === 'players' && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Users size={18} className="text-teal-600" />
                    จัดการบัญชีผู้เล่น
                  </h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">
                    ตรวจสอบรายชื่อ แก้ไขเครดิต บัญชีธนาคาร หรือเพิ่มสมาชิกใหม่
                  </p>
                </div>
                <button
                  onClick={() => { 
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                    const randomId = chars[Math.floor(Math.random() * 26)] + 
                                     chars[Math.floor(Math.random() * 26)] + 
                                     Math.floor(100000 + Math.random() * 900000).toString();
                    setCreatePlayerModal(true); 
                    setCreatePlayerForm({ lineId: randomId, name: '', balance: 0 }); 
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-lg transition-all active:scale-95"
                >
                  <span>＋ เพิ่มผู้เล่น</span>
                </button>
              </div>

              {/* Player Table */}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left font-sans text-xs border-collapse min-w-[700px]">
                  <thead className="bg-slate-50">
                    <tr className="border-b border-slate-200 text-slate-500 font-bold">
                      <th className="py-2.5 px-3">ผู้เล่น / LINE ID</th>
                      <th className="py-2.5 px-3 text-right">เครดิต</th>
                      <th className="py-2.5 px-3">ธนาคาร</th>
                      <th className="py-2.5 px-3">เลขบัญชี</th>
                      <th className="py-2.5 px-3 text-center">สถานะบัญชี</th>
                      <th className="py-2.5 px-3 text-center">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {players.map(p => {
                      const hasBank = !!(p.bankName && p.bankAccount);
                      return (
                        <tr key={p.shortId || p.lineUserId || p.id} className="hover:bg-teal-50/20 transition-colors group">
                          {/* Player name + ID */}
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              <span className="text-lg w-8 h-8 flex items-center justify-center bg-slate-100 rounded-full border border-slate-200 shrink-0">{p.avatar}</span>
                              <div>
                                <div className="font-bold text-slate-800">{p.name}</div>
                                <div className="text-[9px] text-slate-400 font-mono" title={p.id}>{p.id.length > 18 ? p.id.slice(0, 18) + '…' : p.id}</div>
                              </div>
                            </div>
                          </td>
                          {/* Balance */}
                          <td className="py-3 px-3 text-right">
                            <span className="font-extrabold text-sky-700 font-mono text-sm">{p.balance.toLocaleString()}</span>
                            <span className="text-slate-400 ml-1 text-[10px]">pt</span>
                          </td>
                          {/* Bank */}
                          <td className="py-3 px-3">
                            {hasBank
                              ? <span className="px-2 py-0.5 bg-teal-50 border border-teal-200 text-teal-800 rounded font-bold">{p.bankName}</span>
                              : <span className="text-slate-300 italic">—</span>}
                          </td>
                          {/* Account no */}
                          <td className="py-3 px-3 font-mono">
                            {hasBank ? p.bankAccount : <span className="text-slate-300">—</span>}
                          </td>
                          {/* Status */}
                          <td className="py-3 px-3 text-center">
                            {hasBank
                              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full text-[10px] font-bold">ลงทะเบียนแล้ว</span>
                              : <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full text-[10px] font-bold animate-pulse">รอลงทะเบียน</span>}
                          </td>
                          {/* Actions */}
                          <td className="py-3 px-3">
                            <div className="flex items-center justify-center gap-1.5 flex-wrap">
                              {/* Edit profile & balance */}
                              <button
                                title="แก้ไขชื่อ / เครดิต"
                                onClick={() => {
                                  setPlayerEditModal({ player: p });
                                  setPlayerEditForm({ name: p.name, balance: p.balance });
                                }}
                                className="px-2.5 py-1.5 bg-sky-50 border border-sky-200 text-sky-700 text-[10px] font-bold rounded-lg hover:bg-sky-100 transition-all active:scale-95"
                              >
                                แก้ไข
                              </button>
                              {/* Edit bank */}
                              <button
                                title="แก้ไขบัญชีธนาคาร"
                                onClick={() => {
                                  setBankEditModal({ player: p });
                                  setBankEditForm({ bankName: p.bankName || '', bankAccount: p.bankAccount || '', accountName: p.accountName || p.name || '' });
                                }}
                                className="px-2.5 py-1.5 bg-teal-50 border border-teal-200 text-teal-700 text-[10px] font-bold rounded-lg hover:bg-teal-100 transition-all active:scale-95"
                              >
                                บัญชี
                              </button>
                              {/* Delete */}
                              <button
                                title="ลบผู้เล่น"
                                onClick={() => setConfirmDelete({ player: p })}
                                className="px-2.5 py-1.5 bg-rose-50 border border-rose-200 text-rose-600 text-[10px] font-bold rounded-lg hover:bg-rose-100 transition-all active:scale-95"
                              >
                                
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {players.length === 0 && (
                  <div className="py-10 text-center text-slate-400 text-sm">ยังไม่มีผู้เล่นในระบบ — กด «เพิ่มผู้เล่น» เพื่อเริ่มต้น</div>
                )}
              </div>
            </div>
          )}

          {/* TAB 7: BROADCAST HUB & FIELD ADMIN HOTKEYS */}
          {/* TAB: DEPOSIT ACCOUNT — where the LINE OA deposit screen points players */}
          {adminTab === 'bank' && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Landmark size={18} className="text-sky-600" />
                    บัญชีรับเงินฝาก
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    ข้อมูลนี้คือบัญชีที่ข้อความ &ldquo;ฝาก&rdquo; ใน LINE OA แสดงให้ผู้เล่นโอนเงินเข้า
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed">
                ตรวจสอบเลขบัญชีให้ถูกต้องก่อนบันทึก — ผู้เล่นจะโอนเงินตามข้อมูลชุดนี้ทันที
                และระบบจะเติมเครดิตอัตโนมัติจากยอดในสลิปที่ส่งมา
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">ธนาคาร</span>
                  <input
                    type="text"
                    value={paymentBank.bankName}
                    onChange={(e) => setPaymentBank(p => ({ ...p, bankName: e.target.value }))}
                    placeholder="เช่น SCB (ไทยพาณิชย์)"
                    className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-slate-600">เลขบัญชี</span>
                  <input
                    type="text"
                    value={paymentBank.accountNumber}
                    onChange={(e) => setPaymentBank(p => ({ ...p, accountNumber: e.target.value }))}
                    placeholder="เช่น 123-4-56789-0"
                    className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-bold text-slate-600">ชื่อบัญชี</span>
                  <input
                    type="text"
                    value={paymentBank.accountName}
                    onChange={(e) => setPaymentBank(p => ({ ...p, accountName: e.target.value }))}
                    placeholder="เช่น สมชาย ใจดี"
                    className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-bold text-slate-600">หมายเหตุ (ถ้ามี)</span>
                  <input
                    type="text"
                    value={paymentBank.note}
                    onChange={(e) => setPaymentBank(p => ({ ...p, note: e.target.value }))}
                    placeholder="ข้อความเสริมใต้เลขบัญชี เช่น ชำระหมดค่าส่วนนี้"
                    className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleSavePaymentBank}
                  disabled={paymentBankSaving}
                  className={`px-4 py-2.5 rounded-lg text-sm font-bold text-white transition-all flex items-center gap-2 ${
                    paymentBankSaving ? 'bg-slate-400 cursor-not-allowed' : 'bg-sky-600 hover:bg-sky-700'
                  }`}
                >
                  {paymentBankSaving ? <RefreshCw size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                  {paymentBankSaving ? 'กำลังบันทึก...' : 'บันทึกบัญชีรับเงิน'}
                </button>
              </div>
            </div>
          )}

          {adminTab === 'bank' && adminRole === 'superadmin' && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div className="flex items-center gap-2">
                  <ShieldAlert size={18} className="text-rose-600" />
                  <h3 className="text-base font-black text-slate-800">PIN สำหรับการล้างข้อมูลระบบ</h3>
                </div>
                <span className="text-[11px] text-slate-500">Super Admin เท่านั้น</span>
              </div>

              <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-800 space-y-1">
                <p className="font-bold">การล้างระเบียนข้อมูล (Factory Reset) ไม่มีการสำรองข้อมูลและย้อนกลับไม่ได้</p>
                <p>ระบบจะไม่อนุญาตให้ล้างข้อมูลจนกว่าจะตั้งค่า PIN นี้ ข้อมูลผู้เล่น ยอดเครดิต ธุรกรรม และบันทึกแชททั้งหมดจะถูกลบถาวร</p>
                <p>PIN นี้ไม่เกี่ยวข้องกับรหัสผ่านของคุณ และจะถูกตรวจสอบบนเซิร์ฟเวอร์อีกครั้งก่อนดำเนินการ</p>
              </div>

              <label className="block">
                <span className="text-xs font-bold text-slate-600">ตั้งค่า PIN (ตัวเลข 4–12 หลัก)</span>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  value={dangerPin}
                  onChange={(e) => setDangerPin(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="เช่น 583920"
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </label>

              <div className="flex justify-end">
                <button
                  onClick={handleSaveDangerPin}
                  disabled={dangerPinSaving}
                  className={`px-4 py-2.5 rounded-lg text-sm font-bold text-white transition-all flex items-center gap-2 ${
                    dangerPinSaving ? 'bg-slate-400 cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-700'
                  }`}
                >
                  {dangerPinSaving ? <RefreshCw size={15} className="animate-spin" /> : <ShieldAlert size={15} />}
                  {dangerPinSaving ? 'กำลังบันทึก...' : 'บันทึก PIN'}
                </button>
              </div>
            </div>
          )}

          {adminTab === 'broadcast' && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Radio size={18} className="text-purple-600" />
                    ศูนย์บรอดแคสต์ & คีย์ลัดสั่งการสนาม
                  </h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">
                    ควบคุมรอบฉุกเฉิน ปิดรับดวล ส่งคู่มือกติกา ประกาศข้อความสนามเข้ากลุ่ม LINE
                  </p>
                </div>
              </div>


              {/* Target Group Selector (Applies to all actions in this tab) */}
              <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 bg-purple-600 text-white rounded-lg">
                    <Users size={14} />
                  </span>
                  <div>
                    <span className="text-xs font-black text-purple-950 font-heading block">กลุ่มเป้าหมายการส่งข้อความ:</span>
                    <span className="text-[10px] text-purple-700 font-sans">คำสั่งและประกาศทั้งหมดในหน้านี้จะส่งไปยังกลุ่มที่เลือก</span>
                  </div>
                </div>
                <div className="w-full sm:w-80">
                  <select
                    value={broadcastTargetGroup}
                    onChange={(e) => setBroadcastTargetGroup(e.target.value)}
                    className="w-full bg-white border border-purple-200 text-purple-950 font-bold px-3 py-1.5 rounded-lg text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none"
                  >
                    <option value="ALL">กระจายทุกกลุ่มดวลสด (All Groups)</option>
                    {lineGroups.map((g, idx) => {
                      const isRawId = !g.name || g.name.startsWith('C') || g.name.includes(g.id) || !isNaN(g.name);
                      const displayName = !isRawId ? g.name : `กลุ่มดวลสด #${idx + 1} (${g.id.slice(-4)})`;
                      return (
                        <option key={g.id} value={g.id}>
                          เฉพาะกลุ่ม: {displayName}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {/* SECTION 1: FIELD OPERATION & EMERGENCY HOTKEYS */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-slate-800 uppercase tracking-wider font-heading flex items-center gap-1.5">
                    <span>1. ปุ่มคีย์ลัดสั่งการสนาม & กฎกติกา</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-sans">ส่งการ์ด Flex แจ้งเตือนด่วนเข้ากลุ่ม LINE ทันที</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Combined Rocket Launched + Final Call Card */}
                  <div className="bg-gradient-to-br from-orange-50 via-amber-50/80 to-orange-100/70 border-2 border-orange-300 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between shadow-xs">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-1 flex-wrap">
                        <span className="text-xs font-black text-orange-950 font-heading flex items-center gap-1">
                          <span>บั้งไฟออกแล้ว! (ปิดรับดวล)</span>
                        </span>
                        <span className="text-[10px] font-black px-2 py-0.5 bg-orange-200 text-orange-950 rounded-md">
                          Live Action · Final Call
                        </span>
                      </div>
                      <p className="text-[10.5px] text-orange-900/90 font-sans leading-relaxed">
                        ล็อกรอบและประกาศ <strong>&ldquo;บั้งไฟออกแล้ว + ปิดรับดวล&rdquo;</strong> พร้อมกันในคลิกเดียว ยกเลิกแผลเปิดที่ไม่มีคู่และคืนแต้มอัตโนมัติทันที
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <button
                        onClick={async () => {
                          try {
                            const res = await runBackendFunction('adminBroadcastRocketLaunched', [broadcastTargetGroup || 'ALL']);
                            if (res && res.success === false) {
                              addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                            } else {
                              await forceSyncFreshData();
                              addToast('บั้งไฟออกแล้ว & ปิดรับดวลเรียบร้อย!', 'warning');
                            }
                          } catch {
                            addToast('ส่งไม่สำเร็จ', 'danger');
                          }
                        }}
                        style={{ backgroundColor: '#ea580c', color: '#ffffff' }}
                        className="w-full py-2.5 px-3 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-xs font-black transition-all active:scale-95 flex items-center justify-center gap-1.5 shadow-xs cursor-pointer"
                      >
                        <span className="text-white font-black">บั้งไฟออกแล้ว! (ปิดรับดวลทันที)</span>
                      </button>
                      <button
                        onClick={() => setAdminTab('next_rocket')}
                        className="w-full py-1.5 px-2.5 bg-white/90 hover:bg-white text-orange-900 border border-orange-300 rounded-lg text-[10.5px] font-extrabold transition-all flex items-center justify-center gap-1 cursor-pointer"
                      >
                        <Rocket size={12} className="text-orange-600" />
                        <span>เปิดรับบั้งไฟลูกถัดไป (Rocket B) ต่อทันที </span>
                      </button>
                    </div>
                  </div>

                  {/* Void Round */}
                  <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-rose-900 font-heading">โมฆะรอบ (ช่าง )</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-rose-200 text-rose-900 rounded-md">Emergency</span>
                      </div>
                      <p className="text-[10.5px] text-rose-800/80 font-sans leading-relaxed">
                        กรณีบั้งไฟมีปัญหา ยุติรอบการแข่งขัน ยกเลิกแผลดวลและโอนคืนเครดิตให้ผู้เล่น 100%
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        const roundLabel = activeRoundObj?.name || rocketName || 'โมฆะ';
                        const ok = await ask({
                          title: `โมฆะรอบ “${roundLabel}”`,
                          tone: 'danger',
                          body: 'ยกเลิกทุกแผลในรอบนี้และคืนเงินผู้เล่น 100% ย้อนกลับไม่ได้ และจะแจ้งเข้ากลุ่ม LINE',
                          typeToConfirm: roundLabel,
                          confirmLabel: 'โมฆะและคืนเงิน',
                        });
                        if (!ok) return;
                        try {
                          const res = await runBackendFunction('adminBroadcastVoidRound', [broadcastTargetGroup || 'ALL']);
                          if (res && res.success === false) addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('โมฆะรอบและคืนเงินแล้ว', 'success');
                        } catch {
                          addToast('ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="w-full py-2 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <span>สั่งโมฆะรอบ & คืนแต้ม</span>
                    </button>
                  </div>

                  {/* Rule Guide */}
                  <div className="bg-teal-50/70 border border-teal-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-teal-900 font-heading">คู่มือกติกา</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-teal-200 text-teal-900 rounded-md">Guide</span>
                      </div>
                      <p className="text-[10.5px] text-teal-800/80 font-sans leading-relaxed">
                        ส่ง Flex Card กฎกติกา คีย์เวิร์ดต่ำ/สูง อัตราต่อรอง และวิธีจับคู่ลงกลุ่มดวลสด
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const res = await runBackendFunction('adminBroadcastRuleGuide', [broadcastTargetGroup || 'ALL']);
                          if (res && res.success === false) addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('ส่งกติกาแล้ว', 'info');
                        } catch {
                          addToast('ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="w-full py-2 px-3 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <span>ส่งคู่มือกติกาเข้ากลุ่ม</span>
                    </button>
                  </div>

                  {/* Daily Duel Summary */}
                  <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-indigo-900 font-heading">สรุปผลประจำวัน</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-indigo-200 text-indigo-900 rounded-md">Summary</span>
                      </div>
                      <p className="text-[10.5px] text-indigo-800/80 font-sans leading-relaxed">
                        ส่ง Flex สรุปคู่ดวลที่ตัดสินผลแล้วของวัน แยกตามบั้งไฟแต่ละลำ พร้อมผู้ชนะ/ผู้แพ้ทุกคู่
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <input
                        type="date"
                        value={summaryDay}
                        max={bangkokToday()}
                        onChange={(e) => { setSummaryDay(e.target.value); setSummaryPreview(null); }}
                        className="w-full py-1.5 px-2 bg-white border border-indigo-200 rounded-lg text-[11px] font-bold text-indigo-950"
                      />
                      {summaryPreview && (
                        <div className="bg-white/90 border border-indigo-100 rounded-lg p-2 space-y-1 max-h-40 overflow-y-auto">
                          {summaryPreview.count === 0 ? (
                            <p className="text-[10.5px] text-slate-500 text-center">ยังไม่มีคู่ดวลที่ตัดสินผลในวันนี้</p>
                          ) : (
                            summaryPreview.rounds.map((r) => (
                              <div key={r.key} className="flex items-center justify-between text-[10.5px] gap-2">
                                <span className="font-bold text-indigo-950 truncate">{r.name}</span>
                                <span className="text-slate-500 shrink-0">{r.pairs} คู่ · ค่าธรรมเนียม {r.fees.toLocaleString()}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                      <button
                        disabled={summaryBusy}
                        onClick={async () => {
                          setSummaryBusy(true);
                          try {
                            const res = await runBackendFunction('adminGetDailySummary', [summaryDay]);
                            if (!res || res.success === false) {
                              addToast(`โหลดสรุปไม่สำเร็จ: ${res?.error || 'ไม่ทราบสาเหตุ'}`, 'warning');
                            } else {
                              const byRound = new Map();
                              for (const o of res.orders || []) {
                                const key = o.roundId || o.inFlightRoundId || `name:${o.rocketName || 'บั้งไฟสด'}`;
                                const r = byRound.get(key) || { key, name: o.rocketName || 'บั้งไฟสด', pairs: 0, fees: 0 };
                                r.pairs += 1;
                                r.fees += Number(o.commission) || 0;
                                byRound.set(key, r);
                              }
                              setSummaryPreview({ count: res.count || 0, rounds: [...byRound.values()] });
                            }
                          } catch {
                            addToast('โหลดสรุปไม่สำเร็จ', 'danger');
                          } finally {
                            setSummaryBusy(false);
                          }
                        }}
                        className="w-full py-1.5 px-2.5 bg-white/90 hover:bg-white text-indigo-900 border border-indigo-300 rounded-lg text-[10.5px] font-extrabold transition-all flex items-center justify-center gap-1 cursor-pointer disabled:opacity-60"
                      >
                        <span>ดูตัวอย่างสรุป</span>
                      </button>
                      <button
                        disabled={summaryBusy}
                        onClick={async () => {
                          const ok = await ask({
                            title: `ส่งสรุปผลวันที่ ${summaryDay} เข้ากลุ่ม LINE?`,
                            items: ['การ์ดแสดงผู้ชนะและผู้แพ้ของแต่ละออเดอร์ ไม่มียอดเงิน', 'ส่งแล้วยกเลิกไม่ได้'],
                            confirmLabel: 'ส่งเข้ากลุ่ม',
                          });
                          if (!ok) return;
                          setSummaryBusy(true);
                          try {
                            const res = await runBackendFunction('adminBroadcastDailySummary', [summaryDay, broadcastTargetGroup || 'ALL']);
                            if (res && res.success === false) addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                            else addToast(`ส่งสรุปผลประจำวันแล้ว (${res?.count ?? 0} คู่)`, 'info');
                          } catch {
                            addToast('ส่งไม่สำเร็จ', 'danger');
                          } finally {
                            setSummaryBusy(false);
                          }
                        }}
                        className="w-full py-2 px-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                      >
                        <span>ส่งสรุปผลเข้ากลุ่ม</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION 2: CUSTOM FIELD ANNOUNCEMENT */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-slate-800 uppercase tracking-wider font-heading flex items-center gap-1.5">
                    <span>2. ส่งประกาศอิสระเข้ากลุ่ม LINE</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-sans">พิมพ์ข้อความแจ้งเตือนหรือข้อมูลสนามส่งตรงเข้ากลุ่ม</span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  {/* Quick Preset Buttons */}
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">ข้อความด่วนแนะนำ (คลิกเพื่อใส่ข้อความ):</span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setCustomBroadcastText('ประกาศจากสนาม: ขณะนี้อยู่ในช่วงพักเบรก 15 นาที จะเริ่มเปิดรับดวลรอบถัดไปเร็ว ๆ นี้ครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95 cursor-pointer"
                      >
                        พักเบรก 15 นาที
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('ประกาศจากสนาม: เนื่องจากสภาพอากาศมีฝนตก จึงขอพักการปล่อยบั้งไฟชั่วคราว เมื่อพร้อมจะแจ้งให้ทราบครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95 cursor-pointer"
                      >
                        ฝนตก พักการยิงชั่วคราว
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('เตรียมพร้อม! บั้งไฟกำลังขึ้นติดตั้งบนแท่นยิง โปรดเตรียมแต้มให้พร้อมสำหรับการท้าดวล')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95 cursor-pointer"
                      >
                        บั้งไฟกำลังขึ้นแท่นยิง
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText(`บั้งไฟ ${rocketName || activeRoundObj?.name || 'รอบใหม่'} พร้อมแล้ว เปิดแผลเล่นได้เลยครับ`)}
                        className="px-2.5 py-1 bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-300 rounded-lg text-[10.5px] font-extrabold transition-all active:scale-95 cursor-pointer"
                      >
                        บั้งไฟพร้อมแล้ว เชิญเปิดแผล
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('สรุปผลการแข่งขันและการดวลประจำวันเสร็จสิ้นเรียบร้อย ขอบพระคุณสมาชิกทุกท่านที่ร่วมสนุกครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95 cursor-pointer"
                      >
                        จบการแข่งขันประจำวัน
                      </button>
                    </div>
                  </div>

                  {/* Textarea Input */}
                  <div className="space-y-1">
                    <textarea
                      rows={3}
                      value={customBroadcastText}
                      onChange={(e) => setCustomBroadcastText(e.target.value)}
                      placeholder="พิมพ์ข้อความที่ต้องการประกาศส่งตรงเข้ากลุ่ม LINE..."
                      className="w-full bg-white border border-slate-200 text-slate-900 px-3 py-2.5 rounded-xl text-xs font-sans focus:ring-2 focus:ring-purple-500 focus:outline-none placeholder-slate-400"
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <span className="text-[10px] text-slate-400 font-sans">
                      ส่งไปยัง: <strong className="text-purple-800">{broadcastTargetGroup === 'ALL' ? 'ทุกกลุ่มดวลสด' : 'กลุ่มที่เลือก'}</strong>
                    </span>
                    <div className="flex gap-2">
                      {customBroadcastText && (
                        <button
                          onClick={() => setCustomBroadcastText('')}
                          className="px-3 py-1.5 border border-slate-300 text-slate-600 rounded-lg text-xs font-bold hover:bg-white transition-all active:scale-95"
                        >
                          ล้างข้อความ
                        </button>
                      )}
                      <button
                        disabled={isSendingBroadcast || !customBroadcastText.trim()}
                        onClick={async () => {
                          if (!customBroadcastText.trim()) return;
                          setIsSendingBroadcast(true);
                          try {
                            const res = await runBackendFunction('sendAdminMessageToLine', [broadcastTargetGroup || 'ALL', customBroadcastText.trim()]);
                            if (res && res.success === false) {
                              addToast(`ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                            } else {
                              addToast('ส่งประกาศเข้ากลุ่มแล้ว', 'success');
                              setCustomBroadcastText('');
                            }
                          } catch {
                            addToast('ส่งไม่สำเร็จ', 'danger');
                          } finally {
                            setIsSendingBroadcast(false);
                          }
                        }}
                        className="py-2 px-5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-all active:scale-95 shadow-md flex items-center gap-1.5"
                      >
                        <Megaphone size={14} />
                        <span>{isSendingBroadcast ? 'กำลังส่ง...' : 'ส่งประกาศเข้ากลุ่ม LINE'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION 3: LINE GROUP CONNECTION & DIAGNOSTICS */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-slate-800 uppercase tracking-wider font-heading flex items-center gap-1.5">
                    <span>3. จัดการการเชื่อมต่อกลุ่ม LINE</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-sans">ตรวจสอบสถานะ Webhook และทดสอบการส่งข้อความ</span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  {/* Status Bar */}
                  <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-slate-200">
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${activeGroupId ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
                      <span className="text-xs font-bold text-slate-700">
                        สถานะ Active Group ID:
                      </span>
                      {activeGroupId ? (
                        <span className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded font-mono text-[11px] font-bold">
                          {activeGroupId}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 rounded text-[10.5px] font-bold">
                          ยังไม่มี Group ID หลัก
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {activeGroupId && (
                        <button
                          onClick={async () => {
                            const ok = await ask({
                              title: 'เปลี่ยนกลุ่ม LINE ที่ใช้งาน',
                              body: 'ประกาศ กระดาน และสรุปผลจะถูกส่งเข้ากลุ่มใหม่นี้',
                              fields: [{
                                name: 'gid',
                                label: 'LINE Group ID',
                                defaultValue: activeGroupId,
                                validate: (v) => (v.trim().length > 5 ? null : 'Group ID สั้นเกินไป'),
                              }],
                              confirmLabel: 'บันทึก',
                            });
                            const gid = ok?.values.gid;
                            if (gid && gid !== activeGroupId) {
                              await runBackendFunction('adminSetActiveGroupId', [gid.trim()]);
                              const dash = await runBackendFunction('getDashboardData', []);
                              if (dash) { setActiveGroupId(dash.activeGroupId); setLineGroups(dash.lineGroups || []); }
                              addToast(`เปลี่ยน Group ID เป็น ...${gid.trim().slice(-8)}`, 'success');
                            }
                          }}
                          className="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                        >
                          เปลี่ยน Group ID
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          const testPushToastId = addToast('กำลังทดสอบส่ง Push...', 'info');
                          try {
                            const testRes = await runBackendFunction('adminTestPushGroupMessage', [activeGroupId || 'ALL']);
                            removeToast(testPushToastId);
                            if (testRes && testRes.success) {
                              addToast('ทดสอบส่ง Push สำเร็จ', 'success');
                            } else {
                              addToast(`ส่งไม่สำเร็จ: ${testRes?.error || 'โควตาเต็ม'}`, 'warning');
                            }
                          } catch {
                            removeToast(testPushToastId);
                            addToast('ส่งไม่สำเร็จ', 'danger');
                          }
                        }}
                        className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-bold transition-all active:scale-95 shadow-xs flex items-center gap-1"
                      >
                        <span>ทดสอบส่ง Push เข้ากลุ่ม</span>
                      </button>
                    </div>
                  </div>

                  {/* Auto Discover & Paste Bar */}
                  <div className="flex gap-2 flex-wrap sm:flex-nowrap pt-1">
                    <button
                      onClick={async () => {
                        try {
                          const res = await runBackendFunction('adminDiscoverGroupIds', []);
                          if (res && res.discovered && res.discovered.length > 0) {
                            const first = res.discovered[0];
                            addToast(`พบ Group ID: ...${first.id.slice(-6)}`, 'info');
                            await runBackendFunction('adminSetActiveGroupId', [first.id]);
                            const dash = await runBackendFunction('getDashboardData', []);
                            if (dash) { setActiveGroupId(dash.activeGroupId); setLineGroups(dash.lineGroups || []); }
                            addToast('ตั้งค่า Group ID สำเร็จ', 'success');
                          } else {
                            addToast('ไม่พบ Group ID ในระบบ', 'warning');
                          }
                        } catch {
                          addToast('ค้นหาไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="py-2 px-3.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg transition-all active:scale-95 whitespace-nowrap"
                    >
                      Auto Discover
                    </button>
                    <input
                      type="text"
                      placeholder="หรือวาง LINE Group ID ด้วยตนเอง (เช่น C1234567890abcdef...) แล้วกด Enter"
                      className="flex-1 bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-purple-400"
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && e.target.value.trim().length > 5) {
                          const gid = e.target.value.trim();
                          try {
                            await runBackendFunction('adminSetActiveGroupId', [gid]);
                            const dash = await runBackendFunction('getDashboardData', []);
                            if (dash) { setActiveGroupId(dash.activeGroupId); setLineGroups(dash.lineGroups || []); }
                            addToast(`ตั้งค่า Group ID สำเร็จ: ...${gid.slice(-8)}`, 'success');
                            e.target.value = '';
                          } catch(err) {
                            const errStr = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'Error';
                            addToast(`Error: ${errStr}`, 'danger');
                          }
                        }
                      }}
                    />
                  </div>

                  {/* Connected Groups List */}
                  {lineGroups.length > 0 && (
                    <div className="pt-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                        กลุ่ม LINE ทั้งหมดที่บอทเชื่อมต่อ ({lineGroups.length} กลุ่ม):
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {lineGroups.map((g, i) => (
                          <div key={g.id || i} className="p-2.5 bg-white border border-slate-200 rounded-lg flex items-center justify-between text-xs">
                            <div className="min-w-0">
                              <span className="font-bold text-slate-800 block truncate">{g.name || `กลุ่ม #${i + 1}`}</span>
                              <span className="text-[9px] text-slate-400 font-mono block">{g.id}</span>
                            </div>
                            <span className="text-[9.5px] px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md font-bold shrink-0">
                              Connected
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── PLAYER EDIT MODAL (name + balance) ── */}
          {playerEditModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
              onClick={e => { if (e.target === e.currentTarget) setPlayerEditModal(null); }}
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                <div 
                  className="bg-sky-600 bg-gradient-to-r from-sky-600 to-sky-700 px-6 py-4"
                  style={{ backgroundColor: '#0284c7', color: '#ffffff' }}
                >
                  <h3 className="font-bold text-base" style={{ color: '#ffffff' }}>แก้ไขข้อมูลผู้เล่น</h3>
                  <p className="text-xs mt-0.5 font-mono" style={{ color: '#e0f2fe' }}>{playerEditModal.player.id}</p>
                </div>
                <div className="px-6 py-5 space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">ชื่อผู้เล่น (Display Name)</label>
                    <input
                      type="text"
                      value={playerEditForm.name}
                      onChange={e => setPlayerEditForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">ยอดเครดิต (Credit Balance)</label>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPlayerEditForm(f => ({ ...f, balance: Math.max(0, f.balance - 100) }))} className="w-9 h-9 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 font-bold text-slate-600 text-lg flex items-center justify-center transition-all">−</button>
                      <input
                        type="number"
                        min="0"
                        value={playerEditForm.balance}
                        onChange={e => setPlayerEditForm(f => ({ ...f, balance: Math.max(0, Number(e.target.value)) }))}
                        className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-sky-400"
                      />
                      <button onClick={() => setPlayerEditForm(f => ({ ...f, balance: f.balance + 100 }))} className="w-9 h-9 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 font-bold text-slate-600 text-lg flex items-center justify-center transition-all">＋</button>
                    </div>
                    <p className="text-[10px] text-slate-400">ยอดปัจจุบัน: <strong>{playerEditModal.player.balance.toLocaleString()} pt</strong> → ยอดใหม่: <strong className="text-sky-700">{playerEditForm.balance.toLocaleString()} pt</strong></p>
                  </div>
                </div>
                <div className="px-6 pb-5 flex gap-3">
                  <button onClick={() => setPlayerEditModal(null)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all">ยกเลิก</button>
                  <button
                    disabled={playerEditSaving || !playerEditForm.name.trim()}
                    onClick={async () => {
                      setPlayerEditSaving(true);
                      const p = playerEditModal.player;
                      const nameChanged = playerEditForm.name.trim() !== p.name;
                      const balChanged = playerEditForm.balance !== p.balance;
                      try {
                        let lastData = null;
                        if (nameChanged) lastData = await runBackendFunction('adminUpdatePlayerName', [p.id, playerEditForm.name.trim()]);
                        if (balChanged) {
                          lastData = await runBackendFunction('adminSetPlayerBalance', [p.id, playerEditForm.balance, playerEditForm.name.trim()]);
                        }
                        if (!nameChanged && !balChanged) lastData = await runBackendFunction('getDashboardData', []);
                        
                        setPlayers(prev => deduplicatePlayersList(prev.map(pl => pl.id === p.id ? { ...pl, name: playerEditForm.name.trim(), balance: playerEditForm.balance } : pl)));
                        if (lastData && lastData.players) setPlayers(deduplicatePlayersList(lastData.players));
                        if (lastData && lastData.transactions) setTransactions(lastData.transactions);
                        setPlayerEditSaving(false);
                        setPlayerEditModal(null);
                        addToast(balChanged ? `ปรับเครดิต ${playerEditForm.name} เป็น ${playerEditForm.balance.toLocaleString()} pt (ส่ง DM เรียบร้อย)` : `อัปเดตข้อมูล ${p.name} สำเร็จ`, 'success');
                      } catch (err) {
                        setPlayerEditSaving(false);
                        addToast('' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
                  >
                    {playerEditSaving ? 'บันทึก...' : 'บันทึก'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── BANK EDIT MODAL ── */}
          {bankEditModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setBankEditModal(null); }}
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                {/* Modal Header */}
                <div 
                  className="bg-teal-700 bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-4"
                  style={{ backgroundColor: '#0f766e', color: '#ffffff' }}
                >
                  <h3 className="font-bold text-base" style={{ color: '#ffffff' }}>ลงทะเบียนบัญชีธนาคาร</h3>
                  <p className="text-xs mt-0.5" style={{ color: '#ccfbf1' }}>
                    {bankEditModal.player.name} · <span className="font-mono" style={{ color: '#99f6e4' }}>{bankEditModal.player.id.slice(0, 18)}…</span>
                  </p>
                </div>

                {/* Modal Body */}
                <div className="px-6 py-5 space-y-4">
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                    <strong>ตรวจสอบให้แน่ใจ:</strong> เลขบัญชีและชื่อบัญชีต้องตรงกับสลิปที่ผู้เล่นส่งมาเท่านั้น
                  </div>

                  {/* Bank name */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">ธนาคาร (Bank)</label>
                    <select
                      value={bankEditForm.bankName}
                      onChange={e => setBankEditForm(f => ({ ...f, bankName: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white"
                    >
                      <option value="">-- เลือกธนาคาร --</option>
                      {['SCB','KBANK','BBL','KTB','BAY','TMB','GSB','BAAC','CIMB','UOB','LH','TISCO','KKP','TCD'].map(b => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </div>

                  {/* Account number */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">เลขบัญชี (Account Number)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="เช่น 890-1-23456-7"
                      value={bankEditForm.bankAccount}
                      onChange={e => setBankEditForm(f => ({ ...f, bankAccount: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  </div>

                  {/* Account holder name */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">ชื่อเจ้าของบัญชี (Account Name)</label>
                    <input
                      type="text"
                      placeholder="เช่น Somchai Jongcharoen"
                      value={bankEditForm.accountName}
                      onChange={e => setBankEditForm(f => ({ ...f, accountName: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  </div>
                </div>

                {/* Modal Footer */}
                <div className="px-6 pb-5 flex gap-3">
                  <button
                    onClick={() => setBankEditModal(null)}
                    className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all"
                  >
                    ยกเลิก
                  </button>
                  <button
                    disabled={bankEditSaving || !bankEditForm.bankName || !bankEditForm.bankAccount || !bankEditForm.accountName}
                    onClick={async () => {
                      if (!bankEditForm.bankName || !bankEditForm.bankAccount || !bankEditForm.accountName) return;
                      setBankEditSaving(true);
                      const p = bankEditModal.player;
                      try {
                        const data = await runBackendFunction('adminSetPlayerBank', [p.id, bankEditForm.bankName, bankEditForm.bankAccount, bankEditForm.accountName]);
                        setPlayers(prev => deduplicatePlayersList(prev.map(pl =>
                          pl.id === p.id
                            ? { ...pl, bankName: bankEditForm.bankName, bankAccount: bankEditForm.bankAccount, accountName: bankEditForm.accountName }
                            : pl
                        )));
                        if (data && data.players) setPlayers(deduplicatePlayersList(data.players));
                        setBankEditSaving(false);
                        setBankEditModal(null);
                        addToast(`บันทึกบัญชีธนาคารของ ${p.name} สำเร็จ`, 'success');
                      } catch (err) {
                        setBankEditSaving(false);
                        addToast('เกิดข้อผิดพลาด:' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 text-white text-sm font-bold rounded-xl transition-all active:scale-95 disabled:cursor-not-allowed"
                    style={{ 
                      backgroundColor: (bankEditSaving || !bankEditForm.bankName || !bankEditForm.bankAccount || !bankEditForm.accountName) ? '#94a3b8' : '#0f766e', 
                      color: '#ffffff' 
                    }}
                  >
                    {bankEditSaving ? 'กำลังบันทึก...' : 'บันทึกบัญชี'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── CREATE PLAYER MODAL ── */}
          {createPlayerModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
              onClick={e => { if (e.target === e.currentTarget) setCreatePlayerModal(false); }}
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                <div 
                  className="bg-teal-700 bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-4"
                  style={{ backgroundColor: '#0f766e', color: '#ffffff' }}
                >
                  <h3 className="font-bold text-base" style={{ color: '#ffffff' }}>＋ เพิ่มผู้เล่นใหม่</h3>
                  <p className="text-xs mt-0.5" style={{ color: '#ccfbf1' }}>สร้างบัญชีผู้เล่นใหม่ในระบบ</p>
                </div>
                <div className="px-6 py-5 space-y-4">
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-xs">
                    <strong>วิธีหา LINE ID:</strong> ให้ผู้เล่นส่งข้อความมาใน LINE OA ก่อน แล้วดู ID ในหน้า LINE Chat ของแดชบอร์ดนี้
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">LINE User ID <span className="text-rose-500">*</span></label>
                    <input
                      type="text"
                      placeholder="U1234567890abcdef..."
                      value={createPlayerForm.lineId}
                      onChange={e => setCreatePlayerForm(f => ({ ...f, lineId: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">ชื่อผู้เล่น <span className="text-rose-500">*</span></label>
                    <input
                      type="text"
                      placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"
                      value={createPlayerForm.name}
                      onChange={e => setCreatePlayerForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 block">เครดิตเริ่มต้น (pt)</label>
                    <input
                      type="number"
                      min="0"
                      value={createPlayerForm.balance}
                      onChange={e => setCreatePlayerForm(f => ({ ...f, balance: Math.max(0, Number(e.target.value)) }))}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-400"
                    />
                  </div>
                </div>
                <div className="px-6 pb-5 flex gap-3">
                  <button onClick={() => setCreatePlayerModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all">ยกเลิก</button>
                  <button
                    disabled={createPlayerSaving || !createPlayerForm.lineId.trim() || !createPlayerForm.name.trim()}
                    onClick={async () => {
                      setCreatePlayerSaving(true);
                      const { lineId, name, balance } = createPlayerForm;
                      const avatars = ['🐉','🐯','🦅','🦁','🐻','🐼','🦊','🦉'];
                      try {
                        const data = await runBackendFunction('adminCreatePlayer', [lineId.trim(), name.trim(), balance]);
                        setPlayers(prev => deduplicatePlayersList([...prev, { id: lineId.trim(), name: name.trim(), balance, bankName: '', bankAccount: '', accountName: '', avatar: avatars[prev.length % avatars.length] }]));
                        if (data && data.players) setPlayers(deduplicatePlayersList(data.players));
                        setCreatePlayerSaving(false);
                        setCreatePlayerModal(false);
                        addToast(`สร้างบัญชี ${name} สำเร็จ`, 'success');
                      } catch (err) {
                        setCreatePlayerSaving(false);
                        addToast('' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 text-white text-sm font-bold rounded-xl transition-all active:scale-95 disabled:cursor-not-allowed"
                    style={{ 
                      backgroundColor: (createPlayerSaving || !createPlayerForm.lineId.trim() || !createPlayerForm.name.trim()) ? '#94a3b8' : '#0f766e', 
                      color: '#ffffff' 
                    }}
                  >
                    {createPlayerSaving ? 'กำลังสร้าง...' : 'สร้างบัญชี'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── DELETE CONFIRM MODAL ── */}
          {confirmDelete && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
              onClick={e => { if (e.target === e.currentTarget) setConfirmDelete(null); }}
            >
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
                <div className="bg-rose-600 px-6 py-4">
                  <h3 className="text-white font-bold text-base">ยืนยันการลบผู้เล่น</h3>
                </div>
                <div className="px-6 py-5 space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-rose-50 border border-rose-200 rounded-xl">
                    <span className="text-3xl">{confirmDelete.player.avatar}</span>
                    <div>
                      <div className="font-bold text-slate-800">{confirmDelete.player.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{confirmDelete.player.id}</div>
                      <div className="text-xs font-bold text-rose-600 mt-0.5">เครดิตคงเหลือ: {confirmDelete.player.balance.toLocaleString()} pt</div>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600">การลบนี้จะ<strong>ลบข้อมูลผู้เล่นทั้งหมด</strong>ออกจากฐานข้อมูลทันที และไม่สามารถกู้คืนได้</p>
                </div>
                <div className="px-6 pb-5 flex gap-3">
                  <button onClick={() => setConfirmDelete(null)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all">ยกเลิก</button>
                  <button
                    disabled={deleteSaving}
                    onClick={async () => {
                      setDeleteSaving(true);
                      const p = confirmDelete.player;
                      try {
                        const data = await runBackendFunction('adminDeletePlayer', [p.id]);
                        setPlayers(prev => deduplicatePlayersList(prev.filter(pl => pl.id !== p.id)));
                        if (data && data.players) setPlayers(deduplicatePlayersList(data.players));
                        setDeleteSaving(false);
                        setConfirmDelete(null);
                        addToast(`ลบบัญชี ${p.name} สำเร็จ`, 'info');
                      } catch (err) {
                        setDeleteSaving(false);
                        addToast('' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
                  >
                    {deleteSaving ? 'กำลังลบ...' : 'ยืนยันลบ'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── TRANSACTION DETAIL & SLIP PREVIEW MODAL ── */}
          {txDetailModal && (() => {
            const tx = txDetailModal;
            const isWithdrawal = tx.id.startsWith('WD') || 
              (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || 
              (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));

            return (
              <div 
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in font-sans"
                onClick={e => { if (e.target === e.currentTarget) setTxDetailModal(null); }}
              >
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-200 max-h-[90vh] flex flex-col">
                  {/* Modal Header */}
                  <div 
                    className={`px-6 py-4 flex items-center justify-between text-white ${isWithdrawal ? 'bg-rose-700 bg-gradient-to-r from-rose-600 to-red-700' : 'bg-teal-700 bg-gradient-to-r from-emerald-600 to-teal-700'}`}
                    style={{ backgroundColor: isWithdrawal ? '#be123c' : '#047857', color: '#ffffff' }}
                  >
                    <div>
                      <h3 className="font-extrabold text-base flex items-center gap-2" style={{ color: '#ffffff' }}>
                        {isWithdrawal ? 'รายละเอียดคำขอถอนเงิน' : 'รายละเอียดการแจ้งสลิปเติมเงิน'}
                        <span className="bg-white/20 px-2 py-0.5 rounded font-mono text-xs" style={{ color: '#ffffff' }}>{tx.id}</span>
                      </h3>
                      <p className="text-xs mt-0.5" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>ผู้เล่น: {tx.playerName} ({tx.playerId})</p>
                    </div>
                    <button 
                      onClick={() => setTxDetailModal(null)}
                      className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center font-bold transition-all"
                      style={{ color: '#ffffff' }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Modal Body */}
                  <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs text-slate-800">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Left: e-Slip Visual */}
                      <div className="flex justify-center shrink-0">
                        {isWithdrawal ? (
                          <div className="w-full max-w-xs h-[240px] bg-gradient-to-b from-rose-100 to-rose-200 border border-rose-300 rounded-2xl p-4 flex flex-col items-center justify-between text-center select-none shadow-sm">
                            <div className="text-4xl mt-2"></div>
                            <div className="space-y-1">
                              <span className="text-[10px] text-rose-800 font-black uppercase tracking-wider bg-rose-200 px-2 py-0.5 rounded-md">คำขอถอนเงิน</span>
                              <h4 className="text-2xl font-black text-rose-950 font-mono">-{tx.requestedAmount}.00 THB</h4>
                            </div>
                            <div className="w-full bg-white/90 border border-rose-300 rounded-lg p-2 text-[10px] text-rose-900 font-bold leading-normal font-sans shadow-2xs">
                              {tx.reviewReason.replace('Withdrawal request to ', '')}
                            </div>
                          </div>
                        ) : (
                          renderSlipCard(tx.presetId, true, (tx.requestedAmount && tx.requestedAmount > 0) ? tx.requestedAmount : (tx.actualAmount || 100))
                        )}
                      </div>

                      {/* Right: Key Info Grid */}
                      <div className="space-y-3 flex flex-col justify-between">
                        <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-2">
                          <div className="flex justify-between items-center border-b border-slate-200 pb-2">
                            <span className="text-slate-500 font-bold">สถานะทำรายการ:</span>
                            <span>
                              {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg font-bold">อนุมัติเรียบร้อย</span>}
                              {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg font-bold animate-pulse">รออนุมัติแมนนวล</span>}
                              {tx.status === 'rejected' && <span className="badge-high px-2 py-0.5 rounded-lg font-bold">✕ ปฏิเสธบิล</span>}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 font-mono pt-1">
                            <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                              <span className="text-[9px] text-slate-400 uppercase block font-sans font-bold">ยอดสั่งเติม:</span>
                              <span className="text-base font-black text-sky-800">{tx.requestedAmount}.00 THB</span>
                            </div>
                            <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                              <span className="text-[9px] text-slate-400 uppercase block font-sans font-bold">ยอดสแกนจริง:</span>
                              <span className="text-base font-black text-emerald-700">{tx.actualAmount}.00 THB</span>
                            </div>
                          </div>

                          <div className="space-y-1 font-mono text-[11px] pt-1">
                            <div><span className="text-slate-400 font-sans">เลขอ้างอิง Ref:</span> <strong className="text-slate-900">{tx.slipRef || 'N/A'}</strong></div>
                            <div><span className="text-slate-400 font-sans">เวลาทำรายการ:</span> <strong className="text-slate-900">{tx.timestamp}</strong></div>
                            <div><span className="text-slate-400 font-sans">สาเหตุ / หมายเหตุ:</span> <strong className="text-rose-700">{tx.reviewReason}</strong></div>
                          </div>
                        </div>

                        {/* OCR Logs */}
                        {tx.logs && tx.logs.length > 0 && (
                          <div className="p-3 bg-slate-900 text-slate-200 rounded-xl text-[10px] font-mono space-y-1 max-h-[100px] overflow-y-auto">
                            <span className="text-emerald-400 font-bold block font-sans">Scan Analysis Logs:</span>
                            {tx.logs.map((l, i) => (
                              <div key={i}>{l}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Modal Footer */}
                  <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center gap-3">
                    <button 
                      onClick={() => setTxDetailModal(null)}
                      className="px-4 py-2 border border-slate-300 rounded-xl text-slate-700 font-bold text-xs hover:bg-slate-100 transition-all"
                    >
                      ปิดหน้าต่าง
                    </button>
                    {tx.status === 'escalated' && (
                      <div className="flex gap-2">
                        <button 
                          onClick={() => { handleAdminRejectReview(tx.id, isWithdrawal ? 'ปฏิเสธคำขอและส่งแต้มคืนเข้าบัญชี' : 'ปฏิเสธเนื่องจากไม่มียอดโอนจริง'); setTxDetailModal(null); }}
                          className="px-4 py-2 bg-rose-50 border border-rose-200 hover:bg-rose-600 text-rose-700 hover:text-white rounded-xl text-xs font-bold transition-all"
                        >
                          ✕ ปฏิเสธรายการ
                        </button>
                        <button 
                          onClick={() => { handleAdminApproveReview(tx.id); setTxDetailModal(null); }}
                          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black shadow-md transition-all active:scale-95"
                        >
                          ยืนยันอนุมัติ ({isWithdrawal ? tx.requestedAmount : (tx.actualAmount || tx.requestedAmount)} THB)
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          </div>
        </main>
      </div>

      {/* Dynamic Settle Outcome Result Report Popup Overlay Modal - Cloud PMS Style */}
      {settlementResult && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-[99999] p-4 font-sans">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 max-w-md w-full text-slate-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="text-center space-y-2">
              <div className="w-12 h-12 bg-sky-50 text-sky-600 rounded-xl flex items-center justify-center mx-auto border border-sky-100">
                <Cloud size={28} />
              </div>
              <h3 className="text-lg font-black text-slate-900 font-heading">
                สรุปผลการจับเวลาบั้งไฟ ({settlementResult.rocketName || 'ค่ายบั้งไฟ'})
              </h3>
              <p className="text-xs text-slate-500">ผลการบินเปรียบเทียบเกณฑ์เส้นแบ่งราคาช่าง (Bang Fai Commander)</p>
            </div>
            
            <div className="grid grid-cols-2 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-100 text-center font-mono">
              <div className="space-y-0.5">
                <span className="text-[10px] text-slate-500 uppercase block font-sans">เวลาบินจริง</span>
                <span className="text-2xl font-black text-slate-800 font-mono">{(settlementResult.finalTime || 0).toFixed(2)}s</span>
              </div>
              <div className="border-l border-slate-200 space-y-0.5">
                <span className="text-[10px] text-slate-500 uppercase block font-sans">ช่วงราคาช่าง</span>
                <span className="text-lg font-black text-amber-700 font-mono">
                  {settlementResult.targetMin || 330} - {settlementResult.targetMax || 380}s
                </span>
              </div>
            </div>

            <div className={`p-3 rounded-xl border text-center font-bold text-sm ${
              settlementResult.outcome === 'LOW' 
                ? 'bg-sky-50 border-sky-200 text-sky-700' 
                : settlementResult.outcome === 'HIGH'
                ? 'bg-rose-50 border-rose-200 text-rose-700'
                : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              ผลตัดสินฝั่งชนะ: {
                settlementResult.outcome === 'LOW' 
                  ? 'ต่ำ (LOW)' 
                  : settlementResult.outcome === 'HIGH' 
                  ? 'สูง (HIGH)' 
                  : 'ในราคาช่าง (RANGE) '
              }
            </div>

            <div className="space-y-2">
              <span className="text-xs font-bold text-slate-600 block">บิลที่ได้รับการชำระรางวัล ({(settlementResult.payouts || []).length}):</span>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {(!settlementResult.payouts || settlementResult.payouts.length === 0) ? (
                  <p className="text-xs text-slate-400 italic text-center py-2">ไม่มีแผลจับคู่ในรอบนี้</p>
                ) : (
                  settlementResult.payouts.map(p => (
                    <div key={p.orderNumber} className="flex justify-between items-center text-xs p-2 bg-slate-50 border border-slate-100 rounded-lg">
                      <span className="font-mono font-bold text-slate-700">Order #{p.orderNumber}</span>
                      <span className="text-slate-600 font-bold">{p.winnerName ? p.winnerName.split(' ')[0] : 'ผู้ชนะ'} Win</span>
                      <span className="font-mono font-bold text-emerald-600">+{p.payout} pt</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <button
              onClick={() => {
                setSettlementResult(null);
              }}
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <CheckCircle size={14} />
              ปิดหน้าต่างและเริ่มรอบใหม่
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// -------------------------------------------------------------
// SECURE PLAYER STATEMENT CONSOLE
// -------------------------------------------------------------
function PlayerDashboard({ player, transactions, bets, playerUserId, players }) {
  const [activeTab, setActiveTab] = useState('statement'); // 'statement' | 'bets'

  return (
    <div className="w-full max-w-4xl min-h-screen p-4 md:p-6 flex flex-col font-sans text-slate-800 bg-slate-50">
      {/* Brand Header - Cloud PMS Style */}
      <header className="mb-6 flex justify-between items-center border-b border-slate-200 pb-4 bg-white p-4 rounded-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-600 flex items-center justify-center text-white">
            <Cloud size={20} />
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-900 uppercase font-heading">
              Bang Fai Commander
            </h1>
            <p className="text-[10px] text-slate-500">ระบบตรวจสอบรายการเดินบัญชีผู้เล่นรายบุคคล (Player Statement Console)</p>
          </div>
        </div>
        <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-sky-50 text-sky-700 border border-sky-200">
          Player View
        </span>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-grow">
        {/* Left Card: Account Summary */}
        <div className="md:col-span-1 space-y-4">
          <div className="p-5 bg-gradient-to-br from-sky-700 to-sky-900 text-white rounded-xl border border-sky-800">
            <span className="text-[10px] uppercase font-bold tracking-wider opacity-80 block">เครดิตทั้งหมด (Balance)</span>
            <span className="text-3xl font-black mt-2 block font-mono">
              {player.balance.toLocaleString('th-TH', { minimumFractionDigits: 2 })} <span className="text-sm font-bold opacity-80">แต้ม</span>
            </span>
            <div className="mt-4 pt-4 border-t border-white/10 space-y-2 text-xs font-sans">
              <div className="flex justify-between">
                <span className="opacity-80">ชื่อผู้เล่น:</span>
                <span className="font-bold">{player.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-80">LINE ID:</span>
                <span className="font-mono">{playerUserId}</span>
              </div>
            </div>
          </div>

          <div className="bg-white p-5 rounded-xl border border-slate-200 space-y-3">
            <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest border-b border-slate-100 pb-2">ข้อมูลธนาคารรับเงินโอนคืน</h3>
            <div className="space-y-2 text-xs font-semibold">
              <div>
                <span className="text-slate-400 block text-[10px]">ธนาคาร:</span>
                <span className="font-bold text-slate-700">{player.bankName || '-'}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">เลขที่บัญชี:</span>
                <span className="font-mono font-bold text-slate-700">{player.bankAccount || '-'}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">ชื่อบัญชี:</span>
                <span className="font-bold text-slate-700">{player.accountName || '-'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Area: Tabs and details */}
        <div className="md:col-span-2 flex flex-col bg-white rounded-xl border border-slate-200 overflow-hidden h-[600px]">
          {/* Tab switches */}
          <div className="flex border-b border-slate-200 bg-slate-50 text-xs font-bold text-slate-500">
            <button
              onClick={() => setActiveTab('statement')}
              className={`flex-1 py-3 border-b-2 text-center transition-all cursor-pointer ${
                activeTab === 'statement' ? 'border-sky-600 text-sky-700 bg-white font-black' : 'border-transparent hover:text-slate-700'
              }`}
            >
              ประวัติการเงิน ({transactions.length})
            </button>
            <button
              onClick={() => setActiveTab('bets')}
              className={`flex-1 py-3 border-b-2 text-center transition-all cursor-pointer ${
                activeTab === 'bets' ? 'border-sky-600 text-sky-700 bg-white font-black' : 'border-transparent hover:text-slate-700'
              }`}
            >
              รายการดวลบั้งไฟ ({bets.length})
            </button>
          </div>

          {/* Tab Content Panel */}
          <div className="p-4 flex-grow overflow-y-auto min-h-0 bg-white">
            {activeTab === 'statement' && (
              <div className="space-y-3">
                {transactions.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 text-xs italic">ไม่มีประวัติการทำรายการโอนเงิน</div>
                ) : (
                  transactions.slice().reverse().map(t => {
                    const isWithdrawal = t.id.startsWith('WD');
                    const amountVal = isWithdrawal ? t.requestedAmount : t.actualAmount;
                    const amountText = (isWithdrawal ? '-' : '+') + amountVal.toLocaleString();
                    return (
                      <div key={t.id} className="p-3.5 border border-slate-100 rounded-xl flex items-center justify-between hover:border-slate-200 transition-all font-sans">
                        <div className="space-y-1">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            !isWithdrawal ? 'bg-sky-50 text-sky-700 border border-sky-100' : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}>
                            {!isWithdrawal ? 'ฝากเงิน' : 'ถอนเงิน'}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 block mt-1">Ref: {t.slipRef || '-'}</span>
                          <span className="text-[9px] text-slate-400 block">{t.timestamp}</span>
                        </div>
                        <div className="text-right space-y-1.5">
                          <span className={`text-sm font-black font-mono block ${!isWithdrawal ? 'text-sky-600' : 'text-slate-600'}`}>
                            {amountText} บาท
                          </span>
                          <span className={`text-[9.5px] px-2 py-0.5 rounded-md font-bold uppercase block w-max ml-auto ${
                            t.status === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                            t.status === 'escalated' ? 'bg-amber-50 text-amber-700 border border-amber-100' :
                            t.status === 'rejected' ? 'bg-rose-50 text-rose-700 border border-rose-100' :
                            'bg-slate-50 text-slate-500'
                          }`}>
                            {t.status === 'success' ? 'สแกนผ่าน' :
                             t.status === 'escalated' ? 'รอรีวิวมือ' :
                             t.status === 'rejected' ? 'ปฏิเสธ' : t.status}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {activeTab === 'bets' && (
              <div className="space-y-3">
                {bets.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 text-xs italic font-sans">ไม่มีประวัติการส่งข้อมูลดวลเวลาบั้งไฟ</div>
                ) : (
                  bets.slice().reverse().map(b => {
                    const isOrderLow = b.side === 'low';
                    const lowId = b.playerLowId || (isOrderLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
                    const isLow = lowId === playerUserId || (isOrderLow && (b.creatorId === playerUserId || b.creatorLineUserId === playerUserId));
                    const sideText = isLow ? 'ต่ำ (LOW)' : 'สูง (HIGH)';
                    const lowName = b.playerLowName || (isOrderLow ? b.creatorName : b.matcherName);
                    const highName = b.playerHighName || (!isOrderLow ? b.creatorName : b.matcherName);
                    const opponentText = isLow ? highName : lowName;
                    const opponentId = isLow 
                      ? (b.playerHighId || (!isOrderLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId)))
                      : (b.playerLowId || (isOrderLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId)));
                    
                    let payoutBadge = 'รอจับคู่';
                    let payoutColor = 'bg-slate-100 text-slate-500 border border-slate-200';
                    
                    if (b.status === 'resolved') {
                      if (b.winnerName) {
                        const myName = players.find(p => p.id === playerUserId)?.name || '';
                        const won = b.winnerName.split(' ')[0] === myName.split(' ')[0];
                        payoutBadge = won ? 'ชนะ' : 'แพ้';
                        payoutColor = won ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100';
                      } else {
                        payoutBadge = 'จบแล้ว';
                        payoutColor = 'bg-slate-100 text-slate-600';
                      }
                    } else if (b.status === 'matched') {
                      payoutBadge = 'จับคู่แล้ว';
                      payoutColor = 'bg-sky-50 text-sky-700 border border-sky-100';
                    }

                    return (
                      <div key={b.id} className="p-3.5 border border-slate-100 rounded-xl space-y-2 hover:border-slate-200 transition-all font-sans">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-mono font-bold text-slate-700">Order #{b.orderNumber}</span>
                          <span className={`text-[9.5px] px-2 py-0.5 rounded-md font-bold ${payoutColor}`}>
                            {payoutBadge}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs font-semibold">
                          <div>
                            <span className="text-slate-400 text-[9px] block">คุณเลือก:</span>
                            <span className={`font-bold ${isLow ? 'text-sky-600' : 'text-rose-600'}`}>{sideText}</span>
                          </div>
                          <div>
                            <span className="text-slate-400 text-[9px] block">ยอดเดิมพัน:</span>
                            <span className="font-mono text-slate-700">{b.amount} แต้ม</span>
                          </div>
                          <div className="text-right">
                            <span className="text-slate-400 text-[9px] block">วันเวลา:</span>
                            <span className="text-[10px] text-slate-500 font-mono">{b.timestamp.split(' ')[1] || b.timestamp}</span>
                          </div>
                        </div>
                        {opponentText && (
                          <div className="text-[10px] text-slate-500 pt-1.5 border-t border-slate-50 flex justify-between font-sans">
                            <span>
                              คู่ดวล: <strong className="text-slate-700">{opponentText}</strong>
                              {opponentId && <span className="ml-1 text-[9px] px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-slate-500 font-mono">ID: {opponentId}</span>}
                            </span>
                            {b.finalTime !== undefined && (
                              <span>เวลาบั้งไฟ: <strong className="text-slate-700">{b.finalTime}s</strong></span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// ADMIN LOCK SCREEN (Imported from ./AdminLockScreen.jsx)
// -------------------------------------------------------------
