// ==========================================
// Fichier : lire-stats.js
// Reçoit uniquement l'identifiant du projet, lit <projetId>/stats
// dans la base de données et renvoie toutes les informations
// statistiques trouvées, sans filtrage par niveau ou formule.
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(objet)
    };
}

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return reponse(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        let body;
        try {
            body = JSON.parse(event.body || "{}");
        } catch (e) {
            return reponse(400, { success: false, message: "Données illisibles." });
        }

        const projetId = String(body.projetId || body.id || "").trim();
        if (!projetId) {
            return reponse(400, { success: false, message: "Identifiant du projet manquant." });
        }

        const snapStats = await db.ref(projetId + "/stats").once("value");
        const stats = snapStats.exists() ? (snapStats.val() || {}) : {};

        return reponse(200, {
            success: true,
            projetId: projetId,
            stats: stats
        });

    } catch (error) {
        console.error("Erreur technique dans lire-stats :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la lecture des statistiques." });
    }
}
