import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type EmergencyLocation = {
  latitude: number;
  longitude: number;
  heading?: number;
};

export type SttEngine = 'off' | 'sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27';

export type SafetyMode = 'child' | 'adult';

export type RoutineLocation = {
  latitude: number;
  longitude: number;
  address: string;
};

export type RoutePathPoint = {
  latitude: number;
  longitude: number;
};

export type SavedRoute = {
  id: string;
  name: string;
  isActive: boolean;
  start: RoutineLocation;
  end: RoutineLocation;
  waypoints: RoutePathPoint[];
  startHour: string;
  startMinute: string;
  destinationHour: string;
  destinationMinute: string;
};

export type SafetyProfile = {
  mode: SafetyMode | null;
  birthday: string;
  gender: string;
  emergencyPhone: string;
  detailAddress: string;
  startLocation: RoutineLocation | null;
  destinationLocation: RoutineLocation | null;
  childRoutePath: RoutePathPoint[];
  savedRoutes: SavedRoute[];
  activeRouteId: string;
  startHour: string;
  startMinute: string;
  destinationHour: string;
  destinationMinute: string;
};

export type GemmaPromptTemplates = {
  system: string;
  primary: string;
  secondary: string;
};

export type EmergencyAnalysis = {
  is_emergency: boolean;
  crime_type: string;
  situation_summary: string;
  route_deviation?: boolean;
  location?: EmergencyLocation;
  model_id?: string;
  trigger_source?: string;
  analysis_mode?: string;
  monitoring_mode?: SafetyMode;
  litert_error?: string;
  recognized_dialogue?: string;
  confidence?: string;
  analysis_pass?: string;
  final_decision?: boolean;
  audio_summary?: string;
  stt_context_used?: boolean;
  previous_primary_context?: string;
  decision_reason?: string;
  stt_transcript?: string;
  stt_engine?: string;
  stt_error?: string;
  raw_model_response?: string;
};

export type MonitoringConfig = {
  modelId: string;
  sensorThreshold: number;
  gyroThreshold: number;
  audioRmsThreshold: number;
  preTriggerSeconds: number;
  postTriggerSeconds: number;
  routeDeviationDistanceMeters: number;
  routeDeviationDurationSeconds: number;
  routePath: RoutePathPoint[];
  sttEnabled: boolean;
  sttEngine: SttEngine;
  monitoringMode: SafetyMode;
  customPrompt?: string;
};

export type AppSettings = {
  sttEngine: SttEngine;
  sirenEnabled: boolean;
  customPrompt: string;
  sensorThreshold: number;
  gyroThreshold: number;
  audioRmsThreshold: number;
  preTriggerSeconds: number;
  postTriggerSeconds: number;
  routeDeviationDistanceMeters: number;
  routeDeviationDurationSeconds: number;
  safetyProfile: SafetyProfile;
};

export type AudioLogEntry = {
  id: string;
  createdAt: string | number;
  trigger_source: string;
  duration_seconds: number;
  sample_rate: number;
  file_name: string;
  max_rms?: number;
  analysis_pass?: string;
};

export type RouteCaptureResult = {
  start: EmergencyLocation;
  end: EmergencyLocation;
  waypoints: RoutePathPoint[];
};

type EmergencyNativeModule = {
  startMonitoring(config: MonitoringConfig): Promise<boolean>;
  stopMonitoring(): Promise<boolean>;
  cancelPendingReport(): Promise<boolean>;
  triggerDevEmergency(): Promise<boolean>;
  getCurrentLocation(): Promise<EmergencyLocation & {accuracy?: number; timestamp?: number}>;
  getCurrentHeading(): Promise<{heading: number}>;
  startRouteStatusUpdates(): Promise<boolean>;
  stopRouteStatusUpdates(): Promise<boolean>;
  startRouteCapture(start: EmergencyLocation): Promise<boolean>;
  stopRouteCapture(): Promise<RouteCaptureResult>;
  startSiren(durationMs: number): Promise<boolean>;
  stopSiren(): Promise<boolean>;
  loadAnalysisLogs(): Promise<string>;
  saveAnalysisLogs(logsJson: string): Promise<boolean>;
  geocodeAddress(address: string): Promise<EmergencyLocation & {address?: string}>;
  loadAppSettings(): Promise<string>;
  saveAppSettings(settingsJson: string): Promise<boolean>;
  loadGemmaPrompts(monitoringMode: SafetyMode): Promise<string>;
  saveGemmaPrompts(monitoringMode: SafetyMode, promptsJson: string): Promise<boolean>;
  resetGemmaPrompts(monitoringMode: SafetyMode): Promise<string>;
  loadAudioLogs(): Promise<string>;
  playAudioLog(id: string): Promise<boolean>;
  stopAudioLog(): Promise<boolean>;
  sendEmergencySms(payload: {
    destination: string;
    situation_summary: string;
    location?: EmergencyLocation;
  }): Promise<{status: string; destination: string; parts: number}>;
};

type MlcGemmaNativeModule = {
  warmUp(modelId: string): Promise<{
    ready: boolean;
    model_id: string;
    mode: string;
  }>;
  analyzeEmergencyAudio(input: {
    pcmBase64: string;
    sampleRate: number;
    triggerSource: string;
    location?: EmergencyLocation;
    prompt: string;
  }): Promise<EmergencyAnalysis>;
};

const missingModule = (name: string) => {
  throw new Error(`${name} is only available on Android native builds.`);
};

const nativeEmergencyNative =
  Platform.OS === 'android'
    ? (NativeModules.EmergencyNative as Partial<EmergencyNativeModule> | undefined)
    : undefined;

if (
  nativeEmergencyNative &&
  typeof nativeEmergencyNative.getCurrentHeading !== 'function'
) {
  nativeEmergencyNative.getCurrentHeading = () => Promise.resolve({heading: 0});
}

if (
  nativeEmergencyNative &&
  typeof nativeEmergencyNative.startRouteStatusUpdates !== 'function'
) {
  nativeEmergencyNative.startRouteStatusUpdates = () => Promise.resolve(false);
}

if (
  nativeEmergencyNative &&
  typeof nativeEmergencyNative.stopRouteStatusUpdates !== 'function'
) {
  nativeEmergencyNative.stopRouteStatusUpdates = () => Promise.resolve(false);
}

export const EmergencyNative: EmergencyNativeModule =
  nativeEmergencyNative
    ? (nativeEmergencyNative as EmergencyNativeModule)
    : {
        startMonitoring: () => missingModule('EmergencyNative'),
        stopMonitoring: () => missingModule('EmergencyNative'),
        cancelPendingReport: () => missingModule('EmergencyNative'),
        triggerDevEmergency: () => missingModule('EmergencyNative'),
        getCurrentLocation: () => missingModule('EmergencyNative'),
        getCurrentHeading: () => missingModule('EmergencyNative'),
        startRouteStatusUpdates: () => missingModule('EmergencyNative'),
        stopRouteStatusUpdates: () => missingModule('EmergencyNative'),
        startRouteCapture: () => missingModule('EmergencyNative'),
        stopRouteCapture: () => missingModule('EmergencyNative'),
        startSiren: () => missingModule('EmergencyNative'),
        stopSiren: () => missingModule('EmergencyNative'),
        loadAnalysisLogs: () => missingModule('EmergencyNative'),
        saveAnalysisLogs: () => missingModule('EmergencyNative'),
        geocodeAddress: () => missingModule('EmergencyNative'),
        loadAppSettings: () => missingModule('EmergencyNative'),
        saveAppSettings: () => missingModule('EmergencyNative'),
        loadGemmaPrompts: () => missingModule('EmergencyNative'),
        saveGemmaPrompts: () => missingModule('EmergencyNative'),
        resetGemmaPrompts: () => missingModule('EmergencyNative'),
        loadAudioLogs: () => missingModule('EmergencyNative'),
        playAudioLog: () => missingModule('EmergencyNative'),
        stopAudioLog: () => missingModule('EmergencyNative'),
        sendEmergencySms: () => missingModule('EmergencyNative'),
      };

export const MlcGemmaNative: MlcGemmaNativeModule =
  Platform.OS === 'android' && NativeModules.MlcGemmaNative
    ? NativeModules.MlcGemmaNative
    : {
        warmUp: () => missingModule('MlcGemmaNative'),
        analyzeEmergencyAudio: () => missingModule('MlcGemmaNative'),
      };

export const emergencyEvents =
  Platform.OS === 'android' && NativeModules.EmergencyNative
    ? new NativeEventEmitter(NativeModules.EmergencyNative)
    : undefined;


