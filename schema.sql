-- =====================================================
-- 養豚場薬品在庫管理システム - Supabase (PostgreSQL) スキーマ
-- Supabase の SQL Editor で実行してください
-- =====================================================

-- ===== テーブル =====

-- 大分類マスタ
CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    sort_order  INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO categories (name, sort_order) VALUES
('ワクチン', 1),
('抗生物質', 2),
('消毒薬', 3),
('飼料添加剤', 4),
('注射針', 5),
('資材', 6),
('殺虫剤・殺鼠剤', 7)
ON CONFLICT DO NOTHING;

-- 薬品マスタ
CREATE TABLE IF NOT EXISTS medicines (
    id              SERIAL PRIMARY KEY,
    category_id     INT NOT NULL REFERENCES categories(id),
    name            VARCHAR(200) NOT NULL,
    volume          VARCHAR(100),
    barcode         VARCHAR(100),
    unit            VARCHAR(50) DEFAULT '本',
    min_stock       INT DEFAULT 0,
    current_stock   INT DEFAULT 0,
    kana_initial    VARCHAR(10),
    notes           TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode  ON medicines(barcode);
CREATE INDEX IF NOT EXISTS idx_medicines_category ON medicines(category_id);
CREATE INDEX IF NOT EXISTS idx_medicines_kana     ON medicines(kana_initial);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS medicines_updated_at ON medicines;
CREATE TRIGGER medicines_updated_at
  BEFORE UPDATE ON medicines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 担当者マスタ
CREATE TABLE IF NOT EXISTS staff (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 入庫ログ
CREATE TABLE IF NOT EXISTS stock_in (
    id                  SERIAL PRIMARY KEY,
    medicine_id         INT NOT NULL REFERENCES medicines(id),
    staff_id            INT NOT NULL REFERENCES staff(id),
    quantity            INT NOT NULL,
    transaction_date    DATE NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_in_date     ON stock_in(transaction_date);
CREATE INDEX IF NOT EXISTS idx_stock_in_medicine ON stock_in(medicine_id);

-- 出庫ログ
CREATE TABLE IF NOT EXISTS stock_out (
    id                  SERIAL PRIMARY KEY,
    medicine_id         INT NOT NULL REFERENCES medicines(id),
    staff_id            INT NOT NULL REFERENCES staff(id),
    quantity            INT NOT NULL,
    transaction_date    DATE NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_out_date     ON stock_out(transaction_date);
CREATE INDEX IF NOT EXISTS idx_stock_out_medicine ON stock_out(medicine_id);


-- =====================================================
-- ===== RPC関数（Cloudflare Worker から呼び出す） =====
-- =====================================================

-- ===== 入庫トランザクション =====
CREATE OR REPLACE FUNCTION stock_in_transaction(
    p_medicine_id INT,
    p_staff_id    INT,
    p_quantity    INT,
    p_date        DATE,
    p_notes       TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
    v_current INT;
    v_min     INT;
BEGIN
    INSERT INTO stock_in (medicine_id, staff_id, quantity, transaction_date, notes)
    VALUES (p_medicine_id, p_staff_id, p_quantity, p_date, p_notes);

    UPDATE medicines
    SET current_stock = current_stock + p_quantity
    WHERE id = p_medicine_id
    RETURNING current_stock, min_stock INTO v_current, v_min;

    RETURN json_build_object(
        'current_stock', v_current,
        'is_alert', (v_min > 0 AND v_current <= v_min)
    );
END;
$$ LANGUAGE plpgsql;

-- ===== 出庫トランザクション =====
CREATE OR REPLACE FUNCTION stock_out_transaction(
    p_medicine_id INT,
    p_staff_id    INT,
    p_quantity    INT,
    p_date        DATE,
    p_notes       TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
    v_current INT;
    v_min     INT;
BEGIN
    SELECT current_stock INTO v_current FROM medicines WHERE id = p_medicine_id;
    IF v_current < p_quantity THEN
        RETURN json_build_object('error', '在庫不足です（現在庫: ' || v_current || '）');
    END IF;

    INSERT INTO stock_out (medicine_id, staff_id, quantity, transaction_date, notes)
    VALUES (p_medicine_id, p_staff_id, p_quantity, p_date, p_notes);

    UPDATE medicines
    SET current_stock = current_stock - p_quantity
    WHERE id = p_medicine_id
    RETURNING current_stock, min_stock INTO v_current, v_min;

    RETURN json_build_object(
        'current_stock', v_current,
        'is_alert', (v_min > 0 AND v_current <= v_min)
    );
END;
$$ LANGUAGE plpgsql;

-- ===== 入庫記録修正 =====
CREATE OR REPLACE FUNCTION update_stock_in(
    p_id       INT,
    p_quantity INT,
    p_date     DATE,
    p_staff_id INT,
    p_notes    TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
    v_old_qty   INT;
    v_med_id    INT;
    v_current   INT;
BEGIN
    SELECT medicine_id, quantity INTO v_med_id, v_old_qty FROM stock_in WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION '該当レコードが見つかりません'; END IF;

    UPDATE stock_in
    SET quantity = p_quantity, transaction_date = p_date, staff_id = p_staff_id, notes = p_notes
    WHERE id = p_id;

    UPDATE medicines
    SET current_stock = current_stock + (p_quantity - v_old_qty)
    WHERE id = v_med_id
    RETURNING current_stock INTO v_current;

    RETURN json_build_object('current_stock', v_current);
END;
$$ LANGUAGE plpgsql;

-- ===== 入庫記録取消 =====
CREATE OR REPLACE FUNCTION cancel_stock_in(p_id INT)
RETURNS JSON AS $$
DECLARE
    v_qty     INT;
    v_med_id  INT;
    v_current INT;
BEGIN
    SELECT medicine_id, quantity INTO v_med_id, v_qty FROM stock_in WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION '該当レコードが見つかりません'; END IF;

    DELETE FROM stock_in WHERE id = p_id;

    UPDATE medicines
    SET current_stock = current_stock - v_qty
    WHERE id = v_med_id
    RETURNING current_stock INTO v_current;

    RETURN json_build_object('current_stock', v_current);
END;
$$ LANGUAGE plpgsql;

-- ===== 出庫記録修正 =====
CREATE OR REPLACE FUNCTION update_stock_out(
    p_id       INT,
    p_quantity INT,
    p_date     DATE,
    p_staff_id INT,
    p_notes    TEXT DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
    v_old_qty   INT;
    v_med_id    INT;
    v_current   INT;
    v_diff      INT;
BEGIN
    SELECT medicine_id, quantity INTO v_med_id, v_old_qty FROM stock_out WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION '該当レコードが見つかりません'; END IF;

    v_diff := v_old_qty - p_quantity; -- 正なら在庫が増える、負なら減る

    SELECT current_stock INTO v_current FROM medicines WHERE id = v_med_id;
    IF v_diff < 0 AND v_current < ABS(v_diff) THEN
        RETURN json_build_object('error', '在庫不足のため修正できません（現在庫: ' || v_current || '）');
    END IF;

    UPDATE stock_out
    SET quantity = p_quantity, transaction_date = p_date, staff_id = p_staff_id, notes = p_notes
    WHERE id = p_id;

    UPDATE medicines
    SET current_stock = current_stock + v_diff
    WHERE id = v_med_id
    RETURNING current_stock INTO v_current;

    RETURN json_build_object('current_stock', v_current);
END;
$$ LANGUAGE plpgsql;

-- ===== 出庫記録取消 =====
CREATE OR REPLACE FUNCTION cancel_stock_out(p_id INT)
RETURNS JSON AS $$
DECLARE
    v_qty     INT;
    v_med_id  INT;
    v_current INT;
BEGIN
    SELECT medicine_id, quantity INTO v_med_id, v_qty FROM stock_out WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION '該当レコードが見つかりません'; END IF;

    DELETE FROM stock_out WHERE id = p_id;

    UPDATE medicines
    SET current_stock = current_stock + v_qty
    WHERE id = v_med_id
    RETURNING current_stock INTO v_current;

    RETURN json_build_object('current_stock', v_current);
END;
$$ LANGUAGE plpgsql;

-- ===== ログ取得（入出庫履歴） =====
CREATE OR REPLACE FUNCTION get_logs(
    p_type      TEXT    DEFAULT 'all',
    p_date_from DATE    DEFAULT NULL,
    p_date_to   DATE    DEFAULT NULL,
    p_cat_id    INT     DEFAULT NULL
)
RETURNS TABLE (
    type             TEXT,
    id               INT,
    transaction_date DATE,
    category_name    TEXT,
    medicine_name    TEXT,
    volume           TEXT,
    quantity         INT,
    unit             TEXT,
    staff_name       TEXT,
    notes            TEXT,
    medicine_id      INT,
    stock_after      INT
) AS $$
BEGIN
    RETURN QUERY
    WITH base AS (
        -- 入庫
        SELECT
            'in'::TEXT                AS type,
            0                         AS type_order,
            si.id,
            si.transaction_date,
            c.name                    AS category_name,
            m.name                    AS medicine_name,
            m.volume,
            si.quantity,
            m.unit,
            s.name                    AS staff_name,
            si.notes,
            m.id                      AS medicine_id,
            (
                m.current_stock
                - COALESCE((SELECT SUM(si2.quantity) FROM stock_in si2
                   WHERE si2.medicine_id = m.id
                     AND (si2.transaction_date > si.transaction_date
                          OR (si2.transaction_date = si.transaction_date AND si2.id > si.id))), 0)
                + COALESCE((SELECT SUM(so2.quantity) FROM stock_out so2
                   WHERE so2.medicine_id = m.id
                     AND so2.transaction_date >= si.transaction_date), 0)
            )::INT                    AS stock_after
        FROM stock_in si
        JOIN medicines m ON si.medicine_id = m.id
        JOIN categories c ON m.category_id = c.id
        JOIN staff s ON si.staff_id = s.id
        WHERE (p_type = 'all' OR p_type = 'in')
          AND (p_date_from IS NULL OR si.transaction_date >= p_date_from)
          AND (p_date_to   IS NULL OR si.transaction_date <= p_date_to)
          AND (p_cat_id    IS NULL OR m.category_id = p_cat_id)

        UNION ALL

        -- 出庫
        SELECT
            'out'::TEXT               AS type,
            1                         AS type_order,
            so.id,
            so.transaction_date,
            c.name                    AS category_name,
            m.name                    AS medicine_name,
            m.volume,
            so.quantity,
            m.unit,
            s.name                    AS staff_name,
            so.notes,
            m.id                      AS medicine_id,
            (
                m.current_stock
                - COALESCE((SELECT SUM(si2.quantity) FROM stock_in si2
                   WHERE si2.medicine_id = m.id
                     AND si2.transaction_date > so.transaction_date), 0)
                + COALESCE((SELECT SUM(so2.quantity) FROM stock_out so2
                   WHERE so2.medicine_id = m.id
                     AND (so2.transaction_date > so.transaction_date
                          OR (so2.transaction_date = so.transaction_date AND so2.id > so.id))), 0)
            )::INT                    AS stock_after
        FROM stock_out so
        JOIN medicines m ON so.medicine_id = m.id
        JOIN categories c ON m.category_id = c.id
        JOIN staff s ON so.staff_id = s.id
        WHERE (p_type = 'all' OR p_type = 'out')
          AND (p_date_from IS NULL OR so.transaction_date >= p_date_from)
          AND (p_date_to   IS NULL OR so.transaction_date <= p_date_to)
          AND (p_cat_id    IS NULL OR m.category_id = p_cat_id)
    )
    SELECT
        base.type, base.id, base.transaction_date, base.category_name,
        base.medicine_name, base.volume, base.quantity, base.unit,
        base.staff_name, base.notes, base.medicine_id, base.stock_after
    FROM base
    ORDER BY base.transaction_date ASC, base.type_order ASC, base.id ASC;
END;
$$ LANGUAGE plpgsql;


-- =====================================================
-- ===== Row Level Security (RLS) =====
-- セキュリティが必要な場合は有効化してください
-- 社内利用のみであれば、service_role キーで接続すれば RLS は不要
-- =====================================================

-- 全テーブルに RLS を有効化する場合の例（anon キー使用時）:
-- ALTER TABLE categories  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE medicines   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE staff       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE stock_in    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE stock_out   ENABLE ROW LEVEL SECURITY;
--
-- 全員に全操作を許可するポリシー（簡易版）:
-- CREATE POLICY "allow_all" ON categories  FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow_all" ON medicines   FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow_all" ON staff       FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow_all" ON stock_in    FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "allow_all" ON stock_out   FOR ALL USING (true) WITH CHECK (true);
