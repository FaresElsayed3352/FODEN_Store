```javascript
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN || 'CHANGE_ME';

const WHATSAPP =
  process.env.WHATSAPP_NUMBER || '201020477414';

const CREDENTIAL_KEY =
  process.env.CREDENTIAL_KEY || '';

const KEY =
  Buffer.from(CREDENTIAL_KEY, 'base64');

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const RECEIPT_BUCKET = 'receipts';


/* =========================================================
   SUPABASE
   ========================================================= */

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    'WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.'
  );
}

if (KEY.length !== 32) {
  console.warn(
    'WARNING: CREDENTIAL_KEY must decode to exactly 32 bytes.'
  );
}

const supabase =
  SUPABASE_URL &&
  SUPABASE_SERVICE_ROLE_KEY
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
  process.env.DATABASE_URL;

if (!rawConnectionString) {
  console.warn(
    'WARNING: No PostgreSQL connection string found.'
  );
}

let connectionString =
  rawConnectionString || null;

if (connectionString) {
  try {
    const url =
      new URL(connectionString);

    /*
      node-postgres can let SSL parameters from the
      connection string override the explicit SSL config.

      We remove them and control SSL below.
    */

    url.searchParams.delete(
      'sslmode'
    );

    url.searchParams.delete(
      'sslrootcert'
    );

    url.searchParams.delete(
      'sslcert'
    );

    url.searchParams.delete(
      'sslkey'
    );

    url.searchParams.delete(
      'pgbouncer'
    );

    url.searchParams.delete(
      'supa'
    );

    connectionString =
      url.toString();

  } catch (error) {
    console.error(
      'Invalid PostgreSQL connection string:',
      error
    );
  }
}

const pool =
  connectionString
    ? new Pool({
        connectionString,

        /*
          Fix for the certificate-chain error
          that appeared in the Vercel runtime.
        */
        ssl: {
          rejectUnauthorized: false
        },

        max: 2,

        idleTimeoutMillis:
          10000,

        connectionTimeoutMillis:
          10000
      })
    : null;


/* =========================================================
   DEFAULT PACKAGES
   =========================================================

   الأسعار مأخوذة من الصورة التي أرسلتها:

   ID:
   110  = 60
   231  = 120
   341  = 165
   460  = 220
   583  = 270
   1040 = 470
   1188 = 540
   2002 = 900
   2420 = 1050
   3000 = 1350
   5000 = 2190
   5600 = 2450

   Account:
   110  = 55
   310  = 145
   520  = 220
   1060 = 380
   2180 = 760
   3240 = 1140
   5600 = 1850
   11200 = 3700
   ========================================================= */

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


/* =========================================================
   DATABASE INITIALIZATION
   ========================================================= */

async function initDatabase() {
  if (!pool) {
    throw new Error(
      'Database is not configured.'
    );
  }

  /*
    Test connection first.
  */

  await pool.query(
    'SELECT 1'
  );

  /*
    Create tables.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,

      type TEXT NOT NULL
        CHECK (
          type IN ('id', 'account')
        ),

      diamonds INTEGER NOT NULL,

      price NUMERIC NOT NULL,

      player_id TEXT DEFAULT '',

      customer_name TEXT DEFAULT '',

      receipt_path TEXT,

      status TEXT NOT NULL
        DEFAULT 'new',

      has_credentials BOOLEAN NOT NULL
        DEFAULT FALSE,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_secrets (
      order_id TEXT PRIMARY KEY
        REFERENCES orders(id)
        ON DELETE CASCADE,

      username JSONB NOT NULL,

      password JSONB NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,

      first_seen TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      last_seen TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      exited_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id BIGSERIAL PRIMARY KEY,

      type TEXT NOT NULL
        CHECK (
          type IN ('id', 'account')
        ),

      diamonds INTEGER NOT NULL,

      price NUMERIC NOT NULL,

      active BOOLEAN NOT NULL
        DEFAULT TRUE
    )
  `);


  /* =======================================================
     PACKAGE SYNC
     =======================================================

     بدل الاعتماد على COUNT فقط، نقوم بمزامنة القائمة
     الصحيحة حتى تختفي الباقات القديمة أو الناقصة.
     ======================================================= */

  await pool.query(
    'BEGIN'
  );

  try {
    await pool.query(
      'DELETE FROM packages'
    );

    for (
      const [diamonds, price]
      of defaultPackages.id
    ) {
      await pool.query(
        `
        INSERT INTO packages
          (
            type,
            diamonds,
            price,
            active
          )
        VALUES
          (
            $1,
            $2,
            $3,
            TRUE
          )
        `,
        [
          'id',
          diamonds,
          price
        ]
      );
    }

    for (
      const [diamonds, price]
      of defaultPackages.account
    ) {
      await pool.query(
        `
        INSERT INTO packages
          (
            type,
            diamonds,
            price,
            active
          )
        VALUES
          (
            $1,
            $2,
            $3,
            TRUE
          )
        `,
        [
          'account',
          diamonds,
          price
        ]
      );
    }

    await pool.query(
      'COMMIT'
    );

  } catch (error) {
    await pool.query(
      'ROLLBACK'
    );

    throw error;
  }


  /* =======================================================
     SUPABASE STORAGE
     ======================================================= */

  if (supabase) {
    try {
      const {
        data: buckets,
        error: listError
      } =
        await supabase.storage
          .listBuckets();

      if (listError) {
        console.error(
          'Storage list error:',
          listError.message
        );
      } else {
        const exists =
          buckets?.some(
            (bucket) =>
              bucket.name ===
              RECEIPT_BUCKET
          );

        if (!exists) {
          const {
            error: createError
          } =
            await supabase.storage
              .createBucket(
                RECEIPT_BUCKET,
                {
                  public: false,

                  allowedMimeTypes: [
                    'image/jpeg',
                    'image/png',
                    'image/webp'
                  ],

                  fileSizeLimit:
                    5 * 1024 * 1024
                }
              );

          if (
            createError &&
            !/already exists/i.test(
              createError.message ||
                ''
            )
          ) {
            console.error(
              'Storage bucket error:',
              createError.message
            );
          }
        }
      }

    } catch (error) {
      console.error(
        'Storage initialization error:',
        error
      );
    }
  }

  console.log(
    'Database initialized successfully.'
  );

  return true;
}


/*
  Initialize once per serverless instance.
*/

const ready =
  initDatabase().catch(
    (error) => {
      console.error(
        'Database initialization failed:',
        error
      );

      throw error;
    }
  );


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

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        5 * 1024 * 1024
    },

    fileFilter: (
      _,
      file,
      cb
    ) => {
      const allowed =
        /^image\/(jpeg|png|webp)$/
          .test(
            file.mimetype
          );

      cb(
        null,
        allowed
      );
    }
  });


/* =========================================================
   AUTH
   ========================================================= */

function auth(
  req,
  res,
  next
) {
  if (
    !ADMIN_TOKEN ||
    req.headers.authorization !==
      `Bearer ${ADMIN_TOKEN}`
  ) {
    return res
      .status(401)
      .json({
        error:
          'unauthorized'
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
      'CREDENTIAL_KEY not configured'
    );
  }

  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      'aes-256-gcm',
      KEY,
      iv
    );

  const data =
    Buffer.concat([
      cipher.update(
        String(value),
        'utf8'
      ),

      cipher.final()
    ]);

  return {
    iv:
      iv.toString(
        'base64'
      ),

    data:
      data.toString(
        'base64'
      ),

    tag:
      cipher
        .getAuthTag()
        .toString(
          'base64'
        )
  };
}


function dec(value) {
  if (KEY.length !== 32) {
    throw new Error(
      'CREDENTIAL_KEY not configured'
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
  ]).toString(
    'utf8'
  );
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
  await ready;

  const result =
    await pool.query(`
      SELECT

        COUNT(*) FILTER (
          WHERE last_seen >
            NOW() -
            INTERVAL '35 seconds'
        )::int AS online,

        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE first_seen::date =
            (
              NOW()
              AT TIME ZONE 'UTC'
            )::date
        )::int AS today,

        COUNT(*) FILTER (
          WHERE exited_at::date =
            (
              NOW()
              AT TIME ZONE 'UTC'
            )::date
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
  async (
    req,
    res
  ) => {
    try {
      await ready;

      const id =
        String(
          req.body?.id ||
            ''
        ).slice(
          0,
          100
        );

      if (!id) {
        return res
          .status(400)
          .json({
            error:
              'id'
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

      return res.json(
        await visitorStats()
      );

    } catch (error) {
      console.error(
        'Heartbeat error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'visitor error'
        });
    }
  }
);


/* =========================================================
   VISITOR EXIT
   ========================================================= */

app.post(
  '/api/visitor/exit',
  async (
    req,
    res
  ) => {
    try {
      await ready;

      const id =
        String(
          req.body?.id ||
            ''
        ).slice(
          0,
          100
        );

      if (id) {
        await pool.query(
          `
          UPDATE visitors

          SET
            exited_at = NOW()

          WHERE id = $1
          `,
          [id]
        );
      }

      return res.json(
        await visitorStats()
      );

    } catch (error) {
      console.error(
        'Exit error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'visitor error'
        });
    }
  }
);


/* =========================================================
   VISITOR STATS API
   ========================================================= */

app.get(
  '/api/visitor/stats',
  async (
    req,
    res
  ) => {
    try {
      return res.json(
        await visitorStats()
      );

    } catch (error) {
      console.error(
        'Visitor stats error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'visitor error'
        });
    }
  }
);


/* =========================================================
   PACKAGES API
   ========================================================= */

app.get(
  '/api/packages',
  async (
    req,
    res
  ) => {
    try {
      await ready;

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
              WHEN type = 'id'
              THEN 1
              ELSE 2
            END,
            diamonds ASC
        `);

      return res.json(
        result.rows
      );

    } catch (error) {
      console.error(
        'Packages error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'packages error'
        });
    }
  }
);


/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post(
  '/api/orders',
  upload.single('receipt'),
  async (
    req,
    res
  ) => {
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


      /* ---------------------------------------------------
         Validate type
         --------------------------------------------------- */

      if (
        ![
          'id',
          'account'
        ].includes(type)
      ) {
        return res
          .status(400)
          .json({
            error:
              'نوع شحن غير صحيح'
          });
      }


      /* ---------------------------------------------------
         Validate package against database
         --------------------------------------------------- */

      const packageResult =
        await pool.query(
          `
          SELECT
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

      if (
        !packageResult.rows[0]
      ) {
        return res
          .status(400)
          .json({
            error:
              'الباقة غير موجودة'
          });
      }

      const selectedPackage =
        packageResult.rows[0];

      const dbPrice =
        Number(
          selectedPackage.price
        );

      const sentPrice =
        Number(price);

      /*
        لا نعتمد على السعر القادم من المتصفح.
        السعر الصحيح يأتي من قاعدة البيانات.
      */

      if (
        !Number.isFinite(
          sentPrice
        ) ||
        sentPrice !== dbPrice
      ) {
        return res
          .status(400)
          .json({
            error:
              'سعر الباقة غير صحيح'
          });
      }


      /* ---------------------------------------------------
         ID validation
         --------------------------------------------------- */

      if (
        type === 'id' &&
        !String(
          playerId || ''
        ).trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              'UID مطلوب'
          });
      }


      /* ---------------------------------------------------
         Account validation
         --------------------------------------------------- */

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
        return res
          .status(400)
          .json({
            error:
              'بيانات الحساب مطلوبة'
          });
      }


      if (
        type === 'account' &&
        KEY.length !== 32
      ) {
        return res
          .status(500)
          .json({
            error:
              'التشفير غير مهيأ على السيرفر'
          });
      }


      /* ---------------------------------------------------
         Order ID
         --------------------------------------------------- */

      const id =
        newOrderId();


      /* ---------------------------------------------------
         Receipt upload
         --------------------------------------------------- */

      let receiptPath =
        null;

      if (req.file) {
        if (!supabase) {
          return res
            .status(500)
            .json({
              error:
                'Storage غير مهيأ على السيرفر'
            });
        }

        let extension =
          'jpg';

        if (
          req.file.mimetype ===
          'image/png'
        ) {
          extension =
            'png';
        } else if (
          req.file.mimetype ===
          'image/webp'
        ) {
          extension =
            'webp';
        }

        receiptPath =
          `${id}-${crypto
            .randomBytes(6)
            .toString('hex')}.${extension}`;

        const {
          error
        } =
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

                upsert:
                  false
              }
            );

        if (error) {
          console.error(
            'Receipt upload error:',
            error
          );

          return res
            .status(500)
            .json({
              error:
                'فشل رفع الإيصال'
            });
        }
      }


      /* ---------------------------------------------------
         Database transaction
         --------------------------------------------------- */

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

            dbPrice,

            String(
              playerId || ''
            ).trim(),

            String(
              customerName || ''
            ).trim(),

            receiptPath,

            type ===
              'account'
          ]
        );


        /* -----------------------------------------------
           Account credentials
           ----------------------------------------------- */

        if (
          type ===
          'account'
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
          } catch (
            cleanupError
          ) {
            console.error(
              'Receipt cleanup error:',
              cleanupError
            );
          }
        }

        throw error;

      } finally {
        client.release();
      }


      /* ---------------------------------------------------
         WhatsApp message
         --------------------------------------------------- */

      let message =
        `طلب FODEN%0A` +
        `رقم الطلب: ${encodeURIComponent(
          id
        )}%0A` +
        `الباقة: ${encodeURIComponent(
          diamonds
        )} جوهرة%0A` +
        `السعر: ${encodeURIComponent(
          dbPrice
        )} ج.م%0A` +
        `نوع الشحن: ${
          type === 'id'
            ? 'UID'
            : 'حساب'
        }%0A`;

      if (
        type === 'id'
      ) {
        message +=
          `UID: ${encodeURIComponent(
            String(
              playerId
            ).trim()
          )}`;
      }

      return res.json({
        ok: true,

        orderId:
          id,

        whatsapp:
          `https://wa.me/${WHATSAPP}?text=${message}`
      });

    } catch (error) {
      console.error(
        'Order error:',
        error
      );

      return res
        .status(500)
        .json({
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
    id:
      row.id,

    type:
      row.type,

    diamonds:
      Number(
        row.diamonds
      ),

    price:
      Number(
        row.price
      ),

    playerId:
      row.player_id ||
      '',

    customerName:
      row.customer_name ||
      '',

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
  async (
    req,
    res
  ) => {
    try {
      await ready;

      const result =
        await pool.query(`
          SELECT *
          FROM orders

          ORDER BY
            created_at DESC
        `);

      const orders =
        [];

      for (
        const row
        of result.rows
      ) {
        let receipt =
          null;

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
              !signed.error &&
              signed.data
            ) {
              receipt =
                signed.data
                  .signedUrl;
            }
          } catch (
            receiptError
          ) {
            console.error(
              'Receipt URL error:',
              receiptError
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

      return res.json(
        orders
      );

    } catch (error) {
      console.error(
        'Orders error:',
        error
      );

      return res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
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
        !allowed.includes(
          req.body.status
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'status'
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

      if (
        !result.rows[0]
      ) {
        return res
          .status(404)
          .json({
            error:
              'not found'
          });
      }

      return res.json(
        formatOrder(
          result.rows[0]
        )
      );

    } catch (error) {
      console.error(
        'Update order error:',
        error
      );

      return res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
    try {
      await ready;

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
        ).getTime() <
          now()
      ) {
        await pool.query(
          `
          DELETE FROM order_secrets

          WHERE order_id = $1
          `,
          [req.params.id]
        );

        return res
          .status(404)
          .json({
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
        Delete immediately after retrieval.
        Credentials are one-time readable.
      */

      await pool.query(
        `
        DELETE FROM order_secrets

        WHERE order_id = $1
        `,
        [req.params.id]
      );

      return res.json(
        resultData
      );

    } catch (error) {
      console.error(
        'Credential error:',
        error
      );

      return res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
    try {
      await ready;

      const [
        orders,
        visitors
      ] =
        await Promise.all([
          pool.query(`
            SELECT

              COUNT(*)::int
                AS total,

              COUNT(*) FILTER (
                WHERE status =
                  'new'
              )::int AS new,

              COUNT(*) FILTER (
                WHERE status =
                  'paid'
              )::int AS paid,

              COUNT(*) FILTER (
                WHERE status =
                  'processing'
              )::int AS processing,

              COUNT(*) FILTER (
                WHERE status =
                  'completed'
              )::int AS completed,

              COUNT(*) FILTER (
                WHERE status =
                  'cancelled'
              )::int AS cancelled

            FROM orders
          `),

          visitorStats()
        ]);

      const row =
        orders.rows[0];

      return res.json({
        visitors,

        orders:
          Number(
            row.total
          ),

        counts: {
          new:
            Number(
              row.new
            ),

          paid:
            Number(
              row.paid
            ),

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
        'Admin stats error:',
        error
      );

      return res
        .status(500)
        .json({
          error:
            'stats error'
        });
    }
  }
);


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  '/api/health',
  async (
    req,
    res
  ) => {
    try {
      await ready;

      await pool.query(
        'SELECT 1'
      );

      return res.json({
        ok: true,
        database: true
      });

    } catch (error) {
      console.error(
        'HEALTH CHECK ERROR:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          database: false
        });
    }
  }
);


/* =========================================================
   STATIC ROUTES
   ========================================================= */

app.get(
  '/admin.html',
  (
    req,
    res
  ) => {
    res.sendFile(
      path.join(
        ROOT,
        'admin.html'
      )
    );
  }
);


/*
  Keep the frontend route last.
*/

app.get(
  /.*/,
  (
    req,
    res
  ) => {
    res.sendFile(
      path.join(
        ROOT,
        'index.html'
      )
    );
  }
);


/* =========================================================
   VERCEL EXPORT
   ========================================================= */

/*
  IMPORTANT:
  Do NOT use app.listen() on Vercel.

  Vercel imports the Express application
  as a serverless function.
*/

module.exports = app;


/* =========================================================
   LOCAL DEVELOPMENT
   ========================================================= */

if (
  require.main === module
) {
  app.listen(
    PORT,
    () => {
      console.log(
        `FODEN running on port ${PORT}`
      );
    }
  );
}
```
