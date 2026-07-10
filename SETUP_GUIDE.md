# 체험단 대시보드 — 설정 가이드

구성:
- `index.html` → GitHub Pages에 올리는 화면 (정적 파일 하나)
- `worker/` → Cloudflare Worker (네이버 로그인 처리 + 구글 드라이브 저장/조회 대신 해주는 아주 작은 백엔드)

왜 Worker가 필요한가? 네이버 로그인은 Client Secret이 필요한데, 이건 절대 index.html 같은 정적 파일에 넣으면 안 됩니다(그 순간 전 세계에 공개됨). 그래서 이 비밀값들은 Worker 안, 즉 서버 쪽에만 보관합니다. 구글 드라이브 저장도 마찬가지 이유로 Worker를 거칩니다.

---

## 0. GitHub 토큰 재발급 (아직 안 하셨다면)
채팅에 붙여넣으셨던 기존 PAT는 이미 revoke 하셨어야 해요. 새 토큰이 필요하면 GitHub → Settings → Developer settings → Fine-grained tokens 에서 새로 만들고, **절대 코드나 채팅에 직접 붙여넣지 말고** 나중에 GitHub Desktop이나 git credential manager에만 입력하세요.

---

## 1. GitHub Pages에 index.html 올리기

1. 저장소 `001_RCD_Review-Campaign-Dashboard`를 로컬에 clone 하거나, GitHub 웹에서 "Add file → Upload files"로 `index.html`을 루트에 업로드합니다.
2. 저장소 Settings → Pages → Source를 "Deploy from a branch" → `main` / `/(root)`로 설정합니다.
3. 몇 분 후 `https://<계정>.github.io/001_RCD_Review-Campaign-Dashboard/` 로 접속됩니다. **이 정확한 주소를 아래 단계들에서 계속 사용**하니 메모해두세요.

---

## 2. 네이버 로그인 애플리케이션 등록

1. https://developers.naver.com/apps/#/register 접속 (네이버 계정 로그인 필요)
2. 애플리케이션 이름: 예) 체험단 대시보드
3. 사용 API: **네이버 로그인** 선택
4. 제공 정보 선택: 이름, 이메일 (필요한 만큼만)
5. 로그인 오픈 API 서비스 환경: **웹 서비스** 선택
6. 서비스 URL: 1단계에서 확인한 GitHub Pages 주소 (예: `https://jimmy-jib-dev.github.io`)
7. 네이버 로그인 Callback URL: **GitHub Pages 주소와 완전히 동일하게** (예: `https://jimmy-jib-dev.github.io/001_RCD_Review-Campaign-Dashboard/`)
8. 등록 완료 후 **Client ID / Client Secret**을 복사해두세요. (Secret은 이후 Worker에만 넣고 버립니다)

> 참고: 처음엔 "개발중" 상태로 본인 계정으로는 바로 테스트 가능합니다. 여자친구분 본인만 쓰는 앱이면 검수 없이도 계속 써도 무방해요.

---

## 3. 구글 드라이브 전용 계정 준비

방금 결정하신 대로 **새 구글 계정을 하나 만들어서** 그 계정의 드라이브를 저장소로 씁니다.

1. 새 구글 계정 생성 (예: `stk-experience-dashboard@gmail.com` 같은 전용 계정)
2. https://console.cloud.google.com 접속 → 방금 만든 계정으로 로그인
3. 새 프로젝트 생성 (이름 예: `rcd-dashboard`)
4. 좌측 메뉴 → APIs & Services → Library → **Google Drive API** 검색 후 **Enable**
5. APIs & Services → OAuth consent screen
   - User Type: External
   - 앱 이름, 이메일 등 최소 정보만 입력하고 저장 (Publishing status는 "Testing"으로 둬도 됩니다)
   - Test users에 방금 만든 전용 구글 계정 이메일 추가
6. APIs & Services → Credentials → **Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - 이름 아무거나 입력 후 생성 → **Client ID / Client Secret** 복사

### refresh token 발급받기 (딱 한 번만 하면 됨)

가장 쉬운 방법은 Google OAuth Playground를 쓰는 겁니다:

1. https://developers.google.com/oauthplayground 접속
2. 오른쪽 위 톱니바퀴(⚙) 클릭 → **Use your own OAuth credentials** 체크 → 위에서 만든 Client ID / Client Secret 입력
3. 왼쪽에서 **Drive API v3** → `https://www.googleapis.com/auth/drive.file` 스코프 선택 → **Authorize APIs**
4. 팝업에서 **전용 구글 계정으로 로그인**하고 권한 허용
5. **Exchange authorization code for tokens** 클릭
6. 화면에 나온 **Refresh token** 값을 복사해둡니다 (이게 Worker의 `GOOGLE_REFRESH_TOKEN`)

---

## 4. Cloudflare Worker 배포

1. https://dash.cloudflare.com 무료 가입 (또는 로그인)
2. 로컬 컴�터에서 (Node.js 필요):
   ```bash
   npm install -g wrangler
   wrangler login
   ```
3. 이 프로젝트의 `worker/` 폴더로 이동:
   ```bash
   cd worker
   ```
4. `wrangler.toml`의 `ALLOWED_ORIGIN` 값을 실제 GitHub Pages 주소로 수정 (마지막 슬래시 없이, 예: `https://jimmy-jib-dev.github.io`)
5. Secrets 등록 (하나씩 실행하면 값을 입력하라고 물어봅니다):
   ```bash
   wrangler secret put NAVER_CLIENT_ID
   wrangler secret put NAVER_CLIENT_SECRET
   wrangler secret put SESSION_SECRET        # 아무 긴 랜덤 문자열 (예: openssl rand -hex 32 결과)
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put GOOGLE_REFRESH_TOKEN
   ```
6. 배포:
   ```bash
   wrangler deploy
   ```
7. 배포가 끝나면 `https://rcd-dashboard-worker.<본인-서브도메인>.workers.dev` 같은 주소가 출력됩니다. 이 주소를 복사하세요.

---

## 5. index.html에 Worker 주소 연결

`index.html` 안에서 아래 줄을 찾아 방금 복사한 Worker 주소로 바꿔주세요:

```js
const WORKER_BASE = "https://REPLACE-WITH-YOUR-WORKER.workers.dev";
```

수정 후 다시 GitHub에 커밋 & 푸시하면 GitHub Pages가 자동으로 반영합니다 (1~2분 소요).

---

## 6. 테스트

1. GitHub Pages 주소로 접속
2. "네이버로 로그인" 클릭 → 네이버 로그인 화면으로 이동 → 로그인 및 동의
3. 대시보드로 돌아오면 성공. "+ 캠페인 추가"로 테스트 캠페인을 하나 등록해보고, 새로고침해도 데이터가 남아있는지 확인하세요 (구글 드라이브에 저장된 겁니다).
4. 전용 구글 계정 드라이브에 들어가 보면 `rcd_campaigns.json` 파일이 생성되어 있을 거예요.

---

## 문제가 생기면

- **로그인 후 바로 로그아웃되거나 401 에러** → `SESSION_SECRET`이 Worker에 정상 등록됐는지, `ALLOWED_ORIGIN`이 실제 주소와 정확히 일치하는지 확인
- **네이버 로그인 화면에서 "잘못된 요청" 에러** → 네이버 개발자센터에 등록한 Callback URL과 index.html이 실제로 열리는 주소가 한 글자도 다르지 않은지 확인 (슬래시 유무 포함)
- **데이터 저장이 안 됨** → `wrangler tail` 명령으로 Worker 로그를 실시간으로 보면서 어떤 에러인지 확인 가능
- **CORS 에러가 콘솔에 뜸** → `wrangler.toml`의 `ALLOWED_ORIGIN`을 고치고 `wrangler deploy` 재실행
