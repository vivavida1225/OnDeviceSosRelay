# OnGuard AI

OnGuard AI는 밤늦게 인적이 드문 길로 귀가할 때 두려움과 걱정을 겪는 여성, 어린이, 노약자 등 안전 취약 사용자를 위한 온디바이스 AI 안심 귀가 Android 프로토타입입니다.

사용자가 `안심 귀가 모드 ON`을 누르면 Android Foreground Service가 센서와 마이크를 계속 감시합니다. 급격한 움직임이나 큰 소리 같은 이상 징후가 감지되면, 먼저 트리거 직전 오디오를 온디바이스 LLM으로 분석하고, 명확하지 않을 때만 트리거 이후 오디오를 2차로 분석합니다. 최종적으로 실제 위급 또는 범죄 상황으로 판단될 때 자동 문자 신고 흐름을 수행합니다.

> 현재 프로젝트는 로컬 APK 직접 설치와 디버그 목적의 프로토타입입니다. 실제 긴급 신고, Google Play 배포, 상용 안전 서비스로 바로 사용할 수준의 검증을 완료한 상태가 아닙니다.

## 대상 사용자

- 밤늦게 혼자 귀가하는 사람
- 인적이 드문 길에서 불안감을 느끼는 여성, 어린이, 노약자
- 직접 휴대폰 조작이 어려운 위협 상황에서 자동 신고 보조가 필요한 사용자

## 핵심 사용 흐름

1. 사용자가 앱에서 `안심 귀가 모드 ON`을 누릅니다.
2. Android Foreground Service가 시작되고 가속도/자이로 센서 모니터링과 음향 이벤트 감지가 활성화됩니다.
3. 뛰기, 넘어짐, 몸싸움처럼 보이는 급격한 움직임 또는 큰 소리가 감지되면 트리거가 발생합니다.
4. 트리거 순간의 이전 최대 10초 오디오를 즉시 복사하고 무음 구간을 잘라 Gemma 4 E4B LiteRT-LM 1차 추론에 전달합니다.
5. 1차 추론이 진행되는 동안 마이크 녹음은 계속 유지되며, 트리거 이후 약 7초 오디오를 별도로 수집합니다.
6. 1차 추론에서 위급 상황이면 바로 신고 전 카운트다운으로 진입합니다.
7. 1차 추론에서 위급 상황이 아니면, 1차 결과 컨텍스트와 트리거 이후 오디오를 이용해 2차 추론을 수행합니다.
8. 분석 로그에는 1차와 2차 결과를 모두 저장하지만, 앱 상태와 신고 판단에는 최종 결과만 사용합니다.
9. `is_emergency=true`이면 앱이 카운트다운 팝업을 띄우고 사용자가 취소할 시간을 줍니다.
10. 취소하지 않으면 위치 링크와 상황 요약을 SMS로 전송합니다.

## 화면 흐름

아래 스크린샷은 사용자가 앱을 켜고 안심 귀가 모드를 시작한 뒤, 트리거 감지와 모델 분석, 신고 전 취소 대기, 분석 로그 확인, 문자 전송까지 이어지는 흐름을 보여줍니다.

| 1. 대기 화면 | 2. 안심 귀가 모드 실행 |
| --- | --- |
| ![대기 화면](src/assets/for_readme/ss1.jpg) | ![감시 중 화면](src/assets/for_readme/ss2.jpg) |
| 사용자는 `안심 귀가 모드 ON`을 눌러 감시를 시작합니다. | 모드가 켜지면 앱은 감시 중 상태로 전환되고 모니터링 중지와 개발용 트리거를 사용할 수 있습니다. |

| 3. Foreground Service 알림 | 4. 위급 상황 판단 후 신고 전 대기 |
| --- | --- |
| ![포그라운드 서비스 알림](src/assets/for_readme/ss3.jpg) | ![신고 전 카운트다운](src/assets/for_readme/ss4.jpg) |
| Android 알림 영역에 감시 중인 Foreground Service가 표시됩니다. | 모델이 실제 위급 상황으로 판단하면 자동 신고 전 카운트다운을 띄우고 사용자가 취소할 기회를 줍니다. |

| 5. 음성 분석 로그 | 6. 문자 신고 결과 |
| --- | --- |
| ![음성 분석 로그](src/assets/for_readme/ss5.jpg) | ![문자 신고 결과](src/assets/for_readme/ss6.jpg) |
| 최근 10개의 모델 분석 결과를 앱 안에서 확인할 수 있습니다. | 취소하지 않으면 상황 요약과 위치 링크가 포함된 문자가 전송됩니다. |

## 사용 기술

- 프레임워크: React Native CLI 0.85.3
- 언어: TypeScript, Kotlin
- Android 구조: React Native New Architecture 및 Fabric 기반 프로젝트 구조
- 백그라운드 실행: Foreground Service
- 네이티브 센서: Android SensorManager 가속도계 및 자이로스코프
- 오디오 캡처: Android AudioRecord, 16 kHz PCM 링 버퍼
- 위치 수집: Android LocationManager
- 문자 전송: Android SmsManager
- 온디바이스 AI: Google AI Edge LiteRT-LM
- 모델: Gemma 4 E4B IT LiteRT-LM 모델 파일, `gemma-4-E4B-it.litertlm`
- 실험용 STT: Sherpa-ONNX Moonshine tiny-ko quantized, `sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27`
- 로컬 영구 저장: 최근 분석 로그 저장용 Android SharedPreferences

## 현재 구현 상태

### React Native 계층

`App.tsx`가 사용자에게 보이는 상태 흐름과 화면을 관리합니다.

- `idle`: 모니터링이 꺼진 상태
- `warming`: 모델 준비를 요청한 상태
- `monitoring`: 센서와 오디오를 감시 중인 상태
- `analyzing`: 트리거가 발생해 오디오를 분석 중인 상태
- `countdown`: 위급 상황으로 판단되어 신고 전 취소 대기 중인 상태
- `sent`: 문자 전송 요청이 큐에 들어간 상태
- `cancelled`: 사용자가 신고를 취소한 상태
- `error`: 권한, 네이티브 모듈, 런타임 오류가 발생한 상태

메인 화면에는 다음 동작이 있습니다.

- `안심 귀가 모드 ON`
- `모니터링 중지`
- `개발용 위급 트리거`
- 메뉴 버튼을 통한 `로그 보기`, `오디오 로그`, `설정`, `개인화 설정`

`로그 보기`에서는 최근 AI 음성 분석 로그 10개를 확인할 수 있습니다. 1차 추론과 2차 추론은 각각 별도 로그로 저장되며 `analysis_pass` 항목으로 구분됩니다. 앱 상태 전환과 신고 판단에는 `final_decision=true`인 최종 결과만 사용합니다. 로그는 Android 네이티브 브릿지를 통해 저장되므로 앱 프로세스가 종료된 뒤에도 남아 있습니다. 새 로그가 저장될 때 10개를 초과한 오래된 항목은 삭제됩니다.

저장되는 로그 항목은 다음과 같습니다.

- `analysis_mode`
- `crime_type`
- `is_emergency`
- `location`
- `model_id`
- `raw_model_response`
- `recognized_dialogue`
- `confidence`
- `audio_summary`
- `decision_reason`
- `stt_transcript`
- `stt_engine`
- `stt_error`
- `situation_summary`
- `trigger_source`
- `litert_error`

`오디오 로그`에서는 최근 트리거 오디오 10개를 확인할 수 있습니다. 각 오디오 로그는 1차 추론용 오디오인지 2차 추론용 오디오인지 `analysis_pass`로 표시하며, 최대 RMS 값과 재생 버튼을 함께 제공합니다. 재생 중지 버튼은 오디오 로그 화면 하단에 고정되어 있습니다.

### 주소 선택과 좌표 확정 흐름

메뉴의 `설정` 또는 최초 사용자 정보 등록 화면에서 `출발지 선택`과 `도착지 선택`을 누르면 `LocationPickerModal`이 열립니다. 이 모달은 React Native `WebView` 안에서 Daum Postcode 주소 검색 화면을 띄우고, 사용자가 주소를 선택하면 그 주소를 특정 위도/경도로 변환한 뒤 Kakao 지도 위에서 최종 위치를 확인하게 합니다.

현재 구현 흐름은 다음과 같습니다.

1. 사용자가 `출발지 선택` 또는 `도착지 선택`을 누릅니다.
2. `App.tsx`의 `openLocationPicker(target)`이 `locationPickerTarget`을 `startLocation` 또는 `destinationLocation`으로 설정합니다.
3. `LocationPickerModal`이 열리고 `buildKakaoLocationPickerHtml()`이 만든 HTML을 WebView에 로드합니다.
4. WebView 안의 Daum Postcode 스크립트가 주소 검색 UI를 표시합니다.
5. 사용자가 주소를 선택하면 Postcode `oncomplete(data)` 콜백이 실행됩니다.
6. WebView는 `roadAddress`, `jibunAddress`, `address`, `autoRoadAddress`, `autoJibunAddress`를 이용해 좌표 변환 후보 주소 목록을 만듭니다.
7. WebView는 후보 주소를 직접 좌표화하지 않고, `{type: "addressSelected", address, candidates}` 메시지를 React Native로 보냅니다.
8. React Native의 `handleLocationPickerMessage()`는 `geocodeLocationPickerAddress()`를 호출합니다.
9. `geocodeLocationPickerAddress()`는 후보 주소를 순서대로 Android 네이티브 브릿지 `EmergencyNative.geocodeAddress(address)`에 전달합니다.
10. `EmergencyNativeModule.kt`는 Android `Geocoder`와 `Locale.KOREA`를 사용해 주소를 위도/경도로 변환합니다.
11. 좌표를 찾으면 React Native가 WebView의 `window.renderNativeGeocodeResult(...)`를 `injectJavaScript()`로 호출합니다.
12. WebView는 전달받은 좌표로 Kakao 지도를 렌더링하고 드래그 가능한 마커를 표시합니다.
13. 사용자가 지도에서 핀 위치를 확인하거나 조정한 뒤 `Confirm`을 누르면 WebView가 `{type: "location", address, latitude, longitude}`를 React Native로 보냅니다.
14. React Native는 해당 좌표를 `profileDraft.startLocation` 또는 `profileDraft.destinationLocation`에 저장하고, 기존 아동 경로(`childRoutePath`)는 초기화합니다.

이 흐름에서 Daum Postcode는 주소 선택 UI만 담당하고, Kakao Map은 최종 지도 표시와 핀 조정만 담당합니다. 주소를 좌표로 바꾸는 단계는 WebView 안의 Kakao Maps `services.Geocoder`가 아니라 Android native `Geocoder`가 담당합니다.

이 구조를 쓰는 이유는 WebView 안에서 Kakao Maps JavaScript SDK 자체는 로드되어 지도 렌더링이 가능하지만, 일부 기기/도메인 설정 조합에서 `kakao.maps.services.Geocoder().addressSearch()`와 `Places.keywordSearch()`가 정상 좌표 배열 대신 `"ERROR"`를 반환할 수 있기 때문입니다. `경로 보기` 화면이 정상 동작했던 이유도 이 차이 때문입니다. 경로 보기는 이미 저장된 위도/경도를 지도에 표시하므로 Kakao services 주소 변환 API를 호출하지 않습니다.

관련 코드 위치는 다음과 같습니다.

- `App.tsx`
  - `LocationPickerModal`: 주소 검색 WebView 모달
  - `buildKakaoLocationPickerHtml()`: Daum Postcode와 Kakao 지도 HTML 생성
  - `handleLocationPickerMessage()`: WebView 메시지 처리
  - `geocodeLocationPickerAddress()`: 주소 후보를 native geocode로 변환
- `src/native/EmergencyNative.ts`
  - `geocodeAddress(address)` TypeScript 브릿지 타입
- `android/app/src/main/java/com/emergencycall/EmergencyNativeModule.kt`
  - `geocodeAddress(address, promise)`: Android `Geocoder` 기반 좌표 변환

### 등하교 경로 수동/자동 입력 흐름

유아 모드의 등하교 동선은 최대 5개까지 저장할 수 있습니다. 각 경로는 `SavedRoute` 데이터로 관리되며, 경로 식별자, 이름, 활성화 여부, 출발지, 도착지, 웨이포인트 배열, 출발 시간대, 도착 시간대를 함께 가집니다. 따라서 수동으로 입력한 경로와 GPS 자동 수집으로 만든 경로는 동일한 데이터 형식으로 저장되고, 설정 화면의 활성 경로 선택과 개인 정보 수정 화면의 경로 관리 메뉴에서 같은 방식으로 다룹니다.

경로 데이터의 기본 구조는 다음과 같습니다.

```ts
type SavedRoute = {
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
```

#### 수동 경로 입력

개인 정보 수정 화면의 `경로 수동 인식` 버튼은 출발지와 도착지를 별도 버튼으로 흩어 두지 않고, 다음 3단계 플로우를 강제합니다.

1. `openManualRouteFlow()`가 수동 경로 입력 상태를 시작하고 `LocationPickerModal`을 출발지 선택 모드로 엽니다.
2. 출발지가 확정되면 `handleLocationPickerMessage()`가 `profileDraft.startLocation`에 좌표를 저장하고 곧바로 도착지 선택 모드로 전환합니다.
3. 도착지가 확정되면 `RoutePickerModal`을 열어 Kakao 지도 위에서 웨이포인트를 직접 찍게 합니다.
4. 사용자는 경로 이름과 출발/도착 시간대를 입력한 뒤 저장합니다.
5. `handleRoutePickerMessage()`는 최신 `profileDraft`를 기준으로 출발지, 도착지, 웨이포인트, 시간 정보를 묶어 `SavedRoute`로 저장합니다.

수동 경로 저장 시점에는 `profileDraftRef.current`를 사용해 최신 출발지와 도착지를 참조합니다. React callback이 오래된 `profileDraft`를 잡고 있어 저장 시점에 출발지/도착지가 비어 보이는 문제를 피하기 위한 구조입니다. 문제가 재현될 때는 Metro 또는 `adb logcat`에서 `[ManualRouteFlow]` 로그를 보면 출발지 선택, 도착지 선택, 경로 저장 요청, 저장 승인 또는 차단 지점을 확인할 수 있습니다.

#### GPS 자동 경로 수집

개인 정보 수정 화면의 `경로 자동 인식` 버튼은 실시간 GPS 기반 경로 수집 모달을 엽니다. 이 모달은 `RouteAutoCaptureModal`과 Kakao 지도 WebView를 사용해 현재 위치를 출발지로 확인한 뒤, Android 네이티브 위치 수집 서비스에 경로 수집을 요청합니다.

현재 구현 흐름은 다음과 같습니다.

1. `openRouteAutoCapture()`가 위치 권한을 확인하고 `EmergencyNative.getCurrentLocation()`으로 현재 GPS 좌표를 가져옵니다.
2. 사용자가 시작을 누르면 `startRouteAutoCapture()`가 `EmergencyNative.startRouteCapture(start)`를 호출합니다.
3. Android의 `RouteCaptureForegroundService`가 화면 꺼짐 상태에서도 포그라운드 서비스로 유지되며 약 10초 간격으로 위치를 수집합니다.
4. 네이티브 서비스는 이전 저장 지점과 4m 이상 떨어져 있고 GPS 정확도 조건을 만족하는 좌표만 웨이포인트에 추가합니다.
5. 수집 중에는 `routeCaptureUpdate` 이벤트가 React Native로 전달되어 수집 지점 수와 현재 상태를 갱신합니다.
6. 사용자가 `경로 자동 수집 종료`를 누르면 `EmergencyNative.stopRouteCapture()`가 최종 위치를 도착지로 확정하고 전체 웨이포인트를 반환합니다.
7. 검수 화면에서 지도 위 경로 라인과 마커를 확인하고, 중간 웨이포인트와 도착지 마커를 드래그해 미세 조정할 수 있습니다.
8. 경로 이름과 출발/도착 시간대를 입력한 뒤 최종 저장하면 동일한 `SavedRoute` 구조로 저장됩니다.

#### 저장된 경로 관리

개인 정보 수정 화면 맨 아래의 `저장된 경로 관리` 영역에서는 최대 5개 경로를 확인하고 편집할 수 있습니다.

- 경로 이름, 출발지 주소, 도착지 주소, 웨이포인트 수, 출발/도착 시간대를 확인합니다.
- 경로를 펼치면 `buildKakaoRoutePreviewHtml()`이 만든 Kakao 지도 미리보기에서 경로 모양을 확인합니다.
- 이름과 시간대는 리스트 안에서 바로 수정합니다.
- `웨이포인트 수정`을 누르면 기존 `RoutePickerModal`이 해당 저장 경로를 편집 모드로 열고, 저장 시 `updateSavedRouteInProfile()`이 해당 경로의 웨이포인트를 교체합니다.
- `이 경로 사용`을 누르면 `activateRouteInProfile()`이 활성 경로를 바꾸고, 선택된 경로의 출발지, 도착지, 웨이포인트, 시간대가 현재 프로필 상태에 동기화됩니다.

관련 코드 위치는 다음과 같습니다.

- `App.tsx`
  - `openManualRouteFlow()`: 수동 입력 3단계 플로우 시작
  - `handleLocationPickerMessage()`: 출발지/도착지 선택 메시지 처리
  - `RoutePickerModal`: 수동 경로 입력 및 저장 경로 웨이포인트 편집
  - `RouteAutoCaptureModal`: GPS 자동 수집 시작, 종료, 검수 화면
  - `SavedRouteManager`: 개인 정보 수정 화면 하단의 경로 목록, 지도 미리보기, 경로 정보 편집 UI
  - `buildKakaoRoutePreviewHtml()`: 저장된 경로 지도 미리보기 WebView HTML 생성
  - `addSavedRouteToProfile()`, `updateSavedRouteInProfile()`, `activateRouteInProfile()`: 경로 저장, 수정, 활성화
- `src/native/EmergencyNative.ts`
  - `SavedRoute`: 경로 저장 데이터 타입
  - `startRouteCapture(start)`, `stopRouteCapture()`, `getCurrentLocation()`: 경로 자동 수집 브릿지 타입
- `android/app/src/main/java/com/emergencycall/RouteCaptureForegroundService.kt`
  - 10초 간격 GPS 수집, 4m 거리 필터, 정확도 필터, 포그라운드 서비스 유지
- `android/app/src/main/java/com/emergencycall/EmergencyNativeModule.kt`
  - React Native에서 호출하는 경로 자동 수집 시작/종료 브릿지 구현

### Android 네이티브 계층

Kotlin 네이티브 코드는 React Native 브릿지와 백그라운드 실행 로직을 제공합니다.

- `EmergencyNativeModule.kt`
  - 모니터링 서비스 시작 및 중지
  - `Geocoder`를 통한 주소 좌표 변환
  - `SmsManager`를 통한 문자 전송
  - 사이렌 알림 시작 및 중지
  - `SharedPreferences`를 통한 최근 분석 로그 로드 및 저장

- `EmergencyForegroundService.kt`
  - Foreground Service로 실행
  - 센서와 마이크 모니터링 유지
  - PCM 링 버퍼 유지
  - GPS 및 위치 수집
  - React Native 이벤트 발행
    - `serviceStatus`
    - `triggerDetected`
    - `analysisDebug`
    - `analysisResult`
    - `smsStatus`
    - `nativeError`

- `LiteRtGemmaAnalyzer.kt`
  - 로컬 LiteRT-LM Gemma 모델 로드
  - 무음 구간을 잘라낸 오디오 컨텍스트를 모델에 전달
  - 엄격한 JSON 출력 요청
  - 모델 출력을 다음 형태로 파싱

- `SherpaOnnxMoonshineSttAnalyzer.kt`
  - 설정에서 실험용 STT를 켰을 때만 트리거 이후 오디오를 Moonshine tiny-ko 모델로 전사
  - STT 결과는 `stt_transcript`, `stt_engine`, `stt_error`로 로그에만 저장
  - Gemma 프롬프트와 최종 신고 판단에는 STT 결과를 전달하지 않음


```json
{
  "is_emergency": true,
  "confidence": "high",
  "crime_type": "스토킹",
  "situation_summary": "사용자가 밤길에서 누군가 따라오는 상황을 거부하며 도움 또는 신고가 필요해 보입니다.",
  "recognized_dialogue": "따라오지 마세요. 경찰 불러주세요.",
  "audio_summary": "트리거 직전 오디오에서 접근 거부와 도움 요청으로 보이는 발화가 들립니다.",
  "analysis_pass": "primary",
  "final_decision": true,
  "decision_reason": "트리거 직전 오디오에서 접근 거부 발화와 긴박한 톤이 확인되었습니다."
}
```

## 트리거와 오디오 처리 흐름

### 1. 모니터링 시작

`안심 귀가 모드 ON`을 누르면 다음 흐름이 실행됩니다.

- Android 런타임 권한을 요청합니다.
- 앱에 저장된 `safetyProfile.mode`를 읽어 현재 감시 모드(`monitoringMode`)를 결정합니다.
  - 아동 모드: `child`
  - 성인 모드: `adult`
- LiteRT-LM 모델 준비를 요청합니다.
- `EmergencyForegroundService`가 포그라운드 알림과 함께 시작됩니다.
- `EmergencyNative.startMonitoring(config)` 호출 시 `monitoringMode`가 네이티브 서비스까지 전달됩니다.
- 오디오 녹음과 센서 리스너가 등록됩니다.

### 2. 트리거 감지

서비스는 다음 조건에서 분석을 시작할 수 있습니다.

- 센서 트리거: 뛰기, 넘어짐, 충격, 갑작스러운 움직임을 나타내는 높은 가속도 또는 회전값
- 오디오 트리거: RMS 또는 피크 값 기준으로 감지된 큰 음향 이벤트
- 개발용 트리거: 앱 안의 수동 테스트 버튼

### 3. 오디오 추출

서비스는 최근 마이크 입력을 10초 링 버퍼에 유지합니다. 트리거가 발생하면 다음 과정을 거칩니다.

- 트리거 직후 즉시 링 버퍼를 복사해 트리거 이전 최대 10초 오디오를 고정합니다.
- 1차 추론용 오디오는 비무음 구간 중심으로 잘라 Gemma 4 E4B LiteRT-LM에 즉시 전달합니다.
- 1차 추론이 진행되는 동안 마이크 입력은 계속 읽으며 트리거 이후 약 7초 오디오를 별도로 수집합니다.
- 1차 추론이 위급 상황이면 2차 추론을 기다리지 않고 신고 전 카운트다운으로 넘어갑니다.
- 1차 추론이 위급 상황이 아니면, 1차 결과 컨텍스트와 트리거 이후 오디오를 2차 프롬프트로 전달합니다.
- 디버그 로그에는 `primary_audio_captured`, `primary_ai_started`, `primary_ai_completed`, `secondary_capture_started`, `secondary_audio_captured`, `secondary_ai_started`, `secondary_ai_completed` 단계가 기록됩니다.
- 각 로그에는 버퍼 채움 비율, RMS와 피크 값, 비무음 구간 위치, PCM 바이트 수, 트리거 출처가 포함됩니다.

### 4. 온디바이스 LLM 분석

모델은 1차 추론에서는 트리거 이전 최대 10초 오디오와 위치, 한국어 위급 상황 판단 프롬프트를 함께 받습니다. 2차 추론에서는 1차 추론 결과 컨텍스트와 트리거 이후 약 7초 오디오를 받습니다.

분석 프롬프트는 `monitoringMode`에 따라 분기됩니다.

- 성인 모드(`adult`)는 `prompts/onguard_gemma_prompts_adult.json`을 기본 프롬프트로 사용합니다.
- 아동 모드(`child`)는 `prompts/onguard_gemma_prompts_child.json`을 기본 프롬프트로 사용합니다.
- 아동 모드 프롬프트는 비명이나 공포 톤뿐 아니라, 부모 사칭, 보상 제안, 동행 유도, 차량 탑승 유도처럼 조용하고 친절한 말투로 이루어질 수 있는 유인/유괴 정황을 별도로 판단하도록 구성되어 있습니다.
- Android 빌드 시 `prompts/` 디렉터리의 JSON 파일들이 앱 assets에 포함되고, `GemmaPromptStore`가 현재 모드에 맞는 프롬프트 파일을 선택합니다.
- 메뉴의 `프롬프트 수정` 화면에서는 아동용/성인용 프롬프트를 각각 따로 확인, 수정, 저장, 기본값 원복할 수 있습니다.
- 분석 결과와 디버그 로그에는 `monitoring_mode`가 포함되어 어떤 모드의 프롬프트로 판정했는지 확인할 수 있습니다.

프롬프트는 모델에 다음 내용을 명시합니다.

- 녹음은 큰 소리 또는 갑작스러운 움직임 때문에 시작됐을 수 있습니다.
- 트리거 발생 자체가 위급 상황을 보장하지는 않습니다.
- 대화 내용과 음향 단서를 바탕으로 객관적으로 판단해야 합니다.
- 1차 추론은 트리거 직전 맥락을 빠르게 판단합니다.
- 2차 추론은 1차에서 위급 상황이 아니라고 판단된 경우에만, 트리거 직후 발화와 음향 단서를 다시 확인합니다.
- "도와주세요", "살려주세요", "따라오지 마세요", "가까이 오지 마세요", "신고해 주세요" 같은 한국어 표현은 중요한 단서입니다.
- "죽여버리겠다", "죽고 싶냐" 같은 가해자의 위협적인 말도 중요한 단서입니다.
- 응답은 순수 JSON 형식으로만 반환해야 합니다.
- 응답에는 `analysis_pass`, `confidence`, `audio_summary`, `decision_reason`을 포함해야 합니다.

### 5. 신고 전 사용자 안전장치

`is_emergency=true`이면 다음 흐름이 실행됩니다.

- 카운트다운 모달이 표시됩니다.
- 진동이 시작됩니다.
- 사용자는 문자 전송 전에 신고를 취소할 수 있습니다.
- 취소하지 않으면 앱이 문자 전송을 요청합니다.

### 6. 문자 신고

네이티브 모듈은 다음 내용을 조합해 문자 메시지를 만듭니다.

- 상황 요약
- 위치가 있을 때 Google Maps 위치 링크

문자 메시지는 Android `SmsManager`를 통해 전송됩니다.

> 개발 중에는 수신 번호를 반드시 테스트용 전화번호로 설정해야 합니다. 통제되지 않은 테스트 중에는 긴급 신고 번호를 목적지로 설정하지 마십시오.

## Android 권한

Android 매니페스트에는 프로토타입 동작에 필요한 다음 권한이 선언되어 있습니다.

- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_MICROPHONE`
- `FOREGROUND_SERVICE_LOCATION`
- `HIGH_SAMPLING_RATE_SENSORS`
- `RECORD_AUDIO`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `POST_NOTIFICATIONS`
- `VIBRATE`
- `SEND_SMS`

## 로컬 모델 설정

LiteRT-LM 모델 파일은 크기가 크기 때문에 git에 커밋하지 않습니다.

### 모델 파일 다운로드

현재 앱은 `gemma-4-E4B-it.litertlm` 파일명을 기준으로 모델을 찾습니다. 모델 파일은 공개 Hugging Face 저장소 `litert-community/gemma-4-E4B-it-litert-lm`에서 내려받을 수 있습니다.

PowerShell에서 직접 다운로드하는 예시는 다음과 같습니다.

```powershell
mkdir models
curl.exe -L "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm?download=true" -o "models\gemma-4-E4B-it.litertlm"
```

`huggingface-cli`를 사용하는 경우에는 다음 명령을 사용할 수 있습니다.

```powershell
huggingface-cli download litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm --local-dir models
```

다운로드 후 PC 기준 모델 파일 위치는 다음과 같아야 합니다.

```text
models/gemma-4-E4B-it.litertlm
```

앱이 기대하는 기기 내부 비공개 경로는 다음과 같습니다.

```text
/data/data/com.emergencycall/files/models/gemma-4-E4B-it.litertlm
```

디버그 가능한 앱 설치 상태에서 모델을 넣는 예시는 다음과 같습니다.

```powershell
adb shell run-as com.emergencycall mkdir -p files/models
adb push gemma-4-E4B-it.litertlm /data/local/tmp/gemma-4-E4B-it.litertlm
adb shell run-as com.emergencycall cp /data/local/tmp/gemma-4-E4B-it.litertlm files/models/gemma-4-E4B-it.litertlm
adb shell rm /data/local/tmp/gemma-4-E4B-it.litertlm
```

디버그 불가능한 릴리즈 설치에서는 `run-as`를 사용할 수 없을 수 있습니다. 이 경우 디버그 빌드에서 모델을 넣은 뒤 앱 데이터를 유지한 채 릴리즈로 업데이트하거나, 실제 배포 전 별도의 모델 가져오기 기능을 구현해야 합니다.


### 실험용 STT 런타임 및 모델 다운로드

앱에는 실험용 STT 기능이 남아 있습니다. 기본값은 OFF이고 Gemma 판단에는 영향을 주지 않지만, 설정에서 STT를 켜면 다음 모델을 사용합니다.

```text
sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27
```

Android 빌드는 Sherpa-ONNX Android 런타임 AAR를 로컬 파일로 참조합니다. git에는 대용량 AAR를 올리지 않으므로, 빌드 전에 다음 위치에 파일이 있어야 합니다.

```text
android/app/libs/sherpa-onnx-1.13.0.aar
```

PowerShell에서 AAR를 내려받는 예시는 다음과 같습니다.

```powershell
mkdir android\app\libs
curl.exe -L "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.0/sherpa-onnx-1.13.0.aar" -o "android\app\libs\sherpa-onnx-1.13.0.aar"
```

STT 모델 파일은 다음 PC 경로에 내려받습니다.

```text
models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/encoder_model.ort
models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/decoder_model_merged.ort
models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/tokens.txt
```

PowerShell 다운로드 예시는 다음과 같습니다.

```powershell
mkdir models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27
curl.exe -L "https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/resolve/main/encoder_model.ort?download=true" -o "models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\encoder_model.ort"
curl.exe -L "https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/resolve/main/decoder_model_merged.ort?download=true" -o "models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\decoder_model_merged.ort"
curl.exe -L "https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/resolve/main/tokens.txt?download=true" -o "models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\tokens.txt"
```

앱이 우선 확인하는 디버그 빌드 내부 경로는 다음과 같습니다.

```text
/data/data/com.emergencycall/files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/
```

연결된 기기에 모델을 넣는 예시는 다음과 같습니다.

```powershell
adb push models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\encoder_model.ort /data/local/tmp/encoder_model.ort
adb push models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\decoder_model_merged.ort /data/local/tmp/decoder_model_merged.ort
adb push models\sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27\tokens.txt /data/local/tmp/tokens.txt
adb shell chmod 644 /data/local/tmp/encoder_model.ort /data/local/tmp/decoder_model_merged.ort /data/local/tmp/tokens.txt
adb shell run-as com.emergencycall mkdir -p files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27
adb shell run-as com.emergencycall cp /data/local/tmp/encoder_model.ort files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/encoder_model.ort
adb shell run-as com.emergencycall cp /data/local/tmp/decoder_model_merged.ort files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/decoder_model_merged.ort
adb shell run-as com.emergencycall cp /data/local/tmp/tokens.txt files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27/tokens.txt
adb shell run-as com.emergencycall ls -l files/models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27
```

성공하면 기기 내부 모델 폴더에 `encoder_model.ort`, `decoder_model_merged.ort`, `tokens.txt` 3개 파일이 보여야 합니다.

## 개발 명령어

### 1. 의존성 설치

```powershell
npm install
```

### 2. Metro 실행

터미널 1에서 실행합니다.

```powershell
npm start
```

### 3. USB 연결 디버그 실행

기기를 USB로 연결한 뒤, 터미널 2에서 실행합니다.

```powershell
adb reverse tcp:8081 tcp:8081
```

그 다음 디버그 APK를 빌드합니다.

```powershell
cd android
.\gradlew.bat assembleDebug
```

빌드가 끝나면 디바이스에 설치합니다.

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

설치된 디버그 앱을 실행합니다.

```powershell
adb shell am start -W -n com.emergencycall/.MainActivity
```

### 4. 릴리즈 APK 빌드

```powershell
cd android
.\gradlew.bat assembleRelease
```

### 5. 릴리즈 APK 설치

```powershell
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

### 6. 검증 명령어

```powershell
npx tsc --noEmit
npm run lint
npm test -- --runInBand
```

## 저장소 관리 기준

이 저장소는 다음 항목을 git에 올리지 않도록 설정합니다.

- `node_modules`
- Android 및 iOS 빌드 산출물
- APK 및 AAB 파일
- 로컬 Gradle, Metro 캐시
- 대용량 로컬 AI 모델 파일
- 로컬 오디오 캡처와 디버그 덤프

`android/app/src/main/res/mipmap-*` 아래의 앱 아이콘 리소스는 작은 생성 이미지이므로 커밋 대상입니다.

## 현재 한계

- 이 프로젝트는 프로토타입이며 인증된 긴급 신고 시스템이 아닙니다.
- 모델 정확도는 캡처된 오디오 품질, 기기 마이크 특성, 프롬프트, 모델 성능에 크게 의존합니다.
- 자동 SMS 권한은 Google Play 배포에서 강하게 제한됩니다.
- 현재 릴리즈 빌드는 로컬 프로젝트 서명 설정을 사용하며 개인 직접 설치 테스트 목적입니다.
- 모델 파일은 git 밖에서 관리하며 기기에 별도로 배치해야 합니다.

## TODOS

1. 모델 학습 방안 연구
  - 부족한 한국어 인식 능력을 보완하기 위해 파인튜닝된 모델을 찾거나 직접 학습시키는 방안을 고안한다.
2. 개인정보 입력 기능 추가
  - 집 층호수, 가족 구성원/연애 상대방의 정보 등을 사전 입력할 수 있게 구현한다.
  - 안심귀가 모드의 경우 평소 사용자의 귀가 루틴 정보를 등록해둔다
  - 사전 등록된 정보를 AI에게 prompt context로 제공해, AI가 보다 더 정확한 상황 추론을 가능하게끔 한다.
  - 온디바이스 AI로 구동되므로 개인정보 침해 및 유출 이슈에서 비교적 자유롭다.
3. 에이전트 대화 기능 추가
  - 클라이언트 사이드에서 챗봇이 돌아가는 것과 같다.
  - 첫 신고 이후 경찰에서부터 답신이 올 시 추가로 녹음된 데이터로 상황을 분석하여 생성된 텍스트 데이터를 추가로 전송한다.
  - 혹은 로컬 AI와 AI챗봇(경찰 측) 과의 API 통신으로 세부 신고 사항을 추가 공유하는 식의 구현도 가능하다.
4. 추가 번호 등록 가능 기능
  - 경찰 외에도, 부모님 혹은 보호자 등의 전화번호도 자유롭게 등록할 수 있게 구현한다.
5. 가정용(데이트폭력/가정폭력) 모드 전환 가능
  - 비교적 조용한 실내에서 일어나는 폭력 상황을 감지할 수 있게끔 구현한다. 움직임보다는 음성 인식 위주로 구현한다.
6. 위협 감지 트리거 조건 세부화
  - 현재는 큰 소리 / 큰 동작 감지로 트리거를 발생시키고, 1차 10초 / 2차 7초 오디오 분석으로 위급 여부를 판단한다.
  - 현재 위치정보(해당 지역의 치안)도 판단 기준 변수에 넣을 수 있다.
7. 앱 내부 모델 가져오기 기능 추가
  - 현재는 개발 편의를 위해 앱이 외부 모델 폴더를 만들고 adb로 모델 파일을 넣는 방식이다.
  - 릴리즈 앱 단독 사용을 위해 Storage Access Framework 또는 파일 선택기를 통해 사용자가 모델 파일을 고르고, 앱이 직접 내부 저장소로 복사하는 기능을 추가한다.
  - Gemma 모델의 파라미터 개수(e4b, e2b 간 선택 가능)를 앱 내부에서 검증하고 교체할 수 있게 한다.
8. 트리거 발동 조건 세분화
  - 여성 안심귀가 모드와 어린이 안심귀가 모드 2개로 타겟층 설정
    - 여성의 경우 귀가 이후 이상상황(큰 소리)이 없는지 여부를 감지
    - 어린이의 경우 평소 루트 이탈 + 주변 대화 분석
  - 기본 귀가 루틴(GPS, 카카오맵 기반) 등록 가능 기능 구현
  - 현재의 '움직임 + 큰 소리' 의 2채널 트리거에서, 서로 다른 여러 채널의 정보를 종합해 위급 상황을 판단하도록.
9. UI 개선 및 UX 플로우 구체화
10. 카카오맵 연동 가능성 (기획 단계에서 어필 가능)
    - 현재 존재하는 서비스인 카카오맵의 추가 기능으로써의 가능성을 어필한다.
