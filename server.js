const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'super_secret_passport_key'; // in real-world, use env variables

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer for document uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.status(401).json({ error: 'Token missing' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

const isAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Route: Auth - Register
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role === 'admin' ? 'admin' : 'applicant';

        db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, userRole],
            function (err) {
                if (err) {
                    return res.status(400).json({ error: 'Email already exists' });
                }
                res.status(201).json({ message: 'User registered successfully', userId: this.lastID });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Auth - Login
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ message: 'Login successful', token, user: { id: user.id, name: user.name, role: user.role } });
    });
});

// Route: Submit Application
app.post('/api/applications', authenticateToken, upload.single('document'), (req, res) => {
    const { firstName, lastName, dob, address } = req.body;
    const documentUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!firstName || !lastName || !dob || !address || !documentUrl) {
        return res.status(400).json({ error: 'All fields and document are required' });
    }

    db.run(`INSERT INTO applications (user_id, first_name, last_name, dob, address, document_url) 
            VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, firstName, lastName, dob, address, documentUrl],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to submit application' });
            }
            res.status(201).json({ message: 'Application submitted successfully', applicationId: this.lastID });
        }
    );
});

// Route: Get User Applications
app.get('/api/applications/my', authenticateToken, (req, res) => {
    db.all('SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC', [req.user.id], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// Route: Book Appointment
app.post('/api/appointments', authenticateToken, (req, res) => {
    const { applicationId, appointmentDate, appointmentTime } = req.body;

    if (!applicationId || !appointmentDate || !appointmentTime) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Verify application belongs to user
    db.get('SELECT * FROM applications WHERE id = ? AND user_id = ?', [applicationId, req.user.id], (err, application) => {
        if (err || !application) {
            return res.status(403).json({ error: 'Unauthorized or application not found' });
        }

        db.run(`INSERT INTO appointments (application_id, user_id, appointment_date, appointment_time) 
                VALUES (?, ?, ?, ?)`,
            [applicationId, req.user.id, appointmentDate, appointmentTime],
            function (err) {
                if (err) {
                    return res.status(500).json({ error: 'Failed to book appointment' });
                }
                res.status(201).json({ message: 'Appointment booked successfully' });
            }
        );
    });
});

// Admin Route: Get all applications
app.get('/api/admin/applications', authenticateToken, isAdmin, (req, res) => {
    db.all(`SELECT a.*, u.email as user_email 
            FROM applications a 
            JOIN users u ON a.user_id = u.id 
            ORDER BY a.created_at DESC`, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// Admin Route: Update application status
app.put('/api/admin/applications/:id/status', authenticateToken, isAdmin, (req, res) => {
    const { status, remarks } = req.body;
    const applicationId = req.params.id;

    if (!status) {
        return res.status(400).json({ error: 'Status is required' });
    }

    db.run('UPDATE applications SET status = ?, remarks = ? WHERE id = ?',
        [status, remarks || '', applicationId],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to update application' });
            }
            res.json({ message: 'Status updated successfully' });
        }
    );
});

// Check if admin exists, if not create one
db.get('SELECT id FROM users WHERE role = "admin"', async (err, row) => {
    if (!err && !row) {
        console.log('No admin found, creating default admin...');
        const hashedPw = await bcrypt.hash('admin123', 10);
        db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            ['Super Admin', 'admin@passport.gov', hashedPw, 'admin']);
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
