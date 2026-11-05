# Android 앱 패키징 (PWA → APK/AAB)

웹 관리 화면은 PWA 이므로 휴대폰 Chrome 에서 서버 주소를 열고 **메뉴 → 홈 화면에 추가(앱 설치)** 를 누르면 바로 앱처럼 쓸 수 있습니다.

스토어 배포나 APK 파일이 필요하면 Google 의 공식 도구 Bubblewrap 으로 TWA(Trusted Web Activity) 앱을 만듭니다.

## 준비물
- Node.js 20 이상, JDK 17, Android SDK (Bubblewrap 이 처음 실행할 때 설치를 안내합니다)
- HTTPS 로 접속되는 서버 주소

## 빌드

```bash
npm install -g @bubblewrap/cli
cd android
# twa-manifest.json 의 host, iconUrl, webManifestUrl 을 실제 서버 주소로 바꿉니다
bubblewrap update --manifest ./twa-manifest.json
bubblewrap build        # app-release-signed.apk 와 app-release-bundle.aab 생성
```

## 서명 키
- 처음 빌드할 때 Bubblewrap 이 서명 키(`android.keystore`)를 만듭니다. **이 파일과 비밀번호는 저장소에 올리지 말고 안전한 곳에 보관하세요.** 잃어버리면 같은 앱으로 업데이트할 수 없습니다.
- 개발용 키와 배포용 키는 따로 만드세요 (`signingKey.path` 를 바꿔 지정).
- 주소창 없이 전체 화면으로 열리려면 `bubblewrap fingerprint` 로 얻은 `assetlinks.json` 을 서버의 `/.well-known/assetlinks.json` 에 올려야 합니다. (이 기능은 아직 서버에 없습니다 — 남은 작업 참고)

> 이 설정은 작성만 했고, 현재 개발 환경에 Android SDK 가 없어 실제 APK 빌드는 검증하지 못했습니다.
