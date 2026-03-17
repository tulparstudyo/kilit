const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const { pool, migrate, checkConnection } = require('./helper');
const { sendWelcomeEmail, sendResetEmail, sendInstitutionNotification } = require('./smtp');

const app = express();
app.use(cors({
  origin: ['https://kilit.dosyamosya.com'],
  credentials: true
}));
app.use(express.json());

// ─── Başarısız giriş denemesi takibi (brute-force koruması) ───
const loginAttempts = new Map(); // key: phone/code → { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 dakika

function checkLoginAttempts(key) {
  const record = loginAttempts.get(key);
  if (!record) return { allowed: true };
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    const remaining = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return { allowed: false, remaining };
  }
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedAttempt(key) {
  const record = loginAttempts.get(key) || { count: 0, lockedUntil: null };
  record.count += 1;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_DURATION_MS;
    record.count = 0;
  }
  loginAttempts.set(key, record);
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// Eski kayıtları temizle (her 10 dakika)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    if (record.lockedUntil && now >= record.lockedUntil) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000);

// ─── Cache busting middleware (startup'ta HTML'leri oku, bellekte tut) ───
const fs = require('fs');
const APP_VERSION = process.env.APP_VERSION || Date.now();
const htmlCache = new Map();
const publicDir = path.join(__dirname, 'public');

function loadHtmlCache() {
  const allowedFiles = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
  for (const file of allowedFiles) {
    try {
      let html = fs.readFileSync(path.join(publicDir, file), 'utf-8');
      html = html.replace(/layout\.js"/g, `layout.js?v=${APP_VERSION}"`);
      html = html.replace(/style\.css"/g, `style.css?v=${APP_VERSION}"`);
      htmlCache.set(file, html);
    } catch { /* dosya okunamazsa atla */ }
  }
}
loadHtmlCache();

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/admin') {
    const fileName = req.path === '/' ? 'index.html'
      : req.path === '/admin' ? 'admin.html'
      : req.path.split('/').pop();
    const cached = htmlCache.get(fileName);
    if (cached) {
      res.type('html').send(cached);
    } else {
      next();
    }
  } else {
    next();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// QR oturumları bellekte (kısa ömürlü)
const qrSessions = new Map();

// Middleware: Token doğrulama
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
};

// REGISTER
app.post('/register', async (req, res) => {
  const { name, phone, password, institutionId } = req.body;
  if (!name || !phone || !password || !institutionId) {
    return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, phone, institution_id, password) VALUES (?, ?, ?, ?)',
      [name, phone, parseInt(institutionId), hashedPassword]
    );

    res.json({ message: 'Kayıt başarılı!' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      if (err.message.includes('phone') || err.message.includes('idx_phone')) {
        return res.status(400).json({ error: 'Bu telefon numarası zaten kayıtlı' });
      }
      return res.status(400).json({ error: 'Bu bilgiler zaten kayıtlı' });
    }
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// LOGIN
app.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefon numarası gerekli' });

  const attempt = checkLoginAttempts(phone);
  if (!attempt.allowed) {
    return res.status(429).json({ error: `Çok fazla başarısız deneme. ${attempt.remaining} dakika sonra tekrar deneyin.` });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    const user = rows[0];
    if (!user) {
      recordFailedAttempt(phone);
      return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordFailedAttempt(phone);
      return res.status(401).json({ error: 'Şifre hatalı' });
    }

    clearLoginAttempts(phone);
    const token = jwt.sign(
      { userId: user.id, phone: user.phone, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// FORGOT PASSWORD
app.post('/forgot-password', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefon numarası gerekli' });
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (!rows[0]) return res.status(404).json({ error: 'Bu telefon ile kayıtlı kullanıcı bulunamadı' });

    const newPassword = crypto.randomBytes(4).toString('hex');
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, rows[0].id]);

    res.json({ message: 'Yeni şifreniz oluşturuldu.', newPassword });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// PROFILE GET
app.get('/profile', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.phone, u.institution_id AS institutionId,
              u.has_unlock_permission AS hasUnlockPermission,
              i.name AS institutionName, i.il_adi, i.ilce_adi
       FROM users u
       LEFT JOIN institutions i ON u.institution_id = i.id
       WHERE u.id = ?`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const row = rows[0];
    res.json({
      id: row.id,
      name: row.name,
      phone: row.phone,
      institutionId: row.institutionId,
      hasUnlockPermission: row.hasUnlockPermission,
      institutionName: row.institutionName,
      ilAdi: row.il_adi,
      ilceAdi: row.ilce_adi
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// PROFILE PUT
app.put('/profile', authenticate, async (req, res) => {
  const { phone, institutionId } = req.body;
  try {
    await pool.query(
      'UPDATE users SET phone = COALESCE(?, phone), institution_id = COALESCE(?, institution_id) WHERE id = ?',
      [phone || null, institutionId ? parseInt(institutionId) : null, req.user.userId]
    );
    const [rows] = await pool.query(
      'SELECT id, name, phone, institution_id AS institutionId, has_unlock_permission AS hasUnlockPermission FROM users WHERE id = ?',
      [req.user.userId]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// LOCK - Desktop için QR Kod Üretimi
app.get('/lock/desktop', async (req, res) => {
  const { institutionCode } = req.query;
  const sessionId = uuidv4();
  const expiresAt = Date.now() + (5 * 60 * 1000);
  qrSessions.set(sessionId, { expiresAt, unlocked: false, institutionCode: institutionCode || null });

  const qrData = JSON.stringify({ sessionId, timestamp: Date.now() });
  res.json({ qrData, sessionId, expiresAt });
});

// UNLOCK
app.post('/unlock', authenticate, async (req, res) => {
  const { sessionId } = req.body;
  const session = qrSessions.get(sessionId);

  if (!session) return res.status(404).json({ error: 'Geçersiz QR kod', unlocked: false });
  if (session.unlocked) return res.status(400).json({ error: 'QR kod zaten kullanıldı', unlocked: false });
  if (Date.now() > session.expiresAt) {
    qrSessions.delete(sessionId);
    return res.status(400).json({ error: 'QR kod süresi doldu', unlocked: false });
  }

  // Kullanıcının kilit açma yetkisi var mı kontrol et
  try {
    const [userRows] = await pool.query(
      'SELECT has_unlock_permission, institution_id FROM users WHERE id = ?',
      [req.user.userId]
    );
    if (!userRows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı', unlocked: false });
    if (!userRows[0].has_unlock_permission) {
      return res.status(403).json({ error: 'Kilit açma yetkiniz yok. Kurum yöneticinizden izin isteyin.', unlocked: false });
    }

    // Kurum kontrolü: session'da institutionCode varsa kullanıcının kurumu eşleşmeli
    if (session.institutionCode) {
      const [instRows] = await pool.query(
        'SELECT institution_code FROM institutions WHERE id = ?',
        [userRows[0].institution_id]
      );
      if (instRows[0]?.institution_code !== session.institutionCode) {
        return res.status(403).json({ error: 'Bu kilidi açma yetkiniz yok', unlocked: false });
      }
    }

    session.unlocked = true;

    // Unlock sonrası session'ı 5 saniye sonra sil (desktop polling'in son yanıtı alması için kısa süre bırak)
    setTimeout(() => qrSessions.delete(sessionId), 5000);

    res.json({ unlocked: true, message: 'Kilit açıldı' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası', unlocked: false });
  }
});

// OFFLINE UNLOCK KEY - Challenge kodu + kurum kodu ile unlock key üret
app.post('/offline-unlock-key', authenticate, async (req, res) => {
  const { challengeCode } = req.body;
  if (!challengeCode) return res.status(400).json({ error: 'Challenge kodu gerekli' });

  const offlineSecret = process.env.OFFLINE_SECRET;
  if (!offlineSecret) return res.status(500).json({ error: 'OFFLINE_SECRET tanımlı değil' });

  try {
    const [rows] = await pool.query(
      `SELECT i.institution_code FROM users u
       JOIN institutions i ON u.institution_id = i.id
       WHERE u.id = ?`,
      [req.user.userId]
    );
    const institutionCode = rows[0]?.institution_code;
    if (!institutionCode) return res.status(403).json({ error: 'Kurum bulunamadı' });

    const hmac = crypto.createHmac('sha256', offlineSecret);
    hmac.update(challengeCode + institutionCode);
    const digest = hmac.digest('hex');
    const unlockKey = (parseInt(digest.substring(0, 8), 16) % 1000000).toString().padStart(6, '0');

    res.json({ unlockKey });
  } catch (err) {
    console.error('offline-unlock-key hatası:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});


app.get('/lock/status/:sessionId', (req, res) => {
  const session = qrSessions.get(req.params.sessionId);
  if (!session) return res.json({ unlocked: false });
  res.json({ unlocked: session.unlocked });
});

// ─── KURUM AUTH ───

// Kurum Login
app.post('/institution/login', async (req, res) => {
  const { institutionCode, password } = req.body;
  if (!institutionCode || !password) {
    return res.status(400).json({ error: 'Kurum kodu ve şifre zorunlu' });
  }

  const attemptKey = `inst:${institutionCode}`;
  const attempt = checkLoginAttempts(attemptKey);
  if (!attempt.allowed) {
    return res.status(429).json({ error: `Çok fazla başarısız deneme. ${attempt.remaining} dakika sonra tekrar deneyin.` });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM institutions WHERE institution_code = ?', [institutionCode]);
    const inst = rows[0];
    if (!inst) {
      recordFailedAttempt(attemptKey);
      return res.status(401).json({ error: 'Kurum bulunamadı' });
    }

    if (!inst.password) {
      return res.status(403).json({ error: `Kurumunuz henüz aktif değil. Kurumunuzu aktif etmek için resmi kurum epostanız ile ${process.env.EMAIL_TO} eposta adresinden talepte bulunmalısınız.`, needsActivation: true });
    }

    const valid = await bcrypt.compare(password, inst.password);
    if (!valid) {
      recordFailedAttempt(attemptKey);
      return res.status(401).json({ error: 'Şifre hatalı' });
    }

    clearLoginAttempts(attemptKey);
    const token = jwt.sign(
      { institutionId: inst.id, institutionCode: inst.institution_code, type: 'institution' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, institution: { id: inst.id, name: inst.name, is_verified: inst.is_verified } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Middleware: Kurum token doğrulama
const authenticateInstitution = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'institution') return res.status(403).json({ error: 'Yetkisiz erişim' });
    req.institution = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
};

// Kurum bilgileri
app.get('/institution/profile', authenticateInstitution, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, institution_code, email, responsible_name, phone, il_adi, ilce_adi, tip, is_verified FROM institutions WHERE id = ?',
      [req.institution.institutionId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kurum bulunamadı' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kurum doğrulama için EMAIL_TO bilgisi
app.get('/institution/email-to', authenticateInstitution, (req, res) => {
  res.json({ emailTo: process.env.EMAIL_TO || '' });
});

// Kurum kullanıcıları listele
app.get('/institution/users', authenticateInstitution, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, phone, has_unlock_permission, created_at FROM users WHERE institution_id = ? ORDER BY created_at DESC',
      [req.institution.institutionId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kullanıcı has_unlock_permission toggle
app.put('/institution/users/:userId/permission', authenticateInstitution, async (req, res) => {
  const { userId } = req.params;
  try {
    // Kullanıcının bu kuruma ait olduğunu doğrula
    const [rows] = await pool.query(
      'SELECT id, has_unlock_permission FROM users WHERE id = ? AND institution_id = ?',
      [userId, req.institution.institutionId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    const newVal = rows[0].has_unlock_permission ? 0 : 1;
    await pool.query('UPDATE users SET has_unlock_permission = ? WHERE id = ?', [newVal, userId]);
    res.json({ id: parseInt(userId), has_unlock_permission: newVal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ─── ADMIN: Kurum Aktivasyonu ───

// Admin login — secret ile JWT token al
app.post('/admin/login', (req, res) => {
  const { secret } = req.body;

  const attempt = checkLoginAttempts('admin');
  if (!attempt.allowed) {
    return res.status(429).json({ error: `Çok fazla başarısız deneme. ${attempt.remaining} dakika sonra tekrar deneyin.` });
  }

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    recordFailedAttempt('admin');
    return res.status(401).json({ error: 'Geçersiz şifre' });
  }
  clearLoginAttempts('admin');
  const token = jwt.sign({ type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// Admin JWT middleware
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'admin') return res.status(403).json({ error: 'Yetkisiz erişim' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın' });
  }
};

// Kurum aktif et: şifre belirle + is_verified = 1
app.post('/admin/institution/activate', authenticateAdmin, async (req, res) => {
  const { institutionCode, password } = req.body;
  if (!institutionCode || !password) {
    return res.status(400).json({ error: 'Kurum kodu ve şifre zorunlu' });
  }
  try {
    const [rows] = await pool.query('SELECT id, name FROM institutions WHERE institution_code = ?', [institutionCode]);
    if (!rows[0]) return res.status(404).json({ error: 'Kurum bulunamadı' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE institutions SET password = ?, is_verified = 1 WHERE id = ?',
      [hashedPassword, rows[0].id]
    );
    res.json({ message: `${rows[0].name} kurumu aktif edildi.`, institutionCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Kurum deaktif et
app.post('/admin/institution/deactivate', authenticateAdmin, async (req, res) => {
  const { institutionCode } = req.body;
  if (!institutionCode) return res.status(400).json({ error: 'Kurum kodu zorunlu' });
  try {
    const [rows] = await pool.query('SELECT id, name FROM institutions WHERE institution_code = ?', [institutionCode]);
    if (!rows[0]) return res.status(404).json({ error: 'Kurum bulunamadı' });

    await pool.query('UPDATE institutions SET password = NULL, is_verified = 0 WHERE id = ?', [rows[0].id]);
    res.json({ message: `${rows[0].name} kurumu deaktif edildi.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Admin: Kurum listele (sayfalı + arama)
app.get('/admin/institutions', authenticateAdmin, async (req, res) => {
  const q = (req.query.q || '').trim();
  const status = req.query.status || ''; // 'active', 'inactive', ''
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    let conditions = [];
    let params = [];

    if (q) {
      conditions.push('(name LIKE ? OR institution_code LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status === 'active') {
      conditions.push('is_verified = 1');
    } else if (status === 'inactive') {
      conditions.push('(is_verified = 0 OR is_verified IS NULL)');
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM institutions ${where}`, params);
    const [rows] = await pool.query(
      `SELECT id, name, institution_code, responsible_name, phone, il_adi, ilce_adi, tip, is_verified, website
       FROM institutions ${where} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ results: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// KURUMLAR
app.get('/institutions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM institutions ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// İL LİSTESİ
app.get('/iller', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT il_adi FROM institutions WHERE il_adi IS NOT NULL ORDER BY il_adi'
    );
    res.json(rows.map(r => r.il_adi));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// İLÇE LİSTESİ (il'e göre)
app.get('/ilceler', async (req, res) => {
  const il = req.query.il || '';
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT ilce_adi FROM institutions WHERE il_adi = ? AND ilce_adi IS NOT NULL ORDER BY ilce_adi',
      [il]
    );
    res.json(rows.map(r => r.ilce_adi));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// KURUM ARA (Select2 server-side)
app.get('/institutions/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const il = (req.query.il || '').trim();
  const ilce = (req.query.ilce || '').trim();
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    let conditions = [];
    let params = [];

    if (il) {
      conditions.push('il_adi = ?');
      params.push(il);
    }
    if (ilce) {
      conditions.push('ilce_adi = ?');
      params.push(ilce);
    }
    if (q) {
      conditions.push('name LIKE ?');
      params.push(`%${q}%`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM institutions ${where}`, params
    );
    const [rows] = await pool.query(
      `SELECT id, name, il_adi, ilce_adi, tip FROM institutions ${where} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      results: rows.map(r => ({
        id: r.id,
        text: `${r.name} (${r.tip || ''})`
      })),
      pagination: { more: offset + limit < total }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Süresi dolmuş QR oturumlarını temizle
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of qrSessions.entries()) {
    if (now > session.expiresAt) qrSessions.delete(id);
  }
}, 60000);

const PORT = process.env.PORT || 3000;
checkConnection()
  .then(() => migrate())
  .then(() => {
    app.listen(PORT, () => console.log(`Tulpar Backend çalışıyor: http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('[DB] Bağlantı hatası:', err.message);
    process.exit(1);
  });
