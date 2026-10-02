import { useState, useEffect, useRef } from 'react';
import AdminLockScreen from './AdminLockScreen.jsx';
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
  User,
  FileText,
  RefreshCw,
  TrendingUp,
  RotateCcw,
  ShieldCheck,
  Zap,
  Info,
  Wallet,
  ShieldAlert,
  Trophy,
  Search,
  Radio,
  Megaphone,
  LogOut,
  Cloud
} from 'lucide-react';

const INITIAL_PLAYERS = [];

// Presets for the Slip Upload Simulator
const SLIP_PRESETS = [
  {
    id: 'preset_valid_100',
    name: 'KBANK 100 THB (Match)',
    bankLogo: '🟢',
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
    bankLogo: '🟣',
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
    bankLogo: '🔵',
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
    bankLogo: '🟢',
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
    bankLogo: '🔷',
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

const SUPER_ADMIN_USERNAME = import.meta.env.VITE_SUPER_ADMIN_USERNAME || import.meta.env.VITE_ADMIN_USERNAME || 'Admin';
const SUPER_ADMIN_PASSWORD = import.meta.env.VITE_SUPER_ADMIN_PASSWORD || import.meta.env.VITE_ADMIN_PASSWORD || import.meta.env.VITE_ADMIN_PASSCODE || 'P@ssW0rd2026';
const SUPER_ADMIN_PASSCODE = import.meta.env.VITE_ADMIN_PASSCODE || 'P@ssW0rd2026';

const LIMITED_ADMIN_USERNAME = import.meta.env.VITE_LIMITED_ADMIN_USERNAME || import.meta.env.VITE_ADMIN1_USERNAME || 'Admin1';
const LIMITED_ADMIN_PASSWORD = import.meta.env.VITE_LIMITED_ADMIN_PASSWORD || import.meta.env.VITE_ADMIN1_PASSWORD || 'Admin@2026';

const ADMIN_USERNAME = SUPER_ADMIN_USERNAME;
const ADMIN_PASSWORD = SUPER_ADMIN_PASSWORD;
const ADMIN_PASSCODE = SUPER_ADMIN_PASSCODE;

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
  const getAdminApiKey = () => {
    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('rocket_admin_key') || localStorage.getItem('rocket_admin_key');
      if (stored) return stored;
    }
    return 'urkDQHE2Mm8Q4oqhS_1ftZV0EqWT-cAT';
  };
  const ADMIN_API_KEY = getAdminApiKey();

  const runBackendFunction = async (functionName, args = []) => {
    const targetBase = API_BASE_URL || CF_WORKER_BASE_URL;
    const targetUrl = `${targetBase}/api/run`;
    const apiKey = getAdminApiKey();
    const headers = {
      'Content-Type': 'application/json',
      'x-admin-key': apiKey,
      'x-admin-api-key': apiKey,
    };

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ functionName, args, adminKey: apiKey, apiKey, adminRole }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(res.status === 404 ? 'ไม่พบ API Endpoint' : 'ระบบขัดข้อง');
      }

      const json = await res.json();
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
            runner.executeAdminAction(functionName, args, apiKey);
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

  const handleAdminLogout = () => {
    if (window.confirm('🔒 คุณต้องการออกจากระบบแอดมินใช่หรือไม่?')) {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('rocket_admin_auth');
        sessionStorage.removeItem('rocket_admin_user');
        sessionStorage.removeItem('rocket_admin_key');
        sessionStorage.removeItem('rocket_admin_role');
      }
      setAdminAuthenticated(false);
      setAdminRole('admin');
      setPasswordInput('');
      addToast('🔒 ออกจากระบบเรียบร้อย', 'info');
    }
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
  const [adminTab, setAdminTab] = useState('quote'); // 'quote' | 'settle' | 'bets' | 'review' | 'players' | 'logs' | 'broadcast'
  const [customBroadcastText, setCustomBroadcastText] = useState('');
  const [isSendingBroadcast, setIsSendingBroadcast] = useState(false);
  const [betStatusFilter, setBetStatusFilter] = useState('all'); // 'all' | 'matched' | 'pending_match' | 'cancelled' | 'resolved'
  const [betSearchQuery, setBetSearchQuery] = useState('');
  const [toasts, setToasts] = useState([]);

  // Transaction filtering & search & detail modal states
  const [txSearchQuery, setTxSearchQuery] = useState('');
  const [txStatusFilter, setTxStatusFilter] = useState('all'); // 'all' | 'escalated' | 'success' | 'rejected'
  const [txTypeFilter, setTxTypeFilter] = useState('all'); // 'all' | 'deposit' | 'withdrawal'
  const [txDetailModal, setTxDetailModal] = useState(null);

  // Player bank edit modal state
  const [bankEditModal, setBankEditModal] = useState(null);
  const [bankEditForm, setBankEditForm] = useState({ bankName: '', bankAccount: '', accountName: '' });
  const [bankEditSaving, setBankEditSaving] = useState(false);

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
  const [quoteBetAmount, setQuoteBetAmount] = useState(''); // Bet Amount (entered manually by admin)
  const [quoteIsChotoy, setQuoteIsChotoy] = useState(false);

  const handleBroadcastFastQuote = async (overrideMin = null, overrideMax = null, overrideChotoy = null) => {
    const min = overrideMin !== null ? overrideMin : targetMin;
    const max = overrideMax !== null ? overrideMax : targetMax;
    const isChotoy = overrideChotoy !== null ? overrideChotoy : quoteIsChotoy;
    const name = rocketName.trim() || 'ช่างบั้งไฟสด';

    if (!min || !max || Number(min) >= Number(max)) {
      addToast('⚠️ กรุณากรอกช่วงราคาช่างให้ถูกต้อง (Min ต้องน้อยกว่า Max) ก่อนประกาศออกราคาครับ', 'warning');
      return;
    }

    try {
      const res = await runBackendFunction('adminBroadcastQuote', [broadcastTargetGroup || 'ALL', name, min, max, isChotoy]);
      if (res && res.success === false) {
        addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
      } else {
        addToast(`🚀 ประกาศราคาสำเร็จ (${min}-${max}s)`, 'success');
      }
    } catch {
      addToast('❌ ส่งไม่สำเร็จ', 'danger');
    }
  };
  const [customRocketTime, setCustomRocketTime] = useState(''); // Manual entry by admin (blank default)
  const [flightLogs, setFlightLogs] = useState([]);
  const [settlementResult, setSettlementResult] = useState(null); // Settle results popup summary
  const [activeGroupId, setActiveGroupId] = useState(null); // Active connected LINE Group ID
  const [lineGroups, setLineGroups] = useState([]); // List of active connected LINE Groups
  const [broadcastTargetGroup, setBroadcastTargetGroup] = useState('ALL'); // Multi-group broadcast target

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
      if (data.activeGroupId !== undefined) setActiveGroupId(data.activeGroupId);
      if (data.lineGroups && data.lineGroups.length > 0) {
        setLineGroups(data.lineGroups);
      } else if (data.activeGroupId) {
        setLineGroups([{ id: data.activeGroupId, name: `🚀 กลุ่มดวลสด LINE (#${data.activeGroupId.slice(-4)})`, lastMessage: 'เชื่อมต่อสำเร็จ', timestamp: 'Live' }]);
      } else if (Array.isArray(data.lineGroups)) {
        setLineGroups([]);
      }
      if (data.activeRound) {
        if (data.activeRound.name) setRocketName(prev => (!prev || prev === 'ช่างบั้งไฟสด') ? data.activeRound.name : prev);
        if (data.activeRound.targetMin) setTargetMin(prev => (!prev ? String(data.activeRound.targetMin) : prev));
        if (data.activeRound.targetMax) setTargetMax(prev => (!prev ? String(data.activeRound.targetMax) : prev));
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

    const fetchFromBackend = async () => {
      try {
        const apiKey = ADMIN_API_KEY || 'urkDQHE2Mm8Q4oqhS_1ftZV0EqWT-cAT';
        const res = await fetch(`${targetUrl}/api/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-admin-key': apiKey, 'x-admin-api-key': apiKey } : {}),
          },
          body: JSON.stringify({ functionName: 'getDashboardData', adminKey: apiKey, apiKey }),
        });
        if (res.ok) {
          const json = await res.json();
          const payload = json?.data || json?.result || json;
          if (payload && (payload.players || payload.activeRound || payload.bets)) {
            applyData(payload);
            return;
          }
        }
      } catch {
        // Fallback to GAS RPC only if network fetch to Worker fails and in GAS
        if (isGAS && typeof window !== 'undefined' && window.google?.script?.run) {
          const gas = window.google.script.run;
          if (typeof gas.getDashboardData === 'function') {
            gas.withSuccessHandler(applyData).getDashboardData();
          }
        }
      }
    };

    // ── Sub-Second Responsive Polling Loop ──
    // 600ms when tab is active (instant real-time sync with LINE Group orders).
    // 3000ms when tab is hidden.
    const pollLoop = async () => {
      while (!cancelled) {
        await fetchFromBackend();
        const delay = (typeof document !== 'undefined' && document.hidden) ? 3000 : 600;
        await new Promise((r) => setTimeout(r, delay));
      }
    };

    pollLoop();

    // Trigger immediate poll when admin refocuses tab or becomes visible
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !cancelled) {
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
  }, [isGAS, isLiveBackend, isGitHubPages, ADMIN_API_KEY, API_BASE_URL, adminAuthenticated, playerUserId]);

  // Toast Notification manager
  const addToast = (msg, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Safe portal close & reset function (preserves player data & transaction history)
  const handleClosePortal = () => {
    const activeMatched = bets.filter(b => b.status === 'matched');
    if (activeMatched.length > 0) {
      addToast(`⚠️ ไม่สามารถปิดรอบพอร์ทัลได้ เนื่องจากยังมีแผลดวลจับคู่สดค้างอยู่ ${activeMatched.length} แผล! กรุณาชำระแต้มก่อนปิดครับ`, 'danger');
      return;
    }

    if (!window.confirm("🔒 คุณต้องการปิดและรีเซ็ตพอร์ทัลรอบปัจจุบันใช่หรือไม่?\n\n(ระบบจะเคลียร์สถานะเวลาบินและสรุปผลรอบนี้ โดยจะไม่ลบข้อมูลผู้เล่น ยอดเครดิตคงเหลือ หรือประวัติธุรกรรมใดๆ ทั้งสิ้น)")) {
      return;
    }
    
    setSettlementResult(null);
    setRocketName('');
    addToast('🔒 ปิดและรีเซ็ตพอร์ทัลรอบปัจจุบันเรียบร้อย (รักษาข้อมูลผู้เล่นและธุรกรรมครบถ้วน 100%)', 'info');
  };

  // Expose reset state for debug button (preventing reference error)
  const resetConsoleState = async () => {
    if (adminRole !== 'superadmin') {
      addToast('⛔ สิทธิ์ไม่เพียงพอ: บัญชีผู้ดูแลนี้ไม่มีสิทธิ์ล้างระเบียนข้อมูลระบบ (เฉพาะ Super Admin เท่านั้น)', 'danger');
      return;
    }

    if (!window.confirm("⚠️ คุณต้องการล้างระเบียนข้อมูลระบบทั้งหมดใช่หรือไม่?\n\nการกระทำนี้จะล้างข้อมูลผู้เล่น ธุรกรรม ประวัติการเดิมพัน และบันทึกแชททั้งหมดในฐานข้อมูล ให้กลับสู่ค่าเริ่มต้น\n(การกระทำนี้ต้องได้รับสิทธิ์จาก Super Admin)")) {
      return;
    }
    
    setSettlementResult(null);

    try {
      addToast('⏳ กำลังล้างระเบียนข้อมูลระบบ (Factory Reset)...', 'info');
      const data = await runBackendFunction('resetGoogleSheetsDatabase', []);
      if (data) {
        if (data.players) setPlayers(deduplicatePlayersList(data.players));
        if (data.transactions) setTransactions(data.transactions);
        if (data.bets) setBets(data.bets);
      } else {
        setPlayers(INITIAL_PLAYERS);
        setTransactions([]);
        setBets([]);
      }
      try {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('rocket_sci_dashboard_cache');
        }
      } catch {
        // ignore cache removal error
      }
      addToast('✅ ล้างระเบียนข้อมูลระบบ (Factory Reset) สำเร็จแล้ว', 'success');
    } catch (err) {
      console.error("Failed to reset database:", err);
      addToast('เกิดข้อผิดพลาดในการล้างระเบียนระบบ: ' + (err.message || err), 'error');
    }
  };

  const forceSyncFreshData = async () => {
    addToast('⏳ กำลังดึงข้อมูลล่าสุดจากฐานข้อมูล...', 'info');
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('rocket_sci_dashboard_cache');
      }
      const d = await runBackendFunction('getDashboardData', []);
      if (d) {
        if (Array.isArray(d.players)) setPlayers(deduplicatePlayersList(d.players));
        if (Array.isArray(d.transactions)) setTransactions(d.transactions);
        if (Array.isArray(d.bets)) setBets(d.bets);
        if (d.activeGroupId !== undefined) setActiveGroupId(d.activeGroupId);
        if (d.lineGroups) setLineGroups(d.lineGroups);
        if (typeof window !== 'undefined') {
          localStorage.setItem('rocket_sci_dashboard_cache', JSON.stringify(d));
        }
        addToast('✅ ดึงข้อมูลสดสำเร็จ', 'success');
      }
    } catch (e) {
      console.error('[Force Sync Error]:', e);
      addToast('❌ ไม่สามารถดึงข้อมูลสดได้', 'error');
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
  const handleRequestCancelBet = (betId) => {
    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          addToast('ขอยกเลิกแผลสดในฐานข้อมูลสำเร็จ รอคู่ตอบรับ...', 'info');
        })
        .adminRequestCancelBet(betId);
    } else {
      // Sandbox cancel
      const bet = bets.find(b => b.id === betId);
      if (bet) {
        setBets(prev => prev.map(b => b.id === betId ? { ...b, status: 'pending_cancel' } : b));
        
        // Auto approve cancel after 3s
        setTimeout(() => {
          const refundAmount = bet.amount;
          setPlayers(prev => prev.map(p => {
            if (p.id === bet.playerLowId || p.id === bet.playerHighId) {
              return { ...p, balance: p.balance + refundAmount };
            }
            return p;
          }));
          setBets(prev => prev.map(b => b.id === betId ? { ...b, status: 'cancelled' } : b));
          addToast(`ขอยกเลิกแผลสำเร็จ! คืนเครดิตเข้ายอดเรียบร้อย (Order #${bet.orderNumber})`, 'info');
        }, 3000);
      }
    }
  };

  // Admin Manual Slip Reviews
  const handleAdminApproveReview = (txId) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('⚠️ รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }
    const approvedAmount = (targetTx.actualAmount && targetTx.actualAmount > 0) ? targetTx.actualAmount : (targetTx.requestedAmount || 0);

    // 🚀 OPTIMISTIC UPDATE: Update React State Instantly (0ms response time for admin!)
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'success', actualAmount: approvedAmount, reviewReason: 'Manually approved by admin' } : t));
    if (!txId.startsWith('WD')) {
      setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + approvedAmount } : p));
    }
    addToast(txId.startsWith('WD') ? `แอดมินอนุมัติคำขอถอนเงินยอด ${targetTx.requestedAmount} THB โอนเงินแล้วเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)` : `แอดมินอนุมัติเครดิตเติมเงินยอด ${approvedAmount} THB แมนนวลเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'success');

    // Run backend in background
    if (isGAS) {
      window.google.script.run
        .withFailureHandler((err) => {
          console.error('[GAS Approve Error]:', err);
          // Rollback on failure
          setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
          if (!txId.startsWith('WD')) {
            setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - approvedAmount } : p));
          }
          addToast('❌ เกิดข้อผิดพลาดในการบันทึกหลังบ้าน กรุณาลองใหม่อีกครั้ง', 'error');
        })
        .adminApproveTransaction(txId);
    } else {
      runBackendFunction('adminApproveTransaction', [txId]).catch(err => {
        console.error('[Background Approve Error]:', err);
        // Rollback on failure
        setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
        if (!txId.startsWith('WD')) {
          setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - approvedAmount } : p));
        }
        addToast('❌ เกิดข้อผิดพลาดในการบันทึกหลังบ้าน กรุณาลองใหม่อีกครั้ง', 'error');
      });
    }
  };

  const handleAdminRejectReview = (txId, reason) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('⚠️ รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }

    // 🚀 OPTIMISTIC UPDATE: Update React State Instantly (0ms response time for admin!)
    setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'rejected', reviewReason: reason } : t));
    if (txId.startsWith('WD')) {
      setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + targetTx.requestedAmount } : p));
      addToast(`ปฏิเสธคำขอถอนเงินยอด ${targetTx.requestedAmount} THB และคืนเครดิตให้ผู้เล่นเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'info');
    } else {
      addToast('ปฏิเสธการโอนสลิปเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)', 'info');
    }

    // Run backend in background
    if (isGAS) {
      window.google.script.run
        .withFailureHandler((err) => {
          console.error('[GAS Reject Error]:', err);
          // Rollback on failure
          setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
          if (txId.startsWith('WD')) {
            setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - targetTx.requestedAmount } : p));
          }
          addToast('❌ เกิดข้อผิดพลาดในการบันทึกหลังบ้าน กรุณาลองใหม่อีกครั้ง', 'error');
        })
        .adminRejectTransaction(txId, reason);
    } else {
      runBackendFunction('adminRejectTransaction', [txId, reason]).catch(err => {
        console.error('[Background Reject Error]:', err);
        // Rollback on failure
        setTransactions(prev => prev.map(t => t.id === txId ? targetTx : t));
        if (txId.startsWith('WD')) {
          setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) - targetTx.requestedAmount } : p));
        }
        addToast('❌ เกิดข้อผิดพลาดในการบันทึกหลังบ้าน กรุณาลองใหม่อีกครั้ง', 'error');
      });
    }
  };

  // Submit manual telemetry flight result (No flight animation, resolve immediately)
  const handleSubmitOnsiteResult = (finalTime) => {
    if (!finalTime || finalTime <= 0) {
      addToast('⚠️ กรุณาระบุเวลาผลการบินของบั้งไฟให้ถูกต้อง', 'warning');
      return;
    }

    if (!targetMin || !targetMax || Number(targetMin) >= Number(targetMax)) {
      addToast('⚠️ กรุณาระบุช่วงราคาช่าง (Min ต้องน้อยกว่า Max) ก่อนชำระแต้มครับ', 'warning');
      return;
    }

    const activeMatched = bets.filter(b => b.status === 'matched');
    if (activeMatched.length === 0) {
      addToast('⚠️ ไม่พบแผลดวลที่จับคู่สำเร็จ (Matched Bets = 0) ในรอบนี้! ระบบไม่สามารถชำระแต้มได้', 'warning');
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

    setFlightLogs(prev => [`💥 Telemetry link settled. Final Air Time: ${finalTime}s.`, ...prev]);

    // Calculate payouts details from currently matched bets for the popup modal
    const previouslyMatched = bets.filter(b => b.status === 'matched');
    const payouts = previouslyMatched.map(b => {
      let isLowWinner;
      const minSec = (b.type === 'range' && b.rangeMin !== null && b.rangeMax !== null) ? Number(b.rangeMin) : tMin;
      const maxSec = (b.type === 'range' && b.rangeMin !== null && b.rangeMax !== null) ? Number(b.rangeMax) : tMax;

      if (timeSec < minSec) {
        isLowWinner = true;
      } else if (timeSec > maxSec) {
        isLowWinner = false;
      } else {
        const midPoint = (minSec + maxSec) / 2;
        isLowWinner = timeSec <= midPoint;
      }
      const isLowOrder = b.side === 'low';
      const lowWinnerName = b.playerLowName || (isLowOrder ? b.creatorName : b.matcherName) || 'ฝั่งต่ำ';
      const highWinnerName = b.playerHighName || (!isLowOrder ? b.creatorName : b.matcherName) || 'ฝั่งสูง';
      const winnerName = isLowWinner ? lowWinnerName : highWinnerName;
      return {
        orderNumber: b.orderNumber,
        winnerName: winnerName,
        amount: b.amount,
        payout: Math.round(b.amount * 1.90)
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
      if (data) {
        if (data.bets) setBets(data.bets);
        if (data.players) setPlayers(deduplicatePlayersList(data.players));
        if (data.transactions) setTransactions(data.transactions);
      }
      addToast(`🚀 เคลียร์ผลรางวัลรอบ [${name}] เวลา ${finalTime}s (ช่วง ${tMin}-${tMax}s) และบรอดแคสต์ลงกลุ่มเรียบร้อย!`, 'success');
    } catch (e) {
      console.error('Settlement backend error:', e);
      addToast(`❌ เกิดข้อผิดพลาดในการบันทึกผลการตัดสิน: ${e?.message || 'ระบบหลังบ้านไม่ตอบสนอง'}`, 'error');
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
        bankLogo: '🟣',
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
        bankLogo: '🟢',
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
              <span>สถานะ QR: {p.isValidQR ? '✅ มีรหัสตรวจพบ' : '❌ ไม่มี/เสียหาย'}</span>
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

  if (!adminAuthenticated) {
    return (
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
        adminPassword={SUPER_ADMIN_PASSWORD}
        adminPasscode={SUPER_ADMIN_PASSCODE}
        admin1Username={LIMITED_ADMIN_USERNAME}
        admin1Password={LIMITED_ADMIN_PASSWORD}
        runBackendFunction={runBackendFunction}
      />
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center">
      {/* Toast Manager */}
      <div className="fixed top-4 right-4 z-[999999] flex flex-col gap-2 max-w-sm w-80">
        {toasts.map(t => (
          <div 
            key={t.id} 
            className={`px-4 py-3 rounded-xl text-sm font-semibold flex items-start gap-2.5 shadow-lg border transition-all ${
              t.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
              t.type === 'danger' ? 'bg-rose-50 border-rose-200 text-rose-800' :
              t.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' :
              'bg-sky-50 border-sky-200 text-sky-800'
            }`}
          >
            <span className="mt-0.5 shrink-0">
              {t.type === 'success' && <CheckCircle size={15} />}
              {t.type === 'danger' && <XCircle size={15} />}
              {t.type === 'warning' && <AlertTriangle size={15} />}
              {t.type === 'info' && <Info size={15} />}
            </span>
            <span className="leading-snug">{t.msg}</span>
          </div>
        ))}
      </div>

      {/* Header Panel - Cloud PMS Corporate Bar */}
      <header className="w-full max-w-6xl mb-6 bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-3.5 sm:gap-4 shadow-xs">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-sky-600 flex items-center justify-center text-white shrink-0 shadow-sm">
            <Cloud size={22} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl md:text-2xl font-black tracking-tight text-slate-900 uppercase font-heading whitespace-nowrap">
                Bang Fai Commander
              </h1>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider whitespace-nowrap shrink-0 ${
                (window.isNodeJS || isGAS) ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-slate-100 border border-slate-200 text-slate-600'
              }`}>
                {(window.isNodeJS || isGAS) ? '🟢 Cloud Connected' : '🧪 Sandbox Mode'}
              </span>
              {adminRole === 'superadmin' ? (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-purple-50 border border-purple-300 text-purple-700 flex items-center gap-1 shadow-xs whitespace-nowrap shrink-0" title="Super Admin: สิทธิ์เต็มรูปแบบทุกฟังก์ชัน">
                  <ShieldCheck size={12} className="text-purple-600" />
                  <span>Super Admin</span>
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-sky-50 border border-sky-300 text-sky-700 flex items-center gap-1 shadow-xs whitespace-nowrap shrink-0" title="Admin: สิทธิ์ปฏิบัติการภาคสนาม (ไม่สามารถรีเซ็ตระบบได้)">
                  <User size={12} className="text-sky-600" />
                  <span>Admin</span>
                  <span className="font-semibold text-sky-600/80">({usernameInput || 'Admin1'})</span>
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 font-sans">
              ระบบบริหารจัดการธุรกรรมเครดิตและการแข่งขันบั้งไฟสดภาคสนาม
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 justify-start xl:justify-end flex-nowrap shrink-0 overflow-x-auto">
          <button 
            onClick={handleClosePortal}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-bold bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shrink-0 whitespace-nowrap"
            title="รีเซ็ตและปิดรอบพอร์ทัลปัจจุบัน โดยไม่ลบข้อมูลผู้เล่นหรือประวัติธุรกรรม"
          >
            <RotateCcw size={13} className="text-amber-700" />
            <span>ปิดรอบพอร์ทัล</span>
          </button>
          <button 
            onClick={forceSyncFreshData}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-bold bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shrink-0 whitespace-nowrap shadow-xs"
            title="ดึงข้อมูลล่าสุดจากฐานข้อมูลและล้างแคชในเบราว์เซอร์ทันที"
          >
            <RefreshCw size={13} className="text-white" />
            <span>ซิงค์ข้อมูลสด</span>
          </button>
          {adminRole === 'superadmin' && (
            <button 
              onClick={resetConsoleState}
              className="px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-bold bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-300 text-slate-700 hover:text-rose-700 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shrink-0 whitespace-nowrap"
              title="ล้างข้อมูลระบบทั้งหมดกลับสู่ค่าเริ่มต้นโรงงาน (เฉพาะ Super Admin)"
            >
              <RotateCcw size={13} className="text-rose-600" />
              <span>รีเซ็ตระบบ</span>
            </button>
          )}
          <button 
            onClick={handleAdminLogout}
            className="px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shrink-0 whitespace-nowrap"
            title="ออกจากระบบแอดมิน"
          >
            <LogOut size={13} className="text-slate-500" />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </header>

      {/* Main Sandbox Grid (Standardized to corporate light 100% width column) */}
      <main className="w-full max-w-6xl space-y-5">
        
        {/* Top metrics bar stretching 100% width - Cloud PMS Style */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between hover:border-slate-300 transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                ยอดฝากเครดิตรวม
              </span>
              <span className="p-1.5 rounded-lg bg-sky-50 text-sky-600 border border-sky-100">
                <Wallet size={15} />
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-slate-900 font-mono tracking-tight">
                {transactions.filter(t => t.status === 'success').reduce((acc, t) => acc + t.actualAmount, 0).toLocaleString()}
              </span>
              <span className="text-xs font-bold text-slate-400">THB</span>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between hover:border-slate-300 transition-colors relative">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                รอตรวจหลักฐาน
              </span>
              <span className="p-1.5 rounded-lg bg-amber-50 text-amber-600 border border-amber-100 relative">
                <ShieldAlert size={15} />
                {transactions.filter(t => t.status === 'escalated').length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 animate-ping"></span>
                )}
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-amber-600 font-mono tracking-tight">
                {transactions.filter(t => t.status === 'escalated').length}
              </span>
              <span className="text-xs font-bold text-slate-400">บิลค้าง</span>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between hover:border-slate-300 transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                แผลจับคู่สด
              </span>
              <span className="p-1.5 rounded-lg bg-sky-50 text-sky-600 border border-sky-100">
                <Layers size={15} />
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-sky-600 font-mono tracking-tight">
                {bets.filter(b => b.status === 'matched').length}
              </span>
              <span className="text-xs font-bold text-slate-400">ดีลคู่</span>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col justify-between hover:border-slate-300 transition-colors">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                บัญชีผู้เล่น
              </span>
              <span className="p-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200">
                <Users size={15} />
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-1.5">
              <span className="text-2xl font-black text-slate-900 font-mono tracking-tight">
                {players.length}
              </span>
              <span className="text-xs font-bold text-slate-400">บัญชี</span>
            </div>
          </div>
        </div>

        {/* Tab Selection Bar - Cloud PMS Segmented Tabs */}
        <div className="bg-white p-1.5 flex text-xs md:text-sm font-semibold tracking-wide shrink-0 overflow-x-auto gap-1.5 rounded-xl border border-slate-200">
          <button 
            onClick={() => setAdminTab('quote')}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              (adminTab === 'quote' || adminTab === 'rocket') 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Layers size={15} className={(adminTab === 'quote' || adminTab === 'rocket') ? 'text-white' : 'text-slate-500'} />
            <span>ออกราคาช่าง</span>
          </button>
          <button 
            onClick={() => setAdminTab('broadcast')}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'broadcast' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Radio size={15} className={adminTab === 'broadcast' ? 'text-white' : 'text-slate-500'} />
            <span>บรอดแคสต์ & คีย์ลัด</span>
          </button>
          <button 
            onClick={() => setAdminTab('settle')}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'settle' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Zap size={15} className={adminTab === 'settle' ? 'text-white' : 'text-slate-500'} />
            <span>ป้อนผลเวลา</span>
          </button>
          <button 
            onClick={() => setAdminTab('bets')}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'bets' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Trophy size={15} className={adminTab === 'bets' ? 'text-white' : 'text-slate-500'} />
            <span>กระดานดวลสด</span>
            {bets.filter(b => b.status === 'matched' || b.status === 'pending_match').length > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${
                adminTab === 'bets' ? 'bg-white text-sky-800' : 'bg-sky-600 text-white'
              }`}>
                {bets.filter(b => b.status === 'matched' || b.status === 'pending_match').length}
              </span>
            )}
          </button>
          <button 
            onClick={() => { setAdminTab('review'); setTxStatusFilter('escalated'); }}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'review' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <FileText size={15} className={adminTab === 'review' ? 'text-white' : 'text-slate-500'} />
            <span>สลิปค้างรีวิว</span>
            {transactions.filter(t => t.status === 'escalated').length > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${
                adminTab === 'review' ? 'bg-white text-amber-600' : 'bg-amber-500 text-white'
              }`}>
                {transactions.filter(t => t.status === 'escalated').length}
              </span>
            )}
          </button>
          <button 
            onClick={() => setAdminTab('players')}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'players' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Users size={15} className={adminTab === 'players' ? 'text-white' : 'text-slate-500'} />
            <span>เครดิตผู้เล่น</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
              adminTab === 'players' ? 'bg-sky-800 text-white' : 'bg-slate-200 text-slate-700'
            }`}>
              {players.length}
            </span>
          </button>
          <button 
            onClick={() => { setAdminTab('logs'); setTxStatusFilter('all'); }}
            className={`flex-1 py-2.5 px-3 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap font-heading tracking-wide cursor-pointer ${
              adminTab === 'logs' 
                ? 'bg-sky-600 text-white font-bold' 
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Database size={15} className={adminTab === 'logs' ? 'text-white' : 'text-slate-500'} />
            <span>ทรานแซคชัน</span>
          </button>
        </div>

        {/* Tab panels contents container */}
        <div className="w-full space-y-6">

          {/* TAB 1: ONSITE TELEMETRY RECEIVER & MECHANIC QUOTE SETUP */}
          {(adminTab === 'quote' || adminTab === 'rocket') && (
            <div className="glass-panel p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                    <Layers size={18} className="text-sky-600" />
                    ออกราคาช่างเปิดรับดวล
                  </h3>
                  <p className="text-xs text-slate-500 font-sans mt-0.5">
                    ตั้งค่าชื่อค่ายช่าง บั้งไฟ และช่วงราคาเปิด (Min - Max) เพื่อบรอดแคสต์ลงกลุ่มดวลสด
                  </p>
                </div>
                <span className="self-start sm:self-auto text-[10px] text-emerald-700 font-extrabold bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                  LINE Broadcast Ready
                </span>
              </div>

              {/* Connected Channel Header */}
              <div className="w-full rounded-xl border border-slate-200 bg-slate-50 p-2.5 flex justify-between items-center text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="text-[11px] font-bold text-slate-700 font-heading">
                    กลุ่มเป้าหมายปัจจุบัน:
                  </span>
                  {activeGroupId ? (
                    <span className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded text-[11px] font-mono font-bold flex items-center gap-1">
                      {(() => {
                        const activeObj = lineGroups.find(g => g.id === activeGroupId);
                        const isRaw = !activeObj || !activeObj.name || activeObj.name.startsWith('C') || activeObj.name.includes(activeGroupId) || !isNaN(activeObj.name);
                        return !isRaw ? activeObj.name : `🚀 กลุ่มดวลสด (#${activeGroupId.slice(-4)})`;
                      })()}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 rounded text-[10.5px] font-semibold">
                      ยังไม่มีกลุ่มที่เชื่อมต่อ
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 font-mono">Channel: Onsite-Radio-V2</span>
              </div>

              {/* Form Card */}
              <div className="p-4 bg-slate-50/50 rounded-xl border border-slate-200 space-y-3.5">

                {/* Form Fields: Rocket Name & Range Min/Max */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <Rocket size={13} className="text-amber-600" />
                      ชื่อบั้งไฟ / ชื่อช่าง:
                    </label>
                    <input 
                      type="text"
                      value={rocketName}
                      onChange={(e) => setRocketName(e.target.value)}
                      className="w-full bg-white border border-slate-200 text-slate-900 font-bold px-3 py-2 rounded-xl text-xs font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                      placeholder="กรอกชื่อช่าง / บั้งไฟ (เช่น โชคน้องกวาง)"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <TrendingUp size={13} className="text-sky-500" />
                      ราคาช่าง Min (ต่ำ / เกิบ):
                    </label>
                    <div className="flex items-center gap-1">
                      <input 
                        type="number"
                        step="1"
                        value={targetMin}
                        onChange={(e) => setTargetMin(e.target.value)}
                        className="w-full bg-white border border-slate-200 text-slate-900 font-bold px-3 py-2 rounded-xl text-xs font-mono"
                        placeholder="เช่น 330"
                      />
                      <span className="text-xs text-slate-500 font-mono font-bold">s</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <TrendingUp size={13} className="text-rose-500" />
                      ราคาช่าง Max (สูง / หมวก):
                    </label>
                    <div className="flex items-center gap-1">
                      <input 
                        type="number"
                        step="1"
                        value={targetMax}
                        onChange={(e) => setTargetMax(e.target.value)}
                        className="w-full bg-white border border-slate-200 text-slate-900 font-bold px-3 py-2 rounded-xl text-xs font-mono"
                        placeholder="เช่น 380"
                      />
                      <span className="text-xs text-slate-500 font-mono font-bold">s</span>
                    </div>
                  </div>
                </div>

                {/* Bet Amount & Chotoy Option Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="flex items-center gap-2 bg-white px-3 py-2 rounded-xl border border-emerald-200">
                    <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">แต้มดวลเริ่มต้น:</span>
                    <input
                      type="number"
                      step="50"
                      value={quoteBetAmount}
                      onChange={(e) => setQuoteBetAmount(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-slate-800 font-bold px-2 py-1 rounded-lg text-xs font-mono"
                      placeholder="500"
                    />
                    <span className="text-xs text-slate-500 font-mono font-bold">pt</span>
                  </div>

                  <label className="flex items-center gap-2 bg-white px-3 py-2 rounded-xl border border-emerald-200 cursor-pointer hover:bg-emerald-50/50 transition-all">
                    <input
                      type="checkbox"
                      checked={quoteIsChotoy}
                      onChange={(e) => setQuoteIsChotoy(e.target.checked)}
                      className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-xs font-extrabold text-amber-900">
                      เผื่อช่างไม่ต่อย (ชตย: ช่างต่อยยุติ) Option
                    </span>
                  </label>
                </div>


                {/* Target Group Broadcast Selector */}
                <div className="bg-white p-2.5 rounded-xl border border-emerald-200 space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <Users size={13} className="text-emerald-600" />
                      กลุ่มเป้าหมายที่จะบรอดแคสต์ (Broadcast Target Group):
                    </label>
                    <span className="text-[10px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                      {broadcastTargetGroup === 'ALL' ? '🌐 ทุกกลุ่มดวลสด (All)' : '🎯 เฉพาะกลุ่มที่เลือก'}
                    </span>
                  </div>
                  <select
                    value={broadcastTargetGroup}
                    onChange={(e) => setBroadcastTargetGroup(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 text-slate-900 font-bold px-3 py-2 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                  >
                    <option value="ALL">🌐 กระจายทุกกลุ่มดวลสดพร้อมกัน (Broadcast All Groups - One Shot)</option>
                    {lineGroups.map((g, idx) => {
                      const isRawId = !g.name || g.name.startsWith('C') || g.name.includes(g.id) || !isNaN(g.name);
                      const displayName = !isRawId ? g.name : `🚀 กลุ่มดวลสด #${idx + 1} (${g.id.slice(-4)})`;
                      return (
                        <option key={g.id} value={g.id}>
                          🎯 เฉพาะกลุ่ม: {displayName}
                        </option>
                      );
                    })}
                  </select>
                </div>


                {/* Broadcast Quote Primary Button */}
                <button
                  onClick={() => handleBroadcastFastQuote()}
                  className="w-full py-3 px-4 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-lg text-xs transition-all active:scale-95 flex items-center justify-center gap-2 font-heading tracking-wide cursor-pointer"
                >
                  <Send size={15} />
                  <span>ประกาศราคาช่าง {targetMin && targetMax ? `${targetMin}-${targetMax}s` : ''} ลง{broadcastTargetGroup === 'ALL' ? 'ทุกกลุ่มดวลสด' : 'กลุ่มที่เลือก'}</span>
                </button>

                {/* Tab 1 Footer Note & Shortcut to Broadcast Tab */}
                <div className="pt-2 border-t border-emerald-100 flex items-center justify-between text-[11px] font-sans flex-wrap gap-2">
                  <span className="text-emerald-700 font-bold">💡 ราคาช่างเปิดจากแอดมินไม่ต้องใช้แต้ม</span>
                  <button 
                    onClick={() => setAdminTab('broadcast')}
                    className="text-purple-700 hover:text-purple-900 font-bold underline flex items-center gap-1 transition-all active:scale-95"
                  >
                    <Radio size={13} className="text-purple-600" />
                    <span>ไปยังศูนย์บรอดแคสต์ & คีย์ลัดแอดมิน ➜</span>
                  </button>
                </div>
              </div>
            </div>
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
                          onChange={(e) => setTargetMin(e.target.value)}
                          className="w-14 bg-slate-50 border border-slate-300 text-slate-900 font-bold px-1.5 py-0.5 rounded text-xs text-center focus:ring-1 focus:ring-sky-500 focus:outline-none"
                          placeholder="330"
                        />
                        <span className="text-slate-400">-</span>
                        <input
                          type="number"
                          step="1"
                          value={targetMax}
                          onChange={(e) => setTargetMax(e.target.value)}
                          className="w-14 bg-slate-50 border border-slate-300 text-slate-900 font-bold px-1.5 py-0.5 rounded text-xs text-center focus:ring-1 focus:ring-sky-500 focus:outline-none"
                          placeholder="380"
                        />
                        <span className="text-slate-500 font-bold">s</span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center text-xs font-bold">
                      <span>คาดการณ์ผลชนะ:</span>
                      {Number(customRocketTime || 0) < Number(targetMin || 330) ? (
                        <span className="px-2.5 py-1 bg-blue-100 text-blue-800 font-black rounded-lg text-xs flex items-center gap-1">🔵 ฝั่งต่ำ (LOW / ชถ) ชนะ</span>
                      ) : Number(customRocketTime || 0) > Number(targetMax || 380) ? (
                        <span className="px-2.5 py-1 bg-rose-100 text-rose-800 font-black rounded-lg text-xs flex items-center gap-1">🔴 ฝั่งสูง (HIGH / ชล) ชนะ</span>
                      ) : (
                        <span className="px-2.5 py-1 bg-emerald-100 text-emerald-800 font-black rounded-lg text-xs flex items-center gap-1">🎯 ในราคาช่าง (RANGE)</span>
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
                  <span>⚡ สรุปผลและชำระแต้มดีลทั้งหมด / SETTLE ONSITE ROUND (ผลลัพธ์ยิงจริง: {customRocketTime || 0}s)</span>
                </button>
              </div>

              {/* Logs and Flight Histories in Light Mode */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-[11px]">
                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col" style={{ minHeight: '160px', maxHeight: '220px' }}>
                  <span className="text-[11px] font-bold text-slate-800 border-b border-slate-200 pb-1.5 mb-2 flex items-center justify-between font-sans shrink-0">
                    <span>📋 LAUNCH ENGINE LOGS</span>
                    <Clock size={12} className="text-slate-400" />
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-1 pr-1" style={{ wordBreak: 'break-all' }}>
                    {flightLogs.length === 0 ? (
                      <span className="text-slate-400 italic text-[11px]">-- ไม่มีข้อมูลบันทึกในเซสชันนี้ --</span>
                    ) : (
                      flightLogs.map((l, i) => (
                        <div key={i} className={`text-[11px] ${l.includes('🏆') || l.includes('SUCCESS') ? 'text-emerald-600 font-bold' : l.includes('💥') || l.includes('terminated') ? 'text-rose-600 font-bold' : 'text-slate-600'}`}>
                          ➜ {l}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex flex-col" style={{ minHeight: '160px', maxHeight: '220px' }}>
                  <span className="text-[11px] font-bold text-slate-800 border-b border-slate-200 pb-1.5 mb-2 flex justify-between font-sans shrink-0">
                    <span>🗂️ ประวัติออกผล</span>
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

            return (
              <div className="glass-panel p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-base font-black text-slate-800 flex items-center gap-2 font-heading">
                      <Trophy size={18} className="text-indigo-600" />
                      กระดานดวลสด & สัญญาแข่งขัน
                    </h3>
                    <p className="text-xs text-slate-500 font-sans mt-0.5">
                      ตรวจสอบคู่ดวลที่จับคู่แล้ว บิลที่รอคู่ดวล หรือถอนแผลคืนแต้มให้ผู้เล่น
                    </p>
                  </div>
                </div>

                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-sans">
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                      <span className="text-[10px] text-slate-400 font-bold uppercase block">สัญญาทั้งหมด</span>
                      <span className="text-lg font-black text-slate-800 font-mono">{bets.length}</span>
                      <span className="text-[10px] text-slate-500 block">รายการ</span>
                    </div>
                    <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-3 text-center">
                      <span className="text-[10px] text-indigo-600 font-bold uppercase block">กำลังดวลสด</span>
                      <span className="text-lg font-black text-indigo-900 font-mono">{matchedCount}</span>
                      <span className="text-[10px] text-indigo-500 block">คู่ดวล</span>
                    </div>
                    <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-3 text-center">
                      <span className="text-[10px] text-amber-600 font-bold uppercase block">รอคู่ดวล</span>
                      <span className="text-lg font-black text-amber-900 font-mono">{pendingCount}</span>
                      <span className="text-[10px] text-amber-500 block">รอรับแผล</span>
                    </div>
                    <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-3 text-center">
                      <span className="text-[10px] text-emerald-600 font-bold uppercase block">มูลค่าดวลรวม</span>
                      <span className="text-lg font-black text-emerald-900 font-mono">{totalBetVolume.toLocaleString()}</span>
                      <span className="text-[10px] text-emerald-600 block">แต้ม (pt)</span>
                    </div>
                  </div>

                  {/* Filter & Search Bar */}
                  <div className="flex items-center justify-between gap-3 flex-wrap bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <div className="flex items-center gap-1.5 flex-wrap text-xs font-bold font-sans">
                      <span className="text-slate-400 text-[11px] uppercase tracking-wider mr-1">สถานะ:</span>
                      <button
                        onClick={() => setBetStatusFilter('all')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${betStatusFilter === 'all' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'}`}
                      >
                        ทั้งหมด ({bets.length})
                      </button>
                      <button
                        onClick={() => setBetStatusFilter('matched')}
                        className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${betStatusFilter === 'matched' ? 'bg-indigo-600 text-white' : 'bg-white text-indigo-700 border border-indigo-200 hover:bg-indigo-50'}`}
                      >
                        <span>⚔️ ดวลกันอยู่</span>
                        {matchedCount > 0 && <span className="bg-indigo-200 text-indigo-950 text-[10px] px-1.5 py-0.2 rounded-full font-black">{matchedCount}</span>}
                      </button>
                      <button
                        onClick={() => setBetStatusFilter('pending_match')}
                        className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${betStatusFilter === 'pending_match' ? 'bg-amber-600 text-white' : 'bg-white text-amber-700 border border-amber-200 hover:bg-amber-50'}`}
                      >
                        <span>⏳ รอคู่ดวล</span>
                        {pendingCount > 0 && <span className="bg-amber-200 text-amber-950 text-[10px] px-1.5 py-0.2 rounded-full font-black">{pendingCount}</span>}
                      </button>
                      <button
                        onClick={() => setBetStatusFilter('resolved')}
                        className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${betStatusFilter === 'resolved' ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-50'}`}
                      >
                        ✅ สรุปผลแล้ว ({resolvedCount})
                      </button>
                      <button
                        onClick={() => setBetStatusFilter('cancelled')}
                        className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 ${betStatusFilter === 'cancelled' ? 'bg-rose-600 text-white' : 'bg-white text-rose-700 border border-rose-200 hover:bg-rose-50'}`}
                      >
                        ❌ ขอยกเลิก ({cancelCount})
                      </button>
                    </div>

                    <div className="relative w-full sm:w-64">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        placeholder="ค้นหา Order # หรือชื่อผู้เล่น..."
                        value={betSearchQuery}
                        onChange={(e) => setBetSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-sans focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  {/* Bets Table */}
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-left font-sans text-xs border-collapse min-w-[700px]">
                      <thead className="bg-slate-50 text-slate-500 font-bold border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3">Order #</th>
                          <th className="py-2.5 px-3">ฝั่งต่ำ (Low / ชถ)</th>
                          <th className="py-2.5 px-3">ฝั่งสูง (High / ชล)</th>
                          <th className="py-2.5 px-3 text-right">ยอดดวล</th>
                          <th className="py-2.5 px-3 text-center">ประเภทราคา</th>
                          <th className="py-2.5 px-3 text-center">สถานะ</th>
                          <th className="py-2.5 px-3 text-right">จัดการแผล</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {filteredBets.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-10 text-center text-slate-400 text-xs italic">
                              -- ไม่พบบันทึกการดวลที่ตรงกับเงื่อนไข --
                            </td>
                          </tr>
                        ) : (
                          filteredBets.slice().reverse().map(b => {
                          const isLow = b.side === 'low';
                          const pLowName = b.playerLowName || (isLow ? b.creatorName : b.matcherName);
                          const pLowId = b.playerLowId || (isLow ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));
                          const pHighName = b.playerHighName || (!isLow && b.side === 'high' ? b.creatorName : b.matcherName);
                          const pHighId = b.playerHighId || (!isLow && b.side === 'high' ? (b.creatorId || b.creatorLineUserId) : (b.matcherId || b.matcherLineUserId));

                          return (
                            <tr key={b.id || `bet_${b.orderNumber}`} className="hover:bg-indigo-50/20 transition-colors">
                              <td className="py-3 px-3 font-bold text-slate-800 font-mono">
                                Order #{b.orderNumber}
                                <div className="text-[10px] text-slate-400 font-sans font-normal">{b.timestamp || ''}</div>
                              </td>
                              <td className="py-3 px-3">
                                {pLowName ? (
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0"></span>
                                      <span className="text-sky-800 font-black">{pLowName}</span>
                                    </div>
                                    {pLowId && (
                                      <span className="text-[10px] text-slate-500 font-mono font-bold pl-3.5 flex items-center gap-1">
                                        <span className="px-1.5 py-0.2 bg-sky-50 border border-sky-200 text-sky-700 rounded text-[9.5px]">ID: {pLowId}</span>
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-slate-300 italic font-sans">-- รอผู้เล่น --</span>
                                )}
                              </td>
                              <td className="py-3 px-3">
                                {pHighName ? (
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0"></span>
                                      <span className="text-rose-800 font-black">{pHighName}</span>
                                    </div>
                                    {pHighId && (
                                      <span className="text-[10px] text-slate-500 font-mono font-bold pl-3.5 flex items-center gap-1">
                                        <span className="px-1.5 py-0.2 bg-rose-50 border border-rose-200 text-rose-700 rounded text-[9.5px]">ID: {pHighId}</span>
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-slate-300 italic font-sans">-- รอผู้เล่น --</span>
                                )}
                              </td>
                              <td className="py-3 px-3 text-right font-black text-slate-900 font-mono text-sm">
                                {b.amount?.toLocaleString()} <span className="text-[10px] text-slate-400 font-normal">pt</span>
                              </td>
                              <td className="py-3 px-3 text-center font-mono">
                                {b.type === 'range' ? (
                                  <span className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 font-extrabold rounded text-[10.5px]">
                                    🤝 P2P ({b.rangeMin > 1000 ? (b.rangeMin/100) : b.rangeMin}-{b.rangeMax > 1000 ? (b.rangeMax/100) : b.rangeMax}s)
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 bg-sky-50 border border-sky-200 text-sky-800 font-bold rounded text-[10.5px]">
                                    🏛️ ราคาช่าง ({targetMin}-{targetMax}s)
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-3 text-center font-sans font-bold text-[10.5px]">
                                {b.status === 'matched' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-full font-bold">
                                    ⚔️ ดวลกันอยู่
                                  </span>
                                )}
                                {b.status === 'pending_match' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full font-bold animate-pulse">
                                    ⏳ รอคู่ดวล
                                  </span>
                                )}
                                {b.status === 'pending_cancel' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-full font-bold">
                                    ⚠️ รอถอนแผล
                                  </span>
                                )}
                                {b.status === 'cancelled' && (
                                  <span className="px-2 py-0.5 text-slate-400 line-through font-mono">
                                    ✕ ขอยกเลิก
                                  </span>
                                )}
                                {b.status === 'resolved' && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full font-bold">
                                    🏆 {b.winnerName ? b.winnerName.split(' ')[0] : 'จบแล้ว'}
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-3 text-right">
                                {(b.status === 'matched' || b.status === 'pending_match' || b.status === 'pending_cancel') ? (
                                  <button
                                    onClick={() => handleRequestCancelBet(b.id)}
                                    className="px-2.5 py-1 bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-700 text-[10.5px] rounded-lg font-bold transition-all active:scale-95"
                                    title="ยกเลิกการดวลและคืนแต้มเข้าบัญชี"
                                  >
                                    ถอนดีลสด
                                  </button>
                                ) : (
                                  <span className="text-slate-300 text-[11px]">—</span>
                                )}
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
                        <span>⏳ รออนุมัติ</span>
                        {escalatedCount > 0 && <span className="bg-amber-200 text-amber-900 text-[10px] px-1.5 py-0.2 rounded-full font-black">{escalatedCount}</span>}
                      </button>
                      <button 
                        onClick={() => setTxStatusFilter('success')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${txStatusFilter === 'success' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100'}`}
                      >
                        ✅ อนุมัติแล้ว ({successCount})
                      </button>
                      <button 
                        onClick={() => setTxStatusFilter('rejected')}
                        className={`px-2.5 py-1 rounded-lg transition-all ${txStatusFilter === 'rejected' ? 'bg-rose-600 text-white shadow-xs' : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100'}`}
                      >
                        ❌ ปฏิเสธ ({rejectedCount})
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
                        📥 ฝากเงิน
                      </button>
                      <button 
                        onClick={() => setTxTypeFilter('withdrawal')}
                        className={`px-2 py-1 rounded-lg text-[11px] transition-all ${txTypeFilter === 'withdrawal' ? 'bg-rose-700 text-white' : 'bg-white text-rose-700 border border-rose-200'}`}
                      >
                        📤 ถอนเงิน
                      </button>
                    </div>

                    <div className="relative min-w-[240px] flex-1 md:flex-initial">
                      <input 
                        type="text" 
                        placeholder="🔍 ค้นหา TX ID / ชื่อผู้เล่น / LINE ID / Ref..." 
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
                                  <span className="px-2 py-0.5 bg-rose-100 text-rose-800 font-black rounded-md text-[10px]">📤 ถอนเงิน</span>
                                ) : (
                                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-black rounded-md text-[10px]">📥 ฝากเงิน</span>
                                )}
                              </td>

                              <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                                {isWithdrawal ? `-${tx.requestedAmount}` : tx.requestedAmount}.00
                              </td>

                              <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">
                                {tx.actualAmount > 0 ? `${tx.actualAmount}.00` : <span className="text-slate-400 italic">0.00</span>}
                              </td>

                              <td className="py-2.5 px-3 text-center">
                                {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg text-[10px] font-bold">✓ อนุมัติแล้ว</span>}
                                {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg text-[10px] font-bold animate-pulse">⏳ รออนุมัติ</span>}
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
                                        ✓ อนุมัติ
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
                                    👁️ สลิป
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
                              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full text-[10px] font-bold">✓ ลงทะเบียนแล้ว</span>
                              : <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full text-[10px] font-bold animate-pulse">⚠ รอลงทะเบียน</span>}
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
                                ✏️ แก้ไข
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
                                🏦 บัญชี
                              </button>
                              {/* Delete */}
                              <button
                                title="ลบผู้เล่น"
                                onClick={() => setConfirmDelete({ player: p })}
                                className="px-2.5 py-1.5 bg-rose-50 border border-rose-200 text-rose-600 text-[10px] font-bold rounded-lg hover:bg-rose-100 transition-all active:scale-95"
                              >
                                🗑
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
                    <option value="ALL">🌐 กระจายทุกกลุ่มดวลสด (All Groups)</option>
                    {lineGroups.map((g, idx) => {
                      const isRawId = !g.name || g.name.startsWith('C') || g.name.includes(g.id) || !isNaN(g.name);
                      const displayName = !isRawId ? g.name : `🚀 กลุ่มดวลสด #${idx + 1} (${g.id.slice(-4)})`;
                      return (
                        <option key={g.id} value={g.id}>
                          🎯 เฉพาะกลุ่ม: {displayName}
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
                    <span>⚡ 1. ปุ่มคีย์ลัดสั่งการสนาม & กฎกติกา</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-sans">ส่งการ์ด Flex แจ้งเตือนด่วนเข้ากลุ่ม LINE ทันที</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Final Call */}
                  <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-amber-900 font-heading">⛔ ปิดรับดวล</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-200 text-amber-900 rounded-md">Final Call</span>
                      </div>
                      <p className="text-[10.5px] text-amber-800/80 font-sans leading-relaxed">
                        ประกาศปิดรับออเดอร์ท้าดวลก่อนปล่อยบั้งไฟ บอทจะปฏิเสธทุกบิลหลังจากนี้
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const res = await runBackendFunction('adminBroadcastFinalCall', [broadcastTargetGroup || 'ALL']);
                          if (res && res.success === false) addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('⛔ ปิดรับดวลแล้ว', 'warning');
                        } catch {
                          addToast('❌ ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="w-full py-2 px-3 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <span>⛔ ส่งประกาศ ปิดรับดวล</span>
                    </button>
                  </div>

                  {/* Void Round */}
                  <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-rose-900 font-heading">⛔ โมฆะรอบ (ช่าง ⛔)</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-rose-200 text-rose-900 rounded-md">Emergency</span>
                      </div>
                      <p className="text-[10.5px] text-rose-800/80 font-sans leading-relaxed">
                        กรณีบั้งไฟมีปัญหา ยุติรอบการแข่งขัน ยกเลิกแผลดวลและโอนคืนเครดิตให้ผู้เล่น 100%
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!window.confirm("⛔ ยืนยันโมฆะรอบและยกเลิกคืนแต้มทั้งหมด?")) return;
                        try {
                          const res = await runBackendFunction('adminBroadcastVoidRound', [broadcastTargetGroup || 'ALL']);
                          if (res && res.success === false) addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('⛔ โมฆะรอบและคืนแต้มแล้ว', 'danger');
                        } catch {
                          addToast('❌ ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="w-full py-2 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <span>⛔ สั่งโมฆะรอบ & คืนแต้ม</span>
                    </button>
                  </div>

                  {/* Rule Guide */}
                  <div className="bg-teal-50/70 border border-teal-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-teal-900 font-heading">📖 คู่มือกติกา</span>
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
                          if (res && res.success === false) addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('📖 ส่งกติกาแล้ว', 'info');
                        } catch {
                          addToast('❌ ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="w-full py-2 px-3 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <span>📖 ส่งคู่มือกติกาเข้ากลุ่ม</span>
                    </button>
                  </div>

                  {/* Rocket Launched Broadcast Card */}
                  <div className="bg-orange-50/80 border border-orange-200 rounded-xl p-3.5 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-orange-950 font-heading flex items-center gap-1">
                          <span>🚀 บั้งไฟออกแล้ว!</span>
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-orange-200 text-orange-900 rounded-md">Live Action</span>
                      </div>
                      <p className="text-[10.5px] text-orange-900/80 font-sans leading-relaxed">
                        ส่ง Flex Card "🚀 บั้งไฟออกแล้ว! 🚀" แจ้งเตือนด่วนเข้ากลุ่ม LINE ทันที เมื่อบั้งไฟพุ่งขึ้นฟ้า
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const res = await runBackendFunction('adminBroadcastRocketLaunched', [broadcastTargetGroup || 'ALL']);
                          if (res && res.success === false) addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                          else addToast('🚀 ส่งประกาศบั้งไฟออกแล้ว!', 'info');
                        } catch {
                          addToast('❌ ส่งไม่สำเร็จ', 'danger');
                        }
                      }}
                      style={{ backgroundColor: '#ea580c', color: '#ffffff' }}
                      className="w-full py-2 px-3 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <span className="text-white font-bold">🚀 ส่งประกาศ บั้งไฟออกแล้ว!</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* SECTION 2: CUSTOM FIELD ANNOUNCEMENT */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-slate-800 uppercase tracking-wider font-heading flex items-center gap-1.5">
                    <span>📢 2. ส่งประกาศอิสระเข้ากลุ่ม LINE</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-sans">พิมพ์ข้อความแจ้งเตือนหรือข้อมูลสนามส่งตรงเข้ากลุ่ม</span>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  {/* Quick Preset Buttons */}
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">ข้อความด่วนแนะนำ (คลิกเพื่อใส่ข้อความ):</span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setCustomBroadcastText('☕ ประกาศจากสนาม: ขณะนี้อยู่ในช่วงพักเบรก 15 นาที จะเริ่มเปิดรับดวลรอบถัดไปเร็ว ๆ นี้ครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                      >
                        ☕ พักเบรก 15 นาที
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('🌧️ ประกาศจากสนาม: เนื่องจากสภาพอากาศมีฝนตก จึงขอพักการปล่อยบั้งไฟชั่วคราว เมื่อพร้อมจะแจ้งให้ทราบครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                      >
                        🌧️ ฝนตก พักการยิงชั่วคราว
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('🔥 เตรียมพร้อม! บั้งไฟกำลังขึ้นติดตั้งบนแท่นยิง โปรดเตรียมแต้มให้พร้อมสำหรับการท้าดวล')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                      >
                        🔥 บั้งไฟกำลังขึ้นแท่นยิง
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('🚀 บั้งไฟออกแล้ว! เปิดรับดวลรอบใหม่เร็ว ๆ นี้ ติดตามประกาศจากสนามได้เลยครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                      >
                        🚀 บั้งไฟออกแล้ว
                      </button>
                      <button
                        onClick={() => setCustomBroadcastText('🏁 สรุปผลการแข่งขันและการดวลประจำวันเสร็จสิ้นเรียบร้อย ขอบพระคุณสมาชิกทุกท่านที่ร่วมสนุกครับ')}
                        className="px-2.5 py-1 bg-white hover:bg-purple-50 text-slate-700 hover:text-purple-700 border border-slate-200 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                      >
                        🏁 จบการแข่งขันประจำวัน
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
                              addToast(`⚠️ ส่งไม่สำเร็จ: ${res.error || 'โควตาเต็ม'}`, 'warning');
                            } else {
                              addToast('📢 ส่งประกาศเข้ากลุ่มแล้ว', 'success');
                              setCustomBroadcastText('');
                            }
                          } catch {
                            addToast('❌ ส่งไม่สำเร็จ', 'danger');
                          } finally {
                            setIsSendingBroadcast(false);
                          }
                        }}
                        className="py-2 px-5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white rounded-xl text-xs font-bold transition-all active:scale-95 shadow-md flex items-center gap-1.5"
                      >
                        <Megaphone size={14} />
                        <span>{isSendingBroadcast ? 'กำลังส่ง...' : '📢 ส่งประกาศเข้ากลุ่ม LINE'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION 3: LINE GROUP CONNECTION & DIAGNOSTICS */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="text-xs font-black text-slate-800 uppercase tracking-wider font-heading flex items-center gap-1.5">
                    <span>📡 3. จัดการการเชื่อมต่อกลุ่ม LINE</span>
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
                            const gid = window.prompt('เปลี่ยน Group ID (วาง LINE Group ID ใหม่):', activeGroupId);
                            if (gid && gid.trim().length > 5) {
                              await runBackendFunction('adminSetActiveGroupId', [gid.trim()]);
                              const dash = await runBackendFunction('getDashboardData', []);
                              if (dash) { setActiveGroupId(dash.activeGroupId); setLineGroups(dash.lineGroups || []); }
                              addToast(`✅ เปลี่ยน Group ID เป็น ...${gid.trim().slice(-8)}`, 'success');
                            }
                          }}
                          className="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-lg text-[10.5px] font-bold transition-all active:scale-95"
                        >
                          ✏️ เปลี่ยน Group ID
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          addToast('⚡ กำลังทดสอบส่ง Push...', 'info');
                          try {
                            const testRes = await runBackendFunction('adminTestPushGroupMessage', [activeGroupId || 'ALL']);
                            if (testRes && testRes.success) {
                              addToast('✅ ทดสอบส่ง Push สำเร็จ', 'success');
                            } else {
                              addToast(`⚠️ ส่งไม่สำเร็จ: ${testRes?.error || 'โควตาเต็ม'}`, 'warning');
                            }
                          } catch {
                            addToast('❌ ส่งไม่สำเร็จ', 'danger');
                          }
                        }}
                        className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-bold transition-all active:scale-95 shadow-xs flex items-center gap-1"
                      >
                        <span>⚡ ทดสอบส่ง Push เข้ากลุ่ม</span>
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
                            addToast(`🔍 พบ Group ID: ...${first.id.slice(-6)}`, 'info');
                            await runBackendFunction('adminSetActiveGroupId', [first.id]);
                            const dash = await runBackendFunction('getDashboardData', []);
                            if (dash) { setActiveGroupId(dash.activeGroupId); setLineGroups(dash.lineGroups || []); }
                            addToast('✅ ตั้งค่า Group ID สำเร็จ', 'success');
                          } else {
                            addToast('⚠️ ไม่พบ Group ID ในระบบ', 'warning');
                          }
                        } catch {
                          addToast('❌ ค้นหาไม่สำเร็จ', 'danger');
                        }
                      }}
                      className="py-2 px-3.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg transition-all active:scale-95 whitespace-nowrap"
                    >
                      🔍 Auto Discover
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
                            addToast(`✅ ตั้งค่า Group ID สำเร็จ: ...${gid.slice(-8)}`, 'success');
                            e.target.value = '';
                          } catch(err) {
                            const errStr = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'Error';
                            addToast(`❌ Error: ${errStr}`, 'danger');
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
                  <h3 className="font-bold text-base" style={{ color: '#ffffff' }}>✏️ แก้ไขข้อมูลผู้เล่น</h3>
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
                        addToast(balChanged ? `✅ ปรับเครดิต ${playerEditForm.name} เป็น ${playerEditForm.balance.toLocaleString()} pt (ส่ง DM เรียบร้อย)` : `✅ อัปเดตข้อมูล ${p.name} สำเร็จ`, 'success');
                      } catch (err) {
                        setPlayerEditSaving(false);
                        addToast('❌ ' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
                  >
                    {playerEditSaving ? '⏳ บันทึก...' : '💾 บันทึก'}
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
                  <h3 className="font-bold text-base" style={{ color: '#ffffff' }}>🏦 ลงทะเบียนบัญชีธนาคาร</h3>
                  <p className="text-xs mt-0.5" style={{ color: '#ccfbf1' }}>
                    {bankEditModal.player.name} · <span className="font-mono" style={{ color: '#99f6e4' }}>{bankEditModal.player.id.slice(0, 18)}…</span>
                  </p>
                </div>

                {/* Modal Body */}
                <div className="px-6 py-5 space-y-4">
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                    <strong>⚠️ ตรวจสอบให้แน่ใจ:</strong> เลขบัญชีและชื่อบัญชีต้องตรงกับสลิปที่ผู้เล่นส่งมาเท่านั้น
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
                        addToast(`✅ บันทึกบัญชีธนาคารของ ${p.name} สำเร็จ`, 'success');
                      } catch (err) {
                        setBankEditSaving(false);
                        addToast('❌ เกิดข้อผิดพลาด: ' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 text-white text-sm font-bold rounded-xl transition-all active:scale-95 disabled:cursor-not-allowed"
                    style={{ 
                      backgroundColor: (bankEditSaving || !bankEditForm.bankName || !bankEditForm.bankAccount || !bankEditForm.accountName) ? '#94a3b8' : '#0f766e', 
                      color: '#ffffff' 
                    }}
                  >
                    {bankEditSaving ? '⏳ กำลังบันทึก...' : '💾 บันทึกบัญชี'}
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
                    <strong>💡 วิธีหา LINE ID:</strong> ให้ผู้เล่นส่งข้อความมาใน LINE OA ก่อน แล้วดู ID ในหน้า LINE Chat ของแดชบอร์ดนี้
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
                        addToast(`✅ สร้างบัญชี ${name} สำเร็จ`, 'success');
                      } catch (err) {
                        setCreatePlayerSaving(false);
                        addToast('❌ ' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 text-white text-sm font-bold rounded-xl transition-all active:scale-95 disabled:cursor-not-allowed"
                    style={{ 
                      backgroundColor: (createPlayerSaving || !createPlayerForm.lineId.trim() || !createPlayerForm.name.trim()) ? '#94a3b8' : '#0f766e', 
                      color: '#ffffff' 
                    }}
                  >
                    {createPlayerSaving ? '⏳ กำลังสร้าง...' : '🎉 สร้างบัญชี'}
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
                  <h3 className="text-white font-bold text-base">🗑 ยืนยันการลบผู้เล่น</h3>
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
                        addToast(`🗑 ลบบัญชี ${p.name} สำเร็จ`, 'info');
                      } catch (err) {
                        setDeleteSaving(false);
                        addToast('❌ ' + (err.message || err), 'error');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
                  >
                    {deleteSaving ? '⏳ กำลังลบ...' : '🗑 ยืนยันลบ'}
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
                        {isWithdrawal ? '📤 รายละเอียดคำขอถอนเงิน' : '📥 รายละเอียดการแจ้งสลิปเติมเงิน'}
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
                            <div className="text-4xl mt-2">💸</div>
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
                              {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg font-bold">✓ อนุมัติเรียบร้อย</span>}
                              {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg font-bold animate-pulse">⏳ รออนุมัติแมนนวล</span>}
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
                            <span className="text-emerald-400 font-bold block font-sans">🔍 Scan Analysis Logs:</span>
                            {tx.logs.map((l, i) => (
                              <div key={i}>➜ {l}</div>
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
                          ✓ ยืนยันอนุมัติ ({isWithdrawal ? tx.requestedAmount : (tx.actualAmount || tx.requestedAmount)} THB)
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
                  ? 'ต่ำ (LOW) 🔵' 
                  : settlementResult.outcome === 'HIGH' 
                  ? 'สูง (HIGH) 🔴' 
                  : 'ในราคาช่าง (RANGE) 🎯'
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
              📊 ประวัติการเงิน ({transactions.length})
            </button>
            <button
              onClick={() => setActiveTab('bets')}
              className={`flex-1 py-3 border-b-2 text-center transition-all cursor-pointer ${
                activeTab === 'bets' ? 'border-sky-600 text-sky-700 bg-white font-black' : 'border-transparent hover:text-slate-700'
              }`}
            >
              ⏱️ รายการดวลบั้งไฟ ({bets.length})
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
