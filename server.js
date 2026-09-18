require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_51MockKeyStripeHere'; 
const stripe = require('stripe')(stripeKey);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration Session Admin
app.use(session({
    secret: process.env.SESSION_SECRET || 'forge3d-secret-session-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 heures
}));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base de données SQLite
const db = new sqlite3.Database('./boutique_3d.db', (err) => {
    if (!err) {
        console.log('Base de données SQLite connectée.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Table Utilisateurs Admin
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )`);

        // Table Produits
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            category TEXT,
            price REAL,
            stock INTEGER DEFAULT 10,
            image TEXT,
            description TEXT
        )`);

        // Table Commandes
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT,
            email TEXT,
            address TEXT,
            country TEXT,
            carrier TEXT,
            items TEXT,
            total REAL,
            shipping_label TEXT,
            tracking_number TEXT,
            status TEXT DEFAULT 'En attente d impression',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Compte Admin par défaut (Login: admin / MDP: admin123)
        db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
            if (row && row.count === 0) {
                const hash = bcrypt.hashSync('admin123', 10);
                db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['admin', hash]);
                console.log("Compte Administrateur initialisé -> Login: admin / MDP: admin123");
            }
        });

        // Produits de démo
        db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
            if (row && row.count === 0) {
                const stmt = db.prepare("INSERT INTO products (title, category, price, stock, image, description) VALUES (?, ?, ?, ?, ?, ?)");
                stmt.run("Support Manette PS5 / Xbox Articulé", "gaming", 14.90, 20, "https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?w=500", "Support haute résistance imprimé en PETG.");
                stmt.run("Accroche-Casque Sous-Bureau", "gaming", 9.90, 30, "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=500", "Fixation robuste avec passe-câble.");
                stmt.run("Support Modulaire Sim-Racing", "simracing", 24.90, 10, "https://images.unsplash.com/photo-1547394765-185e1e68f34e?w=500", "Adaptateur cockpit rigide pour volant/pédalier.");
                stmt.finalize();
            }
        });
    });
}

// Middleware d'accès sécurisé Admin
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    return res.status(401).json({ error: "Accès non autorisé" });
}

// ==========================================
// ROUTES CLIENT & EXPÉDITION INTERNATIONALE
// ==========================================

app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Calculateur de frais de port selon le pays
app.post('/api/calculate-shipping', (req, res) => {
    const { country, carrier } = req.body;
    let cost = 4.90; // Tarif national de base (France / Mondial Relay)

    if (country !== 'FR') {
        if (carrier === 'DHL_EXPRESS') cost = 19.90; // International Express
        else if (carrier === 'FEDEX_INT') cost = 24.90; // USA / Asie
        else cost = 12.90; // Europe Standard Colissimo
    } else {
        if (carrier === 'COLISSIMO_FR') cost = 6.90;
        if (carrier === 'CHRONOPOST_13') cost = 11.90;
    }

    res.json({ cost });
});

// Création de Session de Paiement Stripe Réelle
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { items, customerEmail, customerName, address, country, carrier } = req.body;

        // Calcul des frais de port
        let shippingCost = 4.90;
        if (country !== 'FR') {
            shippingCost = (carrier === 'DHL_EXPRESS') ? 19.90 : 12.90;
        } else {
            if (carrier === 'COLISSIMO_FR') shippingCost = 6.90;
            if (carrier === 'CHRONOPOST_13') shippingCost = 11.90;
        }

        const lineItems = items.map(item => ({
            price_data: {
                currency: 'eur',
                product_data: { name: `${item.title} (Couleur: ${item.color || 'Noir'})` },
                unit_amount: Math.round(item.price * 100),
            },
            quantity: 1,
        }));

        lineItems.push({
            price_data: {
                currency: 'eur',
                product_data: { name: `Frais d'Expédition (${carrier} - ${country})` },
                unit_amount: Math.round(shippingCost * 100),
            },
            quantity: 1,
        });

        const domainURL = process.env.URL_SITE || `http://localhost:${PORT}`;
        const total = items.reduce((sum, i) => sum + i.price, 0) + shippingCost;

        const stmt = db.prepare("INSERT INTO orders (customer_name, email, address, country, carrier, items, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(customerName, customerEmail, address, country, carrier, JSON.stringify(items), total, 'En attente de paiement', function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const orderId = this.lastID;

            stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                customer_email: customerEmail,
                line_items: lineItems,
                mode: 'payment',
                success_url: `${domainURL}/success.html?order_id=${orderId}`,
                cancel_url: `${domainURL}/index.html?canceled=true`,
            }).then(session => {
                res.json({ url: session.url });
            });
        });
        stmt.finalize();

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Confirmation de Commande
app.post('/api/confirm-order', (req, res) => {
    const { orderId } = req.body;
    const tracking = `TRACK-INT-${Math.floor(100000000 + Math.random() * 900000000)}`;
    const labelUrl = `/api/admin/download-label/${orderId}`;

    db.run("UPDATE orders SET status = 'Payée - À Imprimer', tracking_number = ?, shipping_label = ? WHERE id = ?", 
        [tracking, labelUrl, orderId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, trackingNumber: tracking, labelUrl });
    });
});

// ==========================================
// ROUTES ADMIN & BORDEREAUX D'EXPÉDITION
// ==========================================

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.isAdmin = true;
            return res.json({ success: true });
        }
        res.status(401).json({ success: false, message: "Identifiants incorrects" });
    });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
    db.all("SELECT * FROM orders ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items || '[]') })));
    });
});

app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
    const { status } = req.body;
    db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
    const { title, category, price, stock, image, description } = req.body;
    const stmt = db.prepare("INSERT INTO products (title, category, price, stock, image, description) VALUES (?, ?, ?, ?, ?, ?)");
    stmt.run(title, category, parseFloat(price), parseInt(stock), image, description, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
    stmt.finalize();
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Serveur Forge3D actif sur http://localhost:${PORT}`);
});