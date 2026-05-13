
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { User, AttendanceRecord } from '../types';
import { storage } from '../services/storageService';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import QRCode from 'qrcode';

interface StudentDashboardProps {
  student: User;
}

type ScanStatus = 'idle' | 'initializing' | 'scanning' | 'processing' | 'success' | 'expired' | 'denied' | 'invalid' | 'error';

const StudentDashboard: React.FC<StudentDashboardProps> = ({ student }) => {
  const [activeTab, setActiveTab] = useState<'home' | 'scan' | 'id'>('home');
  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [feedback, setFeedback] = useState('');
  const [proofQrData, setProofQrData] = useState<string | null>(null);
  const [identityQr, setIdentityQr] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<{ 
    subject: string; 
    staff: string; 
    date: string;
    timestamp: number;
    receiptId: string;
    periodId: string;
  } | null>(null);
  const [hasFlash, setHasFlash] = useState(false);
  const [isFlashOn, setIsFlashOn] = useState(false);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isProcessingScan = useRef(false);
  const lastScannedRef = useRef<string | null>(null);

  const refreshHistory = useCallback(() => {
    const all = storage.getAttendance();
    const myHistory = all.filter(r => r.studentId === student.id)
      .sort((a, b) => b.timestamp - a.timestamp);
    setHistory(myHistory);
  }, [student.id]);

  useEffect(() => {
    refreshHistory();
    const payload = JSON.stringify({
      type: 'ST_IDENTITY',
      sid: student.id,
      nm: student.fullName,
      adm: student.admissionNumber || 'N/A',
      hw: storage.getDeviceFingerprint()
    });
    
    // Generate Identity QR
    QRCode.toDataURL(payload, { 
      width: 512, 
      margin: 2, 
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M' // Optimized for scanning
    }).then(setIdentityQr);

    const sync = () => refreshHistory();
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('storage', sync);
      stopScanner();
    };
  }, [refreshHistory, student]);

  const metrics = useMemo(() => {
    const last7Days = history.filter(h => h.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000).length;
    const target = 10;
    const percentage = Math.min(Math.round((last7Days / target) * 100), 100);
    return { last7Days, percentage, total: history.length };
  }, [history]);

  const stopScanner = async () => {
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        scannerRef.current = null;
        setIsFlashOn(false);
        lastScannedRef.current = null;
      } catch (e) {
        console.warn("Scanner shutdown warning:", e);
        scannerRef.current = null;
      }
    }
  };

  const toggleFlash = async () => {
    if (!scannerRef.current || !hasFlash) return;
    try {
      const newState = !isFlashOn;
      await scannerRef.current.applyVideoConstraints({
        advanced: [{ torch: newState } as any]
      });
      setIsFlashOn(newState);
    } catch (e) {
      console.warn("Flash toggle failed", e);
      setHasFlash(false);
    }
  };

  const startScanner = async () => {
    if (isProcessingScan.current) return;
    setScanStatus('initializing');
    setFeedback('Starting camera...');
    setActiveTab('scan');
    
    await stopScanner();

    setTimeout(async () => {
      const container = document.getElementById("student-reader");
      if (!container) {
         setScanStatus('error');
         setFeedback('Camera Interface Error. Please retry.');
         return;
      }

      try {
        const scanner = new Html5Qrcode("student-reader", {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false
        });
        scannerRef.current = scanner;
        
        const config = { 
          fps: 20,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const boxSize = Math.max(220, Math.floor(minEdge * 0.75));
            return { width: boxSize, height: boxSize };
          },
          videoConstraints: {
            facingMode: "environment"
          }
        };

        await scanner.start(
          { facingMode: "environment" },
          config,
          (text) => {
            if (!isProcessingScan.current && text !== lastScannedRef.current) {
              handleScan(text);
            }
          },
          () => {} 
        );
        
        setHasFlash(true);
        setScanStatus('scanning');
        setFeedback('Scanning for Session QR...');
      } catch (err: any) {
        console.error("Camera Link Error:", err);
        setScanStatus('error');
        setFeedback('Error: Camera not accessible.');
      }
    }, 600); // Increased timeout for stability
  };

  const handleScan = async (payloadStr: string) => {
    if (isProcessingScan.current) return;
    
    try {
      isProcessingScan.current = true;
      setScanStatus('processing');
      setFeedback('Verifying...');

      let data;
      try {
        data = JSON.parse(payloadStr);
      } catch (e) {
        throw new Error('INVALID_DATA');
      }

      if (data.type !== 'ST_SESSION') {
        throw new Error('INVALID_TYPE');
      }

      lastScannedRef.current = payloadStr;

      // 1. Expiry Check (Strict enforcement)
      if (Date.now() > data.exp) { 
        if (window.navigator?.vibrate) window.navigator.vibrate([50, 50]);
        await stopScanner();
        setScanStatus('expired');
        setFeedback('Session has expired.');
        isProcessingScan.current = false;
        return;
      }

      // 2. Enrollment Check
      const allGroups = storage.getGroups();
      const targetGroup = allGroups.find(g => g.id === data.gid);
      
      if (data.gid && data.gid !== 'GEN') {
        if (!targetGroup || !targetGroup.studentIds.includes(student.id)) {
           if (window.navigator?.vibrate) window.navigator.vibrate([100, 50, 100]);
           await stopScanner();
           setScanStatus('denied');
           setFeedback('Access denied: You are not in this class.');
           isProcessingScan.current = false;
           return;
        }
      }

      // Success Handshake
      if (window.navigator?.vibrate) window.navigator.vibrate([40, 20, 40]);
      await stopScanner();

      const all = storage.getAttendance();
      const alreadyMarked = all.some(r => r.studentId === student.id && r.periodId === data.id);
      const receiptId = `ST-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      if (!alreadyMarked) {
        const newRecord: AttendanceRecord = {
          id: storage.generateId(),
          periodId: data.id,
          studentId: student.id,
          studentName: student.fullName,
          admissionNumber: student.admissionNumber || 'N/A',
          timestamp: Date.now(),
          subject: data.sub,
          staffName: data.stf,
          date: data.dat
        };
        storage.saveAttendance([...all, newRecord]);
        window.dispatchEvent(new Event('storage'));
      }

      const proof = JSON.stringify({ 
        type: 'ST_PROOF', 
        sid: student.id, 
        pid: data.id, 
        nm: student.fullName, 
        rid: receiptId,
        ts: Date.now() 
      });
      
      const proofUrl = await QRCode.toDataURL(proof, { 
        width: 600, 
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'H'
      });
      
      setProofQrData(proofUrl);
      setSessionInfo({ 
        subject: data.sub, 
        staff: data.stf, 
        date: data.dat, 
        timestamp: Date.now(),
        receiptId,
        periodId: data.id
      });
      
      setScanStatus('success');
      setFeedback('Attendance Marked Successfully.');
      refreshHistory();
    } catch (e: any) {
      console.warn("Scan fault:", e.message);
      if (e.message === 'INVALID_DATA' || e.message === 'INVALID_TYPE') {
        // Ignore invalid QRs silently, just stay scanning
        setScanStatus('scanning');
        setFeedback('Searching for valid QR...');
        isProcessingScan.current = false;
        lastScannedRef.current = null; // Allow rescan
      } else {
        setScanStatus('error');
        setFeedback('Scanning Error.');
        isProcessingScan.current = false;
      }
    }
  };

  const handleDownloadReceipt = (infoOverride?: any) => {
    const info = infoOverride || sessionInfo;
    if (!info) return;

    const timestampStr = new Date(info.timestamp).toLocaleString();
    const hwProfile = storage.getDeviceFingerprint();
    const verificationHash = btoa(`${info.receiptId}-${student.id}`).slice(0, 16);

    const content = `
==================================================
              ATTENDANCE RECEIPT
==================================================
STATUS: VERIFIED
DATE: ${info.date}
TIME: ${new Date(info.timestamp).toLocaleTimeString()}
RECEIPT ID: ${info.receiptId || 'ST-VERIFIED'}

--------------------------------------------------
STUDENT DETAILS:
--------------------------------------------------
  NAME: ${student.fullName}
  ID/ADM: ${student.admissionNumber}
  BRANCH: ${student.course || 'GENERAL'}
  DEVICE ID: ${hwProfile}

--------------------------------------------------
SESSION DETAILS:
--------------------------------------------------
  SUBJECT: ${info.subject}
  FACULTY: ${info.staff || info.staffName}
  PERIOD_ID: ${info.periodId}

--------------------------------------------------
VERIFICATION:
--------------------------------------------------
  PROTOCOL: SECURE_QR_V2.5
  HASH: ${verificationHash}
  TIMESTAMP: ${timestampStr}

==================================================
      OFFICIAL ATTENDANCE RECORD
==================================================
    `.trim();

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ST_Receipt_${info.receiptId || 'Attendance'}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const reset = async () => {
    await stopScanner();
    setScanStatus('idle');
    setProofQrData(null);
    setActiveTab('home');
    isProcessingScan.current = false;
    lastScannedRef.current = null;
  };

  const statusTheme = useMemo(() => {
    switch (scanStatus) {
      case 'initializing': return { color: 'text-indigo-400', bg: 'bg-indigo-500/10' };
      case 'scanning': return { color: 'text-indigo-500', bg: 'bg-indigo-500/10' };
      case 'processing': return { color: 'text-amber-400', bg: 'bg-amber-400/10' };
      case 'success': return { color: 'text-emerald-500', bg: 'bg-emerald-500/10' };
      case 'expired': return { color: 'text-orange-500', bg: 'bg-orange-500/10' };
      case 'denied': return { color: 'text-rose-500', bg: 'bg-rose-500/10' };
      case 'invalid': return { color: 'text-rose-400', bg: 'bg-rose-400/10' };
      default: return { color: 'text-gray-400', bg: 'bg-gray-400/10' };
    }
  }, [scanStatus]);

  return (
    <div className="max-w-2xl mx-auto space-y-8 pb-32">
      {activeTab === 'home' && (
        <div className="space-y-6 page-transition">
          <div className="bg-white p-8 rounded-[2.5rem] border border-gray-100 shadow-sm overflow-hidden relative group">
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110"></div>
            <div className="relative z-10">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-3xl font-black text-gray-900 tracking-tight">Student Portal</h2>
                  <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mt-1">{student.admissionNumber} &bull; ACCOUNT ACTIVE</p>
                </div>
                <div className="bg-emerald-50 text-emerald-600 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border border-emerald-100 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                  Device Verified
                </div>
              </div>
              
              <div className="mt-10 flex items-center gap-8">
                <div className="relative w-24 h-24">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="48" cy="48" r="40" fill="transparent" stroke="#f1f5f9" strokeWidth="8" />
                    <circle cx="48" cy="48" r="40" fill="transparent" stroke="#4f46e5" strokeWidth="8" strokeDasharray="251.2" strokeDashoffset={251.2 - (251.2 * metrics.percentage / 100)} strokeLinecap="round" className="transition-all duration-1000 ease-out" />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xl font-black text-indigo-600 leading-none">{metrics.percentage}%</span>
                  </div>
                </div>
                <div>
                   <p className="text-sm font-black text-gray-800 tracking-tight">Attendance Rate</p>
                   <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">{metrics.last7Days} sessions confirmed this week</p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-indigo-600 p-6 rounded-[2.5rem] shadow-xl shadow-indigo-100 flex items-center justify-between text-white group cursor-pointer active:scale-95 transition-all" onClick={() => setActiveTab('id')}>
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md border border-white/10">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                 </svg>
              </div>
              <div>
                <h4 className="text-lg font-black tracking-tight leading-none">Digital ID</h4>
                <p className="text-[10px] font-bold text-indigo-200 uppercase tracking-widest mt-1">My ID Card</p>
              </div>
            </div>
            <div className="bg-white/20 p-3 rounded-xl"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" /></svg></div>
          </div>

          <div className="flex items-center justify-between px-2">
             <h3 className="text-xs font-black text-gray-900 uppercase tracking-widest">Recent Attendance</h3>
          </div>

          <div className="space-y-4">
            {history.slice(0, 10).map(record => (
              <div key={record.id} className="bg-white p-5 rounded-3xl border border-gray-100 flex items-center justify-between hover:border-indigo-100 hover:shadow-lg transition-all ripple group/item">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <div>
                    <p className="text-sm font-black text-gray-900 leading-none mb-1.5">{record.subject}</p>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest leading-none">{record.date} &bull; {record.staffName}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                   <div className="text-right hidden sm:block">
                      <p className="text-xs font-black text-gray-900 tabular-nums">{new Date(record.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
                   </div>
                   <button 
                     onClick={(e) => { e.stopPropagation(); handleDownloadReceipt(record); }}
                     className="w-10 h-10 rounded-xl bg-gray-50 text-gray-300 flex items-center justify-center hover:bg-emerald-50 hover:text-emerald-600 transition-all border border-transparent hover:border-emerald-100"
                     title="Download Receipt"
                   >
                     <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                   </button>
                </div>
              </div>
            ))}
            {history.length === 0 && (
              <div className="py-16 text-center border-2 border-dashed border-gray-100 rounded-[2.5rem]">
                 <p className="text-gray-300 font-black uppercase tracking-[0.3em] text-[10px]">No attendance history found</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'home' && (
        <button 
          onClick={startScanner}
          className="fixed bottom-24 right-6 md:right-12 w-20 h-20 bg-indigo-600 text-white rounded-[2rem] shadow-2xl shadow-indigo-300 flex items-center justify-center hover:scale-110 active:scale-95 transition-all z-40 group"
        >
          <div className="absolute -inset-3 bg-indigo-600/10 rounded-[2.5rem] animate-ping group-hover:animate-none"></div>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 relative z-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01" /></svg>
        </button>
      )}

      {activeTab === 'id' && (
        <div className="fixed inset-0 bg-slate-900 z-[100] flex flex-col animate-in slide-in-from-bottom-10 duration-500">
           {/* Top Navigation */}
           <div className="p-8 flex justify-between items-center z-20">
              <div>
                 <h2 className="text-3xl font-black text-white uppercase tracking-tighter leading-none">Digital ID</h2>
                 <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mt-2">Official Student Pass</p>
              </div>
              <button onClick={() => setActiveTab('home')} className="w-14 h-14 rounded-2xl bg-white/10 text-white flex items-center justify-center text-3xl font-light hover:bg-white/20 transition-all border border-white/5">
                &times;
              </button>
           </div>
           
           {/* Main Content */}
           <div className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">
              {/* Background Ambient Effects */}
              <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-indigo-500/20 rounded-full blur-[100px]"></div>
              <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-purple-500/20 rounded-full blur-[100px]"></div>

              {/* ID Card Container */}
              <div className="w-full max-w-sm relative group">
                 {/* Holographic Border Effect */}
                 <div className="absolute -inset-[2px] bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-[2.5rem] opacity-70 blur-sm group-hover:opacity-100 transition-opacity duration-500"></div>
                 
                 <div className="relative bg-[#0f172a] rounded-[2.5rem] p-8 h-full flex flex-col items-center overflow-hidden border border-white/10 shadow-2xl">
                    {/* Background Pattern */}
                    <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(63,63,70,0.2)_50%,transparent_75%,transparent_100%)] bg-[length:20px_20px] opacity-10"></div>
                    
                    {/* Card Header */}
                    <div className="w-full flex justify-between items-center mb-8 relative z-10 border-b border-white/5 pb-6">
                       <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/30">
                             <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                          </div>
                          <span className="text-xs font-black text-white uppercase tracking-widest">SmartTrack</span>
                       </div>
                       <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                          <span className="text-[8px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-1.5">
                             <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                             Active
                          </span>
                       </div>
                    </div>

                    {/* Student Info */}
                    <div className="w-24 h-24 p-1 rounded-[2rem] bg-gradient-to-br from-indigo-500 to-purple-500 mb-6 shadow-xl shadow-indigo-500/20 relative z-10">
                       <div className="w-full h-full bg-[#1e293b] rounded-[1.8rem] flex items-center justify-center text-3xl font-black text-white uppercase">
                          {student.fullName.charAt(0)}
                       </div>
                    </div>
                    
                    <h3 className="text-2xl font-black text-white text-center uppercase tracking-tight leading-none mb-2 relative z-10">{student.fullName}</h3>
                    <p className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-8 relative z-10">{student.admissionNumber}</p>

                    {/* QR Section */}
                    <div className="bg-white p-4 rounded-3xl shadow-xl mb-8 relative z-10 group-hover:scale-105 transition-transform duration-300">
                       {identityQr ? (
                         <img src={identityQr} className="w-48 h-48 mix-blend-multiply" alt="Student ID QR" />
                       ) : (
                         <div className="w-48 h-48 flex items-center justify-center text-gray-400 text-xs font-bold">Generatng...</div>
                       )}
                    </div>

                    {/* Footer Info */}
                    <div className="w-full grid grid-cols-2 gap-4 relative z-10">
                       <div className="bg-white/5 p-3 rounded-2xl border border-white/5 text-center">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest mb-1">Course</p>
                          <p className="text-[10px] font-bold text-white uppercase truncate">{student.course || 'N/A'}</p>
                       </div>
                       <div className="bg-white/5 p-3 rounded-2xl border border-white/5 text-center">
                          <p className="text-[8px] font-black text-gray-400 uppercase tracking-widest mb-1">Role</p>
                          <p className="text-[10px] font-bold text-white uppercase">Student</p>
                       </div>
                    </div>

                 </div>
              </div>
              
              <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.2em] mt-8 animate-pulse">
                 This is an official digital document
              </p>
           </div>
        </div>
      )}

      {activeTab === 'scan' && (
        <div className="fixed inset-0 bg-[#010413] z-[100] flex flex-col animate-in fade-in duration-500 overflow-hidden">
           <div className="flex justify-between items-center p-8 sm:p-12 sticky top-0 z-20">
              <div>
                <h2 className="text-white text-2xl font-black tracking-tighter uppercase leading-none">QR Scanner</h2>
                <div className="flex items-center gap-2 mt-3">
                   <div className={`w-2 h-2 rounded-full transition-colors duration-300 ${statusTheme.color.replace('text-', 'bg-')} ${scanStatus === 'scanning' ? 'animate-pulse' : ''}`}></div>
                   <p className={`text-[9px] font-black uppercase tracking-[0.2em] ${statusTheme.color}`}>{feedback}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                 {hasFlash && scanStatus === 'scanning' && (
                    <button 
                      onClick={toggleFlash}
                      className={`w-14 h-14 rounded-2xl flex items-center justify-center border transition-all ${isFlashOn ? 'bg-amber-400 border-amber-400 text-black' : 'bg-white/5 text-white border-white/10'}`}
                    >
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    </button>
                 )}
                 <button onClick={reset} className="w-14 h-14 rounded-2xl bg-white/5 text-white flex items-center justify-center border border-white/10 hover:bg-white/10 transition-all">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                 </button>
              </div>
           </div>

           <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
              {(['initializing', 'scanning', 'processing', 'expired', 'denied', 'invalid'].includes(scanStatus)) && (
                 <div className="relative group w-full max-w-[340px] aspect-square">
                    <div className={`absolute -inset-10 blur-[120px] rounded-full transition-colors duration-700 ${statusTheme.bg.replace('/10', '/30')}`}></div>
                    
                    <div className={`w-full h-full bg-black rounded-[4.5rem] border-[16px] transition-colors duration-500 overflow-hidden shadow-2xl relative ${scanStatus === 'denied' || scanStatus === 'invalid' ? 'border-rose-500/20' : scanStatus === 'expired' ? 'border-orange-500/20' : 'border-white/5'}`}>
                        <div id="student-reader" className={`w-full h-full transition-opacity duration-1000 ${scanStatus === 'initializing' ? 'opacity-0' : 'opacity-100'}`}></div>
                        
                        <div className="absolute inset-0 pointer-events-none z-20 flex items-center justify-center">
                           <div className={`absolute top-12 left-12 w-14 h-14 border-t-[3.5px] border-l-[3.5px] rounded-tl-[2rem] transition-colors duration-500 ${statusTheme.color} opacity-40`}></div>
                           <div className={`absolute top-12 right-12 w-14 h-14 border-t-[3.5px] border-r-[3.5px] rounded-tr-[2rem] transition-colors duration-500 ${statusTheme.color} opacity-40`}></div>
                           <div className={`absolute bottom-12 left-12 w-14 h-14 border-b-[3.5px] border-l-[3.5px] rounded-bl-[2rem] transition-colors duration-500 ${statusTheme.color} opacity-40`}></div>
                           <div className={`absolute bottom-12 right-12 w-14 h-14 border-b-[3.5px] border-r-[3.5px] rounded-br-[2rem] transition-colors duration-500 ${statusTheme.color} opacity-40`}></div>
                           
                           {scanStatus === 'scanning' && <div className="scan-line"></div>}
                           
                           <div className="animate-in zoom-in duration-300">
                             {scanStatus === 'expired' && <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-orange-500 drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                             {(scanStatus === 'denied' || scanStatus === 'invalid') && <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-rose-500 drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
                             {scanStatus === 'processing' && <div className="w-16 h-16 border-4 border-amber-400/20 border-t-amber-400 rounded-full animate-spin"></div>}
                           </div>
                        </div>

                        {scanStatus === 'initializing' && (
                           <div className="absolute inset-0 flex items-center justify-center bg-[#020617]">
                              <div className="w-16 h-16 border-[4px] border-indigo-500/10 border-t-indigo-500 rounded-full animate-spin"></div>
                           </div>
                        )}
                    </div>
                 </div>
              )}

              {scanStatus === 'success' && sessionInfo && (
                <div className="w-full max-w-sm py-12 animate-in slide-in-from-bottom-8 duration-700 ease-out overflow-y-auto max-h-full no-scrollbar">
                   <div className="text-center mb-10">
                      <div className="w-20 h-20 bg-emerald-500 rounded-[2.5rem] flex items-center justify-center mx-auto mb-6 shadow-2xl animate-in zoom-in duration-500">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>
                      </div>
                      <h3 className="text-white text-3xl font-black uppercase tracking-tighter leading-none mb-2">Attendance Marked</h3>
                      <p className="text-emerald-400 text-[9px] font-black uppercase tracking-[0.4em] opacity-80">Verified</p>
                   </div>

                   <div className="bg-white rounded-[2.5rem] shadow-2xl overflow-hidden border border-white/20 mb-8">
                      <div className="bg-indigo-600 p-6 flex justify-between items-center">
                         <div>
                            <p className="text-white/40 text-[8px] font-black uppercase tracking-widest mb-1">Receipt ID</p>
                            <p className="text-white text-xs font-black tracking-widest">{sessionInfo.receiptId}</p>
                         </div>
                         <div className="bg-white/20 px-3 py-1.5 rounded-xl flex items-center gap-2">
                            <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></div>
                            <span className="text-[8px] font-black text-white uppercase tracking-widest">Success</span>
                         </div>
                      </div>

                      <div className="p-8 space-y-8">
                         <div>
                            <p className="text-gray-300 text-[8px] font-black uppercase tracking-widest mb-2">Subject</p>
                            <h4 className="text-2xl font-black text-gray-900 uppercase tracking-tight leading-none">{sessionInfo.subject}</h4>
                         </div>
                         <div className="grid grid-cols-2 gap-8">
                            <div>
                               <p className="text-gray-300 text-[8px] font-black uppercase tracking-widest mb-2">Date</p>
                               <p className="text-sm font-black text-gray-800 uppercase leading-none">{sessionInfo.date}</p>
                            </div>
                            <div>
                               <p className="text-gray-300 text-[8px] font-black uppercase tracking-widest mb-2">Time</p>
                               <p className="text-sm font-black text-gray-800 tabular-nums leading-none">
                                  {new Date(sessionInfo.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                               </p>
                            </div>
                         </div>
                         <div className="pt-8 border-t border-dashed border-gray-100 flex items-center justify-between gap-4">
                            <div className="flex-1">
                               <p className="text-gray-300 text-[8px] font-black uppercase tracking-widest mb-2">Faculty</p>
                               <p className="text-sm font-black text-gray-800 uppercase leading-none">{sessionInfo.staff}</p>
                            </div>
                            <div className="relative group p-2 bg-gray-50 rounded-2xl border border-gray-100">
                               {proofQrData && <img src={proofQrData} className="w-16 h-16" alt="Proof" />}
                            </div>
                         </div>
                      </div>
                   </div>

                   <div className="flex flex-col gap-4">
                      <button 
                        onClick={() => handleDownloadReceipt()}
                        className="w-full bg-emerald-600 text-white py-6 rounded-[2.5rem] font-black uppercase tracking-[0.2em] text-[10px] hover:scale-105 active:scale-95 transition-all shadow-xl flex items-center justify-center gap-3 animate-pulse"
                      >
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                         Download Digital Receipt
                      </button>
                      
                      <button 
                        onClick={reset} 
                        className="w-full bg-white text-gray-950 py-6 rounded-[2.5rem] font-black uppercase tracking-[0.2em] text-[10px] hover:scale-105 active:scale-95 transition-all shadow-2xl"
                      >
                        Return to Dashboard
                      </button>
                   </div>
                </div>
              )}

              {scanStatus === 'error' && (
                <div className="text-center animate-in zoom-in-95 duration-500 mt-10">
                   <div className="w-24 h-24 bg-rose-500/10 text-rose-500 rounded-[3rem] flex items-center justify-center mx-auto mb-8 border border-rose-500/20">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                   </div>
                   <p className="text-white font-black uppercase tracking-[0.3em] text-lg mb-3 leading-relaxed max-w-[300px] mx-auto">{feedback}</p>
                   <button onClick={startScanner} className="bg-indigo-600 text-white px-12 py-6 rounded-[2.5rem] font-black uppercase tracking-widest text-[11px] hover:bg-indigo-500 transition-colors shadow-2xl">Re-establish Link</button>
                </div>
              )}
           </div>
        </div>
      )}
    </div>
  );
};

export default StudentDashboard;
