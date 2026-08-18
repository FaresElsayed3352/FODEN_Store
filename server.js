const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'CHANGE_ME';
const WHATSAPP = process.env.WHATSAPP_NUMBER || '201020477414';
const KEY = Buffer.from(process.env.CREDENTIAL_KEY || '', 'base64');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RECEIPT_BUCKET = 'receipts';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: Supabase environment variables are missing.');
}

if (KEY.length !== 32) {
  console.warn('WARNING: CREDENTIAL_KEY must decode to exactly 32 bytes.');
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;
const connectionString =
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  console.warn('WARNING: No Postgres connection string found.');
}

const pool = connectionString
  ? new Pool({
      connectionString: connectionString
        .trim()
        .replace(/[?&]sslmode=[^&]*/i, '')
        .replace(/[?&]sslrootcert=[^&]*/i, ''),
      ssl: {
        rejectUnauthorized: false
      },
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    })
  : null;
const defaultPackages = {
  id: [
    [110, 60],
    [231, 120],
    [341, 165],
    [460, 220],
    [583, 270],
    [1040, 470],
    [1188, 540],
    [2002, 900],
    [2420, 1050],
    [3000, 1350],
    [5000, 2190],
    [5600, 2450]
  ],
  account: [
    [110, 55],
    [310, 145],
    [520, 220],
    [1060, 380],
    [2180, 760],
    [3240, 1140],
    [5600, 1850],
    [11200, 3700]
  ]
};

async function initDatabase() {
  if (!pool) {
    throw new Error('Database is not configured.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('id','account')),
      diamonds INTEGER NOT NULL,
      price NUMERIC NOT NULL,
      player_id TEXT DEFAULT '',
      customer_name TEXT DEFAULT '',
      receipt_path TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      has_credentials BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS order_secrets (
      order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
      username JSONB NOT NULL,
      password JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      exited_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS packages (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('id','account')),
      diamonds INTEGER NOT NULL,
      price NUMERIC NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  const packageCount = await pool.query(
    'SELECT COUNT(*)::int AS count FROM packages'
  );

  if (packageCount.rows[0].count === 0) {
    for (const [diamonds, price] of defaultPackages.id) {
      await pool.query(
        `
        INSERT INTO packages (type, diamonds, price, active)
        VALUES ($1, $2, $3, TRUE)
        `,
        ['id', diamonds, price]
      );
    }

    for (const [diamonds, price] of defaultPackages.account) {
      await pool.query(
        `
        INSERT INTO packages (type, diamonds, price, active)
        VALUES ($1, $2, $3, TRUE)
        `,
        ['account', diamonds, price]
      );
    }
  }

  if (supabase) {
    const { data: bucket } =
      await supabase.storage.getBucket(RECEIPT_BUCKET);

    if (!bucket) {
      const { error } =
        await supabase.storage.createBucket(RECEIPT_BUCKET, {
          public: false,
          allowedMimeTypes: [
            'image/jpeg',
            'image/png',
            'image/webp'
          ],
          fileSizeLimit: 5 * 1024 * 1024
        });

      if (
        error &&
        !/already exists/i.test(error.message || '')
      ) {
        console.error(
          'Storage bucket error:',
          error.message
        );
      }
    }
  }
}

const ready = initDatabase().catch((error) => {
  console.error('Database initialization failed:', error);
  throw error;
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_, file, cb) => {
    cb(
      null,
      /^image\/(jpeg|png|webp)$/.test(file.mimetype)
    );
  }
});

function auth(req, res, next) {
  if (
    !ADMIN_TOKEN ||
    req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`
  ) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  next();
}

function now() {
  return Date.now();
}

function enc(value) {
  if (KEY.length !== 32) {
    throw new Error('CREDENTIAL_KEY not configured');
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    KEY,
    iv
  );

  const data = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ]);

  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function dec(value) {
  if (KEY.length !== 32) {
    throw new Error('CREDENTIAL_KEY not configured');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(value.iv, 'base64')
  );

  decipher.setAuthTag(
    Buffer.from(value.tag, 'base64')
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(value.data, 'base64')
    ),
    decipher.final()
  ]).toString('utf8');
}

function newOrderId() {
  return (
    'FD-' +
    Date.now().toString(36).toUpperCase() +
    '-' +
    crypto.randomBytes(2).toString('hex').toUpperCase()
  );
}

async function visitorStats() {
  await ready;

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE last_seen > NOW() - INTERVAL '35 seconds'
      )::int AS online,

      COUNT(*)::int AS total,

      COUNT(*) FILTER (
        WHERE first_seen::date =
        (NOW() AT TIME ZONE 'UTC')::date
      )::int AS today,

      COUNT(*) FILTER (
        WHERE exited_at::date =
        (NOW() AT TIME ZONE 'UTC')::date
      )::int AS exited

    FROM visitors
  `);

  return result.rows[0];
}

app.post('/api/visitor/heartbeat', async (req, res) => {
  try {
    await ready;

    const id = String(
      req.body?.id || ''
    ).slice(0, 100);

    if (!id) {
      return res.status(400).json({
        error: 'id'
      });
    }

    await pool.query(
      `
      INSERT INTO visitors
        (id, first_seen, last_seen, exited_at)
      VALUES
        ($1, NOW(), NOW(), NULL)

      ON CONFLICT (id)
      DO UPDATE SET
        last_seen = NOW(),
        exited_at = NULL
      `,
      [id]
    );

    res.json(await visitorStats());
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'visitor error'
    });
  }
});

app.post('/api/visitor/exit', async (req, res) => {
  try {
    await ready;

    const id = String(
      req.body?.id || ''
    ).slice(0, 100);

    if (id) {
      await pool.query(
        `
        UPDATE visitors
        SET exited_at = NOW()
        WHERE id = $1
        `,
        [id]
      );
    }

    res.json(await visitorStats());
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'visitor error'
    });
  }
});

app.get('/api/visitor/stats', async (req, res) => {
  try {
    res.json(await visitorStats());
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'visitor error'
    });
  }
});

app.get('/api/packages', async (req, res) => {
  try {
    await ready;

    const result = await pool.query(`
      SELECT
        type,
        diamonds,
        price
      FROM packages
      WHERE active = TRUE
      ORDER BY diamonds ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'packages error'
    });
  }
});

app.post(
  '/api/orders',
  upload.single('receipt'),
  async (req, res) => {
    try {
      await ready;

      const {
        type,
        diamonds,
        price,
        playerId,
        username,
        password,
        customerName
      } = req.body;

      if (!['id', 'account'].includes(type)) {
        return res.status(400).json({
          error: 'نوع شحن غير صحيح'
        });
      }

      if (!diamonds || !price) {
        return res.status(400).json({
          error: 'بيانات الباقة ناقصة'
        });
      }

      if (
        type === 'id' &&
        !String(playerId || '').trim()
      ) {
        return res.status(400).json({
          error: 'UID مطلوب'
        });
      }

      if (
        type === 'account' &&
        (
          !String(username || '').trim() ||
          !String(password || '')
        )
      ) {
        return res.status(400).json({
          error: 'بيانات الحساب مطلوبة'
        });
      }

      if (
        type === 'account' &&
        KEY.length !== 32
      ) {
        return res.status(500).json({
          error: 'التشفير غير مهيأ على السيرفر'
        });
      }

      const id = newOrderId();

      let receiptPath = null;

      if (req.file) {
        if (!supabase) {
          return res.status(500).json({
            error: 'Storage غير مهيأ على السيرفر'
          });
        }

        const extension =
          req.file.mimetype === 'image/png'
            ? 'png'
            : req.file.mimetype === 'image/webp'
              ? 'webp'
              : 'jpg';

        receiptPath =
          `${id}-${crypto.randomBytes(6).toString('hex')}.${extension}`;

        const { error } =
          await supabase.storage
            .from(RECEIPT_BUCKET)
            .upload(
              receiptPath,
              req.file.buffer,
              {
                contentType: req.file.mimetype,
                cacheControl: '3600',
                upsert: false
              }
            );

        if (error) {
          console.error(
            'Receipt upload error:',
            error
          );

          return res.status(500).json({
            error: 'فشل رفع الإيصال'
          });
        }
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          `
          INSERT INTO orders
            (
              id,
              type,
              diamonds,
              price,
              player_id,
              customer_name,
              receipt_path,
              status,
              has_credentials
            )
          VALUES
            ($1,$2,$3,$4,$5,$6,$7,'new',$8)
          `,
          [
            id,
            type,
            Number(diamonds),
            Number(price),
            String(playerId || '').trim(),
            String(customerName || '').trim(),
            receiptPath,
            type === 'account'
          ]
        );

        if (type === 'account') {
          await client.query(
            `
            INSERT INTO order_secrets
              (
                order_id,
                username,
                password,
                expires_at
              )
            VALUES
              ($1,$2,$3,NOW() + INTERVAL '15 minutes')
            `,
            [
              id,
              JSON.stringify(enc(username)),
              JSON.stringify(enc(password))
            ]
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');

        if (receiptPath && supabase) {
          await supabase.storage
            .from(RECEIPT_BUCKET)
            .remove([receiptPath]);
        }

        throw error;
      } finally {
        client.release();
      }

      const message =
        `طلب FODEN%0A` +
        `رقم الطلب: ${encodeURIComponent(id)}%0A` +
        `الباقة: ${diamonds} جوهرة%0A` +
        `السعر: ${price} ج.م%0A` +
        `نوع الشحن: ${
          type === 'id' ? 'UID' : 'حساب'
        }%0A` +
        (
          type === 'id'
            ? `UID: ${encodeURIComponent(playerId)}`
            : ''
        );

      res.json({
        ok: true,
        orderId: id,
        whatsapp:
          `https://wa.me/${WHATSAPP}?text=${message}`
      });
    } catch (error) {
      console.error(
        'Order error:',
        error
      );

      res.status(500).json({
        error: 'حدث خطأ أثناء إنشاء الطلب'
      });
    }
  }
);

function formatOrder(row, receipt = null) {
  return {
    id: row.id,
    type: row.type,
    diamonds: Number(row.diamonds),
    price: Number(row.price),
    playerId: row.player_id || '',
    customerName: row.customer_name || '',
    receipt,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasCredentials: row.has_credentials
  };
}

app.get('/api/orders', auth, async (req, res) => {
  try {
    await ready;

    const result = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    const orders = [];

    for (const row of result.rows) {
      let receipt = null;

      if (row.receipt_path && supabase) {
        const signed =
          await supabase.storage
            .from(RECEIPT_BUCKET)
            .createSignedUrl(
              row.receipt_path,
              60 * 10
            );

        if (!signed.error) {
          receipt =
            signed.data.signedUrl;
        }
      }

      orders.push(
        formatOrder(row, receipt)
      );
    }

    res.json(orders);
  } catch (error) {
    console.error(
      'Orders error:',
      error
    );

    res.status(500).json({
      error: 'orders error'
    });
  }
});

app.patch(
  '/api/orders/:id',
  auth,
  async (req, res) => {
    try {
      await ready;

      const allowed = [
        'new',
        'paid',
        'processing',
        'completed',
        'cancelled'
      ];

      if (
        !allowed.includes(req.body.status)
      ) {
        return res.status(400).json({
          error: 'status'
        });
      }

      const result = await pool.query(
        `
        UPDATE orders
        SET
          status = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [
          req.body.status,
          req.params.id
        ]
      );

      if (!result.rows[0]) {
        return res.status(404).json({
          error: 'not found'
        });
      }

      res.json(
        formatOrder(result.rows[0])
      );
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'update error'
      });
    }
  }
);

app.get(
  '/api/orders/:id/credentials',
  auth,
  async (req, res) => {
    try {
      await ready;

      const result = await pool.query(
        `
        SELECT
          username,
          password,
          expires_at
        FROM order_secrets
        WHERE order_id = $1
        `,
        [req.params.id]
      );

      const secret = result.rows[0];

      if (
        !secret ||
        new Date(secret.expires_at).getTime() < now()
      ) {
        await pool.query(
          `
          DELETE FROM order_secrets
          WHERE order_id = $1
          `,
          [req.params.id]
        );

        return res.status(404).json({
          error: 'انتهت صلاحية بيانات الدخول'
        });
      }

      const resultData = {
        username: dec(secret.username),
        password: dec(secret.password)
      };

      await pool.query(
        `
        DELETE FROM order_secrets
        WHERE order_id = $1
        `,
        [req.params.id]
      );

      res.json(resultData);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'credential error'
      });
    }
  }
);

app.get(
  '/api/admin/stats',
  auth,
  async (req, res) => {
    try {
      await ready;

      const [orders, visitors] =
        await Promise.all([
          pool.query(`
            SELECT
              COUNT(*)::int AS total,

              COUNT(*) FILTER (
                WHERE status = 'new'
              )::int AS new,

              COUNT(*) FILTER (
                WHERE status = 'paid'
              )::int AS paid,

              COUNT(*) FILTER (
                WHERE status = 'processing'
              )::int AS processing,

              COUNT(*) FILTER (
                WHERE status = 'completed'
              )::int AS completed,

              COUNT(*) FILTER (
                WHERE status = 'cancelled'
              )::int AS cancelled

            FROM orders
          `),

          visitorStats()
        ]);

      const row = orders.rows[0];

      res.json({
        visitors,
        orders: Number(row.total),
        counts: {
          new: Number(row.new),
          paid: Number(row.paid),
          processing: Number(row.processing),
          completed: Number(row.completed),
          cancelled: Number(row.cancelled)
        }
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'stats error'
      });
    }
  }
);

app.get('/api/health', async (req, res) => {
  try {
    await ready;

    await pool.query('SELECT 1');

    res.json({
      ok: true,
      database: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: false
    });
  }
});

app.get('/admin.html', (req, res) => {
  res.sendFile(
    path.join(ROOT, 'admin.html')
  );
});

app.get(/.*/, (req, res) => {
  res.sendFile(
    path.join(ROOT, 'index.html')
  );
});

app.listen(PORT, () => {
  console.log(
    `FODEN running on port ${PORT}`
  );
});
