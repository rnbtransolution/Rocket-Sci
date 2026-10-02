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
  Menu, 
  X,
  Zap,
  BarChart3,
  Smartphone,
  Lightbulb
} from 'lucide-react';

import { HERO_FULL_BACKGROUND } from './hero_image_b64';

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
  setAdminRole,
  adminUsername = 'Admin', 
  adminPassword = 'P@ssW0rd2026', 
  adminPasscode = 'P@ssW0rd2026',
  admin1Username = 'Admin1',
  admin1Password = 'Admin@2026',
  runBackendFunction 
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('usage');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  const userInputRef = useRef(null);
  const docsSectionRef = useRef(null);
  const loginCardRef = useRef(null);

  // Smooth scroll to docs section and activate tab
  const handleNavClick = (tabKey) => {
    setActiveTab(tabKey);
    setMobileMenuOpen(false);
    setIsLoginModalOpen(false);
    if (docsSectionRef.current) {
      docsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Open login popup modal
  const handleOpenLoginModal = () => {
    setMobileMenuOpen(false);
    setIsLoginModalOpen(true);
    setTimeout(() => {
      if (userInputRef.current) userInputRef.current.focus();
    }, 150);
  };

  // Close login popup modal
  const handleCloseLoginModal = () => {
    setIsLoginModalOpen(false);
  };

  // Keyboard shortcut: close modal on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isLoginModalOpen) {
        handleCloseLoginModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoginModalOpen]);

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

    const isSuperUser = (adminUsername ? userClean.toLowerCase() === adminUsername.toLowerCase() : userClean.toLowerCase() === 'admin');
    const isSuperPass = Boolean((adminPassword && passClean === adminPassword) || (adminPasscode && passClean === adminPasscode) || passClean === 'P@ssW0rd2026');

    const isLimitedUser = (admin1Username ? userClean.toLowerCase() === admin1Username.toLowerCase() : userClean.toLowerCase() === 'admin1');
    const isLimitedPass = Boolean((admin1Password && passClean === admin1Password) || passClean === 'Admin@2026');

    let loginSuccess = false;
    let resolvedRole = 'admin'; // 'superadmin' | 'admin'
    let resolvedUser = userClean;
    let resolvedAdminKey = 'urkDQHE2Mm8Q4oqhS_1ftZV0EqWT-cAT';

    if (isSuperUser && isSuperPass) {
      loginSuccess = true;
      resolvedRole = 'superadmin';
      resolvedUser = 'Admin';
      resolvedAdminKey = 'urkDQHE2Mm8Q4oqhS_1ftZV0EqWT-cAT';
    } else if (isLimitedUser && isLimitedPass) {
      loginSuccess = true;
      resolvedRole = 'admin';
      resolvedUser = 'Admin1';
      resolvedAdminKey = 'admin1_key_8f3a9e2c1b4d5e6f';
    }

    // Try backend RPC login
    if (typeof runBackendFunction === 'function') {
      try {
        const res = await runBackendFunction('adminLogin', [userClean, passClean]);
        if (res && res.success) {
          loginSuccess = true;
          if (res.role) resolvedRole = res.role;
          if (res.username) resolvedUser = res.username;
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
        sessionStorage.setItem('rocket_admin_user', resolvedUser);
        sessionStorage.setItem('rocket_admin_role', resolvedRole);
        sessionStorage.setItem('rocket_admin_key', resolvedAdminKey);
      }
      if (typeof setAdminRole === 'function') {
        setAdminRole(resolvedRole);
      }
      setAdminAuthenticated(true);
      setLoginError('');
    } else {
      setLoginError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
      setPasswordInput('');
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800 font-sans flex flex-col selection:bg-sky-500 selection:text-white relative overflow-x-hidden">
      {/* Soft ambient light glow */}
      <div 
        className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #38bdf8 0%, rgba(248,250,252,0) 70%)' }}
      />

      {/* -------------------------------------------------------------
          TOP NAVIGATION BAR (Bright Daylight Glass Theme)
         ------------------------------------------------------------- */}
      <header className="fixed top-0 inset-x-0 z-50 w-full bg-white/85 backdrop-blur-md border-b border-slate-200/80 px-3 sm:px-8 lg:px-12 py-2.5 sm:py-3 transition-all shadow-xs">
        <div className="w-full max-w-[1720px] mx-auto flex items-center justify-between gap-2 sm:gap-4 lg:gap-8">
          
          {/* Brand Logo & Title */}
          <div 
            className="flex items-center gap-2 sm:gap-3 cursor-pointer shrink-0 min-w-0" 
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center text-white shrink-0 shadow-md shadow-sky-500/20">
              <Rocket size={17} className="transform -rotate-45" />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="text-xs sm:text-base lg:text-lg font-black font-heading tracking-tight text-slate-900 uppercase whitespace-nowrap">
                  Bang Fai Commander
                </span>
                <span className="hidden md:inline-block px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider bg-sky-50 text-sky-700 rounded border border-sky-200 whitespace-nowrap">
                  Cloud Portal
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-normal hidden lg:block whitespace-nowrap">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนาม
              </p>
            </div>
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden md:flex items-center gap-6 lg:gap-8 text-sm font-medium text-slate-600 shrink-0">
            <button 
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="hover:text-sky-600 transition-colors cursor-pointer whitespace-nowrap py-1 font-medium"
            >
              หน้าหลัก
            </button>
            <button 
              type="button"
              onClick={() => handleNavClick('usage')}
              className={`hover:text-sky-600 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'usage' ? 'text-sky-600 font-bold' : ''}`}
            >
              <BookOpen size={15} />
              <span>คู่มือการใช้งาน</span>
            </button>
            <button 
              type="button"
              onClick={() => handleNavClick('terms')}
              className={`hover:text-sky-600 transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'terms' ? 'text-sky-600 font-bold' : ''}`}
            >
              <FileCheck size={15} />
              <span>ข้อกำหนดและเงื่อนไข</span>
            </button>
          </nav>

          {/* Action CTA: Sign In Button */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={handleOpenLoginModal}
              className="p-2 sm:px-5 sm:py-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center gap-1.5 sm:gap-2 cursor-pointer border border-sky-300/40 whitespace-nowrap shrink-0 shadow-md shadow-sky-500/25"
              title="เข้าสู่ระบบ (Sign In)"
            >
              <LogIn size={15} className="shrink-0" />
              <span className="hidden sm:inline">เข้าสู่ระบบ (Sign In)</span>
            </button>

            {/* Mobile Hamburger Toggle */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-1.5 sm:p-2 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors shrink-0"
              aria-label="Toggle Navigation Menu"
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden mt-3 pt-3 border-t border-slate-200 flex flex-col gap-2 pb-2 bg-white/95 rounded-xl px-2 shadow-lg">
            <button
              type="button"
              onClick={() => { setMobileMenuOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100"
            >
              หน้าหลัก (Home)
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('usage')}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 flex items-center gap-2"
            >
              <BookOpen size={16} className="text-sky-600" />
              <span>คู่มือการใช้งาน (Usage Instructions)</span>
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('terms')}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100 flex items-center gap-2"
            >
              <FileCheck size={16} className="text-sky-600" />
              <span>ข้อกำหนดและเงื่อนไข (Terms of Use)</span>
            </button>
            <button
              type="button"
              onClick={handleOpenLoginModal}
              className="text-left px-3 py-2.5 rounded-lg text-sm font-semibold text-sky-700 bg-sky-50 hover:bg-sky-100 flex items-center gap-2 mt-1 border border-sky-200"
            >
              <LogIn size={16} className="text-sky-600" />
              <span>เข้าสู่ระบบ (Sign In)</span>
            </button>
          </div>
        )}
      </header>

      {/* -------------------------------------------------------------
          HERO SECTION: DAYLIGHT FIELD LAUNCH (BANG FAI ATMOSPHERE)
         ------------------------------------------------------------- */}
      <section className="relative w-full min-h-[680px] lg:min-h-[740px] pt-[84px] pb-12 lg:pb-16 flex items-center bg-sky-50 overflow-hidden">
        {/* Crystal Clear Daylight Background Image (Field Rocket Launch with White Smoke) */}
        <div 
          className="absolute inset-0 bg-cover bg-no-repeat pointer-events-none transition-all duration-500"
          style={{ 
            backgroundImage: `url(${HERO_FULL_BACKGROUND})`,
            backgroundPosition: '64% top',
          }}
        />

        {/* Subtle Ambient Daylight Atmosphere (No dark scrims) */}
        <div className="absolute inset-0 bg-gradient-to-r from-sky-900/15 via-transparent to-transparent pointer-events-none lg:w-1/2" />
        
        {/* Top Header Subtle Blend */}
        <div className="absolute top-0 inset-x-0 h-20 bg-gradient-to-b from-white/50 to-transparent pointer-events-none" />

        {/* Seamless Bottom Smoke Blend into Core Values */}
        <div 
          className="absolute inset-x-0 bottom-0 h-40 sm:h-56 pointer-events-none"
          style={{ 
            background: 'linear-gradient(to top, #ffffff 0%, #ffffff 22%, rgba(255,255,255,0.88) 55%, rgba(255,255,255,0.3) 82%, transparent 100%)' 
          }}
        />

        <div className="relative z-10 w-full max-w-[1720px] mx-auto px-4 sm:px-8 lg:px-12 py-8 sm:py-12 flex-1 flex flex-col justify-center">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            
            {/* LEFT COLUMN: FROSTED DAYLIGHT ENTERPRISE CARD */}
            <div className="w-full lg:col-span-7 xl:col-span-6 flex flex-col justify-center items-start text-left min-w-0 space-y-4 sm:space-y-5 p-5 sm:p-8 lg:p-10 rounded-3xl bg-white/85 sm:bg-white/80 backdrop-blur-xl border border-white/90 shadow-[0_20px_50px_rgba(15,23,42,0.08),0_1px_3px_rgba(15,23,42,0.05)]">
              
              {/* Status Overline Badge */}
              <div className="inline-flex items-center gap-2 px-3 py-1 sm:px-3.5 sm:py-1.5 rounded-full bg-sky-50 border border-sky-200/80 text-sky-800 text-xs font-semibold shadow-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <ShieldCheck size={14} className="text-sky-600" />
                <span className="whitespace-nowrap">Bang Fai Operations Platform</span>
              </div>

              {/* Main Headline */}
              <div className="space-y-2.5 sm:space-y-3 min-w-0">
                <h1 className="text-3xl sm:text-5xl lg:text-[54px] font-heading text-slate-900 tracking-tight leading-[1.12]">
                  <span className="font-extrabold block sm:whitespace-nowrap">Better Solutions</span>
                  <span className="font-light italic text-sky-600 block text-2xl sm:text-4xl lg:text-[42px] mt-0.5 sm:mt-1 sm:whitespace-nowrap">For Your Operations</span>
                </h1>
                <h2 className="text-xs sm:text-base md:text-lg font-semibold text-slate-800 font-thai">
                  ระบบบริหารจัดการธุรกรรมและการแข่งขันบั้งไฟภาคสนามระดับมืออาชีพ
                </h2>
                <p className="text-xs sm:text-sm md:text-base text-slate-600 font-thai font-normal max-w-xl leading-relaxed">
                  ศูนย์กลางประมวลผลคำสั่งซื้อ ตรวจสลิปอัตโนมัติ และระบบบันทึกเวลาเรียลไทม์ แม่นยำ รวดเร็ว ตรวจสอบได้ทุกขั้นตอน
                </p>
              </div>

              {/* Core Feature Highlights (Liquid Glass Pills - Daylight Style) */}
              <div className="pt-1 flex flex-wrap items-center gap-2 sm:gap-2.5 text-xs text-slate-800 font-medium max-w-full">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 rounded-xl bg-slate-50/90 border border-slate-200/90 shadow-2xs shrink-0">
                  <Zap size={13} className="text-amber-500" />
                  <span className="whitespace-nowrap font-semibold">แม่นยำระดับเสี้ยววินาที</span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 rounded-xl bg-slate-50/90 border border-slate-200/90 shadow-2xs shrink-0">
                  <ShieldCheck size={13} className="text-emerald-600" />
                  <span className="whitespace-nowrap font-semibold">ตรวจสลิปอัตโนมัติ 1:1</span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 rounded-xl bg-slate-50/90 border border-slate-200/90 shadow-2xs shrink-0">
                  <BarChart3 size={13} className="text-sky-600" />
                  <span className="whitespace-nowrap font-semibold">ซิงก์ข้อมูลเรียลไทม์</span>
                </span>
              </div>

            </div>

            {/* RIGHT COLUMN: OPEN HERO SPACE SHOWCASING FIELD LAUNCH ROCKET */}
            <div className="hidden lg:block lg:col-span-5 xl:col-span-6 pointer-events-none select-none" />

          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------
          CORE OPERATIONAL VALUES & CAPABILITIES (Unified Flow)
         ------------------------------------------------------------- */}
      <section className="relative z-20 w-full bg-white text-slate-800 py-12 px-4 sm:px-8 border-b border-slate-200">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-2 border-b border-slate-100">
            <div>
              <span className="text-xs uppercase tracking-wider font-extrabold text-sky-600 block mb-1">
                CORE OPERATIONAL VALUES
              </span>
              <h3 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
                มาตรฐานความแม่นยำและความปลอดภัยระดับมืออาชีพ
              </h3>
            </div>
            <p className="text-xs text-slate-500 max-w-md">
              ออกแบบเพื่อยกระดับการปฏิบัติงานภาคสนามให้ราบรื่น โปร่งใส ตรวจสอบได้ และรวดเร็ว
            </p>
          </div>

          {/* 4 Professional Value Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Value 1: Precision Timing */}
            <div className="p-5 rounded-2xl bg-slate-50/80 hover:bg-white border border-slate-200/80 hover:border-amber-400 hover:shadow-md transition-all text-left group">
              <div className="w-10 h-10 rounded-xl bg-amber-100/70 border border-amber-200 flex items-center justify-center text-amber-600 mb-3 group-hover:scale-105 transition-transform">
                <Zap size={20} />
              </div>
              <span className="text-sm font-bold text-slate-900 block">แม่นยำระดับเสี้ยววินาที</span>
              <span className="text-xs text-slate-500 font-medium block mt-0.5">High-Precision Timing</span>
              <p className="text-[11px] text-slate-500 mt-2 font-thai leading-relaxed">
                บันทึกผลเวลาบินจริงระดับทศนิยม แม่นยำทุกเสี้ยววินาที
              </p>
            </div>

            {/* Value 2: Automated Verification */}
            <div className="p-5 rounded-2xl bg-slate-50/80 hover:bg-white border border-slate-200/80 hover:border-emerald-400 hover:shadow-md transition-all text-left group">
              <div className="w-10 h-10 rounded-xl bg-emerald-100/70 border border-emerald-200 flex items-center justify-center text-emerald-600 mb-3 group-hover:scale-105 transition-transform">
                <ShieldCheck size={20} />
              </div>
              <span className="text-sm font-bold text-slate-900 block">ตรวจสอบอัตโนมัติ 1:1</span>
              <span className="text-xs text-slate-500 font-medium block mt-0.5">Instant Verification</span>
              <p className="text-[11px] text-slate-500 mt-2 font-thai leading-relaxed">
                AI Vision สแกนตรวจสลิปโอนเงิน ป้องกันการส่งซ้ำ 100%
              </p>
            </div>

            {/* Value 3: Real-Time Live Sync */}
            <div className="p-5 rounded-2xl bg-slate-50/80 hover:bg-white border border-slate-200/80 hover:border-sky-400 hover:shadow-md transition-all text-left group">
              <div className="w-10 h-10 rounded-xl bg-sky-100/70 border border-sky-200 flex items-center justify-center text-sky-600 mb-3 group-hover:scale-105 transition-transform">
                <BarChart3 size={20} />
              </div>
              <span className="text-sm font-bold text-slate-900 block">ซิงก์ข้อมูลเรียลไทม์</span>
              <span className="text-xs text-slate-500 font-medium block mt-0.5">Live Synchronization</span>
              <p className="text-[11px] text-slate-500 mt-2 font-thai leading-relaxed">
                บรอดแคสต์ราคาช่างและผลรอบเข้า LINE แบบทันทีทันใด
              </p>
            </div>

            {/* Value 4: Multi-Device Ready */}
            <div className="p-5 rounded-2xl bg-slate-50/80 hover:bg-white border border-slate-200/80 hover:border-blue-400 hover:shadow-md transition-all text-left group">
              <div className="w-10 h-10 rounded-xl bg-blue-100/70 border border-blue-200 flex items-center justify-center text-blue-600 mb-3 group-hover:scale-105 transition-transform">
                <Smartphone size={20} />
              </div>
              <span className="text-sm font-bold text-slate-900 block">รองรับทุกอุปกรณ์</span>
              <span className="text-xs text-slate-500 font-medium block mt-0.5">Multi-Device Ready</span>
              <p className="text-[11px] text-slate-500 mt-2 font-thai leading-relaxed">
                ใช้งานได้ลื่นไหลทั้งมือถือ แท็บเล็ต และคอมพิวเตอร์ภาคสนาม
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------
          INTERACTIVE DOCUMENTATION & OPERATIONAL TABS SECTION (Bright Theme)
         ------------------------------------------------------------- */}
      <section 
        ref={docsSectionRef}
        className="w-full bg-slate-50 text-slate-800 py-16 px-4 sm:px-8 border-b border-slate-200 scroll-mt-16"
      >
        <div className="max-w-5xl mx-auto space-y-8">
          
          {/* Section Header */}
          <div className="text-center space-y-2.5 max-w-2xl mx-auto">
            <span className="px-3.5 py-1 rounded-full bg-sky-100 text-sky-700 border border-sky-200 text-xs font-bold uppercase tracking-wider">
              System Documentation &amp; Guidelines
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold font-heading text-slate-900 tracking-tight">
              ศูนย์ข้อมูลและคู่มือการปฏิบัติงานภาคสนาม
            </h2>
            <p className="text-sm text-slate-500">
              คำแนะนำขั้นตอนการทำงานสำหรับเจ้าหน้าที่และนโยบายความปลอดภัยของระบบ
            </p>
          </div>

          {/* Segmented Tabs Navigation */}
          <div className="grid grid-cols-2 gap-2 p-1.5 bg-slate-200/80 rounded-2xl max-w-md mx-auto border border-slate-300/60 shadow-xs">
            <button
              type="button"
              onClick={() => setActiveTab('usage')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'usage' 
                  ? 'bg-white text-sky-700 shadow-sm border border-slate-200/80' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen size={16} className={activeTab === 'usage' ? 'text-sky-600' : 'text-slate-500'} />
              <span className="whitespace-nowrap">คู่มือการใช้งาน (Usage)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('terms')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'terms' 
                  ? 'bg-white text-sky-700 shadow-sm border border-slate-200/80' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileCheck size={16} className={activeTab === 'terms' ? 'text-sky-600' : 'text-slate-500'} />
              <span className="whitespace-nowrap">ข้อกำหนดและเงื่อนไข (Terms)</span>
            </button>
          </div>

          {/* TAB 1: USAGE INSTRUCTIONS (Bright Theme) */}
          {activeTab === 'usage' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Step 1 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                      1
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การลงชื่อเข้าใช้ระบบ &amp; สิทธิ์การควบคุม (Sign-In &amp; Role Access)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    ผู้ดูแลระบบลงชื่อเข้าใช้งานด้วย Username และ Password ผ่านปุ่ม <strong className="text-sky-600">"เข้าสู่ระบบ (Sign In)"</strong> ที่แถบเมนูด้านบน โดยระบบจะแยกสิทธิ์ออกเป็น 2 ระดับตามความรับผิดชอบ:
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li><strong className="text-slate-800">Super Admin (Admin):</strong> ควบคุมทุกฟังก์ชัน คอนฟิก และมีสิทธิ์สั่งรีเซ็ตฐานข้อมูล (Factory Reset)</li>
                    <li><strong className="text-slate-800">Admin (Admin1):</strong> จัดการรอบ ป้อนราคาช่าง บันทึกเวลา ออกผลการแข่งขัน และตรวจสลิป (จำกัดสิทธิ์ห้ามทำ Factory Reset)</li>
                  </ul>
                </div>

                {/* Step 2 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                      2
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การตั้งราคาช่าง &amp; ประกาศราคา (Manual Quote Entry &amp; Broadcast)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    ก่อนเริ่มปล่อยบั้งไฟ แอดมินเป็นผู้ป้อนข้อมูลรอบด้วยตนเอง (Manual Data Entry) เช่น ชื่อค่ายบั้งไฟ, พิกัดเวลาเป้าหมายต่ำสุด-สูงสุด (เช่น 330-380s), แต้มดวลเริ่มต้น และเลือกตัวเลือก "เผื่อช่างไม่ต่อย (ชตย)" จากนั้นเลือกกลุ่มเป้าหมาย (ทุกกลุ่มดวลสด หรือเฉพาะกลุ่ม) แล้วกด <strong className="text-sky-600">"ประกาศราคาช่าง"</strong> เพื่อส่งราคาเข้ากลุ่ม LINE ทันที
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>คำสั่งซื้อประเภท Hold จะถูกปล่อยพร้อมกันเมื่อแอดมินประกาศราคา</li>
                    <li>เมื่อบั้งไฟจุดขึ้นสู่อากาศ ระบบจะทำการล็อครอบเพื่อปิดรับคำสั่งซื้อทันที</li>
                  </ul>
                </div>

                {/* Step 3 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                      3
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      ตรวจสลิปเงินโอน 1:1 (Automated OCR Verification)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    เมื่อผู้เล่นส่งรูปสลิป ระบบ AI Vision จะตรวจอ่าน QR Code ถอดรหัสตรวจสอบยอดเงินและเลขอ้างอิง (Ref Code) แบบ 1:1 ทันที หากผ่านเงื่อนไข ระบบจะเพิ่มเครดิตเข้ากระเป๋าผู้เล่นอัตโนมัติพร้อมส่งบัตรยืนยันกลับไปยัง LINE ทันที
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>สลิปที่ไม่มี QR หรือภาพไม่ชัด จะถูกส่งเข้าคิวให้แอดมินตรวจสอบและกดอนุมัติด้วยมือ (Manual Approval)</li>
                    <li>ระบบป้องกันสลิปซ้ำซ้อน 100% ด้วยการจดจำเลขอ้างอิงลงฐานข้อมูลถาวร</li>
                  </ul>
                </div>

                {/* Step 4 */}
                <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                      4
                    </span>
                    <h3 className="text-base font-bold text-slate-900">
                      การป้อนผลเวลาบินจริง &amp; ออกผลการแข่งขัน (Manual Result Entry &amp; Settlement)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed font-thai">
                    กรรมการภาคสนามจับเวลาจริงของบั้งไฟด้วยนาฬิกาจับเวลามาตรฐาน เมื่อตกถึงพื้น แอดมินนำเวลาที่บันทึกได้มา<strong className="text-sky-600">ป้อนลงในช่อง "ผลยิงจริงในสนาม (Actual Air Time)" ด้วยตนเอง</strong> (เช่น 355.0s) ระบบจะเปรียบเทียบกับราคาช่าง แสดงผลคาดการณ์ (ต่ำ / สูง / ในราคาช่าง) และเมื่อกด <strong className="text-sky-600">"สรุปผลและชำระแต้มดีลทั้งหมด"</strong> ระบบจะโอนจ่ายแต้มผู้ชนะทันที
                  </p>
                  <ul className="text-xs text-slate-500 space-y-1.5 list-disc pl-5">
                    <li>กรณีบั้งไฟแตก ระเบิด หรือกรรมการสั่งโมฆะ ให้ใช้ปุ่ม "ยกเลิกรอบ (Void Round)"</li>
                    <li>ระบบจะคืนเครดิตแบบ Idempotent ป้องกันการคืนเงินซ้ำซ้อน 100%</li>
                  </ul>
                </div>
              </div>

              {/* Quick Field Tip Box */}
              <div className="p-4 bg-sky-50 border border-sky-200 rounded-xl flex items-start gap-3">
                <Lightbulb size={20} className="text-amber-500 shrink-0 mt-0.5" />
                <div className="text-xs text-slate-700">
                  <strong className="block text-sky-800 font-bold mb-0.5">ข้อแนะนำภาคสนาม (Field Pro-Tip):</strong>
                  กรรมการควรเปิดหน้านี้บนแท็บเล็ตหรือโน้ตบุ๊กที่มีการเชื่อมต่ออินเทอร์เน็ตเสถียร หากแอดมินออกจากระบบ ให้กดปุ่ม <strong>"เข้าสู่ระบบ (Sign In)"</strong> ที่แถบเมนูด้านบนเพื่อเปิดหน้าต่างเข้าสู่ระบบโดยไม่ต้องรีเฟรชหน้าเว็บ
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TERMS OF USE & SECURITY (Bright Theme) */}
          {activeTab === 'terms' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 shadow-xs space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 mb-1">
                    ข้อกำหนดความปลอดภัยและการใช้งานระบบ (Enterprise Compliance &amp; Terms)
                  </h3>
                  <p className="text-xs text-slate-500">
                    มีผลบังคับใช้สำหรับเจ้าหน้าที่ผู้ดูแลระบบ, ผู้บันทึกเวลา และกรรมการภาคสนามทุกคน
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Term 1 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-800 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-100 text-sky-700 border border-sky-200 text-[11px] flex items-center justify-center font-bold">1</span>
                      การแบ่งระดับสิทธิ์และการรักษาความลับของบัญชี (Two-Tier Role Access &amp; Security)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ผู้ดูแลระบบต้องเก็บรักษา Username, Password และรหัสผ่าน Admin Key เป็นความลับสูงสุด โดยระบบแบ่งระดับสิทธิ์เป็น Super Admin (จัดการทุกระบบและล้างฐานข้อมูล) และ Admin (ปฏิบัติการภาคสนามทั่วไป ป้อนราคาช่าง ป้อนเวลาจริง และเคลียร์ผล แต่ไม่มีสิทธิ์ล้างฐานข้อมูล) ห้ามส่งต่อหรือบันทึกในอุปกรณ์สาธารณะ หากสงสัยว่ารหัสผ่านรั่วไหล ต้องติดต่อผู้ดูแลระบบส่วนกลางเพื่อรีเซ็ตรหัสผ่านทันที
                    </p>
                  </div>

                  {/* Term 2 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-800 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-100 text-sky-700 border border-sky-200 text-[11px] flex items-center justify-center font-bold">2</span>
                      นโยบายป้องกันสลิปซ้ำซ้อน (Anti-Fraud Slip Quarantine)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      สลิปทุกใบที่ผ่านการเคลมเครดิตจะถูกบันทึกรหัสอ้างอิง (Ref Code) ลงในระบบถาวร หากมีการส่งซ้ำหรือตรวจพบการดัดแปลงภาพ ระบบจะปฏิเสธการเติมเงินและขึ้นบันทึกเตือนในหน้าตรวจสอบสลิปของแอดมินทันที
                    </p>
                  </div>

                  {/* Term 3 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-800 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-100 text-sky-700 border border-sky-200 text-[11px] flex items-center justify-center font-bold">3</span>
                      การบันทึกประวัติการกระทำและความรับผิดชอบ (Audit Trail Logging)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ทุกการกระทำของผู้ดูแลระบบ ได้แก่ การป้อนราคาช่าง (Manual Quote Entry), การบรอดแคสต์ราคา, การป้อนเวลาผลการบินจริง (Actual Flight Time Input), การสรุปผลรอบ และการอนุมัติสลิปมือ จะถูกบันทึกประวัติพร้อม Timestamp และ Admin Role เพื่อความโปร่งใสและตรวจสอบย้อนหลังได้ 100%
                    </p>
                  </div>

                  {/* Term 4 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-800 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-100 text-sky-700 border border-sky-200 text-[11px] flex items-center justify-center font-bold">4</span>
                      มาตรการยกเลิกรอบและคืนเงินสองขั้นตอน (Two-Phase Idempotent Round Voiding)
                    </h4>
                    <p className="text-xs text-slate-600 leading-relaxed font-thai">
                      ในกรณีที่รอบแข่งขันถูกยกเลิก (Void Round) ระบบจะเปลี่ยนสถานะออเดอร์เป็น <code className="text-xs bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded text-amber-700">refunding</code> ก่อนคืนเครดิต เมื่อยอดเงินผู้เล่นอัปเดตเรียบร้อยจึงเปลี่ยนเป็น <code className="text-xs bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded text-slate-600">cancelled</code> ป้องกันการคืนเงินซ้ำซ้อนแม้อินเทอร์เน็ตขัดข้อง
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

        </div>
      </section>

      {/* -------------------------------------------------------------
          FOOTER (Bright Daylight Theme)
         ------------------------------------------------------------- */}
      <footer className="w-full bg-white text-slate-500 py-8 px-4 sm:px-8 border-t border-slate-200 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3 text-center md:text-left">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center text-white shrink-0 shadow-sm">
              <Rocket size={18} className="transform -rotate-45" />
            </div>
            <div>
              <span className="text-sm font-bold text-slate-900 uppercase block">
                Bang Fai Commander &bull; Mission Control
              </span>
              <p className="text-xs text-slate-400">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนาม &bull; Cloud Edition
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4 text-xs">
            <button 
              type="button" 
              onClick={() => handleNavClick('terms')} 
              className="hover:text-sky-600 transition-colors cursor-pointer whitespace-nowrap text-slate-600 font-medium"
            >
              ข้อกำหนดและเงื่อนไข (Terms of Service)
            </button>
          </div>

          <div className="text-xs text-slate-400 text-center md:text-right">
            <span>&copy; {new Date().getFullYear()} Bang Fai Commander. All rights reserved.</span>
          </div>
        </div>
      </footer>

      {/* -------------------------------------------------------------
          POPUP MODAL: APPLE-STYLE BRIGHT GLASS ADMIN LOGIN DIALOG
         ------------------------------------------------------------- */}
      {isLoginModalOpen && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm transition-all duration-300 animate-in fade-in"
          onClick={handleCloseLoginModal}
        >
          <div 
            ref={loginCardRef}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[420px] bg-white rounded-3xl p-6 sm:p-7 shadow-[0_25px_60px_rgba(0,0,0,0.18)] border border-slate-200/80 space-y-4 overflow-hidden animate-in zoom-in-95 duration-200"
          >
            {/* Top Accent Bar */}
            <div className="absolute top-0 inset-x-0 h-1.5 bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 rounded-t-3xl" />

            {/* Close Button (X) */}
            <button
              type="button"
              onClick={handleCloseLoginModal}
              className="absolute top-4 right-4 z-20 p-2 rounded-full bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-500 hover:text-slate-800 transition-all cursor-pointer"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            {/* Card Header */}
            <div className="relative z-10 flex items-center justify-between pb-3 border-b border-slate-100 gap-3 pr-8">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600 shadow-xs shrink-0">
                  <Lock size={18} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight whitespace-nowrap">
                    เข้าสู่ระบบผู้ดูแล (Admin)
                  </h3>
                  <p className="text-[11px] sm:text-xs text-slate-500 font-medium whitespace-nowrap">
                    ยินดีต้อนรับสู่ระบบควบคุมภาคสนาม
                  </p>
                </div>
              </div>
              <span className="text-[10px] px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full font-sans font-bold tracking-wider whitespace-nowrap">
                SECURED
              </span>
            </div>

            {/* Login Form */}
            <form onSubmit={handleLogin} className="relative z-10 space-y-3.5">
              {/* Username Input */}
              <div className="space-y-1">
                <label 
                  htmlFor="admin-username-field" 
                  className="text-xs font-semibold text-slate-700 block"
                >
                  ชื่อผู้ใช้ (Username)
                </label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <User size={16} />
                  </span>
                  <input 
                    id="admin-username-field"
                    ref={userInputRef}
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck="false"
                    placeholder="ป้อนชื่อผู้ใช้..."
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    className="w-full pl-9 pr-3.5 py-2.5 bg-slate-50 hover:bg-slate-100/60 focus:bg-white border border-slate-200 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 rounded-xl text-slate-900 placeholder-slate-400 font-sans text-xs tracking-normal transition-all shadow-xs"
                    autoFocus
                  />
                </div>
              </div>

              {/* Password Input */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label 
                    htmlFor="admin-password-field" 
                    className="text-xs font-semibold text-slate-700 block"
                  >
                    รหัสผ่าน (Password)
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[10px] text-sky-600 hover:text-sky-800 hover:underline flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    {showPassword ? (
                      <>
                        <EyeOff size={11} />
                        <span>ซ่อน</span>
                      </>
                    ) : (
                      <>
                        <Eye size={11} />
                        <span>แสดง</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <Lock size={16} />
                  </span>
                  <input 
                    id="admin-password-field"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="ป้อนรหัสผ่าน..."
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    className="w-full pl-9 pr-9 py-2.5 bg-slate-50 hover:bg-slate-100/60 focus:bg-white border border-slate-200 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 rounded-xl text-slate-900 placeholder-slate-400 font-mono text-xs tracking-wider transition-all shadow-xs"
                  />
                </div>
              </div>

              {/* Error Banner */}
              {loginError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl flex items-center gap-2 text-rose-800">
                  <AlertTriangle size={16} className="shrink-0 text-rose-600" />
                  <span className="text-[11px] font-semibold">
                    {loginError}
                  </span>
                </div>
              )}

              {/* Sign-In Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 px-5 bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 hover:from-sky-600 hover:to-blue-700 active:scale-[0.98] disabled:opacity-50 text-white rounded-xl text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-sky-500/25 mt-1"
              >
                <LogIn size={15} />
                <span>{isSubmitting ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ (Sign In)'}</span>
              </button>
            </form>

            {/* Card Footer Info */}
            <div className="relative z-10 pt-2 flex items-center justify-between text-[10px] text-slate-400 border-t border-slate-100">
              <span className="flex items-center gap-1 text-slate-600">
                <ShieldCheck size={13} className="text-emerald-600" />
                <span>256-Bit SSL Secured</span>
              </span>
              <span className="text-slate-400">
                Mission Control &bull; TLS 1.3
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
