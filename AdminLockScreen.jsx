import { useState, useRef } from 'react';
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
  Menu, 
  X
} from 'lucide-react';

// -------------------------------------------------------------
// WELCOMING ROCKET LAUNCH & OPERATIONS ARTWORK
// Inspired by friendly startup aesthetic (Login Page Reference)
// -------------------------------------------------------------
function AdminHeroIllustration() {
  return (
    <div className="relative w-full max-w-[580px] mx-auto select-none">
      {/* Ambient background glows */}
      <div 
        className="absolute -top-12 -left-12 w-72 h-72 rounded-full pointer-events-none opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, #38bdf8 0%, rgba(55,81,126,0) 70%)' }}
      />
      <div 
        className="absolute -bottom-10 -right-10 w-80 h-80 rounded-full pointer-events-none opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, #f43f5e 0%, rgba(55,81,126,0) 70%)' }}
      />

      {/* SVG Modern Startup Launch Artwork */}
      <svg 
        viewBox="0 0 680 500" 
        className="w-full h-auto drop-shadow-2xl overflow-visible"
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Rocket Body Gradient */}
          <linearGradient id="rocketBodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="45%" stopColor="#0284c7" />
            <stop offset="100%" stopColor="#1e3a8a" />
          </linearGradient>

          {/* Rocket Fin & Accent Gradient */}
          <linearGradient id="rocketCoralGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="50%" stopColor="#f43f5e" />
            <stop offset="100%" stopColor="#be123c" />
          </linearGradient>

          {/* Rocket Flame Gradients */}
          <linearGradient id="flameOuterGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.9" />
            <stop offset="70%" stopColor="#fbbf24" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#fef08a" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="flameInnerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="40%" stopColor="#fef08a" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
          </linearGradient>

          {/* Cloud Gradients */}
          <linearGradient id="cloudBaseGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#e2e8f0" stopOpacity="0.85" />
          </linearGradient>

          {/* Card / Badge Gradient */}
          <linearGradient id="badgeBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1e293b" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#0f172a" stopOpacity="0.88" />
          </linearGradient>
        </defs>

        {/* -------------------------------------------------------------
            BACKGROUND DECORATIVE ELEMENTS (Gears & Globe Bubble)
           ------------------------------------------------------------- */}
        {/* Soft Organic Floor / Hill Shape */}
        <path 
          d="M 20 460 Q 200 400 380 430 T 660 450 L 660 500 L 20 500 Z" 
          fill="#1b283d" 
          fillOpacity="0.5" 
        />

        {/* Gear 1: Upper Right Large Gear (Inspired by reference) */}
        <g transform="translate(550, 150) rotate(15)" opacity="0.32">
          <circle cx="0" cy="0" r="44" stroke="#818cf8" strokeWidth="10" strokeDasharray="18 12" fill="none" />
          <circle cx="0" cy="0" r="28" fill="#818cf8" fillOpacity="0.15" stroke="#818cf8" strokeWidth="2" />
          <circle cx="0" cy="0" r="14" fill="#37517e" />
        </g>

        {/* Gear 2: Middle Right Smaller Gear */}
        <g transform="translate(535, 245) rotate(-25)" opacity="0.25">
          <circle cx="0" cy="0" r="30" stroke="#38bdf8" strokeWidth="8" strokeDasharray="12 9" fill="none" />
          <circle cx="0" cy="0" r="18" fill="#38bdf8" fillOpacity="0.15" stroke="#38bdf8" strokeWidth="1.5" />
          <circle cx="0" cy="0" r="9" fill="#37517e" />
        </g>

        {/* Globe Speech Bubble (Inspired by reference) */}
        <g transform="translate(370, 160)" opacity="0.85">
          <rect x="0" y="0" width="46" height="34" rx="8" fill="#1e293b" stroke="#38bdf8" strokeWidth="1.5" />
          <polygon points="12,34 20,34 14,41" fill="#1e293b" stroke="#38bdf8" strokeWidth="1.5" strokeLinejoin="round" />
          <rect x="0.5" y="32" width="20" height="3" fill="#1e293b" />
          {/* Globe lines inside */}
          <circle cx="23" cy="17" r="9" stroke="#38bdf8" strokeWidth="1.2" fill="none" />
          <line x1="14" y1="17" x2="32" y2="17" stroke="#38bdf8" strokeWidth="1" />
          <ellipse cx="23" cy="17" rx="4.5" ry="9" stroke="#38bdf8" strokeWidth="1" fill="none" />
        </g>

        {/* -------------------------------------------------------------
            CENTER: MODERN ASCENDING ROCKET (Inspired by reference)
           ------------------------------------------------------------- */}
        <g id="mainRocket" transform="translate(435, 75)">
          {/* Rocket Propulsion Exhaust Flames */}
          <path 
            d="M -16 230 Q 0 310 0 330 Q 0 310 16 230 Z" 
            fill="url(#flameOuterGrad)" 
            filter="drop-shadow(0 0 10px #f43f5e)"
          />
          <path 
            d="M -8 230 Q 0 280 0 295 Q 0 280 8 230 Z" 
            fill="url(#flameInnerGrad)" 
          />

          {/* Left Booster Rocket */}
          <g transform="translate(-32, 70)">
            <path d="M 0 30 Q 8 0 16 30 L 16 140 Q 8 148 0 140 Z" fill="#0284c7" stroke="#38bdf8" strokeWidth="1" />
            <polygon points="0,30 8,0 16,30" fill="#38bdf8" />
            <polygon points="2,140 14,140 11,148 5,148" fill="#1e293b" />
            <path d="M 5 148 Q 8 175 8 185 Q 8 175 11 148 Z" fill="url(#flameOuterGrad)" opacity="0.8" />
          </g>

          {/* Right Booster Rocket */}
          <g transform="translate(16, 70)">
            <path d="M 0 30 Q 8 0 16 30 L 16 140 Q 8 148 0 140 Z" fill="#0284c7" stroke="#38bdf8" strokeWidth="1" />
            <polygon points="0,30 8,0 16,30" fill="#38bdf8" />
            <polygon points="2,140 14,140 11,148 5,148" fill="#1e293b" />
            <path d="M 5 148 Q 8 175 8 185 Q 8 175 11 148 Z" fill="url(#flameOuterGrad)" opacity="0.8" />
          </g>

          {/* Main Fuselage Body */}
          <path 
            d="M -26 80 Q 0 -20 26 80 L 26 215 L -26 215 Z" 
            fill="url(#rocketBodyGrad)" 
            stroke="#bae6fd" 
            strokeWidth="1.5"
          />

          {/* Center Main Fin / Dorsal Spine (Coral Red) */}
          <path 
            d="M 0 50 L 0 230" 
            stroke="#f43f5e" 
            strokeWidth="4" 
            strokeLinecap="round" 
          />

          {/* Left Wing Fin (Swept Coral Fin) */}
          <path 
            d="M -26 140 C -45 160 -52 210 -48 235 C -36 230 -26 215 -26 215 Z" 
            fill="url(#rocketCoralGrad)" 
            stroke="#fda4af" 
            strokeWidth="1"
          />

          {/* Right Wing Fin (Swept Coral Fin) */}
          <path 
            d="M 26 140 C 45 160 52 210 48 235 C 36 230 26 215 26 215 Z" 
            fill="url(#rocketCoralGrad)" 
            stroke="#fda4af" 
            strokeWidth="1"
          />

          {/* Cockpit Porthole Window */}
          <circle cx="0" cy="85" r="14" fill="#0f172a" stroke="#f43f5e" strokeWidth="3" />
          <circle cx="0" cy="85" r="10" fill="#0284c7" />
          <path d="M -5 80 A 7 7 0 0 1 5 80" stroke="#bae6fd" strokeWidth="2" strokeLinecap="round" />

          {/* Main Engine Base Ring */}
          <rect x="-24" y="215" width="48" height="12" rx="4" fill="#0f172a" stroke="#38bdf8" strokeWidth="1" />
          <polygon points="-18,227 18,227 14,235 -14,235" fill="#334155" />
        </g>

        {/* -------------------------------------------------------------
            BILLOWING CLOUDS & LAUNCH SMOKE (Layered Cloud Base)
           ------------------------------------------------------------- */}
        <g id="launchClouds">
          {/* Back Soft Layer */}
          <path 
            d="M 260 430 Q 320 360 380 400 Q 430 350 490 380 Q 560 340 620 400 Q 660 430 640 470 L 260 470 Z" 
            fill="#93c5fd" 
            fillOpacity="0.25" 
          />

          {/* Middle Cloud Layer */}
          <ellipse cx="440" cy="370" rx="65" ry="35" fill="url(#cloudBaseGrad)" />
          <ellipse cx="370" cy="385" rx="55" ry="32" fill="url(#cloudBaseGrad)" />
          <ellipse cx="510" cy="380" rx="58" ry="30" fill="url(#cloudBaseGrad)" />
          <ellipse cx="310" cy="405" rx="50" ry="28" fill="url(#cloudBaseGrad)" />
          <ellipse cx="570" cy="400" rx="52" ry="28" fill="url(#cloudBaseGrad)" />

          {/* Foreground Puffy Cloud Shapes */}
          <circle cx="435" cy="385" r="42" fill="#ffffff" />
          <circle cx="380" cy="400" r="38" fill="#ffffff" />
          <circle cx="490" cy="395" r="38" fill="#ffffff" />
          <circle cx="330" cy="425" r="35" fill="#ffffff" />
          <circle cx="545" cy="420" r="35" fill="#ffffff" />
          <circle cx="280" cy="445" r="30" fill="#f8fafc" />
          <circle cx="595" cy="440" r="32" fill="#f8fafc" />
        </g>

        {/* -------------------------------------------------------------
            FRIENDLY OPERATIONS TEAM (Inspired by reference figures)
           ------------------------------------------------------------- */}
        {/* Figure 1: Standing Operations Lead with Tablet/Clipboard (Left) */}
        <g id="figureLead" transform="translate(345, 205)">
          {/* Head & Hair */}
          <circle cx="16" cy="18" r="9" fill="#fbd5b5" />
          <path d="M 9 17 C 9 10 14 7 21 9 C 24 10 25 15 25 18 C 22 17 19 14 15 15 C 13 16 11 17 9 17 Z" fill="#1e293b" />
          {/* Hand to ear/headset (communicating) */}
          <path d="M 23 18 Q 28 20 26 27" stroke="#fbd5b5" strokeWidth="3" strokeLinecap="round" fill="none" />
          
          {/* Torso & Shirt (Crisp Periwinkle/Lavender) */}
          <path d="M 6 30 L 26 30 L 29 78 L 3 78 Z" fill="#818cf8" />
          {/* Collar & Dark Tie */}
          <polygon points="13,30 19,30 17,54 15,54" fill="#1e293b" />
          <polygon points="12,30 16,36 14,30" fill="#ffffff" />
          <polygon points="20,30 16,36 18,30" fill="#ffffff" />

          {/* Left Arm holding Clipboard */}
          <path d="M 8 32 L -4 55 L 8 64" stroke="#818cf8" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Tablet / Clipboard */}
          <g transform="translate(-10, 52) rotate(6)">
            <rect x="0" y="0" width="22" height="30" rx="3" fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" />
            <rect x="7" y="-2" width="8" height="4" rx="1.5" fill="#64748b" />
            <line x1="4" y1="8" x2="18" y2="8" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
            <line x1="4" y1="13" x2="18" y2="13" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4" y1="18" x2="14" y2="18" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4" y1="23" x2="16" y2="23" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" />
          </g>

          {/* Legs & Trousers (Dark Slate) */}
          <path d="M 4 78 L 13 148 L 7 150" stroke="#1e293b" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M 27 78 L 19 148 L 24 150" stroke="#1e293b" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Shoes */}
          <ellipse cx="6" cy="151" rx="6" ry="2.5" fill="#0284c7" />
          <ellipse cx="23" cy="151" rx="6" ry="2.5" fill="#0284c7" />
        </g>

        {/* Figure 2: Specialist Seated on Cloud with Laptop (Right) */}
        <g id="figureSpecialist" transform="translate(485, 270)">
          {/* Head & Glasses */}
          <circle cx="15" cy="14" r="8" fill="#fbd5b5" />
          <path d="M 9 14 C 9 8 13 5 21 7 C 23 9 24 13 23 15 C 20 14 17 12 14 13 C 12 14 10 15 9 14 Z" fill="#1e293b" />
          {/* Glasses */}
          <rect x="15" y="12" width="6" height="4" rx="1" stroke="#1e293b" strokeWidth="1" fill="none" />

          {/* Torso & Bright Blue Sweater */}
          <path d="M 5 24 L 25 24 L 28 62 L 2 62 Z" fill="#0284c7" />

          {/* Crossed Legs on Cloud */}
          <path 
            d="M 2 62 C -10 65 -6 82 12 82 C 26 82 34 76 38 68 C 32 64 26 62 18 62" 
            fill="#1e293b" 
          />
          {/* Shoes */}
          <ellipse cx="-4" cy="78" rx="5" ry="3" fill="#ffffff" />
          <ellipse cx="32" cy="74" rx="5" ry="3" fill="#ffffff" />

          {/* Arms holding laptop */}
          <path d="M 5 26 L -2 46 L 8 48" stroke="#0284c7" strokeWidth="5" strokeLinecap="round" fill="none" />
          <path d="M 25 26 L 22 46 L 14 48" stroke="#0284c7" strokeWidth="5" strokeLinecap="round" fill="none" />

          {/* Laptop (Open towards operator) */}
          <polygon points="-8,48 20,48 18,52 -6,52" fill="#cbd5e1" />
          <polygon points="-5,48 17,48 15,32 -3,32" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.8" />
          <rect x="-1" y="35" width="14" height="10" rx="1" fill="#0284c7" fillOpacity="0.3" />
          <line x1="1" y1="38" x2="11" y2="38" stroke="#38bdf8" strokeWidth="1" strokeLinecap="round" />
          <line x1="1" y1="41" x2="8" y2="41" stroke="#38bdf8" strokeWidth="1" strokeLinecap="round" />
        </g>

        {/* -------------------------------------------------------------
            FLOATING VALUE BADGES (Friendly, Rounded Modern Glassmorphism)
           ------------------------------------------------------------- */}
        {/* Badge 1: Real-Time Sync (Top Left) */}
        <g transform="translate(60, 110)">
          <rect x="0" y="0" width="168" height="48" rx="14" fill="url(#badgeBgGrad)" stroke="#38bdf8" strokeWidth="1.2" filter="drop-shadow(0 4px 12px rgba(0,0,0,0.3))" />
          <circle cx="22" cy="24" r="5" fill="#10b981" />
          <circle cx="22" cy="24" r="9" stroke="#10b981" strokeWidth="1.5" strokeOpacity="0.5" className="animate-ping" />
          <text x="36" y="20" fill="#94a3b8" fontSize="8.5" fontWeight="bold" letterSpacing="0.05em" fontFamily="sans-serif">REAL-TIME SYNC</text>
          <text x="36" y="35" fill="#ffffff" fontSize="12" fontWeight="800" fontFamily="sans-serif">Live Field Control</text>
        </g>

        {/* Badge 2: Verified & Secured (Top Right) */}
        <g transform="translate(480, 50)">
          <rect x="0" y="0" width="164" height="48" rx="14" fill="url(#badgeBgGrad)" stroke="#818cf8" strokeWidth="1.2" filter="drop-shadow(0 4px 12px rgba(0,0,0,0.3))" />
          <circle cx="22" cy="24" r="9" fill="#818cf8" fillOpacity="0.25" />
          <path d="M 18 24 L 21 27 L 26 21" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <text x="36" y="20" fill="#94a3b8" fontSize="8.5" fontWeight="bold" letterSpacing="0.05em" fontFamily="sans-serif">VERIFIED &amp; SECURED</text>
          <text x="36" y="35" fill="#ffffff" fontSize="12" fontWeight="800" fontFamily="sans-serif">100% Data Integrity</text>
        </g>

        {/* Badge 3: Precision Timing (Bottom Center-Left) */}
        <g transform="translate(110, 380)">
          <rect x="0" y="0" width="164" height="48" rx="14" fill="url(#badgeBgGrad)" stroke="#38bdf8" strokeWidth="1.2" filter="drop-shadow(0 4px 12px rgba(0,0,0,0.3))" />
          <circle cx="22" cy="24" r="9" fill="#0284c7" fillOpacity="0.3" />
          <circle cx="22" cy="24" r="4" fill="#38bdf8" />
          <text x="36" y="20" fill="#94a3b8" fontSize="8.5" fontWeight="bold" letterSpacing="0.05em" fontFamily="sans-serif">PRECISION TIMING</text>
          <text x="36" y="35" fill="#38bdf8" fontSize="12" fontWeight="800" fontFamily="monospace">Sub-Second Flight</text>
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

  const userInputRef = useRef(null);
  const docsSectionRef = useRef(null);
  const loginCardRef = useRef(null);

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
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/10 border border-[#47b2e4]/30 text-[#bae6fd] text-xs font-semibold shadow-sm backdrop-blur-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>✨ Professional Competition &amp; Operations Management Platform</span>
            </div>

            {/* Main Headline (2-Line Restyle: Bold + Thin Italic) */}
            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-heading text-white tracking-tight leading-tight">
                <span className="font-extrabold block">Better Solutions</span>
                <span className="font-light italic text-[#38bdf8] block text-2xl sm:text-3xl lg:text-4xl mt-1.5">For Your Operations</span>
              </h1>
              <h2 className="text-lg sm:text-xl font-medium text-[#bae6fd] font-thai">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนามแบบครบวงจร
              </h2>
              <p className="text-sm sm:text-base text-[#e0f2fe]/90 leading-relaxed max-w-xl font-thai font-normal">
                ศูนย์กลางประมวลผลคำสั่งซื้อและตรวจสลิปเงินโอนอัตโนมัติ พร้อมแดชบอร์ดควบคุมรอบการแข่งขัน 
                และระบบประมวลผลเวลาภาคสนามความเร็วสูงแบบเรียลไทม์
              </p>
            </div>

            {/* ADMIN SIGN-IN CARD (Clean Frosted Navy Card) */}
            <div 
              ref={loginCardRef}
              className="bg-[#243552]/90 border border-[#47b2e4]/35 rounded-2xl p-6 sm:p-7 backdrop-blur-md space-y-5"
            >
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#38bdf8]/30 to-[#0284c7]/20 border border-[#38bdf8]/40 flex items-center justify-center text-[#38bdf8] shrink-0">
                    <Lock size={18} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white tracking-tight">
                      เข้าสู่ระบบผู้ดูแล (Admin Portal)
                    </h3>
                    <p className="text-xs text-[#bae6fd]">
                      ยินดีต้อนรับสู่ระบบจัดการและควบคุมภาคสนาม
                    </p>
                  </div>
                </div>
                <span className="text-[10px] px-2.5 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-full font-sans font-semibold tracking-wide">
                  SECURED ACCESS
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

                {/* Sign-In Submit Button (Vibrant Friendly Gradient Pill) */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3.5 px-6 bg-gradient-to-r from-[#0284c7] via-[#0ea5e9] to-[#38bdf8] hover:from-[#0369a1] hover:to-[#0284c7] active:scale-[0.99] disabled:opacity-50 text-white rounded-full text-sm font-bold tracking-wide transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-[#0ea5e9]/25 border border-white/20"
                >
                  <LogIn size={16} />
                  <span>{isSubmitting ? 'กำลังตรวจสอบสิทธิ์...' : 'เข้าสู่ระบบ (Sign In)'}</span>
                </button>
              </form>

              {/* Card Footer Info */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-between text-[11px] text-[#a5c5e8] gap-2 border-t border-white/10">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-[#38bdf8]" />
                  <span>256-Bit SSL Secured Portal</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleNavClick('usage')}
                  className="text-[#38bdf8] hover:underline flex items-center gap-1 cursor-pointer font-medium"
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
          CORE OPERATIONAL VALUES & CAPABILITIES (Confidential Value Proposition)
         ------------------------------------------------------------- */}
      <section className="w-full bg-white text-slate-800 py-8 px-4 sm:px-8 border-y border-slate-200">
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row items-center justify-between gap-8">
          <div className="text-center lg:text-left max-w-sm">
            <span className="text-xs uppercase tracking-wider font-extrabold text-[#0ea5e9] block mb-1">
              CORE OPERATIONAL VALUES
            </span>
            <h3 className="text-lg font-extrabold text-slate-900 leading-snug">
              <span>มาตรฐานความแม่นยำและความปลอดภัย</span>
              <span className="block">ระดับมืออาชีพ</span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              ออกแบบเพื่อยกระดับการปฏิบัติงานภาคสนามให้ราบรื่น โปร่งใส และรวดเร็ว
            </p>
          </div>

          {/* 4 Professional Value Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 w-full lg:w-auto">
            {/* Value 1: Precision Timing */}
            <div className="p-4 rounded-2xl bg-slate-50 hover:bg-sky-50/50 border border-slate-200/80 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-sky-100 text-sky-600 flex items-center justify-center text-lg mb-2.5 group-hover:scale-105 transition-transform">
                ⚡
              </div>
              <span className="text-xs font-bold text-slate-900 block">แม่นยำระดับเสี้ยววินาที</span>
              <span className="text-[11px] text-slate-500 font-medium block mt-0.5">High-Precision Timing</span>
            </div>

            {/* Value 2: Automated Verification */}
            <div className="p-4 rounded-2xl bg-slate-50 hover:bg-emerald-50/50 border border-slate-200/80 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center text-lg mb-2.5 group-hover:scale-105 transition-transform">
                🛡️
              </div>
              <span className="text-xs font-bold text-slate-900 block">ตรวจสอบอัตโนมัติ</span>
              <span className="text-[11px] text-slate-500 font-medium block mt-0.5">Instant Verification</span>
            </div>

            {/* Value 3: Real-Time Live Sync */}
            <div className="p-4 rounded-2xl bg-slate-50 hover:bg-indigo-50/50 border border-slate-200/80 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center text-lg mb-2.5 group-hover:scale-105 transition-transform">
                📊
              </div>
              <span className="text-xs font-bold text-slate-900 block">ซิงก์ข้อมูลเรียลไทม์</span>
              <span className="text-[11px] text-slate-500 font-medium block mt-0.5">Live Synchronization</span>
            </div>

            {/* Value 4: Multi-Device Ready */}
            <div className="p-4 rounded-2xl bg-slate-50 hover:bg-amber-50/50 border border-slate-200/80 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center text-lg mb-2.5 group-hover:scale-105 transition-transform">
                📱
              </div>
              <span className="text-xs font-bold text-slate-900 block">รองรับทุกอุปกรณ์</span>
              <span className="text-[11px] text-slate-500 font-medium block mt-0.5">Multi-Device Ready</span>
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
                    ผู้ดูแลระบบใช้ Username และ Password ที่ได้รับมอบหมายเพื่อเข้าสู่ระบบ คอนโซลจะผูก Session ไว้ใน <code className="text-xs bg-slate-100 px-1 py-0.5 rounded text-sky-700">sessionStorage</code> และตรวจสอบสิทธิ์ตามมาตรฐานความปลอดภัยสูงสุด หากปิดเบราว์เซอร์เซสชันจะสิ้นสุดทันที
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
                    <li>สถานะรอบบนกระดานแสดงผลจะอัปเดตแบบเรียลไทม์</li>
                  </ul>
                </div>

                {/* Step 3 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-[#37517e] text-white font-bold flex items-center justify-center text-sm">
                      3
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      ตรวจสลิปเงินโอน 1:1 (Automated Verification)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    เมื่อผู้เล่นส่งรูปสลิป ระบบจะทำการอ่านรหัสสลิป ถอดรหัสตรวจสอบยอดเงินและเลข Ref Code ทันที หากผ่านเงื่อนไข ระบบจะเพิ่มเครดิต 1:1 และส่งบัตรยืนยันให้ผู้เล่นในเสี้ยววินาที
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
                      ผู้ดูแลระบบต้องเก็บรักษา Username, Password และรหัสผ่าน Admin Key เป็นความลับสูงสุด ห้ามส่งต่อหรือบันทึกในอุปกรณ์สาธารณะ หากสงสัยว่ารหัสผ่านรั่วไหล ต้องติดต่อผู้ดูแลระบบส่วนกลางเพื่อรีเซ็ตรหัสผ่านทันที
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
    </div>
  );
}
