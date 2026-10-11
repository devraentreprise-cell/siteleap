// ==========================================
// Fichier : lister-projets.js
// Renvoie les projets du client connecté, avec leurs statistiques
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
    return { statusCode: statusCode, body: JSON.stringify(objet) };
}

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return reponse(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        // 1. Lecture de ce que le site envoie
        let body;
        try {
            body = JSON.parse(event.body || "{}");
        } catch (e) {
            return reponse(400, { success: false, message: "Données illisibles." });
        }

        const jeton = body.jeton;
        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }

        // 2. Vérification du jeton Google : l'email vient du jeton, jamais du site
        let email;
        try {
            const decode = await admin.auth().verifyIdToken(jeton);
            email = decode.email;
        } catch (e) {
            return reponse(401, { success: false, message: "Connexion Google invalide. Reconnectez-vous." });
        }
        if (!email) {
            return reponse(401, { success: false, message: "Adresse email introuvable." });
        }

        // Même règle de nom de tiroir que creer-projet.js
        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // 3. Lecture des projets de cet email
        const snapProjets = await db.ref("projets/" + cleEmail).once("value");

        if (!snapProjets.exists()) {
            return reponse(200, { success: true, projets: [] });
        }

        const projets = [];
        snapProjets.forEach(function (enfant) {
            const p = enfant.val() || {};
            projets.push({
                id: enfant.key,
                nom: p.nom || "",
                formule: p.formule || "",
                statut: p.statut || "",
                creeLe: p.creeLe || 0,
                imageUrl: p.imageUrl || ""
            });
        });

        // 4. Lecture des statistiques de chaque projet, toutes en même temps
        const lectures = projets.map(function (p) {
            return db.ref("stats/" + p.id).once("value");
        });
        const snapsStats = await Promise.all(lectures);

        projets.forEach(function (p, i) {
            p.stats = snapsStats[i].val() || {};
        });

        // 5. Du plus récent au plus ancien
        projets.sort(function (a, b) {
            return b.creeLe - a.creeLe;
        });

        return reponse(200, { success: true, projets: projets });

    } catch (error) {
        console.error("Erreur technique dans lister-projets :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la lecture des projets." });
    }
}
