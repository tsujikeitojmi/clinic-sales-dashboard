/**********************************************************************
 * 3院売上集計ダッシュボード — スタンドアロン版 server.js (Node.js)
 *  - GAS不要。Node.js 18以上で動く（標準モジュールのみ・依存パッケージなし）。
 *  - medical-force API から会計実績を取得し、施術カテゴリ別に集計して
 *    ブラウザ(index.html)にダッシュボード表示する。
 *
 *  集計コアは引き継ぎ資料「集計コア」を検証済みのまま移植（変更しない）:
 *   売上 = 契約額(courseContractAmount) + 単発genuine / 消化は除外 / 按分なし
 *   件数 = 同会計 × 同(カテゴリ,種別) = 1件
 *   daily-accounts は 1日ずつ取得（31日制約回避）
 *   カテゴリ名寄せは 施術マスタ(optionId → カテゴリ + 種別)
 *
 *  認証情報は .env に置く（コードに直書きしない）:
 *   CLINIC1_CLIENT_ID / CLINIC1_CLIENT_SECRET / CLINIC1_CLINIC_ID  (心斎橋)
 *   CLINIC2_... (新宿) / CLINIC3_... (福岡)
 *
 *  保存先（このフォルダ内に自動生成）:
 *   data/master.json        … 施術マスタ optionId→{category,type}
 *   data/cache/<key>.json   … 月次集計キャッシュ（過去月グラフ用）
 **********************************************************************/
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const CACHE_DIR  = path.join(DATA_DIR, 'cache');
const MASTER     = path.join(DATA_DIR, 'master.json');
const CATEGORIES = path.join(DATA_DIR, 'categories.json');
const PORT       = process.env.PORT || 7700;

const API_BASE_NEW = 'https://api.medical-force.com';
const CLINIC_LIST = [
  { key:'CLINIC1', name:'心斎橋', color:'#b76e79' },
  { key:'CLINIC2', name:'新宿',   color:'#c9a35b' },
  { key:'CLINIC3', name:'福岡',   color:'#7fa99b' },
  // 将来: { key:'CLINIC4', name:'名古屋', color:'#9a86b0' },
];
const TYPES_NEW   = ['通常','CP','媒体'];
const UNCLASSIFIED = '★未分類';
const EXCLUDED     = '除外';   // 集計合計には含めないが、確認・修正できるようカテゴリとしては表示する

// 施術カテゴリ（グループ）初期一覧。data/categories.json で編集・追加できる
const DEFAULT_CATEGORIES = [
  'ポテンツァ',
  'CP-25','S-16','S-25','A1-15','ダイヤモンド',
  'BENEV','マックーム','リジュラン','ジュベルック','ボトックスアラガン',
  'エクソソーム','スネコス','デイリースペシャル(マックーム+エクソソーム)',
  'デイリープレミアム(ジュベルック+エクソソーム)','ACRS',
  'フォトフェイシャル','ツヤ肌セット',
  'アクネフォト','ニキビ撃退セット',
  '脱毛',
  'ピコレーザー','ピコスポット','ピコトーニング','ピコフラクショナル','ピコダブル',
  'デンシティ',
  'ハイコックス','スキンボトックス','ジュベリジュ',
  'リジュラン（ハイコックス）','ジュベルック（ハイコックス）','スネコス（ハイコックス）','エクソソーム（ハイコックス）','ACRS（ハイコックス）',
  'ボトックス','ヒアルロン酸',
  '肌育注射','スネコスパフォルマ','リジュランi','リジュランHB Plus',
  'プルリアルデンシファイ','ジャルプロスーパーハイドロ','オーロラ注射',
  'ショートスレッド','ビタミンスレッド','サーモンスレッド','オーダーメイドスレッド',
  '脂肪溶解注射','HIFU','ルメッカ',
  'インモード','MiniFX','Forma','Vリフト',
  'ダーマペン','ヴェルベットスキン','スーパーヴェルベットスキン',
  'ピーリング','マッサージピール','ミラノピール','ララドクター','その他のピーリング',
  'リバースピール','サリチル酸ピール',
  'ハイドラ','ケアシス',
  '物販',
];

// サイドバー用カテゴリ階層ツリー（表示・集計の親子関係のみ定義、振り分けは DEFAULT_CATEGORIES の葉名を使用）
const CATEGORY_TREE = [
  { name:'ポテンツァ', children:[
    { name:'CP-25', children:[
      { name:'BENEV' }, { name:'マックーム' }, { name:'リジュラン' },
      { name:'ジュベルック' }, { name:'ボトックスアラガン' }, { name:'エクソソーム' },
      { name:'スネコス' }, { name:'デイリースペシャル(マックーム+エクソソーム)' },
      { name:'デイリープレミアム(ジュベルック+エクソソーム)' }, { name:'ACRS' },
    ]},
    { name:'S-16' }, { name:'S-25' }, { name:'A1-15' }, { name:'ダイヤモンド' },
  ]},
  { name:'フォトフェイシャル' },
  { name:'アクネフォト' },
  { name:'脱毛' },
  { name:'ピコレーザー', children:[
    { name:'ピコスポット' }, { name:'ピコトーニング' }, { name:'ピコフラクショナル' }, { name:'ピコダブル' },
  ]},
  { name:'デンシティ' },
  { name:'ハイコックス', children:[
    { name:'スキンボトックス' }, { name:'リジュラン（ハイコックス）' }, { name:'ジュベルック（ハイコックス）' },
    { name:'スネコス（ハイコックス）' }, { name:'ジュベリジュ' }, { name:'エクソソーム（ハイコックス）' }, { name:'ACRS（ハイコックス）' },
  ]},
  { name:'ボトックス' }, { name:'ヒアルロン酸' },
  { name:'肌育注射', children:[
    { name:'スネコスパフォルマ' }, { name:'リジュランi' }, { name:'リジュランHB Plus' },
    { name:'プルリアルデンシファイ' }, { name:'ジャルプロスーパーハイドロ' }, { name:'オーロラ注射' },
  ]},
  { name:'ショートスレッド', children:[
    { name:'ビタミンスレッド' }, { name:'サーモンスレッド' }, { name:'オーダーメイドスレッド' },
  ]},
  { name:'脂肪溶解注射' },
  { name:'HIFU' }, { name:'ルメッカ' },
  { name:'インモード', children:[
    { name:'MiniFX' }, { name:'Forma' }, { name:'Vリフト' },
  ]},
  { name:'ダーマペン', children:[
    { name:'ヴェルベットスキン' }, { name:'スーパーヴェルベットスキン' },
  ]},
  { name:'ピーリング', children:[
    { name:'マッサージピール' }, { name:'ミラノピール' }, { name:'ララドクター' }, { name:'その他のピーリング' },
    { name:'リバースピール' }, { name:'サリチル酸ピール' },
  ]},
  { name:'ハイドラ' }, { name:'ケアシス' },
  { name:'物販' },
];

// 子を持つカテゴリ名のSet（振り分け選択肢から除外する）
function collectParentNames(nodes, out=new Set()){
  (nodes||[]).forEach(n=>{ if(n.children&&n.children.length){ out.add(n.name); collectParentNames(n.children,out); } });
  return out;
}
const PARENT_CAT_NAMES = collectParentNames(CATEGORY_TREE);
// 振り分けUIに表示するのはルート（最上位）カテゴリのみ
const ROOT_CAT_NAMES = new Set(CATEGORY_TREE.map(n=>n.name));

/* ====================== .env 読み込み（依存なし簡易パーサ） ====================== */
function loadEnv(){
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
loadEnv();

function ensureDirs(){
  if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR, {recursive:true});
  if (!fs.existsSync(CACHE_DIR))   fs.mkdirSync(CACHE_DIR, {recursive:true});
  if (!fs.existsSync(MASTER))      fs.writeFileSync(MASTER, '[]', 'utf8');
  if (!fs.existsSync(CATEGORIES))  fs.writeFileSync(CATEGORIES, JSON.stringify(DEFAULT_CATEGORIES, null, 2), 'utf8');
}
ensureDirs();

/* ====================== ストレージ（Supabase / ローカルJSON） ======================
   共有データ（master=optionId→カテゴリ, categories=グループ一覧）の保存先。
   ・.env に SUPABASE_URL と SUPABASE_SERVICE_KEY があれば Supabase を使用（全PCで共有）。
   ・無ければ従来どおりローカルJSON。
   ・どちらの場合もローカルJSONにミラー保存（オフライン/バックアップ用）。
   ・読み取りは起動時にメモリへロードし、APIアクセス毎に最大3秒間隔でSupabaseから再取得。 */
const SB_URL = (process.env.SUPABASE_URL||'').trim().replace(/\/+$/,'').replace(/\/rest\/v1$/,'');
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY||'').trim();
const SB_ON  = !!(SB_URL && SB_KEY);
const SB_H   = SB_ON ? { apikey:SB_KEY, Authorization:'Bearer '+SB_KEY, 'Content-Type':'application/json' } : null;

async function sbGet(query){
  const r = await fetch(`${SB_URL}/rest/v1/${query}`, { headers:SB_H });
  if (!r.ok) throw new Error('Supabase GET '+r.status+' '+(await r.text()).slice(0,200));
  return r.json();
}
// PostgRESTは1回最大1000行。offsetで全件ページングする。
async function sbGetAll(table, select, order){
  const out=[]; const page=1000; let from=0;
  for(;;){
    const rows = await sbGet(`${table}?select=${select}${order?`&order=${order}`:''}&limit=${page}&offset=${from}`);
    out.push(...rows);
    if (rows.length < page) break;
    from += page;
  }
  return out;
}
async function sbUpsert(table, rows){
  if (!rows.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method:'POST', headers:{ ...SB_H, Prefer:'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows) });
  if (!r.ok) throw new Error('Supabase upsert '+table+' '+r.status+' '+(await r.text()).slice(0,200));
}
async function sbDeleteCat(name){
  if (!SB_ON) return;
  const r = await fetch(`${SB_URL}/rest/v1/mfdash_categories?name=eq.${encodeURIComponent(name)}`, { method:'DELETE', headers:SB_H });
  if (!r.ok) throw new Error('Supabase delete cat '+r.status);
}

// 廃止カテゴリ（サイドバーから除去・Supabaseからも削除）
const REMOVE_CATS = new Set(['水光注射', 'その他の薬剤']);

// --- Supabase キャッシュ（mfdash_cache テーブル） ---
async function sbCacheGet(clinicKey, year, month){
  if (!SB_ON) return null;
  try {
    const rows = await sbGet(`mfdash_cache?clinic_key=eq.${clinicKey}&year=eq.${year}&month=eq.${month}&select=fetched_at,cache_data`);
    if (!rows || !rows.length) return null;
    return { fetchedAt: rows[0].fetched_at, values: rows[0].cache_data };
  } catch(e){ console.error('sbCacheGet失敗:', e.message); return null; }
}
async function sbCacheUpsert(clinicKey, year, month, fetchedAt, values){
  if (!SB_ON) return;
  try {
    await sbUpsert('mfdash_cache', [{ clinic_key:clinicKey, year, month, fetched_at:fetchedAt, cache_data:values }]);
  } catch(e){ console.error('sbCacheUpsert失敗:', e.message); }
}

// --- ローカルJSON（バックアップ/フォールバック） ---
function localReadMaster(){ try{ return JSON.parse(fs.readFileSync(MASTER,'utf8'))||[]; }catch(e){ return []; } }
function localWriteMaster(arr){ try{ fs.writeFileSync(MASTER, JSON.stringify(arr,null,2),'utf8'); }catch(e){} }
function localReadCats(){ try{ const a=JSON.parse(fs.readFileSync(CATEGORIES,'utf8')); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function localWriteCats(arr){ try{ fs.writeFileSync(CATEGORIES, JSON.stringify(arr,null,2),'utf8'); }catch(e){} }
const toSbMaster = r => ({ option_id:String(r.optionId), name:r.name||'', api_cat:r.apiCat||'', category:r.category, type:r.type||'通常', clinic:r.clinic||null });

// --- メモリ上の現在値 ---
let MASTER_ROWS = [];   // [{optionId,name,apiCat,category,type,clinic}]
let CAT_ARR     = [];
let lastLoad    = 0;

async function sbLoadAll(){
  const m = await sbGetAll('mfdash_master', 'option_id,name,api_cat,category,type,clinic', 'option_id.asc');
  MASTER_ROWS = m.map(r=>({ optionId:String(r.option_id), name:r.name||'', apiCat:r.api_cat||'', category:r.category, type:r.type||'通常', clinic:r.clinic||'' }));
  const c = await sbGetAll('mfdash_categories', 'name,sort', 'sort.asc');
  CAT_ARR = c.map(r=>r.name);
  lastLoad = Date.now();
  localWriteMaster(MASTER_ROWS); localWriteCats(CAT_ARR);   // ローカルバックアップを常にSupabaseと一致させる
}

async function loadState(){
  if (SB_ON){
    await sbLoadAll();
    // 初回移行：Supabaseが空でローカルにデータがあれば押し上げる
    if (MASTER_ROWS.length===0){
      const lm = localReadMaster();
      if (lm.length){ await sbUpsert('mfdash_master', lm.map(toSbMaster)); MASTER_ROWS = lm.map(r=>({clinic:'',...r})); console.log('  → master をSupabaseへ移行:', lm.length, '件'); }
    }
    if (CAT_ARR.length===0){
      const lc = localReadCats(); const seed = lc.length ? lc : DEFAULT_CATEGORIES.slice();
      await sbUpsert('mfdash_categories', seed.map((n,i)=>({name:n,sort:i}))); CAT_ARR = seed;
      console.log('  → categories をSupabaseへ移行:', seed.length, '件');
    }
    // 新カテゴリ追加（DEFAULT_CATEGORIESに増えたものをSupabaseへ反映）
    const missing = DEFAULT_CATEGORIES.filter(n=>!CAT_ARR.includes(n));
    if (missing.length){
      await sbUpsert('mfdash_categories', missing.map((n,i)=>({name:n,sort:CAT_ARR.length+i})));
      CAT_ARR.push(...missing);
      localWriteCats(CAT_ARR);
      console.log('  → 新カテゴリをSupabaseへ追加:', missing.join(', '));
    }
  } else {
    MASTER_ROWS = localReadMaster();
    CAT_ARR = localReadCats(); if (!CAT_ARR.length) CAT_ARR = DEFAULT_CATEGORIES.slice();
    const missing = DEFAULT_CATEGORIES.filter(n=>!CAT_ARR.includes(n));
    if (missing.length){ CAT_ARR.push(...missing); localWriteCats(CAT_ARR); }
  }
  // 廃止カテゴリをメモリ・ローカル・Supabaseから削除
  const toRemove = CAT_ARR.filter(n => REMOVE_CATS.has(n));
  if (toRemove.length){
    CAT_ARR = CAT_ARR.filter(n => !REMOVE_CATS.has(n));
    localWriteCats(CAT_ARR);
    if (SB_ON){ for (const n of toRemove){ try{ await sbDeleteCat(n); }catch(e){ console.error('カテゴリ削除失敗:', n, e.message); } } }
    console.log('  → 廃止カテゴリを削除:', toRemove.join(', '));
  }
}

// APIアクセス毎に呼ぶ。Supabase利用時は最大30秒間隔で最新を取り直す（別PCの変更を反映）。
async function ensureFresh(){
  if (!SB_ON) return;
  if (Date.now()-lastLoad > 30000){ try{ await sbLoadAll(); }catch(e){ console.error('Supabase再取得失敗:', e.message); } }
}

/* ====================== カテゴリ/マスタ アクセサ（メモリから） ====================== */
function readCategories(){ return CAT_ARR.slice(); }
function readMaster(){ return MASTER_ROWS; }
function loadMasterMap(){
  const map = {};
  MASTER_ROWS.forEach(r=>{
    const opt=String(r.optionId||'').trim(), cat=String(r.category||'').trim(), typ=String(r.type||'通常').trim();
    if (opt && cat) map[opt]={category:cat, type:typ};
  });
  return map;
}
function getKnownCategories(){
  return Array.from(new Set(MASTER_ROWS.map(r=>String(r.category||'').trim()).filter(Boolean))).sort();
}

/* ====================== 設定/認証 ====================== */
function getClinic(key){
  const base = CLINIC_LIST.find(c => c.key === key);
  if (!base) throw new Error('未知の院: ' + key);
  const clinic = {
    key: base.key, name: base.name,
    clientId:     process.env[key + '_CLIENT_ID'],
    clientSecret: process.env[key + '_CLIENT_SECRET'],
    clinicId:     process.env[key + '_CLINIC_ID'],
  };
  if (!clinic.clientId || !clinic.clientSecret || !clinic.clinicId)
    throw new Error(`${base.name}(${key}) の認証情報が .env にありません`);
  return clinic;
}

async function getToken(id, secret){
  const res = await fetch(`${API_BASE_NEW}/token`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ client_id:id, client_secret:secret }),
  });
  const j = await res.json().catch(()=>({}));
  if (!j.access_token) throw new Error('トークン取得失敗: ' + JSON.stringify(j));
  return j.access_token;
}

/* ====================== 取得（1日ずつ・検証済み） ====================== */
function fmtDate(d){
  const y=d.getFullYear(), m=('0'+(d.getMonth()+1)).slice(-2), day=('0'+d.getDate()).slice(-2);
  return `${y}-${m}-${day}`;
}

const FETCH_CONCURRENCY = 16;  // 同時に投げる日次リクエスト数（API応答が頭打ちになる手前）

// 1日分を取得（1回リトライ付き）。31日制約を避けるため必ず1日=1リクエスト。
async function fetchDay(token, clinic, d){
  for (let attempt=0; attempt<2; attempt++){
    try {
      const res = await fetch(
        `${API_BASE_NEW}/developer/daily-accounts?epoch_from=${d}&epoch_to=${d}`,
        { method:'GET', headers:{ 'Authorization':`Bearer ${token}`, 'clinic_id':clinic.clinicId } });
      const j = await res.json().catch(()=>({}));
      return j.values || [];
    } catch(e){
      if (attempt===1) throw e;   // 2回目も失敗なら諦めて投げる
    }
  }
  return [];
}

async function fetchClinicMonth(clinic, year, month){
  const token = await getToken(clinic.clientId, clinic.clientSecret);
  const first = new Date(year, month-1, 1);
  const today = new Date();
  const isCur = (year===today.getFullYear() && month===today.getMonth()+1);
  const last  = isCur ? today : new Date(year, month, 0);

  // 対象日を列挙
  const dates = [];
  let cur = new Date(first);
  while (cur <= last){ dates.push(fmtDate(cur)); cur.setDate(cur.getDate()+1); }

  // 同時 FETCH_CONCURRENCY 件のワーカープールで並列取得（集計に順序は不要）
  const values = [];
  let idx = 0;
  async function worker(){
    while (true){
      const my = idx++;
      if (my >= dates.length) return;
      const vals = await fetchDay(token, clinic, dates[my]);
      if (vals.length) values.push(...vals);
    }
  }
  await Promise.all(Array.from({length: Math.min(FETCH_CONCURRENCY, dates.length)}, worker));
  return values;
}


/* ====================== 集計コア（消化計上：medical-force公式画面と一致） ======================
   コースは「契約時」ではなく「消化（来店して使った）時」に計上する。単品はそのまま。
   丸めは medical-force と同じ「切り捨て(round_down)」。端数のある物品等も1円まで公式画面と一致。
   （四捨五入だと物品などで数円の差が出ていたため 2026/07 に Math.floor へ統一） */
function aggregateClinic(values, masterMap, pendingAccum){
  const byCat = {};
  function ensure(c){ if(!byCat[c]){ byCat[c]={count:0,sales:0,通常:0,CP:0,媒体:0,count_通常:0,count_CP:0,count_媒体:0}; } }
  values.forEach(v=>{
    const counted = new Set();
    (v.paymentItems||[]).forEach(it=>{
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      if (contract>0) return;                              // 消化計上：コース契約は計上しない（消化した時に計上＝公式画面と一致）
      let sales = digest>0 ? Math.floor(digest) : Math.floor(genuine);  // 消化があれば消化額、無ければ単品の実額
      if (sales===0) return;
      const opt = String(it.optionId||'').trim();
      let cat, typ;
      if (opt && masterMap[opt]){
        cat = masterMap[opt].category; typ = masterMap[opt].type;
        // 「除外」も byCat に集計する（合計からは getDashboard 等で除外）。確認・修正用に表示するため。
      } else {
        // pendingAccum は振り分けUI用の補助情報（byCatの集計結果には影響しない）
        if (opt && pendingAccum && !pendingAccum[opt]){
          pendingAccum[opt] = { optionId:opt, name:it.name||'', apiCat:it.category||'', count:0, sales:0 };
        }
        if (opt && pendingAccum && pendingAccum[opt]){ pendingAccum[opt].count++; pendingAccum[opt].sales += sales; }
        cat = UNCLASSIFIED; typ = '通常';
      }
      if (!TYPES_NEW.includes(typ)) typ='通常';
      ensure(cat);
      byCat[cat].sales += sales; byCat[cat][typ] += sales;
      const countKey = `${opt||('n:'+it.name)}|${cat}|${typ}`;
      if (!counted.has(countKey)){ byCat[cat].count++; byCat[cat]['count_'+typ]++; counted.add(countKey); }
    });
  });
  return byCat;
}

/* 来院数（会計数）: その月の会計のうち、集計対象の明細を1つ以上持つ会計を1と数える。
   ・1会計＝1（＝1回の来院＝1人）。同じ人が別日にまた来たら別カウント（＝延べ来院数）。
   ・数える対象は施術数と同じ判定（コース契約は除外、消化 or 単品で売上≠0）。金額側には一切影響しない。 */
function countVisits(values){
  let n = 0;
  (values||[]).forEach(v=>{
    const has = (v.paymentItems||[]).some(it=>{
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      if (contract>0) return false;
      const sales = digest>0 ? Math.floor(digest) : Math.floor(genuine);
      return sales!==0;
    });
    if (has) n++;
  });
  return n;
}

/* ====================== 公式画面(medical-force)準拠の集計 ======================
   medical-force の公式集計画面と同じ「個数・消化回数・人数・売上」を kind 別に出す。
   心斎橋2026/6で全行一致を確認（物品売上のみ丸めで±数円）。金額ロジックには一切影響しない。
     個数     = 消化でない明細の数量(quantity)合計（単発＋コース契約）
     消化回数 = 消化(courseDigestion>0)の明細の数量合計
     人数     = その行(kind)の明細を持つユニーク患者数(visitorId)
     売上     = 消化計上（契約は除外、消化 or 単品の実額）＝金額と同一 */
const OFFICIAL_ROWS = ['施術','薬剤','物品','その他'];
function officialRowOf(kind){ return (kind==='施術'||kind==='薬剤'||kind==='物品') ? kind : 'その他'; }
function aggregateByKind(values){
  const R = {}; OFFICIAL_ROWS.forEach(k=>{ R[k]={kind:k, kosuu:0, shouka:0, sales:0, _ppl:new Set()}; });
  (values||[]).forEach(v=>{
    const vis = v.visitorId || null;
    (v.paymentItems||[]).forEach(it=>{
      const row = officialRowOf(it.kind);
      const g = R[row];
      const qty      = Number(it.quantity)||0;
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      // 個数・消化回数は 施術/薬剤/物品 のみ数える（その他＝前受金・返金・調整は公式でも個数0）
      if (row !== 'その他'){ if (digest>0) g.shouka += qty; else g.kosuu += qty; }
      // 売上は全行で消化計上（金額ロジックと同一・一切変更しない）
      g.sales += contract>0 ? 0 : (digest>0 ? Math.floor(digest) : Math.floor(genuine));
      // 人数：施術/薬剤/物品は「価格フィールド(genuinePriceWithTax)のある行」のみ数える
      //   （セット構成品などの未価格行は公式でも人数に数えない。¥0の無料施術は価格0で数える）。
      //   その他は kind が空欄(前受金の内訳等)を除外。→ 3院で公式画面と完全一致を確認。
      const person = (row === 'その他') ? !!it.kind : (it.genuinePriceWithTax !== undefined);
      if (vis && person) g._ppl.add(vis);
    });
  });
  return OFFICIAL_ROWS.map(k=>({ kind:k, kosuu:R[k].kosuu, shouka:R[k].shouka, ninzuu:R[k]._ppl.size, sales:R[k].sales }));
}

/* 施術(optionId)単位の内訳。カテゴリ別ダッシュボードの「中身」表示用（集計コアは変更せず読み取りのみ）。
   ・売上 = 同じルール（契約 or 単発genuine、消化除外）の合算 → 合計はカテゴリ売上と一致
   ・件数 = その施術を受けた「人数」＝ユニーク患者数(visitorId)。公式画面の各施術「人数」と一致。
           （同じ人が同じ来店で同じ施術を2回受けても1、別日に受けても1＝頭数）
           ※旧データ(visitorId無し)は会計単位でフォールバック。金額には一切影響しない。 */
function aggregateItems(values, masterMap){
  const byOpt = {};
  (values||[]).forEach((v, ai)=>{
    const person = v.visitorId || ('__acct' + ai);   // 患者ID（無ければ会計ごとに一意＝旧データ用）
    (v.paymentItems||[]).forEach(it=>{
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      const priced   = it.genuinePriceWithTax !== undefined;   // 価格のある行（人数の対象。契約・消化・単品・¥0を含む＝公式「人数」と一致）
      // 売上は消化計上（契約は0扱い、消化 or 単品の実額）＝カテゴリ売上と一致・金額は不変
      const sales = contract>0 ? 0 : (digest>0 ? Math.floor(digest) : Math.floor(genuine));
      if (sales===0 && !priced) return;                        // 売上にも人数にも効かない行はスキップ
      const opt = String(it.optionId||'').trim();
      let cat, typ;
      if (opt && masterMap[opt]){
        cat = masterMap[opt].category; typ = masterMap[opt].type;
        // 「除外」も内訳には含める（確認・修正できるように）
      } else { cat = UNCLASSIFIED; typ = '通常'; }
      if (!TYPES_NEW.includes(typ)) typ='通常';
      const k = opt || ('noopt|' + (it.name||''));
      if (!byOpt[k]) byOpt[k] = { optionId:opt, name:it.name||'', apiCat:it.category||'', category:cat, type:typ, _ppl:new Set(), sales:0 };
      byOpt[k].sales += sales;
      if (priced) byOpt[k]._ppl.add(person);                   // 人数＝ユニーク患者（コース契約者も含む＝公式と一致）
    });
  });
  return Object.values(byOpt)
    .map(o=>({ optionId:o.optionId, name:o.name, apiCat:o.apiCat, category:o.category, type:o.type, count:o._ppl.size, sales:o.sales }))
    .sort((a,b)=> b.sales - a.sales);
}

/* ====================== キャッシュ（APIの生データを保存） ======================
   集計後ではなく「取得した生データ(values)」をキャッシュする。
   こうすると施術マスタの振り分けを変えても、再集計でちゃんと反映される。 */
function cacheFile(clinicKey, year, month){ return path.join(CACHE_DIR, `${clinicKey}_${year}_${month}.json`); }
async function readRawFull(clinicKey, year, month){
  const f = cacheFile(clinicKey, year, month);
  if (fs.existsSync(f)){
    try { const j = JSON.parse(fs.readFileSync(f,'utf8')); if (j && j.values) return j; } catch(e){}
  }
  // ローカルになければSupabaseから取得してローカルにも保存
  const sb = await sbCacheGet(clinicKey, year, month);
  if (sb){
    try { fs.writeFileSync(f, JSON.stringify({ fetchedAt:sb.fetchedAt, values:sb.values }), 'utf8'); } catch(e){}
    return sb;
  }
  return null;
}
async function readRaw(clinicKey, year, month){ const j = await readRawFull(clinicKey, year, month); return j ? j.values : null; }
// 保存サイズ削減：集計が使う項目だけ残す（会計=v単位は保持。各paymentItemは6項目のみ）。
// 使う項目: optionId / name / category / courseContractAmountWithTax / courseDigestionAmountWithTax / genuinePriceWithTax
function slimValues(values){
  return (values||[]).map(v=>({
    visitorId: v.visitorId,                    // 人数(ユニーク患者数)集計用（公式画面の「人数」）
    paymentItems: (v.paymentItems||[]).map(it=>({
      kind: it.kind,                           // 施術/薬剤/物品/その他（公式画面の行分類）
      optionId: it.optionId,
      name: it.name,
      category: it.category,
      quantity: it.quantity,                   // 数量（公式画面の「個数」は数量ベース）
      courseContractAmountWithTax: it.courseContractAmountWithTax,
      courseDigestionAmountWithTax: it.courseDigestionAmountWithTax,
      genuinePriceWithTax: it.genuinePriceWithTax,
    }))
  }));
}
// 公式集計に必要な項目(kind/quantity/visitorId)が入った新しいキャッシュか判定（古い月は要再取得）
function isEnriched(values){
  return Array.isArray(values) && values.length>0 &&
    values.some(v=> v && Object.prototype.hasOwnProperty.call(v,'visitorId'));
}
async function writeRaw(clinicKey, year, month, valuesRaw){
  const values = slimValues(valuesRaw);   // 軽量化して保存
  const fetchedAt = new Date().toISOString();
  fs.writeFileSync(cacheFile(clinicKey, year, month), JSON.stringify({ fetchedAt, values }), 'utf8');
  sbCacheUpsert(clinicKey, year, month, fetchedAt, values); // Supabaseへも保存（待たない）
  trendCacheInvalidAt = Date.now(); // 月別トレンドキャッシュを無効化
}
function cacheExists(clinicKey, year, month){ return fs.existsSync(cacheFile(clinicKey, year, month)); }

// 生データを取得。
//  refresh=false（既定）: キャッシュ(=ローカルDB)があれば即返す。当月も同じ＝2回目以降は速い。
//  refresh=true       : APIから取り直してキャッシュを更新（「最新取得」ボタン用）。
async function getValues(clinicKey, year, month, refresh){
  if (!refresh){
    const j = await readRawFull(clinicKey, year, month);
    if (j) return { values:j.values, cached:true, fetchedAt:j.fetchedAt };
  }
  const clinic = getClinic(clinicKey);
  const values = await fetchClinicMonth(clinic, year, month);
  await writeRaw(clinicKey, year, month, values);
  return { values, cached:false, fetchedAt:new Date().toISOString() };
}

/* ====================== キーワード自動サジェスト ====================== */
const MEDIA_KW = ['カンナム','キレイパス','ホットペッパー','HPB','トリビュー','くまポン'];
const CP_KW    = ['キャンペーン','ゲリラ','フェア','感謝祭','スキンチケット','CP'];

// 各カテゴリにマッチさせる別名キーワード（表記揺れ対策）。施術名/APIカテゴリに含まれたら近いと判定。
const CATEGORY_ALIAS = {
  'ポテンツァ':['ポテンツァ','POTENZA'],
  'フォトフェイシャル':['フォトフェイシャル','フォトフェイス','フォト','IPL','ステラ','M22'],
  'ツヤ肌セット':['ツヤ肌','ツヤセット'],
  'アクネフォト':['アクネフォト','アクネ'],
  'ニキビ撃退セット':['ニキビ撃退','ニキビセット'],
  '脱毛':['脱毛'],
  'ピコレーザー':['ピコレーザー','ピコ'],
  'ピコスポット':['ピコスポット','スポット','シミ取り','シミ'],
  'ピコトーニング':['ピコトーニング','ピコトーン'],
  'ピコフラクショナル':['ピコフラクショナル','ピコフラク'],
  'ピコダブル':['ピコダブル'],
  'デンシティ':['デンシティ'],
  'ハイコックス':['ハイコックス','ハイドラコックス','コックス'],
  'ボトックス':['ボトックス','ボツリヌス','ボツ'],
  'ヒアルロン酸':['ヒアルロン'],
  '肌育注射':['肌育','プロファイロ'],
  'スネコスパフォルマ':['スネコスパフォルマ','パフォルマ'],
  'リジュランi':['リジュランi','リジュランアイ'],
  'リジュランHB Plus':['リジュランHB','HBPlus'],
  'プルリアルデンシファイ':['プルリアル','デンシファイ'],
  'ジャルプロスーパーハイドロ':['ジャルプロ','スーパーハイドロ'],
  'オーロラ注射':['オーロラ'],
  'ショートスレッド':['ショートスレッド','スレッド','糸'],
  'ビタミンスレッド':['ビタミンスレッド','ビタミンスレ'],
  'サーモンスレッド':['サーモンスレッド','サーモン'],
  'オーダーメイドスレッド':['オーダーメイドスレッド','オーダーメイドスレ'],
  '脂肪溶解注射':['脂肪溶解','脂肪','BNLS','カベリン','チンセラ','FatX','fatX','Fat X','fat X','FATX'],
  'HIFU':['HIFU','ハイフ','ウルトラフォーマー','ソノクイーン'],
  'ルメッカ':['ルメッカ'],
  'インモード':['インモード','ファクトラ','モルフェ'],
  'MiniFX':['MiniFX','ミニFX'],
  'Forma':['Forma','フォルマ'],
  'Vリフト':['Vリフト'],
  'ダーマペン':['ダーマペン'],
  'ヴェルベットスキン':['ヴェルベットスキン','ヴェルベット'],
  'スーパーヴェルベットスキン':['スーパーヴェルベットスキン','スーパーヴェルベット'],
  'ピーリング':['ピーリング','ピール'],
  'マッサージピール':['マッサージピール','コスメラン','TCA'],
  'ミラノピール':['ミラノ','ミラノリ'],
  'ララドクター':['ララドクター'],
  'その他のピーリング':['ハイドラピール'],
  'リバースピール':['リバースピール','リバース'],
  'サリチル酸ピール':['サリチル酸','サリチル'],
  'ハイドラ':['ハイドラフェイシャル','ハイドラ'],
  'ケアシス':['ケアシス'],
  '物販':['物販','物品販売','コスメ販売','スキンケア販売'],
  // ポテンツァ サブカテゴリ
  'CP-25':['CP-25','CP25'],
  'S-16':['S-16','S16'],
  'S-25':['S-25','S25'],
  'A1-15':['A1-15','A115','A1'],
  'ダイヤモンド':['ダイヤモンド','ダイヤ'],
  // CP-25 薬剤
  'BENEV':['BENEV','ベネブ'],
  'マックーム':['マックーム','マクーム'],
  'リジュラン':['リジュラン'],
  'ジュベルック':['ジュベルック'],
  'ボトックスアラガン':['アラガン'],
  'エクソソーム':['エクソソーム','エクソ'],
  'スネコス':['スネコス'],
  'デイリースペシャル(マックーム+エクソソーム)':['デイリースペシャル'],
  'デイリープレミアム(ジュベルック+エクソソーム)':['デイリープレミアム'],
  'ACRS':['ACRS'],
  // ハイコックス サブカテゴリ
  'スキンボトックス':['スキンボトックス','スキンボト'],
  'ジュベリジュ':['ジュベリジュ'],
  'ジュベルック（ハイコックス）':['ジュベルック'],
  'リジュラン（ハイコックス）':['リジュラン'],
  'スネコス（ハイコックス）':['スネコス'],
  'エクソソーム（ハイコックス）':['エクソソーム','エクソ'],
  'ACRS（ハイコックス）':['ACRS'],
  // ピーリング サブカテゴリ
  'マッサージピール':['マッサージピール','コスメラン','TCA'],
  'ミラノピール':['ミラノ','ミラノリ'],
  'ララドクター':['ララドクター'],
  'その他のピーリング':['ハイドラピール'],
};
function aliasesOf(cat){ return CATEGORY_ALIAS[cat] || [cat]; }

/* ツリー各ノードの親・深さ（おすすめパス推定用）。CATEGORY_TREE から構築。 */
function buildNodeInfo(nodes, par, out){
  (nodes||[]).forEach(n=>{
    out[n.name] = { parent: par||null, depth: par ? out[par].depth+1 : 0, hasChildren: !!(n.children&&n.children.length) };
    if (n.children) buildNodeInfo(n.children, n.name, out);
  });
  return out;
}
const NODE_INFO = buildNodeInfo(CATEGORY_TREE, null, {});
const ALL_NODES = Object.keys(NODE_INFO);
// このノード名の別名が施術名に含まれれば、一番長い一致の文字数（具体的なほど高い）
function ownScore(text, name){ let s=0; for (const kw of aliasesOf(name)){ if (kw && text.indexOf(kw)>=0) s=Math.max(s,kw.length); } return s; }
// ルート→葉の「おすすめパス」。自ノード＋先祖の一致を合算し、親の言葉も当たるパスを優先（例:ハイコックス系）。
function suggestBestPath(name, apiCat){
  const text = String(name||'') + ' ' + String(apiCat||'');
  let best=null, bestScore=0, bestDepth=-1;
  ALL_NODES.forEach(n=>{
    if (ownScore(text, n) <= 0) return;                 // 自分自身が当たらないノードは選ばない
    let sc=0, cur=n; while(cur){ sc+=ownScore(text,cur); cur=NODE_INFO[cur].parent; }  // 先祖ぶん加点
    const d = NODE_INFO[n].depth;
    if (sc>bestScore || (sc===bestScore && d>bestDepth)){ best=n; bestScore=sc; bestDepth=d; }  // 同点は深い方＝具体的
  });
  if (!best) return [];
  const path=[]; let cur=best; while(cur){ path.unshift(cur); cur=NODE_INFO[cur].parent; }
  return path;
}

function suggestType(text){
  const t = String(text||'');
  if (MEDIA_KW.some(k=>t.indexOf(k)>=0)) return '媒体';
  if (CP_KW.some(k=>t.indexOf(k)>=0))    return 'CP';
  return '通常';
}

// カテゴリ一覧を「近い順」に並べ替え、最も近いもの(おすすめ)を返す。
//  ordered : 近い順に並べたカテゴリ配列（マッチ無しは元の並びを維持して後ろ）
//  best    : おすすめ（マッチが1つでもあればそのカテゴリ、無ければ ''）
function rankCategories(name, apiCat, cats){
  const text = String(name||'') + ' ' + String(apiCat||'');
  const scored = cats.map((cat,i)=>{
    let score = 0;
    for (const kw of aliasesOf(cat)){
      if (kw && text.indexOf(kw) >= 0) score = Math.max(score, kw.length); // 長い一致ほど具体的＝高スコア
    }
    return { cat, score, i };
  });
  const ordered = scored.slice().sort((a,b)=> (b.score-a.score) || (a.i-b.i)).map(s=>s.cat);
  const top = scored.reduce((best,s)=> s.score>best.score ? s : best, {score:0,cat:''});
  return { ordered, best: top.score>0 ? top.cat : '' };
}

/* ====================== ダッシュボード組み立て ====================== */
function getConfig(){
  const today = new Date();
  return {
    clinics: CLINIC_LIST.map(c=>({key:c.key, name:c.name, color:c.color})),
    categories: readCategories().filter(c=>ROOT_CAT_NAMES.has(c)),
    categoryTree: CATEGORY_TREE,
    types: TYPES_NEW,
    year:  today.getFullYear(),
    month: today.getMonth()+1,
  };
}

function sumByCat(byCat){
  const s = {sales:0,count:0,通常:0,CP:0,媒体:0,count_通常:0,count_CP:0,count_媒体:0};
  Object.keys(byCat).forEach(cat=>{
    if (cat===UNCLASSIFIED || cat===EXCLUDED) return;
    s.sales += byCat[cat].sales; s.count += byCat[cat].count;
    s.通常 += byCat[cat]['通常']; s.CP += byCat[cat]['CP']; s.媒体 += byCat[cat]['媒体'];
    s.count_通常 += byCat[cat]['count_通常']||0;
    s.count_CP   += byCat[cat]['count_CP']||0;
    s.count_媒体 += byCat[cat]['count_媒体']||0;
  });
  return s;
}

// 月別トレンドキャッシュ（データ変更時に無効化）
const trendCache = new Map();
let trendCacheInvalidAt = 0;

async function buildMonthlyTrend(clinicKey, year, month, currentByCat){
  const cacheKey = `${clinicKey}_${year}_${month}`;
  const cached = trendCache.get(cacheKey);
  if (cached && cached.ts >= trendCacheInvalidAt) return cached.data;
  const masterMap = loadMasterMap();
  const endS = year*12 + (month-1);
  const startS = endS - 11;   // 選択月から過去12か月（1年間）
  const serials = [];
  for (let s=startS; s<=endS; s++) serials.push(s);
  // 各月を並列で集計（44か月でも遅くならないように）
  const out = await Promise.all(serials.map(async s=>{
    const y = Math.floor(s/12), m = (s%12)+1;
    let byCat;
    if (y===year && m===month) byCat = currentByCat;
    else { const raw = await readRaw(clinicKey, y, m); byCat = raw ? aggregateClinic(raw, masterMap, null) : null; }
    const sum = byCat ? sumByCat(byCat) : null;
    // 全件合計（★未分類・除外含む）= カード「累計粗利」と一致する値
    const allSales = byCat ? Object.values(byCat).reduce((s,c)=>s+c.sales,0) : 0;
    const allCount = byCat ? Object.values(byCat).reduce((s,c)=>s+c.count,0) : 0;
    // カテゴリ別の内訳（フロントの月別グラフをカテゴリで絞り込めるように）
    const cats = {};
    if (byCat) Object.keys(byCat).forEach(cat=>{
      if (cat===UNCLASSIFIED || cat===EXCLUDED) return;
      const c = byCat[cat];
      cats[cat] = { sales:c.sales, count:c.count, 通常:c['通常'], CP:c['CP'], 媒体:c['媒体'],
        count_通常:c['count_通常']||0, count_CP:c['count_CP']||0, count_媒体:c['count_媒体']||0 };
    });
    return {
      label:`${y}/${('0'+m).slice(-2)}`,
      sales:allSales, count:allCount,
      通常:sum?sum.通常:0, CP:sum?sum.CP:0, 媒体:sum?sum.媒体:0,
      count_通常:sum?sum.count_通常:0, count_CP:sum?sum.count_CP:0, count_媒体:sum?sum.count_媒体:0,
      hasData:!!byCat,
      cats,
    };
  }));
  trendCache.set(cacheKey, { data: out, ts: Date.now() });
  return out;
}

async function getDashboard(clinicKey, year, month, refresh){
  // 既定はキャッシュ優先（=速い）。refresh=true のときだけAPI再取得。
  const { values, cached, fetchedAt } = await getValues(clinicKey, year, month, refresh);
  const masterMap = loadMasterMap();
  const byCat = aggregateClinic(values, masterMap, null);
  const categories = Object.keys(byCat).map(cat=>({
    category:cat, sales:byCat[cat].sales, count:byCat[cat].count,
    通常:byCat[cat]['通常'], CP:byCat[cat]['CP'], 媒体:byCat[cat]['媒体'],
    count_通常:byCat[cat]['count_通常']||0, count_CP:byCat[cat]['count_CP']||0, count_媒体:byCat[cat]['count_媒体']||0,
  })).sort((a,b)=>{
    // ★未分類・除外は末尾へ（除外を一番下に）
    const rk = c => c.category===EXCLUDED ? 2 : c.category===UNCLASSIFIED ? 1 : 0;
    if (rk(a)!==rk(b)) return rk(a)-rk(b);
    return b.sales - a.sales;
  });

  // 合計は「除外」も含む（除外＝該当カテゴリなしの項目。★未分類と同じく売上には数える）
  const totalSales = categories.reduce((s,c)=>s+c.sales,0);
  const totalCount = categories.reduce((s,c)=>s+c.count,0);
  const cpSales    = categories.reduce((s,c)=>s+c.CP,0);
  const mediaSales = categories.reduce((s,c)=>s+c.媒体,0);

  // ランキングは集計の軸にしない「★未分類・除外」を除く
  const ranked = categories.filter(c=>c.category!==UNCLASSIFIED && c.category!==EXCLUDED);
  const rankings = {
    sales: ranked.slice().sort((a,b)=>b.sales-a.sales).slice(0,10).map(c=>({label:c.category, value:c.sales})),
    count: ranked.slice().sort((a,b)=>b.count-a.count).slice(0,10).map(c=>({label:c.category, value:c.count})),
  };

  return {
    clinic: getClinic(clinicKey).name, clinicKey, year, month,
    cached, fetchedAt,   // データの鮮度（キャッシュか・取得時刻）
    summary:{ totalSales, totalCount, cpSales, mediaSales, avgPrice: totalCount?Math.round(totalSales/totalCount):0,
      visitCount: countVisits(values) },   // 来院数（会計数）。金額・施術数はそのまま。
    categories,
    items: aggregateItems(values, masterMap),  // 施術(optionId)単位の内訳
    official: { rows: aggregateByKind(values), enriched: isEnriched(values) },  // 公式画面準拠（個数/消化回数/人数）
    monthly: await buildMonthlyTrend(clinicKey, year, month, byCat),
    rankings,
    pendingCount: byCat[UNCLASSIFIED] ? byCat[UNCLASSIFIED].count : 0,
  };
}

// 全院のサイドバー用：キャッシュ済みの院だけ集計して返す（APIは叩かない＝軽い）
async function getOverview(year, month){
  const masterMap = loadMasterMap();
  return Promise.all(CLINIC_LIST.map(async c=>{
    const raw = await readRaw(c.key, year, month);
    if (!raw) return { key:c.key, name:c.name, color:c.color, cached:false, totalSales:0, categories:[] };
    const byCat = aggregateClinic(raw, masterMap, null);
    const categories = Object.keys(byCat).map(cat=>({ category:cat, sales:byCat[cat].sales, count:byCat[cat].count }))
      .sort((a,b)=>{ const rk=x=>x.category===EXCLUDED?2:x.category===UNCLASSIFIED?1:0; if(rk(a)!==rk(b))return rk(a)-rk(b); return b.sales-a.sales; });
    return { key:c.key, name:c.name, color:c.color, cached:true,
      totalSales: categories.reduce((s,x)=>s+x.sales,0), categories };
  }));
}

// キャッシュ済みの月一覧（このクリニック）
async function listCachedMonths(clinicKey){
  const out = [], seen = new Set();
  const re = new RegExp('^' + clinicKey + '_(\\d+)_(\\d+)\\.json$');
  try { fs.readdirSync(CACHE_DIR).forEach(f=>{ const m=f.match(re); if(m){ const k=`${m[1]}_${m[2]}`; if(!seen.has(k)){ seen.add(k); out.push({year:+m[1], month:+m[2]}); } } }); } catch(e){}
  if (SB_ON){
    try {
      const rows = await sbGet(`mfdash_cache?clinic_key=eq.${clinicKey}&select=year,month`);
      rows.forEach(r=>{ const k=`${r.year}_${r.month}`; if(!seen.has(k)){ seen.add(k); out.push({year:r.year, month:r.month}); } });
    } catch(e){ console.error('listCachedMonths SB失敗:', e.message); }
  }
  return out;
}

// 未分類(pending)を集める。scope: 'month'=その月 / 'all'=キャッシュ済み全月（optionIdで合算）
async function collectPending(clinicKey, year, month, scope){
  const masterMap = loadMasterMap();
  const pending = {};
  if (scope==='all'){
    const months = await listCachedMonths(clinicKey);
    for (const {year:y, month:m} of months){
      const raw = await readRaw(clinicKey, y, m); if (raw) aggregateClinic(raw, masterMap, pending);
    }
  } else {
    const { values } = await getValues(clinicKey, year, month, false);
    aggregateClinic(values, masterMap, pending);
  }
  return pending;
}

// 1件ぶんの「かんたん自動振り分け」判定。明確に1カテゴリだけなら そのカテゴリ、そうでなければ null。
function autoPickCategory(name, apiCat, cats){
  const text = (name||'') + ' ' + (apiCat||'');
  // 厳しめ：カテゴリ名そのものが施術名/APIカテゴリに literal で含まれる時だけ自動振り分け。
  // 別名キーワード（フォト→フォトフェイシャル 等）や複合メニューは自動では入れず、手動カードのおすすめに回す。
  const hits = Array.from(new Set(cats.filter(cat => cat && text.indexOf(cat) >= 0)));
  if (hits.length === 0) return null;                       // 名前一致なし → ユーザーへ
  if (hits.length === 1) return hits[0];
  // 複数一致：名前が入れ子（例「スキンボトックス」⊃「ボトックス」）なら、より具体的（長い）方を採用
  const longest = hits.reduce((a,b)=> b.length>a.length ? b : a);
  if (hits.every(h => longest.indexOf(h) >= 0)) return longest;
  return null;                                              // 無関係な複数該当（複合メニュー等）→ ユーザーへ
}

// かんたんなものを自動振り分け（scope: 'month' / 'all'）
async function autoAssign(clinicKey, year, month, scope){
  const pending = await collectPending(clinicKey, year, month, scope);
  const cats = Array.from(ROOT_CAT_NAMES).filter(c=>readCategories().includes(c));
  const assignments = [];
  Object.values(pending).forEach(p=>{
    const cat = autoPickCategory(p.name, p.apiCat, cats);
    if (cat) assignments.push({ optionId:p.optionId, name:p.name, apiCat:p.apiCat, category:cat, type:cat==='物販'?'通常':suggestType((p.name||'')+' '+(p.apiCat||'')) });
  });
  const res = await assignMaster(assignments);
  return { assigned: res.updated };
}

async function getPending(clinicKey, year, month, scope){
  const pending = await collectPending(clinicKey, year, month, scope);
  const cats = Array.from(ROOT_CAT_NAMES).filter(c=>readCategories().includes(c));
  const rows = Object.keys(pending).map(opt=>{
    const p = pending[opt];
    const r = rankCategories(p.name, p.apiCat, cats);   // ルートを近い順に並べ替え
    const path = suggestBestPath(p.name, p.apiCat);     // ルート→葉のおすすめパス（子のおすすめ用）
    return { optionId:p.optionId, name:p.name, apiCat:p.apiCat, count:p.count, sales:p.sales,
      categoriesRanked: r.ordered,
      suggestCategory:  path.length ? path[0] : r.best, // 親カードのおすすめ（パスの根っこ優先）
      suggestPath: path,                                // ["ハイコックス","ジュベルック（ハイコックス）"] 等
      suggestType: suggestType(p.name + ' ' + p.apiCat) };
  }).sort((a,b)=> b.sales - a.sales);   // 金額の大きい順（影響の大きいものから振り分け）
  const monthsScanned = scope==='all' ? (await listCachedMonths(clinicKey)).length : 1;
  return { rows, knownCategories: cats, types: TYPES_NEW,
    scope: scope||'month', monthsScanned };
}

/* 施術マスタ管理ページ用：この院のキャッシュ全月に出てくる全施術(optionId)を集め、
   現在の振り分け（カテゴリ・種別）を付けて返す。未分類も含む。金額は出さない（軽量）。 */
async function getMasterList(clinicKey){
  const masterMap = loadMasterMap();
  const byOpt = {};
  const months = await listCachedMonths(clinicKey);
  for (const {year:y, month:m} of months){
    const raw = await readRaw(clinicKey, y, m);
    if (!raw) continue;
    raw.forEach(v=>(v.paymentItems||[]).forEach(it=>{
      const opt = String(it.optionId||'').trim();
      if (!opt || byOpt[opt]) return;
      byOpt[opt] = { optionId:opt, name:it.name||'', apiCat:it.category||'' };
    }));
  }
  const rows = Object.values(byOpt).map(o=>{
    const m = masterMap[o.optionId];
    const path = suggestBestPath(o.name, o.apiCat);
    return { optionId:o.optionId, name:o.name, apiCat:o.apiCat,
      category: m ? m.category : UNCLASSIFIED,
      type:     m ? m.type : suggestType(o.name+' '+o.apiCat),
      suggestPath: path,
      suggestCategory: path.length ? path[path.length-1] : '' };   // おすすめ（葉まで）
  }).sort((a,b)=> String(a.name).localeCompare(String(b.name),'ja'));
  return { clinic: getClinic(clinicKey).name, clinicKey, rows,
    categoryTree: CATEGORY_TREE, types: TYPES_NEW, monthsScanned: months.length };
}

async function assignMaster(assignments){
  if (!assignments || !assignments.length) return {updated:0};
  trendCacheInvalidAt = Date.now(); // 月別トレンドキャッシュを無効化
  const idxByOpt = {};
  MASTER_ROWS.forEach((r,i)=>{ const o=String(r.optionId||'').trim(); if(o) idxByOpt[o]=i; });
  const changed = [], newCats = [];
  assignments.forEach(a=>{
    const opt = String(a.optionId||'').trim();
    if (!opt || !a.category) return;
    const row = { optionId:opt, name:a.name||'', apiCat:a.apiCat||'', category:a.category, type:a.type||'通常', clinic:a.clinic||'' };
    if (idxByOpt[opt] !== undefined) MASTER_ROWS[idxByOpt[opt]] = row;
    else { MASTER_ROWS.push(row); idxByOpt[opt]=MASTER_ROWS.length-1; }
    changed.push(row);
    const c = String(a.category||'').trim();
    if (c && c!=='除外' && c!==UNCLASSIFIED && !CAT_ARR.includes(c) && !newCats.includes(c)) newCats.push(c);
  });
  if (newCats.length) CAT_ARR.push(...newCats);
  if (SB_ON){
    try {
      await sbUpsert('mfdash_master', changed.map(toSbMaster));
      if (newCats.length) await sbUpsert('mfdash_categories', newCats.map((n,i)=>({ name:n, sort:CAT_ARR.length+i })));
    } catch(e){ console.error('Supabase書き込み失敗:', e.message); }
  }
  localWriteMaster(MASTER_ROWS);                 // バックアップ
  if (newCats.length) localWriteCats(CAT_ARR);
  return { updated: changed.length };
}

/* ====================== 子カテゴリ振り分け ====================== */
function getTreeChildrenOf(parentName){
  function search(nodes){
    for (const n of nodes){
      if (n.name===parentName) return (n.children||[]).map(c=>c.name);
      if (n.children){ const r=search(n.children); if(r) return r; }
    }
    return null;
  }
  return search(CATEGORY_TREE)||[];
}

async function getSubPending(clinicKey, year, month, parentCat, scope){
  const children = getTreeChildrenOf(parentCat);
  if (!children.length) return {rows:[],children:[],parent:parentCat};
  const parentItems = MASTER_ROWS.filter(r=>r.category===parentCat);
  if (!parentItems.length) return {rows:[],children,parent:parentCat};
  const optIds = new Set(parentItems.map(r=>String(r.optionId)));
  const salesByOpt = {};
  function accum(values){
    values.forEach(v=>{
      const counted=new Set();
      (v.paymentItems||[]).forEach(it=>{
        const contract=Number(it.courseContractAmountWithTax)||0;
        const digest=Number(it.courseDigestionAmountWithTax)||0;
        const genuine=Number(it.genuinePriceWithTax)||0;
        if(contract>0) return;
        const sales=digest>0?Math.floor(digest):Math.floor(genuine);
        if(sales===0) return;
        const opt=String(it.optionId||'').trim();
        if(!optIds.has(opt)) return;
        if(!salesByOpt[opt]) salesByOpt[opt]={count:0,sales:0};
        salesByOpt[opt].sales+=sales;
        if(!counted.has(opt)){salesByOpt[opt].count++;counted.add(opt);}
      });
    });
  }
  if(scope==='all'){
    const months=await listCachedMonths(clinicKey);
    for(const{year:y,month:m}of months){const raw=await readRaw(clinicKey,y,m);if(raw)accum(raw);}
  } else {
    const{values}=await getValues(clinicKey,year,month,false);
    accum(values);
  }
  const rows=parentItems.map(r=>({
    optionId:r.optionId,name:r.name,apiCat:r.apiCat,
    category:r.category,type:r.type,
    count:(salesByOpt[r.optionId]||{}).count||0,
    sales:(salesByOpt[r.optionId]||{}).sales||0,
  })).sort((a,b)=>b.sales-a.sales);
  return{rows,children,parent:parentCat};
}

/* ====================== HTTP サーバ ====================== */
function send(res, code, body, type){
  res.writeHead(code, {'Content-Type': type || 'application/json; charset=utf-8'});
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req){
  return new Promise(resolve=>{
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{resolve(JSON.parse(b||'{}'));}catch(e){resolve({});} });
  });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const q = u.query;
  try {
    if (req.method==='GET' && (u.pathname==='/' || u.pathname==='/index.html')){
      return send(res, 200, fs.readFileSync(path.join(ROOT,'index.html'),'utf8'), 'text/html; charset=utf-8');
    }
    if (u.pathname.startsWith('/api/')) await ensureFresh();   // 共有データを最新化（最大3秒間隔）
    if (u.pathname==='/api/config'){
      return send(res, 200, getConfig());
    }
    if (u.pathname==='/api/dashboard'){
      const d = await getDashboard(q.clinic, +q.year, +q.month, q.refresh==='1');
      return send(res, 200, d);
    }
    if (u.pathname==='/api/overview'){   // 全院のサイドバー用（キャッシュのみ・API叩かない）
      return send(res, 200, await getOverview(+q.year, +q.month));
    }
    if (u.pathname==='/api/pending'){
      const d = await getPending(q.clinic, +q.year, +q.month, q.scope);
      return send(res, 200, d);
    }
    if (u.pathname==='/api/master'){   // 施術マスタ管理ページ用（この院の全施術＋現在の振り分け）
      return send(res, 200, await getMasterList(q.clinic));
    }
    if (u.pathname==='/api/sub-pending'){
      if (!q.parent) return send(res,400,{error:'parent required'});
      const d = await getSubPending(q.clinic, +q.year||new Date().getFullYear(), +q.month||(new Date().getMonth()+1), q.parent, q.scope||'all');
      return send(res, 200, d);
    }
    if (req.method==='POST' && u.pathname==='/api/assign'){
      const body = await readBody(req);
      return send(res, 200, await assignMaster(body.assignments));
    }
    if (req.method==='POST' && u.pathname==='/api/auto-assign'){
      const body = await readBody(req);
      return send(res, 200, await autoAssign(body.clinic, +body.year, +body.month, body.scope));
    }
    send(res, 404, {error:'not found'});
  } catch (e){
    console.error(e);
    send(res, 500, {error: e.message || String(e)});
  }
});

// ローカルキャッシュをSupabaseへ一括移行（起動時にバックグラウンドで実行）
async function migrateCacheToSb(){
  if (!SB_ON) return;
  try {
    const sbRows = await sbGet('mfdash_cache?select=clinic_key,year,month');
    const sbSet = new Set(sbRows.map(r=>`${r.clinic_key}_${r.year}_${r.month}`));
    const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
    let count = 0;
    for (const f of files){
      const m = f.match(/^(CLINIC\d+)_(\d+)_(\d+)\.json$/);
      if (!m) continue;
      const [, key, yr, mo] = m;
      if (!sbSet.has(`${key}_${yr}_${mo}`)){
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
          if (data && data.values){
            await sbCacheUpsert(key, +yr, +mo, data.fetchedAt||'', data.values);
            count++;
          }
        } catch(e){}
      }
    }
    if (count) console.log(`  → ローカルキャッシュをSupabaseへ移行: ${count}ファイル`);
    else console.log('  → キャッシュ移行: Supabase既存と同期済み');
  } catch(e){ console.error('キャッシュ移行失敗:', e.message); }
}

// ハイコックスの薬剤（ジュベルック等）がポテンツァ側の同名カテゴリに入っていた分を、
// ハイコックス専用カテゴリ「〇〇（ハイコックス）」へ付け替える。名前に「コックス」を含むものだけ対象。
// 一度実行すれば名前が変わるので再実行しても二重処理にならない（冪等）。
async function migrateHicox(){
  const SHARED = ['リジュラン','ジュベルック','スネコス','エクソソーム','ACRS'];
  const changed = [], newCats = [];
  MASTER_ROWS.forEach(r=>{
    const cat = String(r.category||'').trim();
    if (SHARED.includes(cat) && String(r.name||'').includes('コックス')){
      r.category = cat + '（ハイコックス）';
      changed.push(r);
      if (!CAT_ARR.includes(r.category) && !newCats.includes(r.category)) newCats.push(r.category);
    }
  });
  if (!changed.length) return;
  if (newCats.length) CAT_ARR.push(...newCats);
  if (SB_ON){
    try {
      await sbUpsert('mfdash_master', changed.map(toSbMaster));
      if (newCats.length) await sbUpsert('mfdash_categories', newCats.map((n,i)=>({ name:n, sort:CAT_ARR.length+i })));
    } catch(e){ console.error('ハイコックス付け替え SB書込失敗:', e.message); }
  }
  localWriteMaster(MASTER_ROWS); if (newCats.length) localWriteCats(CAT_ARR);
  console.log('  → ハイコックス薬剤の付け替え:', changed.length, '件');
}

(async () => {
  try { await loadState(); }
  catch(e){ console.error('保存データの読込に失敗（ローカルにフォールバック）:', e.message); MASTER_ROWS = localReadMaster(); CAT_ARR = localReadCats(); if(!CAT_ARR.length) CAT_ARR = DEFAULT_CATEGORIES.slice(); }
  try { await migrateHicox(); } catch(e){ console.error('ハイコックス付け替え失敗:', e.message); }
  if (SB_ON) migrateCacheToSb().catch(e=>console.error('キャッシュ移行失敗:', e.message));
  server.listen(PORT, () => {
    const ok = CLINIC_LIST.filter(c=>process.env[c.key+'_CLIENT_ID']).map(c=>c.name);
    console.log('──────────────────────────────────────────────');
    console.log(' 3院売上集計ダッシュボード（スタンドアロン版）');
    console.log(' URL    :  http://localhost:' + PORT);
    console.log(' 保存先 :', SB_ON ? 'Supabase（全PC共有）+ ローカルにバックアップ' : 'ローカルJSONのみ');
    console.log(' データ :  master', MASTER_ROWS.length, '件 / categories', CAT_ARR.length, '件');
    console.log(' 設定済の院:', ok.length ? ok.join(' / ') : '（.env未設定）');
    console.log('  ※ ブラウザで上のURLを開いてください。停止は Ctrl+C');
    console.log('──────────────────────────────────────────────');
  });
})();
