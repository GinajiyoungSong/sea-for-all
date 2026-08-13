/**
 * ============================================================
 *  제주 오션맵 - 통합 API 프록시 (doGet)
 * ============================================================
 *  이 파일 하나가 프론트엔드(오션맵)의 모든 외부 API 요청을 중계합니다.
 *  브라우저는 외부 정부 API를 직접 못 부르기 때문에(CORS), 여기를 거칩니다.
 *
 *  처리하는 요청 6가지:
 *   1) ?action=warning                 → 기상특보 현황
 *   2) ?action=typhoon                 → 태풍정보
 *   3) ?obsCode=DT_0004&date=20260811  → 오늘의 물때(고·저조 예보)
 *   4) ?action=obs&obsCode=DT_0004     → 실시간 관측(수온·유속·유향·조위)
 *   5) ?action=astro&date=20260812     → 일출/일몰/월출/월몰 (한국천문연구원)
 *   6) ?action=mulddae&date=20260812   → 오늘의 "몇물"(물때 번호)
 *
 *  ※ 파고·풍속·파주기는 프론트가 Open-Meteo에서 직접 받으므로 여기서 처리 안 함.
 *  ※ 수온은 예전에 해수욕장 API(KMA허브)를 쓰려 했으나, 조위관측소(obs)가
 *     수온을 주므로 해수욕장 API는 제거함. 이제 필요한 키는 아래 1개뿐.
 *
 *  ⚠️ 인증키는 코드에 직접 쓰지 말 것.
 *     Apps Script 편집기 → 좌측 '프로젝트 설정(톱니바퀴)' → '스크립트 속성'
 *     아래 1개 키를 등록하세요:
 *       - DATA_GO_KR_KEY : 공공데이터포털 인증키 (특보·태풍·물때·관측·천문 공용)
 *                          값: d273b665e9fd...(디코딩 원본, 특수문자 없는 64자)
 *
 *  ⚠️ 5),6)번(천문연 API)은 공공데이터포털에서 "한국천문연구원_특일 정보" /
 *     "한국천문연구원_출몰시각 정보" 서비스를 별도로 활용신청해야 합니다
 *     (승인되면 기존 DATA_GO_KR_KEY 그대로 같이 씁니다).
 *     - 출몰시각정보는 getAreaRiseSetInfo(지역코드 방식)가 아니라
 *       getLCRiseSetInfo(위도·경도 직접 입력 방식)를 사용합니다 - 지역코드를
 *       추측할 필요 없이 제주 좌표를 그대로 넣으면 됩니다.
 *     - 음력 정보(getLunCalInfo)도 같이 활용신청 필요.
 * ============================================================
 */

// ---- 인증키 읽기 ----
function getDataGoKrKey() {
  return PropertiesService.getScriptProperties().getProperty('DATA_GO_KR_KEY');
}

// ============================================================
//  메인 진입점
// ============================================================
function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var action = p.action || '';

  try {
    // 1) 기상특보 현황
    if (action === 'warning') {
      return jsonOut(handleWarning());
    }
    // 2) 태풍정보
    if (action === 'typhoon') {
      return jsonOut(handleTyphoon());
    }
    // 4) 실시간 관측 (수온·유속·유향·조위)
    if (action === 'obs') {
      return jsonOut(handleObs(p.obsCode));
    }
    // 5) 일출/일몰/월출/월몰
    if (action === 'astro') {
      return jsonOut(handleAstro(p.date));
    }
    // 6) 오늘의 몇물(물때 번호)
    if (action === 'mulddae') {
      return jsonOut(handleMulddae(p.date));
    }
    // 3) 물때(고·저조 예보) — action 없이 obsCode로 들어옴 (프론트 기존 호출 방식 유지)
    if (p.obsCode) {
      return jsonOut(handleTide(p.obsCode, p.date));
    }

    return jsonOut({ error: 'unknown_request', hint: 'action 또는 obsCode 파라미터가 필요합니다.' });
  } catch (err) {
    return jsonOut({ error: 'proxy_exception', message: String(err) });
  }
}

// ---- 응답 헬퍼 ----
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 공공데이터포털은 발급 시 이미 URL 인코딩된 키(%2B 등 포함)를 줍니다.
// UrlFetchApp에 그대로 넣으면 이중 인코딩되어 실패할 수 있어, 원본(decoded)을 저장하고
// 여기서 encodeURIComponent로 한 번만 인코딩합니다.
function encKey() {
  return encodeURIComponent(getDataGoKrKey());
}

// ============================================================
//  1) 기상특보 현황 (getPwnStatus)
//     지점코드 없이 전국 특보를 t6 필드에 텍스트로 통째로 줌
// ============================================================
function handleWarning() {
  var url = 'https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus'
    + '?serviceKey=' + encKey()
    + '&numOfRows=10&pageNo=1&dataType=JSON';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return JSON.parse(res.getContentText());
}

// ============================================================
//  2) 태풍정보 (getTyphoonInfo)
//     fromTmFc/toTmFc(통보문 발표시각) 필수 → 오늘 날짜로 자동 세팅
//     ⚠️ 기상청은 활동 중인 태풍마다 하루에도 여러 번(3시간 간격 등) 통보를 발표합니다.
//        같은 태풍(typSeq)의 과거 통보가 그대로 다 쌓여서 나오는 걸 방지하기 위해,
//        태풍번호별로 가장 최신 발표시각(tmFc)의 통보 1건만 남기고 나머지는 제거합니다.
// ============================================================
function handleTyphoon() {
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var url = 'https://apis.data.go.kr/1360000/TyphoonInfoService/getTyphoonInfo'
    + '?serviceKey=' + encKey()
    + '&numOfRows=30&pageNo=1&dataType=JSON'  // [수정] 10 -> 30: 중복 제거 전에 그날의 통보를 충분히 확보
    + '&fromTmFc=' + today + '&toTmFc=' + today;
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());

  try {
    var items = json && json.response && json.response.body && json.response.body.items && json.response.body.items.item;
    if (items) {
      if (!Array.isArray(items)) items = [items];

      // 태풍번호(typSeq)별로 발표시각(tmFc)이 가장 최신인 것 1건만 남김
      var latestByTyp = {};
      items.forEach(function (it) {
        var seq = it.typSeq;
        if (!seq) return;
        var existing = latestByTyp[seq];
        // tmFc는 보통 "YYYYMMDDHHmm" 형태 문자열이라 문자열 비교로도 최신 판별 가능
        if (!existing || String(it.tmFc) > String(existing.tmFc)) {
          latestByTyp[seq] = it;
        }
      });
      json.response.body.items.item = Object.keys(latestByTyp).map(function (k) { return latestByTyp[k]; });
    }
  } catch (e) {
    // 응답 구조가 예상과 다르면 원본 그대로 반환 (안전한 폴백 - 화면이 아예 깨지는 것보다 나음)
    Logger.log('[handleTyphoon] 중복 제거 실패, 원본 반환: ' + e);
  }

  return json;
}

// ============================================================
//  4) 실시간 관측 데이터 (GetDTRecentApiService)
//     수온(wtem)·유향(crdir)·유속(crsp)·조위(bscTdlvHgt)·풍속(wspd) 등
//     → 프론트가 쓰기 쉽게 핵심 값 + 유향 8방위 + 좌표를 정리해서 반환
// ============================================================
function handleObs(obsCode) {
  if (!obsCode) obsCode = 'DT_0004';
  var url = 'https://apis.data.go.kr/1192136/dtRecent/GetDTRecentApiService'
    + '?serviceKey=' + encKey()
    + '&obsCode=' + encodeURIComponent(obsCode)
    + '&numOfRows=1&pageNo=1&min=60&type=json';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());

  // item 꺼내기 (구조 방어적 처리)
  var items = null;
  if (json && json.response && json.response.body && json.response.body.items) {
    items = json.response.body.items.item || json.response.body.items;
  } else if (json && json.body && json.body.items) {
    items = json.body.items.item || json.body.items;
  }
  if (items && !Array.isArray(items)) items = [items];

  if (!items || items.length === 0) {
    // 데이터 없음 - 원본을 그대로 넘겨서 프론트에서 원인 확인 가능하게
    return { ok: false, raw: json };
  }

  var it = items[0];
  var crdir = toNum(it.crdir);   // 유향(deg)
  var crsp = toNum(it.crsp);     // 유속(원단위: 문서상 m/s인데 실측은 cm/s 의심)

  return {
    ok: true,
    obsName: it.obsvtrNm || '',              // 관측소명
    lat: toNum(it.lat),                       // 관측소 위도
    lot: toNum(it.lot),                       // 관측소 경도
    obsTime: it.obsrvnDt || '',               // 관측일시
    waterTemp: toNum(it.wtem),                // 수온(℃)
    currentDir: crdir,                        // 유향(deg, 숫자)
    currentDir8: deg2dir8(crdir),             // 유향 8방위(한글): 예 "남서"
    currentSpeed: crsp,                       // 유속(원값)
    windSpeed: toNum(it.wspd),                // 풍속(m/s)
    tideLevel: toNum(it.bscTdlvHgt),          // 현재 조위(cm)
    salinity: toNum(it.slntQty)               // 염분(psu)
  };
}

// 숫자 변환 (빈값/문자 방어)
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 각도(deg) → 8방위 한글. null이면 null 반환.
//  북 N(0/360) 기준 시계방향: 북·북동·동·남동·남·남서·서·북서
function deg2dir8(deg) {
  if (deg === null) return null;
  var dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  var idx = Math.round((deg % 360) / 45) % 8;
  return dirs[idx];
}

// ============================================================
//  3) 물때 — 조석예보(고·저조) (GetTideFcstHghLwApiService)
//     실제 응답(predcDt/predcTdlvVl/extrSe)을,
//     프론트가 기대하는 형태(obsrvnDt/tdlvHgt/hl_code)로 변환해서 돌려줌
//     → 프론트 코드를 거의 손대지 않아도 됨
// ============================================================
function handleTide(obsCode, date) {
  var reqDate = date || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  var url = 'https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService'
    + '?serviceKey=' + encKey()
    + '&obsCode=' + encodeURIComponent(obsCode)
    + '&reqDate=' + reqDate
    + '&numOfRows=100&pageNo=1&type=json';

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());

  // 응답에서 item 목록 꺼내기 (구조가 여러 형태일 수 있어 방어적으로)
  var items = null;
  if (json && json.response && json.response.body && json.response.body.items) {
    items = json.response.body.items.item || json.response.body.items;
  } else if (json && json.body && json.body.items) {
    items = json.body.items.item || json.body.items;
  }
  if (items && !Array.isArray(items)) items = [items];
  if (!items) items = [];

  // 프론트가 쓰기 쉬운 형태로 변환
  //  extrSe: 1=오전고조 2=오전저조 3=오후고조 4=오후저조
  var converted = items.map(function (it) {
    var code = String(it.extrSe || '');
    var isHigh = (code === '1' || code === '3'); // 고조
    return {
      obsrvnDt: it.predcDt || '',        // 예: "2026-08-11 05:25"
      tdlvHgt: it.predcTdlvVl,           // 조위(cm)
      hl_code: isHigh ? 'high' : 'low',  // 고조/저조 구분
      hl_label: isHigh ? '고조 (만조)' : '저조 (간조)'
    };
  });

  // 프론트가 기존에 파싱하던 구조와 호환되도록 body.items.item 형태로 감싸서 반환
  return {
    body: {
      items: {
        item: converted
      }
    }
  };
}

// ============================================================
//  5) 일출/일몰/월출/월몰 (한국천문연구원 - 출몰시각정보, getLCRiseSetInfo)
//     "지역별(getAreaRiseSetInfo)" 대신 "위치별(getLCRiseSetInfo)"을 사용합니다.
//     이 오퍼레이션은 불확실한 지역코드 대신 위도/경도를 직접 받기 때문에
//     제주 좌표를 그대로 넣으면 됩니다 (dnYn=Y → 소수점 좌표 그대로 사용).
//     응답 시각 필드(sunrise 등)는 "HHMMSS" 6자리 문자열로 옵니다.
// ============================================================
function handleAstro(date) {
  var reqDate = date || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
  // 제주시청 부근 좌표 - 필요하면 관측 지점(예: 마커 좌표)에 맞게 조정 가능
  var lat = 33.4996;
  var lon = 126.5312;

  var url = 'https://apis.data.go.kr/B090041/openapi/service/RiseSetInfoService/getLCRiseSetInfo'
    + '?serviceKey=' + encKey()
    + '&locdate=' + reqDate
    + '&longitude=' + lon
    + '&latitude=' + lat
    + '&dnYn=Y'
    + '&numOfRows=10&pageNo=1&dataType=JSON';

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());
  Logger.log('[astro raw] ' + res.getContentText());

  var items = null;
  if (json && json.response && json.response.body && json.response.body.items) {
    items = json.response.body.items.item || json.response.body.items;
  }
  if (items && !Array.isArray(items)) items = [items];
  if (!items || items.length === 0) return { ok: false, raw: json };

  var it = items[0];

  // 응답 시각 형식은 "HHMMSS" 6자리 문자열(예: "055906") - 화면 표시용으로 HH:mm 변환
  var fmt = function (v) {
    if (v === undefined || v === null || v === '') return '-';
    var s = String(v).replace(/[^0-9]/g, '');
    if (s.length < 4) return '-';
    return s.substring(0, 2) + ':' + s.substring(2, 4);
  };

  return {
    ok: true,
    location: it.location || '',
    sunrise: fmt(it.sunrise),
    sunset: fmt(it.sunset),
    moonrise: fmt(it.moonrise),
    moonset: fmt(it.moonset)
  };
}

// ============================================================
//  6) 오늘의 "몇물"(물때 번호)
//     한국천문연구원 음력 변환(getLunCalInfo)으로 오늘의 음력 날짜를 구한 뒤,
//     15일 주기 물때 조견표로 변환합니다.
//     ⚠️ 물때 조견표는 서해/남해/동해 등 지역마다 하루이틀 오차가 날 수 있습니다.
//        제주 실측(예: 수협·낚시 앱)과 비교해서 필요하면 calcMulddae()의
//        보정값(+7 부분)만 조정하면 됩니다.
// ============================================================
function handleMulddae(date) {
  var reqDate = date || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');

  var url = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getLunCalInfo'
    + '?serviceKey=' + encKey()
    + '&solYear=' + reqDate.substring(0, 4)
    + '&solMonth=' + reqDate.substring(4, 6)
    + '&solDay=' + reqDate.substring(6, 8)
    + '&numOfRows=10&pageNo=1&dataType=JSON';

  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var json = JSON.parse(res.getContentText());
  Logger.log('[mulddae raw] ' + res.getContentText());

  var items = null;
  if (json && json.response && json.response.body && json.response.body.items) {
    items = json.response.body.items.item || json.response.body.items;
  }
  if (items && !Array.isArray(items)) items = [items];
  if (!items || items.length === 0) return { ok: false, raw: json };

  var lunDay = parseInt(items[0].lunDay, 10); // 음력 일(1~30)
  if (isNaN(lunDay)) return { ok: false, raw: json };

  return { ok: true, lunDay: lunDay, mulddae: calcMulddae(lunDay) };
}

// 음력 일자(1~30) -> 물때 번호(조금/1물~14물)로 변환하는 15일 주기 조견표
function calcMulddae(lunDay) {
  var table = ['조금', '1물', '2물', '3물', '4물', '5물', '6물', '7물', '8물', '9물', '10물', '11물', '12물', '13물', '14물'];
  // 음력 1일·16일을 "7물" 자리로 맞추는 보정 (표준 서해 조견표 기준)
  var idx = ((lunDay - 1) + 7) % 15;
  return table[idx];
}

// ============================================================
//  [테스트용] 편집기에서 직접 실행해 응답을 로그로 확인
//  각 함수를 선택 후 실행(▶) → '실행 로그'에서 결과 확인
// ============================================================
function TEST_warning()  { Logger.log(JSON.stringify(handleWarning())); }
function TEST_typhoon()  { Logger.log(JSON.stringify(handleTyphoon())); }
function TEST_obs() {
  ['DT_0004','DT_0010','DT_0022','DT_0023'].forEach(function(code){
    var r = handleObs(code);
    Logger.log(code + ' → ' + JSON.stringify(r));
  });
}
function TEST_tide()     { Logger.log(JSON.stringify(handleTide('DT_0004', null))); }
function TEST_astro()    { Logger.log(JSON.stringify(handleAstro(null))); }
function TEST_mulddae()  { Logger.log(JSON.stringify(handleMulddae(null))); }
