```javascript
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const ROOT = __dirname;

/* =========================================================
   ENV
   ========================================================= */

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'CHANGE_ME';
const WHATSAPP = process.env.WHATSAPP_NUMBER || '201020477414';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const RECEIPT_BUCKET = 'receipts';

const KEY = Buffer.from(
  process.env.CREDENTIAL_KEY || '',
  'base64'
);

/* =========================================================
   SUPABASE
   ========================================================= */

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        }
      )
    : null;

/* =========================================================
   DATABASE
   ========================================================= */

const rawConnectionString =
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  null;

/*
  IMPORTANT:
  Remove SSL query parameters from the connection URL.
  SSL is configured explicitly below.
*/

const connectionString = rawConnectionString
  ? rawConnectionString
      .replace(/[?&]sslmode=[^&]*/gi, '')
      .replace(/[?&]pgbouncer=[^&]*/gi, '')
      .replace(/[?&]supa=[^&]*/gi, '')
  : null;

const pool = connectionString
  ? new Pool({
      connectionString,

      ssl: {
        rejectUnauthorized: false
      },

      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000
    })
  : null;

/* =========================================================
   DATABASE READY
   ========================================================= */

let databaseReady = null;
let databaseError = null;

async function initDatabase() {
  if (!pool) {
    throw new Error(
      'No PostgreSQL connection string configured.'
    );
  }

  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
        CHECK (type IN ('id','account')),
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
      order_id TEXT PRIMARY KEY
        REFERENCES orders(id)
        ON DELETE CASCADE,
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
      type TEXT NOT NULL
        CHECK (type IN ('id','account')),
      diamonds INTEGER NOT NULL,
      price NUMERIC NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  /* =======================================================
     DEFAULT PACKAGES
     ======================================================= */

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS count FROM packages'
  );

  if (countResult.rows[0].count === 0) {
    const packages = [

      /* ID */
      ['id', 110, 60],
      ['id', 231, 120],
      ['id', 341, 165],
      ['id', 460, 220],
      ['id', 583, 270],
      ['id', 1040, 470],
      ['id', 1188, 540],
      ['id', 2002, 900],
      ['id', 2420, 1050],
      ['id', 3000, 1350],
      ['id', 5000, 2190],
      ['id', 5600, 2450],

      /* ACCOUNT */
      ['account', 110, 55],
      ['account', 310, 145],
      ['account', 520, 220],
      ['account', 1060, 380],
      ['account', 2180, 760],
      ['account', 3240, 1140],
      ['account', 5600, 1850],
      ['account', 11200, 3700]
    ];

    for (const [type, diamonds, price] of packages) {
      await pool.query(
        `
        INSERT INTO packages
          (type, diamonds, price, active)
        VALUES
          ($1, $2, $3, TRUE)
        `,
        [type, diamonds, price]
      );
    }
  }

  /* =======================================================
     SUPABASE STORAGE
     ======================================================= */

  if (supabase) {
    try {
      const { data: bucket } =
        await supabase.storage.getBucket(
          RECEIPT_BUCKET
        );

      if (!bucket) {
        const { error } =
          await supabase.storage.createBucket(
            RECEIPT_BUCKET,
            {
              public: false,
              allowedMimeTypes: [
                'image/jpeg',
                'image/png',
                'image/webp'
              ],
              fileSizeLimit: 5 * 1024 * 1024
            }
          );

        if (
          error &&
          !/already exists/i.test(
            error.message || ''
          )
        ) {
          console.error(
            'Storage bucket error:',
            error.message
          );
        }
      }
    } catch (error) {
      console.error(
        'Storage initialization error:',
        error.message
      );
    }
  }

  return true;
}

/*
  IMPORTANT:
  Do NOT throw an unhandled rejected promise here.
*/

async function ensureDatabase() {
  if (databaseReady) {
    return databaseReady;
  }

  databaseReady = initDatabase()
    .then(() => {
      databaseError = null;
      console.log('Database ready.');
      return true;
    })
    .catch((error) => {
      databaseError = error;

      console.error(
        'Database initialization failed:',
        error.message
      );

      /*
        Do not kill the Vercel function.
        The individual API endpoint will return
        a controlled 500 response.
      */

      return false;
    });

  return databaseReady;
}

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(ROOT)
);

/* =========================================================
   UPLOAD
   ========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024
  },

  fileFilter: (_, file, cb) => {
    if (
      /^image\/(jpeg|png|webp)$/.test(
        file.mimetype
      )
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Only JPEG, PNG and WEBP images are allowed.'
        )
      );
    }
  }
});

/* =========================================================
   DATABASE GUARD
   ========================================================= */

async function dbRequired(req, res, next) {
  const ok = await ensureDatabase();

  if (!ok || !pool) {
    return res.status(503).json({
      error: 'database_unavailable',
      message:
        'Database connection is unavailable.'
    });
  }

  next();
}

/* =========================================================
   AUTH
   ========================================================= */

function auth(req, res, next) {
  const token =
    req.headers.authorization || '';

  if (
    !ADMIN_TOKEN ||
    token !== `Bearer ${ADMIN_TOKEN}`
  ) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  next();
}

/* =========================================================
   ENCRYPTION
   ========================================================= */

function now() {
  return Date.now();
}

function enc(value) {
  if (KEY.length !== 32) {
    throw new Error(
      'CREDENTIAL_KEY must decode to exactly 32 bytes.'
    );
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    KEY,
    iv
  );

  const data = Buffer.concat([
    cipher.update(
      String(value),
      'utf8'
    ),
    cipher.final()
  ]);

  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher
      .getAuthTag()
      .toString('base64')
  };
}

function dec(value) {
  if (KEY.length !== 32) {
    throw new Error(
      'CREDENTIAL_KEY must decode to exactly 32 bytes.'
    );
  }

  const decipher =
    crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(
        value.iv,
        'base64'
      )
    );

  decipher.setAuthTag(
    Buffer.from(
      value.tag,
      'base64'
    )
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(
        value.data,
        'base64'
      )
    ),
    decipher.final()
  ]).toString('utf8');
}

/* =========================================================
   ORDER ID
   ========================================================= */

function newOrderId() {
  return (
    'FD-' +
    Date.now()
      .toString(36)
      .toUpperCase() +
    '-' +
    crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()
  );
}

/* =========================================================
   VISITOR STATS
   ========================================================= */

async function visitorStats() {
  await ensureDatabase();

  if (!pool || databaseError) {
    return {
      online: 0,
      total: 0,
      today: 0,
      exited: 0
    };
  }

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE last_seen >
          NOW() - INTERVAL '35 seconds'
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

/* =========================================================
   VISITOR HEARTBEAT
   ========================================================= */

app.post(
  '/api/visitor/heartbeat',
  dbRequired,
  async (req, res) => {
    try {
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
          (
            id,
            first_seen,
            last_seen,
            exited_at
          )
        VALUES
          (
            $1,
            NOW(),
            NOW(),
            NULL
          )

        ON CONFLICT (id)
        DO UPDATE SET
          last_seen = NOW(),
          exited_at = NULL
        `,
        [id]
      );

      res.json(
        await visitorStats()
      );

    } catch (error) {
      console.error(
        'Heartbeat error:',
        error
      );

      res.status(500).json({
        error: 'visitor error'
      });
    }
  }
);

/* =========================================================
   VISITOR EXIT
   ========================================================= */

app.post(
  '/api/visitor/exit',
  dbRequired,
  async (req, res) => {
    try {
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

      res.json(
        await visitorStats()
      );

    } catch (error) {
      console.error(
        'Visitor exit error:',
        error
      );

      res.status(500).json({
        error: 'visitor error'
      });
    }
  }
);

/* =========================================================
   VISITOR STATS
   ========================================================= */

app.get(
  '/api/visitor/stats',
  dbRequired,
  async (req, res) => {
    try {
      res.json(
        await visitorStats()
      );
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: 'visitor error'
      });
    }
  }
);

/* =========================================================
   PACKAGES
   ========================================================= */

app.get(
  '/api/packages',
  dbRequired,
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            type,
            diamonds,
            price
          FROM packages
          WHERE active = TRUE
          ORDER BY
            CASE
              WHEN type = 'id' THEN 1
              WHEN type = 'account' THEN 2
              ELSE 3
            END,
            diamonds ASC
        `);

      res.json(
        result.rows
      );

    } catch (error) {
      console.error(
        'Packages error:',
        error
      );

      res.status(500).json({
        error: 'packages error'
      });
    }
  }
);

/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post(
  '/api/orders',
  dbRequired,
  upload.single('receipt'),
  async (req, res) => {
    try {
      const {
        type,
        diamonds,
        price,
        playerId,
        username,
        password,
        customerName
      } = req.body;

      if (
        !['id', 'account'].includes(
          String(type)
        )
      ) {
        return res.status(400).json({
          error:
            'نوع الشحن غير صحيح'
        });
      }

      const packageResult =
        await pool.query(
          `
          SELECT
            type,
            diamonds,
            price
          FROM packages
          WHERE
            type = $1
            AND diamonds = $2
            AND active = TRUE
          LIMIT 1
          `,
          [
            type,
            Number(diamonds)
          ]
        );

      const selectedPackage =
        packageResult.rows[0];

      if (!selectedPackage) {
        return res.status(400).json({
          error:
            'الباقة غير موجودة أو غير مفعلة'
        });
      }

      /*
        IMPORTANT:
        Never trust the price sent by the browser.
        Price comes from the database.
      */

      const finalPrice =
        Number(
          selectedPackage.price
        );

      if (
        type === 'id' &&
        !String(
          playerId || ''
        ).trim()
      ) {
        return res.status(400).json({
          error: 'UID مطلوب'
        });
      }

      if (
        type === 'account' &&
        (
          !String(
            username || ''
          ).trim() ||
          !String(
            password || ''
          )
        )
      ) {
        return res.status(400).json({
          error:
            'بيانات الحساب مطلوبة'
        });
      }

      if (
        type === 'account' &&
        KEY.length !== 32
      ) {
        return res.status(500).json({
          error:
            'CREDENTIAL_KEY غير مهيأ بشكل صحيح'
        });
      }

      const id =
        newOrderId();

      let receiptPath = null;

      /* ===================================================
         RECEIPT
         =================================================== */

      if (req.file) {
        if (!supabase) {
          return res.status(500).json({
            error:
              'Storage غير مهيأ على السيرفر'
          });
        }

        const extension =
          req.file.mimetype ===
          'image/png'
            ? 'png'
            : req.file.mimetype ===
              'image/webp'
              ? 'webp'
              : 'jpg';

        receiptPath =
          `${id}-${crypto
            .randomBytes(6)
            .toString('hex')}.${extension}`;

        const { error } =
          await supabase.storage
            .from(
              RECEIPT_BUCKET
            )
            .upload(
              receiptPath,
              req.file.buffer,
              {
                contentType:
                  req.file.mimetype,
                cacheControl:
                  '3600',
                upsert: false
              }
            );

        if (error) {
          console.error(
            'Receipt upload error:',
            error
          );

          return res.status(500).json({
            error:
              'فشل رفع الإيصال'
          });
        }
      }

      const client =
        await pool.connect();

      try {
        await client.query(
          'BEGIN'
        );

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
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'new',
              $8
            )
          `,
          [
            id,
            type,
            Number(
              selectedPackage.diamonds
            ),
            finalPrice,
            String(
              playerId || ''
            ).trim(),
            String(
              customerName || ''
            ).trim(),
            receiptPath,
            type === 'account'
          ]
        );

        if (
          type === 'account'
        ) {
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
              (
                $1,
                $2,
                $3,
                NOW() +
                  INTERVAL '15 minutes'
              )
            `,
            [
              id,
              JSON.stringify(
                enc(username)
              ),
              JSON.stringify(
                enc(password)
              )
            ]
          );
        }

        await client.query(
          'COMMIT'
        );

      } catch (error) {
        await client.query(
          'ROLLBACK'
        );

        if (
          receiptPath &&
          supabase
        ) {
          try {
            await supabase.storage
              .from(
                RECEIPT_BUCKET
              )
              .remove([
                receiptPath
              ]);
          } catch (_) {}
        }

        throw error;

      } finally {
        client.release();
      }

      const message =
        `طلب FODEN%0A` +
        `رقم الطلب: ${encodeURIComponent(
          id
        )}%0A` +
        `الباقة: ${selectedPackage.diamonds} جوهرة%0A` +
        `السعر: ${finalPrice} ج.م%0A` +
        `نوع الشحن: ${
          type === 'id'
            ? 'UID'
            : 'حساب'
        }%0A` +
        (
          type === 'id'
            ? `UID: ${encodeURIComponent(
                playerId
              )}`
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
        error:
          'حدث خطأ أثناء إنشاء الطلب'
      });
    }
  }
);

/* =========================================================
   FORMAT ORDER
   ========================================================= */

function formatOrder(
  row,
  receipt = null
) {
  return {
    id: row.id,
    type: row.type,

    diamonds:
      Number(row.diamonds),

    price:
      Number(row.price),

    playerId:
      row.player_id || '',

    customerName:
      row.customer_name || '',

    receipt,

    status:
      row.status,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,

    hasCredentials:
      row.has_credentials
  };
}

/* =========================================================
   GET ORDERS
   ========================================================= */

app.get(
  '/api/orders',
  auth,
  dbRequired,
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT *
          FROM orders
          ORDER BY
            created_at DESC
        `);

      const orders = [];

      for (
        const row of result.rows
      ) {
        let receipt = null;

        if (
          row.receipt_path &&
          supabase
        ) {
          try {
            const signed =
              await supabase.storage
                .from(
                  RECEIPT_BUCKET
                )
                .createSignedUrl(
                  row.receipt_path,
                  60 * 10
                );

            if (
              signed &&
              !signed.error &&
              signed.data
            ) {
              receipt =
                signed.data.signedUrl;
            }
          } catch (error) {
            console.error(
              'Signed URL error:',
              error.message
            );
          }
        }

        orders.push(
          formatOrder(
            row,
            receipt
          )
        );
      }

      res.json(
        orders
      );

    } catch (error) {
      console.error(
        'Orders error:',
        error
      );

      res.status(500).json({
        error:
          'orders error'
      });
    }
  }
);

/* =========================================================
   UPDATE ORDER
   ========================================================= */

app.patch(
  '/api/orders/:id',
  auth,
  dbRequired,
  async (req, res) => {
    try {
      const allowed = [
        'new',
        'paid',
        'processing',
        'completed',
        'cancelled'
      ];

      if (
        !allowed.includes(
          req.body.status
        )
      ) {
        return res.status(400).json({
          error: 'status'
        });
      }

      const result =
        await pool.query(
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
          error:
            'not found'
        });
      }

      res.json(
        formatOrder(
          result.rows[0]
        )
      );

    } catch (error) {
      console.error(
        'Update order error:',
        error
      );

      res.status(500).json({
        error:
          'update error'
      });
    }
  }
);

/* =========================================================
   GET ACCOUNT CREDENTIALS
   ========================================================= */

app.get(
  '/api/orders/:id/credentials',
  auth,
  dbRequired,
  async (req, res) => {
    try {
      const result =
        await pool.query(
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

      const secret =
        result.rows[0];

      if (
        !secret ||
        new Date(
          secret.expires_at
        ).getTime() < now()
      ) {
        await pool.query(
          `
          DELETE FROM order_secrets
          WHERE order_id = $1
          `,
          [req.params.id]
        );

        return res.status(404).json({
          error:
            'انتهت صلاحية بيانات الدخول'
        });
      }

      const resultData = {
        username:
          dec(
            secret.username
          ),

        password:
          dec(
            secret.password
          )
      };

      /*
        Credentials are deleted after being viewed.
      */

      await pool.query(
        `
        DELETE FROM order_secrets
        WHERE order_id = $1
        `,
        [req.params.id]
      );

      res.json(
        resultData
      );

    } catch (error) {
      console.error(
        'Credential error:',
        error
      );

      res.status(500).json({
        error:
          'credential error'
      });
    }
  }
);

/* =========================================================
   ADMIN STATS
   ========================================================= */

app.get(
  '/api/admin/stats',
  auth,
  dbRequired,
  async (req, res) => {
    try {
      const [
        orders,
        visitors
      ] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*)::int
              AS total,

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

      const row =
        orders.rows[0];

      res.json({
        visitors,

        orders:
          Number(
            row.total
          ),

        counts: {
          new:
            Number(row.new),

          paid:
            Number(row.paid),

          processing:
            Number(
              row.processing
            ),

          completed:
            Number(
              row.completed
            ),

          cancelled:
            Number(
              row.cancelled
            )
        }
      });

    } catch (error) {
      console.error(
        'Stats error:',
        error
      );

      res.status(500).json({
        error:
          'stats error'
      });
    }
  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  '/api/health',
  async (req, res) => {
    try {
      const ok =
        await ensureDatabase();

      if (
        !ok ||
        !pool
      ) {
        return res.status(503).json({
          ok: false,
          database: false,
          error:
            databaseError?.message ||
            'Database unavailable'
        });
      }

      await pool.query(
        'SELECT 1'
      );

      res.json({
        ok: true,
        database: true
      });

    } catch (error) {
      console.error(
        'HEALTH CHECK ERROR:',
        error
      );

      res.status(503).json({
        ok: false,
        database: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   API 404
   ========================================================= */

app.use(
  '/api',
  (req, res) => {
    res.status(404).json({
      error: 'API route not found'
    });
  }
);

/* =========================================================
   STATIC ROUTES
   ========================================================= */

app.get(
  '/admin.html',
  (req, res) => {
    res.sendFile(
      path.join(
        ROOT,
        'admin.html'
      )
    );
  }
);

/*
  Do NOT use app.get(/.*/, ...) here.
  This keeps API handling separated from the frontend.
*/

app.get(
  '*',
  (req, res) => {
    res.sendFile(
      path.join(
        ROOT,
        'index.html'
      )
    );
  }
);

/* =========================================================
   VERCEL
   ========================================================= */

/*
  IMPORTANT:
  NO app.listen() on Vercel.

  Vercel handles the HTTP server.
*/

module.exports = app;
```
