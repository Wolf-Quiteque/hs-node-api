require('dotenv').config(); // fine for local; on Vercel env comes from dashboard

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');
const { randomUUID } = require('crypto');   // ✅ use built-in UUID

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const {
  ADMIN_KEY = 'changeme',
  MONGODB_URI = '',
  R2_BUCKET = '',
  R2_ENDPOINT = '',
  R2_ACCESS_KEY_ID = '',
  R2_SECRET_ACCESS_KEY = '',
  R2_PUBLIC_BASE_URL = ''
} = process.env;

// ---- Mongo: lazy connect + timeouts (prevents 300s timeouts)
let mongoReady = null;
async function ensureMongo() {
  if (mongoReady) return mongoReady;
  if (!MONGODB_URI) throw new Error('MONGODB_URI missing');
  mongoose.set('strictQuery', true);
  mongoReady = mongoose.connect(MONGODB_URI, {
    dbName: 'news',
    serverSelectionTimeoutMS: 8000, // 8s to connect or fail
    socketTimeoutMS: 20000,
    maxPoolSize: 5
  });
  return mongoReady;
}

// ---- Model (guard against recompile on hot start)
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
const News = mongoose.models.News || mongoose.model('News', NewsSchema);

// ---- R2 client with timeouts (prevents hangs)
const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 3000, // 3s
    requestTimeout: 10000    // 10s
  })
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
  return `${kind}/${year}/${month}/${randomUUID()}-${filename}`;   // ✅
}
function buildPublicUrl(key) {
  // You’re using Option A: R2_PUBLIC_BASE_URL already includes /<bucket>
  return `${R2_PUBLIC_BASE_URL.replace(/\/+$/,'')}/${key}`;
}
function extractKeyFromPublicUrl(publicUrl) {
  const base = R2_PUBLIC_BASE_URL.replace(/\/+$/,'');
  let rest = String(publicUrl).replace(base, '').replace(/^\/+/, '');
  const bucketPath = `/${R2_BUCKET}/`;
  if (rest.startsWith(bucketPath)) rest = rest.slice(bucketPath.length);
  return rest;
}

// ---- Health endpoints (help debug quickly)
app.get('/api/health', (_req,res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/db-health', async (_req,res) => {
  const t0 = Date.now();
  try { await ensureMongo(); return res.json({ ok: true, ms: Date.now()-t0 }); }
  catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

// ---- Upload (no DB needed)
app.post('/api/upload', adminOnly, async (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || !String(dataUrl).startsWith('data:image/webp;base64,')) {
      return res.status(400).json({ error: 'Provide a WEBP dataUrl' });
    }
    const base64 = dataUrl.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const safeName = (String(filename || 'cover.webp').toLowerCase().replace(/[^a-z0-9.\-_]+/g, '-') || 'cover.webp');
    const key = s3KeyFor('news', safeName.endsWith('.webp') ? safeName : (safeName.replace(/\.[^.]+$/, '') + '.webp'));

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable'
    }));

    return res.json({ url: buildPublicUrl(key), key });
  } catch (e) {
    console.error('[upload] error', e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ---- CRUD routes (ensure Mongo inside each)
app.get('/api/news', async (req,res) => {
  try {
    await ensureMongo();
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
    const data = await News.find(where).sort({ date: -1, createdAt: -1 }).skip((p-1)*lim).limit(lim).lean();
    res.json({ data, pagination: { page: p, limit: lim, total, totalPages: Math.max(1, Math.ceil(total/lim)) } });
  } catch (e) {
    console.error('[GET /api/news] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/news/:slug', async (req,res) => {
  try {
    await ensureMongo();
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
    await ensureMongo();
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || '3', 10)));
    const data = await News.find({}).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
    res.json({ data });
  } catch (e) {
    console.error('[GET /api/recent] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/categories', async (_req,res) => {
  try {
    await ensureMongo();
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

app.get('/api/tags', async (_req,res) => {
  try {
    await ensureMongo();
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

app.post('/api/news', adminOnly, async (req,res) => {
  try {
    await ensureMongo();
    const body = req.body || {};
    const slug = toSlug(body.slug || body.title || randomUUID());   // ✅
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
    if (e.code === 11000) return res.status(409).json({ error: 'Slug already exists' });
    console.error('[POST /api/news] error', e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.put('/api/news/:id', adminOnly, async (req,res) => {
  try {
    await ensureMongo();
    const idOrSlug = req.params.id;
    const body = req.body || {};
    const found = await News.findOne({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
    if (!found) return res.status(404).json({ error: 'Not found' });
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

app.delete('/api/news/:id', adminOnly, async (req,res) => {
  try {
    await ensureMongo();
    const idOrSlug = req.params.id;
    const found = await News.findOneAndDelete({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
    if (!found) return res.status(404).json({ error: 'Not found' });

    try {
      if (found.cover && R2_PUBLIC_BASE_URL && found.cover.startsWith(R2_PUBLIC_BASE_URL)) {
        const key = extractKeyFromPublicUrl(found.cover);
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

// 👉 IMPORTANT: no app.listen() on Vercel
// Export a handler so @vercel/node can invoke it:
module.exports = app;          // Express is a handler function (req, res)
