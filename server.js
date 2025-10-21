
/**
 * News REST API with MongoDB + Cloudflare R2 (S3-compatible)
 *
 * Install:
 *   npm init -y
 *   npm i express cors mongoose @aws-sdk/client-s3 uuid
 *
 * Env:
 *   PORT=4000
 *   ADMIN_KEY=changeme
 *   MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/news?retryWrites=true&w=majority
 *
 *   # Cloudflare R2 (S3-compatible)
 *   R2_ACCOUNT_ID=<account-id>
 *   R2_ACCESS_KEY_ID=<access-key-id>
 *   R2_SECRET_ACCESS_KEY=<secret>
 *   R2_BUCKET=<bucket-name>
 *   # The S3 endpoint for R2:
 *   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
 *   # Public base URL for your bucket (r2.dev custom domain or your own CDN):
 *   R2_PUBLIC_BASE_URL=https://<your-public-domain-or-r2.dev-bucket>
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuid } = require('uuid');

// --- Setup
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';

const {
  MONGODB_URI,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_PUBLIC_BASE_URL
} = process.env;

if (!MONGODB_URI) console.warn('[WARN] Missing MONGODB_URI');
if (!R2_BUCKET) console.warn('[WARN] Missing R2_BUCKET');
if (!R2_ENDPOINT) console.warn('[WARN] Missing R2_ENDPOINT');
if (!R2_PUBLIC_BASE_URL) console.warn('[WARN] Missing R2_PUBLIC_BASE_URL');

// --- MongoDB
mongoose.set('strictQuery', true);
mongoose.connect(MONGODB_URI, { dbName: 'news' })
  .then(() => console.log('[MongoDB] connected'))
  .catch(err => console.error('[MongoDB] connection error', err));

const NewsSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  excerpt: { type: String },
  cover: { type: String },
  date: { type: Date, default: Date.now },
  author: { type: String, default: 'H&S Angola' },
  categories: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  content: { type: String, default: '' },
}, { timestamps: true });

const News = mongoose.model('News', NewsSchema);

// --- Cloudflare R2 via AWS SDK v3
const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || ''
  }
});

function adminOnly(req, res, next) {
  const key = req.header('x-admin-key');
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function toSlug(str) {
  return String(str || 'noticia')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function s3KeyFor(kind='news', filename='cover.webp') {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth()+1).padStart(2,'0');
  return `${kind}/${year}/${month}/${uuid()}-${filename}`;
}

// --- Upload endpoint (expects WEBP dataURL to enforce client-side conversion)
app.post('/api/upload', adminOnly, async (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/webp;base64,')) {
      return res.status(400).json({ error: 'Provide a WEBP dataUrl' });
    }
    const base64 = dataUrl.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');

    const safeName = (String(filename || 'cover.webp').toLowerCase().replace(/[^a-z0-9\.\-_]+/g, '-') || 'cover.webp');
    const key = s3KeyFor('news', safeName.endsWith('.webp') ? safeName : (safeName.replace(/\.[^.]+$/, '') + '.webp'));

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    const publicUrl = `${R2_PUBLIC_BASE_URL.replace(/\/+$/,'')}/${key}`;
    return res.json({ url: publicUrl, key });
  } catch (e) {
    console.error('[upload] error', e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// --- CRUD
// List with filters + pagination
app.get('/api/news', async (req,res) => {
  try {
    const { page=1, limit=6, category, tag, q } = req.query;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 6));

    const where = {};
    if (category) where.categories = { $in: [ new RegExp(`^${String(category)}$`, 'i') ] };
    if (tag) where.tags = { $in: [ new RegExp(`^${String(tag)}$`, 'i') ] };
    if (q) {
      const s = String(q);
      where.$or = [
        { title:   { $regex: s, $options: 'i' } },
        { excerpt: { $regex: s, $options: 'i' } },
        { author:  { $regex: s, $options: 'i' } },
      ];
    }

    const total = await News.countDocuments(where);
    const data = await News.find(where)
      .sort({ date: -1, createdAt: -1 })
      .skip((p-1)*lim)
      .limit(lim)
      .lean();

    return res.json({
      data,
      pagination: { page: p, limit: lim, total, totalPages: Math.max(1, Math.ceil(total/lim)) }
    });
  } catch (e) {
    console.error('[GET /api/news] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/news/:slug', async (req,res) => {
  try {
    const idOrSlug = req.params.slug;
    const item = await News.findOne({ $or: [{ slug: idOrSlug }, { _id: idOrSlug }] }).lean();
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (e) {
    console.error('[GET /api/news/:slug] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/recent', async (req,res) => {
  try {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '3', 10)));
    const data = await News.find({}).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
    res.json({ data });
  } catch (e) {
    console.error('[GET /api/recent] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/categories', async (req,res) => {
  try {
    const agg = await News.aggregate([
      { $unwind: { path: "$categories", preserveNullAndEmptyArrays: false } },
      { $group: { _id: { $toLower: "$categories" }, count: { $sum: 1 } } },
      { $project: { name: "$_id", count: 1, _id: 0 } },
      { $sort: { name: 1 } }
    ]);
    res.json({ data: agg });
  } catch (e) {
    console.error('[GET /api/categories] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/tags', async (req,res) => {
  try {
    const agg = await News.aggregate([
      { $unwind: { path: "$tags", preserveNullAndEmptyArrays: false } },
      { $group: { _id: { $toLower: "$tags" }, count: { $sum: 1 } } },
      { $project: { name: "$_id", count: 1, _id: 0 } },
      { $sort: { name: 1 } }
    ]);
    res.json({ data: agg });
  } catch (e) {
    console.error('[GET /api/tags] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Create
app.post('/api/news', adminOnly, async (req,res) => {
  try {
    const body = req.body || {};
    const slug = toSlug(body.slug || body.title || uuid());
    const item = await News.create({
      slug,
      title: body.title || '',
      excerpt: body.excerpt || '',
      cover: body.cover || '',
      date: body.date ? new Date(body.date) : new Date(),
      author: body.author || 'H&S Angola',
      categories: Array.isArray(body.categories) ? body.categories : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
      content: body.content || ''
    });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ error: 'Slug already exists' });
    }
    console.error('[POST /api/news] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Update
app.put('/api/news/:id', adminOnly, async (req,res) => {
  try {
    const idOrSlug = req.params.id;
    const body = req.body || {};
    const found = await News.findOne({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
    if (!found) return res.status(404).json({ error: 'Not found' });

    // Prevent duplicate slug on update
    if (body.slug && body.slug !== found.slug) {
      const newSlug = toSlug(body.slug);
      const exists = await News.exists({ slug: newSlug });
      if (exists) return res.status(409).json({ error: 'Slug already exists' });
      body.slug = newSlug;
    }

    Object.assign(found, body);
    await found.save();
    res.json(found);
  } catch (e) {
    console.error('[PUT /api/news/:id] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Delete
app.delete('/api/news/:id', adminOnly, async (req,res) => {
  try {
    const idOrSlug = req.params.id;
    const found = await News.findOneAndDelete({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
    if (!found) return res.status(404).json({ error: 'Not found' });

    // Optional: if cover is on this bucket, attempt to delete best-effort
    try {
      if (found.cover && R2_PUBLIC_BASE_URL && found.cover.startsWith(R2_PUBLIC_BASE_URL)) {
        const key = found.cover.replace(R2_PUBLIC_BASE_URL, '').replace(/^\/+/, '');
        await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
      }
    } catch (e) {
      console.warn('[delete cover] non-fatal', e);
    }

    res.json(found);
  } catch (e) {
    console.error('[DELETE /api/news/:id] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.listen(PORT, () => {
  console.log(`News API (Mongo + R2) listening on http://localhost:${PORT}`);
});
