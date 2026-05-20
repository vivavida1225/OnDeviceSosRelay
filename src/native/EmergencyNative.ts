import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type EmergencyLocation = {
  latitude: number;
  longitude: number;
};

export type EmergencyAnalysis = {
  is_emergency: boolean;
  crime_type: string;
  situation_summary: string;
  location?: EmergencyLocation;
  model_id?: string;
  trigger_source?: string;
  analysis_mode?: string;
  litert_error?: string;
  recognized_dialogue?: string;
  raw_model_response?: string;
};

export type MonitoringConfig = {
  modelId: string;
  sensorThreshold: number;
  audioRmsThreshold: number;
};

type EmergencyNativeModule = {
  startMonitoring(config: MonitoringConfig): Promise<boolean>;
  stopMonitoring(): Promise<boolean>;
  cancelPendingReport(): Promise<boolean>;
  triggerDevEmergency(): Promise<boolean>;
  startSiren(durationMs: number): Promise<boolean>;
  stopSiren(): Promise<boolean>;
  loadAnalysisLogs(): Promise<string>;
  saveAnalysisLogs(logsJson: string): Promise<boolean>;
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

export const EmergencyNative: EmergencyNativeModule =
  Platform.OS === 'android' && NativeModules.EmergencyNative
    ? NativeModules.EmergencyNative
    : {
        startMonitoring: () => missingModule('EmergencyNative'),
        stopMonitoring: () => missingModule('EmergencyNative'),
        cancelPendingReport: () => missingModule('EmergencyNative'),
        triggerDevEmergency: () => missingModule('EmergencyNative'),
        startSiren: () => missingModule('EmergencyNative'),
        stopSiren: () => missingModule('EmergencyNative'),
        loadAnalysisLogs: () => missingModule('EmergencyNative'),
        saveAnalysisLogs: () => missingModule('EmergencyNative'),
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
