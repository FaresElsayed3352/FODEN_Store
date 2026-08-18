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
process.env.POSTGRES_URL_NON_POOLING ||
process.env.POSTGRES_PRISMA_URL ||
process.env.POSTGRES_URL;

if (!connectionString) {
console.warn('WARNING: No Postgres connection string found.');
}

const pool = connectionString
? new Pool({
connectionString: connectionString.replace(
/[?&]sslmode=[^&]*/i,
''
),
ssl: {
rejectUnauthorized: false
},
max: 2
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
        INSERT INTO packages (type, diamonds, price, active)
        VALUES ($1, $2, $3, TRUE)
       ,
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
/^image/(jpeg|png|webp)$/.test(file.mimetype)
);
}
});

function auth(req, res, next) {
if (
!ADMIN_TOKEN ||
req.headers.authorization !== Bearer ${ADMIN_TOKEN}
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
