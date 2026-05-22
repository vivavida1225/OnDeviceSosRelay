import React, {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {
  Alert,
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
  useColorScheme,
  Vibration,
  View,
} from 'react-native';
import {
  EmergencyNative,
  emergencyEvents,
  MlcGemmaNative,
  type AppSettings,
  type AudioLogEntry,
  type EmergencyAnalysis,
} from './src/native/EmergencyNative';
import {
  emergencyReducer,
  initialEmergencyState,
} from './src/state/emergencyState';

const baseMonitoringConfig = {
  modelId: 'gemma-4-E4B-it',
  sensorThreshold: 28,
  audioRmsThreshold: 0.35,
};

const DEFAULT_CUSTOM_PROMPT = `기본 프롬프트를 사용합니다.
오디오와 STT 결과가 서로 충돌하면 실제 오디오의 톤, 긴급성, 배경 소음을 우선해 판단하세요.
위급 상황 단서가 부족하면 보수적으로 false를 반환하세요.`;

const defaultAppSettings: AppSettings = {
  sttEnabled: false,
  customPrompt: DEFAULT_CUSTOM_PROMPT,
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
  const [logsVisible, setLogsVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [personalizationVisible, setPersonalizationVisible] = useState(false);
  const [audioLogsVisible, setAudioLogsVisible] = useState(false);
  const [audioLogs, setAudioLogs] = useState<AudioLogEntry[]>([]);
  const [playingAudioId, setPlayingAudioId] = useState<string>();
  const [sttEnabled, setSttEnabled] = useState(defaultAppSettings.sttEnabled);
  const [customPrompt, setCustomPrompt] = useState(defaultAppSettings.customPrompt);
  const [promptDraft, setPromptDraft] = useState(defaultAppSettings.customPrompt);
  const smsSentForAnalysis = useRef<EmergencyAnalysis | undefined>(undefined);

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
        const nextSettings = {
          ...defaultAppSettings,
          ...parsed,
          sttEnabled: parsed.sttEnabled ?? defaultAppSettings.sttEnabled,
          customPrompt: parsed.customPrompt || defaultAppSettings.customPrompt,
        };
        setSttEnabled(nextSettings.sttEnabled);
        setCustomPrompt(nextSettings.customPrompt);
        setPromptDraft(nextSettings.customPrompt);
      })
      .catch(error => {
        console.warn('[EmergencyDebug] loadAppSettings failed', error);
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
      emergencyEvents.addListener('analysisResult', event => {
        console.log('[EmergencyDebug] analysisResult', event);
        setAnalysisLogs(logs => {
          const nextLogs = [
            {
              ...event,
              id: `${Date.now()}-${logs.length}`,
              createdAt: new Date().toLocaleString(),
            },
            ...logs,
          ].slice(0, 10);

          EmergencyNative.saveAnalysisLogs(JSON.stringify(nextLogs)).catch(
            error => {
              console.warn('[EmergencyDebug] saveAnalysisLogs failed', error);
            },
          );

          return nextLogs;
        });
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
  }, []);

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
      setAudioLogs(Array.isArray(logs) ? logs.slice(0, 3) : []);
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

  const savePrompt = useCallback(async () => {
    const nextPrompt = promptDraft.trim() || defaultAppSettings.customPrompt;
    setCustomPrompt(nextPrompt);
    await saveSettings({sttEnabled, customPrompt: nextPrompt});
    setPersonalizationVisible(false);
  }, [promptDraft, saveSettings, sttEnabled]);

  const restoreDefaultPrompt = useCallback(() => {
    setPromptDraft(defaultAppSettings.customPrompt);
  }, []);
  const startMonitoring = useCallback(async () => {
    try {
      dispatch({type: 'START_REQUESTED'});
      await requestAndroidPermissions();
      const config = {...baseMonitoringConfig, sttEnabled, customPrompt};
      const warmUpStatus = await MlcGemmaNative.warmUp(config.modelId);
      console.log('[EmergencyDebug] warmUp', warmUpStatus);
      await EmergencyNative.startMonitoring(config);
    } catch (error) {
      dispatch({
        type: 'ERROR',
        message: error instanceof Error ? error.message : '시작 실패',
      });
    }
  }, [customPrompt, sttEnabled]);

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

  const updateSttEnabled = useCallback(
    async (enabled: boolean) => {
      setSttEnabled(enabled);
      await saveSettings({sttEnabled: enabled, customPrompt});
      if (!isMonitoring) {
        return;
      }

      try {
        await EmergencyNative.startMonitoring({
          ...baseMonitoringConfig,
          sttEnabled: enabled,
          customPrompt,
        });
      } catch (error) {
        console.warn('[EmergencyDebug] updateSttEnabled failed', error);
      }
    },
    [customPrompt, isMonitoring, saveSettings],
  );
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

      <Modal visible={state.mode === 'countdown'} transparent animationType="fade">
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



      <Modal visible={menuVisible} transparent animationType="fade">
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
                setPromptDraft(customPrompt);
                setPersonalizationVisible(true);
              }}>
              <Text style={styles.menuOptionText}>개인화 설정</Text>
            </Pressable>
            <Pressable
              style={styles.menuCloseButton}
              onPress={() => setMenuVisible(false)}>
              <Text style={styles.menuCloseButtonText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={settingsVisible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>설정</Text>
            <View style={styles.settingRow}>
              <View style={styles.settingTextGroup}>
                <Text style={styles.settingLabel}>STT 기능</Text>
                <Text style={styles.settingDescription}>
                  Sherpa-ONNX Whisper 받아쓰기 채널을 켜거나 끕니다.
                </Text>
              </View>
              <Switch value={sttEnabled} onValueChange={updateSttEnabled} />
            </View>
            <Text style={styles.settingHint}>
              감시 중 변경하면 다음 트리거부터 적용됩니다.
            </Text>
            <Pressable
              style={styles.menuCloseButton}
              onPress={() => setSettingsVisible(false)}>
              <Text style={styles.menuCloseButtonText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={personalizationVisible} animationType="slide">
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>개인화 설정</Text>
              <Text style={styles.logsSubtitle}>Gemma 판단 프롬프트</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={() => setPersonalizationVisible(false)}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.logsContent}>
            <Text style={styles.settingDescription}>
              이 프롬프트는 기본 위급 상황 판단 프롬프트 뒤에 추가되며, 기본 지침보다 우선 적용됩니다.
            </Text>
            <TextInput
              style={styles.promptInput}
              value={promptDraft}
              onChangeText={setPromptDraft}
              multiline
              textAlignVertical="top"
              placeholder="Gemma에게 추가로 지시할 내용을 입력하세요."
            />
            <Pressable style={styles.secondaryButton} onPress={restoreDefaultPrompt}>
              <Text style={styles.secondaryButtonText}>기본값으로 원복</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={savePrompt}>
              <Text style={styles.buttonText}>저장</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={audioLogsVisible} animationType="slide">
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>오디오 로그</Text>
              <Text style={styles.logsSubtitle}>최근 {audioLogs.length}개</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={() => {
                stopAudioLog().catch(() => undefined);
                setAudioLogsVisible(false);
              }}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.logsContent}>
            {audioLogs.length === 0 ? (
              <Text style={styles.emptyLogs}>아직 저장된 오디오 로그가 없습니다.</Text>
            ) : (
              audioLogs.map((log, index) => (
                <View key={log.id} style={styles.logCard}>
                  <Text style={styles.logIndex}>#{index + 1}</Text>
                  <LogRow label="time" value={formatAudioLogTime(log.createdAt)} />
                  <LogRow label="trigger_source" value={log.trigger_source} />
                  <LogRow
                    label="duration_seconds"
                    value={log.duration_seconds.toFixed(1)}
                  />
                  <LogRow label="sample_rate" value={String(log.sample_rate)} />
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
            <Pressable style={styles.secondaryButton} onPress={stopAudioLog}>
              <Text style={styles.secondaryButtonText}>재생 중지</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal visible={logsVisible} animationType="slide">
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
                  <LogRow label="crime_type" value={log.crime_type} />
                  <LogRow label="is_emergency" value={String(log.is_emergency)} />
                  <LogRow label="model_id" value={log.model_id} />
                  <LogRow label="trigger_source" value={log.trigger_source} />
                  <LogRow
                    label="location"
                    value={formatLocation(log.location)}
                  />
                  <LogRow
                    label="recognized_dialogue"
                    value={log.recognized_dialogue}
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

function formatLocation(location?: {latitude: number; longitude: number}) {
  if (!location) {
    return undefined;
  }
  return `lat ${location.latitude}, lng ${location.longitude}`;
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
  },  promptInput: {
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












