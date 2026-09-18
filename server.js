require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'forge3d_super_secret_jwt_key_2026';
const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const stripe = require('stripe')(stripeKey);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base de Données SQLite
const db = new sqlite3.Database('./boutique.db', (err) => {
    if (!err) {
        console.log("Connecté à la base SQLite.");
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Table Admin
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )`);

        // Table Produits
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL,
            stock INTEGER DEFAULT 10,
            image TEXT,
            category TEXT DEFAULT 'Accessoires Gaming'
        )`);

        // Table Commandes
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_email TEXT NOT NULL,
            carrier TEXT NOT NULL,
            items TEXT NOT NULL,
            subtotal REAL NOT NULL,
            shipping_cost REAL NOT NULL,
            total REAL NOT NULL,
            status TEXT DEFAULT 'Payée - À Imprimer',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Admin par défaut (admin / admin123)
        db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
            if (row && row.count === 0) {
                const hash = bcrypt.hashSync('admin123', 10);
                db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['admin', hash]);
                console.log("Compte Administrateur configuré (admin / admin123)");
            }
        });

        // Produits de démonstration
        db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
            if (row && row.count === 0) {
                const stmt = db.prepare("INSERT INTO products (title, description, price, stock, image, category) VALUES (?, ?, ?, ?, ?, ?)");
                stmt.run("Support Double Manette PS5 / Xbox", "Support ergonomique de haute précision imprimé en PETG haute résistance.", 18.90, 20, "https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?w=800", "Gaming");
                stmt.run("Support de Casque Sous-Bureau", "Système d'accroche épuré avec passe-câble intégré.", 11.50, 35, "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=800", "Gaming");
                stmt.run("Support Volant Sim-Racing Rigide", "Adaptateur renforcé pour cockpit sim-racing et volant Logitech/Thrustmaster.", 29.90, 12, "https://images.unsplash.com/photo-1547394765-185e1e68f34e?w=800", "SimRacing");
                stmt.finalize();
            }
        });
    });
}

// Middleware Authentification Admin via JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Accès refusé. Token manquant." });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token invalide ou expiré." });
        req.user = user;
        next();
    });
}

// ==========================================
// ROUTES PUBLIQUES (CLIENT)
// ==========================================

// Liste des produits
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Créer session Stripe Checkout
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { items, customerEmail, carrier, shippingCost } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ error: "Panier vide." });
        }

        const lineItems = items.map(item => ({
            price_data: {
                currency: 'eur',
                product_data: { name: item.title },
                unit_amount: Math.round(item.price * 100),
            },
            quantity: 1,
        }));

        lineItems.push({
            price_data: {
                currency: 'eur',
                product_data: { name: `Livraison (${carrier})` },
                unit_amount: Math.round(shippingCost * 100),
            },
            quantity: 1,
        });

        const domainURL = process.env.URL_SITE || `https://${req.get('host')}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: lineItems,
            mode: 'payment',
            success_url: `${domainURL}/?payment=success`,
            cancel_url: `${domainURL}/?payment=cancel`,
        });

        // Enregistrer la commande
        const subtotal = items.reduce((sum, i) => sum + i.price, 0);
        const total = subtotal + shippingCost;

        db.run(
            "INSERT INTO orders (customer_email, carrier, items, subtotal, shipping_cost, total) VALUES (?, ?, ?, ?, ?, ?)",
            [customerEmail, carrier, JSON.stringify(items), subtotal, shippingCost, total]
        );

        res.json({ url: session.url });
    } catch (error) {
        console.error("Erreur Stripe:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ROUTES ADMINISTRATEUR (SECTEUR PRO)
// ==========================================

// Connexion Admin
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
            return res.json({ success: true, token });
        }
        res.status(401).json({ error: "Identifiants incorrects" });
    });
});

// Obtenir toutes les commandes (Admin)
app.get('/api/admin/orders', authenticateToken, (req, res) => {
    db.all("SELECT * FROM orders ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const orders = rows.map(o => ({ ...o, items: JSON.parse(o.items || '[]') }));
        res.json(orders);
    });
});

// Modifier le statut d'une commande
app.put('/api/admin/orders/:id', authenticateToken, (req, res) => {
    const { status } = req.body;
    db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Ajouter un produit (Admin)
app.post('/api/admin/products', authenticateToken, (req, res) => {
    const { title, description, price, stock, image, category } = req.body;
    db.run(
        "INSERT INTO products (title, description, price, stock, image, category) VALUES (?, ?, ?, ?, ?, ?)",
        [title, description, parseFloat(price), parseInt(stock), image, category || 'Gaming'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Supprimer un produit (Admin)
app.delete('/api/admin/products/:id', authenticateToken, (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Serveur Forge3D Pro actif sur le port ${PORT}`);
});