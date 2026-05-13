
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { User, Period, AttendanceRecord, ClassGroup, UserRole } from '../types';
import { storage } from '../services/storageService';
import { Html5Qrcode } from 'html5-qrcode';
import QRCode from 'qrcode';

interface StaffDashboardProps {
  staff: User;
}

interface ConfirmState {
  type: 'REMOVE' | 'BULK_REMOVE' | null;
  id?: string;
  name?: string;
  count?: number;
}

const ACTIVE_SESSION_KEY = 'smart_track_active_session_id';

const StaffDashboard: React.FC<StaffDashboardProps> = ({ staff }) => {
  const [activeTab, setActiveTab] = useState<'terminal' | 'classrooms' | 'archive'>('terminal');
  const [groups, setGroups] = useState<ClassGroup[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [activeQr, setActiveQr] = useState<Period | null>(null);
  const [liveAttendance, setLiveAttendance] = useState<AttendanceRecord[]>([]);
  
  // Ref for activeQr to avoid stale closures in scanner callbacks
  const activeQrRef = useRef<Period | null>(null);
  // Ref for managing group ID to avoid stale closures in enrollment scanner
  const managingGroupIdRef = useRef<string | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [timeLeft, setTimeLeft] = useState(0);
  
  // QR Rotation State
  const [qrRotationIndex, setQrRotationIndex] = useState(0);

  const [qrSize, setQrSize] = useState<number>(600);
  const [qrErrorLevel, setQrErrorLevel] = useState<'L' | 'M' | 'Q' | 'H'>('M'); 
  
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [renamingGroup, setRenamingGroup] = useState<ClassGroup | null>(null);
  const [managingGroup, setManagingGroup] = useState<ClassGroup | null>(null);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [enrollStatus, setEnrollStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [enrollMsg, setEnrollMsg] = useState('');
  const [enrollBatchLog, setEnrollBatchLog] = useState<{name: string, status: 'success' | 'error', id: string, time: string}[]>([]);
  const [lastScannedName, setLastScannedName] = useState<string | null>(null);

  // Manual Override States (Session)
  const [isManualAdding, setIsManualAdding] = useState(false);
  const [manualOverrideLog, setManualOverrideLog] = useState<{id: string, action: 'ADD' | 'REMOVE', studentName: string, time: string}[]>([]);
  const [selectedManualStudents, setSelectedManualStudents] = useState<Set<string>>(new Set());

  // Attendance Management States
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedForRemoval, setSelectedForRemoval] = useState<Set<string>>(new Set());
  const [confirmState, setConfirmState] = useState<ConfirmState>({ type: null });

  // Manual Override States (Groups)
  const [isManualGroupAdding, setIsManualGroupAdding] = useState(false);
  const [selectedGroupStudents, setSelectedGroupStudents] = useState<Set<string>>(new Set());

  // Attendance Scanning State
  const [isScanningAttendance, setIsScanningAttendance] = useState(false);
  const [scanResult, setScanResult] = useState<{status: 'success'|'error'|'info', message: string} | null>(null);

  const [sessionSubject, setSessionSubject] = useState(staff.subject || '');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [newGroupName, setNewGroupName] = useState('');

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Update refs
  useEffect(() => {
    activeQrRef.current = activeQr;
  }, [activeQr]);

  useEffect(() => {
    managingGroupIdRef.current = managingGroup?.id || null;
  }, [managingGroup]);

  // Initialize Audio Context lazily
  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContext) audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  };

  const playTone = (freq: number, type: OscillatorType, duration: number) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      console.error("Audio warning error", e);
    }
  };

  const refreshData = useCallback(() => {
    const allGroups = storage.getGroups().filter(g => g.staffId === staff.id);
    const allPeriods = storage.getPeriods().filter(p => p.staffId === staff.id);
    const users = storage.getUsers();
    
    setGroups(allGroups);
    setPeriods(allPeriods.sort((a, b) => b.createdAt - a.createdAt));
    setAllUsers(users);

    const activeId = localStorage.getItem(ACTIVE_SESSION_KEY);
    const session = allPeriods.find(p => p.id === activeId && p.expiresAt > Date.now());

    if (session) {
      setActiveQr(session);
      const attendance = storage.getAttendance()
        .filter(a => a.periodId === session.id)
        .sort((a, b) => b.timestamp - a.timestamp);
      setLiveAttendance(attendance);
    } else {
      setActiveQr(null);
      setQrDataUrl('');
      setLiveAttendance([]);
      setIsManageMode(false);
      setSelectedForRemoval(new Set());
    }
  }, [staff.id]);

  useEffect(() => {
    if (!activeQr) return;
    const interval = setInterval(() => {
      setQrRotationIndex(prev => prev + 1);
    }, 10000); 
    return () => clearInterval(interval);
  }, [activeQr]);

  useEffect(() => {
    if (activeQr) {
      const frameExpiry = Math.min(activeQr.expiresAt, Date.now() + 15000);
      const payload = JSON.stringify({ 
        type: 'ST_SESSION', 
        id: activeQr.id, 
        sub: activeQr.subject, 
        exp: frameExpiry, 
        stf: staff.fullName, 
        dat: activeQr.date, 
        gid: activeQr.groupId, 
        ts: Date.now() 
      });
      QRCode.toDataURL(payload, { 
        width: qrSize, 
        margin: 2, 
        errorCorrectionLevel: qrErrorLevel 
      }).then(setQrDataUrl);
    }
  }, [activeQr, qrSize, qrErrorLevel, staff.fullName, qrRotationIndex]);

  useEffect(() => {
    refreshData();
    const sync = () => refreshData();
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [refreshData]);

  useEffect(() => {
    let timer: any;
    if (activeQr) {
      timer = setInterval(() => {
        const remaining = Math.max(0, Math.floor((activeQr.expiresAt - Date.now()) / 1000));
        if (remaining === 60) playTone(440, 'sine', 0.5);
        if (remaining === 30) playTone(550, 'sine', 0.5); 
        if (remaining <= 10 && remaining > 0) playTone(880, 'square', 0.2);
        
        setTimeLeft(remaining);
        if (remaining <= 0) { 
            localStorage.removeItem(ACTIVE_SESSION_KEY); 
            refreshData(); 
        }
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [activeQr, refreshData]);

  // --- Session Manual Add Logic ---
  const eligibleForManualAdd = useMemo(() => {
    if (!activeQr) return [];
    let candidates = allUsers.filter(u => u.role === UserRole.STUDENT);
    if (activeQr.groupId !== 'GEN') {
      const targetGroup = groups.find(g => g.id === activeQr.groupId);
      if (targetGroup) {
        candidates = candidates.filter(u => targetGroup.studentIds.includes(u.id));
      }
    }
    const presentIds = new Set(liveAttendance.map(a => a.studentId));
    return candidates.filter(u => !presentIds.has(u.id));
  }, [activeQr, allUsers, liveAttendance, groups]);

  const toggleManualStudent = (studentId: string) => {
    setSelectedManualStudents(prev => {
      const next = new Set(prev);
      next.has(studentId) ? next.delete(studentId) : next.add(studentId);
      return next;
    });
  };

  const toggleSelectAllManual = () => {
    if (selectedManualStudents.size === eligibleForManualAdd.length) {
      setSelectedManualStudents(new Set());
    } else {
      setSelectedManualStudents(new Set(eligibleForManualAdd.map(s => s.id)));
    }
  };

  const handleBulkManualAdd = () => {
    if (!activeQr || selectedManualStudents.size === 0) return;
    const newRecords: AttendanceRecord[] = [];
    const logEntries: any[] = [];
    const timestamp = Date.now();
    const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});

    eligibleForManualAdd.forEach(student => {
      if (selectedManualStudents.has(student.id)) {
        newRecords.push({
          id: storage.generateId(),
          periodId: activeQr.id,
          studentId: student.id,
          studentName: student.fullName,
          admissionNumber: student.admissionNumber || 'N/A',
          timestamp: timestamp,
          subject: activeQr.subject,
          staffName: staff.fullName,
          date: activeQr.date
        });
        logEntries.push({ id: storage.generateId(), action: 'ADD', studentName: student.fullName, time: timeStr });
      }
    });

    const all = storage.getAttendance();
    storage.saveAttendance([...all, ...newRecords]);
    setManualOverrideLog(prev => [...logEntries, ...prev]);
    setSelectedManualStudents(new Set());
    setIsManualAdding(false);
    window.dispatchEvent(new Event('storage'));
    refreshData();
  };

  const handleManualRemove = (attendanceId: string, studentName: string) => {
    setConfirmState({ type: 'REMOVE', id: attendanceId, name: studentName });
  };

  const executeRemove = () => {
    if (!confirmState.id) return;
    const all = storage.getAttendance();
    storage.saveAttendance(all.filter(a => a.id !== confirmState.id));
    
    setManualOverrideLog(prev => [{
      id: storage.generateId(), 
      action: 'REMOVE', 
      studentName: confirmState.name || 'Student', 
      time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})
    }, ...prev]);

    window.dispatchEvent(new Event('storage'));
    refreshData();
    setConfirmState({ type: null });
  };

  // --- Bulk Remove Logic ---
  const toggleRemovalSelection = (id: string) => {
    const next = new Set(selectedForRemoval);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedForRemoval(next);
  };

  const handleBulkRemove = () => {
    if (selectedForRemoval.size === 0) return;
    setConfirmState({ type: 'BULK_REMOVE', count: selectedForRemoval.size });
  };

  const executeBulkRemove = () => {
    const all = storage.getAttendance();
    const newAttendance = all.filter(a => !selectedForRemoval.has(a.id));
    storage.saveAttendance(newAttendance);
    
    // Log
    const newLogs = Array.from(selectedForRemoval).map(id => {
        const record = all.find(a => a.id === id);
        return {
            id: storage.generateId(),
            action: 'REMOVE' as 'REMOVE',
            studentName: record?.studentName || 'Unknown',
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})
        };
    });
    setManualOverrideLog(prev => [...newLogs, ...prev]);
    
    setSelectedForRemoval(new Set());
    setIsManageMode(false);
    window.dispatchEvent(new Event('storage'));
    refreshData();
    setConfirmState({ type: null });
  };

  // --- Group Manual Add Logic ---
  const eligibleForGroupAdd = useMemo(() => {
    if (!managingGroup) return [];
    return allUsers.filter(u => u.role === UserRole.STUDENT && !managingGroup.studentIds.includes(u.id));
  }, [managingGroup, allUsers]);

  const toggleGroupStudent = (studentId: string) => {
    setSelectedGroupStudents(prev => {
      const next = new Set(prev);
      next.has(studentId) ? next.delete(studentId) : next.add(studentId);
      return next;
    });
  };

  const toggleSelectAllGroup = () => {
    if (selectedGroupStudents.size === eligibleForGroupAdd.length) {
      setSelectedGroupStudents(new Set());
    } else {
      setSelectedGroupStudents(new Set(eligibleForGroupAdd.map(s => s.id)));
    }
  };

  const handleBulkGroupAdd = () => {
    if (!managingGroup || selectedGroupStudents.size === 0) return;

    const updatedStudentIds = [...managingGroup.studentIds];
    const newLogEntries: any[] = [];
    const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});

    eligibleForGroupAdd.forEach(student => {
      if (selectedGroupStudents.has(student.id)) {
        updatedStudentIds.push(student.id);
        newLogEntries.push({
          name: student.fullName, 
          status: 'success', 
          id: storage.generateId(), 
          time: timeStr
        });
      }
    });

    const updatedGroup = { ...managingGroup, studentIds: updatedStudentIds };
    const allGroups = storage.getGroups();
    storage.saveGroups(allGroups.map(g => g.id === updatedGroup.id ? updatedGroup : g));
    
    setManagingGroup(updatedGroup);
    setEnrollBatchLog(prev => [...newLogEntries, ...prev].slice(0, 20));
    
    setSelectedGroupStudents(new Set());
    setIsManualGroupAdding(false);
    refreshData();
  };

  // --- Scanners ---
  const startEnrollScanner = async () => {
    if (scannerRef.current) await stopScanner();
    setIsEnrolling(true);
    setEnrollStatus('idle');
    setEnrollBatchLog([]);
    processingRef.current = false;
    
    setTimeout(async () => {
      try {
        const scanner = new Html5Qrcode("enroll-reader");
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 20, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.85, height: Math.min(w, h) * 0.85 }), aspectRatio: 1.0 },
          handleEnrollScan,
          () => {}
        );
      } catch (err) { setIsEnrolling(false); }
    }, 500);
  };

  const startAttendanceScanner = async () => {
    if (scannerRef.current) await stopScanner();
    setIsScanningAttendance(true);
    setScanResult(null);
    processingRef.current = false;
    
    setTimeout(async () => {
      try {
        const scanner = new Html5Qrcode("attendance-reader");
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 20, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.7, height: Math.min(w, h) * 0.7 }), aspectRatio: 1.0 },
          handleAttendanceScan,
          () => {}
        );
      } catch (err) { setIsScanningAttendance(false); }
    }, 500);
  };

  const handleAttendanceScan = (payload: string) => {
    const currentActiveQr = activeQrRef.current;
    if (processingRef.current || !currentActiveQr) return;
    try {
      const data = JSON.parse(payload);
      if (data.type !== 'ST_IDENTITY') return;
      processingRef.current = true;
      const alreadyPresent = storage.getAttendance().some(a => a.periodId === currentActiveQr.id && a.studentId === data.sid);
      if (alreadyPresent) {
         setScanResult({ status: 'info', message: `${data.nm} already marked.` });
         setTimeout(() => { setScanResult(null); processingRef.current = false; }, 1500);
         return;
      }
      if (currentActiveQr.groupId !== 'GEN') {
         const grp = storage.getGroups().find(g => g.id === currentActiveQr.groupId);
         if (grp && !grp.studentIds.includes(data.sid)) {
            setScanResult({ status: 'error', message: 'Student not in this class group.' });
            setTimeout(() => { setScanResult(null); processingRef.current = false; }, 2000);
            return;
         }
      }
      const newRecord: AttendanceRecord = {
          id: storage.generateId(),
          periodId: currentActiveQr.id,
          studentId: data.sid,
          studentName: data.nm,
          admissionNumber: data.adm || 'N/A',
          timestamp: Date.now(),
          subject: currentActiveQr.subject,
          staffName: staff.fullName,
          date: currentActiveQr.date
      };
      const all = storage.getAttendance();
      storage.saveAttendance([...all, newRecord]);
      window.dispatchEvent(new Event('storage'));
      refreshData();
      setScanResult({ status: 'success', message: `${data.nm} marked present!` });
      playTone(800, 'sine', 0.15);
      setTimeout(() => { setScanResult(null); processingRef.current = false; }, 1500);
    } catch (e) { processingRef.current = false; }
  };

  const handleEnrollScan = (payload: string) => {
    if (processingRef.current || enrollStatus !== 'idle') return;
    
    // Use Ref to get current group ID, avoiding stale closures from scanner callback
    const currentGroupId = managingGroupIdRef.current;
    if (!currentGroupId) return;

    try {
      const data = JSON.parse(payload);
      if (data.type !== 'ST_IDENTITY') return;

      processingRef.current = true;
      
      // Fetch latest groups from storage to ensure we don't overwrite previous scans
      const allGroups = storage.getGroups();
      const currentGroup = allGroups.find(g => g.id === currentGroupId);

      if (!currentGroup) {
         processingRef.current = false;
         return;
      }

      if (currentGroup.studentIds.includes(data.sid)) {
        setEnrollStatus('error');
        setEnrollMsg('ALREADY IN GROUP');
        setTimeout(() => { setEnrollStatus('idle'); processingRef.current = false; }, 500);
        return;
      }

      const updatedGroup = { ...currentGroup, studentIds: [...currentGroup.studentIds, data.sid] };
      const updatedGroupsList = allGroups.map(g => g.id === updatedGroup.id ? updatedGroup : g);
      storage.saveGroups(updatedGroupsList);
      
      setManagingGroup(updatedGroup);
      
      setLastScannedName(data.nm);
      setEnrollStatus('success');
      setEnrollMsg('STUDENT ADDED');
      
      const newEntry: {name: string, status: 'success' | 'error', id: string, time: string} = {
        name: String(data.nm), status: 'success', id: storage.generateId(), time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})
      };
      setEnrollBatchLog(prev => [newEntry, ...prev].slice(0, 20));
      
      refreshData();
      playTone(800, 'sine', 0.1);
      
      // Fast reset (500ms) for continuous scanning
      setTimeout(() => { setEnrollStatus('idle'); processingRef.current = false; }, 500);
    } catch (e) { processingRef.current = false; }
  };

  const stopScanner = async () => {
    if (scannerRef.current) {
      try { await scannerRef.current.stop(); } catch (e) {}
      scannerRef.current = null;
    }
    setIsEnrolling(false);
    setIsScanningAttendance(false);
  };

  const handleRenameGroup = () => {
    if (!renamingGroup || !newGroupName.trim()) return;
    const allGroups = storage.getGroups();
    const updated = allGroups.map(g => g.id === renamingGroup.id ? { ...g, name: newGroupName.trim() } : g);
    storage.saveGroups(updated);
    setRenamingGroup(null);
    setNewGroupName('');
    refreshData();
  };

  const handleDeleteGroup = (groupId: string) => {
    if (!window.confirm('Are you sure you want to permanently delete this class group?')) return;
    const allGroups = storage.getGroups();
    const updated = allGroups.filter(g => g.id !== groupId);
    storage.saveGroups(updated);
    refreshData();
    window.dispatchEvent(new Event('storage'));
  };

  const handleDeleteSession = (periodId: string) => {
    if (!window.confirm('Are you sure you want to delete this session record?')) return;
    const allPeriods = storage.getPeriods();
    const updated = allPeriods.filter(p => p.id !== periodId);
    storage.savePeriods(updated);
    refreshData();
    window.dispatchEvent(new Event('storage'));
  };

  const handleExportCSV = (period: Period) => {
    const records = storage.getAttendance().filter(a => a.periodId === period.id);
    if (records.length === 0) {
      alert('No attendance data available for this session.');
      return;
    }
    const headers = "Date,Time,Student Name,Admission ID,Subject,Faculty\n";
    const csvContent = records.map(r => {
      const timeStr = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `"${r.date}","${timeStr}","${r.studentName}","${r.admissionNumber}","${r.subject}","${r.staffName}"`;
    }).join('\n');
    const blob = new Blob([headers + csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Attendance_Log_${period.subject.replace(/[^a-z0-9]/gi, '_')}_${period.date}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportFullArchiveCSV = () => {
    const allAttendance = storage.getAttendance();
    const myPeriodsIds = periods.map(p => p.id);
    const myRecords = allAttendance.filter(a => myPeriodsIds.includes(a.periodId));

    if (myRecords.length === 0) {
      alert('No archival data found.');
      return;
    }

    const headers = "Session Date,Session Time,Subject,Student Name,Admission ID,Faculty\n";
    const csvContent = myRecords.map(r => {
      const timeStr = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `"${r.date}","${timeStr}","${r.subject}","${r.studentName}","${r.admissionNumber}","${r.staffName}"`;
    }).join('\n');

    const blob = new Blob([headers + csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SmartTrack_Attendance_History_${staff.fullName.replace(/\s+/g, '_')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const timerStyle = useMemo(() => {
    if (timeLeft <= 10) return 'text-rose-600 animate-pulse scale-110';
    if (timeLeft <= 30) return 'text-orange-500';
    return 'text-indigo-600';
  }, [timeLeft]);

  return (
    <div className="space-y-8 pb-32 max-w-6xl mx-auto no-print">
      {/* Tab Nav */}
      <div className="flex bg-white p-2 rounded-[2rem] border border-gray-100 shadow-sm w-fit mx-auto mb-10 overflow-hidden">
        {[
          { id: 'terminal', label: 'Attendance Terminal', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
          { id: 'classrooms', label: 'Class Groups', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
          { id: 'archive', label: 'Attendance History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' }
        ].map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-3 px-8 py-4 rounded-[1.5rem] text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${activeTab === tab.id ? 'bg-indigo-600 text-white shadow-xl shadow-indigo-200 translate-y-[-2px]' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={tab.icon} /></svg>
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'terminal' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 animate-in slide-in-from-bottom-8 duration-700">
          <div className="lg:col-span-7">
            <div className={`bg-white p-12 rounded-[4rem] border shadow-xl shadow-indigo-50/50 overflow-hidden relative min-h-[550px] flex flex-col items-center justify-center group transition-colors duration-500 ${timeLeft <= 30 && activeQr ? 'border-rose-100 shadow-rose-100' : 'border-gray-100'}`}>
              {!activeQr ? (
                <div className="text-center page-transition">
                  <div className="w-24 h-24 bg-indigo-50 rounded-[3rem] flex items-center justify-center mx-auto mb-10 text-indigo-600 shadow-inner group-hover:scale-110 transition-transform duration-500">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01" /></svg>
                  </div>
                  <h3 className="text-3xl font-black text-gray-900 uppercase tracking-tight mb-4 leading-none">Start Attendance Session</h3>
                  <p className="text-[12px] font-bold text-gray-400 uppercase tracking-widest max-w-[320px] mx-auto mb-12 leading-relaxed">Generate a session QR code for students to scan and mark attendance.</p>
                  <button onClick={() => setIsCreatingSession(true)} className="bg-indigo-600 text-white px-12 py-6 rounded-[2.5rem] font-black uppercase tracking-widest text-[11px] shadow-2xl shadow-indigo-100 hover:scale-[1.05] active:scale-95 transition-all">Create Session</button>
                </div>
              ) : (
                <div className="flex flex-col items-center w-full page-transition">
                  <div className="flex justify-between w-full mb-8 items-end px-6">
                      <div className="flex-1">
                        <h4 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none mb-2">{activeQr.subject}</h4>
                        <p className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.4em] leading-none">Session Active</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-4xl font-black leading-none tabular-nums tracking-tighter transition-all duration-500 ${timerStyle}`}>{Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, '0')}</p>
                        <p className={`text-[9px] font-black uppercase tracking-widest mt-2 ${timeLeft <= 30 ? 'text-rose-500 animate-pulse' : 'text-gray-300'}`}>
                          {timeLeft <= 10 ? 'SESSION EXPIRING SOON' : timeLeft <= 30 ? 'ENDING SOON' : 'Time Remaining'}
                        </p>
                      </div>
                  </div>

                  <div className="mb-8 bg-gray-50/80 backdrop-blur-sm px-6 py-4 rounded-[2rem] border border-gray-100 flex items-center gap-8 shadow-sm">
                      <div className="flex flex-col gap-2">
                        <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Correction</span>
                        <div className="flex bg-white rounded-xl p-1 border border-gray-100">
                            {(['L', 'M', 'Q', 'H'] as const).map(lvl => (
                              <button 
                                  key={lvl} 
                                  onClick={() => setQrErrorLevel(lvl)}
                                  className={`w-8 h-8 rounded-lg text-[10px] font-black transition-all ${qrErrorLevel === lvl ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-600'}`}
                                >
                                  {lvl}
                              </button>
                            ))}
                        </div>
                      </div>
                      <div className="w-px h-10 bg-gray-200"></div>
                      <div className="flex flex-col gap-2">
                        <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest">Size</span>
                        <div className="flex bg-white rounded-xl p-1 border border-gray-100">
                            {[400, 600, 800].map(sz => (
                              <button 
                                  key={sz} 
                                  onClick={() => setQrSize(sz)}
                                  className={`px-3 h-8 rounded-lg text-[9px] font-black transition-all ${qrSize === sz ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-600'}`}
                                >
                                  {sz === 400 ? 'S' : sz === 600 ? 'M' : 'L'}
                              </button>
                            ))}
                        </div>
                      </div>
                  </div>

                  <div className="relative p-6 mb-8 group/qr">
                      <div className={`absolute -inset-10 blur-[100px] rounded-full transition-colors duration-1000 ${timeLeft <= 30 ? 'bg-rose-600/20' : 'bg-indigo-600/5 group-hover/qr:bg-indigo-600/10'}`}></div>
                      <div className={`relative bg-white p-8 rounded-[4rem] shadow-[0_40px_80px_-15px_rgba(0,0,0,0.1)] border-8 overflow-hidden transition-colors duration-500 ${timeLeft <= 30 ? 'border-rose-50' : 'border-gray-50'}`}>
                        <img 
                            src={qrDataUrl} 
                            style={{ width: qrSize === 400 ? '200px' : qrSize === 600 ? '280px' : '360px' }} 
                            className="h-auto object-contain mix-blend-multiply transition-all duration-500" 
                            alt="Live Session QR" 
                        />
                        <div className={`scan-line ${timeLeft <= 30 ? '!bg-rose-500 !shadow-[0_0_15px_rgba(244,63,94,1)]' : ''}`}></div>
                      </div>
                  </div>

                  <div className="flex flex-col items-center gap-6 w-full max-w-sm">
                      <div className={`flex items-center gap-3 bg-gray-50 px-6 py-3 rounded-full border mb-2 transition-colors duration-500 ${timeLeft <= 30 ? 'border-rose-100 bg-rose-50' : 'border-gray-100'}`}>
                        <div className={`w-2 h-2 rounded-full animate-pulse ${timeLeft <= 30 ? 'bg-rose-500' : 'bg-indigo-500'}`}></div>
                        <span className={`text-[10px] font-black uppercase tracking-widest ${timeLeft <= 30 ? 'text-rose-600' : 'text-gray-500'}`}>Session Active</span>
                      </div>
                      
                      <button 
                        onClick={() => { localStorage.removeItem(ACTIVE_SESSION_KEY); refreshData(); }} 
                        className="w-full bg-indigo-600 text-white py-5 rounded-[2rem] font-black uppercase tracking-[0.2em] text-[10px] hover:scale-105 transition-all shadow-xl active:scale-95"
                      >
                        End Session
                      </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 flex flex-col gap-8">
            <div className="bg-white rounded-[4rem] border border-gray-100 shadow-xl shadow-indigo-50/20 flex flex-col h-[480px] overflow-hidden relative">
                <div className="p-10 border-b border-gray-50 flex justify-between items-center bg-gray-50/30">
                  <div>
                      <h4 className="text-xl font-black text-gray-900 uppercase tracking-tight leading-none">Live Attendance</h4>
                      <p className="text-[9px] font-black text-gray-400 uppercase tracking-[0.3em] mt-2">Students Present</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                      <div className="bg-emerald-50 text-emerald-600 px-5 py-2.5 rounded-2xl text-[11px] font-black uppercase tracking-widest border border-emerald-100">{liveAttendance.length} Present</div>
                      <div className="flex items-center gap-2">
                        {activeQr && (
                          <button 
                            onClick={startAttendanceScanner}
                            className="bg-indigo-600 text-white w-8 h-8 rounded-lg flex items-center justify-center shadow-lg hover:scale-110 active:scale-95 transition-all"
                            title="Scan Student ID"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01" /></svg>
                          </button>
                        )}
                        {activeQr && (
                          <button 
                            onClick={() => { setIsManualAdding(true); setSelectedManualStudents(new Set()); }}
                            className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline flex items-center gap-1.5 ml-2"
                          >
                             <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v1m8-8H4" /></svg>
                             Add
                          </button>
                        )}
                        {activeQr && liveAttendance.length > 0 && (
                            <button 
                            onClick={() => { setIsManageMode(!isManageMode); setSelectedForRemoval(new Set()); }}
                            className={`text-[10px] font-black uppercase tracking-widest transition-colors flex items-center gap-1.5 ml-2 ${isManageMode ? 'text-rose-500' : 'text-gray-400 hover:text-indigo-600'}`}
                            >
                                {isManageMode ? 'Done' : 'Manage'}
                            </button>
                        )}
                      </div>
                  </div>
                </div>
                
                {/* Scrollable List */}
                <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar pb-24">
                  {liveAttendance.map((a, idx) => (
                    <div 
                        key={a.id} 
                        onClick={() => isManageMode && toggleRemovalSelection(a.id)}
                        className={`p-5 rounded-[2rem] border flex items-center justify-between group/att animate-in slide-in-from-right-4 transition-all ${isManageMode ? (selectedForRemoval.has(a.id) ? 'bg-indigo-50 border-indigo-200 cursor-pointer' : 'bg-white border-gray-100 cursor-pointer hover:bg-gray-50') : 'bg-gray-50/50 border-gray-100'}`}
                    >
                        <div className="flex items-center gap-5">
                          {isManageMode && (
                              <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${selectedForRemoval.has(a.id) ? 'bg-indigo-600 border-indigo-600' : 'border-gray-200'}`}>
                                  {selectedForRemoval.has(a.id) && <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                              </div>
                          )}
                          <div className={`w-12 h-12 rounded-[1.2rem] flex items-center justify-center font-black text-sm uppercase transition-colors ${isManageMode && selectedForRemoval.has(a.id) ? 'bg-indigo-200 text-indigo-700' : 'bg-indigo-600 text-white'}`}>{a.studentName.charAt(0)}</div>
                          <div>
                              <span className={`text-[13px] font-black uppercase block leading-none mb-1.5 transition-colors ${isManageMode && selectedForRemoval.has(a.id) ? 'text-indigo-900' : 'text-gray-800'}`}>{a.studentName}</span>
                              <span className="text-[10px] font-bold text-gray-400 uppercase font-mono">{a.admissionNumber}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                           {!isManageMode && (
                                <>
                                    <span className="text-[10px] font-bold text-gray-300 tabular-nums hidden sm:block">{new Date(a.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); handleManualRemove(a.id, a.studentName); }}
                                        className="w-10 h-10 bg-white border border-gray-100 text-gray-400 rounded-xl flex items-center justify-center hover:bg-rose-50 hover:border-rose-100 hover:text-rose-500 transition-all shadow-sm"
                                        title="Remove Attendance"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    </button>
                                </>
                           )}
                        </div>
                    </div>
                  ))}
                  {liveAttendance.length === 0 && (
                    <div className="py-20 text-center">
                       <p className="text-gray-300 font-black uppercase tracking-[0.3em] text-[10px]">No students marked yet</p>
                    </div>
                  )}
                </div>

                {/* Bulk Action Footer */}
                {isManageMode && selectedForRemoval.size > 0 && (
                    <div className="absolute bottom-0 inset-x-0 p-6 bg-white/90 backdrop-blur-md border-t border-gray-100 z-10 animate-in slide-in-from-bottom-2">
                        <button 
                            onClick={handleBulkRemove}
                            className="w-full bg-rose-500 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-lg shadow-rose-200 hover:bg-rose-600 transition-all flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            Remove {selectedForRemoval.size} Students
                        </button>
                    </div>
                )}
            </div>

            {/* Manual Override Audit Log */}
            <div className="bg-white rounded-[4rem] border border-gray-100 shadow-xl shadow-indigo-50/10 flex flex-col flex-1 overflow-hidden min-h-[250px]">
                <div className="px-10 py-6 border-b border-gray-50 flex justify-between items-center bg-gray-50/20">
                    <div>
                        <h4 className="text-sm font-black text-gray-900 uppercase tracking-widest leading-none">Activity Log</h4>
                        <p className="text-[8px] font-black text-gray-400 uppercase tracking-[0.3em] mt-1.5">Manual Adjustments</p>
                    </div>
                    {liveAttendance.length > 0 && (
                          <button 
                            onClick={() => handleExportCSV(activeQr!)}
                            className="text-[10px] font-black text-gray-400 uppercase tracking-widest hover:text-indigo-600 transition-colors flex items-center gap-1.5 ml-2"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                            CSV
                          </button>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-3 no-scrollbar">
                    {manualOverrideLog.map(log => (
                      <div key={log.id} className="text-[10px] flex items-center justify-between p-3 rounded-xl bg-gray-50/50 border border-gray-100 animate-in slide-in-from-bottom-2">
                        <div className="flex items-center gap-3">
                           <span className={`px-2 py-0.5 rounded text-[8px] font-black ${log.action === 'ADD' ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'}`}>
                             {log.action}
                           </span>
                           <span className="font-bold text-gray-700 uppercase">{log.studentName}</span>
                        </div>
                        <span className="text-[9px] font-bold text-gray-300 font-mono">{log.time}</span>
                      </div>
                    ))}
                    {manualOverrideLog.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full opacity-20 py-10">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                         <p className="text-[9px] font-black uppercase tracking-widest text-gray-400">No manual changes</p>
                      </div>
                    )}
                </div>
            </div>
          </div>
        </div>
      )}

      {/* Classrooms Tab Content */}
      {activeTab === 'classrooms' && (
        <div className="animate-in slide-in-from-bottom-8 duration-700">
          <div className="flex justify-between items-center mb-10">
             <div>
                <h2 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none">Class Groups</h2>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-2">Manage Student Cohorts</p>
             </div>
             <button onClick={() => setIsCreatingGroup(true)} className="bg-indigo-600 text-white px-8 py-4 rounded-[2rem] font-black uppercase tracking-widest text-[10px] shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
                New Group
             </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {/* General Group Card */}
             <div className="bg-gradient-to-br from-gray-50 to-white p-8 rounded-[2.5rem] border border-gray-100 opacity-60">
                <div className="w-14 h-14 bg-gray-200 rounded-2xl flex items-center justify-center mb-6 text-gray-500">
                   <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                </div>
                <h3 className="text-xl font-black text-gray-900 uppercase tracking-tight leading-none mb-2">General</h3>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-8">All Students Access</p>
                <div className="bg-gray-100 px-4 py-2 rounded-xl inline-block">
                   <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Default</span>
                </div>
             </div>

             {/* Dynamic Groups */}
             {groups.map(group => (
               <div key={group.id} className="bg-white p-8 rounded-[2.5rem] border border-gray-100 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all group relative">
                  <div className="flex justify-between items-start mb-6">
                     <div className="w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                        <span className="text-lg font-black uppercase">{group.name.substring(0,2)}</span>
                     </div>
                     <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setRenamingGroup(group)} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600 flex items-center justify-center transition-all">
                           <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        </button>
                        <button onClick={() => handleDeleteGroup(group.id)} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-50 hover:text-rose-600 flex items-center justify-center transition-all">
                           <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                     </div>
                  </div>
                  
                  <h3 className="text-xl font-black text-gray-900 uppercase tracking-tight leading-none mb-2">{group.name}</h3>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-8">{group.studentIds.length} Students Enrolled</p>
                  
                  <button onClick={() => { setManagingGroup(group); stopScanner(); }} className="w-full bg-gray-50 text-gray-600 py-4 rounded-2xl font-black uppercase tracking-widest text-[9px] hover:bg-indigo-600 hover:text-white transition-all">
                     Manage Enrollment
                  </button>
               </div>
             ))}
          </div>
          
          {groups.length === 0 && (
             <div className="text-center py-20 opacity-50">
                <p className="text-gray-400 font-black uppercase tracking-widest text-[10px]">No custom groups created</p>
             </div>
          )}
        </div>
      )}

      {/* Archive Tab Content */}
      {activeTab === 'archive' && (
        <div className="animate-in slide-in-from-bottom-8 duration-700">
           <div className="flex justify-between items-center mb-10">
             <div>
                <h2 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none">Attendance History</h2>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mt-2">Past Sessions Log</p>
             </div>
             <button onClick={handleExportFullArchiveCSV} className="bg-gray-900 text-white px-8 py-4 rounded-[2rem] font-black uppercase tracking-widest text-[10px] shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                Export All
             </button>
          </div>

          <div className="space-y-4">
             {periods.map(period => {
               const count = storage.getAttendance().filter(a => a.periodId === period.id).length;
               return (
                 <div key={period.id} className="bg-white p-6 rounded-[2.5rem] border border-gray-100 flex items-center justify-between hover:border-indigo-100 hover:shadow-lg transition-all group">
                    <div className="flex items-center gap-6">
                       <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex flex-col items-center justify-center text-indigo-600">
                          <span className="text-lg font-black leading-none">{new Date(period.date).getDate()}</span>
                          <span className="text-[9px] font-black uppercase tracking-widest">{new Date(period.date).toLocaleString('default', { month: 'short' })}</span>
                       </div>
                       <div>
                          <h4 className="text-lg font-black text-gray-900 uppercase tracking-tight leading-none mb-1.5">{period.subject}</h4>
                          <div className="flex items-center gap-3">
                             <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-gray-50 px-2 py-1 rounded-lg">{period.time}</span>
                             <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{count} Students</span>
                          </div>
                       </div>
                    </div>
                    
                    <div className="flex items-center gap-3">
                       <button 
                          onClick={() => handleExportCSV(period)}
                          className="w-12 h-12 rounded-2xl bg-gray-50 text-gray-400 hover:bg-emerald-50 hover:text-emerald-600 flex items-center justify-center transition-all"
                          title="Download CSV"
                       >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                       </button>
                       <button 
                          onClick={() => handleDeleteSession(period.id)}
                          className="w-12 h-12 rounded-2xl bg-gray-50 text-gray-400 hover:bg-rose-50 hover:text-rose-600 flex items-center justify-center transition-all"
                          title="Delete Record"
                       >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                       </button>
                    </div>
                 </div>
               );
             })}
             
             {periods.length === 0 && (
                <div className="text-center py-24 border-2 border-dashed border-gray-100 rounded-[3rem]">
                   <p className="text-gray-300 font-black uppercase tracking-[0.3em] text-[10px]">No past sessions found</p>
                </div>
             )}
          </div>
        </div>
      )}

      {/* ATTENDANCE SCANNER MODAL */}
      {isScanningAttendance && (
        <div className="fixed inset-0 bg-[#020617] z-[100] flex flex-col animate-in fade-in duration-300 no-print">
            <div className="flex justify-between items-center p-8 sm:p-12 z-10 relative">
              <div>
                <h2 className="text-white text-2xl font-black tracking-tighter uppercase leading-none">Scan ID</h2>
                <p className="text-indigo-400 text-[10px] font-black uppercase tracking-[0.3em] mt-2">Instant Attendance</p>
              </div>
              <button onClick={stopScanner} className="w-14 h-14 rounded-2xl bg-white/10 text-white flex items-center justify-center border border-white/10 hover:bg-white/20 transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-8 relative">
                <div className="w-full max-w-sm aspect-square bg-black rounded-[3rem] border border-white/10 relative overflow-hidden flex flex-col items-center justify-center shadow-2xl">
                    <div id="attendance-reader" className="w-full h-full object-cover"></div>
                    
                    {/* Viewfinder Overlay */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                        <div className={`w-64 h-64 border-[4px] rounded-[2.5rem] relative transition-colors duration-300 ${scanResult ? (scanResult.status === 'success' ? 'border-emerald-500' : scanResult.status === 'error' ? 'border-rose-500' : 'border-amber-400') : 'border-indigo-500/50'}`}>
                             {!scanResult && (
                                <>
                                  <div className="absolute top-0 left-0 w-6 h-6 border-t-[6px] border-l-[6px] border-indigo-500 -mt-[3px] -ml-[3px] rounded-tl-2xl"></div>
                                  <div className="absolute top-0 right-0 w-6 h-6 border-t-[6px] border-r-[6px] border-indigo-500 -mt-[3px] -mr-[3px] rounded-tr-2xl"></div>
                                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-[6px] border-l-[6px] border-indigo-500 -mb-[3px] -ml-[3px] rounded-bl-2xl"></div>
                                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-[6px] border-r-[6px] border-indigo-500 -mb-[3px] -mr-[3px] rounded-br-2xl"></div>
                                </>
                             )}
                        </div>
                    </div>

                    {/* Status Feedback */}
                    {scanResult && (
                        <div className={`absolute bottom-8 left-1/2 -translate-x-1/2 px-8 py-4 rounded-[2rem] font-black uppercase tracking-widest text-[10px] shadow-2xl animate-in slide-in-from-bottom-4 flex items-center gap-3 whitespace-nowrap z-20 ${scanResult.status === 'success' ? 'bg-emerald-500 text-white' : scanResult.status === 'error' ? 'bg-rose-500 text-white' : 'bg-amber-400 text-black'}`}>
                            <div className={`w-2 h-2 rounded-full ${scanResult.status === 'success' ? 'bg-white' : 'bg-black/20'}`}></div>
                            {scanResult.message}
                        </div>
                    )}
                </div>
                <p className="text-gray-500 font-black uppercase tracking-widest text-[10px] mt-8">Point camera at Student Digital ID</p>
            </div>
        </div>
      )}

      {/* Manual Add Selection Modal (Attendance) */}
      {isManualAdding && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-2xl z-[150] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
           <div className="bg-white w-full max-w-xl rounded-[4.5rem] p-16 animate-in zoom-in-95 flex flex-col max-h-[80vh] relative">
              <div className="flex justify-between items-start mb-6">
                 <div>
                    <h3 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none">Manual Entry</h3>
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.4em] mt-3">Select Students</p>
                 </div>
                 <button onClick={() => setIsManualAdding(false)} className="w-14 h-14 rounded-2xl bg-gray-50 text-gray-400 flex items-center justify-center text-3xl font-light hover:bg-rose-50 hover:text-rose-500 transition-all shadow-inner">&times;</button>
              </div>

              {eligibleForManualAdd.length > 0 && (
                <div className="flex items-center justify-between mb-4 px-2">
                   <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{selectedManualStudents.size} Selected</p>
                   <button 
                      onClick={toggleSelectAllManual}
                      className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline"
                   >
                      {selectedManualStudents.size === eligibleForManualAdd.length ? 'Deselect All' : 'Select All'}
                   </button>
                </div>
              )}
              
              <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar pr-2 pb-24">
                 {eligibleForManualAdd.map(student => (
                   <div 
                      key={student.id} 
                      onClick={() => toggleManualStudent(student.id)}
                      className={`p-4 rounded-[2rem] flex justify-between items-center border cursor-pointer transition-all duration-300 ${selectedManualStudents.has(student.id) ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-100 hover:bg-white hover:shadow-lg'}`}
                   >
                      <div className="flex items-center gap-4">
                        <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${selectedManualStudents.has(student.id) ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}`}>
                           {selectedManualStudents.has(student.id) && (
                             <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                           )}
                        </div>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs uppercase ${selectedManualStudents.has(student.id) ? 'bg-indigo-200 text-indigo-700' : 'bg-gray-200 text-gray-500'}`}>
                           {student.fullName.charAt(0)}
                        </div>
                        <div>
                          <span className={`text-sm font-black uppercase block leading-none mb-1 ${selectedManualStudents.has(student.id) ? 'text-indigo-900' : 'text-gray-800'}`}>{student.fullName}</span>
                          <span className="text-[9px] font-bold text-gray-400 uppercase font-mono">{student.admissionNumber}</span>
                        </div>
                      </div>
                   </div>
                 ))}
                 {eligibleForManualAdd.length === 0 && (
                    <div className="py-20 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-100">
                       <p className="text-gray-300 font-black uppercase tracking-widest text-[10px]">No students available to add</p>
                    </div>
                 )}
              </div>

              {selectedManualStudents.size > 0 && (
                 <div className="absolute bottom-8 left-0 right-0 px-16 flex justify-center">
                    <button 
                       onClick={handleBulkManualAdd}
                       className="bg-indigo-600 text-white px-10 py-5 rounded-[2.5rem] font-black uppercase tracking-widest text-[10px] shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 animate-in slide-in-from-bottom-4"
                    >
                       <span>Mark {selectedManualStudents.size} Present</span>
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                    </button>
                 </div>
              )}
           </div>
        </div>
      )}

      {/* Manual Group Add Modal */}
      {isManualGroupAdding && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-2xl z-[150] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
           <div className="bg-white w-full max-w-xl rounded-[4.5rem] p-16 animate-in zoom-in-95 flex flex-col max-h-[80vh] relative">
              <div className="flex justify-between items-start mb-6">
                 <div>
                    <h3 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none">Bulk Enroll</h3>
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.4em] mt-3">Select Students to Add</p>
                 </div>
                 <button onClick={() => setIsManualGroupAdding(false)} className="w-14 h-14 rounded-2xl bg-gray-50 text-gray-400 flex items-center justify-center text-3xl font-light hover:bg-rose-50 hover:text-rose-500 transition-all shadow-inner">&times;</button>
              </div>

              {eligibleForGroupAdd.length > 0 && (
                <div className="flex items-center justify-between mb-4 px-2">
                   <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{selectedGroupStudents.size} Selected</p>
                   <button 
                      onClick={toggleSelectAllGroup}
                      className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline"
                   >
                      {selectedGroupStudents.size === eligibleForGroupAdd.length ? 'Deselect All' : 'Select All'}
                   </button>
                </div>
              )}
              
              <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar pr-2 pb-24">
                 {eligibleForGroupAdd.map(student => (
                   <div 
                      key={student.id} 
                      onClick={() => toggleGroupStudent(student.id)}
                      className={`p-4 rounded-[2rem] flex justify-between items-center border cursor-pointer transition-all duration-300 ${selectedGroupStudents.has(student.id) ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-100 hover:bg-white hover:shadow-lg'}`}
                   >
                      <div className="flex items-center gap-4">
                        <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${selectedGroupStudents.has(student.id) ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'}`}>
                           {selectedGroupStudents.has(student.id) && (
                             <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                           )}
                        </div>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs uppercase ${selectedGroupStudents.has(student.id) ? 'bg-indigo-200 text-indigo-700' : 'bg-gray-200 text-gray-500'}`}>
                           {student.fullName.charAt(0)}
                        </div>
                        <div>
                          <span className={`text-sm font-black uppercase block leading-none mb-1 ${selectedGroupStudents.has(student.id) ? 'text-indigo-900' : 'text-gray-800'}`}>{student.fullName}</span>
                          <span className="text-[9px] font-bold text-gray-400 uppercase font-mono">{student.admissionNumber}</span>
                        </div>
                      </div>
                   </div>
                 ))}
                 {eligibleForGroupAdd.length === 0 && (
                    <div className="py-20 text-center bg-gray-50 rounded-[2.5rem] border-2 border-dashed border-gray-100">
                       <p className="text-gray-300 font-black uppercase tracking-widest text-[10px]">No eligible students found</p>
                    </div>
                 )}
              </div>

              {selectedGroupStudents.size > 0 && (
                 <div className="absolute bottom-8 left-0 right-0 px-16 flex justify-center">
                    <button 
                       onClick={handleBulkGroupAdd}
                       className="bg-indigo-600 text-white px-10 py-5 rounded-[2.5rem] font-black uppercase tracking-widest text-[10px] shadow-2xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3 animate-in slide-in-from-bottom-4"
                    >
                       <span>Add {selectedGroupStudents.size} Students</span>
                       <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 4v16m8-8H4" /></svg>
                    </button>
                 </div>
              )}
           </div>
        </div>
      )}

      {/* CREATE SESSION MODAL */}
      {isCreatingSession && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-2xl z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
           <div className="bg-white w-full max-w-xl rounded-[4.5rem] p-16 animate-in zoom-in-95">
              <div className="flex justify-between items-start mb-12">
                 <div>
                    <h3 className="text-3xl font-black text-gray-900 uppercase tracking-tighter leading-none">New Session</h3>
                    <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.4em] mt-3">Enter Details</p>
                 </div>
                 <button onClick={() => setIsCreatingSession(false)} className="w-14 h-14 rounded-2xl bg-gray-50 text-gray-400 flex items-center justify-center text-3xl font-light hover:bg-rose-50 hover:text-rose-500 transition-all shadow-inner">&times;</button>
              </div>
              <div className="space-y-10">
                 <div className="space-y-10">
                    <div>
                       <label className="text-[10px] font-black text-gray-300 uppercase tracking-widest mb-4 block ml-2">Subject / Topic</label>
                       <input type="text" value={sessionSubject} onChange={e => setSessionSubject(e.target.value)} className="w-full p-8 bg-gray-50 border border-gray-100 rounded-[2.5rem] font-black text-sm focus:border-indigo-500 outline-none shadow-inner" />
                    </div>
                    <div>
                       <label className="text-[10px] font-black text-gray-300 uppercase tracking-widest mb-4 block ml-2">Select Class</label>
                       <select value={selectedGroupId} onChange={e => setSelectedGroupId(e.target.value)} className="w-full p-8 bg-gray-50 border border-gray-100 rounded-[2.5rem] font-black text-sm outline-none shadow-inner appearance-none cursor-pointer">
                          <option value="">Select Class Group...</option>
                          {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.studentIds.length} students)</option>)}
                          <option value="GEN">General (Open to All)</option>
                       </select>
                    </div>
                 </div>
                 <button onClick={() => {
                      if(!sessionSubject || !selectedGroupId) return;
                      // Resume audio context on user interaction
                      getAudioContext()?.resume();
                      const id = storage.generateId();
                      const period: Period = {
                        id, staffId: staff.id, date: new Date().toISOString().split('T')[0],
                        day: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date()),
                        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        subject: sessionSubject, groupId: selectedGroupId, wifiIp: '',
                        createdAt: Date.now(), expiresAt: Date.now() + 15 * 60000
                      };
                      storage.savePeriods([period, ...storage.getPeriods()]);
                      localStorage.setItem(ACTIVE_SESSION_KEY, id);
                      setIsCreatingSession(false); refreshData();
                   }} className="w-full bg-indigo-600 text-white py-8 rounded-[3rem] font-black uppercase tracking-widest text-[11px] shadow-2xl">Start Session</button>
              </div>
           </div>
        </div>
      )}

      {/* CREATE GROUP MODAL */}
      {isCreatingGroup && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-2xl z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
            <div className="bg-white w-full max-w-lg rounded-[3.5rem] p-12 animate-in zoom-in-95">
              <h3 className="text-2xl font-black text-gray-900 uppercase tracking-tighter mb-2">New Class Group</h3>
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-8">Define a student subset</p>
              
              <input 
                type="text" 
                value={groupName} 
                onChange={e => setGroupName(e.target.value)} 
                placeholder="e.g., CS-A 2024"
                className="w-full p-6 bg-gray-50 border border-gray-100 rounded-[2rem] font-bold text-sm focus:border-indigo-500 outline-none shadow-inner mb-8" 
              />

              <div className="flex gap-4">
                <button onClick={() => setIsCreatingGroup(false)} className="flex-1 py-5 rounded-[2rem] bg-gray-100 text-gray-500 font-black uppercase tracking-widest text-[10px] hover:bg-gray-200">Cancel</button>
                <button 
                  onClick={() => {
                    if(!groupName.trim()) return;
                    const newGroup: ClassGroup = {
                      id: storage.generateId(),
                      name: groupName.trim(),
                      staffId: staff.id,
                      studentIds: []
                    };
                    storage.saveGroups([...storage.getGroups(), newGroup]);
                    setGroupName('');
                    setIsCreatingGroup(false);
                    refreshData();
                  }} 
                  className="flex-1 py-5 rounded-[2rem] bg-indigo-600 text-white font-black uppercase tracking-widest text-[10px] shadow-xl hover:scale-105 transition-all"
                >
                  Create Group
                </button>
              </div>
            </div>
        </div>
      )}

      {/* RENAME GROUP MODAL */}
      {renamingGroup && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-2xl z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
            <div className="bg-white w-full max-w-lg rounded-[3.5rem] p-12 animate-in zoom-in-95">
              <h3 className="text-2xl font-black text-gray-900 uppercase tracking-tighter mb-2">Rename Group</h3>
              
              <input 
                type="text" 
                value={newGroupName} 
                onChange={e => setNewGroupName(e.target.value)} 
                className="w-full p-6 bg-gray-50 border border-gray-100 rounded-[2rem] font-bold text-sm focus:border-indigo-500 outline-none shadow-inner mb-8" 
              />

              <div className="flex gap-4">
                <button onClick={() => setRenamingGroup(null)} className="flex-1 py-5 rounded-[2rem] bg-gray-100 text-gray-500 font-black uppercase tracking-widest text-[10px]">Cancel</button>
                <button onClick={handleRenameGroup} className="flex-1 py-5 rounded-[2rem] bg-indigo-600 text-white font-black uppercase tracking-widest text-[10px] shadow-xl">Update</button>
              </div>
            </div>
        </div>
      )}

      {/* MANAGE GROUP (ENROLLMENT) MODAL */}
      {managingGroup && (
        <div className="fixed inset-0 bg-[#020617] z-[100] flex flex-col animate-in fade-in duration-300 no-print">
            <div className="flex justify-between items-center p-8 sm:p-12">
              <div>
                <h2 className="text-white text-2xl font-black tracking-tighter uppercase leading-none">{managingGroup.name}</h2>
                <div className="flex items-center gap-4 mt-2">
                    <p className="text-indigo-400 text-[10px] font-black uppercase tracking-[0.3em]">Group Enrollment</p>
                    <button 
                       onClick={() => { setIsManualGroupAdding(true); setSelectedGroupStudents(new Set()); }}
                       className="text-[10px] font-black text-white uppercase tracking-widest hover:text-indigo-400 border-l border-white/20 pl-4"
                    >
                       + Manual Bulk Add
                    </button>
                </div>
              </div>
              <button onClick={() => { stopScanner(); setManagingGroup(null); }} className="w-14 h-14 rounded-2xl bg-white/10 text-white flex items-center justify-center border border-white/10 hover:bg-white/20 transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 flex flex-col md:flex-row gap-8 p-8 overflow-hidden">
              {/* Scanner Section */}
              <div className="flex-1 bg-black rounded-[3rem] border border-white/10 relative overflow-hidden flex flex-col items-center justify-center">
                 {!isEnrolling ? (
                   <div className="text-center">
                      <button onClick={startEnrollScanner} className="bg-indigo-600 text-white w-24 h-24 rounded-full flex items-center justify-center shadow-2xl hover:scale-110 transition-all mx-auto mb-6">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                      </button>
                      <p className="text-gray-400 font-black uppercase tracking-widest text-[10px]">Add Student via ID QR</p>
                   </div>
                 ) : (
                   <div className="w-full h-full relative">
                      <div id="enroll-reader" className="w-full h-full object-cover"></div>
                      <div className="absolute inset-0 pointer-events-none border-[20px] border-black/50 flex items-center justify-center">
                         <div className="w-64 h-64 border-2 border-indigo-500 rounded-3xl relative">
                            <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-indigo-500 -mt-1 -ml-1"></div>
                            <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-indigo-500 -mt-1 -mr-1"></div>
                            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-indigo-500 -mb-1 -ml-1"></div>
                            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-indigo-500 -mb-1 -mr-1"></div>
                         </div>
                      </div>
                      {enrollStatus !== 'idle' && (
                        <div className={`absolute bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full font-black uppercase tracking-widest text-[10px] shadow-xl ${enrollStatus === 'success' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>
                          {enrollMsg}
                        </div>
                      )}
                   </div>
                 )}
              </div>

              {/* List Section */}
              <div className="flex-1 bg-white/5 rounded-[3rem] border border-white/5 p-8 flex flex-col overflow-hidden">
                 <div className="flex justify-between items-center mb-6">
                    <h4 className="text-white font-black uppercase tracking-widest text-sm">Enrolled Students</h4>
                    <span className="bg-white/10 text-white px-3 py-1 rounded-lg text-[10px] font-bold">{managingGroup.studentIds.length}</span>
                 </div>
                 
                 <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar">
                    {enrollBatchLog.map(log => (
                      <div key={log.id} className="bg-white/5 p-4 rounded-2xl flex justify-between items-center animate-in slide-in-from-left-4">
                         <div>
                            <p className="text-white text-xs font-bold">{log.name}</p>
                            <p className="text-gray-500 text-[9px] font-mono">{log.time}</p>
                         </div>
                         <div className={`w-2 h-2 rounded-full ${log.status === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                      </div>
                    ))}
                    
                    {managingGroup.studentIds.length === 0 && enrollBatchLog.length === 0 && (
                      <div className="text-center py-20 opacity-30">
                         <p className="text-white font-black uppercase tracking-widest text-[10px]">No Data</p>
                      </div>
                    )}
                 </div>
              </div>
            </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmState.type && (
        <div className="fixed inset-0 bg-gray-950/60 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-300 no-print">
           <div className="bg-white w-full max-w-sm rounded-[3rem] p-10 shadow-2xl border border-white/20 animate-in zoom-in-95 duration-500 text-center">
              <div className="w-16 h-16 rounded-[1.8rem] flex items-center justify-center mx-auto mb-6 bg-rose-50 text-rose-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              
              <h3 className="text-xl font-black text-gray-900 uppercase tracking-tight leading-none mb-3">
                 Remove Student
              </h3>
              
              <p className="text-gray-500 text-xs font-medium mb-8 leading-relaxed">
                 {confirmState.type === 'REMOVE' 
                   ? `Are you sure you want to remove ${confirmState.name} from the current session?`
                   : `Remove ${confirmState.count} selected students from the current session?`}
              </p>

              <div className="flex flex-col gap-3">
                 <button 
                    onClick={confirmState.type === 'REMOVE' ? executeRemove : executeBulkRemove}
                    className="w-full py-5 rounded-[2rem] font-black uppercase tracking-widest text-[10px] text-white shadow-xl hover:scale-105 active:scale-95 transition-all bg-rose-600 shadow-rose-200"
                 >
                    Confirm Removal
                 </button>
                 <button 
                    onClick={() => setConfirmState({ type: null })}
                    className="w-full py-5 rounded-[2rem] bg-gray-50 text-gray-500 font-black uppercase tracking-widest text-[10px] hover:bg-gray-100 transition-colors"
                 >
                    Cancel
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default StaffDashboard;
