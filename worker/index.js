/**
 * Cloudflare Workers API
 * 養豚場薬品在庫管理システム
 *
 * 環境変数（wrangler.toml または Cloudflare Dashboard で設定）:
 *   SUPABASE_URL  : https://xxxxxxxxxxxx.supabase.co
 *   SUPABASE_KEY  : service_role key (anon key でも可、RLS設定による)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ===== かな行グループ判定 =====
function getKanaGroup(name) {
  const first = [...name][0] ?? '';
  const groups = {
    'ア行': [...'アイウエオあいうえおAEFHILMNORS X'],
    'カ行': [...'カキクケコかきくけこガギグゲゴがぎぐげごKQ'],
    'サ行': [...'サシスセソさしすせそザジズゼゾざじずぜぞCGJZ'],
    'タ行': [...'タチツテトたちつてとダヂヅデドだぢづでどDTW'],
    'ナ行': [...'ナニヌネノなにぬねの'],
    'ハ行': [...'ハヒフヘホはひふへほバビブベボばびぶべぼパピプペポぱぴぷぺぽBPV'],
    'マ行': [...'マミムメモまみむめも'],
    'ヤ行': [...'ヤユヨやゆよ'],
    'ラ行': [...'ラリルレロらりるれろ'],
    'ワ行': [...'ワヲンわをんY'],
  };
  for (const [group, chars] of Object.entries(groups)) {
    if (chars.includes(first)) return group;
  }
  return 'その他';
}

// ===== Supabase REST クライアント =====
class SupabaseClient {
  constructor(url, key) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
  }

  headers(extra = {}) {
    return {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extra,
    };
  }

  async query(table, params = '') {
    const res = await fetch(`${this.url}/rest/v1/${table}${params ? '?' + params : ''}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async rpc(fn, body = {}) {
    const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async insert(table, data) {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async update(table, match, data) {
    const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
    const res = await fetch(`${this.url}/rest/v1/${table}?${qs}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async delete(table, match) {
    const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
    const res = await fetch(`${this.url}/rest/v1/${table}?${qs}`, {
      method: 'DELETE',
      headers: this.headers({ 'Prefer': 'return=representation' }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}

// ===== JSON レスポンス =====
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ===== メインハンドラ =====
export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') ?? '';
    const db = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);

    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch {}
    }

    try {
      // ===== カテゴリ =====
      if (action === 'get_categories') {
        const data = await db.query('categories', 'order=sort_order.asc');
        return json({ data });
      }

      // ===== 薬品一覧 =====
      if (action === 'get_medicines') {
        const catId = url.searchParams.get('category_id');
        const kana  = url.searchParams.get('kana');
        let qs = 'select=*,categories(name)&is_active=eq.true';
        if (catId) qs += `&category_id=eq.${catId}`;
        if (kana)  qs += `&kana_initial=eq.${encodeURIComponent(kana)}`;
        qs += '&order=kana_initial.asc,name.asc';
        const rows = await db.query('medicines', qs);
        const data = rows.map(r => ({ ...r, category_name: r.categories?.name }));
        return json({ data });
      }

      // ===== バーコード検索 =====
      if (action === 'get_medicine_by_barcode') {
        const barcode = url.searchParams.get('barcode');
        if (!barcode) return json({ error: 'バーコードが必要です' }, 400);
        const rows = await db.query('medicines',
          `select=*,categories(name)&barcode=eq.${encodeURIComponent(barcode)}&is_active=eq.true&limit=1`
        );
        if (rows.length) {
          const r = rows[0];
          return json({ found: true, data: { ...r, category_name: r.categories?.name } });
        }
        return json({ found: false, barcode });
      }

      // ===== 薬品単体取得 =====
      if (action === 'get_medicine') {
        const id = url.searchParams.get('id');
        const rows = await db.query('medicines', `select=*,categories(name)&id=eq.${id}`);
        const r = rows[0];
        return json({ data: r ? { ...r, category_name: r.categories?.name } : null });
      }

      // ===== 薬品保存 =====
      if (action === 'save_medicine') {
        const { id, category_id, name, volume, barcode, unit, min_stock, notes } = body;
        if (!category_id || !name) return json({ error: '大分類と薬品名は必須です' }, 400);
        const kana = getKanaGroup(name);
        const payload = {
          category_id: Number(category_id),
          name: name.trim(),
          volume: volume?.trim() || null,
          barcode: barcode?.trim() || null,
          unit: unit || '本',
          min_stock: Number(min_stock) || 0,
          kana_initial: kana,
          notes: notes?.trim() || null,
        };
        // バーコード重複チェック
        if (payload.barcode) {
          let dupQs = `barcode=eq.${encodeURIComponent(payload.barcode)}&is_active=eq.true`;
          if (id) dupQs += `&id=neq.${id}`;
          const dup = await db.query('medicines', dupQs);
          if (dup.length) return json({ error: 'このバーコードは既に登録されています' }, 409);
        }
        if (id) {
          await db.update('medicines', { id }, payload);
          return json({ success: true, id, message: '薬品情報を更新しました' });
        } else {
          const rows = await db.insert('medicines', payload);
          return json({ success: true, id: rows[0]?.id, message: '薬品を登録しました' });
        }
      }

      // ===== 薬品削除（論理削除） =====
      if (action === 'delete_medicine') {
        const id = Number(body.id);
        await db.update('medicines', { id }, { is_active: false });
        return json({ success: true });
      }

      // ===== 担当者一覧 =====
      if (action === 'get_staff') {
        const data = await db.query('staff', 'is_active=eq.true&order=name.asc');
        return json({ data });
      }

      // ===== 担当者保存 =====
      if (action === 'save_staff') {
        const { id, name } = body;
        if (!name?.trim()) return json({ error: '担当者名は必須です' }, 400);
        if (id) {
          await db.update('staff', { id }, { name: name.trim() });
          return json({ success: true, id });
        } else {
          const rows = await db.insert('staff', { name: name.trim() });
          return json({ success: true, id: rows[0]?.id });
        }
      }

      // ===== 担当者削除（論理削除） =====
      if (action === 'delete_staff') {
        await db.update('staff', { id: Number(body.id) }, { is_active: false });
        return json({ success: true });
      }

      // ===== 入庫 =====
      if (action === 'stock_in') {
        const { medicine_id, staff_id, quantity, date, notes } = body;
        if (!medicine_id || !staff_id || quantity <= 0)
          return json({ error: '薬品・担当者・数量は必須です' }, 400);

        // stock_in 挿入 + 在庫更新 を RPC トランザクションで実行
        const result = await db.rpc('stock_in_transaction', {
          p_medicine_id: Number(medicine_id),
          p_staff_id:    Number(staff_id),
          p_quantity:    Number(quantity),
          p_date:        date,
          p_notes:       notes || null,
        });
        return json({
          success: true,
          message: '入庫を記録しました',
          current_stock: result.current_stock,
          alert: result.is_alert,
        });
      }

      // ===== 出庫 =====
      if (action === 'stock_out') {
        const { medicine_id, staff_id, quantity, date, notes } = body;
        if (!medicine_id || !staff_id || quantity <= 0)
          return json({ error: '薬品・担当者・数量は必須です' }, 400);

        const result = await db.rpc('stock_out_transaction', {
          p_medicine_id: Number(medicine_id),
          p_staff_id:    Number(staff_id),
          p_quantity:    Number(quantity),
          p_date:        date,
          p_notes:       notes || null,
        });
        if (result.error) return json({ error: result.error }, 400);
        return json({
          success: true,
          message: '出庫を記録しました',
          current_stock: result.current_stock,
          alert: result.is_alert,
          alert_message: result.is_alert
            ? `⚠️ 在庫が最低数量を下回りました（${result.current_stock}）` : null,
        });
      }

      // ===== ログ取得 =====
      if (action === 'get_logs') {
        const type     = url.searchParams.get('type') ?? 'all';
        const dateFrom = url.searchParams.get('date_from');
        const dateTo   = url.searchParams.get('date_to');
        const catId    = url.searchParams.get('category_id');

        const data = await db.rpc('get_logs', {
          p_type:      type,
          p_date_from: dateFrom,
          p_date_to:   dateTo,
          p_cat_id:    catId ? Number(catId) : null,
        });
        return json({ data });
      }

      // ===== 在庫一覧（アラート付き） =====
      if (action === 'get_stock') {
        const catId = url.searchParams.get('category_id');
        let qs = `select=id,name,volume,unit,current_stock,min_stock,kana_initial,categories(name)&is_active=eq.true`;
        if (catId) qs += `&category_id=eq.${catId}`;
        qs += '&order=current_stock.asc'; // アラート判定はクライアント側で
        const rows = await db.query('medicines', qs);
        const data = rows.map(r => ({
          ...r,
          category_name: r.categories?.name,
          is_alert: r.min_stock > 0 && r.current_stock <= r.min_stock ? 1 : 0,
        }));
        data.sort((a, b) => b.is_alert - a.is_alert);
        return json({ data });
      }

      // ===== カナ行グループ一覧 =====
      if (action === 'get_kana_groups') {
        const catId = url.searchParams.get('category_id');
        if (!catId) return json({ data: [] });
        const rows = await db.query('medicines',
          `select=kana_initial&category_id=eq.${catId}&is_active=eq.true`
        );
        const order = ['ア行','カ行','サ行','タ行','ナ行','ハ行','マ行','ヤ行','ラ行','ワ行','その他'];
        const unique = [...new Set(rows.map(r => r.kana_initial ?? 'その他'))];
        unique.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        return json({ data: unique });
      }

      // ===== 入庫 修正 =====
      if (action === 'update_stock_in') {
        const { id, quantity, date, staff_id, notes } = body;
        if (!id || quantity <= 0 || !date || !staff_id)
          return json({ error: '必須項目が不足しています' }, 400);
        const result = await db.rpc('update_stock_in', {
          p_id: Number(id), p_quantity: Number(quantity),
          p_date: date, p_staff_id: Number(staff_id), p_notes: notes || null,
        });
        return json({ success: true, message: '入庫記録を修正しました', current_stock: result.current_stock });
      }

      // ===== 入庫 取消 =====
      if (action === 'cancel_stock_in') {
        const { id } = body;
        if (!id) return json({ error: 'IDが必要です' }, 400);
        const result = await db.rpc('cancel_stock_in', { p_id: Number(id) });
        return json({ success: true, message: '入庫記録を取消しました', current_stock: result.current_stock });
      }

      // ===== 出庫 修正 =====
      if (action === 'update_stock_out') {
        const { id, quantity, date, staff_id, notes } = body;
        if (!id || quantity <= 0 || !date || !staff_id)
          return json({ error: '必須項目が不足しています' }, 400);
        const result = await db.rpc('update_stock_out', {
          p_id: Number(id), p_quantity: Number(quantity),
          p_date: date, p_staff_id: Number(staff_id), p_notes: notes || null,
        });
        if (result.error) return json({ error: result.error }, 400);
        return json({ success: true, message: '出庫記録を修正しました', current_stock: result.current_stock });
      }

      // ===== 出庫 取消 =====
      if (action === 'cancel_stock_out') {
        const { id } = body;
        if (!id) return json({ error: 'IDが必要です' }, 400);
        const result = await db.rpc('cancel_stock_out', { p_id: Number(id) });
        return json({ success: true, message: '出庫記録を取消しました', current_stock: result.current_stock });
      }

      // ===== CSV エクスポート（Workerから直接返す） =====
      if (action === 'export_csv') {
        const type     = url.searchParams.get('type') ?? 'all';
        const dateFrom = url.searchParams.get('date_from');
        const dateTo   = url.searchParams.get('date_to');
        const rows = await db.rpc('get_logs', {
          p_type: type, p_date_from: dateFrom, p_date_to: dateTo, p_cat_id: null,
        });
        const BOM = '\uFEFF';
        const header = '種別,日付,大分類,薬品名,容量,数量,単位,担当者,備考\n';
        const lines = rows.map(r =>
          [r.type==='in'?'入庫':'出庫', r.transaction_date, r.category_name,
           r.medicine_name, r.volume??'', r.quantity, r.unit, r.staff_name, r.notes??'']
          .map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')
        ).join('\n');
        return new Response(BOM + header + lines, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/csv; charset=UTF-8',
            'Content-Disposition': `attachment; filename="pharma_log_${dateFrom}_${dateTo}.csv"`,
          },
        });
      }

      // ===== 在庫 CSV エクスポート =====
      if (action === 'export_stock_csv') {
        const rows = await db.query('medicines',
          'select=name,volume,unit,current_stock,min_stock,kana_initial,categories(name)&is_active=eq.true&order=kana_initial.asc,name.asc'
        );
        const BOM = '\uFEFF';
        const header = '大分類,中分類,薬品名,容量,単位,現在庫,最低在庫,アラート\n';
        const lines = rows.map(r =>
          [r.categories?.name??'', r.kana_initial??'その他', r.name, r.volume??'',
           r.unit, r.current_stock, r.min_stock,
           (r.min_stock > 0 && r.current_stock <= r.min_stock) ? '警告' : '']
          .map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')
        ).join('\n');
        return new Response(BOM + header + lines, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/csv; charset=UTF-8',
            'Content-Disposition': `attachment; filename="pharma_stock_${new Date().toISOString().slice(0,10)}.csv"`,
          },
        });
      }

      // fix_category_name は Supabase では不要（初期データを正しく投入するため）
      if (action === 'fix_category_name') return json({ success: true });

      return json({ error: '不明なアクション: ' + action }, 400);

    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500);
    }
  },
};
