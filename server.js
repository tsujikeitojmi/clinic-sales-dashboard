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
const crypto = require('crypto');

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
  'S-16','S-25','A1-15','ダイヤモンド','ジュベリジュ（ポテンツァ）','スノーフラワーブルーム（ポテンツァ）',
  'BENEV','マックーム','リジュラン','ジュベルック','ボトックス（ポテンツァ）',
  'エクソソーム','スネコス','デイリースペシャル(マックーム+エクソソーム)',
  'デイリープレミアム(ジュベルック+エクソソーム)','ACRS',
  'フォトフェイシャル',
  'アクネフォト',
  '脱毛',
  'ピコレーザー','ピコスポット','ピコトーニング','ピコフラクショナル','ピコダブル',
  'デンシティ',
  'ハイコックス','スキンボトックス','ジュベリジュ','スノーフラワーブルーム','その他の薬剤（ハイコックス）',
  'リジュラン（ハイコックス）','ジュベルック（ハイコックス）','スネコス（ハイコックス）','エクソソーム（ハイコックス）','ACRS（ハイコックス）',
  'ボトックス','ヒアルロン酸',
  '肌育注射','スネコスパフォルマ','リジュランi','リジュランHB Plus',
  'プルリアルデンシファイ','ジャルプロスーパーハイドロ','オーロラ注射','ジュベルック（肌育注射）','リズネ','その他の薬剤（肌育注射）',
  'ショートスレッド',
  '脂肪溶解注射','HIFU','ルメッカ',
  'インモード','MiniFX','Forma','Vリフト',
  'ダーマペン',
  'サブシジョン',
  'ピーリング','マッサージピール','ミラノピール','ララドクター','その他のピーリング',
  'リバースピール','サリチル酸ピール',
  'ハイドラ','ケアシス','レナトスTa+','ペップビュー','エクソソーム（ケアシス）','その他の薬剤',
  '物販',
];

// サイドバー用カテゴリ階層ツリー（表示・集計の親子関係のみ定義、振り分けは DEFAULT_CATEGORIES の葉名を使用）
const CATEGORY_TREE = [
  { name:'ポテンツァ', children:[
    { name:'BENEV' }, { name:'マックーム' }, { name:'リジュラン' },
    { name:'ジュベルック' }, { name:'ボトックス（ポテンツァ）' }, { name:'エクソソーム' },
    { name:'スネコス' }, { name:'デイリースペシャル(マックーム+エクソソーム)' },
    { name:'デイリープレミアム(ジュベルック+エクソソーム)' }, { name:'ACRS' },
    { name:'S-16' }, { name:'S-25' }, { name:'A1-15' }, { name:'ダイヤモンド' },
    { name:'ジュベリジュ（ポテンツァ）' }, { name:'スノーフラワーブルーム（ポテンツァ）' },
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
    { name:'スノーフラワーブルーム' }, { name:'その他の薬剤（ハイコックス）' },
  ]},
  { name:'ボトックス' }, { name:'ヒアルロン酸' },
  { name:'肌育注射', children:[
    { name:'スネコスパフォルマ' }, { name:'リジュランi' }, { name:'リジュランHB Plus' },
    { name:'プルリアルデンシファイ' }, { name:'ジャルプロスーパーハイドロ' }, { name:'オーロラ注射' },
    { name:'ジュベルック（肌育注射）' }, { name:'リズネ' }, { name:'その他の薬剤（肌育注射）' },
  ]},
  { name:'ショートスレッド' },
  { name:'脂肪溶解注射' },
  { name:'HIFU' }, { name:'ルメッカ' },
  { name:'インモード', children:[
    { name:'MiniFX' }, { name:'Forma' }, { name:'Vリフト' },
  ]},
  { name:'ダーマペン' },
  { name:'サブシジョン' },
  { name:'ピーリング', children:[
    { name:'マッサージピール' }, { name:'ミラノピール' }, { name:'ララドクター' }, { name:'その他のピーリング' },
    { name:'リバースピール' }, { name:'サリチル酸ピール' },
  ]},
  { name:'ハイドラ' },
  { name:'ケアシス', children:[
    { name:'レナトスTa+' }, { name:'ペップビュー' }, { name:'エクソソーム（ケアシス）' }, { name:'その他の薬剤' },
  ]},
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

// カテゴリの院スコープ：指定した院でのみ表示・振り分け可能にする。未指定カテゴリは全院共通。
const CATEGORY_CLINICS = {
  'サブシジョン': ['CLINIC3'],   // サブシジョンは福岡のみ
};

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
const REMOVE_CATS = new Set(['水光注射','ヴェルベットスキン','スーパーヴェルベットスキン','ビタミンスレッド','サーモンスレッド','オーダーメイドスレッド','CP-25','ツヤ肌セット','ニキビ撃退セット','美容点滴・注射','高濃度ビタミンC点滴','エクソソーム点滴','NMN点滴','白玉注射','疲労回復点滴']);

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
      const d = dates[my];
      const vals = await fetchDay(token, clinic, d);
      if (vals.length){ for (const v of vals) v._day = d; values.push(...vals); }  // 日別サマリー用に会計日を付与
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

/* 施術(optionId)単位の内訳。カテゴリ別ダッシュボードの「中身」表示用（集計コアは変更せず読み取りのみ）。
   ・売上 = 同じルール（契約 or 単発genuine、消化除外）の合算 → 合計はカテゴリ売上と一致
   ・件数 = aggregateClinic と同じ数え方（会計ごとに数える。同一会計内で同じ施術は1件）。
           同じ人が別の日に同じ施術を受けたら2件＝「回数」であって頭数ではない。
           → 内訳の件数合計 = カード/月別サマリーの総件数 と一致する。
   ※ユニーク患者数(頭数)は公式集計テーブル(aggregateByKind)だけが扱う。 */
function aggregateItems(values, masterMap){
  const byOpt = {};
  (values||[]).forEach(v=>{
    const counted = new Set();   // 会計内の重複排除（aggregateClinic の countKey と同じ考え方）
    (v.paymentItems||[]).forEach(it=>{
      const contract = Number(it.courseContractAmountWithTax)||0;
      const digest   = Number(it.courseDigestionAmountWithTax)||0;
      const genuine  = Number(it.genuinePriceWithTax)||0;
      if (contract>0) return;                                  // コース契約は計上しない（消化時に計上）
      const sales = digest>0 ? Math.floor(digest) : Math.floor(genuine);
      if (sales===0) return;                                   // 売上が立たない行は件数にも数えない
      const opt = String(it.optionId||'').trim();
      let cat, typ;
      if (opt && masterMap[opt]){
        cat = masterMap[opt].category; typ = masterMap[opt].type;
        // 「除外」も内訳には含める（確認・修正できるように）
      } else { cat = UNCLASSIFIED; typ = '通常'; }
      if (!TYPES_NEW.includes(typ)) typ='通常';
      const k = opt || ('noopt|' + (it.name||''));
      if (!byOpt[k]) byOpt[k] = { optionId:opt, name:it.name||'', apiCat:it.category||'', category:cat, type:typ, count:0, sales:0 };
      byOpt[k].sales += sales;
      if (!counted.has(k)){ byOpt[k].count++; counted.add(k); }
    });
  });
  return Object.values(byOpt)
    .map(o=>({ optionId:o.optionId, name:o.name, apiCat:o.apiCat, category:o.category, type:o.type, count:o.count, sales:o.sales }))
    .sort((a,b)=> b.sales - a.sales);
}

/* ====================== 公式画面(medical-force)準拠の集計 ======================
   medical-force の公式集計画面と同じ「個数・消化回数・人数・売上」を kind 別に出す。金額ロジックには影響しない。
     個数=消化でない明細の数量(quantity)合計（単発＋コース契約）／消化回数=消化(courseDigestion>0)の数量合計
     人数=その行(kind)の明細を持つユニーク患者数(visitorId)／売上=消化計上（金額と同一） */
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
      // 個数・消化回数は 施術/薬剤/物品 のみ（その他＝前受金・返金・調整は公式でも0）
      if (row !== 'その他'){ if (digest>0) g.shouka += qty; else g.kosuu += qty; }
      // 売上は全行で消化計上（金額ロジックと同一）
      g.sales += contract>0 ? 0 : (digest>0 ? Math.floor(digest) : Math.floor(genuine));
      // 人数：施術/薬剤/物品は価格フィールドのある行のみ、その他は kind 空欄を除外
      const person = (row === 'その他') ? !!it.kind : (it.genuinePriceWithTax !== undefined);
      if (vis && person) g._ppl.add(vis);
    });
  });
  return OFFICIAL_ROWS.map(k=>({ kind:k, kosuu:R[k].kosuu, shouka:R[k].shouka, ninzuu:R[k]._ppl.size, sales:R[k].sales }));
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
    _day: v._day,                              // 会計日(YYYY-MM-DD)。日別サマリー用（旧キャッシュには無い）
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
  masterListInvalidAt = Date.now(); // マスタ画面キャッシュも無効化（施術一覧が増える可能性）
}
function cacheExists(clinicKey, year, month){ return fs.existsSync(cacheFile(clinicKey, year, month)); }

// 生データを取得。
//  refresh=false（既定）: キャッシュ(=ローカルDB)があれば即返す。当月も同じ＝2回目以降は速い。
//  refresh=true       : APIから取り直してキャッシュを更新（「最新取得」ボタン用）。
async function getValues(clinicKey, year, month, refresh){
  if (!refresh){
    const j = await readRawFull(clinicKey, year, month);
    // enrich済み or データが空の月はキャッシュを使う。データはあるが旧形式(kind/visitorId無し)の月だけ自動で取り直す
    if (j && (isEnriched(j.values) || (j.values||[]).length===0)) return { values:j.values, cached:true, fetchedAt:j.fetchedAt };
    if (j) console.log(`  自動再取得(旧形式): ${clinicKey} ${year}/${month}`);
  }
  const clinic = getClinic(clinicKey);
  const values = await fetchClinicMonth(clinic, year, month);
  await writeRaw(clinicKey, year, month, values);
  return { values, cached:false, fetchedAt:new Date().toISOString() };
}

/* ====================== キーワード自動サジェスト ====================== */
const MEDIA_KW = ['カンナム','キレイパス','ホットペッパー','HPB','トリビュー','くまポン','くまぽん'];
const CP_KW    = ['キャンペーン','ゲリラ','フェア','感謝祭','スキンチケット','CP'];

// 各カテゴリにマッチさせる別名キーワード（表記揺れ対策）。施術名/APIカテゴリに含まれたら近いと判定。
const CATEGORY_ALIAS = {
  'ポテンツァ':['ポテンツァ','POTENZA','CP-25','CP25','ポテ'],   // CP-25/ポテ短縮も拾う（子薬剤を正しくポテンツァ配下へ）
  'フォトフェイシャル':['フォトフェイシャル','フォトフェイス','フォト','IPL','ステラ','M22'],
  'アクネフォト':['アクネフォト','アクネ'],
  '脱毛':['脱毛'],
  'ピコレーザー':['ピコレーザー','ピコ'],
  'ピコスポット':['ピコスポット','ピコS','スポット','シミ取り','シミ'],
  'ピコトーニング':['ピコトーニング','ピコトーン','ピコT'],
  'ピコフラクショナル':['ピコフラクショナル','ピコフラク','ピコF'],
  'ピコダブル':['ピコダブル','ピコW'],
  'デンシティ':['デンシティ'],
  'ハイコックス':['ハイコックス','ハイドラコックス','コックス','メソガン','ハイコ'],
  'ボトックス':['ボトックス','ボツリヌス','ボツ'],
  'ヒアルロン酸':['ヒアルロン'],
  '肌育注射':['肌育','プロファイロ','水光','スキンブースター'],
  'スネコスパフォルマ':['スネコスパフォルマ','パフォルマ'],
  'リジュランi':['リジュランi','リジュランアイ'],
  'リジュランHB Plus':['リジュランHB','HBPlus'],
  'プルリアルデンシファイ':['プルリアル','デンシファイ'],
  'ジャルプロスーパーハイドロ':['ジャルプロ','スーパーハイドロ'],
  'オーロラ注射':['オーロラ'],
  'ジュベルック（肌育注射）':['ジュベルック'],
  'リズネ':['リズネ'],
  'ショートスレッド':['ショートスレッド','スレッド','糸','ビタミンスレ','サーモン','オーダーメイドスレ'],
  '脂肪溶解注射':['脂肪溶解','脂肪','BNLS','カベリン','チンセラ','FatX','fatX','Fat X','fat X','FATX'],
  'HIFU':['HIFU','ハイフ','ウルトラフォーマー','ソノクイーン'],
  'ルメッカ':['ルメッカ'],
  'インモード':['インモード','ファクトラ','モルフェ'],
  'MiniFX':['MiniFX','ミニFX'],
  'Forma':['Forma','フォルマ'],
  'Vリフト':['Vリフト'],
  'ダーマペン':['ダーマペン','ヴェルベットスキン','ヴェルベット'],
  'ピーリング':['ピーリング','ピール'],
  'マッサージピール':['マッサージピール','コスメラン','TCA'],
  'ミラノピール':['ミラノ','ミラノリ'],
  'ララドクター':['ララドクター'],
  'その他のピーリング':['ハイドラピール'],
  'リバースピール':['リバースピール','リバース'],
  'サリチル酸ピール':['サリチル酸','サリチル'],
  'ハイドラ':['ハイドラフェイシャル','ハイドラ'],
  'ケアシス':['ケアシス'],
  'レナトスTa+':['レナトス'],
  'ペップビュー':['ペップビュー','ペップ'],
  'エクソソーム（ケアシス）':['エクソソーム','エクソ'],
  '物販':['《物販》','物販','物品販売','コスメ販売','スキンケア販売'],
  // ポテンツァ サブカテゴリ
  'S-16':['S-16','S16'],
  'S-25':['S-25','S25'],
  'A1-15':['A1-15','A115','A1'],
  'ダイヤモンド':['ダイヤモンド','ダイヤ'],
  // CP-25 薬剤
  'BENEV':['BENEV','ベネブ'],
  'マックーム':['マックーム','マクーム'],
  'リジュラン':['リジュラン'],
  'ジュベルック':['ジュベルック'],
  'ボトックス（ポテンツァ）':['アラガン'],
  'エクソソーム':['エクソソーム','エクソ'],
  'スネコス':['スネコス'],
  'デイリースペシャル(マックーム+エクソソーム)':['デイリースペシャル'],
  'デイリープレミアム(ジュベルック+エクソソーム)':['デイリープレミアム'],
  'ACRS':['ACRS'],
  // ハイコックス サブカテゴリ
  'スキンボトックス':['スキンボトックス','スキンボト'],
  'ジュベリジュ':['ジュベリジュ'],
  'スノーフラワーブルーム':['スノーフラワーブルーム','スノーフラワー','SNOW FLOWER','SNOWFLOWER'],
  'ジュベリジュ（ポテンツァ）':['ジュベリジュ'],
  'スノーフラワーブルーム（ポテンツァ）':['スノーフラワーブルーム','スノーフラワー','SNOW FLOWER','SNOWFLOWER'],
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
// 表記ゆれ吸収：全角→半角(NFKC)、各種ハイフン/ダッシュを "-" に統一、小文字化。
// 例: "Ｓ－２５" "S‐25"(U+2010) "s25" → いずれも "s-25"/"s25" として一致できる。※長音ー(U+30FC)は語の一部なので変換しない。
function norm(s){
  return String(s||'').normalize('NFKC').replace(/[‐-―−]/g, '-').toLowerCase();
}
// このノード名の別名が施術名に含まれれば、一番長い一致の文字数（具体的なほど高い）
function ownScore(text, name){ const T=norm(text); let s=0; for (const kw of aliasesOf(name)){ const k=norm(kw); if (k && T.indexOf(k)>=0) s=Math.max(s,k.length); } return s; }
// ルート→葉の「おすすめパス」。自ノード＋先祖の一致を合算し、親の言葉も当たるパスを優先（例:ハイコックス系）。
// セット施術の「主メニュー」優先度。強い順。ここに無いカテゴリは中間、付け合わせは最弱。
const CATEGORY_PRIORITY = ['ポテンツァ','ピコレーザー','ハイコックス','フォトフェイシャル','アクネフォト','ボトックス'];
const ADDON_CATS = new Set(['ハイドラ','ケアシス']);   // 付け合わせ：セットでは負ける（物販は含めない）
function rootOf(n){ let r=n; while(NODE_INFO[r] && NODE_INFO[r].parent) r=NODE_INFO[r].parent; return r; }
// 主メニュー加点：強い順に大きめの加点（ポテンツァ=6 … ボトックス=1）。リスト外は0。
// 加点はスコアに乗せるので、セットでは強い方に寄りつつ、単独の具体的一致（例:アクネフォト）は壊さない。
function highBonus(root){ const i = CATEGORY_PRIORITY.indexOf(root); return i>=0 ? (CATEGORY_PRIORITY.length - i) : 0; }
// そのノードに当たった一番長い別名（文字列）。部分一致判定に使う。
function ownMatch(text, name){ const T=norm(text); let best=''; for (const kw of aliasesOf(name)){ const k=norm(kw); if (k && T.indexOf(k)>=0 && k.length>best.length) best=k; } return best; }

function suggestBestPath(name, apiCat){
  const text = String(name||'') + ' ' + String(apiCat||'');
  // 候補ノードを収集（当たった語 mk・スコア sc・ルート・深さ）
  const cands = [];
  ALL_NODES.forEach(n=>{
    const mk = ownMatch(text, n);
    if (!mk) return;
    let sc=0, cur=n; while(cur){ sc+=ownScore(text,cur); cur=NODE_INFO[cur].parent; }  // 先祖ぶん加点
    cands.push({ n, mk, sc, root:rootOf(n), depth:NODE_INFO[n].depth });
  });
  if (!cands.length) return [];
  // 部分一致（自分の当たり語が、他候補のより長い当たり語に含まれる）は優先加点を無効化。
  //  例「スネコスパフォルマ」に対し'スネコス'は部分一致→ポテンツァ加点を効かせない／'フォト'⊂'アクネフォト' 等
  cands.forEach(c=>{ c.partial = cands.some(o=> o!==c && o.mk.length>c.mk.length && o.mk.indexOf(c.mk)>=0); });
  let best=null, bestEff=-Infinity, bestDepth=-1;
  cands.forEach(c=>{
    const bonus = c.partial ? 0 : highBonus(c.root);
    const eff = c.sc + bonus - (ADDON_CATS.has(c.root) ? 10000 : 0); // 主メニュー加点／付け合わせは大幅減点
    if (eff>bestEff || (eff===bestEff && c.depth>bestDepth)){ best=c.n; bestEff=eff; bestDepth=c.depth; } // 同点は深い方
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
  const T = norm(String(name||'') + ' ' + String(apiCat||''));
  const scored = cats.map((cat,i)=>{
    let score = 0;
    for (const kw of aliasesOf(cat)){
      const k = norm(kw);
      if (k && T.indexOf(k) >= 0) score = Math.max(score, k.length); // 長い一致ほど具体的＝高スコア
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
    categoryClinics: CATEGORY_CLINICS,   // カテゴリの院スコープ（未指定は全院）
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

// マスタ画面（全月走査＋おすすめ計算）の重い部分を院ごとにキャッシュ。生データ更新時のみ作り直す。
// 振り分け（カテゴリ・種別）は毎回最新のmasterMapで反映するので、割り当て変更は即座に出る。
const masterListCache = new Map();   // clinicKey -> { byOpt, months, ts }
let masterListInvalidAt = 0;

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
    // 「件数」列は会計ベースの件数（1会計内で同じ施術×種別は1と数える）
    const allCount = byCat ? Object.values(byCat).reduce((s,c)=>s+c.count,0) : 0;
    // カテゴリ別の内訳（フロントの絞り込み用）
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

/* 日別サマリー：選択月の各日(1日〜末日/当月は今日まで)を、月別と同じ形（種別内訳・カテゴリ別cats付き）で返す。
   会計日 _day は取得時に付与。旧キャッシュ(=_day無し)のときは available:false を返してフロントで案内表示する。 */
function buildDailyBreakdown(values, masterMap, year, month){
  const hasDay = (values||[]).some(v=>v && v._day);
  if (!hasDay) return { available:false, rows:[] };   // 日付なし＝再取得が必要
  const byDay = {};
  values.forEach(v=>{ const d=v&&v._day; if(!d) return; (byDay[d]=byDay[d]||[]).push(v); });
  const first = new Date(year, month-1, 1);
  const today = new Date();
  const isCur = (year===today.getFullYear() && month===today.getMonth()+1);
  const last  = isCur ? today : new Date(year, month, 0);
  const rows = [];
  for (let cur=new Date(first); cur<=last; cur.setDate(cur.getDate()+1)){
    const ds   = fmtDate(cur);
    const vals = byDay[ds] || [];
    const byCat = aggregateClinic(vals, masterMap, null);
    const sum   = sumByCat(byCat);
    const allSales = Object.values(byCat).reduce((s,c)=>s+c.sales,0);
    const allCount = Object.values(byCat).reduce((s,c)=>s+c.count,0);   // 会計ベースの件数
    const cats = {};
    Object.keys(byCat).forEach(cat=>{
      if (cat===UNCLASSIFIED || cat===EXCLUDED) return;
      const c = byCat[cat];
      cats[cat] = { sales:c.sales, count:c.count, 通常:c['通常'], CP:c['CP'], 媒体:c['媒体'],
        count_通常:c['count_通常']||0, count_CP:c['count_CP']||0, count_媒体:c['count_媒体']||0 };
    });
    rows.push({
      label:`${('0'+(cur.getMonth()+1)).slice(-2)}/${('0'+cur.getDate()).slice(-2)}`,
      hasData: vals.length>0,
      sales:allSales, count:allCount,
      通常:sum.通常, CP:sum.CP, 媒体:sum.媒体,
      count_通常:sum.count_通常, count_CP:sum.count_CP, count_媒体:sum.count_媒体,
      cats,
    });
  }
  return { available:true, rows };
}

async function getDashboard(clinicKey, year, month, refresh){
  // 既定はキャッシュ優先（=速い）。refresh=true のときだけAPI再取得。
  const { values, cached, fetchedAt } = await getValues(clinicKey, year, month, refresh);
  const masterMap = loadMasterMap();
  const pend = {};   // 振り分け可能な未分類（optionId有り・売上≠0）だけを集める
  const byCat = aggregateClinic(values, masterMap, pend);
  const itemsData = aggregateItems(values, masterMap);   // 施術単位の内訳（件数は会計ベース＝総件数と一致）
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
    items: itemsData,  // 施術(optionId)単位の内訳
    monthly: await buildMonthlyTrend(clinicKey, year, month, byCat),
    daily: buildDailyBreakdown(values, masterMap, year, month),
    official: { rows: aggregateByKind(values), enriched: isEnriched(values) },   // 公式画面準拠（個数/消化回数/人数/売上）
    rankings,
    pendingCount: Object.keys(pend).length,   // 実際に振り分けできる未分類の件数（キャンセル料・払戻金などoptionId無しは除く）
  };
}

/* 期間集計（別ページ /period 用）。任意の日付範囲 from〜to（YYYY-MM-DD）を _day で絞って集計。
   月をまたいでもOK（範囲が触れる各月のキャッシュを読み、_day で範囲内だけ抽出して結合）。
   数え方はダッシュボードと同一（aggregateClinic / aggregateItems ＝ 会計ベース件数）。 */
async function getRange(clinicKey, from, to){
  if (!clinicKey) throw new Error('院を指定してください');
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from||'') || !ymd.test(to||'')) throw new Error('日付は YYYY-MM-DD 形式で指定してください');
  if (from > to){ const t=from; from=to; to=t; }   // 逆順で来ても許容
  const masterMap = loadMasterMap();
  // 範囲が触れる月を列挙（シリアル年月で回す）
  const [fy,fm] = from.split('-').map(Number);
  const [ty,tm] = to.split('-').map(Number);
  const months = [];
  for (let s = fy*12+(fm-1); s <= ty*12+(tm-1); s++) months.push([Math.floor(s/12), (s%12)+1]);
  if (months.length > 25) throw new Error('期間が長すぎます（最大24か月程度にしてください）');
  const values = [];
  const monthsNoDay = [];   // 日付なし＝旧キャッシュ。フロントで「要再取得」案内に使う
  for (const [y,m] of months){
    let vs;
    try { vs = (await getValues(clinicKey, y, m, false)).values || []; }
    catch(e){ monthsNoDay.push(`${y}/${m}(取得失敗)`); continue; }
    if (vs.length && !vs.some(v=>v && v._day)){ monthsNoDay.push(`${y}/${m}`); continue; }
    for (const v of vs){ if (v && v._day && v._day>=from && v._day<=to) values.push(v); }
  }
  const byCat = aggregateClinic(values, masterMap, null);
  const items = aggregateItems(values, masterMap);
  const categories = Object.keys(byCat).map(cat=>({
    category:cat, sales:byCat[cat].sales, count:byCat[cat].count,
    通常:byCat[cat]['通常'], CP:byCat[cat]['CP'], 媒体:byCat[cat]['媒体'],
    count_通常:byCat[cat]['count_通常']||0, count_CP:byCat[cat]['count_CP']||0, count_媒体:byCat[cat]['count_媒体']||0,
  })).sort((a,b)=>{
    const rk = c => c.category===EXCLUDED ? 2 : c.category===UNCLASSIFIED ? 1 : 0;
    if (rk(a)!==rk(b)) return rk(a)-rk(b);
    return b.sales - a.sales;
  });
  const totalSales = categories.reduce((s,c)=>s+c.sales,0);
  const totalCount = categories.reduce((s,c)=>s+c.count,0);
  const cnt = t => categories.reduce((s,c)=>s+(c['count_'+t]||0),0);
  return {
    clinic: getClinic(clinicKey).name, clinicKey, from, to, months: months.length,
    summary: {
      totalSales, totalCount,
      normalSales: categories.reduce((s,c)=>s+c['通常'],0),
      cpSales:     categories.reduce((s,c)=>s+c.CP,0),
      mediaSales:  categories.reduce((s,c)=>s+c.媒体,0),
      count_通常: cnt('通常'), count_CP: cnt('CP'), count_媒体: cnt('媒体'),
      avgPrice: totalCount ? Math.round(totalSales/totalCount) : 0,
      accounts: countVisits(values),   // 会計数（来院数）
    },
    categories, items, monthsNoDay,
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
  // category が null/★未分類 のマスタエントリは「未振り分け」として扱う
  // （振り分けカードに表示されるよう、これらを masterMap から外したコピーを使う）
  const effectiveMap = {};
  Object.keys(masterMap).forEach(k=>{
    if (masterMap[k].category && masterMap[k].category !== UNCLASSIFIED) effectiveMap[k] = masterMap[k];
  });
  const pending = {};
  if (scope==='all'){
    const months = await listCachedMonths(clinicKey);
    for (const {year:y, month:m} of months){
      const raw = await readRaw(clinicKey, y, m); if (raw) aggregateClinic(raw, effectiveMap, pending);
    }
  } else {
    const { values } = await getValues(clinicKey, year, month, false);
    aggregateClinic(values, effectiveMap, pending);
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
  // 重い部分（全月走査で施術一覧を作り、おすすめパスを計算）はキャッシュ。生データ更新時のみ作り直す。
  let entry = masterListCache.get(clinicKey);
  if (!entry || entry.ts < masterListInvalidAt){
    const byOpt = {};
    const months = await listCachedMonths(clinicKey);
    for (const {year:y, month:m} of months){
      const raw = await readRaw(clinicKey, y, m);
      if (!raw) continue;
      raw.forEach(v=>(v.paymentItems||[]).forEach(it=>{
        const opt = String(it.optionId||'').trim();
        if (!opt || byOpt[opt]) return;
        // aggregateClinic と同じく sales=0 のアイテムは除外（回数券消化など0円アイテムは集計対象外）
        const digest = Math.floor(+(it.courseDigestionAmountWithTax)||0);
        const genuine = Math.floor(+(it.genuinePriceWithTax)||0);
        if (digest === 0 && genuine === 0) return;
        const name = it.name||'', apiCat = it.category||'';
        byOpt[opt] = { optionId:opt, name, apiCat, suggestPath: suggestBestPath(name, apiCat) };
      }));
    }
    entry = { byOpt, months: months.length, ts: Date.now() };
    masterListCache.set(clinicKey, entry);
  }
  // 振り分け（カテゴリ・種別）は毎回最新のmasterMapで反映 → 割り当て変更は即座に出る
  const rows = Object.values(entry.byOpt).map(o=>{
    const m = masterMap[o.optionId];
    return { optionId:o.optionId, name:o.name, apiCat:o.apiCat,
      category: m ? m.category : UNCLASSIFIED,
      type:     m ? m.type : suggestType(o.name+' '+o.apiCat),
      suggestPath: o.suggestPath,
      suggestCategory: o.suggestPath.length ? o.suggestPath[o.suggestPath.length-1] : '' };   // おすすめ（葉まで）
  }).sort((a,b)=> String(a.name).localeCompare(String(b.name),'ja'));
  return { clinic: getClinic(clinicKey).name, clinicKey, rows,
    categoryTree: CATEGORY_TREE, types: TYPES_NEW, monthsScanned: entry.months };
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

/* ====================== ログイン認証（Googleログイン・指定メールのみ許可） ======================
   環境変数 GOOGLE_CLIENT_ID と ALLOWED_EMAILS の両方があるときだけ有効(AUTH_ON)。
   未設定なら AUTH_ON=false ＝ 従来どおり誰でも閲覧可（設定を入れた瞬間に認証が有効になる）。 */
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID||'').trim();
const ALLOWED_EMAILS   = (process.env.ALLOWED_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET   = (process.env.SESSION_SECRET||'').trim() || crypto.randomBytes(32).toString('hex');
const AUTH_ON          = !!(GOOGLE_CLIENT_ID && ALLOWED_EMAILS.length);
const SESSION_MAXAGE   = 7*86400;   // セッション有効期間（秒）＝7日

function isAllowed(email){ return ALLOWED_EMAILS.includes(String(email||'').trim().toLowerCase()); }
function signSession(email){
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now()+SESSION_MAXAGE*1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifySession(token){
  if (!token || token.indexOf('.')<0) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length!==expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let d; try { d = JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); } catch(e){ return null; }
  if (!d || !d.exp || d.exp < Date.now() || !isAllowed(d.email)) return null;   // 期限切れ or 許可リストから外れたら無効
  return d;
}
function parseCookies(req){
  const out={}; (req.headers.cookie||'').split(';').forEach(p=>{ const i=p.indexOf('='); if(i>0) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); });
  return out;
}
function currentUser(req){ return AUTH_ON ? verifySession(parseCookies(req).sid) : { email:'(auth off)' }; }
function sessionCookie(token){ return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAXAGE}`; }
function clearCookie(){ return 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'; }
function redirect(res, loc){ res.writeHead(302, { Location: loc }); res.end(); }

// Google IDトークンを検証（tokeninfoエンドポイント利用・外部ライブラリ不要）
async function verifyGoogleIdToken(idToken){
  if (!idToken) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const p = await r.json();
    if (p.aud !== GOOGLE_CLIENT_ID) return null;                       // このアプリ向けのトークンか
    if (p.email_verified!=='true' && p.email_verified!==true) return null;
    return p;   // { email, name, ... }
  } catch(e){ return null; }
}
function loginPage(){
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン｜3院売上集計ダッシュボード</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f3f4;display:grid;place-items:center;min-height:100vh;margin:0;color:#4a3a3d}
.card{background:#fff;padding:40px 44px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center;max-width:340px}
h1{font-size:18px;margin:0 0 6px}.sub{font-size:13px;color:#9a8a8d;margin:0 0 24px;line-height:1.6}
.gbtn{display:flex;justify-content:center}#msg{color:#c0392b;font-size:13px;margin-top:16px;min-height:18px}</style></head>
<body><div class="card">
  <h1>3院売上集計ダッシュボード</h1>
  <p class="sub">許可されたGoogleアカウントで<br>ログインしてください</p>
  <div id="g_id_onload" data-client_id="${GOOGLE_CLIENT_ID}" data-callback="onSignIn" data-auto_prompt="false"></div>
  <div class="gbtn"><div class="g_id_signin" data-type="standard" data-size="large" data-theme="outline" data-text="signin_with" data-shape="pill"></div></div>
  <div id="msg"></div>
</div>
<script>
function onSignIn(resp){
  fetch('/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:resp.credential})})
   .then(r=>r.json()).then(d=>{ if(d.ok){ location.href='/'; } else { document.getElementById('msg').textContent = d.error||'このアカウントは許可されていません。'; } })
   .catch(()=>{ document.getElementById('msg').textContent='ログインに失敗しました。'; });
}
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const q = u.query;
  try {
    // --- ログイン認証（AUTH_ON のときだけ働く。未設定なら素通り＝従来どおり）---
    if (u.pathname==='/login'){
      return AUTH_ON ? send(res,200,loginPage(),'text/html; charset=utf-8') : redirect(res,'/');
    }
    if (req.method==='POST' && u.pathname==='/auth/google'){
      if (!AUTH_ON) return send(res,200,{ok:true});
      const body = await readBody(req);
      const p = await verifyGoogleIdToken(body.credential);
      if (!p) return send(res,401,{ok:false,error:'ログインを確認できませんでした。'});
      if (!isAllowed(p.email)) return send(res,403,{ok:false,error:'このアカウント（'+p.email+'）は許可されていません。'});
      res.setHeader('Set-Cookie', sessionCookie(signSession(p.email)));
      return send(res,200,{ok:true});
    }
    if (u.pathname==='/auth/logout'){
      res.setHeader('Set-Cookie', clearCookie());
      return redirect(res,'/login');
    }
    // 上記(ログイン関連)以外は、未ログインなら弾く
    if (AUTH_ON && !currentUser(req)){
      if (u.pathname.startsWith('/api/')) return send(res,401,{error:'ログインが必要です'});
      return redirect(res,'/login');
    }

    if (req.method==='GET' && (u.pathname==='/' || u.pathname==='/index.html')){
      return send(res, 200, fs.readFileSync(path.join(ROOT,'index.html'),'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method==='GET' && (u.pathname==='/period' || u.pathname==='/period.html')){   // 期間集計（別ページ）
      return send(res, 200, fs.readFileSync(path.join(ROOT,'period.html'),'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method==='GET' && u.pathname==='/master'){   // 施術マスタ（index.html を配信し、フロントが自動で開く）
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
    if (u.pathname==='/api/range'){   // 期間集計（別ページ /period 用）
      return send(res, 200, await getRange(q.clinic, q.from, q.to));
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

// 「くまぽん」施術の種別を媒体に統一（キーワードがカタカナ限定で通常のままだった分を修正）。起動時・冪等。
async function migrateKumaponMedia(){
  const changed = [];
  MASTER_ROWS.forEach(r=>{
    const nm = String(r.name||''); const cat = String(r.category||'').trim();
    if ((nm.includes('くまぽん')||nm.includes('くまポン')) && !['物販','除外','★未分類'].includes(cat) && r.type!=='媒体'){
      r.type = '媒体'; changed.push(r);
    }
  });
  if (!changed.length) return;
  if (SB_ON){ try { await sbUpsert('mfdash_master', changed.map(toSbMaster)); } catch(e){ console.error('くまぽん種別 SB書込失敗:', e.message); } }
  localWriteMaster(MASTER_ROWS);
  console.log('  → くまぽん種別を媒体に修正:', changed.length, '件');
}

// 親カテゴリにいた特定名の施術を子カテゴリへ移す（例: 肌育注射内のリズネ → リズネ）。起動時・冪等。
async function migrateNameToChild(parentCat, nameKw, childCat){
  const changed = [];
  MASTER_ROWS.forEach(r=>{
    if (String(r.category||'').trim()===parentCat && String(r.name||'').includes(nameKw)){ r.category = childCat; changed.push(r); }
  });
  if (!changed.length) return;
  if (SB_ON){ try { await sbUpsert('mfdash_master', changed.map(toSbMaster)); } catch(e){ console.error('子カテゴリ移行 SB書込失敗:', e.message); } }
  localWriteMaster(MASTER_ROWS);
  console.log('  → '+parentCat+'内の「'+nameKw+'」を'+childCat+'へ:', changed.length, '件');
}

// 廃止カテゴリに入っている施術を未分類へ戻す（マスタから割り当てを外す）。起動時・冪等。
async function migrateUnassignCats(cats){
  const set = new Set(cats);
  const changed = [];
  MASTER_ROWS.forEach(r=>{
    if (set.has(String(r.category||'').trim())){ r.category = UNCLASSIFIED; changed.push(r); }
  });
  if (!changed.length) return;
  if (SB_ON){ try { await sbUpsert('mfdash_master', changed.map(toSbMaster)); } catch(e){ console.error('未分類戻し SB書込失敗:', e.message); } }
  localWriteMaster(MASTER_ROWS);
  masterListInvalidAt = Date.now();   // マスタ画面キャッシュを無効化
  console.log('  → 未分類へ戻す:', cats.join('/'), changed.length, '件');
}

// 廃止した子カテゴリを親へ統合（例: ヴェルベットスキン等 → ダーマペン）。起動時・冪等。
async function migrateMergeCats(fromCats, toCat){
  const from = new Set(fromCats);
  const changed = [];
  MASTER_ROWS.forEach(r=>{
    if (from.has(String(r.category||'').trim())){ r.category = toCat; changed.push(r); }
  });
  if (!changed.length) return;
  if (SB_ON){ try { await sbUpsert('mfdash_master', changed.map(toSbMaster)); } catch(e){ console.error('カテゴリ統合 SB書込失敗:', e.message); } }
  localWriteMaster(MASTER_ROWS);
  console.log('  → カテゴリ統合:', fromCats.join('/'), '→', toCat, changed.length, '件');
}

(async () => {
  try { await loadState(); }
  catch(e){ console.error('保存データの読込に失敗（ローカルにフォールバック）:', e.message); MASTER_ROWS = localReadMaster(); CAT_ARR = localReadCats(); if(!CAT_ARR.length) CAT_ARR = DEFAULT_CATEGORIES.slice(); }
  try { await migrateHicox(); } catch(e){ console.error('ハイコックス付け替え失敗:', e.message); }
  try { await migrateMergeCats(['ヴェルベットスキン','スーパーヴェルベットスキン'], 'ダーマペン'); } catch(e){ console.error('ダーマペン統合失敗:', e.message); }
  try { await migrateMergeCats(['ビタミンスレッド','サーモンスレッド','オーダーメイドスレッド'], 'ショートスレッド'); } catch(e){ console.error('ショートスレッド統合失敗:', e.message); }
  try { await migrateKumaponMedia(); } catch(e){ console.error('くまぽん種別修正失敗:', e.message); }
  try { await migrateNameToChild('肌育注射', 'リズネ', 'リズネ'); } catch(e){ console.error('リズネ子カテゴリ移行失敗:', e.message); }
  try { await migrateMergeCats(['CP-25'], 'ポテンツァ'); } catch(e){ console.error('CP-25統合失敗:', e.message); }
  try { await migrateUnassignCats(['ツヤ肌セット','ニキビ撃退セット']); } catch(e){ console.error('セット系未分類戻し失敗:', e.message); }
  try { await migrateMergeCats(['美容点滴・注射','高濃度ビタミンC点滴','エクソソーム点滴','NMN点滴','白玉注射','疲労回復点滴'], EXCLUDED); } catch(e){ console.error('美容点滴・注射 除外移行失敗:', e.message); }
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
