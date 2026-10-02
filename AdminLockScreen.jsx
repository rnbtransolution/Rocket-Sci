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
    <div className="min-h-screen w-full bg-[#071324] text-white font-sans flex flex-col selection:bg-sky-500 selection:text-white relative overflow-x-hidden">
      {/* Background Subtle Tech Grid & Ambient Lighting */}
      <div className="absolute inset-0 pointer-events-none opacity-10 bg-[radial-gradient(#38bdf8_1px,transparent_1px)] [background-size:28px_28px]" />
      <div 
        className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full pointer-events-none opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(circle, #0284c7 0%, rgba(7,19,36,0) 70%)' }}
      />
      <div 
        className="absolute top-1/3 left-0 w-[500px] h-[500px] rounded-full pointer-events-none opacity-15 blur-3xl"
        style={{ background: 'radial-gradient(circle, #f97316 0%, rgba(7,19,36,0) 70%)' }}
      />
      {/* -------------------------------------------------------------
          TOP NAVIGATION BAR (Rescaled for Professional Alignment)
         ------------------------------------------------------------- */}
      <header className="sticky top-0 z-50 w-full bg-[#071324]/90 backdrop-blur-md border-b border-white/10 px-4 sm:px-8 lg:px-12 py-3 transition-all">
        <div className="max-w-[1720px] mx-auto flex items-center justify-between gap-4 lg:gap-8">
          
          {/* Brand Logo & Title */}
          <div 
            className="flex items-center gap-3 cursor-pointer shrink-0" 
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center text-white border border-white/20 shrink-0 shadow-lg shadow-sky-500/20">
              <Rocket size={20} className="transform -rotate-45" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-base sm:text-lg font-black font-heading tracking-tight text-white uppercase whitespace-nowrap">
                  Bang Fai Commander
                </span>
                <span className="hidden md:inline-block px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider bg-white/10 text-sky-300 rounded border border-sky-400/30 whitespace-nowrap">
                  Cloud Portal
                </span>
              </div>
              <p className="text-[11px] text-slate-300 font-normal hidden lg:block whitespace-nowrap">
                ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนาม
              </p>
            </div>
          </div>

          {/* Desktop Navigation Links (Clean Single-Line Alignment) */}
          <nav className="hidden md:flex items-center gap-6 lg:gap-8 text-sm font-medium text-slate-300 shrink-0">
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
              className={`hover:text-white transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'usage' ? 'text-sky-400 font-bold' : ''}`}
            >
              <BookOpen size={15} />
              <span>คู่มือการใช้งาน</span>
            </button>
            <button 
              type="button"
              onClick={() => handleNavClick('terms')}
              className={`hover:text-white transition-colors cursor-pointer whitespace-nowrap flex items-center gap-1.5 py-1 ${activeTab === 'terms' ? 'text-sky-400 font-bold' : ''}`}
            >
              <FileCheck size={15} />
              <span>ข้อกำหนดและเงื่อนไข</span>
            </button>
          </nav>

          {/* Action CTA: Sign In Button */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={handleScrollToLogin}
              className="px-3 sm:px-5 py-1.5 sm:py-2 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center gap-1.5 sm:gap-2 cursor-pointer border border-sky-300/40 whitespace-nowrap shrink-0 shadow-lg shadow-sky-500/20"
            >
              <LogIn size={14} className="shrink-0" />
              <span>เข้าสู่ระบบ</span>
              <span className="hidden sm:inline">(Sign In)</span>
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
          <div className="md:hidden mt-3 pt-3 border-t border-white/10 flex flex-col gap-2 pb-2 bg-[#071324]/95 rounded-xl px-2">
            <button
              type="button"
              onClick={() => { setMobileMenuOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-white/10 hover:text-white"
            >
              หน้าหลัก (Home)
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('usage')}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
            >
              <BookOpen size={16} className="text-sky-400" />
              <span>คู่มือการใช้งาน (Usage Instructions)</span>
            </button>
            <button
              type="button"
              onClick={() => handleNavClick('terms')}
              className="text-left px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
            >
              <FileCheck size={16} className="text-sky-400" />
              <span>ข้อกำหนดและเงื่อนไข (Terms of Use)</span>
            </button>
          </div>
        )}
      </header>

      {/* -------------------------------------------------------------
          HERO SECTION: FULL HOMEPAGE STYLE WITH BACKGROUND.PNG (ATLAS V LAUNCH)
         ------------------------------------------------------------- */}
      <section 
        className="relative w-full min-h-[calc(100vh-68px)] flex items-center bg-[#030712] bg-cover bg-right lg:bg-center overflow-hidden"
        style={{ backgroundImage: `url(${HERO_FULL_BACKGROUND})` }}
      >
        {/* Rich Multi-Layered Atmospheric Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#030712]/90 via-[#030712]/60 to-[#030712]/35 pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#071324]/90 via-transparent to-[#081528] pointer-events-none" />
        {/* Smooth Top Transition from Header */}
        <div className="absolute top-0 inset-x-0 h-24 bg-gradient-to-b from-[#071324] to-transparent pointer-events-none" />
        {/* Smooth Bottom Transition to Next Section */}
        <div className="absolute bottom-0 inset-x-0 h-32 bg-gradient-to-t from-[#081528] via-[#081528]/80 to-transparent pointer-events-none" />

        <div className="relative z-10 w-full max-w-[1720px] mx-auto px-4 sm:px-8 lg:px-12 py-10 sm:py-16 flex-1 flex flex-col justify-center">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-center">
            
            {/* LEFT COLUMN: APPLE STYLE LIQUID GLASS LOGIN CARD */}
            <div className="order-2 lg:order-1 lg:col-span-4 xl:col-span-3 w-full flex justify-center lg:justify-start">
              <div 
                ref={loginCardRef}
                className="relative w-full max-w-[340px] sm:max-w-[350px] bg-[#071324]/55 backdrop-blur-2xl border border-white/20 border-t-white/40 rounded-3xl p-5 sm:p-6 shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.2)] space-y-4 overflow-hidden ring-1 ring-inset ring-white/10"
              >
                {/* Upper Specular Glass Sheen Highlight */}
                <div className="absolute top-0 inset-x-0 h-28 bg-gradient-to-b from-white/15 to-transparent pointer-events-none rounded-t-3xl" />

                {/* Card Header */}
                <div className="relative z-10 flex items-center justify-between pb-2.5 border-b border-white/15 gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-2xl bg-white/15 border border-white/25 backdrop-blur-xl flex items-center justify-center text-sky-300 shadow-[inset_0_1px_1px_rgba(255,255,255,0.3)] shrink-0">
                      <Lock size={17} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm sm:text-base font-bold text-white tracking-tight drop-shadow-sm whitespace-nowrap">
                        เข้าสู่ระบบผู้ดูแล (Admin)
                      </h3>
                      <p className="text-[10px] sm:text-[11px] text-sky-200/90 font-medium whitespace-nowrap">
                        ยินดีต้อนรับสู่ระบบควบคุมภาคสนาม
                      </p>
                    </div>
                  </div>
                  <span className="text-[9px] px-2 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 rounded-full font-sans font-semibold tracking-wide backdrop-blur-md shadow-sm shrink-0 whitespace-nowrap">
                    SECURED
                  </span>
                </div>

                {/* Login Form */}
                <form onSubmit={handleLogin} className="relative z-10 space-y-3.5">
                  {/* Username Input */}
                  <div className="space-y-1">
                    <label 
                      htmlFor="admin-username-field" 
                      className="text-xs font-semibold text-slate-200 block drop-shadow-sm"
                    >
                      ชื่อผู้ใช้ (Username)
                    </label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-sky-300">
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
                        className="w-full pl-9 pr-3.5 py-2 bg-[#061120]/70 hover:bg-[#061120]/80 focus:bg-[#061120]/95 backdrop-blur-xl border border-white/20 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 rounded-xl text-white placeholder-slate-400 font-sans text-xs tracking-normal transition-all shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Password Input */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label 
                        htmlFor="admin-password-field" 
                        className="text-xs font-semibold text-slate-200 block drop-shadow-sm"
                      >
                        รหัสผ่าน (Password)
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="text-[10px] text-sky-300 hover:text-white hover:underline flex items-center gap-1 cursor-pointer transition-colors"
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
                      <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-sky-300">
                        <Lock size={16} />
                      </span>
                      <input 
                        id="admin-password-field"
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        placeholder="ป้อนรหัสผ่าน..."
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        className="w-full pl-9 pr-9 py-2 bg-[#061120]/70 hover:bg-[#061120]/80 focus:bg-[#061120]/95 backdrop-blur-xl border border-white/20 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 rounded-xl text-white placeholder-slate-400 font-mono text-xs tracking-wider transition-all shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
                      />
                    </div>
                  </div>

                  {/* Error Banner */}
                  {loginError && (
                    <div className="p-2.5 bg-rose-500/25 border border-rose-500/50 rounded-xl flex items-center gap-2 text-rose-100 backdrop-blur-md">
                      <AlertTriangle size={16} className="shrink-0 text-rose-300" />
                      <span className="text-[11px] font-semibold">
                        {loginError}
                      </span>
                    </div>
                  )}

                  {/* Sign-In Submit Button */}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-3 px-5 bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 hover:from-sky-400 hover:to-blue-500 active:scale-[0.98] disabled:opacity-50 text-white rounded-xl text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center justify-center gap-2 cursor-pointer shadow-[0_8px_20px_rgba(14,165,233,0.35),inset_0_1px_1px_rgba(255,255,255,0.4)] border-t border-t-white/30 mt-1"
                  >
                    <LogIn size={15} />
                    <span>{isSubmitting ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ (Sign In)'}</span>
                  </button>
                </form>

                {/* Card Footer Info */}
                <div className="relative z-10 pt-2 flex flex-col sm:flex-row items-center justify-between text-[10px] text-slate-300 gap-1.5 border-t border-white/15">
                  <span className="flex items-center gap-1 text-slate-200">
                    <ShieldCheck size={13} className="text-sky-300" />
                    <span>256-Bit SSL Secured</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleNavClick('usage')}
                    className="text-sky-300 hover:text-white hover:underline flex items-center gap-1 cursor-pointer font-medium transition-colors"
                  >
                    <BookOpen size={11} />
                    <span>คู่มือการใช้งาน</span>
                  </button>
                </div>
              </div>
            </div>

            {/* CENTER COLUMN: Buffer between card and welcome block */}
            <div className="hidden lg:block lg:order-2 lg:col-span-2 xl:col-span-2 pointer-events-none select-none" />

            {/* RIGHT COLUMN: WELCOME HEADINGS, VALUE PROPOSITIONS & TRUST INDICATORS */}
            <div className="order-1 lg:order-3 lg:col-span-6 xl:col-span-6 w-full flex justify-center lg:justify-end min-w-0">
              <div className="w-full max-w-full sm:max-w-[560px] space-y-4 text-left min-w-0">
                
                {/* Status Overline Badge (Zero Emojis - Lucide ShieldCheck) */}
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20 text-sky-200 text-xs font-semibold shadow-sm backdrop-blur-md whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <ShieldCheck size={14} className="text-sky-400" />
                  <span className="whitespace-nowrap">Enterprise Operations Platform</span>
                </div>

                {/* Main Headline (2-Line Restyle: Bold + Thin Italic) */}
                <div className="space-y-2 min-w-0">
                  <h1 className="text-3xl sm:text-4xl lg:text-[40px] font-heading text-white tracking-tight leading-[1.15] drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]">
                    <span className="font-extrabold block whitespace-nowrap">Better Solutions</span>
                    <span className="font-light italic text-[#38bdf8] block text-2xl sm:text-3xl mt-0.5 whitespace-nowrap">For Your Operations</span>
                  </h1>
                  <h2 className="text-xs sm:text-sm md:text-base font-medium text-sky-100 font-thai drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] whitespace-nowrap overflow-hidden text-ellipsis">
                    ระบบบริหารจัดการธุรกรรมและการแข่งขันภาคสนามระดับองค์กร
                  </h2>
                  <p className="text-[10px] sm:text-xs md:text-sm text-slate-200 font-thai font-normal drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] whitespace-nowrap overflow-hidden text-ellipsis">
                    ศูนย์กลางประมวลผลคำสั่งซื้อ ตรวจสลิปอัตโนมัติ และระบบบันทึกเวลาเรียลไทม์
                  </p>
                </div>

                {/* Core Feature Highlights (Liquid Glass Pills - Strictly Single Line) */}
                <div className="pt-1 flex flex-nowrap items-center gap-2 text-xs text-white font-medium max-w-full overflow-x-auto pb-1 min-w-0">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/60 backdrop-blur-xl border border-white/20 shadow-md whitespace-nowrap shrink-0">
                    <Zap size={13} className="text-amber-400" />
                    <span className="whitespace-nowrap">แม่นยำระดับเสี้ยววินาที</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/60 backdrop-blur-xl border border-white/20 shadow-md whitespace-nowrap shrink-0">
                    <ShieldCheck size={13} className="text-emerald-400" />
                    <span className="whitespace-nowrap">ตรวจสลิปอัตโนมัติ 1:1</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/60 backdrop-blur-xl border border-white/20 shadow-md whitespace-nowrap shrink-0">
                    <BarChart3 size={13} className="text-sky-400" />
                    <span className="whitespace-nowrap">ซิงก์ข้อมูลเรียลไทม์</span>
                  </span>
                </div>

              </div>
            </div>

          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------
          CORE OPERATIONAL VALUES & CAPABILITIES (Confidential Value Proposition)
         ------------------------------------------------------------- */}
      <section className="w-full bg-[#081528] text-white py-10 px-4 sm:px-8 border-y border-white/10">
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row items-center justify-between gap-8">
          <div className="text-center lg:text-left max-w-sm">
            <span className="text-xs uppercase tracking-wider font-extrabold text-sky-400 block mb-1">
              CORE OPERATIONAL VALUES
            </span>
            <h3 className="text-lg font-extrabold text-white leading-snug">
              <span>มาตรฐานความแม่นยำและความปลอดภัย</span>
              <span className="block">ระดับมืออาชีพ</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              ออกแบบเพื่อยกระดับการปฏิบัติงานภาคสนามให้ราบรื่น โปร่งใส และรวดเร็ว
            </p>
          </div>

          {/* 4 Professional Value Cards (Zero Emojis - Lucide Icons) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 w-full lg:w-auto">
            {/* Value 1: Precision Timing */}
            <div className="p-4 rounded-2xl bg-[#0c1e36]/80 hover:bg-[#102746] border border-white/10 hover:border-amber-400/40 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400 mb-2.5 group-hover:scale-105 transition-transform">
                <Zap size={18} />
              </div>
              <span className="text-xs font-bold text-white block">แม่นยำระดับเสี้ยววินาที</span>
              <span className="text-[11px] text-slate-400 font-medium block mt-0.5">High-Precision Timing</span>
            </div>

            {/* Value 2: Automated Verification */}
            <div className="p-4 rounded-2xl bg-[#0c1e36]/80 hover:bg-[#102746] border border-white/10 hover:border-emerald-400/40 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-emerald-400/10 border border-emerald-400/25 flex items-center justify-center text-emerald-400 mb-2.5 group-hover:scale-105 transition-transform">
                <ShieldCheck size={18} />
              </div>
              <span className="text-xs font-bold text-white block">ตรวจสอบอัตโนมัติ</span>
              <span className="text-[11px] text-slate-400 font-medium block mt-0.5">Instant Verification</span>
            </div>

            {/* Value 3: Real-Time Live Sync */}
            <div className="p-4 rounded-2xl bg-[#0c1e36]/80 hover:bg-[#102746] border border-white/10 hover:border-sky-400/40 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-sky-400/10 border border-sky-400/25 flex items-center justify-center text-sky-400 mb-2.5 group-hover:scale-105 transition-transform">
                <BarChart3 size={18} />
              </div>
              <span className="text-xs font-bold text-white block">ซิงก์ข้อมูลเรียลไทม์</span>
              <span className="text-[11px] text-slate-400 font-medium block mt-0.5">Live Synchronization</span>
            </div>

            {/* Value 4: Multi-Device Ready */}
            <div className="p-4 rounded-2xl bg-[#0c1e36]/80 hover:bg-[#102746] border border-white/10 hover:border-sky-400/40 transition-all text-left group">
              <div className="w-9 h-9 rounded-xl bg-sky-400/10 border border-sky-400/25 flex items-center justify-center text-sky-400 mb-2.5 group-hover:scale-105 transition-transform">
                <Smartphone size={18} />
              </div>
              <span className="text-xs font-bold text-white block">รองรับทุกอุปกรณ์</span>
              <span className="text-[11px] text-slate-400 font-medium block mt-0.5">Multi-Device Ready</span>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------
          INTERACTIVE DOCUMENTATION & OPERATIONAL TABS SECTION
         ------------------------------------------------------------- */}
      <section 
        ref={docsSectionRef}
        className="w-full bg-[#071324] text-white py-16 px-4 sm:px-8 border-b border-white/10"
      >
        <div className="max-w-5xl mx-auto space-y-8">
          
          {/* Section Header */}
          <div className="text-center space-y-2.5 max-w-2xl mx-auto">
            <span className="px-3 py-1 rounded-full bg-sky-500/10 text-sky-300 border border-sky-500/30 text-xs font-bold uppercase tracking-wider">
              System Documentation &amp; Guidelines
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold font-heading text-white tracking-tight">
              ศูนย์ข้อมูลและคู่มือการปฏิบัติงานภาคสนาม
            </h2>
            <p className="text-sm text-slate-400">
              คำแนะนำขั้นตอนการทำงานสำหรับเจ้าหน้าที่และนโยบายความปลอดภัยของระบบ
            </p>
          </div>

          {/* Segmented Tabs Navigation (2 Clean Balanced Tabs) */}
          <div className="grid grid-cols-2 gap-2 p-1.5 bg-[#0b1b31] rounded-2xl max-w-md mx-auto border border-white/10">
            <button
              type="button"
              onClick={() => setActiveTab('usage')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'usage' 
                  ? 'bg-gradient-to-r from-sky-600 to-blue-600 text-white border border-sky-400/40 shadow-md' 
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <BookOpen size={16} className={activeTab === 'usage' ? 'text-white' : 'text-slate-400'} />
              <span className="whitespace-nowrap">คู่มือการใช้งาน (Usage)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('terms')}
              className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                activeTab === 'terms' 
                  ? 'bg-gradient-to-r from-sky-600 to-blue-600 text-white border border-sky-400/40 shadow-md' 
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <FileCheck size={16} className={activeTab === 'terms' ? 'text-white' : 'text-slate-400'} />
              <span className="whitespace-nowrap">ข้อกำหนดและเงื่อนไข (Terms)</span>
            </button>
          </div>

          {/* TAB 1: USAGE INSTRUCTIONS */}
          {activeTab === 'usage' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Step 1 */}
                <div className="bg-[#0c1e36]/90 p-6 rounded-2xl border border-white/10 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-md">
                      1
                    </span>
                    <h3 className="text-base font-bold text-white">
                      การลงชื่อเข้าใช้ระบบ (Sign-In &amp; Auth)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed font-thai">
                    ผู้ดูแลระบบใช้ Username และ Password ที่ได้รับมอบหมายเพื่อเข้าสู่ระบบ คอนโซลจะผูก Session ไว้ใน <code className="text-xs bg-[#061120] border border-white/10 px-1.5 py-0.5 rounded text-sky-300">sessionStorage</code> และตรวจสอบสิทธิ์ตามมาตรฐานความปลอดภัยสูงสุด หากปิดเบราว์เซอร์เซสชันจะสิ้นสุดทันที
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-5">
                    <li>ห้ามใช้รหัสผ่านร่วมกันในจุดควบคุมหลายจุด</li>
                    <li>หากพิมพ์รหัสผ่านผิดเกินกำหนด ระบบจะหน่วงเวลาอัตโนมัติ</li>
                  </ul>
                </div>

                {/* Step 2 */}
                <div className="bg-[#0c1e36]/90 p-6 rounded-2xl border border-white/10 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-md">
                      2
                    </span>
                    <h3 className="text-base font-bold text-white">
                      การเปิดรอบแข่งขัน &amp; อัตราต่อรอง (Rounds &amp; Quotes)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed font-thai">
                    ก่อนเริ่มปล่อยบั้งไฟ กรรมการกด <strong className="text-sky-300">"เปิดรอบใหม่ (Open Round)"</strong> พร้อมตั้งเวลาและราคาต่อรอง จากนั้นกด <strong className="text-sky-300">"ปล่อยราคา (Release Quote)"</strong> เพื่อเปิดรับคำสั่งซื้อ และกด <strong className="text-sky-300">"ล็อครอบ (Lock Round)"</strong> ทันทีที่บั้งไฟถูกจุดขึ้นสู่อากาศ
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-5">
                    <li>คำสั่งซื้อประเภท Hold จะถูกปล่อยพร้อมกันเมื่อเปิดราคา</li>
                    <li>สถานะรอบบนกระดานแสดงผลจะอัปเดตแบบเรียลไทม์</li>
                  </ul>
                </div>

                {/* Step 3 */}
                <div className="bg-[#0c1e36]/90 p-6 rounded-2xl border border-white/10 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-md">
                      3
                    </span>
                    <h3 className="text-base font-bold text-white">
                      ตรวจสลิปเงินโอน 1:1 (Automated Verification)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed font-thai">
                    เมื่อผู้เล่นส่งรูปสลิป ระบบจะทำการอ่านรหัสสลิป ถอดรหัสตรวจสอบยอดเงินและเลข Ref Code ทันที หากผ่านเงื่อนไข ระบบจะเพิ่มเครดิต 1:1 และส่งบัตรยืนยันให้ผู้เล่นในเสี้ยววินาที
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-5">
                    <li>สลิปที่ไม่มี QR หรือภาพไม่ชัด จะถูกส่งเข้าคิวให้แอดมินอนุมัติมือ</li>
                    <li>ระบบป้องกันสลิปซ้ำซ้อน 100% ด้วยการจดจำเลขอ้างอิงถาวร</li>
                  </ul>
                </div>

                {/* Step 4 */}
                <div className="bg-[#0c1e36]/90 p-6 rounded-2xl border border-white/10 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold flex items-center justify-center text-sm shadow-md">
                      4
                    </span>
                    <h3 className="text-base font-bold text-white">
                      การจับเวลา &amp; ออกผลการแข่งขัน (Flight Settlement)
                    </h3>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed font-thai">
                    ใช้หน้าปัด Telemetry Simulator จับเวลาการลอยตัวของบั้งไฟ เมื่อตกถึงพื้น กรรมการป้อนเวลาเป็นวินาที (เช่น 125.40s) ระบบจะคำนวณผลชนะตามกลุ่มเวลา (สูง / ต่ำ / เสมอ) และปรับยอดชนะเข้ากระเป๋าผู้เล่นอัตโนมัติ
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1.5 list-disc pl-5">
                    <li>กรณีบั้งไฟแตกหรือโมฆะ ให้ใช้ปุ่ม "ยกเลิกรอบ (Void Round)"</li>
                    <li>ระบบจะคืนเครดิตแบบ Idempotent ป้องกันการคืนเงินซ้ำ</li>
                  </ul>
                </div>
              </div>

              {/* Quick Field Tip Box (Zero Emojis - Lucide Lightbulb) */}
              <div className="p-4 bg-[#0a1e38]/80 border border-sky-500/30 rounded-xl flex items-start gap-3">
                <Lightbulb size={20} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="text-xs text-sky-100">
                  <strong className="block text-sky-300 font-bold mb-0.5">ข้อแนะนำภาคสนาม (Field Pro-Tip):</strong>
                  กรรมการควรเปิดหน้านี้บนแท็บเล็ตหรือโน้ตบุ๊กที่มีการเชื่อมต่ออินเทอร์เน็ตเสถียร หากแอดมินออกจากระบบ ให้กดปุ่ม <strong>"เข้าสู่ระบบ (Sign In)"</strong> ด้านบนเพื่อกรอกรหัสผ่านใหม่อีกครั้งโดยไม่ต้องรีเฟรชหน้าเว็บ
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TERMS OF USE & SECURITY */}
          {activeTab === 'terms' && (
            <div className="space-y-6 animate-fadeIn">
              <div className="bg-[#0c1e36]/90 p-6 sm:p-8 rounded-2xl border border-white/10 space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-white mb-1">
                    ข้อกำหนดความปลอดภัยและการใช้งานระบบ (Enterprise Compliance &amp; Terms)
                  </h3>
                  <p className="text-xs text-slate-400">
                    มีผลบังคับใช้สำหรับเจ้าหน้าที่ผู้ดูแลระบบ, ผู้บันทึกเวลา และกรรมการภาคสนามทุกคน
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Term 1 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-300 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 text-[11px] flex items-center justify-center font-bold">1</span>
                      การรักษาความลับของบัญชีผู้ดูแล (Credential Confidentiality)
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed font-thai">
                      ผู้ดูแลระบบต้องเก็บรักษา Username, Password และรหัสผ่าน Admin Key เป็นความลับสูงสุด ห้ามส่งต่อหรือบันทึกในอุปกรณ์สาธารณะ หากสงสัยว่ารหัสผ่านรั่วไหล ต้องติดต่อผู้ดูแลระบบส่วนกลางเพื่อรีเซ็ตรหัสผ่านทันที
                    </p>
                  </div>

                  {/* Term 2 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-300 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 text-[11px] flex items-center justify-center font-bold">2</span>
                      นโยบายป้องกันสลิปซ้ำซ้อน (Anti-Fraud Slip Quarantine)
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed font-thai">
                      สลิปทุกใบที่ผ่านการเคลมเครดิตจะถูกบันทึกรหัสอ้างอิง (Ref Code) ลงในระบบถาวร หากมีการส่งซ้ำหรือตรวจพบการดัดแปลงภาพ ระบบจะปฏิเสธการเติมเงินและขึ้นบันทึกเตือนในหน้าตรวจสอบสลิปของแอดมินทันที
                    </p>
                  </div>

                  {/* Term 3 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-300 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 text-[11px] flex items-center justify-center font-bold">3</span>
                      การบันทึกประวัติการกระทำ (Audit Trail Logging)
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed font-thai">
                      ทุกการกระทำของผู้ดูแลระบบ ได้แก่ การเปิด/ปิดรอบ, การตั้งราคาต่อรอง, การปรับยอดเงินผู้เล่น และการอนุมัติสลิปมือ จะถูกบันทึกประวัติพร้อม Timestamp และ Admin Identifier เพื่อความโปร่งใสและตรวจสอบย้อนหลังได้ 100%
                    </p>
                  </div>

                  {/* Term 4 */}
                  <div className="space-y-2">
                    <h4 className="text-sm font-bold text-sky-300 flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 text-[11px] flex items-center justify-center font-bold">4</span>
                      มาตรการคืนเงินสองขั้นตอน (Two-Phase Idempotent Refund)
                    </h4>
                    <p className="text-xs text-slate-300 leading-relaxed font-thai">
                      ในกรณีที่รอบแข่งขันถูกยกเลิก (Void) ระบบจะเปลี่ยนสถานะออเดอร์เป็น <code className="text-xs bg-[#061120] border border-white/10 px-1.5 py-0.5 rounded text-amber-300">refunding</code> ก่อนคืนเครดิต เมื่อยอดเงินผู้เล่นอัปเดตเรียบร้อยจึงเปลี่ยนเป็น <code className="text-xs bg-[#061120] border border-white/10 px-1.5 py-0.5 rounded text-slate-300">cancelled</code> ป้องกันการคืนเงินซ้ำซ้อนแม้อินเทอร์เน็ตขัดข้อง
                    </p>
                  </div>
                </div>

                <div className="p-3.5 bg-[#061120] border border-sky-500/30 rounded-xl text-xs text-slate-300 flex items-center gap-2">
                  <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
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
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-95 text-white text-xs sm:text-sm font-bold tracking-wide transition-all cursor-pointer shadow-lg shadow-sky-500/20 whitespace-nowrap border border-sky-300/40"
            >
              <LogIn size={15} />
              <span>กลับไปที่แบบฟอร์มเข้าสู่ระบบ (Sign In)</span>
            </button>
          </div>

        </div>
      </section>

      {/* -------------------------------------------------------------
          FOOTER (Corporate Navy #050e1a with Sky Blue Accents)
         ------------------------------------------------------------- */}
      <footer className="w-full bg-[#050e1a] text-slate-400 py-8 px-4 sm:px-8 border-t border-white/10 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3 text-center md:text-left">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 flex items-center justify-center text-white shrink-0 shadow-md">
              <Rocket size={18} className="transform -rotate-45" />
            </div>
            <div>
              <span className="text-sm font-bold text-white uppercase block">
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
              onClick={() => handleNavClick('usage')} 
              className="hover:text-sky-300 transition-colors cursor-pointer whitespace-nowrap"
            >
              คู่มือการใช้งาน
            </button>
            <span className="text-white/20">&bull;</span>
            <button 
              type="button" 
              onClick={() => handleNavClick('terms')} 
              className="hover:text-sky-300 transition-colors cursor-pointer whitespace-nowrap"
            >
              ข้อกำหนดและเงื่อนไข
            </button>
          </div>

          <div className="text-xs text-slate-500 text-center md:text-right">
            <span>&copy; {new Date().getFullYear()} Bang Fai Commander. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
