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
  type GemmaPromptTemplates,
  type SttEngine,
} from './src/native/EmergencyNative';
import {
  emergencyReducer,
  initialEmergencyState,
} from './src/state/emergencyState';

const DEFAULT_AUDIO_RMS_THRESHOLD = 0.35;
const STT_ENGINE_OFF: SttEngine = 'off';
const STT_ENGINE_ON: SttEngine = 'sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27';

const baseMonitoringConfig = {
  modelId: 'gemma-4-E4B-it',
  sensorThreshold: 28,
};

const DEFAULT_CUSTOM_PROMPT = `기본 프롬프트를 사용합니다.
트리거 이전 10초와 이후 7초 오디오의 톤, 긴급성, 발화, 배경 소음만 근거로 판단하세요.
STT 결과는 실험용 로그일 뿐 판단 근거로 사용하지 마세요.
위급 상황 단서가 부족하면 보수적으로 false를 반환하세요.`;

const defaultAppSettings: AppSettings = {
  sttEngine: STT_ENGINE_OFF,
  customPrompt: DEFAULT_CUSTOM_PROMPT,
  audioRmsThreshold: DEFAULT_AUDIO_RMS_THRESHOLD,
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
  const [logsVisible, setLogsVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [personalizationVisible, setPersonalizationVisible] = useState(false);
  const [promptEditorVisible, setPromptEditorVisible] = useState(false);
  const [audioLogsVisible, setAudioLogsVisible] = useState(false);
  const [audioLogs, setAudioLogs] = useState<AudioLogEntry[]>([]);
  const [playingAudioId, setPlayingAudioId] = useState<string>();
  const [sttEngine, setSttEngine] = useState<SttEngine>(defaultAppSettings.sttEngine);
  const [customPrompt, setCustomPrompt] = useState(defaultAppSettings.customPrompt);
  const [promptDraft, setPromptDraft] = useState(defaultAppSettings.customPrompt);
  const [gemmaPromptDraft, setGemmaPromptDraft] = useState<GemmaPromptTemplates>(
    emptyGemmaPromptTemplates,
  );
  const [audioRmsThreshold, setAudioRmsThreshold] = useState(
    defaultAppSettings.audioRmsThreshold,
  );
  const [audioRmsThresholdInput, setAudioRmsThresholdInput] = useState(
    String(defaultAppSettings.audioRmsThreshold),
  );
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
          sttEngine: resolveSttEngine(parsed),
          customPrompt: parsed.customPrompt || defaultAppSettings.customPrompt,
          audioRmsThreshold:
            parsed.audioRmsThreshold ?? defaultAppSettings.audioRmsThreshold,
        };
        setSttEngine(nextSettings.sttEngine);
        setCustomPrompt(nextSettings.customPrompt);
        setPromptDraft(nextSettings.customPrompt);
        setAudioRmsThreshold(nextSettings.audioRmsThreshold);
        setAudioRmsThresholdInput(String(nextSettings.audioRmsThreshold));
      })
      .catch(error => {
        console.warn('[EmergencyDebug] loadAppSettings failed', error);
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

  const savePrompt = useCallback(async () => {
    const nextPrompt = promptDraft.trim() || defaultAppSettings.customPrompt;
    setCustomPrompt(nextPrompt);
    await saveSettings({sttEngine, customPrompt: nextPrompt, audioRmsThreshold});
    setPersonalizationVisible(false);
  }, [audioRmsThreshold, promptDraft, saveSettings, sttEngine]);

  const restoreDefaultPrompt = useCallback(() => {
    setPromptDraft(defaultAppSettings.customPrompt);
  }, []);

  const openGemmaPromptEditor = useCallback(async () => {
    setSettingsVisible(false);
    try {
      const promptsJson = await EmergencyNative.loadGemmaPrompts();
      const parsed = JSON.parse(promptsJson) as GemmaPromptTemplates;
      setGemmaPromptDraft({
        system: parsed.system ?? '',
        primary: parsed.primary ?? '',
        secondary: parsed.secondary ?? '',
      });
      setPromptEditorVisible(true);
    } catch (error) {
      Alert.alert(
        '프롬프트 로드 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);

  const updateGemmaPromptDraft = useCallback(
    (key: keyof GemmaPromptTemplates, value: string) => {
      setGemmaPromptDraft(current => ({...current, [key]: value}));
    },
    [],
  );

  const saveGemmaPrompts = useCallback(async () => {
    try {
      await EmergencyNative.saveGemmaPrompts(JSON.stringify(gemmaPromptDraft));
      setPromptEditorVisible(false);
    } catch (error) {
      Alert.alert(
        '프롬프트 저장 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [gemmaPromptDraft]);

  const resetGemmaPrompts = useCallback(async () => {
    try {
      const promptsJson = await EmergencyNative.resetGemmaPrompts();
      const parsed = JSON.parse(promptsJson) as GemmaPromptTemplates;
      setGemmaPromptDraft({
        system: parsed.system ?? '',
        primary: parsed.primary ?? '',
        secondary: parsed.secondary ?? '',
      });
    } catch (error) {
      Alert.alert(
        '프롬프트 원복 실패',
        error instanceof Error ? error.message : String(error),
      );
    }
  }, []);
  const startMonitoring = useCallback(async () => {
    try {
      dispatch({type: 'START_REQUESTED'});
      await requestAndroidPermissions();
      const config = {
        ...baseMonitoringConfig,
        audioRmsThreshold,
        sttEnabled: sttEngine !== STT_ENGINE_OFF,
        sttEngine,
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
  }, [audioRmsThreshold, customPrompt, sttEngine]);

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

  const updateSttEngine = useCallback(
    async (nextEngine: SttEngine) => {
      setSttEngine(nextEngine);
      await saveSettings({sttEngine: nextEngine, customPrompt, audioRmsThreshold});
      if (!isMonitoring) {
        return;
      }

      try {
        await EmergencyNative.startMonitoring({
          ...baseMonitoringConfig,
          audioRmsThreshold,
          sttEnabled: nextEngine !== STT_ENGINE_OFF,
          sttEngine: nextEngine,
          customPrompt,
        });
      } catch (error) {
        console.warn('[EmergencyDebug] updateSttEngine failed', error);
      }
    },
    [audioRmsThreshold, customPrompt, isMonitoring, saveSettings],
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
    saveSettings,
    sttEngine,
  ]);
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
            <Pressable style={styles.menuOption} onPress={openGemmaPromptEditor}>
              <Text style={styles.menuOptionText}>프롬프트 수정</Text>
            </Pressable>
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

      <Modal visible={promptEditorVisible} animationType="slide">
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>프롬프트 수정</Text>
              <Text style={styles.logsSubtitle}>시스템 / 1차 / 2차 추론</Text>
            </View>
            <Pressable
              style={styles.closeButton}
              onPress={() => setPromptEditorVisible(false)}>
              <Text style={styles.closeButtonText}>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.logsContent}>
            <Text style={styles.settingDescription}>
              루트의 prompts/onguard_gemma_prompts.json이 기본값입니다. 여기서 저장한 내용은 이 기기 앱 설정에 override로 남고, 기본값 원복으로 언제든 되돌릴 수 있습니다.
            </Text>
            <PromptEditorField
              label="시스템 프롬프트"
              description="모델의 전역 역할과 출력 형식을 지정합니다."
              value={gemmaPromptDraft.system}
              onChangeText={value => updateGemmaPromptDraft('system', value)}
              minHeight={180}
            />
            <PromptEditorField
              label="1차 추론 프롬프트"
              description="트리거 직전 최대 10초 오디오 분석 지침입니다. {{sampleRate}}, {{triggerSource}}, {{locationText}}, {{customPromptText}} 토큰을 사용할 수 있습니다."
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

      <Modal visible={audioLogsVisible} animationType="slide">
        <SafeAreaView style={styles.logsScreen}>
          <View style={styles.logsHeader}>
            <View>
              <Text style={styles.logsTitle}>오디오 로그</Text>
              <Text style={styles.logsSubtitle}>최근 {audioLogs.length}개 / 최대 10개</Text>
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






