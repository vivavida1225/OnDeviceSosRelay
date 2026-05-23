import React, {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  Modal,
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
  type GemmaPromptTemplates,
  type RoutineLocation,
  type RoutePathPoint,
  type SafetyMode,
  type SafetyProfile,
  type SttEngine,
} from './src/native/EmergencyNative';
import {
  emergencyReducer,
  initialEmergencyState,
} from './src/state/emergencyState';
import {KAKAO_MAP_JAVASCRIPT_KEY} from './src/config/kakaoMap';

const DEFAULT_AUDIO_RMS_THRESHOLD = 0.35;
const STT_ENGINE_OFF: SttEngine = 'off';
const STT_ENGINE_ON: SttEngine = 'sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27';
type LocationPickerTarget = 'startLocation' | 'destinationLocation';
type RoutePickerMode = 'view' | 'edit';

const baseMonitoringConfig = {
  modelId: 'gemma-4-E4B-it',
  sensorThreshold: 28,
};

const DEFAULT_CUSTOM_PROMPT = `기본 프롬프트를 사용합니다.
트리거 이전 10초와 이후 7초 오디오의 톤, 긴급성, 발화, 배경 소음만 근거로 판단하세요.
STT 결과는 실험용 로그일 뿐 판단 근거로 사용하지 마세요.
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
  startHour: '',
  startMinute: '',
  destinationHour: '',
  destinationMinute: '',
};
const defaultAppSettings: AppSettings = {
  sttEngine: STT_ENGINE_OFF,
  customPrompt: DEFAULT_CUSTOM_PROMPT,
  audioRmsThreshold: DEFAULT_AUDIO_RMS_THRESHOLD,
  safetyProfile: defaultSafetyProfile,
};

const emptyGemmaPromptTemplates: GemmaPromptTemplates = {
  system: '',
  primary: '',
  secondary: '',
};
type AnalysisLogEntry = EmergencyAnalysis & {
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
  const [audioRmsThreshold, setAudioRmsThreshold] = useState(
    defaultAppSettings.audioRmsThreshold,
  );
  const [audioRmsThresholdInput, setAudioRmsThresholdInput] = useState(
    String(defaultAppSettings.audioRmsThreshold),
  );
  const smsSentForAnalysis = useRef<EmergencyAnalysis | undefined>(undefined);
  const lastBackPressAt = useRef(0);

  useEffect(() => {
    EmergencyNative.loadAnalysisLogs()
      .then(logsJson => {
        const logs = JSON.parse(logsJson);
        if (Array.isArray(logs)) {
          setAnalysisLogs(logs.slice(0, 10));
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
        setCustomPrompt(nextSettings.customPrompt);
        setAudioRmsThreshold(nextSettings.audioRmsThreshold);
        setAudioRmsThresholdInput(String(nextSettings.audioRmsThreshold));
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
      const nextLogs = [
        {
          ...event,
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
      }),
      emergencyEvents.addListener('smsStatus', event => {
        console.log('[EmergencyDebug] smsStatus', event);
        dispatch({type: 'SMS_STATUS', status: event.status});
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
    return () => {
      Vibration.cancel();
      EmergencyNative.stopSiren().catch(() => undefined);
    };
  }, [state.mode]);

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
      EmergencyNative.sendEmergencySms({
        destination: '01082014333',
        situation_summary: state.analysis.situation_summary,
        location: state.analysis.location,
      }).catch(error => {
        dispatch({
          type: 'ERROR',
          message: error?.message ?? 'SMS 전송에 실패했습니다.',
        });
      });
    }
  }, [state.analysis, state.countdown, state.mode]);

  const saveSettings = useCallback(async (nextSettings: AppSettings) => {
    await EmergencyNative.saveAppSettings(JSON.stringify(nextSettings));
  }, []);

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

  const handleLocationPickerMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!locationPickerTarget) {
        return;
      }

      try {
        const payload = JSON.parse(event.nativeEvent.data) as
          | (RoutineLocation & {type?: 'location'})
          | {type: 'close'}
          | {error?: string};
        if ('type' in payload && payload.type === 'close') {
          setLocationPickerTarget(null);
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
    [locationPickerTarget],
  );

  const openRoutePicker = useCallback(() => {
    setRoutePickerMode(profileDraft.childRoutePath.length > 0 ? 'view' : 'edit');
    setRoutePickerVisible(true);
  }, [profileDraft.childRoutePath.length]);

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

      setProfileDraft(current => ({
        ...current,
        childRoutePath: payload.childRoutePath ?? [],
      }));
      setRoutePickerVisible(false);
    } catch (error) {
      Alert.alert(
        '\uACBD\uB85C \uC800\uC7A5 \uC2E4\uD328',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const saveSafetyProfile = useCallback(async () => {
    if (!profileDraft.mode) {
      Alert.alert('모드 선택 필요', '유아 모드 또는 성인 모드를 선택해 주세요.');
      return;
    }

    const nextProfile = {
      ...profileDraft,
      birthday: profileDraft.birthday.trim(),
      gender: profileDraft.gender.trim(),
      detailAddress: profileDraft.detailAddress.trim(),
      emergencyPhone: normalizePhoneNumber(profileDraft.emergencyPhone),
      startHour: profileDraft.startHour.trim(),
      startMinute: profileDraft.startMinute.trim(),
      destinationHour: profileDraft.destinationHour.trim(),
      destinationMinute: profileDraft.destinationMinute.trim(),
    };
    setSafetyProfile(nextProfile);
    setProfileDraft(nextProfile);
    setMonitoringMode(nextProfile.mode ?? 'adult');
    await saveSettings({
      sttEngine,
      customPrompt,
      audioRmsThreshold,
      safetyProfile: nextProfile,
    });
    setProfileEditorVisible(false);
  }, [audioRmsThreshold, customPrompt, profileDraft, saveSettings, sttEngine]);
  const startMonitoring = useCallback(async () => {
    try {
      dispatch({type: 'START_REQUESTED'});
      await requestAndroidPermissions();
      const config = {
        ...baseMonitoringConfig,
        audioRmsThreshold,
        sttEnabled: sttEngine !== STT_ENGINE_OFF,
        sttEngine,
        monitoringMode,
        customPrompt,
      };
      const warmUpStatus = await MlcGemmaNative.warmUp(config.modelId);
      console.log('[EmergencyDebug] warmUp', warmUpStatus);
      await EmergencyNative.startMonitoring(config);
    } catch (error) {
      dispatch({
        type: 'ERROR',
        message: error instanceof Error ? error.message : '시작 실패',
      });
    }
  }, [audioRmsThreshold, customPrompt, monitoringMode, sttEngine]);

  const stopMonitoring = useCallback(async () => {
    await EmergencyNative.stopMonitoring();
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
  }, []);

  const handleRouteBack = useCallback(() => {
    if (routePickerMode === 'edit' && profileDraft.childRoutePath.length > 0) {
      setRoutePickerMode('view');
      return;
    }
    closeRoutePicker();
  }, [closeRoutePicker, profileDraft.childRoutePath.length, routePickerMode]);

  const handleHardwareBack = useCallback(() => {
    if (locationPickerTarget) {
      setLocationPickerTarget(null);
      return true;
    }
    if (routePickerVisible) {
      handleRouteBack();
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
    closeProfileEditor,
    handleRouteBack,
    locationPickerTarget,
    logsVisible,
    menuVisible,
    profileEditorVisible,
    promptEditorVisible,
    routePickerVisible,
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

  const isMonitoring =
    state.mode === 'warming' ||
    state.mode === 'monitoring' ||
    state.mode === 'analyzing' ||
    state.mode === 'countdown';

  const canStop =
    state.mode === 'monitoring' ||
    state.mode === 'analyzing' ||
    state.mode === 'countdown';

  const updateSttEngine = useCallback(
    async (nextEngine: SttEngine) => {
      setSttEngine(nextEngine);
      await saveSettings({sttEngine: nextEngine, customPrompt, audioRmsThreshold, safetyProfile});
      if (!isMonitoring) {
        return;
      }

      try {
        await EmergencyNative.startMonitoring({
          ...baseMonitoringConfig,
          audioRmsThreshold,
          sttEnabled: nextEngine !== STT_ENGINE_OFF,
          sttEngine: nextEngine,
          monitoringMode,
          customPrompt,
        });
      } catch (error) {
        console.warn('[EmergencyDebug] updateSttEngine failed', error);
      }
    },
    [audioRmsThreshold, customPrompt, isMonitoring, monitoringMode, safetyProfile, saveSettings],
  );
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
      customPrompt,
      audioRmsThreshold: nextThreshold,
      safetyProfile,
    });

    if (!isMonitoring) {
      return;
    }

    try {
      await EmergencyNative.startMonitoring({
        ...baseMonitoringConfig,
        audioRmsThreshold: nextThreshold,
        sttEnabled: sttEngine !== STT_ENGINE_OFF,
        sttEngine,
        monitoringMode,
        customPrompt,
      });
    } catch (error) {
      console.warn('[EmergencyDebug] updateAudioRmsThreshold failed', error);
    }
  }, [
    audioRmsThreshold,
    audioRmsThresholdInput,
    customPrompt,
    isMonitoring,
    monitoringMode,
    safetyProfile,
    saveSettings,
    sttEngine,
  ]);
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
            onPickLocation={openLocationPicker}
            onOpenRoutePicker={openRoutePicker}
            onSave={saveSafetyProfile}
            saveLabel="저장하고 시작"
          />
        </ScrollView>
        <LocationPickerModal
          visible={locationPickerTarget !== null}
          kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
          onClose={() => setLocationPickerTarget(null)}
          onMessage={handleLocationPickerMessage}
        />
        <RoutePickerModal
          visible={routePickerVisible}
          kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
          startLocation={profileDraft.startLocation}
          destinationLocation={profileDraft.destinationLocation}
          routePath={profileDraft.childRoutePath}
          mode={routePickerMode}
          onClose={closeRoutePicker}
          onBack={handleRouteBack}
          onMessage={handleRoutePickerMessage}
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
          <Text style={styles.statusLabel}>현재 상태</Text>
          <Text style={styles.statusValue}>{statusText(state.mode)}</Text>
          <Text style={styles.summary}>{monitoringModeLabel(monitoringMode)}</Text>
          {state.analysis ? (
            <Text style={styles.summary}>{state.analysis.situation_summary}</Text>
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
            <Text style={styles.modalSummary}>
              {state.analysis?.situation_summary}
            </Text>
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
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>설정</Text>
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
            <Pressable
              style={styles.menuOption}
              onPress={() => {
                setSettingsVisible(false);
                setProfileDraft(safetyProfile);
                setProfileEditorVisible(true);
              }}>
              <Text style={styles.menuOptionText}>민감 정보 수정</Text>
            </Pressable>
            <Pressable
              style={styles.menuCloseButton}
              onPress={() => setSettingsVisible(false)}>
              <Text style={styles.menuCloseButtonText}>닫기</Text>
            </Pressable>
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
              description="트리거 직전 최대 10초 오디오 분석 지침입니다. {{sampleRate}}, {{triggerSource}}, {{locationText}} 토큰을 사용할 수 있습니다."
              value={gemmaPromptDraft.primary}
              onChangeText={value => updateGemmaPromptDraft('primary', value)}
              minHeight={360}
            />
            <PromptEditorField
              label="2차 추론 프롬프트"
              description="트리거 이후 7초 오디오 분석 지침입니다. 1차 토큰에 더해 {{previousContext}} 토큰을 사용할 수 있습니다."
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
              onPickLocation={openLocationPicker}
              onOpenRoutePicker={openRoutePicker}
              onSave={saveSafetyProfile}
              onClose={closeProfileEditor}
              saveLabel={'\uC800\uC7A5'}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <LocationPickerModal
        visible={locationPickerTarget !== null}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        onClose={() => setLocationPickerTarget(null)}
        onMessage={handleLocationPickerMessage}
      />
      <RoutePickerModal
        visible={routePickerVisible}
        kakaoKey={KAKAO_MAP_JAVASCRIPT_KEY}
        startLocation={profileDraft.startLocation}
        destinationLocation={profileDraft.destinationLocation}
        routePath={profileDraft.childRoutePath}
        mode={routePickerMode}
        onClose={closeRoutePicker}
        onBack={handleRouteBack}
        onMessage={handleRoutePickerMessage}
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
                    label="stt_context_used"
                    value={String(log.stt_context_used ?? false)}
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
                    label="situation_summary"
                    value={log.situation_summary}
                  />
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

function SafetyProfileForm({
  title,
  subtitle,
  profile,
  onChange,
  onPickLocation,
  onOpenRoutePicker,
  onSave,
  saveLabel,
  onClose,
}: {
  title: string;
  subtitle: string;
  profile: SafetyProfile;
  onChange: <K extends keyof SafetyProfile>(key: K, value: SafetyProfile[K]) => void;
  onPickLocation: (target: LocationPickerTarget) => void;
  onOpenRoutePicker: () => void;
  onSave: () => void;
  saveLabel: string;
  onClose?: () => void;
}) {
  const routeReady = Boolean(profile.startLocation && profile.destinationLocation);

  return (
    <View style={styles.profilePanel}>
      <View style={styles.profileHeaderRow}>
        <View style={styles.profileHeaderText}>
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
        <LocationSelectButton
          label={'\uCD9C\uBC1C\uC9C0 \uC120\uD0DD'}
          location={profile.startLocation}
          onPress={() => onPickLocation('startLocation')}
        />
        <LocationSelectButton
          label={'\uB3C4\uCC29\uC9C0 \uC120\uD0DD'}
          location={profile.destinationLocation}
          onPress={() => onPickLocation('destinationLocation')}
        />
        {routeReady ? (
          <View style={styles.inputGroup}>
            <Text style={styles.fieldLabel}>{'\uB4F1\uD558\uAD50 \uCEE4\uC2A4\uD140 \uACBD\uB85C'}</Text>
            <Pressable style={styles.locationButton} onPress={onOpenRoutePicker}>
              <Text style={styles.locationButtonText}>
                {profile.childRoutePath.length > 0 ? '\uACBD\uB85C \uBCF4\uAE30' : '\uACBD\uB85C \uC785\uB825'}
              </Text>
            </Pressable>
            <Text style={styles.locationSummary}>
              {formatRoutePathSummary(profile.childRoutePath)}
            </Text>
          </View>
        ) : null}
        <TimeRangeGroup
          startHour={profile.startHour}
          startMinute={profile.startMinute}
          endHour={profile.destinationHour}
          endMinute={profile.destinationMinute}
          onStartHourChange={value => onChange('startHour', value)}
          onStartMinuteChange={value => onChange('startMinute', value)}
          onEndHourChange={value => onChange('destinationHour', value)}
          onEndMinuteChange={value => onChange('destinationMinute', value)}
        />
      </View>

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
function LocationSelectButton({
  label,
  location,
  onPress,
}: {
  label: string;
  location: RoutineLocation | null;
  onPress: () => void;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable style={styles.locationButton} onPress={onPress}>
        <Text style={styles.locationButtonText}>
          {location ? '다시 선택' : label}
        </Text>
      </Pressable>
      {location ? (
        <Text style={styles.locationSummary}>{formatRoutineLocation(location)}</Text>
      ) : null}
    </View>
  );
}

function LocationPickerModal({
  visible,
  kakaoKey,
  onClose,
  onMessage,
}: {
  visible: boolean;
  kakaoKey: string;
  onClose: () => void;
  onMessage: (event: WebViewMessageEvent) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <WebView
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
  startLocation,
  destinationLocation,
  routePath,
  mode,
  onClose,
  onBack,
  onMessage,
}: {
  visible: boolean;
  kakaoKey: string;
  startLocation: RoutineLocation | null;
  destinationLocation: RoutineLocation | null;
  routePath: RoutePathPoint[];
  mode: RoutePickerMode;
  onClose: () => void;
  onBack: () => void;
  onMessage: (event: WebViewMessageEvent) => void;
}) {
  if (!startLocation || !destinationLocation) {
    return null;
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onBack}>
      <SafeAreaView style={styles.locationPickerScreen}>
        <View style={styles.logsHeader}>
          <Pressable style={styles.backButton} onPress={onBack}>
            <Text style={styles.backButtonText}>{'\uB4A4\uB85C'}</Text>
          </Pressable>
          <View style={styles.routeHeaderText}>
            <Text style={styles.logsTitle}>
              {mode === 'view' ? '\uACBD\uB85C \uBCF4\uAE30' : '\uACBD\uB85C \uC785\uB825'}
            </Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>{'\uB2EB\uAE30'}</Text>
          </Pressable>
        </View>
        <WebView
          key={`route-${mode}-${routePath.length}`}
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
    customPrompt: input.customPrompt || defaultAppSettings.customPrompt,
    audioRmsThreshold:
      input.audioRmsThreshold ?? defaultAppSettings.audioRmsThreshold,
    safetyProfile: normalizeSafetyProfile(input.safetyProfile),
  };
}

function normalizeSafetyProfile(input?: Partial<SafetyProfile> & {age?: string; startTime?: string; destinationTime?: string}): SafetyProfile {
  const legacyStart = splitLegacyTime(input?.startTime);
  const legacyDestination = splitLegacyTime(input?.destinationTime);
  return {
    ...defaultSafetyProfile,
    ...input,
    mode: input?.mode === 'child' || input?.mode === 'adult' ? input.mode : null,
    birthday: input?.birthday ?? '',
    gender: normalizeGender(input?.gender),
    emergencyPhone: normalizePhoneNumber(input?.emergencyPhone ?? ''),
    startLocation: normalizeRoutineLocation(input?.startLocation),
    destinationLocation: normalizeRoutineLocation(input?.destinationLocation),
    childRoutePath: normalizeRoutePath(input?.childRoutePath),
    startHour: input?.startHour ?? legacyStart.hour,
    startMinute: input?.startMinute ?? legacyStart.minute,
    destinationHour: input?.destinationHour ?? legacyDestination.hour,
    destinationMinute: input?.destinationMinute ?? legacyDestination.minute,
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

function isKakaoKeyConfigured(key: string) {
  return key.trim().length > 0 && key !== 'YOUR_KAKAO_JAVASCRIPT_KEY';
}

function formatRoutineLocation(location: RoutineLocation) {
  return `${location.address}\nlat ${location.latitude}, lng ${location.longitude}`;
}

function formatRoutePathSummary(path?: RoutePathPoint[]) {
  if (!path || path.length === 0) {
    return '\uC800\uC7A5\uB41C \uACBD\uB85C \uC5C6\uC74C';
  }

  return `${path.length}\uAC1C \uC9C0\uC810 \uC800\uC7A5\uB428`;
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

    ${kakaoSharedJs()}

    function geocodeAddress(address) {
      waitForKakaoSdk(function() {
        window.kakao.maps.load(function() {
          if (!window.kakao.maps.services || !window.kakao.maps.services.Geocoder) {
            fail('Kakao Maps Geocoder service could not be initialized.');
            return;
          }
          var geocoder = new window.kakao.maps.services.Geocoder();
          geocoder.addressSearch(address, function(result, status) {
            if (status === window.kakao.maps.services.Status.OK && result && result[0]) {
              renderMap(address, Number(result[0].y), Number(result[0].x));
            } else {
              fail('Could not convert the address to coordinates.');
            }
          });
        });
      }, 0);
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
          var address = data.roadAddress || data.jibunAddress || data.address;
          if (!address) { fail('Selected address is empty.'); return; }
          geocodeAddress(address);
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
    .mapPanel { position: absolute; left: 12px; right: 92px; top: 12px; z-index: 5; background: rgba(255,255,255,0.96); border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; box-shadow: 0 8px 24px rgba(15,23,42,0.16); }
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

function monitoringModeLabel(mode: SafetyMode) {
  return mode === 'child'
    ? '\uC544\uB3D9 \uBCF4\uD638 \uBAA8\uB4DC'
    : '\uC131\uC778 \uC548\uC2EC \uADC0\uAC00 \uBAA8\uB4DC';
}

function promptModeLabel(mode: SafetyMode) {
  return mode === 'child' ? '\uC544\uB3D9\uC6A9' : '\uC131\uC778\uC6A9';
}

function statusText(mode: string) {
  switch (mode) {
    case 'idle':
      return '대기 중';
    case 'warming':
      return '모델 준비 중';
    case 'monitoring':
      return '감시 중';
    case 'analyzing':
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
  },  header: {
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






