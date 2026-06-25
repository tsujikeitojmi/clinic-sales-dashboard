# Claude Code 引き継ぎ — 3院売上集計 GASダッシュボード

## ゴール

医療法人の3院（心斎橋・新宿・福岡。将来 名古屋も）の売上を、medical-force APIから取得して
施術カテゴリ別に集計し、**GASのHTML Serviceでダッシュボード表示する**ツールを作る。

お手本UI（既存の別ツールのスクショ）と同等の見た目・機能を目指す:
- 左サイドバー: 院切り替え ＋ 施術カテゴリ一覧
- サマリーカード×4（累計粗利 / 累計施術数 / 前回実施 / 月CP・ゲリラ 等）
- 月別グラフ（棒＋折れ線。Chart.js想定）
- ランキング（粗利TOP / 原価率TOP / 予約数TOP 等）

実装は GAS（`Code.gs` ＋ `index.html`）。`script.google.com/macros/.../exec` でデプロイして使う。
ローカルではなくGASエディタに貼る前提なので、コードはコピペしやすい単位で。

---

## 最重要: 集計ロジック（検証で確定済み・変更しないこと）

medical-force の `GET /developer/daily-accounts` から会計実績を取得し、各会計の
`paymentItems[]` を以下のルールで集計する。**心斎橋5月でMF公式画面と照合し、物品・返金・薬剤は
ほぼ完全一致、施術の1.5%差も「契約日計上 vs MF消化計上」の方針差と説明済み。バグなし。**

### 認証
- 院ごとに client_id / client_secret / clinic_id。トークンは院に紐づく（有効期限1日）。
- Script Properties に `CLINIC1_CLIENT_ID` 等（CLINIC1=心斎橋, 2=新宿, 3=福岡）。
- `SPREADSHEET_ID` も Script Properties。

### 取得
- `daily-accounts` は epoch_from〜epoch_to が**最大31日**。**1日ずつ取得**して結合するのが安全
  （月一括だと「31日ちょうど」で `Unexpected error occurred` になることがある）。

### 金額（アイテム単位）
```
contract = courseContractAmountWithTax
digest   = courseDigestionAmountWithTax
genuine  = genuinePriceWithTax

if contract > 0:                      # ① 契約（お金が入った日）
    sales = round(contract)
elif digest > 0:                      # ② コース消化（過去計上済み）
    → 集計対象外（売上にも件数にも入れない）
else:                                 # ③ 単発購入
    sales = round(genuine)

if sales <= 0: スキップ
```
- **按分しない**（genuine が既に割引適用後の実額）。
- 前受金（advancePaymentTransactionPriceWithTax）の会計は、施術アイテムはそのまま計上、
  支払い方法行（name空・genuine無し）は自然にスキップされる。二重計上なし（検証済み）。
- 返金・その他のマイナス売上もそのまま計上（MFと一致）。

### 件数
- **同じ会計 × 同じ(カテゴリ, 種別) = 1件**（同会計内で重複排除）。
  例: 脂肪溶解5部位（同会計・同カテゴリ）→ 1件 / 脂肪溶解＋ボトックス → 2件。

### カテゴリの名寄せ（重要・未完成の論点）
- APIの `paymentItems[].category` は院が自由に付けたフォルダ名で、キャンペーン名や日付が混ざり
  表記が揺れる（例: 「6/15〜30日ポテンツァゲリラキャンペーン」も実体はポテンツァ）。
  そのまま集計軸にはできない。
- `optionId` は表記が揺れない安定キー（90/91で充足）。
- 方針: **施術マスタ（optionId → 集計カテゴリ ＋ 種別）** で名寄せ。表に無いものは
  「未分類」に候補つきで吐き出し、人が振り分ける（＝お手本UIのカテゴリ管理に相当）。
- 補助として、施術名/category のキーワードで「候補カテゴリ・候補種別」を自動サジェストし、
  人が確認・修正する方式（手作業を減らす）。1院1か月で未分類 optionId は約1000件規模なので、
  キーワード自動サジェストは必須。

### 種別（通常 / CP / 媒体）
- 媒体KW: カンナム/キレイパス/ホットペッパー/HPB/トリビュー/くまポン 等
- CP KW: キャンペーン/ゲリラ/フェア/感謝祭/スキンチケット 等
- それ以外: 通常
- 施術マスタに種別も持たせ、自動サジェスト＋人が確定。

---

## 検証で確定した事実（参考）

心斎橋 2026年5月（フル月）の kind別 照合:

| kind | 新ロジック | MF公式画面 | 判定 |
|---|---|---|---|
| 施術 | ¥70,705,897 | ¥71,942,672 | 消化計上方針の差（説明済み） |
| 物品 | ¥7,003,188 | ¥7,003,183 | +¥5（端数）ほぼ一致 |
| その他 | -¥17,549 | -¥17,549 | 完全一致 |
| 薬剤 | ¥0 | ¥0 | 一致 |

- 新ロジックは「契約日に計上・消化は除外」（Kei確定方針）。MFは消化の一部を売上計上する模様。
  差は方針差でありバグではない。**新ロジックの定義のまま実装する**。
- 内部検算（reconcileTotals）: 会計の totalWithTax とアイテム積み上げが新宿5月で2160/2230一致、
  残り70件も前受金で説明済み。計算ロジックに穴なし。

---

## 検証済みの集計コア（GAS / これをベースに）

以下は検証で正しさを確認した集計関数。Code.gs にこのロジックを移植し、ダッシュボード用に
「カテゴリ別・種別別・月別・院別」を返す形へ拡張する。

```javascript
const API_BASE_NEW = 'https://api.medical-force.com';
const CLINIC_LIST = [
  { key:'CLINIC1', name:'心斎橋' },
  { key:'CLINIC2', name:'新宿'   },
  { key:'CLINIC3', name:'福岡'   },
];
const TYPES_NEW = ['通常','CP','媒体'];

function getTokenNew(id, secret){
  const res = UrlFetchApp.fetch(`${API_BASE_NEW}/token`, {
    method:'POST', contentType:'application/json',
    payload: JSON.stringify({ client_id:id, client_secret:secret }), muteHttpExceptions:true });
  return JSON.parse(res.getContentText()).access_token;
}

// 1院1か月を1日ずつ取得（31日制約を回避）
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

// 施術マスタ: optionId -> { category, type }
function loadMasterMap(ss){
  const sh = ss.getSheetByName('施術マスタ');
  if (!sh || sh.getLastRow()<2) return {};
  const data = sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  const map = {};
  data.forEach(r=>{
    const opt=String(r[0]||'').trim(), cat=String(r[3]||'').trim(), typ=String(r[4]||'通常').trim();
    if (opt && cat) map[opt]={category:cat, type:typ};
  });
  return map;
}

// 1院ぶん集計（検証済みロジック）
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
          pendingAccum[opt] = { optionId:opt, name:it.name||'', apiCat:it.category||'' };
        }
        cat = '★未分類'; typ = '通常';
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
```

---

## Claude Code への指示（コピペ用）

```
GASのHTML Serviceで、3院売上集計ダッシュボードを作って。
添付スクショと同等のUI（左サイドバーで院・カテゴリ切替、サマリーカード4枚、
月別グラフ=棒+折れ線でChart.js、粗利/原価率/予約数のランキング）。

集計ロジックは引き継ぎ資料の「集計コア」をそのまま使う（検証済み・変更しない）:
- 売上 = 契約額(courseContractAmount) + 単発genuine。消化は除外。按分なし。
- 件数 = 同会計×同カテゴリ=1件。
- daily-accountsは1日ずつ取得（31日制約回避）。
- カテゴリ名寄せは施術マスタ(optionId→カテゴリ+種別)。未登録は「未分類」に候補つきで出す。

成果物:
1. Code.gs … doGet()でindex.htmlを返す。集計関数群。google.script.runで呼ぶAPI関数。
2. index.html … サイドバー+カード+Chart.jsグラフ+ランキング。
3. 「未分類」を人が振り分けるUI（サイドバーから開ける）。キーワードで候補をサジェスト。

まず全体構成を提案 → Code.gsの集計API → index.htmlの骨組み → グラフ → ランキング → 振り分けUI
の順で、動作確認しながら段階的に。
```

### Claude Code に一緒に渡すもの
- このファイル
- お手本ダッシュボードのスクショ
- （あれば）medical-force APIドキュメント

### 注意
- 認証情報（client_secret等）はScript Propertiesに置く。コードに直書きしない。
- GASは実行6分制限。過去数か月の一括集計は月ごと/院ごとに分割するか、集計結果をシートに
  キャッシュして読む設計にすると軽い。
