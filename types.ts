
export enum UserRole {
  STUDENT = 'STUDENT',
  STAFF = 'STAFF',
  ADMIN = 'ADMIN'
}

export interface User {
  id: string;
  fullName: string;
  email: string;
  password?: string;
  role: UserRole;
  deviceId?: string; // Hardware anchor
  // Student specific
  admissionNumber?: string;
  course?: string;
  yearOfStudying?: string;
  // Staff specific
  staffId?: string;
  subject?: string;
}

export interface ClassGroup {
  id: string;
  name: string;
  staffId: string;
  studentIds: string[];
}

export interface Period {
  id: string;
  staffId: string;
  date: string;
  day: string;
  time: string;
  subject: string;
  groupId: string; // Linked Class Group
  wifiIp: string;
  createdAt: number;
  expiresAt: number;
}

export interface AttendanceRecord {
  id: string;
  periodId: string;
  studentId: string;
  studentName: string;
  admissionNumber: string;
  timestamp: number;
  subject: string;
  staffName: string;
  date: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
}
