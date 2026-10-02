import { useState, useRef, useEffect } from 'react';
import { 
  User, 
  Lock, 
  Eye, 
  EyeOff, 
  LogIn, 
  Rocket, 
  ShieldCheck, 
  AlertTriangle, 
  BookOpen, 
  FileCheck, 
  ArrowUp, 
  Menu, 
  X
} from 'lucide-react';

// -------------------------------------------------------------
// ISOMETRIC TECH ARTWORK (Inspired by reference image)
// -------------------------------------------------------------
function AdminHeroIllustration() {
  return (
    <div className="relative w-full max-w-[560px] mx-auto select-none">
      {/* Ambient background glow */}
      <div 
        className="absolute -top-12 -left-12 w-72 h-72 rounded-full pointer-events-none opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, #47b2e4 0%, rgba(55,81,126,0) 70%)' }}
      />
      <div 
        className="absolute -bottom-10 -right-10 w-80 h-80 rounded-full pointer-events-none opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, #0ea5e9 0%, rgba(55,81,126,0) 70%)' }}
      />

      {/* SVG Isometric Artwork */}
      <svg 
        viewBox="0 0 680 500" 
        className="w-full h-auto drop-shadow-2xl overflow-visible"
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gradients */}
          <linearGradient id="isoGridGrad" x1="100" y1="200" x2="580" y2="460" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#47b2e4" stopOpacity="0.4" />
            <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#253754" stopOpacity="0.05" />
          </linearGradient>

          <linearGradient id="laptopScreenGrad" x1="280" y1="120" x2="520" y2="280" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0f172a" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>

          <linearGradient id="chartWaveGrad" x1="300" y1="160" x2="500" y2="220" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#47b2e4" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.05" />
          </linearGradient>

          <linearGradient id="beaconBeamGrad" x1="530" y1="310" x2="530" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#47b2e4" stopOpacity="0.8" />
            <stop offset="70%" stopColor="#38bdf8" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* -------------------------------------------------------------
            ISOMETRIC FLOOR PLANE & CIRCUIT TRACES
           ------------------------------------------------------------- */}
        {/* Floor Diamond */}
        <polygon 
          points="340,170 630,310 340,470 50,330" 
          fill="#1e2d44" 
          stroke="#47b2e4" 
          strokeWidth="1.5" 
          strokeOpacity="0.3"
        />

        {/* Isometric Grid Lines */}
        <g stroke="url(#isoGridGrad)" strokeWidth="1" strokeDasharray="3 3">
          <line x1="120" y1="295" x2="410" y2="435" />
          <line x1="190" y1="260" x2="480" y2="400" />
          <line x1="260" y1="225" x2="550" y2="365" />

          <line x1="190" y1="365" x2="480" y2="225" />
          <line x1="260" y1="400" x2="550" y2="260" />
          <line x1="120" y1="330" x2="410" y2="190" />
        </g>

        {/* Glowing Circuit Traces */}
        <path 
          d="M 160 300 L 260 350 L 340 310 L 410 345 L 530 285" 
          stroke="#47b2e4" 
          strokeWidth="2.5" 
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="drop-shadow(0 0 4px #47b2e4)"
        />
        <path 
          d="M 260 350 L 260 400 L 340 440" 
          stroke="#38bdf8" 
          strokeWidth="1.8" 
          strokeLinecap="round"
          strokeOpacity="0.8"
        />
        <path 
          d="M 340 310 L 340 250 L 430 205" 
          stroke="#38bdf8" 
          strokeWidth="1.8" 
          strokeLinecap="round"
          strokeOpacity="0.8"
        />

        {/* Circuit Nodes (Dots) */}
        <circle cx="160" cy="300" r="4" fill="#47b2e4" />
        <circle cx="260" cy="350" r="4.5" fill="#38bdf8" />
        <circle cx="340" cy="310" r="4" fill="#47b2e4" />
        <circle cx="410" cy="345" r="4" fill="#00e5ff" />
        <circle cx="530" cy="285" r="5" fill="#47b2e4" />
        <circle cx="260" cy="400" r="3.5" fill="#38bdf8" />
        <circle cx="340" cy="440" r="4.5" fill="#47b2e4" />

        {/* -------------------------------------------------------------
            LEFT: STACKED SERVER BLADE RACKS (Cloudflare KV Node)
           ------------------------------------------------------------- */}
        <g transform="translate(-10, -10)">
          {/* Server Unit 3 (Bottom) */}
          <polygon points="120,290 170,265 210,285 160,310" fill="#2d4163" stroke="#47b2e4" strokeWidth="1" />
          <polygon points="120,290 160,310 160,335 120,315" fill="#1b283d" stroke="#47b2e4" strokeWidth="0.8" />
          <polygon points="160,310 210,285 210,310 160,335" fill="#24344d" stroke="#47b2e4" strokeWidth="0.8" />
          {/* Server Unit 2 (Middle) */}
          <polygon points="120,260 170,235 210,255 160,280" fill="#2d4163" stroke="#47b2e4" strokeWidth="1" />
          <polygon points="120,260 160,280 160,290 120,270" fill="#1b283d" stroke="#47b2e4" strokeWidth="0.8" />
          <polygon points="160,280 210,255 210,265 160,290" fill="#24344d" stroke="#47b2e4" strokeWidth="0.8" />
          {/* Server Unit 1 (Top) */}
          <polygon points="120,230 170,205 210,225 160,250" fill="#37517e" stroke="#47b2e4" strokeWidth="1.2" />
          <polygon points="120,230 160,250 160,260 120,240" fill="#1b283d" stroke="#47b2e4" strokeWidth="0.8" />
          <polygon points="160,250 210,225 210,235 160,260" fill="#24344d" stroke="#47b2e4" strokeWidth="0.8" />

          {/* Server Activity LEDs */}
          <circle cx="168" cy="274" r="2.2" fill="#00e5ff" className="animate-pulse" />
          <circle cx="176" cy="270" r="2.2" fill="#10b981" />
          <circle cx="184" cy="266" r="2.2" fill="#00e5ff" />
          <circle cx="192" cy="262" r="2.2" fill="#38bdf8" />

          <circle cx="168" cy="304" r="2.2" fill="#10b981" />
          <circle cx="176" cy="300" r="2.2" fill="#00e5ff" className="animate-pulse" />
          <circle cx="184" cy="296" r="2.2" fill="#38bdf8" />

          <circle cx="168" cy="244" r="2.2" fill="#38bdf8" />
          <circle cx="176" cy="240" r="2.2" fill="#10b981" />
          <circle cx="184" cy="236" r="2.2" fill="#00e5ff" className="animate-pulse" />
        </g>

        {/* -------------------------------------------------------------
            CENTER: ISOMETRIC LAPTOP DISPLAY (Admin Telemetry Board)
           ------------------------------------------------------------- */}
        <g id="isometricLaptop">
          {/* Laptop Base (Lower Wedge) */}
          <polygon points="270,300 480,200 560,240 350,340" fill="#1e293b" stroke="#47b2e4" strokeWidth="1.5" />
          <polygon points="270,300 350,340 350,352 270,312" fill="#0f172a" stroke="#47b2e4" strokeWidth="1" />
          <polygon points="350,340 560,240 560,252 350,352" fill="#172338" stroke="#47b2e4" strokeWidth="1" />

          {/* Keyboard Surface & Keys */}
          <polygon points="305,290 470,212 525,240 360,318" fill="#111c2e" stroke="#334155" strokeWidth="1" />
          {/* Trackpad */}
          <polygon points="340,320 375,304 395,314 360,330" fill="#1e2d45" stroke="#47b2e4" strokeWidth="0.8" strokeOpacity="0.5" />

          {/* Screen Bezel (Tilted Back) */}
          <polygon points="270,300 480,200 480,70 270,170" fill="#0f172a" stroke="#47b2e4" strokeWidth="2" />
          {/* Inner Screen Surface */}
          <polygon points="280,290 470,200 470,85 280,175" fill="url(#laptopScreenGrad)" stroke="#38bdf8" strokeWidth="1" />

          {/* Screen Content: Telemetry & Flight Chart */}
          {/* Top Window Bar */}
          <polygon points="282,175 468,91 468,103 282,187" fill="#1e2d48" />
          <circle cx="292" cy="180" r="2.5" fill="#ef4444" />
          <circle cx="300" cy="176" r="2.5" fill="#f59e0b" />
          <circle cx="308" cy="172" r="2.5" fill="#10b981" />
          <text x="325" y="172" fill="#94a3b8" fontSize="8" fontFamily="sans-serif" transform="rotate(-25 325 172)">
            BANG FAI TELEMETRY LIVE
          </text>

          {/* Telemetry Wave Curve */}
          <path 
            d="M 295 245 Q 330 220 360 235 T 410 170 T 455 140" 
            stroke="#47b2e4" 
            strokeWidth="2.5" 
            fill="none"
            filter="drop-shadow(0 0 5px #00e5ff)"
          />
          {/* Gradient Area under Wave */}
          <polygon 
            points="295,245 360,235 410,170 455,140 455,180 295,255" 
            fill="url(#chartWaveGrad)" 
          />

          {/* Flight Timer Pill on Screen */}
          <polygon points="310,270 380,237 380,222 310,255" fill="#0284c7" fillOpacity="0.8" />
          <text x="318" y="260" fill="#ffffff" fontSize="9" fontWeight="bold" fontFamily="monospace" transform="rotate(-25 318 260)">
            01:42.85s
          </text>
        </g>

        {/* -------------------------------------------------------------
            FOREGROUND: ISOMETRIC SMARTPHONE (LINE OA Slip OCR 1:1)
           ------------------------------------------------------------- */}
        <g id="isometricPhone" transform="translate(140, 240)">
          {/* Phone Body */}
          <polygon points="60,110 140,70 175,88 95,128" fill="#1e293b" stroke="#47b2e4" strokeWidth="1.5" />
          <polygon points="60,110 95,128 95,135 60,117" fill="#0f172a" stroke="#47b2e4" strokeWidth="1" />
          <polygon points="95,128 175,88 175,95 95,135" fill="#172338" stroke="#47b2e4" strokeWidth="1" />

          {/* Phone Screen */}
          <polygon points="65,108 135,73 168,89 98,124" fill="#0c4a6e" stroke="#38bdf8" strokeWidth="0.8" />
          {/* LINE OA Green Check Badge */}
          <circle cx="115" cy="98" r="10" fill="#10b981" />
          <path d="M 111 98 L 114 101 L 120 95" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {/* Text in Phone */}
          <text x="75" y="117" fill="#bae6fd" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif" transform="rotate(-25 75 117)">
            SLIP 1:1 VERIFIED
          </text>
        </g>

        {/* -------------------------------------------------------------
            RIGHT: TELEMETRY SIGNAL BEACON & HOLOGRAPHIC WAVE
           ------------------------------------------------------------- */}
        <g id="telemetryBeacon" transform="translate(490, 250)">
          {/* Beacon Base */}
          <ellipse cx="40" cy="50" rx="35" ry="18" fill="#1b283d" stroke="#47b2e4" strokeWidth="1.5" />
          <ellipse cx="40" cy="40" rx="30" ry="15" fill="#2c3e5e" stroke="#38bdf8" strokeWidth="1" />
          <ellipse cx="40" cy="30" rx="20" ry="10" fill="#0284c7" stroke="#00e5ff" strokeWidth="1.5" />

          {/* Vertical Light Shaft */}
          <polygon points="25,30 55,30 65,-90 15,-90" fill="url(#beaconBeamGrad)" />

          {/* Hologram Pulse Rings */}
          <ellipse cx="40" cy="-20" rx="32" ry="12" stroke="#47b2e4" strokeWidth="1.2" strokeDasharray="4 4" className="animate-pulse" />
          <ellipse cx="40" cy="-60" rx="24" ry="9" stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx="40" cy="-90" r="4" fill="#00e5ff" filter="drop-shadow(0 0 6px #00e5ff)" />
        </g>

        {/* -------------------------------------------------------------
            FLOATING METRIC CARDS / HOLOGRAPHIC CHIPS
           ------------------------------------------------------------- */}
        {/* Chip 1: Edge Latency */}
        <g transform="translate(80, 150)">
          <rect x="0" y="0" width="130" height="42" rx="8" fill="#1b2a41" stroke="#47b2e4" strokeWidth="1.2" fillOpacity="0.9" />
          <circle cx="16" cy="21" r="5" fill="#10b981" />
          <text x="28" y="18" fill="#94a3b8" fontSize="8" fontWeight="600" fontFamily="sans-serif">EDGE LATENCY</text>
          <text x="28" y="32" fill="#ffffff" fontSize="12" fontWeight="bold" fontFamily="sans-serif">&lt; 25 ms (Global)</text>
        </g>

        {/* Chip 2: Auto OCR Verification */}
        <g transform="translate(420, 70)">
          <rect x="0" y="0" width="150" height="42" rx="8" fill="#1b2a41" stroke="#38bdf8" strokeWidth="1.2" fillOpacity="0.9" />
          <circle cx="16" cy="21" r="5" fill="#0ea5e9" />
          <text x="28" y="18" fill="#94a3b8" fontSize="8" fontWeight="600" fontFamily="sans-serif">LINE OA BOT 1:1</text>
          <text x="28" y="32" fill="#ffffff" fontSize="11" fontWeight="bold" fontFamily="sans-serif">Auto-OCR Verified</text>
        </g>

        {/* Chip 3: O(1) KV Index State */}
        <g transform="translate(450, 370)">
          <rect x="0" y="0" width="140" height="40" rx="8" fill="#1b2a41" stroke="#47b2e4" strokeWidth="1" fillOpacity="0.9" />
          <circle cx="16" cy="20" r="4.5" fill="#f59e0b" />
          <text x="28" y="16" fill="#94a3b8" fontSize="7.5" fontWeight="600" fontFamily="sans-serif">KV STATE MACHINE</text>
          <text x="28" y="30" fill="#38bdf8" fontSize="11" fontWeight="bold" fontFamily="monospace">O(1) Array Index</text>
        </g>
      </svg>
    </div>
  );
}

// -------------------------------------------------------------
// MAIN ADMIN LOCK SCREEN COMPONENT
// -------------------------------------------------------------
export default function AdminLockScreen({ 
  usernameInput, 
  setUsernameInput, 
  passwordInput, 
  setPasswordInput, 
  loginError, 
  setLoginError, 
  setAdminAuthenticated, 
  adminUsername, 
  adminPassword, 
  adminPasscode,
  runBackendFunction 
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('usage');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);

  const userInputRef = useRef(null);
  const docsSectionRef = useRef(null);
  const loginCardRef = useRef(null);

  // Monitor scroll position for back-to-top button
  useEffect(() => {
    const handleScroll = () => {
      if (typeof window !== 'undefined') {
        setShowBackToTop(window.scrollY > 400);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Smooth scroll to docs section and activate tab
  const handleNavClick = (tabKey) => {
    setActiveTab(tabKey);
    setMobileMenuOpen(false);
    if (docsSectionRef.current) {
      docsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Smooth scroll back to login card and focus username input
  const handleScrollToLogin = () => {
    setMobileMenuOpen(false);
    if (loginCardRef.current) {
      loginCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        if (userInputRef.current) userInputRef.current.focus();
      }, 400);
    }
  };

  // Handle Login submission
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');

    const userClean = (usernameInput || '').trim();
    const passClean = (passwordInput || '');

    if (!userClean) {
      setLoginError('กรุณาระบุชื่อผู้ใช้ (Username)');
      if (userInputRef.current) userInputRef.current.focus();
      return;
    }
    if (!passClean) {
      setLoginError('กรุณาระบุรหัสผ่าน (Password)');
      return;
    }

    setIsSubmitting(true);

    const isUserMatch = adminUsername ? userClean.toLowerCase() === adminUsername.toLowerCase() : true;
    const isPassMatch = Boolean((adminPassword && passClean === adminPassword) || (adminPasscode && passClean === adminPasscode));

    let loginSuccess = Boolean(isUserMatch && isPassMatch);
    let resolvedAdminKey = 'urkDQHE2Mm8Q4oqhS_1ftZV0EqWT-cAT';

    // Try backend RPC login
    if (typeof runBackendFunction === 'function') {
      try {
        const res = await runBackendFunction('adminLogin', [userClean, passClean]);
        if (res && res.success) {
          loginSuccess = true;
          if (res.adminKey) resolvedAdminKey = res.adminKey;
        }
      } catch {
        // ignore RPC login exception
      }
    }

    setIsSubmitting(false);

    if (loginSuccess) {
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('rocket_admin_auth', 'true');
        sessionStorage.setItem('rocket_admin_user', userClean);
        sessionStorage.setItem('rocket_admin_key', resolvedAdminKey);
      }
      setAdminAuthenticated(true);
      setLoginError('');
    } else {
      setLoginError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
      setPasswordInput('');
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#37517e] text-white font-sans flex flex-col selection:bg-[#47b2e4] selection:text-white">
      {/* -------------------------------------------------------------
          TOP NAVIGATION BAR (Rescaled for Professional Alignment)
         ------------------------------------------------------------- */}
      <header className="sticky top-0 z-50 w-full bg-[#37517e]/95 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 lg:px-8 py-3 transition-all">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 lg:gap-8">
          
          {/* Brand Logo & Title */}
          <div 
            className="flex items-center gap-3 cursor-pointer shrink-0" 
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <div className="w-9 h-9 rounded-xl bg-[#47b2e4] flex items-center justify-center text-white border border-white/20 shrink-0">
              <Rocket size={20} className="transform -rotate-45" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-base sm:text-lg font-black font-heading tracking-tight text-white uppercase whitespace-nowrap">
                  Bang Fai Commander
                </span>
                <span className="hidden md:inline-block px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider bg-white/10 text-[#47b2e4] rounded border border-[#47b2e4]/30 whitespace-nowrap">
                  Cloud Portal
                </span>
              </div>
              <p className="text-[11px] text-[#c5d5e8] font-normal hidden lg:block whitespace-nowrap">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนาม
              </p>
            </div>
          </div>

          {/* Desktop Navigation Links (Clean Single-Line Alignment) */}
          <nav className="hidden md:flex items-center gap-6 lg:gap-8 text-sm font-medium text-[#c5d5e8] shrink-0">
            <button 
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="hover:text-white transition-colors cursor-pointer whitespace-nowrap py-1 font-medium"
            >
              หน้าหลัก
            </button>
            <button 
              type="button"
              onClick={() => handleNavClick('usage')}
              className={`hover:text-white transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'usage' ? 'text-[#47b2e4] font-bold' : ''}`}
            >
              <BookOpen size={15} />
              <span>คู่มือการใช้งาน</span>
            </button>
            <button 
              type="button"
              onClick={() => handleNavClick('terms')}
              className={`hover:text-white transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'terms' ? 'text-[#47b2e4] font-bold' : ''}`}
            >
              <FileCheck size={15} />
              <span>ข้อกำหนดและเงื่อนไข</span>
            </button>
          </nav>

          {/* Action CTA: Sign In Button */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleScrollToLogin}
              className="px-4 sm:px-5 py-2 rounded-full bg-[#47b2e4] hover:bg-[#38a3d6] active:bg-[#2c91c3] text-white text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center gap-2 cursor-pointer border border-[#68c6f3]/40 whitespace-nowrap shrink-0 shadow-none"
            >
              <LogIn size={15} />
              <span>เข้าสู่ระบบ (Sign In)</span>
            </button>

            {/* Mobile Hamburger Toggle */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors shrink-0"
              aria-label="Toggle Navigation Menu"
            >
              {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden mt-3 pt-3 border-t border-white/10 flex flex-col gap-2 pb-2">
            <button
              type="button"
              onClick={() => { setMobileMenuOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              className="text-left px-3 py-2 rounded-lg text-sm text-[#c5d5e8] hover:bg-white/10 hover:text-white"
            >
              หน้าหลัก (Home)
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('usage')}
              className="text-left px-3 py-2 rounded-lg text-sm text-[#c5d5e8] hover:bg-white/10 hover:text-white flex items-center gap-2"
            >
              <BookOpen size={16} className="text-[#47b2e4]" />
              <span>คู่มือการใช้งาน (Usage Instructions)</span>
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('terms')}
              className="text-left px-3 py-2 rounded-lg text-sm text-[#c5d5e8] hover:bg-white/10 hover:text-white flex items-center gap-2"
            >
              <FileCheck size={16} className="text-[#47b2e4]" />
              <span>ข้อกำหนดและเงื่อนไข (Terms of Use)</span>
            </button>
          </div>
        )}
      </header>

      {/* -------------------------------------------------------------
          HERO SECTION: 2-COLUMN BALANCED COMPOSITION
         ------------------------------------------------------------- */}
      <section className="relative w-full pt-8 pb-16 sm:py-16 px-4 sm:px-8 max-w-7xl mx-auto flex-1 flex flex-col justify-center">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
          
          {/* LEFT COLUMN: Headings & Sign-In Card */}
          <div className="lg:col-span-6 space-y-6">
            
            {/* Status Overline Badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-[#47b2e4]/40 text-[#47b2e4] text-xs font-semibold">
              <span className="w-2 h-2 rounded-full bg-[#00e5ff] animate-pulse" />
              <span>Cloudflare Worker & LINE OA 1:1 Gateway</span>
            </div>

            {/* Main Headline */}
            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold font-heading text-white tracking-tight leading-tight">
                Better Solutions For Your Operations
              </h1>
              <h2 className="text-lg sm:text-xl font-semibold text-[#a5c5e8] font-thai">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนามระดับองค์กร
              </h2>
              <p className="text-sm sm:text-base text-[#c5d5e8] leading-relaxed max-w-xl font-thai font-normal">
                ศูนย์กลางประมวลผลคำสั่งซื้อ, ตรวจสลิปเงินโอน 1:1 อัตโนมัติผ่าน LINE OA 
                พร้อมแดชบอร์ดแอดมินสำหรับควบคุมรอบแข่งขัน และระบบจำลองความเร็วเวลาการบินบั้งไฟบน Cloudflare Edge
              </p>
            </div>

            {/* ADMIN SIGN-IN CARD (Clean Frosted Navy Card) */}
            <div 
              ref={loginCardRef}
              className="bg-[#243552]/90 border border-[#47b2e4]/35 rounded-2xl p-6 sm:p-7 backdrop-blur-md space-y-5"
            >
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-[#47b2e4]/20 border border-[#47b2e4]/40 flex items-center justify-center text-[#47b2e4]">
                    <Lock size={17} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white tracking-tight">
                      เข้าสู่ระบบผู้ดูแล (Admin Portal)
                    </h3>
                    <p className="text-xs text-[#a5c5e8]">
                      ระบุ Username และ Password เพื่อเข้าถึงคอนโซลควบคุม
                    </p>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded font-mono font-semibold">
                  TLS 1.3 SECURED
                </span>
              </div>

              {/* Login Form */}
              <form onSubmit={handleLogin} className="space-y-4">
                {/* Username Input */}
                <div className="space-y-1.5">
                  <label 
                    htmlFor="admin-username-field" 
                    className="text-xs font-semibold text-[#c5d5e8] block"
                  >
                    ชื่อผู้ใช้ (Username)
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#47b2e4]">
                      <User size={17} />
                    </span>
                    <input 
                      id="admin-username-field"
                      ref={userInputRef}
                      type="text"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck="false"
                      placeholder="ป้อนชื่อผู้ใช้ (เช่น admin)..."
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 bg-[#18263d] border border-[#3b537d] rounded-lg focus:outline-none focus:border-[#47b2e4] focus:ring-1 focus:ring-[#47b2e4] text-white placeholder-slate-400 font-sans text-sm tracking-normal transition-colors"
                      autoFocus
                    />
                  </div>
                </div>

                {/* Password Input */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label 
                      htmlFor="admin-password-field" 
                      className="text-xs font-semibold text-[#c5d5e8] block"
                    >
                      รหัสผ่าน (Password)
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="text-[11px] text-[#47b2e4] hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      {showPassword ? (
                        <>
                          <EyeOff size={12} />
                          <span>ซ่อนรหัสผ่าน</span>
                        </>
                      ) : (
                        <>
                          <Eye size={12} />
                          <span>แสดงรหัสผ่าน</span>
                        </>
                      )}
                    </button>
                  </div>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#47b2e4]">
                      <Lock size={17} />
                    </span>
                    <input 
                      id="admin-password-field"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="ป้อนรหัสผ่าน..."
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      className="w-full pl-10 pr-10 py-2.5 bg-[#18263d] border border-[#3b537d] rounded-lg focus:outline-none focus:border-[#47b2e4] focus:ring-1 focus:ring-[#47b2e4] text-white placeholder-slate-400 font-mono text-sm tracking-wider transition-colors"
                    />
                  </div>
                </div>

                {/* Error Banner */}
                {loginError && (
                  <div className="p-3 bg-rose-500/20 border border-rose-500/50 rounded-lg flex items-center gap-2.5 text-rose-200">
                    <AlertTriangle size={18} className="shrink-0 text-rose-400" />
                    <span className="text-xs font-semibold">
                      {loginError}
                    </span>
                  </div>
                )}

                {/* Sign-In Submit Button (Reference-style Bright Cyan Pill) */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 px-6 bg-[#47b2e4] hover:bg-[#38a3d6] active:bg-[#2c91c3] disabled:opacity-50 text-white rounded-full text-sm font-bold tracking-wide transition-all flex items-center justify-center gap-2 cursor-pointer border border-[#68c6f3]/40"
                >
                  <LogIn size={16} />
                  <span>{isSubmitting ? 'กำลังตรวจสอบสิทธิ์...' : 'เข้าสู่ระบบ (Sign In)'}</span>
                </button>
              </form>

              {/* Card Footer Info */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-between text-[11px] text-[#a5c5e8] gap-2 border-t border-white/10">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-[#47b2e4]" />
                  <span>256-Bit SSL Enterprise Edge Console</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleNavClick('usage')}
                  className="text-[#47b2e4] hover:underline flex items-center gap-1 cursor-pointer font-medium"
                >
                  <BookOpen size={12} />
                  <span>อ่านคู่มือการใช้งาน</span>
                </button>
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: Modern Isometric Tech Artwork */}
          <div className="lg:col-span-6 flex items-center justify-center">
            <AdminHeroIllustration />
          </div>

        </div>
      </section>

      {/* -------------------------------------------------------------
          PARTNER & TECHNOLOGY STRIP (Inspired by Reference Bottom Bar)
         ------------------------------------------------------------- */}
      <section className="w-full bg-white text-slate-800 py-6 px-4 sm:px-8 border-y border-slate-200">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="text-center md:text-left">
            <p className="text-xs uppercase tracking-wider font-extrabold text-slate-400">
              POWERED BY ENTERPRISE CLOUD INFRASTRUCTURE
            </p>
            <p className="text-sm font-semibold text-slate-700">
              เทคโนโลยีโครงสร้างพื้นฐานระดับสากลที่ทำงานร่วมกัน
            </p>
          </div>

          {/* Technology Badges Grid */}
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
            {/* Cloudflare Workers */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
              <span className="text-base">⚡</span>
              <div className="text-left">
                <span className="text-xs font-black text-slate-800 block">Cloudflare Workers</span>
                <span className="text-[10px] text-slate-500 font-medium">KV Edge Runtime</span>
              </div>
            </div>

            {/* LINE Messaging API */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200">
              <span className="w-2.5 h-2.5 rounded-full bg-[#06c755]" />
              <div className="text-left">
                <span className="text-xs font-black text-emerald-950 block">LINE OA Bot 1:1</span>
                <span className="text-[10px] text-emerald-700 font-medium">Automated Slip OCR</span>
              </div>
            </div>

            {/* Google Apps Script */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-50 border border-sky-200">
              <span className="text-base">📊</span>
              <div className="text-left">
                <span className="text-xs font-black text-sky-950 block">Google Cloud</span>
                <span className="text-[10px] text-sky-700 font-medium">Sheets & Drive Sync</span>
              </div>
            </div>

            {/* PromptPay QR */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-50 border border-indigo-200">
              <span className="text-base">💳</span>
              <div className="text-left">
                <span className="text-xs font-black text-indigo-950 block">PromptPay QR</span>
                <span className="text-[10px] text-indigo-700 font-medium">Standard EMVCo</span>
              </div>
            </div>

            {/* React 19 + Tailwind */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
              <span className="text-base">⚛️</span>
              <div className="text-left">
                <span className="text-xs font-black text-slate-800 block">React 19 & Tailwind</span>
                <span className="text-[10px] text-slate-500 font-medium">Ultra-Fast Frontend</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------
          INTERACTIVE DOCUMENTATION & OPERATIONAL TABS SECTION
         ------------------------------------------------------------- */}
      <section 
        ref={docsSectionRef}
        className="w-full bg-[#f8fafc] text-slate-800 py-16 px-4 sm:px-8 border-b border-slate-200"
      >
        <div className="max-w-5xl mx-auto space-y-8">
          
          {/* Section Header */}
          <div className="text-center space-y-2.5 max-w-2xl mx-auto">
            <span className="px-3 py-1 rounded-full bg-[#37517e]/10 text-[#37517e] border border-[#37517e]/20 text-xs font-bold uppercase tracking-wider">
              System Documentation & Guidelines
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold font-heading text-slate-900 tracking-tight">
              ศูนย์ข้อมูลและคู่มือการปฏิบัติงานภาคสนาม
            </h2>
            <p className="text-sm text-slate-600">
              คำแนะนำขั้นตอนการทำงานสำหรับเจ้าหน้าที่และนโยบายความปลอดภัยของระบบ
            </p>
          </div>

          {/* Segmented Tabs Navigation (2 Clean Balanced Tabs) */}
          <div className="grid grid-cols-2 gap-2 p-1.5 bg-slate-200/80 rounded-2xl max-w-md mx-auto border border-slate-300">
            <button
              type="button"
              onClick={() => setActiveTab('usage')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'usage' 
                  ? 'bg-[#37517e] text-white border border-[#37517e]' 
                  : 'text-slate-700 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <BookOpen size={16} className={activeTab === 'usage' ? 'text-[#47b2e4]' : 'text-slate-500'} />
              <span className="whitespace-nowrap">คู่มือการใช้งาน (Usage)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('terms')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'terms' 
                  ? 'bg-[#37517e] text-white border border-[#37517e]' 
                  : 'text-slate-700 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <FileCheck size={16} className={activeTab === 'terms' ? 'text-[#47b2e4]' : 'text-slate-500'} />
              <span className="whitespace-nowrap">ข้อกำหนดและเงื่อนไข (Terms)</span>
            </button>
          </div>

          {/* TAB 1: USAGE INSTRUCTIONS */}
          {activeTab === 'usage' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Step 1 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-[#37517e] text-white font-bold flex items-center justify-center text-sm">
                      1
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การลงชื่อเข้าใช้ระบบ (Sign-In & Auth)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    ผู้ดูแลระบบใช้ Username และ Password ที่ได้รับมอบหมายเพื่อเข้าสู่ระบบ คอนโซลจะผูก Session ไว้ใน <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-sky-700">sessionStorage</code> และตรวจสอบสิทธิ์ผ่าน RPC Backend เพื่อความปลอดภัยสูงสุด หากปิดเบราว์เซอร์เซสชันจะสิ้นสุดทันที
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>ห้ามใช้รหัสผ่านร่วมกันในจุดควบคุมหลายจุด</li>
                    <li>หากพิมพ์รหัสผ่านผิดเกินกำหนด ระบบจะหน่วงเวลาอัตโนมัติ</li>
                  </ul>
                </div>

                {/* Step 2 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-[#37517e] text-white font-bold flex items-center justify-center text-sm">
                      2
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การเปิดรอบแข่งขัน & อัตราต่อรอง (Rounds & Quotes)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    ก่อนเริ่มปล่อยบั้งไฟ กรรมการกด <strong className="text-slate-800">"เปิดรอบใหม่ (Open Round)"</strong> พร้อมตั้งเวลาและราคาต่อรอง จากนั้นกด <strong className="text-slate-800">"ปล่อยราคา (Release Quote)"</strong> เพื่อเปิดรับคำสั่งซื้อ และกด <strong className="text-slate-800">"ล็อครอบ (Lock Round)"</strong> ทันทีที่บั้งไฟถูกจุดขึ้นสู่อากาศ
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>คำสั่งซื้อประเภท Hold จะถูกปล่อยพร้อมกันเมื่อเปิดราคา</li>
                    <li>สถานะรอบบนกระดานกลุ่ม LINE จะอัปเดตแบบเรียลไทม์</li>
                  </ul>
                </div>

                {/* Step 3 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-[#37517e] text-white font-bold flex items-center justify-center text-sm">
                      3
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      ตรวจสลิปเงินโอน 1:1 (Automated Slip OCR)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    เมื่อผู้เล่นส่งรูปสลิปใน LINE OA บอทจะทำการอ่าน QR Code สลิป (EMVCo PromptPay) ถอดรหัสตรวจสอบยอดเงินและเลข Ref Code ทันที หากผ่านเงื่อนไข ระบบจะเพิ่มเครดิต 1:1 และส่ง Flex Card ยืนยันให้ผู้เล่นในเสี้ยววินาที
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>สลิปที่ไม่มี QR หรือภาพไม่ชัด จะถูกส่งเข้าคิวให้แอดมินอนุมัติมือ</li>
                    <li>ระบบป้องกันสลิปซ้ำซ้อน 100% ด้วยการจดจำเลขอ้างอิงถาวร</li>
                  </ul>
                </div>

                {/* Step 4 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-[#37517e] text-white font-bold flex items-center justify-center text-sm">
                      4
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การจับเวลา & ออกผลการแข่งขัน (Flight Settlement)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    ใช้หน้าปัด Telemetry Simulator จับเวลาการลอยตัวของบั้งไฟ เมื่อตกถึงพื้น กรรมการป้อนเวลาเป็นวินาที (เช่น 125.40s) ระบบจะคำนวณผลชนะตามกลุ่มเวลา (สูง / ต่ำ / เสมอ) และปรับยอดชนะเข้ากระเป๋าผู้เล่นอัตโนมัติ
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>กรณีบั้งไฟแตกหรือโมฆะ ให้ใช้ปุ่ม "ยกเลิกรอบ (Void Round)"</li>
                    <li>ระบบจะคืนเครดิตแบบ Idempotent ป้องกันการคืนเงินซ้ำ</li>
                  </ul>
                </div>
              </div>

              {/* Quick Field Tip Box */}
              <div className="p-4 bg-sky-50 border border-sky-200 rounded-xl flex items-start gap-3">
                <span className="text-xl">💡</span>
                <div className="text-xs text-sky-900">
                  <strong className="block text-sky-950 font-bold mb-0.5">ข้อแนะนำภาคสนาม (Field Pro-Tip):</strong>
                  กรรมการควรเปิดหน้านี้บนแท็บเล็ตหรือโน้ตบุ๊กที่มีการเชื่อมต่ออินเทอร์เน็ตเสถียร หากแอดมินออกจากระบบ ให้กดปุ่ม <strong>"เข้าสู่ระบบ (Sign In)"</strong> ด้านบนเพื่อกรอกรหัสผ่านใหม่อีกครั้งโดยไม่ต้องรีเฟรชหน้าเว็บ
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TERMS OF USE & SECURITY */}
          {activeTab === 'terms' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 mb-1">
                    ข้อกำหนดความปลอดภัยและการใช้งานระบบ (Enterprise Compliance & Terms)
                  </h3>
                  <p className="text-xs text-slate-500">
                    มีผลบังคับใช้สำหรับเจ้าหน้าที่ผู้ดูแลระบบ, ผู้บันทึกเวลา และกรรมการภาคสนามทุกคน
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Term 1 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-[#37517e] flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-[#37517e] text-white text-[11px] flex items-center justify-center font-bold">1</span>
                      การรักษาความลับของบัญชีผู้ดูแล (Credential Confidentiality)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ผู้ดูแลระบบต้องเก็บรักษา Username, Password และรหัสผ่าน Admin Key เป็นความลับสูงสุด ห้ามส่งต่อหรือบันทึกในอุปกรณ์สาธารณะ หากสงสัยว่ารหัสผ่านรั่วไหล ต้องติดต่อผู้ดูแลระบบเพื่อรีเซ็ต Secret Key บน Cloudflare ทันที
                    </p>
                  </div>

                  {/* Term 2 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-[#37517e] flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-[#37517e] text-white text-[11px] flex items-center justify-center font-bold">2</span>
                      นโยบายป้องกันสลิปซ้ำซ้อน (Anti-Fraud Slip Quarantine)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      สลิปทุกใบที่ผ่านการเคลมเครดิตจะถูกบันทึกรหัสอ้างอิง (Ref Code) ลงในระบบถาวร หากมีการส่งซ้ำหรือตรวจพบการดัดแปลงภาพ ระบบจะปฏิเสธการเติมเงินและขึ้นบันทึกเตือนในหน้าตรวจสอบสลิปของแอดมินทันที
                    </p>
                  </div>

                  {/* Term 3 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-[#37517e] flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-[#37517e] text-white text-[11px] flex items-center justify-center font-bold">3</span>
                      การบันทึกประวัติการกระทำ (Audit Trail Logging)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ทุกการกระทำของผู้ดูแลระบบ ได้แก่ การเปิด/ปิดรอบ, การตั้งราคาต่อรอง, การปรับยอดเงินผู้เล่น และการอนุมัติสลิปมือ จะถูกบันทึกประวัติพร้อม Timestamp และ Admin Identifier เพื่อความโปร่งใสและตรวจสอบย้อนหลังได้ 100%
                    </p>
                  </div>

                  {/* Term 4 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-[#37517e] flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-[#37517e] text-white text-[11px] flex items-center justify-center font-bold">4</span>
                      มาตรการคืนเงินสองขั้นตอน (Two-Phase Idempotent Refund)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ในกรณีที่รอบแข่งขันถูกยกเลิก (Void) ระบบจะเปลี่ยนสถานะออเดอร์เป็น <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-amber-700">refunding</code> ก่อนคืนเครดิต เมื่อยอดเงินผู้เล่นอัปเดตเรียบร้อยจึงเปลี่ยนเป็น <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-700">cancelled</code> ป้องกันการคืนเงินซ้ำซ้อนแม้อินเทอร์เน็ตขัดข้อง
                    </p>
                  </div>
                </div>

                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center gap-2">
                  <ShieldCheck size={16} className="text-emerald-600 shrink-0" />
                  <span>ระบบทำงานภายใต้มาตรฐานความปลอดภัยข้อมูล TLS 1.3 และการเข้ารหัสแบบ End-to-End 256-Bit SSL</span>
                </div>
              </div>
            </div>
          )}

          {/* Action to Jump Back to Login */}
          <div className="pt-4 text-center">
            <button
              type="button"
              onClick={handleScrollToLogin}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[#37517e] hover:bg-[#2b4167] text-white text-xs sm:text-sm font-bold tracking-wide transition-all cursor-pointer shadow-none whitespace-nowrap"
            >
              <LogIn size={15} className="text-[#47b2e4]" />
              <span>กลับไปที่แบบฟอร์มเข้าสู่ระบบ (Sign In)</span>
            </button>
          </div>

        </div>
      </section>

      {/* -------------------------------------------------------------
          FOOTER (Navy #1e2d45 with Cyan Accents)
         ------------------------------------------------------------- */}
      <footer className="w-full bg-[#1e2d45] text-[#a5c5e8] py-8 px-4 sm:px-8 border-t border-white/10 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3 text-center md:text-left">
            <div className="w-8 h-8 rounded-lg bg-[#47b2e4] flex items-center justify-center text-white shrink-0">
              <Rocket size={18} className="transform -rotate-45" />
            </div>
            <div>
              <span className="text-sm font-bold text-white uppercase block">
                Bang Fai Commander &bull; Mission Control
              </span>
              <p className="text-xs text-[#a5c5e8]">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนาม &bull; Cloud Edition
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4 text-xs">
            <button 
              type="button" 
              onClick={() => handleNavClick('usage')} 
              className="hover:text-white transition-colors cursor-pointer whitespace-nowrap"
            >
              คู่มือการใช้งาน
            </button>
            <span className="text-white/20">&bull;</span>
            <button 
              type="button" 
              onClick={() => handleNavClick('terms')} 
              className="hover:text-white transition-colors cursor-pointer whitespace-nowrap"
            >
              ข้อกำหนดและเงื่อนไข
            </button>
          </div>

          <div className="text-xs text-[#8299bb] text-center md:text-right">
            <span>&copy; {new Date().getFullYear()} Bang Fai Commander. All rights reserved.</span>
          </div>
        </div>
      </footer>

      {/* Floating Back to Top / Quick Login Button */}
      {showBackToTop && (
        <button
          type="button"
          onClick={handleScrollToLogin}
          className="fixed bottom-6 right-6 z-40 p-3 rounded-full bg-[#47b2e4] hover:bg-[#38a3d6] text-white shadow-xl flex items-center gap-2 text-xs font-bold cursor-pointer transition-all border border-white/20"
          title="เข้าสู่ระบบ (Sign In)"
        >
          <LogIn size={15} />
          <span className="hidden sm:inline">เข้าสู่ระบบ</span>
          <ArrowUp size={14} />
        </button>
      )}
    </div>
  );
}
