import React, { useState, useEffect, useRef } from 'react';
import { 
  MessageSquare, 
  User, 
  Send, 
  Upload, 
  CheckCircle, 
  AlertTriangle, 
  XCircle, 
  Rocket, 
  Layers, 
  Clock, 
  DollarSign, 
  Database,
  Users,
  Settings,
  HelpCircle,
  FileText,
  RefreshCw,
  ArrowRight,
  TrendingDown,
  TrendingUp,
  RotateCcw,
  Wifi,
  Battery,
  ShieldCheck,
  Zap,
  Info,
  Wallet,
  ShieldAlert
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

const ADMIN_PASSCODE = '1234';

export default function App() {
  const isGitHubPages = window.location.hostname.includes('github.io');
  const API_BASE_URL = isGitHubPages ? 'https://rocket-sci.onrender.com' : '';

  const runBackendFunction = async (functionName, args = []) => {
    const res = await fetch(`${API_BASE_URL}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionName, args }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Server error');
    return json.data;
  };

  // Security and Mode States
  const [playerUserId, setPlayerUserId] = useState(null);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [passcodeError, setPasscodeError] = useState('');

  // App States
  const [players, setPlayers] = useState(INITIAL_PLAYERS);
  const [transactions, setTransactions] = useState([]);
  const [bets, setBets] = useState([]);
  
  const [flights, setFlights] = useState([]);
  
  // Dashboard & Navigation controls (default to rocket telemetry first)
  const [lineChatType, setLineChatType] = useState('private'); // 'private' | 'group'
  const [adminTab, setAdminTab] = useState('rocket'); // 'rocket' | 'review' | 'players' | 'logs' | 'line'
  const [toasts, setToasts] = useState([]);

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
  
  // LINE billing session states
  const [billingStep, setBillingStep] = useState('idle');
  const [depositAmount, setDepositAmount] = useState(0);
  const [activeTxId, setActiveTxId] = useState(null);
  const [selectedPresetId, setSelectedPresetId] = useState(SLIP_PRESETS[0].id);
  const [customSlipAmount, setCustomSlipAmount] = useState(0);
  const [useCustomSlip, setUseCustomSlip] = useState(false);
  const [scannerLogs, setScannerLogs] = useState([]);
  const [billingResult, setBillingResult] = useState(null);

  // Private chat states
  const [myPrivateInput, setMyPrivateInput] = useState('');
  const [privateMessages, setPrivateMessages] = useState([
    { id: 'bot_welcome', sender: 'bot', text: '🏦 ยินดีต้อนรับสู่ระบบเติมทุนหลังบ้าน Rocket Science 🚀\n\nโอนเงินด้วยยอดที่ท่านเลือก และส่งสลิปที่มี QR code ระบบจะเติมเครดิตให้อัตโนมัติในสเกล 1:1 ครับ\n\nกรุณาเลือกบริการจากเมนูด้านล่าง หรือพิมพ์บอกเราได้เลยครับ\n(เช่น พิมพ์ "ฝากเงิน", "ถอนยอด" หรือ "เช็คยอด")', time: '13:00' }
  ]);

  // Real LINE OA chat states
  const [chatLogs, setChatLogs] = useState([]);
  const [selectedChatPlayerId, setSelectedChatPlayerId] = useState(null);
  const [adminChatInput, setAdminChatInput] = useState('');
  const liveChatEndRef = useRef(null);
  const liveChatContainerRef = useRef(null);
  
  // Group chat states (manual entries)
  const [groupMessages, setGroupMessages] = useState([]);
  const [myGroupInput, setMyGroupInput] = useState('');
  
  // Rocket telemetry states
  const [rocketFlightTime, setRocketFlightTime] = useState(0.00);
  const [rocketStatus, setRocketStatus] = useState('idle');
  const [rocketName, setRocketName] = useState(''); // Technician / Rocket Team Name (entered manually by admin)
  const [targetMin, setTargetMin] = useState(''); // Range Min (entered manually by admin)
  const [targetMax, setTargetMax] = useState(''); // Range Max (entered manually by admin)
  const [quoteBetAmount, setQuoteBetAmount] = useState(''); // Bet Amount (entered manually by admin)
  const [quoteIsChotoy, setQuoteIsChotoy] = useState(false);

  const handleBroadcastFastQuote = (overrideMin = null, overrideMax = null, overrideAmt = null, overrideChotoy = null) => {
    const min = overrideMin !== null ? overrideMin : targetMin;
    const max = overrideMax !== null ? overrideMax : targetMax;
    const amt = overrideAmt !== null ? overrideAmt : (quoteBetAmount || 500);
    const isChotoy = overrideChotoy !== null ? overrideChotoy : quoteIsChotoy;
    const name = rocketName.trim() || 'ช่างบั้งไฟสด';

    if (!min || !max || Number(min) >= Number(max)) {
      addToast('⚠️ กรุณากรอกช่วงราคาช่างให้ถูกต้อง (Min ต้องน้อยกว่า Max) ก่อนประกาศออกราคาครับ', 'warning');
      return;
    }

    if (Number(amt) <= 0) {
      addToast('⚠️ แต้มเดิมพันเริ่มต้นต้องมากกว่า 0 pt ครับ', 'warning');
      return;
    }

    const chotoyTag = isChotoy ? ' (ชตย)' : '';
    const quoteMsg = `🚀 เปิดรอบ ➔ ${name}\n⏱️  ราคาช่าง ${min}-${max}s\n💰 เครดิต ${amt}pt${chotoyTag}`;

    runBackendFunction('adminOpenRound', [name]);
    
    if (broadcastTargetGroup === 'ALL') {
      if (lineGroups && lineGroups.length > 0) {
        lineGroups.forEach(g => {
          runBackendFunction('sendAdminMessageToLine', [g.id, quoteMsg]);
        });
        addToast(`🚀 ประกาศราคาช่าง [${name}] (${min}-${max}s) กระจายทุกกลุ่ม (${lineGroups.length} กลุ่ม) เรียบร้อย!`, 'success');
      } else {
        runBackendFunction('sendAdminMessageToLine', [activeGroupId, quoteMsg]);
        addToast(`🚀 ประกาศราคาช่าง [${name}] (${min}-${max}s) เข้ากลุ่ม LINE เรียบร้อย!`, 'success');
      }
    } else {
      const targetObj = lineGroups.find(g => g.id === broadcastTargetGroup);
      const targetName = targetObj ? targetObj.name : `กลุ่ม (#${broadcastTargetGroup.slice(-4)})`;
      runBackendFunction('sendAdminMessageToLine', [broadcastTargetGroup, quoteMsg]);
      addToast(`🚀 ประกาศราคาช่าง [${name}] (${min}-${max}s) เข้า [${targetName}] เรียบร้อย!`, 'success');
    }
  };
  const [customRocketTime, setCustomRocketTime] = useState(''); // Manual entry by admin (blank default)
  const [flightLogs, setFlightLogs] = useState([]);
  const [settlementResult, setSettlementResult] = useState(null); // Settle results popup summary
  const [activeGroupId, setActiveGroupId] = useState(null); // Active connected LINE Group ID
  const [lineGroups, setLineGroups] = useState([]); // List of active connected LINE Groups
  const [chatTypeMode, setChatTypeMode] = useState('group'); // 'group' or 'private'
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('ALL'); // Multi-group filter
  const [broadcastTargetGroup, setBroadcastTargetGroup] = useState('ALL'); // Multi-group broadcast target
  
  const privateChatEndRef = useRef(null);
  const groupChatEndRef = useRef(null);
  const privateChatContainerRef = useRef(null);
  const groupChatContainerRef = useRef(null);

  // Parse URL query parameter userId on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const uid = urlParams.get('userId');
    if (uid) {
      // Normalize 'user' simulator ID to lowercase 'user' to prevent case-sensitive duplicate accounts
      const normalizedUid = uid.trim().toLowerCase() === 'user' ? 'user' : uid.trim();
      setPlayerUserId(normalizedUid);
    }
  }, []);

  // Detect Google Apps Script Environment
  const isGAS = typeof window !== 'undefined' && window.google && window.google.script && window.google.script.run;

  // Detect live Node.js Express backend (localhost, Render, Vercel, Railway, or custom host)
  const isLiveBackend = typeof window !== 'undefined' && !isGAS;

  // Unified live-data: GAS uses polling RPC; Node.js backend uses SSE for instant push
  useEffect(() => {
    const applyData = (data) => {
      if (!data) return;
      if (data.players) setPlayers(data.players);
      if (data.transactions) setTransactions(data.transactions);
      if (data.bets) setBets(data.bets);
      if (data.chatLogs) setChatLogs(data.chatLogs);
      if (data.activeGroupId) setActiveGroupId(data.activeGroupId);
      if (data.lineGroups && data.lineGroups.length > 0) {
        setLineGroups(data.lineGroups);
      } else if (data.activeGroupId) {
        setLineGroups([{ id: data.activeGroupId, name: `🚀 กลุ่มดวลสด LINE (#${data.activeGroupId.slice(-4)})`, lastMessage: 'เชื่อมต่อสำเร็จ', timestamp: 'Live' }]);
      }
    };

    if (isGAS) {
      // GAS-hosted: use google.script.run RPC (SSE not available in GAS)
      const fetchGAS = () => {
        window.google.script.run
          .withSuccessHandler(applyData)
          .getDashboardData();
      };
      fetchGAS();
      const interval = setInterval(fetchGAS, 3000);
      return () => clearInterval(interval);

    } else if (isLiveBackend) {
      // Node.js server (Render / Local / GitHub Pages): use SSE for zero-delay real-time push from server
      let es;
      let reconnectTimer;

      const connect = () => {
        es = new EventSource(`${API_BASE_URL}/api/events`);

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            applyData(data);
          } catch (_) {}
        };

        es.onerror = () => {
          // SSE connection dropped — close and reconnect after 3s
          es.close();
          reconnectTimer = setTimeout(connect, 3000);
        };
      };

      connect();

      return () => {
        if (es) es.close();
        if (reconnectTimer) clearTimeout(reconnectTimer);
      };
    }
  }, [isGAS, isLiveBackend]);

  // Auto scroll chats inside container without moving the browser viewport
  useEffect(() => {
    if (privateChatContainerRef.current) {
      privateChatContainerRef.current.scrollTop = privateChatContainerRef.current.scrollHeight;
    }
  }, [billingStep, scannerLogs, privateMessages]);

  useEffect(() => {
    if (groupChatContainerRef.current) {
      groupChatContainerRef.current.scrollTop = groupChatContainerRef.current.scrollHeight;
    }
  }, [bets, groupMessages]);

  useEffect(() => {
    if (liveChatContainerRef.current) {
      liveChatContainerRef.current.scrollTop = liveChatContainerRef.current.scrollHeight;
    }
  }, [chatLogs, selectedChatPlayerId]);

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
    
    setRocketStatus('idle');
    setRocketFlightTime(0.00);
    setSettlementResult(null);
    setRocketName('');
    addToast('🔒 ปิดและรีเซ็ตพอร์ทัลรอบปัจจุบันเรียบร้อย (รักษาข้อมูลผู้เล่นและธุรกรรมครบถ้วน 100%)', 'info');
  };

  // Expose reset state for debug button (preventing reference error)
  const resetConsoleState = () => {
    if (!window.confirm("⚠️ คุณต้องการล้างระเบียนข้อมูลระบบทั้งหมดใช่หรือไม่?\n\nการกระทำนี้จะล้างข้อมูลผู้เล่น ธุรกรรม ประวัติการเดิมพัน และบันทึกแชททั้งหมดใน Google Sheets ให้กลับสู่ค่าเริ่มต้น")) {
      return;
    }
    
    setRocketStatus('idle');
    setRocketFlightTime(0.00);
    setSettlementResult(null);

    window.google.script.run
      .withSuccessHandler((data) => {
        if (data) {
          if (data.players) setPlayers(data.players);
          if (data.transactions) setTransactions(data.transactions);
          if (data.bets) setBets(data.bets);
          if (data.chatLogs) setChatLogs(data.chatLogs);
          if (data.activeGroupId) setActiveGroupId(data.activeGroupId);
          if (data.lineGroups && data.lineGroups.length > 0) {
            setLineGroups(data.lineGroups);
          } else if (data.activeGroupId) {
            setLineGroups([{ id: data.activeGroupId, name: `🚀 กลุ่มดวลสด LINE (#${data.activeGroupId.slice(-4)})`, lastMessage: 'เชื่อมต่อสำเร็จ', timestamp: 'Live' }]);
          }
        }
        addToast('ล้างระเบียนข้อมูลระบบสำเร็จแล้ว', 'success');
      })
      .withFailureHandler((err) => {
        console.error("Failed to reset database:", err);
        addToast('เกิดข้อผิดพลาดในการล้างระเบียนระบบ: ' + (err.message || err), 'error');
      })
      .resetGoogleSheetsDatabase();
  };
  
  // Attach resetConsoleState to window context for global call safety
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.resetConsoleState = resetConsoleState;
      window.handleClosePortal = handleClosePortal;
    }
  }, []);

  // Process private chat messages via interactive bot simulation
  const handleSendPrivateMessage = (customText = null) => {
    const textToSend = customText !== null ? customText : myPrivateInput;
    if (!textToSend.toString().trim()) return;

    if (customText === null) {
      setMyPrivateInput('');
    }

    const tStr = new Date().toLocaleTimeString().slice(0, 5);
    const userMsgId = 'user_msg_' + Date.now();
    
    // Add user message to chat history
    setPrivateMessages(prev => [...prev, {
      id: userMsgId,
      sender: 'user',
      text: textToSend.toString(),
      time: tStr
    }]);

    // Bot reply logic simulation
    setTimeout(() => {
      const clean = textToSend.toString().replace(/\s+/g, '').toLowerCase();
      const botTime = new Date().toLocaleTimeString().slice(0, 5);
      const botMsgId = 'bot_msg_' + Date.now();

      // 1. CHECK BALANCE ("เช็คยอด", "คงเหลือ", "balance")
      if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
        const userBal = players.find(p => p.isUser)?.balance || 0;
        setPrivateMessages(prev => [...prev, {
          id: botMsgId,
          sender: 'bot',
          text: `💳 ยอดเครดิตคงเหลือของคุณ:\n\n👤 ผู้เล่น: คุณ (You)\n💰 คงเหลือ: ${userBal.toFixed(2)} แต้ม`,
          time: botTime
        }]);
        return;
      }

      // 2. LIST ACTIVE DEALS ("รายการจับคู่", "matched", "รายการดวล")
      if (clean === 'รายการจับคู่' || clean === 'matched' || clean === 'รายการดวล') {
        const activeBets = bets.filter(b => (b.playerLowId === 'user' || b.playerHighId === 'user') && (b.status === 'matched' || b.status === 'pending_match'));
        if (activeBets.length === 0) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `📝 รายการดวลของคุณ:\n\n❌ ปัจจุบันไม่มีแผลดวลค้างหรือรอคู่ในระบบครับ`,
            time: botTime
          }]);
        } else {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId + '_header',
            sender: 'bot',
            text: `📝 พบแผลดวลของคุณในระบบ ${activeBets.length} รายการ:`,
            time: botTime
          }]);
          
          activeBets.forEach((b, idx) => {
            const sideText = b.playerLowId === 'user' ? 'ต่ำ (Low)' : 'สูง (High)';
            const opponent = b.playerLowId === 'user' ? b.playerHighName : b.playerLowName;
            const statusText = b.status === 'matched' ? 'ดวลกันอยู่ ☄️' : 'รอคู่ดวล ⏳';
            setPrivateMessages(prev => [...prev, {
              id: `${botMsgId}_card_${b.orderNumber}`,
              sender: 'bot',
              isMatchCard: true,
              betData: {
                orderNumber: b.orderNumber,
                amount: b.amount,
                side: sideText,
                opponent: opponent || 'รอคู่...',
                status: b.status,
                statusText: statusText
              },
              time: botTime
            }]);
          });
        }
        return;
      }

      // 3. CANCEL DEAL ("ยกเลิก [orderNo]")
      const cancelRegex = /^(ยกเลิก|cancel)(?:order|#)?(\d+)$/;
      if (cancelRegex.test(clean)) {
        const orderNo = clean.match(cancelRegex)[2];
        const targetBet = bets.find(b => b.orderNumber === orderNo);
        if (!targetBet) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ ไม่พบเลขแผลดวล Order #${orderNo} ในระบบครับ`,
            time: botTime
          }]);
          return;
        }

        const isLowMe = targetBet.playerLowId === 'user';
        const isHighMe = targetBet.playerHighId === 'user';
        if (!isLowMe && !isHighMe) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ ขออภัยครับ แผลดวลนี้ไม่ใช่แผลดวลของคุณ จึงไม่สามารถกดยกเลิกได้`,
            time: botTime
          }]);
          return;
        }

        if (targetBet.status === 'pending_match') {
          // Direct refund and cancel in sandbox
          setBets(prev => prev.map(b => b.orderNumber === orderNo ? { ...b, status: 'cancelled' } : b));
          setPlayers(prev => prev.map(p => p.isUser ? { ...p, balance: p.balance + targetBet.amount } : p));
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ ยกเลิกแผล Order #${orderNo} สำเร็จ!`,
            time: botTime
          }]);
        } else if (targetBet.status === 'matched') {
          // Request cancellation (pending cancel)
          setBets(prev => prev.map(b => b.orderNumber === orderNo ? { ...b, status: 'pending_cancel' } : b));
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `⚠️ ส่งคำร้องขอยกเลิกแผล Order #${orderNo} สำเร็จ!\n\nเนื่องจากแผลถูกจับคู่แล้ว ต้องรอฝั่งตรงข้ามตอบรับคำขอคำขอยกเลิกแผลนี้ครับ`,
            time: botTime
          }]);
        } else {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `⚠️ แผลดวลนี้จบหรือยกเลิกไปแล้ว ไม่สามารถยกเลิกซ้ำได้ครับ`,
            time: botTime
          }]);
        }
        return;
      }

      // 4. INITIATE DEPOSIT ("ฝากเงิน", "เติมเงิน", "deposit", "เติมเครดิต")
      if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit' || clean === 'เติมเครดิต') {
        setBillingStep('input_amount');
        setPrivateMessages(prev => [...prev, {
          id: botMsgId,
          sender: 'bot',
          text: `💰 ขั้นตอนการฝากเครดิต (สเกล 1:1)\n\nกรุณากดเลือกยอดเงินที่ต้องการฝาก หรือพิมพ์ระบุจำนวนเงินที่ต้องการฝากเพื่อรับเลขที่บัญชีรับเงินได้เลยครับ:`,
          time: botTime
        }]);
        return;
      }

      // 5. INITIATE WITHDRAWAL ("ถอนเงิน", "ถอนยอด", "withdraw")
      if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
        const userPlayer = players.find(p => p.isUser);
        const registeredBank = userPlayer?.bankName;
        if (!registeredBank) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ ไม่พบประวัติการฝากเงินผ่านระบบ!\n\nเพื่อความปลอดภัยสูงสุด ระบบกำหนดให้บัญชีถอนเงินต้องตรงกับบัญชีที่ฝากเงินเข้ามาครั้งแรกเท่านั้น\n\nกรุณาทำรายการฝากเงินเข้ามาก่อนเพื่อลงทะเบียนบัญชีธนาคารครับ`,
            time: botTime
          }]);
        } else {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `💸 บัญชีธนาคารสำหรับโอนเงินคืนของคุณคือ:\n\n🏦 ธนาคาร: ${userPlayer.bankName}\n🔢 เลขบัญชี: ${userPlayer.bankAccount}\n👤 ชื่อบัญชี: ${userPlayer.accountName}\n\n💰 เครดิตคงเหลือ: ${userPlayer.balance} แต้ม\n\n💡 กรุณาพิมพ์จำนวนแต้มที่ต้องการถอนในช่องแชท:\n👉 เช่น พิมพ์ "ถอน 500" หรือ "ถอน ${Math.min(userPlayer.balance, 1000)}"`,
            time: botTime
          }]);
        }
        return;
      }

      // 6. PROCESS WITHDRAWAL REQUEST ("ถอน [amount]")
      const withdrawRegex = /^(ถอน|withdraw)(\d+)$/;
      if (withdrawRegex.test(clean)) {
        const withdrawAmt = parseInt(clean.match(withdrawRegex)[2]);
        const userPlayer = players.find(p => p.isUser);
        if (!userPlayer || !userPlayer.bankName) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ ขออภัยครับ ไม่พบข้อมูลบัญชีธนาคารสำหรับถอนเงิน (ต้องใช้บัญชีเดียวกับที่ฝากเงินเข้ามาในครั้งแรก)`,
            time: botTime
          }]);
          return;
        }

        if (withdrawAmt <= 0) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ จำนวนเงินถอนต้องมากกว่า 0 แต้มครับ`,
            time: botTime
          }]);
          return;
        }

        if (userPlayer.balance < withdrawAmt) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `❌ เครดิตคงเหลือไม่เพียงพอสำหรับถอนเงินจำนวนนี้!\n\nยอดเงินคงเหลือของคุณ: ${userPlayer.balance} แต้ม\nต้องการถอน: ${withdrawAmt} แต้ม`,
            time: botTime
          }]);
          return;
        }

        // Deduct balance and create WD transaction
        const txId = 'WD' + Math.floor(Math.random() * 89999 + 10000);
        setPlayers(prev => prev.map(p => p.isUser ? { ...p, balance: p.balance - withdrawAmt } : p));
        
        const newTx = {
          id: txId,
          playerId: 'user',
          playerName: 'คุณ (You)',
          requestedAmount: withdrawAmt,
          actualAmount: 0,
          slipRef: '',
          status: 'escalated',
          reviewReason: `Withdrawal request to ${userPlayer.bankName} ${userPlayer.bankAccount} ${userPlayer.accountName}`,
          timestamp: new Date().toLocaleTimeString(),
          logs: ['Withdrawal requested by user via LINE OA', 'Deducted balance and waiting for manual approve']
        };
        setTransactions(prev => [newTx, ...prev]);

        // Send to Google Sheets if running inside GAS
        if (isGAS) {
          window.google.script.run
            .withSuccessHandler(() => {
              addToast('ส่งคำขอถอนเงินสำเร็จ! รอแอดมินดำเนินการโอนเงิน', 'info');
            })
            .logTransaction('user', 'คุณ (You)', withdrawAmt, 0, 'PENDING_WITHDRAW', 'escalated', `Withdrawal request to ${userPlayer.bankName} ${userPlayer.bankAccount} ${userPlayer.accountName}`);
        }

        setPrivateMessages(prev => [...prev, {
          id: botMsgId,
          sender: 'bot',
          text: `📥 บันทึกคำขอถอนเงินจำนวน ${withdrawAmt} แต้ม เรียบร้อยแล้วครับ!\n\nระบบกำลังส่งต่อข้อมูลให้แอดมินพิจารณาอนุมัติโอนเงินแบบแมนนวลเข้าบัญชีธนาคาร ${userPlayer.bankName} เลขบัญชี ${userPlayer.bankAccount} ของคุณครับ\n\nยอดคงเหลือหลังทำรายการ: ${userPlayer.balance - withdrawAmt} แต้ม`,
          time: botTime
        }]);
        return;
      }

      // 7. PROCESS DEPOSIT AMOUNT REQUEST (pure numbers or "ฝาก [amount]")
      const pureNumRegex = /^\d+$/;
      const depositTextRegex = /^(ฝาก|ฝากเงิน|เติม|เติมเงิน)(\d+)$/;
      let depositAmt = null;

      if (pureNumRegex.test(clean)) {
        depositAmt = parseInt(clean);
      } else if (depositTextRegex.test(clean)) {
        depositAmt = parseInt(clean.match(depositTextRegex)[2]);
      }

      if (depositAmt !== null) {
        if (depositAmt < 100 || depositAmt > 10000) {
          setPrivateMessages(prev => [...prev, {
            id: botMsgId,
            sender: 'bot',
            text: `⚠️ ขออภัยครับ ระบบรองรับการฝากยอดขั้นต่ำ 100 THB และสูงสุดไม่เกิน 10,000 THB ต่อครั้งครับ`,
            time: botTime
          }]);
          return;
        }

        // Trigger deposit selection flow
        setDepositAmount(depositAmt);
        setCustomSlipAmount(depositAmt);
        setBillingStep('waiting_deposit');
        setBillingResult(null);

        const txId = 'TX' + Math.floor(Math.random() * 89999 + 10000);
        setActiveTxId(txId);

        const newTx = {
          id: txId,
          playerId: 'user',
          playerName: 'คุณ (You)',
          requestedAmount: depositAmt,
          actualAmount: 0,
          slipRef: '',
          status: 'escalated',
          reviewReason: 'Waiting for user to upload pay slip',
          timestamp: new Date().toLocaleTimeString(),
          logs: ['Initial deposit order session started']
        };
        setTransactions(prev => [newTx, ...prev]);

        // Send to Google Sheets if running inside GAS
        if (isGAS) {
          window.google.script.run
            .withSuccessHandler(() => {
              addToast('ส่งคำสั่งฝากเงินสำเร็จ! กรุณาโอนเงินและส่งสลิป', 'info');
            })
            .logTransaction('user', 'คุณ (You)', depositAmt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
        }

        // Send the invoice card
        setPrivateMessages(prev => [...prev, {
          id: botMsgId,
          sender: 'bot',
          isInvoice: true,
          amount: depositAmt,
          time: botTime
        }]);
        return;
      }

      // Default fallback
      setPrivateMessages(prev => [...prev, {
        id: botMsgId,
        sender: 'bot',
        text: `🤖 ไม่เข้าใจคำสั่ง บันทึกข้อมูลแล้ว แอดมินจะติดต่อกลับครับ 💬 (พิมพ์ "เมนู" ดูคำสั่ง 🚀)`,
        time: botTime
      }]);

    }, 400);
  };

  // Compile dynamic group messages combining seed values, user messages, and actual bets dynamically
  const getCompiledGroupMessages = () => {
    const msgs = [
      { id: 'seed_1', sender: 'อาร์ต (Art)', text: 'ชล200 🚀', time: '12:25', avatar: '🦅' },
      { id: 'seed_2', sender: 'เบนซ์ (Benz)', text: 'ต ✅', replyTo: 'ชล200 🚀', time: '12:26', avatar: '🐯' },
      { id: 'seed_3', sender: 'เจ๋ง (Jeng)', text: '30-70ถ500 📈', time: '12:26', avatar: '🦁' },
      { id: 'seed_4', sender: 'วชิระ ส. (โบ๊ท)', text: 'ต ✅', replyTo: '30-70ถ500 📈', time: '12:28', avatar: '🐉' }
    ];

    // Filter local manual simulator/user message inputs to remove raw betting commands (handled dynamically by bets compiler)
    const filteredCustom = groupMessages.filter(msg => {
      const cleanMsg = msg.text.replace(/\s+/g, '').toLowerCase();
      const isBetCmd = /^(ชล|ล|ไล่|ชย|ชถ|ย|ถ|ถอย|ต|ติด|ครับ|เค|จ้า|\d+-\d+[ลถ])\d*$/.test(cleanMsg);
      if (isBetCmd) return false;
      
      if (msg.sender === 'ระบบบอทดูด 🚀') {
        if (msg.text.includes('จับคู่สำเร็จ') || msg.text.includes('สรุปผล Order') || msg.text.includes('ยกเลิกดีลสำเร็จ') || msg.text.includes('ร้องขอยกเลิกแผล')) {
          return false;
        }
      }
      return true;
    });
    
    // Add non-bet messages
    msgs.push(...filteredCustom);

    // Generate messages from actual Sheet database bets dynamically
    const sortedBets = [...bets];
    sortedBets.forEach(b => {
      if (b.orderNumber === '289276') return; // Skip seed representation
      
      const timestampStr = b.timestamp ? String(b.timestamp) : '';
      const t = timestampStr ? timestampStr.split(' ')[1] || timestampStr : '12:30';
      
      // 1. Creation message
      let creatorName = '';
      let creatorText = '';
      let creatorAvatar = '👤';
      
      if (b.type === 'range') {
        const sideText = b.playerLowId ? 'ล' : 'ถ';
        creatorText = `${b.rangeMin}-${b.rangeMax}${sideText}${b.amount} 🚀`;
        creatorName = b.playerLowId ? b.playerLowName : b.playerHighName;
      } else {
        const prefix = b.playerLowId ? 'ชล' : 'ชย';
        creatorText = `${prefix}${b.amount} 🚀`;
        creatorName = b.playerLowId ? b.playerLowName : b.playerHighName;
      }
      
      const creatorPlayer = players.find(p => p.name === creatorName);
      if (creatorPlayer) creatorAvatar = creatorPlayer.avatar;
      
      if (creatorName) {
        msgs.push({
          id: `bet_create_${b.orderNumber}`,
          sender: creatorName,
          avatar: creatorAvatar,
          text: creatorText,
          time: t
        });
      }
      
      // 2. Match messages
      if (b.status === 'matched' || b.status === 'resolved') {
        // Matcher is the side that was NOT populated originally by creator
        const isLowCreator = (b.type === 'range' && b.playerLowId && b.playerLowId !== 'user') || 
                             (b.type === 'high_low' && b.playerLowId && b.playerLowId !== 'user' && b.playerLowName !== 'คุณ (You)');
        const matcherName = isLowCreator ? b.playerHighName : b.playerLowName;

        let matcherAvatar = '👤';
        const matcherPlayer = players.find(p => p.name === matcherName);
        if (matcherPlayer) matcherAvatar = matcherPlayer.avatar;
        
        if (matcherName) {
          msgs.push({
            id: `bet_match_agree_${b.orderNumber}`,
            sender: matcherName,
            avatar: matcherAvatar,
            text: 'ต ✅',
            time: t
          });
          
          msgs.push({
            id: `bet_match_sys_${b.orderNumber}`,
            sender: 'ระบบบอทดูด 🚀',
            text: `✅ จับคู่สำเร็จ! (Order #${b.orderNumber})\nยอดดวล: ${b.amount} แต้ม\nฝั่งต่ำ (Low): ${b.playerLowName}\nฝั่งสูง (High): ${b.playerHighName}\nสถานะ: ล็อกเครดิตเรียบร้อย รอออกผลจรวด ☄️`,
            time: t
          });
        }
      }
      
      // 3. Pending Cancel representation
      if (b.status === 'pending_cancel') {
        msgs.push({
          id: `bet_pending_cancel_${b.orderNumber}`,
          sender: 'ระบบบอทดูด 🚀',
          text: `⚠️ ร้องขอยกเลิกแผล! Order #${b.orderNumber}\n\nรอการยืนยันยกเลิกจากคู่ฝ่ายตรงข้าม...`,
          time: t
        });
      }
      
      // 4. Cancel representation
      if (b.status === 'cancelled') {
        msgs.push({
          id: `bet_cancel_sys_${b.orderNumber}`,
          sender: 'ระบบบอทดูด 🚀',
          text: `❌ ยกเลิกดีลสำเร็จ! (Order #${b.orderNumber})\nคืนยอดเครดิตเข้าบัญชีของทั้งคู่เรียบร้อย`,
          time: t
        });
      }
      
      // 5. Settle message
      if (b.status === 'resolved') {
        const finalTimeVal = b.finalFlightTime || rocketFlightTime;
        const isLowWinner = b.winnerName === b.playerLowName;
        msgs.push({
          id: `bet_resolve_${b.orderNumber}`,
          sender: 'ระบบบอทดูด 🚀',
          text: `🔔 สรุปผล Order #${b.orderNumber}\nเกณฑ์ออก: ${finalTimeVal} วินาที\nฝั่งชนะ: ${isLowWinner ? 'ต่ำ (Low)' : 'สูง (High)'} (${b.winnerName})\n💰 ยอดโอนเข้าบัญชี: +${Math.round(b.amount * 1.90)} แต้ม (หักค่าตง 10% เรียบร้อย)`,
          time: t
        });
      }
    });

    return msgs;
  };

  // Trigger deposit process selection
  const handleSelectAmount = (amt) => {
    setDepositAmount(amt);
    setCustomSlipAmount(amt);
    setBillingStep('waiting_deposit');
    setBillingResult(null);
    
    const txId = 'TX' + Math.floor(Math.random() * 89999 + 10000);
    setActiveTxId(txId);

    // Sandbox transaction creation
    const newTx = {
      id: txId,
      playerId: 'user',
      playerName: 'คุณ (You)',
      requestedAmount: amt,
      actualAmount: 0,
      slipRef: '',
      status: 'escalated',
      reviewReason: 'Waiting for user to upload pay slip',
      timestamp: new Date().toLocaleTimeString(),
      logs: ['Initial deposit order session started']
    };
    setTransactions(prev => [newTx, ...prev]);

    // Send to Google Sheets if running inside GAS
    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          addToast('ส่งคำสั่งฝากเงินสำเร็จ! กรุณาโอนเงินและส่งสลิป', 'info');
        })
        .logTransaction('user', 'คุณ (You)', amt, 0, 'PENDING_SLIP', 'escalated', 'Waiting for user to upload pay slip');
    }

    // Append user selection and invoice card to private chat
    const tStr = new Date().toLocaleTimeString().slice(0, 5);
    setPrivateMessages(prev => [
      ...prev,
      { id: 'user_amt_' + Date.now(), sender: 'user', text: `ฝากเงินจำนวน ${amt} บาท`, time: tStr },
      { id: 'bot_invoice_' + Date.now(), sender: 'bot', isInvoice: true, amount: amt, time: tStr }
    ]);
  };

  // Slip upload simulation handler
  const handleUploadPaySlip = () => {
    if (billingStep !== 'waiting_deposit') return;

    setBillingStep('scanning');
    setScannerLogs([
      'Retrieving uploaded image bytes from LINE CDN...',
      'Running image scaling filter...',
      'Initializing EMVCo barcode scanner...',
      'QR Code found! Decoding raw payload...'
    ]);

    const tStr = new Date().toLocaleTimeString().slice(0, 5);
    // Append slip and scanning messages to chat
    setPrivateMessages(prev => [
      ...prev,
      {
        id: 'user_slip_' + Date.now(),
        sender: 'user',
        isSlip: true,
        presetId: selectedPresetId,
        useCustom: useCustomSlip,
        customAmount: customSlipAmount,
        time: tStr
      },
      {
        id: 'bot_scanning_' + Date.now(),
        sender: 'bot',
        isScanning: true,
        time: tStr
      }
    ]);

    setTimeout(() => {
      setScannerLogs(prev => [...prev, 'Payload decoded: 00020101021230380016...']);
      
      setTimeout(() => {
        setScannerLogs(prev => [...prev, 'Youtransfer API verification triggered...']);
        
        setTimeout(() => {
          const preset = SLIP_PRESETS.find(p => p.id === selectedPresetId);
          const realAmt = useCustomSlip ? customSlipAmount : (preset ? preset.actualAmount : 100);
          const isQRValid = useCustomSlip ? true : (preset ? preset.isValidQR : true);
          const isDupe = useCustomSlip ? false : (preset ? preset.isDuplicate : false);
          const ref = useCustomSlip ? 'CUSTX' + Date.now().toString().slice(-4) : (preset ? preset.refCode : 'MOCKREF');

          const presetBankName = preset ? (preset.bankName.includes('SCB') ? 'SCB' : preset.bankName.includes('KBANK') ? 'KBANK' : preset.bankName.includes('BBL') ? 'BBL' : 'KTB') : 'SCB';
          const presetAccountNo = '064-2-35656-6';

          const tDoneStr = new Date().toLocaleTimeString().slice(0, 5);

          // GAS Integration call
          if (isGAS) {
            window.google.script.run
              .withSuccessHandler((res) => {
                if (res && res.status === 'success') {
                  setBillingResult({ status: 'success', amount: realAmt });
                  setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'success', actualAmount: realAmt, slipRef: ref, reviewReason: 'Auto verified via slip API 1:1' } : t));
                  setPlayers(prev => prev.map(p => p.isUser ? { 
                    ...p, 
                    balance: p.balance + realAmt,
                    bankName: presetBankName,
                    bankAccount: presetAccountNo,
                    accountName: p.name
                  } : p));
                  addToast('เติมเงินสำเร็จ! สแกนตรวจสอบ 1:1 เรียบร้อย', 'success');

                  // Append success message
                  setPrivateMessages(prev => {
                    const filtered = prev.filter(m => !m.isScanning);
                    return [...filtered, {
                      id: 'bot_success_' + Date.now(),
                      sender: 'bot',
                      text: `🎉 อัปโหลดสำเร็จ!\n\nระบบสแกนสลิป ตรวจสอบ API พบยอดเงินโอน ${realAmt}.00 บาท ตรงกับบัญชีธนาคาร\n\n💰 บัญชีเครดิตของท่านได้รับการเติมเครดิต 1:1 เรียบร้อยแล้ว!\nเครดิตคงเหลือ: ${(players.find(p => p.isUser)?.balance || 0) + realAmt} แต้ม`,
                      time: tDoneStr
                    }];
                  });

                } else {
                  const resReason = res ? res.reason : 'สลิปไม่ผ่านเกณฑ์การตรวจออโต้';
                  setBillingResult({ status: 'escalate', reason: resReason });
                  setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'escalated', actualAmount: realAmt, slipRef: ref, reviewReason: resReason } : t));
                  addToast('บิลตรวจสอบไม่ผ่าน ส่งเรื่องให้แอดมินแมนนวลแล้ว', 'warning');

                  // Append escalated message
                  setPrivateMessages(prev => {
                    const filtered = prev.filter(m => !m.isScanning);
                    return [...filtered, {
                      id: 'bot_escalate_' + Date.now(),
                      sender: 'bot',
                      text: `⚠️ ดำเนินการออโต้ล้มเหลว!\n\nสาเหตุ: ${resReason}\n\nรายการได้รับการส่งต่อให้ แอดมิน (Manual Admin Review) เพื่ออนุมัติแมนนวลแล้วหลังจากเช็คธนาคาร\n\nกรุณารอสักครู่ แอดมินจะอัพยอดให้ท่านโดยเร็วที่สุดครับ`,
                      time: tDoneStr
                    }];
                  });
                }
                setBillingStep('completed');
              })
              .verifyMockSlipFromClient(depositAmount, realAmt, ref, isQRValid, isDupe);
          } else {
            // Sandbox logic
            if (!isQRValid) {
              const resReason = 'สแกนคิวอาร์โค้ดล้มเหลว (Unreadable QR Code)';
              setBillingResult({ status: 'escalate', reason: resReason });
              setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'escalated', actualAmount: 0, slipRef: 'ERR_NO_QR', reviewReason: 'QR Scan Failed' } : t));
              addToast('แจ้งเตือนแอดมิน: ตรวจสอบสลิปชำรุด!', 'warning');

              setPrivateMessages(prev => {
                const filtered = prev.filter(m => !m.isScanning);
                return [...filtered, {
                  id: 'bot_escalate_' + Date.now(),
                  sender: 'bot',
                  text: `⚠️ ดำเนินการออโต้ล้มเหลว!\n\nสาเหตุ: ${resReason}\n\nรายการได้รับการส่งต่อให้ แอดมิน (Manual Admin Review) เพื่ออนุมัติแมนนวลแล้วหลังจากเช็คธนาคาร\n\nกรุณารอสักครู่ แอดมินจะอัพยอดให้ท่านโดยเร็วที่สุดครับ`,
                  time: tDoneStr
                }];
              });

            } else if (isDupe) {
              const resReason = 'ตรวจพบการโอนเงินซ้ำซ้อน (Duplicate Slip Submission)';
              setBillingResult({ status: 'escalate', reason: resReason });
              setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'escalated', actualAmount: realAmt, slipRef: ref, reviewReason: 'Duplicate Transaction Ref' } : t));
              addToast('แจ้งเตือนแอดมิน: ตรวจพบสลิปโอนซ้ำ!', 'danger');

              setPrivateMessages(prev => {
                const filtered = prev.filter(m => !m.isScanning);
                return [...filtered, {
                  id: 'bot_escalate_' + Date.now(),
                  sender: 'bot',
                  text: `⚠️ ดำเนินการออโต้ล้มเหลว!\n\nสาเหตุ: ${resReason}\n\nรายการได้รับการส่งต่อให้ แอดมิน (Manual Admin Review) เพื่ออนุมัติแมนนวลแล้วหลังจากเช็คธนาคาร\n\nกรุณารอสักครู่ แอดมินจะอัพยอดให้ท่านโดยเร็วที่สุดครับ`,
                  time: tDoneStr
                }];
              });

            } else if (realAmt !== depositAmount) {
              const resReason = `ยอดเงินโอนสลิปไม่ตรงบิลแจ้ง (ยอดสั่ง ${depositAmount} pt, ยอดโอนจริง ${realAmt} THB)`;
              setBillingResult({ status: 'escalate', reason: resReason });
              setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'escalated', actualAmount: realAmt, slipRef: ref, reviewReason: `Amount Mismatch (${depositAmount} vs ${realAmt})` } : t));
              addToast('แจ้งเตือนแอดมิน: ยอดเงินไม่ตรงกับสลิปโอน!', 'warning');

              setPrivateMessages(prev => {
                const filtered = prev.filter(m => !m.isScanning);
                return [...filtered, {
                  id: 'bot_escalate_' + Date.now(),
                  sender: 'bot',
                  text: `⚠️ ดำเนินการออโต้ล้มเหลว!\n\nสาเหตุ: ${resReason}\n\nรายการได้รับการส่งต่อให้ แอดมิน (Manual Admin Review) เพื่ออนุมัติแมนนวลแล้วหลังจากเช็คธนาคาร\n\nกรุณารอสักครู่ แอดมินจะอัพยอดให้ท่านโดยเร็วที่สุดครับ`,
                  time: tDoneStr
                }];
              });

            } else {
              setBillingResult({ status: 'success', amount: realAmt });
              setTransactions(prev => prev.map(t => t.id === activeTxId ? { ...t, status: 'success', actualAmount: realAmt, slipRef: ref, reviewReason: 'Auto verified 1:1' } : t));
              setPlayers(prev => prev.map(p => p.isUser ? { 
                ...p, 
                balance: p.balance + realAmt,
                bankName: presetBankName,
                bankAccount: presetAccountNo,
                accountName: p.name
              } : p));
              addToast('เติมเงินสำเร็จ! เครดิตอัพเดท 1:1 เรียบร้อย', 'success');

              setPrivateMessages(prev => {
                const filtered = prev.filter(m => !m.isScanning);
                return [...filtered, {
                  id: 'bot_success_' + Date.now(),
                  sender: 'bot',
                  text: `🎉 อัปโหลดสำเร็จ!\n\nระบบสแกนสลิป ตรวจสอบ API พบยอดเงินโอน ${realAmt}.00 บาท ตรงกับบัญชีธนาคาร\n\n💰 บัญชีเครดิตของท่านได้รับการเติมเครดิต 1:1 เรียบร้อยแล้ว!\nเครดิตคงเหลือ: ${(players.find(p => p.isUser)?.balance || 0) + realAmt} แต้ม`,
                  time: tDoneStr
                }];
              });
            }
            setBillingStep('completed');
          }
        }, 1000);
      }, 800);
    }, 800);
  };

  const handleResetBilling = () => {
    setBillingStep('idle');
    setBillingResult(null);
    setScannerLogs([]);
    setPrivateMessages([
      { id: 'bot_welcome', sender: 'bot', text: '🏦 ยินดีต้อนรับสู่ระบบเติมทุนหลังบ้าน Rocket Science 🚀\n\nโอนเงินด้วยยอดที่ท่านเลือก และส่งสลิปที่มี QR code ระบบจะเติมเครดิตให้อัตโนมัติในสเกล 1:1 ครับ\n\nกรุณาเลือกบริการจากเมนูด้านล่าง หรือพิมพ์บอกเราได้เลยครับ\n(เช่น พิมพ์ "ฝากเงิน", "ถอนยอด" หรือ "เช็คยอด")', time: '13:00' }
    ]);
  };

  // Send message inside simulated LINE Group chat
  const handleSendGroupMessage = () => {
    if (!myGroupInput.trim()) return;
    const text = myGroupInput;
    setMyGroupInput('');
    
    // Add user message
    setGroupMessages(prev => [...prev, {
      id: Date.now(),
      sender: 'คุณ (You)',
      avatar: '👨‍🚀',
      text: text,
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    }]);

    // Process betting command locally (simulation fallback)
    processGroupBetCommand(text);

    // Send command to backend server and sync order card to LINE group chat
    runBackendFunction('simulateTextMessageFromDashboard', [text, 'user', 'คุณ (You)', activeGroupId]);
    addToast('ส่งคำสั่งไปที่ระบบบิลลิงส์แล้ว กำลังดำเนินการดวล...', 'info');
  };

  // Send admin chat message to LINE user from GAS console
  const handleSendAdminChatMessage = (overrideText = null) => {
    const text = overrideText !== null ? overrideText : adminChatInput;
    if (!text.trim() || !selectedChatPlayerId) return;
    
    if (overrideText === null) {
      setAdminChatInput('');
    }
    
    const tStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    
    // Add locally to chat logs for instant UI feedback
    const cleanText = text.replace(/\s+/g, '').toLowerCase();
    const isFlexKeyword = ['เช็คยอด', 'คงเหลือ', 'balance', 'ฝากเงิน', 'เติมเงิน', 'deposit', 'ถอนเงิน', 'ถอนยอด', 'withdraw', 'เมนู', 'menu', 'เริ่ม', 'start'].includes(cleanText);
    const newLog = {
      timestamp: tStr,
      userId: selectedChatPlayerId,
      displayName: players.find(p => p.id === selectedChatPlayerId)?.name || 'ผู้เล่น',
      sender: 'admin',
      text: isFlexKeyword ? `[Flex Message: ${text}]` : text,
      type: 'text'
    };
    setChatLogs(prev => [...prev, newLog]);
    
    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          addToast('ส่งข้อความไปยัง LINE ผู้เล่นสำเร็จแล้ว', 'success');
        })
        .sendAdminMessageToLine(selectedChatPlayerId, text);
    } else {
      addToast('จำลอง: ส่งข้อความ LINE สำเร็จ (Sandbox)', 'success');
      // Simulate bot reply in sandbox after 1.5 seconds
      setTimeout(() => {
        const botReply = {
          timestamp: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
          userId: selectedChatPlayerId,
          displayName: players.find(p => p.id === selectedChatPlayerId)?.name || 'ผู้เล่น',
          sender: 'bot',
          text: `[Sandbox Bot] ได้รับข้อความ "${text}" เรียบร้อยแล้วครับ!`,
          type: 'text'
        };
        setChatLogs(prev => [...prev, botReply]);
      }, 1500);
    }
  };

  // Parse bet command from Group chat message (Sandbox fallback)
  const processGroupBetCommand = (cmd) => {
    const clean = cmd.replace(/\s+/g, '').toLowerCase();

    // Check if accept action (ต, ติด, ครับ, เค, จ้า)
    if (['ต', 'ติด', 'ครับ', 'เค', 'จ้า'].includes(clean)) {
      const openBet = bets.find(b => b.status === 'pending_match');
      if (openBet) {
        const user = players.find(p => p.isUser);
        const userBal = user ? user.balance : 0;
        if (userBal < openBet.amount) {
          setGroupMessages(prev => [...prev, {
            id: Date.now() + 1,
            sender: 'ระบบบอทดูด 🚀',
            text: `❌ ยอดเงินของคุณไม่พอรับดวลแผลนี้! ต้องการยอด: ${openBet.amount} แต้ม`,
            time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
          }]);
          return;
        }

        // Subtract user credit
        setPlayers(prev => prev.map(p => p.isUser ? { ...p, balance: p.balance - openBet.amount } : p));
        
        // Find maker side and assign the user ('คุณ (You)') to the opposite side
        const isLowCreator = !!openBet.playerLowId;
        const updatedBet = {
          ...openBet,
          status: 'matched'
        };
        
        if (isLowCreator) {
          updatedBet.playerHighId = 'user';
          updatedBet.playerHighName = 'คุณ (You)';
        } else {
          updatedBet.playerLowId = 'user';
          updatedBet.playerLowName = 'คุณ (You)';
        }
        
        setBets(prev => prev.map(b => b.id === openBet.id ? updatedBet : b));
        
        // Dynamic compiler getCompiledGroupMessages() will auto display the match success message!
        const userSide = isLowCreator ? 'สูง (HIGH) 🔴' : 'ต่ำ (LOW) 🔵';
        addToast(`✅ จับคู่สำเร็จ! คุณอยู่ฝั่ง ${userSide} vs ${isLowCreator ? openBet.playerLowName : openBet.playerHighName} — ยอดดวล ${openBet.amount} แต้ม`, 'success');
      } else {
        setGroupMessages(prev => [...prev, {
          id: Date.now() + 1,
          sender: 'ระบบบอทดูด 🚀',
          text: '❌ ไม่มีแผลดวลเปิดรับอยู่ในขณะนี้',
          time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        }]);
      }
      return;
    }

    const rangeRegex = /^(\d+)-(\d+)([ลถตส]|สูง|ต่ำ)(\d+)$/;
    const simpleRegex = /^(ชล|ล|ไล่|ต|ต่ำ|ชย|ชถ|ย|ถ|ถอย|ส|สูง)(\d+)$/;

    let betType = 'high_low';
    let rangeMin = null;
    let rangeMax = null;
    let side = '';
    let amount = 0;

    if (rangeRegex.test(clean)) {
      const match = clean.match(rangeRegex);
      rangeMin = parseInt(match[1]);
      rangeMax = parseInt(match[2]);
      side = ['ล', 'ต', 'ต่ำ'].includes(match[3]) ? 'low' : 'high';
      amount = parseInt(match[4]);
      betType = 'range';
    } else if (simpleRegex.test(clean)) {
      const match = clean.match(simpleRegex);
      const sub = match[1];
      side = ['ชล', 'ล', 'ไล่', 'ต', 'ต่ำ'].includes(sub) ? 'low' : 'high';
      amount = parseInt(match[2]);
      betType = 'high_low';
    } else {
      return;
    }

    const user = players.find(p => p.isUser);
    const userBal = user ? user.balance : 0;
    if (userBal < amount) {
      return;
    }

    setPlayers(prev => prev.map(p => p.isUser ? { ...p, balance: p.balance - amount } : p));

    const orderNo = Math.floor(Math.random() * 89999 + 10000).toString();
    const newBet = {
      id: 'bet_' + orderNo,
      orderNumber: orderNo,
      amount: amount,
      type: betType,
      rangeMin: rangeMin,
      rangeMax: rangeMax,
      status: 'pending_match',
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    if (side === 'low') {
      newBet.playerLowId = 'user';
      newBet.playerLowName = 'คุณ (You)';
    } else {
      newBet.playerHighId = 'user';
      newBet.playerHighName = 'คุณ (You)';
    }

    setBets(prev => [newBet, ...prev]);

    // Save open bet to backend database and push Order Flex Card into target LINE group!
    const targetGroup = broadcastTargetGroup !== 'ALL' ? broadcastTargetGroup : activeGroupId;
    runBackendFunction('saveOpenBet', [
      orderNo,
      user?.id || 'user',
      user?.name || 'คุณ (You)',
      side,
      amount,
      betType,
      rangeMin,
      rangeMax,
      targetGroup
    ]);

    // Opponent match simulation (Sandbox only)
    setTimeout(() => {
      const opponents = players.filter(p => !p.isUser);
      const opponent = opponents[Math.floor(Math.random() * opponents.length)];

      setBets(prev => prev.map(b => {
        if (b.id === 'bet_' + orderNo) {
          const updated = { ...b, status: 'matched' };
          if (side === 'low') {
            updated.playerHighId = opponent.id;
            updated.playerHighName = opponent.name;
          } else {
            updated.playerLowId = opponent.id;
            updated.playerLowName = opponent.name;
          }
          return updated;
        }
        return b;
      }));

      setPlayers(prev => prev.map(p => p.id === opponent.id ? { ...p, balance: p.balance - amount } : p));
    }, 2500);
  };

  // Cancel Bet Request
  const handleRequestCancelBet = (betId) => {
    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          addToast('ขอยกเลิกแผลสดใน Google Sheets สำเร็จ รอคู่ตอบรับ...', 'info');
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
  const handleAdminApproveReview = async (txId) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('⚠️ รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }
    const approvedAmount = (targetTx.actualAmount && targetTx.actualAmount > 0) ? targetTx.actualAmount : (targetTx.requestedAmount || 0);

    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'success', reviewReason: 'Manually approved by admin', actualAmount: approvedAmount } : t));
          if (!txId.startsWith('WD')) {
            setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + approvedAmount } : p));
          }
          addToast(txId.startsWith('WD') ? 'อนุมัติการถอนเงินเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)' : `อนุมัติและอัพแต้ม +${approvedAmount} pt เรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'success');
        })
        .adminApproveTransaction(txId);
    } else {
      await runBackendFunction('adminApproveTransaction', [txId]);
      setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'success', actualAmount: approvedAmount, reviewReason: 'Approved manually by admin' } : t));
      if (!txId.startsWith('WD')) {
        setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: (p.balance || 0) + approvedAmount } : p));
      }
      addToast(txId.startsWith('WD') ? `แอดมินอนุมัติคำขอถอนเงินยอด ${targetTx.requestedAmount} THB โอนเงินแล้วเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)` : `แอดมินอนุมัติเครดิตเติมเงินยอด ${approvedAmount} THB แมนนวลเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'success');
    }
  };

  const handleAdminRejectReview = async (txId, reason) => {
    const targetTx = transactions.find(t => t.id === txId);
    if (!targetTx || targetTx.status !== 'escalated') {
      addToast('⚠️ รายการนี้ถูกดำเนินการไปแล้วหรือไม่อยู่ในสถานะรอตรวจสอบ', 'warning');
      return;
    }
    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'rejected', reviewReason: reason } : t));
          if (txId.startsWith('WD')) {
            setPlayers(prev => prev.map(p => p.isUser ? { ...p, balance: p.balance + targetTx.requestedAmount } : p));
          }
          addToast(txId.startsWith('WD') ? 'ปฏิเสธคำขอถอนเงินเรียบร้อย คืนเครดิตแล้ว (ส่งข้อความ LINE บอกผู้เล่นแล้ว)' : 'ปฏิเสธการโอนสลิปเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)', 'info');
        })
        .adminRejectTransaction(txId, reason);
    } else {
      await runBackendFunction('adminRejectTransaction', [txId, reason]);
      setTransactions(prev => prev.map(t => t.id === txId ? { ...t, status: 'rejected', reviewReason: reason } : t));
      if (txId.startsWith('WD')) {
        setPlayers(prev => prev.map(p => p.id === targetTx.playerId ? { ...p, balance: p.balance + targetTx.requestedAmount } : p));
        addToast(`ปฏิเสธคำขอถอนเงินยอด ${targetTx.requestedAmount} THB และคืนเครดิตให้ผู้เล่นเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)`, 'info');
      } else {
        if (targetTx.playerId === 'user') {
          setBillingResult({ status: 'rejected', reason });
        }
        addToast('ปฏิเสธการโอนสลิปเรียบร้อย (ส่งข้อความ LINE บอกผู้เล่นแล้ว)', 'info');
      }
    }
  };

  // Submit manual telemetry flight result (No flight animation, resolve immediately)
  const handleSubmitOnsiteResult = (finalTime) => {
    if (!finalTime || finalTime <= 0) {
      addToast('⚠️ กรุณาระบุเวลาผลการบินของจรวดให้ถูกต้อง', 'warning');
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

    setRocketFlightTime(finalTime);
    setRocketStatus('resolved'); // Immediately resolved
    setFlightLogs(prev => [`[LAUNCHPAD] [${new Date().toLocaleTimeString()}] Manual telemetry result submitted: ${finalTime}s.`, ...prev]);

    resolveMatchedBets(finalTime);
  };

  // Settle bets and calculate payouts (instant, no animations)
  const resolveMatchedBets = (finalTime) => {
    const finalScaled = Math.round(finalTime * 100);
    setFlightLogs(prev => [`💥 Telemetry link settled. Final Air Time: ${finalTime}s (${finalScaled} units).`, ...prev]);

    if (isGAS) {
      // In GAS: We run the bet resolution server-side inside Google Sheets database
      window.google.script.run
        .withSuccessHandler((data) => {
          if (data) {
            if (data.bets) setBets(data.bets);
            if (data.players) setPlayers(data.players);
            if (data.transactions) setTransactions(data.transactions);
          }
          
          // Calculate payouts details from matched bets list for the popup modal
          const previouslyMatched = bets.filter(b => b.status === 'matched');
          const payouts = previouslyMatched.map(b => {
            let isLowWinner = true;
            const timeSec = Number(finalTime);
            const minSec = (b.type === 'range' && b.rangeMin !== null && b.rangeMax !== null) ? Number(b.rangeMin) : Number(targetMin);
            const maxSec = (b.type === 'range' && b.rangeMin !== null && b.rangeMax !== null) ? Number(b.rangeMax) : Number(targetMax);

            if (timeSec < minSec) {
              isLowWinner = true;
            } else if (timeSec > maxSec) {
              isLowWinner = false;
            } else {
              const midPoint = (minSec + maxSec) / 2;
              isLowWinner = timeSec <= midPoint;
            }
            const winnerName = isLowWinner ? b.playerLowName : b.playerHighName;
            return {
              orderNumber: b.orderNumber,
              winnerName: winnerName,
              amount: b.amount,
              payout: Math.round(b.amount * 1.90)
            };
          });

          setSettlementResult({
            rocketName: rocketName,
            finalTime: finalTime,
            targetMin: targetMin,
            targetMax: targetMax,
            outcome: finalTime < targetMin ? 'LOW' : finalTime > targetMax ? 'HIGH' : 'RANGE',
            payouts: payouts
          });

          addToast(`เคลียร์ผลรางวัลแผลสดรอบ [${rocketName}] ช่วง ${targetMin}-${targetMax}s เรียบร้อย!`, 'success');
        })
        .adminResolveBets(finalTime, targetMin, targetMax);
    } else {
      // Sandbox fallback
      let payouts = [];
      setBets(prevBets => {
        const activeMatched = prevBets.filter(b => b.status === 'matched');
        const outcome = finalTime < targetMin ? 'LOW' : finalTime > targetMax ? 'HIGH' : 'RANGE';

        if (activeMatched.length === 0) {
          setSettlementResult({
            finalTime: finalTime,
            targetMin: targetMin,
            targetMax: targetMax,
            outcome: outcome,
            payouts: []
          });
          addToast(`🚀 จรวดลอย ${finalTime}s — ผลออก: ${outcome === 'LOW' ? 'ต่ำ (LOW) 🔵' : outcome === 'HIGH' ? 'สูง (HIGH) 🔴' : 'ในราคาช่าง 🎯'} — ไม่มีแผลค้างในรอบนี้`, 'info');
          return prevBets;
        }

        const updated = prevBets.map(bet => {
          if (bet.status !== 'matched') return bet;

          let isLowWinner = true;
          const timeSec = Number(finalTime);
          const minSec = (bet.type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMin) : Number(targetMin);
          const maxSec = (bet.type === 'range' && bet.rangeMin !== null && bet.rangeMax !== null) ? Number(bet.rangeMax) : Number(targetMax);

          if (timeSec < minSec) {
            isLowWinner = true;
          } else if (timeSec > maxSec) {
            isLowWinner = false;
          } else {
            const midPoint = (minSec + maxSec) / 2;
            isLowWinner = timeSec <= midPoint;
          }

          const winnerId = isLowWinner ? bet.playerLowId : bet.playerHighId;
          const winnerName = isLowWinner ? bet.playerLowName : bet.playerHighName;
          const payout = Math.round(bet.amount * 1.90);

          payouts.push({
            orderNumber: bet.orderNumber,
            winnerName: winnerName,
            amount: bet.amount,
            payout: payout
          });

          setPlayers(prevPlayers => prevPlayers.map(p => p.id === winnerId ? { ...p, balance: p.balance + payout } : p));

          return {
            ...bet,
            status: 'resolved',
            winnerId,
            winnerName,
            finalFlightTime: finalTime,
            payout
          };
        });

        setFlights(prev => [
          {
            id: 'FL_' + Math.floor(Math.random() * 89999 + 10000),
            duration: finalTime,
            scaled: finalScaled,
            timestamp: new Date().toLocaleTimeString(),
            betsResolved: activeMatched.length
          },
          ...prev
        ]);

        const finalOutcome = finalTime < targetMin ? 'LOW' : finalTime > targetMax ? 'HIGH' : 'RANGE';
        setSettlementResult({
          finalTime: finalTime,
          targetMin: targetMin,
          targetMax: targetMax,
          outcome: finalOutcome,
          payouts: payouts
        });

        // Show alert toast after settlement
        addToast(
          `🚀 ผลออกแล้ว! จรวดลอย ${finalTime}s — ${finalOutcome === 'LOW' ? 'ฝั่งต่ำ (LOW) 🔵 ชนะ' : finalOutcome === 'HIGH' ? 'ฝั่งสูง (HIGH) 🔴 ชนะ' : 'ในราคาช่าง 🎯'} — เคลียร์ ${activeMatched.length} แผลเรียบร้อย`,
          finalOutcome === 'LOW' ? 'info' : 'danger'
        );

        return updated;
      });
    }
  };

  // Render dynamic visual bank slip card in Light Mode
  const renderSlipCard = (presetId, isCustom, custAmt) => {
    let p = null;
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
    const playerBets = bets.filter(b => b.playerLowId === playerUserId || b.playerHighId === playerUserId);
    const playerChatLogs = chatLogs.filter(l => l.userId === playerUserId);

    return (
      <PlayerDashboard 
        player={matchedPlayer} 
        transactions={playerTransactions} 
        bets={playerBets} 
        chatLogs={playerChatLogs}
        playerUserId={playerUserId}
        players={players}
        isGAS={isGAS}
        setToasts={setToasts}
        addToast={addToast}
        setChatLogs={setChatLogs}
      />
    );
  }

  if (!adminAuthenticated) {
    return (
      <AdminLockScreen 
        passcodeInput={passcodeInput}
        setPasscodeInput={setPasscodeInput}
        passcodeError={passcodeError}
        setPasscodeError={setPasscodeError}
        setAdminAuthenticated={setAdminAuthenticated}
        adminPasscode={ADMIN_PASSCODE}
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

      {/* Header Panel */}
      <header className="w-full max-w-6xl mb-6 text-center md:text-left flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center justify-center md:justify-start gap-2.5">
            <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider ${
              (window.isNodeJS || isGAS) ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-slate-100 border border-slate-200 text-slate-600'
            }`}>
              {(window.isNodeJS || isGAS) ? '🟢 Connected' : '🧪 Demo Mode'}
            </span>
            <h1 className="text-xl md:text-2xl font-black tracking-tight text-slate-800 uppercase font-heading">
              Rocket Science Command System
            </h1>
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5 font-sans">
            ระบบจัดการธุรกรรมเครดิตและบันทึกเวลาขีปนาวุธภาคสนาม (Rocket Telemetry & Credit Settle System)
          </p>
        </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <button 
            onClick={handleClosePortal}
            className="px-3.5 py-2 rounded-lg text-xs font-bold bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 flex items-center gap-1.5 transition-all shadow-xs active:scale-95"
            title="รีเซ็ตและปิดรอบพอร์ทัลปัจจุบัน โดยไม่ลบข้อมูลผู้เล่นหรือประวัติธุรกรรม"
          >
            <RotateCcw size={14} className="text-amber-700" />
            🔒 ปิดรอบพอร์ทัล (Close Portal Session)
          </button>
          <button 
            onClick={resetConsoleState}
            className="px-3.5 py-2 rounded-lg text-xs font-bold bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 flex items-center gap-1.5 transition-all shadow-xs active:scale-95"
            title="ล้างข้อมูลระบบทั้งหมดกลับสู่ค่าเริ่มต้นโรงงาน"
          >
            <RotateCcw size={14} className="text-rose-600" />
            ⚠️ ล้างระเบียนโรงงาน (Factory Reset)
          </button>
        </div>
      </header>

      {/* Main Sandbox Grid (Standardized to corporate light 100% width column) */}
      <main className="w-full max-w-6xl space-y-6">
        
        {/* Top metrics bar stretching 100% width */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="glass-panel p-4 flex flex-col justify-between glass-panel-hover relative overflow-hidden group">
            {/* Watermark Icon */}
            <Wallet size={110} className="absolute -bottom-6 -right-6 text-slate-100/70 group-hover:text-emerald-100/40 group-hover:scale-110 transition-all duration-500 ease-out pointer-events-none z-0" />
            
            <div className="relative z-10 flex flex-col justify-between h-full">
              <span className="text-xs uppercase font-bold tracking-wider text-slate-500 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                ยอดฝากเครดิตรวม
              </span>
              <span className="text-xl font-black mt-2 text-slate-800 font-mono tracking-tight">
                {transactions.filter(t => t.status === 'success').reduce((acc, t) => acc + t.actualAmount, 0).toLocaleString()} <span className="text-sm text-slate-500">THB</span>
              </span>
            </div>
          </div>

          <div className="glass-panel p-4 flex flex-col justify-between glass-panel-hover relative overflow-hidden group">
            {/* Watermark Icon */}
            <ShieldAlert size={110} className="absolute -bottom-6 -right-6 text-slate-100/70 group-hover:text-amber-100/40 group-hover:scale-110 transition-all duration-500 ease-out pointer-events-none z-0" />
            
            {transactions.filter(t => t.status === 'escalated').length > 0 && (
              <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-rose-500 animate-ping z-20"></div>
            )}
            
            <div className="relative z-10 flex flex-col justify-between h-full">
              <span className="text-xs uppercase font-bold tracking-wider text-slate-500">
                รอตรวจหลักฐาน
              </span>
              <div className="flex items-baseline gap-1 mt-2">
                <span className="text-xl font-black text-amber-600 font-mono tracking-tight">
                  {transactions.filter(t => t.status === 'escalated').length}
                </span>
                <span className="text-sm text-slate-500">บิลค้าง</span>
              </div>
            </div>
          </div>

          <div className="glass-panel p-4 flex flex-col justify-between glass-panel-hover relative overflow-hidden group">
            {/* Watermark Icon */}
            <Rocket size={110} className="absolute -bottom-6 -right-6 text-slate-100/70 group-hover:text-sky-100/40 group-hover:scale-110 transition-all duration-500 ease-out pointer-events-none z-0" />
            
            <div className="relative z-10 flex flex-col justify-between h-full">
              <span className="text-xs uppercase font-bold tracking-wider text-slate-500">
                แผลจับคู่สด
              </span>
              <span className="text-xl font-black mt-2 text-sky-600 font-mono tracking-tight">
                {bets.filter(b => b.status === 'matched').length} <span className="text-sm text-slate-500 font-sans font-bold">ดีลคู่</span>
              </span>
            </div>
          </div>

          <div className="glass-panel p-4 flex flex-col justify-between glass-panel-hover relative overflow-hidden group">
            {/* Watermark Icon */}
            <Users size={110} className="absolute -bottom-6 -right-6 text-slate-100/70 group-hover:text-indigo-100/40 group-hover:scale-110 transition-all duration-500 ease-out pointer-events-none z-0" />
            
            <div className="relative z-10 flex flex-col justify-between h-full">
              <span className="text-xs uppercase font-bold tracking-wider text-slate-500">
                บัญชีผู้เล่น
              </span>
              <span className="text-xl font-black mt-2 text-indigo-600 font-mono tracking-tight">
                {players.length} <span className="text-sm text-slate-500 font-sans font-bold">บัญชี</span>
              </span>
            </div>
          </div>
        </div>

        {/* Tab Selection Bar stretching 100% width */}
        <div className="glass-panel p-1 flex text-sm font-bold tracking-wide shrink-0 overflow-x-auto">
          <button 
            onClick={() => setAdminTab('rocket')}
            className={`flex-1 py-2.5 px-2 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
              adminTab === 'rocket' ? 'bg-sky-100 border border-sky-200 text-sky-800' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Rocket size={14} />
            ป้อนผลจรวด {bets.filter(b => b.status === 'matched').length > 0 && <span className="bg-sky-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">{bets.filter(b => b.status === 'matched').length}</span>}
          </button>
          <button 
            onClick={() => setAdminTab('review')}
            className={`flex-1 py-2.5 px-2 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
              adminTab === 'review' ? 'bg-sky-100 border border-sky-200 text-sky-800' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <FileText size={14} />
            สลิปค้างรีวิว {transactions.filter(t => t.status === 'escalated').length > 0 && <span className="bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{transactions.filter(t => t.status === 'escalated').length}</span>}
          </button>
          <button 
            onClick={() => setAdminTab('players')}
            className={`flex-1 py-2.5 px-2 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
              adminTab === 'players' ? 'bg-sky-100 border border-sky-200 text-sky-800' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Users size={14} />
            เครดิตผู้เล่น
          </button>
          <button 
            onClick={() => setAdminTab('logs')}
            className={`flex-1 py-2.5 px-2 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
              adminTab === 'logs' ? 'bg-sky-100 border border-sky-200 text-sky-800' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Database size={14} />
            ทรานแซคชัน
          </button>
          <button 
            onClick={() => setAdminTab('line')}
            className={`flex-1 py-2.5 px-2 rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
              adminTab === 'line' ? 'bg-sky-100 border border-sky-200 text-sky-800' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <MessageSquare size={14} />
            แชท LINE OA
          </button>

        </div>

        {/* Tab panels contents container */}
        <div className="w-full space-y-6">

          {/* TAB 1: ONSITE TELEMETRY RECEIVER */}
          {adminTab === 'rocket' && (
            <div className="glass-panel p-5 space-y-5 relative overflow-hidden group">
              {/* Watermark Icon */}
              <Rocket size={140} className="absolute -bottom-10 -right-10 text-slate-100/30 group-hover:text-sky-100/40 group-hover:scale-105 transition-all duration-500 ease-out pointer-events-none z-0" />
              
              <div className="relative z-10">
                <div className="card-header-ref card-header-dot-sky">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center justify-center gap-2 font-heading">
                    <Rocket size={14} className="text-sky-600 animate-pulse" />
                    หอบังคับการป้อนเวลาขีปนาวุธ (Onsite Rocket Telemetry Inputs)
                  </h3>
                </div>
                <p className="text-[11px] text-slate-500 text-center font-sans mt-2">
                  ระบบจัดการและสรุปผลเวลาขีปนาวุธ แยกการตั้งค่าราคาช่างต้นทางและสรุปผลเคลียร์แต้มอิสระจากกัน
                </p>
              </div>

              {/* Connected Channel Header */}
              <div className="w-full rounded-xl border border-slate-200 bg-white p-3 flex justify-between items-center shadow-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800 flex items-center gap-1.5 font-heading">
                    📡 ONSITE TELEMETRY RECEIVER (ACTIVE)
                  </span>
                  {activeGroupId ? (
                    <span className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md text-[10px] font-mono font-bold flex items-center gap-1">
                      💬 Connected Group: {(() => {
                        const activeObj = lineGroups.find(g => g.id === activeGroupId);
                        const isRaw = !activeObj || !activeObj.name || activeObj.name.startsWith('C') || activeObj.name.includes(activeGroupId) || !isNaN(activeObj.name);
                        return !isRaw ? activeObj.name : `🚀 กลุ่มดวลสด (#${activeGroupId.slice(-4)})`;
                      })()}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-md text-[10px] font-mono font-semibold">
                      ⏳ Waiting for LINE Group chat message...
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 uppercase font-mono">Channel: Onsite-Radio-V2</span>
              </div>

              {/* CARD 1: Original Mechanic Quote Setup & Broadcast Card */}
              <div className="p-5 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/50 rounded-2xl border border-emerald-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-emerald-100 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 bg-emerald-600 text-white rounded-lg shadow-sm">
                      <Rocket size={16} />
                    </span>
                    <div>
                      <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider font-heading">
                        CARD 1: 🚀 ราคาช่างเปิดรับดวล (Original Mechanic Quote Setup)
                      </h3>
                      <p className="text-[11px] text-slate-500 font-sans">
                        ตั้งค่าชื่อค่ายช่าง บั้งไฟ และช่วงราคาช่างเปิด (Min - Max) เพื่อกระจายราคาท้าดวลลงกลุ่มดวลสด
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] text-emerald-700 font-extrabold bg-emerald-100 px-2.5 py-1 rounded-full border border-emerald-200">
                    LINE Broadcast Ready
                  </span>
                </div>

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
                  className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-xs shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 font-heading tracking-wide"
                >
                  🚀 ประกาศออกราคาช่าง {targetMin && targetMax ? `${targetMin}-${targetMax}` : '(ระบุช่วงราคา)'} วินาที ลง{broadcastTargetGroup === 'ALL' ? 'ทุกกลุ่มดวลสด' : 'กลุ่มที่เลือก'} (Broadcast Quote)
                </button>

                {/* Quick Action Commands & Instruction Hot Keys */}
                <div className="pt-2 border-t border-emerald-100 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block font-heading">⚡ ปุ่มคีย์ลัดแอดมิน & บรอดแคสต์กติกา (Admin Hot Keys & Rule Guide):</span>
                    <span className="text-[10px] text-emerald-700 font-mono font-bold">💡 ราคาช่างเปิดจากแอดมินไม่ต้องใช้แต้ม</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs font-bold">
                    <button onClick={() => {
                      const msg = `📖 [คู่มือคีย์เวิร์ดกติกา]\n🔵 ช่างไล่ (ต่ำ): ชล, a, ไล่, ล, +5ชล, -5ชล\n🔴 ช่างถอย (สูง): ชย, ชถ, ย, ถ, ยั่ง, ถอย, +5ชย, -5ชย\n🎯 เปิดราคาเอง: 300-340ล500, 345-385ถ500 ชตย\n✅ จับคู่แผล: พิมพ์ ต, ตต, ติด, ครับ, เค, จ้า`;
                      if (broadcastTargetGroup === 'ALL') {
                        const targets = lineGroups.length > 0 ? lineGroups.map(g => g.id) : [activeGroupId];
                        targets.forEach(tId => runBackendFunction('sendAdminMessageToLine', [tId, msg]));
                      } else {
                        runBackendFunction('sendAdminMessageToLine', [broadcastTargetGroup, msg]);
                      }
                      addToast('📖 ประกาศส่งคู่มือคีย์เวิร์ด & กติกาการเล่นลงกลุ่มเรียบร้อย!', 'info');
                    }} className="py-2.5 px-3 bg-teal-600 hover:bg-teal-700 text-white rounded-lg flex items-center justify-center gap-1 transition-all active:scale-95 shadow-sm">📖 ประกาศส่งคู่มือคีย์เวิร์ดกติกา</button>
                    <button onClick={() => {
                      const msg = `🔒 ปิดรับดวล ➔ ${rocketName || 'ช่างบั้งไฟสด'}\n⛔ 3-2-GO! หมดเวลาท้าดวลก่อนปล่อยบั้งไฟ\n⚠️ ออเดอร์และกดแมตช์หลังจากนี้จะไม่ถูกจับคู่ทุกกรณีครับ`;
                      if (broadcastTargetGroup === 'ALL') {
                        const targets = lineGroups.length > 0 ? lineGroups.map(g => g.id) : [activeGroupId];
                        targets.forEach(tId => runBackendFunction('sendAdminMessageToLine', [tId, msg]));
                      } else {
                        runBackendFunction('sendAdminMessageToLine', [broadcastTargetGroup, msg]);
                      }
                      addToast(`🔒 ล็อคปิดรับดวลรอบ [${rocketName || 'ช่างบั้งไฟสด'}] (1 นาที ก่อนจุด) เรียบร้อย!`, 'warning');
                    }} className="py-2.5 px-3 bg-amber-500 hover:bg-amber-600 text-white rounded-lg flex items-center justify-center gap-1 transition-all active:scale-95 shadow-sm">🔒 ปิดรับดวล (1 นาที ก่อนจุด)</button>
                    <button onClick={() => {
                      if (!window.confirm("⛔ คุณต้องการประกาศ 'ช่าง ⛔' (โมฆะรอบ) และยกเลิกคืนแต้มแผลดวลทั้งหมดใช่หรือไม่?")) return;
                      runBackendFunction('adminVoidRound', []);
                      addToast(`⛔ ประกาศ "ช่าง ⛔" (โมฆะรอบ) และคืนแต้มผู้เล่นเรียบร้อย!`, 'danger');
                    }} className="py-2.5 px-3 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 rounded-lg flex items-center justify-center gap-1 transition-all active:scale-95">⛔ ประกาศ "ช่าง ⛔" (โมฆะรอบ)</button>
                    <button onClick={() => {
                      const msg = `🚨 [เตือนภัย] ฝาก-ถอน กรุณาทักแชตตรงหา LINE OA เท่านั้นครับ ❌`;
                      if (broadcastTargetGroup === 'ALL') {
                        const targets = lineGroups.length > 0 ? lineGroups.map(g => g.id) : [activeGroupId];
                        targets.forEach(tId => runBackendFunction('sendAdminMessageToLine', [tId, msg]));
                      } else {
                        runBackendFunction('sendAdminMessageToLine', [broadcastTargetGroup, msg]);
                      }
                      addToast(`🚨 บรอดแคสต์ประกาศเตือนมิจฉาชีพไปยัง LINE เรียบร้อย!`, 'info');
                    }} className="py-2.5 px-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 rounded-lg flex items-center justify-center gap-1 transition-all active:scale-95">🚨 เตือนมิจฉาชีพ</button>
                  </div>
                </div>
              </div>

              {/* CARD 2: Final Result Telemetry & Round Settlement Card */}
              <div className="p-5 bg-gradient-to-br from-sky-50/80 via-white to-indigo-50/50 rounded-2xl border border-sky-200 shadow-sm space-y-4">
                <div className="flex items-center justify-between border-b border-sky-100 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 bg-sky-600 text-white rounded-lg shadow-sm">
                      <Zap size={16} />
                    </span>
                    <div>
                      <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider font-heading">
                        CARD 2: 🎯 ป้อนผลเวลาบินจริง & ชำระแต้มดวล (Final Flight Time & Round Settlement)
                      </h3>
                      <p className="text-[11px] text-slate-500 font-sans">
                        ป้อนผลเวลาวินาทีที่จรวดบินสำเร็จจริง เพื่อให้ระบบคำนวณผู้ชนะและโอนจ่ายแต้มผลการท้าดวลทั้งหมดในรอบนี้
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] text-sky-700 font-extrabold bg-sky-100 px-2.5 py-1 rounded-full border border-sky-200">
                    Telemetry Settlement Engine
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                  {/* Actual Air Time Input */}
                  <div className="space-y-1 bg-white p-3.5 rounded-xl border border-slate-200">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1 font-heading">
                      <Clock size={14} className="text-indigo-600" />
                      ผลยิงจริงในสนาม (Actual Air Time in Seconds):
                    </label>
                    <div className="flex items-center gap-2">
                      <input 
                        type="number"
                        step="0.1"
                        value={customRocketTime}
                        onChange={(e) => setCustomRocketTime(e.target.value)}
                        className="w-full bg-indigo-50/50 border border-indigo-200 text-indigo-950 font-black px-3 py-2 rounded-xl text-base font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        placeholder="เช่น 355.0"
                      />
                      <span className="text-sm text-indigo-700 font-mono font-black">s</span>
                    </div>
                  </div>

                  {/* Live Outcome Preview */}
                  <div className="p-3.5 bg-white rounded-xl border border-slate-200 flex flex-col justify-center space-y-1.5">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-600">
                      <span>ราคาช่างเปรียบเทียบ:</span>
                      <span className="font-mono text-slate-800">{targetMin || 330} - {targetMax || 380}s</span>
                    </div>
                    <div className="flex justify-between items-center text-xs font-bold">
                      <span>คาดการณ์ผลชนะ:</span>
                      {Number(customRocketTime || 0) < Number(targetMin || 330) ? (
                        <span className="px-2.5 py-1 bg-blue-100 text-blue-800 font-black rounded-lg text-xs flex items-center gap-1">🔵 ฝั่งต่ำ (LOW / ชล) ชนะ</span>
                      ) : Number(customRocketTime || 0) > Number(targetMax || 380) ? (
                        <span className="px-2.5 py-1 bg-rose-100 text-rose-800 font-black rounded-lg text-xs flex items-center gap-1">🔴 ฝั่งสูง (HIGH / ชถ) ชนะ</span>
                      ) : (
                        <span className="px-2.5 py-1 bg-emerald-100 text-emerald-800 font-black rounded-lg text-xs flex items-center gap-1">🎯 ในราคาช่าง (RANGE)</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Settle Round Primary Button */}
                <button
                  onClick={() => handleSubmitOnsiteResult(Number(customRocketTime) || 355)}
                  className="w-full py-3.5 px-6 bg-sky-600 hover:bg-sky-500 text-white font-black text-xs uppercase tracking-wider rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-sky-600/20 active:scale-95 transition-all font-heading"
                >
                  <Zap size={16} />
                  ⚡ สรุปผลและชำระแต้มดีลทั้งหมด / SETTLE ONSITE ROUND (ผลลัพธ์ยิงจริง: {customRocketTime || 0}s)
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
                            f.duration < targetTime ? 'bg-sky-50 text-sky-700 border border-sky-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
                          }`}>
                            {f.duration < targetTime ? 'LOW' : 'HIGH'}
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

          {/* TAB 2: SLIP REVIEWS */}
          {adminTab === 'review' && (
            <div className="glass-panel p-5 space-y-4 relative overflow-hidden group">
              {/* Watermark Icon */}
              <FileText size={140} className="absolute -bottom-10 -right-10 text-slate-100/30 group-hover:text-amber-100/40 group-hover:scale-105 transition-all duration-500 ease-out pointer-events-none z-0" />
              
              <div className="relative z-10">
                <div className="card-header-ref card-header-dot-amber">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center justify-center gap-2 font-heading">
                    <FileText size={14} className="text-amber-600 animate-pulse" />
                    การทำธุรกรรมรออนุมัติแมนนวล (Escalation & Withdrawal Overseer)
                  </h3>
                </div>
                <p className="text-[11px] text-slate-500 text-center font-sans mt-2">
                  รายการถอนเงินของลูกค้า หรือบิลสลิปโอนที่มีการเอสคาเลท (ยอดไม่ตรง/สลิปซ้ำ/ภาพชำรุด) แอดมินต้องตรวจสอบบัญชีธนาคารปลายทางแล้วกดยืนยัน
                </p>
              </div>

              {transactions.filter(t => t.status === 'escalated').length === 0 ? (
                <div className="py-12 text-center text-slate-400 space-y-2 font-sans">
                  <CheckCircle size={32} className="mx-auto text-emerald-600" />
                  <p className="font-bold text-xs">รายการตรวจสอบธุรกรรมเคลียร์หมดแล้ว!</p>
                  <p className="text-[11px] text-slate-500">สลิปฝากออโต้จะเติมอัตโนมัติ 1:1 ส่วนถอนเงินและเอสคาเลชั่นจะรอตรงนี้</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {transactions.filter(t => t.status === 'escalated').map(tx => {
                    const isWithdrawal = tx.id.startsWith('WD') || 
                      (tx.slipRef && tx.slipRef.toString().toUpperCase().includes('WD')) || 
                      (tx.reviewReason && tx.reviewReason.toString().toLowerCase().includes('withdraw'));
                    const cardBgStyle = isWithdrawal 
                      ? 'p-4 rounded-2xl bg-gradient-to-br from-rose-50/80 via-white to-red-50/60 border-2 border-rose-300 flex flex-col md:flex-row gap-4 items-stretch shadow-sm'
                      : 'p-4 rounded-2xl bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 border-2 border-emerald-300 flex flex-col md:flex-row gap-4 items-stretch shadow-sm';

                    return (
                      <div key={tx.id} className={cardBgStyle}>
                        <div className="shrink-0 flex justify-center">
                          {isWithdrawal ? (
                            <div className="w-[180px] h-[240px] bg-gradient-to-b from-rose-100 to-rose-200 border border-rose-300 rounded-2xl p-4 flex flex-col items-center justify-between text-center select-none shadow">
                              <div className="text-3xl mt-2 animate-bounce">📤</div>
                              <div className="space-y-1">
                                <span className="text-[10px] text-rose-800 font-black uppercase tracking-wider bg-rose-200 px-2 py-0.5 rounded-md">📤 รายการถอนเงิน</span>
                                <h4 className="text-xl font-black text-rose-950 font-mono">-{tx.requestedAmount} pt</h4>
                              </div>
                              <div className="w-full bg-white/90 border border-rose-300 rounded-lg p-2 text-[9.5px] text-rose-900 font-bold leading-normal font-sans shadow-xs">
                                {tx.reviewReason.replace('Withdrawal request to ', '')}
                              </div>
                            </div>
                          ) : (
                            renderSlipCard(tx.presetId, true, (tx.requestedAmount && tx.requestedAmount > 0) ? tx.requestedAmount : (tx.actualAmount || 100))
                          )}
                        </div>

                        <div className="flex-1 flex flex-col justify-between gap-3 font-sans text-xs">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: isWithdrawal ? '#FCA5A5' : '#6EE7B7' }}>
                              <div className="flex items-center gap-2">
                                {isWithdrawal ? (
                                  <span className="px-2.5 py-1 bg-rose-700 text-white font-extrabold rounded-lg text-[10px] font-heading tracking-wide uppercase shadow-xs">
                                    📤 รายการถอนเงิน (WITHDRAWAL REQUEST)
                                  </span>
                                ) : (
                                  <span className="px-2.5 py-1 bg-emerald-700 text-white font-extrabold rounded-lg text-[10px] font-heading tracking-wide uppercase shadow-xs">
                                    📥 รายการฝากเงิน (DEPOSIT REQUEST)
                                  </span>
                                )}
                                <span className="px-2 py-0.5 bg-slate-200/80 rounded text-[10px] font-mono text-slate-700 font-bold">{isWithdrawal ? `WITHDRAW: ${tx.id}` : `TX: ${tx.id}`}</span>
                              </div>
                              <span className={`font-extrabold text-[11px] flex items-center gap-1 ${isWithdrawal ? 'text-rose-700' : 'text-emerald-800'}`}>
                                <AlertTriangle size={12} />
                                {isWithdrawal ? 'คำขอถอนยอด รอโอนเงิน' : `สาเหตุค้าง: ${tx.reviewReason}`}
                              </span>
                            </div>

                            {isWithdrawal ? (
                              <div className="bg-white p-3 rounded-xl border border-rose-200 space-y-1.5 leading-normal text-slate-700 font-sans shadow-2xs">
                                <div className="font-bold text-rose-950 flex items-center gap-1 text-xs">
                                  <span>💸 ช่องทางโอนเงินคืนผู้เล่น:</span>
                                </div>
                                <div>• ผู้เล่นที่ทำรายการ: <span className="font-extrabold text-slate-900">{tx.playerName} ({tx.playerId})</span></div>
                                <div>• ยอดแต้มที่หักออก: <span className="font-black text-rose-700 font-mono text-sm">-{tx.requestedAmount}.00 pt</span></div>
                                <div>• บัญชีโอนออกแมนนวล: <span className="font-black text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">{tx.reviewReason.replace('Withdrawal request to ', '')}</span></div>
                                <div className="text-[10px] text-rose-600 font-medium leading-snug pt-1">
                                  💡 <b>สำคัญ:</b> แอดมินกรุณาโอนเงินจริงไปยังบัญชีธนาคารด้านบนนี้ให้สำเร็จก่อนกดปุ่มอนุมัติ
                                </div>
                              </div>
                            ) : (
                              <div className="grid grid-cols-2 gap-2 bg-white p-3 rounded-xl border border-emerald-200 font-mono shadow-2xs">
                                <div>
                                  <span className="text-[9.5px] text-slate-500 uppercase block font-sans font-bold">ยอดเงินเติมที่ผู้เล่นสั่ง:</span>
                                  <span className="text-lg font-black text-sky-800">{tx.requestedAmount}.00 THB</span>
                                </div>
                                <div className="border-l border-slate-200 pl-3">
                                  <span className="text-[9.5px] text-slate-500 uppercase block font-sans font-bold">ยอดสแกนจริงจากสลิปโอน:</span>
                                  <span className="text-lg font-black text-emerald-700">{tx.actualAmount}.00 THB</span>
                                </div>
                              </div>
                            )}

                            {!isWithdrawal && (
                              <div className="p-2.5 bg-white border border-emerald-100 rounded-xl text-[10px] text-slate-600 space-y-0.5" style={{ maxHeight: '80px', overflowY: 'auto' }}>
                                <span className="font-bold text-emerald-800 text-[9px] block uppercase font-sans">Scan analysis logs:</span>
                                {tx.logs.map((l, i) => (
                                  <div key={i} className="font-mono">➜ {l}</div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2 border-t pt-2 font-sans" style={{ borderColor: isWithdrawal ? '#FCA5A5' : '#6EE7B7' }}>
                            <button
                              onClick={() => handleAdminApproveReview(tx.id)}
                              className={`flex-1 py-2.5 text-white font-black text-xs uppercase tracking-wider rounded-xl flex items-center justify-center gap-1.5 transition-all active:scale-95 shadow-md ${
                                isWithdrawal ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/20' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20'
                              }`}
                            >
                              <CheckCircle size={14} />
                              {isWithdrawal ? `ยืนยันว่าโอนแล้ว & อนุมัติถอนเงิน (${tx.requestedAmount} THB)` : `อนุมัติฝากเงินและอัพแต้ม (+${(tx.actualAmount && tx.actualAmount > 0) ? tx.actualAmount : (tx.requestedAmount || 0)} pt)`}
                            </button>
                            <button
                              onClick={() => handleAdminRejectReview(tx.id, isWithdrawal ? 'ปฏิเสธคำขอและส่งแต้มคืนเข้าบัญชี' : 'ปฏิเสธเนื่องจากไม่มียอดโอนจริง')}
                              className="py-2.5 px-4 bg-slate-100 hover:bg-rose-600 text-slate-700 hover:text-white border border-slate-300 hover:border-rose-600 rounded-xl text-xs font-bold transition-all active:scale-95"
                            >
                              ปฏิเสธรายการ
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: PLAYERS CREDIT */}
          {adminTab === 'players' && (
            <div className="glass-panel p-5 space-y-6 relative overflow-hidden group">
              {/* Watermark Icon */}
              <Users size={140} className="absolute -bottom-10 -right-10 text-slate-100/30 group-hover:text-indigo-100/40 group-hover:scale-105 transition-all duration-500 ease-out pointer-events-none z-0" />
              
              <div className="relative z-10">
                <div className="card-header-ref card-header-dot-indigo">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center justify-center gap-2 font-heading">
                    <Users size={14} className="text-indigo-600" />
                    จัดการบัญชีผู้เล่น (Player Account Management)
                  </h3>
                </div>
                <p className="text-[11px] text-slate-500 text-center font-sans mt-2 mb-4">
                  แก้ไขชื่อ เครดิต บัญชีธนาคาร หรือลบผู้เล่นได้จากหน้านี้โดยตรง
                </p>
              </div>

              {/* Header actions */}
              <div className="flex items-center justify-between flex-wrap gap-2 relative z-10">
                <div>
                  <span className="text-xs font-bold text-slate-700">รายชื่อสมาชิกทั้งหมด</span>
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
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-xl shadow transition-all active:scale-95"
                >
                  <span className="text-base leading-none">＋</span> เพิ่มผู้เล่น
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
                        <tr key={p.id} className="hover:bg-teal-50/20 transition-colors group">
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

              {/* Active Bets Summary */}
              <div className="space-y-2">
                <span className="text-xs font-black text-slate-800 uppercase tracking-wider block border-b border-slate-200 pb-1.5 font-heading">
                  ตารางสรุปดีลดวลที่กำลังดำเนินการ (Active Game Contracts)
                </span>
                <div className="overflow-x-auto" style={{ wordBreak: 'keep-all' }}>
                  <table className="w-full text-left font-sans text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 font-bold">
                        <th className="py-2 px-1">Order #</th>
                        <th className="py-2 px-1">ฝั่งต่ำ (Low)</th>
                        <th className="py-2 px-1">ฝั่งสูง (High)</th>
                        <th className="py-2 px-1 text-right">ยอดดวล</th>
                        <th className="py-2 px-1 text-center">ประเภท</th>
                        <th className="py-2 px-1 text-center">สถานะ</th>
                        <th className="py-2 px-1 text-right">ยกเลิกแผล</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {bets.map(b => (
                        <tr key={b.id} className="hover:bg-slate-50/50">
                          <td className="py-2.5 px-1 font-bold text-slate-800 font-mono">{b.orderNumber}</td>
                          <td className="py-2.5 px-1">
                            {b.playerLowName
                              ? <span className="text-sky-700 font-bold">{b.playerLowName}</span>
                              : <span className="text-slate-400 italic">-- ว่าง --</span>}
                          </td>
                          <td className="py-2.5 px-1">
                            {b.playerHighName
                              ? <span className="text-rose-700 font-bold">{b.playerHighName}</span>
                              : <span className="text-slate-400 italic">-- ว่าง --</span>}
                          </td>
                          <td className="py-2.5 px-1 text-right font-bold text-slate-800 font-mono">{b.amount} pt</td>
                          <td className="py-2.5 px-1 text-center font-mono">
                            {b.type === 'range'
                              ? <span className="px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 font-extrabold rounded text-[10px]">🤝 P2P ({b.rangeMin > 1000 ? (b.rangeMin/100) : b.rangeMin}-{b.rangeMax > 1000 ? (b.rangeMax/100) : b.rangeMax}s)</span>
                              : <span className="px-1.5 py-0.5 bg-sky-50 border border-sky-200 text-sky-800 font-bold rounded text-[10px]">🏛️ ราคาช่าง ({targetMin}-{targetMax}s)</span>}
                          </td>
                          <td className="py-2.5 px-1 text-center font-sans font-bold text-[10.5px]">
                            {b.status === 'matched' && <span className="badge-success px-1.5 py-0.5 rounded-lg">ดวลกันอยู่</span>}
                            {b.status === 'pending_match' && <span className="badge-warning px-1.5 py-0.5 rounded-lg animate-pulse">รอคู่ดวล</span>}
                            {b.status === 'pending_cancel' && <span className="badge-high px-1.5 py-0.5 rounded-lg">รอถอนแผล</span>}
                            {b.status === 'cancelled' && <span className="px-1.5 py-0.5 text-slate-400 line-through">ขอยกเลิก</span>}
                            {b.status === 'resolved' && <span className="badge-low px-1.5 py-0.5 rounded-lg">สรุป ➔ {b.winnerName?.split(' ')[0]}</span>}
                          </td>
                          <td className="py-2.5 px-1 text-right">
                            {b.status === 'matched' && (
                              <button
                                onClick={() => handleRequestCancelBet(b.id)}
                                className="px-2.5 py-1 bg-rose-50 border border-rose-200 text-rose-700 text-[10.5px] rounded-lg font-bold transition-all active:scale-95"
                              >
                                ถอนดีลสด
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                <div className="bg-gradient-to-r from-sky-600 to-sky-700 px-6 py-4">
                  <h3 className="text-white font-bold text-base">✏️ แก้ไขข้อมูลผู้เล่น</h3>
                  <p className="text-sky-100 text-xs mt-0.5 font-mono">{playerEditModal.player.id}</p>
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
                    onClick={() => {
                      setPlayerEditSaving(true);
                      const p = playerEditModal.player;
                      const nameChanged = playerEditForm.name.trim() !== p.name;
                      const balChanged = playerEditForm.balance !== p.balance;
                      const gasCall = (fn, ...args) => new Promise((res, rej) => {
                        window.google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn](...args);
                      });
                      const doSave = async () => {
                        let lastData = null;
                        if (isGAS) {
                          if (nameChanged) lastData = await gasCall('adminUpdatePlayerName', p.id, playerEditForm.name.trim());
                          if (balChanged) lastData = await gasCall('adminSetPlayerBalance', p.id, playerEditForm.balance);
                          if (!nameChanged && !balChanged) lastData = await gasCall('getDashboardData');
                        } else {
                          setPlayers(prev => prev.map(pl => pl.id === p.id ? { ...pl, name: playerEditForm.name.trim(), balance: playerEditForm.balance } : pl));
                          lastData = null;
                        }
                        if (lastData && lastData.players) setPlayers(lastData.players);
                        if (lastData && lastData.transactions) setTransactions(lastData.transactions);
                        setPlayerEditSaving(false);
                        setPlayerEditModal(null);
                        addToast(`✅ อัปเดตข้อมูล ${p.name} สำเร็จ`, 'success');
                      };
                      doSave().catch(err => { setPlayerEditSaving(false); addToast('❌ ' + (err.message || err), 'error'); });
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
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-4">
                  <h3 className="text-white font-bold text-base">🏦 ลงทะเบียนบัญชีธนาคาร</h3>
                  <p className="text-teal-100 text-xs mt-0.5">{bankEditModal.player.name} · <span className="font-mono opacity-70">{bankEditModal.player.id.slice(0, 18)}…</span></p>
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
                      placeholder="เช่น 0642356566"
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
                      placeholder="ชื่อ-นามสกุล ตามสมุดบัญชี"
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
                    onClick={() => {
                      if (!bankEditForm.bankName || !bankEditForm.bankAccount || !bankEditForm.accountName) return;
                      setBankEditSaving(true);
                      const p = bankEditModal.player;
                      if (isGAS) {
                        window.google.script.run
                          .withSuccessHandler((data) => {
                            setBankEditSaving(false);
                            setBankEditModal(null);
                            if (data && data.players) setPlayers(data.players);
                            addToast(`✅ บันทึกบัญชีธนาคารของ ${p.name} สำเร็จ และแจ้งผู้เล่นทาง LINE แล้ว`, 'success');
                          })
                          .withFailureHandler((err) => {
                            setBankEditSaving(false);
                            addToast('❌ เกิดข้อผิดพลาด: ' + err.message, 'error');
                          })
                          .adminSetPlayerBank(p.id, bankEditForm.bankName, bankEditForm.bankAccount, bankEditForm.accountName);
                      } else {
                        // Local preview mode — update state directly
                        setPlayers(prev => prev.map(pl =>
                          pl.id === p.id
                            ? { ...pl, bankName: bankEditForm.bankName, bankAccount: bankEditForm.bankAccount, accountName: bankEditForm.accountName }
                            : pl
                        ));
                        setBankEditSaving(false);
                        setBankEditModal(null);
                        addToast(`✅ บันทึกบัญชีธนาคาร (โหมดทดสอบ) ของ ${p.name} สำเร็จ`, 'success');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
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
                <div className="bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-4">
                  <h3 className="text-white font-bold text-base">＋ เพิ่มผู้เล่นใหม่</h3>
                  <p className="text-teal-100 text-xs mt-0.5">สร้างบัญชีผู้เล่นใหม่ในระบบ</p>
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
                    onClick={() => {
                      setCreatePlayerSaving(true);
                      const { lineId, name, balance } = createPlayerForm;
                      if (isGAS) {
                        window.google.script.run
                          .withSuccessHandler(data => {
                            setCreatePlayerSaving(false);
                            setCreatePlayerModal(false);
                            if (data && data.players) setPlayers(data.players);
                            addToast(`✅ สร้างบัญชี ${name} สำเร็จ และส่งข้อความ LINE แล้ว`, 'success');
                          })
                          .withFailureHandler(err => { setCreatePlayerSaving(false); addToast('❌ ' + err.message, 'error'); })
                          .adminCreatePlayer(lineId.trim(), name.trim(), balance);
                      } else {
                        const avatars = ['🐉','🐯','🦅','🦁','🐻','🐼','🦊','🦉'];
                        setPlayers(prev => [...prev, { id: lineId.trim(), name: name.trim(), balance, bankName: '', bankAccount: '', accountName: '', avatar: avatars[prev.length % avatars.length] }]);
                        setCreatePlayerSaving(false);
                        setCreatePlayerModal(false);
                        addToast(`✅ สร้างบัญชี ${name} สำเร็จ (โหมดทดสอบ)`, 'success');
                      }
                    }}
                    className="flex-1 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-all active:scale-95 shadow-md"
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
                  <p className="text-sm text-slate-600">การลบนี้จะ<strong>ลบข้อมูลผู้เล่นทั้งหมด</strong>ออกจาก Google Sheet ทันที และไม่สามารถกู้คืนได้</p>
                </div>
                <div className="px-6 pb-5 flex gap-3">
                  <button onClick={() => setConfirmDelete(null)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 text-sm font-bold rounded-xl hover:bg-slate-50 transition-all">ยกเลิก</button>
                  <button
                    disabled={deleteSaving}
                    onClick={() => {
                      setDeleteSaving(true);
                      const p = confirmDelete.player;
                      if (isGAS) {
                        window.google.script.run
                          .withSuccessHandler(data => {
                            setDeleteSaving(false);
                            setConfirmDelete(null);
                            if (data && data.players) setPlayers(data.players);
                            addToast(`🗑 ลบบัญชี ${p.name} สำเร็จ`, 'info');
                          })
                          .withFailureHandler(err => { setDeleteSaving(false); addToast('❌ ' + err.message, 'error'); })
                          .adminDeletePlayer(p.id);
                      } else {
                        setPlayers(prev => prev.filter(pl => pl.id !== p.id));
                        setDeleteSaving(false);
                        setConfirmDelete(null);
                        addToast(`🗑 ลบบัญชี ${p.name} สำเร็จ (โหมดทดสอบ)`, 'info');
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

          {/* TAB 4: SYSTEM TRANSACTIONS LOGS */}
          {adminTab === 'logs' && (
            <div className="glass-panel p-5 space-y-4 relative overflow-hidden group">
              {/* Watermark Icon */}
              <Database size={140} className="absolute -bottom-10 -right-10 text-slate-100/30 group-hover:text-teal-100/40 group-hover:scale-105 transition-all duration-500 ease-out pointer-events-none z-0" />
              
              <div className="relative z-10">
                <div className="card-header-ref card-header-dot-teal">
                  <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center justify-center gap-2 font-heading">
                    <Database size={14} className="text-teal-600" />
                    ประวัติทำรายการฝาก-ถอนของเงินเครดิตระบบ (Credit Transactions Archive)
                  </h3>
                </div>
              </div>

              <div className="space-y-2">
                {transactions.length === 0 ? (
                  <span className="text-slate-400 italic block py-4 text-center">-- ยังไม่มีทรานแซคชันเกิดขึ้นในเซสชันนี้ --</span>
                ) : (
                  transactions.map(tx => (
                    <div key={tx.id} className="p-3 bg-white border border-slate-200 rounded-xl font-mono text-[11px] flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-extrabold text-slate-800">ID: {tx.id}</span>
                          <span className="text-slate-400">[{tx.timestamp}]</span>
                          <span className="px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded font-bold text-slate-600 font-sans">
                            {tx.playerName}
                          </span>
                        </div>
                        {tx.id.startsWith('WD') ? (
                          <div className="text-slate-600 font-sans">
                            ขอลดถอนแต้ม: <span className="font-bold text-rose-700 font-mono">-{tx.requestedAmount} pt</span> ➜ โอนออกธนาคาร: <span className="font-bold text-slate-700 font-mono">{tx.actualAmount > 0 ? `${tx.actualAmount} THB` : 'รอโอน'}</span>
                          </div>
                        ) : (
                          <div className="text-slate-600 font-sans">
                            แจ้งสลิปเติม: <span className="font-bold text-sky-700 font-mono">{tx.requestedAmount} THB</span> ➜ โอนจริงตามสแกน: <span className="font-bold text-emerald-700 font-mono">{tx.actualAmount} THB</span>
                          </div>
                        )}
                        <div className="text-[10px] text-slate-400 font-sans">
                          {tx.id.startsWith('WD') ? (
                            <span>รายละเอียด: {tx.reviewReason}</span>
                          ) : (
                            <span>Ref อ้างอิงสลิป: {tx.slipRef} {tx.reviewReason && <span className="text-rose-600/90 font-bold">• หมายเหตุ: {tx.reviewReason}</span>}</span>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 font-sans font-bold">
                        {tx.status === 'success' && <span className="badge-success px-2 py-0.5 rounded-lg text-[10px]">อนุมัติแล้ว</span>}
                        {tx.status === 'escalated' && <span className="badge-warning px-2 py-0.5 rounded-lg text-[10px] animate-pulse">รอตรวจ</span>}
                        {tx.status === 'rejected' && <span className="badge-high px-2 py-0.5 rounded-lg text-[10px]">ปฏิเสธบิล</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB 5: LINE OA VIRTUAL CHAT */}
          {adminTab === 'line' && (
            <div className="glass-panel p-0 overflow-hidden flex flex-col md:flex-row h-[600px] border border-slate-200 rounded-2xl shadow-xl relative group">
              {/* Watermark Icon */}
              <MessageSquare size={140} className="absolute -bottom-10 -right-10 text-slate-100/20 group-hover:text-sky-100/30 group-hover:scale-105 transition-all duration-500 ease-out pointer-events-none z-0" />
              
              {/* Left sidebar: Players & Groups list */}
              <div className="w-full md:w-80 border-r border-slate-200 bg-slate-50 flex flex-col h-1/3 md:h-full shrink-0 relative z-10">
                <div className="p-3 border-b border-slate-200 bg-white shrink-0 space-y-2">
                  <div className="card-header-ref card-header-dot-sky !pb-1 !mb-1">
                    <h3 className="font-heading font-black text-xs text-slate-800 uppercase tracking-wider text-center">มอนิเตอร์แชต LINE OA & Groups</h3>
                  </div>
                  {/* Mode Selector: Groups vs 1-on-1 */}
                  <div className="grid grid-cols-2 gap-1 bg-slate-100 p-1 rounded-xl text-[10.5px] font-bold">
                    <button
                      onClick={() => setChatTypeMode('group')}
                      className={`py-1 rounded-lg text-center transition-all ${
                        chatTypeMode === 'group'
                          ? 'bg-emerald-600 text-white shadow-sm font-extrabold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      👥 กลุ่มดวลสด ({lineGroups.length || (activeGroupId ? 1 : 0)})
                    </button>
                    <button
                      onClick={() => setChatTypeMode('private')}
                      className={`py-1 rounded-lg text-center transition-all ${
                        chatTypeMode === 'private'
                          ? 'bg-sky-600 text-white shadow-sm font-extrabold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      👤 ส่วนตัว 1:1
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-2 space-y-1">
                  {(() => {
                    if (chatTypeMode === 'group') {
                      // Render connected LINE Group Rooms
                      const groupsToRender = lineGroups.length > 0 ? lineGroups : (activeGroupId ? [{ id: activeGroupId, name: `🚀 กลุ่มดวลสด LINE (#${activeGroupId.slice(-4)})`, lastMessage: 'เชื่อมต่อกลุ่มแล้ว', timestamp: 'Live' }] : []);
                      if (groupsToRender.length === 0) {
                        return (
                          <div className="text-center py-8 text-xs text-slate-400 italic font-sans space-y-1">
                            <div>👥 ยังไม่มีกลุ่ม LINE ดวลสดที่เชื่อมต่อ</div>
                            <div className="text-[10px] text-amber-600 font-normal">เชิญบอร์ดเข้ากลุ่ม หรือพิมพ์ข้อความในกลุ่มเพื่อเชื่อมต่อ</div>
                          </div>
                        );
                      }
                      return groupsToRender.map(g => {
                        const isSelected = selectedChatPlayerId === g.id;
                        return (
                          <button
                            key={g.id}
                            onClick={() => setSelectedChatPlayerId(g.id)}
                            className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 border ${
                              isSelected 
                                ? 'bg-emerald-600 border-emerald-600 text-white shadow-md' 
                                : 'bg-white border-slate-100 hover:bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="text-xl w-10 h-10 rounded-full bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center shrink-0 shadow-inner">
                              👥
                            </div>
                            <div className="flex-1 min-w-0 space-y-0.5">
                              <div className="flex items-center justify-between">
                                <span className="font-bold text-xs truncate block">{g.name}</span>
                                <span className={`text-[8.5px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                                  isSelected ? 'bg-emerald-500 text-white' : 'bg-emerald-50 text-emerald-700'
                                }`}>
                                  GROUP
                                </span>
                              </div>
                              <p className={`text-[10px] truncate ${isSelected ? 'text-emerald-100' : 'text-slate-400'}`}>
                                {g.lastMessage}
                              </p>
                            </div>
                          </button>
                        );
                      });
                    }
                    // Get unique users from chat logs
                    const uniquePlayers = [];
                    chatLogs.forEach(log => {
                      if (log.userId && !uniquePlayers.some(p => p.id === log.userId)) {
                        const pDb = players.find(p => p.id === log.userId);
                        uniquePlayers.push({
                          id: log.userId,
                          name: pDb ? pDb.name : log.displayName || 'ผู้เล่น LINE',
                          avatar: pDb ? pDb.avatar : '🐉',
                          balance: pDb ? pDb.balance : 0
                        });
                      }
                    });
                    
                    // Fallback to active players who are not 'user' to ensure admin can initiate chat
                    players.forEach(p => {
                      if (p.id !== 'user' && !uniquePlayers.some(up => up.id === p.id)) {
                        uniquePlayers.push({
                          id: p.id,
                          name: p.name,
                          avatar: p.avatar || '🐉',
                          balance: p.balance
                        });
                      }
                    });

                    if (uniquePlayers.length === 0) {
                      return <div className="text-center py-8 text-xs text-slate-400 italic font-sans">ไม่มีผู้เล่นในรายชื่อแชท</div>;
                    }

                    return uniquePlayers.map(p => {
                      const isSelected = selectedChatPlayerId === p.id;
                      const playerLogs = chatLogs.filter(log => log.userId === p.id);
                      const lastLog = playerLogs[playerLogs.length - 1];
                      const lastMsgText = lastLog ? (lastLog.text.length > 25 ? lastLog.text.substring(0, 25) + '...' : lastLog.text) : 'ยังไม่มีข้อความ';
                      
                      return (
                        <button
                          key={p.id}
                          onClick={() => setSelectedChatPlayerId(p.id)}
                          className={`w-full text-left p-3 rounded-xl transition-all flex items-center gap-3 border ${
                            isSelected 
                              ? 'bg-sky-600 border-sky-600 text-white shadow-md' 
                              : 'bg-white border-slate-100 hover:bg-slate-50 text-slate-700'
                          }`}
                        >
                          <div className="text-2xl w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0 shadow-inner">
                            {p.avatar}
                          </div>
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-xs truncate block">{p.name}</span>
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                                isSelected ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-500'
                              }`}>
                                {p.balance} pt
                              </span>
                            </div>
                            <p className={`text-[10px] truncate ${isSelected ? 'text-sky-100' : 'text-slate-400'}`}>
                              {lastMsgText}
                            </p>
                          </div>
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
              
              {/* Right main pane: chat messages & action interface */}
              <div className="flex-1 flex flex-col bg-white h-2/3 md:h-full">
                {selectedChatPlayerId ? (
                  <>
                    {/* Header showing player details */}
                    <div className="p-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50">
                      <div className="flex items-center gap-2.5">
                        <div className="text-xl">
                          {players.find(p => p.id === selectedChatPlayerId)?.avatar || '🐉'}
                        </div>
                        <div>
                          <h4 className="font-bold text-xs text-slate-800">
                            {players.find(p => p.id === selectedChatPlayerId)?.name || 'ผู้เล่น LINE'}
                          </h4>
                          <span className="text-[9px] font-mono text-slate-400">ID: {selectedChatPlayerId}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-sans font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 px-2.5 py-1 rounded-full">
                          เครดิต: {players.find(p => p.id === selectedChatPlayerId)?.balance || 0} pt
                        </span>
                      </div>
                    </div>
                    
                    {/* Message body container (scrollable) */}
                    <div 
                      ref={liveChatContainerRef}
                      className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50"
                    >
                      {chatLogs.filter(log => log.userId === selectedChatPlayerId).length === 0 ? (
                        <div className="text-center py-20 text-xs text-slate-400 italic font-sans">
                          -- เริ่มการสนทนากับผู้เล่น (แอดมินสามารถส่งข้อความตรงหรือปุ่ม Flex ได้ทันที) --
                        </div>
                      ) : (
                        chatLogs.filter(log => log.userId === selectedChatPlayerId).map((log, index) => {
                          const isAdmin = log.sender === 'admin';
                          const isBot = log.sender === 'bot';
                          
                          let bubbleBg = 'bg-white text-slate-800 border border-slate-200';
                          let containerClass = 'flex justify-start';
                          let nameColor = 'text-slate-500';
                          
                          if (isAdmin) {
                            bubbleBg = 'bg-sky-600 text-white shadow-sm';
                            containerClass = 'flex justify-end';
                            nameColor = 'text-sky-600 text-right';
                          } else if (isBot) {
                            bubbleBg = 'bg-purple-600 text-white shadow-sm';
                            containerClass = 'flex justify-end';
                            nameColor = 'text-purple-600 text-right';
                          }
                          
                          return (
                            <div key={index} className={`w-full ${containerClass} animate-fade-in`}>
                              <div className="max-w-[75%] space-y-0.5">
                                <span className={`text-[9px] block font-bold ${nameColor}`}>
                                  {isAdmin ? 'แอดมิน (Admin)' : isBot ? 'ระบบบอท (Automation)' : log.displayName}
                                  <span className="font-normal text-slate-400 ml-1.5">{log.timestamp}</span>
                                </span>
                                <div className={`p-3 rounded-2xl text-xs whitespace-pre-wrap font-sans ${bubbleBg}`}>
                                  {log.text}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                      <div ref={liveChatEndRef} />
                    </div>
                    
                    {/* Footer input and quick action shortcuts */}
                    <div className="p-4 border-t border-slate-200 bg-white shrink-0 space-y-3">
                      {/* Flex Action Buttons */}
                      <div className="flex flex-wrap gap-2">
                        <span className="text-[10px] text-slate-400 font-bold self-center mr-1">ส่งปุ่มด่วน (Flex Card):</span>
                        <button
                          onClick={() => handleSendAdminChatMessage('เมนู')}
                          className="px-2.5 py-1 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg text-[10px] font-bold transition-all active:scale-95 flex items-center gap-1"
                        >
                          📋 ส่งเมนูหลัก
                        </button>
                        <button
                          onClick={() => handleSendAdminChatMessage('เช็คยอด')}
                          className="px-2.5 py-1 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 rounded-lg text-[10px] font-bold transition-all active:scale-95 flex items-center gap-1"
                        >
                          💳 ส่งเช็คยอด
                        </button>
                        <button
                          onClick={() => handleSendAdminChatMessage('ฝากเงิน')}
                          className="px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg text-[10px] font-bold transition-all active:scale-95 flex items-center gap-1"
                        >
                          📥 ส่งปุ่มฝาก
                        </button>
                        <button
                          onClick={() => handleSendAdminChatMessage('ถอนเงิน')}
                          className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-[10px] font-bold transition-all active:scale-95 flex items-center gap-1"
                        >
                          📤 ส่งปุ่มถอน
                        </button>
                      </div>
                      
                      {/* Chat text input bar */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={adminChatInput}
                          onChange={(e) => setAdminChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSendAdminChatMessage();
                          }}
                          placeholder="พิมพ์ข้อความคุยกับผู้เล่น หรือพิมพ์คำสั่งส่ง Flex..."
                          className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none placeholder-slate-400"
                        />
                        <button
                          onClick={() => handleSendAdminChatMessage()}
                          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-bold transition-all active:scale-95 shadow-md flex items-center gap-1 shrink-0"
                        >
                          <Send size={12} />
                          ส่ง
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-slate-50/50">
                    <div className="text-4xl animate-bounce mb-3">💬</div>
                    <h4 className="font-heading font-black text-sm text-slate-700">กรุณาเลือกผู้เล่นจากคอลัมน์ด้านซ้าย</h4>
                    <p className="text-xs text-slate-400 font-sans max-w-xs mt-1">เพื่ออ่านบทสนทนาและโต้ตอบโดยส่งข้อความหรือ Flex Cards ควบคุมไปยังผู้เล่นคนดังกล่าว</p>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Dynamic Settle Outcome Result Report Popup Overlay Modal */}
      {settlementResult && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[99999] p-4 animate-fade-in font-sans">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 max-w-md w-full text-slate-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="text-center space-y-2">
              <div className="text-4xl">🚀</div>
              <h3 className="text-lg font-black text-slate-900 font-heading">
                สรุปผลการจับเวลาขีปนาวุธ ({settlementResult.rocketName || 'โชคน้องกวาง'})
              </h3>
              <p className="text-xs text-slate-500">ผลการปล่อยจรวดเปรียบเทียบเกณฑ์เส้นแบ่งราคาช่าง</p>
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
                setRocketStatus('idle');
                setRocketFlightTime(0.00);
              }}
              className="w-full py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-bold transition-all active:scale-95 shadow-md flex items-center justify-center gap-1.5"
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
function PlayerDashboard({ player, transactions, bets, chatLogs, playerUserId, players, isGAS, setToasts, addToast, setChatLogs }) {
  const [activeTab, setActiveTab] = useState('statement'); // 'statement' | 'bets' | 'chat'
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatLogs, activeTab]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const text = chatInput;
    setChatInput('');

    const tStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    const newLog = {
      timestamp: tStr,
      userId: playerUserId,
      displayName: player.name || 'ผู้เล่น',
      sender: 'user',
      text: text,
      type: 'text'
    };
    
    // Add locally for instant UI update
    setChatLogs(prev => [...prev, newLog]);

    if (isGAS) {
      window.google.script.run
        .withSuccessHandler(() => {
          // Message processed successfully
        })
        .simulateTextMessageFromDashboard(text, playerUserId, player.name);
    } else {
      // Sandbox Simulator Reply Simulation
      setTimeout(() => {
        const clean = text.replace(/\s+/g, '').toLowerCase();
        let botText = `[ระบบบอท] ได้รับข้อความ "${text}" เรียบร้อยแล้วครับ เจ้าหน้าที่จะรีบตรวจสอบโดยเร็วที่สุด`;
        
        if (clean === 'เช็คยอด' || clean === 'คงเหลือ' || clean === 'balance') {
          botText = `💳 ยอดเครดิตคงเหลือของคุณ:\n\n👤 ผู้เล่น: ${player.name}\n💰 คงเหลือ: ${player.balance.toFixed(2)} แต้ม`;
        } else if (clean === 'ฝากเงิน' || clean === 'เติมเงิน' || clean === 'deposit') {
          botText = `💰 ฝากเครดิตเข้าระบบ (1:1)\n\nกรุณาพิมพ์จำนวนเงินที่ต้องการฝาก เช่น "100" หรือ "500" ได้เลยครับ`;
        } else if (clean === 'ถอนเงิน' || clean === 'ถอนยอด' || clean === 'withdraw') {
          botText = `💸 ถอนเครดิตคืนเข้าบัญชี\n\nยอดถอนขั้นต่ำคือ 100 แต้ม กรุณาพิมพ์ระบุจำนวนเงินที่ต้องการถอน เช่น "ถอน 300"`;
        }

        const botReply = {
          timestamp: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
          userId: playerUserId,
          displayName: player.name,
          sender: 'bot',
          text: botText,
          type: 'text'
        };
        setChatLogs(prev => [...prev, botReply]);
      }, 1200);
    }
  };

  return (
    <div className="w-full max-w-4xl min-h-screen p-4 md:p-6 flex flex-col font-sans text-slate-800 bg-slate-50/50">
      {/* Brand Header */}
      <header className="mb-6 flex justify-between items-center border-b border-slate-200 pb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center text-white text-lg">💳</div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-teal-800 uppercase font-heading">
              Demo Statement Console
            </h1>
            <p className="text-[10px] text-slate-500">ระบบตรวจสอบรายการเดินบัญชีผู้เล่นรายบุคคล</p>
          </div>
        </div>
        <span className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase bg-teal-100 text-teal-800 border border-teal-200">
          Player View
        </span>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-grow">
        {/* Left Card: Account Summary */}
        <div className="md:col-span-1 space-y-4">
          <div className="glass-panel p-5 bg-gradient-to-br from-teal-700 to-emerald-800 text-white rounded-2xl shadow-lg border-none">
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

          <div className="glass-panel p-5 space-y-3">
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
        <div className="md:col-span-2 flex flex-col glass-panel overflow-hidden h-[600px]">
          {/* Tab switches */}
          <div className="flex border-b border-slate-200/80 bg-slate-50/50 text-xs font-bold text-slate-500">
            <button
              onClick={() => setActiveTab('statement')}
              className={`flex-1 py-3 border-b-2 text-center transition-all ${
                activeTab === 'statement' ? 'border-teal-600 text-teal-700 bg-white font-black' : 'border-transparent hover:text-slate-700'
              }`}
            >
              📊 ประวัติการเงิน ({transactions.length})
            </button>
            <button
              onClick={() => setActiveTab('bets')}
              className={`flex-1 py-3 border-b-2 text-center transition-all ${
                activeTab === 'bets' ? 'border-teal-600 text-teal-700 bg-white font-black' : 'border-transparent hover:text-slate-700'
              }`}
            >
              🚀 รายการดวล ({bets.length})
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
                            !isWithdrawal ? 'bg-teal-50 text-teal-700 border border-teal-100' : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}>
                            {!isWithdrawal ? 'ฝากเงิน' : 'ถอนเงิน'}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 block mt-1">Ref: {t.slipRef || '-'}</span>
                          <span className="text-[9px] text-slate-400 block">{t.timestamp}</span>
                        </div>
                        <div className="text-right space-y-1.5">
                          <span className={`text-sm font-black font-mono block ${!isWithdrawal ? 'text-teal-600' : 'text-slate-600'}`}>
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
                  <div className="text-center py-12 text-slate-400 text-xs italic font-sans">ไม่มีประวัติการส่งข้อมูลดวลความเร็วขีปนาวุธ</div>
                ) : (
                  bets.slice().reverse().map(b => {
                    const isLow = b.playerLowId === playerUserId;
                    const sideText = isLow ? 'ต่ำ (LOW)' : 'สูง (HIGH)';
                    const opponentText = isLow ? b.playerHighName : b.playerLowName;
                    
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
                            <span>คู่ดวล: {opponentText}</span>
                            {b.finalTime !== undefined && (
                              <span>เวลาจรวด: <strong className="text-slate-700">{b.finalTime}s</strong></span>
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
// ADMIN PASSCODE LOCK SCREEN
// -------------------------------------------------------------
function AdminLockScreen({ passcodeInput, setPasscodeInput, passcodeError, setPasscodeError, setAdminAuthenticated, adminPasscode }) {
  const handleLogin = (e) => {
    e.preventDefault();
    if (passcodeInput === adminPasscode) {
      setAdminAuthenticated(true);
      setPasscodeError('');
    } else {
      setPasscodeError('รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 px-4 font-sans">
      <div className="w-full max-w-md bg-slate-800/80 border border-slate-700/50 backdrop-blur-xl p-8 rounded-2xl shadow-2xl space-y-6 text-white">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 rounded-full flex items-center justify-center mx-auto text-emerald-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-lock"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h2 className="text-2xl font-black font-heading tracking-tight">เข้าสู่ระบบแอดมิน</h2>
          <p className="text-xs text-slate-400">ระบบควบคุมจรวดและธนาคารจำลอง (Rocket Science Admin Console)</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-300 block">รหัสผ่านแอดมิน (Admin Passcode)</label>
            <input 
              type="password"
              placeholder="ป้อนรหัสผ่าน..."
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              className="w-full px-4 py-3 bg-slate-950/50 border border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-white font-mono text-center tracking-widest text-lg"
            />
          </div>

          {passcodeError && (
            <p className="text-xs font-semibold text-rose-400 text-center">
              ⚠️ {passcodeError}
            </p>
          )}

          <button
            type="submit"
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 active:scale-98 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/20 transition-all flex items-center justify-center gap-2"
          >
            ยืนยันรหัสผ่าน
          </button>
        </form>
      </div>
    </div>
  );
}
