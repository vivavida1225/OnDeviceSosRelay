import type {EmergencyAnalysis} from '../native/EmergencyNative';

export type AppMode =
  | 'idle'
  | 'warming'
  | 'monitoring'
  | 'analyzing'
  | 'countdown'
  | 'sent'
  | 'cancelled'
  | 'error';

export type EmergencyState = {
  mode: AppMode;
  countdown: number;
  analysisPass?: 'primary' | 'secondary';
  analysis?: EmergencyAnalysis;
  error?: string;
  lastSmsStatus?: string;
};

export type EmergencyAction =
  | {type: 'START_REQUESTED'}
  | {type: 'SERVICE_STATUS'; status: string}
  | {type: 'TRIGGER_DETECTED'}
  | {type: 'ANALYSIS_PASS_STARTED'; analysisPass: 'primary' | 'secondary'}
  | {type: 'ANALYSIS_RESULT'; analysis: EmergencyAnalysis}
  | {type: 'COUNTDOWN_TICK'}
  | {type: 'CANCEL_REPORT'}
  | {type: 'SMS_STATUS'; status: string}
  | {type: 'ERROR'; message: string}
  | {type: 'RESET'};

export const initialEmergencyState: EmergencyState = {
  mode: 'idle',
  countdown: 5,
};

export function emergencyReducer(
  state: EmergencyState,
  action: EmergencyAction,
): EmergencyState {
  switch (action.type) {
    case 'START_REQUESTED':
      return {...state, mode: 'warming', analysisPass: undefined, error: undefined};
    case 'SERVICE_STATUS':
      if (action.status === 'monitoring') {
        return {...state, mode: 'monitoring', countdown: 5, analysisPass: undefined, error: undefined};
      }
      if (action.status === 'analyzing') {
        return {...state, mode: 'analyzing'};
      }
      if (action.status === 'idle') {
        return initialEmergencyState;
      }
      return state;
    case 'TRIGGER_DETECTED':
      return {...state, mode: 'analyzing', analysisPass: 'primary'};
    case 'ANALYSIS_PASS_STARTED':
      return {...state, mode: 'analyzing', analysisPass: action.analysisPass};
    case 'ANALYSIS_RESULT':
      if (!action.analysis.is_emergency) {
        return {...state, mode: 'monitoring', analysisPass: undefined, analysis: action.analysis};
      }
      return {
        ...state,
        mode: 'countdown',
        countdown: 5,
        analysisPass: undefined,
        analysis: action.analysis,
      };
    case 'COUNTDOWN_TICK':
      return {...state, countdown: Math.max(0, state.countdown - 1)};
    case 'CANCEL_REPORT':
      return {...state, mode: 'cancelled', countdown: 5};
    case 'SMS_STATUS':
      return {...state, mode: 'sent', lastSmsStatus: action.status};
    case 'ERROR':
      return {...state, mode: 'error', error: action.message};
    case 'RESET':
      return initialEmergencyState;
  }
}
