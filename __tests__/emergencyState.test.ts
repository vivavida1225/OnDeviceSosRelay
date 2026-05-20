import {
  emergencyReducer,
  initialEmergencyState,
} from '../src/state/emergencyState';

test('moves from monitoring to countdown when analysis reports an emergency', () => {
  const monitoring = emergencyReducer(initialEmergencyState, {
    type: 'SERVICE_STATUS',
    status: 'monitoring',
  });

  const countdown = emergencyReducer(monitoring, {
    type: 'ANALYSIS_RESULT',
    analysis: {
      is_emergency: true,
      crime_type: 'physical_distress',
      situation_summary: '위급 상황 가능성이 감지되었습니다.',
    },
  });

  expect(countdown.mode).toBe('countdown');
  expect(countdown.countdown).toBe(5);
});

test('cancel report prevents the sent state and returns to idle on reset', () => {
  const countdown = {
    ...initialEmergencyState,
    mode: 'countdown' as const,
    countdown: 3,
  };

  const cancelled = emergencyReducer(countdown, {type: 'CANCEL_REPORT'});
  const reset = emergencyReducer(cancelled, {type: 'RESET'});

  expect(cancelled.mode).toBe('cancelled');
  expect(reset).toEqual(initialEmergencyState);
});

test('non-emergency analysis returns to monitoring', () => {
  const result = emergencyReducer(
    {...initialEmergencyState, mode: 'analyzing'},
    {
      type: 'ANALYSIS_RESULT',
      analysis: {
        is_emergency: false,
        crime_type: 'none',
        situation_summary: '위급 상황이 아닙니다.',
      },
    },
  );

  expect(result.mode).toBe('monitoring');
});
