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



// ---- Attendance Route for Aprenda & Empreenda Event
const AttendanceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  event: { type: String, default: 'Aprenda & Empreenda' },
  date: { type: Date, default: Date.now },
  confirmed: { type: Boolean, default: false },
  smsSent: { type: Boolean, default: false },
  smsSentAt: { type: Date },
  smsMessageId: { type: String },
  smsError: { type: String }
}, { timestamps: true, collection: 'attendances' });
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', AttendanceSchema);

// POST route to save attendance
app.post('/api/attendance', async (req, res) => {
  try {
    await ensureMongo();
    
    const { name, phone } = req.body;
    
    // Basic validation
    if (!name || !phone) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nome e telefone são obrigatórios' 
      });
    }
    
    if (name.length < 3) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nome deve ter pelo menos 3 caracteres' 
      });
    }
    
    if (phone.length < 9) {
      return res.status(400).json({ 
        success: false, 
        message: 'Telefone deve ter pelo menos 9 dígitos' 
      });
    }
    
    // Check if this phone already registered
    const existing = await Attendance.findOne({ 
      phone: phone,
      event: 'Aprenda & Empreenda'
    });
    
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Este número já foi registado para o evento' 
      });
    }
    
    // Create attendance record
    const attendance = await Attendance.create({
      name: name.trim(),
      phone: phone.trim(),
      event: 'Aprenda & Empreenda',
      date: new Date(),
      confirmed: true
    });
    
    res.status(201).json({ 
      success: true, 
      message: 'Presença confirmada com sucesso!',
      data: {
        id: attendance._id,
        name: attendance.name,
        phone: attendance.phone,
        date: attendance.date
      }
    });
    
  } catch (e) {
    console.error('[POST /api/attendance] error', e);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao processar a inscrição. Tente novamente.' 
    });
  }
});

// Optional: GET route to see all attendees (admin only)
app.get('/api/attendance', adminOnly, async (req, res) => {
  try {
    await ensureMongo();
    const { event = 'Aprenda & Empreenda' } = req.query;
    const attendees = await Attendance.find({ event })
      .sort({ date: -1 })
      .lean();
    
    res.json({ 
      success: true, 
      count: attendees.length,
      data: attendees 
    });
  } catch (e) {
    console.error('[GET /api/attendance] error', e);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao obter lista de participantes' 
    });
  }
});


// ---- Public Admin Routes (no authentication needed for viewing)
app.get('/api/attendance/public', async (req, res) => {
  try {
    await ensureMongo();
    const { 
      page = 1, 
      limit = 10,
      search = '',
      filter = 'all',
      sortBy = 'date',
      sortOrder = 'desc'
    } = req.query;
    
    // Build query - REMOVED event filter
    const query = {}; 
    
    // Apply search filter (Name or Phone)
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: searchRegex },
        { phone: searchRegex } // Unified regex for phone search
      ];
    }
    
    // Apply SMS filters
    if (filter === 'sms-sent') {
      query.smsSent = true;
    } else if (filter === 'sms-not-sent') {
      query.smsSent = false;
    }
    
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    
    // Fetch data
    const total = await Attendance.countDocuments(query);
    const data = await Attendance.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean();
      
    // Simplified Statistics (No event filter needed)
    const totalCount = await Attendance.countDocuments({});
    const smsSentCount = await Attendance.countDocuments({ smsSent: true });
    
    // ... rest of your date-based statistics code

    res.json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      },
      statistics: {
        total: totalCount,
        smsSent: smsSentCount,
        // ... include other stats here
      }
    });
    
  } catch (e) {
    console.error('[GET /api/attendance/public] error', e);
    res.status(500).json({ success: false, message: 'Erro ao obter dados' });
  }
});

// Delete attendance (public but with basic validation)
app.delete('/api/attendance/public/:id', async (req, res) => {
  try {
    await ensureMongo();
    
    const attendanceId = req.params.id;
    
    // You might want to add some validation here, like checking a simple token
    // For now, we'll allow deletion but you should implement proper security
    const deleted = await Attendance.findByIdAndDelete(attendanceId);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Registro não encontrado'
      });
    }
    
    res.json({
      success: true,
      message: 'Inscrição eliminada com sucesso',
      data: deleted
    });
    
  } catch (e) {
    console.error('[DELETE /api/attendance/public/:id] error', e);
    res.status(500).json({
      success: false,
      message: 'Erro ao eliminar inscrição'
    });
  }
});

// ---- SMS Integration with Ombala API
const axios = require('axios'); // Add this at the top with other requires

// Ombala API Configuration
const OMBALA_API_URL = 'https://api.useombala.ao/v1/messages';
const OMBALA_API_TOKEN = process.env.OMBALA_API_TOKEN || '';
const OMBALA_SENDER_NAME = process.env.OMBALA_SENDER_NAME || 'APRENDAEMPR';

// Send SMS via Ombala API
async function sendOmbalaSMS(phoneNumber, message) {
  try {
    // Clean phone number (remove spaces, plus signs, etc.)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    
    // Ensure phone starts with country code for Angola
    let formattedPhone = cleanPhone;
    if (!formattedPhone.startsWith('244')) {
      if (formattedPhone.startsWith('9') || formattedPhone.startsWith('2')) {
        formattedPhone = '244' + formattedPhone;
      } else if (formattedPhone.startsWith('0')) {
        formattedPhone = '244' + formattedPhone.substring(1);
      }
    }
    
    const payload = {
      message: message,
      from: OMBALA_SENDER_NAME,
      to: cleanPhone
    };
    
    const response = await axios.post(OMBALA_API_URL, payload, {
      headers: {
        'Authorization': `Token ${OMBALA_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    });
    
    return {
      success: true,
      data: response.data,
      messageId: response.data?.id
    };
    
  } catch (error) {
    console.error('[Ombala SMS] Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.error || error.message,
      status: error.response?.status
    };
  }
}

// Send thank you SMS after attendance registration
app.post('/api/attendance/:id/send-sms', adminOnly, async (req, res) => {
  try {
    await ensureMongo();
    
    const attendanceId = req.params.id;
    const { customMessage } = req.body;
    
    if (!OMBALA_API_TOKEN || !OMBALA_SENDER_NAME) {
      return res.status(500).json({
        success: false,
        message: 'Configuração de SMS não está completa'
      });
    }
    
    // Find attendance record
    const attendance = await Attendance.findById(attendanceId);
    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'Registro de presença não encontrado'
      });
    }
    
    // Prepare thank you message
    const message = customMessage || `
Olá ${attendance.name.split(' ')[0]}! Obrigado por confirmar presença no evento Aprenda & Empreenda.

📅 Data: 20 de Dezembro
🕗 Hora: 8h00
📍 Local: Sala de Conferência do Shopping Popular (Camama)

Para mais informações: 942 218 877 | 953 990 348

Contamos com a sua presença!
Equipe Aprenda & Empreenda
    `.trim();
    
    // Send SMS
    const smsResult = await sendOmbalaSMS(attendance.phone, message);
    
    if (smsResult.success) {
      // Update attendance record with SMS info
      attendance.smsSent = true;
      attendance.smsSentAt = new Date();
      attendance.smsMessageId = smsResult.messageId;
      await attendance.save();
      
      res.json({
        success: true,
        message: 'SMS enviado com sucesso',
        data: {
          attendanceId: attendance._id,
          phone: attendance.phone,
          message: message,
          smsResult: smsResult.data
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Falha ao enviar SMS',
        error: smsResult.error
      });
    }
    
  } catch (e) {
    console.error('[POST /api/attendance/:id/send-sms] error', e);
    res.status(500).json({
      success: false,
      message: 'Erro ao processar pedido de SMS'
    });
  }
});

// Auto-send SMS on attendance registration (optional)
app.post('/api/attendance-with-sms', async (req, res) => {
  try {
    await ensureMongo();
    
    const { name, phone } = req.body;
    
    // Basic validation
    if (!name || !phone) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nome e telefone são obrigatórios' 
      });
    }
    
    if (name.length < 3) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nome deve ter pelo menos 3 caracteres' 
      });
    }
    
    if (phone.length < 9) {
      return res.status(400).json({ 
        success: false, 
        message: 'Telefone deve ter pelo menos 9 dígitos' 
      });
    }
    
    // Check if this phone already registered
    const existing = await Attendance.findOne({ 
      phone: phone,
      event: 'Aprenda & Empreenda'
    });
    
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        message: 'Este número já foi registado para o evento' 
      });
    }
    
    // Create attendance record
    const attendance = await Attendance.create({
      name: name.trim(),
      phone: phone.trim(),
      event: 'Aprenda & Empreenda',
      date: new Date(),
      confirmed: true
    });
    
    // Try to send SMS (non-blocking)
    let smsResult = null;
    if (OMBALA_API_TOKEN && OMBALA_SENDER_NAME) {
      try {
        const message = `
Olá ${name.split(' ')[0]}! Obrigado por confirmar presença na Conferência Aprenda & Empreenda.`.trim();
        
        smsResult = await sendOmbalaSMS(phone, message);
        
        if (smsResult.success) {
          attendance.smsSent = true;
          attendance.smsSentAt = new Date();
          attendance.smsMessageId = smsResult.messageId;
          await attendance.save();
        }
      } catch (smsError) {
        console.warn('[Auto SMS] Failed to send:', smsError.message);
        // Continue even if SMS fails
      }
    }
    
    res.status(201).json({ 
      success: true, 
      message: 'Presença confirmada com sucesso!' + (smsResult?.success ? ' SMS enviado.' : ''),
      data: {
        id: attendance._id,
        name: attendance.name,
        phone: attendance.phone,
        date: attendance.date,
        smsSent: smsResult?.success || false
      }
    });
    
  } catch (e) {
    console.error('[POST /api/attendance-with-sms] error', e);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao processar a inscrição. Tente novamente.' 
    });
  }
});

// 👉 IMPORTANT: no app.listen() on Vercel
// Export a handler so @vercel/node can invoke it:
module.exports = app;          // Express is a handler function (req, res)
