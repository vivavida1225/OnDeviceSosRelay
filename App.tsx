import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  type LayoutChangeEvent,
  Modal,
  PanResponder,
  type PanResponderGestureState,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  useColorScheme,
  Vibration,
  View,
} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import {
  EmergencyNative,
  emergencyEvents,
  MlcGemmaNative,
  type AppSettings,
  type AudioLogEntry,
  type EmergencyAnalysis,
  type EmergencyLocation,
  type GemmaPromptTemplates,
  type MonitoringConfig,
  type RoutineLocation,
  type RoutePathPoint,
  type SafetyMode,
  type SafetyProfile,
  type SavedRoute,
  type SttEngine,
} from './src/native/EmergencyNative';
import {
  emergencyReducer,
  initialEmergencyState,
} from './src/state/emergencyState';
import {KAKAO_MAP_JAVASCRIPT_KEY} from './src/config/kakaoMap';

const DEFAULT_AUDIO_RMS_THRESHOLD = 0.35;
const DEFAULT_SENSOR_THRESHOLD = 28;
const DEFAULT_GYRO_THRESHOLD = 8;
const DEFAULT_PRE_TRIGGER_SECONDS = 10;
const DEFAULT_POST_TRIGGER_SECONDS = 7;
const DEFAULT_ROUTE_DEVIATION_DISTANCE_METERS = 50;
const DEFAULT_ROUTE_DEVIATION_DURATION_SECONDS = 20;
const MIN_ANALYSIS_WINDOW_SECONDS = 1;
const MAX_ANALYSIS_WINDOW_SECONDS = 30;
const MAX_SAVED_ROUTES = 5;
const STT_ENGINE_OFF: SttEngine = 'off';
const STT_ENGINE_ON: SttEngine = 'sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27';
type LocationPickerTarget = 'startLocation' | 'destinationLocation';
type RoutePickerMode = 'view' | 'edit';
type RouteCapturePhase = 'confirm' | 'collecting' | 'review';
type ManualRouteFlowPhase = 'idle' | 'start' | 'destination' | 'route';
type RoutePickerPurpose = 'manualCreate' | 'savedRouteEdit' | null;
type RouteScheduleKey = 'startHour' | 'startMinute' | 'destinationHour' | 'destinationMinute';
type RouteInfoDraft = Pick<SavedRoute, 'name' | RouteScheduleKey>;
type RouteDeviationStatus = {
  route_deviation: boolean;
  distance_meters?: number;
  threshold_meters?: number;
  duration_seconds?: number;
};
type LocationPickerAddressSelection = {
  type: 'addressSelected';
  address?: string;
  candidates?: string[];
};

const baseMonitoringConfig = {
  modelId: 'gemma-4-E4B-it',
};

const DEFAULT_CUSTOM_PROMPT = `기본 프롬프트를 사용합니다.
사용자가 설정한 트리거 이전/이후 오디오의 톤, 긴급성, 발화, 배경 소음만 근거로 판단하세요.
위급 상황 단서가 부족하면 보수적으로 false를 반환하세요.`;

const defaultSafetyProfile: SafetyProfile = {
  mode: null,
  birthday: '',
  gender: '',
  emergencyPhone: '',
  detailAddress: '',
  startLocation: null,
  destinationLocation: null,
  childRoutePath: [],
  savedRoutes: [],
  activeRouteId: '',
  startHour: '',
  startMinute: '',
  destinationHour: '',
  destinationMinute: '',
};
const defaultAppSettings: AppSettings = {
  sttEngine: STT_ENGINE_OFF,
  sirenEnabled: false,
  customPrompt: DEFAULT_CUSTOM_PROMPT,
  sensorThreshold: DEFAULT_SENSOR_THRESHOLD,
  gyroThreshold: DEFAULT_GYRO_THRESHOLD,
  audioRmsThreshold: DEFAULT_AUDIO_RMS_THRESHOLD,
  preTriggerSeconds: DEFAULT_PRE_TRIGGER_SECONDS,
  postTriggerSeconds: DEFAULT_POST_TRIGGER_SECONDS,
  routeDeviationDistanceMeters: DEFAULT_ROUTE_DEVIATION_DISTANCE_METERS,
  routeDeviationDurationSeconds: DEFAULT_ROUTE_DEVIATION_DURATION_SECONDS,
  safetyProfile: defaultSafetyProfile,
};
const DEADMAN_SIREN_DURATION_MS = 5000;

const emptyGemmaPromptTemplates: GemmaPromptTemplates = {
  system: '',
  primary: '',
  secondary: '',
};
type AnalysisLogEntry = Omit<EmergencyAnalysis, 'situation_summary' | 'stt_context_used'> & {
  id: string;
  createdAt: string;
};

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [state, dispatch] = useReducer(
    emergencyReducer,
    initialEmergencyState,
  );
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLogEntry[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [logsVisible, setLogsVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [promptEditorVisible, setPromptEditorVisible] = useState(false);
  const [profileEditorVisible, setProfileEditorVisible] = useState(false);
  const [audioLogsVisible, setAudioLogsVisible] = useState(false);
  const [audioLogs, setAudioLogs] = useState<AudioLogEntry[]>([]);
  const [playingAudioId, setPlayingAudioId] = useState<string>();
  const [sttEngine, setSttEngine] = useState<SttEngine>(defaultAppSettings.sttEngine);
  const [sirenEnabled, setSirenEnabled] = useState(defaultAppSettings.sirenEnabled);
  const [customPrompt, setCustomPrompt] = useState(defaultAppSettings.customPrompt);
  const [monitoringMode, setMonitoringMode] = useState<SafetyMode>('adult');
  const [promptEditorMode, setPromptEditorMode] = useState<SafetyMode>('adult');
  const [gemmaPromptDraft, setGemmaPromptDraft] = useState<GemmaPromptTemplates>(
    emptyGemmaPromptTemplates,
  );
  const [safetyProfile, setSafetyProfile] = useState<SafetyProfile>(defaultSafetyProfile);
  const [profileDraft, setProfileDraft] = useState<SafetyProfile>(defaultSafetyProfile);
  const [locationPickerTarget, setLocationPickerTarget] = useState<LocationPickerTarget | null>(null);
  const [routePickerVisible, setRoutePickerVisible] = useState(false);
  const [routePickerMode, setRoutePickerMode] = useState<RoutePickerMode>('edit');
  const [routePickerPurpose, setRoutePickerPurpose] = useState<RoutePickerPurpose>(null);
  const [editingSavedRouteId, setEditingSavedRouteId] = useState<string | null>(null);
  const [manualRouteFlowPhase, setManualRouteFlowPhase] = useState<ManualRouteFlowPhase>('idle');
  const [manualRouteInfoDraft, setManualRouteInfoDraft] = useState<RouteInfoDraft>(() =>
    createRouteInfoDraft(),
  );
  const [manualRouteInfoVisible, setManualRouteInfoVisible] = useState(false);
  const [pendingManualRoutePath, setPendingManualRoutePath] = useState<RoutePathPoint[]>([]);
  const [routeCaptureVisible, setRouteCaptureVisible] = useState(false);
  const [routeCapturePhase, setRouteCapturePhase] = useState<RouteCapturePhase>('confirm');
  const [routeCaptureStart, setRouteCaptureStart] = useState<RoutineLocation | null>(null);
  const [routeCaptureEnd, setRouteCaptureEnd] = useState<RoutineLocation | null>(null);
  const [routeCaptureWaypoints, setRouteCaptureWaypoints] = useState<RoutePathPoint[]>([]);
  const [routeCaptureInfoDraft, setRouteCaptureInfoDraft] = useState<RouteInfoDraft>(() =>
    createRouteInfoDraft(),
  );
  const [audioRmsThreshold, setAudioRmsThreshold] = useState(
    defaultAppSettings.audioRmsThreshold,
  );
  const [sensorThreshold, setSensorThreshold] = useState(
    defaultAppSettings.sensorThreshold,
  );
  const [gyroThreshold, setGyroThreshold] = useState(
    defaultAppSettings.gyroThreshold,
  );
  const [preTriggerSeconds, setPreTriggerSeconds] = useState(
    defaultAppSettings.preTriggerSeconds,
  );
  const [postTriggerSeconds, setPostTriggerSeconds] = useState(
    defaultAppSettings.postTriggerSeconds,
  );
  const [routeDeviationDistanceMeters, setRouteDeviationDistanceMeters] = useState(
    defaultAppSettings.routeDeviationDistanceMeters,
  );
  const [routeDeviationDurationSeconds, setRouteDeviationDurationSeconds] = useState(
    defaultAppSettings.routeDeviationDurationSeconds,
  );
  const [audioRmsThresholdInput, setAudioRmsThresholdInput] = useState(
    String(defaultAppSettings.audioRmsThreshold),
  );
  const [sensorThresholdInput, setSensorThresholdInput] = useState(
    String(defaultAppSettings.sensorThreshold),
  );
  const [gyroThresholdInput, setGyroThresholdInput] = useState(
    String(defaultAppSettings.gyroThreshold),
  );
  const [routeDeviationDistanceInput, setRouteDeviationDistanceInput] = useState(
    String(defaultAppSettings.routeDeviationDistanceMeters),
  );
  const [routeDeviationDurationInput, setRouteDeviationDurationInput] = useState(
    String(defaultAppSettings.routeDeviationDurationSeconds),
  );
  const [routeDeviationStatus, setRouteDeviationStatus] = useState<RouteDeviationStatus | null>(null);
  const [routeStatusVisible, setRouteStatusVisible] = useState(false);
  const [routeStatusLocation, setRouteStatusLocation] = useState<EmergencyLocation | null>(null);
  const [routeStatusMapVersion, setRouteStatusMapVersion] = useState(0);
  const [routeStatusMapStatusText, setRouteStatusMapStatusText] = useState('경로 일치');
  const routeStatusWebViewRef = useRef<WebView>(null);
  const smsSentForAnalysis = useRef<EmergencyAnalysis | undefined>(undefined);
  const lastBackPressAt = useRef(0);
  const profileDraftRef = useRef<SafetyProfile>(defaultSafetyProfile);
  const locationPickerWebViewRef = useRef<WebView>(null);

  useEffect(() => {
    profileDraftRef.current = profileDraft;
  }, [profileDraft]);

  useEffect(() => {
    EmergencyNative.loadAnalysisLogs()
      .then(logsJson => {
        const logs = JSON.parse(logsJson);
        if (Array.isArray(logs)) {
          setAnalysisLogs(
            logs
              .map(log => omitUnusedAnalysisLogFields(log) as AnalysisLogEntry)
              .slice(0, 10),
          );
        }
      })
      .catch(error => {
        console.warn('[EmergencyDebug] loadAnalysisLogs failed', error);
      });
  }, []);

  useEffect(() => {
    EmergencyNative.loadAppSettings()
      .then(settingsJson => {
        const parsed = JSON.parse(settingsJson) as Partial<AppSettings>;
        const nextSettings = normalizeAppSettings(parsed);
        setSttEngine(nextSettings.sttEngine);
        setSirenEnabled(nextSettings.sirenEnabled);
        setCustomPrompt(nextSettings.customPrompt);
        setSensorThreshold(nextSettings.sensorThreshold);
        setGyroThreshold(nextSettings.gyroThreshold);
        setAudioRmsThreshold(nextSettings.audioRmsThreshold);
        setPreTriggerSeconds(nextSettings.preTriggerSeconds);
        setPostTriggerSeconds(nextSettings.postTriggerSeconds);
        setRouteDeviationDistanceMeters(nextSettings.routeDeviationDistanceMeters);
        setRouteDeviationDurationSeconds(nextSettings.routeDeviationDurationSeconds);
        setAudioRmsThresholdInput(String(nextSettings.audioRmsThreshold));
        setSensorThresholdInput(String(nextSettings.sensorThreshold));
        setGyroThresholdInput(String(nextSettings.gyroThreshold));
        setRouteDeviationDistanceInput(String(nextSettings.routeDeviationDistanceMeters));
        setRouteDeviationDurationInput(String(nextSettings.routeDeviationDurationSeconds));
        setSafetyProfile(nextSettings.safetyProfile);
        setProfileDraft(nextSettings.safetyProfile);
        setMonitoringMode(nextSettings.safetyProfile.mode ?? 'adult');
        setPromptEditorMode(nextSettings.safetyProfile.mode ?? 'adult');
        setSettingsLoaded(true);
      })
      .catch(error => {
        console.warn('[EmergencyDebug] loadAppSettings failed', error);
        setSafetyProfile(defaultSafetyProfile);
        setProfileDraft(defaultSafetyProfile);
        setMonitoringMode('adult');
        setPromptEditorMode('adult');
        setSettingsLoaded(true);
      });
  }, []);

  const appendAnalysisLog = useCallback((event: EmergencyAnalysis) => {
    setAnalysisLogs(logs => {
      const logEvent = omitUnusedAnalysisLogFields(event);
      const nextLogs = [
        {
          ...logEvent,
          id: `${Date.now()}-${logs.length}`,
          createdAt: new Date().toLocaleString(),
        },
        ...logs,
      ].slice(0, 10);

      EmergencyNative.saveAnalysisLogs(JSON.stringify(nextLogs)).catch(error => {
        console.warn('[EmergencyDebug] saveAnalysisLogs failed', error);
      });

      return nextLogs;
    });
  }, []);

  useEffect(() => {
    if (!emergencyEvents) {
      return;
    }

    const subscriptions = [
      emergencyEvents.addListener('serviceStatus', event => {
        console.log('[EmergencyDebug] serviceStatus', event);
        dispatch({type: 'SERVICE_STATUS', status: event.status});
      }),
      emergencyEvents.addListener('triggerDetected', event => {
        console.log('[EmergencyDebug] triggerDetected', event);
        dispatch({type: 'TRIGGER_DETECTED'});
      }),
      emergencyEvents.addListener('analysisLog', event => {
        console.log('[EmergencyDebug] analysisLog', event);
        appendAnalysisLog(event);
      }),
      emergencyEvents.addListener('analysisResult', event => {
        console.log('[EmergencyDebug] analysisResult', event);
        dispatch({
          type: 'ANALYSIS_RESULT',
          analysis: event,
        });
      }),
      emergencyEvents.addListener('analysisDebug', event => {
        console.log(`[EmergencyDebug] ${event.stage}`, event);
        if (event.stage === 'primary_ai_started') {
          dispatch({type: 'ANALYSIS_PASS_STARTED', analysisPass: 'primary'});
        }
        if (event.stage === 'secondary_ai_started') {
          dispatch({type: 'ANALYSIS_PASS_STARTED', analysisPass: 'secondary'});
        }
      }),
      emergencyEvents.addListener('smsStatus', event => {
        console.log('[EmergencyDebug] smsStatus', event);
        dispatch({type: 'SMS_STATUS', status: event.status});
      }),
      emergencyEvents.addListener('routeCaptureUpdate', event => {
        console.log('[RouteCapture]', event);
        const start = normalizeRoutineLocation(event.start);
        const end = normalizeRoutineLocation(event.end);
        if (start) {
          setRouteCaptureStart(start);
        }
        if (end) {
          setRouteCaptureEnd(end);
        }
        setRouteCaptureWaypoints(normalizeRoutePath(event.waypoints));
      }),
      emergencyEvents.addListener('routeDeviationStatus', event => {
        console.log('[RouteDeviation]', event);
        setRouteDeviationStatus({
          route_deviation: Boolean(event.route_deviation),
          distance_meters:
            typeof event.distance_meters === 'number' ? event.distance_meters : undefined,
          threshold_meters:
            typeof event.threshold_meters === 'number' ? event.threshold_meters : undefined,
          duration_seconds:
            typeof event.duration_seconds === 'number' ? event.duration_seconds : undefined,
        });
      }),
      emergencyEvents.addListener('nativeError', event => {
        console.warn('[EmergencyDebug] nativeError', event);
        dispatch({
          type: 'ERROR',
          message: event.message ?? 'Native module error',
        });
      }),
    ];

    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [appendAnalysisLog]);
  useEffect(() => {
    if (state.mode !== 'countdown') {
      return;
    }

    Vibration.vibrate([0, 500, 200, 500], true);
    if (sirenEnabled) {
      EmergencyNative.startSiren(DEADMAN_SIREN_DURATION_MS).catch(error => {
        console.warn('[EmergencyDebug] startSiren failed', error);
      });
    }
    return () => {
      Vibration.cancel();
      EmergencyNative.stopSiren().catch(() => undefined);
    };
  }, [sirenEnabled, state.mode]);

  useEffect(() => {
    if (state.mode !== 'countdown') {
      return;
    }

    if (state.countdown > 0) {
      const timeoutId = setTimeout(() => {
        dispatch({type: 'COUNTDOWN_TICK'});
      }, 1000);
      return () => clearTimeout(timeoutId);
    }

    if (state.analysis && smsSentForAnalysis.current !== state.analysis) {
      smsSentForAnalysis.current = state.analysis;
      const destination = normalizePhoneNumber(safetyProfile.emergencyPhone);
      if (!destination) {
        dispatch({
          type: 'ERROR',
          message: '비상 전화번호가 등록되어 있지 않습니다.',
        });
        return;
      }
      EmergencyNative.sendEmergencySms({
        destination,
        situation_summary:
          formatAnalysisSummary(state.analysis) ?? '위급 상황이 감지되었습니다.',
        location: state.analysis.location,
      }).catch(error => {
        dispatch({
          type: 'ERROR',
          message: error?.message ?? 'SMS 전송에 실패했습니다.',
        });
      });
    }
  }, [safetyProfile.emergencyPhone, state.analysis, state.countdown, state.mode]);

  const saveSettings = useCallback(async (nextSettings: AppSettings) => {
    await EmergencyNative.saveAppSettings(JSON.stringify(nextSettings));
  }, []);

  const buildMonitoringConfig = useCallback(
    (overrides: Partial<MonitoringConfig> = {}): MonitoringConfig => {
      const routePath = safetyProfile.childRoutePath.length >= 2 ? safetyProfile.childRoutePath : [];
      return {
        ...baseMonitoringConfig,
        sensorThreshold,
        gyroThreshold,
        audioRmsThreshold,
        preTriggerSeconds,
        postTriggerSeconds,
        routeDeviationDistanceMeters,
        routeDeviationDurationSeconds,
        routePath,
        sttEnabled: sttEngine !== STT_ENGINE_OFF,
        sttEngine,
        monitoringMode,
        customPrompt,
        ...overrides,
      };
    },
    [
      audioRmsThreshold,
      customPrompt,
      gyroThreshold,
      monitoringMode,
      postTriggerSeconds,
      preTriggerSeconds,
      routeDeviationDistanceMeters,
      routeDeviationDurationSeconds,
      safetyProfile.childRoutePath,
      sensorThreshold,
      sttEngine,
    ],
  );

  const refreshAudioLogs = useCallback(async () => {
    try {
      const logsJson = await EmergencyNative.loadAudioLogs();
      const logs = JSON.parse(logsJson);
      setAudioLogs(Array.isArray(logs) ? logs.slice(0, 10) : []);
    } catch (error) {
      console.warn('[EmergencyDebug] loadAudioLogs failed', error);
      setAudioLogs([]);
    }
  }, []);

  const openAudioLogs = useCallback(async () => {
    setMenuVisible(false);
    await refreshAudioLogs();
    setAudioLogsVisible(true);
  }, [refreshAudioLogs]);

  const playAudioLog = useCallback(async (id: string) => {
    const started = await EmergencyNative.playAudioLog(id);
    setPlayingAudioId(started ? id : undefined);
  }, []);

  const stopAudioLog = useCallback(async () => {
    await EmergencyNative.stopAudioLog();
    setPlayingAudioId(undefined);
  }, []);

  const loadGemmaPromptDraft = useCallback(async (mode: SafetyMode) => {
    const promptsJson = await EmergencyNative.loadGemmaPrompts(mode);
    const parsed = JSON.parse(promptsJson) as GemmaPromptTemplates;
    setGemmaPromptDraft({
      system: parsed.system ?? '',
      primary: parsed.primary ?? '',
      secondary: parsed.secondary ?? '',
    });
  }, []);

  const openGemmaPromptEditor = useCallback(async () => {
    setMenuVisible(false);
    setSettingsVisible(false);
    const nextMode = safetyProfile.mode ?? monitoringMode;
    setPromptEditorMode(nextMode);
    try {
      await loadGemmaPromptDraft(nextMode);
      setPromptEditorVisible(true);
    } catch (error) {
      Alert.alert(
        '\uD504\uB86C\uD504\uD2B8 \uB85C\uB4DC \uC2E4\uD328',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [loadGemmaPromptDraft, monitoringMode, safetyProfile.mode]);

  const updateGemmaPromptDraft = useCallback(
    (key: keyof GemmaPromptTemplates, value: string) => {
      setGemmaPromptDraft(current => ({...current, [key]: value}));
    },
    [],
  );

  const changePromptEditorMode = useCallback(
    async (nextMode: SafetyMode) => {
      setPromptEditorMode(nextMode);
      try {
        await loadGemmaPromptDraft(nextMode);
      } catch (error) {
        Alert.alert(
          '\uD504\uB86C\uD504\uD2B8 \uB85C\uB4DC \uC2E4\uD328',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [loadGemmaPromptDraft],
  );

  const saveGemmaPrompts = useCallback(async () => {
    try {
      await EmergencyNative.saveGemmaPrompts(promptEditorMode, JSON.stringify(gemmaPromptDraft));
      setPromptEditorVisible(false);
    } catch (error) {
      Alert.alert(
        '\uD504\uB86C\uD504\uD2B8 \uC800\uC7A5 \uC2E4\uD328',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [gemmaPromptDraft, promptEditorMode]);

  const resetGemmaPrompts = useCallback(async () => {
    try {
      const promptsJson = await EmergencyNative.resetGemmaPrompts(promptEditorMode);
      const parsed = JSON.parse(promptsJson) as GemmaPromptTemplates;
      setGemmaPromptDraft({
        system: parsed.system ?? '',
        primary: parsed.primary ?? '',
        secondary: parsed.secondary ?? '',
      });
    } catch (error) {
      Alert.alert(
        '\uD504\uB86C\uD504\uD2B8 \uC6D0\uBCF5 \uC2E4\uD328',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [promptEditorMode]);
  const updateProfileDraft = useCallback(
    <K extends keyof SafetyProfile>(key: K, value: SafetyProfile[K]) => {
      setProfileDraft(current => ({...current, [key]: value}));
      if (key === 'mode' && (value === 'child' || value === 'adult')) {
        setMonitoringMode(value);
      }
    },
    [],
  );

  const openLocationPicker = useCallback((target: LocationPickerTarget) => {
    if (!isKakaoKeyConfigured(KAKAO_MAP_JAVASCRIPT_KEY)) {
      Alert.alert(
        '카카오맵 JavaScript 키 필요',
        'src/config/kakaoMap.ts의 KAKAO_MAP_JAVASCRIPT_KEY 값을 실제 키로 변경해 주세요.',
      );
      return;
    }

    setLocationPickerTarget(target);
  }, []);

  const openManualRouteFlow = useCallback(() => {
    if (!isKakaoKeyConfigured(KAKAO_MAP_JAVASCRIPT_KEY)) {
      Alert.alert(
        '카카오맵 JavaScript 키 필요',
        'src/config/kakaoMap.ts의 KAKAO_MAP_JAVASCRIPT_KEY 값을 실제 키로 변경해 주세요.',
      );
      return;
    }

    console.log('[ManualRouteFlow] open');
    setManualRouteInfoDraft(createRouteInfoDraft(`수동 경로 ${profileDraftRef.current.savedRoutes.length + 1}`));
    setManualRouteInfoVisible(false);
    setPendingManualRoutePath([]);
    setRoutePickerPurpose('manualCreate');
    setEditingSavedRouteId(null);
    setManualRouteFlowPhase('start');
    setRoutePickerMode('edit');
    setProfileDraft(current => ({
      ...current,
      startLocation: null,
      destinationLocation: null,
      childRoutePath: [],
    }));
    setLocationPickerTarget('startLocation');
  }, []);

  const closeLocationPicker = useCallback(() => {
    setLocationPickerTarget(null);
    if (manualRouteFlowPhase !== 'idle') {
      setManualRouteFlowPhase('idle');
    }
  }, []);

  const injectLocationPickerGeocodeResult = useCallback(
    (payload: {address?: string; latitude?: number; longitude?: number; error?: string}) => {
      locationPickerWebViewRef.current?.injectJavaScript(
        `window.renderNativeGeocodeResult && window.renderNativeGeocodeResult(${JSON.stringify(payload)}); true;`,
      );
    },
    [],
  );

  const geocodeLocationPickerAddress = useCallback(
    async (candidates: string[]) => {
      const uniqueCandidates = Array.from(
        new Set(candidates.map(candidate => candidate.trim()).filter(Boolean)),
      );

      if (uniqueCandidates.length === 0) {
        injectLocationPickerGeocodeResult({
          error: '선택한 주소가 비어 있습니다. 다른 주소를 선택해 주세요.',
        });
        return;
      }

      for (const candidate of uniqueCandidates) {
        try {
          console.log('[LocationPicker] nativeGeocode request', candidate);
          const result = await EmergencyNative.geocodeAddress(candidate);
          console.log('[LocationPicker] nativeGeocode response', candidate, result);
          if (
            result &&
            typeof result.latitude === 'number' &&
            typeof result.longitude === 'number' &&
            Number.isFinite(result.latitude) &&
            Number.isFinite(result.longitude)
          ) {
            injectLocationPickerGeocodeResult({
              address: candidate,
              latitude: result.latitude,
              longitude: result.longitude,
            });
            return;
          }
        } catch (error) {
          console.warn('[LocationPicker] nativeGeocode failed', candidate, error);
        }
      }

      injectLocationPickerGeocodeResult({
        error: '선택한 주소의 좌표를 찾지 못했습니다. 더 구체적인 주소 결과를 선택해 주세요.',
      });
    },
    [injectLocationPickerGeocodeResult],
  );

  const handleLocationPickerMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!locationPickerTarget) {
        return;
      }

      try {
        const payload = JSON.parse(event.nativeEvent.data) as
          | (RoutineLocation & {type?: 'location'})
          | LocationPickerAddressSelection
          | {type: 'locationPickerDebug'; message: string}
          | {type: 'close'}
          | {error?: string};
        if ('type' in payload && payload.type === 'locationPickerDebug') {
          console.log('[LocationPicker]', payload.message);
          return;
        }

        if ('type' in payload && payload.type === 'close') {
          setLocationPickerTarget(null);
          if (manualRouteFlowPhase !== 'idle') {
            setManualRouteFlowPhase('idle');
          }
          return;
        }

        if ('type' in payload && payload.type === 'addressSelected') {
          geocodeLocationPickerAddress([
            ...(Array.isArray(payload.candidates) ? payload.candidates : []),
            typeof payload.address === 'string' ? payload.address : '',
          ]);
          return;
        }

        if ('error' in payload && payload.error) {
          Alert.alert('\uC704\uCE58 \uC120\uD0DD \uC2E4\uD328', payload.error);
          return;
        }

        if (
          typeof (payload as RoutineLocation).latitude !== 'number' ||
          typeof (payload as RoutineLocation).longitude !== 'number' ||
          !(payload as RoutineLocation).address
        ) {
          Alert.alert('\uC704\uCE58 \uC120\uD0DD \uC2E4\uD328', '\uC8FC\uC18C \uC88C\uD45C \uC751\uB2F5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.');
          return;
        }

        const nextLocation = {
          latitude: (payload as RoutineLocation).latitude,
          longitude: (payload as RoutineLocation).longitude,
          address: (payload as RoutineLocation).address,
        };
        if (manualRouteFlowPhase === 'start' && locationPickerTarget === 'startLocation') {
          console.log('[ManualRouteFlow] start selected', nextLocation);
          setProfileDraft(current => ({
            ...current,
            startLocation: nextLocation,
            destinationLocation: null,
            childRoutePath: [],
          }));
          setLocationPickerTarget(null);
          setManualRouteFlowPhase('destination');
          setTimeout(() => setLocationPickerTarget('destinationLocation'), 0);
          return;
        }

        if (manualRouteFlowPhase === 'destination' && locationPickerTarget === 'destinationLocation') {
          console.log('[ManualRouteFlow] destination selected', nextLocation);
          setProfileDraft(current => ({
            ...current,
            destinationLocation: nextLocation,
            childRoutePath: [],
          }));
          setLocationPickerTarget(null);
          setManualRouteFlowPhase('route');
          setRoutePickerMode('edit');
          setRoutePickerVisible(true);
          return;
        }

        setProfileDraft(current => ({
          ...current,
          [locationPickerTarget]: nextLocation,
          childRoutePath: [],
        }));
        setLocationPickerTarget(null);
      } catch (error) {
        Alert.alert(
          '\uC704\uCE58 \uC120\uD0DD \uC2E4\uD328',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [geocodeLocationPickerAddress, locationPickerTarget, manualRouteFlowPhase],
  );

  const handleRoutePickerMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as
        | {type: 'route'; childRoutePath?: RoutePathPoint[]}
        | {type: 'editRoute'}
        | {error?: string};
      if ('error' in payload && payload.error) {
        Alert.alert('\uACBD\uB85C \uC800\uC7A5 \uC2E4\uD328', payload.error);
        return;
      }

      if ('type' in payload && payload.type === 'editRoute') {
        setRoutePickerMode('edit');
        return;
      }

      if (!('type' in payload) || payload.type !== 'route' || !Array.isArray(payload.childRoutePath)) {
        Alert.alert('\uACBD\uB85C \uC800\uC7A5 \uC2E4\uD328', '\uACBD\uB85C \uC88C\uD45C \uC751\uB2F5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.');
        return;
      }
      const nextRoutePath = payload.childRoutePath;

      if (routePickerPurpose === 'savedRouteEdit' && editingSavedRouteId) {
        console.log('[SavedRouteEditor] waypoint save requested', {
          routeId: editingSavedRouteId,
          routePointCount: nextRoutePath.length,
        });
        setProfileDraft(current =>
          updateSavedRouteInProfile(current, editingSavedRouteId, {
            waypoints: nextRoutePath,
          }),
        );
        setEditingSavedRouteId(null);
        setRoutePickerPurpose(null);
        setRoutePickerVisible(false);
        return;
      }

      const latestProfileDraft = profileDraftRef.current;
      console.log('[ManualRouteFlow] route save requested', {
        phase: manualRouteFlowPhase,
        routePointCount: nextRoutePath.length,
        hasStartLocation: Boolean(latestProfileDraft.startLocation),
        hasDestinationLocation: Boolean(latestProfileDraft.destinationLocation),
        savedRouteCount: latestProfileDraft.savedRoutes.length,
      });

      if (!latestProfileDraft.startLocation || !latestProfileDraft.destinationLocation) {
        console.warn('[ManualRouteFlow] route save blocked: missing endpoint', {
          phase: manualRouteFlowPhase,
          startLocation: latestProfileDraft.startLocation,
          destinationLocation: latestProfileDraft.destinationLocation,
        });
        Alert.alert('경로 저장 실패', '출발지와 도착지를 먼저 선택해 주세요.');
        return;
      }
      if (latestProfileDraft.savedRoutes.length >= MAX_SAVED_ROUTES) {
        Alert.alert('경로 저장 한도', '저장 가능한 경로는 최대 5개입니다.');
        return;
      }

      setPendingManualRoutePath(nextRoutePath);
      setProfileDraft(current => ({
        ...current,
        childRoutePath: nextRoutePath,
      }));
      setRoutePickerVisible(false);
      setManualRouteInfoVisible(true);
    } catch (error) {
      Alert.alert(
        '\uACBD\uB85C \uC800\uC7A5 \uC2E4\uD328',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [editingSavedRouteId, manualRouteFlowPhase, routePickerPurpose]);

  const saveManualRouteInfo = useCallback(() => {
    const latestProfileDraft = profileDraftRef.current;
    if (!latestProfileDraft.startLocation || !latestProfileDraft.destinationLocation) {
      Alert.alert('경로 저장 실패', '출발지와 도착지를 먼저 선택해 주세요.');
      return;
    }
    if (latestProfileDraft.savedRoutes.length >= MAX_SAVED_ROUTES) {
      Alert.alert('경로 저장 한도', '저장 가능한 경로는 최대 5개입니다.');
      return;
    }
    if (pendingManualRoutePath.length < 2) {
      Alert.alert('경로 저장 실패', '저장하려면 경로 지점을 2개 이상 선택해 주세요.');
      return;
    }

    const routeInfo = normalizeRouteInfoDraft(
      manualRouteInfoDraft,
      `수동 경로 ${latestProfileDraft.savedRoutes.length + 1}`,
    );
    const nextRoute: SavedRoute = {
      id: createRouteId(),
      ...routeInfo,
      isActive: true,
      start: latestProfileDraft.startLocation,
      end: latestProfileDraft.destinationLocation,
      waypoints: pendingManualRoutePath,
    };
    console.log('[ManualRouteFlow] route save accepted', {
      routeId: nextRoute.id,
      routePointCount: nextRoute.waypoints.length,
    });
    setProfileDraft(current => addSavedRouteToProfile(current, nextRoute));
    setManualRouteFlowPhase('idle');
    setRoutePickerPurpose(null);
    setManualRouteInfoVisible(false);
    setPendingManualRoutePath([]);
  }, [manualRouteInfoDraft, pendingManualRoutePath]);

  const cancelManualRouteInfo = useCallback(() => {
    setManualRouteInfoVisible(false);
    if (routePickerPurpose === 'manualCreate' && manualRouteFlowPhase === 'route') {
      setRoutePickerMode('edit');
      setRoutePickerVisible(true);
    }
  }, [manualRouteFlowPhase, routePickerPurpose]);

  const isMonitoring =
    state.mode === 'warming' ||
    state.mode === 'monitoring' ||
    state.mode === 'analyzing' ||
    state.mode === 'countdown';

  const canStop =
    state.mode === 'monitoring' ||
    state.mode === 'analyzing' ||
    state.mode === 'countdown';

  const saveSafetyProfile = useCallback(async () => {
    if (!profileDraft.mode) {
      Alert.alert('모드 선택 필요', '유아 모드 또는 성인 모드를 선택해 주세요.');
      return;
    }

    const nextProfile = normalizeSafetyProfile({
      ...profileDraft,
      birthday: profileDraft.birthday.trim(),
      gender: profileDraft.gender.trim(),
      detailAddress: profileDraft.detailAddress.trim(),
      emergencyPhone: normalizePhoneNumber(profileDraft.emergencyPhone),
      startHour: profileDraft.startHour.trim(),
      startMinute: profileDraft.startMinute.trim(),
      destinationHour: profileDraft.destinationHour.trim(),
      destinationMinute: profileDraft.destinationMinute.trim(),
      savedRoutes: profileDraft.savedRoutes.map(route => ({
        ...route,
        ...normalizeRouteInfoDraft(route, route.name),
      })),
    });
    if (!nextProfile.birthday || !parseBirthday(nextProfile.birthday)) {
      Alert.alert('생일 입력 필요', '유효한 생일을 입력해 주세요.');
      return;
    }
    if (!nextProfile.emergencyPhone) {
      Alert.alert('비상 전화번호 입력 필요', '비상 전화번호를 입력해 주세요.');
      return;
    }
    if (!nextProfile.detailAddress) {
      Alert.alert('상세 주소 입력 필요', '상세 주소를 입력해 주세요.');
      return;
    }
    setSafetyProfile(nextProfile);
    setProfileDraft(nextProfile);
    setMonitoringMode(nextProfile.mode ?? 'adult');
    await saveSettings({
      sttEngine,
      sirenEnabled,
      customPrompt,
      sensorThreshold,
      gyroThreshold,
      audioRmsThreshold,
      preTriggerSeconds,
      postTriggerSeconds,
      routeDeviationDistanceMeters,
      routeDeviationDurationSeconds,
      safetyProfile: nextProfile,
    });
    if (isMonitoring) {
      try {
        setRouteDeviationStatus(null);
        await EmergencyNative.startMonitoring(
          buildMonitoringConfig({
            monitoringMode: nextProfile.mode ?? 'adult',
            routePath: nextProfile.childRoutePath.length >= 2 ? nextProfile.childRoutePath : [],
          }),
        );
      } catch (error) {
        console.warn('[RouteDeviation] saveSafetyProfile route refresh failed', error);
      }
    }
    setProfileEditorVisible(false);
  }, [audioRmsThreshold, buildMonitoringConfig, customPrompt, gyroThreshold, isMonitoring, postTriggerSeconds, preTriggerSeconds, profileDraft, routeDeviationDistanceMeters, routeDeviationDurationSeconds, saveSettings, sensorThreshold, sirenEnabled, sttEngine]);
  const startMonitoring = useCallback(async () => {
    try {
      setRouteDeviationStatus(null);
      dispatch({type: 'START_REQUESTED'});
      await requestAndroidPermissions();
      const config = buildMonitoringConfig();
      const warmUpStatus = await MlcGemmaNative.warmUp(config.modelId);
      console.log('[EmergencyDebug] warmUp', warmUpStatus);
      await EmergencyNative.startMonitoring(config);
    } catch (error) {
      dispatch({
        type: 'ERROR',
        message: error instanceof Error ? error.message : '시작 실패',
      });
    }
  }, [buildMonitoringConfig]);

  const stopMonitoring = useCallback(async () => {
    await EmergencyNative.stopMonitoring();
    setRouteDeviationStatus(null);
    setRouteStatusVisible(false);
    setRouteStatusLocation(null);
    dispatch({type: 'RESET'});
  }, []);

  const cancelReport = useCallback(async () => {
    Vibration.cancel();
    await EmergencyNative.stopSiren();
    smsSentForAnalysis.current = undefined;
    await EmergencyNative.cancelPendingReport();
    dispatch({type: 'CANCEL_REPORT'});
    setTimeout(() => dispatch({type: 'RESET'}), 500);
  }, []);

  const closeProfileEditor = useCallback(() => {
    setProfileDraft(safetyProfile);
    setMonitoringMode(safetyProfile.mode ?? 'adult');
    setProfileEditorVisible(false);
  }, [safetyProfile]);

  const closeAudioLogs = useCallback(() => {
    stopAudioLog().catch(() => undefined);
    setAudioLogsVisible(false);
  }, [stopAudioLog]);

  const closeRoutePicker = useCallback(() => {
    setRoutePickerVisible(false);
    setRoutePickerMode('edit');
    setRoutePickerPurpose(null);
    setEditingSavedRouteId(null);
    setManualRouteInfoVisible(false);
    setPendingManualRoutePath([]);
    if (manualRouteFlowPhase === 'route') {
      setManualRouteFlowPhase('idle');
    }
  }, [manualRouteFlowPhase]);

  const closeRouteAutoCapture = useCallback(async () => {
    if (routeCapturePhase === 'collecting') {
      await EmergencyNative.stopRouteCapture().catch(() => undefined);
    }
    setRouteCaptureVisible(false);
    setRouteCapturePhase('confirm');
    setRouteCaptureStart(null);
    setRouteCaptureEnd(null);
    setRouteCaptureWaypoints([]);
    setRouteCaptureInfoDraft(createRouteInfoDraft());
  }, [routeCapturePhase]);

  const openRouteAutoCapture = useCallback(async () => {
    if (!isKakaoKeyConfigured(KAKAO_MAP_JAVASCRIPT_KEY)) {
      Alert.alert(
        '카카오맵 JavaScript 키 필요',
        'src/config/kakaoMap.ts의 KAKAO_MAP_JAVASCRIPT_KEY 값을 실제 키로 변경해 주세요.',
      );
      return;
    }

    try {
      await requestAndroidLocationPermissions();
      const currentLocation = await EmergencyNative.getCurrentLocation();
      const startLocation = routePointToRoutineLocation(
        currentLocation,
        '자동 수집 출발지',
      );
      setRouteCaptureInfoDraft(createRouteInfoDraft(`자동 경로 ${profileDraft.savedRoutes.length + 1}`));
      setRouteCaptureStart(startLocation);
      setRouteCaptureEnd(null);
      setRouteCaptureWaypoints([currentLocation]);
      setRouteCapturePhase('confirm');
      setRouteCaptureVisible(true);
    } catch (error) {
      Alert.alert(
        '현재 위치 확인 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [profileDraft.savedRoutes.length]);

  const startRouteAutoCapture = useCallback(async () => {
    if (!routeCaptureStart) {
      return;
    }
    try {
      await EmergencyNative.startRouteCapture(routeCaptureStart);
      setRouteCaptureWaypoints([routeCaptureStart]);
      setRouteCapturePhase('collecting');
    } catch (error) {
      Alert.alert(
        '경로 자동 수집 시작 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [routeCaptureStart]);

  const stopRouteAutoCapture = useCallback(async () => {
    try {
      const result = await EmergencyNative.stopRouteCapture();
      const startLocation = routePointToRoutineLocation(result.start, '자동 수집 출발지');
      const endLocation = routePointToRoutineLocation(result.end, '자동 수집 목적지');
      setRouteCaptureStart(startLocation);
      setRouteCaptureEnd(endLocation);
      setRouteCaptureWaypoints(normalizeRoutePath(result.waypoints));
      setRouteCapturePhase('review');
    } catch (error) {
      Alert.alert(
        '경로 자동 수집 종료 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [profileDraft.destinationLocation, profileDraft.savedRoutes.length, profileDraft.startLocation]);

  const handleRouteAutoCaptureMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as
        | {type: 'routeEdited'; waypoints?: RoutePathPoint[]; end?: RoutePathPoint}
        | {type: 'routeStartAdjusted'; start?: RoutePathPoint}
        | {error?: string};
      if ('error' in payload && payload.error) {
        Alert.alert('경로 편집 오류', payload.error);
        return;
      }
      if ('type' in payload && payload.type === 'routeStartAdjusted' && payload.start) {
        const startLocation = routePointToRoutineLocation(payload.start, '자동 수집 출발지');
        setRouteCaptureStart(startLocation);
        setRouteCaptureWaypoints([payload.start]);
        return;
      }
      if ('type' in payload && payload.type === 'routeEdited') {
        setRouteCaptureWaypoints(normalizeRoutePath(payload.waypoints));
        if (payload.end) {
          setRouteCaptureEnd(routePointToRoutineLocation(payload.end, '자동 수집 목적지'));
        }
      }
    } catch (error) {
      Alert.alert(
        '경로 편집 오류',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const saveAutoCapturedRoute = useCallback(() => {
    if (!routeCaptureStart || !routeCaptureEnd) {
      Alert.alert('경로 저장 실패', '출발지와 도착지 좌표가 필요합니다.');
      return;
    }
    if (profileDraft.savedRoutes.length >= MAX_SAVED_ROUTES) {
      Alert.alert('경로 저장 한도', '저장 가능한 경로는 최대 5개입니다.');
      return;
    }

    const routeInfo = normalizeRouteInfoDraft(
      routeCaptureInfoDraft,
      `자동 경로 ${profileDraft.savedRoutes.length + 1}`,
    );
    const nextRoute: SavedRoute = {
      id: createRouteId(),
      ...routeInfo,
      isActive: true,
      start: routeCaptureStart,
      end: routeCaptureEnd,
      waypoints: routeCaptureWaypoints,
    };

    setProfileDraft(current => addSavedRouteToProfile(current, nextRoute));
    setRouteCaptureVisible(false);
    setRouteCapturePhase('confirm');
    setRouteCaptureInfoDraft(createRouteInfoDraft());
  }, [
    profileDraft.savedRoutes.length,
    routeCaptureEnd,
    routeCaptureInfoDraft,
    routeCaptureStart,
    routeCaptureWaypoints,
  ]);

  const handleRouteBack = useCallback(() => {
    if (
      routePickerPurpose !== 'savedRouteEdit' &&
      routePickerMode === 'edit' &&
      profileDraft.childRoutePath.length > 0
    ) {
      setRoutePickerMode('view');
      return;
    }
    closeRoutePicker();
  }, [closeRoutePicker, profileDraft.childRoutePath.length, routePickerMode, routePickerPurpose]);

  const handleHardwareBack = useCallback(() => {
    if (locationPickerTarget) {
      closeLocationPicker();
      return true;
    }
    if (routePickerVisible) {
      handleRouteBack();
      return true;
    }
    if (manualRouteInfoVisible) {
      cancelManualRouteInfo();
      return true;
    }
    if (routeCaptureVisible) {
      closeRouteAutoCapture().catch(() => undefined);
      return true;
    }
    if (promptEditorVisible) {
      setPromptEditorVisible(false);
      return true;
    }
    if (profileEditorVisible) {
      closeProfileEditor();
      return true;
    }
    if (audioLogsVisible) {
      closeAudioLogs();
      return true;
    }
    if (logsVisible) {
      setLogsVisible(false);
      return true;
    }
    if (settingsVisible) {
      setSettingsVisible(false);
      return true;
    }
    if (menuVisible) {
      setMenuVisible(false);
      return true;
    }
    if (state.mode === 'countdown') {
      cancelReport().catch(() => undefined);
      return true;
    }

    const now = Date.now();
    if (now - lastBackPressAt.current < 2000) {
      BackHandler.exitApp();
      return true;
    }
    lastBackPressAt.current = now;
    ToastAndroid.show('\uD55C \uBC88 \uB354 \uB204\uB974\uBA74 \uC571\uC774 \uC885\uB8CC\uB429\uB2C8\uB2E4.', ToastAndroid.SHORT);
    return true;
  }, [
    audioLogsVisible,
    cancelReport,
    closeAudioLogs,
    closeLocationPicker,
    closeProfileEditor,
    closeRouteAutoCapture,
    cancelManualRouteInfo,
    handleRouteBack,
    locationPickerTarget,
    logsVisible,
    manualRouteInfoVisible,
    menuVisible,
    profileEditorVisible,
    promptEditorVisible,
    routePickerVisible,
    routeCaptureVisible,
    settingsVisible,
    state.mode,
  ]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleHardwareBack);
    return () => subscription.remove();
  }, [handleHardwareBack]);

  const triggerDevEmergency = useCallback(async () => {
    try {
      await EmergencyNative.triggerDevEmergency();
    } catch (error) {
      Alert.alert(
        '테스트 트리거 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const updateSttEngine = useCallback(
    async (nextEngine: SttEngine) => {
      setSttEngine(nextEngine);
      await saveSettings({
        sttEngine: nextEngine,
        sirenEnabled,
        customPrompt,
        sensorThreshold,
        gyroThreshold,
        audioRmsThreshold,
        preTriggerSeconds,
        postTriggerSeconds,
        routeDeviationDistanceMeters,
        routeDeviationDurationSeconds,
        safetyProfile,
      });
      if (!isMonitoring) {
        return;
      }

      try {
        await EmergencyNative.startMonitoring(
          buildMonitoringConfig({
            sttEnabled: nextEngine !== STT_ENGINE_OFF,
            sttEngine: nextEngine,
          }),
        );
      } catch (error) {
        console.warn('[EmergencyDebug] updateSttEngine failed', error);
      }
    },
    [audioRmsThreshold, buildMonitoringConfig, customPrompt, gyroThreshold, isMonitoring, postTriggerSeconds, preTriggerSeconds, routeDeviationDistanceMeters, routeDeviationDurationSeconds, safetyProfile, saveSettings, sensorThreshold, sirenEnabled],
  );
  const updateSirenEnabled = useCallback(
    async (enabled: boolean) => {
      setSirenEnabled(enabled);
      await saveSettings({
        sttEngine,
        sirenEnabled: enabled,
        customPrompt,
        sensorThreshold,
        gyroThreshold,
        audioRmsThreshold,
        preTriggerSeconds,
        postTriggerSeconds,
        routeDeviationDistanceMeters,
        routeDeviationDurationSeconds,
        safetyProfile,
      });
      if (!enabled && state.mode === 'countdown') {
        EmergencyNative.stopSiren().catch(() => undefined);
      }
    },
    [audioRmsThreshold, customPrompt, gyroThreshold, postTriggerSeconds, preTriggerSeconds, routeDeviationDistanceMeters, routeDeviationDurationSeconds, safetyProfile, saveSettings, sensorThreshold, state.mode, sttEngine],
  );
  const activateSavedRoute = useCallback(
    async (routeId: string) => {
      const nextProfile = activateRouteInProfile(safetyProfile, routeId);
      setSafetyProfile(nextProfile);
      setProfileDraft(nextProfile);
      await saveSettings({
        sttEngine,
        sirenEnabled,
        customPrompt,
        sensorThreshold,
        gyroThreshold,
        audioRmsThreshold,
        preTriggerSeconds,
        postTriggerSeconds,
        routeDeviationDistanceMeters,
        routeDeviationDurationSeconds,
        safetyProfile: nextProfile,
      });
      if (isMonitoring) {
        try {
          setRouteDeviationStatus(null);
          setRouteStatusVisible(false);
          setRouteStatusLocation(null);
          await EmergencyNative.startMonitoring(
            buildMonitoringConfig({
              routePath: nextProfile.childRoutePath.length >= 2 ? nextProfile.childRoutePath : [],
            }),
          );
        } catch (error) {
          console.warn('[RouteDeviation] activateSavedRoute refresh failed', error);
        }
      }
    },
    [audioRmsThreshold, buildMonitoringConfig, customPrompt, gyroThreshold, isMonitoring, postTriggerSeconds, preTriggerSeconds, routeDeviationDistanceMeters, routeDeviationDurationSeconds, safetyProfile, saveSettings, sensorThreshold, sirenEnabled, sttEngine],
  );
  const updateProfileDraftRoute = useCallback(
    (routeId: string, updates: Partial<SavedRoute>) => {
      setProfileDraft(current => updateSavedRouteInProfile(current, routeId, updates));
    },
    [],
  );
  const activateProfileDraftRoute = useCallback((routeId: string) => {
    setProfileDraft(current => activateRouteInProfile(current, routeId));
  }, []);
  const deleteProfileDraftRoute = useCallback((routeId: string) => {
    const route = profileDraftRef.current.savedRoutes.find(savedRoute => savedRoute.id === routeId);
    if (!route) {
      return;
    }
    Alert.alert(
      '경로 삭제',
      `'${route.name}' 경로를 삭제할까요?`,
      [
        {text: '취소', style: 'cancel'},
        {
          text: '삭제',
          style: 'destructive',
          onPress: () => setProfileDraft(current => deleteSavedRouteFromProfile(current, routeId)),
        },
      ],
    );
  }, []);
  const openSavedRouteWaypointEditor = useCallback((routeId: string) => {
    setEditingSavedRouteId(routeId);
    setRoutePickerPurpose('savedRouteEdit');
    setRoutePickerMode('edit');
    setRoutePickerVisible(true);
  }, []);
  const updateAudioRmsThreshold = useCallback(async () => {
    const parsed = Number(audioRmsThresholdInput);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      Alert.alert('임계값 오류', '0보다 크고 1 이하인 숫자를 입력해 주세요.');
      setAudioRmsThresholdInput(String(audioRmsThreshold));
      return;
    }

    const nextThreshold = Number(parsed.toFixed(3));
    setAudioRmsThreshold(nextThreshold);
    setAudioRmsThresholdInput(String(nextThreshold));
    await saveSettings({
      sttEngine,
      sirenEnabled,
      customPrompt,
      sensorThreshold,
      gyroThreshold,
      audioRmsThreshold: nextThreshold,
      preTriggerSeconds,
      postTriggerSeconds,
      routeDeviationDistanceMeters,
      routeDeviationDurationSeconds,
      safetyProfile,
    });

    if (!isMonitoring) {
      return;
    }

    try {
      await EmergencyNative.startMonitoring(
        buildMonitoringConfig({audioRmsThreshold: nextThreshold}),
      );
    } catch (error) {
      console.warn('[EmergencyDebug] updateAudioRmsThreshold failed', error);
    }
  }, [
    audioRmsThreshold,
    audioRmsThresholdInput,
    buildMonitoringConfig,
    customPrompt,
    gyroThreshold,
    isMonitoring,
    postTriggerSeconds,
    preTriggerSeconds,
    routeDeviationDistanceMeters,
    routeDeviationDurationSeconds,
    safetyProfile,
    saveSettings,
    sensorThreshold,
    sirenEnabled,
    sttEngine,
  ]);
  const updateAnalysisWindowSeconds = useCallback(
    async (target: 'pre' | 'post', value: number) => {
      const nextValue = normalizeAnalysisWindowSeconds(value, target === 'pre' ? preTriggerSeconds : postTriggerSeconds);
      const nextPreTriggerSeconds = target === 'pre' ? nextValue : preTriggerSeconds;
      const nextPostTriggerSeconds = target === 'post' ? nextValue : postTriggerSeconds;

      if (
        nextPreTriggerSeconds === preTriggerSeconds &&
        nextPostTriggerSeconds === postTriggerSeconds
      ) {
        return;
      }

      setPreTriggerSeconds(nextPreTriggerSeconds);
      setPostTriggerSeconds(nextPostTriggerSeconds);
      await saveSettings({
        sttEngine,
        sirenEnabled,
        customPrompt,
        sensorThreshold,
        gyroThreshold,
        audioRmsThreshold,
        preTriggerSeconds: nextPreTriggerSeconds,
        postTriggerSeconds: nextPostTriggerSeconds,
        routeDeviationDistanceMeters,
        routeDeviationDurationSeconds,
        safetyProfile,
      });

      if (!isMonitoring) {
        return;
      }

      try {
        await EmergencyNative.startMonitoring(
          buildMonitoringConfig({
            preTriggerSeconds: nextPreTriggerSeconds,
            postTriggerSeconds: nextPostTriggerSeconds,
          }),
        );
      } catch (error) {
        console.warn('[EmergencyDebug] updateAnalysisWindowSeconds failed', error);
      }
    },
    [
      audioRmsThreshold,
      buildMonitoringConfig,
      customPrompt,
      gyroThreshold,
      isMonitoring,
      postTriggerSeconds,
      preTriggerSeconds,
      routeDeviationDistanceMeters,
      routeDeviationDurationSeconds,
      safetyProfile,
      saveSettings,
      sensorThreshold,
      sirenEnabled,
      sttEngine,
    ],
  );
  const applyMotionSensorThresholds = useCallback(async (
    nextSensorThreshold: number,
    nextGyroThreshold: number,
  ) => {
    setSensorThreshold(nextSensorThreshold);
    setGyroThreshold(nextGyroThreshold);
    await saveSettings({
      sttEngine,
      sirenEnabled,
      customPrompt,
      sensorThreshold: nextSensorThreshold,
      gyroThreshold: nextGyroThreshold,
      audioRmsThreshold,
      preTriggerSeconds,
      postTriggerSeconds,
      routeDeviationDistanceMeters,
      routeDeviationDurationSeconds,
      safetyProfile,
    });

    if (!isMonitoring) {
      return;
    }

    try {
      await EmergencyNative.startMonitoring(
        buildMonitoringConfig({
          sensorThreshold: nextSensorThreshold,
          gyroThreshold: nextGyroThreshold,
        }),
      );
    } catch (error) {
      console.warn('[EmergencyDebug] applyMotionSensorThresholds failed', error);
    }
  }, [
    audioRmsThreshold,
    buildMonitoringConfig,
    customPrompt,
    isMonitoring,
    postTriggerSeconds,
    preTriggerSeconds,
    routeDeviationDistanceMeters,
    routeDeviationDurationSeconds,
    safetyProfile,
    saveSettings,
    sirenEnabled,
    sttEngine,
  ]);
  const updateSensorThresholdInput = useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, '');
      setSensorThresholdInput(digits);
      const parsed = parsePositiveInteger(digits);
      if (parsed) {
        applyMotionSensorThresholds(parsed, gyroThreshold).catch(() => undefined);
      }
    },
    [applyMotionSensorThresholds, gyroThreshold],
  );
  const updateGyroThresholdInput = useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, '');
      setGyroThresholdInput(digits);
      const parsed = parsePositiveInteger(digits);
      if (parsed) {
        applyMotionSensorThresholds(sensorThreshold, parsed).catch(() => undefined);
      }
    },
    [applyMotionSensorThresholds, sensorThreshold],
  );
  const resetMotionSensorThresholds = useCallback(async () => {
    setSensorThresholdInput(String(DEFAULT_SENSOR_THRESHOLD));
    setGyroThresholdInput(String(DEFAULT_GYRO_THRESHOLD));
    await applyMotionSensorThresholds(
      DEFAULT_SENSOR_THRESHOLD,
      DEFAULT_GYRO_THRESHOLD,
    );
  }, [applyMotionSensorThresholds]);
  const applyRouteDeviationSettings = useCallback(async (
    nextDistanceMeters: number,
    nextDurationSeconds: number,
  ) => {
    setRouteDeviationDistanceMeters(nextDistanceMeters);
    setRouteDeviationDurationSeconds(nextDurationSeconds);
    await saveSettings({
      sttEngine,
      sirenEnabled,
      customPrompt,
      sensorThreshold,
      gyroThreshold,
      audioRmsThreshold,
      preTriggerSeconds,
      postTriggerSeconds,
      routeDeviationDistanceMeters: nextDistanceMeters,
      routeDeviationDurationSeconds: nextDurationSeconds,
      safetyProfile,
    });

    if (!isMonitoring) {
      return;
    }

    try {
      await EmergencyNative.startMonitoring(
        buildMonitoringConfig({
          routeDeviationDistanceMeters: nextDistanceMeters,
          routeDeviationDurationSeconds: nextDurationSeconds,
        }),
      );
    } catch (error) {
      console.warn('[RouteDeviation] applyRouteDeviationSettings failed', error);
    }
  }, [
    audioRmsThreshold,
    buildMonitoringConfig,
    customPrompt,
    gyroThreshold,
    isMonitoring,
    postTriggerSeconds,
    preTriggerSeconds,
    safetyProfile,
    saveSettings,
    sensorThreshold,
    sirenEnabled,
    sttEngine,
  ]);
  const updateRouteDeviationDistanceInput = useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, '');
      setRouteDeviationDistanceInput(digits);
      const parsed = parsePositiveInteger(digits);
      if (parsed) {
        applyRouteDeviationSettings(parsed, routeDeviationDurationSeconds).catch(() => undefined);
      }
    },
    [applyRouteDeviationSettings, routeDeviationDurationSeconds],
  );
  const updateRouteDeviationDurationInput = useCallback(
    (value: string) => {
      const digits = value.replace(/\D/g, '');
      setRouteDeviationDurationInput(digits);
      const parsed = parsePositiveInteger(digits);
      if (parsed) {
        applyRouteDeviationSettings(routeDeviationDistanceMeters, parsed).catch(() => undefined);
      }
    },
    [applyRouteDeviationSettings, routeDeviationDistanceMeters],
  );
  const currentRouteStatusText = routeDeviationStatus?.route_deviation ? '경로 이탈' : '경로 일치';
  const loadRouteStatusLocation = useCallback(async () => {
    const currentLocation = await EmergencyNative.getCurrentLocation();
    const headingResult =
      typeof EmergencyNative.getCurrentHeading === 'function'
        ? await EmergencyNative.getCurrentHeading().catch(() => undefined)
        : undefined;
    return {
      ...currentLocation,
      heading: headingResult?.heading ?? currentLocation.heading,
    };
  }, []);
  const openRouteStatusModal = useCallback(async () => {
    if (!isKakaoKeyConfigured(KAKAO_MAP_JAVASCRIPT_KEY)) {
      Alert.alert(
        '카카오맵 JavaScript 키 필요',
        'src/config/kakaoMap.ts의 KAKAO_MAP_JAVASCRIPT_KEY 값을 실제 키로 변경해 주세요.',
      );
      return;
    }
    if (!safetyProfile.startLocation || !safetyProfile.destinationLocation || safetyProfile.childRoutePath.length < 2) {
      Alert.alert('경로 확인 불가', '현재 활성화된 경로가 없습니다.');
      return;
    }

    try {
      await requestAndroidLocationPermissions();
      const nextLocation = await loadRouteStatusLocation();
      setRouteStatusLocation(nextLocation);
      setRouteStatusMapStatusText(currentRouteStatusText);
      setRouteStatusMapVersion(version => version + 1);
      setRouteStatusVisible(true);
    } catch (error) {
      Alert.alert(
        '현재 위치 확인 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [currentRouteStatusText, loadRouteStatusLocation, safetyProfile.childRoutePath.length, safetyProfile.destinationLocation, safetyProfile.startLocation]);

  useEffect(() => {
    if (!routeStatusVisible || !emergencyEvents) {
      return;
    }

    const subscription = emergencyEvents.addListener('routeStatusLocation', event => {
      const nextLocation = normalizeEmergencyLocation(event);
      if (!nextLocation) {
        return;
      }
      routeStatusWebViewRef.current?.injectJavaScript(
        `window.updateCurrentLocation && window.updateCurrentLocation(${JSON.stringify(nextLocation)}); true;`,
      );
    });

    EmergencyNative.startRouteStatusUpdates().catch(error => {
      console.warn('[RouteStatus] start updates failed', error);
    });

    return () => {
      subscription.remove();
      EmergencyNative.stopRouteStatusUpdates().catch(error => {
        console.warn('[RouteStatus] stop updates failed', error);
      });
    };
  }, [routeStatusVisible]);

  useEffect(() => {
    if (!routeStatusVisible) {
      return;
    }

    routeStatusWebViewRef.current?.injectJavaScript(
      `window.updateRouteStatus && window.updateRouteStatus(${JSON.stringify(currentRouteStatusText)}); true;`,
    );
  }, [currentRouteStatusText, routeStatusVisible]);
  const editingSavedRoute =
    routePickerPurpose === 'savedRouteEdit' && editingSavedRouteId
      ? profileDraft.savedRoutes.find(route => route.id === editingSavedRouteId)
      : undefined;
  const routePickerStartLocation = editingSavedRoute?.start ?? profileDraft.startLocation;
  const routePickerDestinationLocation = editingSavedRoute?.end ?? profileDraft.destinationLocation;
  const routePickerPath =
    editingSavedRoute?.waypoints ??
    (routePickerPurpose === 'manualCreate' && pendingManualRoutePath.length > 0
      ? pendingManualRoutePath
      : profileDraft.childRoutePath);
  const routePickerKey = editingSavedRoute?.id ?? routePickerPurpose ?? 'profile-draft';
  const hasActiveRouteForStatus =
    Boolean(safetyProfile.startLocation) &&
    Boolean(safetyProfile.destinationLocation) &&
    safetyProfile.childRoutePath.length >= 2;
  const showRouteStatusBadge = isMonitoring && hasActiveRouteForStatus && routeDeviationStatus !== null;
  const routeStatusLabel = currentRouteStatusText;
  const routeDeviationBadgeStyle =
    routeDeviationStatus?.route_deviation && monitoringMode === 'child'
      ? styles.routeDeviationBadgeChild
      : routeDeviationStatus?.route_deviation
        ? styles.routeDeviationBadgeAdult
        : styles.routeDeviationBadgeMatched;
  const routeStatusBadgeButtonStyle =
    routeDeviationStatus?.route_deviation && monitoringMode === 'child'
      ? styles.routeDeviationBadgeButtonChild
      : routeDeviationStatus?.route_deviation
        ? styles.routeDeviationBadgeButtonAdult
        : styles.routeDeviationBadgeButtonMatched;
  if (!settingsLoaded) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <View style={styles.loadingScreen}>
          <Text style={styles.statusValue}>앱 설정을 불러오는 중</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!safetyProfile.mode) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <ScrollView contentContainerStyle={styles.container}>
          <SafetyProfileForm
            title="안심 귀가 정보 등록"
            subtitle="유아/성인 모드와 귀가 루틴 정보를 먼저 저장합니다. 저장 후 기존 감시 화면으로 이동합니다."
            profile={profileDraft}
            onChange={updateProfileDraft}
            kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
            onOpenRouteAutoCapture={openRouteAutoCapture}
            onOpenManualRouteFlow={openManualRouteFlow}
            onUpdateRoute={updateProfileDraftRoute}
            onActivateRoute={activateProfileDraftRoute}
            onEditRouteWaypoints={openSavedRouteWaypointEditor}
            onDeleteRoute={deleteProfileDraftRoute}
            onSave={saveSafetyProfile}
            saveLabel="저장하고 시작"
          />
        </ScrollView>
        <LocationPickerModal
          visible={locationPickerTarget !== null}
          kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
          webViewRef={locationPickerWebViewRef}
          onClose={closeLocationPicker}
          onMessage={handleLocationPickerMessage}
        />
        <RoutePickerModal
          visible={routePickerVisible}
          kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
          routeKey={routePickerKey}
          startLocation={routePickerStartLocation}
          destinationLocation={routePickerDestinationLocation}
          routePath={routePickerPath}
          mode={routePickerMode}
          onBack={handleRouteBack}
          onMessage={handleRoutePickerMessage}
        />
        <ManualRouteInfoModal
          visible={manualRouteInfoVisible}
          draft={manualRouteInfoDraft}
          onChange={(key, value) =>
            setManualRouteInfoDraft(current => ({...current, [key]: value}))
          }
          onCancel={cancelManualRouteInfo}
          onSave={saveManualRouteInfo}
        />
        <RouteAutoCaptureModal
          visible={routeCaptureVisible}
          kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
          phase={routeCapturePhase}
          startLocation={routeCaptureStart}
          endLocation={routeCaptureEnd}
          waypoints={routeCaptureWaypoints}
          routeInfoDraft={routeCaptureInfoDraft}
          onRouteInfoChange={(key, value) =>
            setRouteCaptureInfoDraft(current => ({...current, [key]: value}))
          }
          onStartCapture={startRouteAutoCapture}
          onStopCapture={stopRouteAutoCapture}
          onSaveRoute={saveAutoCapturedRoute}
          onClose={closeRouteAutoCapture}
          onMessage={handleRouteAutoCaptureMessage}
        />
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Pressable
            style={styles.logButton}
            onPress={() => setMenuVisible(true)}>
            <Text style={styles.logButtonText}>메뉴</Text>
          </Pressable>
          <Text style={styles.eyebrow}>On-device prototype</Text>
          <Text style={styles.title}>AI 안심 귀가</Text>
          <Text style={styles.subtitle}>
            Foreground Service가 센서, 마이크, 위치를 감시하고 Gemma 4 E4B
            LiteRT-LM 분석 후 자동 문자 신고 흐름을 검증합니다.
          </Text>
        </View>

        <View style={styles.statusPanel}>
          {showRouteStatusBadge ? (
            <Pressable
              style={[styles.routeDeviationBadgeButton, routeStatusBadgeButtonStyle]}
              hitSlop={8}
              onPress={openRouteStatusModal}>
              <Text style={[styles.routeDeviationBadge, routeDeviationBadgeStyle]}>
                {routeStatusLabel}
              </Text>
            </Pressable>
          ) : null}
          <Text style={styles.statusLabel}>현재 상태</Text>
          <Text style={styles.statusValue}>
            {statusText(state.mode, state.analysisPass)}
          </Text>
          <Text style={styles.summary}>{monitoringModeLabel(monitoringMode)}</Text>
          {formatAnalysisSummary(state.analysis) ? (
            <Text style={styles.summary}>{formatAnalysisSummary(state.analysis)}</Text>
          ) : null}
          {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
        </View>

        <View style={styles.actions}>
          <Pressable
            style={[styles.button, isMonitoring && styles.buttonDisabled]}
            disabled={isMonitoring}
            onPress={startMonitoring}>
            <Text style={styles.buttonText}>안심 귀가 모드 ON</Text>
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, !canStop && styles.buttonDisabled]}
            disabled={!canStop}
            onPress={stopMonitoring}>
            <Text style={styles.secondaryButtonText}>모니터링 중지</Text>
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, !canStop && styles.buttonDisabled]}
            disabled={!canStop}
            onPress={triggerDevEmergency}>
            <Text style={styles.secondaryButtonText}>개발용 위급 트리거</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal visible={state.mode === 'countdown'} transparent animationType="fade" onRequestClose={cancelReport}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {state.countdown}초 후 경찰에 자동 신고됩니다
            </Text>
            {formatAnalysisSummary(state.analysis) ? (
              <Text style={styles.modalSummary}>
                {formatAnalysisSummary(state.analysis)}
              </Text>
            ) : null}
            <Pressable style={styles.cancelButton} onPress={cancelReport}>
              <Text style={styles.cancelButtonText}>신고 취소</Text>
            </Pressable>
          </View>
        </View>
      </Modal>



      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>메뉴</Text>
            <Pressable
              style={styles.menuOption}
              onPress={() => {
                setMenuVisible(false);
                setLogsVisible(true);
              }}>
              <Text style={styles.menuOptionText}>분석 로그 보기</Text>
            </Pressable>
            <Pressable style={styles.menuOption} onPress={openAudioLogs}>
              <Text style={styles.menuOptionText}>오디오 로그</Text>
            </Pressable>
            <Pressable
              style={styles.menuOption}
              onPress={() => {
                setMenuVisible(false);
                setSettingsVisible(true);
              }}>
              <Text style={styles.menuOptionText}>설정</Text>
            </Pressable>
            <Pressable
              style={styles.menuOption}
              onPress={() => {
                setMenuVisible(false);
                setProfileDraft(safetyProfile);
                setProfileEditorVisible(true);
              }}>
              <Text style={styles.menuOptionText}>개인 정보 수정</Text>
            </Pressable>
            <Pressable
              style={styles.menuOption}
              onPress={openGemmaPromptEditor}>
              <Text style={styles.menuOptionText}>{'\uD504\uB86C\uD504\uD2B8 \uC218\uC815'}</Text>
            </Pressable>
            <Pressable
              style={styles.menuCloseButton}
              onPress={() => setMenuVisible(false)}>
              <Text style={styles.menuCloseButtonText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={settingsVisible} transparent animationType="fade" onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.menuCard, styles.settingsCard]}>
            <ScrollView
              contentContainerStyle={styles.settingsScrollContent}
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled">
              <Text style={styles.menuTitle}>설정</Text>
              <View style={styles.analysisWindowPanel}>
                <Text style={styles.settingLabel}>분석 범위 설정</Text>
                <Text style={styles.settingDescription}>
                  트리거 기준으로 Gemma가 확인할 이전/이후 오디오 길이를 조정합니다.
                </Text>
                <SecondsSlider
                  label="이전 분석 범위"
                  value={preTriggerSeconds}
                  onChange={value => updateAnalysisWindowSeconds('pre', value)}
                />
                <SecondsSlider
                  label="이후 분석 범위"
                  value={postTriggerSeconds}
                  onChange={value => updateAnalysisWindowSeconds('post', value)}
                />
                <Text style={styles.settingHint}>각 값은 1초부터 최대 30초까지 설정할 수 있습니다.</Text>
              </View>
              <View style={styles.analysisWindowPanel}>
                <Text style={styles.settingLabel}>모션 센서 설정</Text>
                <Text style={styles.settingDescription}>
                  센서 값이 기준값보다 커지면 움직임 트리거가 발생합니다. 값이 낮을수록 더 민감하게 반응합니다.
                </Text>
                <View style={styles.motionSensorFieldRow}>
                  <Text style={styles.motionSensorFieldLabel}>가속도</Text>
                  <TextInput
                    style={styles.motionSensorInput}
                    value={sensorThresholdInput}
                    onChangeText={updateSensorThresholdInput}
                    onBlur={() => {
                      if (!parsePositiveInteger(sensorThresholdInput)) {
                        setSensorThresholdInput(String(sensorThreshold));
                      }
                    }}
                    keyboardType="number-pad"
                    placeholder={String(DEFAULT_SENSOR_THRESHOLD)}
                  />
                </View>
                <View style={styles.motionSensorFieldRow}>
                  <Text style={styles.motionSensorFieldLabel}>자이로스코프</Text>
                  <TextInput
                    style={styles.motionSensorInput}
                    value={gyroThresholdInput}
                    onChangeText={updateGyroThresholdInput}
                    onBlur={() => {
                      if (!parsePositiveInteger(gyroThresholdInput)) {
                        setGyroThresholdInput(String(gyroThreshold));
                      }
                    }}
                    keyboardType="number-pad"
                    placeholder={String(DEFAULT_GYRO_THRESHOLD)}
                  />
                </View>
                <View style={styles.motionSensorResetRow}>
                  <Pressable
                    style={[styles.secondaryButton, styles.motionSensorResetButton]}
                    onPress={resetMotionSensorThresholds}>
                    <Text style={styles.secondaryButtonText}>기본값으로 리셋</Text>
                  </Pressable>
                </View>
                <Text style={styles.settingHint}>
                  기본값은 가속도계 {DEFAULT_SENSOR_THRESHOLD}, 자이로스코프 {DEFAULT_GYRO_THRESHOLD}입니다.
                </Text>
              </View>
              <View style={styles.analysisWindowPanel}>
                <Text style={styles.settingLabel}>경로 이탈 감지</Text>
                <Text style={styles.settingDescription}>
                  활성 경로에서 지정 거리 이상 벗어난 상태가 설정 시간 이상 지속되면 경로 이탈로 표시합니다.
                </Text>
                <View style={styles.motionSensorFieldRow}>
                  <Text style={styles.motionSensorFieldLabel}>거리(m)</Text>
                  <TextInput
                    style={styles.motionSensorInput}
                    value={routeDeviationDistanceInput}
                    onChangeText={updateRouteDeviationDistanceInput}
                    onBlur={() => {
                      if (!parsePositiveInteger(routeDeviationDistanceInput)) {
                        setRouteDeviationDistanceInput(String(routeDeviationDistanceMeters));
                      }
                    }}
                    keyboardType="number-pad"
                    placeholder={String(DEFAULT_ROUTE_DEVIATION_DISTANCE_METERS)}
                  />
                </View>
                <View style={styles.motionSensorFieldRow}>
                  <Text style={styles.motionSensorFieldLabel}>시간(초)</Text>
                  <TextInput
                    style={styles.motionSensorInput}
                    value={routeDeviationDurationInput}
                    onChangeText={updateRouteDeviationDurationInput}
                    onBlur={() => {
                      if (!parsePositiveInteger(routeDeviationDurationInput)) {
                        setRouteDeviationDurationInput(String(routeDeviationDurationSeconds));
                      }
                    }}
                    keyboardType="number-pad"
                    placeholder={String(DEFAULT_ROUTE_DEVIATION_DURATION_SECONDS)}
                  />
                </View>
                <Text style={styles.settingHint}>
                  기본값은 {DEFAULT_ROUTE_DEVIATION_DISTANCE_METERS}m, {DEFAULT_ROUTE_DEVIATION_DURATION_SECONDS}초입니다.
                </Text>
              </View>
              <View style={styles.settingRow}>
                <View style={styles.settingTextGroup}>
                  <Text style={styles.settingLabel}>STT 기능</Text>
                  <Text style={styles.settingDescription}>
                    실험용 로그 기능입니다. Moonshine tiny-ko가 트리거 이후 오디오를 받아쓰지만 Gemma 판단에는 사용되지 않습니다.
                  </Text>
                </View>
                <Switch
                  value={sttEngine === STT_ENGINE_ON}
                  onValueChange={enabled => updateSttEngine(enabled ? STT_ENGINE_ON : STT_ENGINE_OFF)}
                />
              </View>
              <Text style={styles.settingHint}>
                기본값은 OFF입니다. 켜도 신고 판단에는 영향을 주지 않고 로그에만 남습니다.
              </Text>
              <View style={styles.settingRow}>
                <View style={styles.settingTextGroup}>
                  <Text style={styles.settingLabel}>위급 시 사이렌 기능(소리)</Text>
                  <Text style={styles.settingDescription}>
                    자동 신고 전 카운트다운 팝업이 뜰 때 진동과 함께 사이렌 소리를 재생합니다.
                  </Text>
                </View>
                <Switch
                  value={sirenEnabled}
                  onValueChange={updateSirenEnabled}
                />
              </View>
              <Text style={styles.settingHint}>
                끄면 위급 상황 팝업에서는 진동만 동작합니다.
              </Text>
              <SavedRouteSelector
                routes={safetyProfile.savedRoutes}
                activeRouteId={safetyProfile.activeRouteId}
                onSelect={activateSavedRoute}
              />
              <Pressable
                style={styles.menuCloseButton}
                onPress={() => setSettingsVisible(false)}>
                <Text style={styles.menuCloseButtonText}>닫기</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={promptEditorVisible} animationType="slide" onRequestClose={() => setPromptEditorVisible(false)}>
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>프롬프트 수정</Text>
              <Text style={styles.logsSubtitle}>{promptModeLabel(promptEditorMode)} {'\uD504\uB86C\uD504\uD2B8'}</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={() => setPromptEditorVisible(false)}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.logsContent}>
            <Text style={styles.settingDescription}>
              {'\uD604\uC7AC \uC120\uD0DD\uD55C \uBAA8\uB4DC\uC758 \uD504\uB86C\uD504\uD2B8\uB9CC \uC218\uC815\uB429\uB2C8\uB2E4. \uAE30\uBCF8 \uD30C\uC77C\uC740 prompts/onguard_gemma_prompts_child.json \uB610\uB294 prompts/onguard_gemma_prompts_adult.json\uC774\uBA70, \uC800\uC7A5\uD55C \uB0B4\uC6A9\uC740 \uC774 \uAE30\uAE30 \uC571 \uC124\uC815\uC5D0 \uBAA8\uB4DC\uBCC4 override\uB85C \uB0A8\uC2B5\uB2C8\uB2E4.'}
            </Text>
            <View style={styles.modeGrid}>
              <ModeButton
                label={'\uC544\uB3D9\uC6A9'}
                selected={promptEditorMode === 'child'}
                onPress={() => changePromptEditorMode('child')}
              />
              <ModeButton
                label={'\uC131\uC778\uC6A9'}
                selected={promptEditorMode === 'adult'}
                onPress={() => changePromptEditorMode('adult')}
              />
            </View>
            <PromptEditorField
              label="시스템 프롬프트"
              description="모델의 전역 역할과 출력 형식을 지정합니다."
              value={gemmaPromptDraft.system}
              onChangeText={value => updateGemmaPromptDraft('system', value)}
              minHeight={180}
            />
            <PromptEditorField
              label="1차 추론 프롬프트"
              description="트리거 직전 오디오 분석 지침입니다. {{preTriggerSeconds}}, {{sampleRate}}, {{triggerSource}}, {{locationText}} 토큰을 사용할 수 있습니다."
              value={gemmaPromptDraft.primary}
              onChangeText={value => updateGemmaPromptDraft('primary', value)}
              minHeight={360}
            />
            <PromptEditorField
              label="2차 추론 프롬프트"
              description="트리거 이후 오디오 분석 지침입니다. {{postTriggerSeconds}}와 1차 토큰에 더해 {{previousContext}} 토큰을 사용할 수 있습니다."
              value={gemmaPromptDraft.secondary}
              onChangeText={value => updateGemmaPromptDraft('secondary', value)}
              minHeight={360}
            />
            <Pressable style={styles.secondaryButton} onPress={resetGemmaPrompts}>
              <Text style={styles.secondaryButtonText}>기본값으로 원복</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={saveGemmaPrompts}>
              <Text style={styles.buttonText}>저장</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={profileEditorVisible} animationType="slide" onRequestClose={closeProfileEditor}>
        <SafeAreaView style={styles.logsScreen}>
          <ScrollView contentContainerStyle={styles.logsContent}>
            <SafetyProfileForm
              title={'\uC0AC\uC6A9\uC790 \uC815\uBCF4'}
              subtitle={'\uC800\uC7A5\uB41C \uC815\uBCF4\uB294 \uC774 \uAE30\uAE30 \uC571 \uB0B4\uBD80 \uC124\uC815\uC5D0 \uBCF4\uAD00\uB429\uB2C8\uB2E4.'}
              profile={profileDraft}
              onChange={updateProfileDraft}
              kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
              onOpenRouteAutoCapture={openRouteAutoCapture}
              onOpenManualRouteFlow={openManualRouteFlow}
              onUpdateRoute={updateProfileDraftRoute}
              onActivateRoute={activateProfileDraftRoute}
              onEditRouteWaypoints={openSavedRouteWaypointEditor}
              onDeleteRoute={deleteProfileDraftRoute}
              onSave={saveSafetyProfile}
              saveLabel={'\uC800\uC7A5'}
              reserveHeaderActionSpace
              showFooterActions={false}
            />
          </ScrollView>
          <Pressable style={styles.profileFloatingSaveButton} onPress={saveSafetyProfile}>
            <Text style={styles.buttonText}>{'\uC800\uC7A5'}</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>

      <LocationPickerModal
        visible={locationPickerTarget !== null}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        webViewRef={locationPickerWebViewRef}
        onClose={closeLocationPicker}
        onMessage={handleLocationPickerMessage}
      />
      <RoutePickerModal
        visible={routePickerVisible}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        routeKey={routePickerKey}
        startLocation={routePickerStartLocation}
        destinationLocation={routePickerDestinationLocation}
        routePath={routePickerPath}
        mode={routePickerMode}
        onBack={handleRouteBack}
        onMessage={handleRoutePickerMessage}
      />
      <ManualRouteInfoModal
        visible={manualRouteInfoVisible}
        draft={manualRouteInfoDraft}
        onChange={(key, value) =>
          setManualRouteInfoDraft(current => ({...current, [key]: value}))
        }
        onCancel={cancelManualRouteInfo}
        onSave={saveManualRouteInfo}
      />
      <RouteAutoCaptureModal
        visible={routeCaptureVisible}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        phase={routeCapturePhase}
        startLocation={routeCaptureStart}
        endLocation={routeCaptureEnd}
        waypoints={routeCaptureWaypoints}
        routeInfoDraft={routeCaptureInfoDraft}
        onRouteInfoChange={(key, value) =>
          setRouteCaptureInfoDraft(current => ({...current, [key]: value}))
        }
        onStartCapture={startRouteAutoCapture}
        onStopCapture={stopRouteAutoCapture}
        onSaveRoute={saveAutoCapturedRoute}
        onClose={closeRouteAutoCapture}
        onMessage={handleRouteAutoCaptureMessage}
      />
      <RouteStatusModal
        visible={routeStatusVisible}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        webViewRef={routeStatusWebViewRef}
        startLocation={safetyProfile.startLocation}
        destinationLocation={safetyProfile.destinationLocation}
        routePath={safetyProfile.childRoutePath}
        currentLocation={routeStatusLocation}
        mapVersion={routeStatusMapVersion}
        mapStatusText={routeStatusMapStatusText}
        routeDeviationDistanceMeters={routeDeviationDistanceMeters}
        routeDeviationStatus={routeDeviationStatus}
        onClose={() => setRouteStatusVisible(false)}
      />
      <Modal visible={audioLogsVisible} animationType="slide" onRequestClose={closeAudioLogs}>
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>오디오 로그</Text>
              <Text style={styles.logsSubtitle}>최근 {audioLogs.length}개 / 최대 10개</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={closeAudioLogs}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.logsContent, styles.audioLogsContent]}>
            <View style={styles.thresholdPanel}>
              <Text style={styles.settingLabel}>오디오 트리거 RMS 임계값</Text>
              <Text style={styles.settingDescription}>
                현재 값: {audioRmsThreshold.toFixed(3)}. 값이 낮을수록 작은 소리에도 트리거가 켜집니다.
              </Text>
              <View style={styles.thresholdControls}>
                <TextInput
                  style={styles.thresholdInput}
                  value={audioRmsThresholdInput}
                  onChangeText={setAudioRmsThresholdInput}
                  keyboardType="decimal-pad"
                  placeholder="0.35"
                />
                <Pressable
                  style={styles.thresholdApplyButton}
                  onPress={updateAudioRmsThreshold}>
                  <Text style={styles.buttonText}>적용</Text>
                </Pressable>
              </View>
            </View>
            {audioLogs.length === 0 ? (
              <Text style={styles.emptyLogs}>아직 저장된 오디오 로그가 없습니다.</Text>
            ) : (
              audioLogs.map((log, index) => (
                <View key={log.id} style={styles.logCard}>
                  <Text style={styles.logIndex}>#{index + 1}</Text>
                  <LogRow label="time" value={formatAudioLogTime(log.createdAt)} />
                  <LogRow label="trigger_source" value={log.trigger_source} />
                  <LogRow label="analysis_pass" value={formatAnalysisPass(log.analysis_pass)} />

                  <LogRow
                    label="duration_seconds"
                    value={log.duration_seconds.toFixed(1)}
                  />
                  <LogRow label="sample_rate" value={String(log.sample_rate)} />
                  <LogRow
                    label="max_rms"
                    value={formatOptionalNumber(log.max_rms)}
                  />
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => playAudioLog(log.id)}>
                    <Text style={styles.secondaryButtonText}>
                      {playingAudioId === log.id ? '다시 재생' : '재생'}
                    </Text>
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.audioStopBar}>
            <Pressable style={styles.audioStopButton} onPress={stopAudioLog}>
              <Text style={styles.buttonText}>재생 중지</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>
      <Modal visible={logsVisible} animationType="slide" onRequestClose={() => setLogsVisible(false)}>
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>음성 분석 로그</Text>
              <Text style={styles.logsSubtitle}>최근 {analysisLogs.length}개</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={() => setLogsVisible(false)}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.logsContent}>
            {analysisLogs.length === 0 ? (
              <Text style={styles.emptyLogs}>아직 수집된 분석 로그가 없습니다.</Text>
            ) : (
              analysisLogs.map((log, index) => (
                <View key={log.id} style={styles.logCard}>
                  <Text style={styles.logIndex}>#{analysisLogs.length - index}</Text>
                  <LogRow label="time" value={log.createdAt} />
                  <LogRow label="analysis_mode" value={log.analysis_mode} />
                  <LogRow label="monitoring_mode" value={log.monitoring_mode} />
                  <LogRow label="crime_type" value={log.crime_type} />
                  <LogRow label="is_emergency" value={String(log.is_emergency)} />
                  <LogRow label="route_deviation" value={String(log.route_deviation ?? false)} />
                  <LogRow label="final_decision" value={String(log.final_decision ?? false)} />
                  <LogRow label="model_id" value={log.model_id} />
                  <LogRow label="trigger_source" value={log.trigger_source} />
                  <LogRow label="analysis_pass" value={formatAnalysisPass(log.analysis_pass)} />

                  <LogRow
                    label="location"
                    value={formatLocation(log.location)}
                  />
                  <LogRow
                    label="recognized_dialogue"
                    value={log.recognized_dialogue}
                  />
                  <LogRow label="confidence" value={log.confidence} />
                  <LogRow
                    label="audio_summary"
                    value={log.audio_summary}
                  />
                  <LogRow
                    label="decision_reason"
                    value={log.decision_reason}
                  />
                  <LogRow
                    label="previous_primary_context"
                    value={log.previous_primary_context}
                  />
                  <LogRow
                    label="stt_transcript"
                    value={log.stt_transcript}
                  />
                  <LogRow label="stt_engine" value={log.stt_engine} />
                  <LogRow label="stt_error" value={log.stt_error} />
                  <LogRow
                    label="raw_model_response"
                    value={log.raw_model_response}
                    monospace
                  />
                  <LogRow label="litert_error" value={log.litert_error} />
                </View>
              ))
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function SecondsSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const sliderTrackRef = useRef<React.ElementRef<typeof View>>(null);
  const trackLeftRef = useRef(0);
  const trackWidthRef = useRef(1);
  const lastSentValueRef = useRef(value);
  const normalizedValue = normalizeAnalysisWindowSeconds(value, DEFAULT_PRE_TRIGGER_SECONDS);
  const percentage =
    ((normalizedValue - MIN_ANALYSIS_WINDOW_SECONDS) /
      (MAX_ANALYSIS_WINDOW_SECONDS - MIN_ANALYSIS_WINDOW_SECONDS)) *
    100;

  useEffect(() => {
    lastSentValueRef.current = normalizedValue;
  }, [normalizedValue]);

  const updateFromPageX = useCallback(
    (pageX: number) => {
      const ratio = Math.max(
        0,
        Math.min(1, (pageX - trackLeftRef.current) / trackWidthRef.current),
      );
      const nextValue =
        MIN_ANALYSIS_WINDOW_SECONDS +
        ratio * (MAX_ANALYSIS_WINDOW_SECONDS - MIN_ANALYSIS_WINDOW_SECONDS);
      const normalizedNextValue = normalizeAnalysisWindowSeconds(nextValue, normalizedValue);
      if (normalizedNextValue === lastSentValueRef.current) {
        return;
      }
      lastSentValueRef.current = normalizedNextValue;
      onChange(normalizedNextValue);
    },
    [normalizedValue, onChange],
  );

  const measureTrackAndUpdate = useCallback(
    (pageX: number) => {
      sliderTrackRef.current?.measureInWindow((x, _y, width) => {
        trackLeftRef.current = x;
        trackWidthRef.current = Math.max(1, width);
        updateFromPageX(pageX);
      });
    },
    [updateFromPageX],
  );

  const updateFromGesture = useCallback(
    (gestureState: PanResponderGestureState, shouldMeasure: boolean) => {
      const pageX = gestureState.moveX || gestureState.x0;
      if (shouldMeasure) {
        measureTrackAndUpdate(pageX);
        return;
      }
      updateFromPageX(pageX);
    },
    [measureTrackAndUpdate, updateFromPageX],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (_event, gestureState) => updateFromGesture(gestureState, true),
        onPanResponderMove: (_event, gestureState) => updateFromGesture(gestureState, false),
      }),
    [updateFromGesture],
  );

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidthRef.current = Math.max(1, event.nativeEvent.layout.width);
    sliderTrackRef.current?.measureInWindow((x, _y, width) => {
      trackLeftRef.current = x;
      trackWidthRef.current = Math.max(1, width);
    });
  }, []);

  return (
    <View style={styles.secondsSlider}>
      <View style={styles.secondsSliderHeader}>
        <Text style={styles.secondsSliderLabel}>{label}</Text>
        <Text style={styles.secondsSliderValue}>{normalizedValue}초</Text>
      </View>
      <View
        ref={sliderTrackRef}
        style={styles.sliderTrack}
        onLayout={handleTrackLayout}
        {...panResponder.panHandlers}>
        <View pointerEvents="none" style={[styles.sliderFill, {width: `${percentage}%`}]} />
        <View pointerEvents="none" style={[styles.sliderThumb, {left: `${percentage}%`}]} />
      </View>
      <View style={styles.sliderRangeLabels}>
        <Text style={styles.sliderRangeLabel}>{MIN_ANALYSIS_WINDOW_SECONDS}초</Text>
        <Text style={styles.sliderRangeLabel}>{MAX_ANALYSIS_WINDOW_SECONDS}초</Text>
      </View>
    </View>
  );
}

function SafetyProfileForm({
  title,
  subtitle,
  profile,
  onChange,
  kakaoKey,
  onOpenRouteAutoCapture,
  onOpenManualRouteFlow,
  onUpdateRoute,
  onActivateRoute,
  onEditRouteWaypoints,
  onDeleteRoute,
  onSave,
  saveLabel,
  onClose,
  reserveHeaderActionSpace = false,
  showFooterActions = true,
}: {
  title: string;
  subtitle: string;
  profile: SafetyProfile;
  onChange: <K extends keyof SafetyProfile>(key: K, value: SafetyProfile[K]) => void;
  kakaoKey: string;
  onOpenRouteAutoCapture: () => void;
  onOpenManualRouteFlow: () => void;
  onUpdateRoute: (routeId: string, updates: Partial<SavedRoute>) => void;
  onActivateRoute: (routeId: string) => void;
  onEditRouteWaypoints: (routeId: string) => void;
  onDeleteRoute: (routeId: string) => void;
  onSave: () => void;
  saveLabel: string;
  onClose?: () => void;
  reserveHeaderActionSpace?: boolean;
  showFooterActions?: boolean;
}) {
  return (
    <View style={styles.profilePanel}>
      <View style={styles.profileHeaderRow}>
        <View style={[styles.profileHeaderText, reserveHeaderActionSpace && styles.profileHeaderTextWithAction]}>
          <Text style={styles.eyebrow}>Sensitive profile</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {onClose ? (
          <Pressable style={styles.inlineCloseButton} onPress={onClose}>
            <Text style={styles.inlineCloseButtonText}>{'\uB2EB\uAE30'}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.modeGrid}>
        <ModeButton
          label={'\uC720\uC544 \uBAA8\uB4DC'}
          selected={profile.mode === 'child'}
          onPress={() => onChange('mode', 'child')}
        />
        <ModeButton
          label={'\uC131\uC778 \uBAA8\uB4DC'}
          selected={profile.mode === 'adult'}
          onPress={() => onChange('mode', 'adult')}
        />
      </View>

      <View style={styles.formSection}>
        <View style={styles.inputGroup}>
          <Text style={styles.fieldLabel}>{'\uC131\uBCC4'}</Text>
          <View style={styles.modeGrid}>
            <ModeButton
              label={'\uB0A8'}
              selected={profile.gender === 'male'}
              onPress={() => onChange('gender', 'male')}
            />
            <ModeButton
              label={'\uC5EC'}
              selected={profile.gender === 'female'}
              onPress={() => onChange('gender', 'female')}
            />
          </View>
        </View>
        <BirthdayInput
          value={profile.birthday}
          onChange={value => onChange('birthday', value)}
        />
        <ProfileInput
          label={'\uBE44\uC0C1 \uC804\uD654\uBC88\uD638'}
          value={profile.emergencyPhone}
          placeholder={'\uC608: 010-0000-0000'}
          keyboardType="phone-pad"
          onChangeText={value => onChange('emergencyPhone', normalizePhoneNumber(value))}
        />
        <ProfileInput
          label={'\uC0C1\uC138 \uC8FC\uC18C'}
          value={profile.detailAddress}
          placeholder={'\uB3D9/\uD638\uC218, \uAC74\uBB3C\uBA85 \uB4F1'}
          onChangeText={value => onChange('detailAddress', value)}
        />
      </View>

      <View style={styles.formSection}>
        <View style={styles.inputGroup}>
          <Text style={styles.fieldLabel}>{'\uACBD\uB85C \uC790\uB3D9 \uC778\uC2DD'}</Text>
          <Pressable style={styles.locationButton} onPress={onOpenRouteAutoCapture}>
            <Text style={styles.locationButtonText}>{'\uC2E4\uC2DC\uAC04 GPS\uB85C \uACBD\uB85C \uC218\uC9D1'}</Text>
          </Pressable>
        </View>
        <View style={styles.inputGroup}>
          <Text style={styles.fieldLabel}>{'\uACBD\uB85C \uC218\uB3D9 \uC778\uC2DD'}</Text>
          <Pressable style={styles.locationButton} onPress={onOpenManualRouteFlow}>
            <Text style={styles.locationButtonText}>{'\uCD9C\uBC1C\uC9C0-\uB3C4\uCC29\uC9C0-\uACBD\uB85C \uC21C\uC11C\uB85C \uC785\uB825'}</Text>
          </Pressable>
          <Text style={styles.locationSummary}>
            {formatSavedRouteSummary(profile.savedRoutes, profile.activeRouteId)}
          </Text>
        </View>
      </View>

      <SavedRouteManager
        routes={profile.savedRoutes}
        activeRouteId={profile.activeRouteId}
        kakaoKey={kakaoKey}
        onUpdateRoute={onUpdateRoute}
        onActivateRoute={onActivateRoute}
        onEditRouteWaypoints={onEditRouteWaypoints}
        onDeleteRoute={onDeleteRoute}
      />

      {showFooterActions ? (
        <View style={styles.profileActionRow}>
          <Pressable style={[styles.button, styles.profileSaveButton]} onPress={onSave}>
            <Text style={styles.buttonText}>{saveLabel}</Text>
          </Pressable>
          {onClose ? (
            <Pressable style={styles.profileCloseButton} onPress={onClose}>
              <Text style={styles.secondaryButtonText}>{'\uB2EB\uAE30'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

    </View>
  );
}

function BirthdayInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const parsed = parseBirthdayParts(value);
  const [year, setYear] = useState(parsed.year);
  const [month, setMonth] = useState(parsed.month);
  const [day, setDay] = useState(parsed.day);
  const [error, setError] = useState('');

  const commit = useCallback(
    (nextYear: string, nextMonth: string, nextDay: string) => {
      const validation = validateBirthdayParts(nextYear, nextMonth, nextDay);
      if (validation) {
        setError(validation);
        return;
      }
      setError('');
      if (nextYear.length === 4 && nextMonth.length > 0 && nextDay.length > 0) {
        onChange(`${nextYear}-${nextMonth.padStart(2, '0')}-${nextDay.padStart(2, '0')}`);
      } else {
        onChange('');
      }
    },
    [onChange],
  );

  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{'\uC0DD\uC77C'}</Text>
      <View style={styles.birthdayRow}>
        <DatePartInput
          value={year}
          placeholder="YYYY"
          maxLength={4}
          onChangeText={next => {
            const digits = next.replace(/\D/g, '').slice(0, 4);
            const validation = validateBirthdayParts(digits, month, day);
            if (validation) {
              setError(validation);
              return;
            }
            setYear(digits);
            commit(digits, month, day);
          }}
        />
        <Text style={styles.inlineUnit}>{'\uB144'}</Text>
        <DatePartInput
          value={month}
          placeholder="MM"
          maxLength={2}
          onChangeText={next => {
            const digits = next.replace(/\D/g, '').slice(0, 2);
            const validation = validateBirthdayParts(year, digits, day);
            if (validation) {
              setError(validation);
              return;
            }
            setMonth(digits);
            commit(year, digits, day);
          }}
        />
        <Text style={styles.inlineUnit}>{'\uC6D4'}</Text>
        <DatePartInput
          value={day}
          placeholder="DD"
          maxLength={2}
          onChangeText={next => {
            const digits = next.replace(/\D/g, '').slice(0, 2);
            const validation = validateBirthdayParts(year, month, digits);
            if (validation) {
              setError(validation);
              return;
            }
            setDay(digits);
            commit(year, month, digits);
          }}
        />
        <Text style={styles.inlineUnit}>{'\uC77C'}</Text>
      </View>
      {error ? <Text style={styles.inputError}>{error}</Text> : null}
    </View>
  );
}

function DatePartInput({
  value,
  placeholder,
  maxLength,
  onChangeText,
}: {
  value: string;
  placeholder: string;
  maxLength: number;
  onChangeText: (value: string) => void;
}) {
  return (
    <TextInput
      style={[styles.textInput, styles.compactNumberInput]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      keyboardType="number-pad"
      maxLength={maxLength}
    />
  );
}

function TimeRangeGroup({
  startHour,
  startMinute,
  endHour,
  endMinute,
  onStartHourChange,
  onStartMinuteChange,
  onEndHourChange,
  onEndMinuteChange,
}: {
  startHour: string;
  startMinute: string;
  endHour: string;
  endMinute: string;
  onStartHourChange: (value: string) => void;
  onStartMinuteChange: (value: string) => void;
  onEndHourChange: (value: string) => void;
  onEndMinuteChange: (value: string) => void;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{'\uCD9C\uBC1C/\uB3C4\uCC29 \uC2DC\uAC04\uB300'}</Text>
      <View style={styles.timeRangeLine}>
        <TimePartInput value={startHour} max={23} onChangeText={onStartHourChange} />
        <Text style={styles.inlineUnit}>{'\uC2DC'}</Text>
        <TimePartInput value={startMinute} max={59} onChangeText={onStartMinuteChange} />
        <Text style={styles.inlineUnit}>{'\uBD84 \uBD80\uD130'}</Text>
      </View>
      <View style={styles.timeRangeLine}>
        <TimePartInput value={endHour} max={23} onChangeText={onEndHourChange} />
        <Text style={styles.inlineUnit}>{'\uC2DC'}</Text>
        <TimePartInput value={endMinute} max={59} onChangeText={onEndMinuteChange} />
        <Text style={styles.inlineUnit}>{'\uBD84 \uAE4C\uC9C0'}</Text>
      </View>
    </View>
  );
}

function TimePartInput({
  value,
  max,
  onChangeText,
}: {
  value: string;
  max: number;
  onChangeText: (value: string) => void;
}) {
  const [error, setError] = useState('');
  return (
    <View style={styles.compactTimeInputGroup}>
      <TextInput
        style={[styles.textInput, styles.compactNumberInput]}
        value={value}
        onChangeText={next => {
          const digits = next.replace(/\D/g, '').slice(0, 2);
          if (digits && Number(digits) > max) {
            setError(`0~${max}\uBC94\uC704\uC758 \uC815\uC218\uB9CC \uC785\uB825\uD574 \uC8FC\uC138\uC694.`);
            return;
          }
          setError('');
          onChangeText(digits);
        }}
        keyboardType="number-pad"
        maxLength={2}
      />
      {error ? <Text style={styles.inputError}>{error}</Text> : null}
    </View>
  );
}

function RouteInfoEditor({
  draft,
  onChange,
}: {
  draft: RouteInfoDraft;
  onChange: <K extends keyof RouteInfoDraft>(key: K, value: RouteInfoDraft[K]) => void;
}) {
  return (
    <View style={styles.routeInfoEditor}>
      <ProfileInput
        label={'\uACBD\uB85C \uC774\uB984'}
        value={draft.name}
        placeholder={'\uC608: \uD559\uAD50 \uAC00\uB294 \uAE38'}
        onChangeText={value => onChange('name', value)}
      />
      <TimeRangeGroup
        startHour={draft.startHour}
        startMinute={draft.startMinute}
        endHour={draft.destinationHour}
        endMinute={draft.destinationMinute}
        onStartHourChange={value => onChange('startHour', value)}
        onStartMinuteChange={value => onChange('startMinute', value)}
        onEndHourChange={value => onChange('destinationHour', value)}
        onEndMinuteChange={value => onChange('destinationMinute', value)}
      />
    </View>
  );
}

function ManualRouteInfoModal({
  visible,
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  visible: boolean;
  draft: RouteInfoDraft;
  onChange: <K extends keyof RouteInfoDraft>(key: K, value: RouteInfoDraft[K]) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.manualRouteInfoCard}>
          <Text style={styles.menuTitle}>경로 정보 입력</Text>
          <RouteInfoEditor draft={draft} onChange={onChange} />
          <View style={styles.routeCaptureActionRow}>
            <Pressable style={[styles.secondaryButton, styles.routeCaptureActionButton]} onPress={onCancel}>
              <Text style={styles.secondaryButtonText}>경로 다시 수정</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.routeCaptureActionButton]} onPress={onSave}>
              <Text style={styles.buttonText}>최종 저장</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ModeButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.modeButton, selected && styles.modeButtonActive]}
      onPress={onPress}>
      <Text style={[styles.modeButtonText, selected && styles.modeButtonTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SavedRouteSelector({
  routes,
  activeRouteId,
  onSelect,
}: {
  routes: SavedRoute[];
  activeRouteId: string;
  onSelect: (routeId: string) => void;
}) {
  return (
    <View style={styles.savedRoutePanel}>
      <Text style={styles.settingLabel}>{'\uD65C\uC131 \uB4F1\uD558\uAD50 \uACBD\uB85C'}</Text>
      {routes.length === 0 ? (
        <Text style={styles.settingDescription}>
          {'\uC800\uC7A5\uB41C \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uAC1C\uC778 \uC815\uBCF4 \uC218\uC815\uC5D0\uC11C \uACBD\uB85C\uB97C \uC790\uB3D9 \uC778\uC2DD\uD558\uAC70\uB098 \uC785\uB825\uD574 \uC8FC\uC138\uC694.'}
        </Text>
      ) : (
        routes.map(route => (
          <Pressable
            key={route.id}
            style={[
              styles.savedRouteOption,
              route.id === activeRouteId && styles.savedRouteOptionActive,
            ]}
            onPress={() => onSelect(route.id)}>
            <View style={styles.savedRouteOptionText}>
              <Text
                style={[
                  styles.savedRouteName,
                  route.id === activeRouteId && styles.savedRouteNameActive,
                ]}>
                {route.name}
              </Text>
              <Text
                style={[
                  styles.savedRouteMeta,
                  route.id === activeRouteId && styles.savedRouteMetaActive,
                ]}>
                {`${route.waypoints.length}\uAC1C \uC9C0\uC810 · ${formatRouteTimeRange(route)}`}
              </Text>
            </View>
            <Text
              style={[
                styles.savedRouteBadge,
                route.id === activeRouteId && styles.savedRouteBadgeActive,
              ]}>
              {route.id === activeRouteId ? '\uC0AC\uC6A9 \uC911' : '\uC120\uD0DD'}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

function SavedRouteManager({
  routes,
  activeRouteId,
  kakaoKey,
  onUpdateRoute,
  onActivateRoute,
  onEditRouteWaypoints,
  onDeleteRoute,
}: {
  routes: SavedRoute[];
  activeRouteId: string;
  kakaoKey: string;
  onUpdateRoute: (routeId: string, updates: Partial<SavedRoute>) => void;
  onActivateRoute: (routeId: string) => void;
  onEditRouteWaypoints: (routeId: string) => void;
  onDeleteRoute: (routeId: string) => void;
}) {
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null);

  useEffect(() => {
    if (expandedRouteId && !routes.some(route => route.id === expandedRouteId)) {
      setExpandedRouteId(null);
    }
  }, [expandedRouteId, routes]);

  return (
    <View style={styles.formSection}>
      <View style={styles.routeManagerHeader}>
        <Text style={styles.settingLabel}>{'\uC800\uC7A5\uB41C \uACBD\uB85C \uAD00\uB9AC'}</Text>
        <Text style={styles.settingHint}>{`${routes.length}/${MAX_SAVED_ROUTES}`}</Text>
      </View>
      {routes.length === 0 ? (
        <Text style={styles.settingDescription}>
          {'\uC544\uC9C1 \uC800\uC7A5\uB41C \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uC704\uC758 \uC790\uB3D9/\uC218\uB3D9 \uC778\uC2DD\uC73C\uB85C \uACBD\uB85C\uB97C \uBA3C\uC800 \uB9CC\uB4E4\uC5B4 \uC8FC\uC138\uC694.'}
        </Text>
      ) : (
        routes.map(route => {
          const isExpanded = expandedRouteId === route.id;
          const isActive = route.id === activeRouteId;
          return (
            <View key={route.id} style={styles.routeManagerItem}>
              <Pressable
                style={styles.routeManagerSummary}
                onPress={() => setExpandedRouteId(isExpanded ? null : route.id)}
                onLongPress={() => onDeleteRoute(route.id)}>
                <View style={styles.savedRouteOptionText}>
                  <Text style={styles.savedRouteName}>{route.name}</Text>
                  <Text style={styles.savedRouteMeta}>
                    {`${route.waypoints.length}\uAC1C \uC9C0\uC810 · ${formatRouteTimeRange(route)}`}
                  </Text>
                  <Text style={styles.savedRouteMeta} numberOfLines={2}>
                    {`${route.start.address} → ${route.end.address}`}
                  </Text>
                </View>
                <Text style={[styles.savedRouteBadge, isActive && styles.routeManagerActiveBadge]}>
                  {isActive ? '\uC0AC\uC6A9 \uC911' : '\uBCF4\uAE30'}
                </Text>
              </Pressable>
              {isExpanded ? (
                <View style={styles.routeManagerEditor}>
                  <WebView
                    key={`route-preview-${route.id}-${route.waypoints.length}`}
                    source={{
                      html: buildKakaoRoutePreviewHtml(kakaoKey, route),
                      baseUrl: 'http://localhost',
                    }}
                    originWhitelist={['*']}
                    javaScriptEnabled
                    domStorageEnabled
                    mixedContentMode="always"
                    scrollEnabled={false}
                    style={styles.routePreviewWebView}
                  />
                  <RouteInfoEditor
                    draft={route}
                    onChange={(key, value) => onUpdateRoute(route.id, {[key]: value})}
                  />
                  <View style={styles.routeManagerActionRow}>
                    <Pressable
                      style={[styles.secondaryButton, styles.routeManagerActionButton]}
                      onPress={() => onActivateRoute(route.id)}>
                      <Text style={styles.secondaryButtonText}>
                        {isActive ? '\uD604\uC7AC \uC0AC\uC6A9 \uC911' : '\uC774 \uACBD\uB85C \uC0AC\uC6A9'}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.button, styles.routeManagerActionButton]}
                      onPress={() => onEditRouteWaypoints(route.id)}>
                      <Text style={styles.buttonText}>{'\uC6E8\uC774\uD3EC\uC778\uD2B8 \uC218\uC815'}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
}


function ProfileInput({
  label,
  value,
  placeholder,
  keyboardType,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder: string;
  keyboardType?: 'default' | 'number-pad' | 'phone-pad';
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.textInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}
function LocationPickerModal({
  visible,
  kakaoKey,
  webViewRef,
  onClose,
  onMessage,
}: {
  visible: boolean;
  kakaoKey: string;
  webViewRef: React.RefObject<WebView | null>;
  onClose: () => void;
  onMessage: (event: WebViewMessageEvent) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <WebView
          ref={webViewRef}
          source={{html: buildKakaoLocationPickerHtml(kakaoKey), baseUrl: 'http://localhost'}}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          onMessage={onMessage}
          style={styles.locationWebView}
        />
      </SafeAreaView>
    </Modal>
  );
}

function RoutePickerModal({
  visible,
  kakaoKey,
  routeKey,
  startLocation,
  destinationLocation,
  routePath,
  mode,
  onBack,
  onMessage,
}: {
  visible: boolean;
  kakaoKey: string;
  routeKey: string;
  startLocation: RoutineLocation | null;
  destinationLocation: RoutineLocation | null;
  routePath: RoutePathPoint[];
  mode: RoutePickerMode;
  onBack: () => void;
  onMessage: (event: WebViewMessageEvent) => void;
}) {
  if (!startLocation || !destinationLocation) {
    return null;
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onBack}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <WebView
          key={`route-${routeKey}-${mode}-${routePath.length}`}
          source={{
            html: buildKakaoRoutePickerHtml(kakaoKey, startLocation, destinationLocation, routePath, mode),
            baseUrl: 'http://localhost',
          }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          onMessage={onMessage}
          style={styles.locationWebView}
        />
      </SafeAreaView>
    </Modal>
  );
}

function RouteAutoCaptureModal({
  visible,
  kakaoKey,
  phase,
  startLocation,
  endLocation,
  waypoints,
  routeInfoDraft,
  onRouteInfoChange,
  onStartCapture,
  onStopCapture,
  onSaveRoute,
  onClose,
  onMessage,
}: {
  visible: boolean;
  kakaoKey: string;
  phase: RouteCapturePhase;
  startLocation: RoutineLocation | null;
  endLocation: RoutineLocation | null;
  waypoints: RoutePathPoint[];
  routeInfoDraft: RouteInfoDraft;
  onRouteInfoChange: <K extends keyof RouteInfoDraft>(key: K, value: RouteInfoDraft[K]) => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onSaveRoute: () => void;
  onClose: () => void | Promise<void>;
  onMessage: (event: WebViewMessageEvent) => void;
}) {
  if (!startLocation) {
    return null;
  }

  const mapEndLocation =
    endLocation ??
    routePointToRoutineLocation(
      waypoints[waypoints.length - 1] ?? startLocation,
      '자동 수집 목적지',
    );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <View style={styles.logsHeader}>
          <View style={styles.routeHeaderText}>
            <Text style={styles.logsTitle}>{'\uACBD\uB85C \uC790\uB3D9 \uC778\uC2DD'}</Text>
            <Text style={styles.logsSubtitle}>
              {phase === 'collecting'
                ? `${waypoints.length}\uAC1C \uC9C0\uC810 \uC218\uC9D1 \uC911`
                : phase === 'review'
                  ? '\uC218\uC9D1\uB41C \uACBD\uB85C \uAC80\uC218'
                  : '\uC2DC\uC791 \uC9C0\uC810 \uD655\uC778'}
            </Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>{'\uB2EB\uAE30'}</Text>
          </Pressable>
        </View>
        <WebView
          key={`auto-route-${phase}-${waypoints.length}-${mapEndLocation.latitude}-${mapEndLocation.longitude}`}
          source={{
            html: buildKakaoAutoRouteCaptureHtml(
              kakaoKey,
              phase,
              startLocation,
              mapEndLocation,
              waypoints,
            ),
            baseUrl: 'http://localhost',
          }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          onMessage={onMessage}
          style={styles.locationWebView}
        />
        {phase === 'confirm' ? (
          <View style={styles.routeCaptureConfirmCard}>
            <Text style={styles.settingLabel}>
              {'\uC5EC\uAE30\uB97C \uC0C8\uB85C\uC6B4 \uCD9C\uBC1C\uC9C0\uB85C \uC9C0\uC815\uD558\uACE0 \uC790\uB3D9 \uC218\uC9D1\uC744 \uC2DC\uC791\uD560\uAE4C\uC694?'}
            </Text>
            <Text style={styles.settingDescription}>
              {'GPS \uC624\uCC28\uAC00 \uC788\uC744 \uC218 \uC788\uC73C\uBBC0\uB85C, \uC9C0\uB3C4\uC758 \uCD9C\uBC1C\uC9C0 \uB9C8\uCEE4\uB97C \uB4DC\uB798\uADF8\uD574 \uC704\uCE58\uB97C \uBBF8\uC138 \uC870\uC815\uD55C \uB4A4 \uC2DC\uC791\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.'}
            </Text>
            <View style={styles.routeCaptureActionRow}>
              <Pressable style={[styles.secondaryButton, styles.routeCaptureActionButton]} onPress={onClose}>
                <Text style={styles.secondaryButtonText}>{'\uCDE8\uC18C'}</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.routeCaptureActionButton]} onPress={onStartCapture}>
                <Text style={styles.buttonText}>{'\uC2DC\uC791'}</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {phase === 'collecting' ? (
          <View style={styles.routeCaptureBottomBar}>
            <Text style={styles.settingDescription}>
              {'10\uCD08\uB9C8\uB2E4 GPS \uC815\uD655\uB3C4\uC640 4m \uC774\uB3D9 \uC870\uAC74\uC744 \uD655\uC778\uD574 \uC9C0\uC810\uC744 \uC800\uC7A5\uD569\uB2C8\uB2E4.'}
            </Text>
            <Pressable style={styles.cancelButton} onPress={onStopCapture}>
              <Text style={styles.cancelButtonText}>{'\uACBD\uB85C \uC790\uB3D9 \uC218\uC9D1 \uC885\uB8CC'}</Text>
            </Pressable>
          </View>
        ) : null}
        {phase === 'review' ? (
          <View style={styles.routeCaptureBottomBar}>
            <Text style={styles.settingDescription}>
              {'\uC911\uAC04 \uB9C8\uCEE4\uB97C \uB20C\uB7EC \uC0AD\uC81C\uD558\uACE0, \uB3C4\uCC29\uC9C0 \uB9C8\uCEE4\uB294 \uB4DC\uB798\uADF8\uD574 \uC870\uC815\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.'}
            </Text>
            <RouteInfoEditor draft={routeInfoDraft} onChange={onRouteInfoChange} />
            <Pressable style={styles.button} onPress={onSaveRoute}>
              <Text style={styles.buttonText}>{'\uCD5C\uC885 \uC800\uC7A5'}</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

function RouteStatusModal({
  visible,
  kakaoKey,
  webViewRef,
  startLocation,
  destinationLocation,
  routePath,
  currentLocation,
  mapVersion,
  mapStatusText,
  routeDeviationDistanceMeters,
  routeDeviationStatus,
  onClose,
}: {
  visible: boolean;
  kakaoKey: string;
  webViewRef: React.RefObject<WebView | null>;
  startLocation: RoutineLocation | null;
  destinationLocation: RoutineLocation | null;
  routePath: RoutePathPoint[];
  currentLocation: EmergencyLocation | null;
  mapVersion: number;
  mapStatusText: string;
  routeDeviationDistanceMeters: number;
  routeDeviationStatus: RouteDeviationStatus | null;
  onClose: () => void;
}) {
  const statusText = routeDeviationStatus?.route_deviation ? '경로 이탈' : '경로 일치';
  const distanceText =
    typeof routeDeviationStatus?.distance_meters === 'number'
      ? `${Math.round(routeDeviationStatus.distance_meters)}m`
      : '확인 중';
  const mapSource = useMemo(
    () => ({
      html:
        startLocation && destinationLocation && currentLocation && routePath.length >= 2
          ? buildKakaoRouteStatusHtml(
              kakaoKey,
              startLocation,
              destinationLocation,
              routePath,
              currentLocation,
              routeDeviationDistanceMeters,
              mapStatusText,
            )
          : '',
      baseUrl: 'http://localhost',
    }),
    [
      kakaoKey,
      startLocation,
      destinationLocation,
      routePath,
      currentLocation,
      routeDeviationDistanceMeters,
      mapStatusText,
      mapVersion,
    ],
  );

  if (!startLocation || !destinationLocation || !currentLocation || routePath.length < 2) {
    return null;
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <View style={styles.logsHeader}>
          <View style={styles.routeHeaderText}>
            <Text style={styles.logsTitle}>현재 경로</Text>
            <Text style={styles.logsSubtitle}>{`${statusText} · 경로까지 ${distanceText}`}</Text>
          </View>
          <View style={styles.routeHeaderActions}>
            <Pressable style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
        </View>
        <WebView
          key={`route-status-${mapVersion}`}
          ref={webViewRef}
          source={mapSource}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          style={styles.locationWebView}
        />
      </SafeAreaView>
    </Modal>
  );
}

function PromptEditorField({
  label,
  description,
  value,
  onChangeText,
  minHeight,
}: {
  label: string;
  description: string;
  value: string;
  onChangeText: (value: string) => void;
  minHeight: number;
}) {
  return (
    <View style={styles.promptEditorSection}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingDescription}>{description}</Text>
      <TextInput
        style={[styles.promptInput, {minHeight}]}
        value={value}
        onChangeText={onChangeText}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}
function LogRow({
  label,
  value,
  monospace,
}: {
  label: string;
  value?: string;
  monospace?: boolean;
}) {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.logRow}>
      <Text style={styles.logLabel}>{label}</Text>
      <Text style={[styles.logValue, monospace && styles.logValueMono]}>
        {value}
      </Text>
    </View>
  );
}

function normalizePhoneNumber(value: string) {
  return value.replace(/\D/g, '').slice(0, 11);
}

function createRouteInfoDraft(name = ''): RouteInfoDraft {
  return {
    name,
    startHour: '',
    startMinute: '',
    destinationHour: '',
    destinationMinute: '',
  };
}

function normalizeTimePart(value: unknown, max: number) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '').slice(0, 2) : '';
  if (!digits) {
    return '';
  }
  const parsed = Number(digits);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? digits : '';
}

function normalizeRouteInfoDraft(
  draft: Partial<RouteInfoDraft>,
  fallbackName: string,
): RouteInfoDraft {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  return {
    name: name || fallbackName.trim() || '\uC800\uC7A5 \uACBD\uB85C',
    startHour: normalizeTimePart(draft.startHour, 23),
    startMinute: normalizeTimePart(draft.startMinute, 59),
    destinationHour: normalizeTimePart(draft.destinationHour, 23),
    destinationMinute: normalizeTimePart(draft.destinationMinute, 59),
  };
}

function parseBirthdayParts(value?: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  return {
    year: match?.[1] ?? '',
    month: match?.[2]?.replace(/^0(?=\d)/, '') ?? '',
    day: match?.[3]?.replace(/^0(?=\d)/, '') ?? '',
  };
}

function validateBirthdayParts(year: string, month: string, day: string) {
  if (month && (Number(month) < 1 || Number(month) > 12)) {
    return '\uC6D4\uC740 1~12\uBC94\uC704\uC758 \uC815\uC218\uB9CC \uC785\uB825\uD574 \uC8FC\uC138\uC694.';
  }
  if (!day) {
    return '';
  }
  if (Number(day) < 1) {
    return '\uC77C\uC740 1\uC774\uC0C1\uC758 \uC815\uC218\uB9CC \uC785\uB825\uD574 \uC8FC\uC138\uC694.';
  }
  if (month) {
    const safeYear = year.length === 4 ? Number(year) : 2024;
    const maxDay = new Date(safeYear, Number(month), 0).getDate();
    if (Number(day) > maxDay) {
      return `${Number(month)}\uC6D4\uC740 ${maxDay}\uC77C\uAE4C\uC9C0\uB9CC \uC785\uB825\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`;
    }
  } else if (Number(day) > 31) {
    return '\uC77C\uC740 1~31\uBC94\uC704\uC758 \uC815\uC218\uB9CC \uC785\uB825\uD574 \uC8FC\uC138\uC694.';
  }
  return '';
}

function parseBirthday(value?: string) {
  if (!value) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function formatBirthday(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeGender(value?: string) {
  if (value === 'male' || value === '\uB0A8' || value === '\uB0A8\uC131') {
    return 'male';
  }
  if (value === 'female' || value === '\uC5EC' || value === '\uC5EC\uC131') {
    return 'female';
  }
  return '';
}

function splitLegacyTime(value?: string) {
  const match = /(\d{1,2})\s*[:\uC2DC]\s*(\d{1,2})?/.exec(value ?? '');
  if (!match) {
    return {hour: '', minute: ''};
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? String(hour) : '',
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? String(minute) : '',
  };
}

function normalizeAppSettings(input: Partial<AppSettings> & {sttEnabled?: boolean}): AppSettings {
  return {
    ...defaultAppSettings,
    ...input,
    sttEngine: resolveSttEngine(input),
    sirenEnabled: input.sirenEnabled ?? defaultAppSettings.sirenEnabled,
    customPrompt: input.customPrompt || defaultAppSettings.customPrompt,
    sensorThreshold: normalizeMotionSensorThreshold(
      input.sensorThreshold,
      defaultAppSettings.sensorThreshold,
    ),
    gyroThreshold: normalizeMotionSensorThreshold(
      input.gyroThreshold,
      defaultAppSettings.gyroThreshold,
    ),
    audioRmsThreshold:
      input.audioRmsThreshold ?? defaultAppSettings.audioRmsThreshold,
    preTriggerSeconds: normalizeAnalysisWindowSeconds(
      input.preTriggerSeconds,
      defaultAppSettings.preTriggerSeconds,
    ),
    postTriggerSeconds: normalizeAnalysisWindowSeconds(
      input.postTriggerSeconds,
      defaultAppSettings.postTriggerSeconds,
    ),
    routeDeviationDistanceMeters: normalizePositiveInteger(
      input.routeDeviationDistanceMeters,
      defaultAppSettings.routeDeviationDistanceMeters,
    ),
    routeDeviationDurationSeconds: normalizePositiveInteger(
      input.routeDeviationDurationSeconds,
      defaultAppSettings.routeDeviationDurationSeconds,
    ),
    safetyProfile: normalizeSafetyProfile(input.safetyProfile),
  };
}

function normalizeMotionSensorThreshold(value: unknown, fallback: number) {
  const parsed = parsePositiveInteger(value);
  return parsed ?? fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsed = parsePositiveInteger(value);
  return parsed ?? fallback;
}

function parsePositiveInteger(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function normalizeAnalysisWindowSeconds(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(
    MIN_ANALYSIS_WINDOW_SECONDS,
    Math.min(MAX_ANALYSIS_WINDOW_SECONDS, Math.round(parsed)),
  );
}

function normalizeSafetyProfile(input?: Partial<SafetyProfile> & {age?: string; startTime?: string; destinationTime?: string}): SafetyProfile {
  const legacyStart = splitLegacyTime(input?.startTime);
  const legacyDestination = splitLegacyTime(input?.destinationTime);
  const savedRoutes = normalizeSavedRoutes(input?.savedRoutes);
  const activeRouteId =
    typeof input?.activeRouteId === 'string' &&
    savedRoutes.some(route => route.id === input.activeRouteId)
      ? input.activeRouteId
      : savedRoutes.find(route => route.isActive)?.id ?? '';
  const activeRoute = savedRoutes.find(route => route.id === activeRouteId);
  return {
    ...defaultSafetyProfile,
    ...input,
    mode: input?.mode === 'child' || input?.mode === 'adult' ? input.mode : null,
    birthday: input?.birthday ?? '',
    gender: normalizeGender(input?.gender),
    emergencyPhone: normalizePhoneNumber(input?.emergencyPhone ?? ''),
    startLocation: activeRoute?.start ?? normalizeRoutineLocation(input?.startLocation),
    destinationLocation: activeRoute?.end ?? normalizeRoutineLocation(input?.destinationLocation),
    childRoutePath: activeRoute?.waypoints ?? normalizeRoutePath(input?.childRoutePath),
    savedRoutes: savedRoutes.map(route => ({
      ...route,
      isActive: route.id === activeRouteId,
    })),
    activeRouteId,
    startHour: activeRoute?.startHour ?? input?.startHour ?? legacyStart.hour,
    startMinute: activeRoute?.startMinute ?? input?.startMinute ?? legacyStart.minute,
    destinationHour: activeRoute?.destinationHour ?? input?.destinationHour ?? legacyDestination.hour,
    destinationMinute: activeRoute?.destinationMinute ?? input?.destinationMinute ?? legacyDestination.minute,
  };
}

function normalizeRoutineLocation(
  input?: Partial<RoutineLocation> | null,
): RoutineLocation | null {
  if (
    !input ||
    typeof input.latitude !== 'number' ||
    typeof input.longitude !== 'number' ||
    typeof input.address !== 'string'
  ) {
    return null;
  }

  return {
    latitude: input.latitude,
    longitude: input.longitude,
    address: input.address,
  };
}

function normalizeRoutePath(input?: Partial<RoutePathPoint>[] | null): RoutePathPoint[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter(
      point =>
        typeof point?.latitude === 'number' &&
        typeof point?.longitude === 'number',
    )
    .map(point => ({
      latitude: point.latitude as number,
      longitude: point.longitude as number,
    }));
}

function normalizeSavedRoutes(input?: Partial<SavedRoute>[] | null): SavedRoute[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .slice(0, MAX_SAVED_ROUTES)
    .map((route, index) => {
      const start = normalizeRoutineLocation(route?.start);
      const end = normalizeRoutineLocation(route?.end);
      const waypoints = normalizeRoutePath(route?.waypoints);
      if (!start || !end || waypoints.length === 0) {
        return undefined;
      }
      const routeInfo = normalizeRouteInfoDraft(
        route ?? {},
        `\uC800\uC7A5 \uACBD\uB85C ${index + 1}`,
      );
      return {
        id: typeof route?.id === 'string' && route.id ? route.id : `legacy-route-${index}`,
        ...routeInfo,
        isActive: Boolean(route?.isActive),
        start,
        end,
        waypoints,
      };
    })
    .filter((route): route is SavedRoute => Boolean(route));
}

function activateRouteInProfile(profile: SafetyProfile, routeId: string): SafetyProfile {
  const selectedRoute = profile.savedRoutes.find(route => route.id === routeId);
  if (!selectedRoute) {
    return profile;
  }

  return {
    ...profile,
    savedRoutes: profile.savedRoutes.map(route => ({
      ...route,
      isActive: route.id === routeId,
    })),
    activeRouteId: routeId,
    startLocation: selectedRoute.start,
    destinationLocation: selectedRoute.end,
    childRoutePath: selectedRoute.waypoints,
    startHour: selectedRoute.startHour,
    startMinute: selectedRoute.startMinute,
    destinationHour: selectedRoute.destinationHour,
    destinationMinute: selectedRoute.destinationMinute,
  };
}

function addSavedRouteToProfile(profile: SafetyProfile, route: SavedRoute): SafetyProfile {
  const savedRoutes = [
    ...profile.savedRoutes.map(savedRoute => ({...savedRoute, isActive: false})),
    route,
  ].slice(-MAX_SAVED_ROUTES);

  return {
    ...profile,
    savedRoutes,
    activeRouteId: route.id,
    startLocation: route.start,
    destinationLocation: route.end,
    childRoutePath: route.waypoints,
    startHour: route.startHour,
    startMinute: route.startMinute,
    destinationHour: route.destinationHour,
    destinationMinute: route.destinationMinute,
  };
}

function updateSavedRouteInProfile(
  profile: SafetyProfile,
  routeId: string,
  updates: Partial<SavedRoute>,
): SafetyProfile {
  let updatedActiveRoute: SavedRoute | undefined;
  const savedRoutes = profile.savedRoutes.map(route => {
    if (route.id !== routeId) {
      return route;
    }
    const nextRoute = {
      ...route,
      ...updates,
      ...(updates.name !== undefined ||
      updates.startHour !== undefined ||
      updates.startMinute !== undefined ||
      updates.destinationHour !== undefined ||
      updates.destinationMinute !== undefined
        ? normalizeRouteInfoDraft({...route, ...updates}, route.name)
        : {}),
      waypoints: updates.waypoints ? normalizeRoutePath(updates.waypoints) : route.waypoints,
    };
    if (route.id === profile.activeRouteId) {
      updatedActiveRoute = nextRoute;
    }
    return nextRoute;
  });

  if (!updatedActiveRoute) {
    return {
      ...profile,
      savedRoutes,
    };
  }

  return {
    ...profile,
    savedRoutes,
    startLocation: updatedActiveRoute.start,
    destinationLocation: updatedActiveRoute.end,
    childRoutePath: updatedActiveRoute.waypoints,
    startHour: updatedActiveRoute.startHour,
    startMinute: updatedActiveRoute.startMinute,
    destinationHour: updatedActiveRoute.destinationHour,
    destinationMinute: updatedActiveRoute.destinationMinute,
  };
}

function deleteSavedRouteFromProfile(profile: SafetyProfile, routeId: string): SafetyProfile {
  const savedRoutes = profile.savedRoutes.filter(route => route.id !== routeId);
  if (savedRoutes.length === profile.savedRoutes.length) {
    return profile;
  }

  if (savedRoutes.length === 0) {
    return {
      ...profile,
      savedRoutes: [],
      activeRouteId: '',
      startLocation: null,
      destinationLocation: null,
      childRoutePath: [],
      startHour: '',
      startMinute: '',
      destinationHour: '',
      destinationMinute: '',
    };
  }

  if (profile.activeRouteId !== routeId) {
    return {
      ...profile,
      savedRoutes,
    };
  }

  const nextActiveRoute = savedRoutes[0];
  return {
    ...profile,
    savedRoutes: savedRoutes.map(route => ({
      ...route,
      isActive: route.id === nextActiveRoute.id,
    })),
    activeRouteId: nextActiveRoute.id,
    startLocation: nextActiveRoute.start,
    destinationLocation: nextActiveRoute.end,
    childRoutePath: nextActiveRoute.waypoints,
    startHour: nextActiveRoute.startHour,
    startMinute: nextActiveRoute.startMinute,
    destinationHour: nextActiveRoute.destinationHour,
    destinationMinute: nextActiveRoute.destinationMinute,
  };
}

function routePointToRoutineLocation(
  point: RoutePathPoint,
  address: string,
): RoutineLocation {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    address,
  };
}

function createRouteId(seed = Date.now()) {
  return `route-${Date.now()}-${seed}`;
}

function isKakaoKeyConfigured(key: string) {
  return key.trim().length > 0 && key !== 'YOUR_KAKAO_JAVASCRIPT_KEY';
}

function formatSavedRouteSummary(routes: SavedRoute[], activeRouteId: string) {
  if (routes.length === 0) {
    return '\uC800\uC7A5\uB41C \uACBD\uB85C \uC5C6\uC74C';
  }
  const activeRoute = routes.find(route => route.id === activeRouteId);
  if (!activeRoute) {
    return `${routes.length}\uAC1C \uACBD\uB85C \uC800\uC7A5\uB428`;
  }
  return `${routes.length}\uAC1C \uACBD\uB85C \uC911 ${activeRoute.name} \uC0AC\uC6A9 \uC911`;
}

function formatRouteTimeRange(route: Pick<SavedRoute, RouteScheduleKey>) {
  const start = formatTimeLabel(route.startHour, route.startMinute);
  const end = formatTimeLabel(route.destinationHour, route.destinationMinute);
  if (!start && !end) {
    return '\uC2DC\uAC04 \uBBF8\uC124\uC815';
  }
  return `${start || '--:--'}~${end || '--:--'}`;
}

function formatTimeLabel(hour: string, minute: string) {
  if (!hour && !minute) {
    return '';
  }
  return `${hour.padStart(2, '0')}:${(minute || '0').padStart(2, '0')}`;
}

function kakaoScriptUrl(kakaoKey: string) {
  return `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(
    kakaoKey,
  )}&libraries=services&autoload=false`;
}

function buildKakaoLocationPickerHtml(kakaoKey: string) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>${kakaoPickerCss()}</style>
</head>
<body>
  <button class="headerClose" type="button" onclick="post({type: 'close'})">Close</button>
  <div id="postcode"><div class="status">Loading address search...</div></div>
  <div id="mapScreen" class="hidden">
    <div id="map"></div>
    <div class="pinConfirmPanel">
      <button id="confirmPin" class="primary pinConfirmButton" type="button">Confirm</button>
    </div>
  </div>
  <script src="https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"></script>
  <script src="${kakaoScriptUrl(kakaoKey)}" onerror="window.__kakaoSdkLoadFailed = true"></script>
  <script>
    var map = null;
    var marker = null;
    var selectedAddress = '';
    var isDraggingMarker = false;
    var geocodeDiagnostics = [];

    ${kakaoSharedJs()}

    function debug(message) {
      var alertMessage = message.length > 240 ? message.slice(0, 240) + '...' : message;
      geocodeDiagnostics.push(alertMessage);
      if (window.console && window.console.log) {
        window.console.log('[LocationPicker] ' + message);
      }
      post({ type: 'locationPickerDebug', message: message });
    }

    function snapshot(value, depth, seen) {
      var type = typeof value;
      if (value === null || type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
        return value;
      }
      if (type === 'function') {
        return '[Function]';
      }
      if (seen.indexOf(value) >= 0) {
        return '[Circular]';
      }
      if (depth >= 4) {
        return '[' + Object.prototype.toString.call(value) + ']';
      }

      seen.push(value);
      var keys = Object.keys(value).slice(0, 24);
      var output = {
        __type: Object.prototype.toString.call(value),
        __keys: keys,
      };
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        output[key] = snapshot(value[key], depth + 1, seen);
      }
      seen.pop();
      return output;
    }

    function stringifyDebug(value) {
      try {
        return JSON.stringify(snapshot(value, 0, []));
      } catch (error) {
        return String(value);
      }
    }

    function debugChunked(label, value) {
      var text = label + '=' + stringifyDebug(value);
      var maxLength = 900;
      for (var i = 0; i < text.length; i += maxLength) {
        debug(text.slice(i, i + maxLength));
      }
    }

    function debugKakaoCallback(label, candidate, result, status) {
      debug(label + ' meta candidate=' + candidate +
        ' resultType=' + typeof result +
        ' resultString=' + String(result) +
        ' resultLength=' + (result && typeof result.length !== 'undefined' ? result.length : 'n/a') +
        ' statusType=' + typeof status +
        ' statusString=' + String(status));
      debugChunked(label + ' result', result);
      debugChunked(label + ' status', status);
    }

    function failWithDiagnostics(message) {
      var suffix = geocodeDiagnostics.length > 0
        ? '\\n\\n디버그 로그는 logcat/Metro 콘솔의 [LocationPicker] 항목을 확인해 주세요.\\n최근 로그:\\n' + geocodeDiagnostics.slice(-3).join('\\n')
        : '';
      fail(message + suffix);
    }

    function unique(values) {
      var seen = {};
      return values
        .map(function(value) { return (value || '').trim(); })
        .filter(function(value) {
          if (!value || seen[value]) { return false; }
          seen[value] = true;
          return true;
        });
    }

    function addressCandidates(data) {
      var roadCandidate = data.roadAddress || data.autoRoadAddress || '';
      var jibunCandidate = data.jibunAddress || data.autoJibunAddress || '';
      var primary = data.userSelectedType === 'J' ? jibunCandidate : roadCandidate;
      var fallback = data.userSelectedType === 'J' ? roadCandidate : jibunCandidate;
      return unique([
        primary,
        fallback,
        data.address,
        data.roadAddress,
        data.jibunAddress,
        data.autoRoadAddress,
        data.autoJibunAddress,
      ]);
    }

    function hasSameArea(place, data, candidate) {
      var text = [
        place.address_name,
        place.road_address_name,
        place.place_name,
      ].filter(Boolean).join(' ');
      if (!text) { return false; }
      if (data.sigungu && text.indexOf(data.sigungu) < 0) { return false; }
      if (data.roadname && text.indexOf(data.roadname) >= 0) { return true; }
      if (data.bname && text.indexOf(data.bname) >= 0) { return true; }
      return text.replace(/\\s/g, '').indexOf(candidate.replace(/\\s/g, '')) >= 0;
    }

    function coordinateValue(source, keys) {
      for (var i = 0; i < keys.length; i += 1) {
        var raw = source ? source[keys[i]] : null;
        var numeric = Number(raw);
        if (raw !== null && raw !== undefined && isFinite(numeric)) {
          return numeric;
        }
      }
      return null;
    }

    function validCoordinates(latitude, longitude) {
      return isFinite(latitude) &&
        isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180;
    }

    function coordinatesFromResult(value, depth) {
      if (!value || depth > 8) { return null; }

      if (typeof value.getLat === 'function' && typeof value.getLng === 'function') {
        var methodLatitude = Number(value.getLat());
        var methodLongitude = Number(value.getLng());
        if (validCoordinates(methodLatitude, methodLongitude)) {
          return { latitude: methodLatitude, longitude: methodLongitude };
        }
      }

      var latitude = coordinateValue(value, ['y', 'Y', 'lat', 'latitude', 'Lat', 'Latitude', 'Ma', 'ha']);
      var longitude = coordinateValue(value, ['x', 'X', 'lng', 'longitude', 'lon', 'Long', 'Longitude', 'La', 'qa']);
      if (latitude !== null && longitude !== null && validCoordinates(latitude, longitude)) {
        return { latitude: latitude, longitude: longitude };
      }

      if (
        value.length === 2 &&
        value[0] !== null &&
        value[0] !== undefined &&
        value[1] !== null &&
        value[1] !== undefined
      ) {
        var first = Number(value[0]);
        var second = Number(value[1]);
        if (validCoordinates(second, first)) {
          return { latitude: second, longitude: first };
        }
        if (validCoordinates(first, second)) {
          return { latitude: first, longitude: second };
        }
      }

      var nestedKeys = ['address', 'road_address', '0'];
      for (var i = 0; i < nestedKeys.length; i += 1) {
        var nested = coordinatesFromResult(value[nestedKeys[i]], depth + 1);
        if (nested) { return nested; }
      }

      var keys = Object.keys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var key = keys[keyIndex];
        if (/^\\d+$/.test(key) || key === 'coords' || key === 'position' || key === 'point') {
          var keyCoordinates = coordinatesFromResult(value[key], depth + 1);
          if (keyCoordinates) { return keyCoordinates; }
        }
      }

      if (typeof value.length === 'number') {
        for (var j = 0; j < value.length; j += 1) {
          var itemCoordinates = coordinatesFromResult(value[j], depth + 1);
          if (itemCoordinates) { return itemCoordinates; }
        }
      }
      return null;
    }

    function hasSameAreaDeep(value, data, candidate, depth) {
      if (!value || depth > 4) { return false; }
      if (hasSameArea(value, data, candidate)) { return true; }
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        if (/^\\d+$/.test(key) || key === 'address' || key === 'road_address') {
          if (hasSameAreaDeep(value[key], data, candidate, depth + 1)) {
            return true;
          }
        }
      }
      return false;
    }

    function coordinatesFromResults(results, data, candidate, requireSameArea) {
      if (!results || !results.length) { return null; }
      for (var i = 0; i < results.length; i += 1) {
        var coordinates = coordinatesFromResult(results[i], 0);
        if (coordinates && (!requireSameArea || hasSameAreaDeep(results[i], data, candidate, 0))) {
          return coordinates;
        }
      }
      return null;
    }

    function shape(value, depth) {
      if (!value || depth > 3) { return []; }
      var keys = Object.keys(value).slice(0, 12);
      var nested = {};
      for (var i = 0; i < keys.length; i += 1) {
        var key = keys[i];
        if (/^\\d+$/.test(key) || key === 'address' || key === 'road_address') {
          nested[key] = shape(value[key], depth + 1);
        }
      }
      return { keys: keys, nested: nested };
    }

    function resultShapeForDebug(results) {
      if (!results || !results.length || !results[0]) { return 'empty-result'; }
      return JSON.stringify(shape(results[0], 0));
    }

    function geocodeAddress(data) {
      geocodeDiagnostics = [];
      var candidates = addressCandidates(data);
      var displayAddress = candidates[0];
      if (!displayAddress) { fail('Selected address is empty.'); return; }
      selectedAddress = displayAddress;
      debugChunked('postcodeData', data);
      debug('selectedSummary=' + JSON.stringify({
        userSelectedType: data.userSelectedType,
        sido: data.sido,
        sigungu: data.sigungu,
        bname: data.bname,
        roadname: data.roadname,
        candidates: candidates,
      }));

      setText('postcode', '좌표를 확인하는 중...');
      post({ type: 'addressSelected', address: displayAddress, candidates: candidates });
    }

    window.renderNativeGeocodeResult = function(payload) {
      if (!payload || payload.error) {
        fail(payload && payload.error ? payload.error : '선택한 주소의 좌표를 찾지 못했습니다. 더 구체적인 주소 결과를 선택해 주세요.');
        return;
      }

      var latitude = Number(payload.latitude);
      var longitude = Number(payload.longitude);
      if (!validCoordinates(latitude, longitude)) {
        fail('주소 좌표 응답 형식이 올바르지 않습니다.');
        return;
      }

      waitForKakaoSdk(function() {
        window.kakao.maps.load(function() {
          renderMap(payload.address || selectedAddress, latitude, longitude);
        });
      }, 0);
    };

    function tryGeocodeCandidate(geocoder, candidates, index, data) {
      if (index >= candidates.length) {
        tryPlaceCandidate(candidates, 0, data);
        return;
      }

      geocoder.addressSearch(candidates[index], function(result, status) {
        debugKakaoCallback('addressSearch', candidates[index], result, status);
        var coordinates = coordinatesFromResults(result, data, candidates[index], false);
        if (coordinates) {
          renderMap(candidates[index], coordinates.latitude, coordinates.longitude);
        } else {
          debug('addressSearch shape=' + resultShapeForDebug(result));
          tryGeocodeCandidate(geocoder, candidates, index + 1, data);
        }
      });
    }

    function tryPlaceCandidate(candidates, index, data) {
      if (!window.kakao.maps.services || !window.kakao.maps.services.Places) {
        failWithDiagnostics('선택한 주소의 좌표를 찾지 못했습니다. 더 구체적인 주소 결과를 선택해 주세요.');
        return;
      }
      if (index >= candidates.length) {
        failWithDiagnostics('선택한 주소의 좌표를 찾지 못했습니다. 더 구체적인 주소 결과를 선택해 주세요.');
        return;
      }

      var places = new window.kakao.maps.services.Places();
      places.keywordSearch(candidates[index], function(result, status) {
        debugKakaoCallback('keywordSearch', candidates[index], result, status);
        var coordinates = coordinatesFromResults(result, data, candidates[index], true);
        if (coordinates) {
          renderMap(candidates[index], coordinates.latitude, coordinates.longitude);
          return;
        }
        debug('keywordSearch shape=' + resultShapeForDebug(result));
        tryPlaceCandidate(candidates, index + 1, data);
      });
    }

    function renderMap(address, latitude, longitude) {
      selectedAddress = address;
      document.getElementById('postcode').className = 'hidden';
      document.getElementById('mapScreen').className = '';
      var center = new window.kakao.maps.LatLng(latitude, longitude);
      map = new window.kakao.maps.Map(document.getElementById('map'), { center: center, level: 2 });
      marker = new window.kakao.maps.Marker({ position: center, draggable: true, map: map });
      window.kakao.maps.event.addListener(marker, 'dragstart', function() { isDraggingMarker = true; });
      window.kakao.maps.event.addListener(marker, 'dragend', function() { isDraggingMarker = false; });
      window.kakao.maps.event.addListener(map, 'idle', function() {
        if (!isDraggingMarker && marker) { marker.setPosition(map.getCenter()); }
      });
      document.getElementById('confirmPin').onclick = function() {
        var position = marker.getPosition();
        post({ type: 'location', address: selectedAddress, latitude: position.getLat(), longitude: position.getLng() });
      };
      setTimeout(function() { map.relayout(); map.setCenter(center); }, 250);
    }

    function resizePostcode() {
      var height = window.innerHeight;
      if (window.visualViewport && window.visualViewport.height) {
        height = window.visualViewport.height;
      }
      var postcode = document.getElementById('postcode');
      if (postcode) {
        postcode.style.height = Math.max(260, height) + 'px';
      }
    }

    function openPostcode() {
      resizePostcode();
      if (!window.daum || !window.daum.Postcode) {
        fail('Daum address search service failed to load.');
        return;
      }
      new window.daum.Postcode({
        width: '100%',
        height: '100%',
        oncomplete: function(data) {
          geocodeAddress(data);
        }
      }).embed(document.getElementById('postcode'));
    }
    window.addEventListener('resize', resizePostcode);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', resizePostcode);
      window.visualViewport.addEventListener('scroll', resizePostcode);
    }
    window.addEventListener('load', function() { setTimeout(openPostcode, 300); });
  </script>
</body>
</html>`;
}

function buildKakaoRoutePickerHtml(
  kakaoKey: string,
  startLocation: RoutineLocation,
  destinationLocation: RoutineLocation,
  routePath: RoutePathPoint[],
  mode: RoutePickerMode,
) {
  const routePathJson = JSON.stringify(routePath);
  const isViewMode = mode === 'view';
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>${kakaoPickerCss()}</style>
</head>
<body>
  <div id="mapScreen">
    <div id="map"></div>
    <div class="mapPanel">
      <div class="title">${isViewMode ? '&#44221;&#47196; &#48372;&#44592;' : '&#44221;&#47196; &#51077;&#47141;'}</div>
      <div class="actions">
        ${isViewMode
          ? '<button id="editRoute" class="primary" type="button">&#54200;&#51665;</button>'
          : '<button id="undoRoute" class="secondary" type="button">&#46104;&#46028;&#47532;&#44592;</button><button id="clearRoute" class="secondary" type="button">&#52488;&#44592;&#54868;</button><button id="saveRoute" class="primary" type="button">&#51200;&#51109;</button>'}
      </div>
      <div id="counter" class="counter"></div>
    </div>
  </div>
  <script src="${kakaoScriptUrl(kakaoKey)}" onerror="window.__kakaoSdkLoadFailed = true"></script>
  <script>
    var map = null;
    var polyline = null;
    var routePoints = [];
    var routeMarkers = [];
    var mode = '${mode}';
    var initialRoutePath = ${routePathJson};
    var start = { lat: ${startLocation.latitude}, lng: ${startLocation.longitude} };
    var destination = { lat: ${destinationLocation.latitude}, lng: ${destinationLocation.longitude} };

    ${kakaoSharedJs()}

    function toLatLng(point) {
      return new window.kakao.maps.LatLng(point.lat, point.lng);
    }

    function routePathPointToLatLng(point) {
      return new window.kakao.maps.LatLng(point.latitude, point.longitude);
    }

    function renderMap() {
      var center = toLatLng(start);
      map = new window.kakao.maps.Map(document.getElementById('map'), { center: center, level: 3 });
      polyline = new window.kakao.maps.Polyline({ map: map, path: [], strokeWeight: 5, strokeColor: '#2563eb', strokeOpacity: 0.9, strokeStyle: 'solid' });
      new window.kakao.maps.Marker({ position: toLatLng(start), map: map });
      new window.kakao.maps.Marker({ position: toLatLng(destination), map: map });

      if (initialRoutePath.length > 0) {
        loadRoutePath(initialRoutePath, mode === 'edit');
      } else {
        addRoutePoint(toLatLng(start), true);
      }

      if (mode === 'view') {
        document.getElementById('editRoute').onclick = function() { post({ type: 'editRoute' }); };
      } else {
        window.kakao.maps.event.addListener(map, 'click', function(mouseEvent) { addRoutePoint(mouseEvent.latLng, true); });
        document.getElementById('undoRoute').onclick = undoRoute;
        document.getElementById('clearRoute').onclick = clearRoute;
        document.getElementById('saveRoute').onclick = saveRoute;
      }

      setText('counter', routePoints.length + ' \uAC1C \uC9C0\uC810 \uC120\uD0DD\uB428');
      setTimeout(function() { map.relayout(); fitRouteBounds(center); }, 250);
    }

    function loadRoutePath(path, showMarkers) {
      routePoints = path.map(routePathPointToLatLng);
      polyline.setPath(routePoints);
      if (showMarkers) {
        routePoints.forEach(function(point) {
          routeMarkers.push(new window.kakao.maps.Marker({ position: point, map: map }));
        });
      }
    }

    function fitRouteBounds(fallbackCenter) {
      if (!routePoints.length) {
        map.setCenter(fallbackCenter);
        return;
      }
      var bounds = new window.kakao.maps.LatLngBounds();
      routePoints.forEach(function(point) { bounds.extend(point); });
      bounds.extend(toLatLng(start));
      bounds.extend(toLatLng(destination));
      map.setBounds(bounds);
    }

    function addRoutePoint(latLng, showMarker) {
      routePoints.push(latLng);
      if (showMarker) {
        routeMarkers.push(new window.kakao.maps.Marker({ position: latLng, map: map }));
      }
      polyline.setPath(routePoints);
      setText('counter', routePoints.length + ' \uAC1C \uC9C0\uC810 \uC120\uD0DD\uB428');
    }

    function undoRoute() {
      if (routePoints.length <= 1) { return; }
      routePoints.pop();
      var marker = routeMarkers.pop();
      if (marker) { marker.setMap(null); }
      polyline.setPath(routePoints);
      setText('counter', routePoints.length + ' \uAC1C \uC9C0\uC810 \uC120\uD0DD\uB428');
    }

    function clearRoute() {
      routeMarkers.forEach(function(marker) { marker.setMap(null); });
      routeMarkers = [];
      routePoints = [];
      polyline.setPath([]);
      addRoutePoint(toLatLng(start), true);
    }

    function distanceMeters(a, b) {
      var radius = 6371000;
      var dLat = (b.lat - a.lat) * Math.PI / 180;
      var dLng = (b.lng - a.lng) * Math.PI / 180;
      var lat1 = a.lat * Math.PI / 180;
      var lat2 = b.lat * Math.PI / 180;
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function saveRoute() {
      if (routePoints.length < 2) { fail('\uC800\uC7A5\uD558\uB824\uBA74 \uACBD\uB85C \uC9C0\uC810\uC744 2\uAC1C \uC774\uC0C1 \uC120\uD0DD\uD558\uC138\uC694.'); return; }
      var last = routePoints[routePoints.length - 1];
      var lastPoint = { lat: last.getLat(), lng: last.getLng() };
      var distance = distanceMeters(lastPoint, destination);
      if (distance > 30) {
        fail('\uB9C8\uC9C0\uB9C9 \uC9C0\uC810\uC774 \uB3C4\uCC29\uC9C0\uC5D0\uC11C ' + Math.round(distance) + 'm \uB5A8\uC5B4\uC838 \uC788\uC2B5\uB2C8\uB2E4. 30m \uC774\uB0B4\uC5EC\uC57C \uD569\uB2C8\uB2E4.');
        return;
      }
      post({
        type: 'route',
        childRoutePath: routePoints.map(function(point) {
          return { latitude: point.getLat(), longitude: point.getLng() };
        })
      });
    }

    waitForKakaoSdk(function() { window.kakao.maps.load(renderMap); }, 0);
  </script>
</body>
</html>`;
}

function buildKakaoRoutePreviewHtml(kakaoKey: string, route: SavedRoute) {
  const routePathJson = JSON.stringify(route.waypoints);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; }
    body { background: #f3f4f6; overflow: hidden; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="${kakaoScriptUrl(kakaoKey)}" onerror="window.__kakaoSdkLoadFailed = true"></script>
  <script>
    var routePoints = ${routePathJson};
    var start = { latitude: ${route.start.latitude}, longitude: ${route.start.longitude} };
    var end = { latitude: ${route.end.latitude}, longitude: ${route.end.longitude} };
    ${kakaoSharedJs()}
    function toLatLng(point) {
      return new window.kakao.maps.LatLng(point.latitude, point.longitude);
    }
    function renderMap() {
      var fallback = routePoints.length > 0 ? routePoints[0] : start;
      var map = new window.kakao.maps.Map(document.getElementById('map'), { center: toLatLng(fallback), level: 4 });
      var path = routePoints.length > 0 ? routePoints.map(toLatLng) : [toLatLng(start), toLatLng(end)];
      new window.kakao.maps.Polyline({ map: map, path: path, strokeWeight: 5, strokeColor: '#2563eb', strokeOpacity: 0.9, strokeStyle: 'solid' });
      new window.kakao.maps.Marker({ position: toLatLng(start), map: map });
      new window.kakao.maps.Marker({ position: toLatLng(end), map: map });
      var bounds = new window.kakao.maps.LatLngBounds();
      path.forEach(function(point) { bounds.extend(point); });
      bounds.extend(toLatLng(start));
      bounds.extend(toLatLng(end));
      setTimeout(function() { map.relayout(); map.setBounds(bounds); }, 200);
    }
    waitForKakaoSdk(function() { window.kakao.maps.load(renderMap); }, 0);
  </script>
</body>
</html>`;
}

function buildKakaoRouteStatusHtml(
  kakaoKey: string,
  startLocation: RoutineLocation,
  destinationLocation: RoutineLocation,
  routePath: RoutePathPoint[],
  currentLocation: EmergencyLocation,
  routeDeviationDistanceMeters: number,
  statusText: string,
) {
  const routePathJson = JSON.stringify(routePath);
  const currentLocationJson = JSON.stringify(currentLocation);
  const routeDeviationDistanceMetersJson = JSON.stringify(routeDeviationDistanceMeters);
  const statusTextJson = JSON.stringify(statusText);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>
    html, body, #map { width: 100%; height: 100%; margin: 0; padding: 0; }
    body { background: #f3f4f6; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .currentOverlay { position: relative; width: 42px; height: 42px; }
    .headingArrow { position: absolute; left: 9px; top: 1px; width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 30px solid rgba(37,99,235,0.92); transform-origin: 12px 20px; filter: drop-shadow(0 2px 4px rgba(15,23,42,0.25)); }
    .centerDot { position: absolute; left: 13px; top: 13px; width: 10px; height: 10px; border: 4px solid #2563eb; border-radius: 50%; background: #ffffff; box-shadow: 0 2px 8px rgba(15,23,42,0.22); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="${kakaoScriptUrl(kakaoKey)}" onerror="window.__kakaoSdkLoadFailed = true"></script>
  <script>
    var map = null;
    var currentCircle = null;
    var currentOverlay = null;
    var routePoints = ${routePathJson};
    var start = { latitude: ${startLocation.latitude}, longitude: ${startLocation.longitude} };
    var end = { latitude: ${destinationLocation.latitude}, longitude: ${destinationLocation.longitude} };
    var current = ${currentLocationJson};
    var routeDeviationDistanceMeters = ${routeDeviationDistanceMetersJson};
    var statusText = ${statusTextJson};
    ${kakaoSharedJs()}
    function toLatLng(point) {
      return new window.kakao.maps.LatLng(point.latitude, point.longitude);
    }
    function headingDegrees(point) {
      return typeof point.heading === 'number' && isFinite(point.heading) ? point.heading : 0;
    }
    function currentOverlayHtml(point) {
      return '<div class="currentOverlay"><div class="headingArrow" style="transform: rotate(' + headingDegrees(point) + 'deg);"></div><div class="centerDot"></div></div>';
    }
    function renderCurrentLocation(point, shouldPan) {
      var currentLatLng = toLatLng(point);
      if (!currentCircle) {
        currentCircle = new window.kakao.maps.Circle({
          map: map,
          center: currentLatLng,
          radius: routeDeviationDistanceMeters,
          strokeWeight: 3,
          strokeColor: statusText === '경로 이탈' ? '#dc2626' : '#16a34a',
          strokeOpacity: 0.9,
          fillColor: statusText === '경로 이탈' ? '#fecaca' : '#bbf7d0',
          fillOpacity: 0.65
        });
      } else {
        currentCircle.setPosition(currentLatLng);
        currentCircle.setRadius(routeDeviationDistanceMeters);
        if (typeof currentCircle.setOptions === 'function') {
          currentCircle.setOptions({
            strokeColor: statusText === '경로 이탈' ? '#dc2626' : '#16a34a',
            fillColor: statusText === '경로 이탈' ? '#fecaca' : '#bbf7d0'
          });
        }
      }
      if (!currentOverlay) {
        currentOverlay = new window.kakao.maps.CustomOverlay({
          map: map,
          position: currentLatLng,
          content: currentOverlayHtml(point),
          xAnchor: 0.5,
          yAnchor: 0.5
        });
      } else {
        currentOverlay.setPosition(currentLatLng);
        currentOverlay.setContent(currentOverlayHtml(point));
      }
      if (shouldPan) {
        map.panTo(currentLatLng);
      }
    }
    window.updateCurrentLocation = function(nextLocation) {
      current = nextLocation;
      if (map) {
        renderCurrentLocation(current, true);
      }
    };
    window.updateRouteStatus = function(nextStatusText) {
      statusText = nextStatusText;
      if (map && current) {
        renderCurrentLocation(current, false);
      }
    };
    function renderMap() {
      map = new window.kakao.maps.Map(document.getElementById('map'), { center: toLatLng(current), level: 4 });
      var path = routePoints.length > 0 ? routePoints.map(toLatLng) : [toLatLng(start), toLatLng(end)];
      new window.kakao.maps.Polyline({ map: map, path: path, strokeWeight: 5, strokeColor: '#2563eb', strokeOpacity: 0.9, strokeStyle: 'solid' });
      new window.kakao.maps.Marker({ position: toLatLng(start), map: map });
      new window.kakao.maps.Marker({ position: toLatLng(end), map: map });
      var currentLatLng = toLatLng(current);
      renderCurrentLocation(current, false);
      var bounds = new window.kakao.maps.LatLngBounds();
      path.forEach(function(point) { bounds.extend(point); });
      bounds.extend(toLatLng(start));
      bounds.extend(toLatLng(end));
      bounds.extend(currentLatLng);
      setTimeout(function() { map.relayout(); map.setBounds(bounds); }, 200);
    }
    waitForKakaoSdk(function() { window.kakao.maps.load(renderMap); }, 0);
  </script>
</body>
</html>`;
}

function buildKakaoAutoRouteCaptureHtml(
  kakaoKey: string,
  phase: RouteCapturePhase,
  startLocation: RoutineLocation,
  endLocation: RoutineLocation,
  waypoints: RoutePathPoint[],
) {
  const routePathJson = JSON.stringify(
    (waypoints.length > 0 ? waypoints : [startLocation]).map(point => ({
      latitude: point.latitude,
      longitude: point.longitude,
    })),
  );
  const isReview = phase === 'review';
  const isConfirm = phase === 'confirm';

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <style>${kakaoPickerCss()}</style>
</head>
<body>
  <div id="mapScreen">
    <div id="map"></div>
  </div>
  <script src="${kakaoScriptUrl(kakaoKey)}" onerror="window.__kakaoSdkLoadFailed = true"></script>
  <script>
    var map = null;
    var polyline = null;
    var markers = [];
    var infoWindow = null;
    var phase = '${phase}';
    var isReview = ${isReview ? 'true' : 'false'};
    var isConfirm = ${isConfirm ? 'true' : 'false'};
    var routePoints = ${routePathJson};
    var start = { latitude: ${startLocation.latitude}, longitude: ${startLocation.longitude} };
    var end = { latitude: ${endLocation.latitude}, longitude: ${endLocation.longitude} };

    ${kakaoSharedJs()}

    function toLatLng(point) {
      return new window.kakao.maps.LatLng(point.latitude, point.longitude);
    }

    function pointFromLatLng(latLng) {
      return { latitude: latLng.getLat(), longitude: latLng.getLng() };
    }

    function clearMarkers() {
      markers.forEach(function(marker) { marker.setMap(null); });
      markers = [];
      if (infoWindow) { infoWindow.close(); infoWindow = null; }
    }

    function postEditedRoute() {
      post({
        type: 'routeEdited',
        waypoints: routePoints,
        end: end
      });
    }

    function postAdjustedStart() {
      post({
        type: 'routeStartAdjusted',
        start: start
      });
    }

    function updatePolyline() {
      polyline.setPath(routePoints.map(toLatLng));
    }

    function deleteWaypoint(index) {
      if (index <= 0 || index >= routePoints.length - 1) { return; }
      routePoints.splice(index, 1);
      clearMarkers();
      updatePolyline();
      renderMarkers();
      postEditedRoute();
    }
    window.deleteWaypoint = deleteWaypoint;

    function renderMarkers() {
      clearMarkers();
      routePoints.forEach(function(point, index) {
        var isStart = index === 0;
        var isEnd = index === routePoints.length - 1;
        var marker = new window.kakao.maps.Marker({
          position: toLatLng(point),
          map: map,
          draggable: (isReview && !isStart) || (isConfirm && isStart)
        });
        markers.push(marker);

        if (isConfirm && isStart) {
          window.kakao.maps.event.addListener(marker, 'click', function() {
            if (infoWindow) { infoWindow.close(); }
            infoWindow = new window.kakao.maps.InfoWindow({
              content: '<div style="padding:8px;white-space:nowrap;font-size:13px;font-weight:800;">마커를 드래그해 출발지를 조정하세요</div>'
            });
            infoWindow.open(map, marker);
          });
          window.kakao.maps.event.addListener(marker, 'dragend', function() {
            start = pointFromLatLng(marker.getPosition());
            routePoints[0] = start;
            updatePolyline();
            postAdjustedStart();
          });
        }

        if (isReview && !isStart && !isEnd) {
          window.kakao.maps.event.addListener(marker, 'click', function() {
            if (infoWindow) { infoWindow.close(); }
            infoWindow = new window.kakao.maps.InfoWindow({
              content: '<div style="padding:8px;white-space:nowrap;"><button type="button" onclick="window.deleteWaypoint(' + index + ')" style="height:32px;min-height:32px;border:0;border-radius:6px;background:#b91c1c;color:#fff;font-weight:900;">지점 삭제</button></div>'
            });
            infoWindow.open(map, marker);
          });
        }

        if (isReview && !isStart) {
          window.kakao.maps.event.addListener(marker, 'dragend', function() {
            var movedPoint = pointFromLatLng(marker.getPosition());
            routePoints[index] = movedPoint;
            if (isEnd) {
              end = movedPoint;
            }
            updatePolyline();
            postEditedRoute();
          });
        }
      });
    }

    function fitRouteBounds() {
      var bounds = new window.kakao.maps.LatLngBounds();
      routePoints.forEach(function(point) { bounds.extend(toLatLng(point)); });
      map.setBounds(bounds);
    }

    function renderMap() {
      if (routePoints.length === 0) {
        routePoints = [start];
      }
      if (isReview && routePoints.length > 0) {
        routePoints[routePoints.length - 1] = end;
      }
      var center = toLatLng(routePoints[routePoints.length - 1]);
      map = new window.kakao.maps.Map(document.getElementById('map'), { center: center, level: 3 });
      polyline = new window.kakao.maps.Polyline({ map: map, path: routePoints.map(toLatLng), strokeWeight: 5, strokeColor: '#2563eb', strokeOpacity: 0.9, strokeStyle: 'solid' });
      renderMarkers();
      setTimeout(function() {
        map.relayout();
        if (routePoints.length > 1) { fitRouteBounds(); } else { map.setCenter(center); }
      }, 250);
    }

    waitForKakaoSdk(function() { window.kakao.maps.load(renderMap); }, 0);
  </script>
</body>
</html>`;
}

function kakaoPickerCss() {
  return `html, body { margin: 0; width: 100%; height: 100%; min-height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; overflow: auto; }
    body { background: #ffffff; }
    #postcode { width: 100%; min-height: 260px; overflow: auto; }
    #mapScreen { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: hidden; }
    #map { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 100vh; }
    .hidden { display: none; }
    .headerClose { position: fixed; top: 8px; right: 8px; z-index: 20; width: 72px; height: 36px; min-height: 0; background: #111827; color: #ffffff; border: 0; border-radius: 6px; padding: 0; font-size: 13px; font-weight: 900; box-shadow: 0 4px 12px rgba(15,23,42,0.18); }
    .status { padding: 16px; color: #111827; font-size: 15px; line-height: 22px; }
    .pinConfirmPanel { position: absolute; left: 8px; top: 8px; z-index: 6; }
    .pinConfirmButton { width: 96px; height: 40px; min-height: 0; padding: 0; font-size: 14px; }
    .mapPanel { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 5; background: rgba(255,255,255,0.96); border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; box-shadow: 0 8px 24px rgba(15,23,42,0.16); }
    .title { font-size: 15px; font-weight: 900; margin-bottom: 4px; }
    .desc { font-size: 13px; line-height: 18px; color: #4b5563; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button { border-radius: 8px; min-height: 42px; padding: 0 12px; font-size: 14px; font-weight: 900; }
    .primary { background: #111827; color: #ffffff; border: 0; flex: 1; }
    .secondary { background: #ffffff; color: #111827; border: 1px solid #d1d5db; }
    .counter { margin-top: 8px; font-size: 12px; color: #6b7280; }`;
}

function kakaoSharedJs() {
  return `function post(payload) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(payload)); }
    function fail(message) { post({ error: message }); }
    function setText(id, value) { var element = document.getElementById(id); if (element) { element.textContent = value; } }
    function waitForKakaoSdk(onReady, attempt) {
      if (window.kakao && window.kakao.maps && window.kakao.maps.load) { onReady(); return; }
      if (window.__kakaoSdkLoadFailed) { fail('Kakao Maps JavaScript SDK failed to load. Check the JavaScript key and Web domain settings.'); return; }
      if (attempt >= 50) { fail('Kakao Maps JavaScript SDK is not ready. Check network or Kakao JavaScript key domain settings.'); return; }
      setTimeout(function() { waitForKakaoSdk(onReady, attempt + 1); }, 100);
    }`;
}

function resolveSttEngine(settings: Partial<AppSettings> & {sttEnabled?: boolean}): SttEngine {
  if (settings.sttEngine === STT_ENGINE_OFF) {
    return STT_ENGINE_OFF;
  }

  if (settings.sttEngine || settings.sttEnabled) {
    return STT_ENGINE_ON;
  }

  return STT_ENGINE_OFF;
}

function formatAnalysisPass(pass?: string) {
  if (pass === 'primary') {
    return '1차 추론';
  }
  if (pass === 'secondary') {
    return '2차 추론';
  }
  return pass;
}

function formatAnalysisSummary(analysis?: EmergencyAnalysis) {
  return (
    analysis?.audio_summary?.trim() ||
    analysis?.decision_reason?.trim() ||
    analysis?.recognized_dialogue?.trim() ||
    undefined
  );
}

function formatLocation(location?: {latitude: number; longitude: number}) {
  if (!location) {
    return undefined;
  }
  return `lat ${location.latitude}, lng ${location.longitude}`;
}

function formatOptionalNumber(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value.toFixed(4);
}
function formatAudioLogTime(value: string | number) {
  if (typeof value === 'number') {
    return new Date(value).toLocaleString();
  }
  return value;
}

function omitUnusedAnalysisLogFields<T extends Partial<EmergencyAnalysis>>(entry: T) {
  const {
    stt_context_used: _sttContextUsed,
    situation_summary: _situationSummary,
    ...rest
  } = entry;
  return rest;
}

function normalizeEmergencyLocation(input: unknown): EmergencyLocation | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const location = input as Partial<EmergencyLocation>;
  if (typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
    return null;
  }
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    heading: typeof location.heading === 'number' ? location.heading : undefined,
  };
}

async function requestAndroidPermissions() {
  if (Platform.OS !== 'android') {
    return;
  }

  const permissions = [
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    PermissionsAndroid.PERMISSIONS.SEND_SMS,
  ];

  if (Platform.Version >= 29) {
    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION);
  }
  if (Platform.Version >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  const result = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.filter(
    permission => result[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (denied.length > 0) {
    throw new Error(`필수 권한이 거부되었습니다: ${denied.join(', ')}`);
  }
}

async function requestAndroidLocationPermissions() {
  if (Platform.OS !== 'android') {
    return;
  }

  const permissions = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ];
  if (Platform.Version >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }

  const result = await PermissionsAndroid.requestMultiple(permissions);
  const denied = permissions.filter(
    permission => result[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (denied.length > 0) {
    throw new Error(`위치 수집 권한이 거부되었습니다: ${denied.join(', ')}`);
  }
}

function monitoringModeLabel(mode: SafetyMode) {
  return mode === 'child'
    ? '\uC544\uB3D9 \uBCF4\uD638 \uBAA8\uB4DC'
    : '\uC131\uC778 \uC548\uC2EC \uADC0\uAC00 \uBAA8\uB4DC';
}

function promptModeLabel(mode: SafetyMode) {
  return mode === 'child' ? '\uC544\uB3D9\uC6A9' : '\uC131\uC778\uC6A9';
}

function statusText(mode: string, analysisPass?: 'primary' | 'secondary') {
  switch (mode) {
    case 'idle':
      return '대기 중';
    case 'warming':
      return '모델 준비 중';
    case 'monitoring':
      return '감시 중';
    case 'analyzing':
      if (analysisPass === 'primary') {
        return '1차 추론 중';
      }
      if (analysisPass === 'secondary') {
        return '2차 추론 중';
      }
      return '상황 분석 중';
    case 'countdown':
      return '신고 대기 카운트다운';
    case 'sent':
      return '문자 신고 요청 완료';
    case 'cancelled':
      return '신고 취소됨';
    case 'error':
      return '오류';
    default:
      return mode;
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f7f8fb',
  },
  container: {
    flexGrow: 1,
    padding: 24,
    gap: 20,
  },
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  profilePanel: {
    gap: 16,
  },
  profileHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  profileHeaderText: {
    flex: 1,
    gap: 8,
  },
  profileHeaderTextWithAction: {
    paddingRight: 112,
  },
  profileFloatingSaveButton: {
    position: 'absolute',
    top: 10,
    right: 16,
    zIndex: 10,
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 42,
    minWidth: 86,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineCloseButton: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 38,
    justifyContent: 'center',
  },
  inlineCloseButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900',
  },
  profileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  profileSaveButton: {
    flex: 1,
  },
  profileCloseButton: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 52,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  modeButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    backgroundColor: '#111827',
    borderColor: '#111827',
  },
  modeButtonText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '900',
  },
  modeButtonTextActive: {
    color: '#ffffff',
  },
  formSection: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 12,
  },
  inputGroup: {
    gap: 6,
  },
  routeInfoEditor: {
    gap: 10,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  birthdayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  timeRangeLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  inlineUnit: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '800',
  },
  compactTimeInputGroup: {
    width: 58,
    gap: 4,
  },
  timeInputGroup: {
    flex: 1,
    gap: 4,
  },
  compactNumberInput: {
    width: 58,
    minHeight: 42,
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  inputError: {
    color: '#b91c1c',
    fontSize: 12,
    lineHeight: 17,
  },
  fieldLabel: {
    color: '#374151',
    fontSize: 13,
    fontWeight: '900',
  },
  textInput: {
    minHeight: 48,
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#111827',
    fontSize: 15,
  },
  locationButton: {
    minHeight: 48,
    backgroundColor: '#111827',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  locationSummary: {
    color: '#4b5563',
    fontSize: 13,
    lineHeight: 19,
  },
  locationPickerScreen: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  locationWebView: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  manualRouteInfoCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 18,
    gap: 14,
  },
  routeCaptureConfirmCard: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 108,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 16,
    gap: 14,
  },
  routeCaptureActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  routeCaptureActionButton: {
    flex: 1,
  },
  routeCaptureBottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    padding: 16,
    gap: 12,
  },
  header: {
    gap: 8,
  },
  logButton: {
    alignSelf: 'flex-end',
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    minHeight: 38,
    justifyContent: 'center',
  },
  logButtonText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '800',
  },
  eyebrow: {
    color: '#4263eb',
    fontSize: 13,
    fontWeight: '700',
  },
  title: {
    color: '#111827',
    fontSize: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: '#4b5563',
    fontSize: 16,
    lineHeight: 24,
  },
  statusPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 18,
    gap: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    position: 'relative',
  },
  routeDeviationBadgeButton: {
    position: 'absolute',
    right: 14,
    top: 14,
    minHeight: 26,
    borderRadius: 7,
    borderWidth: 1,
    paddingHorizontal: 9,
    justifyContent: 'center',
  },
  routeDeviationBadgeButtonChild: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  routeDeviationBadgeButtonAdult: {
    backgroundColor: '#fff7ed',
    borderColor: '#fed7aa',
  },
  routeDeviationBadgeButtonMatched: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  routeDeviationBadge: {
    fontSize: 12,
    fontWeight: '900',
  },
  routeDeviationBadgeChild: {
    color: '#dc2626',
  },
  routeDeviationBadgeAdult: {
    color: '#f97316',
  },
  routeDeviationBadgeMatched: {
    color: '#16a34a',
  },
  statusLabel: {
    color: '#6b7280',
    fontSize: 13,
    fontWeight: '700',
  },
  statusValue: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '800',
  },
  summary: {
    color: '#374151',
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: '#b91c1c',
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    gap: 12,
  },
  button: {
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryButtonText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '800',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 22,
    gap: 16,
  },
  calendarCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 18,
    gap: 14,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  calendarTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '900',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  calendarDay: {
    width: '13%',
    aspectRatio: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f4f6',
  },
  calendarDayText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '800',
  },
  secondaryButtonSmall: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 38,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    color: '#b91c1c',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '900',
  },
  modalSummary: {
    color: '#374151',
    fontSize: 15,
    lineHeight: 22,
  },
  cancelButton: {
    backgroundColor: '#b91c1c',
    borderRadius: 8,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },

  menuCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 8,
    padding: 18,
    gap: 12,
  },
  settingsCard: {
    maxHeight: '88%',
    padding: 0,
    overflow: 'hidden',
  },
  settingsScrollContent: {
    padding: 18,
    gap: 12,
  },
  analysisWindowPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 12,
  },
  menuTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '900',
  },
  menuOption: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 50,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  menuOptionText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '800',
  },
  menuCloseButton: {
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuCloseButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 8,
  },
  settingTextGroup: {
    flex: 1,
    gap: 4,
  },
  settingLabel: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '900',
  },
  settingDescription: {
    color: '#4b5563',
    fontSize: 13,
    lineHeight: 19,
  },
  settingHint: {
    color: '#6b7280',
    fontSize: 12,
    lineHeight: 18,
  },
  secondsSlider: {
    gap: 8,
  },
  secondsSliderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  secondsSliderLabel: {
    color: '#374151',
    fontSize: 13,
    fontWeight: '800',
  },
  secondsSliderValue: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900',
  },
  sliderTrack: {
    height: 34,
    borderRadius: 17,
    backgroundColor: '#e5e7eb',
    justifyContent: 'center',
    overflow: 'visible',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 13,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2563eb',
  },
  sliderThumb: {
    position: 'absolute',
    top: 6,
    width: 22,
    height: 22,
    marginLeft: -11,
    borderRadius: 11,
    backgroundColor: '#111827',
    borderWidth: 3,
    borderColor: '#ffffff',
  },
  sliderRangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sliderRangeLabel: {
    color: '#6b7280',
    fontSize: 11,
    fontWeight: '700',
  },
  motionSensorFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  motionSensorFieldLabel: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '900',
    flex: 1,
  },
  motionSensorInput: {
    width: 96,
    minHeight: 44,
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#111827',
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  motionSensorResetRow: {
    alignItems: 'stretch',
  },
  motionSensorResetButton: {
    minHeight: 44,
  },
  savedRoutePanel: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 10,
  },
  savedRouteOption: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
    padding: 12,
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  savedRouteOptionActive: {
    backgroundColor: '#111827',
    borderColor: '#111827',
  },
  savedRouteOptionText: {
    flex: 1,
    gap: 4,
  },
  savedRouteName: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '900',
  },
  savedRouteNameActive: {
    color: '#ffffff',
  },
  savedRouteMeta: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '800',
  },
  savedRouteMetaActive: {
    color: '#d1d5db',
  },
  savedRouteBadge: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '900',
  },
  savedRouteBadgeActive: {
    color: '#ffffff',
  },
  routeManagerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  routeManagerItem: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 12,
    gap: 12,
  },
  routeManagerSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  routeManagerActiveBadge: {
    color: '#2563eb',
  },
  routeManagerEditor: {
    gap: 12,
  },
  routePreviewWebView: {
    height: 180,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
    overflow: 'hidden',
  },
  routeManagerActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  routeManagerActionButton: {
    flex: 1,
  },
  thresholdPanel: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 10,
  },
  thresholdControls: {
    flexDirection: 'row',
    gap: 10,
  },
  thresholdInput: {
    flex: 1,
    minHeight: 48,
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#111827',
    fontSize: 15,
    fontWeight: '800',
  },
  thresholdApplyButton: {
    minHeight: 48,
    minWidth: 86,
    backgroundColor: '#111827',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptEditorSection: {
    gap: 8,
  },
  promptInput: {
    minHeight: 260,
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    color: '#111827',
    fontSize: 14,
    lineHeight: 20,
  },
  logsScreen: {
    flex: 1,
    backgroundColor: '#f7f8fb',
  },
  logsHeader: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  logsTitle: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '900',
  },
  logsSubtitle: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  routeHeaderText: {
    flex: 1,
  },
  routeHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backButton: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 42,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  backButtonText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '900',
  },
  closeButton: {
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 42,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  logsContent: {
    padding: 16,
    gap: 12,
  },
  audioLogsContent: {
    paddingBottom: 96,
  },
  audioStopBar: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#f7f8fb',
    padding: 16,
  },
  audioStopButton: {
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyLogs: {
    color: '#4b5563',
    fontSize: 16,
    lineHeight: 24,
  },
  logCard: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 14,
    gap: 10,
  },
  logIndex: {
    color: '#4263eb',
    fontSize: 13,
    fontWeight: '900',
  },
  logRow: {
    gap: 4,
  },
  logLabel: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '900',
  },
  logValue: {
    color: '#111827',
    fontSize: 14,
    lineHeight: 20,
  },
  logValueMono: {
    fontFamily: Platform.select({android: 'monospace', default: undefined}),
    fontSize: 13,
  },
});

export default App;






