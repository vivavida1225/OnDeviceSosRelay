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
  StyleSheet,
  Text,
  useColorScheme,
  Vibration,
  View,
} from 'react-native';
import {
  EmergencyNative,
  emergencyEvents,
  MlcGemmaNative,
  type EmergencyAnalysis,
} from './src/native/EmergencyNative';
import {
  emergencyReducer,
  initialEmergencyState,
} from './src/state/emergencyState';

const monitoringConfig = {
  modelId: 'gemma-4-E4B-it',
  sensorThreshold: 28,
  audioRmsThreshold: 0.35,
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

  const startMonitoring = useCallback(async () => {
    try {
      dispatch({type: 'START_REQUESTED'});
      await requestAndroidPermissions();
      const warmUpStatus = await MlcGemmaNative.warmUp(monitoringConfig.modelId);
      console.log('[EmergencyDebug] warmUp', warmUpStatus);
      await EmergencyNative.startMonitoring(monitoringConfig);
    } catch (error) {
      dispatch({
        type: 'ERROR',
        message: error instanceof Error ? error.message : '시작 실패',
      });
    }
  }, []);

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

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Pressable
            style={styles.logButton}
            onPress={() => setLogsVisible(true)}>
            <Text style={styles.logButtonText}>로그 보기</Text>
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
