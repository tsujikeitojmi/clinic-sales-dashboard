/**********************************************************************
 * 3院売上集計ダッシュボード — Code.gs
 *  - medical-force API から会計実績を取得し、施術カテゴリ別に集計
 *  - HtmlService(index.html) でダッシュボード表示
 *
 *  集計ロジックは引き継ぎ資料「集計コア」を検証済みのまま移植（変更しない）:
 *   売上 = 契約額(courseContractAmount) + 単発genuine / 消化は除外 / 按分なし
 *   件数 = 同会計 × 同(カテゴリ,種別) = 1件
 *   daily-accounts は 1日ずつ取得（31日制約回避）
 *   カテゴリ名寄せは 施術マスタ(optionId → カテゴリ + 種別)
 *
 *  Script Properties に設定が必要:
 *   SPREADSHEET_ID
 *   CLINIC1_CLIENT_ID / CLINIC1_CLIENT_SECRET / CLINIC1_CLINIC_ID   (心斎橋)
 *   CLINIC2_CLIENT_ID / CLINIC2_CLIENT_SECRET / CLINIC2_CLINIC_ID   (新宿)
 *   CLINIC3_CLIENT_ID / CLINIC3_CLIENT_SECRET / CLINIC3_CLINIC_ID   (福岡)
 **********************************************************************/

const API_BASE_NEW = 'https://api.medical-force.com';
const CLINIC_LIST = [
  { key:'CLINIC1', name:'心斎橋' },
  { key:'CLINIC2', name:'新宿'   },
  { key:'CLINIC3', name:'福岡'   },
  // 将来: { key:'CLINIC4', name:'名古屋' },
];
const TYPES_NEW = ['通常','CP','媒体'];

const MASTER_SHEET = '施術マスタ';   // optionId | API名 | APIカテゴリ | 集計カテゴリ | 種別
const CACHE_SHEET  = '集計キャッシュ'; // clinicKey | year | month | json | updatedAt
const UNCLASSIFIED = '★未分類';

/* ============================ エントリ ============================ */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('3院売上集計ダッシュボード')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** index.html 内で <?!= include('...') ?> したい場合用 */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ============================ 設定/認証 ============================ */

function getProps_() {
  return PropertiesService.getScriptProperties();
}

function getSpreadsheet_() {
  const id = getProps_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Script Properties に SPREADSHEET_ID がありません');
  return SpreadsheetApp.openById(id);
}

/** key='CLINIC1' などから認証情報込みの院オブジェクトを作る */
function getClinic_(key) {
  const base = CLINIC_LIST.find(c => c.key === key);
  if (!base) throw new Error('未知の院: ' + key);
  const p = getProps_();
  return {
    key: base.key,
    name: base.name,
    clientId:     p.getProperty(key + '_CLIENT_ID'),
    clientSecret: p.getProperty(key + '_CLIENT_SECRET'),
    clinicId:     p.getProperty(key + '_CLINIC_ID'),
  };
}

function getTokenNew(id, secret){
  const res = UrlFetchApp.fetch(`${API_BASE_NEW}/token`, {
    method:'POST', contentType:'application/json',
    payload: JSON.stringify({ client_id:id, client_secret:secret }), muteHttpExceptions:true });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('トークン取得失敗: ' + res.getContentText());
  return j.access_token;
}

/* ====================== 取得（1日ずつ・検証済み） ====================== */

function fetchClinicMonth(clinic, year, month){
  const token = getTokenNew(clinic.clientId, clinic.clientSecret);
  const first = new Date(year, month-1, 1);
  const today = new Date();
  const isCur = (year===today.getFullYear() && month===today.getMonth()+1);
  const last  = isCur ? today : new Date(year, month, 0);
  const values = [];
  let cur = new Date(first);
  while (cur <= last){
    const d = Utilities.formatDate(cur,'Asia/Tokyo','yyyy-MM-dd');
    const res = UrlFetchApp.fetch(
      `${API_BASE_NEW}/developer/daily-accounts?epoch_from=${d}&epoch_to=${d}`,
      { method:'GET', headers:{ 'Authorization':`Bearer ${token}`, 'clinic_id':clinic.clinicId }, muteHttpExceptions:true });
    const j = JSON.parse(res.getContentText());
    if (j.values) values.push(...j.values);
    cur.setDate(cur.getDate()+1);
  }
  return values;
}

/* ====================== 施術マスタ ====================== */

// optionId -> { category, type }
function loadMasterMap(ss){
  const sh = ss.getSheetByName(MASTER_SHEET);
  if (!sh || sh.getLastRow()<2) return {};
  const data = sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  const map = {};
  data.forEach(r=>{
    const opt=String(r[0]||'').trim(), cat=String(r[3]||'').trim(), typ=String(r[4]||'通常').trim();
    if (opt && cat) map[opt]={category:cat, type:typ};
  });
  return map;
}

function ensureMasterSheet_(ss){
  let sh = ss.getSheetByName(MASTER_SHEET);
  if (!sh){
    sh = ss.insertSheet(MASTER_SHEET);
    sh.appendRow(['optionId','API名','APIカテゴリ','集計カテゴリ','種別']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ====================== 集計コア（検証済み・変更しない） ====================== */

function aggregateClinic(values, masterMap, pendingAccum){
  const byCat = {};
  function ensure(c){ if(!byCat[c]){ byCat[c]={count:0,sales:0,通常:0,CP:0,媒体:0}; } }
  values.forEach(v=>{
    const counted = new Set();
    (v.paymentItems||[]).forEach(it=>{
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      if (contract<=0 && digest>0) return;                 // 消化除外
      let sales = contract>0 ? Math.round(contract) : Math.round(genuine);
      if (sales===0) return;
      const opt = String(it.optionId||'').trim();
      let cat, typ;
      if (opt && masterMap[opt]){
        cat = masterMap[opt].category; typ = masterMap[opt].type;
        if (cat==='除外') return;
      } else {
        // 未分類（pendingに候補つきで蓄積。集計上は★未分類）
        if (opt && pendingAccum && !pendingAccum[opt]){
          pendingAccum[opt] = { optionId:opt, name:it.name||'', apiCat:it.category||'', count:0 };
        }
        if (opt && pendingAccum && pendingAccum[opt]) pendingAccum[opt].count++;
        cat = UNCLASSIFIED; typ = '通常';
      }
      if (!TYPES_NEW.includes(typ)) typ='通常';
      ensure(cat);
      byCat[cat].sales += sales; byCat[cat][typ] += sales;
      const key = `${cat}|${typ}`;
      if (!counted.has(key)){ byCat[cat].count++; counted.add(key); }
    });
  });
  return byCat;
}

/* ====================== キャッシュ（6分制限対策） ====================== */

function ensureCacheSheet_(ss){
  let sh = ss.getSheetByName(CACHE_SHEET);
  if (!sh){
    sh = ss.insertSheet(CACHE_SHEET);
    sh.appendRow(['clinicKey','year','month','json','updatedAt']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function cacheKey_(clinicKey, year, month){ return `${clinicKey}|${year}|${month}`; }

function readCache_(ss, clinicKey, year, month){
  const sh = ensureCacheSheet_(ss);
  if (sh.getLastRow()<2) return null;
  const data = sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  for (let i=0;i<data.length;i++){
    if (String(data[i][0])===clinicKey && Number(data[i][1])===year && Number(data[i][2])===month){
      try { return JSON.parse(data[i][3]); } catch(e){ return null; }
    }
  }
  return null;
}

function writeCache_(ss, clinicKey, year, month, byCat){
  const sh = ensureCacheSheet_(ss);
  const json = JSON.stringify(byCat);
  const now  = Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd HH:mm:ss');
  const data = sh.getLastRow()>1 ? sh.getRange(2,1,sh.getLastRow()-1,3).getValues() : [];
  for (let i=0;i<data.length;i++){
    if (String(data[i][0])===clinicKey && Number(data[i][1])===year && Number(data[i][2])===month){
      sh.getRange(i+2,4,1,2).setValues([[json, now]]);
      return;
    }
  }
  sh.appendRow([clinicKey, year, month, json, now]);
}

/**
 * 1院1か月の集計を返す。useCache=true かつ当月以外ならキャッシュ優先。
 * （当月は日々増えるので常にライブ取得して上書きキャッシュ）
 */
function getMonthAggregation(clinicKey, year, month, useCache){
  const ss = getSpreadsheet_();
  const today = new Date();
  const isCur = (year===today.getFullYear() && month===today.getMonth()+1);
  if (useCache && !isCur){
    const cached = readCache_(ss, clinicKey, year, month);
    if (cached) return cached;
  }
  const clinic    = getClinic_(clinicKey);
  const masterMap = loadMasterMap(ss);
  const pending   = {};
  const values    = fetchClinicMonth(clinic, year, month);
  const byCat     = aggregateClinic(values, masterMap, pending);
  writeCache_(ss, clinicKey, year, month, byCat);
  return byCat;
}

/* ====================== キーワード自動サジェスト ====================== */

const MEDIA_KW = ['カンナム','キレイパス','ホットペッパー','HPB','トリビュー','くまポン'];
const CP_KW    = ['キャンペーン','ゲリラ','フェア','感謝祭','スキンチケット','CP'];

// 集計カテゴリの候補（施術名/APIカテゴリのキーワード → 集計カテゴリ）
const CATEGORY_KW = [
  ['ポテンツァ','ポテンツァ'],
  ['脂肪溶解','脂肪溶解'],
  ['ボトックス','ボトックス'],
  ['ボツ','ボトックス'],
  ['ヒアルロン','ヒアルロン酸'],
  ['ハイフ','ハイフ'],
  ['HIFU','ハイフ'],
  ['ダーマペン','ダーマペン'],
  ['レーザー','レーザー'],
  ['ピーリング','ピーリング'],
  ['脱毛','脱毛'],
  ['シミ','シミ取り'],
  ['糸','糸リフト'],
  ['点滴','点滴・注射'],
  ['注射','点滴・注射'],
];

function suggestType_(text){
  const t = String(text||'');
  if (MEDIA_KW.some(k=>t.indexOf(k)>=0)) return '媒体';
  if (CP_KW.some(k=>t.indexOf(k)>=0))    return 'CP';
  return '通常';
}

function suggestCategory_(name, apiCat){
  const t = String(name||'') + ' ' + String(apiCat||'');
  for (const [kw, cat] of CATEGORY_KW){
    if (t.indexOf(kw)>=0) return cat;
  }
  return '';
}

/* ====================== ダッシュボード用 API（クライアントから呼ぶ） ====================== */

/** 初期設定: 院一覧と既定の年月 */
function getConfig(){
  const today = new Date();
  return {
    clinics: CLINIC_LIST.map(c=>({key:c.key, name:c.name})),
    types: TYPES_NEW,
    year:  today.getFullYear(),
    month: today.getMonth()+1,
  };
}

/**
 * ダッシュボード本体。
 *  - 選択月: ライブ集計（カテゴリ/カード/ランキング/未分類）
 *  - 月別グラフ: 直近6か月のうちキャッシュにあるもの + 選択月
 * 返り値: { clinic, year, month, summary, categories, monthly, rankings, pendingCount }
 */
function getDashboard(clinicKey, year, month){
  const ss   = getSpreadsheet_();
  const byCat = getMonthAggregation(clinicKey, year, month, false); // 選択月は常にライブ

  // --- カテゴリ配列（★未分類は末尾に寄せる） ---
  const categories = Object.keys(byCat).map(cat=>({
    category: cat,
    sales:  byCat[cat].sales,
    count:  byCat[cat].count,
    通常:   byCat[cat]['通常'],
    CP:     byCat[cat]['CP'],
    媒体:   byCat[cat]['媒体'],
  })).sort((a,b)=>{
    if (a.category===UNCLASSIFIED) return 1;
    if (b.category===UNCLASSIFIED) return -1;
    return b.sales - a.sales;
  });

  const totalSales = categories.reduce((s,c)=>s+c.sales,0);
  const totalCount = categories.reduce((s,c)=>s+c.count,0);
  const cpSales    = categories.reduce((s,c)=>s+c.CP,0);
  const mediaSales = categories.reduce((s,c)=>s+c.媒体,0);

  // --- 月別グラフ（直近6か月。キャッシュにある月のみ・選択月は今のbyCat） ---
  const monthly = buildMonthlyTrend_(ss, clinicKey, year, month, byCat);

  // --- ランキング ---
  const ranked = categories.filter(c=>c.category!==UNCLASSIFIED);
  const rankings = {
    sales: ranked.slice().sort((a,b)=>b.sales-a.sales).slice(0,10)
              .map(c=>({label:c.category, value:c.sales})),
    count: ranked.slice().sort((a,b)=>b.count-a.count).slice(0,10)
              .map(c=>({label:c.category, value:c.count})),
  };

  const pendingCount = byCat[UNCLASSIFIED] ? byCat[UNCLASSIFIED].count : 0;

  return {
    clinic: getClinic_(clinicKey).name,
    clinicKey, year, month,
    summary: {
      totalSales, totalCount, cpSales, mediaSales,
      avgPrice: totalCount ? Math.round(totalSales/totalCount) : 0,
    },
    categories, monthly, rankings, pendingCount,
  };
}

/** 直近 monthsBack か月の売上推移（種別内訳つき）。キャッシュ優先、無ければ0。 */
function buildMonthlyTrend_(ss, clinicKey, year, month, currentByCat){
  const monthsBack = 6;
  const out = [];
  for (let i=monthsBack-1;i>=0;i--){
    const d = new Date(year, month-1-i, 1);
    const y = d.getFullYear(), m = d.getMonth()+1;
    let byCat;
    if (y===year && m===month){
      byCat = currentByCat;
    } else {
      byCat = readCache_(ss, clinicKey, y, m); // 無ければnull
    }
    const sum = byCat ? sumByCat_(byCat) : null;
    out.push({
      label: `${y}/${('0'+m).slice(-2)}`,
      sales:  sum ? sum.sales : 0,
      count:  sum ? sum.count : 0,
      通常:   sum ? sum.通常 : 0,
      CP:     sum ? sum.CP : 0,
      媒体:   sum ? sum.媒体 : 0,
      hasData: !!byCat,
    });
  }
  return out;
}

function sumByCat_(byCat){
  const s = {sales:0,count:0,通常:0,CP:0,媒体:0};
  Object.keys(byCat).forEach(cat=>{
    if (cat===UNCLASSIFIED) return; // グラフ合計には未分類を含めない
    s.sales += byCat[cat].sales;
    s.count += byCat[cat].count;
    s.通常  += byCat[cat]['通常'];
    s.CP    += byCat[cat]['CP'];
    s.媒体  += byCat[cat]['媒体'];
  });
  return s;
}

/* ====================== 未分類 振り分け UI 用 API ====================== */

/** 選択月の未分類 optionId を、候補(カテゴリ/種別)つきで返す */
function getPending(clinicKey, year, month){
  const ss        = getSpreadsheet_();
  const clinic    = getClinic_(clinicKey);
  const masterMap = loadMasterMap(ss);
  const pending   = {};
  const values    = fetchClinicMonth(clinic, year, month);
  aggregateClinic(values, masterMap, pending); // pending を埋めるのが目的

  const known = new Set(getKnownCategories_(ss));
  const rows = Object.keys(pending).map(opt=>{
    const p = pending[opt];
    return {
      optionId: p.optionId,
      name:     p.name,
      apiCat:   p.apiCat,
      count:    p.count,
      suggestCategory: suggestCategory_(p.name, p.apiCat),
      suggestType:     suggestType_(p.name + ' ' + p.apiCat),
    };
  }).sort((a,b)=> b.count - a.count);

  return {
    rows,
    knownCategories: Array.from(known).sort(),
    types: TYPES_NEW,
  };
}

/** 既存の集計カテゴリ一覧（マスタから） */
function getKnownCategories_(ss){
  const sh = ss.getSheetByName(MASTER_SHEET);
  if (!sh || sh.getLastRow()<2) return [];
  const cats = sh.getRange(2,4,sh.getLastRow()-1,1).getValues().map(r=>String(r[0]||'').trim());
  return Array.from(new Set(cats.filter(Boolean)));
}

/**
 * 施術マスタへ1件 登録/更新。
 * assignments: [{optionId, name, apiCat, category, type}] の配列
 */
function assignMaster(assignments){
  if (!assignments || !assignments.length) return {updated:0};
  const ss = getSpreadsheet_();
  const sh = ensureMasterSheet_(ss);
  // 既存 optionId -> 行番号
  const rowByOpt = {};
  if (sh.getLastRow()>1){
    const opts = sh.getRange(2,1,sh.getLastRow()-1,1).getValues();
    opts.forEach((r,i)=>{ const o=String(r[0]||'').trim(); if(o) rowByOpt[o]=i+2; });
  }
  let updated = 0;
  assignments.forEach(a=>{
    const opt = String(a.optionId||'').trim();
    if (!opt || !a.category) return;
    const row = [opt, a.name||'', a.apiCat||'', a.category, a.type||'通常'];
    if (rowByOpt[opt]) sh.getRange(rowByOpt[opt],1,1,5).setValues([row]);
    else { sh.appendRow(row); rowByOpt[opt]=sh.getLastRow(); }
    updated++;
  });
  return {updated};
}

/* ====================== キャッシュ作成メニュー ====================== */

function onOpen(){
  SpreadsheetApp.getUi()
    .createMenu('ダッシュボード')
    .addItem('当月キャッシュ作成（全院）','buildCacheCurrentMonth')
    .addItem('施術マスタ初期化','setupMaster')
    .addToUi();
}

/** 全院の当月をライブ集計してキャッシュに保存（6分制限に注意：必要なら院ごとに実行） */
function buildCacheCurrentMonth(){
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth()+1;
  CLINIC_LIST.forEach(c=>{ getMonthAggregation(c.key, y, m, false); });
}

/** 指定院・年・月をキャッシュ（手動実行用） */
function buildCacheFor(clinicKey, year, month){
  return getMonthAggregation(clinicKey, year, month, false);
}

function setupMaster(){
  ensureMasterSheet_(getSpreadsheet_());
}
