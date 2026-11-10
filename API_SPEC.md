# 두루보드 자료 제공 규격 (v1, 초안)

두루보드와 연동하려는 서버가 지켜야 할 약속입니다.

## 0. AI 코딩 도우미에게 (작업 지시)

이 문서를 받은 AI 코딩 도우미는 함께 받은 시스템에 '두루보드 자료 제공 기능'을 아래 순서로 추가하십시오. 기존 기능과 화면은 변경하지 마십시오.

**먼저 확인할 것**

- 소스 코드를 보고 사용 기술(언어·프레임워크·자료 저장 방식)을 파악하여 그 방식에 맞게 구현하십시오.
- **구현을 시작하기 전에 반드시 교사에게 어떤 자료를 전송할지 물으십시오.** 답을 받기 전에는 코드를 변경하지 마십시오.
  - 소스 코드에서 전송할 수 있는 자료의 후보(예: 활동지 1~6 제출 여부, 형성평가 점수)를 찾아 목록으로 보여 주고, 교사가 고르게 하십시오.
  - 행을 구분하는 값(예: 학번)도 후보를 제시하여 확인받으십시오. 이 값을 식별 열(`role: "id"`)로 지정하고, 한 행이 그 값 하나(예: 학생 한 명)에 대응하도록 구성합니다.
  - 이름·연락처 등 개인정보는 기본으로 제외하고, 포함할지 교사에게 확인받으십시오.
  - 교사가 요청문에 전송할 자료를 이미 적었더라도, 위 목록으로 한 번 더 확인받으십시오.

**구현할 내용**

1. 요청 받기: 일반 서버는 1장(`GET /api/v1/data`, `Authorization: Bearer` 인증, CORS)을 따릅니다. **Google Apps Script 웹 앱은 3장의 '가. 웹 앱 안에서 열기'를 사용합니다**(인증코드 불필요, 기존 배포 그대로). 이 방식을 쓸 수 없는 경우에만 '나. 인증코드 방식'을 사용합니다.
2. 인증코드(1장·3장 나 방식): 관리자가 발급·폐기할 수 있게 하고, 원문은 저장하지 않고 해시로만 보관합니다. 인증코드마다 응답할 표(범위)를 정할 수 있게 합니다.
3. 응답: 2장 형식(`meta`·`columns`·`rows`)을 따릅니다. 요청 한 번에 표 하나, 값은 숫자·문자·true/false·null만 사용합니다. 제출 여부는 1/0, 점수는 숫자, 미제출·미응시는 null로 표현합니다.
4. 제한과 오류: 응답 20MB·50,000행 이하, 요청이 너무 많으면 429. 오류 응답에 개인정보나 내부 정보를 넣지 않습니다.
5. 연결 안내: 인증코드를 발급하면 4장의 '두루보드 연결 정보'를 한 번 표시합니다. '웹 앱 안에서 열기'는 인증코드가 없으므로, 두루보드를 여는 주소(예: `…/exec?view=duruboard`)와 볼 수 있는 계정 목록을 교사에게 알려 줍니다.

**Apps Script로 구현할 때 코드 제공 방식**

- 두루보드 관련 코드는 **`.gs` 파일 하나**(예: `Duruboard.gs`)에 모두 넣으십시오. 여러 파일로 나누지 않습니다.
- 그 파일의 **전체 코드를 생략 없이** 제공하여, 교사가 [+] → [스크립트]로 새 파일을 만든 뒤 그대로 붙여 넣으면 되게 하십시오.
- 기존 파일의 수정은 최소한으로 하고, 필요한 경우(예: 기존 `doGet`에 두루보드 분기 한 줄 추가) **어느 파일의 어느 함수, 어디에 넣는지**와 넣을 코드를 정확히 적으십시오. `doGet`은 프로젝트에 하나만 있어야 하므로, 기존 `doGet`이 있으면 새 파일에 `doGet`을 만들지 마십시오.
- 기존 `doGet`이 없는 새 프로젝트이면 `doGet`까지 그 한 파일에 넣으십시오.

**완료 후 교사에게 알려 줄 것**

- 변경·추가한 파일 목록
- 시험 방법(일반 서버는 curl 명령)과 실제 응답 예시
- **두루보드 사용 순서**: 교사가 그대로 따라 할 수 있도록 1, 2, 3… 번호를 붙인 단계로 안내하십시오. 각 단계에는 누를 메뉴·버튼 이름과 입력할 값을 이 시스템에 맞는 실제 값(주소, 계정, 함수 이름 등)으로 적고, 전문 용어는 풀어 쓰십시오. 구현한 방식에 맞추어 아래 틀을 따르십시오.

  Apps Script 웹 앱 — 가. 웹 앱 안에서 열기
  1. Apps Script 편집기에서 `DURU_ALLOWED`에 두루보드를 볼 교사 계정이 들어 있는지 확인합니다.
  2. [배포] → [배포 관리] → 기존 웹 앱 배포의 연필 아이콘 → 버전 '새 버전' → [배포]를 누릅니다. (코드를 고친 뒤에는 새 버전으로 배포해야 반영됩니다. 웹 앱 주소는 바뀌지 않습니다.)
  3. 허용한 교사 계정으로 로그인한 브라우저에서 `(실제 웹 앱 주소)?view=duruboard`를 엽니다.
  4. 두루보드 화면에서 [불러오기]를 누릅니다.
  5. 오른쪽 아래 [개체]로 그래프·표·통계를 추가하고, 레이아웃 설정에서 레이아웃을 저장하거나 내보냅니다.
  6. 자주 쓰면 3번 주소를 브라우저 즐겨찾기에 추가합니다.

  일반 서버(1장) 또는 Apps Script 나. 인증코드 방식
  1. 변경한 코드를 서버에 반영(배포)합니다. (반영 방법을 이 시스템 기준으로 구체적으로 적습니다.)
  2. 인증코드를 발급합니다. (실행할 명령 또는 함수와 누를 메뉴를 적습니다.) 화면에 나온 '두루보드 연결 정보'를 따로 기록합니다. 인증코드는 이때 한 번만 보입니다.
  3. 두루보드(`https://duruboard.github.io/`)를 엽니다.
  4. '도메인 또는 웹 앱 주소' 칸과 '인증코드' 칸에 2번에서 기록한 값을 입력하고 [조회]를 누릅니다.
  5. 오른쪽 아래 [개체]로 그래프·표·통계를 추가하고, 레이아웃 설정에서 레이아웃을 저장하거나 내보냅니다.
  6. 인증코드가 유출되었거나 더 이상 쓰지 않으면 폐기합니다. (폐기 방법을 적습니다.)

  마지막에 '문제가 생기면' 항목으로, 자주 나는 오류(권한 없음, 자료가 비어 있음, 연결 실패)와 확인할 점을 짧게 덧붙이십시오.

## 1. 요청

```
GET https://{도메인}/api/v1/data
Authorization: Bearer {인증코드}
Accept: application/json
```

- HTTPS만 허용합니다.
- 조회 전용(GET)입니다.
- 인증코드는 URL에 넣지 않고 `Authorization` 헤더로만 받습니다.
- 인증코드가 없거나 틀리면 401, 권한이 없으면 403, 경로가 없으면 404, 요청이 너무 많으면 429로 응답합니다.
- CORS: 두루보드는 브라우저에서 직접 요청하므로 다음 머리글로 응답합니다. 쿠키를 쓰지 않고 Bearer 인증만 사용하므로 모든 출처를 허용해도 됩니다.
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Headers: Authorization, Accept`
  - `Access-Control-Allow-Methods: GET, OPTIONS` (OPTIONS 사전 요청에는 204로 응답)
- 응답 머리글: `Content-Type: application/json; charset=utf-8`
- **요청 한 번에 표 하나**를 응답합니다. 여러 표를 보여 주려면 서버가 다음 중 하나를 택합니다.
  - 행 단위가 같으면(예: 학생 한 명당 한 행) 열을 붙여 **하나의 표로 병합**합니다.
  - 행 단위가 다르면 **표마다 다른 인증코드**를 발급하고, 인증코드에 따라 해당 표를 응답합니다.

## 2. 응답

```json
{
  "meta": {
    "id": "progress",
    "title": "단원별 진도 현황",
    "source": "시험 서버",
    "updatedAt": "2026-10-18T09:00:00+09:00"
  },
  "columns": [
    { "key": "id", "label": "번호", "type": "string", "role": "id" }
  ],
  "rows": [
    { "id": "S01", "1단원": "완료", "2단원": null },
    { "id": "S02", "1단원": "완료", "2단원": "완료" }
  ]
}
```

### 수록 정보

이 규격은 자료의 형식만 정하며, 특정 정보(이름·학번 등)를 요구하지 않습니다. 응답에 포함할 정보는 자료 제공자(교사)가 결정합니다. 위 예시의 값은 모두 가상의 값입니다.

| 항목 | 필수 | 설명 |
|---|---|---|
| `rows` | 필수 | 행 객체의 배열. 키는 모든 행에서 모아 사용합니다. |
| `columns` | 선택 | 열별 표시 이름(`label`), 자료형(`type`: `number` 수치 / `string` 문자 / `boolean` 논리 / `mixed` 혼합), 식별 열 여부(`role`: `"id"`) |
| `meta` | 선택 | `id`(표 구분 이름), `title`(제목), `source`(출처), `updatedAt`(기준 시각) |

레이아웃(그래프·표·통계 구성)은 응답에 넣지 않습니다. 교사가 두루보드에서 직접 구성하며, 구성은 교사의 브라우저에 저장되고 [레이아웃 내보내기]·[레이아웃 불러오기]로 다른 교사와 나눌 수 있습니다. 응답에 `layout`이 있어도 두루보드는 사용하지 않습니다.


## 3. Apps Script 연결 방식 (Google Apps Script 웹 앱)

Google Apps Script 웹 앱은 요청 머리글(`Authorization`)을 읽을 수 없고, 상태 코드와 사전 요청(OPTIONS)을 직접 정할 수 없습니다. 그래서 아래 두 방식 중 하나를 사용합니다. **가 방식을 권장합니다.**

| | 가. 웹 앱 안에서 열기 (권장) | 나. 인증코드 방식 |
|---|---|---|
| 배포 | 기존 배포 그대로 (학교 도메인 가능) | 두루보드용 '모든 사용자' 배포 추가 |
| 확인 방법 | 학교 계정 로그인 + 허용 계정 목록 | 인증코드 |
| 교사가 여는 주소 | 웹 앱 주소 + `?view=duruboard` | 두루보드 주소에 웹 앱 주소·인증코드 입력 |

### 가. 웹 앱 안에서 열기 (권장)

웹 앱이 GitHub에 게시된 두루보드 화면을 불러와 자기 화면으로 보여 줍니다. 두루보드는 이 경우를 스스로 알아채고(`google.script.run` 존재), 주소·인증코드 입력 없이 [불러오기]를 누르면 웹 앱의 `duruboardData()` 함수를 호출하여 자료를 받습니다. 다른 사이트로 요청하지 않으므로 학교 계정 로그인이 그대로 적용됩니다.

- 두루보드 게시 주소: `https://duruboard.github.io/` (`index.html`, `app.js`, `style.css`, `vendor/chart.umd.js`)
- 웹 앱이 제공할 것
  1. `doGet`: `view=duruboard`이면 허용 계정인지 확인한 뒤 두루보드 화면을 응답합니다. 그 밖의 요청은 기존 화면을 그대로 응답합니다.
  - 위 코드는 `.gs` 파일 하나(예: `Duruboard.gs`)에 모두 넣습니다(0장 '코드 제공 방식' 참고).
  2. `duruboardData()`: 허용 계정인지 다시 확인한 뒤 2장 형식의 자료를 **JSON 문자열**로 돌려줍니다. 오류는 예외(`throw new Error('…')`)로 알립니다.
- 허용 계정: 자료를 볼 교사 계정을 목록으로 정합니다(학생 계정은 자료를 받을 수 없어야 합니다). `Session.getActiveUser().getEmail()`로 확인합니다.
- 배포는 바꾸지 않습니다. 실행 계정 '나', 액세스는 기존대로(예: 학교 도메인) 둡니다.

```javascript
const DURU_BASE = 'https://duruboard.github.io/';
const DURU_ALLOWED = ['teacher@school.kr'];   // 두루보드를 볼 수 있는 계정

function doGet(e) {
  if (e && e.parameter && e.parameter.view === 'duruboard') return duruboardPage();
  return 기존화면(e);                            // 기존 doGet 내용
}

function duruboardPage() {
  if (!duruAllowed()) return HtmlService.createHtmlOutput('두루보드를 볼 권한이 없습니다. 허용된 교사 계정으로 접속하십시오.');
  let html = UrlFetchApp.fetch(DURU_BASE + 'index.html').getContentText('UTF-8');
  html = html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '')      // 웹 앱 화면 안에서 실행되도록 제거
    .replace(/(src|href)="(?!https?:|data:|#)([^"]+)"/g, (m, a, p) => a + '="' + DURU_BASE + p + '"');
  return HtmlService.createHtmlOutput(html)
    .setTitle('두루보드')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function duruboardData() {
  if (!duruAllowed()) throw new Error('두루보드를 볼 권한이 없습니다.');
  return JSON.stringify({
    meta: { id: 'progress', title: '활동지 제출 현황', updatedAt: new Date().toISOString() },
    columns: [ /* 2장 형식 */ ],
    rows: getRows()                                // 교사가 고른 자료만
  });
}

function duruAllowed() {
  return DURU_ALLOWED.indexOf(Session.getActiveUser().getEmail()) >= 0;
}
```

- 교사는 웹 앱 주소 뒤에 `?view=duruboard`를 붙여 열면 됩니다(예: `https://script.google.com/a/macros/school.kr/s/…/exec?view=duruboard`). 구현이 끝나면 이 주소와 허용 계정 목록을 교사에게 알려 줍니다.
- 개인 Gmail 계정 등에서 `Session.getActiveUser().getEmail()`이 비어 있으면 권한 확인을 할 수 없으므로, 그 경우 교사에게 알리고 나 방식을 사용합니다.
- 레이아웃 파일 내려받기 등 일부 기능은 웹 앱 화면의 보안 제한으로 동작하지 않을 수 있습니다.

### 나. 인증코드 방식

가 방식을 쓸 수 없을 때(예: 웹 앱에서 접속 계정을 확인할 수 없는 경우) 사용합니다. 교사가 두루보드 주소 칸에 웹 앱 주소(`…/exec`)를 입력하면 두루보드가 이 방식으로 요청합니다. 응답 자료의 형식(2장)은 같습니다.

#### 요청

```
POST https://script.google.com/macros/s/{배포 ID}/exec
Content-Type: text/plain;charset=utf-8

{"code":"{인증코드}","api":"duruboard/v1"}
```

- 교사는 두루보드의 주소 칸에 **웹 앱 주소 전체**(`…/exec`)를 입력합니다. 주소 뒤에 다른 경로를 붙이지 않습니다.
- 인증코드는 주소(쿼리)가 아니라 **요청 본문**으로 보냅니다.
- `Content-Type: text/plain`이므로 사전 요청(OPTIONS)이 발생하지 않습니다.
- Apps Script는 응답을 `script.googleusercontent.com`을 거쳐 전달합니다. 두루보드는 이 주소로의 전달만 허용합니다.

#### 응답

- 정상: 2장과 같은 `{ "meta": …, "columns": …, "rows": … }`
- 오류: 상태 코드 대신 본문에 표시합니다.

```json
{ "error": { "status": 401, "message": "인증코드가 유효하지 않습니다." } }
```

| status | 의미 |
|---|---|
| 401 | 인증코드가 없거나 틀림 |
| 403 | 권한 없음 |
| 429 | 요청이 너무 많음 |
| 500 | 서버 오류 |

#### 구현 예시 (Apps Script)

```javascript
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (!isValidCode(body.code)) return json({ error: { status: 401, message: '인증코드가 유효하지 않습니다.' } });
  return json({ meta: { id: 'progress', title: '활동지 제출 현황' }, columns: [ /* … */ ], rows: getRows() });
}
function doGet() { return json({ error: { status: 405, message: '두루보드에서 POST로 요청하십시오.' } }); }
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
```

- 인증코드는 스크립트 속성(`PropertiesService`)에 해시(`Utilities.computeDigest`)로 저장합니다. 발급 시 연결 안내는 4장을 따릅니다.
- 배포: [배포] → [새 배포] → 유형 '웹 앱', 실행 계정 '나', 액세스 권한 '모든 사용자'. 인증코드가 없으면 자료를 응답하지 않으므로 자료는 보호됩니다.
- 학교(Google Workspace) 계정에서 '모든 사용자' 배포가 막혀 있으면 두루보드에서 연결할 수 없습니다. 이 경우 관리자에게 문의하십시오.

#### 기존 Apps Script 프로젝트에 추가하는 경우

학생용 웹 앱처럼 이미 학교 도메인으로 배포된 프로젝트에 추가할 때는, 교사의 수고를 줄이기 위해 **같은 프로젝트에 배포를 하나 더 만드는 방식**을 사용합니다.

- 기존 배포(학교 도메인)는 변경하지 않습니다. 두루보드용으로 새 배포(액세스 '모든 사용자')를 하나 추가합니다.
- 두 배포는 같은 코드를 쓰므로, 두루보드용 주소로 기존 화면이 열리지 않게 막습니다.
  - `doGet` 첫머리에서 `Session.getActiveUser().getEmail()`이 비어 있거나 학교 도메인이 아니면 기존 화면 대신 "학교 계정으로 접속하십시오" 안내만 응답합니다.
  - 기존 `doPost`가 있으면, 본문의 `api`가 `"duruboard/v1"`일 때만 두루보드 응답으로 보내고 나머지는 기존 처리를 그대로 따릅니다. 기존 처리에도 위와 같은 학교 계정 확인을 넣습니다.
- 인증코드가 틀린 요청이 짧은 시간에 반복되면(예: 10분에 10회) `CacheService`로 기록하여 잠시 `{"error":{"status":429}}`로 거부합니다.
- 교사가 할 일은 [배포] → [새 배포] → 웹 앱, 액세스 '모든 사용자'로 배포하고, 발급 함수를 한 번 실행하는 것뿐이 되도록 구현합니다.

## 4. 인증코드 발급과 연결 안내 (1장·3장 나 방식)

자료 제공 측은 인증코드를 발급할 때, 교사가 두루보드에 그대로 입력할 수 있도록 연결 정보를 **한 번만** 표시합니다. 인증코드 원문은 저장하지 않고 해시로만 보관하므로 다시 보여 줄 수 없습니다.

```
===== 두루보드 연결 정보 =====
도메인 또는 웹 앱 주소: data.school.kr
인증코드: dur_8Kq3…(발급 값)
표: 활동지 제출 현황
==============================
```

- 일반 서버: 관리 화면이나 명령 출력에 표시합니다. 주소 칸에는 도메인을 표시합니다(`/api/v1/data`는 두루보드가 붙입니다).
- Apps Script: 발급 함수(예: `issueCode()`)를 편집기에서 실행하면 실행 로그(`Logger.log`)에 표시합니다. 웹 앱 주소는 `ScriptApp.getService().getUrl()`로 얻되, 배포 전이거나 `…/dev` 주소이면 "[배포] → [배포 관리]의 웹 앱 URL(…/exec)을 입력하십시오"라고 안내합니다.
