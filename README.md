# 薬品在庫管理システム - InfinityFree → Cloudflare + Supabase 移行ガイド

## 移行後の構成

```
GitHub リポジトリ
├── index.html         ← フロントエンド (Cloudflare Pages でホスト)
├── manifest.json      ← PWA マニフェスト
├── _redirects         ← Cloudflare Pages ルーティング設定
└── worker/
    ├── index.js       ← バックエンド API (Cloudflare Workers)
    └── wrangler.toml  ← Workers デプロイ設定
```

データベースは **Supabase (PostgreSQL)** を使用します。

---

## STEP 1 — Supabase セットアップ（約10分）

1. https://supabase.com にアクセスし、無料アカウントを作成
2. **New Project** をクリックし、プロジェクト名・パスワードを設定
3. 作成完了後、左メニューの **SQL Editor** を開く
4. `schema.sql` の内容を全てコピーして貼り付け、**Run** をクリック
   - テーブル・インデックス・RPC関数が一括作成されます
5. 左メニュー **Settings → API** を開き、以下をメモ帳に控える
   - **Project URL**（例: `https://xxxxxxxxxxxx.supabase.co`）
   - **service_role** キー（`eyJ...` で始まる長い文字列）

> ⚠️ `service_role` キーは管理者権限を持つため、フロントエンド（index.html）には絶対に埋め込まないこと。Worker の環境変数にのみ設定します。

---

## STEP 2 — GitHub リポジトリ作成（約5分）

1. https://github.com にログインし、**New repository** をクリック
2. リポジトリ名を入力（例: `pharma-stock`）、**Private** を選択して作成
3. ローカルPCでの操作:

```bash
# Git がない場合は先にインストール
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USER/pharma-stock.git
git push -u origin main
```

または GitHub Desktop（GUI）を使っても OK です。

---

## STEP 3 — Cloudflare Workers デプロイ（約10分）

### 3-1. Cloudflare アカウント作成
https://cloudflare.com で無料アカウントを作成

### 3-2. Wrangler CLI インストール
```bash
npm install -g wrangler
wrangler login   # ブラウザが開くので Cloudflare にログイン
```

### 3-3. シークレット変数を設定
```bash
cd worker/
wrangler secret put SUPABASE_URL
# → STEP 1 で控えた Project URL を貼り付けてEnter

wrangler secret put SUPABASE_KEY
# → STEP 1 で控えた service_role キーを貼り付けてEnter
```

### 3-4. Worker をデプロイ
```bash
wrangler deploy
```

デプロイ成功後、以下のような URL が表示されます:
```
https://pharma-api.YOUR_SUBDOMAIN.workers.dev
```
この URL をメモしてください。

---

## STEP 4 — index.html の URL を更新

`index.html` の以下の行を編集:

```javascript
// 変更前
const API = 'https://pharma-api.YOUR_SUBDOMAIN.workers.dev'; // ← Worker の URL に変更

// 変更後（STEP 3-4 で得た URL に書き換え）
const API = 'https://pharma-api.your-subdomain.workers.dev';
```

変更をコミット＆プッシュ:
```bash
git add index.html
git commit -m "set worker URL"
git push
```

---

## STEP 5 — Cloudflare Pages セットアップ（約5分）

1. Cloudflare Dashboard → 左メニュー **Workers & Pages** → **Create** → **Pages**
2. **Connect to Git** をクリック → GitHub を連携 → リポジトリを選択
3. ビルド設定:
   - **Framework preset**: `None`
   - **Build command**: （空欄）
   - **Build output directory**: `/`（ルート）
4. **Save and Deploy** をクリック
5. デプロイ完了後、`https://YOUR_PROJECT.pages.dev` でアクセス可能になります

### カスタムドメインを使う場合
Pages の **Custom domains** から独自ドメインを設定できます（Cloudflare DNS 管理下のドメインが必要）

---

## STEP 6 — 既存データの移行（任意）

InfinityFree の phpMyAdmin からデータをエクスポートし、Supabase に移行する手順:

1. **phpMyAdmin でエクスポート**:
   - 各テーブル（categories, medicines, staff, stock_in, stock_out）を CSV または SQL でエクスポート

2. **Supabase にインポート**:
   - Supabase の **Table Editor** からCSVを直接インポート可能
   - または SQL Editor で `INSERT INTO ...` 文を実行

3. **在庫数の確認**:
   - `medicines.current_stock` が正しい値になっているか確認

---

## 費用の目安（全て無料枠内で運用可能）

| サービス | 無料枠 | 備考 |
|----------|--------|------|
| Supabase | DB 500MB、月50万 API リクエスト | 2週間操作なしで一時停止（設定で回避可） |
| Cloudflare Workers | 月10万リクエスト/日 | ほぼ無制限に近い |
| Cloudflare Pages | 月500ビルド、帯域無制限 | 静的ファイルのホスティング |
| GitHub | プライベートリポジトリ無制限 | 無料 |

> Supabase の自動停止を防ぐには、ダッシュボードの **Settings → General → Pause project when inactive** をオフにするか、有料プラン（$25/月）に移行してください。

---

## トラブルシューティング

**CORS エラーが出る場合**  
Worker の `CORS_HEADERS` に Pages のドメインを明示してください:
```javascript
'Access-Control-Allow-Origin': 'https://YOUR_PROJECT.pages.dev',
```

**Supabase の RPC が 404 になる場合**  
SQL Editor で `schema.sql` の関数部分のみ再実行してください。

**在庫数がおかしい場合**  
Supabase の SQL Editor で直接確認:
```sql
SELECT id, name, current_stock FROM medicines WHERE is_active = true;
```
